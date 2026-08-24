'use strict';
/** FULL SAIL Stage 1 NIGHTWATCH Chapter 4 Slice C1: ambient PUBLIC EXECUTE hardening. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
assert.equal(RED.head_reviewed, '45757de136a7f7f503989511b51df7bf69b9c5c1');
assert.equal(RED.pr_reviewed, 709);
assert.equal(RED.runtime_activation, false);
assert.equal(RED.activation_authorized, false);
assert.equal(RED.create_role, false);
assert.equal(RED.grant_to_worker, false);
assert.equal(RED.findings.length, 3);
assert.ok(RED.findings.every((row) => row.severity === 'blocking' && row.red && row.green));
assert.equal(RED.findings[0].id, 'ambient-public-execute');
assert.equal(RED.findings[1].id, 'default-privileges-reintroduce');
assert.equal(RED.findings[2].id, 'adoption-blocked-by-public-execute');
assert.equal(JSON.stringify(RED).includes('PASSWORD'), false);
console.log('  PASS  authentic RED artifact records PR #709 ambient PUBLIC EXECUTE refusal');

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
assert.equal(/^\s*CREATE ROLE/m.test(UP), false);
assert.equal(/^\s*GRANT /m.test(UP), false);
assert.equal(/CREATE TABLE/i.test(UP), false);
assert.equal(/INSERT INTO/i.test(UP), false);
for (const marker of LIVE_MARKERS) {
  assert.equal(UP.includes(marker), false, marker);
}
console.log('  PASS  096 revokes ambient PUBLIC EXECUTE as the applying owner and does not GRANT/CREATE ROLE');

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
console.log('  PASS  canonical manifest places 096 after 095 with paired down');

console.log('ALL OK — FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice C1 public EXECUTE static verifier');
