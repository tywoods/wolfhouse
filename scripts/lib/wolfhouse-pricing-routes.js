/**
 * Wolfhouse Admin Pricing routes — extracted module (DI template).
 *
 *   GET    /staff/admin/wh/pricing                       merged catalog
 *   PUT    /staff/admin/wh/pricing/seasons               upsert season + ranges
 *   DELETE /staff/admin/wh/pricing/seasons/:code
 *   PUT    /staff/admin/wh/pricing/prices                upsert one price
 *   DELETE /staff/admin/wh/pricing/prices                deactivate one price
 *   PUT    /staff/admin/wh/pricing/items                 create/update rental or service
 *   DELETE /staff/admin/wh/pricing/items/:type/:code
 *   PUT    /staff/admin/wh/pricing/transfers             upsert airport rule
 *   DELETE /staff/admin/wh/pricing/transfers/:airport
 *
 * Auth is NOT enforced here. The Staff API router must call
 * requireAuth(req, res, 'admin') before dispatching.
 *
 * Reads are deliberately not gated on WOLFHOUSE_ADMIN_WRITES_ENABLED: staff
 * should always be able to see current prices, and the payload reports
 * writes_enabled so the UI can render read-only instead of failing on save.
 * Writes go through evaluateWolfhousePricingWriteGate, which is fail-closed.
 *
 * @module wolfhouse-pricing-routes
 */

'use strict';

const resolve = require('./wolfhouse-pricing-resolve');
const store = require('./wolfhouse-pricing-store');
const writes = require('./wolfhouse-pricing-writes');
const { getClientTransferConfig } = require('./client-transfer-config');

const WH_PRICING_BASE_PATH = '/staff/admin/wh/pricing';
const WH_PRICING_MIN_ROLE = 'admin';

/**
 * @typedef {object} WolfhousePricingRouteDeps
 * @property {Function} sendJSON
 * @property {Function} send400
 * @property {Function} readBody
 * @property {Function} assertStaffClientAccess
 * @property {Function} appendAuditLog
 * @property {Function} withPgClient
 * @property {string} DEFAULT_CLIENT
 * @property {RegExp} SQL_INJECT_RE
 * @property {boolean} STAFF_AUTH_REQUIRED
 * @property {Function} resolveStaffRole
 */

function createWolfhousePricingRoutes(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new Error('createWolfhousePricingRoutes: deps required');
  }
  const {
    sendJSON,
    send400,
    readBody,
    assertStaffClientAccess,
    appendAuditLog,
    withPgClient,
    DEFAULT_CLIENT,
    SQL_INJECT_RE,
    STAFF_AUTH_REQUIRED,
    resolveStaffRole,
  } = deps;

  // Runtime twin of migration 076, attempted once per process. Lunabox cannot
  // always run migrations against staging Postgres, and a read must not fail
  // just because the tables are not there yet.
  let ensureAttempted = false;
  async function ensureTablesOnce(pg) {
    if (ensureAttempted) return;
    ensureAttempted = true;
    try {
      await store.ensureWolfhousePricingTables(pg);
    } catch (err) {
      console.error('[wh.pricing] ensure tables failed:', err && err.message);
    }
  }

  function resolveScope(query, res, user) {
    const clientSlug = (String(query.client || DEFAULT_CLIENT)).trim();
    if (SQL_INJECT_RE.test(clientSlug)) {
      send400(res, 'invalid client slug');
      return null;
    }
    if (clientSlug !== resolve.WH_PRICING_CLIENT_SLUG) {
      sendJSON(res, 404, {
        success: false,
        error: 'unsupported_client',
        message: 'Wolfhouse Admin pricing is only available for wolfhouse-somo',
        client_slug: clientSlug,
      });
      return null;
    }
    if (!assertStaffClientAccess(user, clientSlug, res)) return null;
    return clientSlug;
  }

  function gateWrite(clientSlug, res, user) {
    const gate = writes.evaluateWolfhousePricingWriteGate({
      user, clientSlug, staffAuthRequired: STAFF_AUTH_REQUIRED, resolveStaffRole,
    });
    if (!gate.ok) {
      sendJSON(res, gate.status, gate.body);
      return false;
    }
    return true;
  }

  async function parseJsonBody(req, res) {
    let body = null;
    try { body = JSON.parse(await readBody(req) || '{}'); } catch (_) {
      send400(res, 'invalid JSON body');
      return null;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      send400(res, 'invalid body');
      return null;
    }
    return body;
  }

  function audit(intent, clientSlug, user, success, started, extra) {
    appendAuditLog(Object.assign({
      ts: new Date().toISOString(),
      intent: `api:admin.wh.pricing.${intent}`,
      category: 'admin_api',
      client_slug: clientSlug,
      success: !!success,
      staff_user_id: user ? user.staff_user_id : null,
      elapsed_ms: Date.now() - started,
    }, extra || {}));
  }

  function actorOf(user) {
    return user && user.staff_user_id ? user.staff_user_id : null;
  }

  /** Load the merged view. Degrades to config-only if the overlay is unreadable. */
  async function loadView() {
    const config = resolve.loadPricingConfig();
    const transferConfig = getClientTransferConfig(resolve.WH_PRICING_CLIENT_SLUG);
    const writesEnabled = writes.isWolfhousePricingWritesEnabled(process.env);
    let overlay = { seasons: [], rules: [], items: [], transfers: [] };
    let degraded = null;
    try {
      overlay = await withPgClient(async (pg) => {
        await ensureTablesOnce(pg);
        const slug = resolve.WH_PRICING_CLIENT_SLUG;
        return {
          seasons: await store.loadSeasons(pg, slug),
          rules: await store.loadRules(pg, slug),
          items: await store.loadItems(pg, slug),
          transfers: await store.loadTransferRules(pg, slug),
        };
      });
    } catch (err) {
      // Config-only is the honest fallback: it is exactly today's behaviour.
      degraded = err && err.message ? err.message : 'overlay_unavailable';
      console.error('[wh.pricing] overlay read failed, serving config only:', degraded);
    }
    const view = resolve.buildAdminPricingView({
      config,
      transferConfig,
      dbSeasons: overlay.seasons,
      dbRules: overlay.rules,
      dbItems: overlay.items,
      dbTransferRules: overlay.transfers,
      writesEnabled,
    });
    if (degraded) {
      view.overlay_available = false;
      view.overlay_error = degraded;
    } else {
      view.overlay_available = true;
    }
    return view;
  }

  async function handleWhPricingGet(query, req, res, user) {
    const started = Date.now();
    const clientSlug = resolveScope(query, res, user);
    if (!clientSlug) return undefined;
    try {
      const view = await loadView();
      audit('read', clientSlug, user, true, started);
      return sendJSON(res, 200, Object.assign(
        { success: true }, view, { elapsed_ms: Date.now() - started },
      ));
    } catch (err) {
      console.error('[wh.pricing.read] failed:', err && err.message);
      return sendJSON(res, 500, { success: false, error: 'pricing read failed' });
    }
  }

  /**
   * Run a validated write, then return the freshly merged view so the UI never
   * has to guess what the server stored.
   */
  async function commitWrite(ctx) {
    const { intent, clientSlug, res, user, started, run } = ctx;
    try {
      const outcome = await withPgClient(async (pg) => {
        await ensureTablesOnce(pg);
        return run(pg);
      });
      if (outcome && outcome.notFound) {
        audit(intent, clientSlug, user, false, started, { reason: 'not_found' });
        return sendJSON(res, 404, { success: false, error: 'not_found' });
      }
      const view = await loadView();
      audit(intent, clientSlug, user, true, started);
      return sendJSON(res, 200, Object.assign(
        { success: true }, view, { elapsed_ms: Date.now() - started },
      ));
    } catch (err) {
      console.error(`[wh.pricing.${intent}] failed:`, err && err.message);
      audit(intent, clientSlug, user, false, started, { error: err && err.message });
      if (err && err.message === 'tenant_scope_violation') {
        return sendJSON(res, 403, { success: false, error: 'tenant_scope_violation' });
      }
      return sendJSON(res, 500, { success: false, error: 'write failed', code: err && err.code });
    }
  }

  async function handleWhPricingSeasonPut(query, req, res, user) {
    const started = Date.now();
    const clientSlug = resolveScope(query, res, user);
    if (!clientSlug) return undefined;
    if (!gateWrite(clientSlug, res, user)) return undefined;
    const body = await parseJsonBody(req, res);
    if (!body) return undefined;
    const parsed = writes.validateSeasonBody(body);
    if (!parsed.ok) return send400(res, parsed.error);
    return commitWrite({
      intent: 'season_save', clientSlug, res, user, started,
      run: (pg) => store.saveSeason(pg, clientSlug, parsed.value, actorOf(user)),
    });
  }

  async function handleWhPricingSeasonDelete(codeRaw, query, req, res, user) {
    const started = Date.now();
    const clientSlug = resolveScope(query, res, user);
    if (!clientSlug) return undefined;
    if (!gateWrite(clientSlug, res, user)) return undefined;
    const code = writes.validateCode(codeRaw, 'code');
    if (!code.ok) return send400(res, code.error);
    return commitWrite({
      intent: 'season_delete', clientSlug, res, user, started,
      run: async (pg) => {
        const removed = await store.deactivateSeason(pg, clientSlug, code.value, actorOf(user));
        return removed ? null : { notFound: true };
      },
    });
  }

  async function handleWhPricingPricePut(query, req, res, user) {
    const started = Date.now();
    const clientSlug = resolveScope(query, res, user);
    if (!clientSlug) return undefined;
    if (!gateWrite(clientSlug, res, user)) return undefined;
    const body = await parseJsonBody(req, res);
    if (!body) return undefined;
    const parsed = writes.validatePriceRuleBody(body);
    if (!parsed.ok) return send400(res, parsed.error);
    return commitWrite({
      intent: 'price_save', clientSlug, res, user, started,
      run: (pg) => store.savePriceRule(pg, clientSlug, parsed.value, actorOf(user)),
    });
  }

  async function handleWhPricingPriceDelete(query, req, res, user) {
    const started = Date.now();
    const clientSlug = resolveScope(query, res, user);
    if (!clientSlug) return undefined;
    if (!gateWrite(clientSlug, res, user)) return undefined;
    const body = await parseJsonBody(req, res);
    if (!body) return undefined;
    if (!writes.RULE_ITEM_TYPES.has(String(body.item_type || ''))) {
      return send400(res, 'invalid item_type');
    }
    const itemCode = String(body.item_code || '').trim();
    if (!itemCode) return send400(res, 'item_code required');
    const seasonCode = body.season_code == null || String(body.season_code).trim() === ''
      ? null
      : String(body.season_code).trim();
    return commitWrite({
      intent: 'price_delete', clientSlug, res, user, started,
      run: async (pg) => {
        const removed = await store.deactivatePriceRule(pg, clientSlug, {
          item_type: String(body.item_type), item_code: itemCode, season_code: seasonCode,
        }, actorOf(user));
        return removed ? null : { notFound: true };
      },
    });
  }

  async function handleWhPricingItemPut(query, req, res, user) {
    const started = Date.now();
    const clientSlug = resolveScope(query, res, user);
    if (!clientSlug) return undefined;
    if (!gateWrite(clientSlug, res, user)) return undefined;
    const body = await parseJsonBody(req, res);
    if (!body) return undefined;
    const parsed = writes.validateItemBody(body);
    if (!parsed.ok) return send400(res, parsed.error);
    return commitWrite({
      intent: 'item_save', clientSlug, res, user, started,
      run: (pg) => store.saveItem(pg, clientSlug, parsed.value, actorOf(user)),
    });
  }

  async function handleWhPricingItemDelete(itemTypeRaw, itemCodeRaw, query, req, res, user) {
    const started = Date.now();
    const clientSlug = resolveScope(query, res, user);
    if (!clientSlug) return undefined;
    if (!gateWrite(clientSlug, res, user)) return undefined;
    const itemType = String(itemTypeRaw || '').trim();
    if (!writes.ITEM_TYPES.has(itemType)) return send400(res, 'invalid item_type');
    const itemCode = writes.validateCode(itemCodeRaw, 'item_code');
    if (!itemCode.ok) return send400(res, itemCode.error);
    return commitWrite({
      intent: 'item_delete', clientSlug, res, user, started,
      run: async (pg) => {
        const removed = await store.deactivateItem(
          pg, clientSlug, itemType, itemCode.value, actorOf(user),
        );
        return removed ? null : { notFound: true };
      },
    });
  }

  async function handleWhPricingTransferPut(query, req, res, user) {
    const started = Date.now();
    const clientSlug = resolveScope(query, res, user);
    if (!clientSlug) return undefined;
    if (!gateWrite(clientSlug, res, user)) return undefined;
    const body = await parseJsonBody(req, res);
    if (!body) return undefined;
    const parsed = writes.validateTransferRuleBody(body);
    if (!parsed.ok) return send400(res, parsed.error);
    return commitWrite({
      intent: 'transfer_save', clientSlug, res, user, started,
      run: (pg) => store.saveTransferRule(pg, clientSlug, parsed.value, actorOf(user)),
    });
  }

  async function handleWhPricingTransferDelete(airportRaw, query, req, res, user) {
    const started = Date.now();
    const clientSlug = resolveScope(query, res, user);
    if (!clientSlug) return undefined;
    if (!gateWrite(clientSlug, res, user)) return undefined;
    const airport = writes.validateAirportCode(airportRaw);
    if (!airport.ok) return send400(res, airport.error);
    return commitWrite({
      intent: 'transfer_delete', clientSlug, res, user, started,
      run: async (pg) => {
        const removed = await store.deactivateTransferRule(
          pg, clientSlug, airport.value, actorOf(user),
        );
        return removed ? null : { notFound: true };
      },
    });
  }

  const SEASON_DELETE_RE = /^\/staff\/admin\/wh\/pricing\/seasons\/([^/?]+)$/i;
  const ITEM_DELETE_RE = /^\/staff\/admin\/wh\/pricing\/items\/([^/?]+)\/([^/?]+)$/i;
  const TRANSFER_DELETE_RE = /^\/staff\/admin\/wh\/pricing\/transfers\/([^/?]+)$/i;

  function decodeSegment(segment) {
    try { return decodeURIComponent(String(segment || '')); } catch (_) { return String(segment || ''); }
  }

  /**
   * Resolve pathname+method to a zero-arg-bound handler, or null when this
   * module owns nothing at that path. Caller still owns requireAuth.
   *
   * @returns {null|((query, req, res, user) => Promise<unknown>)}
   */
  function match(pathname, method) {
    const m = String(method || '').toUpperCase();
    if (pathname === WH_PRICING_BASE_PATH && m === 'GET') return handleWhPricingGet;
    if (pathname === `${WH_PRICING_BASE_PATH}/seasons` && m === 'PUT') {
      return handleWhPricingSeasonPut;
    }
    if (pathname === `${WH_PRICING_BASE_PATH}/prices` && m === 'PUT') {
      return handleWhPricingPricePut;
    }
    if (pathname === `${WH_PRICING_BASE_PATH}/prices` && m === 'DELETE') {
      return handleWhPricingPriceDelete;
    }
    if (pathname === `${WH_PRICING_BASE_PATH}/items` && m === 'PUT') {
      return handleWhPricingItemPut;
    }
    if (pathname === `${WH_PRICING_BASE_PATH}/transfers` && m === 'PUT') {
      return handleWhPricingTransferPut;
    }

    const seasonDelete = SEASON_DELETE_RE.exec(pathname);
    if (seasonDelete && m === 'DELETE') {
      const code = decodeSegment(seasonDelete[1]);
      return (query, req, res, user) => handleWhPricingSeasonDelete(code, query, req, res, user);
    }
    const itemDelete = ITEM_DELETE_RE.exec(pathname);
    if (itemDelete && m === 'DELETE') {
      const itemType = decodeSegment(itemDelete[1]);
      const itemCode = decodeSegment(itemDelete[2]);
      return (query, req, res, user) => handleWhPricingItemDelete(
        itemType, itemCode, query, req, res, user,
      );
    }
    const transferDelete = TRANSFER_DELETE_RE.exec(pathname);
    if (transferDelete && m === 'DELETE') {
      const airport = decodeSegment(transferDelete[1]);
      return (query, req, res, user) => handleWhPricingTransferDelete(
        airport, query, req, res, user,
      );
    }
    return null;
  }

  return {
    BASE_PATH: WH_PRICING_BASE_PATH,
    MIN_ROLE: WH_PRICING_MIN_ROLE,
    match,
    loadView,
    handleWhPricingGet,
    handleWhPricingSeasonPut,
    handleWhPricingSeasonDelete,
    handleWhPricingPricePut,
    handleWhPricingPriceDelete,
    handleWhPricingItemPut,
    handleWhPricingItemDelete,
    handleWhPricingTransferPut,
    handleWhPricingTransferDelete,
  };
}

module.exports = {
  WH_PRICING_BASE_PATH,
  WH_PRICING_MIN_ROLE,
  createWolfhousePricingRoutes,
};
