#!/usr/bin/env python3
import subprocess

cwd = "/opt/wolfhouse/WH"
msg = (
    "Sunset Schedule polish: source row styling, rental pickup grouping, remove row tags."
)
subprocess.run(
    [
        "/usr/bin/git",
        "add",
        "scripts/staff-query-api.js",
        "scripts/lib/staff-portal-i18n.js",
        "scripts/verify-sunset-portal-v1.js",
        "_work/patch-sunset-schedule-source-rental-polish.py",
        "_work/deploy-sunset-schedule-source-rental-polish.sh",
        "_work/commit-source-rental-polish.py",
    ],
    cwd=cwd,
    check=False,
)
subprocess.run(["/usr/bin/git", "commit", "-m", msg], cwd=cwd, check=True)
subprocess.run(["/usr/bin/git", "log", "-1", "--oneline"], cwd=cwd, check=True)
