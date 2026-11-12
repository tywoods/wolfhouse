'use strict';

/** At Wolfhouse a double room and a private room are the same sale. */

function canonicalSupplementCode(roomType) {
  const code = String(roomType || '').trim().toLowerCase();
  if (code === 'double' || code === 'couple_private' || code === 'private_room' || code === 'matrimonial') {
    return 'private';
  }
  return code;
}

function lookupRoomSupplement(config, roomType) {
  const code = canonicalSupplementCode(roomType);
  const supplements = (config && config.room_supplements) || {};
  let supplement = supplements[code];
  if (code === 'private' && !hasPrivateTariff(supplement) && hasPrivateTariff(supplements.double)) {
    supplement = supplements.double;
  }
  return { code, supplement: supplement || null };
}

function hasPrivateTariff(supplement) {
  if (!supplement || typeof supplement !== 'object') return false;
  const perRoom = Number(supplement.per_room_per_night_cents);
  const perPerson = Number(supplement.per_person_per_night_cents);
  return (Number.isSafeInteger(perRoom) && perRoom >= 0)
    || (Number.isSafeInteger(perPerson) && perPerson >= 0);
}

/** Default (today): per booking = per room per night. */
function supplementChargeScope(supplement) {
  const perPerson = Number(supplement && supplement.per_person_per_night_cents);
  const perRoom = Number(supplement && supplement.per_room_per_night_cents);
  if (Number.isSafeInteger(perPerson) && perPerson > 0 && !(Number.isSafeInteger(perRoom) && perRoom > 0)) {
    return 'per_person';
  }
  return 'per_booking';
}

function roomSupplementAmountCents(supplement) {
  if (!supplement) return null;
  const scope = supplementChargeScope(supplement);
  if (scope === 'per_person') {
    const n = Number(supplement.per_person_per_night_cents);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  }
  const n = Number(supplement.per_room_per_night_cents);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function roomSupplementStayCents(supplement, nights, guests) {
  const amount = roomSupplementAmountCents(supplement);
  const stay = Number(nights);
  const heads = Number(guests);
  if (amount == null || !Number.isSafeInteger(stay) || stay < 1) return null;
  if (supplementChargeScope(supplement) === 'per_person') {
    if (!Number.isSafeInteger(heads) || heads < 1) return null;
    return amount * stay * heads;
  }
  return amount * stay;
}

module.exports = {
  canonicalSupplementCode,
  lookupRoomSupplement,
  hasPrivateTariff,
  supplementChargeScope,
  roomSupplementAmountCents,
  roomSupplementStayCents,
};
