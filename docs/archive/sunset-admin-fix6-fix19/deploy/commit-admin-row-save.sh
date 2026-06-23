#!/bin/bash
set -euo pipefail
cd /opt/wolfhouse/WH
git add scripts/staff-query-api.js scripts/lib/tenant-admin-writes.js scripts/lib/sunset-admin-location-store.js
git commit -m "fix(sunset): admin rental row save and lesson config upsert"
git rev-parse --short HEAD
