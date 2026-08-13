'use strict';

/**
 * verify:gate-dates
 *
 * Keeps verify-*.js gates from rotting when the calendar moves.
 *
 * A gate whose fixture books '2026-07-10' tests private lessons until 2026-07-10, and tests
 * the calendar every day after. verify-sunset-private-lesson-luna-contract.js sat red for a
 * month that way: the schedule validator rejected the fixture as explicit_past_date long
 * before any private-lesson rule ran, so the gate proved nothing and blamed no one. Nothing
 * regressed. The date did.
 *
 * MAKE YOUR GATE IMMUNE — read the clock instead of writing a month:
 *
 *     function isoDaysFromNow(offset) {
 *       const d = new Date();
 *       d.setUTCDate(d.getUTCDate() + offset);
 *       return d.toISOString().slice(0, 10);
 *     }
 *     const DATE_FROM = isoDaysFromNow(30);
 *
 * A gate that calls Date.now() or new Date() with no arguments is treated as clock-derived
 * and is not scanned at all. That is the escape hatch and the intended fix: derive the
 * fixture, keep the relationships (a three-day span stays three days), and this gate leaves
 * you alone forever.
 *
 * WHAT FAILS: a hardcoded YYYY-MM-DD in a string literal that has already expired, or
 * expires within LEAD_DAYS. The lead time is the whole point — a fixture that dies next
 * week should go red while someone can still act on it, not on the morning it starts lying.
 *
 * WHAT IS NOT SCANNED: comments and regex literals (a date matched by a pattern is not a
 * fixture), impossible dates such as 2026-02-30 (validator fixtures, deliberately invalid),
 * years outside 2000–2100, and api-version literals (Azure REST versions are named after
 * dates but do not expire).
 *
 * ALLOWLIST: carrying an expired date is not by itself a bug. Most of these dates are inert
 * — nothing ever compares them to the clock — and failing on all of them would bury the few
 * that matter. Every allowlisted gate below was RUN, not guessed: each was executed with the
 * clock moved 31 days past every date it carries. Gates still green that way cannot be
 * decided by their dates. Gates already red for an unrelated reason could not be proven
 * either way and say so. An entry only covers dates up to its `through` value, so a date
 * added later is still checked. Unused entries fail, so the list cannot outlive the
 * exception it excuses.
 *
 * To re-run that proof for one gate — say, to promote it out of the unproven list — run it
 * under a Date shim pinned 31 days past its newest date and see whether it still passes.
 *
 * Offline: no database, no network, no test framework. Reads files only.
 *
 * Run:
 *   node scripts/verify-gate-dates.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const SELF = path.basename(__filename);

/** Days of notice before a fixture expires. */
const LEAD_DAYS = 30;

/** The day the allowlist below was measured, quoted in its reasons. */
const SEEDED_ON = '2026-08-13';

/**
 * Verified inert: run on 2026-08-13 with the clock moved 31 days past every date the gate
 * carries, and still green — so no date in it decides its result.
 * [gate, newest date covered]
 */
const INERT_THROUGH = [
  ['verify-booking-hold-expiry.js', '2026-07-16'],
  ['verify-crowsnest-ai-usage-adapter.js', '2026-07-21'],
  ['verify-crowsnest-ai-usage-contract.js', '2026-07-21'],
  ['verify-crowsnest-client-metrics-reporter.js', '2026-07-23'],
  ['verify-crowsnest-sales-approved-crm-sync.js', '2026-07-22'],
  ['verify-crowsnest-sales-ux.js', '2026-07-03'],
  ['verify-email-authority-bound-bounded-catchup-operation.js', '2026-08-06'],
  ['verify-email-authority-bound-inbound-operation.js', '2026-08-06'],
  ['verify-email-google-oauth-callback-consume.js', '2026-08-11'],
  ['verify-email-google-oauth-start.js', '2026-08-11'],
  ['verify-email-google-oauth-sunset-staging-runtime-composition.js', '2026-08-12'],
  ['verify-email-google-oauth-transaction-repository-consume.js', '2026-08-11'],
  ['verify-email-google-oauth-transaction-repository-create.js', '2026-08-11'],
  ['verify-email-google-onboarding-runtime-assembly.js', '2026-08-12'],
  ['verify-email-google-state-first-callback-runtime.js', '2026-08-12'],
  ['verify-email-google-state-first-runtime-composition.js', '2026-08-11'],
  ['verify-email-inbound-batch-processor.js', '2026-08-10'],
  ['verify-email-inbound-envelope-contract.js', '2026-08-10'],
  ['verify-email-luna-draft-author-deterministic.js', '2026-09-12'],
  ['verify-email-luna-draft-policy.js', '2026-08-12'],
  ['verify-email-microsoft-graph-adapter.js', '2026-08-01'],
  ['verify-email-microsoft-graph-delegated-messages-transport.js', '2026-01-01'],
  ['verify-email-microsoft-graph-immutableid-bounded-catchup-transport.js', '2026-08-06'],
  ['verify-email-microsoft-graph-immutableid-page-transport.js', '2026-08-06'],
  ['verify-email-microsoft-graph-messages-delta-page-transport.js', '2026-08-06'],
  ['verify-email-microsoft-graph-normalized-page.js', '2026-08-10'],
  ['verify-email-microsoft-oauth-operation-composition.js', '2026-08-05'],
  ['verify-email-microsoft-oauth-stage-telemetry.js', '2026-08-05'],
  ['verify-email-microsoft-phase-b-oauth-callback-composition.js', '2026-08-08'],
  ['verify-generic-rental-create-wiring.js', '2026-08-01'],
  ['verify-guest-addon-pricing.js', '2026-09-04'],
  ['verify-guest-room-type-supplement.js', '2026-07-13'],
  ['verify-inbox-thread-composite.js', '2026-08-11'],
  ['verify-inbox-view-routes.js', '2026-08-12'],
  ['verify-luna-catalog-services.js', '2026-08-05'],
  ['verify-luna-front-desk-accommodation-adapter.js', '2026-07-13'],
  ['verify-luna-front-desk-accommodation-availability-service.js', '2026-07-13'],
  ['verify-luna-front-desk-accommodation-booking-create-service.js', '2026-07-13'],
  ['verify-luna-front-desk-catalog-service.js', '2026-07-18'],
  ['verify-luna-front-desk-quote-service.js', '2026-07-20'],
  ['verify-luna-singular-person-date-range.js', '2026-08-05'],
  ['verify-luna-tenant-catalog-s1.js', '2026-08-17'],
  ['verify-luna-ux-quote-memory-deposit.js', '2026-09-02'],
  ['verify-owner-insight-agent-live.js', '2026-08-01'],
  ['verify-owner-insight-agent.js', '2026-08-01'],
  ['verify-per-guest-booking-payments.js', '2026-08-08'],
  ['verify-per-person-gear-room-pref.js', '2026-09-06'],
  ['verify-private-lesson-package-upsell.js', '2026-07-08'],
  ['verify-rental-admin-catalog-control.js', '2026-08-01'],
  ['verify-rental-invoice-line-text.js', '2026-09-04'],
  ['verify-rental-stock-slice-b.js', '2026-09-01'],
  ['verify-short-stay-booking-create.js', '2026-07-17'],
  ['verify-staff-automated-notifications-live.js', '2026-07-07'],
  ['verify-staff-automated-notifications-runner.js', '2026-07-07'],
  ['verify-staff-customers-crm.js', '2026-01-01'],
  ['verify-staff-email-google-oauth-routes.js', '2026-08-12'],
  ['verify-staff-email-registry-routes.js', '2026-01-02'],
  ['verify-staff-email-thread-body-render.js', '2026-08-10'],
  ['verify-staff-portal-private-room-ui.js', '2026-06-08'],
  ['verify-staff-running-invoice-display.js', '2026-08-01'],
  ['verify-staff-stormglass-forecast.js', '2026-06-17'],
  ['verify-staff-today-navigation-ui.js', '2026-08-06'],
  ['verify-sunset-accommodation-ui-hotfix.js', '2026-08-04'],
  ['verify-sunset-addon-price-duration-hotfix.js', '2026-07-30'],
  ['verify-sunset-batch-a1-f1-f3-cancel-hide.js', '2026-08-31'],
  ['verify-sunset-batch-d4-course-rental-quote.js', '2026-08-15'],
  ['verify-sunset-booking-component-boundary.js', '2026-07-23'],
  ['verify-sunset-booking-composition-contract.js', '2026-08-20'],
  ['verify-sunset-booking-drawer-summary.js', '2026-07-20'],
  ['verify-sunset-booking-unhide-action.js', '2026-08-10'],
  ['verify-sunset-bookings-admin-sort-type.js', '2026-07-12'],
  ['verify-sunset-combo-pricing-p0b.js', '2026-09-05'],
  ['verify-sunset-course-equipment-consolidation.js', '2026-09-01'],
  ['verify-sunset-course-equipment-money-matrix.js', '2026-09-03'],
  ['verify-sunset-course-equipment-pricing.js', '2026-09-03'],
  ['verify-sunset-course-equipment-quote-authority.js', '2026-09-02'],
  ['verify-sunset-course-equipment-slice-e.js', '2026-09-10'],
  ['verify-sunset-course-free-during-equipment-p2.js', '2026-08-01'],
  ['verify-sunset-course-included-equipment-production.js', '2026-08-12'],
  ['verify-sunset-course-lesson-db-pricing.js', '2026-07-21'],
  ['verify-sunset-drawer-auth-order.js', '2026-08-03'],
  ['verify-sunset-drawer-reconcile-bound.js', '2026-01-01'],
  ['verify-sunset-finance-data.js', '2026-07-16'],
  ['verify-sunset-finance-redesign-s1.js', '2026-07-16'],
  ['verify-sunset-finance-refund-net-s2.js', '2026-09-01'],
  ['verify-sunset-finance-revenue-by-product-f2.js', '2026-08-31'],
  ['verify-sunset-finance-summary.js', '2026-07-16'],
  ['verify-sunset-finance-ui-revisions.js', '2026-08-15'],
  ['verify-sunset-finance-ui.js', '2026-07-15'],
  ['verify-sunset-full-day-equipment-addon.js', '2026-08-01'],
  ['verify-sunset-generated-schedule-equipment.js', '2026-08-10'],
  ['verify-sunset-generic-admin-service-pricing.js', '2026-07-15'],
  ['verify-sunset-group-lesson-quote.js', '2026-07-23'],
  ['verify-sunset-guest-date-intake.js', '2026-08-02'],
  ['verify-sunset-luna-school-context.js', '2026-07-03'],
  ['verify-sunset-multi-lessons-contract.js', '2026-08-21'],
  ['verify-sunset-multi-lessons-production.js', '2026-08-21'],
  ['verify-sunset-no-baseline-group-lesson-seed.js', '2026-07-20'],
  ['verify-sunset-private-course-equipment-authority.js', '2026-09-01'],
  ['verify-sunset-private-quote-claim.js', '2026-08-25'],
  ['verify-sunset-rental-create-price-lookup-p1.js', '2026-08-20'],
  ['verify-sunset-rental-create-price-lookup-p1c.js', '2026-08-22'],
  ['verify-sunset-rental-labels-p0e.js', '2026-08-15'],
  ['verify-sunset-rental-quantity-create-edit.js', '2026-08-01'],
  ['verify-sunset-schedule-architecture.js', '2026-07-15'],
  ['verify-sunset-schedule-booking-lifecycle.js', '2026-08-10'],
  ['verify-sunset-schedule-data-loader.js', '2026-07-16'],
  ['verify-sunset-schedule-day-ops-board-ui.js', '2026-07-20'],
  ['verify-sunset-schedule-drawer-actions.js', '2026-07-01'],
  ['verify-sunset-schedule-forecast-cards-ui.js', '2026-07-20'],
  ['verify-sunset-schedule-navigation-ui.js', '2026-07-20'],
  ['verify-sunset-schedule-rental-availability.js', '2026-07-22'],
  ['verify-sunset-schedule-row-normalizer.js', '2026-07-15'],
  ['verify-sunset-schedule-view-grid-ui.js', '2026-07-31'],
  ['verify-sunset-staging-bicep-preflight.js', '2026-07-17'],
  ['verify-sunset-stripe-payment-webhook.js', '2026-07-15'],
  ['verify-sunset-waiver-staff.js', '2026-07-24'],
  ['verify-tenant-business-config.js', '2026-07-10'],
  ['verify-tenant-rental-price-resolver.js', '2026-08-01'],
  ['verify-tenant-rental-stock.js', '2026-08-15'],
  ['verify-tenant-services-writes.js', '2026-09-01'],
  ['verify-wolfhouse-admin-pricing.js', '2026-08-15'],
];

/**
 * Could not be verified: already red on 2026-08-13 for a reason that has nothing to do with
 * its dates, so moving the clock proved nothing. On the operator's triage list; re-run the
 * clock-moved check once the gate is green again and move it up or fix the fixture.
 * [gate, newest date covered, what it died of]
 */
const UNPROVEN_THROUGH = [
  ['verify-booking-drawer-equipment-reorg.js', '2026-08-11', 'verify:booking-drawer-equipment-reorg'],
  ['verify-crowsnest-ai-usage-store.js', '2026-07-23', 'forward count includes 050 (48) — forward=74'],
  ['verify-crowsnest-client-metrics-store.js', '2026-07-22', 'forward count includes 050 (48) — forward=74'],
  ['verify-crowsnest-sales-approved-crm-sync-attempts.js', '2026-07-23', 'forward count includes 050 (48) — forward=74'],
  ['verify-email-inbound-inbox-bridge.js', '2026-08-01', 'verify-email-inbound-inbox-bridge'],
  ['verify-factory-slice1d-integration-proof.js', '2026-04-08', 'verify:factory-slice1c-dry-run-generator exit 0'],
  ['verify-fortress-slice15f-bot-request-tenant-bind.js', '2026-08-01', 'GREEN guarded_inventory_wired'],
  ['verify-fortress-slice15j3-payment-uuid-callback-tenant-acl.js', '2026-07-28', 'RED staff_payment_foreign_and_nonexistent_identical_404_zero_writes'],
  ['verify-luna-front-desk-booking-create-service.js', '2026-07-18', 'manual_staff success'],
  ['verify-luna-front-desk-domain-contract.js', '2026-07-18', 'validate body shape ok pre-write'],
  ['verify-luna-future-course-equipment-incident.js', '2026-09-01', 'AssertionError [ERR_ASSERTION]: ordinary offering quote must not inve...'],
  ['verify-migration-integrity.js', '2026-07-20', 'green-manifest-integrity'],
  ['verify-radar-slice16aa-g02-live-sigint-evidence.js', '2026-07-21', 'not run at seeding: drives Azure CLI / deploy tooling'],
  ['verify-radar-slice16ab-g02-readyz503-evidence.js', '2026-07-21', 'not run at seeding: drives Azure CLI / deploy tooling'],
  ['verify-radar-slice16ac-organic-restart-alert-evidence.js', '2026-07-21', 'C1 HEAD on 16AC branch (tip may advance to 16AD)'],
  ['verify-radar-slice16ad-g02-sampled-restart-continuity-evidence.js', '2026-07-21', 'C3 HEAD on 16AD branch (tip may advance to 16AF)'],
  ['verify-radar-slice16b-staging-cost-budgets.js', '2020-01-01', 'not run at seeding: drives Azure CLI / deploy tooling'],
  ['verify-radar-slice16p-live-drill-evidence.js', '2026-07-20', 'C3 HEAD on 16P branch (tip may be 16W/16X)'],
  ['verify-radar-slice16s-request-log-live-evidence.js', '2026-01-01', 'C3 16S contract branch frozen (tip may advance to 16U/16W/16X)'],
  ['verify-radar-slice16x-g02-live-evidence.js', '2026-07-21', 'C3 HEAD on 16X branch (tip may advance to 16Y/16Z/16AA)'],
  ['verify-radar-slice16z-g02-live-sigterm-evidence.js', '2026-07-21', 'C3 HEAD on 16Z branch (tip may advance to 16AA)'],
  ['verify-sunset-admin-authoritative-1-to-7-day-pricing.js', '2026-08-21', 'ReferenceError: scheduleDrawerIsCourseLikeLine is not defined'],
  ['verify-sunset-admin-rental-availability.js', '2026-07-01', 'monolith group-level availability toggle present'],
  ['verify-sunset-backend-blockers.js', '2026-08-01', 'AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy v...'],
  ['verify-sunset-booking-activity-model.js', '2026-07-22', 'radiogroup role'],
  ['verify-sunset-booking-consent.js', '2026-08-02', 'literal true accepted at boundary'],
  ['verify-sunset-booking-create-draft-defaults.js', '2026-08-01', 'warm selects clicked course'],
  ['verify-sunset-booking-stepper-playwright.js', '2026-08-20', 'Playwright browser not available'],
  ['verify-sunset-bot-write-endpoints.js', '2026-08-01', 'write handlers never read client_slug/client from body'],
  ['verify-sunset-canonical-offering-pipeline.js', '2026-07-20', 'Luna weekend quote succeeds'],
  ['verify-sunset-course-equipment-booking-production.js', '2026-08-10', 'AssertionError [ERR_ASSERTION]: group create failed: {"success":false...'],
  ['verify-sunset-course-equipment-catalog.js', '2026-09-01', 'AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-e...'],
  ['verify-sunset-course-equipment-ui-playwright.js', '2026-08-14', 'Playwright browser not available'],
  ['verify-sunset-course-included-equipment.js', '2026-08-11', 'AssertionError [ERR_ASSERTION]: server accepts explicit boolean'],
  ['verify-sunset-create-course-drilldown.js', '2026-08-05', 'at main (/workspace/scripts/verify-sunset-create-course-drilldown.js:...'],
  ['verify-sunset-create-drawer-layout-equipment-quote-hotfix.js', '2026-08-23', 'surfers change resyncs non-user-owned qty'],
  ['verify-sunset-create-drawer-ux-followup.js', '2026-08-20', 'Create default selected qty is 1 (not surfers)'],
  ['verify-sunset-create-equipment-mobile-layout-playwright.js', '2026-08-10', 'at async /workspace/scripts/verify-sunset-create-equipment-mobile-lay...'],
  ['verify-sunset-create-footer-mobile-compact.js', '2026-08-02', 'ReferenceError: schedulePortalNormalizeLessonsIntent is not defined'],
  ['verify-sunset-create-private-drilldown.js', '2026-07-31', 'at main (/workspace/scripts/verify-sunset-create-private-drilldown.js...'],
  ['verify-sunset-drawer-update-luna.js', '2026-08-04', 'update succeeds'],
  ['verify-sunset-google-email-settings.js', '2026-08-12', 'Cannot find module \'../website/node_modules/happy-dom\''],
  ['verify-sunset-luna-admin-catalog.js', '2026-01-01', 'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:'],
  ['verify-sunset-multi-date-lesson-pricing.js', '2026-07-23', 'pricing ok'],
  ['verify-sunset-multi-lessons-edit-playwright.js', '2026-08-20', 'Playwright browser not available'],
  ['verify-sunset-multi-lessons-playwright.js', '2026-08-20', 'Playwright browser not available'],
  ['verify-sunset-rendered-ui-price-hotfix.js', '2026-07-30', 'shortMode gated in generated HTML'],
  ['verify-sunset-rental-drawer-projection.js', '2026-08-11', 'Playwright browser not available'],
  ['verify-sunset-rental-duration-pebbles-quickfix.js', '2026-08-20', 'common keys exactly configured hour/half-day (1-day absent)'],
  ['verify-sunset-rental-quantity-total-hotfix.js', '2026-07-31', 'components present but do not replace rentals'],
  ['verify-sunset-rental-surfer-label-edit-parity.js', '2026-08-01', 'rental qty min-height ≥ 36 shared CSS (touch)'],
  ['verify-sunset-schedule-create-multi-equipment-playwright.js', '2026-08-14', 'Playwright browser not available'],
  ['verify-sunset-schedule-drawer-edit-ui.js', '2026-07-26', 'TypeError: Cannot read properties of undefined (reading \'toggle\')'],
  ['verify-sunset-schedule-drawer-view-ui.js', '2026-09-12', 'ReferenceError: scheduleDrawerBookingIsCancelled is not defined'],
  ['verify-sunset-schedule-edit-multi-equipment-playwright.js', '2026-08-14', 'Playwright browser not available'],
  ['verify-sunset-schedule-edit-private-multi-equipment-playwright.js', '2026-08-10', 'Playwright browser not available'],
  ['verify-sunset-schedule-portal-module.js', '2026-08-22', 'buildUiHtml calls inject'],
  ['verify-sunset-schema-slice14ad.js', '2026-07-20', 'Error: manifest integrity failed'],
  ['verify-sunset-schema-slice14n.js', '2026-07-19', 'manifest-integrity'],
  ['verify-sunset-schema-slice14q.js', '2024-03-01', 'manifest-integrity'],
  ['verify-sunset-schema-slice14r.js', '2026-07-19', 'manifest-integrity'],
  ['verify-sunset-staff-schedule-date-boundary.js', '2026-08-02', 'POST /staff/schedule/bookings normalizes dates'],
  ['verify-sunset-staging-ledger-reconcile.js', '2026-08-01', 'Error: manifest integrity failed'],
];

const ALLOWLIST = [
  ...INERT_THROUGH.map(([gate, through]) => ({
    gate,
    through,
    reason: `verified inert — green on ${SEEDED_ON} with the clock moved 31 days past every date it carries`,
  })),
  ...UNPROVEN_THROUGH.map(([gate, through, died]) => ({
    gate,
    through,
    reason: `inertness unproven — already red on ${SEEDED_ON} for a non-date reason (${died})`,
  })),
];

let failures = 0;

function fail(message) {
  failures += 1;
  console.error(`  FAIL  ${message}`);
}

const ISO_DATE = /\d{4}-\d{2}-\d{2}/g;

/** Real calendar day in a plausible range — not 2026-02-30, not year 0099. */
function isRealDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  if (y < 2000 || y > 2100) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** A date is a fixture only when it is written into a string. Comments and regexes are not. */
function stringLiterals(src) {
  const out = [];
  let i = 0;
  let prev = '';
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    // A slash after an operator or an opening bracket starts a regex, never division.
    if (c === '/' && /[=(,:[!&|?{};+\-*%~^<>]/.test(prev)) {
      i += 1;
      let inClass = false;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) break;
        else if (src[i] === '\n') break;
        i += 1;
      }
      i += 1;
      prev = '/';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      const start = i;
      let raw = '';
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') { raw += src[i] + (src[i + 1] || ''); i += 2; continue; }
        if (src[i] === quote) break;
        if (quote !== '`' && src[i] === '\n') break;
        raw += src[i];
        i += 1;
      }
      i += 1;
      out.push({ raw, index: start });
      prev = quote;
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return out;
}

/** Azure REST versions are named after a date and never expire. */
const API_VERSION_CONTEXT = /api[-_]?version["'\s:=]*$/i;

/** No argument means "now": the fixture moves with the calendar and cannot rot. */
const CLOCK_READ = /\bDate\.now\(\s*\)|\bnew Date\(\s*\)/;

function collectDates(src) {
  const found = new Map();
  for (const literal of stringLiterals(src)) {
    const before = src.slice(Math.max(0, literal.index - 32), literal.index);
    if (API_VERSION_CONTEXT.test(before)) continue;
    ISO_DATE.lastIndex = 0;
    let match = ISO_DATE.exec(literal.raw);
    while (match) {
      const iso = match[0];
      if (isRealDate(iso) && !found.has(iso)) {
        found.set(iso, src.slice(0, literal.index).split('\n').length);
      }
      match = ISO_DATE.exec(literal.raw);
    }
  }
  return found;
}

const todayIso = new Date().toISOString().slice(0, 10);
const MS_PER_DAY = 86400000;
function daysUntil(iso) {
  return Math.round(
    (Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / MS_PER_DAY,
  );
}

function describe(remaining) {
  if (remaining < 0) return `expired ${-remaining} day${remaining === -1 ? '' : 's'} ago`;
  if (remaining === 0) return 'expires today';
  return `expires in ${remaining} day${remaining === 1 ? '' : 's'}`;
}

const allowlist = new Map();
for (const entry of ALLOWLIST) {
  if (allowlist.has(entry.gate)) fail(`duplicate allowlist entry: ${entry.gate}`);
  if (!entry.reason) fail(`allowlist entry without a reason: ${entry.gate}`);
  if (!isRealDate(String(entry.through))) fail(`allowlist entry without a valid through date: ${entry.gate}`);
  allowlist.set(entry.gate, entry);
}
const usedAllowlist = new Set();

const gateFiles = fs.readdirSync(SCRIPTS)
  .filter((f) => f.startsWith('verify-') && f.endsWith('.js') && f !== SELF)
  .sort();

console.log(`\nverify:gate-dates  (${gateFiles.length} gates, ${LEAD_DAYS} days of notice, today ${todayIso})\n`);

let clockDerived = 0;
let gatesWithDates = 0;
let datesChecked = 0;
let expired = 0;
let expiringSoon = 0;

for (const gate of gateFiles) {
  const src = fs.readFileSync(path.join(SCRIPTS, gate), 'utf8');
  const dates = collectDates(src);
  if (!dates.size) continue;
  if (CLOCK_READ.test(src)) {
    clockDerived += 1;
    continue;
  }
  gatesWithDates += 1;

  const entry = allowlist.get(gate);
  const offending = [];
  for (const [iso, line] of [...dates].sort()) {
    datesChecked += 1;
    const remaining = daysUntil(iso);
    if (remaining > LEAD_DAYS) continue;
    if (entry && iso <= entry.through) {
      usedAllowlist.add(gate);
      continue;
    }
    if (remaining < 0) expired += 1;
    else expiringSoon += 1;
    offending.push({ iso, line, remaining });
  }
  if (!offending.length) continue;

  // One failure per gate: the whole fixture set is one repair, and a gate carrying a
  // dozen dead dates should not push the next gate off the screen.
  const shown = offending.slice(0, 3).map((d) => `${d.iso} (${describe(d.remaining)})`).join(', ');
  const more = offending.length > 3 ? ` and ${offending.length - 3} more` : '';
  const noun = offending.length === 1 ? 'date' : 'dates';
  fail(`${gate}:${offending[0].line} — ${offending.length} hardcoded fixture ${noun}: ${shown}${more}`);
}

for (const [gate, entry] of allowlist) {
  if (usedAllowlist.has(gate)) continue;
  fail(`stale allowlist entry — ${gate} no longer carries an unexpired-through-${entry.through} hardcoded date (fixed, deleted, or now clock-derived); delete the entry`);
}

console.log(`  scanned ${datesChecked} hardcoded dates across ${gatesWithDates} gates`);
console.log(`  skipped ${clockDerived} gates that derive their dates from the clock`);
console.log(`  allowlisted ${usedAllowlist.size} of ${allowlist.size} entries`);
if (expired) console.log(`  expired dates: ${expired}`);
if (expiringSoon) console.log(`  dates expiring within ${LEAD_DAYS} days: ${expiringSoon}`);

console.log('');
if (failures) {
  console.error(`verify:gate-dates FAILED (${failures})`);
  console.error('Derive the fixture from the clock (see the header), or allowlist the gate with a reason.');
} else {
  console.log('verify:gate-dates PASSED — no gate fixture is expired or about to expire');
}

process.exit(failures ? 1 : 0);
