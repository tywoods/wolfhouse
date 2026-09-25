'use strict';

/**
 * Wolfhouse Luna: titled pay-link map line + private-room skips gender mix ask.
 *
 * Locks:
 *   1. guest_location_line is "📍 Here is our Location: <maps URL>" (not a bare pin+URL).
 *   2. SOUL forbids girls/guys/mix when private / couple_private / room_supplement.
 *   3. Sunset map lines stay pin+URL (no Wolfhouse title regression).
 *
 * Run: node scripts/verify-wolfhouse-paylink-map-private-skip.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PLUGIN = path.join(ROOT, 'docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py');
const SOUL = path.join(ROOT, 'docker/hermes-staging/SOUL.md');
const FOLLOWTHROUGH = path.join(
  ROOT,
  'docker/hermes-staging/plugins/wolfhouse_staff_api/test_sunset_guest_followthrough.py',
);

const pluginSrc = fs.readFileSync(PLUGIN, 'utf8');
const soul = fs.readFileSync(SOUL, 'utf8');
const followSrc = fs.readFileSync(FOLLOWTHROUGH, 'utf8');

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('  PASS ', name);
  } else {
    fail += 1;
    console.log('  FAIL ', name, detail ? `— ${detail}` : '');
  }
}

console.log('verify:wolfhouse-paylink-map-private-skip\n');

const expectedLine = '📍 Here is our Location: https://maps.app.goo.gl/oPRckhqozVBvXxL16';
const constMatch = pluginSrc.match(/_WOLFHOUSE_GUEST_LOCATION_LINE\s*=\s*"([^"]+)"/);
ok('plugin constant exists', !!constMatch);
ok('Wolfhouse map line has cute title + pin + URL',
  constMatch && constMatch[1] === expectedLine,
  constMatch && constMatch[1]);

ok('Sunset Somo map stays pin+URL (no Wolfhouse title)',
  pluginSrc.includes(
    '"sunset-somo": "https://www.google.com/maps/search/?api=1&query=Sunset+Surf+School+Somo"',
  )
  && /return f"📍 \{url\}" if url else None/.test(pluginSrc));
ok('Sunset El Sardi map URL unchanged',
  pluginSrc.includes(
    '"sunset-sardinero": "https://www.google.com/maps/search/?api=1&query=Sunset+Surf+School+El+Sardinero"',
  ));

ok('SOUL private-room header forbids composition ask',
  soul.includes('Private room = no composition ask'));
ok('SOUL says gender mix does not matter for private room',
  soul.includes('gender mix does not matter for a private room'));
ok('SOUL never-ask once private is on the quote',
  /Never\*\* ask .+all girls.+mix.+once private is on the quote/s.test(soul));
ok('SOUL groups section titled shared dorm only',
  soul.includes('ask composition at room step (shared dorm only)'));
ok('group_gender tool skips private room',
  /"group_gender".*Do NOT ask or pass when the booking is private room/s.test(pluginSrc));

ok('followthrough test expects titled Wolfhouse map',
  followSrc.includes(expectedLine));
ok('followthrough locks private-room SOUL skip',
  followSrc.includes('Private room = no composition ask'));

console.log('\n────────────────────────────────────────────────');
if (fail === 0) {
  console.log(`Results: ${pass} passed, ${fail} failed`);
  console.log('verify:wolfhouse-paylink-map-private-skip — ALL CHECKS PASSED\n');
  process.exit(0);
}
console.error(`Results: ${pass} passed, ${fail} failed`);
console.error('verify:wolfhouse-paylink-map-private-skip — FAILED\n');
process.exit(1);
