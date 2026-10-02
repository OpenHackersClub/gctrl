#!/usr/bin/env python3
"""Live target identity gate; run on the disposable Linux acceptance host."""
import json
import os
import subprocess
import sys

helper = sys.argv[1]

def request(payload):
    result = subprocess.run([sys.executable, helper], input=json.dumps(payload), text=True, capture_output=True, check=True, timeout=15)
    return json.loads(result.stdout)

probe = request({"operation":"discover"})
assert "error" not in probe, probe
assert probe["capabilities"]["display"] == "x11"
assert probe["capabilities"]["accessibility"] is True
assert probe["capabilities"]["input"] is False, "this observation-only helper must not claim input support"
identities = [target for target in probe["targets"] if target["application"]["application"] in ("gctrl acceptance Editor", "gctrl acceptance Tracker")]
assert len(identities) == 2, probe
assert identities[0]["desktop"] == identities[1]["desktop"], "windows on one display must share the actual runtime"
assert identities[0]["id"] != identities[1]["id"]
for identity in identities:
    assert all(identity["desktop"].values()), identity
    assert identity["application"]["process_incarnation"].startswith(open("/proc/sys/kernel/random/boot_id").read().strip() + ":")
    observation = request({"operation":"observe", "target":identity})
    assert "error" not in observation, observation
    assert observation["target"] == identity
    assert "Ready" in observation["text"] and "Apply" in observation["text"]
    assert observation["revision"]
    foreign = json.loads(json.dumps(identity))
    foreign["application"]["window_incarnation"] = "reused-window"
    denied = request({"operation":"observe", "target":foreign})
    assert denied["error"]["kind"] == "stale", denied
assert request({"operation":"apply", "target":identities[0]})["error"]["kind"] == "unsupported"
assert request({"operation":"invent"})["error"]["kind"] == "invalid"
print("native identity gate: two real applications, shared runtime, complete incarnations, accessibility observation, stale replacement denied")
