#!/usr/bin/env python3
from pathlib import Path

p = Path("/opt/wolfhouse/WH/scripts/verify-sunset-portal-v1.js")
t = p.read_text(encoding="utf-8")
old = "  assert('no row gradient wash', !apiSrc.includes('rgba(111,167,131,.14)'));"
new = """  assert('light schedule rows no gradient wash', !apiSrc.includes(':root:not([data-theme="dark"]) #tab-portal-home .portal-schedule-ops-row.is-staff{background:linear-gradient'));
  assert('dark schedule row gradient restored', apiSrc.includes('[data-theme="dark"] #tab-portal-home .portal-schedule-ops-row.is-staff{background:linear-gradient'));"""
if old not in t:
    raise SystemExit("old assert missing")
p.write_text(t.replace(old, new), encoding="utf-8")
print("verify gradient fix OK")
