'use strict';
/**
 * Email thread body/subject ownership — serialization + production portal renderer.
 *
 * Incident: subject-only bubble with blank body for controlled Gate 3 email threads.
 * Proves staff-conversation-queries projection + staff-query-api bubble renderer.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const {
  getConversationMessagesQuery,
  projectStaffInboxThreadMessage,
  staffInboxThreadMessageBody,
  staffInboxThreadMessageSubject,
} = require('./lib/staff-conversation-queries');

const SUBJECT = 'SUNSET-G3-CONTROLLED-20260810';
const BODY = 'Controlled Gate 3 body content for staff thread render.';
const STAFF = path.join(ROOT, 'scripts/staff-query-api.js');

function extractPortalFn(source, name) {
  // Production browser helpers live in the embedded /staff/ui script bundle.
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' missing from production portal');
  let i = start;
  let depth = 0;
  let started = false;
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') { depth += 1; started = true; }
    else if (ch === '}') {
      depth -= 1;
      if (started && depth === 0) { i += 1; break; }
    }
  }
  return source.slice(start, i);
}

function loadProductionBubbleRenderer() {
  const source = fs.readFileSync(STAFF, 'utf8');
  assert.match(source, /function formatInboxThreadBubbleHtml/);
  assert.match(source, /function inboxThreadMessageBodyText/);
  assert.match(source, /msg-email-subject/);
  assert.match(source, /body_text/);

  const stubs = {
    escHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },
    formatThreadMessageHtml(text) {
      return stubs.escHtml(String(text == null ? '' : text));
    },
  };
  const code = [
    extractPortalFn(source, 'inboxThreadMessageBodyText'),
    extractPortalFn(source, 'inboxThreadMessageSubjectText'),
    extractPortalFn(source, 'formatInboxThreadBubbleHtml'),
  ].join('\n');
  const sandbox = { ...stubs, Object, String };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return {
    formatInboxThreadBubbleHtml: sandbox.formatInboxThreadBubbleHtml,
    inboxThreadMessageBodyText: sandbox.inboxThreadMessageBodyText,
    inboxThreadMessageSubjectText: sandbox.inboxThreadMessageSubjectText,
  };
}

(async () => {
  console.log('verify:staff-email-thread-body-render');

  const sql = getConversationMessagesQuery();
  assert.match(sql, /email_subject/i);
  assert.match(sql, /body_text/i);
  assert.match(sql, /email_inbound/i);
  assert.match(sql, /message_text/i);

  // Inbound subject-only storage (bridge): subject retained, body empty — not inventing body.
  const inbound = projectStaffInboxThreadMessage({
    message_id: 'm1',
    direction: 'inbound',
    message_text: SUBJECT,
    source: 'email_inbound',
    route: 'email',
    email_subject: SUBJECT,
    body_text: '',
    created_at: '2026-08-10T12:00:00.000Z',
  });
  assert.equal(staffInboxThreadMessageSubject(inbound), SUBJECT);
  assert.equal(staffInboxThreadMessageBody(inbound), '');
  assert.equal(inbound.message_text, SUBJECT);

  // Outbound staff email: message_text is the body; body_text projection carries it.
  const outbound = projectStaffInboxThreadMessage({
    message_id: 'm2',
    direction: 'outbound',
    message_text: BODY,
    source: 'staff_email_reply',
    route: 'email',
    email_subject: null,
    body_text: BODY,
    created_at: '2026-08-10T12:05:00.000Z',
  });
  assert.equal(staffInboxThreadMessageBody(outbound), BODY);
  assert.equal(outbound.message_text, BODY);

  // Distinct subject + body must both survive projection (API DTO ownership).
  const both = projectStaffInboxThreadMessage({
    message_id: 'm3',
    direction: 'inbound',
    message_text: SUBJECT,
    source: 'email_inbound',
    route: 'email',
    email_subject: SUBJECT,
    body_text: BODY,
    created_at: '2026-08-10T12:00:00.000Z',
  });
  assert.equal(staffInboxThreadMessageSubject(both), SUBJECT);
  assert.equal(staffInboxThreadMessageBody(both), BODY);

  // Production portal renderer (extracted from staff-query-api embedded UI).
  const portal = loadProductionBubbleRenderer();
  const subjectOnlyHtml = portal.formatInboxThreadBubbleHtml(inbound);
  assert.match(subjectOnlyHtml, /msg-email-subject/);
  assert.match(subjectOnlyHtml, new RegExp(SUBJECT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // Subject-only must not render an empty second body block after subject chrome.
  assert.equal((subjectOnlyHtml.match(/msg-email-subject/g) || []).length, 1);

  const bothHtml = portal.formatInboxThreadBubbleHtml(both);
  assert.match(bothHtml, /msg-email-subject/);
  assert.match(bothHtml, new RegExp(SUBJECT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(bothHtml, /Controlled Gate 3 body content/);
  assert.ok(bothHtml.indexOf(SUBJECT) < bothHtml.indexOf('Controlled Gate 3 body content'));

  const outboundHtml = portal.formatInboxThreadBubbleHtml(outbound);
  assert.match(outboundHtml, /Controlled Gate 3 body content/);
  // Outbound without separate subject should not invent subject chrome.
  assert.doesNotMatch(outboundHtml, /msg-email-subject/);

  // WhatsApp unchanged: message_text only, no email fields.
  const wa = projectStaffInboxThreadMessage({
    message_id: 'm4',
    direction: 'inbound',
    message_text: 'Hello WhatsApp',
    source: 'whatsapp',
    route: 'whatsapp',
    created_at: '2026-08-10T12:00:00.000Z',
  });
  assert.equal(staffInboxThreadMessageBody(wa), 'Hello WhatsApp');
  assert.equal(staffInboxThreadMessageSubject(wa), '');
  assert.equal(portal.formatInboxThreadBubbleHtml(wa), 'Hello WhatsApp');

  // Outbound mirror SQL must exist on approve-send owner (committed body → messages).
  const inboxRoutes = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-email-inbox-routes.js'), 'utf8');
  assert.match(inboxRoutes, /SQL_INSERT_OUTBOUND_THREAD/);
  assert.match(inboxRoutes, /staff_email_reply/);
  assert.match(inboxRoutes, /mirrorCommittedOutboundThread/);
  assert.match(inboxRoutes, /deliveryCommitted === true/);

  // UI refreshes thread bubbles after successful email send (keeps draft status).
  const api = fs.readFileSync(STAFF, 'utf8');
  assert.match(api, /\/messages' \+ inboxClientQuery\(\)/);
  assert.match(api, /renderInboxThreadMessagesHtml\(msgs\)/);
  assert.match(api, /projectStaffInboxThreadMessage/);

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(
    pkg.scripts['verify:staff-email-thread-body-render'],
    'node scripts/verify-staff-email-thread-body-render.js',
  );

  console.log('PASS staff-email-thread-body-render');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
