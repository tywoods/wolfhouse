'use strict';

const {
  portalRoomGenderI18nKey,
  isPortalOperatorRoom,
  formatPortalRoomMetaLabel,
  resolveRoomCategory,
} = require('./lib/staff-portal-room-label');
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');

let passed = 0;
let failed = 0;

function check(id, ok, msg) {
  if (ok) { passed += 1; return; }
  failed += 1;
  console.error(`FAIL ${id}: ${msg}`);
}

function t(locale, key, vars) {
  const pack = STAFF_PORTAL_STRINGS[locale] || STAFF_PORTAL_STRINGS.en;
  let text = pack[key] || STAFF_PORTAL_STRINGS.en[key] || key;
  if (vars) {
    Object.keys(vars).forEach((k) => {
      text = String(text).split(`{${k}}`).join(String(vars[k]));
    });
  }
  return text;
}

function room(code, opts) {
  const layout = {
    R1: { room_type: 'mixed', gender_strategy: 'Flexible', capacity: 5 },
    R2: { room_type: 'male_only', gender_strategy: 'Male preferred', capacity: 5 },
    R3: { room_type: 'matrimonial_or_mixed', gender_strategy: 'Flexible', capacity: 4, can_be_matrimonial: true },
    R4: { room_type: 'male_only', gender_strategy: 'Male preferred', capacity: 9 },
    R5: { room_type: 'female_only', gender_strategy: 'Female preferred', capacity: 6 },
    R6: { room_type: 'matrimonial_private_couple', gender_strategy: 'Private', capacity: 2, can_be_matrimonial: true },
    R7: { room_type: 'operator_surfweek', gender_strategy: 'Flexible', capacity: 4, often_used_by_operator: true },
    R9: { room_type: 'operator_surfweek', gender_strategy: 'Flexible', capacity: 6, often_used_by_operator: true },
  };
  const base = layout[code];
  return { room_code: code, ...base, ...(opts || {}) };
}

check('CAT1', resolveRoomCategory(room('R2')) === 'male_only', 'R2 male_only');
check('CAT2', resolveRoomCategory(room('R5')) === 'female_only', 'R5 female_only');
check('CAT3', resolveRoomCategory(room('R3')) === 'matrimonial_or_mixed', 'R3 matrimonial_or_mixed');
check('CAT4', resolveRoomCategory(room('R6')) === 'matrimonial_private_couple', 'R6 private couple');
check('CAT5', resolveRoomCategory(room('R7')) === 'operator_surfweek', 'R7 operator');

check('KEY1', portalRoomGenderI18nKey(room('R2')) === 'room.gender.male', 'male key');
check('KEY2', portalRoomGenderI18nKey(room('R5')) === 'room.gender.female', 'female key');
check('KEY3', portalRoomGenderI18nKey(room('R1')) === 'room.gender.flexible', 'mixed flexible');
check('KEY4', portalRoomGenderI18nKey(room('R6')) === 'room.gender.private', 'private key');

check('OP1', isPortalOperatorRoom(room('R7')), 'R7 operator');
check('OP2', !isPortalOperatorRoom(room('R1')), 'R1 not operator');

{
  const label = formatPortalRoomMetaLabel(room('R2'), (k, v) => t('en', k, v));
  check('EN1', label === 'Male · 5 beds', `R2 en label (${label})`);
  check('EN2', !/preferred|only|male_only/i.test(label), 'no raw tokens en');
}
{
  const label = formatPortalRoomMetaLabel(room('R5'), (k, v) => t('en', k, v));
  check('EN3', label === 'Female · 6 beds', `R5 en (${label})`);
}
{
  const label = formatPortalRoomMetaLabel(room('R7'), (k, v) => t('en', k, v));
  check('EN4', label === 'Flexible · Operator · 4 beds', `R7 en (${label})`);
}
{
  const label = formatPortalRoomMetaLabel(room('R6'), (k, v) => t('en', k, v));
  check('EN5', label === 'Private · 2 beds', `R6 en (${label})`);
}

{
  const label = formatPortalRoomMetaLabel(room('R2'), (k, v) => t('es', k, v));
  check('ES1', label === 'Masculino · 5 camas', `R2 es (${label})`);
}
{
  const label = formatPortalRoomMetaLabel(room('R7'), (k, v) => t('es', k, v));
  check('ES2', label.includes('Operador') && label.includes('camas'), `R7 es (${label})`);
}

{
  const label = formatPortalRoomMetaLabel(room('R5'), (k, v) => t('it', k, v));
  check('IT1', label === 'Femminile · 6 letti', `R5 it (${label})`);
}
{
  const label = formatPortalRoomMetaLabel(room('R9'), (k, v) => t('it', k, v));
  check('IT2', label === 'Flessibile · Operatore · 6 letti', `R9 it (${label})`);
}

console.log(`\n── verify:staff-portal-room-label ${failed ? 'FAILED' : 'PASSED'} (${passed}/${passed + failed}) ──`);
process.exit(failed > 0 ? 1 : 0);
