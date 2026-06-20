#!/usr/bin/env python3
import subprocess

cwd = "/opt/wolfhouse/WH"
msg = (
    "Sunset Schedule drawer: editable bookings, itemized payments, test Stripe links."
)
files = [
    "scripts/staff-query-api.js",
    "scripts/lib/staff-portal-i18n.js",
    "scripts/lib/staff-portal-i18n-es-sunset.js",
    "scripts/lib/sunset-schedule-booking-writes.js",
    "scripts/lib/sunset-schedule-booking-drawer.js",
    "scripts/lib/sunset-stripe-payment-links.js",
    "scripts/verify-sunset-portal-v1.js",
    "_work/patch-sunset-booking-drawer-payments-stripe.py",
    "_work/deploy-sunset-booking-drawer-payments-stripe.sh",
    "_work/commit-sunset-booking-drawer-payments-stripe.py",
    "_work/sunset-schedule-booking-drawer.js",
    "_work/sunset-stripe-payment-links.js",
    "_work/sunset-schedule-drawer-ui.js",
]
subprocess.run(["/usr/bin/git", "add"] + files, cwd=cwd, check=False)
subprocess.run(["/usr/bin/git", "commit", "-m", msg], cwd=cwd, check=True)
subprocess.run(["/usr/bin/git", "log", "-1", "--oneline"], cwd=cwd, check=True)
