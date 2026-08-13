#!/usr/bin/env python3
"""Unit tests for the Hermes Luna WhatsApp kill switches (no network, no Docker).

The cross-language parity check — that these readings match the shipped JS
predicates on the same env values — lives in `scripts/verify-hermes-send-flags.js`,
which runs this module and the JS side against one shared matrix.
"""

from __future__ import annotations

import importlib.util
import logging
import os
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent
SEND_FLAGS_PATH = ROOT / "send_flags.py"


def _load():
    spec = importlib.util.spec_from_file_location("send_flags_under_test", SEND_FLAGS_PATH)
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

    # ── WHATSAPP_DRY_RUN: only the literal "false" turns dry run off ──────────
    check("dry run on when unset", mod.whatsapp_dry_run({}) is True)
    check("dry run on when empty", mod.whatsapp_dry_run({"WHATSAPP_DRY_RUN": ""}) is True)
    check("dry run off on 'false'", mod.whatsapp_dry_run({"WHATSAPP_DRY_RUN": "false"}) is False)
    check("dry run off on ' FALSE '", mod.whatsapp_dry_run({"WHATSAPP_DRY_RUN": " FALSE "}) is False)
    for unparseable in ("0", "off", "no", "nope", "true", "1"):
        check(
            f"dry run stays on for {unparseable!r}",
            mod.whatsapp_dry_run({"WHATSAPP_DRY_RUN": unparseable}) is True,
        )

    # ── LUNA_AUTO_SEND_ENABLED: only the literal "true" opens the gate ────────
    check("auto-send off when unset", mod.luna_auto_send_enabled({}) is False)
    check("auto-send on for 'true'", mod.luna_auto_send_enabled({"LUNA_AUTO_SEND_ENABLED": "true"}) is True)
    check("auto-send on for ' TRUE '", mod.luna_auto_send_enabled({"LUNA_AUTO_SEND_ENABLED": " TRUE "}) is True)
    for unparseable in ("1", "yes", "on", "", "false"):
        check(
            f"auto-send stays off for {unparseable!r}",
            mod.luna_auto_send_enabled({"LUNA_AUTO_SEND_ENABLED": unparseable}) is False,
        )

    # ── The block decision ────────────────────────────────────────────────────
    open_env = {"LUNA_AUTO_SEND_ENABLED": "true", "WHATSAPP_DRY_RUN": "false"}
    check("both flags open → no block", mod.guest_whatsapp_send_flag_block("+34600000404", open_env) is None)

    empty = mod.guest_whatsapp_send_flag_block("+34600000404", {})
    check("nothing set → blocked", empty is not None)
    check(
        "auto-send decides before dry run",
        empty["blocked_reason"] == mod.AUTO_SEND_BLOCKED_REASON,
        str(empty),
    )
    check(
        "both parsed values are reported, not just the deciding one",
        empty["flags"] == {"whatsapp_dry_run": True, "luna_auto_send_enabled": False},
        str(empty["flags"]),
    )

    dry = mod.guest_whatsapp_send_flag_block("+34600000404", {"LUNA_AUTO_SEND_ENABLED": "true"})
    check("auto-send open, dry run unset → dry run blocks", dry["blocked_reason"] == mod.DRY_RUN_BLOCKED_REASON)
    check("dry-run block names the flag", dry["flag"] == "WHATSAPP_DRY_RUN" and dry["allow_value"] == "false")

    zero = mod.guest_whatsapp_send_flag_block(
        "+34600000404", {"LUNA_AUTO_SEND_ENABLED": "true", "WHATSAPP_DRY_RUN": "0"}
    )
    check("WHATSAPP_DRY_RUN=0 still blocks (matches the JS reading)", zero is not None)
    check(
        "and says so in words, quoting the value it rejected",
        zero["flag_note"] == "'0', not the literal 'false'",
        zero["flag_note"],
    )

    # ── Process env is the default source ─────────────────────────────────────
    with mock.patch.dict(os.environ, {"LUNA_AUTO_SEND_ENABLED": "true", "WHATSAPP_DRY_RUN": "false"}, clear=False):
        check("reads process env when no env passed", mod.guest_whatsapp_send_flag_block("+34600000404") is None)
    with mock.patch.dict(os.environ, {}, clear=True):
        check("empty process env blocks", mod.guest_whatsapp_send_flag_block("+34600000404") is not None)

    # ── Fail closed on a broken env source ────────────────────────────────────
    class _Hostile(dict):
        def get(self, *_a, **_k):
            raise RuntimeError("env exploded")

    hostile = mod.guest_whatsapp_send_flag_block("+34600000404", _Hostile())
    check("unreadable env fails closed", hostile is not None)
    check(
        "unreadable env reports a guard error, not a flag",
        hostile["blocked_reason"] == mod.GUARD_ERROR_BLOCKED_REASON,
        str(hostile),
    )
    check(
        "guard_error_block is also fail-closed",
        mod.guard_error_block(ImportError("no module"))["blocked_reason"] == mod.GUARD_ERROR_BLOCKED_REASON,
    )

    # ── A blocked send is observable ──────────────────────────────────────────
    records: list[logging.LogRecord] = []

    class _Capture(logging.Handler):
        def emit(self, record):
            records.append(record)

    handler = _Capture()
    mod.logger.addHandler(handler)
    mod.logger.setLevel(logging.INFO)
    try:
        line = mod.log_flag_block(empty)
    finally:
        mod.logger.removeHandler(handler)

    check("blocked send emits exactly one log record", len(records) == 1, str(len(records)))
    check("logged at warning, not debug", records and records[0].levelno == logging.WARNING)
    # logging keeps a single mapping argument as-is (for %(key)s formatting).
    payload = records[0].args if records and isinstance(records[0].args, dict) else {}
    check("log payload uses the pause_gate event shape", payload.get("event") == mod.LOG_EVENT, str(payload))
    check("log payload states nothing was sent", payload.get("sent") is False, str(payload))
    check("log payload names the deciding flag", payload.get("flag") == "LUNA_AUTO_SEND_ENABLED", str(payload))
    check("operator line names the flag and the fix", "LUNA_AUTO_SEND_ENABLED=true" in line, line)
    check("operator line says where to set it", "/etc/hermes-luna.env" in line, line)
    check("no log record for an allowed send", mod.log_flag_block(None) == "")

    raw = mod.flag_block_raw_response(empty)
    check("raw_response marks the suppression", raw.get(mod.SUPPRESSED_KEY) is True, str(raw))
    check("raw_response carries the reason", raw.get("blocked_reason") == mod.AUTO_SEND_BLOCKED_REASON, str(raw))

    # ── Logs identify the thread without printing a phone book ────────────────
    check("guest is masked to the last 4 digits", empty["guest"] == "…0404", empty["guest"])
    check(
        "full number never appears in the operator line",
        "+34600000404" not in mod.describe_flag_block(empty),
        mod.describe_flag_block(empty),
    )

    print(f"\ntest_send_flags: {passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
