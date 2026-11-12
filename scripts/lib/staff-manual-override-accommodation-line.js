'use strict';

/**
 * Staff Create Booking nightly override is stored on the booking, but the
 * invoice accommodation line re-quotes leftover guest_packages (catalog Malibu).
 * Use the saved override amount instead.
 */

function parseMetadata(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

function staffManualOverrideAccommodationCents(booking, metadata) {
  const bk = booking || {};
  const md = metadata || parseMetadata(bk.metadata);
  const snap = (md && md.quote_snapshot) || {};
  const items = Array.isArray(snap.line_items) ? snap.line_items : [];
  const manual = items.find((item) => item && item.code === 'manual_accommodation');
  const pkg = String(bk.package_code || md.package_code || '').trim().toLowerCase();
  if (pkg !== 'manual_override' && !manual) return null;
  if (manual && Number.isFinite(Number(manual.total_cents))) return Number(manual.total_cents);
  const people = Array.isArray(snap.per_person) ? snap.per_person : [];
  const fromPeople = people.reduce((sum, person) => sum + Number(person.accommodation_cents || 0), 0);
  if (fromPeople > 0) return fromPeople;
  if (Number.isFinite(Number(snap.total_cents))) return Number(snap.total_cents);
  if (Number.isFinite(Number(bk.total_amount_cents))) return Number(bk.total_amount_cents);
  return null;
}

module.exports = {
  staffManualOverrideAccommodationCents,
};
