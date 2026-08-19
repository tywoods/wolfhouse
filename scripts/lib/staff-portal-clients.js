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
const SUNSET_STAGING_ACCESS_FILE = path.join(CLIENTS_DIR, 'staff-portal-access.sunset-staging.json');
const SUNSET_STAGING_DEPLOYMENT = 'sunset-staging';
const SUNSET_ACCESS_CLIENT_SLUG = 'sunset';

/**
 * Trusted deploy env only — never request headers or caller-supplied input.
 * Overlay when LUNA_DEPLOYMENT=sunset-staging or DEFAULT_CLIENT_SLUG=sunset.
 * Conflicting pair (sunset-staging + non-sunset slug, or sunset slug +
 * non-sunset-staging deployment) fail closed to the Wolfhouse base file.
 */
function envOwnTrimmedString(env, key) {
  const src = env && typeof env === 'object' ? env : process.env;
  if (!Object.prototype.hasOwnProperty.call(src, key)) return '';
  const val = src[key];
  return typeof val === 'string' ? val.trim() : '';
}

function shouldUseSunsetStagingAccess(env) {
  const deploy = envOwnTrimmedString(env, 'LUNA_DEPLOYMENT');
  const slug = envOwnTrimmedString(env, 'DEFAULT_CLIENT_SLUG');
  const sunsetDeploy = deploy === SUNSET_STAGING_DEPLOYMENT;
  const sunsetSlug = slug === SUNSET_ACCESS_CLIENT_SLUG;
  if (sunsetDeploy && slug && !sunsetSlug) return false;
  if (sunsetSlug && deploy && !sunsetDeploy) return false;
  return sunsetDeploy || sunsetSlug;
}

function resolveStaffPortalAccessFile(env) {
  return shouldUseSunsetStagingAccess(env) ? SUNSET_STAGING_ACCESS_FILE : ACCESS_FILE;
}

const SURF_VERTICALS = new Set([
  'surf_school_rentals',
  'surf_shop_rentals',
  'surf_school_lessons',
  'lessons',
]);

const DEFAULT_LODGING_VERTICAL = 'lodging_surf_house';

/** Staging portal hostnames → authoritative deploy client (isolated staging only). */
const STAGING_PORTAL_HOST_CLIENT = {
  'sunset-staging.lunafrontdesk.com': 'sunset',
  'staff-staging.lunafrontdesk.com': 'wolfhouse-somo',
};

/**
 * Resolve the portal's deployment-default client slug from trusted deployment
 * configuration first, then an exact allowlisted canonical hostname, then the
 * Wolfhouse legacy default. Never trust arbitrary Host / X-Forwarded-Host values.
 */
function resolvePortalDeployClient(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const envSlug = process.env.DEFAULT_CLIENT_SLUG;
  if (envSlug != null && String(envSlug).trim()) {
    return String(envSlug).trim();
  }
  const host = String(opts.host || opts.hostname || '').split(':')[0].toLowerCase().trim();
  if (host && STAGING_PORTAL_HOST_CLIENT[host]) {
    return STAGING_PORTAL_HOST_CLIENT[host];
  }
  return 'wolfhouse-somo';
}

/** Staff Portal dev-only tabs (staging/local). Hidden when NODE_ENV=production unless STAFF_PORTAL_DEV_TABS=true. */
const STAFF_PORTAL_DEV_TAB_IDS = ['query-tools', 'luna-guest-simulator'];

function staffPortalDevTabsEnabled() {
  const flag = String(process.env.STAFF_PORTAL_DEV_TABS || '').trim().toLowerCase();
  if (flag === 'true' || flag === '1' || flag === 'yes') return true;
  if (flag === 'false' || flag === '0' || flag === 'no') return false;
  return String(process.env.NODE_ENV || '').toLowerCase() !== 'production';
}

function appendHiddenDevTabs(hidden) {
  const out = Array.isArray(hidden) ? hidden.slice() : [];
  if (staffPortalDevTabsEnabled()) return out;
  for (const tab of STAFF_PORTAL_DEV_TAB_IDS) {
    if (out.indexOf(tab) < 0) out.push(tab);
  }
  return out;
}

function readAccessConfig() {
  try {
    return JSON.parse(fs.readFileSync(resolveStaffPortalAccessFile(), 'utf8'));
  } catch {
    return { all_clients_emails: [], client_access: {} };
  }
}

/**
 * True only when login company matches the session client AND the deploy ACL
 * allows that client. Login must not mint a cookie the session endpoint rejects
 * (that bounce is the Sunset login loop).
 */
function canMintStaffPortalSession(user, loginClientSlug) {
  const slug = String(loginClientSlug || '').trim();
  if (!slug) return false;
  if (!user) return false;
  const sessionSlug = String(user.client_slug || '').trim();
  if (!sessionSlug || sessionSlug !== slug) return false;
  return userCanAccessClient(user, slug);
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
 * Hardcoded fallback for the manual-booking per-guest package selector. Mirrors
 * the legacy Wolfhouse list (kept in sync with the browser BC_GUEST_PACKAGE_OPTIONS).
 */
const MANUAL_BOOKING_PACKAGES_FALLBACK = [
  { value: 'malibu', label: 'Malibu' },
  { value: 'uluwatu', label: 'Uluwatu' },
  { value: 'waimea', label: 'Waimea' },
  { value: 'package_none', label: 'No package' },
];

function titleCasePackageLabel(code) {
  const raw = String(code || '').trim();
  if (!raw) return raw;
  return raw
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Per-client per-guest package options for the manual "Create New Booking" panel.
 * Always appends { value: 'package_none', label: 'No package' }.
 *
 * The per-client package list is read straight from the tenant's baseline config
 * (the same source resolveTenantBusinessConfig() draws its package offerings from),
 * so this stays aligned per client without introducing a require cycle:
 *   1. catalog.accommodation.offerings (package offerings — generic tenant shape)
 *   2. packages.known_packages (Wolfhouse legacy shape → malibu/uluwatu/waimea)
 * Falls back to MANUAL_BOOKING_PACKAGES_FALLBACK if config is missing / empty.
 */
function buildManualBookingPackages(cfg) {
  const packages = [];
  const seen = new Set();
  const push = (value, label) => {
    const code = String(value || '').trim();
    if (!code || code === 'package_none' || seen.has(code)) return;
    seen.add(code);
    packages.push({ value: code, label: label || titleCasePackageLabel(code) });
  };

  try {
    // 1) Generic tenant shape: catalog.accommodation.offerings.
    const offerings = cfg
      && cfg.catalog
      && cfg.catalog.accommodation
      && cfg.catalog.accommodation.offerings;
    if (offerings && typeof offerings === 'object') {
      for (const [key, off] of Object.entries(offerings)) {
        if (!off || typeof off !== 'object') continue;
        push(key, off.label);
      }
    }

    // 2) Wolfhouse legacy shape: packages.known_packages.
    if (!packages.length) {
      const known = cfg && cfg.packages && Array.isArray(cfg.packages.known_packages)
        ? cfg.packages.known_packages
        : [];
      for (const code of known) push(code);
    }
  } catch {
    /* fall through to hardcoded fallback */
  }

  if (!packages.length) {
    return MANUAL_BOOKING_PACKAGES_FALLBACK.slice();
  }
  packages.push({ value: 'package_none', label: 'No package' });
  return packages;
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
    hidden_tabs: appendHiddenDevTabs(surf ? ['bed-calendar', 'tour-operator'] : []),
    hidden_drawer_tabs: surf ? ['transfers'] : [],
    lesson_slots_demo: surf ? loadLessonSlotsDemo(cfg) : [],
    inbox_threads_demo: surf ? loadInboxThreadsDemo(cfg) : [],
    manual_booking_packages: buildManualBookingPackages(cfg),
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
  if (!user) return all;

  // FORTRESS 15E — internal bot principal is bound to one runtime tenant.
  // Never expand email-less bot access to all baseline clients (closes B06).
  // Staff-session ACL below is unchanged (sessions carry email + login client_slug).
  if (user.staff_user_id === 'luna-bot-internal') {
    const bound = String(user.client_slug || '').trim();
    if (!bound) return [];
    return all.filter((slug) => slug === bound);
  }

  if (!user.email) return all;
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
  canMintStaffPortalSession,
  resolveStaffRole,
  canUseOwnerInsights,
  loadBaselineJson,
  loadClientPortalProfile,
  buildClientProfilesMap,
  buildSessionClientProfilesMap,
  staffPortalDevTabsEnabled,
  STAFF_PORTAL_DEV_TAB_IDS,
  isSurfVertical,
  SURF_VERTICALS,
  STAGING_PORTAL_HOST_CLIENT,
  resolvePortalDeployClient,
};
