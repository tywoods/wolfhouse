"""Regression proof for revocable cancellation sender authority.

Uses Hermes' real gateway.session_context helper. Only urllib transport is replaced
with an in-memory recorder; no socket or Staff API call is permitted.
"""

import contextvars
import json
import os
import socket
import urllib.request
import unittest
from unittest.mock import patch

from gateway.session_context import clear_session_vars, set_session_vars
from wolfhouse.live_turn_owner import bind_live_turn_owner, close_live_turn_owner
import wolfhouse_staff_api as tools


OWN = "+" + "34" + "600000001"
OTHER = "+" + "34" + "600000002"


class _Response:
    status = 200
    headers = {}

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def read(self):
        return b'{"success":false,"cancelled":false,"staff_review_needed":true}'


class LiveTurnCancellationOwnerTests(unittest.TestCase):
    def setUp(self):
        self.requests = []
        self.env = patch.dict(os.environ, {
            "LUNA_CLIENT_SLUG": "wolfhouse-somo",
            "LUNA_BOT_INTERNAL_TOKEN": "OFFLINE_TEST_NOT_A_CREDENTIAL",
            "WOLFHOUSE_STAFF_API_BASE_URL": "https://review.invalid",
            "HERMES_SESSION_PLATFORM": "whatsapp_cloud",
            "HERMES_SESSION_USER_ID": OTHER,
            "HERMES_SESSION_CHAT_ID": OTHER,
            "WOLFHOUSE_WHATSAPP_GUEST_PHONE": OTHER,
            "WHATSAPP_GUEST_PHONE": OTHER,
        })
        self.env.start()
        self.urlopen = patch.object(urllib.request, "urlopen", self._urlopen)
        self.urlopen.start()
        self.connect = patch.object(socket.socket, "connect", side_effect=OSError("OFFLINE_TEST"))
        self.connect.start()

    def tearDown(self):
        self.connect.stop()
        self.urlopen.stop()
        self.env.stop()

    def _urlopen(self, req, **_kwargs):
        self.requests.append({"url": req.full_url, "payload": json.loads(req.data)})
        return _Response()

    def _invoke(self):
        return json.loads(tools.cancel_unpaid_booking({
            "booking_code": "OFFLINE-TEST",
            "phone": OTHER,
        }))

    def _bound(self, platform="whatsapp_cloud"):
        tokens = set_session_vars(platform=platform, user_id=OWN, chat_id=OWN)
        return bind_live_turn_owner(tokens, platform=platform, user_id=OWN, chat_id=OWN)

    def _close(self, tokens):
        close_live_turn_owner(tokens)
        clear_session_vars(tokens)

    def test_active_owner_overrides_ambient_and_model_phone(self):
        tokens = self._bound()
        try:
            self._invoke()
            self.assertEqual(len(self.requests), 1)
            self.assertEqual(self.requests[0]["payload"]["phone"], OWN)
        finally:
            self._close(tokens)

    def test_never_bound_context_rejects_ambient_identity_before_transport(self):
        result = contextvars.Context().run(self._invoke)
        self.assertEqual(self.requests, [])
        self.assertEqual(result.get("error"), "guest_phone_required")

    def test_copied_context_loses_authority_after_origin_turn_closes(self):
        tokens = self._bound()
        copied = contextvars.copy_context()
        self._close(tokens)
        result = copied.run(self._invoke)
        self.assertEqual(self.requests, [])
        self.assertEqual(result.get("error"), "guest_phone_required")

    def test_non_whatsapp_owner_rejected_before_transport(self):
        tokens = self._bound("discord")
        try:
            result = self._invoke()
            self.assertEqual(self.requests, [])
            self.assertEqual(result.get("error"), "guest_phone_required")
        finally:
            self._close(tokens)

    def test_independent_copied_turn_does_not_revoke_active_origin(self):
        origin_tokens = self._bound()
        copied = contextvars.copy_context()

        def independent_turn():
            tokens = set_session_vars(platform="whatsapp_cloud", user_id=OTHER, chat_id=OTHER)
            bind_live_turn_owner(
                tokens, platform="whatsapp_cloud", user_id=OTHER, chat_id=OTHER,
            )
            try:
                self._invoke()
            finally:
                self._close(tokens)

        try:
            copied.run(independent_turn)
            self._invoke()
            self.assertEqual(
                [request["payload"]["phone"] for request in self.requests],
                [OTHER, OWN],
            )
        finally:
            self._close(origin_tokens)


if __name__ == "__main__":
    unittest.main(verbosity=2)
