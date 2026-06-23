#!/usr/bin/env bash
set -euo pipefail
cd /opt/wolfhouse/WH
git add scripts/staff-query-api.js scripts/lib/staff-portal-i18n.js scripts/verify-portal-tenant-isolation.js scripts/verify-sunset-portal-v1.js docs/sunset/SUNSET-ADMIN-CONFIG-SPEC.md
git commit -m "feat(sunset): read-only Admin tab skeleton and config spec"
git log -1 --format=%H
git show --stat --oneline HEAD
