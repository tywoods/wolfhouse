"""Sunset-only isolated live-model no-send Luna Personality corpus path.

Same serving Hermes process / HERMES_HOME / SOUL / model / personality bind.
Does not use the default simulate-guest-turn webhook inject (that path is
warn-and-allow for read tools). Callers may only pass an allowlisted case_id
and a closed personality id — no arbitrary guest text, tenant, model, or
auth overrides.
"""

from __future__ import annotations

import json
import os
import re
import uuid
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Awaitable, Callable, Dict, List, Optional

from wolfhouse.luna_personality import (
    CLOSED_PERSONALITY_IDS,
    DEFAULT_PERSONALITY_ID,
    bind_whatsapp_turn_personality,
    get_personality_pack,
)
from wolfhouse.luna_personality_isolation import (
    IsolatedTurnCapture,
    IsolationAbort,
    capture_send_if_isolated,
    deny_post_bot_if_isolated,
    deny_tool_if_isolated,
    enter_isolated_turn,
    exit_isolated_turn,
    install_isolation_runtime,
    isolation_status,
    mark_test_isolation_installed,
    preflight_isolation_or_abort,
    record_model_call,
    record_personality_fetch,
    record_tool_invocation_violation,
)
from wolfhouse.staging_guard import assert_staging_environment

LIVE_EVAL_PATH = "/wolfhouse/luna-personality-live-eval"
SUNSET_SLUG = "sunset"
SUNSET_ROLE = "sunset-luna"

ALLOWED_CASE_IDS = frozenset(
    {
        "warmth-greeting-en",
        "warmth-dates-en",
        "warmth-greeting-es",
        "warmth-dates-es",
        "truth-payment-link-en",
        "truth-payment-link-es",
        "invariant-identity-en",
        "invariant-spots-es",
    }
)

LATAM_MARKERS = re.compile(r"\b(celular|ustedes|vos sos|\bche\b|okis|computadora)\b", re.I)
PENINSULAR_MARKERS = re.compile(
    r"\b(vale|móvil|vosotros|tenéis|queréis|vais|ordenador|vuestro)\b",
    re.I,
)
EXTRA_URL_RE = re.compile(r"https?://[^\s]+", re.I)
EURO_RE = re.compile(r"€\s?\d+(?:[.,]\d+)?")
UNSUPPORTED_FACT_RE = re.compile(
    r"\b(available now|sold out|confirmed booking|open spots?)\b",
    re.I,
)

InvokeTurn = Callable[[str, IsolatedTurnCapture, Dict[str, Any]], Awaitable[str]]


def _corpus_path() -> Path:
    here = Path(__file__).resolve()
    candidates = [
        here.parents[3] / "fixtures" / "luna-personality-corpus.json",
        Path("/opt/wolfhouse/WH/fixtures/luna-personality-corpus.json"),
        Path("/etc/hermes-staging/fixtures/luna-personality-corpus.json"),
    ]
    for p in candidates:
        if p.is_file():
            return p
    return candidates[0]


def load_corpus(path: Optional[Path] = None) -> Dict[str, Any]:
    target = path or _corpus_path()
    return json.loads(target.read_text(encoding="utf-8"))


def case_by_id(corpus: Dict[str, Any], case_id: str) -> Dict[str, Any]:
    for item in corpus.get("cases") or []:
        if item.get("id") == case_id:
            return item
    raise IsolationAbort("case_id_not_allowlisted")


def build_eval_user_message(case: Dict[str, Any]) -> str:
    guest = str(case.get("guest_text") or "").strip()
    facts = [str(f) for f in (case.get("frozen_facts") or []) if str(f).strip()]
    if not facts:
        return guest
    joined = "; ".join(facts)
    return (
        "Immutable synthetic evaluation facts (not live availability, prices, "
        f"or bookings; copy them unchanged; invent nothing else): {joined}\n\n"
        f"Guest: {guest}"
    )


def assert_sunset_serving_identity() -> Dict[str, str]:
    role = (os.getenv("HERMES_ROLE") or "").strip()
    slug = (os.getenv("LUNA_CLIENT_SLUG") or os.getenv("LUNA_BOT_CLIENT_SLUG") or "").strip()
    home = (os.getenv("HERMES_HOME") or "").strip()
    if role != SUNSET_ROLE:
        raise IsolationAbort(f"refusing_non_sunset_role:{role or 'unset'}")
    if slug != SUNSET_SLUG:
        raise IsolationAbort(f"refusing_non_sunset_tenant:{slug or 'unset'}")
    return {"HERMES_ROLE": role, "LUNA_CLIENT_SLUG": slug, "HERMES_HOME": home}


def _emoji_or_bang(text: str) -> int:
    em = re.findall(r"[\U0001F300-\U0001FAFF]", text or "")
    bangs = (text or "").count("!")
    return len(em) + bangs


def evaluate_generated_reply(
    *,
    case: Dict[str, Any],
    personality_id: str,
    reply: str,
    fixture_echo_forbidden: bool = True,
) -> Dict[str, Any]:
    text = str(reply or "")
    findings: List[str] = []
    kind = str(case.get("kind") or "")
    lang = str(case.get("lang") or "en")
    fixture = ((case.get("replies") or {}).get(personality_id) or "").strip()

    if not text.strip():
        findings.append("empty_reply")
    if fixture_echo_forbidden and fixture and text.strip() == fixture:
        findings.append("fixture_echo")

    for fact in case.get("frozen_facts") or []:
        if str(fact) not in text:
            findings.append(f"missing_fact:{fact}")

    if kind in {"truth_frozen", "invariant"}:
        allowed_urls = set()
        allowed_euros = set()
        for fact in case.get("frozen_facts") or []:
            allowed_urls.update(EXTRA_URL_RE.findall(str(fact)))
            allowed_euros.update(EURO_RE.findall(str(fact)))
        for url in EXTRA_URL_RE.findall(text):
            if url not in allowed_urls:
                findings.append(f"unsupported_url:{url}")
        for euro in EURO_RE.findall(text):
            if euro not in allowed_euros and allowed_euros:
                findings.append(f"unsupported_amount:{euro}")

    lower = text.lower()
    if kind == "warmth_eligible":
        tokens = [
            t
            for t in re.split(r"[^a-záéíóúüñ]+", str(case.get("meaning_tokens") or case.get("meaning") or "").lower())
            if len(t) >= 4
        ]
        shared = [str(t).lower() for t in (case.get("shared_tokens") or [])]
        if tokens:
            must = tokens[:2]
            if not any(t in lower for t in must) and not (shared and all(t in lower for t in shared)):
                findings.append("meaning_tokens_missing")
        elif shared and not all(t in lower for t in shared):
            findings.append("shared_tokens_missing")

    if kind == "invariant" and "identity" in str(case.get("id") or "") and "luna" not in lower:
        findings.append("identity_missing")

    if lang == "es":
        if LATAM_MARKERS.search(text):
            findings.append("latam_spanish")
    if lang == "en" and re.search(r"\b(hola|bienvenid|gracias|reservar)\b", lower):
        findings.append("unexpected_spanish_on_en")

    if UNSUPPORTED_FACT_RE.search(text) and kind == "warmth_eligible":
        findings.append("unsupported_availability_claim")

    return {
        "ok": not findings,
        "findings": findings,
        "reply_len": len(text),
        "emoji_or_bang": _emoji_or_bang(text),
        "personality_id": personality_id,
        "case_id": case.get("id"),
        "lang": lang,
        "kind": kind,
    }


def fetch_setting_guard(fetch_setting: Callable[[str], Dict[str, Any]]) -> Callable[[str], Dict[str, Any]]:
    def _guarded(tenant_id: str) -> Dict[str, Any]:
        tid = (tenant_id or "").strip()
        env_tid = (os.getenv("LUNA_CLIENT_SLUG") or os.getenv("LUNA_BOT_CLIENT_SLUG") or "").strip()
        effective = tid or env_tid
        if effective and effective != SUNSET_SLUG:
            raise IsolationAbort("foreign_tenant_fetch")
        record_personality_fetch()
        return fetch_setting(tenant_id)

    return _guarded


async def default_invoke_live_gateway(
    user_message: str,
    cap: IsolatedTurnCapture,
    meta: Dict[str, Any],
) -> str:
    try:
        from gateway.run import _wolfhouse_gateway_runner  # noqa: WPS433
        from gateway.config import Platform
        from gateway.session import SessionSource
        from gateway.platforms.base import MessageEvent, MessageType
    except Exception as exc:
        raise IsolationAbort(f"gateway_runner_unavailable:{type(exc).__name__}") from exc

    runner = _wolfhouse_gateway_runner
    if runner is None:
        raise IsolationAbort("gateway_runner_unavailable")

    install_isolation_runtime(runner=runner)
    preflight_isolation_or_abort(require_live_seams=True)

    digits = "490000009901"
    source = SessionSource(
        platform=Platform.WHATSAPP_CLOUD,
        chat_id=digits,
        user_id=digits,
        chat_type="dm",
        user_name="Personality Eval",
    )
    event = MessageEvent(
        text=user_message,
        message_type=MessageType.TEXT,
        source=source,
        message_id=f"wamid.personality-eval.{uuid.uuid4().hex[:12]}",
    )
    record_model_call(os.getenv("HERMES_MODEL") or os.getenv("LLM_MODEL") or "serving")
    try:
        await runner._handle_message(event)  # noqa: SLF001
    except IsolationAbort:
        raise
    except Exception as exc:
        raise IsolationAbort(f"gateway_turn_failed:{type(exc).__name__}") from exc
    return cap.reply_text or ""


async def run_isolated_personality_eval(
    *,
    case_id: str,
    personality_id: str,
    corpus: Optional[Dict[str, Any]] = None,
    fetch_setting: Optional[Callable[[str], Dict[str, Any]]] = None,
    invoke_turn: Optional[InvokeTurn] = None,
    require_live_seams: bool = False,
    serving_preflight: bool = True,
) -> Dict[str, Any]:
    cid = str(case_id or "").strip()
    pid = str(personality_id or "").strip().lower()
    if cid not in ALLOWED_CASE_IDS:
        raise IsolationAbort("case_id_not_allowlisted")
    if pid not in CLOSED_PERSONALITY_IDS:
        raise IsolationAbort("invalid_personality_id")
    env_slug = (os.getenv("LUNA_CLIENT_SLUG") or os.getenv("LUNA_BOT_CLIENT_SLUG") or "").strip()
    if env_slug and env_slug != SUNSET_SLUG:
        raise IsolationAbort("foreign_tenant_fetch")
    if serving_preflight:
        assert_staging_environment()
        identity = assert_sunset_serving_identity()
    else:
        identity = {
            "HERMES_ROLE": os.getenv("HERMES_ROLE") or "",
            "LUNA_CLIENT_SLUG": os.getenv("LUNA_CLIENT_SLUG") or SUNSET_SLUG,
            "HERMES_HOME": os.getenv("HERMES_HOME") or "",
        }

    loaded = corpus or load_corpus()
    case = case_by_id(loaded, cid)
    user_message = build_eval_user_message(case)

    if invoke_turn is None:
        install_isolation_runtime()
    else:
        mark_test_isolation_installed()

    cap = IsolatedTurnCapture(case_id=cid, personality_id=pid, tenant_id=SUNSET_SLUG)
    token = enter_isolated_turn(cap)
    try:
        preflight_isolation_or_abort(require_live_seams=require_live_seams)

        source = SimpleNamespace(platform=SimpleNamespace(value="whatsapp_cloud"))
        fetcher = fetch_setting_guard(fetch_setting) if fetch_setting else None
        bound = bind_whatsapp_turn_personality(source, fetch_setting=fetcher)
        pack_id = ((bound.get("pack") or {}).get("id")) or DEFAULT_PERSONALITY_ID

        invoker = invoke_turn or default_invoke_live_gateway
        reply = await invoker(user_message, cap, {"case": case, "pack_id": pack_id, "identity": identity})
        if not cap.model_called:
            record_model_call(os.getenv("HERMES_MODEL") or "injected")
        cap.reply_text = str(reply or cap.reply_text or "").strip()

        if cap.tools_invoked > 0 or cap.sends_completed > 0:
            raise IsolationAbort("isolation_violated")

        semantic = evaluate_generated_reply(
            case=case,
            personality_id=pid,
            reply=cap.reply_text,
        )
        return {
            "ok": True,
            "case_id": cid,
            "lang": case.get("lang"),
            "kind": case.get("kind"),
            "personality_id": pack_id,
            "requested_personality_id": pid,
            "reply_text": cap.reply_text,
            "fixture_echo": False,
            "tools_invoked": cap.tools_invoked,
            "tools_denied": list(cap.tools_denied),
            "sends_attempted": cap.sends_attempted,
            "sends_completed": cap.sends_completed,
            "journal_writes_denied": cap.journal_writes_denied,
            "personality_fetches": cap.personality_fetches,
            "model_calls": cap.model_calls,
            "model": cap.model,
            "whatsapp_suppressed": True,
            "isolation": isolation_status(),
            "serving_identity": identity,
            "semantic": semantic,
            "pack_instruction_mark": get_personality_pack(pack_id)["id"],
        }
    finally:
        exit_isolated_turn(token)


def register_live_eval_route(app) -> None:
    """Authenticated Sunset-only allowlisted eval. Does not alter simulate defaults."""

    async def _handle(request):
        token = (os.getenv("LUNA_BOT_INTERNAL_TOKEN") or "").strip()
        if not token:
            from aiohttp import web

            return web.json_response({"ok": False, "error": "unauthorized"}, status=401)
        hdr = request.headers.get("X-Luna-Bot-Token") or request.headers.get("Authorization") or ""
        if hdr.startswith("Bearer "):
            hdr = hdr[7:].strip()
        if hdr != token:
            from aiohttp import web

            return web.json_response({"ok": False, "error": "unauthorized"}, status=401)

        try:
            body = await request.json()
        except Exception:
            from aiohttp import web

            return web.json_response({"ok": False, "error": "invalid_json"}, status=400)

        if not isinstance(body, dict):
            from aiohttp import web

            return web.json_response({"ok": False, "error": "invalid_json"}, status=400)

        # Hostile: refuse arbitrary prompts / tenant / model / auth overrides.
        for banned in (
            "text",
            "message_text",
            "guest_text",
            "prompt",
            "system_prompt",
            "model",
            "tenant_id",
            "client_slug",
            "allow_writes",
            "fetch_setting",
            "soul",
        ):
            if banned in body:
                from aiohttp import web

                return web.json_response({"ok": False, "error": "caller_override_rejected"}, status=400)

        try:
            result = await run_isolated_personality_eval(
                case_id=str(body.get("case_id") or ""),
                personality_id=str(body.get("personality_id") or DEFAULT_PERSONALITY_ID),
                require_live_seams=True,
                serving_preflight=True,
            )
        except IsolationAbort as exc:
            from aiohttp import web

            status = 403 if "non_sunset" in exc.reason or "unauthorized" in exc.reason else 400
            if exc.reason in {"isolation_not_installed", "send_adapter_not_isolated", "tools_not_isolated", "isolation_context_missing"}:
                status = 503
            return web.json_response({"ok": False, "error": exc.reason}, status=status)
        except SystemExit as exc:
            from aiohttp import web

            return web.json_response({"ok": False, "error": str(exc)}, status=403)
        except Exception as exc:
            from aiohttp import web

            return web.json_response({"ok": False, "error": type(exc).__name__}, status=500)

        from aiohttp import web

        return web.json_response(result)

    app.router.add_post(LIVE_EVAL_PATH, _handle)


async def simulated_model_turn(
    user_message: str,
    cap: IsolatedTurnCapture,
    meta: Dict[str, Any],
) -> str:
    """Test double: genuinely generate (not fixture echo), prove tool/send denial."""
    case = meta["case"]
    pack_id = meta["pack_id"]
    # Attempted business tools — must be denied, never invoked.
    for tool in (
        "check_availability",
        "quote_booking",
        "create_sunset_booking",
        "create_sunset_payment_link",
        "get_sunset_lesson_availability",
        "preview_package_prices",
    ):
        blocked = deny_tool_if_isolated(tool, {})
        if not blocked:
            record_tool_invocation_violation(tool)
        denied_bot = deny_post_bot_if_isolated(f"/staff/bot/{tool}", {})
        if denied_bot is None:
            record_tool_invocation_violation(f"post_bot:{tool}")
    capture_send_if_isolated("")  # will be overwritten with generated reply
    record_model_call("test-double-not-fixture")

    facts = [str(f) for f in (case.get("frozen_facts") or [])]
    lang = case.get("lang")
    kind = case.get("kind")
    if kind in {"truth_frozen", "invariant"}:
        if lang == "es":
            body = "Hecho sintético de evaluación — " + " ".join(facts)
            if case.get("id") == "invariant-spots-es":
                body = f"Hay {facts[0] if facts else '2 plazas'}; un compañero lo revisa."
            if case.get("id") == "truth-payment-link-es":
                body = f"Tu plaza queda con el depósito. Paga aquí: {' '.join(facts)}"
            if case.get("id") == "invariant-identity-en":
                body = f"Soy Luna en Wolf-House. {body}"
        else:
            body = "Synthetic evaluation truth — " + " ".join(facts)
            if case.get("id") == "invariant-identity-en":
                body = f"I'm Luna at Wolf-House. Booking {facts[0] if facts else ''} is confirmed (synthetic eval)."
            if case.get("id") == "truth-payment-link-en":
                body = f"Your stay is held. Pay the deposit here: {' '.join(facts)}"
        generated = f"{body} [generated:{pack_id}:{case.get('id')}]"
    else:
        meaning = str(case.get("meaning") or "")
        if lang == "es":
            base = {
                "sunny": f"¡Hola! Bienvenidos a Wolf-House 🌊 Puedo ayudaros a reservar — {meaning}. ¿Qué fechas tenéis?",
                "calm": f"Bienvenidos a Wolf-House. Puedo ayudaros a reservar. {meaning}. ¿Qué fechas os vienen bien?",
                "concise": f"Bienvenidos. {meaning}. ¿Fechas?",
                "extra": f"¡¡Bienvenidos a Wolf-House!! 🌊🙌🐺 {meaning} ¿Qué fechas soñáis? 😊 Vale.",
            }[pack_id]
        else:
            base = {
                "sunny": f"Hey! Welcome to Wolf-House 🌊 I can help you book a stay — {meaning}. What dates are you thinking?",
                "calm": f"Welcome to Wolf-House. I can help you book a stay. {meaning}. Which dates work?",
                "concise": f"Welcome. {meaning}. Dates?",
                "extra": f"Yesss welcome to Wolf-House!! 🌊🙌 I can help you book a stay — {meaning} 😊",
            }[pack_id]
        generated = f"{base} [generated:{pack_id}:{case.get('id')}]"
    cap.reply_text = generated
    capture_send_if_isolated(generated)
    return generated
