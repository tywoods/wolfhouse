#!/usr/bin/env python3
"""MAIL-MVP-007 hotfix: Azure Files setup SOUL is read-only; email bootstrap must replace it.

01-hermes-setup seeds $HERMES_HOME/SOUL.md before 99-wh-staging-bootstrap.
On Azure Files CIFS the file can be DOS-readonly: `cp` overwrite fails even
when the parent directory is writable (live noperm/gid=0 did not fix it).
Email role unlinks then installs the role SOUL + overlay, writes .env from
imported s6 env, and the Python service loads that .env. Auth.json is
untouched. Missing HMAC still fails closed. Never print secret values.
"""

from __future__ import annotations

import hashlib
import io
import os
import re
import shutil
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

from wolfhouse.email_draft_server import (  # noqa: E402
    load_sunset_email_luna_env,
    main as draft_server_main,
)

BOOTSTRAP = STAGING / "bootstrap.sh"
OVERLAY = STAGING / "wolfhouse/email_draft_soul_overlay.md"
SUNSET_SOUL = REPO / "docker/hermes-sunset/SOUL.md"
STAGING_SOUL = STAGING / "SOUL.md"
DOCKERFILE = STAGING / "Dockerfile"
ACA = STAGING / "sunset-email-luna.aca.yaml.example"
SETUP_SOUL = "# 01-hermes-setup default SOUL.md\nYou are the default Hermes agent.\n"
HMAC_VALUE = "azurefiles-test-hmac-do-not-print"
TOKEN_VALUE = "azurefiles-test-token-do-not-print"
AUTH_BODY = '{"providers":{"openai-codex":{"kind":"oauth"}}}\n'


def _extract_function(text: str, name: str) -> str:
    match = re.search(rf"^{re.escape(name)}\(\) \{{(.*?)^}}\n", text, re.M | re.S)
    if not match:
        raise AssertionError(f"bootstrap missing function {name}")
    return f"{name}() {{\n{match.group(1)}}}\n"


def _rewrite_bootstrap(text: str, fake_etc: Path, s6_dir: Path) -> str:
    rewritten = text.replace("/run/s6/container_environment", str(s6_dir))
    rewritten = rewritten.replace("/etc/hermes-sunset", str(fake_etc / "hermes-sunset"))
    rewritten = rewritten.replace("/etc/hermes-staging", str(fake_etc / "hermes-staging"))
    return rewritten


def _prepare_fake_etc(fake_etc: Path, s6_dir: Path, *, hmac: str | None, token: str | None) -> None:
    sunset_dir = fake_etc / "hermes-sunset"
    staging_dir = fake_etc / "hermes-staging" / "wolfhouse"
    sunset_dir.mkdir(parents=True)
    staging_dir.mkdir(parents=True)
    shutil.copyfile(SUNSET_SOUL, sunset_dir / "SOUL.md")
    shutil.copyfile(STAGING_SOUL, fake_etc / "hermes-staging" / "SOUL.md")
    shutil.copyfile(OVERLAY, staging_dir / "email_draft_soul_overlay.md")
    s6_dir.mkdir(parents=True)
    required = {
        "HERMES_ROLE": "sunset-email-luna",
        "LUNA_CLIENT_SLUG": "sunset",
        "LUNA_TENANT_ID": "sunset",
        "LUNA_ALLOWED_LOCATION_IDS": "sunset-somo",
    }
    if token is not None:
        required["API_SERVER_KEY"] = token
    if hmac is not None:
        required["EMAIL_LUNA_HERMES_SOL_RESPONSE_HMAC_SECRET"] = hmac
    for name, value in required.items():
        (s6_dir / name).write_text(value, encoding="utf-8")


def _seed_azurefiles_home(mount: Path) -> tuple[Path, Path, str]:
    hermes = mount / ".hermes"
    hermes.mkdir(parents=True)
    auth = hermes / "auth.json"
    auth.write_text(AUTH_BODY, encoding="utf-8")
    auth.chmod(0o600)
    digest = hashlib.sha256(auth.read_bytes()).hexdigest()
    soul = hermes / "SOUL.md"
    soul.write_text(SETUP_SOUL, encoding="utf-8")
    soul.chmod(0o444)
    return hermes, auth, digest


def _run_email_bootstrap(
    mount: Path,
    *,
    hmac: str | None,
    token: str | None,
    extra_env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    with tempfile.TemporaryDirectory() as fake:
        fake_etc = Path(fake) / "etc"
        s6_dir = Path(fake) / "s6"
        _prepare_fake_etc(fake_etc, s6_dir, hmac=hmac, token=token)
        script = _rewrite_bootstrap(BOOTSTRAP.read_text(encoding="utf-8"), fake_etc, s6_dir)
        env = {
            "HOME": str(mount),
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "LC_ALL": "C",
        }
        if extra_env:
            env.update(extra_env)
        return subprocess.run(
            ["sh", "-s"],
            input=script,
            text=True,
            capture_output=True,
            check=False,
            env=env,
            cwd=str(mount),
            timeout=30,
        )


def _has_key_value(text: str, key: str, value: str) -> bool:
    prefix = f"{key}="
    for line in text.splitlines():
        if line.startswith(prefix) and line[len(prefix):] == value:
            return True
    return False


def _combined(result: subprocess.CompletedProcess[str]) -> str:
    return f"{result.stdout}{result.stderr}"


class NaiveCpCannotOverwriteSetupSoulTests(unittest.TestCase):
    def test_cp_without_unlink_fails_on_readonly_dest(self):
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "SOUL.md"
            dest.write_text(SETUP_SOUL, encoding="utf-8")
            dest.chmod(0o444)
            src = Path(tmp) / "role.SOUL.md"
            src.write_text("role soul\n", encoding="utf-8")
            naive = subprocess.run(
                ["cp", str(src), str(dest)],
                capture_output=True,
                text=True,
                check=False,
                timeout=10,
                stdin=subprocess.DEVNULL,
            )
            self.assertNotEqual(naive.returncode, 0)
            self.assertEqual(dest.read_text(encoding="utf-8"), SETUP_SOUL)


class EmailRoleReplacesReadonlySetupSoulTests(unittest.TestCase):
    def test_replaces_setup_soul_writes_env_preserves_auth(self):
        with tempfile.TemporaryDirectory() as tmp:
            mount = Path(tmp)
            hermes, auth, digest = _seed_azurefiles_home(mount)
            result = _run_email_bootstrap(mount, hmac=HMAC_VALUE, token=TOKEN_VALUE)
            combined = _combined(result)
            self.assertEqual(result.returncode, 0, combined)
            self.assertNotIn(HMAC_VALUE, combined)
            self.assertNotIn(TOKEN_VALUE, combined)
            soul = (hermes / "SOUL.md").read_text(encoding="utf-8")
            self.assertNotEqual(soul, SETUP_SOUL)
            self.assertIn("Email draft channel (Staff Inbox only)", soul)
            self.assertTrue((hermes / "config.yaml").is_file())
            config = (hermes / "config.yaml").read_text(encoding="utf-8")
            self.assertIn("default: gpt-5.6-sol", config)
            self.assertIn("provider: openai-codex", config)
            env_text = (hermes / ".env").read_text(encoding="utf-8")
            self.assertTrue(
                _has_key_value(env_text, "EMAIL_LUNA_HERMES_SOL_RESPONSE_HMAC_SECRET", HMAC_VALUE),
                "HMAC missing from .env",
            )
            self.assertTrue(
                _has_key_value(env_text, "API_SERVER_KEY", TOKEN_VALUE),
                "bearer missing from .env",
            )
            self.assertEqual(auth.read_text(encoding="utf-8"), AUTH_BODY)
            self.assertEqual(hashlib.sha256(auth.read_bytes()).hexdigest(), digest)
            self.assertFalse(auth.is_symlink())
            self.assertFalse((hermes / "SOUL.md").is_symlink())
            self.assertFalse((mount / "config.yaml").exists())
            self.assertFalse((mount / ".env").exists())

    def test_missing_hmac_fails_closed_before_env_completion(self):
        with tempfile.TemporaryDirectory() as tmp:
            mount = Path(tmp)
            hermes, auth, digest = _seed_azurefiles_home(mount)
            result = _run_email_bootstrap(mount, hmac=None, token=TOKEN_VALUE)
            combined = _combined(result)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("EMAIL_LUNA_HERMES_SOL_RESPONSE_HMAC_SECRET", result.stderr)
            self.assertNotIn(TOKEN_VALUE, combined)
            self.assertFalse((hermes / ".env").exists())
            self.assertEqual(auth.read_text(encoding="utf-8"), AUTH_BODY)
            self.assertEqual(hashlib.sha256(auth.read_bytes()).hexdigest(), digest)


class PythonLoadsBootstrapEnvTests(unittest.TestCase):
    def test_load_fills_missing_hmac_without_printing(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            env_file = home / ".env"
            env_file.write_text(
                f"API_SERVER_KEY={TOKEN_VALUE}\n"
                f"EMAIL_LUNA_HERMES_SOL_RESPONSE_HMAC_SECRET={HMAC_VALUE}\n"
                "LD_PRELOAD=/tmp/evil.so\n",
                encoding="utf-8",
            )
            env = {
                k: v
                for k, v in os.environ.items()
                if k
                not in {
                    "API_SERVER_KEY",
                    "EMAIL_LUNA_HERMES_SOL_RESPONSE_HMAC_SECRET",
                    "LD_PRELOAD",
                }
            }
            env["HERMES_HOME"] = str(home)
            env["HOME"] = str(home)
            with mock.patch.dict(os.environ, env, clear=True):
                os.environ.pop("API_SERVER_KEY", None)
                os.environ.pop("EMAIL_LUNA_HERMES_SOL_RESPONSE_HMAC_SECRET", None)
                os.environ.pop("LD_PRELOAD", None)
                buf = io.StringIO()
                with mock.patch("sys.stdout", buf), mock.patch("sys.stderr", buf):
                    load_sunset_email_luna_env()
                dumped = buf.getvalue()
                self.assertNotIn(HMAC_VALUE, dumped)
                self.assertNotIn(TOKEN_VALUE, dumped)
                self.assertEqual(os.environ.get("EMAIL_LUNA_HERMES_SOL_RESPONSE_HMAC_SECRET"), HMAC_VALUE)
                self.assertEqual(os.environ.get("API_SERVER_KEY"), TOKEN_VALUE)
                self.assertNotIn("LD_PRELOAD", os.environ)

    def test_process_env_wins_over_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            env_file = Path(tmp) / ".env"
            env_file.write_text(
                f"EMAIL_LUNA_HERMES_SOL_RESPONSE_HMAC_SECRET={HMAC_VALUE}\n",
                encoding="utf-8",
            )
            live = "live-process-hmac-do-not-print"
            with mock.patch.dict(
                os.environ,
                {"EMAIL_LUNA_HERMES_SOL_RESPONSE_HMAC_SECRET": live},
                clear=False,
            ):
                load_sunset_email_luna_env(env_file)
                self.assertEqual(
                    os.environ["EMAIL_LUNA_HERMES_SOL_RESPONSE_HMAC_SECRET"], live
                )

    def test_main_missing_hmac_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            (home / "auth.json").write_text(AUTH_BODY, encoding="utf-8")
            (home / ".env").write_text(f"API_SERVER_KEY={TOKEN_VALUE}\n", encoding="utf-8")
            env = {
                k: v
                for k, v in os.environ.items()
                if k
                not in {
                    "API_SERVER_KEY",
                    "EMAIL_LUNA_HERMES_SOL_RESPONSE_HMAC_SECRET",
                }
            }
            env["HERMES_HOME"] = str(home)
            env["HOME"] = str(home)
            env["HERMES_ROLE"] = "sunset-email-luna"
            stderr = io.StringIO()
            stdout = io.StringIO()
            with mock.patch.dict(os.environ, env, clear=True):
                os.environ.pop("EMAIL_LUNA_HERMES_SOL_RESPONSE_HMAC_SECRET", None)
                with mock.patch("sys.stderr", stderr), mock.patch("sys.stdout", stdout):
                    rc = draft_server_main()
            self.assertEqual(rc, 1)
            err = stderr.getvalue() + stdout.getvalue()
            self.assertIn("EMAIL_LUNA_HERMES_SOL_RESPONSE_HMAC_SECRET", err)
            self.assertNotIn(TOKEN_VALUE, err)
            self.assertNotIn(HMAC_VALUE, err)
            self.assertNotIn(AUTH_BODY, err)

    def test_main_loads_hmac_from_env_file_then_listens(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            (home / "auth.json").write_text(AUTH_BODY, encoding="utf-8")
            (home / ".env").write_text(
                f"API_SERVER_KEY={TOKEN_VALUE}\n"
                f"EMAIL_LUNA_HERMES_SOL_RESPONSE_HMAC_SECRET={HMAC_VALUE}\n",
                encoding="utf-8",
            )
            env = {
                k: v
                for k, v in os.environ.items()
                if k
                not in {
                    "API_SERVER_KEY",
                    "EMAIL_LUNA_HERMES_SOL_RESPONSE_HMAC_SECRET",
                }
            }
            env["HERMES_HOME"] = str(home)
            env["HOME"] = str(home)
            env["HERMES_ROLE"] = "sunset-email-luna"
            stderr = io.StringIO()
            stdout = io.StringIO()
            with mock.patch.dict(os.environ, env, clear=True):
                os.environ.pop("API_SERVER_KEY", None)
                os.environ.pop("EMAIL_LUNA_HERMES_SOL_RESPONSE_HMAC_SECRET", None)
                with mock.patch(
                    "wolfhouse.email_draft_server.ensure_isolated_sol_home"
                ), mock.patch(
                    "wolfhouse.email_draft_server.ThreadingHTTPServer"
                ) as httpd:
                    httpd.return_value.serve_forever.return_value = None
                    with mock.patch("sys.stderr", stderr), mock.patch("sys.stdout", stdout):
                        rc = draft_server_main()
            self.assertEqual(rc, 0)
            dumped = stderr.getvalue() + stdout.getvalue()
            self.assertNotIn(HMAC_VALUE, dumped)
            self.assertNotIn(TOKEN_VALUE, dumped)


class EmailOnlySoulReplaceAndStartupOrderTests(unittest.TestCase):
    def test_other_roles_still_use_plain_cp(self):
        bootstrap = BOOTSTRAP.read_text(encoding="utf-8")
        self.assertIn("install_sunset_email_luna_soul", bootstrap)
        email = re.search(
            r'elif \[ "\$HERMES_ROLE" = "sunset-email-luna" \]; then\n(.*?)(?=\nelif |\nelse\n)',
            bootstrap,
            re.S,
        )
        self.assertIsNotNone(email)
        email_body = email.group(1)
        self.assertIn("install_sunset_email_luna_soul", email_body)
        self.assertIn("write_sunset_email_luna_env", email_body)
        self.assertLess(
            email_body.index("install_sunset_email_luna_soul"),
            email_body.index("write_sunset_email_luna_env"),
        )
        self.assertNotIn("install_luna_plugins", email_body)
        self.assertNotIn("link_shared_auth", email_body)
        for role, needle in (
            ("orchestrator", 'if [ "$HERMES_ROLE" = "orchestrator" ]; then'),
            ("deckhand", 'elif [ "$HERMES_ROLE" = "deckhand" ]; then'),
            ("luna", 'elif [ "$HERMES_ROLE" = "luna" ]'),
        ):
            start = bootstrap.index(needle)
            nxt = bootstrap.find("elif [", start + 1)
            block = bootstrap[start:nxt]
            self.assertNotIn(
                "install_sunset_email_luna_soul",
                block,
                f"{role} must not call email SOUL replace",
            )
        self.assertIn('cp "$STAGING_ORCH_SOUL" "$HERMES_HOME/SOUL.md"', bootstrap)
        self.assertIn('cp "$STAGING_DECKHAND_SOUL" "$HERMES_HOME/SOUL.md"', bootstrap)
        self.assertIn('cp "$STAGING_LUNA_SOUL" "$HERMES_HOME/SOUL.md"', bootstrap)

    def test_cont_init_order_and_tight_cifs_modes(self):
        dockerfile = DOCKERFILE.read_text(encoding="utf-8")
        bootstrap = BOOTSTRAP.read_text(encoding="utf-8")
        aca = ACA.read_text(encoding="utf-8")
        self.assertIn(
            "COPY bootstrap.sh /etc/cont-init.d/99-wh-staging-bootstrap",
            dockerfile,
        )
        self.assertIn("01-hermes-setup", bootstrap)
        self.assertIn("99-wh-staging-bootstrap", bootstrap)
        self.assertIn(
            "mountOptions: uid=10000,gid=10000,nobrl,mfsymlinks,dir_mode=0700,file_mode=0600",
            aca,
        )
        self.assertNotIn("noperm", aca)
        self.assertNotIn("uid=0,", aca)
        self.assertNotIn("gid=0,", aca)
        fn = _extract_function(bootstrap, "install_sunset_email_luna_soul")
        self.assertIn("rm -f", fn)
        self.assertIn("SOUL.md", fn)


if __name__ == "__main__":
    unittest.main(verbosity=2)
