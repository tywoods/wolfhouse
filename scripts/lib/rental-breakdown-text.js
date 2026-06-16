'use strict';

function pluralUnit(count, singular, plural) {
  const n = Number(count);
  if (n === 1) return singular;
  return plural;
}

function formatEurCents(cents) {
  if (cents == null || Number.isNaN(Number(cents))) return null;
  return `\u20ac${(Number(cents) / 100).toFixed(2)}`;
}

/**
 * Guest/staff rental line: "Soft board — 5 rental days × 2 people = €150"
 */
function formatRentalPeopleDaysLine({ label, days, people, totalCents, freeNote }) {
  const lbl = String(label || '').trim() || 'Rental';
  const d = Math.max(1, Number(days) || 1);
  const p = Math.max(1, Number(people) || 1);
  const dayWord = pluralUnit(d, 'day', 'days');
  const peopleWord = pluralUnit(p, 'person', 'people');
  const base = `${lbl} \u2014 ${d} rental ${dayWord} \u00d7 ${p} ${peopleWord}`;
  if (freeNote) return `${base} \u2014 ${freeNote}`;
  const eur = formatEurCents(totalCents);
  if (eur == null) return base;
  return `${base} = ${eur}`;
}

function resolveRentalPeopleFromMeta(meta, quantity, serviceType) {
  const m = meta || {};
  if (m.rental_people != null && Number(m.rental_people) > 0) {
    return Math.max(1, Number(m.rental_people));
  }
  if (serviceType !== 'wetsuit' && serviceType !== 'surfboard') return null;
  const days = m.rental_days != null ? Number(m.rental_days) : null;
  const qty = quantity != null ? Number(quantity) : null;
  if (days != null && days > 0 && qty != null && qty > days) {
    return Math.max(1, Math.round(qty / days));
  }
  return null;
}

module.exports = {
  pluralUnit,
  formatEurCents,
  formatRentalPeopleDaysLine,
  resolveRentalPeopleFromMeta,
};
