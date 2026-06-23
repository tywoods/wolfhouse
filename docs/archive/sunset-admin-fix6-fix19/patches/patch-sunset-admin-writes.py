#!/usr/bin/env python3
"""Patch staff-query-api.js for Sunset Admin write endpoints."""
from pathlib import Path

ROOT = Path('/opt/wolfhouse/WH')
API = ROOT / 'scripts/staff-query-api.js'
I18N = ROOT / 'scripts/lib/staff-portal-i18n.js'
text = API.read_text(encoding='utf-8')
i18n = I18N.read_text(encoding='utf-8')

require_anchor = "} = require('./lib/tenant-business-config');"
require_block = """} = require('./lib/tenant-business-config');
const {
  isSunsetAdminWritesEnabled,
  evaluateAdminWriteGate,
  validateUuid,
  validatePricePatchBody,
  validateLessonCapacityBody,
  validateLessonTimePatchBody,
  patchPriceRule,
  putLessonCapacityDefault,
  patchLessonTimeRule,
} = require('./lib/tenant-admin-writes');"""
if require_block not in text:
    if require_anchor not in text:
        raise SystemExit('require anchor missing')
    text = text.replace(require_anchor, require_block, 1)

handler_anchor = 'async function handleCustomerList(query, res, user) {'
handler_block = r'''async function sendAdminWriteGateFailure(res, gate) {
  return sendJSON(res, gate.status, gate.body);
}

async function handleAdminConfigPricePatch(ruleIdRaw, query, req, res, user) {
  const started = Date.now();
  const clientSlug = (String(query.client || DEFAULT_CLIENT)).trim();
  if (SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client slug');
  const gate = evaluateAdminWriteGate({
    user,
    clientSlug,
    staffAuthRequired: STAFF_AUTH_REQUIRED,
    resolveStaffRole,
  });
  if (!gate.ok) return sendAdminWriteGateFailure(res, gate);
  if (!assertStaffClientAccess(user, clientSlug, res)) return;

  const idCheck = validateUuid(ruleIdRaw, 'price rule id');
  if (!idCheck.ok) return send400(res, idCheck.error);

  let body;
  try {
    body = JSON.parse(await readBody(req) || '{}');
  } catch (_) {
    return send400(res, 'invalid JSON body');
  }
  const validated = validatePricePatchBody(body);
  if (!validated.ok) return send400(res, validated.error);

  try {
    const result = await withPgClient(async (pg) => patchPriceRule(pg, {
      ruleId: idCheck.value,
      clientSlug,
      patch: validated.patch,
      actor: { staff_user_id: user && user.staff_user_id, email: user && user.email },
    }));
    appendAuditLog({
      ts: new Date().toISOString(),
      intent: 'api:admin.config.price_patch',
      category: 'admin_api',
      client_slug: clientSlug,
      success: result.ok,
      staff_user_id: user ? user.staff_user_id : null,
      elapsed_ms: Date.now() - started,
    });
    return sendJSON(res, result.status, { ...result.body, elapsed_ms: Date.now() - started });
  } catch (err) {
    return sendJSON(res, 500, { success: false, error: 'write failed' });
  }
}

async function handleAdminConfigLessonCapacityPut(query, req, res, user) {
  const started = Date.now();
  const clientSlug = (String(query.client || DEFAULT_CLIENT)).trim();
  if (SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client slug');
  const gate = evaluateAdminWriteGate({
    user,
    clientSlug,
    staffAuthRequired: STAFF_AUTH_REQUIRED,
    resolveStaffRole,
  });
  if (!gate.ok) return sendAdminWriteGateFailure(res, gate);
  if (!assertStaffClientAccess(user, clientSlug, res)) return;

  let body;
  try {
    body = JSON.parse(await readBody(req) || '{}');
  } catch (_) {
    return send400(res, 'invalid JSON body');
  }
  const validated = validateLessonCapacityBody(body);
  if (!validated.ok) return send400(res, validated.error);

  try {
    const result = await withPgClient(async (pg) => putLessonCapacityDefault(pg, {
      clientSlug,
      capacity: validated.patch.default_daily_cap,
      actor: { staff_user_id: user && user.staff_user_id, email: user && user.email },
    }));
    appendAuditLog({
      ts: new Date().toISOString(),
      intent: 'api:admin.config.lesson_capacity_put',
      category: 'admin_api',
      client_slug: clientSlug,
      success: result.ok,
      staff_user_id: user ? user.staff_user_id : null,
      elapsed_ms: Date.now() - started,
    });
    return sendJSON(res, result.status, { ...result.body, elapsed_ms: Date.now() - started });
  } catch (err) {
    return sendJSON(res, 500, { success: false, error: 'write failed' });
  }
}

async function handleAdminConfigLessonTimePatch(ruleIdRaw, query, req, res, user) {
  const started = Date.now();
  const clientSlug = (String(query.client || DEFAULT_CLIENT)).trim();
  if (SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client slug');
  const gate = evaluateAdminWriteGate({
    user,
    clientSlug,
    staffAuthRequired: STAFF_AUTH_REQUIRED,
    resolveStaffRole,
  });
  if (!gate.ok) return sendAdminWriteGateFailure(res, gate);
  if (!assertStaffClientAccess(user, clientSlug, res)) return;

  const idCheck = validateUuid(ruleIdRaw, 'lesson time rule id');
  if (!idCheck.ok) return send400(res, idCheck.error);

  let body;
  try {
    body = JSON.parse(await readBody(req) || '{}');
  } catch (_) {
    return send400(res, 'invalid JSON body');
  }
  const validated = validateLessonTimePatchBody(body);
  if (!validated.ok) return send400(res, validated.error);

  try {
    const result = await withPgClient(async (pg) => patchLessonTimeRule(pg, {
      ruleId: idCheck.value,
      clientSlug,
      patch: validated.patch,
      actor: { staff_user_id: user && user.staff_user_id, email: user && user.email },
    }));
    appendAuditLog({
      ts: new Date().toISOString(),
      intent: 'api:admin.config.lesson_time_patch',
      category: 'admin_api',
      client_slug: clientSlug,
      success: result.ok,
      staff_user_id: user ? user.staff_user_id : null,
      elapsed_ms: Date.now() - started,
    });
    return sendJSON(res, result.status, { ...result.body, elapsed_ms: Date.now() - started });
  } catch (err) {
    return sendJSON(res, 500, { success: false, error: 'write failed' });
  }
}

async function handleCustomerList(query, res, user) {'''
if handler_block not in text:
    if handler_anchor not in text:
        raise SystemExit('handler anchor missing')
    text = text.replace(handler_anchor, handler_block, 1)

old_return = """  const { ok, ...payload } = resolved;
  return sendJSON(res, 200, {
    success: true,
    ...payload,
    elapsed_ms: elapsed,
  });
}

async function sendAdminWriteGateFailure"""
if old_return not in text:
    old_return2 = """  const { ok, ...payload } = resolved;
  return sendJSON(res, 200, {
    success: true,
    ...payload,
    elapsed_ms: elapsed,
  });
}

async function handleCustomerList"""
    if old_return2 in text:
        text = text.replace(
            """  const { ok, ...payload } = resolved;
  return sendJSON(res, 200, {
    success: true,
    ...payload,
    elapsed_ms: elapsed,
  });
}""",
            """  const { ok, ...payload } = resolved;
  return sendJSON(res, 200, {
    success: true,
    ...payload,
    read_only: !isSunsetAdminWritesEnabled(),
    writes_enabled: isSunsetAdminWritesEnabled(),
    elapsed_ms: elapsed,
  });
}""",
            1,
        )
    else:
        raise SystemExit('handleAdminConfig return block missing')
else:
    text = text.replace(
        """  const { ok, ...payload } = resolved;
  return sendJSON(res, 200, {
    success: true,
    ...payload,
    elapsed_ms: elapsed,
  });
}""",
        """  const { ok, ...payload } = resolved;
  return sendJSON(res, 200, {
    success: true,
    ...payload,
    read_only: !isSunsetAdminWritesEnabled(),
    writes_enabled: isSunsetAdminWritesEnabled(),
    elapsed_ms: elapsed,
  });
}""",
        1,
    )

route_anchor = "  // ── All other routes: GET only ────────────────────────────────────────────"
route_block = r'''  const adminPricePatchMatch = /^\/staff\/admin\/config\/prices\/([0-9a-f-]{36})$/i.exec(pathname);
  if (adminPricePatchMatch && method === 'PATCH') {
    const auth = await requireAuth(req, res, 'admin');
    if (!auth.ok) return;
    return handleAdminConfigPricePatch(adminPricePatchMatch[1], parsed.query, req, res, auth.user);
  }

  if (pathname === '/staff/admin/config/lesson-capacity' && method === 'PUT') {
    const auth = await requireAuth(req, res, 'admin');
    if (!auth.ok) return;
    return handleAdminConfigLessonCapacityPut(parsed.query, req, res, auth.user);
  }

  const adminLessonTimePatchMatch = /^\/staff\/admin\/config\/lesson-times\/([0-9a-f-]{36})$/i.exec(pathname);
  if (adminLessonTimePatchMatch && method === 'PATCH') {
    const auth = await requireAuth(req, res, 'admin');
    if (!auth.ok) return;
    return handleAdminConfigLessonTimePatch(adminLessonTimePatchMatch[1], parsed.query, req, res, auth.user);
  }

  // ── All other routes: GET only ────────────────────────────────────────────'''
if route_block not in text:
    if route_anchor not in text:
        raise SystemExit('route anchor missing')
    text = text.replace(route_anchor, route_block, 1)

banner_old = '<div class="portal-admin-banner">'
banner_new = '<div class="portal-admin-banner" id="admin-write-banner">'
if banner_new not in text:
    text = text.replace(banner_old, banner_new, 1)

render_old = """function renderAdminFromConfig(cfg){
  renderAdminSectionPricesFromConfig(cfg);
  renderAdminSectionCapacityFromConfig(cfg);
  renderAdminSectionLessonTimesFromConfig(cfg);
  renderAdminSectionBusinessInfoFromConfig(cfg);
  renderAdminSectionChangeHistoryFromConfig(cfg);
}"""
render_new = """function renderAdminWriteState(cfg){
  var banner = el('admin-write-banner');
  if (banner) {
    if (cfg && cfg.writes_enabled === true) {
      banner.innerHTML = '<strong>' + escHtml(portalT('admin.banner.writesApiOnly')) + '</strong> — ' +
        escHtml(portalT('admin.banner.writesApiOnlySub'));
    } else {
      banner.innerHTML = '<strong data-i18n="admin.banner.readOnly">' + escHtml(portalT('admin.banner.readOnly')) + '</strong> — ' +
        '<span data-i18n="admin.banner.writesDisabled">' + escHtml(portalT('admin.banner.writesDisabled')) + '</span> ' +
        '<span data-i18n="admin.banner.lunaNote">' + escHtml(portalT('admin.banner.lunaNote')) + '</span>';
    }
  }
  document.querySelectorAll('#tab-admin .portal-admin-actions button').forEach(function(btn){
    btn.disabled = true;
    if (cfg && cfg.writes_enabled === true) {
      btn.title = portalT('admin.action.apiOnlyTitle');
    }
  });
}

function renderAdminFromConfig(cfg){
  renderAdminWriteState(cfg);
  renderAdminSectionPricesFromConfig(cfg);
  renderAdminSectionCapacityFromConfig(cfg);
  renderAdminSectionLessonTimesFromConfig(cfg);
  renderAdminSectionBusinessInfoFromConfig(cfg);
  renderAdminSectionChangeHistoryFromConfig(cfg);
}"""
if render_new not in text:
    if render_old not in text:
        raise SystemExit('renderAdminFromConfig block missing')
    text = text.replace(render_old, render_new, 1)

API.write_text(text, encoding='utf-8')

i18n_entries = {
    "'admin.banner.writesApiOnly'": "'admin.banner.writesApiOnly': 'Writes enabled (API only)'",
    "'admin.banner.writesApiOnlySub'": "'admin.banner.writesApiOnlySub': 'Use Admin write API endpoints; UI editing is not available yet.'",
    "'admin.action.apiOnlyTitle'": "'admin.action.apiOnlyTitle': 'Admin writes are API-only until UI editing ships'",
}
for key, line in i18n_entries.items():
    if key not in i18n:
        anchor = "'admin.banner.writesDisabled':"
        if anchor not in i18n:
            raise SystemExit('i18n anchor missing')
        i18n = i18n.replace(
            anchor,
            line + "\n    " + anchor,
            1,
        )
I18N.write_text(i18n, encoding='utf-8')
print('OK patched staff-query-api.js and staff-portal-i18n.js')
