"""Calls the tool endpoints the test host gave us for this run (bridge contract v1).

The agent owns this client. It only ever talks to the exact toolsUrl it received, sends the
run-scoped bearer token, and never logs the token.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass, field


class ToolLimitReached(Exception):
    pass


@dataclass
class ToolsClient:
    tools_url: str
    token: str
    allowed: set[str]
    max_calls: int
    timeout_s: float = 30.0
    calls: int = 0
    log: list[dict] = field(default_factory=list)

    def call(self, name: str, args: dict) -> dict:
        if name not in self.allowed:
            return {"success": False, "error": f"tool not offered by the test host: {name}"}
        if self.calls >= self.max_calls:
            raise ToolLimitReached(f"maxToolCalls={self.max_calls}")
        self.calls += 1
        req = urllib.request.Request(
            f"{self.tools_url}/{name}",
            data=json.dumps(args).encode(),
            method="POST",
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
                # Safe retries on our side never duplicate a side effect.
                "Idempotency-Key": str(uuid.uuid4()),
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_s) as res:
                out = json.loads(res.read().decode())
        except urllib.error.HTTPError as e:
            try:
                out = json.loads(e.read().decode())
            except Exception:
                out = {"success": False, "error": f"HTTP {e.code}"}
        self.log.append({"tool": name, "args": args, "success": out.get("success")})
        return out
