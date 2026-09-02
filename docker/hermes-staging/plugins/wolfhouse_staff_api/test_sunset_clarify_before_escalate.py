#!/usr/bin/env python3
"""RED/GREEN: unclear / large-party turns ask one question; they do not set Needs human.

SUNSET-LUNA-LIVE-TEST-001 defect 3:
  Unclear requests and large parties must not automatically set Needs human.
  Ask exactly one useful clarifying question first.
  Escalate only on a genuine inability to finish under canonical policy.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(PLUGIN_DIR.parent))
os.environ["LUNA_CLIENT_SLUG"] = "sunset"
os.environ["WOLFHOUSE_WHATSAPP_GUEST_PHONE"] = "+34600111222"

import wolfhouse_staff_api as mod  # noqa: E402

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


class FakeBot:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def __call__(self, path, payload):
        self.calls.append((path, dict(payload or {})))
        for key, resp in self.responses.items():
            if key in path:
                return dict(resp)
        return {"success": True}


def with_fake(responses):
    fake = FakeBot(responses)
    mod._post_bot = fake  # type: ignore[attr-defined]
    return fake


def _one_question(text: str) -> bool:
    raw = str(text or "").strip()
    if not raw:
        return False
    return raw.count("?") == 1


def main() -> int:
    print("\n[A] Unclear / large-party reasons do not persist needs_human")
    fake = with_fake({
        "/conversation/needs-human": {"success": True, "needs_human": True, "conversation_id": "conv-1"},
    })
    for reason in ("unclear", "vague", "large_party", "party_size", "group_too_large", "missing_dates"):
        fake.calls.clear()
        out = json.loads(mod.flag_needs_human({"reason": reason}))
        check(f"{reason}: does not set needs_human", out.get("needs_human") is not True, str(out))
        check(f"{reason}: does not POST needs-human", not any("/conversation/needs-human" in c[0] for c in fake.calls), str(fake.calls))
        check(f"{reason}: do_not_escalate", out.get("do_not_escalate") is True and out.get("staff_review_needed") is not True, str(out))
        action = str(out.get("guest_safe_next_action") or "")
        check(f"{reason}: one clarifying question", _one_question(action), action)

    print("\n[B] Canonical explicit handoff still persists")
    fake.calls.clear()
    ok = json.loads(mod.flag_needs_human({"reason": "human_requested"}))
    check("human_requested still flags", ok.get("success") is True and ok.get("needs_human") is True, str(ok))
    check("human_requested still POSTs", any("/conversation/needs-human" in c[0] for c in fake.calls), str(fake.calls))

    refund = json.loads(mod.flag_needs_human({"reason": "complaint"}))
    check("complaint still flags", refund.get("needs_human") is True, str(refund))

    print("\n[C] SOUL + tool copy: unclear ≠ staff review")
    soul = (PLUGIN_DIR.parents[2] / "hermes-sunset" / "SOUL.md").read_text(encoding="utf-8")
    check("SOUL unclear-first hard rule", "Unclear request — clarify first" in soul)
    check("SOUL unclear ≠ staff review", "Unclear ≠ staff review" in soul)
    plugin_src = (PLUGIN_DIR / "__init__.py").read_text(encoding="utf-8")
    check("plugin exports auto-escalation guard", "clarify_first" in plugin_src or "_is_auto_escalation_reason" in plugin_src)

    print(f"\ntest_sunset_clarify_before_escalate: {passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
