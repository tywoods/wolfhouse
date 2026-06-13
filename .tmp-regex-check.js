'use strict';
// Simulate what buildUiHtml template emits (single backslash in source → browser HTML)
const broken = `var phoneNorm = phone.replace(/^\+/, '').replace(/[\s\-()]/g, '');`;
console.log('broken emitted:', broken);
try {
  // eslint-disable-next-line no-new-func
  new Function(broken);
  console.log('broken: parses OK');
} catch (e) {
  console.log('broken parse error:', e.message);
}

const fixed = `var phoneNorm = phone.replace(/^\\+/, '').replace(/[\\s\\-()]/g, '');`;
console.log('fixed emitted:', fixed);
try {
  // eslint-disable-next-line no-new-func
  new Function(fixed);
  console.log('fixed: parses OK');
} catch (e) {
  console.log('fixed parse error:', e.message);
}

const noRegex = `function norm(p){var s=String(p||'').trim();if(s.charAt(0)==='+')s=s.slice(1);return s.split(' ').join('').split('-').join('').split('(').join('').split(')').join('');}`;
console.log('noRegex emitted:', noRegex.slice(0, 80) + '...');
new Function(noRegex);
console.log('noRegex: parses OK');
