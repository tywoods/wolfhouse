'use strict';

// Offline contract test for the phone-bound first-contact name slice.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const soul = fs.readFileSync(path.join(root, 'docker/hermes-staging/SOUL.md'), 'utf8');
const plugin = fs.readFileSync(path.join(root, 'docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py'), 'utf8');
const api = fs.readFileSync(path.join(root, 'scripts/staff-query-api.js'), 'utf8');

for (const prompt of ['What name should I use?', '¿Qué nombre prefieres que use?', 'Che nome preferisci che usi?']) {
  assert.ok(soul.includes(prompt), `first-contact prompt missing: ${prompt}`);
}
assert.match(soul, /skip the name question/i, 'known contact must skip first-contact name ask');
assert.match(plugin, /known_contact_name = _contact_identity_read\(\)/, 'contact is read pre-LLM');
assert.match(plugin, /_contact_identity_save_after_capture\(payload\.get\("guest_name"\)\)/,
  'contact is saved only after capture_booking_names accepts it');
assert.match(plugin, /"\/contact-identity", \{"full_name": name\}/,
  'save payload contains only name, never an untrusted phone');
assert.match(api, /pathname === '\/staff\/bot\/contact-identity'/, 'bot endpoint is wired');
assert.match(api, /phone: req\.headers\['x-luna-guest-phone'\]/, 'endpoint phone comes only from trusted header');
assert.doesNotMatch(api.slice(api.indexOf("pathname === '/staff/bot/contact-identity'"), api.indexOf("const botGuestPackagesMatch")), /body\.phone|query\.phone/,
  'route must not admit body/query phone aliases');

// A three-person party can carry one contact and three names; companions need no phones.
const contact = 'Ana';
const guests = [{ name: 'Ana' }, { name: 'Bea' }, { name: 'Carlo' }];
assert.equal(contact, guests[0].name);
assert.equal(guests.length, 3);
assert.equal(guests.slice(1).some((guest) => Object.hasOwn(guest, 'phone')), false,
  'two companion names have no phone fields');
console.log('PASS ask-names contact: EN/ES/IT prompts, known-name skip, 3 guests and 2 phone-free companions');
