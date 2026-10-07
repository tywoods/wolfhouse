'use strict';

// Shared pure occupancy score: Staff preview and live-safe allocator use one ordering.
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_NIGHTS = 366;

function addDay(iso) {
  const match = ISO_DATE.exec(iso);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(date.getTime())) return null;
  if (date.toISOString().slice(0, 10) !== iso) return null;
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function nightsBetween(checkIn, checkOut) {
  if (!ISO_DATE.test(checkIn) || !ISO_DATE.test(checkOut) || !(checkIn < checkOut)) return null;
  const nights = [];
  let cursor = checkIn;
  while (cursor < checkOut) {
    nights.push(cursor);
    cursor = addDay(cursor);
    if (!cursor || nights.length > MAX_NIGHTS) return null;
  }
  return nights.length ? nights : null;
}

function ratioCmp(an, ad, bn, bd) {
  const left = BigInt(an) * BigInt(bd);
  const right = BigInt(bn) * BigInt(ad);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function scoreOccupancy(room, unavailable, capacity, unitSize, rank) {
  let peakNum = 0;
  let peakDen = 1;
  let sum = 0;
  for (const occupied of unavailable) {
    const projected = occupied + unitSize;
    sum += projected;
    if (ratioCmp(projected, capacity, peakNum, peakDen) > 0) {
      peakNum = projected;
      peakDen = capacity;
    }
  }
  return { room, rank, peakNum, peakDen, meanNum: sum, meanDen: capacity * unavailable.length };
}

function compareScore(a, b) {
  const peak = ratioCmp(a.peakNum, a.peakDen, b.peakNum, b.peakDen);
  if (peak) return peak;
  const mean = ratioCmp(a.meanNum, a.meanDen, b.meanNum, b.meanDen);
  if (mean) return mean;
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.room.roomId < b.room.roomId) return -1;
  if (a.room.roomId > b.room.roomId) return 1;
  return 0;
}

function compareFillScore(a, b, mode) {
  if (mode === 'room' && a.rank !== b.rank) return a.rank - b.rank;
  if (mode === 'house') return compareScore(a, b);
  return a.room.roomId < b.room.roomId ? -1 : a.room.roomId > b.room.roomId ? 1 : 0;
}

module.exports = { nightsBetween, ratioCmp, scoreOccupancy, compareScore, compareFillScore };
