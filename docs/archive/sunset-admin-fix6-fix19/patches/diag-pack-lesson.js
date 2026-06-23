#!/usr/bin/env node
'use strict';
const path = require('path');
process.chdir('/opt/wolfhouse/WH');
const { withPgClient } = require('../scripts/lib/pg-connect');
const { createSurfPackRule } = require('../scripts/lib/sunset-admin-pack-rules');
const { patchLessonTimeRule } = require('../scripts/lib/tenant-admin-writes');

const packBody = {
  label: 'Diag Pack',
  age_band: '12_and_up',
  group_size: 16,
  beaches: ['somo'],
  weekly: 'mon_fri',
  schedules: ['0930_1130'],
  price_tiers: [{ key: '1_week', label: '1 week', hours: 10, amount_cents: 18000 }],
};

const lessonPatch = {
  label: 'Diag lesson',
  kind: 'lesson',
  age_band: 'all_ages',
  frequency: 'daily',
  time_local: '11:00',
  capacity: 20,
  amount_cents: 4500,
};

withPgClient(async (pg) => {
  try {
    const pack = await createSurfPackRule(pg, {
      clientSlug: 'sunset',
      locationId: 'sunset-somo',
      body: packBody,
      actor: { staff_user_id: null, email: 'diag' },
    });
    console.log('pack', JSON.stringify(pack));
  } catch (e) {
    console.error('pack ERR', e.message);
    console.error(e.stack?.split('\n').slice(0, 8).join('\n'));
  }
  try {
    const lesson = await patchLessonTimeRule(pg, {
      ruleId: 'demo-slot-001',
      clientSlug: 'sunset',
      locationId: 'sunset-somo',
      patch: lessonPatch,
      actor: { staff_user_id: null, email: 'diag' },
    });
    console.log('lesson', JSON.stringify({ ok: lesson.ok, status: lesson.status, error: lesson.body?.error }));
  } catch (e) {
    console.error('lesson ERR', e.message);
    console.error(e.stack?.split('\n').slice(0, 8).join('\n'));
  }
}).catch((e) => {
  console.error('outer', e.message);
  process.exit(1);
});
