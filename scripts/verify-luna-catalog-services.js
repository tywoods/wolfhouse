'use strict';

/* Unit gate for Luna's catalog-services knowledge engine (no DB, no GPT). */

const {
  matchCatalogServices,
  buildCatalogServiceReply,
  staysOverlapWindow,
  formatCampDates,
  formatPrice,
} = require('./lib/luna-guest-catalog-services');

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) { pass += 1; console.log('  PASS ', name); }
  else { fail += 1; console.log('  FAIL ', name); }
}

const jiu = {
  id: 'svc-1', name: 'Chokes and Barrels', active: true, luna_visible: true,
  keywords: ['jiu jitsu', 'bjj'], notes_for_luna: 'Guests come for the waves and Jiu Jitsu classes.',
  start_date: '2026-07-05', end_date: '2026-07-11', price_cents: 2000, price_unit: 'per_day', per_guest: true,
};
const hidden = { id: 'svc-2', name: 'Secret Sauna', active: true, luna_visible: false, keywords: ['sauna'] };

// ── matching ─────────────────────────────────────────────────────────
ok('matches keyword "jiu jitsu"', matchCatalogServices('do you have jiu jitsu?', [jiu]).length === 1);
ok('matches keyword with punctuation "Jiu-Jitsu"', matchCatalogServices('any Jiu-Jitsu here', [jiu]).length === 1);
ok('matches run-together "jiujitsu"', matchCatalogServices('do you do jiujitsu', [jiu]).length === 1);
ok('matches alt keyword bjj', matchCatalogServices('is there BJJ', [jiu]).length === 1);
ok('matches by name', matchCatalogServices('tell me about Chokes and Barrels', [jiu]).length === 1);
ok('no match for unrelated', matchCatalogServices('what time is breakfast', [jiu]).length === 0);
ok('luna_visible=false excluded', matchCatalogServices('is there a sauna', [hidden]).length === 0);

// ── overlap logic ────────────────────────────────────────────────────
ok('unknown dates → null', staysOverlapWindow(null, null, '2026-07-05', '2026-07-11') === null);
ok('no window → always available', staysOverlapWindow('2026-08-01', '2026-08-05', null, null) === true);
ok('stay inside window → true', staysOverlapWindow('2026-07-06', '2026-07-10', '2026-07-05', '2026-07-11') === true);
ok('stay overlaps edge → true', staysOverlapWindow('2026-07-01', '2026-07-08', '2026-07-05', '2026-07-11') === true);
ok('stay entirely after window → false', staysOverlapWindow('2026-07-12', '2026-07-23', '2026-07-05', '2026-07-11') === false);
ok('stay entirely before window → false', staysOverlapWindow('2026-06-20', '2026-07-05', '2026-07-05', '2026-07-11') === false);

// ── formatting ───────────────────────────────────────────────────────
ok('camp dates from Date objects (pg)', formatCampDates(new Date('2026-07-05T00:00:00.000Z'), new Date('2026-07-11T00:00:00.000Z')) === '5–11 Jul 2026');
ok('camp dates same month', formatCampDates('2026-07-05', '2026-07-11') === '5–11 Jul 2026');
ok('camp dates cross month', formatCampDates('2026-07-28', '2026-08-03') === '28 Jul – 3 Aug 2026');
ok('price per_day per guest', formatPrice(2000, 'per_day', true) === '€20/day per guest');
ok('price per_stay flat', formatPrice(5000, 'per_stay', false) === '€50/stay');

// ── reply assembly ───────────────────────────────────────────────────
const within = buildCatalogServiceReply(jiu, { checkIn: '2026-07-06', checkOut: '2026-07-10', guestCount: 3 });
ok('within: states name + dates + price', /Chokes and Barrels camp 5–11 Jul 2026/.test(within.text) && /€20\/day per guest/.test(within.text));
ok('within: includes notes', within.text.indexOf('Jiu Jitsu classes') !== -1);
ok('within: offers to add for all 3 guests', /add it for all 3 guests/.test(within.text) && within.needs_date_shift === false);

const outside = buildCatalogServiceReply(jiu, { checkIn: '2026-07-12', checkOut: '2026-07-23', guestCount: 5 });
ok('outside: flags date shift', outside.needs_date_shift === true);
ok('outside: offers to move dates + add for all 5', /move your stay to 5–11 Jul 2026/.test(outside.text) && /all 5 guests/.test(outside.text));

const noDates = buildCatalogServiceReply(jiu, {});
ok('no dates: info + generic group offer', noDates.needs_date_shift === false && /your group/.test(noDates.text));

console.log(`\n── luna-catalog-services: ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
