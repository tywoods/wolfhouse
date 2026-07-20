'use strict';

/**
 * verify:fortress-tenant-identity-boundary-matrix — FORTRESS Slice 15A
 *
 * Offline audit gate: machine-readable tenant identity / confused-deputy
 * boundary matrix + RED/GREEN attack cases. No network, no DB, no live
 * mutation, no real secrets.
 *
 * Exit 0 on pass, nonzero on failure.
 */

const fs = require('fs');
const path = require('path');

const {
  VERDICTS,
  isVerdict,
  classifyStripeMetadataPaymentBinding,
  classifyBotTenantOverride,
  classifyWhatsAppIngressTenant,
  classifySunsetLocationBinding,
  classifyPortalSessionTenant,
  scanSecretFreeText,
  summarizeVerdictCounts,
} = require('./lib/fortress-tenant-identity-boundary');

const {
  resolveInboundTenant,
  loadClientRegistry,
  loadChannelRoutingConfig,
  buildChannelResolver,
} = require('./lib/client-channel-resolver');

const { getAccessibleClientSlugs } = require('./lib/staff-portal-clients');
const { validateStripeBookingPaymentEvent } = require('./lib/stripe-webhook-payment-truth');
const { resolveSunsetPhoneNumberId } = require('./lib/sunset-hermes-tenant-router');

const ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'fortress-tenant-identity');
const MATRIX_PATH = path.join(FIXTURE_DIR, 'boundary-matrix.json');
const CASES_PATH = path.join(FIXTURE_DIR, 'attack-cases.json');
const DOC_PATH = path.join(ROOT, 'docs', 'FORTRESS-TENANT-IDENTITY-BOUNDARY-MATRIX.md');

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
    return true;
  }
  fail += 1;
  console.log(`  FAIL  ${name}`);
  if (detail) console.log(`        ${detail}`);
  return false;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function includesStr(hay, needle) {
  return String(hay || '').includes(String(needle || ''));
}

console.log('verify:fortress-tenant-identity-boundary-matrix — FORTRESS Slice 15A\n');

// ── Fixture presence ────────────────────────────────────────────────────────
ok('F1 matrix fixture exists', fs.existsSync(MATRIX_PATH));
ok('F2 attack-cases fixture exists', fs.existsSync(CASES_PATH));
ok('F3 matrix doc exists', fs.existsSync(DOC_PATH));

const matrix = readJson(MATRIX_PATH);
const casesDoc = readJson(CASES_PATH);

ok('F4 matrix schema_version=1', matrix.schema_version === 1);
ok('F5 audit_only + no live mutation flags', matrix.audit_only === true && matrix.live_mutation === false);
ok('F6 master_basis pinned', matrix.master_basis === '32b44930685450cb27ac519d052332be7b18150d');
ok('F7 boundaries non-empty array', Array.isArray(matrix.boundaries) && matrix.boundaries.length >= 10);

const counts = summarizeVerdictCounts(matrix.boundaries);
ok('F8 all boundaries have allowed verdicts', counts.total === matrix.boundaries.length);

const requiredFields = [
  'id', 'name', 'chain', 'source_identity', 'trusted_principal',
  'untrusted_tenant_fields', 'conflict_behavior', 'db_scope_predicate',
  'payment_secret_account_binding', 'cross_tenant_object_id_behavior',
  'evidence', 'tests', 'verdict',
];
let schemaOk = true;
for (const b of matrix.boundaries) {
  for (const f of requiredFields) {
    if (b[f] == null) {
      schemaOk = false;
      ok(`F9 field ${f} on ${b.id || '?'}`, false, 'missing');
    }
  }
  if (!isVerdict(b.verdict)) {
    schemaOk = false;
    ok(`F9 verdict on ${b.id}`, false, b.verdict);
  }
}
ok('F9 boundary schema complete', schemaOk);

ok('F10 vulnerable count > 0 (fail-closed audit found issues)', counts.vulnerable >= 1);
ok('F11 unproven not silently marked safe', counts.unproven >= 1 || matrix.classification_policy === 'fail_closed_absence_is_unproven');

const sel = matrix.slice_15b_selection;
ok('F12 exactly one 15B selection', sel && sel.selected === true && sel.boundary_id === 'B13_stripe_webhook_payment_lookup');
ok('F13 15B owner files listed', Array.isArray(sel.owner_files) && sel.owner_files.length >= 1);
ok('F14 15B acceptance tests listed', Array.isArray(sel.acceptance_tests) && sel.acceptance_tests.length >= 3);

ok('F15 expected verdict counts preserved',
  counts.proven_fail_closed === 5
  && counts.proven_isolated_by_runtime === 3
  && counts.unproven === 3
  && counts.vulnerable === 4
  && counts.total === 15);

const b13 = matrix.boundaries.find((b) => b.id === 'B13_stripe_webhook_payment_lookup');
const b14 = matrix.boundaries.find((b) => b.id === 'B14_stripe_locked_payment_identity');
const b13Blob = JSON.stringify(b13 || {});
ok('F16 B13 severity high not critical',
  b13 && b13.severity === 'high' && b13.severity !== 'critical' && b13.verdict === 'vulnerable');
ok('F17 B13 documents upstream isolation (signature + tenant-isolated runtime/secret/DB)',
  b13
  && b13.upstream_isolation_documented === true
  && /signature/i.test(String(b13.verdict_rationale || ''))
  && /tenant-isolated/i.test(String(b13.verdict_rationale || ''))
  && Array.isArray(b13.exploit_preconditions)
  && b13.exploit_preconditions.some((p) => /signature/i.test(String(p)))
  && b13.exploit_preconditions.some((p) => /shared DB|trusted-server|account compromise|misbound/i.test(String(p))));
ok('F18 B13 does not label current unauthenticated exploit',
  b13
  && b13.current_unauthenticated_exploit === false
  && !/arbitrary unauthenticated/i.test(b13Blob)
  && /not a current unauthenticated exploit/i.test(String(b13.verdict_rationale || ''))
  && /not an unauthenticated ingress/i.test(String(b13.conflict_behavior || '')));
ok('F19 B13 current vs future SaaS blast radius documented',
  b13
  && includesStr(b13.current_blast_radius, 'tenant-isolated')
  && includesStr(b13.future_saas_blast_radius, 'Cross-tenant'));
ok('F20 B14 compounding control gap (not independent direct exploit)',
  b14
  && b14.severity === 'medium'
  && /compounding/i.test(String(b14.verdict_rationale || ''))
  && /not an independent direct exploit/i.test(String(b14.verdict_rationale || '')));
ok('F21 findings_ranked B13 high; B14 medium compounding',
  Array.isArray(matrix.findings_ranked)
  && matrix.findings_ranked[0]
  && matrix.findings_ranked[0].boundary_id === 'B13_stripe_webhook_payment_lookup'
  && matrix.findings_ranked[0].severity === 'high'
  && matrix.findings_ranked.some((f) => f.boundary_id === 'B14_stripe_locked_payment_identity'
    && f.severity === 'medium'
    && /compounding/i.test(String(f.title || ''))));
ok('F22 15B rationale cites payment truth independent tenant binding',
  sel && /payment truth/i.test(String(sel.rationale || ''))
  && /tenant binding/i.test(String(sel.rationale || ''))
  && !/critical/i.test(String(sel.rationale || '')));

// ── Secret scan fixtures + doc ──────────────────────────────────────────────
console.log('\n── Secret-free scan ──');
for (const rel of [
  'fixtures/fortress-tenant-identity/boundary-matrix.json',
  'fixtures/fortress-tenant-identity/attack-cases.json',
  'docs/FORTRESS-TENANT-IDENTITY-BOUNDARY-MATRIX.md',
  'scripts/lib/fortress-tenant-identity-boundary.js',
  'scripts/verify-fortress-tenant-identity-boundary-matrix.js',
]) {
  const abs = path.join(ROOT, rel);
  const text = fs.readFileSync(abs, 'utf8');
  const hits = scanSecretFreeText(text);
  ok(`S secret-free ${rel}`, hits.length === 0, hits.join(','));
}

// ── Static evidence: cited paths exist + key symbols present ───────────────
console.log('\n── Static evidence ──');
const mustExist = new Set();
for (const b of matrix.boundaries) {
  for (const e of b.evidence || []) {
    if (e.path && !e.path.includes('#')) mustExist.add(e.path);
  }
}
for (const p of mustExist) {
  ok(`E exists ${p}`, fs.existsSync(path.join(ROOT, p)));
}

const staffApi = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const stripeTruth = fs.readFileSync(path.join(ROOT, 'scripts/lib/stripe-webhook-payment-truth.js'), 'utf8');
const metaWh = fs.readFileSync(path.join(ROOT, 'scripts/lib/luna-meta-whatsapp-webhook.js'), 'utf8');
const portalClients = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-clients.js'), 'utf8');
const channelResolver = fs.readFileSync(path.join(ROOT, 'scripts/lib/client-channel-resolver.js'), 'utf8');

ok('E DEFAULT_CLIENT hardcoded wolfhouse-somo',
  /const DEFAULT_CLIENT\s*=\s*'wolfhouse-somo'/.test(staffApi));
ok('E handleBotBookingCreate trustedClientSlug from body',
  /trustedClientSlug:\s*clientSlug/.test(staffApi)
  && /body\.client_slug \|\| DEFAULT_CLIENT/.test(staffApi));

// B13 live-code evidence: historical 15A audit stays frozen in matrix/attack-cases.
// When Slice 15B remediation overlay exists, assert remediating patterns instead of
// re-asserting the pre-fix vulnerable SQL shape against live code.
const remediationOverlayPath = path.join(FIXTURE_DIR, 'slice15b-b13-remediation-overlay.json');
const has15bRemediation = fs.existsSync(remediationOverlayPath);
if (has15bRemediation) {
  const overlay = readJson(remediationOverlayPath);
  ok('E B13 remediated via 15B overlay (historical matrix untouched)',
    overlay
    && overlay.boundary_id === 'B13_stripe_webhook_payment_lookup'
    && overlay.historical_audit_unchanged === true
    && overlay.status === 'remediated'
    && /expectedClientSlug/.test(stripeTruth)
    && /cl\.slug = \$2/.test(stripeTruth)
    && /metadata_client_slug_required/.test(stripeTruth));
  ok('E validateStripeBookingPaymentEvent retains metadata mismatch check',
    /if \(metaClientSlug && metaClientSlug !== pm\.client_slug\)/.test(stripeTruth)
    && /payment_client_slug_mismatch/.test(stripeTruth));
} else {
  ok('E Stripe lookup falls back to metadata.payment_id without client_id in WHERE',
    /WHERE p\.id = \$1::uuid/.test(stripeTruth)
    && /metaPaymentId/.test(stripeTruth)
    && !/WHERE p\.id = \$1::uuid[\s\S]{0,80}client_id/.test(stripeTruth));
  ok('E validateStripeBookingPaymentEvent optional client_slug check',
    /if \(metaClientSlug && metaClientSlug !== pm\.client_slug\)/.test(stripeTruth));
}

// B06 live-code evidence: historical 15A audit stays frozen. When Slice 15E
// remediation overlay exists, assert remediating patterns instead of unbound bot.
const remediation15eOverlayPath = path.join(FIXTURE_DIR, 'slice15e-b06-remediation-overlay.json');
const has15eRemediation = fs.existsSync(remediation15eOverlayPath);
if (has15eRemediation) {
  const overlay15e = readJson(remediation15eOverlayPath);
  ok('E B06 remediated via 15E overlay (historical matrix untouched)',
    overlay15e
    && overlay15e.boundary_id === 'B06_staff_bot_auth_principal'
    && overlay15e.historical_audit_unchanged === true
    && overlay15e.status === 'remediated'
    && /buildStaffBotAuthPrincipal/.test(staffApi)
    && /bot_principal_tenant_unconfigured/.test(staffApi)
    && /auth_mode:\s*'bot_token'/.test(staffApi));
  ok('E getAccessibleClientSlugs binds luna-bot-internal to client_slug',
    /staff_user_id === 'luna-bot-internal'/.test(portalClients)
    && /client_slug/.test(portalClients)
    && /if \(!user\.email\) return all/.test(portalClients));
} else {
  ok('E requireBotAuth returns luna-bot-internal without client_id',
    /staff_user_id:\s*'luna-bot-internal'/.test(staffApi)
    && /auth_mode:\s*'bot_token'/.test(staffApi));
  ok('E getAccessibleClientSlugs returns all when !user.email',
    /if \(!user \|\| !user\.email\) return all/.test(portalClients));
}
ok('E Meta DEFAULT_CLIENT_SLUG wolfhouse-somo',
  /DEFAULT_CLIENT_SLUG = 'wolfhouse-somo'/.test(metaWh));
ok('E Meta attachTenantChannelShadow does not overwrite client_slug',
  /tenant_channel_shadow: shadow/.test(metaWh)
  && /client_slug: clientSlug/.test(metaWh));
ok('E resolver never Wolfhouse fallback on unknown',
  /never Wolfhouse/.test(channelResolver)
  && /unknown_channel_identity/.test(channelResolver));
ok('E Sunset bot handlers force tenant comment present',
  /FORCE client_slug=sunset|forced — body cannot override tenant|FORCES client_slug=sunset/i.test(staffApi));

// ── Dynamic RED/GREEN attack cases ──────────────────────────────────────────
console.log('\n── Attack cases (RED/GREEN) ──');
ok('C1 attack cases non-empty', Array.isArray(casesDoc.cases) && casesDoc.cases.length >= 10);

const registry = loadClientRegistry();
const channelConfig = loadChannelRoutingConfig();
const resolver = buildChannelResolver(registry, channelConfig);

let redCount = 0;
let greenCount = 0;

for (const c of casesDoc.cases) {
  const label = `${c.color} ${c.id}`;
  if (c.color === 'RED') redCount += 1;
  if (c.color === 'GREEN') greenCount += 1;

  const input = c.input || {};
  const expect = c.expect || {};
  let actual;

  try {
    switch (input.classifier) {
      case 'whatsapp_ingress':
        actual = classifyWhatsAppIngressTenant(input);
        ok(label, actual.verdict === expect.verdict
          && (!expect.reason_includes || includesStr(actual.reason, expect.reason_includes)),
        JSON.stringify(actual));
        break;

      case 'resolver_blocked': {
        const result = resolveInboundTenant({
          channel: 'whatsapp',
          phone_number_id: input.phone_number_id,
        }, { registry, resolver });
        ok(label, result.blocked === expect.blocked && result.reason === expect.reason,
          JSON.stringify(result));
        break;
      }

      case 'resolver_hit': {
        const result = resolveInboundTenant({
          channel: 'whatsapp',
          phone_number_id: input.phone_number_id,
        }, { registry, resolver });
        ok(label, result.blocked === expect.blocked
          && result.client_slug === expect.client_slug
          && result.location_id === expect.location_id,
        JSON.stringify(result));
        break;
      }

      case 'sunset_location':
        actual = classifySunsetLocationBinding(input);
        ok(label, actual.verdict === expect.verdict
          && (expect.ok == null || actual.ok === expect.ok)
          && (!expect.reason_includes || includesStr(actual.reason, expect.reason_includes)),
        JSON.stringify(actual));
        break;

      case 'bot_override':
        actual = classifyBotTenantOverride(input);
        ok(label, actual.verdict === expect.verdict
          && (!expect.effective_client_slug || actual.effective_client_slug === expect.effective_client_slug)
          && (!expect.reason_includes || includesStr(actual.reason, expect.reason_includes)),
        JSON.stringify(actual));
        break;

      case 'portal_session':
        actual = classifyPortalSessionTenant(input);
        ok(label, actual.verdict === expect.verdict
          && (expect.ok == null || actual.ok === expect.ok)
          && (!expect.reason_includes || includesStr(actual.reason, expect.reason_includes)),
        JSON.stringify(actual));
        break;

      case 'stripe_metadata_binding':
        actual = classifyStripeMetadataPaymentBinding(input);
        ok(label, actual.verdict === expect.verdict
          && (expect.ok == null || actual.ok === expect.ok)
          && (!expect.reason_includes || includesStr(actual.reason, expect.reason_includes)),
        JSON.stringify(actual));
        break;

      case 'stripe_validate_helper': {
        // 15A historical cases model optional metadata.client_slug checks.
        // Pass matching expectedClientSlug so independent 15B tenant bind does not
        // rewrite the historical metadata-optional assertion surface.
        const expectedSlug = (input.pm && input.pm.client_slug) || 'sunset';
        const reasons = validateStripeBookingPaymentEvent(
          input.pm,
          input.session,
          input.eventType,
          expectedSlug,
        );
        if (expect.reasons_include) {
          ok(label, reasons.includes(expect.reasons_include), JSON.stringify(reasons));
        } else if (expect.reasons_exclude) {
          ok(label, !reasons.includes(expect.reasons_exclude)
            && expect.proves === 'vulnerable_optional_client_slug_check',
          JSON.stringify(reasons));
        } else {
          ok(label, false, 'missing expect');
        }
        break;
      }

      case 'bot_acl_emailless': {
        // Historical RED fixture proves pre-15E unbound bot got all clients.
        // With 15E overlay, live code must fail closed (empty) for unbound bot.
        const slugs = getAccessibleClientSlugs({ role: 'operator', staff_user_id: 'luna-bot-internal' });
        const need = expect.includes_both || [];
        if (has15eRemediation) {
          ok(label,
            Array.isArray(slugs) && slugs.length === 0,
            JSON.stringify(slugs));
        } else {
          ok(label, need.every((s) => slugs.includes(s)), JSON.stringify(slugs));
        }
        break;
      }

      case 'registry_location_unique': {
        const lids = [];
        for (const client of registry.clients) {
          for (const loc of client.locations || []) {
            if (loc.location_id) lids.push(loc.location_id);
          }
        }
        const unique = new Set(lids).size === lids.length;
        ok(label, unique === expect.unique
          && lids.includes('sunset-somo') === expect.has_sunset_somo
          && lids.includes('sunset-sardinero') === expect.has_sunset_sardinero
          && lids.includes('wolfhouse-somo') === expect.has_wolfhouse_somo,
        JSON.stringify(lids));
        break;
      }

      case 'conflict_fields': {
        const effectiveFrom = input.body_client_slug ? 'body'
          : (input.query_client ? 'query' : 'header');
        const bot = classifyBotTenantOverride({
          auth_mode: 'bot_token',
          handler_policy: input.handler_policy,
          body_client_slug: input.body_client_slug,
          runtime_client_slug: input.header_runtime_client_slug,
        });
        ok(label, effectiveFrom === expect.effective_from && bot.verdict === expect.verdict,
          JSON.stringify({ effectiveFrom, bot }));
        break;
      }

      default:
        ok(label, false, `unknown classifier ${input.classifier}`);
    }
  } catch (err) {
    ok(label, false, err.message);
  }
}

ok('C2 has both RED and GREEN cases', redCount >= 5 && greenCount >= 5);

// ── Sunset router module fail-closed smoke (env sample, no secrets) ─────────
console.log('\n── Module smokes ──');
try {
  resolveSunsetPhoneNumberId('PNID_SOMO', {
    SUNSET_SOMO_WHATSAPP_PHONE_NUMBER_ID: 'PNID_SOMO',
    SUNSET_SARDINERO_WHATSAPP_PHONE_NUMBER_ID: 'PNID_SARDINERO',
  });
  ok('M1 sunset router maps Somo', true);
} catch (err) {
  ok('M1 sunset router maps Somo', false, err.message);
}
let threw = false;
try {
  resolveSunsetPhoneNumberId('PNID_UNKNOWN', {
    SUNSET_SOMO_WHATSAPP_PHONE_NUMBER_ID: 'PNID_SOMO',
  });
} catch (_) {
  threw = true;
}
ok('M2 sunset router unknown fail closed', threw);

let dupThrew = false;
try {
  resolveSunsetPhoneNumberId('PNID_X', {
    SUNSET_SOMO_WHATSAPP_PHONE_NUMBER_ID: 'PNID_SAME',
    SUNSET_SARDINERO_WHATSAPP_PHONE_NUMBER_ID: 'PNID_SAME',
  });
} catch (_) {
  dupThrew = true;
}
ok('M3 sunset router duplicate ids fail closed', dupThrew);

// ── Doc ↔ matrix consistency ────────────────────────────────────────────────
console.log('\n── Doc consistency ──');
const doc = fs.readFileSync(DOC_PATH, 'utf8');
ok('D1 doc cites Slice 15A', /FORTRESS Slice 15A|Slice 15A/.test(doc));
ok('D2 doc cites B13 / 15B selection', /B13_stripe_webhook_payment_lookup/.test(doc) && /15B/.test(doc));
ok('D3 doc states audit-only / zero live mutation', /audit only|zero live mutation|no live mutation/i.test(doc));
ok('D4 doc includes verdict counts section', /proven_fail_closed|Verdict counts/i.test(doc));
for (const v of VERDICTS) {
  ok(`D5 doc mentions verdict ${v}`, doc.includes(v));
}
ok('D6 doc classifies B13 high not critical',
  /\*\*High — B13\*\*/.test(doc)
  && /`vulnerable` \*\*\(high\)\*\*/.test(doc)
  && !/\*\*Critical — B13\*\*/.test(doc)
  && !/`vulnerable` \*\*\(critical\)\*\*/.test(doc));
ok('D7 doc states B13 not unauthenticated / documents isolation preconditions',
  /not a claim that arbitrary unauthenticated/i.test(doc)
  && /tenant-isolated runtime/i.test(doc)
  && /Stripe signature verification/i.test(doc)
  && /future SaaS/i.test(doc));
ok('D8 doc frames B14 as compounding control gap',
  /\*\*Medium — B14\*\*/.test(doc)
  && /Compounding control gap/i.test(doc)
  && /not an independent direct exploit/i.test(doc));
ok('D9 doc has no trailing whitespace lines',
  !doc.split(/\n/).some((line) => /[ \t]+$/.test(line)));

console.log(`\n── Verdict counts (matrix) ──`);
console.log(`  proven_fail_closed:         ${counts.proven_fail_closed}`);
console.log(`  proven_isolated_by_runtime: ${counts.proven_isolated_by_runtime}`);
console.log(`  unproven:                   ${counts.unproven}`);
console.log(`  vulnerable:                 ${counts.vulnerable}`);
console.log(`  total boundaries:           ${counts.total}`);
console.log(`  RED cases: ${redCount}  GREEN cases: ${greenCount}`);

ok('Z1 assertion floor still 83+', pass >= 83);

console.log(`\n── fortress-tenant-identity: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
console.log('OK — Slice 15A matrix + RED/GREEN gates green (audit only, zero live mutation).');
process.exit(0);
