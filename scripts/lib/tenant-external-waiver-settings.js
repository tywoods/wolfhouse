'use strict';

/**
 * Tenant-wide external waiver settings (business-scoped, not per-location).
 *
 * One configuration per client_slug:
 *   - enabled: whether Staff/Luna should offer an external Google Form link
 *   - external_form_url: validated HTTPS Google Forms URL
 *
 * V1 is link-only. Never infers completion/signature/submission from the URL.
 * Fail closed on missing client_slug. Native Sunset waiver tables remain for
 * historical completed records only when external mode is active.
 */

const TABLE = 'tenant_external_waiver_settings';
const URL_MAX = 2000;

/** Hosts allowed for external Google Forms links (exact host match only). */
const ALLOWED_HOSTS = new Set([
  'docs.google.com',
  'forms.gle',
]);

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

/**
 * Validate and normalize an external Google Forms URL.
 * Accepts only https URLs on an explicit host allowlist with safe path shapes.
 * Rejects credentials, fragments, userinfo, non-https schemes, subdomain tricks,
 * unrelated hosts, and malformed URLs.
 *
 * @returns {{ ok: true, url: string } | { ok: false, error: string }}
 */
function validateExternalWaiverFormUrl(raw) {
  const input = trimStr(raw);
  if (!input) {
    return { ok: false, error: 'external_form_url is required when enabled' };
  }
  if (input.length > URL_MAX) {
    return { ok: false, error: 'external_form_url too long' };
  }
  // Reject whitespace / control chars that can hide host tricks.
  if (/[\u0000-\u001f\u007f\s]/.test(input)) {
    return { ok: false, error: 'external_form_url contains invalid characters' };
  }
  // Reject credentials embedded before parse (user:pass@host).
  if (/^https?:\/\/[^/]*@/i.test(input)) {
    return { ok: false, error: 'external_form_url must not include credentials' };
  }

  let u;
  try {
    u = new URL(input);
  } catch (_) {
    return { ok: false, error: 'external_form_url is not a valid URL' };
  }

  if (u.protocol !== 'https:') {
    return { ok: false, error: 'external_form_url must use https' };
  }
  if (u.username || u.password) {
    return { ok: false, error: 'external_form_url must not include credentials' };
  }
  if (u.hash) {
    return { ok: false, error: 'external_form_url must not include a fragment' };
  }

  const host = String(u.hostname || '').toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    return { ok: false, error: 'external_form_url host is not an allowed Google Forms host' };
  }

  // Block backslash / encoded tricks that some browsers normalize as path separators.
  if (input.includes('\\') || /%5c/i.test(input)) {
    return { ok: false, error: 'external_form_url contains invalid path characters' };
  }
  // Reject path traversal sequences in the raw input (URL may normalize them away).
  if (input.includes('..') || /%2e%2e/i.test(input)) {
    return { ok: false, error: 'external_form_url must not contain path traversal' };
  }

  const path = u.pathname || '';
  if (host === 'docs.google.com') {
    // Normal Google Forms: /forms/d/e/<id>/viewform or /forms/d/<id>/viewform etc.
    if (!/^\/forms\//i.test(path)) {
      return { ok: false, error: 'external_form_url path must be a Google Forms path' };
    }
    // Reject non-forms product paths that share the host (docs, sheets, etc.).
    if (/^\/(document|spreadsheets|presentation|drive)\//i.test(path)) {
      return { ok: false, error: 'external_form_url path must be a Google Forms path' };
    }
  } else if (host === 'forms.gle') {
    // Short links: /<token>
    if (!/^\/[A-Za-z0-9_-]{4,128}\/?$/.test(path)) {
      return { ok: false, error: 'external_form_url path is not a valid forms.gle short link' };
    }
  }

  // Normalize: origin + pathname + search (no hash), drop trailing slash noise on forms.gle.
  let normalized = `${u.origin}${u.pathname}${u.search}`;
  if (host === 'forms.gle' && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return { ok: true, url: normalized };
}

/**
 * Normalize a settings payload for persistence / API responses.
 * When enabled=false, URL may be empty (stored null). When enabled=true, URL
 * must pass validateExternalWaiverFormUrl.
 *
 * Missing/blank client_slug fails closed.
 */
function normalizeExternalWaiverSettings(input) {
  const src = input || {};
  const clientSlug = trimStr(src.client_slug || src.clientSlug || src.client);
  if (!clientSlug) {
    return { ok: false, status: 400, error: 'client_slug is required' };
  }
  if (/[;'"]|--|\/\*|\*\//.test(clientSlug) || clientSlug.length > 80) {
    return { ok: false, status: 400, error: 'invalid client_slug' };
  }

  const enabledRaw = src.enabled;
  const enabled = enabledRaw === true
    || enabledRaw === 'true'
    || enabledRaw === 1
    || enabledRaw === '1';

  const rawUrl = src.external_form_url != null
    ? src.external_form_url
    : (src.externalFormUrl != null ? src.externalFormUrl : src.url);
  const urlTrim = trimStr(rawUrl);

  if (!enabled) {
    // Allow clearing URL on disable; if provided and non-empty, still validate so bad links cannot be stored.
    if (urlTrim) {
      const v = validateExternalWaiverFormUrl(urlTrim);
      if (!v.ok) return { ok: false, status: 400, error: v.error };
      return {
        ok: true,
        client_slug: clientSlug,
        enabled: false,
        external_form_url: v.url,
      };
    }
    return {
      ok: true,
      client_slug: clientSlug,
      enabled: false,
      external_form_url: null,
    };
  }

  const v = validateExternalWaiverFormUrl(urlTrim);
  if (!v.ok) return { ok: false, status: 400, error: v.error };
  return {
    ok: true,
    client_slug: clientSlug,
    enabled: true,
    external_form_url: v.url,
  };
}

/**
 * Public status for Staff/Admin/Luna.
 * - disabled: toggle off
 * - enabled_configured: toggle on + valid URL stored
 * - enabled_missing_link: toggle on but URL missing/invalid (should not happen if writes validated)
 * - native_default: no row / config absent → preserve native waiver behavior
 */
function resolveExternalWaiverMode(settings) {
  if (!settings || settings.enabled !== true) {
    if (!settings || (settings.external_form_url == null && settings.enabled !== true && settings._absent === true)) {
      return {
        mode: 'native_default',
        link_available: false,
        public_url: null,
        status_label: 'native_default',
      };
    }
    return {
      mode: 'disabled',
      link_available: false,
      public_url: null,
      status_label: 'disabled',
    };
  }
  const url = trimStr(settings.external_form_url);
  if (!url) {
    return {
      mode: 'enabled_missing_link',
      link_available: false,
      public_url: null,
      status_label: 'enabled_missing_link',
    };
  }
  const v = validateExternalWaiverFormUrl(url);
  if (!v.ok) {
    return {
      mode: 'enabled_missing_link',
      link_available: false,
      public_url: null,
      status_label: 'enabled_missing_link',
    };
  }
  return {
    mode: 'enabled_configured',
    link_available: true,
    public_url: v.url,
    status_label: 'enabled_configured',
    // V1 truth: external links are never treated as completed/signed/verified.
    verification: 'external_unverified',
  };
}

function defaultAbsentSettings(clientSlug) {
  return {
    client_slug: clientSlug || null,
    enabled: false,
    external_form_url: null,
    updated_at: null,
    updated_by: null,
    _absent: true,
  };
}

function mapSettingsRow(row, clientSlug) {
  if (!row) return defaultAbsentSettings(clientSlug);
  return {
    client_slug: row.client_slug || clientSlug,
    enabled: row.enabled === true,
    external_form_url: row.external_form_url || null,
    updated_at: row.updated_at || null,
    updated_by: row.updated_by || null,
    _absent: false,
  };
}

async function ensureExternalWaiverSettingsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      client_slug        TEXT NOT NULL UNIQUE,
      enabled            BOOLEAN NOT NULL DEFAULT FALSE,
      external_form_url  TEXT NULL,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by         UUID
    )`);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_tenant_external_waiver_settings_client
      ON ${TABLE} (client_slug)`);
}

/**
 * Read tenant-wide external waiver settings. Fail closed without client_slug.
 * Missing row → native_default (backward compatible).
 */
async function getExternalWaiverSettings(client, { clientSlug } = {}) {
  const slug = trimStr(clientSlug);
  if (!slug) {
    return { ok: false, status: 400, error: 'client_slug is required' };
  }
  await ensureExternalWaiverSettingsTable(client);
  const res = await client.query(
    `SELECT client_slug, enabled, external_form_url, updated_at, updated_by::text AS updated_by
       FROM ${TABLE}
      WHERE client_slug = $1
      LIMIT 1`,
    [slug],
  );
  const settings = mapSettingsRow(res.rows[0], slug);
  const mode = resolveExternalWaiverMode(settings);
  return {
    ok: true,
    settings,
    mode: mode.mode,
    link_available: mode.link_available,
    public_url: mode.public_url,
    status_label: mode.status_label,
    verification: mode.verification || null,
  };
}

/**
 * Upsert tenant-wide external waiver settings. Server-authoritative validation.
 */
async function setExternalWaiverSettings(client, { clientSlug, enabled, external_form_url, actor } = {}) {
  const normalized = normalizeExternalWaiverSettings({
    client_slug: clientSlug,
    enabled,
    external_form_url,
  });
  if (!normalized.ok) {
    return { ok: false, status: normalized.status || 400, error: normalized.error };
  }
  await ensureExternalWaiverSettingsTable(client);
  const res = await client.query(
    `INSERT INTO ${TABLE} (client_slug, enabled, external_form_url, updated_by)
          VALUES ($1, $2, $3, $4::uuid)
     ON CONFLICT (client_slug) DO UPDATE
          SET enabled = EXCLUDED.enabled,
              external_form_url = EXCLUDED.external_form_url,
              updated_at = NOW(),
              updated_by = EXCLUDED.updated_by
      RETURNING client_slug, enabled, external_form_url, updated_at, updated_by::text AS updated_by`,
    [
      normalized.client_slug,
      normalized.enabled,
      normalized.external_form_url,
      (actor && (actor.staff_user_id || actor.id)) || null,
    ],
  );
  const settings = mapSettingsRow(res.rows[0], normalized.client_slug);
  const mode = resolveExternalWaiverMode(settings);
  return {
    ok: true,
    settings,
    mode: mode.mode,
    link_available: mode.link_available,
    public_url: mode.public_url,
    status_label: mode.status_label,
    verification: mode.verification || null,
  };
}

/**
 * Resolve whether Staff/Luna may generate/offer a waiver link for this tenant.
 * external configured → use external URL (no native create)
 * disabled / missing-link → no link
 * absent config → native path (caller continues)
 */
async function resolveWaiverOfferForTenant(client, { clientSlug } = {}) {
  const got = await getExternalWaiverSettings(client, { clientSlug });
  if (!got.ok) return got;
  const mode = got.mode;
  if (mode === 'native_default') {
    return {
      ok: true,
      offer: 'native',
      mode,
      public_url: null,
      link_available: false,
      verification: null,
      settings: got.settings,
    };
  }
  if (mode === 'enabled_configured' && got.public_url) {
    return {
      ok: true,
      offer: 'external',
      mode,
      public_url: got.public_url,
      link_available: true,
      verification: 'external_unverified',
      settings: got.settings,
    };
  }
  // disabled or enabled_missing_link — no new link may be offered
  return {
    ok: true,
    offer: 'none',
    mode,
    public_url: null,
    link_available: false,
    verification: null,
    settings: got.settings,
  };
}

/**
 * Staff/Luna-safe external waiver view for a booking (no fake completion).
 */
function buildExternalWaiverStaffView(offer, bookingId) {
  if (!offer || offer.offer !== 'external' || !offer.public_url) return null;
  return {
    id: null,
    status: 'external_unverified',
    request_mode: 'external',
    target_count: null,
    completed_count: 0,
    remaining_count: null,
    public_id: null,
    public_url: offer.public_url,
    form_type: 'external_google_form',
    form_version: null,
    participant_key: null,
    sent_to_phone: null,
    sent_to_email: null,
    completed_at: null,
    expires_at: null,
    created_at: null,
    submission: null,
    external: true,
    verification: 'external_unverified',
    booking_id: bookingId || null,
  };
}

/**
 * Spanish Luna copy for external link — never claims completion.
 */
function buildLunaExternalWaiverInviteMessage(publicUrl) {
  const link = trimStr(publicUrl);
  let msg = 'Perfecto — para terminar la inscripción, Sunset necesita que completes este formulario de inscripción antes de la clase:';
  if (link) msg += `\n${link}`;
  msg += '\n\nCuando lo hayas enviado, el equipo de Sunset lo revisará. Este enlace no confirma por sí solo el envío del formulario.';
  return msg;
}

module.exports = {
  TABLE,
  URL_MAX,
  ALLOWED_HOSTS,
  validateExternalWaiverFormUrl,
  normalizeExternalWaiverSettings,
  resolveExternalWaiverMode,
  ensureExternalWaiverSettingsTable,
  getExternalWaiverSettings,
  setExternalWaiverSettings,
  resolveWaiverOfferForTenant,
  buildExternalWaiverStaffView,
  buildLunaExternalWaiverInviteMessage,
  defaultAbsentSettings,
};
