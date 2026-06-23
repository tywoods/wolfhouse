'use strict';
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const outPath = path.join(__dirname, '..', 'scripts', 'staff-query-api.js');
const patches = [
  'patch-admin-portal-v2.js',
  'patch-admin-fix8.js',
  'patch-admin-fix9.js',
];

console.log('Fetching staff-query-api.js from lunabox...');
const base = execSync(
  'ssh lunabox "cat /opt/wolfhouse/WH/scripts/staff-query-api.js"',
  { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
);
if (!base.includes('function adminRenderPackEditForm(')) {
  throw new Error('unexpected base file - missing adminRenderPackEditForm');
}
fs.writeFileSync(outPath, base, 'utf8');
console.log('Base written:', base.split('\n').length, 'lines');

for (const patchFile of patches) {
  const patchPath = path.join(__dirname, patchFile);
  console.log('Applying', patchFile, '...');
  execSync(`node "${patchPath}"`, { stdio: 'inherit', cwd: path.join(__dirname, '..') });
}

const s = fs.readFileSync(outPath, 'utf8');
const checks = [
  ['adminRenderPackEditForm defined', s.includes('function adminRenderPackEditForm(')],
  ['no renderAdminPackEditForm calls', !s.includes('renderAdminPackEditForm')],
  ['adminRenderPillReadout', s.includes('function adminRenderPillReadout(')],
  ['adminRenderPackScheduleReadout', s.includes('function adminRenderPackScheduleReadout(')],
  ['adminPackFormField', s.includes('function adminPackFormField(')],
  ['ADMIN_TIME_HM_RE', s.includes('ADMIN_TIME_HM_RE')],
  ['adminParseEurosToCentsOptional', s.includes('function adminParseEurosToCentsOptional(')],
  ['add-pack-schedule handler', s.includes("action === 'add-pack-schedule'")],
  ['humanize fixed', s.includes("new RegExp('\\\\b1 hour\\\\b'")],
  ['not bloated', s.split('\n').length < 41200],
];
for (const [name, ok] of checks) {
  if (!ok) throw new Error('check failed: ' + name);
  console.log('  ok:', name);
}
console.log('Final lines:', s.split('\n').length);
