'use strict';

/**
 * Stage 37b — Wolfhouse surf lesson schedule facts + guest-facing copy helpers.
 * Scheduling/assignment remains staff-owned; this module only formats known rhythm.
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
    frequency: scheduling && scheduling.frequency ? scheduling.frequency : 'almost_daily_except_low_season',
    low_season_caveat: 'Lessons run most days in season; low season can be quieter — staff confirm day by day.',
    bot_assigns_slot: scheduling && scheduling.bot_assigns_slot === false,
    daily_slots: (scheduling && Array.isArray(scheduling.daily_slots))
      ? scheduling.daily_slots
      : [
        { group: 1, transport_time: '08:30', lesson_window: '09:00-11:00' },
        { group: 2, transport_time: '10:30', lesson_window: '11:00-13:00' },
      ],
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
  if (['malibu', 'uluwatu', 'waimea'].includes(pkg)) return true;

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

function buildLessonScheduleGuestSection(clientSlug, language, draft) {
  if (!bookingDraftIncludesSurfLessons(draft)) return '';

  const cfg = loadLessonScheduleConfig(clientSlug);
  const lang = trimStr(language).slice(0, 2).toLowerCase() || 'en';
  const slots = cfg.daily_slots || [];
  const g1 = slots[0] || { transport_time: '08:30', lesson_window: '09:00-11:00' };
  const g2 = slots[1] || { transport_time: '10:30', lesson_window: '11:00-13:00' };

  if (lang === 'it') {
    return [
      'Ritmo lezioni surf 🌊',
      'La maggior parte delle mattine abbiamo due gruppi:',
      `• primo gruppo parte da Wolfhouse verso le ${g1.transport_time}, lezione ${g1.lesson_window}`,
      `• secondo gruppo parte verso le ${g2.transport_time}, lezione ${g2.lesson_window}`,
      '',
      'Confermeremo il tuo gruppo esatto più vicino al giorno.',
      cfg.low_season_caveat,
    ].join('\n');
  }

  return [
    'Surf lesson rhythm 🌊',
    'Most mornings we have two groups:',
    `• first group leaves Wolfhouse around ${g1.transport_time}, lesson ${g1.lesson_window}`,
    `• second group leaves around ${g2.transport_time}, lesson ${g2.lesson_window}`,
    '',
    'We\'ll confirm your exact group closer to the day.',
    cfg.low_season_caveat,
  ].join('\n');
}

module.exports = {
  DEFAULT_MAPS_LINK,
  loadLessonScheduleConfig,
  bookingDraftIncludesSurfLessons,
  buildLessonScheduleGuestSection,
  formatPlaybookEuro,
};
