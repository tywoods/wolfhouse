"""Deterministic explicit human-request handoff for Hermes Luna.

When a guest clearly asks to transfer to a human teammate, call
``flag_needs_human`` with reason ``human_requested`` *before* continuing
booking automation. The successful tool result remains authoritative.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

HUMAN_REQUESTED = "human_requested"

# Non-transfer messages that mention staff/human/person — must not hand off.
_EXCLUSION_RE = re.compile(
    r"(?ix)"
    r"("
    r"human[\s\-]?sized"
    r"|reception"
    r"|check[\s\-]?in"
    r"|arrange\s+(?:a\s+)?taxi"
    r"|friend\s+is\s+a\s+staff"
    r"|staff\s+member"
    r"|are\s+there\s+staff"
    r"|is\s+someone\s+there"
    r"|what\s+time\s+is\s+reception"
    r"|staff\s+at\s+reception"
    r"|can\s+staff\s+arrange"
    r")"
)

# Clear transfer / takeover intents (EN / ES / IT + close paraphrases).
_TRANSFER_RE = re.compile(
    r"(?ix)"
    r"("
    # English
    r"(?:speak|talk)\s+to\s+(?:a\s+)?(?:human|real\s+person|person|someone|manager|teammate|staff)"
    r"|(?:want|need|like)\s+to\s+(?:speak|talk)\s+to\s+(?:a\s+)?"
    r"(?:human|real\s+person|person|someone|manager|teammate|staff)"
    r"|get\s+someone\s+from\s+the\s+team"
    r"|can\s+a\s+manager\s+contact\s+me"
    r"|(?:stop|kill)\s+the\s+bot"
    r"|i\s+need\s+staff"
    r"|transfer\s+me\s+to\s+(?:a\s+)?(?:human|person|staff|manager)"
    r"|hand\s*me\s+off"
    # Spanish
    r"|quiero\s+hablar\s+con\s+(?:una\s+)?(?:persona|alguien|un\s+humano)"
    r"|puedo\s+hablar\s+con\s+(?:una\s+)?(?:persona|alguien)"
    r"|hablar\s+con\s+alguien\s+del\s+equipo"
    r"|hablar\s+con\s+(?:una\s+)?persona(?:\s+real)?"
    # Italian
    r"|vorrei\s+parlare\s+con\s+(?:una\s+)?(?:persona|qualcuno)"
    r"|posso\s+parlare\s+con\s+(?:una\s+)?(?:persona|qualcuno)"
    r"|parlare\s+con\s+qualcuno\s+dello\s+staff"
    r"|parlare\s+con\s+(?:una\s+)?persona(?:\s+reale)?"
    r")"
)


def is_explicit_human_request(message_text: Any) -> bool:
    """True only when the guest asks to transfer to a human teammate."""
    text = str(message_text or "").strip()
    if not text:
        return False
    if _EXCLUSION_RE.search(text):
        return False
    return bool(_TRANSFER_RE.search(text))


def acknowledgement_for(message_text: Any) -> str:
    """One short, warm handoff ack — no question."""
    t = str(message_text or "").lower()
    if re.search(r"[áéíóúñ¿¡]|quiero|puedo|hablar|persona|equipo", t):
        return "Claro — te paso con alguien del equipo y te atienden enseguida."
    if re.search(r"vorrei|posso|parlare|persona|qualcuno|staff", t):
        return "Certo — ti passo al team e ti rispondono al più presto."
    return "Of course — I’m looping in a teammate now and they’ll take over from here."


def execute_explicit_human_handoff(*, reason: str = HUMAN_REQUESTED) -> Dict[str, Any]:
    """Call flag_needs_human via the Staff plugin (runtime tenant + session phone)."""
    reason_code = str(reason or HUMAN_REQUESTED).strip() or HUMAN_REQUESTED
    try:
        from wolfhouse_staff_api import flag_needs_human  # type: ignore
    except Exception:
        try:
            import importlib

            mod = importlib.import_module("wolfhouse_staff_api")
            flag_needs_human = getattr(mod, "flag_needs_human")
        except Exception as exc:
            logger.warning(
                "%s",
                {"event": "explicit_human_handoff_import_failed", "error_type": type(exc).__name__},
            )
            return {
                "success": False,
                "tool": "flag_needs_human",
                "reason": reason_code,
                "needs_human": False,
                "error": "flag_needs_human_unavailable",
            }

    raw = flag_needs_human({"reason": reason_code})
    if isinstance(raw, str):
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            data = {"success": False, "raw": raw[:200]}
    else:
        data = dict(raw or {})
    data.setdefault("tool", "flag_needs_human")
    data["reason"] = reason_code
    data["explicit_human_request"] = True
    return data


async def maybe_short_circuit_explicit_human(
    event: Any,
    adapter_dispatch: Any,
) -> Optional[Dict[str, Any]]:
    """If inbound is an explicit human request: hand off, send one ack, skip agent."""
    text = ""
    try:
        text = str(getattr(event, "text", None) or getattr(event, "message_text", None) or "")
        if not text and isinstance(event, dict):
            text = str(event.get("text") or event.get("message_text") or "")
    except Exception:
        text = ""

    if not is_explicit_human_request(text):
        return None

    tool_result = execute_explicit_human_handoff(reason=HUMAN_REQUESTED)
    reply = acknowledgement_for(text)
    sent = False
    try:
        adapter = getattr(adapter_dispatch, "adapter", None)
        chat_id = getattr(event, "chat_id", None) or getattr(event, "sender_id", None)
        if adapter is not None and chat_id is not None and hasattr(adapter, "send"):
            await adapter.send(chat_id, reply)
            sent = True
    except Exception as exc:
        logger.warning(
            "%s",
            {
                "event": "explicit_human_ack_send_failed",
                "error_type": type(exc).__name__,
            },
        )

    return {
        "short_circuited": True,
        "tool": "flag_needs_human",
        "reason": HUMAN_REQUESTED,
        "tool_result": tool_result,
        "reply": reply,
        "ack_sent": sent,
        "needs_human": bool(tool_result.get("needs_human")),
        "conversation_paused": bool(tool_result.get("conversation_paused")),
    }
