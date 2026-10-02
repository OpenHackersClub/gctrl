#!/usr/bin/env python3
"""Live durable-execution gate on an owned Linux target; no model calls."""
import json
import os
from pathlib import Path
import subprocess
import signal
import sys
import tempfile
import time
import uuid

helper=Path(sys.argv[1]).resolve()
root=Path(tempfile.mkdtemp(prefix="gctrl-compute-acceptance-"))
state=root/"state"
cgroups=Path("/sys/fs/cgroup/gctrl-compute-acceptance")
cgroups.mkdir(mode=0o700,exist_ok=True)

def request(operation, **args):
    payload={"operation":operation,"stateRoot":str(state),"cgroupRoot":str(cgroups),**args}
    response=subprocess.run([sys.executable,str(helper)],input=json.dumps(payload),text=True,capture_output=True,check=True,timeout=10,env={**os.environ,"GCTRL_TEST_SUPERVISOR_ONLY":"must-not-reach-agent"})
    result=json.loads(response.stdout)
    assert "error" not in result,result
    return result

def invocation(attempt, script):
    return {"attemptId":attempt,"taskId":"test-task","agentSessionId":"test-session","workspaceId":"test-workspace","environmentId":"test-environment","program":"/bin/sh","args":["-c",script],"cwd":str(root),"stdin":"","env":{"PATH":"/usr/bin:/bin"},"timeoutSeconds":30}

def until(attempt, phase):
    end=time.monotonic()+7
    while time.monotonic()<end:
        snapshot=request("reconcile",attemptId=attempt)
        if snapshot["phase"]==phase:return snapshot
        time.sleep(.03)
    raise AssertionError(snapshot)

attempt=str(uuid.uuid4())
command=invocation(attempt,"echo started >> starts; sleep 2; printf 'completed'; printf 'diagnostic' >&2")
try:
    launched=request("launch",invocation=command)
    assert launched["attemptId"]==attempt
    duplicate=request("launch",invocation=command)
    assert duplicate["attemptId"]==attempt
    running=until(attempt,"running")
    assert running["hostId"] and running["processIncarnation"]
    assert (root/"starts").read_text().splitlines()==["started"]
    completed=until(attempt,"exited")
    assert completed["exitCode"]==0,completed
    assert completed["stdout"]=="completed" and completed["stderr"]=="diagnostic"
    assert request("launch",invocation=command)["phase"]=="exited"
    assert (root/"starts").read_text().splitlines()==["started"]
    changed=invocation(attempt,"touch must-not-reexecute")
    conflict=subprocess.run([sys.executable,str(helper)],input=json.dumps({"operation":"launch","stateRoot":str(state),"cgroupRoot":str(cgroups),"invocation":changed}),text=True,capture_output=True,check=True,timeout=10)
    assert json.loads(conflict.stdout)["error"]["kind"]=="conflict"
    assert not (root/"must-not-reexecute").exists()
    # Loss of terminal metadata must not make the same UUID launchable again.
    old_record=state/attempt/"state.json"
    saved_terminal=state/attempt/"saved-terminal.json"
    old_record.rename(saved_terminal)
    try:
        payload={"operation":"launch","stateRoot":str(state),"cgroupRoot":str(cgroups),"invocation":command}
        response=subprocess.run([sys.executable,str(helper)],input=json.dumps(payload),text=True,capture_output=True,check=True,timeout=10)
        result=json.loads(response.stdout)
        assert result.get("error",{}).get("kind")=="uncertain", "lost terminal metadata made a prior attempt launchable again"
    finally:
        saved_terminal.replace(old_record)
        assert request("cancel",attemptId=attempt)["phase"] in ("exited","cancelled")
    environment_id=str(uuid.uuid4())
    environment=invocation(environment_id,"exec /usr/bin/env")
    environment["program"]="/usr/bin/env";environment["args"]=[]
    request("launch",invocation=environment)
    assert until(environment_id,"exited")["stdout"].strip()=="PATH=/usr/bin:/bin"
    descendant_id=str(uuid.uuid4())
    request("launch",invocation=invocation(descendant_id,"sleep 30 & printf 'descendant spawned'; exit 0"))
    until(descendant_id,"running")
    time.sleep(.1)
    assert request("reconcile",attemptId=descendant_id)["phase"]=="running", "shell exit hid a still-running descendant"
    assert request("cancel",attemptId=descendant_id)["phase"]=="cancelled"
    escaped_id=str(uuid.uuid4())
    escaped=invocation(escaped_id,"")
    escaped["program"]="/usr/bin/python3"
    escaped["args"]=["-c", "import subprocess,sys,time; p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)'],start_new_session=True); print(p.pid,flush=True); time.sleep(30)"]
    request("launch",invocation=escaped)
    until(escaped_id,"running")
    deadline=time.monotonic()+5
    while True:
        output=request("reconcile",attemptId=escaped_id)["stdout"].strip()
        if output:
            escaped_pid=int(output)
            escaped_start=Path(f"/proc/{escaped_pid}/stat").read_text().rsplit(") ",1)[1].split()[19]
            break
        assert time.monotonic()<deadline,"detached child did not start"
        time.sleep(.03)
    assert request("cancel",attemptId=escaped_id)["phase"]=="cancelled"
    child_stat=Path(f"/proc/{escaped_pid}/stat")
    if child_stat.exists():
        child_info=child_stat.read_text().rsplit(") ",1)[1].split()
        assert child_info[0] in ("Z","X") or child_info[19]!=escaped_start, "confirmed cancellation left a detached descendant alive"
    missing_id=str(uuid.uuid4())
    request("launch",invocation=invocation(missing_id,"sleep 30"))
    until(missing_id,"running")
    record=state/missing_id/"state.json"
    saved=state/missing_id/"saved-state.json"
    record.rename(saved)
    try:
        payload={"operation":"cancel","stateRoot":str(state),"cgroupRoot":str(cgroups),"attemptId":missing_id}
        response=subprocess.run([sys.executable,str(helper)],input=json.dumps(payload),text=True,capture_output=True,check=True,timeout=10)
        result=json.loads(response.stdout)
        assert result.get("error",{}).get("kind")=="uncertain", "missing metadata incorrectly confirmed cancellation of a live runtime"
    finally:
        saved.replace(record)
        assert request("cancel",attemptId=missing_id)["phase"]=="cancelled"
    killed=str(uuid.uuid4())
    request("launch",invocation=invocation(killed,"echo started >> cancel-starts; sleep 30"))
    until(killed,"running")
    cancelled=request("cancel",attemptId=killed)
    assert cancelled["phase"]=="cancelled",cancelled
    assert request("reconcile",attemptId=killed)["phase"]=="cancelled"
    assert request("cancel",attemptId=killed)["phase"]=="cancelled"
    tombstone=str(uuid.uuid4())
    assert request("cancel",attemptId=tombstone)["phase"]=="cancelled"
    assert request("cancel",attemptId=tombstone)["phase"]=="cancelled"
    assert request("launch",invocation=invocation(tombstone,"touch must-not-run"))["phase"]=="cancelled"
    assert not (root/"must-not-run").exists()
    print("durable compute gate: stable attempt, exactly one launch, target identity, output/exit reconciliation, exact child env, recursive cancellation including detached descendants, missing-state quarantine, idempotent cancellation tombstones")
finally:
    # Reconcile/cancel only these owned attempts. A failed test must not leave
    # an active process or delete metadata required to fence it.
    for attempt_id in (attempt,locals().get("killed"),locals().get("descendant_id"),locals().get("environment_id"),locals().get("escaped_id"),locals().get("missing_id")):
        if attempt_id:
            try:request("cancel",attemptId=attempt_id)
            except Exception:pass

    # Failure cleanup can fence only this fixture's explicitly observed child.
    if "escaped_pid" in locals():
        process=Path(f"/proc/{escaped_pid}/stat")
        if process.exists():
            info=process.read_text().rsplit(") ",1)[1].split()
            if info[19]==escaped_start and info[0] not in ("Z","X"):
                os.kill(escaped_pid,signal.SIGKILL)
