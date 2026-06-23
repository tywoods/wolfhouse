#!/usr/bin/env python3
from pathlib import Path
p = Path('/opt/wolfhouse/WH/scripts/staff-query-api.js')
s = p.read_text(encoding='utf-8')
broken = 'function renderAdminSectionBusinessInfoFromConfigfunction renderAdminSectionBusinessInfoFromConfig(cfg){'
fixed = 'function renderAdminSectionBusinessInfoFromConfig(cfg){'
if broken in s:
    s = s.replace(broken, fixed, 1)
    p.write_text(s, encoding='utf-8')
    print('OK fixed duplicate function declaration')
else:
    print('SKIP not found')
