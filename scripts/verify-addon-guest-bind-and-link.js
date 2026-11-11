'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  bindAddonRequestToGuest,
  addonCreateResponseAfterWrite,
  addonSavedButLinkFailedReply,
  shouldWaitForGuestAnswer,
} = require('./lib/luna-guest-addon-guest-bind');

const guests = [
  { booking_guest_id: 'g1', guest_number: 1, guest_name: 'Jim' },
  { booking_guest_id: 'g2', guest_number: 2, guest_name: 'James' },
  { booking_guest_id: 'g3', guest_number: 3, guest_name: 'Timmy' },
];

const yoga = bindAddonRequestToGuest({ guest_name: 'Timmy' }, guests);
assert.equal(yoga.booking_guest_id, 'g3');
assert.equal(yoga.guest_name, 'Timmy');

const dinner = bindAddonRequestToGuest({ guest_name: 'Timmy', service_type: 'meal' }, guests);
assert.equal(dinner.booking_guest_id, 'g3');

const booker = bindAddonRequestToGuest({ guest_name: 'Ty' }, guests);
assert.equal(booker, null, 'booker name is not a guest row');

const afterWrite = addonCreateResponseAfterWrite({
  write_performed: true,
  checkout_url: null,
  stripe_error: 'Stripe session creation failed',
  guest_name: 'Timmy',
  service_type: 'yoga',
});
assert.equal(afterWrite.status, 201);
assert.equal(afterWrite.body.success, true);
assert.equal(afterWrite.body.write_performed, true);
assert.equal(afterWrite.body.payment_link_created, false);
assert.match(afterWrite.body.reply_draft, /added/i);
assert.doesNotMatch(afterWrite.body.reply_draft, /hasn.t been booked or charged/i);

const asked = 'Do you already have a scheduled day in mind during 1–5 April, or would you prefer to leave the date open for now?';
assert.equal(shouldWaitForGuestAnswer({ last_outbound: asked, inbound_after: false }), true);
assert.equal(shouldWaitForGuestAnswer({ last_outbound: asked, inbound_after: true }), false);

const soul = fs.readFileSync(path.join(__dirname, '../docker/hermes-staging/SOUL.md'), 'utf8');
assert.match(soul, /wait for (their|the) (answer|next message)/i);
assert.match(soul, /write_performed/);

const extras = fs.readFileSync(path.join(__dirname, '../docker/hermes-staging/soul-guides/10-packages-extras.md'), 'utf8');
assert.match(extras, /wait for (their|the) (answer|next message)/i);

const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
assert.match(api, /bindAddonRequestToGuest/);
assert.match(api, /booking_guest_id/);
assert.match(api, /addonCreateResponseAfterWrite/);

assert.equal(typeof addonSavedButLinkFailedReply, 'function');

console.log('verify-addon-guest-bind-and-link: PASS');
