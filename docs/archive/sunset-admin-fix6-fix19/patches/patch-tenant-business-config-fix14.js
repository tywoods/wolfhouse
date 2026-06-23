'use strict';
const fs = require('fs');
const path = 'G:/Luna/Sunset/scripts/lib/tenant-business-config.js';
let s = fs.readFileSync(path, 'utf8');
if (!s.includes('surf_packs')) throw new Error('missing surf_packs before patch');

s = s.replace(
  `  const hasData = prices.length > 0
    || lessonCapacityRaw.fromDb
    || lesson_times.length > 0
    || change_history.length > 0;`,
  `  const hasData = prices.length > 0
    || lessonCapacityRaw.fromDb
    || lesson_times.length > 0
    || (surf_packs && surf_packs.length > 0)
    || change_history.length > 0;`,
);

s = s.replace(
  `  const surf_packs = dbResult.surf_packs && dbResult.surf_packs.length
    ? dbResult.surf_packs
    : (configBaseline.surf_packs || []);`,
  `  const surf_packs = Array.isArray(dbResult.surf_packs)
    ? dbResult.surf_packs
    : (configBaseline.surf_packs || []);`,
);

fs.writeFileSync(path, s, 'utf8');
console.log('patched ok, surf_packs', (s.match(/surf_packs/g) || []).length);
