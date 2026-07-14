'use strict';

/**
 * Sunset course display-label helpers (UUID must never be the guest/staff title).
 * Shared between write-normalization and schedule UI resolution.
 */

function looksLikeCourseUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    .test(String(value || '').trim());
}

/**
 * What to persist on booking metadata.course_label.
 * Never store the raw course_id / UUID — leave empty so display resolves admin.
 */
function sanitizeCourseLabelForStorage(courseId, rawLabel) {
  const id = String(courseId || '').trim();
  const label = String(rawLabel || '').trim();
  if (!label) return '';
  if (id && label === id) return '';
  if (looksLikeCourseUuid(label)) return '';
  return label;
}

/**
 * Display-time label for a course booking row.
 * Prefer admin pack label; then a non-UUID stored label; else generic.
 */
function resolveCourseDisplayLabel(opts) {
  const options = opts || {};
  const courseId = String(options.courseId || '').trim();
  const storedLabel = String(options.storedLabel || '').trim();
  const genericLabel = String(options.genericLabel || 'Group course').trim() || 'Group course';
  const adminCourses = options.adminCourses || [];

  if (courseId) {
    const admin = adminCourses.find((c) => {
      const cid = String((c && (c.course_id || c.pack_id)) || '').trim();
      return cid && cid === courseId;
    });
    if (admin && String(admin.label || '').trim()) {
      return String(admin.label).trim();
    }
  }

  if (storedLabel
    && storedLabel !== courseId
    && !looksLikeCourseUuid(storedLabel)) {
    return storedLabel;
  }

  return genericLabel;
}

module.exports = {
  looksLikeCourseUuid,
  sanitizeCourseLabelForStorage,
  resolveCourseDisplayLabel,
};
