'use strict';

const OBSERVER_ACCESS_MODE = 'observer';
const OBSERVER_CLIENT_SLUG = 'wolfhouse-somo';
const OBSERVER_DENIED_GET_PATHS = new Set([
  '/staff/inbox/whatsapp/draft',
  '/staff/inbox/email/draft',
  '/staff/inbox/email/luna/draft',
]);

function ownData(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  try {
    const d = Object.getOwnPropertyDescriptor(obj, key);
    return d && Object.prototype.hasOwnProperty.call(d, 'value') && !d.get && !d.set
      ? d.value
      : undefined;
  } catch (_) {
    return undefined;
  }
}

function isStaffPortalObserver(user) {
  const metadata = ownData(user, 'metadata');
  return ownData(metadata, 'portal_access_mode') === OBSERVER_ACCESS_MODE;
}

function deny(error) {
  return { ok: false, status: 403, body: { success: false, error } };
}

function authorizeStaffPortalObserverRequest(user, request) {
  if (!isStaffPortalObserver(user)) return { ok: true };
  if (String(ownData(user, 'client_slug') || '').trim() !== OBSERVER_CLIENT_SLUG) {
    return deny('observer_wrong_client');
  }
  const method = String(ownData(request, 'method') || '').toUpperCase();
  const pathname = String(ownData(request, 'pathname') || '').replace(/\/+$/, '') || '/';
  if (method !== 'GET' && method !== 'HEAD') return deny('observer_read_only');
  if (OBSERVER_DENIED_GET_PATHS.has(pathname)) return deny('observer_draft_forbidden');
  return { ok: true };
}

function shouldGenerateInboxDraftOnOpen(user) {
  return !isStaffPortalObserver(user);
}

module.exports = {
  OBSERVER_ACCESS_MODE,
  OBSERVER_CLIENT_SLUG,
  isStaffPortalObserver,
  authorizeStaffPortalObserverRequest,
  shouldGenerateInboxDraftOnOpen,
};
