#!/usr/bin/env node
'use strict';

/**
 * MAIL-MVP-004 / 003 channel-mode store — canonical clients.settings.
 *
 * Offline, integration-shaped. Fake adapters + in-memory schema-shaped pg.
 * Does not execute live Azure, Graph, provider send, or production/staging DBs.
 *
 * Run: node scripts/verify-email-inbox-channel-mode.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const STORE_REL = 'scripts/lib/email-inbox-channel-mode.js';
const STORE_ABS = path.join(ROOT, STORE_REL);
const LIVE_REL = 'scripts/lib/email-luna-microsoft-auto-create-send-live-proof.js';
const LIVE_ABS = path.join(ROOT, LIVE_REL);
const INIT_SQL = path.join(ROOT, 'database/migrations/001_init.sql');
const RENAME_SQL = path.join(ROOT, 'database/migrations/003_rename_hostel_to_client.sql');
const EXPECTED_SCHEMA = path.join(ROOT, 'fixtures/sunset-schema-observer/expected-product-schema.json');
const PKG = path.join(ROOT, 'package.json');

const {
  createEmailInboxChannelModeStore,
  CHANNEL_MODE_UNPROVEN,
  SQL_LOAD_CLIENT_CHANNEL_MODES,
  SQL_STORE_CLIENT_CHANNEL_MODES,
  EMAIL_INBOX_CHANNEL_MODE_DEFAULT,
  WHATSAPP_INBOX_CHANNEL_MODE_DEFAULT,
} = require('./lib/email-inbox-channel-mode');
const {
  createMailMvp004LiveProof,
  brandProductionAutoOwner,
  parseArgs,
  COMMAND,
  CONFIRMATION_PHRASE,
  SUNSET_DEPLOYMENT,
  SUNSET_TENANT,
  EXPECTED_DATABASE,
  RG,
  STAFF_APP,
  IMAGE_REPOSITORY,
  ENV_LUNA_AUTO_SEND_ENABLED,
  ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED,
} = require('./lib/email-luna-microsoft-auto-create-send-live-proof');

const CLIENT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLIENT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const IMAGE_SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const REVISION = `${STAFF_APP}--0000001`;
const NOW_MS = Date.parse('2026-08-27T12:00:00.000Z');
const ISSUED = new Date(NOW_MS).toISOString();

function pgUndefinedColumn(name) {
  const err = new Error(`column "${name}" does not exist`);
  err.code = '42703';
  return err;
}

function mentionsColumn(sql, column) {
  return new RegExp(`\\b${column}\\b`).test(String(sql));
}

function createSchemaShapedClients(opts) {
  const columns = new Set(opts.columns);
  const clients = new Map();
  for (const row of opts.rows || []) {
    clients.set(row.id, {
      id: row.id,
      slug: row.slug,
      settings: row.settings && typeof row.settings === 'object' ? { ...row.settings } : {},
      metadata: row.metadata && typeof row.metadata === 'object' ? { ...row.metadata } : {},
    });
  }

  async function query(sql, params) {
    const n = String(sql).replace(/\s+/g, ' ').trim();
    if (mentionsColumn(n, 'metadata') && !columns.has('metadata')) throw pgUndefinedColumn('metadata');
    if (mentionsColumn(n, 'settings') && !columns.has('settings')) throw pgUndefinedColumn('settings');
    if (/FROM information_schema.columns/.test(n)) {
      return {
        rows: [...columns].map((column) => ({
          table_schema: 'public',
          table_name: 'clients',
          column_name: column,
          data_type: column === 'settings' || column === 'metadata' ? 'jsonb' : 'text',
        })),
      };
    }
    const id = params && params[0];
    if (/SELECT /.test(n) && /FROM clients/.test(n) && /id=\$1::uuid/.test(n) && !/UPDATE /.test(n)) {
      const row = clients.get(id);
      if (!row) return { rows: [] };
      const src = columns.has('settings') ? row.settings : row.metadata;
      const modes = src && src.inbox_channel_modes;
      return { rows: [{ inbox_channel_modes: modes == null ? null : { ...modes } }] };
    }
    if (/UPDATE clients/.test(n) && /jsonb_set/.test(n) && /id=\$1::uuid/.test(n)) {
      const row = clients.get(id);
      if (!row) return { rows: [] };
      const nextModes = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1];
      const col = /SET settings = jsonb_set/.test(n) ? 'settings' : 'metadata';
      if (!columns.has(col)) throw pgUndefinedColumn(col);
      const current = row[col] && typeof row[col] === 'object' ? { ...row[col] } : {};
      current.inbox_channel_modes = { ...nextModes };
      row[col] = current;
      return { rows: [{ inbox_channel_modes: { ...nextModes } }] };
    }
    throw new Error(`unexpected_sql:${n}`);
  }

  return {
    columns,
    clients,
    withPgClient: async (fn) => fn({ query }),
  };
}

function canonicalWorld(extraSettingsA) {
  return createSchemaShapedClients({
    columns: ['id', 'slug', 'settings'],
    rows: [
      {
        id: CLIENT_A,
        slug: 'sunset',
        settings: {
          theme: 'dark',
          wa_extra: { routing: 'staff' },
          ...(extraSettingsA || {}),
        },
      },
      {
        id: CLIENT_B,
        slug: 'other',
        settings: { theme: 'light' },
      },
    ],
  });
}

function nonce() {
  return crypto.randomBytes(32).toString('hex');
}

function flagsOff() {
  return Object.freeze({
    [ENV_LUNA_AUTO_SEND_ENABLED]: 'false',
    [ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED]: 'false',
  });
}

function flagsOn() {
  return Object.freeze({
    [ENV_LUNA_AUTO_SEND_ENABLED]: 'true',
    [ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED]: 'true',
  });
}

function serving(patch) {
  return {
    resourceGroup: RG,
    appName: STAFF_APP,
    revision: REVISION,
    imageRepository: IMAGE_REPOSITORY,
    imageTag: IMAGE_SHA,
    deploySha: IMAGE_SHA,
    digest: DIGEST,
    flags: flagsOff(),
    healthState: 'Healthy',
    runningState: 'Running',
    trafficWeight: 100,
    ready: true,
    provisioningState: 'Provisioned',
    flagsSource: 'replica_process',
    replica: `${REVISION}-abcde-fghij`,
    unrelatedEnvFingerprint: '[]',
    ...patch,
  };
}

function authArgs() {
  return parseArgs([
    COMMAND,
    '--deployment', SUNSET_DEPLOYMENT,
    '--tenant', SUNSET_TENANT,
    '--database', EXPECTED_DATABASE,
    '--resource-group', RG,
    '--app', STAFF_APP,
    '--revision', REVISION,
    '--image-tag', IMAGE_SHA,
    '--digest', DIGEST,
    '--confirm', CONFIRMATION_PHRASE,
    '--operator-nonce', nonce(),
    '--confirm-issued-at', ISSUED,
  ]);
}

function executeInput() {
  return {
    parsed: authArgs(),
    env: { LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT },
    nowMs: NOW_MS,
    originMasterSha: IMAGE_SHA,
    headSha: IMAGE_SHA,
    artifactsOnMaster: true,
    treeHasProofFiles: true,
    requireLiveImage: true,
  };
}

function create004Harness(withPgClient) {
  const log = [];
  let current = serving();
  const store = createEmailInboxChannelModeStore({ withPgClient });
  const proof = createMailMvp004LiveProof({
    nonceStore: new Set(),
    now: () => NOW_MS,
    async readServingIdentity() { return current; },
    async waitServingHealthy(input) {
      log.push(`wait:${input && input.enabled}`);
      current = serving({
        ...current,
        revision: input && input.enabled
          ? `${STAFF_APP}--enabled-${IMAGE_SHA.slice(0, 8)}`
          : `${STAFF_APP}--safe-${IMAGE_SHA.slice(0, 8)}`,
        replica: input && input.enabled
          ? `${STAFF_APP}--enabled-${IMAGE_SHA.slice(0, 8)}-aaaaa-bbbbb`
          : `${STAFF_APP}--safe-${IMAGE_SHA.slice(0, 8)}-ccccc-ddddd`,
        flags: input && input.enabled ? flagsOn() : flagsOff(),
      });
      return current;
    },
    async setEmergencyFlags(enabled) {
      log.push(`flags:${enabled}`);
      current = serving({
        ...current,
        revision: enabled
          ? `${STAFF_APP}--enabled-${IMAGE_SHA.slice(0, 8)}`
          : `${STAFF_APP}--safe-${IMAGE_SHA.slice(0, 8)}`,
        replica: enabled
          ? `${STAFF_APP}--enabled-${IMAGE_SHA.slice(0, 8)}-aaaaa-bbbbb`
          : `${STAFF_APP}--safe-${IMAGE_SHA.slice(0, 8)}-ccccc-ddddd`,
        flags: enabled ? flagsOn() : flagsOff(),
      });
    },
    async putEmailChannelMode(value) {
      log.push(`mode:${value}`);
      await store.putChannelMode(CLIENT_A, 'email', value);
      const stored = await store.getChannelMode(CLIENT_A, 'email');
      if (stored !== value) throw new Error(CHANNEL_MODE_UNPROVEN);
    },
    async getEmailChannelMode() {
      return store.getChannelMode(CLIENT_A, 'email');
    },
    async preflightSelectedOperation() {
      return {
        ok: true,
        approvals: 0,
        journals: 0,
        provider_sends: 0,
        bookings: 4,
        luna_on: true,
        needs_human: false,
        guest_linked: true,
        sender_ok: true,
        subject_ok: true,
        sol_enabled: true,
        client_id: CLIENT_A,
      };
    },
    invokeAutoOwner: brandProductionAutoOwner(async () => {
      log.push('invoke');
      return { status: 'sent', sent: true, approvals: 1, journals: 1, provider_sends: 1 };
    }),
    async snapshotOperation() {
      return { approvals: 0, journals: 0, provider_sends: 0, bookings: 4 };
    },
    async readDurableEvidence() {
      return {
        hmac_available: true,
        evidence_verified: true,
        leftover: false,
        sol_model: 'gpt-5.6-sol',
        sol_provider: 'openai-codex',
        sol_runtime: 'sunset-email-luna',
      };
    },
    async verifyGraphArrival() {
      return { ok: true, adapter_available: true, readonly: true, arrivals: 1, duplicates: 0, threaded: true };
    },
    async verifyKillSwitch() {
      log.push('kill');
      return {
        ok: true,
        status: 'blocked',
        reason: 'emergency_flags_off',
        author_called: false,
        journal_called: false,
        provider_called: false,
        provider_sends: 0,
      };
    },
  });
  return { proof, log };
}

async function main() {
  console.log('verify:email-inbox-channel-mode\n');

  console.log('[1] Canonical repo schema is clients.settings jsonb, not metadata');
  {
    const initSql = fs.readFileSync(INIT_SQL, 'utf8');
    const renameSql = fs.readFileSync(RENAME_SQL, 'utf8');
    const hostels = initSql.slice(initSql.indexOf('CREATE TABLE hostels'), initSql.indexOf('CREATE TABLE packages'));
    assert.match(hostels, /settings\s+JSONB NOT NULL DEFAULT '\{\}'/);
    assert.doesNotMatch(hostels, /\bmetadata\b/);
    assert.match(renameSql, /ALTER TABLE IF EXISTS hostels RENAME TO clients/);
    assert.doesNotMatch(renameSql, /ADD COLUMN\s+metadata/i);
    const expected = JSON.parse(fs.readFileSync(EXPECTED_SCHEMA, 'utf8'));
    const clientCols = expected.snapshot.columns.filter((col) => col.table === 'clients');
    const names = clientCols.map((col) => col.column);
    assert.equal(names.includes('settings'), true);
    assert.equal(names.includes('metadata'), false);
    const settings = clientCols.find((col) => col.column === 'settings');
    assert.equal(settings.udt, 'jsonb');
    assert.equal(settings.nullable, 'NO');
    console.log('  PASS  canonical clients.settings jsonb; metadata absent');
  }

  console.log('[2] Store SQL is exact settings jsonb_set, no metadata, no dynamic SQL');
  {
    const src = fs.readFileSync(STORE_ABS, 'utf8');
    const liveSrc = fs.readFileSync(LIVE_ABS, 'utf8');
    assert.match(SQL_LOAD_CLIENT_CHANNEL_MODES, /SELECT settings->'inbox_channel_modes' AS inbox_channel_modes/);
    assert.match(SQL_LOAD_CLIENT_CHANNEL_MODES, /FROM clients WHERE id=\$1::uuid LIMIT 1/);
    assert.match(SQL_STORE_CLIENT_CHANNEL_MODES, /SET settings = jsonb_set/);
    assert.match(SQL_STORE_CLIENT_CHANNEL_MODES, /COALESCE\(settings, '\{\}'::jsonb\)/);
    assert.match(SQL_STORE_CLIENT_CHANNEL_MODES, /'\{inbox_channel_modes\}'/);
    assert.match(SQL_STORE_CLIENT_CHANNEL_MODES, /WHERE id=\$1::uuid/);
    assert.match(SQL_STORE_CLIENT_CHANNEL_MODES, /RETURNING settings->'inbox_channel_modes' AS inbox_channel_modes/);
    assert.doesNotMatch(src, /metadata->'inbox_channel_modes'/);
    assert.doesNotMatch(src, /SET metadata = jsonb_set/);
    assert.doesNotMatch(src, /information_schema|pg_catalog|to_regclass/);
    assert.doesNotMatch(src, /catch \{\s*return current;\s*\}/);
    assert.doesNotMatch(src, /catch \{\s*return snapshotModes\(null\);\s*\}/);
    assert.match(src, /if \(!row\) throw unproven\(\)/);
    assert.match(liveSrc, /if \(stored !== value\) throw new Error\('channel_mode_unproven'\)/);
    assert.match(liveSrc, /failedReason = 'channel_mode_unproven'/);
    console.log('  PASS  store SQL + fail-closed source contract');
  }

  console.log('[3] Missing metadata, settings present: put+get auto/off/draft');
  {
    const world = canonicalWorld();
    assert.equal(world.columns.has('settings'), true);
    assert.equal(world.columns.has('metadata'), false);
    const store = createEmailInboxChannelModeStore({ withPgClient: world.withPgClient });
    const missing = await store.loadModes(CLIENT_A);
    assert.equal(missing.email, EMAIL_INBOX_CHANNEL_MODE_DEFAULT);
    assert.equal(missing.whatsapp, WHATSAPP_INBOX_CHANNEL_MODE_DEFAULT);
    assert.equal(await store.getChannelMode(CLIENT_A, 'email'), 'draft');

    const auto = await store.putChannelMode(CLIENT_A, 'email', 'auto');
    assert.equal(auto.email, 'auto');
    assert.equal(auto.whatsapp, 'auto');
    assert.equal(await store.getChannelMode(CLIENT_A, 'email'), 'auto');

    const off = await store.putChannelMode(CLIENT_A, 'email', 'off');
    assert.equal(off.email, 'off');
    assert.equal(await store.getChannelMode(CLIENT_A, 'email'), 'off');

    const draft = await store.putChannelMode(CLIENT_A, 'email', 'draft');
    assert.equal(draft.email, 'draft');
    assert.equal(await store.getChannelMode(CLIENT_A, 'email'), 'draft');
    console.log('  PASS  put+get auto/off/draft on settings-only clients');
  }

  console.log('[4] jsonb_set preserves WhatsApp mode and unrelated settings; tenant binding');
  {
    const world = canonicalWorld({ inbox_channel_modes: { email: 'draft', whatsapp: 'off' } });
    const store = createEmailInboxChannelModeStore({ withPgClient: world.withPgClient });
    await store.putChannelMode(CLIENT_A, 'email', 'auto');
    const modes = await store.loadModes(CLIENT_A);
    assert.equal(modes.email, 'auto');
    assert.equal(modes.whatsapp, 'off');
    const saved = world.clients.get(CLIENT_A).settings;
    assert.equal(saved.theme, 'dark');
    assert.deepEqual(saved.wa_extra, { routing: 'staff' });
    assert.equal(saved.inbox_channel_modes.email, 'auto');
    assert.equal(saved.inbox_channel_modes.whatsapp, 'off');
    const other = world.clients.get(CLIENT_B).settings;
    assert.equal(other.theme, 'light');
    assert.equal(other.inbox_channel_modes, undefined);
    assert.equal(await store.getChannelMode(CLIENT_B, 'email'), 'draft');
    await store.putChannelMode(CLIENT_B, 'whatsapp', 'off');
    assert.equal(await store.getChannelMode(CLIENT_A, 'whatsapp'), 'off');
    assert.equal(await store.getChannelMode(CLIENT_B, 'whatsapp'), 'off');
    assert.equal(world.clients.get(CLIENT_A).settings.theme, 'dark');
    console.log('  PASS  unrelated settings + WhatsApp retained; client binding');
  }

  console.log('[5] Write failure fail-closed; 004 channel_mode_unproven invoked=0');
  {
    const missingSettings = createSchemaShapedClients({
      columns: ['id', 'slug'],
      rows: [{ id: CLIENT_A, slug: 'sunset' }],
    });
    const missingStore = createEmailInboxChannelModeStore({ withPgClient: missingSettings.withPgClient });
    await assert.rejects(
      () => missingStore.putChannelMode(CLIENT_A, 'email', 'auto'),
      (err) => err && err.message === CHANNEL_MODE_UNPROVEN,
    );

    const metadataOnly = createSchemaShapedClients({
      columns: ['id', 'slug', 'metadata'],
      rows: [{ id: CLIENT_A, slug: 'sunset', metadata: { inbox_channel_modes: { email: 'off' } } }],
    });
    const metaStore = createEmailInboxChannelModeStore({ withPgClient: metadataOnly.withPgClient });
    await assert.rejects(
      () => metaStore.putChannelMode(CLIENT_A, 'email', 'auto'),
      (err) => err && err.message === CHANNEL_MODE_UNPROVEN,
    );

    const throwOnWrite = {
      async withPgClient(fn) {
        return fn({
          async query(sql) {
            const n = String(sql).replace(/\s+/g, ' ');
            if (/UPDATE /.test(n)) throw pgUndefinedColumn('metadata');
            if (/SELECT /.test(n) && /FROM clients/.test(n)) {
              return { rows: [{ inbox_channel_modes: { email: 'draft', whatsapp: 'auto' } }] };
            }
            return { rows: [] };
          },
        });
      },
    };
    const throwStore = createEmailInboxChannelModeStore({ withPgClient: throwOnWrite.withPgClient });
    await assert.rejects(
      () => throwStore.putChannelMode(CLIENT_A, 'email', 'auto'),
      (err) => err && err.message === CHANNEL_MODE_UNPROVEN,
    );

    const emptyUpdate = {
      async withPgClient(fn) {
        return fn({
          async query(sql) {
            const n = String(sql).replace(/\s+/g, ' ');
            if (/UPDATE /.test(n)) return { rows: [] };
            return { rows: [{ inbox_channel_modes: { email: 'draft', whatsapp: 'auto' } }] };
          },
        });
      },
    };
    const emptyStore = createEmailInboxChannelModeStore({ withPgClient: emptyUpdate.withPgClient });
    await assert.rejects(
      () => emptyStore.putChannelMode(CLIENT_A, 'email', 'auto'),
      (err) => err && err.message === CHANNEL_MODE_UNPROVEN,
    );

    const { proof, log } = create004Harness(throwOnWrite.withPgClient);
    const refused = await proof.executeOnce(executeInput());
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'channel_mode_unproven');
    assert.equal(refused.invoked, 0);
    assert.equal(log.includes('flags:true'), true);
    assert.equal(log.includes('mode:auto'), true);
    assert.equal(log.includes('invoke'), false);
    console.log('  PASS  write miss fail-closed; 004 channel_mode_unproven invoked=0');
  }

  console.log('[6] No production / live / cloud');
  {
    const storeSrc = fs.readFileSync(STORE_ABS, 'utf8');
    const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
    assert.doesNotMatch(storeSrc, /containerapp/);
    assert.doesNotMatch(storeSrc, /graph\.microsoft\.com/);
    assert.doesNotMatch(storeSrc, /DATABASE_URL/);
    assert.doesNotMatch(storeSrc, /azurecontainerapps\.io/);
    assert.equal(pkg.scripts['verify:email-inbox-channel-mode'], 'node scripts/verify-email-inbox-channel-mode.js');
    console.log('  PASS  offline only; npm script wired');
  }

  console.log('\nPASS email inbox channel-mode settings store');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
