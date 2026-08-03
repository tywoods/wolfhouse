'use strict';

/**
 * verify:email-tenant-location-registry — Luna email Slice 1B offline gate.
 *
 * Structural + policy checks for tenant_locations + tenant_channel_endpoints
 * migration (057), down migration, manifest registration, docs, and secret-ref
 * parity policy. No network, no live/staging DB, no secrets.
 *
 * Intentionally does NOT ship or require a PG locationAuthority adapter —
 * Slice 1A validateTenantChannelEndpointInput is synchronous; async PG lookup
 * is deferred to a future API write slice.
 *
 * Behavioral PostgreSQL enforcement is prove-email-tenant-location-registry-pg.js.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  MANIFEST_PATH,
  MIGRATIONS_DIR,
  loadManifest,
  forwardEntries,
  validateManifestIntegrity,
  sha256CanonicalLfV1File,
  assertSafeDatabaseTarget,
} = require('./lib/migration-integrity');

const ROOT = path.join(__dirname, '..');
const MIG_UP = '057_tenant_locations_and_channel_endpoints.sql';
const MIG_DOWN = '057_tenant_locations_and_channel_endpoints_down.sql';
const MIG_ID = '057_tenant_locations_and_channel_endpoints';
const MIG_DOWN_ID = '057_tenant_locations_and_channel_endpoints_down';
const UP_PATH = path.join(MIGRATIONS_DIR, MIG_UP);
const DOWN_PATH = path.join(MIGRATIONS_DIR, MIG_DOWN);
const DOC_PATH = path.join(ROOT, 'docs', 'EMAIL-MAILBOX-ADAPTER-BOUNDARY.md');
const PKG_PATH = path.join(ROOT, 'package.json');
const AUTHORITY_REL = 'scripts/lib/email-tenant-location-authority-pg.js';
const AUTHORITY_PATH = path.join(ROOT, AUTHORITY_REL);
const PROVE_REL = 'scripts/prove-email-tenant-location-registry-pg.js';
const PROVE_PATH = path.join(ROOT, PROVE_REL);
const CONTRACT_REL = 'scripts/lib/email-mailbox-adapter-contract.js';
const CONTRACT_PATH = path.join(ROOT, CONTRACT_REL);

const CAPABILITY_KEYS = [
  'push_notifications',
  'provider_threads',
  'remote_drafts',
  'reply',
  'reply_all',
  'forward',
  'attachments_metadata',
  'delivery_events',
];

const PROVIDERS = ['microsoft_graph', 'gmail_api', 'imap_smtp'];

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('  PASS ', name);
  } else {
    fail += 1;
    console.log('  FAIL ', name, detail ? `— ${detail}` : '');
  }
}

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

function hasNoProductDml(sql) {
  // Allow comments; reject product INSERT/UPDATE/DELETE/COPY statements.
  // Do not treat FK "ON UPDATE CASCADE" as DML.
  const stripped = String(sql)
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\bON\s+UPDATE\b/gi, 'ON_UPDATE')
    .replace(/\bON\s+DELETE\b/gi, 'ON_DELETE');
  return !/\b(INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|COPY\s+\w)\b/i.test(stripped);
}

console.log('verify:email-tenant-location-registry — Slice 1B offline\n');

// --- Files present ---
ok('migration-057-up-exists', fs.existsSync(UP_PATH), MIG_UP);
ok('migration-057-down-exists', fs.existsSync(DOWN_PATH), MIG_DOWN);
ok('ephemeral-pg-proof-exists', fs.existsSync(PROVE_PATH), PROVE_REL);
ok('docs-email-boundary-exists', fs.existsSync(DOC_PATH));

let upSql = '';
let downSql = '';
if (fs.existsSync(UP_PATH)) upSql = read(UP_PATH);
if (fs.existsSync(DOWN_PATH)) downSql = read(DOWN_PATH);

// --- No product DML / empty tables intent ---
ok('up-has-no-product-dml', upSql ? hasNoProductDml(upSql) : false, 'must ship empty tables only');
ok('down-has-no-product-dml', downSql ? hasNoProductDml(downSql) : false);
ok('up-creates-tenant-locations', /CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?tenant_locations\b/i.test(upSql));
ok('up-creates-tenant-channel-endpoints', /CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?tenant_channel_endpoints\b/i.test(upSql));
ok('down-drops-endpoints-before-locations', (() => {
  if (!downSql) return false;
  const e = downSql.search(/DROP\s+TABLE\s+IF\s+EXISTS\s+tenant_channel_endpoints\b/i);
  const l = downSql.search(/DROP\s+TABLE\s+IF\s+EXISTS\s+tenant_locations\b/i);
  return e >= 0 && l >= 0 && e < l;
})());
// Recovery-safe down: no DROP TRIGGER ON table (fails if table already gone).
ok(
  'down-no-drop-trigger-on-table',
  !/DROP\s+TRIGGER\b/i.test(downSql),
  'prefer table IF EXISTS drops; triggers cascade with tables',
);
ok(
  'down-does-not-drop-shared-set-updated-at',
  !/DROP\s+(FUNCTION|ROUTINE)\b[\s\S]{0,40}set_updated_at/i.test(downSql),
);
ok(
  'down-does-not-drop-clients-or-staff-users',
  !/DROP\s+TABLE\b[\s\S]{0,40}\bclients\b/i.test(downSql)
    && !/DROP\s+TABLE\b[\s\S]{0,40}\bstaff_users\b/i.test(downSql),
);

// --- tenant_locations shape ---
ok('locations-uuid-pk', /id\s+UUID\s+PRIMARY\s+KEY/i.test(upSql) && /tenant_locations/i.test(upSql));
ok('locations-client-fk-restrict', /REFERENCES\s+clients\s*\(\s*id\s*\)[\s\S]{0,80}ON\s+DELETE\s+RESTRICT/i.test(upSql));
ok('locations-location-id-canonical-check', /location_id\s*[^\n]*~|tenant_locations[\s\S]{0,2500}location_id[\s\S]{0,400}\^[a-z0-9]/i.test(upSql));
ok('locations-display-name-nonempty', /display_name/i.test(upSql) && /btrim\s*\(\s*display_name\s*\)|char_length\s*\(\s*btrim/i.test(upSql));
ok('locations-unique-client-location', /UNIQUE\s*\(\s*client_id\s*,\s*location_id\s*\)/i.test(upSql));
ok('locations-unique-location-global', /UNIQUE\s*\(\s*location_id\s*\)/i.test(upSql));
ok('locations-set-updated-at-trigger', /tenant_locations[\s\S]{0,200}set_updated_at\s*\(\s*\)|TRIGGER[\s\S]{0,120}tenant_locations[\s\S]{0,80}set_updated_at/i.test(upSql));
ok('locations-active-column', /\bactive\b\s+BOOLEAN\s+NOT\s+NULL/i.test(upSql));

// --- tenant_channel_endpoints shape ---
ok('endpoints-composite-fk-restrict', /FOREIGN\s+KEY\s*\(\s*client_id\s*,\s*location_id\s*\)[\s\S]{0,120}REFERENCES\s+tenant_locations\s*\(\s*client_id\s*,\s*location_id\s*\)[\s\S]{0,80}ON\s+DELETE\s+RESTRICT/i.test(upSql));
ok('endpoints-email-channel-only', /channel[\s\S]{0,200}(?:=\s*'email'|IN\s*\(\s*'email'\s*\))/i.test(upSql));
ok(
  'endpoints-provider-allowlist',
  PROVIDERS.every((p) => upSql.includes(`'${p}'`))
    && /microsoft_graph[\s\S]{0,80}gmail_api[\s\S]{0,80}imap_smtp|provider[\s\S]{0,200}IN\s*\(/i.test(upSql),
);
ok('endpoints-public-address-no-default', /public_address\s+TEXT\s+NOT\s+NULL(?!\s+DEFAULT)/i.test(upSql)
  || (/public_address\s+TEXT\s+NOT\s+NULL/i.test(upSql) && !/public_address\s+TEXT\s+NOT\s+NULL\s+DEFAULT/i.test(upSql)));
ok('endpoints-public-address-lowercase-check', /public_address\s*=\s*lower\s*\(\s*public_address\s*\)/i.test(upSql));
ok('endpoints-public-address-email-like', /public_address[\s\S]{0,300}@/i.test(upSql));
ok('endpoints-secret-ref-kv-or-secret-ref', /kv:|secret-ref:/.test(upSql) && /secret_ref/i.test(upSql));
ok('endpoints-capabilities-jsonb-not-null', /capabilities\s+JSONB\s+NOT\s+NULL/i.test(upSql));
ok(
  'endpoints-capabilities-exactly-eight-keys',
  /jsonb_object_length\s*\(\s*capabilities\s*\)\s*=\s*8/i.test(upSql)
    || (/\?\s*&/.test(upSql)
      && /-\s*'delivery_events'/i.test(upSql)
      && /=\s*'\{\}'::jsonb/i.test(upSql)),
);
ok('endpoints-capabilities-required-keys', CAPABILITY_KEYS.every((k) => upSql.includes(`'${k}'`)));
ok(
  'endpoints-capabilities-boolean-typeof',
  CAPABILITY_KEYS.every((k) => new RegExp(
    String.raw`jsonb_typeof\s*\(\s*capabilities\s*->\s*'${k}'\s*\)\s*=\s*'boolean'`,
    'i',
  ).test(upSql)),
);
ok('endpoints-inbound-default-false', /inbound_enabled\s+BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+(false|FALSE)/i.test(upSql));
ok('endpoints-outbound-default-false', /outbound_enabled\s+BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+(false|FALSE)/i.test(upSql));
ok('endpoints-automation-default-off', /default_automation_mode[\s\S]{0,80}DEFAULT\s+'off'/i.test(upSql));
ok('endpoints-active-default-false', /(?<!inbound_|outbound_)active\s+BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+(false|FALSE)/i.test(upSql)
  || /active\s+BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+(false|FALSE)/i.test(upSql));
ok('endpoints-partial-unique-active-address', /UNIQUE\s+INDEX[\s\S]{0,200}public_address[\s\S]{0,120}WHERE\s+active\s*=\s*(true|TRUE)/i.test(upSql)
  || /CREATE\s+UNIQUE\s+INDEX[\s\S]{0,300}active\s*=\s*(true|TRUE)/i.test(upSql));
ok('endpoints-set-updated-at-trigger', /tenant_channel_endpoints[\s\S]{0,200}set_updated_at|TRIGGER[\s\S]{0,120}tenant_channel_endpoints[\s\S]{0,80}set_updated_at/i.test(upSql));
ok('endpoints-no-subquery-in-check', !/CHECK\s*\([\s\S]{0,800}\bSELECT\b/i.test(upSql));

// Actor columns only if UUID staff_users convention
ok(
  'audit-actors-uuid-staff-users-when-present',
  !/\b(created_by|updated_by)\b/i.test(upSql)
    || (/created_by\s+UUID/i.test(upSql) && /updated_by\s+UUID/i.test(upSql)
      && /REFERENCES\s+staff_users\s*\(\s*id\s*\)/i.test(upSql)),
);

// --- Manifest ---
let manifest = null;
try {
  manifest = loadManifest(MANIFEST_PATH);
} catch (e) {
  manifest = null;
}
const integrity = manifest ? validateManifestIntegrity(manifest) : { ok: false, errors: [{ code: 'no_manifest' }] };
ok('manifest-integrity', integrity.ok, JSON.stringify((integrity.errors || []).slice(0, 3)));
const forward = manifest ? forwardEntries(manifest) : [];
const upEntry = manifest && (manifest.entries || []).find((e) => e.filename === MIG_UP);
const downEntry = manifest && (manifest.entries || []).find((e) => e.filename === MIG_DOWN);
ok('manifest-has-057-forward', Boolean(upEntry && upEntry.inForwardChain && upEntry.classification === 'canonical_forward'));
ok('manifest-057-order-55', Boolean(upEntry && upEntry.order === 55), upEntry ? `order=${upEntry.order}` : 'missing');
ok('manifest-has-057-down-rollback', Boolean(downEntry && downEntry.classification === 'rollback_down' && downEntry.inForwardChain === false));
ok('forward-count-55', forward.length === 55, `forward=${forward.length}`);
if (upEntry && fs.existsSync(UP_PATH)) {
  const sha = sha256CanonicalLfV1File(UP_PATH);
  ok('manifest-057-sha-matches-file', upEntry.sha256 === sha, `manifest=${upEntry.sha256} file=${sha}`);
}
if (downEntry && fs.existsSync(DOWN_PATH)) {
  const sha = sha256CanonicalLfV1File(DOWN_PATH);
  ok('manifest-057-down-sha-matches-file', downEntry.sha256 === sha, `manifest=${downEntry.sha256} file=${sha}`);
}

// --- package.json scripts ---
let pkg = null;
try {
  pkg = JSON.parse(read(PKG_PATH));
} catch {
  pkg = null;
}
ok('package-has-offline-verify-script', Boolean(pkg && pkg.scripts && pkg.scripts['verify:email-tenant-location-registry']));
ok('package-has-pg-prove-script', Boolean(pkg && pkg.scripts && (
  pkg.scripts['prove:email-tenant-location-registry-pg']
  || pkg.scripts['verify:email-tenant-location-registry-pg']
)));
ok('package-keeps-slice-1a-script', Boolean(pkg && pkg.scripts && pkg.scripts['verify:email-mailbox-adapter-contract']));

// --- Docs ---
let doc = '';
if (fs.existsSync(DOC_PATH)) doc = read(DOC_PATH);
ok('docs-mention-slice-1b-persistence', /Slice\s*1B/i.test(doc) && /tenant_locations|tenant_channel_endpoints/i.test(doc));
ok('docs-empty-tables-no-backfill', /empty|no backfill|operator-controlled registration|intentionally empty/i.test(doc));
ok('docs-operator-registration-later', /operator|registration|later/i.test(doc));
ok(
  'docs-1a-authority-synchronous-preloaded',
  /trusted synchronous|synchronous\s*\/\s*preloaded|synchronous \/ preloaded/i.test(doc)
    && /locationAuthority|location authority/i.test(doc),
);
ok(
  'docs-no-pg-authority-bridge',
  /does not ship a PG authority bridge|does not ship an async PG/i.test(doc)
    && !/Optional trusted PG authority/i.test(doc),
);
ok(
  'docs-future-api-no-async-callback',
  /future API/i.test(doc)
    && /async callback|Promise-returning|async\/`Promise`|async\/Promise/i.test(doc),
);
ok(
  'docs-secret-ref-parity-note',
  /secret-ref parity|DB may be stricter|must never accept/i.test(doc),
);
ok(
  'docs-stock-pg-before-deploy-note',
  /stock PostgreSQL|stock PG|before deploy/i.test(doc) && /PGlite/i.test(doc),
);
// Docs must not claim the deferred adapter is shipped.
ok(
  'docs-do-not-claim-authority-pg-module',
  !/email-tenant-location-authority-pg\.js`\s+queries|scripts\/lib\/email-tenant-location-authority-pg\.js`\s*\|/i.test(doc),
);

// --- Safety helpers still refuse bad hosts ---
const badAzure = assertSafeDatabaseTarget({
  host: 'luna-sunset-staging-pg-app.postgres.database.azure.com',
  database: 'wh_mig_x',
  port: 5432,
});
ok('safety-refuses-azure-host', !badAzure.ok);
const badDb = assertSafeDatabaseTarget({
  host: '127.0.0.1',
  database: 'sunset_staging',
  port: 5432,
});
ok('safety-refuses-staging-db-name', !badDb.ok);
const badPrivate = assertSafeDatabaseTarget({
  host: '10.0.0.5',
  database: 'wh_mig_x',
  port: 5432,
});
ok('safety-refuses-private-host', !badPrivate.ok);
const good = assertSafeDatabaseTarget({
  host: '127.0.0.1',
  database: 'wh_mig_slice1b_proof',
  port: 5432,
});
ok('safety-allows-ephemeral-loopback', good.ok);

// --- No async PG locationAuthority bridge in this slice ---
ok(
  'authority-adapter-not-shipped',
  !fs.existsSync(AUTHORITY_PATH),
  `${AUTHORITY_REL} must be deferred (1A validator is sync-only)`,
);

// --- Secret-ref parity: offline app corpus rejects; DB CHECK is documented / structural ---
// Bounded deterministic corpus shared with Slice 1A adversarial rejects.
// Policy: DB must never accept a value 1A rejects for this corpus (proved in PG proof).
// Offline here: every corpus value is rejected by the 1A contract, and migration
// CHECK covers the same family of shapes (scheme + body detectors).
const ADVERSARIAL_SECRET_REFS = Object.freeze([
  'sk-abcdefghijklmnopqrstuvwxyz0123456789',
  'vault:email/mailbox/support',
  'kv:has space',
  'kv:sk-abcdefghijklmnopqrstuvwxyz123456',
  'kv:password-hunter2',
  'secret-ref:ya29.a0AfH6SMCrawOAuthToken',
  'kv:eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.signature',
  'kv:Bearer.eyJhbGciOiJIUzI1NiIs.payload.sig',
  'kv:api_key=super-secret-api-key-value',
  'secret-ref:client_secret=super-secret-value',
  'kv:password=hunter2',
  'password=hunter2secret',
  'hunter2/password',
]);
if (fs.existsSync(CONTRACT_PATH)) {
  const contract = require(CONTRACT_PATH);
  let allAppReject = true;
  for (const value of ADVERSARIAL_SECRET_REFS) {
    const r = contract.validateEmailMailboxSecretRef(value);
    if (!r || r.ok !== false) {
      allAppReject = false;
      ok(`secret-ref-app-rejects-${value.slice(0, 24)}`, false, 'app unexpectedly accepted');
    }
  }
  ok('secret-ref-adversarial-corpus-app-rejects-all', allAppReject);
} else {
  ok('secret-ref-adversarial-corpus-app-rejects-all', false, 'contract missing');
}
ok(
  'secret-ref-db-check-present',
  /tenant_channel_endpoints_secret_ref_shape/i.test(upSql)
    && /kv\|secret-ref|kv:|secret-ref:/.test(upSql)
    && /sk-/i.test(upSql),
);
ok(
  'secret-ref-parity-doc-allows-stricter-db',
  /stricter/i.test(doc) && /must never accept/i.test(doc),
);

// --- Secret scan on this verifier + migrations (added-line style: whole new files) ---
// Scan product SQL for accidental credential material.
// Skip this verifier source (contains detector regexes) and the PG proof
// (embeds intentional rejection fixtures, not live secrets).
function looksLikeEmbeddedSecret(text) {
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) return 'pem';
  if (/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(text)) return 'jwt';
  // Real assignment-like leaks, not CHECK-constraint pattern strings.
  if (/(?:^|[^\\])password\s*=\s*['"][^'"\n]{8,}['"]/im.test(text)) return 'password_assign';
  if (/(?:^|[^\\])api[_-]?key\s*=\s*['"][A-Za-z0-9]{16,}['"]/im.test(text)) return 'api_key_assign';
  if (/(?:^|[^'"`\\\[])sk-[A-Za-z0-9]{20,}/.test(text)) return 'sk_token';
  return null;
}
function scanSecrets(label, text) {
  const hit = looksLikeEmbeddedSecret(text || '');
  ok(`secret-scan-${label}`, !hit, hit || '');
}
scanSecrets('up-migration', upSql || '');
scanSecrets('down-migration', downSql || '');
// PG proof intentionally embeds adversarial fixtures; do not fail on those strings.
// Still ensure the deferred authority adapter is absent (already checked).

// --- Self-hash stability note (not a secret) ---
ok('canonical-lf-hash-fn-stable', typeof sha256CanonicalLfV1File === 'function');
ok('crypto-available', typeof crypto.createHash === 'function');

console.log(`\n── verify:email-tenant-location-registry ${fail ? 'FAILED' : 'PASSED'} (${pass} pass, ${fail} fail) ──`);
process.exit(fail > 0 ? 1 : 0);
