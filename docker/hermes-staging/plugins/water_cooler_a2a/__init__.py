"""Water-cooler A2A controlled outbound plugin (Seadog + Deckhand only).

Registration is opt-in via Hermes ``plugins.enabled`` and the
``water_cooler_a2a`` toolset. Luna / Sunset Luna / orchestrator configs must
not list this plugin. The tool accepts only bounded body text; destination,
channel, peer, round, and task_id are retrieved from task-scoped runtime
context established after a valid bridge DISPATCH_*.

Default inactive: no adapter wiring, no env enablement in this module.
"""

from __future__ import annotations

from typing import Any

TOOLSET = "water_cooler_a2a"
TOOL_NAME = "water_cooler_a2a_send"

_TOOL_DESCRIPTION = (
    "Send the authorized Water-cooler A2A peer envelope for the current task "
    "(handoff to Deckhand or review to Seadog). Call only when you have "
    "finished the work for this A2A turn. Pass only the bounded handoff or "
    "review body text — never invent task_id, channel, recipient, or protocol "
    "headers. Destination and task identity are fixed by the runtime; plain "
    "chat replies are not A2A. Fails closed when no authorized task context "
    "exists."
)


def _schema() -> dict:
    return {
        "name": TOOL_NAME,
        "description": _TOOL_DESCRIPTION,
        "parameters": {
            "type": "object",
            "properties": {
                "body": {
                    "type": "string",
                    "description": (
                        "Bounded handoff or review notes for the peer. Do not "
                        "include A2A-HANDOFF/A2A-REVIEW headers, task_id lines, "
                        "or destination mentions — the runtime adds those."
                    ),
                },
            },
            # body optional so empty notes are allowed; action still fail-closed
            # without authorized context.
            "required": [],
            "additionalProperties": False,
        },
    }


def _handler(body: str = "", **kwargs: Any) -> dict:
    """Tool handler: only body is used; all other kwargs are ignored."""
    try:
        from wolfhouse.water_cooler_a2a_action import water_cooler_a2a_send
    except ImportError:
        try:
            from water_cooler_a2a_action import water_cooler_a2a_send  # type: ignore
        except ImportError:
            return {
                "success": False,
                "reason": "action_module_unavailable",
                "task_id": None,
                "envelope_kind": None,
                "message_id": None,
            }
    # Strip any model-supplied steering fields before calling the action.
    _ = kwargs
    return water_cooler_a2a_send(body=body if body is not None else "")


def register(ctx: Any) -> None:
    """Register the single controlled outbound tool with Hermes."""
    ctx.register_tool(
        name=TOOL_NAME,
        toolset=TOOLSET,
        schema=_schema(),
        handler=_handler,
        description=_TOOL_DESCRIPTION,
    )


__all__ = ["TOOL_NAME", "TOOLSET", "register"]
