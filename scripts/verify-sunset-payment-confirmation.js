'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  buildConfirmationPreviewFromPlaybook,
  clearLunaMessagingPlaybookCache,
} = require('./lib/luna-client-messaging-playbook');

const ROOT = path.join(__dirname, '..');
const baseline = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'config/clients/sunset.baseline.json'),
  'utf8',
));

clearLunaMessagingPlaybookCache();

const fields = {
  guest_name: 'Francisco',
  booking_code: 'SUNSET-TEST-001',
  amount_paid_cents: 63000,
  balance_due_cents: 0,
  address: '',
  gate_code: '',
  room_number: '',
  include_balance_link: false,
};

const en = buildConfirmationPreviewFromPlaybook('sunset', 'en', fields);
assert.equal(en.ok, true, 'Sunset confirmation must come from a tenant playbook');
assert.equal(en.template_source, 'confirmation_templates');
assert.match(en.message, /payment received/i);
assert.match(en.message, /thank you/i);
assert.match(en.message, /SUNSET-TEST-001/);
assert.match(en.message, /€630/);
assert.match(en.message, /booking is confirmed/i);
assert.match(en.message, /(?:can(?:not|'t) wait|stoked).*(?:water|surf)/i);
assert.doesNotMatch(en.message, /Wolfhouse|gate code|room:/i);

const depositEn = buildConfirmationPreviewFromPlaybook('sunset', 'en', {
  ...fields,
  amount_paid_cents: 20000,
  balance_due_cents: 43000,
});
assert.equal(depositEn.ok, true);
assert.match(depositEn.message, /Balance due: €430/);
assert.match(depositEn.message, /booking is confirmed/i);
assert.doesNotMatch(depositEn.message, /all set|fully paid|paid in full/i);

const es = buildConfirmationPreviewFromPlaybook('sunset', 'es', fields);
assert.equal(es.ok, true);
assert.equal(es.template_source, 'confirmation_templates');
assert.match(es.message, /pago recibido/i);
assert.match(es.message, /gracias/i);
assert.match(es.message, /SUNSET-TEST-001/);
assert.match(es.message, /€630/);
assert.doesNotMatch(es.message, /Wolfhouse|código.*puerta|habitación:/i);

assert.equal(
  baseline.confirmation.confirmation_send_mode,
  'auto_after_payment_truth',
  'Sunset policy must allow the existing gated/idempotent webhook auto-send after authoritative payment truth',
);
assert.equal(baseline.confirmation.confirmation_requires_payment_truth, true);

console.log('verify-sunset-payment-confirmation: PASS');
