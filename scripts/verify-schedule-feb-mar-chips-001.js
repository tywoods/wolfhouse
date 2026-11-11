'use strict';

// Ale Launch Fix Pack item 6: Staff Schedule month pills include February
// and March, same two-month windows as Apr–Nov.
const assert = require('node:assert/strict');
const { readStaffPortalUiSource } = require('./lib/staff-portal-ui-source');
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');

const src = readStaffPortalUiSource();

function extractFunction(name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start > 0, name + ' exists');
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unclosed ' + name);
}

const chipsHtml = src.slice(src.indexOf('id="bc-chips"'), src.indexOf('id="bc-range-wrap"'));
assert.match(chipsHtml, /data-chip="feb-mar"/, 'February–March pill');
assert.match(chipsHtml, /data-chip="mar-apr"/, 'March–April pill');
assert.match(chipsHtml, /data-i18n="calendar.chip.febMar"/);
assert.match(chipsHtml, /data-i18n="calendar.chip.marApr"/);
assert.ok(
  chipsHtml.indexOf('data-chip="feb-mar"') < chipsHtml.indexOf('data-chip="apr-may"'),
  'Feb–Mar sits with the other season pills, before Apr–May'
);
assert.ok(
  chipsHtml.indexOf('data-chip="mar-apr"') < chipsHtml.indexOf('data-chip="apr-may"'),
  'Mar–Apr sits with the other season pills, before Apr–May'
);

assert.match(src, /'feb-mar':\s*\[2,\s*3\]/, 'feb-mar is Feb+Mar (1-based)');
assert.match(src, /'mar-apr':\s*\[3,\s*4\]/, 'mar-apr is Mar+Apr (1-based)');

const monthWindow = extractFunction('bcMonthWindow');
const chipKey = extractFunction('bcChipKeyForCheckIn');
const fn = new Function(
  monthWindow + '\n' + chipKey + '\nreturn { bcMonthWindow, bcChipKeyForCheckIn };'
);
const api = fn();

assert.equal(api.bcChipKeyForCheckIn('2027-02-01'), 'feb-mar');
assert.equal(api.bcChipKeyForCheckIn('2027-03-15'), 'mar-apr');
assert.equal(api.bcChipKeyForCheckIn('2027-04-01'), 'apr-may');

const feb = api.bcMonthWindow(2027, 2);
const mar = api.bcMonthWindow(2027, 3);
const apr = api.bcMonthWindow(2027, 4);
assert.deepEqual(feb, { start: '2027-02-01', end: '2027-03-01' });
assert.equal(mar.end, '2027-04-01', 'Feb–Mar view ends exclusive Apr 1');
assert.equal(apr.end, '2027-05-01', 'Mar–Apr view ends exclusive May 1');

assert.match(
  src,
  /keys = \{[^}]*1:'feb-mar'[^}]*2:'mar-apr'/,
  'opening the calendar in Feb/Mar centers those pills'
);

const en = STAFF_PORTAL_STRINGS.en;
const es = STAFF_PORTAL_STRINGS.es;
const it = STAFF_PORTAL_STRINGS.it;
assert.equal(en['calendar.chip.febMar'], 'Feb - Mar');
assert.equal(en['calendar.chip.marApr'], 'Mar - Apr');
assert.ok(es['calendar.chip.febMar'], 'ES Feb–Mar chip');
assert.equal(es['calendar.chip.marApr'], 'Mar - Abr');
assert.ok(it['calendar.chip.febMar'], 'IT Feb–Mar chip');
assert.ok(it['calendar.chip.marApr'], 'IT Mar–Apr chip');

console.log('PASS schedule feb/mar chips');
