#!/usr/bin/env python3
from pathlib import Path

V1 = Path("/opt/wolfhouse/WH/scripts/verify-sunset-portal-v1.js")
v1 = V1.read_text(encoding="utf-8")
needle = "  assert('schedule source rails retained', apiSrc.includes('.portal-schedule-ops-row-rail.is-staff'));"
add = "\n  assert('schedule calm light scoped only', apiSrc.includes(':root:not([data-theme=\"dark\"]) #tab-portal-home{'));\n  assert('schedule dark night mode restored', apiSrc.includes('[data-theme=\"dark\"] #tab-portal-home{background:var(--cream)}'));"
if "schedule dark night mode restored" not in v1:
    if needle not in v1:
        raise SystemExit("anchor not found")
    v1 = v1.replace(needle, needle + add)
    V1.write_text(v1, encoding="utf-8")
    print("verify updated")
else:
    print("verify already updated")
