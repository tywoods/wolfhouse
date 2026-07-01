'use strict';
const { buildMidFlowAddonsReturnTail, packageIncludesLessons } = require('./lib/luna-booking-addons-policy');
let pass=0, fail=0; function ok(n,c){ if(c){pass++; console.log('  PASS ',n);} else {fail++; console.log('  FAIL ',n);} }
ok('waimea includes lessons', packageIncludesLessons({ package_interest:'waimea' }) === true);
ok('uluwatu does not include lessons', packageIncludesLessons({ package_interest:'uluwatu' }) === false);
const q={ quote_status:'ready', addons_pending_after_quote:true };
ok('waimea add-ons prompt suppresses private lesson upsell', !/private lesson|lessons/.test(buildMidFlowAddonsReturnTail({ package_interest:'waimea', check_in:'2026-07-01', check_out:'2026-07-08', guest_count:2 }, 'en', q)));
ok('uluwatu add-ons prompt can offer private lesson casually', /private lesson/.test(buildMidFlowAddonsReturnTail({ package_interest:'uluwatu', check_in:'2026-07-01', check_out:'2026-07-08', guest_count:2 }, 'en', q)));
console.log(`
── private-lesson-package-upsell: ${pass} passed, ${fail} failed ──`); process.exit(fail?1:0);
