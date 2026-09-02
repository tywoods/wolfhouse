#!/usr/bin/env python3
"""Unit tests for sunset-luna-http: healthz + first-answer joinable leftover."""

from __future__ import annotations

import json
import sys
import threading
import time
import unittest
import uuid
from http.client import HTTPConnection
from pathlib import Path

STAGING = Path(__file__).resolve().parents[1]
PLUGIN = STAGING / "plugins"
if str(STAGING) not in sys.path:
    sys.path.insert(0, str(STAGING))
if str(PLUGIN) not in sys.path:
    sys.path.insert(0, str(PLUGIN))

from wolfhouse.email_draft_replay import ReplayCache  # noqa: E402
from wolfhouse.luna_http_contract import (  # noqa: E402
    INBOUND_PATH,
    LOCATION_KEY,
    REQUEST_SCHEMA,
    RESULT_SCHEMA,
    RUNTIME,
    TENANT,
)
from wolfhouse.luna_http_server import handle_inbound_request, make_handler  # noqa: E402
from wolfhouse.luna_http_turn import build_inbound_result, run_first_answer_lookup  # noqa: E402

TOKEN = "test-luna-http-token"

MATUTINO = {
    "course_id": "curso-matutino",
    "label": "Curso Matutino",
    "capacity": 25,
    "seats_booked": 3,
    "seats_remaining": 22,
    "joinable": True,
    "schedules": [{"start_time": "10:00", "end_time": "12:00"}],
}
TARDE = {
    "course_id": "curso-tarde",
    "label": "Curso Tarde",
    "capacity": 24,
    "seats_booked": 9,
    "seats_remaining": 15,
    "joinable": True,
    "schedules": [{"start_time": "16:00", "end_time": "18:00"}],
}


def envelope(**patch):
    body = {
        "schema": REQUEST_SCHEMA,
        "tenant_id": TENANT,
        "location_key": LOCATION_KEY,
        "request_id": str(uuid.uuid4()),
        "channel": "http_probe",
        "text": "Hi — Thursday for 14 people please",
        "date": "2026-09-03",
        "quantity": 14,
        "outbound_mode": "none",
    }
    body.update(patch)
    return json.dumps(body).encode("utf-8")


def fake_unscoped_availability(params):
    """Mirror plugin unscoped first-pass: joinable courses, never daily-full."""
    assert "date" in params
    assert params.get("quantity") == 14
    assert "slot_time" not in params
    courses = [MATUTINO, TARDE]
    fitting = [c["course_id"] for c in courses if c["seats_remaining"] >= 14]
    return json.dumps(
        {
            "success": True,
            "tool": "get_sunset_lesson_availability",
            "date": params["date"],
            "location_id": params.get("location_id"),
            "scope": "course_choices",
            "requires_course_selection": True,
            "requested_quantity": 14,
            "courses": courses,
            "has_fitting_course": True,
            "fitting_course_ids": fitting,
            "largest_seats_remaining": 22,
            "do_not_claim_date_full": True,
            "has_seats": True,
            "reason": "course_selection_required",
            "daily_capacity": None,
            "guest_safe_next_action": (
                "At least one Admin course still has enough Staff-confirmed seats "
                "for this party. Offer those times and remaining seats."
            ),
        }
    )


def fake_daily_poison(_params):
    """Wrong path — daily leftover 1 (must never be what unscoped returns)."""
    return json.dumps(
        {
            "success": True,
            "scope": "daily",
            "daily_capacity": 24,
            "seats_booked": 23,
            "seats_available": 1,
            "has_seats": False,
            "reason": "no_seats_available",
            "requested_quantity": 14,
        }
    )


def call(raw, availability=fake_unscoped_availability, replay=None, auth=None, token=TOKEN):
    return handle_inbound_request(
        raw_body=raw,
        authorization=f"Bearer {token}" if auth is None else auth,
        expected_token=token,
        replay=replay or ReplayCache(),
        availability=availability,
        outbound_fn=lambda req, reply_hint=None: {
            "mode": req.get("outbound_mode") or "none",
            "sent": False,
            "via": None,
        },
    )


class LunaHttpContractTests(unittest.TestCase):
    def test_rejects_missing_auth(self):
        status, payload = call(envelope(), auth="")
        self.assertEqual(status, 401)
        self.assertEqual(payload["error"], "unauthorized")

    def test_rejects_wrong_tenant(self):
        status, payload = call(envelope(tenant_id="wolfhouse"))
        self.assertEqual(status, 403)
        self.assertEqual(payload["error"], "wrong_tenant")

    def test_rejects_extra_key(self):
        raw = json.loads(envelope())
        raw["graph_access_token"] = "nope"
        status, payload = call(json.dumps(raw).encode("utf-8"))
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"], "extra_keys")

    def test_rejects_replay(self):
        replay = ReplayCache()
        raw = envelope()
        first, _ = call(raw, replay=replay)
        second, payload = call(raw, replay=replay)
        self.assertEqual(first, 200)
        self.assertEqual(second, 409)
        self.assertEqual(payload["error"], "replay")


class LunaHttpFirstAnswerTests(unittest.TestCase):
    def test_unscoped_date_party_uses_course_choices_not_daily_full(self):
        status, payload = call(envelope())
        self.assertEqual(status, 200)
        self.assertEqual(payload["schema"], RESULT_SCHEMA)
        self.assertEqual(payload["runtime"], RUNTIME)
        fa = payload["first_answer"]
        self.assertTrue(fa["ok"])
        lookup = fa["lookup"]
        self.assertEqual(lookup["scope"], "course_choices")
        self.assertTrue(lookup["has_fitting_course"])
        self.assertTrue(lookup["do_not_claim_date_full"])
        self.assertTrue(lookup["has_seats"])
        self.assertEqual(lookup["largest_seats_remaining"], 22)
        self.assertIsNone(lookup["daily_capacity"])
        self.assertIn("curso-matutino", lookup["fitting_course_ids"])
        # Daily leftover would be 1 — must not appear as the first answer.
        self.assertNotEqual(lookup["largest_seats_remaining"], 1)
        self.assertNotEqual(lookup["scope"], "daily")

    def test_daily_poison_path_is_graded_not_ok(self):
        status, payload = call(envelope(), availability=fake_daily_poison)
        self.assertEqual(status, 200)
        fa = payload["first_answer"]
        self.assertFalse(fa["ok"])
        self.assertIn("daily_full_forbidden_on_unscoped_first_pass", fa["notes"])

    def test_plugin_unscoped_path_via_real_tool(self):
        """Exercise real get_sunset_lesson_availability with FakeBot (#844/#845)."""
        import os

        os.environ.setdefault("LUNA_CLIENT_SLUG", "sunset")
        os.environ.setdefault("SUNSET_INGRESS_LOCATION_ID", "sunset-somo")
        os.environ.setdefault("LUNA_ALLOWED_LOCATION_IDS", "sunset-somo")
        os.environ.setdefault("LUNA_BOT_INTERNAL_TOKEN", "test-token-luna-http")
        import wolfhouse_staff_api as mod

        calls = []

        def fake_post(path, payload):
            calls.append((path, dict(payload or {})))
            if "joinable-courses" in path:
                return {"ok": True, "success": True, "courses": [MATUTINO, TARDE]}
            # If the plugin wrongly hit daily lesson-availability first, fail loud.
            return {
                "ok": True,
                "success": True,
                "scope": "daily",
                "daily_capacity": 24,
                "seats_booked": 23,
                "seats_available": 1,
                "has_seats": False,
                "reason": "no_seats_available",
            }

        original = mod._post_bot
        mod._post_bot = fake_post  # type: ignore[attr-defined]
        try:
            status, payload = call(
                envelope(date="2026-09-03", quantity=14),
                availability=mod.get_sunset_lesson_availability,
            )
        finally:
            mod._post_bot = original  # type: ignore[attr-defined]
        self.assertEqual(status, 200)
        self.assertTrue(calls)
        self.assertIn("/sunset/joinable-courses", calls[0][0])
        lookup = payload["first_answer"]["lookup"]
        self.assertEqual(lookup["scope"], "course_choices")
        self.assertTrue(lookup["has_fitting_course"])
        self.assertTrue(lookup["do_not_claim_date_full"])
        self.assertNotEqual(lookup["scope"], "daily")
        self.assertTrue(payload["first_answer"]["ok"])


class LunaHttpHealthzTests(unittest.TestCase):
    def test_healthz_ok(self):
        handler = make_handler(TOKEN, ReplayCache(), availability=fake_unscoped_availability)
        from http.server import ThreadingHTTPServer

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            time.sleep(0.05)
            conn = HTTPConnection("127.0.0.1", port, timeout=2)
            conn.request("GET", "/healthz")
            resp = conn.getresponse()
            body = json.loads(resp.read().decode("utf-8"))
            self.assertEqual(resp.status, 200)
            self.assertTrue(body["ok"])
            self.assertEqual(body["runtime"], RUNTIME)
            self.assertEqual(body["whatsapp_owner"], "hermes-sunset-luna")
            conn.close()

            raw = envelope()
            conn = HTTPConnection("127.0.0.1", port, timeout=2)
            conn.request(
                "POST",
                INBOUND_PATH,
                body=raw,
                headers={
                    "authorization": f"Bearer {TOKEN}",
                    "content-type": "application/json",
                    "content-length": str(len(raw)),
                },
            )
            resp = conn.getresponse()
            inbound = json.loads(resp.read().decode("utf-8"))
            self.assertEqual(resp.status, 200)
            self.assertEqual(inbound["first_answer"]["lookup"]["scope"], "course_choices")
            conn.close()
        finally:
            httpd.shutdown()
            httpd.server_close()


class LunaHttpTurnUnitTests(unittest.TestCase):
    def test_build_flags_daily_invent(self):
        req = {
            "request_id": "r1",
            "channel": "http_probe",
            "tenant_id": TENANT,
            "location_key": LOCATION_KEY,
            "quantity": 14,
            "slot_time": None,
            "course_id": None,
            "outbound_mode": "none",
        }
        lookup = run_first_answer_lookup(
            {**req, "date": "2026-09-03"},
            availability=fake_daily_poison,
        )
        result = build_inbound_result(req, lookup)
        self.assertFalse(result["first_answer"]["ok"])


if __name__ == "__main__":
    unittest.main()
