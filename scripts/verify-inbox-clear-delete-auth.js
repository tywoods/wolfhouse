#!/usr/bin/env node
'use strict';

/**
 * verify:inbox-clear-delete-auth
 *
 * Inbox Clear + Delete must accept any authenticated staff session (viewer+).
 * Product rule: not limited to owner/admin (or operator-only for Clear).
 *
 * Proves (static, no network):
 *   - POST .../clear-thread-session → requireAuth(..., 'viewer')
 *   - DELETE /staff/conversations/:id → requireAuth(..., 'viewer')
 *   - Neighbor destructive routes keep their stricter gates (spam/reset/legacy clear)
 *   - Delete UI no longer claims "Admin access required" on 403
 *
 * Staging-only env fence on Clear (isStagingResetEnvironment) is unchanged.
 *
 * Run: node scripts/verify-inbox-clear-delete-auth.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const API = path.join(ROOT, 'scripts/staff-query-api.js');
const THREAD = path.join(ROOT, 'scripts/browser/inbox-thread.js');
const PKG = path.join(ROOT, 'package.json');

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
    return true;
  }
  fail += 1;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

function read(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (_) {
    return '';
  }
}

function routeBlock(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start < 0) return '';
  const end = src.indexOf(endMarker, start + startMarker.length);
  return end > start ? src.slice(start, end) : src.slice(start, start + 800);
}

function main() {
  console.log('\nverify:inbox-clear-delete-auth — Clear/Delete staff auth\n');

  const apiSrc = read(API);
  const threadSrc = read(THREAD);
  const pkg = JSON.parse(read(PKG) || '{}');

  ok('staff-query-api + inbox-thread sources load', !!(apiSrc && threadSrc));

  const clearRoute = routeBlock(
    apiSrc,
    'const convClearThreadMatch = CONV_CLEAR_THREAD_RE.exec(pathname);',
    'const convResetLunaMatch = CONV_RESET_LUNA_RE.exec(pathname);',
  );
  ok(
    'Clear route (clear-thread-session) requires viewer+ only',
    /requireAuth\(req, res, 'viewer'\)/.test(clearRoute)
      && !/requireAuth\(req, res, 'operator'\)/.test(clearRoute)
      && !/requireAuth\(req, res, 'admin'\)/.test(clearRoute)
      && !/requireAuth\(req, res, 'owner'\)/.test(clearRoute),
    clearRoute ? 'unexpected minRole in clear-thread-session dispatch' : 'clear-thread-session dispatch missing',
  );
  ok(
    'Clear dispatch still calls handleConversationClearThreadSession',
    /handleConversationClearThreadSession\(/.test(clearRoute),
  );

  const deleteRoute = routeBlock(
    apiSrc,
    'const convDeleteMatch = CONV_ID_RE.exec(pathname);\n  if (convDeleteMatch && method === \'DELETE\')',
    'if (pathname === \'/staff/manual-bookings/preview\')',
  );
  ok(
    'Delete route (DELETE /staff/conversations/:id) requires viewer+ only',
    /requireAuth\(req, res, 'viewer'\)/.test(deleteRoute)
      && !/requireAuth\(req, res, 'admin'\)/.test(deleteRoute)
      && !/requireAuth\(req, res, 'operator'\)/.test(deleteRoute)
      && !/requireAuth\(req, res, 'owner'\)/.test(deleteRoute),
    deleteRoute ? 'unexpected minRole in conversation DELETE dispatch' : 'conversation DELETE dispatch missing',
  );
  ok(
    'Delete dispatch still calls handleConversationDelete',
    /handleConversationDelete\(/.test(deleteRoute),
  );

  const spamRoute = routeBlock(
    apiSrc,
    'const convSpamMatch = CONV_SPAM_RE.exec(pathname);',
    'const convResetAgentMatch = CONV_RESET_AGENT_RE.exec(pathname);',
  );
  ok(
    'Spam route keeps operator+ gate (unchanged)',
    /requireAuth\(req, res, 'operator'\)/.test(spamRoute)
      && !/requireAuth\(req, res, 'viewer'\)/.test(spamRoute),
  );

  const resetAgentRoute = routeBlock(
    apiSrc,
    'const convResetAgentMatch = CONV_RESET_AGENT_RE.exec(pathname);',
    'const convClearThreadMatch = CONV_CLEAR_THREAD_RE.exec(pathname);',
  );
  ok(
    'Reset-agent-session keeps operator+ gate (unchanged)',
    /requireAuth\(req, res, 'operator'\)/.test(resetAgentRoute),
  );

  const legacyClearRoute = routeBlock(
    apiSrc,
    'const convClearMatch = CONV_CLEAR_RE.exec(pathname);',
    'const convDeleteMatch = CONV_ID_RE.exec(pathname);',
  );
  ok(
    'Legacy clear-messages keeps operator+ gate (unchanged)',
    /requireAuth\(req, res, 'operator'\)/.test(legacyClearRoute),
  );

  const clearHandler = (() => {
    const start = apiSrc.indexOf('async function handleConversationClearThreadSession(');
    if (start < 0) return '';
    const next = apiSrc.indexOf('\nasync function handleConversationResetLunaContext(', start + 1);
    return apiSrc.slice(start, next === -1 ? start + 2500 : next);
  })();
  ok(
    'Clear handler keeps staging-only + client-access fences',
    /isStagingResetEnvironment/.test(clearHandler)
      && /assertStaffClientAccess/.test(clearHandler),
  );

  ok(
    'Delete UI 403 copy is role-neutral (not Admin-only)',
    /function wireDeleteConversation\(/.test(threadSrc)
      && /r\.status === 403\) throw new Error\('Not allowed'\)/.test(threadSrc)
      && !/Admin access required/.test(threadSrc),
  );

  ok(
    'startup banner documents viewer+ for Clear and Delete',
    /clear-thread-session <- Inbox Clear session_key \(viewer\+, staging\)/.test(apiSrc)
      && /hard delete \(viewer\+\)/.test(apiSrc)
      && !/hard delete \(admin\+\)/.test(apiSrc),
  );

  ok(
    'package.json registers verify:inbox-clear-delete-auth',
    pkg.scripts
      && pkg.scripts['verify:inbox-clear-delete-auth'] === 'node scripts/verify-inbox-clear-delete-auth.js',
  );

  if (fail) {
    console.error(`\nverify:inbox-clear-delete-auth — FAILED (${pass} pass, ${fail} fail)`);
    process.exit(1);
  }
  console.log(`\nverify:inbox-clear-delete-auth — ALL CHECKS PASSED (${pass})`);
}

main();
