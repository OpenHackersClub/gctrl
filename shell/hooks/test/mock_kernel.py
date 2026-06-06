#!/usr/bin/env python3
"""Minimal mock of the gctrl kernel inbox intake for bats tests.

Usage: mock_kernel.py <port> <capture_file>

POST /api/inbox/messages — appends the request body (one JSON object per
line) to <capture_file> and replies 201 {"id": "..."}.
GET on any path replies 200 (used as a readiness probe).
"""

import json
import sys
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    capture_file = None

    def do_GET(self):  # readiness probe
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        with open(self.capture_file, "a") as f:
            f.write(body.decode("utf-8").replace("\n", " ") + "\n")
        self.send_response(201)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"id": str(uuid.uuid4())}).encode())

    def log_message(self, *args):  # silence request logging
        pass


def main():
    port, capture = int(sys.argv[1]), sys.argv[2]
    Handler.capture_file = capture
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
