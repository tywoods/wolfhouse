#!/usr/bin/env python3
"""Internal Luna HTTP runtime for sunset-staging (first shared-channel slice).

Pattern matches email_draft_server.py: healthz + private JSON inbound, Sol home,
Sunset SOUL, wolfhouse_staff_api tools. No WhatsApp/Discord gateway. No Meta
Graph sender. Optional outbound stub posts draft-only to Staff API bot routes.

Live guest WhatsApp remains hermes-sunset-luna (`gateway run`) via Caddy
/whatsapp/* — this service is additive only.
"""

from __future__ import annotations

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable

from wolfhouse.email_draft_replay import ReplayCache
from wolfhouse.luna_http_contract import (
    INBOUND_PATH,
    MAX_BODY,
    ROLE,
    RUNTIME,
    parse_inbound,
)
from wolfhouse.luna_http_invoke import ensure_luna_http_sol_home, resolve_luna_http_hermes_home
from wolfhouse.luna_http_outbound import maybe_outbound
from wolfhouse.luna_http_turn import AvailabilityFn, build_inbound_result, run_first_answer_lookup

MAX_SEEN = 2048

_SUNSET_HTTP_ENV_KEYS = frozenset(
    {
        "API_SERVER_KEY",
        "LUNA_TENANT_ID",
        "LUNA_CLIENT_SLUG",
        "LUNA_ALLOWED_LOCATION_IDS",
        "LUNA_BOT_INTERNAL_TOKEN",
        "WOLFHOUSE_STAFF_API_BASE_URL",
        "STAFF_API_BASE_URL",
        "LUNA_HTTP_LISTEN_HOST",
        "LUNA_HTTP_LISTEN_PORT",
        "PYTHONPATH",
        "API_SERVER_ENABLED",
        "GATEWAY_ALLOW_ALL_USERS",
        "HERMES_ROLE",
        "LUNA_HTTP_ALLOW_MISSING_PLUGIN_TREE",
    }
)


def load_sunset_luna_http_env(env_file: Path | None = None) -> None:
    """Fill missing process env from HERMES_HOME/.env. Never print values."""
    path = env_file if env_file is not None else resolve_luna_http_hermes_home() / ".env"
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
        if key not in _SUNSET_HTTP_ENV_KEYS:
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


def handle_inbound_request(
    *,
    raw_body: bytes,
    authorization: str,
    expected_token: str,
    replay: ReplayCache,
    availability: AvailabilityFn | None = None,
    outbound_fn: Callable[..., dict[str, Any]] | None = None,
) -> tuple[int, dict]:
    if not expected_token or not _constant_time_eq(
        authorization, f"Bearer {expected_token}"
    ):
        return 401, {"error": "unauthorized"}
    req, reason = parse_inbound(raw_body)
    if req is None:
        status = 413 if reason == "oversized" else 400
        if reason in {"wrong_tenant", "wrong_location"}:
            status = 403
        return status, {"error": reason}
    request_id = req["request_id"]
    if not replay.claim(request_id):
        return 409, {"error": "replay"}
    try:
        replay.mark_invoke_started(request_id)
        lookup = run_first_answer_lookup(req, availability=availability)
        outbound_impl = outbound_fn or maybe_outbound
        outbound = outbound_impl(
            req,
            reply_hint=(lookup.get("result") or {}).get("guest_safe_next_action")
            if isinstance(lookup.get("result"), dict)
            else None,
        )
        payload = build_inbound_result(req, lookup, outbound=outbound)
    except Exception as exc:  # noqa: BLE001
        replay.release(request_id)
        return 502, {"error": "turn_failed", "detail": type(exc).__name__}
    if not payload.get("first_answer", {}).get("ok", True):
        # Still return 200 with graded first_answer so callers can assert —
        # the runtime did the joinable path; notes explain any residual risk.
        pass
    replay.finish(request_id)
    return 200, payload


def make_handler(
    expected_token: str,
    replay: ReplayCache,
    availability: AvailabilityFn | None = None,
    outbound_fn: Callable[..., dict[str, Any]] | None = None,
):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt: str, *args) -> None:  # noqa: A003
            sys.stderr.write("luna-http-server " + (fmt % args) + "\n")

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
                self._send(
                    200,
                    {
                        "ok": True,
                        "runtime": RUNTIME,
                        "role": ROLE,
                        "whatsapp_owner": "hermes-sunset-luna",
                    },
                )
                return
            self._send(404, {"error": "not_found"})

        def do_POST(self) -> None:  # noqa: N802
            if self.path.split("?", 1)[0] != INBOUND_PATH:
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
            status, payload = handle_inbound_request(
                raw_body=raw,
                authorization=auth,
                expected_token=expected_token,
                replay=replay,
                availability=availability,
                outbound_fn=outbound_fn,
            )
            if status == 200:
                fa = payload.get("first_answer", {})
                lookup = fa.get("lookup", {}) if isinstance(fa, dict) else {}
                sys.stderr.write(
                    "luna-http-server inbound "
                    f"request_id={payload.get('request_id', '')} "
                    f"scope={lookup.get('scope')} "
                    f"has_fitting_course={lookup.get('has_fitting_course')} "
                    f"first_answer_ok={fa.get('ok')}\n"
                )
            self._send(status, payload)

    return Handler


def main() -> int:
    load_sunset_luna_http_env()
    token = os.environ.get("API_SERVER_KEY", "").strip()
    if not token:
        print("sunset-luna-http requires API_SERVER_KEY", file=sys.stderr)
        return 1
    if os.environ.get("HERMES_ROLE", ROLE) != ROLE:
        print(f"sunset-luna-http requires HERMES_ROLE={ROLE}", file=sys.stderr)
        return 1
    if (os.environ.get("LUNA_CLIENT_SLUG") or "").strip() not in ("", "sunset"):
        print("sunset-luna-http requires LUNA_CLIENT_SLUG=sunset", file=sys.stderr)
        return 1
    try:
        ensure_luna_http_sol_home()
    except Exception as exc:
        print(f"sunset-luna-http runtime home refused: {exc}", file=sys.stderr)
        return 1
    host = os.environ.get("LUNA_HTTP_LISTEN_HOST", "127.0.0.1")
    port = int(os.environ.get("LUNA_HTTP_LISTEN_PORT", "8094"))
    handler = make_handler(token, ReplayCache(MAX_SEEN))
    httpd = ThreadingHTTPServer((host, port), handler)
    print(f"sunset-luna-http listening on {host}:{port}", flush=True)
    httpd.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
