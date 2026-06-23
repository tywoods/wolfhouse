'use strict';
const fs = require('fs');
const s = fs.readFileSync('G:/Luna/Sunset/scripts/staff-query-api.js', 'utf8');
console.log('lines', s.split(/\n/).length, 'bytes', s.length);
const needle = "pathname === '/staff/admin/config/surf-packs'";
let idx = -1;
let count = 0;
while ((idx = s.indexOf(needle, idx + 1)) >= 0) count++;
console.log('surf-packs route occurrences', count);
