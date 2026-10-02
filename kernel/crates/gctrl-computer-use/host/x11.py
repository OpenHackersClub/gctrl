#!/usr/bin/env python3
"""Observe explicit native targets on the selected Linux X11/AT-SPI host.

One JSON request/response on stdin/stdout. This helper does not issue input;
coordinator integration and the revocable input runtime remain deferred.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import uuid


class _Failure(Exception):
    def __init__(self, kind, detail):
        self.kind, self.detail = kind, detail
        super().__init__(detail)


def _command(*args):
    try:
        result = subprocess.run(args, text=True, capture_output=True, timeout=3, check=True)
    except (subprocess.SubprocessError, OSError) as error:
        raise _Failure("unsupported", f"target-host tool failed: {args[0]}: {error}") from error
    return result.stdout.strip()


def _property(window, name):
    result = _command("xprop", "-notype", "-id", str(window), name)
    return result.split(" = ", 1)[1] if " = " in result else None


def _nonce(window, name):
    value = _property(window, name)
    if value is None:
        value = str(uuid.uuid4())
        _command("xprop", "-id", str(window), "-f", name, "8s", "-set", name, value)
        value = _property(window, name)
    try:
        return str(uuid.UUID(json.loads(value)))
    except (ValueError, TypeError, json.JSONDecodeError) as error:
        raise _Failure("uncertain", f"invalid target incarnation property {name}") from error


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def _runtime_lock():
    directory = Path(f"/tmp/gctrl-x11-{os.getuid()}")
    directory.mkdir(mode=0o700, exist_ok=True)
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise _Failure("permission_denied", "native runtime state directory is not exclusively owned")
    fd = os.open(directory / "identity.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX)
    return os.fdopen(fd, "a")


def _desktop():
    if sys.platform != "linux" or not os.environ.get("DISPLAY") or not os.environ.get("DBUS_SESSION_BUS_ADDRESS"):
        raise _Failure("unsupported", "Linux X11 DISPLAY and the selected login's D-Bus session are required")
    for tool in ("xprop", "xwininfo", "xdotool", "gdbus"):
        if shutil.which(tool) is None:
            raise _Failure("unsupported", f"target-host tool missing: {tool}")
    root_info = _command("xwininfo", "-root")
    root = re.search(r"Window id:\s+(0x[0-9a-fA-F]+)", root_info)
    if root is None:
        raise _Failure("unsupported", "cannot establish the selected X11 server root")
    bus_id = _command("gdbus", "call", "--session", "--dest", "org.freedesktop.DBus", "--object-path", "/org/freedesktop/DBus", "--method", "org.freedesktop.DBus.GetId")
    bus_id = re.search(r"'([0-9a-f]{32})'", bus_id)
    if bus_id is None:
        raise _Failure("unsupported", "cannot establish the selected D-Bus login incarnation")
    boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    machine = Path("/etc/machine-id").read_text().strip()
    with _runtime_lock():
        nonce = _nonce(root.group(1), "_GCTRL_INPUT_RUNTIME_NONCE")
    return {"hostId": f"{machine}:{boot}", "loginSession": f"{os.getuid()}:{bus_id.group(1)}", "runtimeId": f"x11:{nonce}"}, boot


def _targets():
    desktop, boot = _desktop()
    try:
        import pyatspi
        accessible = pyatspi.Registry.getDesktop(0)
        # Probe an actual accessibility connection rather than the import alone.
        accessible.childCount
    except Exception as error:
        raise _Failure("unsupported", f"target-host accessibility unavailable: {error}") from error
    listed = _command("xprop", "-root", "_NET_CLIENT_LIST")
    targets = []
    for window in re.findall(r"0x[0-9a-fA-F]+", listed):
        pid = _property(window, "_NET_WM_PID")
        if pid is None or not pid.isdecimal():
            continue
        proc = Path(f"/proc/{pid}")
        try:
            if proc.stat().st_uid != os.getuid():
                continue
            # The command name can contain spaces/parentheses. The tail starts
            # at stat field 3; field 22 is offset 19 in that tail.
            start = (proc / "stat").read_text().rsplit(") ", 1)[1].split()[19]
            title = _property(window, "_NET_WM_NAME") or _property(window, "WM_NAME")
            if title is None:
                continue
            title = json.loads(title)
            with _runtime_lock():
                nonce = _nonce(window, "_GCTRL_WINDOW_NONCE")
        except FileNotFoundError:
            continue  # Window exited during discovery; do not advertise it.
        application = {"kind": "window", "application": title, "process_incarnation": f"{boot}:{pid}:{start}", "window_id": window, "window_incarnation": nonce}
        target = {"desktop": desktop, "application": application}
        target["id"] = _digest(target)
        targets.append(target)
    return targets, accessible


def _accessibility_text(root, application):
    pid = int(application["process_incarnation"].split(":")[-2])
    frames = []
    for app in root:
        if app.get_process_id() == pid:
            frames.extend(frame for frame in app if frame.name == application["application"])
    if len(frames) != 1:
        raise _Failure("uncertain", "bound window's accessibility frame is absent or ambiguous")
    rows, remaining = [], [512]

    def walk(node, depth):
        if depth > 16 or remaining[0] <= 0:
            raise _Failure("unsupported", "accessibility tree exceeds the observation limit")
        remaining[0] -= 1
        text = ""
        try:
            query = node.queryText()
            text = query.getText(0, query.characterCount)
        except NotImplementedError:
            pass
        rows.append({"role": node.getRoleName(), "name": node.name, "text": text})
        for child in node:
            walk(child, depth + 1)
    walk(frames[0], 0)
    return rows


def _observe(request):
    target = request.get("target")
    if not isinstance(target, dict) or not isinstance(target.get("id"), str):
        raise _Failure("invalid", "observe requires a complete discovery target")
    targets, accessibility = _targets()
    matches = [candidate for candidate in targets if candidate["id"] == target["id"]]
    if len(matches) != 1 or matches[0] != target:
        raise _Failure("stale", "target host/login/runtime/process/window incarnation changed")
    rows = _accessibility_text(accessibility, target["application"])
    geometry = _command("xdotool", "getwindowgeometry", "--shell", target["application"]["window_id"])
    focus = _command("xdotool", "getwindowfocus")
    pointer = _command("xdotool", "getmouselocation", "--shell")
    # Read-only focus/pointer observations on the selected target host. These
    # participate in staleness; they never select the target or issue input.
    revision = _digest({"target": target, "rows": rows, "geometry": geometry, "focus": focus, "pointer": pointer})
    return {"target": target, "revision": revision, "text": "\n".join(f'{row["role"]}: {row["name"]} {row["text"]}' for row in rows), "imageBase64": None}


def main():
    try:
        request = json.load(sys.stdin)
        if not isinstance(request, dict):
            raise _Failure("invalid", "request must be an object")
        operation = request.get("operation")
        if operation == "discover":
            targets, _ = _targets()
            result = {"capabilities": {"display": "x11", "accessibility": True, "input": False, "screenshots": False}, "targets": targets}
        elif operation == "observe":
            result = _observe(request)
        elif operation in ("apply", "fence"):
            raise _Failure("unsupported", "revocable input/fencing runtime is not implemented")
        else:
            raise _Failure("invalid", "unknown operation")
    except _Failure as error:
        result = {"error": {"kind": error.kind, "detail": error.detail}}
    except (ValueError, TypeError, OSError) as error:
        result = {"error": {"kind": "invalid", "detail": str(error)}}
    except Exception as error:
        result = {"error": {"kind": "uncertain", "detail": f"native observation failed: {error}"}}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
