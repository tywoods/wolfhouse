#!/usr/bin/env node
'use strict';

/**
 * Offline/operator preparation for Chapter 4A staging test authorization.
 * Default dry-run. Refuses production. Does not fabricate an issuance.
 * Binds only an already-existing 092 issuance / 063 inbound after safe readback.
 * No server synthetic evidence. Operator must inspect and confirm the
 * server-read issuance recipient. --apply is queue-table-owner intent bound
 * durably to that existing issuance via migration 098.
 */

const crypto = require('node:crypto');
const {
  MIGRATION_098_ID,
} = require('./lib/email-luna-controlled-drafting-session-proof');
const {
  isProxySurface,
  ownData,
  exactOwnData,
  isCanonUuid,
} = require('./lib/email-luna-controlled-drafting-closed-data');

const uncurryThis = (fn) => Function.prototype.call.bind(fn);
const objectCreate = Object.create;
const objectFreeze = Object.freeze;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectHasOwn = Object.hasOwn;
const objectPrototype = Object.prototype;
const arrayIsArray = Array.isArray;
const regexpTest = uncurryThis(RegExp.prototype.test);
const stringTrim = uncurryThis(String.prototype.trim);
const stringToLowerCase = uncurryThis(String.prototype.toLowerCase);
const stringCharAt = uncurryThis(String.prototype.charAt);

const PRODUCTION_MARKERS = new Set(['production', 'prod', 'luna_prod', 'wolfhouse_prod', 'sunset_prod']);
const PUBLIC_ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PURPOSE = 'controlled_drafting_staging_proof';
const AUTHORITY = 'queue_table_owner_session';
const EXPECTED_DATABASE = 'sunset_staging';
const EXPECTED_LOCATION_KEY = 'sunset-somo';
const EXPECTED_PROVIDER = 'microsoft_graph';
const SECRETISH = /password|secret|token|postgres:\/\//i;

const READBACK_KEYS = objectFreeze([
  'operation_id',
  'issuance_id',
  'client_id',
  'location_id',
  'location_key',
  'endpoint_id',
  'inbound_event_id',
  'conversation_id',
  'recipient_address',
  'provider',
  'mailbox_id',
  'sender_address_normalized',
]);

const READBACK_SQL = [
  'SELECT m.operation_id::text AS operation_id,',
  '       m.issuance_id::text AS issuance_id,',
  '       m.client_id::text AS client_id,',
  '       m.location_id::text AS location_id,',
  '       m.location_key,',
  '       m.endpoint_id::text AS endpoint_id,',
  '       m.inbound_event_id::text AS inbound_event_id,',
  '       m.conversation_id::text AS conversation_id,',
  '       m.recipient_address,',
  '       e.provider,',
  '       e.provider_mailbox_id AS mailbox_id,',
  '       e.sender_address_normalized',
  '  FROM public.tenant_email_luna_automation_issuance_material m',
  '  JOIN public.tenant_email_inbound_events e',
  '    ON e.id = m.inbound_event_id',
  ' WHERE m.operation_id = $1::uuid',
  '   AND m.issuance_id = $2::uuid',
].join('\n');

const AUTHORIZE_SQL = 'SELECT public.tenant_email_luna_controlled_draft_staging_test_authorize($1::uuid, $2::uuid, $3::uuid) AS authorization_id';
const DATABASE_SQL = 'SELECT current_database()::text AS database';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function invalidArgs(message) {
  const error = new Error(message);
  error.code = 'PREPARE_ARGS';
  throw error;
}

function argvLength(argv) {
  if (!arrayIsArray(argv) || isProxySurface(argv)) throw invalidArgs('malformed arguments');
  const lengthDesc = objectGetOwnPropertyDescriptor(argv, 'length');
  if (!lengthDesc || !objectHasOwn(lengthDesc, 'value') || lengthDesc.get || lengthDesc.set
      || typeof lengthDesc.value !== 'number' || lengthDesc.value < 0) {
    throw invalidArgs('malformed arguments');
  }
  return lengthDesc.value;
}

function readArg(argv, index) {
  const descriptor = objectGetOwnPropertyDescriptor(argv, index);
  if (!descriptor || !objectHasOwn(descriptor, 'value') || descriptor.get || descriptor.set) {
    throw invalidArgs('malformed arguments');
  }
  const value = descriptor.value;
  if (typeof value !== 'string') throw invalidArgs('malformed arguments');
  return value;
}

function readFlagValue(argv, length, index, flag) {
  const next = index + 1;
  if (next >= length) throw invalidArgs(`${flag} requires a value`);
  const value = readArg(argv, next);
  if (value.length >= 2 && stringCharAt(value, 0) === '-' && stringCharAt(value, 1) === '-') {
    throw invalidArgs(`${flag} requires a value`);
  }
  return value;
}

function assignOnce(out, key, value, flag) {
  if (objectHasOwn(out, key)) throw invalidArgs(`duplicate argument: ${flag}`);
  out[key] = value;
}

function parseArgs(argv) {
  const length = argvLength(argv);
  const out = objectCreate(null);
  out.apply = false;
  out.help = false;
  for (let i = 0; i < length; i += 1) {
    const arg = readArg(argv, i);
    if (arg === '--apply') {
      if (out.apply === true) throw invalidArgs('duplicate argument: --apply');
      out.apply = true;
    } else if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else if (arg === '--operation-id') {
      assignOnce(out, 'operationId', readFlagValue(argv, length, i, '--operation-id'), '--operation-id');
      i += 1;
    } else if (arg === '--issuance-id') {
      assignOnce(out, 'issuanceId', readFlagValue(argv, length, i, '--issuance-id'), '--issuance-id');
      i += 1;
    } else if (arg === '--authorization-id') {
      assignOnce(out, 'authorizationId', readFlagValue(argv, length, i, '--authorization-id'), '--authorization-id');
      i += 1;
    } else if (arg === '--recipient-address') {
      assignOnce(out, 'recipientAddress', readFlagValue(argv, length, i, '--recipient-address'), '--recipient-address');
      i += 1;
    } else if (arg === '--database-url') {
      assignOnce(out, 'databaseUrl', readFlagValue(argv, length, i, '--database-url'), '--database-url');
      i += 1;
    } else {
      throw invalidArgs(`unknown argument: ${arg}`);
    }
  }
  return out;
}

function refusedProduction(env) {
  if (!env || typeof env !== 'object' || isProxySurface(env) || arrayIsArray(env)) return true;
  const deployment = ownData(env, 'LUNA_DEPLOYMENT');
  const slug = ownData(env, 'DEFAULT_CLIENT_SLUG');
  const database = ownData(env, 'PGDATABASE');
  const deploymentText = typeof deployment === 'string' ? deployment : '';
  const slugText = typeof slug === 'string' ? slug : '';
  const databaseText = typeof database === 'string' ? database : '';
  if (PRODUCTION_MARKERS.has(deploymentText) || PRODUCTION_MARKERS.has(slugText) || PRODUCTION_MARKERS.has(databaseText)) {
    return true;
  }
  if (/prod/i.test(deploymentText) && deploymentText !== 'sunset-staging') return true;
  return false;
}

function normalizeRecipientAddress(raw) {
  if (typeof raw !== 'string') return null;
  const address = stringToLowerCase(stringTrim(raw));
  if (!regexpTest(PUBLIC_ADDRESS_RE, address) || address.length < 3 || address.length > 320) return null;
  return address;
}

function resolveQuery(client) {
  if (!client || (typeof client !== 'object' && typeof client !== 'function') || isProxySurface(client)) {
    return null;
  }
  const own = objectGetOwnPropertyDescriptor(client, 'query');
  if (own) {
    return objectHasOwn(own, 'value') && typeof own.value === 'function' && !own.get && !own.set
      ? own.value
      : null;
  }
  let proto = objectGetPrototypeOf(client);
  let depth = 0;
  while (proto && proto !== objectPrototype && depth < 8) {
    if (isProxySurface(proto)) return null;
    const descriptor = objectGetOwnPropertyDescriptor(proto, 'query');
    if (descriptor) {
      return objectHasOwn(descriptor, 'value') && typeof descriptor.value === 'function'
        && !descriptor.get && !descriptor.set
        ? descriptor.value
        : null;
    }
    proto = objectGetPrototypeOf(proto);
    depth += 1;
  }
  return null;
}

function resultRows(result) {
  if (!result || typeof result !== 'object' || isProxySurface(result) || arrayIsArray(result)) return null;
  const rows = ownData(result, 'rows');
  if (!arrayIsArray(rows) || isProxySurface(rows)) return null;
  return rows;
}

function copyDatabaseRow(row) {
  const parsed = exactOwnData(row, objectFreeze(['database']));
  if (!parsed || typeof parsed.database !== 'string') return null;
  return parsed.database;
}

function copyReadbackRow(row) {
  const parsed = exactOwnData(row, READBACK_KEYS);
  if (!parsed) return null;
  if (!isCanonUuid(parsed.operation_id) || !isCanonUuid(parsed.issuance_id)
      || !isCanonUuid(parsed.client_id) || !isCanonUuid(parsed.location_id)
      || !isCanonUuid(parsed.endpoint_id) || !isCanonUuid(parsed.inbound_event_id)
      || !isCanonUuid(parsed.conversation_id)) {
    return null;
  }
  if (parsed.location_key !== EXPECTED_LOCATION_KEY || parsed.provider !== EXPECTED_PROVIDER) {
    return null;
  }
  if (typeof parsed.mailbox_id !== 'string' || parsed.mailbox_id.length < 1 || parsed.mailbox_id.length > 2048) {
    return null;
  }
  if (normalizeRecipientAddress(parsed.recipient_address) == null) return null;
  if (normalizeRecipientAddress(parsed.sender_address_normalized) == null) return null;
  return parsed;
}

function helpText() {
  return [
    'prepare-email-luna-controlled-drafting-staging-test-authorization',
    'Default dry-run. Refuses production. Does not fabricate issuance.',
    'Operator-selected existing Sunset 092 issuance / 063 inbound.',
    'No server synthetic evidence. Operator must inspect and confirm the recipient.',
    '--apply is queue-table-owner intent bound durably to that existing issuance.',
    '',
    '  --operation-id <uuid>          existing 092 operation_id',
    '  --issuance-id <uuid>           existing 092 issuance_id',
    '  --authorization-id <uuid>      optional opaque id (generated if omitted)',
    '  --recipient-address <address>  required for --apply; must equal server-read issuance recipient',
    '  --database-url <dsn>           owner exclusive session (else WOLFHOUSE_DATABASE_URL)',
    '  --apply                        invoke authorize after readback (still refuses production)',
  ].join('\n');
}

function envString(env, key) {
  const value = ownData(env, key);
  return typeof value === 'string' ? value : undefined;
}

function sanitizeMessage(error) {
  const message = error && typeof error.message === 'string' ? error.message : 'prepare failed';
  if (SECRETISH.test(message)) return 'prepare failed';
  return message;
}

async function defaultConnect(databaseUrl) {
  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (error) {
    throw new Error(`pg unavailable: ${error && error.message}`);
  }
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  await client.connect();
  return client;
}

async function runPrepare(options) {
  const failFn = options && typeof options.fail === 'function' ? options.fail : fail;
  const print = options && typeof options.print === 'function' ? options.print : (line) => console.log(line);
  if (!options || typeof options !== 'object' || isProxySurface(options) || arrayIsArray(options)) {
    failFn('malformed prepare options');
    return;
  }
  let args;
  try {
    args = parseArgs(options.argv);
  } catch (error) {
    failFn(sanitizeMessage(error));
    return;
  }
  if (args.help === true) {
    print(helpText());
    return;
  }
  const env = options.env;
  if (refusedProduction(env)) {
    failFn('refusing production/Wolfhouse acceptance for controlled-drafting staging test authorization');
    return;
  }
  const operationId = args.operationId;
  const issuanceId = args.issuanceId;
  if (typeof operationId !== 'string' || typeof issuanceId !== 'string') {
    failFn('existing --operation-id and --issuance-id are required; this command does not fabricate issuance');
    return;
  }
  if (!isCanonUuid(operationId) || !isCanonUuid(issuanceId)) {
    failFn('existing --operation-id and --issuance-id must be canonical uuids');
    return;
  }
  let suppliedNormalized = null;
  if (objectHasOwn(args, 'recipientAddress')) {
    suppliedNormalized = normalizeRecipientAddress(args.recipientAddress);
    if (suppliedNormalized == null) {
      failFn('malformed --recipient-address');
      return;
    }
  }
  if (args.apply === true && suppliedNormalized == null) {
    failFn('--apply requires explicit --recipient-address matching the server-read issuance recipient');
    return;
  }
  const authorizationId = objectHasOwn(args, 'authorizationId') ? args.authorizationId : crypto.randomUUID();
  if (!isCanonUuid(authorizationId)) {
    failFn('--authorization-id must be a canonical uuid');
    return;
  }
  const databaseUrl = objectHasOwn(args, 'databaseUrl')
    ? args.databaseUrl
    : (envString(env, 'WOLFHOUSE_DATABASE_URL') || envString(env, 'DATABASE_URL'));
  if (typeof databaseUrl !== 'string' || databaseUrl.length < 1) {
    failFn('owner database URL required');
    return;
  }

  const connect = typeof options.connect === 'function' ? options.connect : defaultConnect;
  let client;
  try {
    client = await connect(databaseUrl);
  } catch (error) {
    failFn(sanitizeMessage(error));
    return;
  }
  const queryFn = resolveQuery(client);
  if (typeof queryFn !== 'function' || isProxySurface(queryFn)) {
    failFn('owner session query is unusable');
    if (client && typeof client.end === 'function') await client.end();
    return;
  }
  let authorized = false;
  try {
    const dbResult = await queryFn.call(client, DATABASE_SQL);
    const dbRows = resultRows(dbResult);
    if (!dbRows || dbRows.length !== 1) {
      failFn('refusing database other than sunset_staging');
      return;
    }
    const databaseName = copyDatabaseRow(ownData(dbRows, 0));
    if (databaseName !== EXPECTED_DATABASE) {
      failFn('refusing database other than sunset_staging');
      return;
    }
    const readback = await queryFn.call(client, READBACK_SQL, [operationId, issuanceId]);
    const rows = resultRows(readback);
    if (!rows || rows.length !== 1) {
      failFn('existing Sunset inbound/issuance not found; will not fabricate');
      return;
    }
    const row = copyReadbackRow(ownData(rows, 0));
    if (!row) {
      failFn('existing Sunset inbound/issuance readback is malformed; will not fabricate');
      return;
    }
    if (row.operation_id !== operationId || row.issuance_id !== issuanceId) {
      failFn('existing Sunset inbound/issuance readback does not match requested ids');
      return;
    }
    const serverRecipientNormalized = normalizeRecipientAddress(row.recipient_address);
    const recipientSupplied = suppliedNormalized != null;
    const recipientMatch = recipientSupplied === true
      ? suppliedNormalized === serverRecipientNormalized
      : null;
    print(JSON.stringify({
      dry_run: args.apply !== true,
      apply: args.apply === true,
      migration: MIGRATION_098_ID,
      authorization_id: authorizationId,
      operation_id: row.operation_id,
      issuance_id: row.issuance_id,
      client_id: row.client_id,
      location_id: row.location_id,
      location_key: row.location_key,
      endpoint_id: row.endpoint_id,
      inbound_event_id: row.inbound_event_id,
      mailbox_id: row.mailbox_id,
      provider: row.provider,
      purpose: PURPOSE,
      server_synthetic_evidence: false,
      authority: AUTHORITY,
      recipient_address: row.recipient_address,
      sender_address_normalized: row.sender_address_normalized,
      recipient_confirmation_supplied: recipientSupplied,
      recipient_address_match: recipientMatch,
    }, null, 2));
    if (args.apply !== true) {
      print('dry-run only; pass --apply with --recipient-address to authorize after this readback');
      return;
    }
    if (recipientMatch !== true) {
      failFn('recipient-address does not match server-read issuance recipient; inbound sender is not a substitute');
      return;
    }
    const authorizedResult = await queryFn.call(client, AUTHORIZE_SQL, [
      authorizationId, operationId, issuanceId,
    ]);
    authorized = true;
    const authorizedRows = resultRows(authorizedResult);
    const authorizedId = authorizedRows && authorizedRows.length === 1
      ? ownData(ownData(authorizedRows, 0), 'authorization_id')
      : undefined;
    print(JSON.stringify({
      applied: true,
      authorization_id: authorizedId,
    }));
  } catch (error) {
    failFn(sanitizeMessage(error));
  } finally {
    if (client && typeof client.end === 'function') {
      try {
        await client.end();
      } catch (_) {
        /* ignore */
      }
    }
  }
  return authorized;
}

async function main() {
  await runPrepare({
    argv: process.argv.slice(2),
    env: process.env,
  });
}

if (require.main === module) {
  main().catch((error) => {
    fail(sanitizeMessage(error));
  });
}

module.exports = {
  parseArgs,
  refusedProduction,
  normalizeRecipientAddress,
  runPrepare,
  READBACK_SQL,
  AUTHORIZE_SQL,
  READBACK_KEYS,
};
