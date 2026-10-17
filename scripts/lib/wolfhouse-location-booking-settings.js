'use strict';

/**
 * Wolfhouse Staff location + booking settings.
 * The Luna Staff cards call these routes. They were never registered, so
 * France TEST answered 404 and the cards stayed on built-in defaults.
 *
 * Persistence is one row per Wolfhouse tenant, created at runtime the same
 * way house notes are (France cannot run a migration from this slice).
 * Booking-settings lock is computed: a paid deposit for this tenant locks
 * the booking card. Location stays editable.
 */

const CLIENT_SLUG = 'wolfhouse-somo';
const TABLE = 'wolfhouse_location_booking_settings';
const ADDRESS_MAX = 500;
const MAP_URL_MAX = 2000;
const HOLD_MIN = 1;
const HOLD_MAX = 525600;

const DEFAULTS = Object.freeze({
  address_text: 'C. Mies de La Ran, 41, 39140 Somo, Cantabria',
  google_maps_url: 'https://maps.app.goo.gl/oPRckhqozVBvXxL16',
  unpaid_hold_minutes: 60,
  require_each_guest_deposit: false,
});

function isSafeMapUrl(value) {
  const raw = String(value == null ? '' : value);
  if (/[\u0000-\u001F\u007F-\u009F]/.test(raw)) return false;
  const text = raw.trim();
  if (!text) return true;
  if (text.length > MAP_URL_MAX) return false;
  try {
    const parsed = new URL(text);
    return parsed.protocol === 'https:' && !!parsed.hostname && !parsed.username && !parsed.password;
  } catch (_error) {
    return false;
  }
}

function validateLocationBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'invalid_location' };
  }
  const address = String(body.address_text == null ? '' : body.address_text).trim();
  const maps = String(body.google_maps_url == null ? '' : body.google_maps_url).trim();
  if (!address || address.length > ADDRESS_MAX) {
    return { ok: false, status: 400, error: 'invalid_address' };
  }
  if (!isSafeMapUrl(maps)) return { ok: false, status: 400, error: 'invalid_map_url' };
  return { ok: true, address_text: address, google_maps_url: maps };
}

function validateBookingBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'invalid_booking_settings' };
  }
  const minutes = body.unpaid_hold_minutes;
  if (!Number.isInteger(minutes) || minutes < HOLD_MIN || minutes > HOLD_MAX) {
    return { ok: false, status: 400, error: 'invalid_hold_minutes' };
  }
  if (typeof body.require_each_guest_deposit !== 'boolean') {
    return { ok: false, status: 400, error: 'invalid_require_each_guest_deposit' };
  }
  return {
    ok: true,
    unpaid_hold_minutes: minutes,
    require_each_guest_deposit: body.require_each_guest_deposit,
  };
}

function settingsFromRow(row, lock) {
  const locked = lock === true;
  return {
    location: {
      address_text: row ? row.address_text : DEFAULTS.address_text,
      google_maps_url: row ? row.google_maps_url : DEFAULTS.google_maps_url,
    },
    booking_settings: {
      unpaid_hold_minutes: row ? row.unpaid_hold_minutes : DEFAULTS.unpaid_hold_minutes,
      require_each_guest_deposit: row
        ? row.require_each_guest_deposit === true
        : DEFAULTS.require_each_guest_deposit,
      locked,
      lock_reason: locked ? 'deposit_received' : '',
    },
  };
}

async function ensureTable(pg) {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      client_slug text PRIMARY KEY,
      address_text text NOT NULL,
      google_maps_url text NOT NULL DEFAULT '',
      unpaid_hold_minutes integer NOT NULL,
      require_each_guest_deposit boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by uuid
    )`);
}

async function readRow(pg, clientSlug) {
  await ensureTable(pg);
  const res = await pg.query(
    `SELECT address_text, google_maps_url, unpaid_hold_minutes, require_each_guest_deposit
       FROM ${TABLE}
      WHERE client_slug = $1`,
    [clientSlug],
  );
  return res.rows[0] || null;
}

async function depositLanded(pg, clientSlug) {
  const probe = await pg.query(
    `SELECT to_regclass('public.payments') AS payments,
            to_regclass('public.clients') AS clients`,
  );
  const rel = probe.rows[0] || {};
  if (!rel.payments || !rel.clients) return false;
  const cols = await pg.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'payments'
        AND column_name IN ('client_id', 'status', 'amount_paid_cents', 'payment_kind')`,
  );
  const names = new Set(cols.rows.map((row) => row.column_name));
  if (!names.has('client_id') || !names.has('status')) return false;
  const amountSql = names.has('amount_paid_cents')
    ? 'AND COALESCE(p.amount_paid_cents, 0) > 0'
    : '';
  const kindSql = names.has('payment_kind')
    ? `AND p.payment_kind::text IN ('deposit', 'deposit_only')`
    : '';
  const res = await pg.query(
    `SELECT EXISTS (
       SELECT 1
         FROM payments p
         INNER JOIN clients c ON c.id = p.client_id
        WHERE c.slug = $1
          AND p.status::text = 'paid'
          ${amountSql}
          ${kindSql}
     ) AS landed`,
    [clientSlug],
  );
  return !!(res.rows[0] && res.rows[0].landed);
}

async function readSettings(pg, clientSlug) {
  const row = await readRow(pg, clientSlug);
  const locked = await depositLanded(pg, clientSlug);
  return settingsFromRow(row, locked);
}

async function saveLocation(pg, clientSlug, location, actorId) {
  await ensureTable(pg);
  await pg.query(
    `INSERT INTO ${TABLE} (
       client_slug, address_text, google_maps_url, unpaid_hold_minutes,
       require_each_guest_deposit, updated_by
     ) VALUES ($1, $2, $3, $4, false, $5::uuid)
     ON CONFLICT (client_slug) DO UPDATE
       SET address_text = EXCLUDED.address_text,
           google_maps_url = EXCLUDED.google_maps_url,
           updated_at = now(),
           updated_by = EXCLUDED.updated_by`,
    [clientSlug, location.address_text, location.google_maps_url, DEFAULTS.unpaid_hold_minutes, actorId],
  );
}

async function saveBooking(pg, clientSlug, booking, actorId) {
  await ensureTable(pg);
  await pg.query(
    `INSERT INTO ${TABLE} (
       client_slug, address_text, google_maps_url, unpaid_hold_minutes,
       require_each_guest_deposit, updated_by
     ) VALUES ($1, $2, $3, $4, $5, $6::uuid)
     ON CONFLICT (client_slug) DO UPDATE
       SET unpaid_hold_minutes = EXCLUDED.unpaid_hold_minutes,
           require_each_guest_deposit = EXCLUDED.require_each_guest_deposit,
           updated_at = now(),
           updated_by = EXCLUDED.updated_by`,
    [
      clientSlug,
      DEFAULTS.address_text,
      DEFAULTS.google_maps_url,
      booking.unpaid_hold_minutes,
      booking.require_each_guest_deposit,
      actorId,
    ],
  );
}

function actorId(user) {
  const id = user && user.staff_user_id ? String(user.staff_user_id) : '';
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : null;
}

function createWolfhouseLocationBookingSettingsRoutes(deps) {
  const {
    sendJSON,
    send400,
    readBody,
    assertStaffClientAccess,
    appendAuditLog,
    withPgClient,
    SQL_INJECT_RE,
  } = deps;

  function rejectOtherClient(query, res) {
    const requested = String((query && (query.client || query.client_slug)) || '').trim();
    if (requested && requested !== CLIENT_SLUG) {
      sendJSON(res, 404, { success: false, error: 'Not found' });
      return true;
    }
    if (SQL_INJECT_RE && SQL_INJECT_RE.test(requested)) {
      send400(res, 'invalid client slug');
      return true;
    }
    return false;
  }

  async function readJson(req, res) {
    let raw;
    try {
      raw = await readBody(req);
    } catch (_error) {
      send400(res, 'invalid JSON body');
      return null;
    }
    try {
      const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
      return JSON.parse(text || '{}');
    } catch (_error) {
      send400(res, 'invalid JSON body');
      return null;
    }
  }

  async function handleGet(query, _req, res, user) {
    if (rejectOtherClient(query, res)) return;
    if (!assertStaffClientAccess(user, CLIENT_SLUG, res)) return;
    try {
      const settings = await withPgClient((pg) => readSettings(pg, CLIENT_SLUG));
      return sendJSON(res, 200, { success: true, ...settings });
    } catch (err) {
      console.error('[location-booking-settings.get] failed:', err && err.code, '|', err && err.message);
      return sendJSON(res, 500, { success: false, error: 'read failed' });
    }
  }

  async function handleLocationPut(query, req, res, user) {
    if (rejectOtherClient(query, res)) return;
    if (!assertStaffClientAccess(user, CLIENT_SLUG, res)) return;
    const body = await readJson(req, res);
    if (!body) return;
    const location = validateLocationBody(body);
    if (!location.ok) return sendJSON(res, location.status, { success: false, error: location.error });
    try {
      await withPgClient((pg) => saveLocation(pg, CLIENT_SLUG, location, actorId(user)));
      if (typeof appendAuditLog === 'function') {
        appendAuditLog({
          ts: new Date().toISOString(),
          intent: 'api:location.set',
          category: 'admin_api',
          client_slug: CLIENT_SLUG,
          success: true,
          staff_user_id: user ? user.staff_user_id : null,
        });
      }
      return sendJSON(res, 200, { success: true });
    } catch (err) {
      console.error('[location.put] failed:', err && err.code, '|', err && err.message);
      return sendJSON(res, 500, { success: false, error: 'write failed' });
    }
  }

  async function handleBookingPut(query, req, res, user) {
    if (rejectOtherClient(query, res)) return;
    if (!assertStaffClientAccess(user, CLIENT_SLUG, res)) return;
    const body = await readJson(req, res);
    if (!body) return;
    const booking = validateBookingBody(body);
    if (!booking.ok) return sendJSON(res, booking.status, { success: false, error: booking.error });
    try {
      const saved = await withPgClient(async (pg) => {
        const current = await readSettings(pg, CLIENT_SLUG);
        if (current.booking_settings.locked) {
          return { locked: true, settings: current };
        }
        await saveBooking(pg, CLIENT_SLUG, booking, actorId(user));
        return { locked: false, settings: await readSettings(pg, CLIENT_SLUG) };
      });
      if (saved.locked) {
        return sendJSON(res, 409, {
          success: false,
          error: 'booking_settings_locked',
          lock_reason: 'deposit_received',
        });
      }
      if (typeof appendAuditLog === 'function') {
        appendAuditLog({
          ts: new Date().toISOString(),
          intent: 'api:booking_settings.set',
          category: 'admin_api',
          client_slug: CLIENT_SLUG,
          success: true,
          staff_user_id: user ? user.staff_user_id : null,
        });
      }
      return sendJSON(res, 200, { success: true, booking_settings: saved.settings.booking_settings });
    } catch (err) {
      console.error('[booking-settings.put] failed:', err && err.code, '|', err && err.message);
      return sendJSON(res, 500, { success: false, error: 'write failed' });
    }
  }

  return {
    handleLocationBookingSettingsGet: handleGet,
    handleLocationPut,
    handleBookingSettingsPut: handleBookingPut,
  };
}

module.exports = {
  CLIENT_SLUG,
  TABLE,
  DEFAULTS,
  isSafeMapUrl,
  validateLocationBody,
  validateBookingBody,
  settingsFromRow,
  createWolfhouseLocationBookingSettingsRoutes,
};
