#!/usr/bin/env node
'use strict';

/**
 * ACTIVE-GUEST-UNDERLINE-001
 * The guest name you select, or the name you are editing, is underlined.
 * Other names stay plain. Edit keeps the selected name underlined.
 */

const fs = require('fs');
const path = require('path');

const apiSrc = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  PASS  ' + label); pass += 1; return; }
  console.error('  FAIL  ' + label + (detail ? ' — ' + detail : ''));
  fail += 1;
}

function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) return '';
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}

console.log('\nverify-active-guest-underline-001\n');

const bind = extractFunction(apiSrc, 'bcBindActiveGuestUnderline');
const paint = extractFunction(apiSrc, 'bcFieldEditPaintInline');
const init = extractFunction(apiSrc, 'bcInitDrawerTabs');

ok('bind exists', bind.includes('function bcBindActiveGuestUnderline'));
ok('click selects one name', bind.includes("#bc-guest-names .bc-guest-name-line") && bind.includes("classList.toggle('is-active', on)"));
ok('click clears the other names', bind.includes("classList.remove('is-active')"));
ok('editing focus underlines that input', bind.includes('focusin') && bind.includes("classList.add('is-editing')"));
ok('selected name carries into the editor', paint.includes('.bc-guest-name-line.is-active') && paint.includes("classList.add('is-editing')"));
ok('drawer init binds the underline', init.includes('bcBindActiveGuestUnderline()'));
ok('selected name is underlined', apiSrc.includes('#bc-drawer-card-booking .bc-guest-name-line.is-active'));
ok('editing name is underlined', apiSrc.includes('#bc-drawer-card-booking .bc-inline-guest-name.is-editing{text-decoration:underline'));
ok('name span stays the name only', apiSrc.includes("'<span class=\"bc-guest-name-line\">' + escHtml(name)"));
ok('no new font-weight 800', !apiSrc.slice(apiSrc.indexOf('bcBindActiveGuestUnderline'), apiSrc.indexOf('function bcFieldEditPaintInline')).includes('font-weight:800') && !apiSrc.includes('.is-editing{text-decoration:underline;text-underline-offset:2px;font-weight'));

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
