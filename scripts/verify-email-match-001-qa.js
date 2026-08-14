'use strict';

/**
 * EMAIL-MATCH-001-QA — test-only attach-release gate.
 *
 * Before the attach implementation lands this reports an explicit SKIP; it never
 * claims the unimplemented join/bind behavior passed. Once both focused gates
 * are present, it executes them and requires their behavior-labelled evidence.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = process.env.EMAIL_MATCH_QA_ROOT
  ? path.resolve(process.env.EMAIL_MATCH_QA_ROOT)
  : path.join(__dirname, '..');
const required = Object.freeze([
  Object.freeze({
    file: 'scripts/verify-inbox-email-match-ui.js',
    evidence: [
      'PASS EMAIL-MATCH-001-UI Inbox chrome person + honest unmatched card',
    ],
  }),
  Object.freeze({
    file: 'scripts/verify-email-inbound-match-ingest.js',
    evidence: [
      'two new mails same From+mailbox → one conversation',
      'exact same-tenant guest email binds existing guest only',
      'ambiguous same-tenant guest email stays unmatched',
      'PASS verify-email-inbound-match-ingest',
    ],
  }),
]);

const missing = required.filter((gate) => !fs.existsSync(path.join(ROOT, gate.file)));
if (missing.length) {
  console.log('SKIP EMAIL-MATCH-001-QA — awaiting Skipper attach implementation; missing: '
    + missing.map((gate) => gate.file).join(', '));
  process.exit(0);
}

for (const gate of required) {
  const absolute = path.join(ROOT, gate.file);
  const result = spawnSync(process.execPath, [absolute], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.error || result.status !== 0) {
    throw new Error(`EMAIL-MATCH-001-QA gate failed: ${gate.file}`);
  }
  const output = String(result.stdout || '') + String(result.stderr || '');
  for (const expected of gate.evidence) {
    if (!output.includes(expected)) {
      throw new Error(`EMAIL-MATCH-001-QA missing behavioral evidence in ${gate.file}: ${expected}`);
    }
  }
}

console.log('PASS EMAIL-MATCH-001-QA — header/email identity, honest unmatched card, same-From mailbox join, exact-only guest bind');
