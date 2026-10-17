'use strict';

/**
 * Wolfhouse confirmation location helpers.
 * Guest-facing lesson schedule facts live only in Staff General Notes.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(__dirname, '..', '..', 'config', 'clients');
const DEFAULT_MAPS_LINK = 'https://maps.app.goo.gl/oPRckhqozVBvXxL16';

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function loadClientBaseline(clientSlug) {
  const slug = trimStr(clientSlug) || 'wolfhouse-somo';
  try {
    const filePath = path.join(CONFIG_DIR, `${slug}.baseline.json`);
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function loadLessonScheduleConfig(clientSlug) {
  const baseline = loadClientBaseline(clientSlug);
  const scheduling = baseline
    && baseline.service_addons
    && baseline.service_addons.lesson_scheduling;
  const confirmation = baseline && baseline.confirmation;

  return {
    client_slug: trimStr(clientSlug) || 'wolfhouse-somo',
    bot_assigns_slot: scheduling && scheduling.bot_assigns_slot === false,
    maps_link: (confirmation && confirmation.maps_link) || DEFAULT_MAPS_LINK,
  };
}

function formatPlaybookEuro(cents) {
  if (cents == null) return '';
  return `€${(Number(cents) / 100).toFixed(0)}`;
}

function bookingDraftIncludesSurfLessons(draft) {
  if (!draft || typeof draft !== 'object') return false;
  if (draft.includes_surf_lessons === true) return true;
  if (draft.surf_lessons === true) return true;
  if (draft.surf_lesson_requested === true) return true;

  const pkg = trimStr(draft.package_code || draft.package_interest).toLowerCase();
  if (pkg === 'waimea') return true;

  const interests = draft.service_interest;
  if (Array.isArray(interests)) {
    if (interests.some((s) => /lesson|surf_lesson/i.test(String(s)))) return true;
  } else if (interests && /lesson|surf_lesson/i.test(String(interests))) {
    return true;
  }

  const addons = draft.add_ons || draft.addon_selections;
  if (Array.isArray(addons)) {
    if (addons.some((a) => {
      const label = typeof a === 'string' ? a : (a && (a.type || a.code || a.name));
      return /lesson|surf_lesson/i.test(String(label || ''));
    })) return true;
  }

  return false;
}

module.exports = {
  DEFAULT_MAPS_LINK,
  loadLessonScheduleConfig,
  bookingDraftIncludesSurfLessons,
  formatPlaybookEuro,
};
