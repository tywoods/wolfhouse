#!/usr/bin/env node
'use strict';

/**
 * Stage 28g — Turn staging open-demo guest playground ON/OFF.
 *
 * Usage:
 *   node scripts/set-open-demo-playground-mode.js --on
 *   node scripts/set-open-demo-playground-mode.js --off
 *   node scripts/set-open-demo-playground-mode.js --off --restore-owner
 *
 * ON: live WhatsApp replies + booking writes for demo number (staging only).
 * OFF: restore safe dry-run baseline.
 */

const { Client } = require('pg');
const {
  DEFAULT_PHONE,
  PLAYGROUND_ON_ENV,
  PLAYGROUND_OFF_ENV,
  assertNotProductionDb,
  azExec,
  defaultConnectionString,
  fetchStaffApiGates,
  parsePhoneVariants,
  removeStaffApiEnvVars,
  restoreGuestPhoneOwner,
  setGuestPhoneInactive,
  setStaffApiEnvVars,
  trimStr,
} = require('./lib/open-demo-playground-common');

const DEFAULT_DURATION_MINUTES = 120;

function parseModeArgs(argv) {
  const out = {
    on: false,
    off: false,
    phone: DEFAULT_PHONE,
    durationMinutes: DEFAULT_DURATION_MINUTES,
    restoreOwner: false,
    json: false,
    dbUrl: null,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--on': out.on = true; break;
      case '--off': out.off = true; break;
      case '--phone': out.phone = argv[++i]; break;
      case '--duration-minutes': out.durationMinutes = Number(argv[++i]) || DEFAULT_DURATION_MINUTES; break;
      case '--restore-owner': out.restoreOwner = true; break;
      case '--json': out.json = true; break;
      case '--db-url': out.dbUrl = argv[++i]; break;
      case '--dry-run': out.dryRun = true; break;
      case '--help':
      case '-h': out.help = true; break;
      default: out.unknown = (out.unknown || []).concat(a); break;
    }
  }
  if (out.on && out.off) throw new Error('use exactly one of --on or --off');
  if (!out.on && !out.off && !out.help) throw new Error('required: --on or --off');
  return out;
}

function printHelp() {
  console.log(`
set-open-demo-playground-mode.js

  --on                     Enable live playground (replies + booking writes)
  --off                    Restore safe baseline
  --phone <e164>           Guest test phone (default: ${DEFAULT_PHONE})
  --duration-minutes <n>   Reminder window (default: ${DEFAULT_DURATION_MINUTES})
  --restore-owner          With --off only: set staff_phone_access.is_active=true
  --dry-run                Print actions without Azure/DB writes
  --json                   JSON output
`);
}

async function main() {
  const flags = parseModeArgs(process.argv.slice(2));
  if (flags.help) {
    printHelp();
    process.exit(0);
  }
  if (flags.unknown && flags.unknown.length) {
    throw new Error(`unknown args: ${flags.unknown.join(', ')}`);
  }

  const dbUrl = flags.dbUrl || defaultConnectionString();
  assertNotProductionDb(dbUrl);

  const expiresAt = new Date(Date.now() + flags.durationMinutes * 60 * 1000).toISOString();
  const result = {
    tool: 'set-open-demo-playground-mode',
    mode: flags.on ? 'on' : 'off',
    phone: flags.phone,
    duration_minutes: flags.durationMinutes,
    suggested_off_by: expiresAt,
    dry_run: flags.dryRun,
    azure: { app: 'wh-staging-staff-api', resource_group: 'wh-staging-rg' },
    warnings: [
      'Real WhatsApp messages are sent to guests while playground is ON.',
      'Stripe payment links and confirmation sends remain OFF.',
    ],
  };

  const pg = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('azure') ? { rejectUnauthorized: false } : undefined });
  await pg.connect();

  try {
    if (flags.on) {
      result.env_apply = PLAYGROUND_ON_ENV;
      if (!flags.dryRun) {
        setStaffApiEnvVars(PLAYGROUND_ON_ENV);
        removeStaffApiEnvVars(['LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST']);
      }
      result.owner_phone = await setGuestPhoneInactive(pg, flags.phone);
      result.gates_after = flags.dryRun ? null : fetchStaffApiGates();
    } else {
      result.env_apply = PLAYGROUND_OFF_ENV;
      if (!flags.dryRun) {
        setStaffApiEnvVars(PLAYGROUND_OFF_ENV);
        removeStaffApiEnvVars(['LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST']);
      }
      if (flags.restoreOwner) {
        result.owner_phone = await restoreGuestPhoneOwner(pg, flags.phone);
      } else {
        const { raw, e164 } = parsePhoneVariants(flags.phone);
        const row = await pg.query(
          `SELECT role, is_active::text FROM staff_phone_access
            WHERE client_slug='wolfhouse-somo' AND (phone_normalized=$1 OR phone_e164=$2)`,
          [raw, e164],
        );
        result.owner_phone = { kept_inactive: true, current: row.rows[0] || null };
      }
      result.gates_after = flags.dryRun ? null : fetchStaffApiGates();
    }

    if (!flags.dryRun) {
      try {
        result.healthz = Number(azExec('curl.exe -s -o NUL -w "%{http_code}" https://staff-staging.lunafrontdesk.com/healthz'));
      } catch {
        result.healthz = null;
      }
    }

    result.success = true;
    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\nPlayground mode: ${result.mode.toUpperCase()}${flags.dryRun ? ' (dry-run)' : ''}`);
      console.log(`Phone ${flags.phone} guest routing: ${flags.on || !flags.restoreOwner ? 'inactive owner row' : 'owner restored'}`);
      if (flags.on) console.log(`Suggested OFF by: ${expiresAt} (${flags.durationMinutes}m)`);
      console.log('Env:', JSON.stringify(result.env_apply, null, 2));
      if (result.gates_after && result.gates_after.status === 'checked') {
        console.log('Gates:', JSON.stringify(result.gates_after.gates, null, 2));
      }
      console.log('\nWARNING: Real WhatsApp replies while ON. Run --off when finished.\n');
    }
  } finally {
    await pg.end();
  }
}

main().catch((err) => {
  console.error(`set-open-demo-playground-mode failed: ${err.message}`);
  process.exit(1);
});
