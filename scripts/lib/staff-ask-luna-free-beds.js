/**
 * Phase 11l — Staff Ask Luna free-bed snapshot for tonight / tomorrow night (read-only).
 *
 * Sellable beds from rooms/beds inventory minus beds tied to active bookings
 * on the requested night (booking check_in <= night AND check_out > night).
 *
 * Snapshot only — not the booking/pricing engine.
 *
 * @module staff-ask-luna-free-beds
 */

'use strict';

const {
  wolfhouseExcludeDemoRoomsSql,
  wolfhouseExcludeDemoBookingsSql,
} = require('./wolfhouse-inventory-source');

const FREE_BEDS_TONIGHT_KEY = 'inventory.free_beds_tonight';
const FREE_BEDS_TOMORROW_NIGHT_KEY = 'inventory.free_beds_tomorrow_night';
const FREE_BEDS_REGISTRY_KEYS = new Set([FREE_BEDS_TONIGHT_KEY, FREE_BEDS_TOMORROW_NIGHT_KEY]);

const SNAPSHOT_CAVEAT = 'Snapshot only — use the booking flow before confirming availability.';

function askLunaIsoDateUTC(d) {
  return d.toISOString().slice(0, 10);
}

function askLunaTodayUTC(refDate = new Date()) {
  return askLunaIsoDateUTC(refDate);
}

function askLunaTomorrowUTC(refDate = new Date()) {
  const d = new Date(refDate);
  d.setUTCDate(d.getUTCDate() + 1);
  return askLunaIsoDateUTC(d);
}

function normalizeFreeBedsQuestionText(question) {
  let q = String(question || '').toLowerCase().trim();
  q = q.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  q = q.replace(/[''`´]/g, ' ');
  q = q.replace(/[?!.,;:()[\]{}""]/g, ' ');
  q = q.replace(/\s+/g, ' ').trim();
  return q;
}

function askLunaHasTonightWord(q) {
  return /\b(tonight|this\s+night)\b/.test(q);
}

function askLunaHasTomorrowNightWord(q) {
  return /\b(tomorrow\s+night|tomorrow\s+evening)\b/.test(q)
    || (/\btomorrow\b/.test(q) && /\b(free|available|beds?|rooms?)\b/.test(q));
}

function matchesFreeBedsTopic(q) {
  const hasBedRoom = /\b(beds?|rooms?)\b/.test(q);
  const hasFreeAvail = /\b(free|available)\b/.test(q);
  if (hasFreeAvail && hasBedRoom) return true;
  if (/\bwhich\s+rooms?\s+have\s+free\s+beds?\b/.test(q)) return true;
  if (/\bhow\s+many\s+beds?\s+(?:are\s+)?free\b/.test(q)) return true;
  if (/\bwhat\s+beds?\s+(?:are\s+)?available\b/.test(q)) return true;
  if (/\bwhich\s+beds?\s+(?:are\s+)?free\b/.test(q)) return true;
  return false;
}

/**
 * @returns {{ intentKey: string, extraParams: { date: string, nightLabel: string } } | null}
 */
function resolveAskLunaFreeBedsIntentKey(question, registryByKey, refDate = new Date()) {
  const rawLower = String(question || '').trim().toLowerCase();

  if (registryByKey && registryByKey.has(rawLower) && FREE_BEDS_REGISTRY_KEYS.has(rawLower)) {
    const isTomorrow = rawLower === FREE_BEDS_TOMORROW_NIGHT_KEY;
    return {
      intentKey: rawLower,
      extraParams: {
        date: isTomorrow ? askLunaTomorrowUTC(refDate) : askLunaTodayUTC(refDate),
        nightLabel: isTomorrow ? 'tomorrow night' : 'tonight',
      },
    };
  }

  const q = normalizeFreeBedsQuestionText(question);
  if (!matchesFreeBedsTopic(q)) return null;

  if (askLunaHasTomorrowNightWord(q)) {
    return {
      intentKey: FREE_BEDS_TOMORROW_NIGHT_KEY,
      extraParams: {
        date: askLunaTomorrowUTC(refDate),
        nightLabel: 'tomorrow night',
      },
    };
  }

  if (askLunaHasTonightWord(q)) {
    return {
      intentKey: FREE_BEDS_TONIGHT_KEY,
      extraParams: {
        date: askLunaTodayUTC(refDate),
        nightLabel: 'tonight',
      },
    };
  }

  return null;
}

/**
 * Free sellable beds on night $2 (not occupied by active booking_beds + booking night rule).
 * $1 = client slug, $2 = night date (YYYY-MM-DD)
 */
function getAskLunaFreeBedsOnNightQuery() {
  return `
WITH sellable_beds AS (
  SELECT
    bd.id                   AS bed_id,
    bd.bed_code,
    bd.bed_label,
    bd.planning_row_label,
    r.room_code,
    r.name                  AS room_name
  FROM rooms r
  INNER JOIN (
    SELECT id, bed_code, bed_label, planning_row_label, room_id, client_id
    FROM beds bd
    WHERE bd.active = TRUE
      AND bd.sellable = TRUE
  ) bd ON r.id = bd.room_id AND r.client_id = bd.client_id
  INNER JOIN clients c ON c.id = bd.client_id
  WHERE c.slug = $1
    AND r.active = TRUE
    ${wolfhouseExcludeDemoRoomsSql('r', 'c')}
),
occupied_beds AS (
  SELECT DISTINCT bb.bed_id
  FROM bookings b
  INNER JOIN booking_beds bb ON b.id = bb.booking_id AND b.client_id = bb.client_id
  INNER JOIN clients c ON c.id = b.client_id
  WHERE c.slug = $1
    AND b.check_in <= $2::date
    AND b.check_out > $2::date
    AND LOWER(b.status::text) NOT IN ('cancelled', 'canceled', 'expired', 'hold')
    ${wolfhouseExcludeDemoBookingsSql('b', 'bb', 'c')}
)
SELECT
  sb.bed_id::text         AS bed_id,
  sb.bed_code,
  sb.bed_label,
  sb.planning_row_label,
  sb.room_code,
  sb.room_name
FROM sellable_beds sb
WHERE sb.bed_id NOT IN (SELECT bed_id FROM occupied_beds)
ORDER BY sb.room_code ASC, sb.bed_code ASC
`;
}

/**
 * @param {object[]} rows
 */
function buildFreeBedsByRoom(rows) {
  const roomMap = new Map();

  for (const r of rows || []) {
    const room = r.room_code || 'Unassigned';
    if (!roomMap.has(room)) {
      roomMap.set(room, { room_code: room, beds: [] });
    }
    const label = r.bed_label && String(r.bed_label).trim() !== String(r.bed_code).trim()
      ? `${r.bed_code} (${r.bed_label})`
      : String(r.bed_code);
    roomMap.get(room).beds.push({
      bed_code: r.bed_code,
      display: label,
    });
  }

  const rooms = [...roomMap.values()].sort((a, b) =>
    String(a.room_code).localeCompare(String(b.room_code)));

  let freeBedCount = 0;
  for (const room of rooms) freeBedCount += room.beds.length;

  return {
    freeBedCount,
    roomsWithFreeBeds: rooms.length,
    rooms,
  };
}

/**
 * @param {object[]} rows
 * @param {{ nightLabel?: string }} [ctx]
 */
function formatAskLunaFreeBedsAnswer(rows, ctx = {}) {
  const nightLabel = ctx.nightLabel || 'tonight';
  const nightCap = nightLabel === 'tomorrow night' ? 'Tomorrow night' : 'Tonight';
  const { freeBedCount, roomsWithFreeBeds, rooms } = buildFreeBedsByRoom(rows);

  if (freeBedCount === 0) {
    return [
      `No sellable beds appear free ${nightLabel}.`,
      '',
      SNAPSHOT_CAVEAT,
    ].join('\n');
  }

  const lines = [
    `${nightCap} there are ${freeBedCount} free bed${freeBedCount !== 1 ? 's' : ''} across ${roomsWithFreeBeds} room${roomsWithFreeBeds !== 1 ? 's' : ''}.`,
    '',
  ];

  for (const room of rooms) {
    const bedList = room.beds.map((b) => b.bed_code).join(', ');
    lines.push(`${room.room_code}: ${bedList}`);
  }

  lines.push('');
  lines.push(SNAPSHOT_CAVEAT);

  return lines.join('\n').trim();
}

/** Verifier smoke: inline resolver for API routing tests. */
function getAskLunaFreeBedsRoutingSmokeBlock() {
  const consts = `
const FREE_BEDS_TONIGHT_KEY = ${JSON.stringify(FREE_BEDS_TONIGHT_KEY)};
const FREE_BEDS_TOMORROW_NIGHT_KEY = ${JSON.stringify(FREE_BEDS_TOMORROW_NIGHT_KEY)};
const FREE_BEDS_REGISTRY_KEYS = new Set([FREE_BEDS_TONIGHT_KEY, FREE_BEDS_TOMORROW_NIGHT_KEY]);
const SNAPSHOT_CAVEAT = ${JSON.stringify(SNAPSHOT_CAVEAT)};
`;
  const fns = [
    askLunaIsoDateUTC,
    askLunaTodayUTC,
    askLunaTomorrowUTC,
    normalizeFreeBedsQuestionText,
    askLunaHasTonightWord,
    askLunaHasTomorrowNightWord,
    matchesFreeBedsTopic,
    resolveAskLunaFreeBedsIntentKey,
  ].map((fn) => fn.toString()).join('\n');
  return `${consts}\n${fns}`;
}

module.exports = {
  FREE_BEDS_TONIGHT_KEY,
  FREE_BEDS_TOMORROW_NIGHT_KEY,
  FREE_BEDS_REGISTRY_KEYS,
  SNAPSHOT_CAVEAT,
  resolveAskLunaFreeBedsIntentKey,
  getAskLunaFreeBedsOnNightQuery,
  formatAskLunaFreeBedsAnswer,
  buildFreeBedsByRoom,
  getAskLunaFreeBedsRoutingSmokeBlock,
};
