'use strict';

/**
 * Minimal staff portal HTTP server for Sunset Admin render verification.
 * Serves /staff/ui, /staff/auth/session, /staff/admin/config, and safe stubs
 * for schedule/inbox fetches triggered during portal startup.
 */

const http = require('http');
const url = require('url');
const { buildVerifyStaffUiHtml } = require('../lib/sunset-admin-verify-ui-html');
const {
  buildClientProfilesMap,
  getAccessibleClients,
} = require('../lib/staff-portal-clients');
const { resolveTenantBusinessConfig } = require('../lib/tenant-business-config');

let cachedHtml = null;

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function getUiHtml() {
  if (!cachedHtml) cachedHtml = buildVerifyStaffUiHtml();
  return cachedHtml;
}

function handleSession(res) {
  sendJson(res, 200, {
    success: true,
    auth_required: false,
    role: 'owner',
    email: null,
    display_name: null,
    clients: getAccessibleClients(null),
    client_profiles: buildClientProfilesMap(null),
    can_use_owner_insights: true,
  });
}

function handleAdminConfig(query, res) {
  const clientSlug = String(query.client || 'sunset').trim();
  const locationId = String(query.location || 'sunset-somo').trim();
  const resolved = resolveTenantBusinessConfig(clientSlug, locationId);
  if (!resolved.ok) {
    return sendJson(res, 403, { success: false, error: resolved.reason || 'unsupported_client' });
  }
  const { ok, ...payload } = resolved;
  return sendJson(res, 200, {
    success: true,
    ...payload,
    read_only: false,
    writes_enabled: true,
  });
}

function handleScheduleDay(res) {
  sendJson(res, 200, {
    success: true,
    date: new Date().toISOString().slice(0, 10),
    lessons: [],
    gear: [],
    rows: [],
  });
}

function handleSchedulePackCounts(res) {
  sendJson(res, 200, {
    success: true,
    counts: {},
  });
}

function createSunsetAdminVerifyServer() {
  return http.createServer((req, res) => {
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname || '/';

    if (req.method !== 'GET' && !(req.method === 'POST' && pathname === '/staff/auth/login')) {
      res.writeHead(405, { Allow: 'GET' });
      return res.end('method not allowed');
    }

    if (pathname === '/staff/auth/session') return handleSession(res);
    if (pathname === '/staff/ui') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(getUiHtml());
    }
    if (pathname === '/staff/admin/config') return handleAdminConfig(parsed.query, res);
    if (pathname === '/staff/conversations') {
      return sendJson(res, 200, { success: true, conversations: [] });
    }
    if (pathname === '/staff/intents') {
      return sendJson(res, 200, { success: true, intents: {}, categories: [] });
    }
    if (pathname === '/staff/query') {
      return sendJson(res, 200, { success: true, rows: [] });
    }
    if (pathname === '/staff/bot/global-pause-state') {
      return sendJson(res, 200, { success: true, paused: false });
    }
    if (pathname === '/staff/schedule/day') return handleScheduleDay(res);
    if (pathname === '/staff/schedule/surf-pack-counts') return handleSchedulePackCounts(res);
    if (pathname.startsWith('/staff/schedule/')) {
      return sendJson(res, 200, { success: true, rows: [], days: [] });
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });
}

module.exports = {
  createSunsetAdminVerifyServer,
};
