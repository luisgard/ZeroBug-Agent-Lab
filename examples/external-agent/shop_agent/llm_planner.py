"""Optional real-model planner (AGENT_PLANNER=openai). Requires requirements-llm.txt and OPENAI_API_KEY.

NOT exercised in this repository's CI: no model credentials were available. It is provided so the
same graph can run with a real model; treat its behavior as unverified until run with a key.
"""
from __future__ import annotations

import json
import os

from .graph import INSTRUCTIONS


def llm_plan(state, client) -> dict:
    from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
    from langchain_openai import ChatOpenAI

    model = ChatOpenAI(model=os.environ.get("AGENT_MODEL", "gpt-5.5"), temperature=0)
    tools = [{"type": "function", "function": {"name": n, "description": n, "parameters": {"type": "object"}}} for n in sorted(client.allowed)]
    messages = [SystemMessage(INSTRUCTIONS[state["variant"]]), HumanMessage(state["task"])]
    for i, o in enumerate(state.get("observations", [])):
        call_id = f"c{i}"
        messages.append(AIMessage(content="", tool_calls=[{"id": call_id, "name": o["tool"], "args": {}}]))
        messages.append(ToolMessage(tool_call_id=call_id, content=json.dumps({k: v for k, v in o.items() if k != "tool"})))
    reply = model.bind_tools(tools).invoke(messages)
    if reply.tool_calls:
        tc = reply.tool_calls[0]
        return {"tool": tc["name"], "args": tc["args"], "phase": "llm"}
    return {"respond": True, "final_message": reply.content}
