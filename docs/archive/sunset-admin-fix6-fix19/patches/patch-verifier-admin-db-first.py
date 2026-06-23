#!/usr/bin/env python3
"""Add DB-first admin persistence verifier checks."""
from pathlib import Path

VERIFY = Path('/opt/wolfhouse/WH/scripts/verify-sunset-portal-v1.js')
text = VERIFY.read_text()

checks = """
  assert('admin writes DB-first when tables exist', tawSrc.includes('adminConfigTablesExist') && tawSrc.includes("storage: 'db'"));
  assert('JSON overlay fallback when tables missing', tawSrc.includes('location_store') && tbcSrc.includes('shouldApplyJsonLocationOverlay'));
  assert('location backfill script present', fs.existsSync(path.join(ROOT, 'scripts/backfill-sunset-admin-location-config.js')));
"""

if "assert('admin writes DB-first when tables exist'" not in text:
    text = text.replace(
        "  assert('proposed migration 023 documented', fs.existsSync(path.join(ROOT, 'database/migrations/023_sunset_admin_location_id_PROPOSED.sql')));",
        "  assert('proposed migration 023 documented', fs.existsSync(path.join(ROOT, 'database/migrations/023_sunset_admin_location_id_PROPOSED.sql')));\n" + checks,
        1,
    )

if "'scripts/backfill-sunset-admin-location-config.js'" not in text:
    text = text.replace(
        "  'scripts/lib/tenant-admin-writes.js',\n];",
        "  'scripts/lib/tenant-admin-writes.js',\n"
        "  'scripts/backfill-sunset-admin-location-config.js',\n];",
        1,
    )

VERIFY.write_text(text)
print('OK verifier DB-first checks')
