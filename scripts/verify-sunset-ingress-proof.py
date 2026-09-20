#!/usr/bin/env python3
"""Offline acceptance for the Sunset signed ingress-proof route."""

from __future__ import annotations

import hashlib
import hmac
import importlib.util
import os
from pathlib import Path
from unittest import mock

MODULE_PATH = Path(__file__).resolve().parents[1] / "docker" / "hermes-staging" / "sunset_ingress_proof.py"
SPEC = importlib.util.spec_from_file_location("sunset_ingress_proof", MODULE_PATH)
assert SPEC and SPEC.loader
proof = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(proof)


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

print("PASS Sunset ingress proof is exact, signed, fresh-capable, role-bound, and fail-closed")
