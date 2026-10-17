'use strict';

/**
 * Wolfhouse Staff portal fields: wetsuit promo text and the staff access code.
 *
 * Runtime table, same pattern as location settings — France cannot run a
 * migration from this slice. The access code is never written to logs, audit,
 * or error text. Luna should read the promo from GET /staff/admin/wetsuit-promo
 * field `text`. Luna must not call the access-code route; that value stays on
 * this staff editor until a confirmed-release path exists.
 */

const CLIENT_SLUG = 'wolfhouse-somo';
const TABLE = 'wolfhouse_staff_portal_fields';
const PROMO_MAX = 500;
const CODE_MAX = 64;

function actorId(user) {
  const id = user && user.staff_user_id ? String(user.staff_user_id) : '';
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : null;
}

function validatePromoBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'invalid_promo' };
  }
  if (Object.keys(body).some((key) => key !== 'text')) {
    return { ok: false, status: 400, error: 'invalid_promo' };
  }
  if (typeof body.text !== 'string') return { ok: false, status: 400, error: 'invalid_promo' };
  const text = body.text.trim();
  if (text.length > PROMO_MAX) return { ok: false, status: 400, error: 'promo_too_long' };
  return { ok: true, text };
}

function validateAccessCodeBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'invalid_access_code' };
  }
  if (Object.keys(body).some((key) => key !== 'code')) {
    return { ok: false, status: 400, error: 'invalid_access_code' };
  }
  if (typeof body.code !== 'string') return { ok: false, status: 400, error: 'invalid_access_code' };
  const code = body.code.trim();
  if (code.length > CODE_MAX) return { ok: false, status: 400, error: 'invalid_access_code' };
  if (code && !/^[\x21-\x7E]+$/.test(code)) {
    return { ok: false, status: 400, error: 'invalid_access_code' };
  }
  return { ok: true, code };
}

async function ensureTable(pg) {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      client_slug text PRIMARY KEY,
      wetsuit_promo_text text NOT NULL DEFAULT '',
      staff_access_code text NOT NULL DEFAULT '',
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by uuid
    )`);
}

async function readPromo(pg, clientSlug) {
  await ensureTable(pg);
  const res = await pg.query(
    `SELECT wetsuit_promo_text FROM ${TABLE} WHERE client_slug = $1`,
    [clientSlug],
  );
  const row = res.rows[0];
  return { text: row ? String(row.wetsuit_promo_text || '') : '' };
}

async function savePromo(pg, clientSlug, text, actor) {
  await ensureTable(pg);
  await pg.query(
    `INSERT INTO ${TABLE} (client_slug, wetsuit_promo_text, updated_by)
     VALUES ($1, $2, $3::uuid)
     ON CONFLICT (client_slug) DO UPDATE
       SET wetsuit_promo_text = EXCLUDED.wetsuit_promo_text,
           updated_at = now(),
           updated_by = EXCLUDED.updated_by`,
    [clientSlug, text, actor],
  );
}

async function readAccessCode(pg, clientSlug) {
  await ensureTable(pg);
  const res = await pg.query(
    `SELECT staff_access_code FROM ${TABLE} WHERE client_slug = $1`,
    [clientSlug],
  );
  const code = res.rows[0] ? String(res.rows[0].staff_access_code || '') : '';
  return { configured: code.length > 0, code };
}

async function saveAccessCode(pg, clientSlug, code, actor) {
  await ensureTable(pg);
  await pg.query(
    `INSERT INTO ${TABLE} (client_slug, staff_access_code, updated_by)
     VALUES ($1, $2, $3::uuid)
     ON CONFLICT (client_slug) DO UPDATE
       SET staff_access_code = EXCLUDED.staff_access_code,
           updated_at = now(),
           updated_by = EXCLUDED.updated_by`,
    [clientSlug, code, actor],
  );
}

function createWolfhouseStaffPortalFieldRoutes(deps) {
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

  const JSON_ALREADY_ANSWERED = Symbol('json-already-answered');

  async function readJson(req, res) {
    let raw;
    try {
      raw = await readBody(req);
    } catch (_error) {
      send400(res, 'invalid JSON body');
      return JSON_ALREADY_ANSWERED;
    }
    try {
      const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
      return JSON.parse(text || '{}');
    } catch (_error) {
      send400(res, 'invalid JSON body');
      return JSON_ALREADY_ANSWERED;
    }
  }

  function audit(intent, user, extra) {
    if (typeof appendAuditLog !== 'function') return;
    appendAuditLog({
      ts: new Date().toISOString(),
      intent,
      category: 'admin_api',
      client_slug: CLIENT_SLUG,
      success: true,
      staff_user_id: user ? user.staff_user_id : null,
      ...extra,
    });
  }

  async function handlePromoGet(query, _req, res, user) {
    if (rejectOtherClient(query, res)) return;
    if (!assertStaffClientAccess(user, CLIENT_SLUG, res)) return;
    try {
      const promo = await withPgClient((pg) => readPromo(pg, CLIENT_SLUG));
      return sendJSON(res, 200, { success: true, text: promo.text });
    } catch (err) {
      console.error('[wetsuit-promo.get] failed:', err && err.code);
      return sendJSON(res, 500, { success: false, error: 'read failed' });
    }
  }

  async function handlePromoPut(query, req, res, user) {
    if (rejectOtherClient(query, res)) return;
    if (!assertStaffClientAccess(user, CLIENT_SLUG, res)) return;
    const body = await readJson(req, res);
    if (body === JSON_ALREADY_ANSWERED) return;
    const promo = validatePromoBody(body);
    if (!promo.ok) return sendJSON(res, promo.status, { success: false, error: promo.error });
    try {
      await withPgClient((pg) => savePromo(pg, CLIENT_SLUG, promo.text, actorId(user)));
      audit('api:wetsuit_promo.set', user, { empty: promo.text.length === 0 });
      return sendJSON(res, 200, { success: true, text: promo.text });
    } catch (err) {
      console.error('[wetsuit-promo.put] failed:', err && err.code);
      return sendJSON(res, 500, { success: false, error: 'write failed' });
    }
  }

  async function handleAccessGet(query, _req, res, user) {
    if (rejectOtherClient(query, res)) return;
    if (!assertStaffClientAccess(user, CLIENT_SLUG, res)) return;
    try {
      const access = await withPgClient((pg) => readAccessCode(pg, CLIENT_SLUG));
      return sendJSON(res, 200, { success: true, configured: access.configured, code: access.code });
    } catch (err) {
      console.error('[staff-access-code.get] failed:', err && err.code);
      return sendJSON(res, 500, { success: false, error: 'read failed' });
    }
  }

  async function handleAccessPut(query, req, res, user) {
    if (rejectOtherClient(query, res)) return;
    if (!assertStaffClientAccess(user, CLIENT_SLUG, res)) return;
    const body = await readJson(req, res);
    if (body === JSON_ALREADY_ANSWERED) return;
    const access = validateAccessCodeBody(body);
    if (!access.ok) return sendJSON(res, access.status, { success: false, error: access.error });
    try {
      await withPgClient((pg) => saveAccessCode(pg, CLIENT_SLUG, access.code, actorId(user)));
      audit('api:staff_access_code.set', user, { configured: access.code.length > 0 });
      return sendJSON(res, 200, {
        success: true,
        configured: access.code.length > 0,
        code: access.code,
      });
    } catch (err) {
      console.error('[staff-access-code.put] failed:', err && err.code);
      return sendJSON(res, 500, { success: false, error: 'write failed' });
    }
  }

  return {
    handleWetsuitPromoGet: handlePromoGet,
    handleWetsuitPromoPut: handlePromoPut,
    handleStaffAccessCodeGet: handleAccessGet,
    handleStaffAccessCodePut: handleAccessPut,
  };
}

module.exports = {
  CLIENT_SLUG,
  TABLE,
  PROMO_MAX,
  CODE_MAX,
  validatePromoBody,
  validateAccessCodeBody,
  createWolfhouseStaffPortalFieldRoutes,
};
