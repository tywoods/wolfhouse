'use strict';

/**
 * EMAIL-M1-QA-002 — staff email reply/send release gate.
 *
 * Never enables outbound. With the staging outbound switch off it reports SKIP.
 * Once an operator explicitly supplies EMAIL_STAFF_OUTBOUND_ENABLED=true, it runs
 * the offline cooked-portal test that proves the approved-send UI contract.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = process.env.EMAIL_M1_QA_ROOT
  ? path.resolve(process.env.EMAIL_M1_QA_ROOT)
  : path.join(__dirname, '..');
const GATE = path.join(ROOT, 'scripts/verify-staff-email-inbox-ui.js');

if (String(process.env.EMAIL_STAFF_OUTBOUND_ENABLED || '').trim().toLowerCase() !== 'true') {
  console.log('SKIP EMAIL-M1-QA-002 — outbound is off; no send case was executed or passed.');
  process.exit(0);
}
if (!fs.existsSync(GATE)) throw new Error('EMAIL-M1-QA-002 missing cooked staff email UI gate');

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
if (result.error || result.status !== 0) throw new Error('EMAIL-M1-QA-002 underlying staff email UI gate failed');

const output = String(result.stdout || '') + String(result.stderr || '');
for (const expected of [
  '200 committed clears reply',
  'Email sent bar hides after 20s window',
  '200 committed stays on one conversation',
  'verify:staff-email-inbox-ui PASSED',
]) {
  if (!output.includes(expected)) throw new Error(`EMAIL-M1-QA-002 missing behavioral evidence: ${expected}`);
}
console.log('PASS EMAIL-M1-QA-002 — type→Approve & send, cleared reply, ~20s sent bar, same conversation');
