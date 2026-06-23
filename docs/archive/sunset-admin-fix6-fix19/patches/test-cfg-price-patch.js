#!/usr/bin/env node
'use strict';
const path = require('path');
process.chdir(path.join(__dirname, '..'));
const { patchPriceRule } = require('./scripts/lib/tenant-admin-writes');
const { withPgClient } = require('./scripts/lib/pg-connect');
const ruleId = 'cfg:sunset-somo:rental|board_rental|1_hour';
withPgClient(async (pg) => {
  try {
    const r = await patchPriceRule(pg, {
      ruleId,
      clientSlug: 'sunset',
      locationId: 'sunset-somo',
      patch: { period_window: '1_hour', amount_cents: 600 },
      actor: { staff_user_id: null, email: 'test@test.com' },
    });
    console.log(JSON.stringify(r, null, 2));
  } catch (e) {
    console.error('ERR', e.message);
    console.error(e.stack);
  }
}).then(() => process.exit(0));
