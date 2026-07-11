"""Discord session-key helpers for Wolfhouse gateway regression tests."""

from __future__ import annotations

from typing import Optional


def _session_key_namespace(profile: Optional[str]) -> str:
    if not profile or profile == "default":
        return "agent:main"
    return f"agent:{profile}"


def build_discord_session_key(
    *,
    chat_id: str,
    chat_type: str,
    thread_id: Optional[str] = None,
    user_id: Optional[str] = None,
    group_sessions_per_user: bool = True,
    thread_sessions_per_user: bool = False,
    profile: Optional[str] = None,
) -> str:
    """Mirror gateway.session.build_session_key for Discord non-DM sources."""
    ns = _session_key_namespace(profile)
    platform = "discord"
    key_parts = [ns, platform, chat_type, chat_id]
    if thread_id:
        key_parts.append(thread_id)

    isolate_user = group_sessions_per_user
    if thread_id and not thread_sessions_per_user:
        isolate_user = False
    if isolate_user and user_id:
        key_parts.append(str(user_id))
    return ":".join(key_parts)


def should_invalidate_stale_session_index_row(db_row) -> bool:
    """Return True only when sessions.json points at a missing SQLite row.

    ``agent_close`` sets ``ended_at`` after every gateway turn. That is normal
    and must not rotate the session mapping on the next inbound message.
    """
    return db_row is None
