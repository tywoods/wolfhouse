#!/usr/bin/env python3
"""Restore dark/night mode on Schedule — scope calm light CSS to light theme only."""
from pathlib import Path

API = Path("/opt/wolfhouse/WH/scripts/staff-query-api.js")
api = API.read_text(encoding="utf-8")

LIGHT_PREFIX = ":root:not([data-theme=\"dark\"]) "

# Scope the calm light block to light theme only.
old_block_start = "/* Sunset Schedule — calm neutral ops surface (scoped to portal home tab) */\n#tab-portal-home{"
new_block_start = "/* Sunset Schedule — calm neutral ops surface (light theme only) */\n:root:not([data-theme=\"dark\"]) #tab-portal-home{"
if old_block_start not in api:
    raise SystemExit("calm block start not found")
api = api.replace(old_block_start, new_block_start)

# Prefix descendant selectors in the calm block (until .portal-admin-wrap)
lines = api.splitlines()
out = []
in_calm = False
for line in lines:
    if line.startswith("/* Sunset Schedule — calm neutral ops surface"):
        in_calm = True
    elif in_calm and line.startswith(".portal-admin-wrap"):
        in_calm = False
    if in_calm and line.startswith("#tab-portal-home"):
        line = LIGHT_PREFIX + line
    out.append(line)
api = "\n".join(out)

DARK_SCHEDULE = """
/* Sunset Schedule — dark/night mode (restore pre-calm-pass night ops feel) */
[data-theme="dark"] #tab-portal-home{background:var(--cream)}
[data-theme="dark"] #tab-portal-home .portal-schedule-card,
[data-theme="dark"] #tab-portal-home .portal-schedule-ops-lesson-group,
[data-theme="dark"] #tab-portal-home .portal-schedule-ops-rental-pickups,
[data-theme="dark"] #tab-portal-home .portal-schedule-week-forecast-card,
[data-theme="dark"] #tab-portal-home .portal-schedule-next30-card{background:var(--surface);border-color:var(--border-soft);box-shadow:var(--shadow-soft)}
[data-theme="dark"] #tab-portal-home .portal-schedule-ops-col-hdr,
[data-theme="dark"] #tab-portal-home .portal-schedule-ops-lesson-hdr{background:var(--surface-soft);border-color:var(--border-soft)}
[data-theme="dark"] #tab-portal-home .portal-schedule-ops-row{border-color:var(--border-soft)}
[data-theme="dark"] #tab-portal-home .portal-schedule-ops-row.is-staff{background:linear-gradient(90deg,rgba(111,167,131,.14),transparent 42%)}
[data-theme="dark"] #tab-portal-home .portal-schedule-ops-row.is-luna{background:linear-gradient(90deg,rgba(111,147,184,.14),transparent 42%)}
[data-theme="dark"] #tab-portal-home .portal-schedule-ops-row:hover{background:rgba(255,255,255,.04)}
[data-theme="dark"] #tab-portal-home .portal-schedule-ops-row-rail.is-staff{background:#6fa783}
[data-theme="dark"] #tab-portal-home .portal-schedule-ops-row-rail.is-luna{background:#6f93b8}
[data-theme="dark"] #tab-portal-home .portal-schedule-view-btn{background:var(--surface);border-color:var(--border-soft);color:var(--text-2)}
[data-theme="dark"] #tab-portal-home .portal-schedule-view-btn.active{background:var(--tan);border-color:var(--tan);color:var(--text);font-weight:700}
[data-theme="dark"] #tab-portal-home .btn-primary{background:var(--primary);border-color:var(--primary)}
[data-theme="dark"] #tab-portal-home .btn-primary:hover{background:var(--primary-hover);border-color:var(--primary-hover)}
[data-theme="dark"] #tab-portal-home .btn-ghost{background:var(--surface);border-color:var(--border);color:var(--text-2)}
[data-theme="dark"] #tab-portal-home .btn-ghost:hover{background:var(--surface-soft);border-color:var(--tan)}
[data-theme="dark"] #tab-portal-home .portal-schedule-status.is-unpaid,
[data-theme="dark"] #tab-portal-home .portal-schedule-status.is-pending{color:#ffb896}
[data-theme="dark"] #tab-portal-home .portal-schedule-status.is-paid{color:#9ee0a8}
[data-theme="dark"] #tab-portal-home .portal-schedule-drawer,
[data-theme="dark"] #tab-portal-home .portal-schedule-create-drawer{background:var(--surface);border-color:var(--border-soft)}
"""

anchor = ".portal-admin-wrap{max-width:1100px"
if anchor not in api:
    raise SystemExit("anchor not found")
if "[data-theme=\"dark\"] #tab-portal-home{background:var(--cream)}" in api:
    print("dark schedule block already present")
else:
    api = api.replace(anchor, DARK_SCHEDULE + "\n" + anchor)

# Restore global dark row gradients (calm pass removed them globally)
GLOBAL_ROW = ".portal-schedule-ops-row.is-staff,.portal-schedule-ops-row.is-luna{background:transparent}"
if GLOBAL_ROW in api and "[data-theme=\"dark\"] .portal-schedule-ops-row.is-staff" not in api:
    api = api.replace(
        GLOBAL_ROW,
        GLOBAL_ROW + "\n[data-theme=\"dark\"] .portal-schedule-ops-row.is-staff{background:linear-gradient(90deg,rgba(111,167,131,.14),transparent 42%)}\n[data-theme=\"dark\"] .portal-schedule-ops-row.is-luna{background:linear-gradient(90deg,rgba(111,147,184,.14),transparent 42%)}",
    )

GLOBAL_STATUS = ".portal-schedule-status.is-pending,.portal-schedule-status.is-unpaid{color:#B4534A}"
if GLOBAL_STATUS in api and "[data-theme=\"dark\"] .portal-schedule-status.is-unpaid" not in api:
    api = api.replace(
        GLOBAL_STATUS,
        GLOBAL_STATUS + "\n[data-theme=\"dark\"] .portal-schedule-status.is-pending,[data-theme=\"dark\"] .portal-schedule-status.is-unpaid{color:#ffb896}",
    )

API.write_text(api, encoding="utf-8")
print("dark mode restore OK")
