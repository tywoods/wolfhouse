import asyncio
import importlib.util
import unittest
from pathlib import Path

MODULE = Path(__file__).resolve().parents[1] / "runtime" / "simulator_route.py"
BOOTSTRAP_MODULE = Path(__file__).resolve().parents[1] / "bootstrap.py"


class FakeAgent:
    def run_conversation(self, **kwargs):
        class Result:
            failed = False
            error = None
            final_response = f"reply:{kwargs['user_message']}"

        return Result()


class FakeAdapter:
    def _check_auth(self, request):
        return None

    def _create_agent(self, **kwargs):
        self.agent_kwargs = kwargs
        return FakeAgent()

    def _bind_api_server_session(self, *, session_key):
        self.bound_session_key = session_key
        return []


class FakeRequest:
    def __init__(self, body):
        self.body = body

    async def json(self):
        return self.body


class SimulatorRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("luna_v3_simulator_route", MODULE)
        if spec is None or spec.loader is None:
            raise RuntimeError("unable to load simulator route")
        cls.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.module)
        bootstrap_spec = importlib.util.spec_from_file_location("luna_v3_bootstrap", BOOTSTRAP_MODULE)
        cls.bootstrap = importlib.util.module_from_spec(bootstrap_spec)
        bootstrap_spec.loader.exec_module(cls.bootstrap)

    def test_reserved_phone_gets_request_bound_session_and_reply(self):
        adapter = FakeAdapter()
        response = asyncio.run(self.module.handle_turn(
            FakeRequest({"thread": "+34 699 901 008", "text": "hello", "allow_writes": False}),
            adapter,
        ))
        self.assertEqual(response["status"], 200)
        self.assertEqual(response["body"]["reply_text"], "reply:hello")
        self.assertTrue(adapter.bound_session_key.startswith("luna-v3:"))
        self.assertEqual(adapter.agent_kwargs["gateway_session_key"], adapter.bound_session_key)

    def test_rejects_non_reserved_phone_and_caller_write_authority(self):
        adapter = FakeAdapter()
        for body, code in [
            ({"thread": "+34 611 111 111", "text": "hello"}, "clone_phone_out_of_range"),
            ({"thread": "+34 699 901 008", "text": "hello", "allow_writes": True}, "caller_write_authority_denied"),
        ]:
            response = asyncio.run(self.module.handle_turn(FakeRequest(body), adapter))
            self.assertEqual(response["status"], 400)
            self.assertEqual(response["body"]["code"], code)

    def test_preflight_rejects_every_hermes_transport_activation_input(self):
        base = {
            "HERMES_ROLE": "luna-v3",
            "LUNA_V3_TENANT_ID": "wolfhouse-somo",
        }
        contaminated = {
            "WHATSAPP_ENABLED": "true",
            "TELEGRAM_BOT_TOKEN": "synthetic-token",
            "EMAIL_ADDRESS": "review@example.invalid",
            "EMAIL_PASSWORD": "synthetic-password",
            "EMAIL_IMAP_HOST": "imap.example.invalid",
            "EMAIL_SMTP_HOST": "smtp.example.invalid",
        }
        self.bootstrap.validate_environment({**base, "WHATSAPP_ENABLED": "false"})
        for name, value in contaminated.items():
            with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, name):
                self.bootstrap.validate_environment({**base, name: value})

    def test_preflight_requires_api_server_as_the_only_effective_platform(self):
        class PlatformConfig:
            def __init__(self, enabled):
                self.enabled = enabled

        class GatewayConfig:
            def __init__(self, platforms):
                self.platforms = platforms

        self.bootstrap.validate_effective_platforms(GatewayConfig({
            "api_server": PlatformConfig(True),
            "discord": PlatformConfig(False),
        }))

        contaminated = (
            {"api_server": True, "discord": True},
            {"api_server": True, "sms": True},
            {"api_server": True, "future_transport": True},
        )
        for platforms in contaminated:
            with self.subTest(platforms=platforms), self.assertRaisesRegex(
                RuntimeError, "api_server only"
            ):
                self.bootstrap.validate_effective_platforms(GatewayConfig({
                    name: PlatformConfig(enabled)
                    for name, enabled in platforms.items()
                }))


if __name__ == "__main__":
    unittest.main()
