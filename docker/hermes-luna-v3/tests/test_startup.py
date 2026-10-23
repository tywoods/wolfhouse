"""Fresh-process regression tests for the Luna v3 startup admission boundary."""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
STARTUP = ROOT / "startup.py"

CONFIG = """\
gateway:
  platforms:
    api_server:
      enabled: true
"""


class StartupAdmissionTests(unittest.TestCase):
    def run_preflight(self, dotenv: str) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / "config.yaml").write_text(CONFIG, encoding="utf-8")
            (home / ".env").write_text(dotenv, encoding="utf-8")
            env = {
                "PATH": os.environ["PATH"],
                "PYTHONPATH": os.environ.get("PYTHONPATH", ""),
                "HERMES_HOME": str(home),
                "HERMES_ROLE": "luna-v3",
                "LUNA_V3_TENANT_ID": "wolfhouse-somo",
                "LUNA_V3_EXTERNAL_SEND_ENABLED": "false",
                "LUNA_V3_STAFF_ALERTS_ENABLED": "false",
            }
            return subprocess.run(
                [sys.executable, str(STARTUP), "--validate-only"],
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )

    def test_retained_dotenv_transport_is_rejected_after_real_loader(self):
        result = self.run_preflight(
            "TWILIO_ACCOUNT_SID=ACsynthetic\n"
            "TWILIO_AUTH_TOKEN=synthetic-auth-token\n"
            "TWILIO_PHONE_NUMBER=+15555550123\n"
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(
            "effective gateway platforms must be api_server only; enabled: api_server,sms",
            result.stderr,
        )

    def test_benign_auth_and_disabled_controls_remain_accepted(self):
        result = self.run_preflight(
            "OPENAI_API_KEY=synthetic-provider-key\n"
            "WHATSAPP_ENABLED=false\n"
            "LUNA_V3_EXTERNAL_SEND_ENABLED=false\n"
            "LUNA_V3_STAFF_ALERTS_ENABLED=false\n"
        )
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
