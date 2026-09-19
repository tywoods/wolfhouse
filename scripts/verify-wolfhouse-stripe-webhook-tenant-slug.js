'use strict';

/**
 * verify-wolfhouse-stripe-webhook-tenant-slug.js
 *
 * Regression gate for: guest pays Stripe checkout on staff-staging but portal
 * stays unpaid and no payment confirmation WhatsApp is sent.
 *
 * Root cause (proven by live env inventory + source):
 *   Wolfhouse staging intentionally leaves DEFAULT_CLIENT_SLUG unset (RADAR 16AN)
 *   and historically lacked STRIPE_WEBHOOK_CLIENT_SLUG. resolveStripeWebhookExpectedClientSlug
 *   then returned missing_runtime_client_slug → webhook 503 no_db_write → payment
 *   truth never applied → confirmation gated on paid status never ran.
 *
 * Booking-code casing in /pay/URLs (UPPER suffix) is intentional and case-insensitive
 * in DB lookup — not the failure mode.
 *
 * Offline only — no network, Stripe, DB, or deploy.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

const ROOT = path.join(__dirname, '..');
const {
  resolveStripeWebhookExpectedClientSlug,
} = require('./lib/stripe-webhook-tenant-config');

const WH_SLUG = 'wolfhouse-somo';
const SUNSET_SLUG = 'sunset';

function section(title) {
  console.log(`\n── ${title} ──`);
}

function check(name, cond, detail) {
  if (!cond) {
    console.error(`FAIL  ${name}${detail ? ' — ' + detail : ''}`);
    process.exitCode = 1;
    return false;
  }
  console.log(`PASS  ${name}`);
  return true;
}

section('A. Wolfhouse staging live shape (ingress only)');
{
  // Matches fixtures/radar-operations/slice16ao-raw-wh-*: DEFAULT absent,
  // STRIPE_WEBHOOK_CLIENT_SLUG absent, STAFF_API_INGRESS_TENANT_SLUG present.
  const liveShape = resolveStripeWebhookExpectedClientSlug({
    STAFF_API_INGRESS_TENANT_SLUG: WH_SLUG,
    STRIPE_WEBHOOK_SKIP_VERIFY: 'false',
    NODE_ENV: 'staging',
  });
  check('A1 ingress-only resolves wolfhouse-somo',
    liveShape.ok === true
    && liveShape.client_slug === WH_SLUG
    && liveShape.source === 'STAFF_API_INGRESS_TENANT_SLUG'
    && liveShape.no_db_write === false);
  check('A2 pre-fix shape (neither slug) still fail-closed',
    (() => {
      const missing = resolveStripeWebhookExpectedClientSlug({
        STRIPE_WEBHOOK_SKIP_VERIFY: 'false',
        NODE_ENV: 'staging',
      });
      return missing.ok === false
        && missing.reason === 'missing_runtime_client_slug'
        && missing.no_db_write === true;
    })());
}

section('B. Preferred dedicated webhook slug + IaC');
{
  const dedicated = resolveStripeWebhookExpectedClientSlug({
    STRIPE_WEBHOOK_CLIENT_SLUG: WH_SLUG,
    STAFF_API_INGRESS_TENANT_SLUG: WH_SLUG,
  });
  check('B1 STRIPE_WEBHOOK_CLIENT_SLUG preferred when aligned',
    dedicated.ok && dedicated.source === 'STRIPE_WEBHOOK_CLIENT_SLUG'
    && dedicated.client_slug === WH_SLUG);

  const bicepPath = path.join(ROOT, 'infra/azure/staging/main.bicep');
  const bicep = fs.readFileSync(bicepPath, 'utf8');
  check('B2 Wolfhouse staging Bicep declares STRIPE_WEBHOOK_CLIENT_SLUG=wolfhouse-somo',
    /name:\s*'STRIPE_WEBHOOK_CLIENT_SLUG'[\s\S]{0,80}value:\s*'wolfhouse-somo'/.test(bicep));
  check('B3 Wolfhouse staging Bicep keeps DEFAULT_CLIENT_SLUG unset (RADAR 16AN)',
    !/name:\s*'DEFAULT_CLIENT_SLUG'/.test(bicep)
    && /STAFF_API_INGRESS_TENANT_SLUG/.test(bicep));
  check('B4 skip-verify remains false-default in Bicep',
    /name:\s*'STRIPE_WEBHOOK_SKIP_VERIFY'[\s\S]{0,40}value:\s*'false'/.test(bicep));
}

section('C. Conflict / Sunset unchanged');
{
  const conflict = resolveStripeWebhookExpectedClientSlug({
    STRIPE_WEBHOOK_CLIENT_SLUG: WH_SLUG,
    STAFF_API_INGRESS_TENANT_SLUG: SUNSET_SLUG,
  });
  check('C1 webhook vs ingress conflict fail-closed',
    conflict.ok === false
    && conflict.reason === 'conflicting_runtime_client_slugs'
    && conflict.no_db_write === true);

  const sunsetCompat = resolveStripeWebhookExpectedClientSlug({
    STRIPE_WEBHOOK_CLIENT_SLUG: SUNSET_SLUG,
    DEFAULT_CLIENT_SLUG: SUNSET_SLUG,
  });
  check('C2 Sunset dual-slug shape still ok',
    sunsetCompat.ok && sunsetCompat.client_slug === SUNSET_SLUG);
}

section('D. Webhook handler still fail-closes before DB when unconfigured');
{
  const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
  const start = apiSrc.indexOf('async function handleStripeWebhook');
  assert.ok(start > 0, 'handleStripeWebhook present');
  // Function is long (claim + addon + booking truth + auto-confirm); take until next top-level route.
  const endMarker = apiSrc.indexOf('// Route: POST /staff/payments/:payment_id/create-stripe-link', start);
  const stripeFn = apiSrc.slice(start, endMarker > start ? endMarker : start + 40000);
  check('D1 resolveStripeWebhookExpectedClientSlug before lookupPaymentForStripeSession',
    /resolveStripeWebhookExpectedClientSlug[\s\S]{0,1200}lookupPaymentForStripeSession/.test(stripeFn));
  check('D2 tenant_unconfigured returns no_db_write',
    /webhook:stripe:tenant_unconfigured/.test(stripeFn)
    && /no_db_write:\s*true/.test(stripeFn));
  check('D3 confirmation auto-send is gated after payment truth (allow_auto_confirmation)',
    /allow_auto_confirmation/.test(stripeFn)
    && /tryAutoSendBookingConfirmation/.test(stripeFn));
}

section('E. Short /pay/ booking-code casing is case-insensitive (not this bug)');
{
  const shortSrc = fs.readFileSync(
    path.join(ROOT, 'scripts/lib/luna-payment-short-link.js'),
    'utf8',
  );
  check('E1 UPPER(booking_code) lookup remains case-insensitive',
    /UPPER\(b\.booking_code\)\s*=\s*UPPER\(\$2\)/.test(shortSrc));
}

if (process.exitCode) {
  console.error('\nverify-wolfhouse-stripe-webhook-tenant-slug: FAIL');
  process.exit(1);
}
console.log('\nverify-wolfhouse-stripe-webhook-tenant-slug: PASS');
