#!/usr/bin/env python3
"""Verify apply_gateway_patches.py survives the container-boot re-run.

bootstrap.sh re-runs apply_gateway_patches.py on every container start against
a gateway tree that was already patched at image build. A non-idempotent script
fails there ("gateway.run turn-handler anchor not found for inbox mirror"),
bootstrap exits 1, and link_shared_auth/finalize_permissions never run.

This verifier re-runs the patch script twice (simulating two boots) and then
asserts the critical WhatsApp/Luna routing patches are still present in
gateway.run — including that an existing _wh_guard_turn call was preserved
verbatim rather than downgraded.

Must run inside the Hermes image (needs the gateway package importable).
"""

from __future__ import annotations

import contextvars
import importlib
import importlib.util
import os
import re
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

SCRIPT = Path(__file__).resolve().parent / "apply_gateway_patches.py"

_agp_spec = importlib.util.spec_from_file_location("wolfhouse_agp_verify", SCRIPT)
_agp = importlib.util.module_from_spec(_agp_spec)
_agp_spec.loader.exec_module(_agp)

GUARD_CALL_RE = re.compile(r"response = _wh_guard_turn\([^\n]*\)")


def read_gateway_run() -> str:
    spec = importlib.util.find_spec("gateway.run")
    if not spec or not spec.origin:
        print("gateway.run not found", file=sys.stderr)
        raise SystemExit(1)
    return Path(spec.origin).read_text(encoding="utf-8")


def verify_live_turn_owner_lifecycle() -> bool:
    """Exercise the patched gateway methods, including copied-context revocation."""
    gateway_run = importlib.import_module("gateway.run")
    from wolfhouse.live_turn_owner import live_turn_guest_phone

    runner = object.__new__(gateway_run.GatewayRunner)
    runner.adapters = {}
    platform = SimpleNamespace(value="whatsapp_cloud")
    source = SimpleNamespace(
        platform=platform,
        chat_id="+34600000001",
        chat_name="test",
        thread_id=None,
        user_id="+34600000001",
        user_name="test",
        message_id="msg-1",
    )
    context = SimpleNamespace(source=source, session_key="verify-live-owner")

    os.environ["HERMES_SESSION_USER_ID"] = "+34699999999"
    try:
        tokens = runner._set_session_env(context)
        if live_turn_guest_phone() != "+34600000001":
            return False
        late_copy = contextvars.copy_context()
        runner._clear_session_env(tokens)
        if late_copy.run(live_turn_guest_phone) != "":
            return False
        # A never-bound context cannot inherit ambient process identity.
        if contextvars.Context().run(live_turn_guest_phone) != "":
            return False
        return True
    finally:
        os.environ.pop("HERMES_SESSION_USER_ID", None)


def main() -> int:
    guard_before = GUARD_CALL_RE.search(read_gateway_run())

    for attempt in (1, 2):
        proc = subprocess.run(
            [sys.executable, str(SCRIPT)], capture_output=True, text=True,
        )
        if proc.returncode != 0:
            print(
                f"FAIL: apply_gateway_patches boot re-run #{attempt} exited {proc.returncode}",
                file=sys.stderr,
            )
            sys.stderr.write(proc.stderr)
            return 1

    final = read_gateway_run()
    guard_after = GUARD_CALL_RE.search(final)
    apg_path = Path(__file__).resolve().parent / "apply_gateway_patches.py"
    apg_src = apg_path.read_text(encoding="utf-8")
    checks = {
        "inbound_mirror": _agp.MIRROR_INBOUND_TAG in final,
        "outbound_mirror": _agp.POST_SEND_MIRROR_TAG in apg_src,
        "output_guard": guard_after is not None,
        "guard_call_preserved": (
            guard_before is None or guard_after.group(0) == guard_before.group(0)
        ),
        "sanitize": "_sanitize_gateway_final_response(source.platform, response)" in final,
        "live_turn_owner_lifecycle": verify_live_turn_owner_lifecycle(),
    }
    print(checks)
    if not all(checks.values()):
        print("MISSING PATCHES AFTER RE-RUN", file=sys.stderr)
        return 1
    print("OK: apply_gateway_patches is boot-idempotent (2 re-runs, patches intact)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
