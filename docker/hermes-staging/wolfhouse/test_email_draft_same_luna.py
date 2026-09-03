#!/usr/bin/env python3
"""RED/GREEN: Staff email drafts are authored by hermes-sunset-luna-http.

Sunset Create Draft / generate-on-open must hit a closed author contract owned
by the live WhatsApp runtime (HERMES_ROLE=sunset-luna, isolated home, port 8094
untouched). Runtime provenance is bound from live process identity, not a
config-label echo. The dedicated email-luna ACA remains as rollback only.
"""

from __future__ import annotations

import asyncio
import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path
from unittest import mock

STAGING = Path(__file__).resolve().parents[1]
if str(STAGING) not in sys.path:
    sys.path.insert(0, str(STAGING))

from wolfhouse.email_draft_contract import (  # noqa: E402
    HMAC_ALG,
    LIVE_ATTEMPT_SOURCE,
    LOCATION_KEY,
    MODEL,
    PRIVATE_TRUST,
    PROVIDER,
    REQUEST_SCHEMA,
    RESULT_SCHEMA,
    TENANT,
    AttemptResult,
    verify_result_authenticity,
)
from wolfhouse.email_draft_server import handle_draft_request  # noqa: E402
from wolfhouse.email_draft_replay import ReplayCache  # noqa: E402

C = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
L = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
V = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
E = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
M = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
TOKEN = "test-hermes-sol-token"
HMAC_SECRET = "test-hermes-sol-hmac"
PLAN = json.dumps({"acts": [{"act": "thank_guest"}, {"act": "ask_booking_interest"}]})
SOL_PLUGIN_CONFIG = "\n".join(
    [
        "model:",
        "  default: gpt-5.6-sol",
        "  provider: openai-codex",
        "toolsets:",
        "  - wolfhouse_staff_api",
        "plugins:",
        "  enabled:",
        "    - wolfhouse-staff-api",
        "",
    ]
)


def envelope(**patch):
    body = {
        "schema": REQUEST_SCHEMA,
        "tenant_id": TENANT,
        "location_key": LOCATION_KEY,
        "client_id": C,
        "location_id": L,
        "conversation_id": V,
        "endpoint_id": E,
        "inbound_message_id": M,
        "language": "en",
        "untrusted_email": {
            "subject": "Re: Testing",
            "body_text": "Hi, just testing the front desk mailbox.",
            "quoted_history": "",
            "from_display_name": "Tyler Woods",
            "from_address": "tyler@example.test",
        },
        "private_staff_goals": {
            "trust": PRIVATE_TRUST,
            "goals": "Thank them and ask if they want to book",
        },
        "request_id": str(uuid.uuid4()),
    }
    body.update(patch)
    return json.dumps(body).encode("utf-8")


def live_attempt(content: str = PLAN) -> AttemptResult:
    return AttemptResult(
        content=content,
        provider=PROVIDER,
        model=MODEL,
        source=LIVE_ATTEMPT_SOURCE,
    )


def make_same_luna_home(root: Path) -> Path:
    home = root / ".hermes"
    home.mkdir()
    (home / "auth.json").write_text("{}", encoding="utf-8")
    (home / "SOUL.md").write_text("# Sunset Luna\n", encoding="utf-8")
    (home / "config.yaml").write_text(SOL_PLUGIN_CONFIG, encoding="utf-8")
    return home


def same_luna_env(home: Path, **patch) -> dict[str, str]:
    env = {
        "HERMES_ROLE": "sunset-luna",
        "SUNSET_LUNA_REQUIRE_ISOLATED_AUTH": "true",
        "WHATSAPP_CLOUD_WEBHOOK_PORT": "8094",
        "HERMES_HOME": str(home),
        "HOME": str(home.parent),
        "SUNSET_LUNA_EMAIL_AUTHOR_LISTEN_HOST": "127.0.0.1",
        "SUNSET_LUNA_EMAIL_AUTHOR_LISTEN_PORT": "8095",
        "API_SERVER_KEY": TOKEN,
        "EMAIL_LUNA_HERMES_SOL_RESPONSE_HMAC_SECRET": HMAC_SECRET,
    }
    env.update(patch)
    return env


class SameLunaAuthorIdentityTests(unittest.TestCase):
    def test_module_exports_live_identity_and_listener(self):
        from wolfhouse.email_draft_same_luna import (  # noqa: F401
            SAME_LUNA_DRAFT_PATH,
            SAME_LUNA_RUNTIME,
            live_same_luna_identity,
            start_same_luna_author_listener,
        )

        self.assertEqual(SAME_LUNA_RUNTIME, "hermes-sunset-luna-http")
        self.assertEqual(SAME_LUNA_DRAFT_PATH, "/whatsapp/v1/internal/email-draft-plan")

    def test_identity_requires_isolated_sunset_luna_on_8094(self):
        from wolfhouse.email_draft_same_luna import live_same_luna_identity

        with tempfile.TemporaryDirectory() as tmp:
            home = make_same_luna_home(Path(tmp))
            with mock.patch.dict(os.environ, same_luna_env(home), clear=False):
                ident = live_same_luna_identity()
            self.assertIsNotNone(ident)
            self.assertEqual(ident["runtime"], "hermes-sunset-luna-http")
            self.assertEqual(ident["webhook_port"], "8094")
            self.assertEqual(ident["author_port"], 8095)
            self.assertEqual(ident["draft_path"], "/whatsapp/v1/internal/email-draft-plan")
            self.assertEqual(ident["hermes_home"], str(home.resolve()))
            self.assertIn("hostname", ident)
            self.assertIn("pid", ident)

            with mock.patch.dict(
                os.environ,
                same_luna_env(home, HERMES_ROLE="sunset-email-luna"),
                clear=False,
            ):
                self.assertIsNone(live_same_luna_identity())
            with mock.patch.dict(
                os.environ,
                same_luna_env(home, SUNSET_LUNA_REQUIRE_ISOLATED_AUTH="false"),
                clear=False,
            ):
                self.assertIsNone(live_same_luna_identity())
            with mock.patch.dict(
                os.environ,
                same_luna_env(home, WHATSAPP_CLOUD_WEBHOOK_PORT="8092"),
                clear=False,
            ):
                self.assertIsNone(live_same_luna_identity())

    def test_identity_refuses_author_port_collision_with_whatsapp(self):
        from wolfhouse.email_draft_same_luna import live_same_luna_identity

        with tempfile.TemporaryDirectory() as tmp:
            home = make_same_luna_home(Path(tmp))
            with mock.patch.dict(
                os.environ,
                same_luna_env(home, SUNSET_LUNA_EMAIL_AUTHOR_LISTEN_PORT="8094"),
                clear=False,
            ):
                self.assertIsNone(live_same_luna_identity())

    def test_stamping_same_luna_runtime_without_live_identity_fails_closed(self):
        status, payload = handle_draft_request(
            raw_body=envelope(),
            authorization=f"Bearer {TOKEN}",
            expected_token=TOKEN,
            invoke=lambda _s, _u: live_attempt(),
            replay=ReplayCache(),
            hmac_secret=HMAC_SECRET,
            runtime="hermes-sunset-luna-http",
        )
        self.assertEqual(status, 502)
        self.assertEqual(payload["error"], "provenance_unavailable")
        self.assertNotIn("provenance", payload)

    def test_live_identity_binds_runtime_not_caller_label(self):
        from wolfhouse.email_draft_same_luna import SAME_LUNA_RUNTIME

        with tempfile.TemporaryDirectory() as tmp:
            home = make_same_luna_home(Path(tmp))
            with mock.patch.dict(os.environ, same_luna_env(home), clear=False):
                raw = envelope()
                req = json.loads(raw)
                status, payload = handle_draft_request(
                    raw_body=raw,
                    authorization=f"Bearer {TOKEN}",
                    expected_token=TOKEN,
                    invoke=lambda _s, _u: live_attempt(),
                    replay=ReplayCache(),
                    hmac_secret=HMAC_SECRET,
                    runtime=SAME_LUNA_RUNTIME,
                )
        self.assertEqual(status, 200)
        self.assertEqual(payload["schema"], RESULT_SCHEMA)
        self.assertEqual(payload["provenance"]["runtime"], "hermes-sunset-luna-http")
        self.assertEqual(payload["provenance"]["provider"], PROVIDER)
        self.assertEqual(payload["provenance"]["model"], MODEL)
        self.assertNotEqual(payload["provenance"]["runtime"], "sunset-email-luna")
        self.assertTrue(
            verify_result_authenticity(
                HMAC_SECRET,
                req,
                payload["provenance"],
                {"acts": payload["acts"]},
                payload["authenticity"],
            )
        )

    def test_email_luna_path_still_stamps_rollback_runtime(self):
        raw = envelope()
        status, payload = handle_draft_request(
            raw_body=raw,
            authorization=f"Bearer {TOKEN}",
            expected_token=TOKEN,
            invoke=lambda _s, _u: live_attempt(),
            replay=ReplayCache(),
            hmac_secret=HMAC_SECRET,
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload["provenance"]["runtime"], "sunset-email-luna")

    def test_listener_binds_8095_not_8094_and_does_not_rewrite_soul(self):
        from wolfhouse.email_draft_same_luna import (
            reset_same_luna_author_listener_for_tests,
            start_same_luna_author_listener,
        )

        reset_same_luna_author_listener_for_tests()
        with tempfile.TemporaryDirectory() as tmp:
            home = make_same_luna_home(Path(tmp))
            soul_before = (home / "SOUL.md").read_text(encoding="utf-8")
            config_before = (home / "config.yaml").read_text(encoding="utf-8")
            with mock.patch.dict(os.environ, same_luna_env(home), clear=False):
                result = start_same_luna_author_listener()
            try:
                self.assertTrue(result["started"])
                self.assertEqual(result["listen"].endswith(":8095"), True)
                self.assertNotIn(":8094", result["listen"])
                self.assertEqual(result["identity"]["runtime"], "hermes-sunset-luna-http")
                self.assertEqual((home / "SOUL.md").read_text(encoding="utf-8"), soul_before)
                self.assertEqual((home / "config.yaml").read_text(encoding="utf-8"), config_before)
                self.assertIn("wolfhouse_staff_api", (home / "config.yaml").read_text())
                sock = socket.create_connection(("127.0.0.1", 8095), timeout=1)
                sock.close()
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                    probe.settimeout(0.2)
                    # Dedicated author must not steal the WhatsApp port.
                    self.assertEqual(probe.connect_ex(("127.0.0.1", 8094)), 111)
            finally:
                reset_same_luna_author_listener_for_tests()

    def test_listener_does_not_start_on_old_8092_runtime(self):
        from wolfhouse.email_draft_same_luna import (
            reset_same_luna_author_listener_for_tests,
            start_same_luna_author_listener,
        )

        reset_same_luna_author_listener_for_tests()
        with tempfile.TemporaryDirectory() as tmp:
            home = make_same_luna_home(Path(tmp))
            with mock.patch.dict(
                os.environ,
                same_luna_env(
                    home,
                    SUNSET_LUNA_REQUIRE_ISOLATED_AUTH="false",
                    WHATSAPP_CLOUD_WEBHOOK_PORT="8092",
                ),
                clear=False,
            ):
                result = start_same_luna_author_listener()
            self.assertFalse(result["started"])
            self.assertEqual(result["reason"], "identity_mismatch")


class SameLunaGatewayConcurrencyTests(unittest.IsolatedAsyncioTestCase):
    async def test_draft_work_does_not_block_event_loop_and_overload_is_bounded(self):
        import wolfhouse.email_draft_same_luna as same_luna

        class Router:
            def __init__(self):
                self.handler = None

            def add_post(self, _path, handler):
                self.handler = handler

        class App:
            def __init__(self):
                self.router = Router()

        class Request:
            def __init__(self, body):
                self._body = body
                self.headers = {"authorization": f"Bearer {TOKEN}"}

            async def read(self):
                return self._body

        entered = threading.Event()
        release = threading.Event()

        def blocking_invoke(_system, _user):
            entered.set()
            self.assertTrue(release.wait(timeout=2))
            return live_attempt()

        with tempfile.TemporaryDirectory() as tmp:
            home = make_same_luna_home(Path(tmp))
            app = App()
            with mock.patch.dict(os.environ, same_luna_env(home), clear=False), mock.patch.object(
                same_luna, "default_invoke", blocking_invoke
            ):
                self.assertTrue(same_luna.register_same_luna_author_route(app))
                handler = app.router.handler
                self.assertIsNotNone(handler)
                assert handler is not None
                first = asyncio.create_task(handler(Request(envelope())))
                for _ in range(100):
                    if entered.is_set():
                        break
                    await asyncio.sleep(0.001)
                self.assertTrue(entered.is_set())

                # The gateway loop remains runnable while the model thread waits.
                loop_tick = False
                await asyncio.sleep(0)
                loop_tick = True
                self.assertTrue(loop_tick)

                second = await asyncio.wait_for(
                    handler(Request(envelope())), timeout=0.5
                )
                self.assertEqual(second.status, 503)
                self.assertEqual(json.loads(second.text)["error"], "author_busy")
                release.set()
                first_response = await asyncio.wait_for(first, timeout=1)
                self.assertEqual(first_response.status, 200)


class SameLunaSourcePinTests(unittest.TestCase):
    def test_gateway_start_hook_and_whatsapp_route_are_wired(self):
        patches = (STAGING / "apply_gateway_patches.py").read_text(encoding="utf-8")
        fresh = (STAGING / "apply_whatsapp_fresh_start_route.py").read_text(encoding="utf-8")
        same = (STAGING / "wolfhouse" / "email_draft_same_luna.py").read_text(encoding="utf-8")
        self.assertIn("start_same_luna_author_listener", patches)
        self.assertIn("register_same_luna_author_route", fresh)
        self.assertIn("_wolfhouse_gateway_runner = self", patches)
        self.assertIn('add_post(SAME_LUNA_DRAFT_PATH', same)
        self.assertIn("/whatsapp/v1/internal/email-draft-plan", same)
        self.assertNotIn("azurecontainerapps.io", same)

    def test_register_same_luna_author_route_uses_whatsapp_path(self):
        from wolfhouse.email_draft_same_luna import register_same_luna_author_route

        class Router:
            def __init__(self):
                self.posts = []

            def add_post(self, path, handler):
                self.posts.append(path)

        class App:
            def __init__(self):
                self.router = Router()

        with tempfile.TemporaryDirectory() as tmp:
            home = make_same_luna_home(Path(tmp))
            app = App()
            with mock.patch.dict(os.environ, same_luna_env(home), clear=False):
                ok = register_same_luna_author_route(app)
        self.assertTrue(ok)
        self.assertEqual(app.router.posts, ["/whatsapp/v1/internal/email-draft-plan"])

    def test_aca_manifest_has_no_email_author_wiring(self):
        aca = (STAGING / "sunset-luna-http.aca.yaml.example").read_text(encoding="utf-8")
        email_aca = (STAGING / "sunset-email-luna.aca.yaml.example").read_text(encoding="utf-8")
        self.assertNotIn("EMAIL_LUNA_HERMES_SOL_RESPONSE_HMAC_SECRET", aca)
        self.assertNotIn("SUNSET_LUNA_EMAIL_AUTHOR_LISTEN_PORT", aca)
        self.assertNotIn("additionalPortMappings", aca)
        self.assertNotIn("resp-hmac-secret", aca)
        self.assertIn("name: luna-sunset-staging-email-luna", email_aca)
        self.assertIn("targetPort: 8093", email_aca)

    def test_compose_exposes_author_without_touching_8092_or_8094_whatsapp(self):
        compose = (STAGING.parent / "hermes-sunset" / "docker-compose.vm.yml").read_text(
            encoding="utf-8"
        )
        self.assertIn('  hermes-sunset-luna-http:', compose)
        self.assertIn('"127.0.0.1:8094:8094"', compose)
        self.assertIn('"127.0.0.1:8095:8095"', compose)
        self.assertIn("SUNSET_LUNA_EMAIL_AUTHOR_LISTEN_PORT: \"8095\"", compose)
        self.assertIn("HERMES_ROLE: sunset-luna", compose)
        self.assertIn('SUNSET_LUNA_REQUIRE_ISOLATED_AUTH: "true"', compose)
        self.assertIn('"8092:8092"', compose)
        self.assertIn("email_draft_server.py", compose)
        self.assertIn("HERMES_ROLE: sunset-email-luna", compose)
        http_idx = compose.index("  hermes-sunset-luna-http:")
        old_idx = compose.index("  hermes-sunset-luna:")
        email_idx = compose.index("  hermes-sunset-email-luna:")
        http = compose[http_idx:]
        old = compose[old_idx:email_idx]
        email = compose[email_idx:http_idx]
        self.assertIn("command: gateway run", http)
        self.assertIn("8095", http)
        self.assertNotIn("8095", old)
        self.assertIn("8092:8092", old)
        self.assertIn("email_draft_server.py", email)


if __name__ == "__main__":
    unittest.main()
