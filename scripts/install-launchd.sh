#!/usr/bin/env bash
# Install gctrl kernel as a per-user LaunchAgent.
# Auto-builds + installs `gctrld` to ~/.cargo/bin if missing, then loads the agent.
#
# Usage:
#   ./scripts/install-launchd.sh          # install + load
#   ./scripts/install-launchd.sh uninstall

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="dev.gctrl.kernel"
PLIST_SRC="$REPO_ROOT/scripts/launchd/$LABEL.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/gctrl"
GCTRL_PORT="${GCTRL_PORT:-4318}"
GCTRL_HOST="${GCTRL_HOST:-127.0.0.1}"

uninstall() {
  if launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
    launchctl bootout "gui/$UID/$LABEL" || true
    echo "[gctrl] unloaded $LABEL"
  fi
  rm -f "$PLIST_DEST"
  echo "[gctrl] removed $PLIST_DEST"
}

if [[ "${1:-}" == "uninstall" ]]; then
  uninstall
  exit 0
fi

# 1. Resolve binary path
GCTRL_BIN="$(command -v gctrld || true)"
if [[ -z "$GCTRL_BIN" ]]; then
  echo "[gctrl] gctrld not found on PATH — building + installing..."
  cargo install --path "$REPO_ROOT/kernel/crates/gctrl-cli" --force
  GCTRL_BIN="$HOME/.cargo/bin/gctrld"
fi
[[ -x "$GCTRL_BIN" ]] || { echo "[gctrl] cannot find gctrld at $GCTRL_BIN" >&2; exit 1; }

# 2. Prepare log dir + LaunchAgents dir
mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"

# 3. Preflight: warn if something else is on the target port
if lsof -nP -iTCP:"$GCTRL_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  if ! launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
    echo "[gctrl] WARNING: port $GCTRL_PORT is already in use by another process — agent will thrash" >&2
    echo "[gctrl] Run 'lsof -nP -iTCP:$GCTRL_PORT -sTCP:LISTEN' to find it, or set GCTRL_PORT=<other>" >&2
  fi
fi

# 4. Render template
sed \
  -e "s|__GCTRL_BIN__|$GCTRL_BIN|g" \
  -e "s|__GCTRL_HOST__|$GCTRL_HOST|g" \
  -e "s|__GCTRL_PORT__|$GCTRL_PORT|g" \
  -e "s|__LOG_DIR__|$LOG_DIR|g" \
  "$PLIST_SRC" > "$PLIST_DEST"

# 4. (Re)load
if launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "gui/$UID/$LABEL" || true
fi
launchctl bootstrap "gui/$UID" "$PLIST_DEST"
launchctl enable "gui/$UID/$LABEL"
launchctl kickstart -k "gui/$UID/$LABEL"

echo
echo "[gctrl] installed $LABEL -> $GCTRL_BIN serve --host $GCTRL_HOST --port $GCTRL_PORT"
echo "[gctrl] logs: $LOG_DIR/kernel.{out,err}.log"
echo "[gctrl] status:  launchctl print gui/\$UID/$LABEL | head"
echo "[gctrl] stop:    ./scripts/install-launchd.sh uninstall"
