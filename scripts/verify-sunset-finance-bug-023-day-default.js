'use strict';

/**
 * verify:sunset-finance-bug-023-day-default
 * Bug Finder #23 — Finanzas Día default must match Horario "Hoy" (portal today),
 * not Europe/Madrid when the browser calendar day differs.
 */

const path = require('path');
const fs = require('fs');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${extra != null ? ` (${extra})` : ''}`); }
}
function eq(label, got, want) {
  ok(label, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

const adminUi = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-ui.js'), 'utf8');
const redesign = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-finance-redesign-ui.js'), 'utf8');

ok('financeTodayIso prefers scheduleTodayIso (Horario Hoy)', /function financeTodayIso\(\)[\s\S]*scheduleTodayIso/.test(adminUi));
ok('financeTodayIso does not prefer Madrid over Horario', !/function financeTodayIso\(\)[\s\S]*schedulePortalMadridTodayIso/.test(adminUi));
ok('day gran snaps anchor via financeTodayIso', /data-finance-gran/.test(adminUi)
  && /financeViewState\.anchor = financeTodayIso\(\)/.test(adminUi));

// Runtime: when Horario today differs from Madrid, finance must follow Horario.
const HORARIO_TODAY = '2026-08-25';
const MADRID_TODAY = '2026-08-26';
const ctx = {
  scheduleTodayIso() { return HORARIO_TODAY; },
  schedulePortalMadridTodayIso() { return MADRID_TODAY; },
  console,
};
vm.createContext(ctx);
vm.runInContext(adminUi.match(/function financeTodayIso\(\)\{[\s\S]*?\n\}/)[0], ctx);
eq('financeTodayIso returns Horario today when Madrid differs', ctx.financeTodayIso(), HORARIO_TODAY);

// Day title uses UTC calendar formatting (EN + ES labels stay on the ISO day).
const redesignCtx = { portalLang: 'en', console };
vm.createContext(redesignCtx);
vm.runInContext(redesign, redesignCtx);
redesignCtx.portalLang = 'es';
const esTitle = redesignCtx.financeRedesignTitle({
  granularity: 'day',
  range: { start: HORARIO_TODAY, end: HORARIO_TODAY },
});
ok('ES day title shows Tue 25 Aug (not Madrid 26)', /25/.test(esTitle) && !/\b26\b/.test(esTitle), esTitle);
redesignCtx.portalLang = 'en';
const enTitle = redesignCtx.financeRedesignTitle({
  granularity: 'day',
  range: { start: HORARIO_TODAY, end: HORARIO_TODAY },
});
ok('EN day title shows Tue 25 Aug', /Tue.*25.*Aug.*2026/i.test(enTitle), enTitle);

console.log(`\nverify:sunset-finance-bug-023-day-default  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
