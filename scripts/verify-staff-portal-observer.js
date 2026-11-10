'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  OBSERVER_ACCESS_MODE,
  isStaffPortalObserver,
  authorizeStaffPortalObserverRequest,
  shouldGenerateInboxDraftOnOpen,
} = require('./lib/staff-portal-observer');

const observer = Object.freeze({
  role: 'viewer',
  client_slug: 'wolfhouse-somo',
  metadata: Object.freeze({ portal_access_mode: OBSERVER_ACCESS_MODE }),
});
const viewer = Object.freeze({ role: 'viewer', client_slug: 'wolfhouse-somo', metadata: {} });

assert.strictEqual(isStaffPortalObserver(observer), true);
assert.strictEqual(isStaffPortalObserver(viewer), false);
assert.deepStrictEqual(
  authorizeStaffPortalObserverRequest(observer, { method: 'GET', pathname: '/staff/inbox/thread/abc' }),
  { ok: true },
);
assert.deepStrictEqual(
  authorizeStaffPortalObserverRequest(observer, { method: 'HEAD', pathname: '/staff/conversations' }),
  { ok: true },
);
for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
  assert.deepStrictEqual(
    authorizeStaffPortalObserverRequest(observer, { method, pathname: '/staff/inbox/send-reply' }),
    { ok: false, status: 403, body: { success: false, error: 'observer_read_only' } },
  );
}
assert.deepStrictEqual(
  authorizeStaffPortalObserverRequest({ ...observer, client_slug: 'sunset' }, { method: 'GET', pathname: '/staff/conversations' }),
  { ok: false, status: 403, body: { success: false, error: 'observer_wrong_client' } },
);
assert.deepStrictEqual(
  authorizeStaffPortalObserverRequest(observer, { method: 'GET', pathname: '/staff/inbox/whatsapp/draft' }),
  { ok: false, status: 403, body: { success: false, error: 'observer_draft_forbidden' } },
);
assert.strictEqual(shouldGenerateInboxDraftOnOpen(observer), false);
assert.strictEqual(shouldGenerateInboxDraftOnOpen(viewer), true);

const apiSource = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
const compositeSource = fs.readFileSync(path.join(__dirname, 'lib', 'staff-inbox-thread-composite.js'), 'utf8');
const access = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'clients', 'staff-portal-access.json'), 'utf8'));
assert.match(apiSource, /authorizeStaffPortalObserverRequest\(user,/);
assert.match(apiSource, /conversation\.channel === 'email' && conversation\.needs_human === true\s*&& shouldGenerateInboxDraftOnOpen\(user\)/);
assert.match(apiSource, /let draft = rows\[0\];\s*if \(shouldGenerateInboxDraftOnOpen\(user\)\) \{\s*try \{/);
assert.match(compositeSource, /shouldGenerateInboxDraftOnOpen\(user\)/);
assert.deepStrictEqual(access.client_access['lunabot-prod@lunafrontdesk.com'], ['wolfhouse-somo']);

console.log('PASS verify-staff-portal-observer');
