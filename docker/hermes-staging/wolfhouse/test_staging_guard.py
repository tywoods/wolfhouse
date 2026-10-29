"""Offline tests for staging_guard prod-simulate opt-in. No network."""
from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from wolfhouse.staging_guard import assert_staging_environment, assert_stripe_test_only

PROD_STAFF = "http://staff-api:3036"


def prod_runtime(**overrides):
    env = {
        "HERMES_ROLE": "luna",
        "WOLFHOUSE_STAFF_API_BASE_URL": PROD_STAFF,
        "NODE_ENV": "production",
        "WHATSAPP_DRY_RUN": "true",
        "LUNA_AUTO_SEND_ENABLED": "false",
    }
    env.update(overrides)
    return env


class StagingGuardProdOptInTests(unittest.TestCase):
    def test_flag_off_refuses_prod_staff_url(self):
        env = prod_runtime()
        with patch.dict(os.environ, env, clear=True):
            with self.assertRaises(SystemExit) as caught:
                assert_staging_environment()
        self.assertIn("does not look like staging", str(caught.exception))

    def test_flag_on_and_dry_run_allows_prod_runtime(self):
        env = prod_runtime(WOLFHOUSE_SIMULATE_ALLOW_PROD="1", WHATSAPP_DRY_RUN="true")
        with patch.dict(os.environ, env, clear=True):
            assert_staging_environment()

    def test_flag_on_and_sunset_luna_still_refuses_prod(self):
        env = prod_runtime(
            HERMES_ROLE="sunset-luna",
            WOLFHOUSE_SIMULATE_ALLOW_PROD="1",
            WHATSAPP_DRY_RUN="true",
        )
        with patch.dict(os.environ, env, clear=True):
            with self.assertRaises(SystemExit) as caught:
                assert_staging_environment()
        self.assertIn("does not look like staging", str(caught.exception))

    def test_flag_on_and_absent_or_unknown_dry_run_refuses(self):
        cases = {
            "absent": None,
            "empty": "",
            "off": "off",
            "nonsense": "nonsense",
            "flase": "flase",
        }
        for name, value in cases.items():
            with self.subTest(dry_run=name):
                env = prod_runtime(WOLFHOUSE_SIMULATE_ALLOW_PROD="1")
                if value is None:
                    env.pop("WHATSAPP_DRY_RUN", None)
                else:
                    env["WHATSAPP_DRY_RUN"] = value
                with patch.dict(os.environ, env, clear=True):
                    with self.assertRaises(SystemExit) as caught:
                        assert_staging_environment()
                message = str(caught.exception).lower()
                self.assertIn("whatsapp", message)
                self.assertNotIn("does not look like staging", message)

    def test_flag_on_and_live_whatsapp_refuses(self):
        env = prod_runtime(
            WOLFHOUSE_SIMULATE_ALLOW_PROD="1",
            WHATSAPP_DRY_RUN="false",
            LUNA_AUTO_SEND_ENABLED="true",
        )
        with patch.dict(os.environ, env, clear=True):
            with self.assertRaises(SystemExit) as caught:
                assert_staging_environment()
        message = str(caught.exception).lower()
        self.assertIn("whatsapp", message)
        self.assertNotIn("does not look like staging", message)

    def test_stripe_test_only_still_blocks_live_checkout(self):
        with self.assertRaises(SystemExit) as caught:
            assert_stripe_test_only("https://checkout.stripe.com/c/pay/cs_live_not_a_test")
        self.assertIn("non-test Stripe", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
