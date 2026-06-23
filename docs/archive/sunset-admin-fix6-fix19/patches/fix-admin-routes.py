#!/usr/bin/env python3
"""Allow cfg: price ids and config lesson time ids in admin write routes."""
from pathlib import Path

ROOT = Path('/opt/wolfhouse/WH')
writes = (ROOT / 'scripts/lib/tenant-admin-writes.js').read_text(encoding='utf-8')
api = (ROOT / 'scripts/staff-query-api.js').read_text(encoding='utf-8')

VALIDATORS = """
function validateAdminPriceRuleId(id, label) {
  const text = String(id || '').trim();
  if (!text) return { ok: false, error: `${label || 'price rule id'} required` };
  if (locationStore.parseConfigPriceId(text)) return { ok: true, value: text };
  return validateUuid(text, label || 'price rule id');
}

function validateAdminLessonTimeRuleId(id, label) {
  const text = String(id || '').trim();
  if (!text) return { ok: false, error: `${label || 'lesson time rule id'} required` };
  if (locationStore.isConfigTimeId(text)) return { ok: true, value: text };
  return validateUuid(text, label || 'lesson time rule id');
}
"""

if 'function validateAdminPriceRuleId' not in writes:
    writes = writes.replace('function validateUuid(id, label) {', VALIDATORS + '\nfunction validateUuid(id, label) {', 1)
    writes = writes.replace('  validateUuid,\n', '  validateUuid,\n  validateAdminPriceRuleId,\n  validateAdminLessonTimeRuleId,\n', 1)
    print('OK validators')

(ROOT / 'scripts/lib/tenant-admin-writes.js').write_text(writes, encoding='utf-8')

if 'validateAdminPriceRuleId' not in api.split('} = require')[1][:800]:
    api = api.replace('  validateUuid,\n', '  validateUuid,\n  validateAdminPriceRuleId,\n  validateAdminLessonTimeRuleId,\n', 1)

api = api.replace("const idCheck = validateUuid(ruleIdRaw, 'price rule id');",
                  "const idCheck = validateAdminPriceRuleId(ruleIdRaw, 'price rule id');", 2)
api = api.replace("const idCheck = validateUuid(ruleIdRaw, 'lesson time rule id');",
                  "const idCheck = validateAdminLessonTimeRuleId(ruleIdRaw, 'lesson time rule id');", 2)

ROUTE_HELPER = """
function decodeAdminPathId(segment) {
  try { return decodeURIComponent(String(segment || '')); } catch (_) { return String(segment || ''); }
}
"""

if 'function decodeAdminPathId' not in api:
    api = api.replace('async function handleAdminConfig(query, res, user) {',
                      ROUTE_HELPER + '\nasync function handleAdminConfig(query, res, user) {', 1)

api = api.replace(
    "  const adminPricePatchMatch = /^\\/staff\\/admin\\/config\\/prices\\/([0-9a-f-]{36})$/i.exec(pathname);",
    "  const adminPricePatchMatch = /^\\/staff\\/admin\\/config\\/prices\\/([^/?]+)$/i.exec(pathname);",
)
api = api.replace(
    "    return handleAdminConfigPricePatch(adminPricePatchMatch[1], parsed.query, req, res, auth.user);",
    "    return handleAdminConfigPricePatch(decodeAdminPathId(adminPricePatchMatch[1]), parsed.query, req, res, auth.user);",
)
api = api.replace(
    "    return handleAdminConfigPriceDelete(adminPricePatchMatch[1], parsed.query, req, res, auth.user);",
    "    return handleAdminConfigPriceDelete(decodeAdminPathId(adminPricePatchMatch[1]), parsed.query, req, res, auth.user);",
)

api = api.replace(
    "  const adminLessonTimePatchMatch = /^\\/staff\\/admin\\/config\\/lesson-times\\/([0-9a-f-]{36})$/i.exec(pathname);",
    "  const adminLessonTimePatchMatch = /^\\/staff\\/admin\\/config\\/lesson-times\\/([^/?]+)$/i.exec(pathname);",
)
api = api.replace(
    "    return handleAdminConfigLessonTimePatch(adminLessonTimePatchMatch[1], parsed.query, req, res, auth.user);",
    "    return handleAdminConfigLessonTimePatch(decodeAdminPathId(adminLessonTimePatchMatch[1]), parsed.query, req, res, auth.user);",
)
api = api.replace(
    "    return handleAdminConfigLessonTimeDelete(adminLessonTimePatchMatch[1], parsed.query, req, res, auth.user);",
    "    return handleAdminConfigLessonTimeDelete(decodeAdminPathId(adminLessonTimePatchMatch[1]), parsed.query, req, res, auth.user);",
)

(ROOT / 'scripts/staff-query-api.js').write_text(api, encoding='utf-8')
print('DONE')
