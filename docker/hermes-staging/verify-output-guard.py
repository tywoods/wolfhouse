#!/usr/bin/env python3
"""Standalone unit test for wolfhouse.output_guard (step 3 output-guard).

Runs WITHOUT the container:  cd docker/hermes-staging && python3 verify-output-guard.py
Exit 0 = all pass, 1 = any failure. CI-gateable alongside the golden suite.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wolfhouse import output_guard as og  # noqa: E402

FAILS = []
_ORIGINAL_ROLE = os.environ.get("HERMES_ROLE")
os.environ["HERMES_ROLE"] = "luna"


def check(name, cond, detail=""):
    mark = "✓" if cond else "✗"
    print(f"  {mark} {name}{('  — ' + detail) if (detail and not cond) else ''}")
    if not cond:
        FAILS.append(name)


# --- leak detection: must CATCH real forensic leaks ---------------------------
LEAKY = [
    "Mi dispiace, il sistema richiede verifica manuale per quelle date.",  # off-season leak
    "Il sistema non mi ha restituito le voci separate del preventivo.",    # BUG E
    "Sorry, the system didn't return the line items to me.",
    "il preventivo che mi arriva non riporta le singole voci",
    "Let me check the backend for that.",
    "The quote tool gave an error.",
]
print("leak detection (must catch):")
for t in LEAKY:
    check(f"catches: {t[:48]}…", bool(og.find_leaks(t)), "MISSED leak")

# --- no false positives on real GREEN-fixture / safe replies ------------------
CLEAN = [
    "Great news — we've got space for 4 from Aug 15–22! 🙌 That's a 7-night stay.",
    "Almost there! One last thing before I create the booking 😊 Is your group all girls, all guys, or a mix?",
    "Ah, mi dispiace tanto! 🙈 Per quel periodo al momento non accettiamo prenotazioni. Vuoi che controlli qualche data nella nostra stagione aperta? 😊",
    "Love it — Malibu for the whole crew! 🌴 Here's your quote.",
]
print("no false positives (must stay clean):")
for t in CLEAN:
    check(f"clean: {t[:48]}…", not og.find_leaks(t), f"FALSE leak: {og.find_leaks(t)}")
# the fallbacks themselves must never trip the leak guard (would loop)
for lang, fb in og.SAFE_FALLBACK.items():
    check(f"fallback[{lang}] is leak-clean", not og.find_leaks(fb), f"fallback leaks: {og.find_leaks(fb)}")

# --- localized fallback -------------------------------------------------------
print("localized fallback:")
check("explicit guest_lang=it", og.safe_fallback_for("whatever", "it") == og.SAFE_FALLBACK["it"])
check("guessed from italian text", og.safe_fallback_for("ciao, grazie per la prenotazione") == og.SAFE_FALLBACK["it"])
check("default en", og.safe_fallback_for("hello there") == og.SAFE_FALLBACK["en"])

# --- unsourced price ----------------------------------------------------------
print("unsourced price:")
check("fabricated €908 with NO tool calls", bool(og.find_unsourced_prices("That'll be €908 total.", [])))
check("€908 present in tool result (euros)",
      not og.find_unsourced_prices("That'll be €908.", [{"name": "quote_booking", "result_summary": "total 908 eur"}]))
check("€140 matches 14000 cents in tool result",
      not og.find_unsourced_prices("Supplement is €140.", [{"name": "quote_booking", "result_summary": "room_supplement_cents 14000"}]))
check("no price in reply -> nothing flagged", not og.find_unsourced_prices("All set, see you soon!", []))

# --- language mismatch --------------------------------------------------------
print("language mismatch:")
check("guest it, substantial english reply -> flagged",
      og.language_mismatch("Hello! Your booking is confirmed and the room is ready for you.", "it") == "en")
check("guest it, italian reply -> ok",
      og.language_mismatch("Ciao! La tua prenotazione è confermata, la stanza è pronta.", "it") is None)
check("short ack not language-checked", og.language_mismatch("ok! 👍", "it") is None)
check("no guest_lang -> no check", og.language_mismatch("Hello there friend, all good", None) is None)

# --- orchestrator -------------------------------------------------------------
print("guard_reply orchestration:")
safe, findings = og.guard_reply("Il sistema non mi ha restituito le voci.", guest_lang="it")
check("leak -> text replaced with it fallback", safe == og.SAFE_FALLBACK["it"])
check("leak -> finding emitted (block)", any(f["kind"] == "leak" and f["severity"] == "block" for f in findings))
safe2, findings2 = og.guard_reply("Tutto pronto, a presto! 😊", guest_lang="it")
check("clean -> text unchanged", safe2 == "Tutto pronto, a presto! 😊")
check("clean -> no findings", findings2 == [])

# --- provider-error / graceful degradation ------------------------------------
print("provider-error scrub (must catch raw API errors):")
RAW_ERRORS = [
    "Error code: 400 - {'type': 'error', 'error': {'type': 'invalid_request_error', 'message': 'Third-party apps now draw from your extra usage'}, 'request_id': 'req_011Cc9gAkerae'}",
    "HTTP 429: Codex provider quota exhausted",
    "BadRequestError [HTTP 400] Provider: anthropic",
    "The usage limit has been reached",
]
for t in RAW_ERRORS:
    check(f"catches: {t[:42]}…", og.is_provider_error(t), "MISSED provider error")
print("provider-error must NOT false-positive on normal replies:")
for t in CLEAN:
    check(f"clean: {t[:42]}…", not og.is_provider_error(t), f"FALSE provider-error")
check("normal price reply not flagged", not og.is_provider_error("That'll be €908 total, deposit €200 😊"))

print("guard_reply -> outage fallback on provider error:")
_raw = "Error code: 400 - {'type': 'error', 'error': {'type': 'invalid_request_error'}, 'request_id': 'req_x'}"
safe_e, find_e = og.guard_reply(_raw, guest_lang="it")
check("provider error -> italian outage fallback", safe_e == og.OUTAGE_FALLBACK["it"])
check("provider error -> block finding (kind=provider_error)", any(f["kind"] == "provider_error" and f["severity"] == "block" for f in find_e))
check("outage fallback is itself leak/error-clean (no loop)",
      not og.find_leaks(og.OUTAGE_FALLBACK["it"]) and not og.is_provider_error(og.OUTAGE_FALLBACK["it"]))
check("turn adapter scrubs raw error too", og.guard_turn_response(_raw, None, [{"role": "user", "content": "ciao, 2 notti"}]) == og.OUTAGE_FALLBACK["it"])

# --- real-path adapter (guard_turn_response) ----------------------------------
print("guard_turn_response (gateway.run adapter):")


class _Obj:  # mimic an attribute-style agent_result / message
    def __init__(self, **kw):
        self.__dict__.update(kw)


# tool calls parsed from dict-shaped agent_result
ar_dict = {"tool_calls": [{"name": "quote_booking", "args": {}, "result_summary": "total 908 eur"}]}
check("dict agent_result -> tool calls parsed",
      og._tool_calls_from_agent_result(ar_dict)[0]["name"] == "quote_booking")
# tool calls parsed from object-shaped agent_result with object tool calls
ar_obj = _Obj(tool_calls=[_Obj(name="quote_booking", arguments={}, result="total 908 eur")])
check("object agent_result -> tool calls parsed",
      og._tool_calls_from_agent_result(ar_obj)[0]["result_summary"] == "total 908 eur")
check("None agent_result -> [] (no crash)", og._tool_calls_from_agent_result(None) == [])

# guest language from history (last user message wins)
hist = [{"role": "assistant", "content": "Hello!"},
        {"role": "user", "content": "Ciao, vorrei prenotare una stanza per 2 notti"}]
check("guest lang from history = it", og._guest_lang_from_history(hist) == "it")
check("empty history -> None", og._guest_lang_from_history([]) is None)

# end-to-end: leak in response is scrubbed even with full turn context
out = og.guard_turn_response("Il sistema non mi ha restituito le voci.", ar_dict, hist)
check("turn adapter scrubs leak -> it fallback", out == og.SAFE_FALLBACK["it"])
# clean reply with a sourced price is returned unchanged (price warn never scrubs)
clean_out = og.guard_turn_response("Perfetto! Il totale è €908.", ar_dict, hist)
check("turn adapter leaves clean reply (sourced price) unchanged", clean_out == "Perfetto! Il totale è €908.")
# fabricated price: still returned unchanged (advisory, not block)
fab_out = og.guard_turn_response("Il totale è €1234.", ar_dict, hist)
check("turn adapter does NOT scrub fabricated price (advisory only)", fab_out == "Il totale è €1234.")
# never raises on garbage input
check("turn adapter survives garbage", og.guard_turn_response(None, object(), object()) is None)

print("booking denial contradiction (Hernan Kyle/George):")
_deny = "Nothing is booked yet — a human from the Sunset team is coming into the chat."
_create_tc = [{"name": "create_sunset_booking", "result_summary": '{"success": true, "booking_code": "SUNSET-KYLE"}'}]
check("create success + deny is a contradiction",
      og.find_booking_denial_contradiction(_deny, _create_tc) == "deny_after_create")
safe_denial, find_denial = og.guard_reply(_deny, guest_lang="en", tool_calls=_create_tc)
check("guard replaces deny with ask fallback", safe_denial == og.BOOKING_ASK_FALLBACK["en"])
check("guard emits booking_denial_contradiction block",
      any(f["kind"] == "booking_denial_contradiction" and f["severity"] == "block" for f in find_denial))
_take = [{"name": "get_sunset_lesson_availability", "result_summary": '{"success": true, "take_request": true}'}]
check("take_request without create is not a contradiction",
      og.find_booking_denial_contradiction(_deny, _take) is None)
_list_rows = [{"name": "list_sunset_bookings", "result_summary": '{"success": true, "count": 2, "booking_code": "SUNSET-KYLE"}'}]
check("list rows + deny is a contradiction",
      og.find_booking_denial_contradiction(_deny, _list_rows) == "deny_after_list_rows")
check("ask fallback is leak-clean", not og.find_leaks(og.BOOKING_ASK_FALLBACK["en"]))
check("ask fallback is not itself a denial", og.find_booking_denial_contradiction(og.BOOKING_ASK_FALLBACK["en"], _create_tc) is None)

# --- orchestrator / operator: never guest handoff copy ------------------------
print("orchestrator mode (no guest leak scrub):")
_prev_role = os.environ.get("HERMES_ROLE")
os.environ["HERMES_ROLE"] = "orchestrator"
_orch_leak = "The quote tool failed — check the Staff API plugin and backend."
_orch_out = og.guard_turn_response(_orch_leak, None, [], platform="discord")
check(
    "orchestrator leak -> NOT team handoff fallback",
    _orch_out == _orch_leak and og.SAFE_FALLBACK["en"] not in str(_orch_out),
    f"got: {_orch_out!r}",
)
_raw_orch = "Error code: 400 - {'type': 'error', 'error': {'type': 'invalid_request_error'}, 'request_id': 'req_x'}"
_orch_err = og.guard_turn_response(_raw_orch, None, [], platform="discord")
check(
    "orchestrator provider-shaped text -> exact passthrough",
    _orch_err == _raw_orch,
    f"got: {_orch_err!r}",
)
_orch_status = "CURRENT FAILURE: Durable capture returned HTTP 503 inbound_capture_unavailable."
check(
    "orchestrator operational HTTP status -> exact passthrough",
    og.guard_turn_response(_orch_status, None, [], platform="discord") == _orch_status,
)
check(
    "should_apply_guest_output_guard false for orchestrator+discord",
    og.should_apply_guest_output_guard(platform="discord") is False,
)
if _prev_role is None:
    os.environ.pop("HERMES_ROLE", None)
else:
    os.environ["HERMES_ROLE"] = _prev_role

if _ORIGINAL_ROLE is None:
    os.environ.pop("HERMES_ROLE", None)
else:
    os.environ["HERMES_ROLE"] = _ORIGINAL_ROLE

print()
if FAILS:
    print(f"✗ output-guard: {len(FAILS)} FAILED: {FAILS}")
    sys.exit(1)
print("✓ output-guard: all checks passed")
sys.exit(0)
