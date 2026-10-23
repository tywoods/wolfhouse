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
COMPOSE = ROOT / "compose.example.yml"

CONFIG = """\
gateway:
  platforms:
    api_server:
      enabled: true
"""


class StartupAdmissionTests(unittest.TestCase):
    def run_startup(
        self,
        dotenv: str,
        *,
        project_dotenv: str | None = None,
        validate_only: bool = True,
        path: str | None = None,
    ) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            home = root / "home"
            home.mkdir()
            (home / "config.yaml").write_text(CONFIG, encoding="utf-8")
            (home / ".env").write_text(dotenv, encoding="utf-8")

            pythonpath = os.environ.get("PYTHONPATH", "")
            if project_dotenv is not None:
                project = root / "project"
                gateway = project / "gateway"
                gateway.mkdir(parents=True)
                (gateway / "__init__.py").write_text("", encoding="utf-8")
                (gateway / "run.py").write_text("", encoding="utf-8")
                (project / ".env").write_text(project_dotenv, encoding="utf-8")
                pythonpath = os.pathsep.join(filter(None, (str(project), pythonpath)))

            env = {
                "PATH": path or os.environ["PATH"],
                "PYTHONPATH": pythonpath,
                "HERMES_HOME": str(home),
                "HERMES_ROLE": "luna-v3",
                "LUNA_V3_TENANT_ID": "wolfhouse-somo",
                "LUNA_V3_EXTERNAL_SEND_ENABLED": "false",
                "LUNA_V3_STAFF_ALERTS_ENABLED": "false",
            }
            command = [sys.executable, str(STARTUP)]
            if validate_only:
                command.append("--validate-only")
            return subprocess.run(
                command,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )

    def test_retained_dotenv_transport_is_rejected_after_real_loader(self):
        result = self.run_startup(
            "TWILIO_ACCOUNT_SID=ACsynthetic\n"
            "TWILIO_AUTH_TOKEN=synthetic-auth-token\n"
            "TWILIO_PHONE_NUMBER=+15555550123\n"
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(
            "effective gateway platforms must be api_server only; enabled: api_server,sms",
            result.stderr,
        )

    def test_project_dotenv_transport_is_rejected_after_real_loader(self):
        result = self.run_startup(
            "OPENAI_API_KEY=synthetic-provider-key\n",
            project_dotenv=(
                "TWILIO_ACCOUNT_SID=ACprojectsynthetic\n"
                "TWILIO_AUTH_TOKEN=synthetic-project-auth-token\n"
                "TWILIO_PHONE_NUMBER=+15555550124\n"
            ),
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(
            "effective gateway platforms must be api_server only; enabled: api_server,sms",
            result.stderr,
        )

    def test_benign_auth_and_disabled_controls_remain_accepted(self):
        result = self.run_startup(
            "OPENAI_API_KEY=synthetic-provider-key\n"
            "WHATSAPP_ENABLED=false\n"
            "LUNA_V3_EXTERNAL_SEND_ENABLED=false\n"
            "LUNA_V3_STAFF_ALERTS_ENABLED=false\n"
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_compose_uses_image_startup_command(self):
        compose = COMPOSE.read_text(encoding="utf-8")
        service = compose.split("    ports:", 1)[0]
        self.assertNotIn("command:", service)

    def test_gateway_handoff_uses_hermes_cli_without_starting_gateway(self):
        with tempfile.TemporaryDirectory() as directory:
            bin_dir = Path(directory)
            receipt = bin_dir / "hermes.args"
            executable = bin_dir / "hermes"
            executable.write_text(
                f"#!/bin/sh\nprintf '%s\\n' \"$@\" > {receipt!s}\n",
                encoding="utf-8",
            )
            executable.chmod(0o755)
            result = self.run_startup(
                "OPENAI_API_KEY=synthetic-provider-key\n",
                validate_only=False,
                path=os.pathsep.join((str(bin_dir), os.environ["PATH"])),
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(receipt.read_text(encoding="utf-8"), "gateway\nrun\n")


if __name__ == "__main__":
    unittest.main()
