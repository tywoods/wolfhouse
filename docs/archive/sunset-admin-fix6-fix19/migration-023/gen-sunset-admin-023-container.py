#!/usr/bin/env python3
"""Generate self-contained container DB script with embedded 023 SQL."""
import base64
import json
from pathlib import Path

ROOT = Path('/opt/wolfhouse/WH')
SQL = (ROOT / 'database/migrations/023_sunset_admin_location_id_PROPOSED.sql').read_text()
TEMPLATE = (ROOT / '_work/sunset-admin-023-container-template.js').read_text()
out = TEMPLATE.replace('__MIGRATION_SQL__', json.dumps(SQL))
path = ROOT / '_work/sunset-admin-023-container-generated.js'
path.write_text(out)
print(path)
print('bytes', path.stat().st_size)
