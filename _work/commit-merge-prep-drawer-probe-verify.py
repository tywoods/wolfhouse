#!/usr/bin/env python3
import subprocess
cwd = "/opt/wolfhouse/WH"
msg = "Merge prep: fix drawer smoke probe conversations tab; guard payment refresh helper."
subprocess.run(["/usr/bin/git", "add",
    "scripts/verify-sunset-portal-v1.js",
    "_work/probe-sunset-booking-drawer-payments-smoke.js",
    "_work/patch-merge-prep-drawer-probe-verify.py",
    "_work/commit-merge-prep-drawer-probe-verify.py",
], cwd=cwd, check=False)
subprocess.run(["/usr/bin/git", "commit", "-m", msg], cwd=cwd, check=True)
subprocess.run(["/usr/bin/git", "log", "-1", "--oneline"], cwd=cwd, check=True)
