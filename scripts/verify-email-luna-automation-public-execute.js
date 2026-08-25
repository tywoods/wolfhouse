'use strict';
/** FULL SAIL Stage 1 NIGHTWATCH Chapter 4 Slice C1: ambient PUBLIC EXECUTE hardening. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  PGCRYPTO_1_3_RESIDUAL,
  PGCRYPTO_1_3_SIGNATURES,
  PRIOR_096_CANONICAL_SHA256,
  ALLOWLIST_BEGIN,
  ALLOWLIST_END,
  allowlistValuesSql,
  extractMigrationAllowlistValuesSql,
  normalizeAllowlistSql,
  assertMigrationAllowlistParity,
} = require('./lib/email-luna-automation-pgcrypto-residual-contract');
const { EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT } = require('./lib/email-luna-automation-principal-contract');
const { checksumMigrationFile, CHECKSUM_MODE_CANONICAL_LF_V1 } = require('./lib/migration-integrity');

const ROOT = path.join(__dirname, '..');
const RED = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'fixtures/email-luna-automation-public-execute-red.json'),
  'utf8',
));
const UP = fs.readFileSync(
  path.join(ROOT, 'database/migrations/096_tenant_email_luna_automation_public_execute.sql'),
  'utf8',
);
const DOWN = fs.readFileSync(
  path.join(ROOT, 'database/migrations/096_tenant_email_luna_automation_public_execute_down.sql'),
  'utf8',
);
const PRE_CORRECTION_UP = fs.readFileSync(
  path.join(ROOT, 'fixtures/email-luna-automation-public-execute-096-pre-correction.sql'),
  'utf8',
);
const MANIFEST = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'database/migrations/canonical-manifest.json'),
  'utf8',
));

const LIVE_MARKERS = [
  'sunset_staging',
  'sunset_prod',
  'wolfhouse_staging',
  'wolfhouse_prod',
  'luna_prod',
  'luna-sunset-staging',
  'azure_pg_admin',
  'PASSWORD',
  'current_setting',
];

console.log('FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice C1 public EXECUTE verifier');

assert.equal(RED.id, 'email-luna-automation-public-execute.ch4c1-red.v1');
assert.equal(RED.slice, 'FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice C1');
assert.equal(RED.head_reviewed, '3144efb83ae6f0e08d2b085be14f3d4418bb4a43');
assert.equal(RED.pr_reviewed, 710);
assert.equal(RED.runtime_activation, false);
assert.equal(RED.activation_authorized, false);
assert.equal(RED.create_role, false);
assert.equal(RED.grant_to_worker, false);
assert.equal(RED.findings.length, 4);
assert.ok(RED.findings.every((row) => row.severity === 'blocking' && row.red && row.green));
assert.equal(RED.findings[0].id, 'ambient-public-execute');
assert.equal(RED.findings[1].id, 'default-privileges-reintroduce');
assert.equal(RED.findings[2].id, 'adoption-blocked-by-public-execute');
assert.equal(RED.findings[3].id, 'azure-pgcrypto-residual');
assert.match(RED.findings[3].red, /rolled back atomically/);
assert.match(RED.findings[3].green, /frozen stock pgcrypto 1\.3/);
assert.equal(JSON.stringify(RED).includes('PASSWORD'), false);
console.log('  PASS  authentic RED artifact records PR #710 Azure pgcrypto residual rollback');

assert.match(UP, /REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC/);
assert.match(UP, /ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC/);
assert.match(UP, /ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC/);
assert.match(UP, /per-schema defaults are unioned with the global/);
assert.match(UP, /must run as queue table\/function owner/);
assert.match(UP, /session_user IS DISTINCT FROM table_owner/);
assert.match(UP, /current_user IS DISTINCT FROM table_owner/);
assert.match(UP, /public-schema function still executable by PUBLIC/);
assert.match(UP, /applying owner default privileges still grant PUBLIC EXECUTE/);
assert.match(UP, /Some engines \(PGlite\) accept/);
assert.match(UP, /Owner implicit EXECUTE is preserved/);
assert.match(UP, /Existing explicit GRANT EXECUTE to named roles survive/);
assert.match(UP, /Another owner \(or an extension script that GRANT EXECUTE/);
assert.match(UP, /frozen stock pgcrypto 1\.3/);
assert.match(UP, /extversion is exactly 1\.3/);
assert.match(UP, /pg_depend deptype=e/);
assert.match(UP, /NOT SECURITY DEFINER/);
assert.match(UP, /public\.gen_random_uuid\(\) is exempt only/);
assert.match(UP, /pg_catalog\.gen_random_uuid\(\) is core PG13\+/);
assert.match(UP, /NIGHTWATCH_PGCRYPTO_1_3_ALLOWLIST_BEGIN/);
assert.match(UP, /NIGHTWATCH_PGCRYPTO_1_3_ALLOWLIST_END/);
assert.match(UP, /PUBLIC-executable pgcrypto residual is not pinned extension version 1\.3/);
assert.equal(UP.includes('azuresu'), false);
assert.equal(UP.includes('sunsetadmin'), false);
assert.equal(UP.includes('097_'), false);
assert.equal(/^\s*CREATE ROLE/m.test(UP), false);
assert.equal(/^\s*GRANT /m.test(UP), false);
assert.equal(/CREATE TABLE/i.test(UP), false);
assert.equal(/INSERT INTO/i.test(UP), false);
assert.equal(assertMigrationAllowlistParity(UP), true);
assert.equal(
  normalizeAllowlistSql(extractMigrationAllowlistValuesSql(UP)),
  normalizeAllowlistSql(allowlistValuesSql()),
);
const CONTRACT_SRC = fs.readFileSync(
  path.join(__dirname, 'lib/email-luna-automation-pgcrypto-residual-contract.js'),
  'utf8',
);
assert.equal(CONTRACT_SRC.includes('parseMigrationAllowlist'), false);
assert.equal(CONTRACT_SRC.includes("const re = /\\('([^']*)'"), false);
assert.match(CONTRACT_SRC, /normalizeAllowlistSql/);
assert.match(CONTRACT_SRC, /extractMigrationAllowlistValuesSql/);

function replaceAllowlistInterior(sql, interior) {
  const lines = String(sql).replace(/\r\n/g, '\n').split('\n');
  const begin = lines.findIndex((line) => line.trim() === `-- ${ALLOWLIST_BEGIN}`);
  const end = lines.findIndex((line) => line.trim() === `-- ${ALLOWLIST_END}`);
  assert.ok(begin >= 0 && end > begin, '096 allowlist markers present for mutant construction');
  const indent = `${lines[begin].match(/^[ \t]*/)[0]}`;
  const rendered = (Array.isArray(interior) ? interior : String(interior).split('\n'))
    .map((line) => (line.length ? indent + line : line));
  return [...lines.slice(0, begin + 1), ...rendered, ...lines.slice(end)].join('\n');
}

function canonicalAllowlistLines() {
  return normalizeAllowlistSql(allowlistValuesSql()).split('\n');
}

function mutantAllowlist(transform) {
  return replaceAllowlistInterior(UP, transform(canonicalAllowlistLines().slice()));
}

function expectAllowlistParityFail(sql, label) {
  assert.throws(
    () => assertMigrationAllowlistParity(sql),
    (err) => err instanceof Error && /096 pgcrypto allowlist/.test(String(err && err.message)),
    label,
  );
}

function legacyRegexTupleCount(sql) {
  const text = String(sql || '');
  const begin = text.indexOf(ALLOWLIST_BEGIN);
  const end = text.indexOf(ALLOWLIST_END);
  const block = begin >= 0 && end > begin ? text.slice(begin, end) : text;
  const re = /\('([^']*)',\s*'([^']*)',\s*'([isv])',\s*(TRUE|FALSE),\s*(TRUE|FALSE)\)/g;
  return [...block.matchAll(re)].length;
}

const sneakyExtra = mutantAllowlist((rows) => {
  rows.splice(1, 0, "( 'sneaky_extra', 'text', 'v', false, true),");
  return rows;
});
assert.equal(
  legacyRegexTupleCount(sneakyExtra),
  36,
  'reported sneaky extra tuple must be invisible to the old regex scanner',
);
expectAllowlistParityFail(sneakyExtra, 'sneaky extra tuple');
expectAllowlistParityFail(mutantAllowlist((rows) => {
  rows.splice(1, 0, "('sneaky_regex_shaped', 'text', 'v', FALSE, TRUE),");
  return rows;
}), 'extra regex-shaped tuple');
expectAllowlistParityFail(mutantAllowlist((rows) => {
  rows.splice(2, 1);
  return rows;
}), 'missing row');
expectAllowlistParityFail(mutantAllowlist((rows) => {
  rows[0] = rows[0].replace("'armor'", "'Armor'");
  return rows;
}), 'changed proname casing');
expectAllowlistParityFail(mutantAllowlist((rows) => {
  rows[0] = rows[0].replace("'bytea'", "'bytea, text'");
  return rows;
}), 'changed identity args');
expectAllowlistParityFail(mutantAllowlist((rows) => {
  rows[0] = rows[0].replace("'i'", "'v'");
  return rows;
}), 'changed volatility');
expectAllowlistParityFail(mutantAllowlist((rows) => {
  rows[0] = rows[0].replace('FALSE, TRUE', 'TRUE, TRUE');
  return rows;
}), 'changed boolean');
expectAllowlistParityFail(mutantAllowlist((rows) => {
  rows[0] = rows[0].replace('FALSE, TRUE', 'false, true');
  return rows;
}), 'alternate lowercase booleans');
expectAllowlistParityFail(mutantAllowlist((rows) => {
  rows[0] = "('armor'::text, 'bytea', 'i', FALSE, TRUE),";
  return rows;
}), 'cast');
expectAllowlistParityFail(mutantAllowlist((rows) => {
  rows[0] = "('arm' || 'or', 'bytea', 'i', FALSE, TRUE),";
  return rows;
}), 'concatenation');
expectAllowlistParityFail(mutantAllowlist((rows) => {
  return [`SELECT 1,`, ...rows];
}), 'prefix SQL inside block');
expectAllowlistParityFail(mutantAllowlist((rows) => {
  const last = rows.length - 1;
  rows[last] = `${rows[last]},`;
  rows.push('(SELECT 1)');
  return rows;
}), 'suffix SQL inside block');
expectAllowlistParityFail(mutantAllowlist((rows) => {
  rows.splice(1, 0, "/* ('sneaky_comment', 'text', 'v', FALSE, TRUE), */");
  return rows;
}), 'block comment hiding extra tuple');
expectAllowlistParityFail(mutantAllowlist((rows) => {
  rows[0] = "('digest', 'text, text' /* x */, 'i', FALSE, TRUE),";
  return rows;
}), 'inline comment altering tuple');
expectAllowlistParityFail(mutantAllowlist((rows) => {
  rows.splice(1, 0, "-- ('sneaky_line', 'text', 'v', FALSE, TRUE),");
  return rows;
}), 'line comment inside block');
expectAllowlistParityFail(mutantAllowlist((rows) => {
  rows[0] = "('armor', 'bytea', 'i', FALSE TRUE),";
  return rows;
}), 'malformed content');
expectAllowlistParityFail(
  UP.replace(`-- ${ALLOWLIST_BEGIN}`, `-- ${ALLOWLIST_BEGIN}\n           -- ${ALLOWLIST_BEGIN}`),
  'duplicate begin marker',
);
expectAllowlistParityFail(
  UP.replace(`-- ${ALLOWLIST_END}`, `-- ${ALLOWLIST_END}\n           -- ${ALLOWLIST_END}`),
  'duplicate end marker',
);
expectAllowlistParityFail(UP.replace(`-- ${ALLOWLIST_BEGIN}\n`, ''), 'missing begin marker');
expectAllowlistParityFail(UP.replace(`-- ${ALLOWLIST_END}`, ''), 'missing end marker');
expectAllowlistParityFail(
  UP.replace(`-- ${ALLOWLIST_BEGIN}`, `SELECT '${ALLOWLIST_BEGIN}'`),
  'begin marker is not a whole-line comment',
);
console.log('  PASS  096 allowlist parity is exact VALUES text, not regex tuple scanning');

assert.equal(PGCRYPTO_1_3_SIGNATURES.length, 36);
assert.equal(PGCRYPTO_1_3_RESIDUAL.extversion, '1.3');
assert.equal(PGCRYPTO_1_3_RESIDUAL.capability.databaseRead, false);
assert.equal(PGCRYPTO_1_3_RESIDUAL.capability.databaseWrite, false);
assert.deepEqual(
  EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.ambient_extension_execute_allowlist.slice(),
  PGCRYPTO_1_3_SIGNATURES.slice(),
);
assert.equal(
  EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.ambient_callable_functions,
  'exact_luna_oids_plus_frozen_pgcrypto_1_3_residual',
);
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.worker_pgcrypto_residual_capability.computationalOnly, true);
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.worker_pgcrypto_residual_capability.databaseRead, false);
assert.equal(PRE_CORRECTION_UP.includes('NIGHTWATCH_PGCRYPTO_1_3_ALLOWLIST_BEGIN'), false);
assert.match(PRE_CORRECTION_UP, /public-schema function still executable by PUBLIC/);
assert.equal(PRE_CORRECTION_UP.includes('extversion is exactly 1.3'), false);
assert.equal(
  checksumMigrationFile(
    path.join(ROOT, 'fixtures/email-luna-automation-public-execute-096-pre-correction.sql'),
    CHECKSUM_MODE_CANONICAL_LF_V1,
  ).sha256,
  PRIOR_096_CANONICAL_SHA256,
);
for (const marker of LIVE_MARKERS) {
  assert.equal(UP.includes(marker), false, marker);
}
console.log('  PASS  096 revokes ambient PUBLIC EXECUTE as the applying owner with frozen pgcrypto 1.3 residual');

function sqlWithoutComments(sql) {
  return String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*--[^\n]*$/gm, '')
    .replace(/[ \t]+--[^\n]*/g, '');
}

function hasBroadPublicGrant(sql) {
  const body = sqlWithoutComments(sql);
  return /GRANT\s+EXECUTE\s+ON\s+ALL\s+FUNCTIONS\s+IN\s+SCHEMA\s+public\s+TO\s+PUBLIC/i.test(sql)
    || /GRANT[\s\S]*?\sTO\s+PUBLIC\b/i.test(body)
    || /ALTER\s+DEFAULT\s+PRIVILEGES[\s\S]*?\bGRANT\b/i.test(body);
}

function hasAclMutation(sql) {
  const body = sqlWithoutComments(sql);
  return /\bGRANT\b/i.test(body)
    || /\bREVOKE\b/i.test(body)
    || /ALTER\s+DEFAULT\s+PRIVILEGES/i.test(body)
    || /UPDATE\s+(?:pg_catalog\.)?pg_(?:proc|default_acl|class)\b/i.test(body);
}

const BROAD_PUBLIC_GRANT = 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO PUBLIC';
assert.equal(hasBroadPublicGrant(BROAD_PUBLIC_GRANT), true);
assert.equal(hasBroadPublicGrant(`EXECUTE '${BROAD_PUBLIC_GRANT}'`), true);
assert.equal(hasBroadPublicGrant('ALTER DEFAULT PRIVILEGES FOR ROLE x GRANT EXECUTE ON FUNCTIONS TO PUBLIC'), true);
assert.equal(hasAclMutation('REVOKE ALL ON FUNCTION public.fn() FROM PUBLIC'), true);
assert.equal(hasBroadPublicGrant(DOWN), false, 'broad PUBLIC grant in 096_down is RED/forbidden');
assert.equal(DOWN.includes(BROAD_PUBLIC_GRANT), false);
assert.equal(hasAclMutation(DOWN), false, '096_down must be ACL mutation-free');
assert.match(DOWN, /096_down_refused/);
assert.match(DOWN, /exact pre-096 ACL\/default-ACL state was not captured/);
assert.match(DOWN, /broad rollback would be unsafe/);
assert.match(DOWN, /USING ERRCODE = '0A000'/);
assert.match(sqlWithoutComments(DOWN), /RAISE EXCEPTION '096_down_refused:/);
assert.equal(/^\s*CREATE ROLE/m.test(DOWN), false);
assert.equal(/^\s*GRANT /m.test(DOWN), false);
assert.equal(/^\s*REVOKE /m.test(DOWN), false);
assert.equal(/^\s*ALTER DEFAULT PRIVILEGES/m.test(DOWN), false);
for (const marker of LIVE_MARKERS) {
  assert.equal(DOWN.includes(marker), false, `down ${marker}`);
}
console.log('  PASS  096 down is mutation-free, fail-closed, and treats broad PUBLIC grants as RED');

const fwd = MANIFEST.entries.find((e) => e.id === '096_tenant_email_luna_automation_public_execute');
const down = MANIFEST.entries.find((e) => e.id === '096_tenant_email_luna_automation_public_execute_down');
assert.equal(fwd.classification, 'canonical_forward');
assert.equal(fwd.inForwardChain, true);
assert.equal(fwd.order, 92);
assert.equal(fwd.downFilename, '096_tenant_email_luna_automation_public_execute_down.sql');
assert.equal(down.classification, 'rollback_down');
assert.equal(down.inForwardChain, false);
assert.equal(down.pairsWith, '096_tenant_email_luna_automation_public_execute.sql');
const forwards = MANIFEST.entries.filter((e) => e.inForwardChain === true).sort((a, b) => a.order - b.order);
assert.equal(forwards[forwards.length - 1].id, '096_tenant_email_luna_automation_public_execute');
assert.equal(forwards[forwards.length - 2].id, '095_tenant_email_luna_automation_claim_scoped');
assert.equal(fwd.legacySha256 == null, true, 'prior 096 hash must not be legacySha256');
assert.equal(fwd.sha256 === PRIOR_096_CANONICAL_SHA256, false);
assert.equal(
  checksumMigrationFile(path.join(ROOT, 'database/migrations/096_tenant_email_luna_automation_public_execute.sql'), CHECKSUM_MODE_CANONICAL_LF_V1).sha256,
  fwd.sha256,
);
assert.equal(
  checksumMigrationFile(path.join(ROOT, 'database/migrations/096_tenant_email_luna_automation_public_execute_down.sql'), CHECKSUM_MODE_CANONICAL_LF_V1).sha256,
  down.sha256,
);
assert.match(fwd.rationale, /pgcrypto 1\.3/);
assert.match(fwd.rationale, /not legacySha256/);
assert.equal(PGCRYPTO_1_3_RESIDUAL.prior096CanonicalSha256, PRIOR_096_CANONICAL_SHA256);
assert.equal(fs.existsSync(path.join(ROOT, 'database/migrations/097_tenant_email_luna_automation_public_execute.sql')), false);
console.log('  PASS  canonical manifest places 096 after 095 with paired down');

console.log('ALL OK — FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice C1 public EXECUTE static verifier');
