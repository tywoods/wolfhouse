#!/usr/bin/env python3
from pathlib import Path

V1 = Path("/opt/wolfhouse/WH/scripts/verify-sunset-portal-v1.js")
v1 = V1.read_text(encoding="utf-8")

v1 = v1.replace(
    "assert('Schedule lesson groups summary card', apiSrc.includes('schedule.card.lessonGroups') && apiSrc.includes('id=\"ps-lessons-surfers-today\"'));",
    "assert('Schedule lesson groups summary card', apiSrc.includes('schedule.card.lessonGroups') && apiSrc.includes('portal-schedule-lesson-times') && apiSrc.includes('id=\"ps-lessons-slot-sub\"'));",
)

v1 = v1.replace(
    "&& apiSrc.includes('id=\"ps-lessons-surfers-today\"')",
    "&& apiSrc.includes('id=\"ps-lessons-slot-sub\"')",
)

v1 = v1.replace(
    "assert('lessons surfer count prominent', apiSrc.includes('id=\"ps-lessons-surfers-today\"') && apiSrc.includes('function scheduleLessonsSurfersToday('));",
    "assert('lessons time rows with counts', apiSrc.includes('portal-schedule-lesson-time-row') && apiSrc.includes('portal-schedule-lesson-time-count'));",
)

v1 = v1.replace(
    "assert('metric slot summary lines', apiSrc.includes('portal-schedule-metric-slot') && apiSrc.includes(\"' — ' + String(stats.surfers)\"));",
    "assert('lesson time row layout', apiSrc.includes('portal-schedule-lesson-time-row') && apiSrc.includes('scheduleNormalizeSlotTime(slot.slot_time)'));",
)

if "[23]" not in v1:
    section23 = """

// ── 23. Sunset UI — ES default, lesson groups card, soft light theme ────────

console.log('\\n[23] Sunset UI — ES default, lesson groups card, soft light theme');

if (apiSrc) {
  assert('ES default locale', i18nSrc.includes("return 'es';"));
  assert('no IT lang button', !apiSrc.includes('data-lang="it"'));
  assert('ES lang button before EN', apiSrc.indexOf('data-lang="es"') >= 0 && apiSrc.indexOf('data-lang="es"') < apiSrc.indexOf('data-lang="en"'));
  assert('spanish sunset supplement', i18nSrc.includes('staff-portal-i18n-es-sunset'));
  assert('lesson groups time rows', apiSrc.includes('portal-schedule-lesson-time-row'));
  assert('soft light cream palette', apiSrc.includes('--cream:#EDE8E0'));
}
"""
    v1 = v1.replace(
        "console.log('\\n' + '─'.repeat(48));",
        section23 + "\nconsole.log('\\n' + '─'.repeat(48));",
    )

V1.write_text(v1, encoding="utf-8")
print("patched verify")
