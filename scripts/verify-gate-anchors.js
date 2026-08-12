'use strict';

/**
 * verify:gate-anchors
 *
 * Keeps verify-*.js gates from rotting into no-ops.
 *
 * Gates locate product code by hardcoded string anchors — a literal such as a function
 * signature handed to indexOf — then slice, eval or assert on the result. When the target
 * is renamed the anchor stops matching: the slice comes back empty and the gate either
 * crashes or asserts against nothing, while looking like ordinary CI noise.
 * verify-staff-portal-private-room-ui.js sat dead that way for a month.
 *
 * This gate collects every string literal passed to .indexOf/.includes/.lastIndexOf/.search
 * in a gate, keeps the ones that look like source code, and fails when such an anchor no
 * longer resolves in any non-verify .js file under scripts/.
 *
 * Anchors that legitimately never resolve there — assertions that a string must be ABSENT,
 * anchors into Python/Bicep files, anchors matched against strings built at runtime — need
 * an ALLOWLIST entry with a reason, so the exception is a decision on the record. Unused
 * allowlist entries fail too, so the list cannot outlive the assertion it excuses.
 *
 * Offline: no database, no network, no test framework.
 *
 * Run:
 *   node scripts/verify-gate-anchors.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');

const LOOKUP_METHODS = ['indexOf', 'includes', 'lastIndexOf', 'search'];

/** Below this an anchor is a fragment, not a landmark. */
const MIN_ANCHOR_LENGTH = 12;

/**
 * Anchors that cannot resolve in scripts/*.js and are still correct.
 *
 *   negative    the gate asserts the string is ABSENT — resolving would be the bug
 *   external    the anchor targets a file outside scripts/*.js; `file` is re-checked here
 *   generated   the anchor is matched against a string built at runtime, not a file on disk
 *   disjunction the assertion is an || chain whose live branch is not a string lookup
 */
const ALLOWLIST = [
  {
    gate: 'verify-crowsnest.js',
    anchor: "require('./crowsnest-sales')",
    kind: 'negative',
    reason: 'Crowsnest page must not couple directly to the sales store; it goes through lib/crowsnest/.',
  },
  {
    gate: 'verify-email-microsoft-oauth-stage-telemetry.js',
    anchor: 'let stageLogger',
    kind: 'negative',
    reason: 'stage telemetry must have no ambient mutable logger to swap at runtime.',
  },
  {
    gate: 'verify-manual-booking-per-guest-package.js',
    anchor: 'function bcUpdateManualPriceOverrideVisibility',
    kind: 'negative',
    reason: 'the manual price override toggle was removed with the per-guest package rework.',
  },
  {
    gate: 'verify-manual-booking-per-guest-package.js',
    anchor: 'function bcSyncGuestPackagesToTop',
    kind: 'negative',
    reason: 'the guest-package re-sort helper was removed with the per-guest package rework.',
  },
  {
    gate: 'verify-manual-booking-per-guest-package.js',
    anchor: "t('calendar.create.missing.package')",
    kind: 'negative',
    reason: 'create no longer blocks on a missing top-level package, so the gate string must stay gone.',
  },
  {
    gate: 'verify-messi-saas-stage2d1-plan-status.js',
    anchor: "concat(parameters('appNamePrefix'), '-bootstrap')",
    kind: 'negative',
    reason: 'main.bicep must not re-derive the bootstrap job name, which overflowed the 32-char limit.',
  },
  {
    gate: 'verify-native-waiver-rollback.js',
    anchor: "require('./lib/tenant-external-waiver-settings')",
    kind: 'negative',
    reason: 'the rollback is only complete while nothing requires the external waiver settings module.',
  },
  {
    gate: 'verify-staff-customers-crm.js',
    anchor: 'function customerBadgeHtml(',
    kind: 'negative',
    reason: 'legacy badge renderer stays replaced by the display-tags chip renderer.',
  },
  {
    gate: 'verify-staff-portal-private-room-ui.js',
    anchor: "bcRenderFieldEditPencilBtn('private_room'",
    kind: 'negative',
    reason: 'private room lives in the guests row with a single edit pencil, not its own.',
  },
  {
    gate: 'verify-staff-whatsapp-notifications.js',
    anchor: "RecipientRemove(\\'' + type",
    kind: 'negative',
    reason: 'guards the recipient remove button against the broken template quoting it once shipped with.',
  },
  {
    gate: 'verify-sunset-admin-render.js',
    anchor: 'text.replace(/s+/g',
    kind: 'negative',
    reason: 'catches the whitespace regex losing its backslash again (/s+/ instead of /\\s+/).',
  },
  {
    gate: 'verify-sunset-admin-render.js',
    anchor: 'text.replace(/(d+) day pack surfer',
    kind: 'negative',
    reason: 'catches the day-pack digit regex losing its backslash again (/(d+)/ instead of /(\\d+)/).',
  },
  {
    gate: 'verify-sunset-google-email-settings.js',
    anchor: 'console.log(dto.authorizationUrl)',
    kind: 'negative',
    reason: 'the Gmail authorization URL carries credentials and must never be logged.',
  },
  {
    gate: 'verify-sunset-portal-calendar-tenant.js',
    anchor: "if (!data || !data.success){\n        populateClientSelect(null);",
    kind: 'negative',
    reason: 'a failed auth session must redirect to login, never fall back to the default tenant UI.',
  },
  {
    gate: 'verify-sunset-portal-v1.js',
    anchor: 'var scheduleManualBookings',
    kind: 'negative',
    reason: 'schedule bookings come from the API, never from an in-browser array.',
  },
  {
    gate: 'verify-sunset-portal-v1.js',
    anchor: ':root:not([data-theme="dark"]) #tab-portal-home .portal-schedule-ops-row.is-staff{background:linear-gradient',
    kind: 'negative',
    reason: 'the light-theme gradient wash on staff schedule rows stays removed (dark theme keeps it).',
  },
  {
    gate: 'verify-sunset-portal-v1.js',
    anchor: "portalT('schedule.drawer.school') + ': ' + scheduleResolveDrawerSchoolLabel",
    kind: 'negative',
    reason: 'the drawer shows the school value without a redundant label prefix.',
  },
  {
    gate: 'verify-sunset-schedule-booking-lifecycle.js',
    anchor: "portalT('schedule.drawer.removeFromSchedule')",
    kind: 'negative',
    reason: 'the drawer view uses the Delete booking i18n key; remove-from-schedule was retired.',
  },
  {
    gate: 'verify-sunset-schedule-booking-lifecycle.js',
    anchor: "portalT('schedule.drawer.removeFromSchedule",
    kind: 'negative',
    reason: 'the drawer actions use the Delete booking i18n keys; remove-from-schedule was retired.',
  },
  {
    gate: 'verify-sunset-schedule-day-ops-board-ui.js',
    anchor: 'function scheduleRenderOpsBoard(',
    kind: 'negative',
    reason: 'the ops board renderer stays extracted; an inline copy in the monolith is the regression.',
  },
  {
    gate: 'verify-sunset-schedule-forecast-cards-ui.js',
    anchor: 'function scheduleRenderWeekForecastCard(',
    kind: 'negative',
    reason: 'the forecast card renderer stays extracted out of staff-query-api.js.',
  },
  {
    gate: 'verify-sunset-schedule-forecast-cards-ui.js',
    anchor: 'function scheduleWireOpsBoardClicks(',
    kind: 'negative',
    reason: 'the ops board click wiring stays extracted out of staff-query-api.js.',
  },
  {
    gate: 'verify-sunset-schedule-view-grid-ui.js',
    anchor: 'function renderScheduleNext30Grid(',
    kind: 'negative',
    reason: 'the 30-day grid renderer stays extracted out of staff-query-api.js.',
  },
  {
    gate: 'verify-sunset-schedule-view-grid-ui.js',
    anchor: 'function renderScheduleOpsBoard(',
    kind: 'negative',
    reason: 'the ops board renderer stays extracted out of staff-query-api.js.',
  },

  {
    gate: 'verify-messi-saas-stage2c1-private-network.js',
    anchor: "module privateNetwork './private-network.bicep' = if (enablePrivateNetwork)",
    kind: 'external',
    file: 'infra/azure/modules/tenant-staging/main.bicep',
    reason: 'Bicep module wiring, not JavaScript.',
  },
  {
    gate: 'verify-radar-slice16h-staff-api-metric-alerts.js',
    anchor: "fail('wrong_subscription')",
    kind: 'external',
    file: 'infra/azure/staging-staff-api-metric-alerts/rg-staff-api-metric-alerts.bicep',
    reason: 'hard-lock assertion compiled from Bicep, not JavaScript.',
  },
  {
    gate: 'verify-radar-slice16h-staff-api-metric-alerts.js',
    anchor: 'subscription().subscriptionId',
    kind: 'external',
    file: 'infra/azure/staging-staff-api-metric-alerts/rg-staff-api-metric-alerts.bicep',
    reason: 'hard-lock assertion compiled from Bicep, not JavaScript.',
  },
  {
    gate: 'verify-radar-slice16h-staff-api-metric-alerts.js',
    anchor: "fail('wrong_container_app')",
    kind: 'external',
    file: 'infra/azure/staging-staff-api-metric-alerts/rg-staff-api-metric-alerts.bicep',
    reason: 'hard-lock assertion compiled from Bicep, not JavaScript.',
  },
  {
    gate: 'verify-radar-slice16h-staff-api-metric-alerts.js',
    anchor: "fail('wrong_resource_group')",
    kind: 'external',
    file: 'infra/azure/staging-staff-api-metric-alerts/rg-staff-api-metric-alerts.bicep',
    reason: 'hard-lock assertion compiled from Bicep, not JavaScript.',
  },
  {
    gate: 'verify-sunset-bot-price-endpoints.js',
    anchor: 'def _schema(',
    kind: 'external',
    file: 'docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py',
    reason: 'slice boundary in the Hermes Python plugin, not JavaScript.',
  },
  {
    gate: 'verify-sunset-bot-write-endpoints.js',
    anchor: '_guest_payment_url(data)',
    kind: 'external',
    file: 'docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py',
    reason: 'Hermes Python plugin prefers the compact guest payment URL, not JavaScript.',
  },
  {
    gate: 'verify-sunset-create-drawer-ux-followup.js',
    anchor: 'def create_sunset_booking(',
    kind: 'external',
    file: 'docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py',
    reason: 'slice boundary in the Hermes Python plugin, not JavaScript.',
  },
  {
    gate: 'verify-sunset-create-drawer-ux-followup.js',
    anchor: '\ndef create_sunset_payment_link(',
    kind: 'external',
    file: 'docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py',
    reason: 'slice boundary in the Hermes Python plugin, not JavaScript.',
  },
  {
    gate: 'verify-sunset-group-lesson-quote.js',
    anchor: 'def get_sunset_group_lesson_quote(',
    kind: 'external',
    file: 'docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py',
    reason: 'disabled Hermes Python stub must stay defined, not JavaScript.',
  },
  {
    gate: 'verify-sunset-luna-courses-only.js',
    anchor: 'def get_sunset_group_lesson_quote(',
    kind: 'external',
    file: 'docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py',
    reason: 'disabled Hermes Python stub must stay defined, not JavaScript.',
  },

  {
    gate: 'verify-sunset-admin-pure.js',
    anchor: "new RegExp('\\\\b1 hour\\\\b'",
    kind: 'generated',
    reason: 'matched against getSunsetAdminBrowserHelperSource(), which rewrites regex literals at build time.',
  },
  {
    gate: 'verify-sunset-admin-render.js',
    anchor: "new RegExp('\\\\b1 hour\\\\b'",
    kind: 'generated',
    reason: 'matched against getSunsetAdminBrowserHelperSource(), which rewrites regex literals at build time.',
  },
  {
    gate: 'verify-sunset-bookings-admin-n1.js',
    anchor: 'sum(p.amount_paid_cents)',
    kind: 'generated',
    reason: 'fake pg router matches sql.toLowerCase(); the query text reads SUM(p.amount_paid_cents).',
  },
  {
    gate: 'verify-sunset-bookings-admin-n1.js',
    anchor: 'sum(amount_cents)',
    kind: 'generated',
    reason: 'fake pg router matches sql.toLowerCase(); the query text reads SUM(amount_cents).',
  },

  {
    gate: 'verify-sunset-admin-tabs.js',
    anchor: "portalT('admin.tabs.finance')",
    kind: 'disjunction',
    reason: 'live branch is /data-i18n="admin.tabs.finance"/ against rendered HTML; the tab title moved to markup.',
  },
  {
    gate: 'verify-sunset-admin-tabs.js',
    anchor: 'portalT("admin.tabs.finance")',
    kind: 'disjunction',
    reason: 'live branch is /data-i18n="admin.tabs.finance"/ against rendered HTML; the tab title moved to markup.',
  },
];

let failures = 0;

function fail(message) {
  failures += 1;
  console.error(`  FAIL  ${message}`);
}

function listJsFiles(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listJsFiles(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const SIMPLE_ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };

/** Raw literal body (escapes intact) to its runtime string value. */
function decodeLiteral(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] !== '\\') {
      out += raw[i];
      continue;
    }
    const c = raw[i + 1];
    i += 1;
    if (c === 'u') {
      if (raw[i + 1] === '{') {
        const end = raw.indexOf('}', i);
        if (end < 0) return null;
        out += String.fromCodePoint(parseInt(raw.slice(i + 2, end), 16));
        i = end;
      } else {
        out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 5), 16));
        i += 4;
      }
      continue;
    }
    if (c === 'x') {
      out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    out += Object.prototype.hasOwnProperty.call(SIMPLE_ESCAPES, c) ? SIMPLE_ESCAPES[c] : c;
  }
  return out;
}

/** Literal body starting at an opening quote, or null when it is not a plain one-line literal. */
function readLiteralAt(src, quoteIndex) {
  const quote = src[quoteIndex];
  let raw = '';
  for (let i = quoteIndex + 1; i < src.length; i += 1) {
    const c = src[i];
    if (c === '\\') {
      raw += c + src[i + 1];
      i += 1;
      continue;
    }
    if (c === quote) return { raw, end: i };
    if (quote !== '`' && c === '\n') return null;
    raw += c;
  }
  return null;
}

const CODE_SHAPES = [
  /^(?:function|async function|var|const|let|class)\s+[A-Za-z_$]/,
  /\b(?:if|for|while|switch|catch|return|typeof)\s*\(/,
  /[A-Za-z_$][A-Za-z0-9_$]*\(/,
  /=>/,
];
const MARKUP = /[<>]|&lt;|&gt;|&#/;

/** Anchors are code landmarks; test fixtures and rendered markup are somebody else's problem. */
function looksLikeSourceAnchor(value) {
  if (MARKUP.test(value)) return false;
  return CODE_SHAPES.some((shape) => shape.test(value));
}

const LOOKUP_RE = new RegExp(`\\.(?:${LOOKUP_METHODS.join('|')})\\(\\s*(?:['"\`])`, 'g');

function collectLookups(src) {
  const found = [];
  LOOKUP_RE.lastIndex = 0;
  let match = LOOKUP_RE.exec(src);
  while (match) {
    const quoteIndex = match.index + match[0].length - 1;
    const literal = readLiteralAt(src, quoteIndex);
    if (literal) {
      LOOKUP_RE.lastIndex = literal.end;
      if (!literal.raw.includes('${')) {
        const value = decodeLiteral(literal.raw);
        if (value !== null) found.push({ value, start: match.index, end: literal.end });
      }
    }
    match = LOOKUP_RE.exec(src);
  }
  return found;
}

/** Start of the receiver expression whose method is called at `index`. */
function receiverStart(src, index) {
  let depth = 0;
  let i = index - 1;
  for (; i >= 0; i -= 1) {
    const c = src[i];
    if (c === ')' || c === ']') {
      depth += 1;
      continue;
    }
    if (c === '(' || c === '[') {
      if (depth === 0) break;
      depth -= 1;
      continue;
    }
    if (depth > 0) continue;
    if (/\s/.test(c)) break;
    if (!/[A-Za-z0-9_$.'"`]/.test(c)) break;
  }
  return i + 1;
}

/** `!src.includes(x) || !src.includes(y)` requires both, so it is not an alternative. */
function isNegatedLookup(src, lookup) {
  let i = receiverStart(src, lookup.start) - 1;
  while (i >= 0 && /[ \t]/.test(src[i])) i -= 1;
  return i >= 0 && src[i] === '!';
}

/**
 * Two lookups belong to the same `||` alternative when only a disjunction separates them.
 * A `&&` or a statement break means they are independent assertions.
 */
function sameDisjunction(src, a, b) {
  if (isNegatedLookup(src, a) || isNegatedLookup(src, b)) return false;
  const from = Math.min(a.end, b.end);
  const to = Math.max(a.start, b.start);
  if (to <= from) return false;
  const between = src.slice(from, to);
  return between.includes('||') && !between.includes('&&') && !between.includes(';');
}

const gateFiles = listJsFiles(SCRIPTS, [])
  .filter((p) => path.dirname(p) === SCRIPTS && path.basename(p).startsWith('verify-'))
  .sort();

const haystackFiles = listJsFiles(SCRIPTS, []).filter((p) => !path.basename(p).startsWith('verify-'));
// NUL separators keep an anchor from matching across a file boundary.
const haystack = haystackFiles.map((p) => fs.readFileSync(p, 'utf8')).join('\n\u0000\n');

const resolutionCache = new Map();
function resolvesInScripts(value) {
  if (!resolutionCache.has(value)) resolutionCache.set(value, haystack.includes(value));
  return resolutionCache.get(value);
}

function allowlistKey(gate, anchor) {
  return `${gate}\u0000${anchor}`;
}

const allowlist = new Map();
for (const entry of ALLOWLIST) {
  const key = allowlistKey(entry.gate, entry.anchor);
  if (allowlist.has(key)) fail(`duplicate allowlist entry: ${entry.gate} — ${JSON.stringify(entry.anchor)}`);
  if (!entry.reason) fail(`allowlist entry without a reason: ${entry.gate} — ${JSON.stringify(entry.anchor)}`);
  allowlist.set(key, entry);
}
const usedAllowlist = new Set();

console.log(`\nverify:gate-anchors  (${gateFiles.length} gates, ${haystackFiles.length} source files)\n`);

let anchorsChecked = 0;
let deadAnchors = 0;

for (const gateFile of gateFiles) {
  const gate = path.basename(gateFile);
  const src = fs.readFileSync(gateFile, 'utf8');
  const lookups = collectLookups(src);
  const anchors = lookups.filter(
    (l) => l.value.length >= MIN_ANCHOR_LENGTH && looksLikeSourceAnchor(l.value),
  );

  const reported = new Set();
  for (const anchor of anchors) {
    anchorsChecked += 1;
    if (resolvesInScripts(anchor.value)) continue;
    if (lookups.some((other) => other !== anchor
      && sameDisjunction(src, anchor, other)
      && resolvesInScripts(other.value))) continue;

    const key = allowlistKey(gate, anchor.value);
    const entry = allowlist.get(key);
    if (!entry) {
      if (reported.has(anchor.value)) continue;
      reported.add(anchor.value);
      deadAnchors += 1;
      const line = src.slice(0, anchor.start).split('\n').length;
      fail(`${gate}:${line} — anchor no longer resolves under scripts/: ${JSON.stringify(anchor.value)}`);
      continue;
    }
    usedAllowlist.add(key);
    if (entry.kind !== 'external') continue;

    const target = path.join(ROOT, entry.file);
    if (!fs.existsSync(target)) {
      fail(`${gate} — allowlisted external target is missing: ${entry.file}`);
      continue;
    }
    if (!fs.readFileSync(target, 'utf8').includes(anchor.value)) {
      fail(`${gate} — anchor no longer resolves in ${entry.file}: ${JSON.stringify(anchor.value)}`);
    }
  }
}

for (const [key, entry] of allowlist) {
  if (usedAllowlist.has(key)) continue;
  fail(`stale allowlist entry — ${entry.gate} no longer looks up ${JSON.stringify(entry.anchor)}, or it resolves now; delete the entry`);
}

console.log(`  checked ${anchorsChecked} anchors across ${gateFiles.length} gates`);
console.log(`  allowlisted ${usedAllowlist.size} of ${allowlist.size} entries`);
if (deadAnchors) console.log(`  dead anchors: ${deadAnchors}`);

console.log('');
if (failures) {
  console.error(`verify:gate-anchors FAILED (${failures})`);
  console.error('Repair the anchor against the renamed target, or allowlist it with a reason.');
} else {
  console.log('verify:gate-anchors PASSED — every gate anchor still resolves');
}

process.exit(failures ? 1 : 0);
