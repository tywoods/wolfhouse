#!/usr/bin/env python
"""Thin, non-owning bridge to Skip's ab0c9078 saved-confirmation validator.

Receives one JSON object on stdin: {"message": str, "booking": object}.  The
caller must provide WH_SKIP_ACCEPTED_QUOTE_ROOT pointing to a read-only worktree
at ab0c9078.  This bridge imports the owner implementation; it does not copy it.
"""
import importlib
import json
import os
import subprocess
import sys

EXPECTED_HEAD = "ab0c9078"
root = os.environ.get("WH_SKIP_ACCEPTED_QUOTE_ROOT", "/tmp/wh-skip-1644")
try:
    head = subprocess.check_output(["git", "-C", root, "rev-parse", "HEAD"], text=True).strip()
    if not head.startswith(EXPECTED_HEAD):
        raise RuntimeError("Skip worktree is not ab0c9078")
    sys.path.insert(0, os.path.join(root, "docker", "hermes-staging"))
    checker = importlib.import_module("wolfhouse.accepted_quote")._confirmation_has_all_facts
    payload = json.load(sys.stdin)
    booking = payload["booking"]
    facts = {
        "reference": booking["reference"],
        "check_in": booking["check_in"],
        "check_out": booking["check_out"],
        "guest_names": booking["names"],
        "room": [booking["room_label"]],
        "room_type": booking["room_type"],
        "package": booking["package_label"],
        "nights": booking["nights"],
        "total_cents": booking["total_cents"],
        "deposit_cents": booking["deposit_cents"],
        "amount_due_now_cents": booking["paid_now_cents"],
        "remains_owed_cents": booking["balance_cents"],
        "balance_due_at": booking["balance_due_at"],
        "payment_links": [booking["payment_link"]],
        "rewrite_context": {"language": booking.get("language", "en")},
    }
    print(json.dumps({"ok": bool(checker(payload["message"], facts))}))
except Exception as exc:
    print(json.dumps({"error": str(exc)}))
    sys.exit(2)
