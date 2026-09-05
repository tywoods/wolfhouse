#!/usr/bin/env python3
"""Bounded Sunset-only Luna Personality live-model proof runner.

Default is dry-run / preflight. --execute-live snapshots the Staff setting,
PUTs each closed pack via the existing operator Staff session principal
(never bot write authority), runs the allowlisted isolated matrix, and
always restores with an independent GET.

Offline tests inject OfflineStaffTransportDouble and a labeled invoke
double. Those doubles are never live acceptance.

  LUNA_PERSONALITY_LIVE_PROOF=SUNSET_STAGING_ONLY python3 -m wolfhouse.run_luna_personality_live_proof --execute-live

Restoration: Staff PUT cannot delete a stored setting back to source=default.
If the original source was default and the effective id is sunny, a restore
PUT of sunny leaves source=stored. Qualify that explicitly in the receipt.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Dict, List, Optional
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from wolfhouse.luna_personality import CLOSED_PERSONALITY_IDS, DEFAULT_PERSONALITY_ID
from wolfhouse.luna_personality_isolation import IsolationAbort
from wolfhouse.luna_personality_live_eval import (
    ALLOWED_CASE_IDS,
    LIVE_EVAL_PATH,
    compare_pack_styles,
    load_corpus,
    run_isolated_personality_eval,
)

WARMTH_CASES = ("warmth-greeting-en", "warmth-dates-en", "warmth-greeting-es", "warmth-dates-es")
TRUTH_CASES = ("truth-payment-link-en", "truth-payment-link-es", "invariant-identity-en", "invariant-spots-es")
ALLOWED_STAFF_ORIGINS = frozenset({"https://sunset-staging.lunafrontdesk.com"})
TURN_TIMEOUT_S = 45.0
MATRIX_CONCURRENCY = 1
STAFF_GET_PATH = "/staff/luna-personality"
STAFF_PUT_PATH = "/staff/luna-personality"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _redact(value: Any) -> str:
    text = str(value or "")
    if not text:
        return ""
    return f"<redacted:{len(text)}b>"


def parse_exact_staff_origin(url: str) -> str:
    raw = str(url or "").strip()
    parsed = urlparse(raw)
    if parsed.scheme != "https":
        raise IsolationAbort("staff_origin_not_https")
    if parsed.username or parsed.password:
        raise IsolationAbort("staff_origin_userinfo_forbidden")
    host = (parsed.hostname or "").lower()
    if parsed.port:
        raise IsolationAbort("staff_origin_port_forbidden")
    origin = f"{parsed.scheme}://{host}"
    if origin not in ALLOWED_STAFF_ORIGINS:
        raise IsolationAbort(f"staff_origin_not_allowlisted:{host or 'empty'}")
    if parsed.path not in ("", "/"):
        raise IsolationAbort("staff_origin_path_forbidden")
    if parsed.query or parsed.fragment:
        raise IsolationAbort("staff_origin_query_forbidden")
    return origin


class StaffSessionTransport:
    """Production Staff GET/PUT using an operator session cookie. Never bot PUT."""

    def __init__(self, origin: str, cookie: str, *, timeout_s: float = 8.0) -> None:
        self.origin = parse_exact_staff_origin(origin)
        self._cookie = str(cookie or "").strip()
        self.timeout_s = timeout_s
        self.label = "staff_session_transport"
        if not self._cookie:
            raise IsolationAbort("staff_session_cookie_missing")

    def _headers(self) -> Dict[str, str]:
        return {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Cookie": self._cookie,
        }

    def _request(self, method: str, path: str, body: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = Request(self.origin + path, data=data, method=method, headers=self._headers())
        with urlopen(req, timeout=self.timeout_s) as res:
            raw = res.read().decode("utf-8") if res else "{}"
        parsed = json.loads(raw or "{}")
        if not isinstance(parsed, dict):
            raise IsolationAbort("staff_personality_invalid_json")
        return parsed

    def get_personality(self) -> Dict[str, Any]:
        return self._request("GET", STAFF_GET_PATH)

    def put_personality(self, personality_id: str) -> Dict[str, Any]:
        pid = str(personality_id or "").strip().lower()
        if pid not in CLOSED_PERSONALITY_IDS:
            raise IsolationAbort("invalid_personality_id")
        return self._request("PUT", STAFF_PUT_PATH, {"personality_id": pid, "channel": "whatsapp"})


class OfflineStaffTransportDouble:
    """TEST DOUBLE — in-memory Staff personality store. Never live acceptance.

    Writes require auth_mode=session (existing operator principal). Bot token
    is rejected for PUT. No network.
    """

    label = "offline_staff_transport_double"

    def __init__(
        self,
        *,
        initial: Optional[Dict[str, Any]] = None,
        principal: Optional[Dict[str, str]] = None,
    ) -> None:
        self.state = dict(initial or {"personality_id": "sunny", "source": "stored", "persisted": True})
        self.principal = dict(principal or {"auth_mode": "session", "role": "operator", "client_slug": "sunset"})
        self.calls: List[Dict[str, Any]] = []
        self.fail_restore = False
        self.fail_put: Optional[str] = None

    def get_personality(self) -> Dict[str, Any]:
        self.calls.append({"method": "GET", "path": STAFF_GET_PATH, "auth_mode": self.principal.get("auth_mode")})
        return {
            "success": True,
            "personality_id": self.state.get("personality_id"),
            "source": self.state.get("source"),
            "channel": "whatsapp",
        }

    def put_personality(self, personality_id: str) -> Dict[str, Any]:
        mode = str(self.principal.get("auth_mode") or "")
        if mode != "session":
            raise IsolationAbort("bot_write_not_authorized")
        pid = str(personality_id or "").strip().lower()
        if pid not in CLOSED_PERSONALITY_IDS:
            raise IsolationAbort("invalid_personality_id")
        self.calls.append({"method": "PUT", "path": STAFF_PUT_PATH, "auth_mode": mode, "personality_id": pid})
        if self.fail_put == pid:
            raise IsolationAbort("staff_put_failed")
        if self.fail_restore and pid == self.state.get("_original"):
            raise IsolationAbort("restore_put_failed")
        self.state["personality_id"] = pid
        self.state["source"] = "stored"
        self.state["persisted"] = True
        return {"success": True, "personality_id": pid, "source": "stored", "persisted": True}


def serving_preflight(
    *,
    staff_origin: Optional[str] = None,
    require_exact_origin: bool = True,
    transport: Any = None,
) -> Dict[str, Any]:
    role = (os.getenv("HERMES_ROLE") or "").strip()
    slug = (os.getenv("LUNA_CLIENT_SLUG") or os.getenv("LUNA_BOT_CLIENT_SLUG") or "").strip()
    home = (os.getenv("HERMES_HOME") or "").strip()
    expected_home = (os.getenv("LUNA_PERSONALITY_EXPECTED_HERMES_HOME") or "/opt/data/.hermes").strip()
    base = staff_origin if staff_origin is not None else (os.getenv("WOLFHOUSE_STAFF_API_BASE_URL") or "").rstrip("/")
    token_present = bool((os.getenv("LUNA_BOT_INTERNAL_TOKEN") or "").strip())
    cookie_present = bool((os.getenv("LUNA_PERSONALITY_STAFF_COOKIE") or "").strip())
    model = (os.getenv("HERMES_MODEL") or os.getenv("LLM_MODEL") or "").strip()
    notes = [
        "Staff API LUNA_BOT_INTERNAL_TOKEN must equal Hermes LUNA_BOT_INTERNAL_TOKEN.",
        "Staff writes use operator session cookie (LUNA_PERSONALITY_STAFF_COOKIE), never bot PUT.",
        "Staff API LUNA_BOT_CLIENT_SLUG (or DEFAULT_CLIENT_SLUG) must be sunset.",
        "Do not rotate credentials in this change.",
        "Stored sunny cannot be reset to source=default via this API.",
        "Secrets are never logged.",
    ]
    origin_ok = False
    origin_error = None
    parsed_origin = None
    labeled_double = bool(transport is not None and getattr(transport, "label", "") == "offline_staff_transport_double")
    try:
        if labeled_double:
            parsed_origin = "double://offline-staff-transport"
            origin_ok = True
            notes.append("staff_origin_skipped_for_offline_staff_transport_double")
        elif require_exact_origin:
            parsed_origin = parse_exact_staff_origin(base)
            origin_ok = True
        else:
            parsed_origin = base
            origin_ok = bool(base)
    except IsolationAbort as exc:
        origin_error = exc.reason
        origin_ok = False

    soul_ok = False
    if home:
        soul = os.path.join(home, "SOUL.md")
        soul_ok = os.path.isfile(soul) and os.path.getsize(soul) > 0
    if not soul_ok:
        soul_ok = os.path.isfile("/etc/hermes-staging/SOUL.md") and os.path.getsize("/etc/hermes-staging/SOUL.md") > 0

    home_ok = bool(home) and os.path.normpath(home) == os.path.normpath(expected_home)
    ok = (
        role == "sunset-luna"
        and slug == "sunset"
        and origin_ok
        and token_present
        and (cookie_present or labeled_double)
        and home_ok
        and soul_ok
        and bool(model)
    )
    return {
        "ok": ok,
        "HERMES_ROLE": role,
        "LUNA_CLIENT_SLUG": slug,
        "HERMES_HOME": home,
        "HERMES_HOME_ok": home_ok,
        "soul_observed": soul_ok,
        "model_observed": bool(model),
        "model_name": model or None,
        "staff_origin": parsed_origin,
        "staff_origin_ok": origin_ok,
        "staff_origin_error": origin_error,
        "bot_token_present": token_present,
        "staff_cookie_present": cookie_present or labeled_double,
        "staff_cookie": _redact(os.getenv("LUNA_PERSONALITY_STAFF_COOKIE")),
        "live_eval_path": LIVE_EVAL_PATH,
        "allowlisted_case_ids": sorted(ALLOWED_CASE_IDS),
        "closed_ids": list(CLOSED_PERSONALITY_IDS),
        "transport_label": getattr(transport, "label", None),
        "notes": notes,
    }


def planned_turns() -> List[Dict[str, str]]:
    turns = []
    for pid in CLOSED_PERSONALITY_IDS:
        for case_id in WARMTH_CASES + TRUTH_CASES:
            turns.append({"personality_id": pid, "case_id": case_id})
    return turns


def sanitize_receipt(row: Dict[str, Any]) -> Dict[str, Any]:
    allowed = {
        "ok",
        "case_id",
        "lang",
        "kind",
        "personality_id",
        "requested_personality_id",
        "tools_invoked",
        "sends_attempted",
        "sends_completed",
        "model_calls",
        "model_called",
        "model",
        "semantic",
        "whatsapp_suppressed",
        "observed_pack_id",
        "evidence_kind",
        "error",
    }
    out = {k: row.get(k) for k in allowed if k in row}
    reply = str(row.get("reply_text") or "")
    out["reply_len"] = len(reply)
    out["reply_preview"] = reply[:180]
    return out


def snapshot_setting(transport: Any) -> Dict[str, Any]:
    row = transport.get_personality()
    pid = str(row.get("personality_id") or "").strip().lower()
    if pid not in CLOSED_PERSONALITY_IDS:
        raise IsolationAbort("snapshot_invalid_personality")
    return {
        "personality_id": pid,
        "source": row.get("source"),
        "independent_get": True,
    }


def put_and_verify(transport: Any, personality_id: str) -> Dict[str, Any]:
    put_row = transport.put_personality(personality_id)
    got = transport.get_personality()
    got_id = str(got.get("personality_id") or "").strip().lower()
    if got_id != personality_id:
        raise IsolationAbort(f"put_not_observed:{personality_id}:{got_id or 'none'}")
    return {"put": put_row, "get": got}


async def _run_one_case(
    *,
    personality_id: str,
    case_id: str,
    invoke_case: Optional[Callable[..., Awaitable[Dict[str, Any]]]],
    timeout_s: float,
) -> Dict[str, Any]:
    async def _go() -> Dict[str, Any]:
        if invoke_case is not None:
            return await invoke_case(personality_id=personality_id, case_id=case_id)
        return await run_isolated_personality_eval(
            case_id=case_id,
            personality_id=personality_id,
            require_live_seams=True,
            serving_preflight=True,
        )

    return await asyncio.wait_for(_go(), timeout=timeout_s)


async def execute_live_matrix(
    *,
    transport: Any,
    invoke_case: Optional[Callable[..., Awaitable[Dict[str, Any]]]] = None,
    timeout_s: float = TURN_TIMEOUT_S,
    planned: Optional[List[Dict[str, str]]] = None,
) -> Dict[str, Any]:
    """Canonical matrix owner. Tests must call this, not a copied runner."""
    turns_plan = planned or planned_turns()
    receipt: Dict[str, Any] = {
        "turns": [],
        "restoration": None,
        "incomplete": False,
        "ok": False,
        "errors": [],
        "style_comparison": None,
        "transport_label": getattr(transport, "label", None),
    }
    snapshot = snapshot_setting(transport)
    original_id = snapshot["personality_id"]
    original_source = snapshot.get("source")
    if hasattr(transport, "state") and isinstance(getattr(transport, "state"), dict):
        transport.state["_original"] = original_id
    restored = False
    try:
        for step in turns_plan:
            pid = step["personality_id"]
            case_id = step["case_id"]
            if case_id not in ALLOWED_CASE_IDS:
                receipt["errors"].append({"error": "case_id_not_allowlisted", "case_id": case_id})
                receipt["incomplete"] = True
                break
            try:
                put_and_verify(transport, pid)
                row = await _run_one_case(
                    personality_id=pid,
                    case_id=case_id,
                    invoke_case=invoke_case,
                    timeout_s=timeout_s,
                )
            except asyncio.TimeoutError:
                receipt["errors"].append({"case_id": case_id, "personality_id": pid, "error": "turn_timeout"})
                receipt["incomplete"] = True
                break
            except IsolationAbort as exc:
                receipt["errors"].append({"case_id": case_id, "personality_id": pid, "error": exc.reason})
                receipt["incomplete"] = True
                break
            if not row.get("ok"):
                receipt["errors"].append({"case_id": case_id, "personality_id": pid, "error": "case_failed"})
            receipt["turns"].append(sanitize_receipt(row))
        if len(receipt["turns"]) != len(turns_plan):
            receipt["incomplete"] = True
        else:
            receipt["style_comparison"] = compare_pack_styles(receipt["turns"])
            if not any(not t.get("ok") for t in receipt["turns"]) and receipt["style_comparison"].get("ok"):
                receipt["ok"] = True
            else:
                receipt["errors"].append({"error": "matrix_case_failed"})
    except IsolationAbort as exc:
        receipt["incomplete"] = True
        receipt["ok"] = False
        receipt["errors"].append({"error": exc.reason})
    except Exception as exc:
        receipt["incomplete"] = True
        receipt["ok"] = False
        receipt["errors"].append({"error": type(exc).__name__})
    finally:
        try:
            put_and_verify(transport, original_id)
            verify = transport.get_personality()
            restored = str(verify.get("personality_id") or "").strip().lower() == original_id
            receipt["restoration"] = {
                "ok": restored,
                "original_personality_id": original_id,
                "original_source": original_source,
                "restored_personality_id": verify.get("personality_id"),
                "restored_source": verify.get("source"),
                "independent_get": True,
                "qualification": (
                    "Existing Sunset personality restore uses PUT of the original id. "
                    "PUT cannot delete the setting; restore of sunny leaves source=stored "
                    f"even when original source was {original_source}."
                ),
            }
        except Exception as restore_exc:
            receipt["restoration"] = {
                "ok": False,
                "original_personality_id": original_id,
                "error": getattr(restore_exc, "reason", None) or type(restore_exc).__name__,
                "independent_get": False,
            }
            restored = False
        if not restored:
            receipt["ok"] = False
            receipt["incomplete"] = True
    return receipt


def parse_args(argv: List[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Bounded Luna Personality live-model proof (Sunset staging)")
    p.add_argument("--execute-live", action="store_true", help="Actually run the isolated matrix (requires env)")
    p.add_argument("--json", action="store_true", help="Print JSON receipt")
    return p.parse_args(argv)


def _deny_network() -> None:
    def _blocked(*_a, **_k):
        raise IsolationAbort("network_denied")

    import urllib.request

    urllib.request.urlopen = _blocked  # type: ignore[method-assign]


def main(
    argv: List[str] | None = None,
    *,
    transport: Any = None,
    invoke_case: Optional[Callable[..., Awaitable[Dict[str, Any]]]] = None,
    deny_network: bool = False,
) -> int:
    args = parse_args(argv)
    if deny_network:
        _deny_network()
    labeled_double = transport is not None and getattr(transport, "label", "") == "offline_staff_transport_double"
    receipt: Dict[str, Any] = {
        "job": "LUNA-PERSONALITY-001-live-proof",
        "started": _now(),
        "execute_live": False,
        "preflight": serving_preflight(transport=transport),
        "planned_turns": planned_turns(),
        "corpus_cases": [c["id"] for c in load_corpus().get("cases") or []],
        "turns": [],
        "restoration": None,
        "qualification": (
            "Existing Sunset personality is stored sunny, not missing/default. "
            "PUT cannot delete the setting; restore of sunny leaves source=stored."
        ),
    }
    live_env = (os.getenv("LUNA_PERSONALITY_LIVE_PROOF") or "").strip()
    if not args.execute_live:
        receipt["mode"] = "dry-run"
        receipt["finished"] = _now()
        print(json.dumps(receipt, indent=2, ensure_ascii=False))
        return 0 if receipt["preflight"]["ok"] or os.getenv("HERMES_ROLE") != "sunset-luna" else 1

    if live_env != "SUNSET_STAGING_ONLY":
        receipt["error"] = "execute_live_requires_LUNA_PERSONALITY_LIVE_PROOF=SUNSET_STAGING_ONLY"
        print(json.dumps(receipt, indent=2, ensure_ascii=False), file=sys.stderr)
        return 2

    if not receipt["preflight"]["ok"] and not labeled_double:
        receipt["error"] = "serving_preflight_failed"
        print(json.dumps(receipt, indent=2, ensure_ascii=False), file=sys.stderr)
        return 3

    if transport is None:
        try:
            origin = parse_exact_staff_origin(os.getenv("WOLFHOUSE_STAFF_API_BASE_URL") or "")
            cookie = (os.getenv("LUNA_PERSONALITY_STAFF_COOKIE") or "").strip()
            transport = StaffSessionTransport(origin, cookie)
        except IsolationAbort as exc:
            receipt["error"] = exc.reason
            receipt["mode"] = "execute-live"
            receipt["finished"] = _now()
            print(json.dumps(receipt, indent=2, ensure_ascii=False), file=sys.stderr)
            return 4

    receipt["execute_live"] = True
    receipt["mode"] = "execute-live"
    receipt["transport_label"] = getattr(transport, "label", None)
    if labeled_double:
        receipt["live_acceptance"] = False
        receipt["note"] = "offline_staff_transport_double is a test double, never live acceptance"
    try:
        matrix = asyncio.run(
            execute_live_matrix(
                transport=transport,
                invoke_case=invoke_case,
                timeout_s=TURN_TIMEOUT_S,
                planned=planned_turns(),
            )
        )
        receipt.update({k: matrix.get(k) for k in ("turns", "restoration", "ok", "errors", "style_comparison", "incomplete")})
    except IsolationAbort as exc:
        receipt["ok"] = False
        receipt["error"] = exc.reason
        receipt["incomplete"] = True
    except Exception as exc:
        receipt["ok"] = False
        receipt["error"] = type(exc).__name__
        receipt["incomplete"] = True

    receipt["finished"] = _now()
    turns = receipt.get("turns") or []
    restoration = receipt.get("restoration")
    complete = (
        bool(receipt.get("ok"))
        and len(turns) == len(receipt["planned_turns"])
        and isinstance(restoration, dict)
        and restoration.get("ok") is True
        and not receipt.get("incomplete")
    )
    if not complete:
        receipt["ok"] = False
        print(json.dumps(receipt, indent=2, ensure_ascii=False), file=sys.stderr)
        return 5
    print(json.dumps(receipt, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
