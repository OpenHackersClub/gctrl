#!/usr/bin/env python3
"""Test-only lost transport acknowledgment after real target dispatch."""
import json
from pathlib import Path
import subprocess
import sys
import time

request = json.load(sys.stdin)
result = subprocess.run([sys.executable, str(Path(__file__).with_name("supervisor.py"))], input=json.dumps(request), text=True, capture_output=True, check=True)
print(result.stdout, end="", flush=True)
# The actual supervisor has already dispatched a detached durable attempt.
# Keep this RPC open so the kernel's owned SSH client times out/disconnects.
time.sleep(20)
