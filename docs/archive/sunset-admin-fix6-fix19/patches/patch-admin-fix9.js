'use strict';
const fs = require('fs');
const path = 'G:/Luna/Sunset/scripts/staff-query-api.js';
let s = fs.readFileSync(path, 'utf8');

if (!s.includes('function adminRenderPackScheduleReadout')) {
  const anchor = `  return { ok: true, value: keys };
}
function adminRenderPackTierFields(tiers, prefix){`;
  const insert = `  return { ok: true, value: keys };
}
function adminRenderPackScheduleReadout(schedules){
  var labels = (schedules || []).map(function(key){
    var times = adminTimesFromScheduleKey(key);
    return (times.start && times.end) ? (times.start + ' – ' + times.end) : '';
  }).filter(function(x){ return !!x; });
  var label = labels.length ? labels.join('; ') : '—';
  return '<div class="portal-admin-pack-schedule-readout"><span class="portal-admin-muted">' + escHtml(portalT('admin.packs.schedules')) + '</span> <strong>' + escHtml(label) + '</strong></div>';
}
function adminRenderPackTierFields(tiers, prefix){`;
  if (!s.includes(anchor)) throw new Error('readout anchor missing');
  s = s.replace(anchor, insert);
  console.log('added adminRenderPackScheduleReadout');
} else {
  console.log('readout already present');
}

if (s.includes('\u00081 hour\u0008') || /replace\(\/\(\u0008/.test(s)) {
  s = s.replace(/  text = text\.replace\([^;]*1 hour[^;]*;\n/, "  text = text.replace(new RegExp('\\\\b1 hour\\\\b', 'i'), '1 hour');\n");
  console.log('fixed adminHumanizeText');
} else if (s.includes("new RegExp('\\\\b1 hour\\\\b'")) {
  console.log('humanize already fixed');
} else {
  s = s.replace(
    "  text = text.replace(/(\u00081 hour\u0008/i, '1 hour');",
    "  text = text.replace(new RegExp('\\\\b1 hour\\\\b', 'i'), '1 hour');"
  );
  console.log('fixed adminHumanizeText fallback');
}

if (!s.includes('function adminPackFormField')) {
  throw new Error('adminPackFormField missing - run fix8 first');
}

if (!s.includes('function adminRenderPackScheduleReadout')) throw new Error('readout still missing');
if (s.split('\n').length > 41200) throw new Error('file bloated');

fs.writeFileSync(path, s, 'utf8');
console.log('fix9 ok lines', s.split('\n').length);
