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
from typing import Callable

from wolfhouse.email_draft_contract import (
    BAKED_SYSTEM,
    DRAFT_PATH,
    MAX_BODY,
    RESULT_SCHEMA,
    TEMPLATE_REQUEST_SCHEMA,
    TEMPLATE_RESULT_SCHEMA,
    AttemptResult,
    bind_attempt_provenance,
    parse_acts_payload,
    parse_attempt,
    parse_request,
)
from wolfhouse.email_draft_invoke import default_invoke, ensure_isolated_sol_home
from wolfhouse.email_draft_replay import ReplayCache

MAX_SEEN = 2048


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
) -> tuple[int, dict]:
    if not expected_token or not _constant_time_eq(
        authorization, f"Bearer {expected_token}"
    ):
        return 401, {"error": "unauthorized"}
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
    try:
        replay.mark_invoke_started(request_id)
        raw_attempt = invoke(BAKED_SYSTEM, user)
    except Exception:
        replay.finish(request_id)
        return 502, {"error": "hermes_unavailable"}
    replay.finish(request_id)
    attempt = parse_attempt(raw_attempt)
    if attempt is None:
        return 502, {"error": "provenance_unavailable"}
    provenance = bind_attempt_provenance(req, attempt)
    if provenance is None:
        return 502, {"error": "provenance_unavailable"}
    if req["schema"] == TEMPLATE_REQUEST_SCHEMA:
        try:
            plan = json.loads(attempt.content)
        except json.JSONDecodeError:
            return 502, {"error": "model_malformed"}
        if not isinstance(plan, dict) or set(plan.keys()) != {
            "template_id",
            "tone",
            "question_key",
            "acknowledgment_key",
        }:
            return 502, {"error": "model_malformed"}
        return 200, {
            "schema": TEMPLATE_RESULT_SCHEMA,
            "plan": plan,
            "provenance": provenance,
        }
    acts = parse_acts_payload(attempt.content)
    if not acts:
        return 502, {"error": "model_malformed"}
    return 200, {
        "schema": RESULT_SCHEMA,
        "acts": acts,
        "provenance": provenance,
    }


def make_handler(
    expected_token: str,
    invoke: Callable[[str, str], AttemptResult | str],
    replay: ReplayCache,
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
            )
            self._send(status, payload)

    return Handler


def main() -> int:
    token = os.environ.get("API_SERVER_KEY", "").strip()
    if not token:
        print("sunset-email-luna requires API_SERVER_KEY", file=sys.stderr)
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
    handler = make_handler(token, default_invoke, ReplayCache(MAX_SEEN))
    httpd = ThreadingHTTPServer((host, port), handler)
    print(f"sunset-email-luna draft server listening on {host}:{port}", flush=True)
    httpd.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
