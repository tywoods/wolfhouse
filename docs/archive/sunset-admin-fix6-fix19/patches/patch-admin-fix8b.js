'use strict';
const fs = require('fs');
const path = 'G:/Luna/Sunset/scripts/staff-query-api.js';
let s = fs.readFileSync(path, 'utf8');

const bad = "  text = text.replace(/(\u00081 hour\u0008/i, '1 hour');";
const good = "  text = text.replace(new RegExp('\\\\b1 hour\\\\b', 'i'), '1 hour');";

if (s.includes(good)) {
  console.log('humanize already fixed');
} else if (s.includes('text = text.replace(/(\u00081 hour\u0008/i')) {
  s = s.replace(bad, good);
  fs.writeFileSync(path, s, 'utf8');
  console.log('humanize fixed via backspace match');
} else {
  s = s.replace(
    /text = text\.replace\(\/\(\\d\+\) day pack surfer\/i, '\$1 day pack'\);\n  text = text\.replace\([^;]+;\n/,
    "text = text.replace(/(\\d+) day pack surfer/i, '$1 day pack');\n  text = text.replace(new RegExp('\\\\b1 hour\\\\b', 'i'), '1 hour');\n"
  );
  fs.writeFileSync(path, s, 'utf8');
  console.log('humanize fixed via regex');
}
