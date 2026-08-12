"""Config-driven Discord bot/webhook wake admission.

Hermes Discord defaults to ``DISCORD_ALLOW_BOTS=none``, so webhook posts are
dropped before a turn starts (they only show up later as history context when
a human nudges). This module is the narrow, env-gated exception:

Wake when ALL of:
  - channel/thread id is in ``DISCORD_BOT_WAKE_CHANNELS`` (thread id and/or parent)
  - author is bot-like (``author.bot`` or ``message.webhook_id``)
  - author display/name matches ``DISCORD_BOT_WAKE_AUTHORS``

Optional JSON preference (default soft — does not block wake):
  - content embeds JSON with ``source`` matching ``DISCORD_BOT_WAKE_JSON_SOURCE``
    (default ``grok-bot``) and ``type`` in ``DISCORD_BOT_WAKE_JSON_TYPES``
    (default ``ping,approved_fix,status``)
  - set ``DISCORD_BOT_WAKE_REQUIRE_JSON=true`` to require that JSON match

Inactive until both channel and author lists are configured.
Does not change global ``DISCORD_ALLOW_BOTS``, require_mention, or free-response.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any, Iterable, Mapping, Optional, Sequence, Set

DEFAULT_JSON_SOURCE = "grok-bot"
DEFAULT_JSON_TYPES = ("ping", "approved_fix", "status")

_JSON_OBJECT_RE = re.compile(r"\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}", re.DOTALL)


def _csv_set(raw: Optional[str]) -> Set[str]:
    if not isinstance(raw, str) or not raw.strip():
        return set()
    return {part.strip() for part in raw.split(",") if part.strip()}


def _env_csv(name: str, default: str = "") -> Set[str]:
    return _csv_set(os.getenv(name, default))


def _truthy(raw: Optional[str]) -> bool:
    return str(raw or "").strip().lower() in {"1", "true", "yes", "on"}


def author_name_candidates(author: Any) -> Set[str]:
    """Lowercased display/name candidates for webhook/bot authors."""
    names: Set[str] = set()
    if author is None:
        return names
    for attr in ("display_name", "global_name", "name"):
        value = getattr(author, attr, None)
        if isinstance(value, str) and value.strip():
            names.add(value.strip().casefold())
    return names


def message_channel_ids(message: Any) -> Set[str]:
    """Channel id plus parent id when the message is in a thread."""
    ids: Set[str] = set()
    channel = getattr(message, "channel", None)
    if channel is None:
        return ids
    cid = getattr(channel, "id", None)
    if cid is not None:
        ids.add(str(cid))
    parent_id = getattr(channel, "parent_id", None)
    if parent_id is not None:
        ids.add(str(parent_id))
    return ids


def is_bot_like_message(message: Any) -> bool:
    author = getattr(message, "author", None)
    if bool(getattr(author, "bot", False)):
        return True
    return bool(getattr(message, "webhook_id", None))


def message_text(message: Any) -> str:
    content = getattr(message, "content", None)
    parts: list[str] = []
    if isinstance(content, str) and content.strip():
        parts.append(content)
    embeds = getattr(message, "embeds", None) or ()
    for embed in embeds:
        for attr in ("title", "description"):
            value = getattr(embed, attr, None)
            if isinstance(value, str) and value.strip():
                parts.append(value)
        # discord.Embed.fields may be a list of objects with .name/.value
        for field in getattr(embed, "fields", None) or ():
            for attr in ("name", "value"):
                value = getattr(field, attr, None)
                if isinstance(value, str) and value.strip():
                    parts.append(value)
    return "\n".join(parts)


def iter_json_objects(text: str) -> Iterable[Mapping[str, Any]]:
    """Best-effort JSON object scan (message may have a human preface)."""
    if not isinstance(text, str) or not text.strip():
        return
    stripped = text.strip()
    # Fast path: whole message is JSON
    try:
        parsed = json.loads(stripped)
        if isinstance(parsed, dict):
            yield parsed
            return
    except Exception:
        pass
    for match in _JSON_OBJECT_RE.finditer(text):
        blob = match.group(0)
        try:
            parsed = json.loads(blob)
        except Exception:
            continue
        if isinstance(parsed, dict):
            yield parsed


def json_job_match(
    text: str,
    *,
    source: str = DEFAULT_JSON_SOURCE,
    types: Sequence[str] = DEFAULT_JSON_TYPES,
) -> bool:
    wanted_types = {str(t).strip() for t in types if str(t).strip()}
    wanted_source = (source or "").strip()
    for obj in iter_json_objects(text):
        if wanted_source and str(obj.get("source") or "").strip() != wanted_source:
            continue
        typ = str(obj.get("type") or "").strip()
        if wanted_types and typ not in wanted_types:
            continue
        return True
    return False


def bot_wake_config_from_env() -> dict:
    channels = _env_csv("DISCORD_BOT_WAKE_CHANNELS")
    authors = {a.casefold() for a in _env_csv("DISCORD_BOT_WAKE_AUTHORS")}
    json_source = (os.getenv("DISCORD_BOT_WAKE_JSON_SOURCE") or DEFAULT_JSON_SOURCE).strip()
    json_types = _env_csv(
        "DISCORD_BOT_WAKE_JSON_TYPES",
        ",".join(DEFAULT_JSON_TYPES),
    )
    require_json = _truthy(os.getenv("DISCORD_BOT_WAKE_REQUIRE_JSON"))
    return {
        "channels": channels,
        "authors": authors,
        "json_source": json_source,
        "json_types": json_types,
        "require_json": require_json,
        "active": bool(channels and authors),
    }


def bot_wake_admit(
    message: Any,
    *,
    channels: Optional[Set[str]] = None,
    authors: Optional[Set[str]] = None,
    json_source: Optional[str] = None,
    json_types: Optional[Set[str]] = None,
    require_json: Optional[bool] = None,
) -> bool:
    """Return True when this bot/webhook message should start a Hermes turn."""
    cfg = bot_wake_config_from_env()
    watch_channels = channels if channels is not None else cfg["channels"]
    watch_authors = authors if authors is not None else cfg["authors"]
    if not watch_channels or not watch_authors:
        return False
    if not is_bot_like_message(message):
        return False
    if not (set(watch_channels) & message_channel_ids(message)):
        return False
    author_names = author_name_candidates(getattr(message, "author", None))
    if not (set(watch_authors) & author_names):
        return False

    src = cfg["json_source"] if json_source is None else json_source
    types = cfg["json_types"] if json_types is None else json_types
    must_json = cfg["require_json"] if require_json is None else bool(require_json)
    text = message_text(message)
    matched = json_job_match(text, source=src or DEFAULT_JSON_SOURCE, types=tuple(types) or DEFAULT_JSON_TYPES)
    if must_json:
        return matched
    # Soft preference: JSON match is nice; author+channel is enough to wake.
    return True


__all__ = [
    "DEFAULT_JSON_SOURCE",
    "DEFAULT_JSON_TYPES",
    "author_name_candidates",
    "bot_wake_admit",
    "bot_wake_config_from_env",
    "is_bot_like_message",
    "iter_json_objects",
    "json_job_match",
    "message_channel_ids",
    "message_text",
]
