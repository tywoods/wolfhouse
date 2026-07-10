'use strict';

const TENANT = 'sunset';
const LOCATIONS = Object.freeze([
  ['SUNSET_SOMO_WHATSAPP_PHONE_NUMBER_ID', 'sunset-somo'],
  ['SUNSET_SARDINERO_WHATSAPP_PHONE_NUMBER_ID', 'sunset-sardinero'],
]);

function resolveSunsetPhoneNumberId(phoneNumberId, env = process.env) {
  const mappings = LOCATIONS.map(([key, location_id]) => ({ id: String(env[key] || '').trim(), location_id }));
  const configured = mappings.filter(({ id }) => id);
  if (new Set(configured.map(({ id }) => id)).size !== configured.length) {
    throw new Error('Sunset phone_number_id mappings must be unique');
  }
  const match = configured.find(({ id }) => id === String(phoneNumberId || '').trim());
  if (!match) throw new Error('unknown Sunset phone_number_id (fail closed)');
  return { tenant_id: TENANT, client_slug: TENANT, location_id: match.location_id };
}

module.exports = { resolveSunsetPhoneNumberId, TENANT, LOCATIONS };
