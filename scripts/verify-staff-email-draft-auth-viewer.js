#!/usr/bin/env node
'use strict';

/**
 * Email Create draft / Delete draft for any authenticated staff (viewer+).
 *
 * Does NOT cover Inbox Clear/Delete conversation auth (see PR #1074 /
 * verify-inbox-clear-delete-auth.js).
 *
 * Covers:
 *   - POST /staff/inbox/email/create-draft → EMAIL_DRAFT_MIN_ROLE (viewer)
 *   - POST /staff/inbox/email/draft        → EMAIL_DRAFT_MIN_ROLE (viewer)
 *   - DELETE /staff/inbox/email/draft      → EMAIL_DRAFT_MIN_ROLE (viewer)
 *   - Approve/send stays EMAIL_APPROVE_MIN_ROLE (operator)
 *   - Actor SQL / actor() / canGenerate include viewer
 *   - Delete draft UI clears unsaved Create Draft text (no silent no-op)
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const api = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const thread = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-thread.js'), 'utf8');
const openSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-email-luna-draft-open.js'), 'utf8');
const actorSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-email-luna-draft-route.js'), 'utf8');
const emailRoutes = require('./lib/staff-email-inbox-routes');
const lunaRoute = require('./lib/staff-email-luna-draft-route');

function sliceAround(src, needle, after = 450) {
  const i = src.indexOf(needle);
  assert.ok(i >= 0, `missing ${needle}`);
  return src.slice(i, i + needle.length + after);
}

assert.equal(emailRoutes.EMAIL_DRAFT_MIN_ROLE, 'viewer');
assert.equal(emailRoutes.EMAIL_APPROVE_MIN_ROLE, 'operator');
assert.ok(emailRoutes.EMAIL_STAFF_ROLES.includes('viewer'));

{
  const createDraft = sliceAround(api, "EMAIL_LUNA_CREATE_DRAFT_PATH && method === 'POST'");
  assert.match(createDraft, /requireAuth\(\s*req\s*,\s*res\s*,\s*EMAIL_DRAFT_MIN_ROLE\s*\)/);

  const draftPost = sliceAround(api, "pathname === EMAIL_DRAFT_PATH && method === 'POST'");
  assert.match(draftPost, /requireAuth\(\s*req\s*,\s*res\s*,\s*EMAIL_DRAFT_MIN_ROLE\s*\)/);

  const draftDel = sliceAround(api, "pathname === EMAIL_DRAFT_PATH && method === 'DELETE'");
  assert.match(draftDel, /requireAuth\(\s*req\s*,\s*res\s*,\s*EMAIL_DRAFT_MIN_ROLE\s*\)/);

  const approve = sliceAround(api, "EMAIL_APPROVE_SEND_PATH && method === 'POST'");
  assert.match(approve, /requireAuth\(\s*req\s*,\s*res\s*,\s*EMAIL_APPROVE_MIN_ROLE\s*\)/);
}

assert.match(emailRoutes.SQL_RESOLVE, /su\.role IN \('viewer','operator','admin','owner'\)/);
assert.match(emailRoutes.SQL_RESOLVE_SMTP, /su\.role IN \('viewer','operator','admin','owner'\)/);
assert.match(lunaRoute.SQL_LOAD_EMAIL_LUNA_GENERATION_CONTEXT,
  /su\.role IN \('viewer','operator','admin','owner'\)/);
assert.match(actorSrc, /\['viewer',\s*'operator',\s*'admin',\s*'owner'\]\.includes\(role\)/);
assert.match(openSrc, /canGenerate[\s\S]{0,120}\['viewer',\s*'operator',\s*'admin',\s*'owner'\]/);
assert.match(openSrc, /su\.role IN \('viewer','operator','admin','owner'\)/);

{
  const delFn = thread.slice(
    thread.indexOf('function performEmailDraftDelete'),
    thread.indexOf('function wireInboxEmailReply'),
  );
  assert.match(delFn, /if\s*\(!approval\)\s*\{/);
  assert.match(delFn, /Draft deleted/);
  assert.match(delFn, /ta\.value\s*=\s*''/);
  assert.doesNotMatch(delFn, /if\s*\(!approval\)\s*return\s*;/);
}

// Stay off Clear/Delete conversation auth (owned by PR #1074).
assert.doesNotMatch(
  api.slice(api.indexOf('const convClearThreadMatch'), api.indexOf('const convClearThreadMatch') + 500),
  /EMAIL_DRAFT_MIN_ROLE/,
);

console.log('verify:staff-email-draft-auth-viewer PASSED');
