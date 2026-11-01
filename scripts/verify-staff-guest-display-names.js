#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  buildWolfhouseOfferRevision,
  guestsFromCreateCommand,
} = require('./lib/luna-front-desk-accommodation-availability-service');

const rev = buildWolfhouseOfferRevision({
  client_slug: 'wolfhouse-somo',
  check_in: '2027-06-05',
  check_out: '2027-06-12',
  guest_count: 3,
  guest_bed_assignments: [
    { guest_index: 0, guest_name: 'Nathan Girard', bed_code: 'R1-1' },
    { guest_index: 1, guest_name: 'Inès', bed_code: 'R1-2' },
    { guest_index: 2, guest_name: 'Léo', bed_code: 'R1-3' },
  ],
});

assert.equal(rev.guest_bed_assignments[0].guest_name, 'Nathan Girard');
assert.equal(rev.guest_bed_assignments[1].guest_name, 'Inès', 'display spelling is not lowercased');
assert.equal(rev.guest_bed_assignments[2].guest_name, 'Léo');
assert.doesNotMatch(rev.guest_bed_assignments[1].guest_name, /Girard/);
assert.doesNotMatch(rev.guest_bed_assignments[2].guest_name, /Girard/);

const roster = guestsFromCreateCommand({
  guestsNorm: {
    guests: [
      { guest_name: 'Nathan Girard' },
      { guest_name: 'Inès' },
      { guest_name: 'Léo' },
    ],
  },
});
assert.deepEqual(roster.map((g) => g.name), ['Nathan Girard', 'Inès', 'Léo']);

const samePerson = buildWolfhouseOfferRevision({
  guest_bed_assignments: [
    { guest_index: 0, guest_name: 'Inès', bed_code: 'R1-1' },
  ],
});
const lower = buildWolfhouseOfferRevision({
  guest_bed_assignments: [
    { guest_index: 0, guest_name: 'inès', bed_code: 'R1-1' },
  ],
});
assert.equal(samePerson.offer_fingerprint, lower.offer_fingerprint,
  'fingerprint uses name key, not display case');

console.log('ok staff-guest-display-names');
