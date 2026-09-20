"""Signed staging ingress proof for the isolated Sunset WhatsApp runtime."""

from __future__ import annotations

import hashlib
import hmac
import os
import time

PROOF_PATH = "/whatsapp/routing-proof"
NUMBER_E164 = "+346****9419"
PHONE_NUMBER_ID = "1152900101233109"
WEBHOOK_PATH = "/whatsapp/webhook"
UPSTREAM = "127.0.0.1:8094"
ENVIRONMENT = "staging"


def _is_sunset_runtime() -> bool:
    return (
        os.getenv("HERMES_ROLE") == "sunset-luna"
        and os.getenv("LUNA_TENANT_ID") == "sunset"
        and os.getenv("WHATSAPP_CLOUD_WEBHOOK_PORT") == "8094"
    )


def build_proof(*, now_ms: int | None = None) -> dict:
    if not _is_sunset_runtime():
        raise RuntimeError("ingress proof is restricted to the isolated Sunset runtime")
    key = os.getenv("LUNA_ROUTING_INGRESS_PROOF_KEY", "")
    if len(key.encode("utf-8")) < 32:
        raise RuntimeError("LUNA_ROUTING_INGRESS_PROOF_KEY must contain at least 32 bytes")
    observed_at_ms = int(time.time() * 1000) if now_ms is None else int(now_ms)
    fields = [NUMBER_E164, PHONE_NUMBER_ID, WEBHOOK_PATH, ENVIRONMENT, UPSTREAM, str(observed_at_ms)]
    signature = hmac.new(key.encode(), "\n".join(fields).encode(), hashlib.sha256).hexdigest()
    return {
        "number_e164": NUMBER_E164,
        "phone_number_id": PHONE_NUMBER_ID,
        "path": WEBHOOK_PATH,
        "environment": ENVIRONMENT,
        "upstream": UPSTREAM,
        "observed_at_ms": observed_at_ms,
        "signature": signature,
    }


async def _handle_proof(_request):
    from aiohttp import web

    try:
        return web.json_response(build_proof(), headers={"Cache-Control": "no-store"})
    except RuntimeError:
        return web.json_response(
            {"ok": False, "code": "ingress_proof_unavailable"},
            status=503,
            headers={"Cache-Control": "no-store"},
        )


def register_ingress_proof_route(app) -> bool:
    """Register only on the exact isolated Sunset staging runtime."""
    if not _is_sunset_runtime():
        return False
    # Refuse Sunset startup without the signing key rather than expose a dead proof route.
    build_proof(now_ms=0)
    app.router.add_get(PROOF_PATH, _handle_proof)
    return True
