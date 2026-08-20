'use strict';

const contract = require('./email-sunset-smtp-secret-ref-contract');
const { createSunsetSmtpStarttlsTransport } = require('./email-sunset-smtp-starttls-transport');
const SQL_ENDPOINT = `SELECT id::text, public_address, provider, inbound_enabled, outbound_enabled,
 active, default_automation_mode, location_id, smtp_health_verified_at FROM tenant_channel_endpoints
 WHERE client_id=$1::uuid AND location_id=$2 AND provider='imap_smtp' LIMIT 2`.replace(/\s+/g, ' ').trim();
const SQL_MARK_HEALTHY = `UPDATE tenant_channel_endpoints
 SET smtp_health_verified_at=NOW(), updated_at=NOW()
 WHERE id=$1::uuid AND client_id=$2::uuid AND location_id=$3 AND provider='imap_smtp'
   AND active=FALSE AND inbound_enabled=FALSE AND outbound_enabled=FALSE
   AND default_automation_mode='off'
 RETURNING id::text, smtp_health_verified_at`.replace(/\s+/g, ' ').trim();

function failure(kind, names) {
  const err = new Error('SMTP verification failed.');
  Object.defineProperty(err, 'stack', { value: undefined });
  Object.defineProperty(err, kind, { value: Object.freeze(names.slice()), enumerable: true });
  return Object.freeze(err);
}
function createSunsetSmtpLiveVerify(opts) {
  const client = opts && opts.client;
  const env = opts && opts.env;
  const provider = opts && opts.secretProvider;
  const transport = opts && opts.smtpTransport ? opts.smtpTransport : createSunsetSmtpStarttlsTransport();
  let used = false;
  return Object.freeze({
    async verifyExistingImapSmtpEndpoint(input) {
      if (used) throw failure('failed_secret_names', []);
      used = true;
      if (!contract.isSunsetEmailSmtpVerifyEnabled(env)) throw failure('failed_secret_names', []);
      if (!input || !client || typeof client.query !== 'function' || !provider
          || typeof provider.resolveSecret !== 'function' || !transport
          || typeof transport.verifySession !== 'function') throw failure('failed_secret_names', []);
      const refs = contract.evaluateSunsetSmtpSecretRefs(env);
      if (!refs.ok) throw failure('missing_secret_names', refs.missing_secret_names);
      const found = await client.query(SQL_ENDPOINT, [input.clientId, input.locationId]);
      if (!found || !Array.isArray(found.rows) || found.rows.length !== 1
          || found.rows[0].provider !== 'imap_smtp') throw failure('failed_secret_names', []);
      const values = [];
      for (let i = 0; i < refs.secret_refs.length; i += 1) {
        try {
          const value = await provider.resolveSecret(refs.secret_refs[i]);
          if (typeof value !== 'string' || value.length === 0) throw new Error('empty');
          values.push(value);
        } catch (_) {
          throw failure('failed_secret_names', [contract.SUNSET_SMTP_SECRET_NAMES[i]]);
        }
      }
      const port = Number(values[1]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw failure('failed_secret_names', ['sunset-smtp-port']);
      if (values[2] !== 'starttls') throw failure('failed_secret_names', ['sunset-smtp-tls-mode']);
      const checked = await transport.verifySession(Object.freeze({
        host: values[0], port, tlsMode: values[2], username: values[3], password: values[4],
      }));
      if (!checked || checked.ok !== true) {
        const names = checked && Array.isArray(checked.failed_secret_names)
          ? checked.failed_secret_names.filter((name) => contract.SUNSET_SMTP_SECRET_NAMES.includes(name)) : [];
        throw failure('failed_secret_names', names);
      }
      const row = found.rows[0];
      const marked = await client.query(SQL_MARK_HEALTHY, [String(row.id), input.clientId, input.locationId]);
      if (!marked || !Array.isArray(marked.rows) || marked.rows.length !== 1) {
        throw failure('failed_secret_names', []);
      }
      return Object.freeze({ endpointId: String(row.id), provider: 'imap_smtp', smtp_verified: true,
        inbound_enabled: false, outbound_enabled: false, active: false, default_automation_mode: 'off' });
    },
  });
}
module.exports = Object.freeze({ EMAIL_SMTP_VERIFY_PATH: contract.EMAIL_SMTP_VERIFY_PATH,
  SQL_ENDPOINT, SQL_MARK_HEALTHY, createSunsetSmtpLiveVerify });
