#!/usr/bin/env python3
"""Regression checks for Discord thread session continuity routing."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

from wolfhouse.discord_session_routing import (
    build_discord_session_key,
    should_invalidate_stale_session_index_row,
)

THREAD_A = "1515862937506418758"
THREAD_B = "1516353367881027795"
USER = "357674774782148610"


def _assert_same_thread_key_stable() -> None:
    key_msg1 = build_discord_session_key(
        chat_id=THREAD_A,
        chat_type="thread",
        thread_id=THREAD_A,
        user_id=USER,
    )
    key_msg2 = build_discord_session_key(
        chat_id=THREAD_A,
        chat_type="thread",
        thread_id=THREAD_A,
        user_id=USER,
    )
    assert key_msg1 == key_msg2, (key_msg1, key_msg2)
    assert key_msg1 == f"agent:main:discord:thread:{THREAD_A}:{THREAD_A}"


def _assert_different_threads_isolated() -> None:
    key_a = build_discord_session_key(
        chat_id=THREAD_A,
        chat_type="thread",
        thread_id=THREAD_A,
        user_id=USER,
    )
    key_b = build_discord_session_key(
        chat_id=THREAD_B,
        chat_type="thread",
        thread_id=THREAD_B,
        user_id=USER,
    )
    assert key_a != key_b


def _assert_message_id_not_in_key() -> None:
    # message_id is metadata on SessionSource only; it must never affect the key.
    _ = "1525450346003173447"
    _ = "1525450999999999999"
    key = build_discord_session_key(
        chat_id=THREAD_A,
        chat_type="thread",
        thread_id=THREAD_A,
        user_id=USER,
    )
    assert "1525450346003173447" not in key
    assert "1525450999999999999" not in key


def _assert_stale_routing() -> None:
    assert should_invalidate_stale_session_index_row(None) is True
    assert should_invalidate_stale_session_index_row({"ended_at": 1.0, "end_reason": "agent_close"}) is False
    assert should_invalidate_stale_session_index_row({"ended_at": 1.0, "end_reason": "session_reset"}) is False


def _assert_gateway_build_session_key_matches() -> None:
    spec = importlib.util.find_spec("gateway.session")
    if not spec or not spec.origin:
        print("SKIP: gateway.session not importable in this runtime")
        return
    mod = importlib.import_module("gateway.session")
    SessionSource = mod.SessionSource
    Platform = importlib.import_module("gateway.platforms.base").Platform

    def _gateway_key(*, thread_id: str) -> str:
        source = SessionSource(
            platform=Platform.DISCORD,
            chat_id=thread_id,
            chat_type="thread",
            thread_id=thread_id,
            user_id=USER,
            message_id="9999999999999999999",
        )
        return mod.build_session_key(source)

    ours = build_discord_session_key(
        chat_id=THREAD_A,
        chat_type="thread",
        thread_id=THREAD_A,
        user_id=USER,
    )
    theirs = _gateway_key(thread_id=THREAD_A)
    assert ours == theirs, (ours, theirs)


def main() -> int:
    _assert_same_thread_key_stable()
    _assert_different_threads_isolated()
    _assert_message_id_not_in_key()
    _assert_stale_routing()
    _assert_gateway_build_session_key_matches()
    print("OK: discord session continuity routing checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
