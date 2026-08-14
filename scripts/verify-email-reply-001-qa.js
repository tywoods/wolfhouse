'use strict';

/**
 * EMAIL-REPLY-001-QA — release gate for email subject + standing reply.
 * This gate never turns a switch on. It is a SKIP until both the explicit
 * outbound switch and the feature-owned behavioral verifier are available.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = process.env.EMAIL_REPLY_QA_ROOT
  ? path.resolve(process.env.EMAIL_REPLY_QA_ROOT)
  : path.join(__dirname, '..');
const GATE = path.join(ROOT, 'scripts/verify-email-reply-001-ui.js');

if (String(process.env.EMAIL_STAFF_OUTBOUND_ENABLED || '').trim().toLowerCase() !== 'true') {
  console.log('SKIP EMAIL-REPLY-001-QA — outbound is off; subject/send cases did not run.');
  process.exit(0);
}
if (!fs.existsSync(GATE)) {
  console.log('SKIP EMAIL-REPLY-001-QA — subject/standing-reply feature verifier is not present; no pass claimed.');
  process.exit(0);
}

const fallbackNodeModules = '/opt/data/workspace/sandbox-repos/WH-seadog/node_modules';
const nodePath = [process.env.NODE_PATH, fs.existsSync(fallbackNodeModules) ? fallbackNodeModules : '']
  .filter(Boolean).join(path.delimiter);
const result = spawnSync(process.execPath, [GATE], {
  cwd: ROOT,
  encoding: 'utf8',
  env: { ...process.env, NODE_PATH: nodePath, EMAIL_STAFF_OUTBOUND_ENABLED: 'true' },
});
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
if (result.error || result.status !== 0) throw new Error('EMAIL-REPLY-001-QA feature verifier failed');

const output = String(result.stdout || '') + String(result.stderr || '');
for (const expected of [
  'subject visible and never emailv1',
  'subject defaults to Re:',
  'changed subject sends without Save draft',
  'same conversation clears reply and shows Email sent',
  'PASS verify-email-reply-001-ui',
]) {
  if (!output.includes(expected)) throw new Error(`EMAIL-REPLY-001-QA missing behavioral evidence: ${expected}`);
}
console.log('PASS EMAIL-REPLY-001-QA — subject, standing reply, same conversation, cleared composer, sent bar');
