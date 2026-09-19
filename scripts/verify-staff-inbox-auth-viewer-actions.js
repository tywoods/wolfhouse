#!/usr/bin/env node
'use strict';

/**
 * Staff portal Inbox actions must authorize any authenticated staff session
 * (viewer+), not only operator/admin/owner.
 *
 * Covers:
 *   - POST /staff/conversations/:id/clear-thread-session  → viewer
 *   - DELETE /staff/conversations/:id                     → viewer
 *   - POST /staff/inbox/email/draft                       → viewer
 *   - DELETE /staff/inbox/email/draft                     → viewer
 *   - POST /staff/inbox/email/create-draft                → viewer
 *   - Approve/send stays operator+
 *   - Email Delete draft UI clears unsaved Create Draft text (no silent no-op)
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const api = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const thread = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-thread.js'), 'utf8');
const openSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-email-luna-draft-open.js'), 'utf8');
const emailRoutes = require('./lib/staff-email-inbox-routes');
const lunaRoute = require('./lib/staff-email-luna-draft-route');

function sliceAround(src, needle, before = 200, after = 200) {
  const i = src.indexOf(needle);
  assert.ok(i >= 0, `missing ${needle}`);
  return src.slice(Math.max(0, i - before), i + needle.length + after);
}

// Router minRole — clear + delete conversation
{
  const clearIdx = api.indexOf('const convClearThreadMatch = CONV_CLEAR_THREAD_RE.exec');
  assert.ok(clearIdx >= 0);
  const clearChunk = api.slice(clearIdx, clearIdx + 500);
  assert.match(clearChunk, /requireAuth\(\s*req\s*,\s*res\s*,\s*'viewer'\s*\)/,
    'clear-thread-session requires viewer+');
  assert.doesNotMatch(clearChunk, /requireAuth\(\s*req\s*,\s*res\s*,\s*'operator'\s*\)/);

  const delIdx = api.search(/convDeleteMatch && method === 'DELETE'/);
  assert.ok(delIdx >= 0);
  const delChunk = api.slice(delIdx, delIdx + 350);
  assert.match(delChunk, /requireAuth\(\s*req\s*,\s*res\s*,\s*'viewer'\s*\)/,
    'conversation DELETE requires viewer+');
  assert.doesNotMatch(delChunk, /requireAuth\(\s*req\s*,\s*res\s*,\s*'admin'\s*\)/);
}

// Router minRole — email draft create/delete + Luna create-draft
{
  assert.equal(emailRoutes.EMAIL_DRAFT_MIN_ROLE, 'viewer');
  assert.equal(emailRoutes.EMAIL_APPROVE_MIN_ROLE, 'operator');

  const draftPost = sliceAround(api, "pathname === EMAIL_DRAFT_PATH && method === 'POST'", 0, 450);
  assert.match(draftPost, /requireAuth\(\s*req\s*,\s*res\s*,\s*EMAIL_DRAFT_MIN_ROLE\s*\)/);

  const draftDel = sliceAround(api, "pathname === EMAIL_DRAFT_PATH && method === 'DELETE'", 0, 450);
  assert.match(draftDel, /requireAuth\(\s*req\s*,\s*res\s*,\s*EMAIL_DRAFT_MIN_ROLE\s*\)/);

  const createDraft = sliceAround(api, "EMAIL_LUNA_CREATE_DRAFT_PATH && method === 'POST'", 0, 450);
  assert.match(createDraft, /requireAuth\(\s*req\s*,\s*res\s*,\s*EMAIL_DRAFT_MIN_ROLE\s*\)/);

  const approve = sliceAround(api, "EMAIL_APPROVE_SEND_PATH && method === 'POST'", 0, 450);
  assert.match(approve, /requireAuth\(\s*req\s*,\s*res\s*,\s*EMAIL_APPROVE_MIN_ROLE\s*\)/);
}

// Handler actor allowlists include viewer
{
  assert.match(emailRoutes.SQL_RESOLVE, /su\.role IN \('viewer','operator','admin','owner'\)/);
  assert.match(emailRoutes.SQL_RESOLVE_SMTP, /su\.role IN \('viewer','operator','admin','owner'\)/);
  assert.ok(emailRoutes.EMAIL_STAFF_ROLES.includes('viewer'));

  assert.match(lunaRoute.SQL_LOAD_EMAIL_LUNA_GENERATION_CONTEXT,
    /su\.role IN \('viewer','operator','admin','owner'\)/);

  assert.match(openSrc, /canGenerate[\s\S]{0,120}\['viewer',\s*'operator',\s*'admin',\s*'owner'\]/);
  assert.match(openSrc, /su\.role IN \('viewer','operator','admin','owner'\)/);
}

// Actor projection accepts viewer
{
  const actorSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-email-luna-draft-route.js'), 'utf8');
  assert.match(actorSrc, /\['viewer',\s*'operator',\s*'admin',\s*'owner'\]\.includes\(role\)/);
}

// Delete draft UI: unsaved / Create Draft text is cleared (not silent return)
{
  const delFn = thread.slice(
    thread.indexOf('function performEmailDraftDelete'),
    thread.indexOf('function wireInboxEmailReply'),
  );
  assert.match(delFn, /if\s*\(!approval\)\s*\{/);
  assert.match(delFn, /Draft deleted/);
  assert.match(delFn, /ta\.value\s*=\s*''/);
  assert.doesNotMatch(delFn, /if\s*\(!approval\)\s*return\s*;/);
  assert.doesNotMatch(thread, /Admin access required/);
}

console.log('verify:staff-inbox-auth-viewer-actions PASSED');
