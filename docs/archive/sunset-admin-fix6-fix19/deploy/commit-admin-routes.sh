#!/bin/bash
cd /opt/wolfhouse/WH
git add scripts/staff-query-api.js scripts/lib/tenant-admin-writes.js
git commit -m "fix(sunset): accept cfg price ids and config lesson ids in admin write routes"
