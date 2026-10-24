"""Synthetic staging outbox (separate process). Not real SMTP.

  POST /staging/outbox   write token (the agent)       {to, subject, body, ref} -> 201
  GET  /staging/outbox?ref=<id>  read token (verifier)  -> {emails: [...]}

Write and read credentials are separate: the agent cannot read, the verifier cannot write.
Run: python -m shop_agent.staging_outbox --port 8010
"""
from __future__ import annotations

import argparse
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

EMAILS: list[dict] = []
LOCK = threading.Lock()


def make_handler(write_token: str, read_token: str):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def _send(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            if urlparse(self.path).path != "/staging/outbox":
                return self._send(404, {"error": "not found"})
            if self.headers.get("Authorization") != f"Bearer {write_token}":
                return self._send(401, {"error": "write token required"})
            n = int(self.headers.get("Content-Length") or 0)
            if n > 64 * 1024:
                return self._send(413, {"error": "too large"})
            m = json.loads(self.rfile.read(n) or b"{}")
            if not all(isinstance(m.get(k), str) for k in ("to", "subject", "body", "ref")):
                return self._send(422, {"error": "to, subject, body, ref required"})
            with LOCK:
                EMAILS.append({k: m[k] for k in ("to", "subject", "body", "ref")})
            self._send(201, {"stored": True})

        def do_GET(self):
            u = urlparse(self.path)
            if u.path != "/staging/outbox":
                return self._send(404, {"error": "not found"})
            if self.headers.get("Authorization") != f"Bearer {read_token}":
                return self._send(401, {"error": "read token required"})
            ref = parse_qs(u.query).get("ref", [""])[0]
            with LOCK:
                emails = [e for e in EMAILS if e["ref"] == ref]
            self._send(200, {"emails": emails})

    return Handler


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("STAGING_PORT", "8010")))
    a = ap.parse_args(argv)
    write, read = os.environ["STAGING_WRITE_TOKEN"], os.environ["STAGING_READ_TOKEN"]
    if write == read:
        raise SystemExit("STAGING_WRITE_TOKEN and STAGING_READ_TOKEN must differ")
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), make_handler(write, read))
    print(json.dumps({"event": "listening", "port": srv.server_address[1]}), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
