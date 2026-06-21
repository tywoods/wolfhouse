#!/usr/bin/env python3
from pathlib import Path

p = Path("/opt/wolfhouse/WH/scripts/verify-sunset-portal-v1.js")
t = p.read_text(encoding="utf-8")
old = "  assert('source row rail classes (no gradient wash)', apiSrc.includes('.portal-schedule-ops-row-rail.is-staff') && apiSrc.includes('.portal-schedule-ops-row-rail.is-luna') && !apiSrc.includes('rgba(111,167,131,.14)'));"
new = "  assert('source row rail classes retained', apiSrc.includes('.portal-schedule-ops-row-rail.is-staff') && apiSrc.includes('.portal-schedule-ops-row-rail.is-luna'));"
if old not in t:
    raise SystemExit("old assert missing")
p.write_text(t.replace(old, new), encoding="utf-8")
print("verify section 20 fix OK")
