'use strict';

const { formatRentalPeopleDaysLine } = require('./rental-breakdown-text');

const ACCOMMODATION_LINE_CODES = new Set([
  'accommodation_only',
  'guest_accommodation_only',
]);

const GUEST_ADDON_LABELS = {
  soft_top_rental: 'Soft board',
  hard_board_rental: 'Hard board',
  wetsuit_rental: 'Wetsuit',
  wetsuit_soft_top_combo: 'Soft board + wetsuit',
  wetsuit_hard_board_combo: 'Hard board + wetsuit',
  surf_lesson_single: 'Surf lesson',
  surf_lesson_multi: 'Surf lesson',
  yoga_class: 'Yoga',
  meals: 'Meals',
};

function guestLabelForLineCode(code) {
  return GUEST_ADDON_LABELS[code] || null;
}

function unitLabelForLineCode(code) {
  if (code === 'wetsuit_rental' || code === 'soft_top_rental' || code === 'hard_board_rental'
    || code === 'wetsuit_soft_top_combo' || code === 'wetsuit_hard_board_combo') {
    return 'days';
  }
  if (code === 'surf_lesson_single' || code === 'surf_lesson_multi') return 'lessons';
  if (code === 'yoga_class') return 'classes';
  if (code === 'meals') return 'meals';
  return null;
}

function expandComboLineItem(li) {
  const days = Math.max(1, Number(li.days) || 1);
  const people = Math.max(1, Number(li.quantity) || Number(li.people_count) || 1);
  const total = Number(li.total_cents) || 0;
  const unit = li.unit_cents != null ? Number(li.unit_cents) : Math.round(total / (days * people));

  if (li.code === 'wetsuit_soft_top_combo') {
    const boardTotal = unit * days * people;
    return [
      {
        label: 'Soft board',
        code: 'soft_top_rental',
        days,
        people_count: people,
        unit_label: 'days',
        unit_cents: unit,
        total_cents: boardTotal,
        free: false,
        display_line: formatRentalPeopleDaysLine({
          label: 'Soft board', days, people, totalCents: boardTotal,
        }),
      },
      {
        label: 'Wetsuit',
        code: 'wetsuit_rental',
        days,
        people_count: people,
        unit_label: 'days',
        unit_cents: 0,
        total_cents: 0,
        free: true,
        free_note: 'free with board 🤙',
        display_line: formatRentalPeopleDaysLine({
          label: 'Wetsuit', days, people, totalCents: 0, freeNote: 'free with board 🤙',
        }),
      },
    ];
  }

  if (li.code === 'wetsuit_hard_board_combo') {
    const boardTotal = unit * days * people;
    return [
      {
        label: 'Hard board',
        code: 'hard_board_rental',
        days,
        people_count: people,
        unit_label: 'days',
        unit_cents: unit,
        total_cents: boardTotal,
        free: false,
        display_line: formatRentalPeopleDaysLine({
          label: 'Hard board', days, people, totalCents: boardTotal,
        }),
      },
      {
        label: 'Wetsuit',
        code: 'wetsuit_rental',
        days,
        people_count: people,
        unit_label: 'days',
        unit_cents: 0,
        total_cents: 0,
        free: true,
        free_note: 'free with board 🤙',
        display_line: formatRentalPeopleDaysLine({
          label: 'Wetsuit', days, people, totalCents: 0, freeNote: 'free with board 🤙',
        }),
      },
    ];
  }

  return null;
}

function mapAddonLineItem(li) {
  const expanded = expandComboLineItem(li);
  if (expanded) return expanded;

  const label = guestLabelForLineCode(li.code);
  if (!label) return [];

  const unitLabel = unitLabelForLineCode(li.code);
  const item = {
    label,
    code: li.code,
    unit_label: unitLabel,
    unit_cents: li.unit_cents != null ? Number(li.unit_cents) : null,
    total_cents: Number(li.total_cents) || 0,
    free: false,
  };

  if (unitLabel === 'days') {
    item.days = Math.max(1, Number(li.days) || 1);
    item.people_count = Math.max(1, Number(li.quantity) || Number(li.people_count) || 1);
    item.display_line = formatRentalPeopleDaysLine({
      label,
      days: item.days,
      people: item.people_count,
      totalCents: item.total_cents,
    });
  } else if (li.quantity != null) {
    item.quantity = Math.max(1, Number(li.quantity) || 1);
  }

  return [item];
}

/**
 * Guest-facing quote line items for short-stay (package_none) bookings with add-ons.
 */
function buildBotQuoteIncludedItems(quote, opts = {}) {
  if (!quote || !quote.success) return null;
  if (!opts.isNoPackage || !opts.hasAddOns) return null;

  const lineItems = Array.isArray(quote.line_items) ? quote.line_items : [];
  if (!lineItems.length) return null;

  let accommodationTotal = 0;
  let accommodationNights = null;
  let accommodationGuests = null;
  const addonLines = [];

  for (const li of lineItems) {
    if (ACCOMMODATION_LINE_CODES.has(li.code)) {
      accommodationTotal += Number(li.total_cents) || 0;
      if (li.nights != null) accommodationNights = li.nights;
      if (li.guest_count != null) accommodationGuests = li.guest_count;
      continue;
    }
    addonLines.push(...mapAddonLineItem(li));
  }

  if (!addonLines.length) return null;

  const out = [];
  if (accommodationTotal > 0) {
    out.push({
      label: 'Accommodation',
      code: 'accommodation',
      total_cents: accommodationTotal,
      free: false,
      ...(accommodationNights != null ? { nights: accommodationNights } : {}),
      ...(accommodationGuests != null ? { guest_count: accommodationGuests } : {}),
    });
  }
  out.push(...addonLines);
  return out;
}

module.exports = {
  buildBotQuoteIncludedItems,
  guestLabelForLineCode,
  ACCOMMODATION_LINE_CODES,
};
