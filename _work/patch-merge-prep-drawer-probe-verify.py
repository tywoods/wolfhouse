#!/usr/bin/env python3
"""Merge-prep: probe inbox tab fix + verifier regression guard."""
from pathlib import Path
import shutil

ROOT = Path("/opt/wolfhouse/WH")
V1 = ROOT / "scripts/verify-sunset-portal-v1.js"
PROBE_SRC = ROOT / "_work/probe-sunset-booking-drawer-payments-smoke.js"

v1 = V1.read_text(encoding="utf-8")
needle = "  assert('drawer save action', apiSrc.includes('function scheduleSaveDrawerBooking('));"
add = """  assert('drawer save action', apiSrc.includes('function scheduleSaveDrawerBooking('));
  assert('drawer payment refresh helper', apiSrc.includes('function scheduleUpdateDrawerPaymentFromContext('));"""
if "drawer payment refresh helper" not in v1:
    if needle not in v1:
        raise SystemExit("MISSING drawer save action assert")
    v1 = v1.replace(needle, add)
    V1.write_text(v1, encoding="utf-8")
    print("VERIFIER OK")
else:
    print("VERIFIER already patched")

# probe should already be updated via scp; sanity check
probe = PROBE_SRC.read_text(encoding="utf-8")
if 'data-tab="inbox"' in probe:
    raise SystemExit("PROBE still uses data-tab=inbox")
if 'data-tab="conversations"' not in probe:
    raise SystemExit("PROBE missing conversations tab assert")
print("PROBE OK")
