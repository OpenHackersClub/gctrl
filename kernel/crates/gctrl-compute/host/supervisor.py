#!/usr/bin/env python3
"""Durable execution on an explicitly selected Linux SSH host.

Requests are JSON on stdin. Attempt UUIDs are never reused for a new launch;
a cancellation tombstone fences even a launch whose acknowledgment was lost.
"""
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import time
import uuid


class _Failure(Exception):
    def __init__(self, kind, detail):
        self.kind, self.detail = kind, detail
        super().__init__(detail)


def _host():
    if sys.platform != "linux":
        raise _Failure("unsupported", "this execution supervisor requires Linux /proc")
    return Path("/etc/machine-id").read_text().strip() + ":" + Path("/proc/sys/kernel/random/boot_id").read_text().strip()


def _owned_directory(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise _Failure("permission_denied", "execution state must be an exclusively owned directory")


@contextmanager
def _lock(directory, name="request.lock"):
    fd = os.open(directory / name, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def _write(path, value):
    temporary = path.parent / (".tmp-" + str(uuid.uuid4()))
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as handle:
        json.dump(value, handle, sort_keys=True)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def _read(directory):
    path = directory / "state.json"
    return json.loads(path.read_text()) if path.exists() else None


def _cgroup_root(value):
    root = Path(value)
    if not root.is_absolute() or not str(root).startswith("/sys/fs/cgroup/") or root.resolve() != root:
        raise _Failure("invalid", "cgroupRoot must be an actual delegated cgroup-v2 subtree")
    try:
        info = root.lstat()
    except FileNotFoundError:
        raise _Failure("unsupported", "target operator must provide a delegated cgroup-v2 subtree")
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise _Failure("permission_denied", "cgroup subtree must be exclusively owned by the supervisor user")
    if not (root / "cgroup.controllers").exists() or not os.access(root / "cgroup.kill", os.W_OK):
        raise _Failure("unsupported", "target cgroup-v2 runtime must support recursive cgroup.kill")
    return root


def _group(state, root=None):
    if state["hostId"] != _host():
        raise _Failure("uncertain", "target host/boot changed; previous runtime cannot be fenced")
    path = Path(state.get("cgroupPath", ""))
    if not path.is_absolute() or (root is not None and path != root / state["attemptId"]):
        raise _Failure("uncertain", "prior attempt has no matching cgroup-v2 execution runtime")
    try:
        info = path.lstat()
    except FileNotFoundError:
        raise _Failure("uncertain", "prior cgroup runtime disappeared; no confirmed execution outcome")
    if not stat.S_ISDIR(info.st_mode) or info.st_ino != state.get("cgroupInode"):
        raise _Failure("uncertain", "cgroup incarnation changed; do not fence an unrelated runtime")
    return path


def _populated(group):
    values = dict(line.split() for line in (group / "cgroup.events").read_text().splitlines())
    return values.get("populated") != "0"


def _descendants(group):
    return any(int(pid) != os.getpid() for path in group.rglob("cgroup.procs") for pid in path.read_text().split())


def _kill(group):
    (group / "cgroup.kill").write_text("1")


def _process(pid):
    try:
        info = Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()
        return {"state": info[0], "group": int(info[2]), "start": info[19]}
    except (FileNotFoundError, ProcessLookupError):
        return None


def _members(group, exclude=None):
    members = []
    for entry in Path("/proc").iterdir():
        if entry.name.isdecimal() and int(entry.name) != exclude:
            info = _process(entry.name)
            if info and info["group"] == group and info["state"] not in ("Z", "X"):
                members.append(int(entry.name))
    return members


def _identity(pid):
    info = _process(pid)
    if info is None:
        raise _Failure("uncertain", "execution leader disappeared before incarnation was recorded")
    return _host() + f':{pid}:{info["start"]}'


def _output(directory, name):
    path = directory / name
    if not path.exists():
        return ""
    with path.open("rb") as handle:
        return handle.read(1024 * 1024).decode("utf-8", errors="replace")


def _snapshot(directory, state):
    if state["phase"] in ("running", "cancel_requested"):
        pid = state.get("leaderPid")
        if state["hostId"] != _host():
            state["phase"], state["detail"] = "uncertain", "target host/boot incarnation changed"
        elif pid and _process(pid):
            if _identity(pid) != state["processIncarnation"]:
                state["phase"], state["detail"] = "uncertain", "execution PID was reused; do not signal it"
        elif pid and _members(pid):
            state["phase"], state["detail"] = "uncertain", "leader disappeared but its process group still has live members"
        # The durable runner records an exit after reaping. Do not infer an
        # exit solely from a missing leader during that small recording gap.
        _write(directory / "state.json", state)
    return {key: state.get(key) for key in ("attemptId", "invocationHash", "hostId", "processIncarnation", "phase", "exitCode", "detail")} | {
        "stdout": _output(directory, "stdout"), "stderr": _output(directory, "stderr")
    }


def _invocation(value):
    fields = {"attemptId", "taskId", "agentSessionId", "workspaceId", "environmentId", "program", "args", "cwd", "stdin", "env", "timeoutSeconds"}
    if not isinstance(value, dict) or set(value) != fields:
        raise _Failure("invalid", "launch requires a complete invocation with no unknown fields")
    for name in ("taskId", "agentSessionId", "workspaceId", "environmentId", "program", "cwd"):
        if not isinstance(value[name], str) or not value[name] or "\0" in value[name]:
            raise _Failure("invalid", f"invalid {name}")
    if not Path(value["cwd"]).is_absolute() or not Path(value["cwd"]).is_dir():
        raise _Failure("invalid", "target-host cwd must be an existing absolute directory")
    if not isinstance(value["args"], list) or any(not isinstance(arg, str) or "\0" in arg for arg in value["args"]):
        raise _Failure("invalid", "args must be strings without NUL")
    if not isinstance(value["stdin"], str) or len(value["stdin"].encode()) > 1024 * 1024:
        raise _Failure("invalid", "stdin must contain at most 1 MiB")
    if not isinstance(value["env"], dict) or any(not isinstance(k, str) or not k or "=" in k or "\0" in k or not isinstance(v, str) or "\0" in v for k, v in value["env"].items()):
        raise _Failure("invalid", "env must be explicit string pairs")
    if type(value["timeoutSeconds"]) is not int or not 1 <= value["timeoutSeconds"] <= 86400:
        raise _Failure("invalid", "timeoutSeconds must be in 1..=86400")
    return value


def _launch(directory, invocation, cgroup_root):
    fingerprint = hashlib.sha256(json.dumps(invocation, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    with _lock(directory):
        state = _read(directory)
        if state:
            if state.get("invocationHash") not in (None, fingerprint):
                raise _Failure("conflict", "attempt identity already belongs to another invocation")
            # Prepared/uncertain attempts are never automatically spawned again.
            return _snapshot(directory, state)
        group = cgroup_root / invocation["attemptId"]
        if group.exists():
            raise _Failure("uncertain", "attempt runtime exists without durable metadata; do not redispatch")
        _owned_directory(group)
        if _populated(group):
            raise _Failure("uncertain", "attempt cgroup already contains live execution")
        state = {"cgroupPath": str(group), "cgroupInode": group.stat().st_ino, "attemptId": invocation["attemptId"], "invocationHash": fingerprint, "hostId": _host(), "processIncarnation": None, "phase": "prepared", "exitCode": None, "detail": None, "invocation": invocation}
        _write(directory / "state.json", state)
        with (directory / "supervisor.log").open("ab") as log:
            subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--run", str(directory)], stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True, close_fds=True)
        return _snapshot(directory, state)


def _run(directory):
    with _lock(directory, "run.lock"):
        with _lock(directory):
            state = _read(directory)
            if not state or state["phase"] != "prepared" or (directory / "cancel.json").exists():
                return
            with (directory / "supervisor.log").open("ab") as log:
                process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--exec", str(directory)], stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True, close_fds=True)
            try:
                group = _group(state)
                (group / "cgroup.procs").write_text(str(process.pid))
            except Exception:
                process.kill()
                process.wait()
                raise
            state.update(phase="running", leaderPid=process.pid, processIncarnation=_identity(process.pid))
            _write(directory / "state.json", state)
            # The execution leader cannot start the command before its actual
            # PID/boot/start identity has been durably recorded.
            _write(directory / "go.json", {"leaderPid": process.pid})
        code = process.wait()
        with _lock(directory):
            state = _read(directory)
            if _populated(_group(state)):
                state.update(phase="uncertain", detail="execution ended with live cgroup descendants")
            elif (directory / "cancel.json").exists():
                state.update(phase="cancelled", exitCode=code, detail=None)
            else:
                exit_path = directory / "exit.json"
                result = json.loads(exit_path.read_text()) if exit_path.exists() else {"exitCode": code}
                state.update(phase="exited", exitCode=result["exitCode"], detail=result.get("detail"))
            _write(directory / "state.json", state)


def _execute(directory):
    deadline = time.monotonic() + 5
    while not (directory / "go.json").exists():
        if (directory / "cancel.json").exists() or time.monotonic() >= deadline:
            return
        time.sleep(.01)
    with _lock(directory):
        state = _read(directory)
        if (directory / "cancel.json").exists() or state["phase"] != "running" or state["processIncarnation"] != _identity(os.getpid()):
            return
        invocation = state["invocation"]
    group = _group(state)
    deadline = time.monotonic() + invocation["timeoutSeconds"]
    with (directory / "stdout").open("wb") as output, (directory / "stderr").open("wb") as error:
        try:
            process = subprocess.Popen([invocation["program"], *invocation["args"]], cwd=invocation["cwd"], env=invocation["env"], stdin=subprocess.PIPE, stdout=output, stderr=error, close_fds=True)
            process.communicate(input=invocation["stdin"].encode(), timeout=invocation["timeoutSeconds"])
            code = process.returncode
        except subprocess.TimeoutExpired:
            _write(directory / "exit.json", {"exitCode": -9, "detail": "target execution deadline exceeded; group fenced"})
            _kill(group)
            return
        except OSError as exception:
            _write(directory / "exit.json", {"exitCode": 127, "detail": str(exception)})
            return
    # A shell can exit while leaving children running. Keep the group leader
    # alive until those children finish or the group can be explicitly fenced.
    while _descendants(group):
        if time.monotonic() >= deadline:
            _write(directory / "exit.json", {"exitCode": -9, "detail": "descendants exceeded execution deadline; group fenced"})
            _kill(group)
            return
        time.sleep(.03)
    _write(directory / "exit.json", {"exitCode": code})


def _cancel(directory, attempt, cgroup_root):
    with _lock(directory):
        _write(directory / "cancel.json", {"attemptId": attempt})
        state = _read(directory)
        if state is None:
            if (cgroup_root / attempt).exists():
                raise _Failure("uncertain", "attempt runtime exists without its durable metadata; cancellation cannot be confirmed")
            state = {"attemptId": attempt, "invocationHash": None, "hostId": _host(), "processIncarnation": None, "phase": "cancelled", "exitCode": None, "detail": None}
            _write(directory / "state.json", state)
            return _snapshot(directory, state)
        if state["phase"] == "cancelled" and state.get("invocationHash") is None and state.get("processIncarnation") is None and not state.get("cgroupPath"):
            return _snapshot(directory, state)
        group = _group(state, cgroup_root)
        if state["phase"] in ("exited", "cancelled") and not _populated(group):
            return _snapshot(directory, state)
        state.update(phase="cancel_requested", detail="recursive execution stop not yet confirmed")
        _write(directory / "state.json", state)
        if _populated(group):
            _kill(group)
    deadline = time.monotonic() + 5
    while _populated(group):
        if time.monotonic() >= deadline:
            raise _Failure("uncertain", "recursive cgroup cancellation not confirmed")
        time.sleep(.03)
    with _lock(directory):
        state = _read(directory)
        state.update(phase="cancelled", detail=None)
        _write(directory / "state.json", state)
        return _snapshot(directory, state)


def main():
    if len(sys.argv) == 3 and sys.argv[1] in ("--run", "--exec"):
        directory = Path(sys.argv[2])
        _owned_directory(directory)
        (_run if sys.argv[1] == "--run" else _execute)(directory)
        return
    try:
        request = json.load(sys.stdin)
        if not isinstance(request, dict):
            raise _Failure("invalid", "request must be an object")
        operation = request.get("operation")
        expected = {"operation", "stateRoot", "cgroupRoot", "invocation" if operation == "launch" else "attemptId"}
        if operation not in ("launch", "reconcile", "cancel") or set(request) != expected:
            raise _Failure("invalid", "unknown operation or request fields")
        cgroup_root = _cgroup_root(request["cgroupRoot"])
        invocation = _invocation(request["invocation"]) if operation == "launch" else None
        attempt = invocation["attemptId"] if invocation else request["attemptId"]
        if not isinstance(attempt, str) or str(uuid.UUID(attempt)) != attempt:
            raise _Failure("invalid", "attemptId must be a canonical UUID")
        root = Path(request["stateRoot"])
        if not root.is_absolute():
            raise _Failure("invalid", "stateRoot must be absolute on the selected target host")
        _owned_directory(root)
        directory = root / attempt
        _owned_directory(directory)
        if operation == "launch":
            result = _launch(directory, invocation, cgroup_root)
        elif operation == "cancel":
            result = _cancel(directory, attempt, cgroup_root)
        else:
            with _lock(directory):
                state = _read(directory)
                if state is None:
                    raise _Failure("not_found", f"attempt not found: {attempt}")
                if state.get("cgroupPath"):
                    group = _group(state, cgroup_root)
                    if state["phase"] in ("exited", "cancelled") and _populated(group):
                        state.update(phase="uncertain", detail="terminal receipt has live cgroup descendants")
                        _write(directory / "state.json", state)
                result = _snapshot(directory, state)
    except _Failure as error:
        result = {"error": {"kind": error.kind, "detail": error.detail}}
    except (ValueError, TypeError, OSError) as error:
        result = {"error": {"kind": "invalid", "detail": str(error)}}
    print(json.dumps(result))


if __name__ == "__main__":
    main()
