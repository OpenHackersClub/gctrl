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
GCTRL_ENV_FILE="${GCTRL_ENV_FILE:-$HOME/.config/gctrl/env}"

# Source the operator-owned env file. Holds TELEGRAM_BOT_TOKEN, vault paths,
# scheduler exec gates, etc. The plist gets these substituted in at install
# time so launchd starts the daemon with the right environment. The file is
# operator-owned (`chmod 600`) and lives outside the repo to keep secrets out
# of git.
if [[ -f "$GCTRL_ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$GCTRL_ENV_FILE"; set +a
  echo "[gctrl] sourced env from $GCTRL_ENV_FILE"
else
  echo "[gctrl] no env file at $GCTRL_ENV_FILE — driver secrets will be empty" >&2
fi

# Defaults so the sed substitution doesn't insert literal "__VAR__" strings
# when an env var is unset. Empty values are tolerated by the daemon at
# startup; drivers refuse to send with a clear error if their secret is missing.
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_PRIMARY_CHAT_ID="${TELEGRAM_PRIMARY_CHAT_ID:-}"
DISCORD_NOTIFY_WEBHOOK_URL="${DISCORD_NOTIFY_WEBHOOK_URL:-}"
UBER_VAULT_DIR="${UBER_VAULT_DIR:-}"
GCTRL_SCHEDULER_EXEC_ENABLED="${GCTRL_SCHEDULER_EXEC_ENABLED:-0}"
GCTRL_SCHEDULER_EXEC_ALLOWED_PROGRAMS="${GCTRL_SCHEDULER_EXEC_ALLOWED_PROGRAMS:-}"

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

# 4. Render template. Substitute the operator's env into the plist's
# `EnvironmentVariables` block. Secret values land in
# ~/Library/LaunchAgents/dev.gctrl.kernel.plist (mode 0600 by default per
# launchd convention) — chmod 600 it explicitly below to be safe. They never
# touch the repo.
sed \
  -e "s|__GCTRL_BIN__|$GCTRL_BIN|g" \
  -e "s|__GCTRL_HOST__|$GCTRL_HOST|g" \
  -e "s|__GCTRL_PORT__|$GCTRL_PORT|g" \
  -e "s|__LOG_DIR__|$LOG_DIR|g" \
  -e "s|__TELEGRAM_BOT_TOKEN__|$TELEGRAM_BOT_TOKEN|g" \
  -e "s|__TELEGRAM_PRIMARY_CHAT_ID__|$TELEGRAM_PRIMARY_CHAT_ID|g" \
  -e "s|__DISCORD_NOTIFY_WEBHOOK_URL__|$DISCORD_NOTIFY_WEBHOOK_URL|g" \
  -e "s|__UBER_VAULT_DIR__|$UBER_VAULT_DIR|g" \
  -e "s|__GCTRL_SCHEDULER_EXEC_ENABLED__|$GCTRL_SCHEDULER_EXEC_ENABLED|g" \
  -e "s|__GCTRL_SCHEDULER_EXEC_ALLOWED_PROGRAMS__|$GCTRL_SCHEDULER_EXEC_ALLOWED_PROGRAMS|g" \
  "$PLIST_SRC" > "$PLIST_DEST"
chmod 600 "$PLIST_DEST"

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
