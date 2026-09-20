#!/usr/bin/env python3
"""Offline acceptance for the Sunset signed ingress-proof route."""

from __future__ import annotations

import hashlib
import hmac
import importlib.util
import os
from pathlib import Path
import tempfile
from unittest import mock

MODULE_PATH = Path(__file__).resolve().parents[1] / "docker" / "hermes-staging" / "sunset_ingress_proof.py"
SPEC = importlib.util.spec_from_file_location("sunset_ingress_proof", MODULE_PATH)
assert SPEC and SPEC.loader
proof = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(proof)

PATCHER_PATH = MODULE_PATH.with_name("apply_whatsapp_fresh_start_route.py")
PATCHER_SPEC = importlib.util.spec_from_file_location("apply_whatsapp_fresh_start_route", PATCHER_PATH)
assert PATCHER_SPEC and PATCHER_SPEC.loader
patcher = importlib.util.module_from_spec(PATCHER_SPEC)
PATCHER_SPEC.loader.exec_module(patcher)


class Router:
    def __init__(self):
        self.routes = {}

    def add_get(self, path, handler):
        self.routes[path] = handler


class App:
    def __init__(self):
        self.router = Router()


def sunset_env():
    return mock.patch.dict(
        os.environ,
        {
            "HERMES_ROLE": "sunset-luna",
            "LUNA_TENANT_ID": "sunset",
            "WHATSAPP_CLOUD_WEBHOOK_PORT": "8094",
            "LUNA_ROUTING_INGRESS_PROOF_KEY": "k" * 32,
        },
        clear=True,
    )


with sunset_env():
    body = proof.build_proof(now_ms=123456789)
    payload = "\n".join(
        [body["number_e164"], body["phone_number_id"], body["path"], body["environment"], body["upstream"], str(body["observed_at_ms"])]
    )
    expected = hmac.new(b"k" * 32, payload.encode(), hashlib.sha256).hexdigest()
    assert body == {
        "number_e164": "+346****9419",
        "phone_number_id": "1152900101233109",
        "path": "/whatsapp/webhook",
        "environment": "staging",
        "upstream": "127.0.0.1:8094",
        "observed_at_ms": 123456789,
        "signature": expected,
    }
    app = App()
    assert proof.register_ingress_proof_route(app) is True
    assert list(app.router.routes) == ["/whatsapp/routing-proof"]

with mock.patch.dict(os.environ, {"HERMES_ROLE": "luna", "LUNA_ROUTING_INGRESS_PROOF_KEY": "k" * 32}, clear=True):
    app = App()
    assert proof.register_ingress_proof_route(app) is False
    assert not app.router.routes
    try:
        proof.build_proof(now_ms=1)
        raise AssertionError("non-Sunset runtime produced a proof")
    except RuntimeError:
        pass

with mock.patch.dict(
    os.environ,
    {"HERMES_ROLE": "sunset-luna", "LUNA_TENANT_ID": "sunset", "WHATSAPP_CLOUD_WEBHOOK_PORT": "8094"},
    clear=True,
):
    try:
        proof.register_ingress_proof_route(App())
        raise AssertionError("Sunset runtime started proof route without a key")
    except RuntimeError:
        pass


def assert_patch_twice_is_exact(source: str, label: str) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        target = Path(tmp) / "whatsapp_cloud.py"
        target.write_text(source, encoding="utf-8")
        first = patcher.apply_patches(target)
        once = target.read_text(encoding="utf-8")
        second = patcher.apply_patches(target)
        twice = target.read_text(encoding="utf-8")
        assert first["ingress_proof_route"] and second["ingress_proof_route"], label
        assert once == twice, f"{label} was not byte-idempotent"
        assert once.count(patcher.INGRESS_PROOF_TAG) == 1, label


pristine = """class WhatsApp:\n    def register(self, app):\n        app.router.add_post(self._webhook_path, self._handle_webhook)\n"""
assert_patch_twice_is_exact(pristine, "pristine patch")

legacy = pristine.replace(
    "app.router.add_post(self._webhook_path, self._handle_webhook)",
    "app.router.add_post(self._webhook_path, self._handle_webhook)" + patcher.FRESH_START_ROUTE,
)
assert patcher.FRESH_START_TAG in legacy and patcher.INGRESS_PROOF_TAG not in legacy
assert_patch_twice_is_exact(legacy, "legacy Fresh Start upgrade")

with tempfile.TemporaryDirectory() as tmp:
    malformed = Path(tmp) / "whatsapp_cloud.py"
    malformed.write_text("def unrelated():\n    pass\n", encoding="utf-8")
    try:
        patcher.apply_patches(malformed)
        raise AssertionError("missing webhook anchor did not fail closed")
    except RuntimeError:
        pass

print("PASS Sunset ingress proof is signed, role-bound, fail-closed, upgrade-safe, and idempotent")
