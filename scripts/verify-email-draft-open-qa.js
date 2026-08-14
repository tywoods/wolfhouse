'use strict';
/** EMAIL-DRAFT-OPEN-QA — feature-release gate; it never enables generation/send. */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = process.env.EMAIL_DRAFT_OPEN_QA_ROOT ? path.resolve(process.env.EMAIL_DRAFT_OPEN_QA_ROOT) : path.join(__dirname, '..');
const GATE = path.join(ROOT, 'scripts/verify-email-draft-open-ui.js');
if (!fs.existsSync(GATE)) {
  console.log('SKIP EMAIL-DRAFT-OPEN-QA — generate-on-open verifier absent; no draft/send behavior passed.');
  process.exit(0);
}
const nodePath = [process.env.NODE_PATH, '/opt/data/workspace/sandbox-repos/WH-seadog/node_modules'].filter(fs.existsSync).join(path.delimiter);
const result = spawnSync(process.execPath, [GATE], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, NODE_PATH: nodePath } });
process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
if (result.error || result.status !== 0) throw new Error('EMAIL-DRAFT-OPEN-QA feature verifier failed');
const output = String(result.stdout || '') + String(result.stderr || '');
for (const expected of [
  'email open generates one editable draft with no Generate button',
  'staff edit then Approve & send does not auto-send',
  'draft contains no invented prices availability or bookings',
  'PASS verify-email-draft-open-ui',
]) if (!output.includes(expected)) throw new Error(`EMAIL-DRAFT-OPEN-QA missing behavioral evidence: ${expected}`);
console.log('PASS EMAIL-DRAFT-OPEN-QA — open draft, editable human approval, no auto-send, grounded content');
