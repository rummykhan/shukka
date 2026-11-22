#!/usr/bin/env python3
"""shukkatest web: a tiny HTTP server for shukka's acceptance suite.

GET /health  200 "ok <revision>" when health.json says {"healthy": true}, else 500
GET /version the release's REVISION (written by shukka-release.sh next to this file)
GET /        page.txt, greeting.txt (a build-time value) and the revision
"""
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.realpath(__file__))
PORT = int(os.environ.get("PORT", "8080"))


def read(name, default=""):
    try:
        with open(os.path.join(HERE, name), encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return default


def healthy():
    try:
        return bool(json.loads(read("health.json", "{}")).get("healthy", False))
    except ValueError:
        return False


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 (http.server's naming)
        revision = read("REVISION", "unknown")
        if self.path == "/health":
            if healthy():
                self.reply(200, f"ok {revision}\n")
            else:
                self.reply(500, f"unhealthy {revision}\n")
        elif self.path == "/version":
            self.reply(200, f"{revision}\n")
        elif self.path == "/":
            self.reply(200, f"{read('page.txt')}\ngreeting: {read('greeting.txt')}\nrevision: {revision}\n")
        else:
            self.reply(404, "not found\n")

    def reply(self, code, body):
        data = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
