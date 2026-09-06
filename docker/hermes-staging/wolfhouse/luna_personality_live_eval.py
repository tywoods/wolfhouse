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
from typing import Any, Awaitable, Callable, Dict, List, Optional, Sequence

from wolfhouse.luna_personality import (
    CLOSED_PERSONALITY_IDS,
    COMPOSER_OWNED_STATES,
    DEFAULT_PERSONALITY_ID,
    bind_whatsapp_turn_personality,
    default_fetch_setting,
    get_personality_pack,
    inject_personality_pack_once,
    parse_exact_staff_origin,
)
from wolfhouse.luna_personality_isolation import (
    IsolatedTurnCapture,
    IsolationAbort,
    IsolationTargets,
    REQUIRED_LIVE_SEAMS,
    capture_send_if_isolated,
    deny_post_bot_if_isolated,
    deny_tool_if_isolated,
    enter_isolated_turn,
    exit_isolated_turn,
    install_isolation_runtime,
    isolation_status,
    mark_test_isolation_installed,
    observe_provider_invocation,
    preflight_isolation_or_abort,
    record_consumed_pack,
    record_personality_fetch,
    record_tool_invocation_violation,
    refuse_unverified_runtime,
    settle_isolated_work,
)
from wolfhouse.staging_guard import assert_staging_environment

# Sibling of /whatsapp/webhook and /whatsapp/v1/internal/email-draft-plan on
# hermes-sunset-luna-http (8094). Tracked Caddy /wolfhouse/* stays Wolfhouse 8090.
# Registration is Sunset-HTTP-identity gated so Wolfhouse 8090 does not serve it.
# Live Caddy /whatsapp/* correspondence is not claimed by this source binding.
LIVE_EVAL_PATH = "/whatsapp/v1/internal/luna-personality-live-eval"
SUNSET_HTTP_WEBHOOK_PORT = "8094"
SUNSET_HTTP_RUNTIME = "hermes-sunset-luna-http"
SUNSET_SLUG = "sunset"
SUNSET_ROLE = "sunset-luna"
EXPECTED_HERMES_HOME = "/opt/data/.hermes"

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
    r"\b(vale|móvil|vosotros|tenéis|queréis|vais|ordenador|vuestro|ayudaros|os vienen|os ayudo)\b",
    re.I,
)
SPANISH_EVIDENCE = re.compile(
    r"[áéíóúñ¿¡]|\b(hay|plaza|plazas|compañero|bienvenid\w*|reserva\w*|tenéis|queréis|"
    r"vale|móvil|entrada|salida|depósito|paga|aquí|os |tu plaza|fechas)\b",
    re.I,
)
EXTRA_URL_RE = re.compile(r"https?://[^\s]+", re.I)
AMOUNT_RE = re.compile(
    r"(?:€\s?\d+(?:[.,]\d+)?|\d+(?:[.,]\d+)?\s*(?:€|euros?|eur)\b)",
    re.I,
)
UNSUPPORTED_FACT_RE = re.compile(
    r"\b(available now|sold out|open spots?|free flights?|we charge)\b",
    re.I,
)
MEANING_NEGATION_RE = re.compile(
    r"\b(do not book|don't book|dont book|no reserve|no reserv(?:e|ar))\b",
    re.I,
)

InvokeTurn = Callable[[str, IsolatedTurnCapture, Dict[str, Any]], Awaitable[str]]

CORPUS_FILENAME = "luna-personality-corpus.json"
# Image install path. docker/hermes-staging is the ACR/VM build context, so the
# Dockerfile copies docker/hermes-staging/fixtures/<name> here. Do not broaden
# that context to the repo root.
INSTALLED_CORPUS_PATH = Path("/etc/hermes-staging/fixtures") / CORPUS_FILENAME
REPO_MOUNT_CORPUS_PATH = Path("/opt/wolfhouse/WH/fixtures") / CORPUS_FILENAME


def corpus_candidates(*, here: Optional[Path] = None) -> List[Path]:
    """Resolve the allowlisted corpus without duplicating the matrix.

    Order:
    1. Staging-root relative to this module (source checkout and image).
    2. Repo-root fixtures/ when the module lives at docker/hermes-staging/wolfhouse.
    3. Optional Lunabox repo mount (absent in hermes-sunset-luna-http).
    4. Hardcoded image install path.
    """
    module = (here or Path(__file__)).resolve()
    candidates: List[Path] = []
    if len(module.parents) > 1:
        candidates.append(module.parents[1] / "fixtures" / CORPUS_FILENAME)
    if len(module.parents) > 3:
        candidates.append(module.parents[3] / "fixtures" / CORPUS_FILENAME)
    candidates.append(REPO_MOUNT_CORPUS_PATH)
    candidates.append(INSTALLED_CORPUS_PATH)
    seen = set()
    unique: List[Path] = []
    for path in candidates:
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        unique.append(path)
    return unique


def _corpus_path(*, here: Optional[Path] = None) -> Path:
    candidates = corpus_candidates(here=here)
    for path in candidates:
        if path.is_file():
            return path
    return candidates[0]


def load_corpus(path: Optional[Path] = None, *, here: Optional[Path] = None) -> Dict[str, Any]:
    target = path or _corpus_path(here=here)
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


def server_owned_serving_identity(*, require_home: bool = False, require_staff_origin: bool = False) -> Dict[str, Any]:
    """Server-owned env/file declarations. Not consumed model/SOUL/home observations."""
    role = (os.getenv("HERMES_ROLE") or "").strip()
    slug = (os.getenv("LUNA_CLIENT_SLUG") or os.getenv("LUNA_BOT_CLIENT_SLUG") or "").strip()
    home = (os.getenv("HERMES_HOME") or "").strip()
    expected_home = (os.getenv("LUNA_PERSONALITY_EXPECTED_HERMES_HOME") or EXPECTED_HERMES_HOME).strip()
    model_env = (os.getenv("HERMES_MODEL") or os.getenv("LLM_MODEL") or "").strip()
    if role != SUNSET_ROLE:
        raise IsolationAbort(f"refusing_non_sunset_role:{role or 'unset'}")
    if slug != SUNSET_SLUG:
        raise IsolationAbort(f"refusing_non_sunset_tenant:{slug or 'unset'}")
    home_env_matches = bool(home) and os.path.normpath(home) == os.path.normpath(expected_home)
    soul_file_present = False
    if home:
        soul = Path(home) / "SOUL.md"
        soul_file_present = soul.is_file() and bool(soul.read_text(encoding="utf-8").strip())
    if not soul_file_present:
        alt = Path("/etc/hermes-staging/SOUL.md")
        soul_file_present = alt.is_file() and bool(alt.read_text(encoding="utf-8").strip())
    if require_home:
        if not home:
            raise IsolationAbort("hermes_home_missing")
        if not home_env_matches:
            raise IsolationAbort("hermes_home_mismatch")
        if not soul_file_present:
            raise IsolationAbort("soul_file_missing")
    staff_origin = None
    staff_origin_ok = False
    staff_origin_error = None
    base = (os.getenv("WOLFHOUSE_STAFF_API_BASE_URL") or "").rstrip("/")
    try:
        staff_origin = parse_exact_staff_origin(base) if base else None
        staff_origin_ok = bool(staff_origin)
    except IsolationAbort as exc:
        staff_origin_error = exc.reason
        staff_origin_ok = False
    if require_staff_origin and not staff_origin_ok:
        raise IsolationAbort(staff_origin_error or "staff_origin_not_allowlisted:empty")
    return {
        "kind": "server_owned_env_declaration_not_consumed_observation",
        "HERMES_ROLE": role,
        "LUNA_CLIENT_SLUG": slug,
        "HERMES_HOME_env": home,
        "home_env_declared": bool(home),
        "home_env_matches_expected": home_env_matches,
        "soul_file_present": soul_file_present,
        "model_env_declared": bool(model_env),
        "model_env_name": model_env or None,
        "consumed_model_observed": False,
        "consumed_soul_observed": False,
        "consumed_home_observed": False,
        "staff_origin_enforced": staff_origin,
        "staff_origin_ok": staff_origin_ok,
        "staff_origin_error": staff_origin_error,
    }


def assert_sunset_serving_identity(*, require_home: bool = False, require_staff_origin: bool = False) -> Dict[str, Any]:
    return server_owned_serving_identity(require_home=require_home, require_staff_origin=require_staff_origin)


def extract_final_handler_text(result: Any) -> str:
    """Canonical FINAL text returned by GatewayRunner._handle_message. Not send capture."""
    if result is None:
        return ""
    if isinstance(result, str):
        return result.strip()
    if isinstance(result, dict):
        for key in ("final_response", "response", "text"):
            val = result.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()
        return ""
    return str(result).strip()


def _emoji_or_bang(text: str) -> int:
    em = re.findall(r"[\U0001F300-\U0001FAFF]", text or "")
    bangs = (text or "").count("!")
    return len(em) + bangs


def _normalize_amount(token: str) -> str:
    raw = str(token or "").lower()
    raw = raw.replace("euros", "").replace("euro", "").replace("eur", "").replace("€", "")
    raw = raw.replace(",", ".").strip()
    try:
        return f"{float(raw):.2f}"
    except Exception:
        return raw


def _fact_contradicted(text: str, fact: str) -> bool:
    escaped = re.escape(str(fact))
    patterns = (
        rf"\bnot\s+{escaped}",
        rf"\bthere are not\s+{escaped}",
        rf"\bno hay\s+{escaped}",
        rf"\bno\s+{escaped}",
        rf"{escaped}\s+is not",
        rf"aren't\s+{escaped}",
        rf"isn't\s+{escaped}",
    )
    return any(re.search(p, text, re.I) for p in patterns)


def _positive_token(text: str, tok: str) -> bool:
    token = str(tok or "").strip().lower()
    if not token:
        return True
    lowered = text.lower()
    if token in {"book", "reserva", "reservar"}:
        if MEANING_NEGATION_RE.search(lowered):
            return False
    if token.startswith("bienvenid") or token.startswith("reserva") or token == "welcome":
        return bool(re.search(rf"\b{re.escape(token)}", lowered))
    if "-" in token or " " in token:
        return token in lowered
    return bool(re.search(rf"\b{re.escape(token)}\b", lowered))


def evaluate_generated_reply(
    *,
    case: Dict[str, Any],
    personality_id: str,
    reply: str,
    fixture_echo_forbidden: bool = True,
) -> Dict[str, Any]:
    """Deterministic checks. Not complete semantic proof of live model quality."""
    text = str(reply or "")
    findings: List[str] = []
    kind = str(case.get("kind") or "")
    lang = str(case.get("lang") or "en")
    fixture = ((case.get("replies") or {}).get(personality_id) or "").strip()
    frozen = [str(f) for f in (case.get("frozen_facts") or []) if str(f).strip()]
    composer_state = str(case.get("composer_state") or "")

    if not text.strip():
        findings.append("empty_reply")
    fixture_echo = bool(fixture and text.strip() == fixture)
    if fixture_echo_forbidden and fixture_echo:
        findings.append("fixture_echo")

    for fact in frozen:
        if fact not in text:
            findings.append(f"missing_fact:{fact}")
        if _fact_contradicted(text, fact):
            findings.append(f"contradicted_fact:{fact}")

    allowed_urls = set()
    allowed_amounts = set()
    for fact in frozen:
        allowed_urls.update(EXTRA_URL_RE.findall(str(fact)))
        allowed_amounts.update(_normalize_amount(m) for m in AMOUNT_RE.findall(str(fact)))

    for url in EXTRA_URL_RE.findall(text):
        if url not in allowed_urls:
            findings.append(f"unsupported_url:{url}")
    for amount in AMOUNT_RE.findall(text):
        norm = _normalize_amount(amount)
        if allowed_amounts:
            if norm not in allowed_amounts:
                findings.append(f"unsupported_amount:{amount}")
        elif kind == "warmth_eligible":
            findings.append(f"unsupported_amount:{amount}")

    if UNSUPPORTED_FACT_RE.search(text):
        findings.append("unsupported_availability_or_addition")

    lower = text.lower()
    if kind == "warmth_eligible":
        shared = [str(t).lower() for t in (case.get("shared_tokens") or [])]
        meaning_tokens = [
            t
            for t in re.split(
                r"[^a-záéíóúüñ-]+",
                str(case.get("meaning_tokens") or case.get("meaning") or "").lower(),
            )
            if len(t) >= 4
        ]
        required = shared or meaning_tokens[:2]
        for tok in required:
            if not _positive_token(text, tok):
                findings.append(f"meaning_token_missing:{tok}")
        if MEANING_NEGATION_RE.search(text):
            findings.append("required_meaning_negated")

    if kind == "invariant" and "identity" in str(case.get("id") or "") and "luna" not in lower:
        findings.append("identity_missing")

    if lang == "es":
        if LATAM_MARKERS.search(text):
            findings.append("latam_spanish")
        if not SPANISH_EVIDENCE.search(text):
            findings.append("missing_spanish_language")
        if kind == "warmth_eligible" and not PENINSULAR_MARKERS.search(text):
            findings.append("missing_peninsular_spanish")
        english_heavy = bool(
            re.search(r"\b(there are not|there are|confirmed booking|free flights|do not book)\b", lower)
        )
        if english_heavy:
            findings.append("english_on_es")
    if lang == "en" and re.search(r"\b(hola|bienvenid|gracias|reservar)\b", lower):
        findings.append("unexpected_spanish_on_en")

    if composer_state in COMPOSER_OWNED_STATES and kind in {"truth_frozen", "invariant"}:
        # Truth-frozen / composer-owned: extra cheer must not rewrite facts.
        if personality_id == "extra" and _emoji_or_bang(text) > 8:
            findings.append("truth_frozen_overstyled")

    deterministic_ok = not findings
    return {
        "ok": deterministic_ok,
        "findings": findings,
        "reply_len": len(text),
        "emoji_or_bang": _emoji_or_bang(text),
        "personality_id": personality_id,
        "case_id": case.get("id"),
        "lang": lang,
        "kind": kind,
        "fixture_echo": fixture_echo,
        "complete_semantic_proof": False,
        "assessment_kind": "deterministic_checks_not_complete_semantic_proof",
        "remaining_human_or_live_assessment": True,
    }


def _row_kind(row: Dict[str, Any]) -> str:
    return str(row.get("kind") or (row.get("semantic") or {}).get("kind") or "")


def _row_emoji(row: Dict[str, Any]) -> int:
    sem = row.get("semantic") or {}
    return int(row.get("emoji_or_bang") or sem.get("emoji_or_bang") or 0)


def _row_len(row: Dict[str, Any]) -> int:
    sem = row.get("semantic") or {}
    return int(row.get("reply_len") or sem.get("reply_len") or 0)


def compare_pack_styles(rows: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """Comparative four-pack style. Deterministic only; remaining assessment is human/live."""
    findings: List[str] = []
    by_case: Dict[str, List[Dict[str, Any]]] = {}
    for row in rows:
        by_case.setdefault(str(row.get("case_id") or ""), []).append(row)
    for case_id, group in by_case.items():
        if not case_id:
            continue
        kind = _row_kind(group[0])
        by_pack = {str(r.get("personality_id")): r for r in group}
        extra = by_pack.get("extra") or {}
        sunny = by_pack.get("sunny") or {}
        calm = by_pack.get("calm") or {}
        concise = by_pack.get("concise") or {}
        if kind == "warmth_eligible":
            if extra and concise and _row_emoji(extra) < _row_emoji(concise):
                findings.append(f"extra_not_more_expressive_than_concise:{case_id}")
            if concise and sunny and _row_len(concise) > _row_len(sunny) + 40:
                findings.append(f"concise_not_shorter_than_sunny:{case_id}")
            if extra and calm and _row_emoji(extra) < _row_emoji(calm):
                findings.append(f"extra_not_warmer_than_calm:{case_id}")
        if kind in {"truth_frozen", "invariant"}:
            facts = []
            for r in group:
                sem = r.get("semantic") or {}
                facts.append(tuple(sem.get("findings") or ()))
            if facts and any(item != facts[0] for item in facts[1:]):
                findings.append(f"truth_frozen_fact_parity_broken:{case_id}")
    return {
        "ok": not findings,
        "findings": findings,
        "complete_style_proof": False,
        "assessment_kind": "deterministic_pack_comparison_not_complete_style_proof",
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


def _ephemeral_digits() -> str:
    n = int(uuid.uuid4().hex[:10], 16) % 10**10
    return f"49{n:010d}"


async def default_invoke_live_gateway(
    user_message: str,
    cap: IsolatedTurnCapture,
    meta: Dict[str, Any],
) -> str:
    runner = meta.get("gateway_runner")
    if runner is None:
        try:
            from gateway.run import _wolfhouse_gateway_runner  # noqa: WPS433
        except Exception as exc:
            raise IsolationAbort(f"gateway_runner_unavailable:{type(exc).__name__}") from exc
        runner = _wolfhouse_gateway_runner
    if runner is None:
        raise IsolationAbort("gateway_runner_unavailable")

    targets = meta.get("isolation_targets")
    install_isolation_runtime(runner=runner, targets=targets)
    preflight_isolation_or_abort(require_live_seams=True, targets=targets, runner=runner)

    digits = cap.ephemeral_chat_id or _ephemeral_digits()
    cap.ephemeral_chat_id = digits
    try:
        from gateway.config import Platform
        from gateway.platforms.base import MessageEvent, MessageType
        from gateway.session import SessionSource

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
    except Exception as exc:
        if meta.get("gateway_runner") is None:
            raise IsolationAbort(f"gateway_types_unavailable:{type(exc).__name__}") from exc
        source = SimpleNamespace(
            platform=SimpleNamespace(value="whatsapp_cloud"),
            chat_id=digits,
            user_id=digits,
            chat_type="dm",
            user_name="Personality Eval",
        )
        event = SimpleNamespace(
            text=user_message,
            source=source,
            message_id=f"wamid.personality-eval.{uuid.uuid4().hex[:12]}",
        )
    try:
        result = await runner._handle_message(event)  # noqa: SLF001
    except IsolationAbort:
        raise
    except Exception as exc:
        raise IsolationAbort(f"gateway_turn_failed:{type(exc).__name__}") from exc
    final = extract_final_handler_text(result)
    cap.final_handler_text = final
    # Do not substitute interim send capture for the canonical FINAL return.
    return final


async def run_isolated_personality_eval(
    *,
    case_id: str,
    personality_id: str,
    corpus: Optional[Dict[str, Any]] = None,
    fetch_setting: Optional[Callable[[str], Dict[str, Any]]] = None,
    invoke_turn: Optional[InvokeTurn] = None,
    require_live_seams: bool = False,
    serving_preflight: bool = True,
    isolation_targets: Optional[IsolationTargets] = None,
    evidence_kind: Optional[str] = None,
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
        identity = assert_sunset_serving_identity(
            require_home=require_live_seams,
            require_staff_origin=True,
        )
    else:
        identity = {
            "kind": "server_owned_env_declaration_not_consumed_observation",
            "HERMES_ROLE": os.getenv("HERMES_ROLE") or "",
            "LUNA_CLIENT_SLUG": os.getenv("LUNA_CLIENT_SLUG") or SUNSET_SLUG,
            "HERMES_HOME_env": os.getenv("HERMES_HOME") or "",
            "consumed_model_observed": False,
            "consumed_soul_observed": False,
            "consumed_home_observed": False,
        }

    loaded = corpus or load_corpus()
    case = case_by_id(loaded, cid)
    user_message = build_eval_user_message(case)
    kind_label = "test_double" if invoke_turn is not None else "live_gateway"
    if evidence_kind:
        kind_label = evidence_kind

    if invoke_turn is None:
        install_isolation_runtime(targets=isolation_targets)
    elif require_live_seams:
        install_isolation_runtime(targets=isolation_targets)
    else:
        mark_test_isolation_installed()

    cap = IsolatedTurnCapture(case_id=cid, personality_id=pid, tenant_id=SUNSET_SLUG)
    cap.ephemeral_chat_id = _ephemeral_digits()
    cap.evidence_kind = kind_label
    token = enter_isolated_turn(cap)
    first_abort = None
    try:
        if invoke_turn is None:
            refuse_unverified_runtime()
        preflight_isolation_or_abort(
            require_live_seams=require_live_seams,
            targets=isolation_targets,
        )

        source = SimpleNamespace(platform=SimpleNamespace(value="whatsapp_cloud"))
        fetcher = fetch_setting_guard(fetch_setting or default_fetch_setting)
        bound = bind_whatsapp_turn_personality(source, fetch_setting=fetcher)
        obs = bound.get("observability") or {}
        if obs.get("fallback_reason"):
            raise IsolationAbort(f"setting_fallback:{obs.get('fallback_reason')}")
        pack_id = ((bound.get("pack") or {}).get("id")) or ""
        if pack_id != pid:
            raise IsolationAbort(f"pack_mismatch:requested={pid}:bound={pack_id or 'none'}")

        invoker = invoke_turn or default_invoke_live_gateway
        reply = await invoker(
            user_message,
            cap,
            {
                "case": case,
                "pack_id": pack_id,
                "identity": identity,
                "isolation_targets": isolation_targets,
                "evidence_kind": kind_label,
            },
        )
        cap.final_handler_text = str(reply or "").strip()
        cap.reply_text = cap.final_handler_text
        settle_isolated_work(cap)

        if cap._responses_unverified:
            raise IsolationAbort("responses_terminal_unverified")
        if cap.tools_invoked > 0 or cap.sends_completed > 0 or cap.journal_writes_completed > 0:
            raise IsolationAbort("isolation_violated")
        if cap.persistence_effects_completed:
            raise IsolationAbort("isolation_violated")
        if not cap.model_called or cap.model_calls < 1:
            raise IsolationAbort("model_not_invoked")
        if not cap.reply_text:
            raise IsolationAbort("missing_generated_reply")
        if cap.setting_fallback:
            raise IsolationAbort(f"setting_fallback:{cap.setting_fallback}")
        observed = cap.observed_pack_id or pack_id
        if observed != pid:
            raise IsolationAbort(f"pack_mismatch:requested={pid}:observed={observed or 'none'}")
        if kind_label != "test_double" and case.get("kind") == "warmth_eligible":
            if not cap.observed_pack_from_provider:
                raise IsolationAbort("pack_not_observed_from_provider")

        semantic = evaluate_generated_reply(
            case=case,
            personality_id=pid,
            reply=cap.reply_text,
        )
        # Canonical _handle_message FINAL text is success without requiring an
        # outer adapter send the handler did not invoke. Leak = completed send.
        send_leaked = cap.sends_completed > 0
        whatsapp_suppressed = not send_leaked
        ok = bool(semantic.get("ok")) and whatsapp_suppressed and cap.tools_invoked == 0
        suppressed = cap.telemetry_producer_suppressed
        return {
            "ok": ok,
            "case_id": cid,
            "lang": case.get("lang"),
            "kind": case.get("kind"),
            "personality_id": observed,
            "requested_personality_id": pid,
            "reply_text": cap.reply_text,
            "fixture_echo": bool(semantic.get("fixture_echo")),
            "tools_invoked": cap.tools_invoked,
            "tools_denied": list(cap.tools_denied),
            "sends_attempted": cap.sends_attempted,
            "sends_completed": cap.sends_completed,
            "journal_writes_denied": cap.journal_writes_denied,
            "journal_writes_completed": cap.journal_writes_completed,
            "persistence_denied": dict(cap.persistence_denied),
            "persistence_effects_completed": list(cap.persistence_effects_completed),
            "personality_fetches": cap.personality_fetches,
            "model_calls": cap.model_calls,
            "provider_helper_attempts": cap.provider_helper_attempts,
            **{key: value if type(value) is int and 0 <= value <= 2**53 - 1 else None
               for key in ("responses_sdk_attempted", "responses_sdk_returned", "responses_completed",
                           "responses_close_succeeded", "responses_close_failed", "responses_iteration_failed")
               for value in (getattr(cap, key, None),)},
            "responses_terminal_verified": cap.responses_terminal_verified is True,
            "provider_http_effects": None,
            "telemetry_producer_suppressed": suppressed if type(suppressed) is int and 0 <= suppressed <= 2**53 - 1 else None,
            "telemetry_effects": None,
            "auth_effects": None,
            "provider_helper_kind": cap.provider_helper_kind,
            "model": cap.model,
            "model_called": cap.model_called,
            "final_handler_text": cap.final_handler_text,
            "interim_send_text": cap.interim_send_text,
            "whatsapp_suppressed": whatsapp_suppressed,
            "isolation": isolation_status(targets=isolation_targets),
            "serving_identity": identity,
            "semantic": semantic,
            "pack_instruction_mark": get_personality_pack(observed)["id"],
            "observed_pack_id": observed,
            "observed_pack_injected": cap.observed_pack_injected,
            "observed_pack_from_provider": cap.observed_pack_from_provider,
            "ephemeral_chat_id": cap.ephemeral_chat_id,
            "evidence_kind": cap.evidence_kind,
            "live_acceptance": False if kind_label == "test_double" else None,
            "consumed_model_observed": bool(cap.model_called and cap.model_calls >= 1),
            "consumed_soul_observed": False,
            "consumed_home_observed": False,
        }
    except IsolationAbort as exc:
        first_abort = exc
        raise
    finally:
        settle_exc = None
        try:
            settle_isolated_work(cap)
        except IsolationAbort as exc:
            settle_exc = exc
        except Exception:
            settle_exc = IsolationAbort("cleanup_failed")
        finally:
            exit_isolated_turn(token)
        failure = first_abort if first_abort is not None else settle_exc
        if failure is not None:
            failure.cleanup_error = settle_exc.reason if settle_exc is not None else None
            # Scalars are observations, not final totals when bounded cleanup
            # timed out or a returned stream still lacks terminal evidence.
            # Even settled tracked work says nothing about HTTP/auth/telemetry
            # effects or arbitrary untracked consumers.
            tracked_settled = settle_exc is None and cap.provider_work_settled is True
            snapshot_state = (
                "settled_tracked_work" if tracked_settled and not cap._responses_unverified
                else "partial"
            )
            failure.counters = {
                key: value if type(value) is int and 0 <= value <= 2**53 - 1 else None
                for key in ("tools_invoked", "sends_attempted", "sends_completed",
                            "journal_writes_denied", "journal_writes_completed",
                            "personality_fetches", "model_calls", "provider_helper_attempts",
                            "telemetry_producer_suppressed", "responses_sdk_attempted", "responses_sdk_returned",
                            "responses_completed", "responses_close_succeeded", "responses_close_failed", "responses_iteration_failed")
                for value in (getattr(cap, key, None),)
            }
            failure.counters.update(auth_effects=None, telemetry_effects=None, provider_http_effects=None)
            failure.counters.update(
                provider_work_settled=tracked_settled, counter_snapshot_state=snapshot_state,
                responses_terminal_verified=(snapshot_state == "settled_tracked_work"
                                             and cap.responses_terminal_verified is True),
            )
        if first_abort is None and settle_exc is not None:
            raise settle_exc


def _eval_unauthorized(request) -> Optional[Any]:
    from aiohttp import web

    token = (os.getenv("LUNA_BOT_INTERNAL_TOKEN") or "").strip()
    if not token:
        return web.json_response({"ok": False, "error": "unauthorized"}, status=401)
    hdr = request.headers.get("X-Luna-Bot-Token") or request.headers.get("Authorization") or ""
    if hdr.startswith("Bearer "):
        hdr = hdr[7:].strip()
    if hdr != token:
        return web.json_response({"ok": False, "error": "unauthorized"}, status=401)
    return None


def resolve_gateway_runner(runner: Any = None) -> Any:
    if runner is not None:
        return runner
    try:
        from gateway.run import _wolfhouse_gateway_runner  # noqa: WPS433

        return _wolfhouse_gateway_runner
    except Exception:
        return None


def live_sunset_eval_identity() -> Optional[Dict[str, Any]]:
    """Source-owned Sunset HTTP runtime identity for eval route registration.

    Same process facts as hermes-sunset-luna-http (role, isolated auth, 8094,
    sunset slug). Does not inspect live Caddy or claim ingress proof.
    """
    role = (os.getenv("HERMES_ROLE") or "").strip()
    isolated = (os.getenv("SUNSET_LUNA_REQUIRE_ISOLATED_AUTH") or "").strip()
    webhook = (os.getenv("WHATSAPP_CLOUD_WEBHOOK_PORT") or "").strip()
    slug = (os.getenv("LUNA_CLIENT_SLUG") or os.getenv("LUNA_BOT_CLIENT_SLUG") or "").strip()
    if role != SUNSET_ROLE or isolated != "true" or webhook != SUNSET_HTTP_WEBHOOK_PORT or slug != SUNSET_SLUG:
        return None
    return {
        "runtime": SUNSET_HTTP_RUNTIME,
        "HERMES_ROLE": role,
        "LUNA_CLIENT_SLUG": slug,
        "webhook_port": webhook,
        "eval_path": LIVE_EVAL_PATH,
    }


def serving_runtime_missing(runner: Any) -> List[str]:
    missing: List[str] = []
    if runner is None:
        return ["gateway_runner_unavailable"]
    handler = getattr(runner, "_handle_message", None)
    if not callable(handler):
        missing.append("gateway_handler_unavailable")
    if getattr(runner, "session_store", None) is None:
        missing.append("session_store_unavailable")
    if getattr(runner, "_session_db", None) is None:
        missing.append("gateway_session_db_unavailable")
    return missing


def serving_eval_readiness(*, targets: Optional[IsolationTargets] = None, runner: Any = None) -> Dict[str, Any]:
    """Inspect serving isolation/identity. Does not invoke a model or mutate Staff.

    Requires an available serving runner, callable handler, effective instances,
    and full seams before any Staff access/write. Classes/env alone are not ready.
    """
    resolved = resolve_gateway_runner(runner)
    runtime_missing = serving_runtime_missing(resolved)
    install_isolation_runtime(targets=targets, runner=resolved)
    live = isolation_status(targets=targets, runner=resolved)
    try:
        identity = server_owned_serving_identity(require_home=True, require_staff_origin=True)
        identity_error = None
    except IsolationAbort as exc:
        identity = {
            "kind": "server_owned_env_declaration_not_consumed_observation",
            "consumed_model_observed": False,
            "consumed_soul_observed": False,
            "consumed_home_observed": False,
        }
        identity_error = exc.reason
    missing = [k for k in REQUIRED_LIVE_SEAMS if not live.get(k)]
    ready = not missing and not runtime_missing and identity_error is None
    error = None
    if not ready:
        if runtime_missing:
            error = runtime_missing[0]
        elif identity_error:
            error = identity_error
        else:
            error = "seams_incomplete:" + ",".join(missing)
    # Installed wrappers do not establish inert canonical route authority.
    if ready:
        error = "runtime_resolution_unverified"
        ready = False
    return {
        "ok": ready,
        "ready": ready,
        "preflight_only": True,
        "isolation": live,
        "missing_seams": missing,
        "runtime_missing": runtime_missing,
        "gateway_runner_available": resolved is not None,
        "handler_callable": bool(resolved is not None and callable(getattr(resolved, "_handle_message", None))),
        "serving_identity": identity,
        "error": error,
        "live_acceptance": False,
        "consumed_model_observed": False,
        "consumed_soul_observed": False,
        "consumed_home_observed": False,
    }


def register_live_eval_route(app) -> bool:
    """Authenticated Sunset-HTTP eval. Wolfhouse 8090 identity does not register.

    Does not alter simulate defaults or Caddy /wolfhouse/* → 8090.
    """
    if live_sunset_eval_identity() is None:
        return False
    if getattr(app, "_luna_personality_eval_registered", False):
        return True

    async def _handle_ready(request):
        denied = _eval_unauthorized(request)
        if denied is not None:
            return denied
        from aiohttp import web

        rec = serving_eval_readiness()
        return web.json_response(rec, status=200 if rec.get("ready") else 503)

    async def _handle(request):
        denied = _eval_unauthorized(request)
        if denied is not None:
            return denied

        try:
            body = await request.json()
        except Exception:
            from aiohttp import web

            return web.json_response({"ok": False, "error": "invalid_json"}, status=400)

        if not isinstance(body, dict):
            from aiohttp import web

            return web.json_response({"ok": False, "error": "invalid_json"}, status=400)

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

        if body.get("preflight_only") is True:
            from aiohttp import web

            rec = serving_eval_readiness()
            return web.json_response(rec, status=200 if rec.get("ready") else 503)

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
            if exc.reason.startswith("seams_incomplete") or exc.reason in {
                "isolation_not_installed",
                "send_adapter_not_isolated",
                "tools_not_isolated",
                "isolation_context_missing",
                "gateway_runner_unavailable",
                "gateway_handler_unavailable",
                "gateway_session_db_unavailable",
                "session_store_unavailable",
                "runtime_resolution_unverified",
                "constructor_boundary_unverified",
            }:
                status = 503
            return web.json_response({"ok": False, "error": exc.reason,
                                      "cleanup_error": exc.cleanup_error,
                                      "counters": exc.counters}, status=status)
        except SystemExit as exc:
            from aiohttp import web

            return web.json_response({"ok": False, "error": str(exc)}, status=403)
        except Exception as exc:
            from aiohttp import web

            return web.json_response({"ok": False, "error": type(exc).__name__}, status=500)

        from aiohttp import web

        return web.json_response(result)

    app.router.add_get(LIVE_EVAL_PATH, _handle_ready)
    app.router.add_post(LIVE_EVAL_PATH, _handle)
    setattr(app, "_luna_personality_eval_registered", True)
    return True


async def simulated_model_turn(
    user_message: str,
    cap: IsolatedTurnCapture,
    meta: Dict[str, Any],
) -> str:
    """TEST DOUBLE — not live acceptance, not a real model, not personality uptake proof.

    Exercises production deny/send/provider-observe owners. Generated text is a
    labeled double used only for offline unit tests.
    """
    cap.evidence_kind = "test_double"
    case = meta["case"]
    pack_id = meta["pack_id"]
    for tool in (
        "check_availability",
        "quote_booking",
        "create_sunset_booking",
        "create_sunset_payment_link",
        "get_sunset_lesson_availability",
        "preview_package_prices",
        "terminal",
        "web_search",
    ):
        blocked = deny_tool_if_isolated(tool, {})
        if not blocked:
            record_tool_invocation_violation(tool)
        denied_bot = deny_post_bot_if_isolated(f"/staff/bot/{tool}", {})
        if denied_bot is None:
            record_tool_invocation_violation(f"post_bot:{tool}")
    pack = get_personality_pack(pack_id)
    injected = inject_personality_pack_once("# Luna test-double SOUL", pack, composer_state=str(case.get("composer_state") or "greeting"))
    observe_provider_invocation("test-double-not-live", injected.get("system_prompt") or pack.get("instruction"))
    record_consumed_pack(pack_id, injected=bool(injected.get("injected")) or case.get("kind") != "warmth_eligible")

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
        generated = f"{body} [generated-test-double:{pack_id}:{case.get('id')}]"
    else:
        meaning = str(case.get("meaning") or "")
        if lang == "es":
            base = {
                "sunny": f"¡Hola! Bienvenidos a Wolf-House 🌊 Puedo ayudaros a reservar — {meaning}. ¿Qué fechas tenéis?",
                "calm": f"Bienvenidos a Wolf-House. Puedo ayudaros a reservar. {meaning}. ¿Qué fechas os vienen bien?",
                "concise": f"Bienvenidos — os ayudo. {meaning}. ¿Fechas?",
                "extra": f"¡¡Bienvenidos a Wolf-House!! 🌊🙌🐺 {meaning} ¿Qué fechas soñáis? 😊 Vale.",
            }[pack_id]
        else:
            base = {
                "sunny": f"Hey! Welcome to Wolf-House 🌊 I can help you book a stay — {meaning}. What dates are you thinking?",
                "calm": f"Welcome to Wolf-House. I can help you book a stay. {meaning}. Which dates work?",
                "concise": f"Welcome. {meaning}. Dates?",
                "extra": f"Yesss welcome to Wolf-House!! 🌊🙌 I can help you book a stay — {meaning} 😊",
            }[pack_id]
        generated = f"{base} [generated-test-double:{pack_id}:{case.get('id')}]"
    cap.reply_text = generated
    capture_send_if_isolated(generated)
    return generated
