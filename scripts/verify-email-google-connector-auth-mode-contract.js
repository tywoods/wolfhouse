'use strict';
/** G2a RED: Gmail becomes an explicit connector/auth-mode pair without changing default SaaS. */
const assert = require('assert/strict');
const {
  validateEmailConnectorAuthModePair,
  resolveEmailConnectorMode,
  getEmailConnectorMaterialKeyNames,
  EMAIL_DEFAULT_SAAS_CONNECTOR_MODE,
  EMAIL_DEFAULT_SAAS_PROVIDER,
} = require('./lib/email-connector-auth-mode-contract');

const pair = validateEmailConnectorAuthModePair({
  provider: 'gmail_api',
  auth_mode: 'delegated_authorization_code',
});
assert.equal(pair.ok, true, 'Gmail delegated pair must be supported');
assert.equal(pair.value.connector_mode, 'google_delegated_oauth');
assert.equal(pair.value.default_saas, false, 'Microsoft remains the existing default SaaS');
assert.equal(pair.value.enterprise_opt_in, false);
assert.equal(pair.value.phase, 'gmail');
assert.deepEqual(pair.value.material_key_names, ['refresh_token']);
assert.equal(Object.isFrozen(pair), true);
assert.equal(Object.isFrozen(pair.value), true);
assert.equal(Object.isFrozen(pair.value.material_key_names), true);

const mode = resolveEmailConnectorMode({ connector_mode: 'google_delegated_oauth' });
assert.equal(mode.ok, true);
assert.equal(mode.value.provider, 'gmail_api');
assert.equal(mode.value.auth_mode, 'delegated_authorization_code');

const materials = getEmailConnectorMaterialKeyNames('google_delegated_oauth');
assert.equal(materials.ok, true);
assert.deepEqual(materials.value, ['refresh_token']);
assert.equal(Object.isFrozen(materials.value), true);

assert.equal(EMAIL_DEFAULT_SAAS_CONNECTOR_MODE, 'microsoft_delegated_oauth');
assert.equal(EMAIL_DEFAULT_SAAS_PROVIDER, 'microsoft_graph');

for (const invalid of [
  { provider: 'gmail_api', auth_mode: 'application_client_credentials' },
  { provider: 'gmail_api', auth_mode: 'password_or_app_password' },
  { provider: 'microsoft_graph', auth_mode: 'delegated_authorization_code', extra: true },
]) {
  assert.equal(validateEmailConnectorAuthModePair(invalid).ok, false);
}

console.log('PASS verify:email-google-connector-auth-mode-contract');
