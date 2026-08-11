'use strict';

/**
 * Offline contract: exact Gmail delegated read-authority generalization.
 * Offline and import-inert; no provider transport, OAuth route, or network access.
 */

const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const cust = require('./lib/email-delegated-grant-custodian');

const CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LOCATION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ENDPOINT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_CLIENT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OTHER_ENDPOINT = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const GOOGLE_ISSUER = 'https://accounts.google.com';
const GOOGLE_SUB = 'CaseSensitive-Sub_09.!~';
const MS_TENANT = '11111111-1111-4111-8111-111111111111';
const MS_MAILBOX = '22222222-2222-4222-8222-2222222222ab';

let passed = 0;
let failed = 0;
function ok(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function ser(value) {
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}
function input() {
  return { clientId: CLIENT, locationId: LOCATION, endpointId: ENDPOINT };
}
function gmailRow(patch) {
  return Object.assign({
    client_id: CLIENT,
    location_id: LOCATION,
    endpoint_id: ENDPOINT,
    provider: 'gmail_api',
    channel: 'email',
    auth_mode: 'delegated_authorization_code',
    connector_mode: 'google_delegated_oauth',
    binding_status: 'verified',
    provider_tenant_id: GOOGLE_ISSUER,
    provider_resource_id: GOOGLE_SUB,
    provider_principal_oid: GOOGLE_SUB,
    mailbox_kind: 'user',
    mailbox_access_kind: 'own_user',
    public_address: 'display-only@example.test',
    grant_client_id: CLIENT,
    grant_endpoint_id: ENDPOINT,
  }, patch || {});
}
function microsoftRow() {
  return {
    client_id: CLIENT,
    location_id: LOCATION,
    endpoint_id: ENDPOINT,
    provider: 'microsoft_graph',
    channel: 'email',
    auth_mode: 'delegated_authorization_code',
    connector_mode: 'microsoft_delegated_oauth',
    binding_status: 'verified',
    provider_tenant_id: MS_TENANT,
    provider_resource_id: MS_MAILBOX,
    provider_principal_oid: MS_MAILBOX,
    mailbox_kind: 'user',
    mailbox_access_kind: 'own_user',
    public_address: 'display-only@example.test',
    grant_client_id: CLIENT,
    grant_endpoint_id: ENDPOINT,
  };
}
function dbFor(rows) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql: String(sql), params: params.slice() });
      return { rows, rowCount: rows.length };
    },
  };
}
async function resolve(rows) {
  const db = dbFor(rows);
  const result = await cust.resolveDelegatedReadAuthority(input(), { db });
  return { result, db };
}
function isUnresolved(result) {
  return result && result.ok === false && result.error === 'delegated_read_authority_unresolved';
}

async function main() {
  console.log('verify:email-google-delegated-read-authority');

  const originals = {
    lookup: dns.lookup,
    lookupService: dns.lookupService,
    resolve4: dns.resolve4,
    connect: net.Socket.prototype.connect,
    httpRequest: http.request,
    httpsRequest: https.request,
  };
  let networkHits = 0;
  const blocked = () => { networkHits += 1; throw new Error('NETWORK_FORBIDDEN'); };
  dns.lookup = dns.lookupService = dns.resolve4 = blocked;
  net.Socket.prototype.connect = blocked;
  http.request = https.request = blocked;

  try {
    // Owner decision: provider is already the closed transport discriminator. Keep
    // all six existing DTO fields exactly; do not add or infer a transport field.
    ok(
      'existing DTO already has exact closed provider discriminator and no evolution is required',
      cust.DELEGATED_READ_AUTHORITY_DTO_KEYS.join(',')
        === 'clientId,locationId,endpointId,provider,providerMailboxId,bindingStatus',
    );

    const microsoft = await resolve([microsoftRow()]);
    ok(
      'Microsoft authority remains byte-compatible',
      microsoft.result.ok === true
        && JSON.stringify(microsoft.result.value) === JSON.stringify({
          clientId: CLIENT,
          locationId: LOCATION,
          endpointId: ENDPOINT,
          provider: 'microsoft_graph',
          providerMailboxId: MS_MAILBOX,
          bindingStatus: 'verified',
        }),
      ser(microsoft.result),
    );

    const gmail = await resolve([gmailRow()]);
    ok(
      'exact live-grant Gmail tuple resolves case-sensitive sub without UUID normalization',
      gmail.result.ok === true
        && Object.isFrozen(gmail.result.value)
        && JSON.stringify(gmail.result.value) === JSON.stringify({
          clientId: CLIENT,
          locationId: LOCATION,
          endpointId: ENDPOINT,
          provider: 'gmail_api',
          providerMailboxId: GOOGLE_SUB,
          bindingStatus: 'verified',
        })
        && gmail.db.queries.length === 1
        && gmail.db.queries[0].params.join(',') === [CLIENT, LOCATION, ENDPOINT].join(','),
      ser(gmail.result),
    );

    ok(
      'query contains closed two-valued Gmail authority branch',
      gmail.db.queries.length === 1
        && gmail.db.queries[0].sql.includes("e.provider = 'gmail_api'")
        && gmail.db.queries[0].sql.includes("e.connector_mode = 'google_delegated_oauth'")
        && gmail.db.queries[0].sql.includes("e.provider_tenant_id COLLATE \"C\" = 'https://accounts.google.com'")
        && gmail.db.queries[0].sql.includes('e.provider_principal_oid IS NOT NULL')
        && gmail.db.queries[0].sql.includes('e.provider_resource_id IS NOT NULL')
        && gmail.db.queries[0].sql.includes('e.provider_principal_oid COLLATE \"C\" = e.provider_resource_id COLLATE \"C\"')
        && gmail.db.queries[0].sql.includes("e.provider_resource_id COLLATE \"C\" ~ '^[!-~]+$'")
        && gmail.db.queries[0].sql.includes('COALESCE('),
      gmail.db.queries.length ? gmail.db.queries[0].sql : 'no query',
    );

    const rejects = [
      ['no live grant row', null],
      ['partial identity', { provider_principal_oid: null }],
      ['malformed non-ASCII sub', { provider_principal_oid: 'sub-é', provider_resource_id: 'sub-é' }],
      ['empty sub', { provider_principal_oid: '', provider_resource_id: '' }],
      ['overlength sub', { provider_principal_oid: 'x'.repeat(256), provider_resource_id: 'x'.repeat(256) }],
      ['malformed space in sub', { provider_principal_oid: 'sub space', provider_resource_id: 'sub space' }],
      ['noncanonical issuer', { provider_tenant_id: 'https://accounts.google.com/' }],
      ['case-mismatched principal/resource sub', { provider_resource_id: GOOGLE_SUB.toLowerCase() }],
      ['cross-provider Microsoft connector', { connector_mode: 'microsoft_delegated_oauth' }],
      ['cross-provider Microsoft provider', { provider: 'microsoft_graph' }],
      ['unverified binding', { binding_status: 'unverified_offline' }],
      ['shared mailbox', { mailbox_kind: 'shared' }],
      ['application access', { mailbox_access_kind: 'application' }],
      ['grant owned by another client', { grant_client_id: OTHER_CLIENT }],
      ['grant owned by another endpoint', { grant_endpoint_id: OTHER_ENDPOINT }],
      ['mixed endpoint ownership', { client_id: OTHER_CLIENT }],
    ];
    for (const [name, patch] of rejects) {
      const attempt = await resolve(patch === null ? [] : [gmailRow(patch)]);
      ok(`${name} rejects`, isUnresolved(attempt.result), ser(attempt.result));
    }

    ok('transport isolation: no network access', networkHits === 0, String(networkHits));
  } finally {
    dns.lookup = originals.lookup;
    dns.lookupService = originals.lookupService;
    dns.resolve4 = originals.resolve4;
    net.Socket.prototype.connect = originals.connect;
    http.request = originals.httpRequest;
    https.request = originals.httpsRequest;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(2);
});
