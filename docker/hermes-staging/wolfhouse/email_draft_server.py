#!/usr/bin/env python3
"""Internal draft-only HTTP service for sunset-email-luna (MAIL-MVP-007).

Authenticated closed-plan endpoint. No WhatsApp/Discord gateway, no outbound
email, no booking tools. Provenance is bound to the live Hermes composition
attempt that produced the plan. Config strings and caller labels are not
accepted as provider/model proof.
"""

from __future__ import annotations

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable

from wolfhouse.email_draft_contract import (
    BAKED_SYSTEM,
    BAKED_TEMPLATE_SYSTEM,
    DRAFT_PATH,
    MAX_BODY,
    RESULT_SCHEMA,
    TEMPLATE_PLAN_KEYS,
    TEMPLATE_REQUEST_SCHEMA,
    TEMPLATE_RESULT_SCHEMA,
    AttemptResult,
    bind_attempt_provenance,
    parse_acts_payload,
    parse_attempt,
    parse_request,
    parse_template_payload,
    sign_result_authenticity,
)
from wolfhouse.email_draft_invoke import (
    default_invoke,
    ensure_isolated_sol_home,
    resolve_sunset_email_hermes_home,
)
from wolfhouse.email_draft_replay import ReplayCache

MAX_SEEN = 2048

# Keys bootstrap write_sunset_email_luna_env persists. Unknown keys are ignored
# so a corrupted Azure Files .env cannot inject PATH/LD_PRELOAD.
_SUNSET_EMAIL_ENV_KEYS = frozenset(
    {
        "API_SERVER_KEY",
        "EMAIL_LUNA_HERMES_SOL_RESPONSE_HMAC_SECRET",
        "LUNA_TENANT_ID",
        "LUNA_CLIENT_SLUG",
        "LUNA_ALLOWED_LOCATION_IDS",
        "EMAIL_LUNA_DRAFT_LISTEN_HOST",
        "EMAIL_LUNA_DRAFT_LISTEN_PORT",
        "PYTHONPATH",
        "API_SERVER_ENABLED",
        "GATEWAY_ALLOW_ALL_USERS",
        "HERMES_ROLE",
    }
)


def load_sunset_email_luna_env(env_file: Path | None = None) -> None:
    """Fill missing process env from HERMES_HOME/.env. Never print values.

    s6 cont-init imports /run/s6/container_environment and bootstrap writes
    bearer/HMAC there. The Python CMD may not inherit that envdir after /init.
    Existing non-empty process env (ACA secretRef) wins over the file.
    """
    path = env_file if env_file is not None else resolve_sunset_email_hermes_home() / ".env"
    if path.is_symlink() or not path.is_file():
        return
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return
    for line in raw.splitlines():
        stripped = line.replace("\r", "")
        if not stripped or stripped.lstrip().startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        key = key.strip()
        if key not in _SUNSET_EMAIL_ENV_KEYS:
            continue
        if os.environ.get(key, "").strip():
            continue
        os.environ[key] = value


def _constant_time_eq(left: str, right: str) -> bool:
    if not isinstance(left, str) or not isinstance(right, str):
        return False
    if len(left) != len(right):
        return False
    acc = 0
    for a, b in zip(left.encode("utf-8"), right.encode("utf-8")):
        acc |= a ^ b
    return acc == 0


def handle_draft_request(
    *,
    raw_body: bytes,
    authorization: str,
    expected_token: str,
    invoke: Callable[[str, str], AttemptResult | str],
    replay: ReplayCache,
    hmac_secret: str,
) -> tuple[int, dict]:
    if not expected_token or not _constant_time_eq(
        authorization, f"Bearer {expected_token}"
    ):
        return 401, {"error": "unauthorized"}
    if not isinstance(hmac_secret, str) or not hmac_secret or hmac_secret.strip() != hmac_secret:
        return 500, {"error": "hmac_unconfigured"}
    req, reason = parse_request(raw_body)
    if req is None:
        status = 413 if reason == "oversized" else 400
        if reason in {"wrong_tenant", "wrong_location"}:
            status = 403
        return status, {"error": reason}
    request_id = req["request_id"]
    if not replay.claim(request_id):
        return 409, {"error": "replay"}
    user = "BEGIN CANONICAL JSON DATA\n" + json.dumps(
        {
            "language": req["language"],
            "untrusted_email": req["untrusted_email"],
            "private_staff_goals": req["private_staff_goals"],
        },
        separators=(",", ":"),
    ) + "\nEND CANONICAL JSON DATA"
    system = (
        BAKED_TEMPLATE_SYSTEM
        if req["schema"] == TEMPLATE_REQUEST_SCHEMA
        else BAKED_SYSTEM
    )
    try:
        replay.mark_invoke_started(request_id)
        raw_attempt = invoke(system, user)
    except Exception:
        replay.release(request_id)
        return 502, {"error": "hermes_unavailable"}
    attempt = parse_attempt(raw_attempt)
    if attempt is None:
        replay.release(request_id)
        return 502, {"error": "provenance_unavailable"}
    provenance = bind_attempt_provenance(req, attempt)
    if provenance is None:
        replay.release(request_id)
        return 502, {"error": "provenance_unavailable"}
    if req["schema"] == TEMPLATE_REQUEST_SCHEMA:
        plan = parse_template_payload(attempt.content)
        if plan is None or set(plan.keys()) != set(TEMPLATE_PLAN_KEYS):
            replay.release(request_id)
            return 502, {"error": "model_malformed"}
        authenticity = sign_result_authenticity(hmac_secret, req, provenance, plan)
        if authenticity is None:
            replay.release(request_id)
            return 500, {"error": "hmac_unconfigured"}
        replay.finish(request_id)
        return 200, {
            "schema": TEMPLATE_RESULT_SCHEMA,
            "plan": plan,
            "provenance": provenance,
            "authenticity": authenticity,
        }
    acts = parse_acts_payload(attempt.content)
    if not acts:
        replay.release(request_id)
        return 502, {"error": "model_malformed"}
    authenticity = sign_result_authenticity(
        hmac_secret, req, provenance, {"acts": acts}
    )
    if authenticity is None:
        replay.release(request_id)
        return 500, {"error": "hmac_unconfigured"}
    replay.finish(request_id)
    return 200, {
        "schema": RESULT_SCHEMA,
        "acts": acts,
        "provenance": provenance,
        "authenticity": authenticity,
    }


def make_handler(
    expected_token: str,
    invoke: Callable[[str, str], AttemptResult | str],
    replay: ReplayCache,
    hmac_secret: str,
):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt: str, *args) -> None:  # noqa: A003
            sys.stderr.write("email-draft-server " + (fmt % args) + "\n")

        def _send(self, status: int, payload: dict) -> None:
            body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.send_header("cache-control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802
            if self.path.rstrip("/") == "/healthz":
                self._send(200, {"ok": True, "runtime": "sunset-email-luna"})
                return
            self._send(404, {"error": "not_found"})

        def do_POST(self) -> None:  # noqa: N802
            if self.path.split("?", 1)[0] != DRAFT_PATH:
                self._send(404, {"error": "not_found"})
                return
            length = self.headers.get("content-length", "")
            try:
                size = int(length)
            except ValueError:
                self._send(400, {"error": "malformed"})
                return
            if size < 0 or size > MAX_BODY:
                self._send(413, {"error": "oversized"})
                return
            raw = self.rfile.read(size)
            auth = self.headers.get("authorization", "")
            status, payload = handle_draft_request(
                raw_body=raw,
                authorization=auth,
                expected_token=expected_token,
                invoke=invoke,
                replay=replay,
                hmac_secret=hmac_secret,
            )
            if status == 200 and isinstance(payload.get("provenance"), dict):
                sys.stderr.write(
                    "email-draft-server attempt "
                    f"request_id={payload.get('authenticity', {}).get('request_id', '')} "
                    f"provider={payload['provenance'].get('provider')} "
                    f"model={payload['provenance'].get('model')} "
                    f"runtime={payload['provenance'].get('runtime')} "
                    "hmac=ok\n"
                )
            self._send(status, payload)

    return Handler


def main() -> int:
    load_sunset_email_luna_env()
    token = os.environ.get("API_SERVER_KEY", "").strip()
    if not token:
        print("sunset-email-luna requires API_SERVER_KEY", file=sys.stderr)
        return 1
    hmac_secret = os.environ.get("EMAIL_LUNA_HERMES_SOL_RESPONSE_HMAC_SECRET", "")
    if not hmac_secret or hmac_secret.strip() != hmac_secret:
        print("sunset-email-luna requires EMAIL_LUNA_HERMES_SOL_RESPONSE_HMAC_SECRET", file=sys.stderr)
        return 1
    if os.environ.get("HERMES_ROLE", "sunset-email-luna") != "sunset-email-luna":
        print("sunset-email-luna requires HERMES_ROLE=sunset-email-luna", file=sys.stderr)
        return 1
    try:
        ensure_isolated_sol_home()
    except Exception as exc:
        print(f"sunset-email-luna runtime home refused: {exc}", file=sys.stderr)
        return 1
    host = os.environ.get("EMAIL_LUNA_DRAFT_LISTEN_HOST", "127.0.0.1")
    port = int(os.environ.get("EMAIL_LUNA_DRAFT_LISTEN_PORT", "8093"))
    handler = make_handler(token, default_invoke, ReplayCache(MAX_SEEN), hmac_secret)
    httpd = ThreadingHTTPServer((host, port), handler)
    print(f"sunset-email-luna draft server listening on {host}:{port}", flush=True)
    httpd.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
