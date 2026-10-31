'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const staging = path.join(root, 'docker', 'hermes-staging');
const guideDir = path.join(staging, 'soul-guides');
const guides = [
  '01-core-voice-language.md',
  '02-greeting-intake.md',
  '03-info-questions.md',
  '04-dates-closed-season.md',
  '05-quote.md',
  '06-confirmation.md',
  '07-payment-choice-booking.md',
  '08-shuttle.md',
  '09-payments-after-booking.md',
  '10-packages-extras.md',
  '11-rooms.md',
  '12-changes-cancel.md',
  '13-handoff.md',
  '14-hard-rules.md',
];

const canonical = fs.readFileSync(path.join(staging, 'SOUL.md'));
const joined = Buffer.concat(guides.map((name) => fs.readFileSync(path.join(guideDir, name))));
assert.deepStrictEqual(joined, canonical, 'ordered guides must be byte-identical to SOUL.md');

const postBootstrap = fs.readFileSync(path.join(staging, '99z-wh-vm-post-bootstrap.sh'), 'utf8');
for (const name of guides) assert(postBootstrap.includes(name), `startup join omits ${name}`);
assert(postBootstrap.includes('cmp -s'), 'startup join must fail closed on canonical mismatch');
assert(postBootstrap.includes('HERMES_ROLE') && postBootstrap.includes('luna'), 'startup join must be Luna-scoped');

const dockerfile = fs.readFileSync(path.join(staging, 'Dockerfile'), 'utf8');
assert(/COPY\s+soul-guides\s+\/etc\/hermes-staging\/soul-guides/.test(dockerfile), 'image must include guide files');

console.log(`PASS: ${guides.length} Luna guides join byte-identically (${canonical.length} bytes)`);
