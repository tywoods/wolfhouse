#!/usr/bin/env python3
"""Append Admin write route assertions to verify-sunset-portal-v1.js."""
from pathlib import Path

path = Path('/opt/wolfhouse/WH/scripts/verify-sunset-portal-v1.js')
text = path.read_text(encoding='utf-8')
marker = "// ── Shared Inbox Slice 3A"
block = """
// ── 13. Sunset Admin write routes (flag-gated, default off) ───────────────────

console.log('\\n[13] Sunset Admin write routes — flag-gated');

if (apiSrc) {
  assert('tenant-admin-writes import', apiSrc.includes("require('./lib/tenant-admin-writes')"));
  assert('PATCH admin price route', apiSrc.includes('adminPricePatchMatch') && apiSrc.includes("method === 'PATCH'"));
  assert('PUT admin lesson capacity route', apiSrc.includes("pathname === '/staff/admin/config/lesson-capacity'") && apiSrc.includes("method === 'PUT'"));
  assert('PATCH admin lesson time route', apiSrc.includes('adminLessonTimePatchMatch'));
  assert('write handlers present', apiSrc.includes('function handleAdminConfigPricePatch('));
  assert('writes flag check in GET config', apiSrc.includes('writes_enabled: isSunsetAdminWritesEnabled()'));
  assert('evaluateAdminWriteGate used', apiSrc.includes('evaluateAdminWriteGate'));
  assert('writes_disabled response path', apiSrc.includes("'writes_disabled'"));
  assert('admin write routes require admin role', apiSrc.includes("requireAuth(req, res, 'admin')") && apiSrc.includes('handleAdminConfigPricePatch'));
  assert('renderAdminWriteState helper', apiSrc.includes('function renderAdminWriteState('));
  assert('admin banner id for write state', apiSrc.includes('id="admin-write-banner"'));
}

try {
  const writes = require('./lib/tenant-admin-writes');
  const saved = process.env.SUNSET_ADMIN_WRITES_ENABLED;
  delete process.env.SUNSET_ADMIN_WRITES_ENABLED;
  assert('writes module default off', writes.isSunsetAdminWritesEnabled() === false);
  if (saved == null) delete process.env.SUNSET_ADMIN_WRITES_ENABLED;
  else process.env.SUNSET_ADMIN_WRITES_ENABLED = saved;
} catch (err) {
  assert('tenant-admin-writes module loads', false, err.message);
}

"""
if 'Sunset Admin write routes — flag-gated' not in text:
    if marker not in text:
        raise SystemExit('portal v1 marker missing')
    text = text.replace(marker, block + marker, 1)
    path.write_text(text, encoding='utf-8')
    print('OK updated verify-sunset-portal-v1.js')
else:
    print('SKIP verify-sunset-portal-v1 already patched')
