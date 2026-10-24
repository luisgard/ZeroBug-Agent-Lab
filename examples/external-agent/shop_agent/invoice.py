"""Black-box mode: a plain chat endpoint that sends invoices through the agent's OWN staging outbox.

ZeroBug does not route these tools. It can only see the reply, plus whatever a separately granted
read-only verifier exposes (the staging outbox read API).
"""
from __future__ import annotations

import json
import os
import re
import urllib.request
from typing import Optional, TypedDict

from langgraph.graph import END, START, StateGraph


class InvoiceState(TypedDict, total=False):
    message: str
    ref: str
    variant: str
    invoice: Optional[str]
    to: Optional[str]
    sent: bool
    error: Optional[str]
    reply: str


def build_invoice_graph(outbox_url: str | None, write_token: str | None):
    def parse(state: InvoiceState) -> dict:
        inv = re.search(r"\b(INV-\d+)\b", state["message"])
        to = re.search(r"[\w.+-]+@[\w-]+(\.[\w-]+)+", state["message"])
        return {"invoice": inv.group(1) if inv else None, "to": to.group(0) if to else None}

    def send(state: InvoiceState) -> dict:
        # The candidate variant regressed: it skips the actual send but still reports success.
        if state["variant"] == "candidate" or not state.get("invoice") or not state.get("to"):
            return {"sent": False}
        if not outbox_url or not write_token:
            return {"sent": False, "error": "no outbox configured"}
        body = {"to": state["to"], "subject": f"Invoice {state['invoice']}", "body": "Synthetic invoice for testing.", "ref": state["ref"]}
        req = urllib.request.Request(
            outbox_url, data=json.dumps(body).encode(), method="POST",
            headers={"Authorization": f"Bearer {write_token}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as res:
                return {"sent": res.status == 201}
        except Exception as e:  # noqa: BLE001 - report, don't crash
            return {"sent": False, "error": type(e).__name__}

    def reply(state: InvoiceState) -> dict:
        if state["variant"] == "candidate" or state.get("sent"):
            return {"reply": f"I sent the invoice {state.get('invoice')} to {state.get('to')}."}
        return {"reply": f"I could not send the invoice ({state.get('error') or 'missing details'})."}

    g = StateGraph(InvoiceState)
    g.add_node("parse", parse)
    g.add_node("send", send)
    g.add_node("reply", reply)
    g.add_edge(START, "parse")
    g.add_edge("parse", "send")
    g.add_edge("send", "reply")
    g.add_edge("reply", END)
    return g.compile(name="invoice-agent")


def handle_chat(message: str, ref: str, variant: str) -> str:
    graph = build_invoice_graph(os.environ.get("STAGING_OUTBOX_URL"), os.environ.get("STAGING_WRITE_TOKEN"))
    return graph.invoke({"message": message, "ref": ref, "variant": variant})["reply"]
