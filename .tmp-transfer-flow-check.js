'use strict';
const { detectBookingReadyToProceed } = require('./scripts/lib/luna-booking-intake-policy');
const { defaultTransferScheduledAtLocal } = require('./scripts/lib/booking-transfers');

console.log('ready', detectBookingReadyToProceed("That's it for now"));
console.log('default arrival', defaultTransferScheduledAtLocal({
  direction: 'arrival',
  booking: { check_in: '2026-09-01', check_out: '2026-09-08' },
  client_slug: 'wolfhouse-somo',
}));
