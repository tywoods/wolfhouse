'use strict';

/**
 * Capture ActualCost for luna-sunset-staging-rg (month-to-date).
 * Secret-free. Read-only. Writes JSON under tmp/foundation-slice9/.
 *
 * Usage: node scripts/capture-sunset-staging-rg-cost.js --phase before|after
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { TARGETS } = require('./lib/sunset-schema-observer-role-provision');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'tmp', 'foundation-slice9');

function azPath() {
  if (process.platform === 'win32') {
    return '"C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd"';
  }
  return 'az';
}

function azJson(argStr) {
  const out = execSync(`${azPath()} ${argStr}`, {
    encoding: 'utf8',
    maxBuffer: 5 * 1024 * 1024,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const s = String(out || '').replace(/^\uFEFF/, '').trim();
  const i = s.indexOf('{');
  if (i < 0) throw new Error('az returned no JSON');
  return JSON.parse(s.slice(i));
}

function main() {
  const idx = process.argv.indexOf('--phase');
  const phase = idx >= 0 ? process.argv[idx + 1] : 'snapshot';
  if (!['before', 'after', 'snapshot'].includes(phase)) {
    console.error('phase must be before|after|snapshot');
    process.exit(2);
  }

  const account = azJson('account show -o json');
  if (String(account.id) !== TARGETS.subscriptionId) {
    console.error('REFUSED: active subscription mismatch');
    process.exit(2);
  }

  const today = new Date();
  const from = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const to = today.toISOString().slice(0, 10);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const bodyPath = path.join(OUT_DIR, 'cost-query-body.json');
  fs.writeFileSync(
    bodyPath,
    `${JSON.stringify({
      type: 'ActualCost',
      timeframe: 'Custom',
      timePeriod: { from, to },
      dataset: {
        granularity: 'None',
        aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
      },
    })}\n`,
  );

  const url =
    `https://management.azure.com/subscriptions/${TARGETS.subscriptionId}`
    + `/resourceGroups/${TARGETS.resourceGroup}`
    + '/providers/Microsoft.CostManagement/query?api-version=2023-11-01';
  const j = azJson(
    `rest --method post --url ${JSON.stringify(url)} --body @${bodyPath} -o json`,
  );
  const row = (j.properties && j.properties.rows && j.properties.rows[0]) || [null, null];
  if (row[0] == null) {
    console.error('REFUSED: cost amount unavailable');
    process.exit(2);
  }

  const report = {
    type: 'ActualCost',
    scope: `/subscriptions/${TARGETS.subscriptionId}/resourceGroups/${TARGETS.resourceGroup}`,
    period: { from, to, label: 'month-to-date' },
    amount: row[0],
    currency: row[1] || 'EUR',
    capturedAt: new Date().toISOString(),
    phase,
  };
  const outFile = path.join(OUT_DIR, `cost-${phase}.json`);
  fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
  console.log(`wrote ${path.relative(ROOT, outFile)}`);
}

main();
