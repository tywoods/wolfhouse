#!/usr/bin/env node
'use strict';

/**
 * Offline/operator preparation for Chapter 4A staging test authorization.
 * Default dry-run. Refuses production. Does not fabricate an issuance.
 * Binds only an already-existing 092 issuance / 063 inbound after safe readback.
 */

const crypto = require('node:crypto');
const {
  MIGRATION_098_ID,
} = require('./lib/email-luna-controlled-drafting-session-proof');

const PRODUCTION_MARKERS = new Set(['production', 'prod', 'luna_prod', 'wolfhouse_prod', 'sunset_prod']);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { apply: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') out.apply = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--operation-id') out.operationId = argv[++i];
    else if (arg === '--issuance-id') out.issuanceId = argv[++i];
    else if (arg === '--authorization-id') out.authorizationId = argv[++i];
    else if (arg === '--database-url') out.databaseUrl = argv[++i];
    else fail(`unknown argument: ${arg}`);
  }
  return out;
}

function refusedProduction(env) {
  const deployment = String(env.LUNA_DEPLOYMENT || '');
  const slug = String(env.DEFAULT_CLIENT_SLUG || '');
  const database = String(env.PGDATABASE || '');
  if (PRODUCTION_MARKERS.has(deployment) || PRODUCTION_MARKERS.has(slug) || PRODUCTION_MARKERS.has(database)) {
    return true;
  }
  if (/prod/i.test(deployment) && deployment !== 'sunset-staging') return true;
  return false;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log([
      'prepare-email-luna-controlled-drafting-staging-test-authorization',
      'Default dry-run. Refuses production. Does not fabricate issuance.',
      '',
      '  --operation-id <uuid>     existing 092 operation_id',
      '  --issuance-id <uuid>      existing 092 issuance_id',
      '  --authorization-id <uuid> optional opaque id (generated if omitted)',
      '  --database-url <dsn>      owner exclusive session (else WOLFHOUSE_DATABASE_URL)',
      '  --apply                   invoke authorize after readback (still refuses production)',
    ].join('\n'));
    return;
  }
  if (refusedProduction(process.env)) {
    fail('refusing production/Wolfhouse acceptance for controlled-drafting staging test authorization');
  }
  const operationId = args.operationId;
  const issuanceId = args.issuanceId;
  if (!operationId || !issuanceId) {
    fail('existing --operation-id and --issuance-id are required; this command does not fabricate issuance');
  }
  const authorizationId = args.authorizationId || crypto.randomUUID();
  const databaseUrl = args.databaseUrl || process.env.WOLFHOUSE_DATABASE_URL || process.env.DATABASE_URL;
  if (!databaseUrl) fail('owner database URL required');

  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (error) {
    fail(`pg unavailable: ${error && error.message}`);
  }
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    const db = await client.query('SELECT current_database()::text AS database');
    if (!db.rows[0] || db.rows[0].database !== 'sunset_staging') {
      fail('refusing database other than sunset_staging');
    }
    const readback = await client.query(
      `SELECT m.operation_id::text AS operation_id,
              m.issuance_id::text AS issuance_id,
              m.client_id::text AS client_id,
              m.location_id::text AS location_id,
              m.location_key,
              m.endpoint_id::text AS endpoint_id,
              m.inbound_event_id::text AS inbound_event_id,
              m.conversation_id::text AS conversation_id,
              e.provider,
              e.provider_mailbox_id AS mailbox_id
         FROM public.tenant_email_luna_automation_issuance_material m
         JOIN public.tenant_email_inbound_events e
           ON e.id = m.inbound_event_id
        WHERE m.operation_id = $1::uuid
          AND m.issuance_id = $2::uuid`,
      [operationId, issuanceId],
    );
    if (readback.rows.length !== 1) {
      fail('existing synthetic Sunset inbound/issuance not found; will not fabricate');
    }
    const row = readback.rows[0];
    if (row.location_key !== 'sunset-somo' || row.provider !== 'microsoft_graph') {
      fail('issuance is not the approved Sunset microsoft_graph binding');
    }
    console.log(JSON.stringify({
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
      purpose: 'controlled_drafting_staging_proof',
    }, null, 2));
    if (args.apply !== true) {
      console.log('dry-run only; pass --apply to authorize after this readback');
      return;
    }
    const authorized = await client.query(
      'SELECT public.tenant_email_luna_controlled_draft_staging_test_authorize($1::uuid, $2::uuid, $3::uuid) AS authorization_id',
      [authorizationId, operationId, issuanceId],
    );
    console.log(JSON.stringify({
      applied: true,
      authorization_id: authorized.rows[0] && authorized.rows[0].authorization_id,
    }));
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    const message = error && error.message ? error.message : String(error);
    if (/password|secret|token/i.test(message)) fail('prepare failed');
    fail(message);
  });
}

module.exports = { parseArgs, refusedProduction };
