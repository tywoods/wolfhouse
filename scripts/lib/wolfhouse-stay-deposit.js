'use strict';

// Ty locked 2026-09-29: stay length is nights. >=6 nights is €200/person,
// <=5 nights is €100/person. Booking deposit is rate × guest count.
// A stored flat €200 must not win when nights and guest count are known.

const LONG_STAY_NIGHTS = 6;
const LONG_STAY_RATE_CENTS = 20000;
const SHORT_STAY_RATE_CENTS = 10000;

function wolfhouseStayNights(checkIn, checkOut) {
  const start = String(checkIn || '').slice(0, 10);
  const end = String(checkOut || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return null;
  const nights = Math.round((Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / 86400000);
  return Number.isInteger(nights) && nights > 0 ? nights : null;
}

function wolfhouseStayDepositRateCents(nights) {
  const n = Number(nights);
  if (!Number.isInteger(n) || n < 1) return null;
  return n >= LONG_STAY_NIGHTS ? LONG_STAY_RATE_CENTS : SHORT_STAY_RATE_CENTS;
}

function wolfhouseStayDepositCents(nights, guestCount) {
  const rate = wolfhouseStayDepositRateCents(nights);
  const guests = Number(guestCount);
  if (rate == null || !Number.isInteger(guests) || guests < 1) return null;
  const total = rate * guests;
  return Number.isSafeInteger(total) ? total : null;
}

function wolfhouseBookingDepositCents(booking) {
  booking = booking || {};
  const ruled = wolfhouseStayDepositCents(
    wolfhouseStayNights(booking.check_in, booking.check_out),
    booking.guest_count,
  );
  if (ruled != null) return ruled;
  if (booking.deposit_required_cents == null || booking.deposit_required_cents === '') return null;
  const stored = Number(booking.deposit_required_cents);
  return Number.isSafeInteger(stored) && stored >= 0 ? stored : null;
}

module.exports = {
  LONG_STAY_NIGHTS,
  LONG_STAY_RATE_CENTS,
  SHORT_STAY_RATE_CENTS,
  wolfhouseStayNights,
  wolfhouseStayDepositRateCents,
  wolfhouseStayDepositCents,
  wolfhouseBookingDepositCents,
};
