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

/** Offline verify: baseline config file has no surf_packs (DB-owned in prod). */
const VERIFY_ADMIN_DEMO_SURF_PACKS = [{
  pack_id: 'verify-demo-pack',
  label: 'Adult group course (verify)',
  age_band: '12_and_up',
  group_size: 16,
  beaches: ['somo'],
  weekly: 'mon_fri',
  schedules: [{ key: '1000_1200', label: '10:00-12:00' }],
  price_tiers: [{ days: 5, amount: 195 }],
}];

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
  if (!Array.isArray(payload.surf_packs) || !payload.surf_packs.length) {
    payload.surf_packs = VERIFY_ADMIN_DEMO_SURF_PACKS.slice();
  }
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
    // Production /staff/ui starts several optional backend owners. Keep this
    // offline fixture fail-quiet with safe API responses; browser tests may
    // still intercept the one endpoint whose behavior they are exercising.
    if (pathname.startsWith('/staff/assets/')) {
      res.writeHead(204);
      return res.end();
    }
    if (pathname.startsWith('/staff/')) {
      return sendJson(res, 200, { success: true, rows: [], conversations: [] });
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });
}

module.exports = {
  createSunsetAdminVerifyServer,
};
