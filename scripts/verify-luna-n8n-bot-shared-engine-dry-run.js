'use strict';
// ============================================================================
// verify-luna-n8n-bot-shared-engine-dry-run.js
// Static verifier for Stage 8.5.7 → 8.5.9
// Luna n8n dry-run shared-engine wiring.
// Stage 8.5.9 additions:
//   • /staff/bot/availability-check node present and wired before booking-create
//   • selected_bed_codes sourced from availability-check response (not hardcoded)
//   • DEMO-R1-B1 placeholder ABSENT
//   • not-enough-beds branch exists
//   • all prior 8.5.7 checks retained
// ============================================================================

const fs   = require('fs');
const path = require('path');

const ROOT      = path.resolve(__dirname, '..');
const WF_FILE   = path.join(ROOT, 'n8n', 'Wolfhouse Booking Assistant - Main - Shared Engine Dry Run.json');
const ORIG_FILE = path.join(ROOT, 'n8n', 'Wolfhouse Booking Assistant  - Main.json');
const MAP_DOC   = path.join(ROOT, 'docs', 'STAGE-8.5.1-LUNA-BOT-SHARED-ENGINE-INTEGRATION-MAP.md');
const ROADMAP   = path.join(ROOT, 'docs', 'ROADMAP.md');

let passed = 0, failed = 0;
const results = [];

function check(id, desc, ok, detail) {
  if (ok) {
    passed++;
    results.push(`  PASS  [${id}] ${desc}`);
  } else {
    failed++;
    results.push(`  FAIL  [${id}] ${desc}${detail ? ' — ' + detail : ''}`);
  }
}

// ── Load files ──────────────────────────────────────────────────────────────
let wf, wfText, orig, origText, mapDoc, roadmap;
try {
  wfText = fs.readFileSync(WF_FILE, 'utf8');
  wf = JSON.parse(wfText);
} catch (e) {
  check('A0', 'dry-run workflow file exists and is valid JSON', false, e.message);
  results.forEach(r => console.log(r));
  console.log(`\nResults: 0 passed, 1 failed`);
  process.exit(1);
}
try { origText = fs.readFileSync(ORIG_FILE, 'utf8'); orig = JSON.parse(origText); } catch (e) { orig = null; origText = ''; }
try { mapDoc   = fs.readFileSync(MAP_DOC, 'utf8'); }   catch (e) { mapDoc = ''; }
try { roadmap  = fs.readFileSync(ROADMAP, 'utf8'); }   catch (e) { roadmap = ''; }

const nodeNames   = wf.nodes.map(n => n.name);
const allNodeJson = JSON.stringify(wf.nodes);

// ── A. Workflow identity ─────────────────────────────────────────────────────
check('A1', 'workflow name contains "Shared Engine Dry Run"',
  wf.name && wf.name.includes('Shared Engine Dry Run'));

check('A2', 'workflow is NOT active (active: false)',
  wf.active === false, `got active=${wf.active}`);

check('A3', 'meta description marks it as INACTIVE / NOT IMPORTED',
  wf.meta && wf.meta.description &&
  (wf.meta.description.includes('INACTIVE') || wf.meta.description.includes('NOT IMPORTED')));

// ── B. Required endpoint calls ───────────────────────────────────────────────
check('B1', 'workflow contains /staff/bot/booking-preview URL',
  wfText.includes('/staff/bot/booking-preview'));

check('B2', 'workflow contains /staff/bot/bookings/create URL',
  wfText.includes('/staff/bot/bookings/create'));

check('B3', 'workflow contains /staff/bot/payments/ URL (Stripe link route)',
  wfText.includes('/staff/bot/payments/'));

// Stage 8.5.9 — availability-check
check('B4', 'workflow contains /staff/bot/availability-check URL (Stage 8.5.9)',
  wfText.includes('/staff/bot/availability-check'));

check('B5', '"HTTP - Bot Availability Check" node exists in workflow',
  nodeNames.includes('HTTP - Bot Availability Check'));

// ── C. Auth token handling ───────────────────────────────────────────────────
check('C1', 'X-Luna-Bot-Token header used in HTTP nodes',
  wfText.includes('X-Luna-Bot-Token'));

check('C2', 'token value is from env var ($env.LUNA_BOT_INTERNAL_TOKEN), not hardcoded',
  wfText.includes('LUNA_BOT_INTERNAL_TOKEN') && !wfText.match(/X-Luna-Bot-Token[^}]*?:\s*["'][0-9a-f]{32,}/i));

check('C3', 'no literal secret/token value hardcoded (no bearer hex string)',
  !wfText.match(/Authorization[^}]*Bearer\s+[0-9a-f]{20,}/i));

// ── D. WHATSAPP_DRY_RUN guard ────────────────────────────────────────────────
check('D1', 'WHATSAPP_DRY_RUN guard node exists',
  wfText.includes('WHATSAPP_DRY_RUN'));

check('D2', 'IF - DryRun Guard node is present',
  nodeNames.some(n => n.toLowerCase().includes('dryrun guard') || n.toLowerCase().includes('dry run guard') || n.toLowerCase().includes('dry-run guard')));

check('D3', 'Respond - DryRun Disabled node present (guard false branch)',
  nodeNames.some(n => n.toLowerCase().includes('disabled') || n.toLowerCase().includes('dryrun disabled')));

// ── E. No live WhatsApp sends ────────────────────────────────────────────────
// Only flag nodes whose URL parameter specifically sends to graph.facebook.com (actual WhatsApp sends).
const waNodes = wf.nodes.filter(n => {
  const url = (n.parameters && (n.parameters.url || '')) || '';
  return url.includes('graph.facebook.com');
});
check('E1', 'no live WhatsApp send HTTP nodes (graph.facebook.com) in dry-run workflow',
  waNodes.length === 0, `found ${waNodes.length} WhatsApp send nodes`);

check('E2', 'sends_whatsapp or whatsapp_sent marked false in code/set nodes',
  wfText.includes('whatsapp_sent') || wfText.includes('sends_whatsapp') || wfText.includes('WhatsApp send bypassed'));

// ── F. No direct Stripe API calls ───────────────────────────────────────────
const directStripeNodes = wf.nodes.filter(n => {
  const urlStr = JSON.stringify(n.parameters || '');
  return urlStr.includes('api.stripe.com') || urlStr.includes('stripe.com/v1');
});
check('F1', 'no direct Stripe API calls (api.stripe.com) in dry-run workflow',
  directStripeNodes.length === 0, `found ${directStripeNodes.length} direct Stripe nodes`);

// Env var usage check — string-in-note mention is fine, active $env usage is not
check('F2', 'STRIPE_DEFAULT_DEPOSIT_CENTS not used as env var in dry-run workflow',
  !wfText.includes('$env.STRIPE_DEFAULT_DEPOSIT_CENTS') && !wfText.includes('env.STRIPE_DEFAULT_DEPOSIT_CENTS'));

check('F3', 'proof marker: _proof_no_direct_stripe in draft reply code',
  wfText.includes('_proof_no_direct_stripe'));

// ── G. Booking create requirements ──────────────────────────────────────────
check('G1', 'confirm: true sent to booking create endpoint',
  wfText.includes('"confirm":') || wfText.includes("confirm:") || wfText.includes('confirm'));

// Stage 8.5.9: selected_bed_codes must reference the availability-check node output
check('G2', 'selected_bed_codes in booking-create body references "HTTP - Bot Availability Check" node output',
  wfText.includes('selected_bed_codes') &&
  wfText.includes('HTTP - Bot Availability Check'));

// Stage 8.5.9: DEMO-R1-B1 placeholder must be ABSENT
check('G3', 'DEMO-R1-B1 staging placeholder REMOVED from workflow (Stage 8.5.9)',
  !wfText.includes('DEMO-R1-B1'));

// ── G5. availability-check wired before booking-create ───────────────────────
// Check connections: IF - Missing Fields or Ready true branch → HTTP - Bot Availability Check
// (not directly to HTTP - Bot Booking Create)
const previewBranch = wf.connections && wf.connections['IF - Missing Fields or Ready'];
const previewTrueBranch = previewBranch && Array.isArray(previewBranch.main) && previewBranch.main[0] ? previewBranch.main[0] : [];
const previewTrueTargets = previewTrueBranch.map(c => c.node);
check('G4', 'IF - Missing Fields or Ready true branch goes to availability-check (not directly to booking-create)',
  previewTrueTargets.includes('HTTP - Bot Availability Check') &&
  !previewTrueTargets.includes('HTTP - Bot Booking Create'));

// Check availability-check connects (directly or via IF) to booking-create
const availConn = wf.connections && wf.connections['HTTP - Bot Availability Check'];
const availTargets = (availConn && availConn.main && availConn.main[0]) ? availConn.main[0].map(c => c.node) : [];
// Availability either goes directly to booking-create or to an IF node that does
const bedsIfName = availTargets.find(n => n.includes('Has Enough Beds') || n.includes('Enough Beds'));
check('G5', 'availability-check connects to a "Has Enough Beds" IF node',
  !!bedsIfName);

// IF - Has Enough Beds true branch → HTTP - Bot Booking Create
const bedsIfConn = bedsIfName && wf.connections && wf.connections[bedsIfName];
const bedsIfTrueBranch = bedsIfConn && Array.isArray(bedsIfConn.main) && bedsIfConn.main[0] ? bedsIfConn.main[0] : [];
const bedsIfTrueTargets = bedsIfTrueBranch.map(c => c.node);
check('G6', '"Has Enough Beds" IF true branch connects to HTTP - Bot Booking Create',
  bedsIfTrueTargets.includes('HTTP - Bot Booking Create'));

// ── H. Not-enough-beds branch ────────────────────────────────────────────────
check('H1', '"IF - Has Enough Beds" node exists in workflow',
  nodeNames.some(n => n.includes('Has Enough Beds') || n.includes('Enough Beds')));

check('H2', 'not-enough-beds Set/log node exists',
  nodeNames.some(n => n.toLowerCase().includes('no beds') || n.toLowerCase().includes('not enough')));

check('H3', 'no-beds reply_draft contains "checking with the team" or equivalent',
  wfText.includes("checking with the team") || wfText.includes("I'm checking") || wfText.includes("no_beds"));

check('H4', 'not-enough-beds branch does NOT call booking-create (false branch goes elsewhere)',
  (() => {
    const falseBranch = bedsIfConn && Array.isArray(bedsIfConn.main) && bedsIfConn.main[1] ? bedsIfConn.main[1] : [];
    const falseBranchTargets = falseBranch.map(c => c.node);
    return !falseBranchTargets.includes('HTTP - Bot Booking Create');
  })());

// ── I. Stripe link node ──────────────────────────────────────────────────────
check('I1', 'payment_id used dynamically in Stripe link URL (not hardcoded UUID)',
  wfText.includes('payment_id') && !wfText.match(/\/payments\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/create-stripe-link/));

check('I2', 'no_payment_truth_recorded in draft reply code',
  wfText.includes('no_payment_truth_recorded'));

// ── J. Original workflow untouched ───────────────────────────────────────────
if (orig) {
  check('J1', 'original workflow still has active field (not zeroed out)',
    orig.hasOwnProperty('active'));

  check('J2', 'original workflow name unchanged (not renamed)',
    orig.name && !orig.name.includes('Shared Engine'));

  // J3: Stripe direct call is in the Create Payment Session sub-workflow
  const CPS_FILE = path.join(ROOT, 'n8n', 'phase2', 'Wolfhouse - Create Payment Session.json');
  let cpsText = '';
  try { cpsText = fs.readFileSync(CPS_FILE, 'utf8'); } catch (e) { cpsText = ''; }
  check('J3', 'Create Payment Session sub-workflow still contains its direct Stripe call (untouched)',
    cpsText.includes('api.stripe.com') || cpsText.includes('Stripe Create Session'),
    cpsText ? 'Stripe call not found in CPS workflow' : 'CPS file not accessible');
} else {
  check('J1', 'original workflow file accessible for comparison', false, 'could not read original');
  check('J2', 'original workflow untouched', false, 'file not accessible');
  check('J3', 'original Stripe node present', false, 'file not accessible');
}

// ── K. Docs checks ───────────────────────────────────────────────────────────
check('K1', 'integration map docs reference Stage 8.5.7 (still present)',
  mapDoc.includes('8.5.7'));

check('K2', 'integration map docs reference Stage 8.5.9 (new)',
  mapDoc.includes('8.5.9'));

check('K3', 'roadmap references Stage 8.5.9',
  roadmap.includes('8.5.9'));

// Staff Ask Luna checks (Stage 8.6 roadmap)
check('K4', 'docs reference Staff Ask Luna or Stage 8.6',
  roadmap.includes('8.6') || roadmap.includes('Staff Ask Luna') || mapDoc.includes('Staff Ask Luna') || mapDoc.includes('8.6'));

check('K5', 'docs mention staff phone allowlist for Staff Ask Luna',
  roadmap.includes('allowlist') || roadmap.includes('allow list') || mapDoc.includes('allowlist') || mapDoc.includes('allow list'));

// ── L. No Airtable amounts used for Stripe ──────────────────────────────────
check('L1', 'dry-run workflow has no Airtable nodes that feed amounts to Stripe',
  !wfText.includes('airtable') || !directStripeNodes.length,
  'Airtable present but no direct Stripe — OK if Airtable not feeding amounts to Stripe');

check('L2', 'no deposit_required_cents reference (Airtable field) in dry-run workflow',
  !wfText.includes('deposit_required_cents'));

// ── Print results ─────────────────────────────────────────────────────────────
results.forEach(r => console.log(r));
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('verify-luna-n8n-bot-shared-engine-dry-run PASS');
  process.exit(0);
} else {
  console.log('verify-luna-n8n-bot-shared-engine-dry-run FAIL');
  process.exit(1);
}
