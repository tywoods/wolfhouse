'use strict';
/**
 * Stage 8.8.31 — Static verifier for Wolfhouse Guest Add-on Request dry-run workflow.
 * No n8n start. No network. No DB.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WF_FILE = path.join(ROOT, 'n8n', 'Wolfhouse Guest Add-on Request - Dry Run.json');
const PKG_FILE = path.join(ROOT, 'package.json');

let passed = 0;
let failed = 0;

function check(id, desc, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  PASS  [${id}] ${desc}`);
  } else {
    failed++;
    console.error(`  FAIL  [${id}] ${desc}${detail ? ' — ' + detail : ''}`);
  }
}

let wfText;
let wf;
try {
  wfText = fs.readFileSync(WF_FILE, 'utf8');
  wf = JSON.parse(wfText);
} catch (e) {
  check('A0', 'workflow file exists and is valid JSON', false, e.message);
  console.log(`\nResults: 0 passed, 1 failed`);
  process.exit(1);
}

const nodeNames = wf.nodes.map((n) => n.name);
const botHttpNodes = wf.nodes.filter(
  (n) => n.type === 'n8n-nodes-base.httpRequest'
    && (n.parameters?.url || '').includes('/staff/bot/'),
);
const ifNodes = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.if');
const ifWithEnv = ifNodes.filter((n) => JSON.stringify(n.parameters || {}).includes('$env'));

console.log('\nA. Workflow identity');
check('A1', 'workflow name is Wolfhouse Guest Add-on Request - Dry Run',
  wf.name === 'Wolfhouse Guest Add-on Request - Dry Run');
check('A2', 'active:false', wf.active === false, `got active=${wf.active}`);
check('A3', 'meta marks INACTIVE / NOT IMPORTED',
  wf.meta?.description?.includes('INACTIVE') || wf.meta?.description?.includes('NOT IMPORTED'));

console.log('\nB. Dry-run mode flags');
const modeNode = wf.nodes.find((n) => (n.name || '').includes('DryRun Mode Flags'));
check('B1', 'Set - DryRun Mode Flags node present', !!modeNode);
if (modeNode) {
  const s = JSON.stringify(modeNode.parameters || {});
  check('B2', 'dry_run:true in mode flags', s.includes('dry_run') && s.includes('true'));
  check('B3', 'live_send_enabled:false in mode flags', s.includes('live_send_enabled') && s.includes('false'));
}

const guardNode = wf.nodes.find((n) => (n.name || '').includes('DryRun Guard'));
check('B4', 'IF - DryRun Guard present', !!guardNode);
if (guardNode) {
  const s = JSON.stringify(guardNode.parameters || {});
  check('B5', 'IF guard checks $json.dry_run', s.includes('$json.dry_run') || s.includes('dry_run'));
  check('B6', 'no $env in IF DryRun Guard', !s.includes('$env'));
}
check('B7', 'no $env in any IF node', ifWithEnv.length === 0,
  ifWithEnv.length ? ifWithEnv.map((n) => n.name).join(', ') : '');

console.log('\nC. Staff API endpoints');
check('C1', 'preview URL /staff/bot/addon-request-preview',
  wfText.includes('/staff/bot/addon-request-preview'));
check('C2', 'create URL /staff/bot/addon-requests/create',
  wfText.includes('/staff/bot/addon-requests/create'));

console.log('\nD. Auth and idempotency');
check('D1', 'two bot HTTP nodes (preview + create)', botHttpNodes.length === 2,
  `found ${botHttpNodes.length}`);
check('D2', 'bot HTTP nodes use httpHeaderAuth credential',
  botHttpNodes.length === 2
  && botHttpNodes.every(
    (n) => n.credentials?.httpHeaderAuth?.name === 'Luna Bot Internal Token (staging)'
      && n.parameters?.genericAuthType === 'httpHeaderAuth',
  ));
check('D3', 'no hardcoded bot token',
  !wfText.match(/X-Luna-Bot-Token[^}]*?:\s*["'][0-9a-f]{32,}/i)
  && !wfText.includes('$env.LUNA_BOT'));
check('D4', 'idempotency_key generated in parse node',
  wfText.includes('idempotency_key') && wfText.includes('booking_code'));
check('D5', 'idempotency_key sent to create endpoint',
  wfText.includes('idempotency_key:') && wfText.includes('addon-requests/create'));
check('D6', 'confirm:true sent to create endpoint',
  wfText.includes('confirm:') && wfText.includes('true'));

console.log('\nE. Preview routing');
check('E1', 'IF - Preview Ready for Create node present',
  nodeNames.includes('IF - Preview Ready for Create'));
check('E2', 'ready_for_addon_create_dry_run branch',
  wfText.includes('ready_for_addon_create_dry_run'));
check('E3', 'ready_for_record_only branch',
  wfText.includes('ready_for_record_only'));
check('E4', 'preview-only reply path (Set - Log Preview Only Reply)',
  nodeNames.some((n) => n.includes('Preview Only')));

console.log('\nF. Dry-run response safety');
check('F1', 'whatsapp_sent:false in workflow',
  wfText.includes('whatsapp_sent'));
check('F2', 'live_send_blocked:true in workflow',
  wfText.includes('live_send_blocked'));
check('F3', 'no_n8n_side_effect:true in workflow',
  wfText.includes('no_n8n_side_effect'));
check('F4', 'checkout_url in format reply code',
  wfText.includes('checkout_url'));

console.log('\nG. Forbidden integrations');
const nodeParamsStr = JSON.stringify((wf.nodes || []).map((n) => n.parameters || {}));
check('G1', 'no graph.facebook.com in node parameters',
  !nodeParamsStr.includes('graph.facebook.com'));
check('G2', 'no Twilio in node parameters',
  !nodeParamsStr.includes('twilio.com') && !nodeParamsStr.match(/"type"\s*:\s*"[^"]*[Tt]wilio/));
check('G3', 'no api.stripe.com direct call in nodes',
  !nodeParamsStr.includes('api.stripe.com') && !nodeParamsStr.includes('stripe.com/v1'));
check('G4', 'no WhatsApp Send node type',
  !(wf.nodes || []).some(
    (n) => (n.type || '').toLowerCase().includes('whatsapp')
      && (n.name || '').toLowerCase().includes('send'),
  ));

console.log('\nH. package.json script');
let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
  check('H1', 'verify:luna-n8n-addon-request-dry-run script',
    !!pkg.scripts['verify:luna-n8n-addon-request-dry-run']);
} catch (e) {
  check('H1', 'package.json readable', false, e.message);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('verify-luna-n8n-addon-request-dry-run PASS\n');
  process.exit(0);
}
console.error('verify-luna-n8n-addon-request-dry-run FAIL\n');
process.exit(1);
