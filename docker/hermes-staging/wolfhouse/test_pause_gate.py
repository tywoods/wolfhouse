#!/usr/bin/env python3
"""Unit tests for Hermes Luna pause_gate (no network)."""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import urllib.error
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent
PAUSE_PATH = ROOT / "pause_gate.py"


def _load():
    spec = importlib.util.spec_from_file_location("pause_gate_under_test", PAUSE_PATH)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


passed = 0
failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global passed, failed
    if ok:
        passed += 1
        print(f"  PASS  {name}")
    else:
        failed += 1
        print(f"  FAIL  {name}" + (f" — {detail}" if detail else ""))


def main() -> int:
    mod = _load()
    mod._CACHE.clear()

    with mock.patch.dict(os.environ, {"HERMES_ROLE": "sunset-luna", "LUNA_CLIENT_SLUG": "sunset"}, clear=False):
        check("sunset-luna is a Luna runtime", mod._is_luna_runtime() is True)
        check("client_slug from LUNA_CLIENT_SLUG", mod._client_slug() == "sunset")

    with mock.patch.dict(os.environ, {"HERMES_ROLE": "orchestrator", "LUNA_CLIENT_SLUG": "sunset"}, clear=False):
        check("orchestrator is not a Luna runtime", mod._is_luna_runtime() is False)

    with mock.patch.dict(os.environ, {"HERMES_ROLE": "luna", "LUNA_CLIENT_SLUG": "wolfhouse-somo"}, clear=False):
        check("luna role enabled", mod._is_luna_runtime() is True)
        check("wolfhouse slug", mod._client_slug() == "wolfhouse-somo")

    with mock.patch.dict(os.environ, {"HERMES_ROLE": "luna"}, clear=True):
        # clear removes LUNA_CLIENT_SLUG
        check("missing slug returns empty", mod._client_slug() == "")
        check("missing slug fail-closed paused", mod.guest_automation_paused("+34600111222", force_refresh=True) is True)

    # Fail closed on network error when no prior active preference.
    mod._CACHE.clear()
    with mock.patch.dict(
        os.environ,
        {
            "HERMES_ROLE": "sunset-luna",
            "LUNA_CLIENT_SLUG": "sunset",
            "LUNA_BOT_INTERNAL_TOKEN": "tok",
            "WOLFHOUSE_STAFF_API_BASE_URL": "https://example.invalid",
        },
        clear=False,
    ):
        with mock.patch("urllib.request.urlopen", side_effect=TimeoutError("timeout")):
            paused = mod.guest_automation_paused("+34600111222", force_refresh=True)
        check("timeout fails closed (no send)", paused is True)

    # Never resume from failed lookup after known paused.
    mod._CACHE.clear()
    mod._cache_set("sunset|+34600111222", True)
    with mock.patch.dict(
        os.environ,
        {
            "HERMES_ROLE": "sunset-luna",
            "LUNA_CLIENT_SLUG": "sunset",
            "LUNA_BOT_INTERNAL_TOKEN": "tok",
            "WOLFHOUSE_STAFF_API_BASE_URL": "https://example.invalid",
        },
        clear=False,
    ):
        with mock.patch("urllib.request.urlopen", side_effect=urllib.error.HTTPError(
            "https://example.invalid", 401, "Unauthorized", hdrs=None, fp=None
        )):
            paused = mod.guest_automation_paused("+34600111222", force_refresh=True)
        check("401 keeps paused", paused is True)

    # Active response clears pause.
    class _Resp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return json.dumps({
                "success": True,
                "bot_paused": False,
                "live_send_blocked": False,
                "can_continue_guest_automation": True,
            }).encode("utf-8")

    mod._CACHE.clear()
    with mock.patch.dict(
        os.environ,
        {
            "HERMES_ROLE": "luna",
            "LUNA_CLIENT_SLUG": "wolfhouse-somo",
            "LUNA_BOT_INTERNAL_TOKEN": "tok",
            "WOLFHOUSE_STAFF_API_BASE_URL": "https://staff.example",
        },
        clear=False,
    ):
        with mock.patch("urllib.request.urlopen", return_value=_Resp()):
            paused = mod.guest_automation_paused("+491701234567", force_refresh=True)
        check("active gate allows automation", paused is False)

    class _PausedResp(_Resp):
        def read(self):
            return json.dumps({
                "success": True,
                "bot_paused": True,
                "live_send_blocked": True,
                "can_continue_guest_automation": False,
                "global_paused": True,
            }).encode("utf-8")

    mod._CACHE.clear()
    with mock.patch.dict(
        os.environ,
        {
            "HERMES_ROLE": "luna",
            "LUNA_CLIENT_SLUG": "wolfhouse-somo",
            "LUNA_BOT_INTERNAL_TOKEN": "tok",
            "WOLFHOUSE_STAFF_API_BASE_URL": "https://staff.example",
        },
        clear=False,
    ):
        with mock.patch("urllib.request.urlopen", return_value=_PausedResp()):
            paused = mod.guest_automation_paused("+491701234567", force_refresh=True)
        check("paused gate blocks automation", paused is True)
        # Tenant-scoped cache keys: sunset phone key independent.
        check(
            "cache key is tenant scoped",
            "wolfhouse-somo|+491701234567" in mod._CACHE,
        )

    # Webhook body phone parse
    body = json.dumps({
        "entry": [{
            "changes": [{
                "value": {
                    "messages": [{"from": "34600111222", "id": "wamid.1", "type": "text"}],
                }
            }]
        }]
    }).encode("utf-8")
    phones = mod._phones_from_webhook_body(body)
    check("webhook extracts from phone", phones == ["+34600111222"])

    print(f"\ntest_pause_gate: {passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
