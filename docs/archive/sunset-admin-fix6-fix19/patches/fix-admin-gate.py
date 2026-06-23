#!/usr/bin/env python3
from pathlib import Path
p = Path('/opt/wolfhouse/WH/scripts/staff-query-api.js')
s = p.read_text(encoding='utf-8')
old = "if (!adminCfgWritesEnabled(cfg)) return;"
new = "if (!adminCfgWritesEnabled(cfg)){ adminShowMessage('error', portalT('admin.banner.writesDisabled')); return; }"
if old in s:
    s = s.replace(old, new, 1)
    p.write_text(s, encoding='utf-8')
    print('OK')
else:
    print('SKIP')
