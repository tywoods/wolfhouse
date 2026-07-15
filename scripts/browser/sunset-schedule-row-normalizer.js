'use strict';

/**
 * Sunset Schedule — canonical row normalizer (Slice 23 → runtime.rows, Slice 24).
 *
 * Compatibility wrappers only. Implementation lives on SunsetScheduleRuntime.rows.
 */

function scheduleRowNormalizerClone(raw) { return SunsetScheduleRuntime.rows.clone(raw); }
function scheduleRowNormalizerFreeze(row) { return SunsetScheduleRuntime.rows.freeze(row); }
function scheduleRowMetaParse(row) { return SunsetScheduleRuntime.rows.metaParse(row); }
function scheduleEnsureRowMeta(row) { return SunsetScheduleRuntime.rows.ensureMeta(row); }
function scheduleRowMeta(row) { return SunsetScheduleRuntime.rows.meta(row); }
function scheduleRowIsPrivateLesson(row) { return SunsetScheduleRuntime.rows.isPrivateLesson(row); }
function scheduleRowIsCourse(row) { return SunsetScheduleRuntime.rows.isCourse(row); }
function scheduleRowEffectivePaid(r) { return SunsetScheduleRuntime.rows.effectivePaid(r); }
function scheduleDeriveStableRowId(row, meta) { return SunsetScheduleRuntime.rows.deriveStableId(row, meta); }
function scheduleEnsureRowId(row) { return SunsetScheduleRuntime.rows.ensureId(row); }
function scheduleRowSourceKind(row) { return SunsetScheduleRuntime.rows.sourceKind(row); }
function scheduleNormalizerApplyTrustFlags(r, ctx) {
  return SunsetScheduleRuntime.rows.applyTrustFlags(r, ctx);
}
function scheduleNormalizerApplyDisplayFields(r) {
  return SunsetScheduleRuntime.rows.applyDisplayFields(r);
}
function scheduleNormalizeApiRow(raw, ctx, opts) {
  return SunsetScheduleRuntime.rows.normalizeApiRow(raw, ctx, opts);
}
function scheduleNormalizeApiRowsBatch(rawRows, ctx) {
  return SunsetScheduleRuntime.rows.normalizeApiRowsBatch(rawRows, ctx);
}
function scheduleNormalizerContextFromRuntime(profile) {
  return SunsetScheduleRuntime.rows.normalizerContextFromRuntime(profile);
}
function scheduleNormalizeLoadedScheduleResponse(weekData, profile, ctx) {
  return SunsetScheduleRuntime.rows.normalizeLoadedScheduleResponse(weekData, profile, ctx);
}
function scheduleNormalizePresentationDemoRow(raw, ctx) {
  return SunsetScheduleRuntime.rows.normalizePresentationDemoRow(raw, ctx);
}
