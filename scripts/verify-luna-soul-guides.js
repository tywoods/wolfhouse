'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

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
// Contract proof, not a model-conversation test: catch the contradictory
// instruction that prevented the already-working save-first tool from being called.
function assertSaveFirst(text, label) {
  assert(!/(?:exactly one booking consent: the guest's deposit-or-full selection|deposit-or-full answer is (?:the sole )?create consent|payment selection is the single booking consent)/i.test(text),
    `${label}: payment-tier selection must not be the sole booking consent`);
  assert(/save first, then ask deposit or full, then send the selected links/i.test(text),
    `${label}: save / amount question / selected links order must be explicit`);
}
for (const name of guides.slice(4, 8)) {
  assertSaveFirst(fs.readFileSync(path.join(guideDir, name), 'utf8'), name);
}
assertSaveFirst(canonical.toString('utf8'), 'canonical SOUL');
// Boolean comparison avoids dumping two entire prompts on a parity failure.
assert(joined.equals(canonical), 'ordered guides must be byte-identical to SOUL.md');
const confirmation = fs.readFileSync(path.join(guideDir, guides[5]), 'utf8');
assert(/saved booking reference[\s\S]*ask deposit or full/i.test(confirmation),
  'amount-pending confirmation must disclose the saved reference before its question');
assert(/same saved booking/i.test(confirmation), 'later tier answer must reuse the saved booking');
assert(/stay remainder is due at arrival\/check-in, never checkout/i.test(confirmation),
  'canonical-only stay-remainder timing must survive guide reconciliation');
assert(/combined link does not defer the original stay remainder/i.test(confirmation),
  'service checkout terms must not defer the stay balance');
assert.throws(() => assertSaveFirst(confirmation + '\nThe deposit-or-full answer is the sole create consent.', 'regressed'),
  /must not be the sole booking consent/);
assert.throws(() => assertSaveFirst(confirmation.replace(/save first, then ask deposit or full, then send the selected links/i, ''), 'missing order'),
  /order must be explicit/);

const postBootstrap = fs.readFileSync(path.join(staging, '99z-wh-vm-post-bootstrap.sh'), 'utf8');
for (const name of guides) assert(postBootstrap.includes(name), `startup join omits ${name}`);
assert(postBootstrap.includes('cmp -s'), 'startup join must compare against canonical SOUL.md');
assert(postBootstrap.includes('HERMES_ROLE') && postBootstrap.includes('luna'), 'startup join must be Luna-scoped');

function assertAssembly(caseName, mutateGuides, expectWarning = true) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-soul-guides-'));
  const tempGuides = path.join(temp, 'guides');
  const home = path.join(temp, 'home');
  fs.cpSync(guideDir, tempGuides, { recursive: true });
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'SOUL.md'), expectWarning ? canonical : 'stale bootstrap prompt');
  const canonicalPath = path.join(temp, 'SOUL.md');
  fs.writeFileSync(canonicalPath, canonical);
  mutateGuides(tempGuides);

  const result = spawnSync('sh', [path.join(staging, '99z-wh-vm-post-bootstrap.sh')], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HERMES_ROLE: 'luna',
      HERMES_HOME: home,
      LUNA_SOUL_GUIDES_DIR: tempGuides,
      LUNA_SOUL_CANONICAL: canonicalPath,
      LUNA_SOUL_GUIDES_TEST_ONLY: '1',
    },
  });
  assert.strictEqual(result.status, 0, `${caseName}: startup must continue: ${result.stderr}`);
  if (expectWarning) assert.match(result.stderr, /warning/i, `${caseName}: must log a warning`);
  else assert(!/warning/i.test(result.stderr), `${caseName}: must assemble without fallback: ${result.stderr}`);
  const active = fs.readFileSync(path.join(home, 'SOUL.md'));
  assert(active.equals(canonical), `${caseName}: active prompt must match canonical`);
  assertSaveFirst(active.toString('utf8'), `${caseName}: active prompt`);
  fs.rmSync(temp, { recursive: true, force: true });
}

assertAssembly('matching guides', () => {}, false);
assertAssembly('missing guide', (tempGuides) => {
  fs.rmSync(path.join(tempGuides, guides[0]));
});
assertAssembly('guide drift', (tempGuides) => {
  fs.appendFileSync(path.join(tempGuides, guides[0]), 'drift');
});

const dockerfile = fs.readFileSync(path.join(staging, 'Dockerfile'), 'utf8');
assert(/COPY\s+soul-guides\s+\/etc\/hermes-staging\/soul-guides/.test(dockerfile), 'image must include guide files');

console.log(`PASS: ${guides.length} Luna guides join byte-identically (${canonical.length} bytes)`);
console.log('PASS: save-first contract in guides 05–08, canonical and assembled active prompt; contradiction mutations rejected');
console.log('PASS: real bootstrap assembly without warning; missing/drifted guides retain corrected canonical fallback');
