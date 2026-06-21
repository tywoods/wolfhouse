/**
 * Staff Portal — list deploy-config clients and resolve per-user access.
 *
 * @module staff-portal-clients
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CLIENTS_DIR = path.join(__dirname, '..', '..', 'config', 'clients');
const ACCESS_FILE = path.join(CLIENTS_DIR, 'staff-portal-access.json');

const SURF_VERTICALS = new Set([
  'surf_school_rentals',
  'surf_shop_rentals',
  'surf_school_lessons',
  'lessons',
]);

const DEFAULT_LODGING_VERTICAL = 'lodging_surf_house';

function readAccessConfig() {
  try {
    return JSON.parse(fs.readFileSync(ACCESS_FILE, 'utf8'));
  } catch {
    return { all_clients_emails: [], client_access: {} };
  }
}

function loadBaselineJson(clientSlug) {
  const slug = String(clientSlug || '').trim();
  if (!slug) return null;
  try {
    const filePath = path.join(CLIENTS_DIR, `${slug}.baseline.json`);
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function resolveVertical(cfg) {
  if (!cfg) return DEFAULT_LODGING_VERTICAL;
  return (cfg._meta && cfg._meta.vertical)
    || (cfg.portal && cfg.portal.vertical)
    || DEFAULT_LODGING_VERTICAL;
}

function isSurfVertical(vertical) {
  return SURF_VERTICALS.has(String(vertical || '').trim());
}

function loadLessonSlotsDemo(cfg) {
  if (!cfg || !cfg.portal_demo) return [];
  const slots = cfg.portal_demo.lesson_slots;
  if (!Array.isArray(slots)) return [];
  return slots.map((s) => ({
    slot_id: s.slot_id || null,
    date: s.date || null,
    slot_time: s.slot_time || null,
    session_type: s.session_type || null,
    offering_label: s.offering_label || null,
    capacity: s.capacity != null ? Number(s.capacity) : null,
    seats_booked: s.seats_booked != null ? Number(s.seats_booked) : null,
    seats_available: s.seats_available != null ? Number(s.seats_available) : null,
    status: s.status || null,
    source: s.source || 'demo_seed',
  }));
}

const { normalizeSunsetLocationId, DEFAULT_SUNSET_LOCATION_ID } = require('./sunset-school-locations');

function loadInboxThreadsDemo(cfg) {
  if (!cfg || !cfg.portal_demo) return [];
  const threads = cfg.portal_demo.inbox_threads;
  if (!Array.isArray(threads)) return [];
  return threads.map((row, idx) => ({
    thread_id: row.thread_id || row.conversation_id || null,
    channel: row.channel === 'email' ? 'email' : 'whatsapp',
    guest_name: row.guest_name || null,
    guest_email: row.guest_email || null,
    phone: row.phone || null,
    email_subject: row.email_subject || null,
    last_message_preview: row.last_message_preview || '',
    needs_human: !!row.needs_human,
    handoff_reason: row.handoff_reason || null,
    luna_paused: !!row.luna_paused,
    relative_time: row.relative_time || null,
    location_id: normalizeSunsetLocationId(
      row.location_id || (idx >= 2 ? 'sunset-sardinero' : DEFAULT_SUNSET_LOCATION_ID),
    ),
    source: row.source || 'demo_preview',
  }));
}

/**
 * Per-tenant portal shell profile (tab gating, default tab, demo lesson slots).
 * Wolfhouse (lodging_surf_house) preserves legacy defaults.
 */
function loadClientPortalProfile(clientSlug) {
  const slug = String(clientSlug || '').trim();
  const cfg = loadBaselineJson(slug);
  const vertical = resolveVertical(cfg);
  const surf = isSurfVertical(vertical);
  return {
    client_slug: slug,
    vertical,
    is_surf_vertical: surf,
    default_tab: surf ? 'portal-home' : 'bed-calendar',
    hidden_tabs: surf ? ['bed-calendar', 'tour-operator'] : [],
    hidden_drawer_tabs: surf ? ['transfers'] : [],
    lesson_slots_demo: surf ? loadLessonSlotsDemo(cfg) : [],
    inbox_threads_demo: surf ? loadInboxThreadsDemo(cfg) : [],
    demo_mode: !!(cfg && cfg.portal_demo && cfg.portal_demo.demo_mode),
  };
}

function buildClientProfilesMap(user) {
  const clients = getAccessibleClients(user);
  const out = {};
  for (const c of clients) {
    out[c.slug] = loadClientPortalProfile(c.slug);
  }
  return out;
}

/**
 * Session-scoped portal clients: login company (auth_sessions.client_id) is authoritative.
 * Never return the full multi-tenant allow-list from /staff/auth/session.
 */
function getSessionScopedClients(user) {
  if (!user) return getAccessibleClients(null);
  const activeSlug = String(user.client_slug || '').trim();
  if (!activeSlug) return [];
  if (!userCanAccessClient(user, activeSlug)) return [];
  return listBaselineClients().filter((c) => c.slug === activeSlug);
}

function buildSessionClientProfilesMap(user) {
  const clients = getSessionScopedClients(user);
  const out = {};
  for (const c of clients) {
    out[c.slug] = loadClientPortalProfile(c.slug);
  }
  return out;
}

function listBaselineClients() {
  const out = [];
  let files = [];
  try {
    files = fs.readdirSync(CLIENTS_DIR);
  } catch {
    return out;
  }
  for (const file of files) {
    if (!file.endsWith('.baseline.json')) continue;
    const full = path.join(CLIENTS_DIR, file);
    try {
      const json = JSON.parse(fs.readFileSync(full, 'utf8'));
      const slug = (json._meta && json._meta.client_slug)
        || file.replace(/\.baseline\.json$/, '');
      const name = (json.deploy_config && json.deploy_config.identity && json.deploy_config.identity.name)
        || (json._meta && json._meta.client_name)
        || (json._meta && json._meta.client_slug)
        || slug;
      out.push({ slug, name: String(name) });
    } catch {
      /* skip invalid */
    }
  }
  out.sort((a, b) => a.slug.localeCompare(b.slug));
  return out;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function getAccessibleClientSlugs(user) {
  const all = listBaselineClients().map((c) => c.slug);
  if (!user || !user.email) return all;
  const email = normalizeEmail(user.email);
  const cfg = readAccessConfig();
  const explicit = cfg.client_access && cfg.client_access[email];
  if (Array.isArray(explicit) && explicit.length > 0) {
    const allowed = new Set(
      explicit.map((slug) => String(slug || '').trim()).filter(Boolean),
    );
    return all.filter((slug) => allowed.has(slug));
  }
  const allEmails = (cfg.all_clients_emails || []).map(normalizeEmail);
  if (allEmails.includes(email)) return all;
  return [];
}

function getAccessibleClients(user) {
  const allowed = new Set(getAccessibleClientSlugs(user));
  return listBaselineClients().filter((c) => allowed.has(c.slug));
}

function userCanAccessClient(user, clientSlug) {
  const slug = String(clientSlug || '').trim();
  if (!slug) return false;
  return getAccessibleClientSlugs(user).includes(slug);
}

const ROLE_RANK_PORTAL = { viewer: 1, operator: 2, admin: 3, owner: 4 };

function resolveStaffRole(user) {
  if (!user) return null;
  const dbRole = user.role || 'viewer';
  const email = normalizeEmail(user.email);
  const cfg = readAccessConfig();
  const admins = new Set((cfg.portal_admin_emails || []).map(normalizeEmail));
  if (admins.has(email) && (ROLE_RANK_PORTAL[dbRole] || 0) < ROLE_RANK_PORTAL.admin) {
    return 'admin';
  }
  return dbRole;
}

/** Owner Insights (25j): portal session must be owner or admin — not operator/viewer. */
function canUseOwnerInsights(user) {
  if (!user) return false;
  const role = resolveStaffRole(user);
  return role === 'owner' || role === 'admin';
}

module.exports = {
  listBaselineClients,
  getAccessibleClients,
  getAccessibleClientSlugs,
  getSessionScopedClients,
  userCanAccessClient,
  resolveStaffRole,
  canUseOwnerInsights,
  loadBaselineJson,
  loadClientPortalProfile,
  buildClientProfilesMap,
  buildSessionClientProfilesMap,
  isSurfVertical,
  SURF_VERTICALS,
};
