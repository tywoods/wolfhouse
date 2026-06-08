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

function readAccessConfig() {
  try {
    return JSON.parse(fs.readFileSync(ACCESS_FILE, 'utf8'));
  } catch {
    return { all_clients_emails: [], client_access: {} };
  }
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
  const allEmails = (cfg.all_clients_emails || []).map(normalizeEmail);
  if (allEmails.includes(email)) return all;
  const allowed = (cfg.client_access && cfg.client_access[email]) || [];
  return all.filter((slug) => allowed.includes(slug));
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
  userCanAccessClient,
  resolveStaffRole,
  canUseOwnerInsights,
};
