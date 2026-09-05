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

from wolfhouse.luna_personality import CLOSED_PERSONALITY_IDS, parse_exact_staff_origin
from wolfhouse.luna_personality_isolation import IsolationAbort
from wolfhouse.luna_personality_live_eval import (
    ALLOWED_CASE_IDS,
    LIVE_EVAL_PATH,
    compare_pack_styles,
    load_corpus,
)

WARMTH_CASES = ("warmth-greeting-en", "warmth-dates-en", "warmth-greeting-es", "warmth-dates-es")
TRUTH_CASES = ("truth-payment-link-en", "truth-payment-link-es", "invariant-identity-en", "invariant-spots-es")
TURN_TIMEOUT_S = 45.0
MATRIX_CONCURRENCY = 1
STAFF_GET_PATH = "/staff/luna-personality"
STAFF_PUT_PATH = "/staff/luna-personality"
ALLOWED_EVAL_ORIGINS = frozenset({"https://lunabox.lunafrontdesk.com"})
EVAL_HTTP_TIMEOUT_S = 45.0


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _redact(value: Any) -> str:
    text = str(value or "")
    if not text:
        return ""
    return f"<redacted:{len(text)}b>"


def parse_exact_eval_url(url: str) -> str:
    """Exact serving eval URL. Separate-process runner must not invent a second gateway."""
    raw = str(url or "").strip()
    parsed = urlparse(raw)
    if parsed.scheme != "https":
        raise IsolationAbort("eval_origin_not_https")
    if parsed.username or parsed.password:
        raise IsolationAbort("eval_origin_userinfo_forbidden")
    host = (parsed.hostname or "").lower()
    if parsed.port:
        raise IsolationAbort("eval_origin_port_forbidden")
    origin = f"{parsed.scheme}://{host}"
    if origin not in ALLOWED_EVAL_ORIGINS:
        raise IsolationAbort(f"eval_origin_not_allowlisted:{host or 'empty'}")
    path = parsed.path or ""
    if path in ("", "/"):
        path = LIVE_EVAL_PATH
    if path != LIVE_EVAL_PATH:
        raise IsolationAbort("eval_path_forbidden")
    if parsed.query or parsed.fragment:
        raise IsolationAbort("eval_origin_query_forbidden")
    return origin + LIVE_EVAL_PATH


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


class ServingEvalHttpTransport:
    """Authenticated HTTP to the existing serving eval route. Does not start a gateway."""

    label = "serving_eval_http_transport"

    def __init__(self, url: str, token: str, *, timeout_s: float = EVAL_HTTP_TIMEOUT_S) -> None:
        self.url = parse_exact_eval_url(url)
        self._token = str(token or "").strip()
        self.timeout_s = timeout_s
        if not self._token:
            raise IsolationAbort("eval_bot_token_missing")

    def _headers(self) -> Dict[str, str]:
        return {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "X-Luna-Bot-Token": self._token,
        }

    def _request(self, method: str, body: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        import urllib.error

        data = None if body is None else json.dumps(body).encode("utf-8")
        req = Request(self.url, data=data, method=method, headers=self._headers())
        try:
            with urlopen(req, timeout=self.timeout_s) as res:
                raw = res.read().decode("utf-8") if res else "{}"
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace") if exc.fp else "{}"
            parsed_err = json.loads(raw or "{}") if raw else {}
            if isinstance(parsed_err, dict):
                parsed_err.setdefault("http_status", exc.code)
                return parsed_err
            raise IsolationAbort(f"serving_eval_http_error:{exc.code}") from exc
        parsed = json.loads(raw or "{}")
        if not isinstance(parsed, dict):
            raise IsolationAbort("eval_http_invalid_json")
        return parsed

    def preflight(self) -> Dict[str, Any]:
        try:
            return self._request("GET")
        except IsolationAbort:
            raise
        except Exception as exc:
            raise IsolationAbort(f"serving_eval_not_ready:{type(exc).__name__}") from exc

    def post_eval(self, case_id: str, personality_id: str) -> Dict[str, Any]:
        return self._request(
            "POST",
            {"case_id": case_id, "personality_id": personality_id},
        )


class OfflineEvalHttpTransportDouble:
    """TEST DOUBLE — in-memory serving eval HTTP. Never live acceptance."""

    label = "offline_eval_http_transport_double"

    def __init__(self, *, ready: bool = True, invoke_case: Optional[Callable[..., Awaitable[Dict[str, Any]]]] = None) -> None:
        self.ready = ready
        self.invoke_case = invoke_case
        self.calls: List[Dict[str, Any]] = []
        self.ready_error = "seams_incomplete:journal_wrapped"

    def preflight(self) -> Dict[str, Any]:
        self.calls.append({"method": "GET", "path": LIVE_EVAL_PATH, "preflight_only": True})
        if not self.ready:
            return {"ok": False, "ready": False, "error": self.ready_error, "live_acceptance": False}
        return {
            "ok": True,
            "ready": True,
            "preflight_only": True,
            "live_acceptance": False,
            "consumed_model_observed": False,
            "consumed_soul_observed": False,
            "consumed_home_observed": False,
        }

    async def post_eval(self, case_id: str, personality_id: str) -> Dict[str, Any]:
        self.calls.append({"method": "POST", "path": LIVE_EVAL_PATH, "case_id": case_id, "personality_id": personality_id})
        if self.invoke_case is None:
            raise IsolationAbort("offline_eval_invoke_missing")
        return await self.invoke_case(personality_id=personality_id, case_id=case_id)


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
    eval_base = (os.getenv("LUNA_PERSONALITY_EVAL_BASE_URL") or "").strip()
    notes = [
        "Staff API LUNA_BOT_INTERNAL_TOKEN must equal Hermes LUNA_BOT_INTERNAL_TOKEN.",
        "Staff writes use operator session cookie (LUNA_PERSONALITY_STAFF_COOKIE), never bot PUT.",
        "Staff API LUNA_BOT_CLIENT_SLUG (or DEFAULT_CLIENT_SLUG) must be sunset.",
        "Do not rotate credentials in this change.",
        "Stored sunny cannot be reset to source=default via this API.",
        "Secrets are never logged.",
        "Env/file presence is not consumed model/SOUL/home observation.",
        "Separate-process runner uses authenticated exact-target HTTP; it does not import the gateway singleton.",
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

    soul_file_present = False
    if home:
        soul = os.path.join(home, "SOUL.md")
        soul_file_present = os.path.isfile(soul) and os.path.getsize(soul) > 0
    if not soul_file_present:
        soul_file_present = (
            os.path.isfile("/etc/hermes-staging/SOUL.md")
            and os.path.getsize("/etc/hermes-staging/SOUL.md") > 0
        )

    home_ok = bool(home) and os.path.normpath(home) == os.path.normpath(expected_home)
    eval_origin_ok = labeled_double
    eval_origin_error = None
    parsed_eval = None
    eval_transport_label = getattr(transport, "label", None)
    if labeled_double:
        parsed_eval = "double://offline-eval-http"
        eval_origin_ok = True
        notes.append("eval_origin_skipped_for_offline_double")
    else:
        try:
            target = eval_base or ""
            parsed_eval = parse_exact_eval_url(target) if target else None
            eval_origin_ok = bool(parsed_eval)
            if not target:
                eval_origin_error = "eval_origin_missing"
                eval_origin_ok = False
        except IsolationAbort as exc:
            eval_origin_error = exc.reason
            eval_origin_ok = False
    ok = (
        role == "sunset-luna"
        and slug == "sunset"
        and origin_ok
        and eval_origin_ok
        and token_present
        and (cookie_present or labeled_double)
        and home_ok
        and soul_file_present
        and bool(model)
    )
    return {
        "ok": ok,
        "kind": "server_owned_env_declaration_not_consumed_observation",
        "HERMES_ROLE": role,
        "LUNA_CLIENT_SLUG": slug,
        "HERMES_HOME_env": home,
        "home_env_declared": bool(home),
        "HERMES_HOME_ok": home_ok,
        "soul_file_present": soul_file_present,
        "model_env_declared": bool(model),
        "model_env_name": model or None,
        "consumed_model_observed": False,
        "consumed_soul_observed": False,
        "consumed_home_observed": False,
        "staff_origin": parsed_origin,
        "staff_origin_ok": origin_ok,
        "staff_origin_error": origin_error,
        "eval_url": parsed_eval,
        "eval_origin_ok": eval_origin_ok,
        "eval_origin_error": eval_origin_error,
        "bot_token_present": token_present,
        "staff_cookie_present": cookie_present or labeled_double,
        "staff_cookie": _redact(os.getenv("LUNA_PERSONALITY_STAFF_COOKIE")),
        "live_eval_path": LIVE_EVAL_PATH,
        "allowlisted_case_ids": sorted(ALLOWED_CASE_IDS),
        "closed_ids": list(CLOSED_PERSONALITY_IDS),
        "transport_label": eval_transport_label,
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
    eval_transport: Any,
    timeout_s: float,
) -> Dict[str, Any]:
    async def _go() -> Dict[str, Any]:
        if invoke_case is not None:
            return await invoke_case(personality_id=personality_id, case_id=case_id)
        if eval_transport is None:
            raise IsolationAbort("serving_eval_transport_missing")
        posted = eval_transport.post_eval(case_id, personality_id)
        if asyncio.iscoroutine(posted):
            posted = await posted
        if not isinstance(posted, dict):
            raise IsolationAbort("eval_http_invalid_json")
        return posted

    return await asyncio.wait_for(_go(), timeout=timeout_s)


def _independent_restore_receipt(
    *,
    transport: Any,
    original_id: str,
    original_source: Any,
    put_error: Optional[BaseException],
) -> Dict[str, Any]:
    independent = None
    independent_get = False
    independent_error = None
    try:
        independent = transport.get_personality()
        independent_get = True
    except Exception as exc:
        independent_error = getattr(exc, "reason", None) or type(exc).__name__
    effective_id = ""
    effective_source = None
    if isinstance(independent, dict):
        effective_id = str(independent.get("personality_id") or "").strip().lower()
        effective_source = independent.get("source")
    effective_restored = bool(independent_get and effective_id == original_id)
    exact_source_restored = bool(
        effective_restored and original_source is not None and effective_source == original_source
    )
    put_failed = put_error is not None
    return {
        "ok": bool(effective_restored and not put_failed),
        "effective_restored": effective_restored,
        "exact_source_restored": exact_source_restored,
        "original_personality_id": original_id,
        "original_source": original_source,
        "restored_personality_id": effective_id or None,
        "restored_source": effective_source,
        "independent_get": independent_get,
        "independent_get_attempted": True,
        "independent_get_error": independent_error,
        "put_error": (getattr(put_error, "reason", None) or type(put_error).__name__) if put_error else None,
        "ambiguous_outcome": bool(put_failed),
        "qualification": (
            "Effective restored id is not exact source restoration. "
            "Existing Sunset personality restore uses PUT of the original id. "
            "PUT cannot delete the setting; restore of sunny leaves source=stored "
            f"even when original source was {original_source}."
        ),
    }


async def execute_live_matrix(
    *,
    transport: Any,
    invoke_case: Optional[Callable[..., Awaitable[Dict[str, Any]]]] = None,
    eval_transport: Any = None,
    timeout_s: float = TURN_TIMEOUT_S,
    planned: Optional[List[Dict[str, str]]] = None,
    require_serving_preflight: Optional[bool] = None,
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
        "eval_transport_label": getattr(eval_transport, "label", None),
        "live_acceptance": False,
    }
    original_id = None
    original_source = None
    restored = False
    need_ready = require_serving_preflight
    if need_ready is None:
        need_ready = invoke_case is None
    try:
        if need_ready:
            if eval_transport is None:
                raise IsolationAbort("serving_eval_transport_missing")
            ready = eval_transport.preflight()
            if asyncio.iscoroutine(ready):
                ready = await ready
            if not isinstance(ready, dict) or not ready.get("ready"):
                err = (ready or {}).get("error") if isinstance(ready, dict) else "serving_eval_not_ready"
                raise IsolationAbort(str(err or "serving_eval_not_ready"))
        snapshot = snapshot_setting(transport)
        original_id = snapshot["personality_id"]
        original_source = snapshot.get("source")
        if hasattr(transport, "state") and isinstance(getattr(transport, "state"), dict):
            transport.state["_original"] = original_id
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
                    eval_transport=eval_transport,
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
        if original_id is None:
            receipt["restoration"] = {
                "ok": False,
                "skipped": True,
                "reason": "no_snapshot_before_settings_writes",
                "independent_get": False,
                "independent_get_attempted": False,
            }
            restored = False
        else:
            put_error = None
            try:
                put_and_verify(transport, original_id)
            except Exception as restore_exc:
                put_error = restore_exc
            receipt["restoration"] = _independent_restore_receipt(
                transport=transport,
                original_id=original_id,
                original_source=original_source,
                put_error=put_error,
            )
            restored = bool(receipt["restoration"].get("ok"))
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
    eval_transport: Any = None,
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

    if eval_transport is None and invoke_case is None:
        try:
            eval_url = os.getenv("LUNA_PERSONALITY_EVAL_BASE_URL") or ""
            token = (os.getenv("LUNA_BOT_INTERNAL_TOKEN") or "").strip()
            eval_transport = ServingEvalHttpTransport(eval_url, token)
        except IsolationAbort as exc:
            receipt["error"] = exc.reason
            receipt["mode"] = "execute-live"
            receipt["finished"] = _now()
            print(json.dumps(receipt, indent=2, ensure_ascii=False), file=sys.stderr)
            return 4

    receipt["execute_live"] = True
    receipt["mode"] = "execute-live"
    receipt["transport_label"] = getattr(transport, "label", None)
    receipt["eval_transport_label"] = getattr(eval_transport, "label", None) if eval_transport is not None else None
    receipt["live_acceptance"] = False
    if labeled_double:
        receipt["note"] = "offline_staff_transport_double is a test double, never live acceptance"
    if eval_transport is not None and getattr(eval_transport, "label", "") == "offline_eval_http_transport_double":
        receipt["note"] = "offline_eval_http_transport_double is a test double, never live acceptance"
    try:
        matrix = asyncio.run(
            execute_live_matrix(
                transport=transport,
                invoke_case=invoke_case,
                eval_transport=eval_transport,
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
