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

print()
if FAILS:
    print(f"✗ output-guard: {len(FAILS)} FAILED: {FAILS}")
    sys.exit(1)
print("✓ output-guard: all checks passed")
sys.exit(0)
