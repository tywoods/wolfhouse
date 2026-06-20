#!/usr/bin/env python3
import subprocess

cwd = "/opt/wolfhouse/WH"
msg = (
    "Sunset Schedule: calm visual pass, live i18n rerender, phone field, conversation open/start."
)
files = [
    "scripts/staff-query-api.js",
    "scripts/lib/staff-portal-i18n.js",
    "scripts/lib/staff-portal-i18n-es-sunset.js",
    "scripts/lib/sunset-schedule-booking-writes.js",
    "scripts/lib/staff-ask-luna-lessons.js",
    "scripts/lib/staff-ask-luna-gear.js",
    "scripts/verify-sunset-portal-v1.js",
    "_work/patch-sunset-schedule-calm-i18n-conversation.py",
    "_work/deploy-sunset-schedule-calm-i18n-conversation.sh",
    "_work/commit-sunset-schedule-calm-i18n-conversation.py",
    "_work/probe-sunset-schedule-calm-i18n-conversation.js",
]
subprocess.run(["/usr/bin/git", "add"] + files, cwd=cwd, check=False)
subprocess.run(["/usr/bin/git", "commit", "-m", msg], cwd=cwd, check=True)
subprocess.run(["/usr/bin/git", "log", "-1", "--oneline"], cwd=cwd, check=True)
