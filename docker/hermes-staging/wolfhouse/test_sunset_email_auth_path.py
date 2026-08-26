#!/usr/bin/env python3
"""MAIL-MVP-007 hotfix: auth-add writes $HOME/.hermes/auth.json; startup must accept it.

Live operator proof: `hermes auth add openai-codex` with HOME=/opt/data (and
/init possibly scrubbing HERMES_HOME) writes /opt/data/.hermes/auth.json.
Bootstrap used to require $HERMES_HOME/auth.json with HERMES_HOME=/opt/data,
so ACA would reject the real credential. One durable file, no copies/symlinks.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

STAGING = Path(__file__).resolve().parents[1]
REPO = STAGING.parent.parent
if str(STAGING) not in sys.path:
    sys.path.insert(0, str(STAGING))

from wolfhouse.email_draft_invoke import (  # noqa: E402
    CANONICAL_HERMES_HOME,
    MOUNTED_HOME,
    ensure_isolated_sol_home,
    pin_sunset_email_hermes_home,
    resolve_sunset_email_hermes_home,
)

BOOTSTRAP = STAGING / "bootstrap.sh"
ACA = STAGING / "sunset-email-luna.aca.yaml.example"
SUNSET_COMPOSE = REPO / "docker/hermes-sunset/docker-compose.vm.yml"
STAGING_COMPOSE = STAGING / "docker-compose.vm.yml"
RUNBOOK = REPO / "docs/MAIL-MVP-007-SUNSET-EMAIL-SOL-RUNBOOK.md"
VERIFIER = REPO / "scripts/verify-email-luna-sunset-email-hermes-sol.js"
INSTANCE = STAGING / "verify_sunset_email_luna_instance.py"


def _extract_function(text: str, name: str) -> str:
    match = re.search(rf"^{re.escape(name)}\(\) \{{(.*?)^}}\n", text, re.M | re.S)
    if not match:
        raise AssertionError(f"bootstrap missing function {name}")
    return f"{name}() {{\n{match.group(1)}}}\n"


def _write_regular(path: Path, body: str = '{"providers":{}}\n') -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    path.chmod(0o600)


def _email_service(compose: str) -> str:
    lines = compose.splitlines()
    block: list[str] = []
    collecting = False
    for line in lines:
        if re.match(r"^  hermes-sunset-email-luna:\s*$", line):
            collecting = True
            block = [line]
            continue
        if collecting:
            if re.match(r"^  [A-Za-z0-9_-]+:\s*$", line):
                break
            block.append(line)
    return "\n".join(block)


def _run_bootstrap_auth(mount: Path) -> subprocess.CompletedProcess[str]:
    bootstrap = BOOTSTRAP.read_text(encoding="utf-8")
    if 'HERMES_HOME="${HOME}/.hermes"' not in bootstrap:
        raise AssertionError("bootstrap no longer pins email HERMES_HOME to $HOME/.hermes")
    pin = """
HERMES_ROLE=sunset-email-luna
if [ "$HERMES_ROLE" = "sunset-email-luna" ]; then
  export HOME="${HOME:-/opt/data}"
  HERMES_HOME="${HOME}/.hermes"
  export HERMES_HOME
else
  HERMES_HOME="${HERMES_HOME:-/opt/data}"
fi
mkdir -p "$HERMES_HOME"
"""
    fn = _extract_function(bootstrap, "require_isolated_sunset_email_auth")
    cfg = _extract_function(bootstrap, "write_sunset_email_luna_config")
    script = f"""#!/bin/sh
set -eu
HOME="{mount}"
export HOME
{pin}
{fn}
{cfg}
require_isolated_sunset_email_auth
write_sunset_email_luna_config
test -f "$HERMES_HOME/config.yaml"
test -f "$HERMES_HOME/auth.json"
test ! -L "$HERMES_HOME/auth.json"
echo ACCEPT_CANONICAL path="$HERMES_HOME/auth.json"
"""
    return subprocess.run(
        ["sh", "-s"],
        input=script,
        text=True,
        capture_output=True,
        check=False,
    )


class InstalledHermesAuthAddLocationTests(unittest.TestCase):
    def test_auth_add_home_fallback_and_pinned_env_agree(self):
        sys.path.insert(0, "/opt/hermes")
        from hermes_constants import get_hermes_home  # noqa: WPS433

        with tempfile.TemporaryDirectory() as tmp:
            mount = Path(tmp)
            empty = {k: v for k, v in os.environ.items() if k != "HERMES_HOME"}
            empty["HOME"] = str(mount)
            with mock.patch.dict(os.environ, empty, clear=True):
                os.environ.pop("HERMES_HOME", None)
                fallback = get_hermes_home()
            self.assertEqual(fallback, mount / ".hermes")

            pinned = dict(os.environ)
            pinned["HOME"] = str(mount)
            pinned["HERMES_HOME"] = str(mount / ".hermes")
            with mock.patch.dict(os.environ, pinned, clear=False):
                self.assertEqual(get_hermes_home(), mount / ".hermes")

            docker_default = dict(os.environ)
            docker_default["HOME"] = str(mount)
            docker_default["HERMES_HOME"] = str(mount)
            with mock.patch.dict(os.environ, docker_default, clear=False):
                disagreed = get_hermes_home()
            self.assertEqual(disagreed, mount)
            self.assertNotEqual(disagreed / "auth.json", fallback / "auth.json")


class ResolveCanonicalHomeTests(unittest.TestCase):
    def test_docker_default_remaps_to_dot_hermes(self):
        with mock.patch.dict(os.environ, {"HERMES_HOME": "/opt/data", "HOME": "/opt/data"}, clear=False):
            self.assertEqual(resolve_sunset_email_hermes_home(), CANONICAL_HERMES_HOME)

    def test_unset_follows_home_dot_hermes(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = {k: v for k, v in os.environ.items() if k != "HERMES_HOME"}
            env["HOME"] = tmp
            with mock.patch.dict(os.environ, env, clear=True):
                os.environ.pop("HERMES_HOME", None)
                self.assertEqual(resolve_sunset_email_hermes_home(), Path(tmp) / ".hermes")

    def test_explicit_tmp_home_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.dict(os.environ, {"HERMES_HOME": tmp}, clear=False):
                self.assertEqual(resolve_sunset_email_hermes_home(), Path(tmp))

    def test_pin_exports_canonical_when_docker_default(self):
        with mock.patch.dict(os.environ, {"HERMES_HOME": "/opt/data", "HOME": "/root"}, clear=False):
            root = pin_sunset_email_hermes_home()
            self.assertEqual(root, CANONICAL_HERMES_HOME)
            self.assertEqual(os.environ["HERMES_HOME"], str(CANONICAL_HERMES_HOME))
            self.assertEqual(os.environ["HOME"], str(MOUNTED_HOME))


class BootstrapAcceptsAuthAddLocationTests(unittest.TestCase):
    def test_accepts_dot_hermes_auth_json_regular_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            mount = Path(tmp)
            auth = mount / ".hermes" / "auth.json"
            _write_regular(auth)
            _write_regular(mount / "auth.json", '{"decoy":true}\n')
            result = _run_bootstrap_auth(mount)
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            self.assertIn("ACCEPT_CANONICAL", result.stdout)
            self.assertIn(str(auth), result.stdout)
            config = (mount / ".hermes" / "config.yaml").read_text(encoding="utf-8")
            self.assertIn("default: gpt-5.6-sol", config)
            self.assertFalse((mount / "config.yaml").exists())
            self.assertTrue(auth.is_file())
            self.assertFalse(auth.is_symlink())

    def test_rejects_root_level_duplicate_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            mount = Path(tmp)
            _write_regular(mount / "auth.json")
            result = _run_bootstrap_auth(mount)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(".hermes/auth.json", result.stderr)
            self.assertNotIn("ACCEPT_CANONICAL", result.stdout)

    def test_rejects_symlink(self):
        with tempfile.TemporaryDirectory() as tmp:
            mount = Path(tmp)
            shared = mount / "elsewhere" / "auth.json"
            _write_regular(shared)
            canonical = mount / ".hermes" / "auth.json"
            canonical.parent.mkdir(parents=True, exist_ok=True)
            canonical.symlink_to(shared)
            result = _run_bootstrap_auth(mount)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("symlink", result.stderr)

    def test_rejects_auth_shared_mount(self):
        with tempfile.TemporaryDirectory() as tmp:
            mount = Path(tmp)
            _write_regular(mount / ".hermes" / "auth.json")
            _write_regular(mount / ".auth-shared" / "auth.json")
            result = _run_bootstrap_auth(mount)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(".auth-shared", result.stderr)

    def test_python_owner_accepts_same_path_and_rejects_decoy(self):
        with tempfile.TemporaryDirectory() as tmp:
            mount = Path(tmp)
            canonical = mount / ".hermes"
            _write_regular(canonical / "auth.json")
            _write_regular(mount / "auth.json", '{"decoy":true}\n')
            env = {k: v for k, v in os.environ.items() if k != "HERMES_HOME"}
            env["HOME"] = str(mount)
            with mock.patch.dict(os.environ, env, clear=True):
                os.environ.pop("HERMES_HOME", None)
                ensure_isolated_sol_home()
                self.assertTrue((canonical / "config.yaml").is_file())
        with tempfile.TemporaryDirectory() as decoy_only:
            decoy_mount = Path(decoy_only)
            _write_regular(decoy_mount / "auth.json")
            env2 = {k: v for k, v in os.environ.items() if k != "HERMES_HOME"}
            env2["HOME"] = str(decoy_mount)
            with mock.patch.dict(os.environ, env2, clear=True):
                os.environ.pop("HERMES_HOME", None)
                with self.assertRaises(RuntimeError) as ctx:
                    ensure_isolated_sol_home()
                self.assertIn("isolated_auth_missing", str(ctx.exception))


class OwnersAgreeOnCanonicalPathTests(unittest.TestCase):
    def test_yaml_compose_runbook_verifier_agree(self):
        aca = ACA.read_text(encoding="utf-8")
        compose = SUNSET_COMPOSE.read_text(encoding="utf-8")
        staging = STAGING_COMPOSE.read_text(encoding="utf-8")
        runbook = RUNBOOK.read_text(encoding="utf-8")
        verifier = VERIFIER.read_text(encoding="utf-8")
        instance = INSTANCE.read_text(encoding="utf-8")
        bootstrap = BOOTSTRAP.read_text(encoding="utf-8")
        invoke = (STAGING / "wolfhouse/email_draft_invoke.py").read_text(encoding="utf-8")
        email = _email_service(compose)

        self.assertIn("value: /opt/data/.hermes", aca)
        self.assertRegex(aca, r"- name: HOME\n\s+value: /opt/data\n")
        self.assertRegex(aca, r"- name: HERMES_HOME\n\s+value: /opt/data/\.hermes\n")
        self.assertIn("mountPath: /opt/data", aca)

        self.assertIn("HERMES_HOME: /opt/data/.hermes", email)
        self.assertIn("HOME: /opt/data", email)
        self.assertIn("/var/lib/hermes-sunset-email-luna:/opt/data", email)
        self.assertNotIn("/var/lib/hermes-shared", email)
        self.assertIn("      HERMES_HOME: /opt/data\n      HERMES_ROLE: sunset-luna", compose)
        self.assertIn("      HERMES_HOME: /opt/data\n      HERMES_ROLE: luna", staging)
        self.assertNotIn("sunset-email-luna", staging)

        self.assertIn("/var/lib/hermes-sunset-email-luna/.hermes/auth.json", runbook)
        self.assertNotIn("/var/lib/hermes-sunset-email-luna/auth.json\n", runbook)
        self.assertIn("--path .hermes/auth.json", runbook)
        self.assertNotIn("--path auth.json", runbook)
        self.assertIn("storage directory create", runbook)
        self.assertIn("--name .hermes", runbook)
        self.assertIn("HOME=/opt/data", runbook)
        self.assertIn("HERMES_HOME=/opt/data/.hermes", runbook)
        self.assertIn("HERMES_SKIP_ROLE_BOOTSTRAP=1", runbook)
        self.assertIn("--entrypoint /init", runbook)
        self.assertIn(
            "test ! -L /var/lib/hermes-sunset-email-luna/.hermes/auth.json",
            runbook,
        )
        self.assertNotIn("ln -s", runbook)

        self.assertIn('HERMES_HOME="${HOME}/.hermes"', bootstrap)
        self.assertIn(".hermes/auth.json", bootstrap)
        self.assertIn("CANONICAL_HERMES_HOME", invoke)
        self.assertIn("/opt/data/.hermes", instance)
        self.assertIn(r"/opt\/data\/\.hermes", verifier)
        self.assertNotIn("ln -sf", invoke)
        self.assertNotIn("os.link", invoke)


if __name__ == "__main__":
    unittest.main(verbosity=2)
