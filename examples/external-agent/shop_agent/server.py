"""HTTP server exposing the agent.

  GET  /health
  GET  /agent/capabilities   bridge v1 handshake (declared capabilities)
  POST /agent/run            bridge v1: run a task using the test host's tools
  POST /chat                 black-box chat endpoint {message, conversation_id} -> {reply}

Binds to 127.0.0.1 by default. Optional bearer auth with AGENT_API_TOKEN.
Run: python -m shop_agent.server --variant baseline --port 8000
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from . import __version__
from .graph import run_task
from .invoice import handle_chat
from .tools_client import ToolsClient

MAX_BODY = 256 * 1024


class Limits(BaseModel):
    model_config = ConfigDict(extra="forbid")
    maxToolCalls: int = Field(ge=1, le=1000)
    maxSeconds: int = Field(ge=1, le=3600)


class ToolDef(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["function"]
    name: str
    description: str | None = None
    parameters: dict


class RunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    protocolVersion: Literal["1"]
    runId: str
    task: str = Field(min_length=1, max_length=4000)
    toolsUrl: str
    toolsToken: str = Field(min_length=32)
    tools: list[ToolDef]
    limits: Limits


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    message: str = Field(min_length=1, max_length=4000)
    conversation_id: str = Field(min_length=1, max_length=100)


def log(event: str, **fields) -> None:
    fields.pop("toolsToken", None)
    print(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "event": event, **fields}), flush=True)


def make_handler(variant: str, api_token: str | None):
    class Handler(BaseHTTPRequestHandler):
        server_version = f"shop-agent/{__version__}"

        def log_message(self, *_):  # quiet default access log; we log JSON lines instead
            pass

        def _send(self, status: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _authorized(self) -> bool:
            return not api_token or self.headers.get("Authorization") == f"Bearer {api_token}"

        def _json(self):
            n = int(self.headers.get("Content-Length") or 0)
            if n > MAX_BODY:
                raise ValueError("payload too large")
            return json.loads(self.rfile.read(n) or b"{}")

        def do_GET(self):
            if self.path == "/health":
                return self._send(200, {"ok": True, "variant": variant})
            if self.path == "/agent/capabilities":
                return self._send(200, {
                    "protocolVersion": "1",
                    "agent": {"name": f"shop-agent-{variant}", "version": __version__, "framework": "langgraph==1.2.17"},
                    "capabilities": {
                        "canAcceptTask": True, "canUseInjectedTools": True, "canObserveToolCalls": True,
                        "canResetSession": True, "canRunConcurrentTasks": True,
                        "canReadSource": False, "canPatchSource": False,
                    },
                })
            self._send(404, {"error": "not found"})

        def do_POST(self):
            if not self._authorized():
                return self._send(401, {"error": "unauthorized"})
            try:
                body = self._json()
            except Exception as e:  # noqa: BLE001
                return self._send(400, {"error": str(e)})
            if self.path == "/agent/run":
                try:
                    req = RunRequest.model_validate(body)
                except ValidationError as e:
                    return self._send(422, {"error": "invalid bridge request", "detail": e.errors(include_url=False)[:5]})
                client = ToolsClient(req.toolsUrl, req.toolsToken, {t.name for t in req.tools}, req.limits.maxToolCalls)
                log("run.start", runId=req.runId, variant=variant, tools=sorted(client.allowed))
                message = run_task(req.task, client, variant, req.limits.maxSeconds)
                log("run.end", runId=req.runId, toolCalls=client.log, finalMessage=message)
                return self._send(200, {"protocolVersion": "1", "runId": req.runId, "finalMessage": message})
            if self.path == "/chat":
                try:
                    req = ChatRequest.model_validate(body)
                except ValidationError:
                    return self._send(422, {"error": "invalid chat request"})
                reply = handle_chat(req.message, req.conversation_id, variant)
                log("chat", ref=req.conversation_id, variant=variant, reply=reply)
                return self._send(200, {"reply": reply})
            self._send(404, {"error": "not found"})

    return Handler


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--variant", default=os.environ.get("AGENT_VARIANT", "baseline"), choices=["baseline", "candidate", "wrong-item"])
    ap.add_argument("--host", default=os.environ.get("AGENT_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("AGENT_PORT", "8000")))
    a = ap.parse_args(argv)
    srv = ThreadingHTTPServer((a.host, a.port), make_handler(a.variant, os.environ.get("AGENT_API_TOKEN")))
    log("listening", host=a.host, port=srv.server_address[1], variant=a.variant, planner=os.environ.get("AGENT_PLANNER", "scripted"))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
        log("stopped")
        sys.exit(0)


if __name__ == "__main__":
    main()
