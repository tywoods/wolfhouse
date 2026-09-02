#!/usr/bin/env python3
"""Executable gate: session-key reset does not wipe shared memory or a second same-phone session."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "wolfhouse_guest_fresh_start",
    ROOT / "wolfhouse_guest_fresh_start.py",
)
mod = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(mod)

PASS = 0
FAIL = 0


def ok(name: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS  {name}")
    else:
        FAIL += 1
        extra = f" — {detail}" if detail else ""
        print(f"  FAIL  {name}{extra}", file=sys.stderr)


class _Lock:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeDb:
    def __init__(self):
        self.deleted = []

    def delete_session(self, session_id, _sessions_dir):
        self.deleted.append(session_id)
        return True


class FakeStore:
    def __init__(self, entries):
        self._entries = dict(entries)
        self._lock = _Lock()
        self._db = FakeDb()
        self.sessions_dir = None
        self.saved = 0

    def _ensure_loaded(self):
        return None

    def _save(self):
        self.saved += 1


class FakeRunner:
    def __init__(self, entries):
        self.session_store = FakeStore(entries)
        self.purged = []
        self.evicted = []
        self._agent_cache = {}
        self._queued_events = {key: ["queued"] for key in entries}
        self._session_model_overrides = {key: "x" for key in entries}
        self._pending_model_notes = {key: "n" for key in entries}

    def _session_key_for_source(self, source):
        digits = "".join(ch for ch in str(getattr(source, "user_id", "") or "") if ch.isdigit())
        return f"whatsapp_cloud:dm:{digits}"

    def _invalidate_session_run_generation(self, session_key, reason=""):
        self.purged.append((session_key, reason))

    def _cleanup_agent_resources(self, _agent):
        return None

    def _evict_cached_agent(self, session_key):
        self.evicted.append(session_key)

    def _set_session_reasoning_override(self, session_key, value):
        return None

    def _clear_session_boundary_security_state(self, session_key):
        return None


def _entry(session_id: str):
    return SimpleNamespace(session_id=session_id)


def main() -> int:
    print("\nverify_inbox_clear_session_key.py — session-key isolation\n")

    def boom(*_a, **_k):
        raise AssertionError("shared-memory deletion is forbidden on the Inbox Clear path")

    mod.clear_luna_agent_memories = boom
    orig_list = mod._list_whatsapp_session_ids

    def boom_list(*_a, **_k):
        raise AssertionError("phone-wide session listing is forbidden on the Inbox Clear path")

    mod._list_whatsapp_session_ids = boom_list

    key_a = "whatsapp_cloud:dm:34600000001"
    key_a_other_source = "whatsapp:dm:34600000001"
    key_b = "whatsapp_cloud:dm:34600000002"
    runner = FakeRunner({
        key_a: _entry("sess-a"),
        key_a_other_source: _entry("sess-a2"),
        key_b: _entry("sess-b"),
    })
    source = SimpleNamespace(user_id="34600000001", chat_id="34600000001")
    result = mod.reset_session_key_only("+34600000001", runner=runner, source=source)

    ok("reset reports ok + session_key scope", result.get("ok") is True and result.get("scope") == "session_key", str(result))
    ok("deleted only the live session_id for that session_key", runner.session_store._db.deleted == ["sess-a"], str(runner.session_store._db.deleted))
    ok("same-phone other source session remains", key_a_other_source in runner.session_store._entries, str(list(runner.session_store._entries)))
    ok("other phone session remains", key_b in runner.session_store._entries, str(list(runner.session_store._entries)))
    ok("live session_key routing entry was dropped", key_a not in runner.session_store._entries)
    ok("shared memories were not cleared", result.get("memories_cleared") in (None, False))
    ok("phone-wide listing was not used", True)  # boom_list would have raised

    runner2 = FakeRunner({key_b: _entry("sess-b")})
    result2 = mod.reset_session_key_only("+34600000001", runner=runner2, source=source)
    ok("missing session still ok (next inbound starts fresh)", result2.get("ok") is True and result2.get("deleted_count") == 0, str(result2))
    ok("other phone session untouched when target had no row", key_b in runner2.session_store._entries)

    mod._list_whatsapp_session_ids = orig_list
    print(f"\n{PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
