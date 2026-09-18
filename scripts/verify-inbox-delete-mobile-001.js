#!/usr/bin/env node
'use strict';

/**
 * INBOX-DELETE-THEN-MOBILE-001
 * - hard-delete safety: scoped delete; protects phone-scoped pause rows when another
 *   conversation for the same client+phone exists.
 * - Inbox row delete glyph: present beside the name, hidden until hover/focus on desktop,
 *   persistent 44px tap target on phone, wired to the existing confirm + DELETE handler.
 * - Mobile landing: phone startup no longer overrides Sunset Schedule; conversation deep
 *   links still land in Inbox; Wolfhouse Booking Calendar default remains available.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { deleteConversationHard } = require('./lib/staff-conversation-writes');
const { readStaffPortalUiSource } = require('./lib/staff-portal-ui-source');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const ui = readStaffPortalUiSource();
const writesSrc = read('scripts/lib/staff-conversation-writes.js');
const threadSrc = read('scripts/browser/inbox-thread.js');
const shellSrc = read('scripts/browser/inbox-shell.js');
const apiSrc = read('scripts/staff-query-api.js');

function check(label, value) {
  assert.ok(value, label);
  console.log('PASS', label);
}

class FakePg {
  constructor({ found = true, siblingSamePhone = false, deleteConversation = true } = {}) {
    this.found = found;
    this.siblingSamePhone = siblingSamePhone;
    this.deleteConversation = deleteConversation;
    this.calls = [];
  }
  async query(sql, params = []) {
    this.calls.push({ sql, params });
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (/SELECT conv\.id::text AS conversation_id, conv\.phone/.test(sql)) {
      return this.found ? { rows: [{ conversation_id: params[1], phone: '+34600000000' }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (/DELETE FROM bot_pause_states bps/.test(sql)) {
      const protectsSibling = /NOT EXISTS[\s\S]*sibling\.id <> \$2::uuid[\s\S]*sibling\.phone = \$3/.test(sql);
      if (!protectsSibling) throw new Error('pause delete does not protect same-phone sibling conversations');
      return { rows: [], rowCount: this.siblingSamePhone ? 1 : 2 };
    }
    if (/DELETE FROM conversations conv/.test(sql)) {
      return this.deleteConversation ? { rows: [{ conversation_id: params[1] }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    throw new Error('Unexpected SQL: ' + sql.slice(0, 120));
  }
}

(async function main(){
  // A1: hard-delete contract and safety on disposable offline records.
  check('hard-delete helper still deletes conversations, not spam/clear-thread paths',
    /async function deleteConversationHard/.test(writesSrc)
    && /DELETE FROM conversations conv/.test(writesSrc)
    && !/setConversationSpam/.test(writesSrc));
  check('pause cleanup is scoped and protected from same-phone sibling side effects',
    /DELETE FROM bot_pause_states bps[\s\S]*bps\.conversation_id = \$2[\s\S]*bps\.guest_phone = \$3[\s\S]*NOT EXISTS[\s\S]*sibling\.id <> \$2::uuid[\s\S]*sibling\.phone = \$3/.test(writesSrc));

  const okPg = new FakePg({ siblingSamePhone: false });
  const ok = await deleteConversationHard(okPg, 'sunset', '11111111-1111-4111-8111-111111111111');
  assert.equal(ok.found, true);
  assert.equal(ok.pause_states_deleted, 2);
  assert.deepEqual(okPg.calls.map(c => c.sql === 'BEGIN' || c.sql === 'COMMIT' || c.sql === 'ROLLBACK' ? c.sql : c.sql.match(/^\s*(SELECT|DELETE FROM [a-z_]+|DELETE FROM conversations)/)[0].trim().replace(/\s+/g, ' ')), [
    'BEGIN',
    'SELECT',
    'DELETE FROM bot_pause_states',
    'DELETE FROM conversations',
    'COMMIT',
  ]);
  console.log('PASS hard-delete exact disposable record path commits conversation delete');

  const missingPg = new FakePg({ found: false });
  const missing = await deleteConversationHard(missingPg, 'sunset', '22222222-2222-4222-8222-222222222222');
  assert.equal(missing.found, false);
  assert.equal(missingPg.calls.at(-1).sql, 'ROLLBACK');
  check('missing conversation rolls back without deleting approvals/messages/pause rows',
    !missingPg.calls.some(c => /DELETE FROM /.test(c.sql)));

  // A2: UI: × is restored beside guest name and above channel icon; hover/focus/touch.
  check('delete glyph rendered for admin non-demo rows',
    /staffIsAdmin\(\) && !c\._is_demo_preview/.test(threadSrc)
    && /class=\"conv-card-delete\"/.test(threadSrc)
    && /aria-label=\"Delete conversation permanently\"/.test(threadSrc));
  check('delete glyph is inside .conv-card-header-row beside .conv-card-name',
    /conv-card-header-row[\s\S]{0,220}conv-card-name[\s\S]{0,160}delBtn[\s\S]{0,80}<\/div>/.test(threadSrc));
  check('Inbox theme no longer hides .conv-card-delete with display:none!important',
    !/#inbox-shell \.conv-card-delete,\s*'\s*,\s*'#inbox-shell \.conv-card-contact/.test(shellSrc)
    && !/#inbox-shell \.conv-card-delete\{display:none!important\}/.test(shellSrc));
  check('desktop delete glyph uses hover and keyboard focus reveal',
    /conv-card:hover \.conv-card-delete/.test(shellSrc)
    && /conv-card:focus-within \.conv-card-delete/.test(shellSrc)
    && /conv-card-delete:focus-visible/.test(shellSrc)
    && /opacity:0/.test(shellSrc));
  check('phone delete glyph persists with 44px tap target',
    /@media\(max-width:768px\)[\s\S]{0,260}\.conv-card-delete\{opacity:\.72;width:44px;height:44px;min-width:44px/.test(shellSrc));
  check('delete handler keeps existing confirm + DELETE route and selected-thread clear',
    /window\.confirm\('Delete this conversation permanently\? This cannot be undone\.'\)/.test(threadSrc)
    && /fetch\('\/staff\/conversations\/' \+ encodeURIComponent\(convId\) \+ inboxClientQuery\(\), \{[\s\S]{0,120}method: 'DELETE'/.test(threadSrc)
    && /if \(selectedConvId === convId\)[\s\S]{0,220}inboxEmptyDetailHtml\(\)[\s\S]{0,120}hideInboxMobileThread\(\)/.test(threadSrc));
  check('spam and Clear remain separate from hard delete',
    /\/staff\/conversations\/.*\/spam/.test(threadSrc)
    && /clear-thread-session/.test(threadSrc)
    && /function wireDeleteConversation/.test(threadSrc));

  // B: Mobile landing and bounded layout/nav checks.
  check('mobile startup no longer forces Inbox',
    !/isPortalMobile\(\)\s*&&\s*!isTabHiddenForClient\('conversations'/.test(apiSrc)
    && /Mobile uses the same landing tab as desktop/.test(apiSrc));
  check('conversation deep links still land on Inbox',
    /new URLSearchParams\(window\.location\.search \|\| ''\)\.get\('conversation'\)/.test(apiSrc)
    && /if \(deepConv && !isTabHiddenForClient\('conversations'/.test(apiSrc)
    && /tab = 'conversations'/.test(apiSrc)
    && /openInboxToConversation\(conv\)/.test(apiSrc));
  check('Sunset Schedule default and Wolfhouse Booking Calendar fallback are preserved',
    /var tab = profile\.default_tab \|\| 'bed-calendar'/.test(apiSrc)
    && /tab = profile\.is_surf_vertical \? 'portal-home' : 'bed-calendar'/.test(apiSrc)
    && /var target = \(homeBtn && homeBtn\.style\.display !== 'none'\) \? 'portal-home' : 'bed-calendar'/.test(apiSrc));
  check('bounded mobile chrome remains scoped to primary flow blockers',
    ui.includes('staff-portal-mobile:shell')
    && ui.includes('staff-portal-mobile:inbox')
    && ui.includes('staff-portal-mobile:inbox-chrome')
    && ui.includes('staff-portal-mobile:main-menu')
    && ui.includes('staff-portal-mobile:calendar-card')
    && ui.includes('staff-portal-mobile:punch-list'));

  console.log('\nverify-inbox-delete-mobile-001 — ALL CHECKS PASSED\n');
})().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
