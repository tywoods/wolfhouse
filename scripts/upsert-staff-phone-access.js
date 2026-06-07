#!/usr/bin/env node
'use strict';
/**
 * Phase 25b — Generic CLI upsert for staff_phone_access (any client).
 *
 * Example:
 *   node scripts/upsert-staff-phone-access.js --client wolfhouse-somo --phone +491726422307 --name Ty --role owner
 *   node scripts/upsert-staff-phone-access.js --client sunset-surf-shop --phone +34600111222 --name "Owner Name" --role owner
 */

const { withPgClient } = require('./lib/pg-connect');
const { upsertStaffPhoneAccess } = require('./lib/staff-phone-access');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const val = argv[i + 1];
    if (val == null || val.startsWith('--')) {
      out[key] = true;
      continue;
    }
    out[key] = val;
    i += 1;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const clientSlug = args.client || args.client_slug;
  const phone = args.phone;
  const displayName = args.name || args.display_name;
  const role = args.role;
  const channel = args.channel || 'whatsapp';
  const isActive = args.inactive ? false : true;
  const notes = args.notes || null;

  if (!clientSlug || !phone || !role) {
    console.error('Usage: node scripts/upsert-staff-phone-access.js --client <slug> --phone <e164> --name "Display" --role owner|operator');
    process.exit(1);
  }

  const row = await withPgClient((pg) => upsertStaffPhoneAccess(pg, {
    client_slug: clientSlug,
    phone,
    display_name: displayName,
    role,
    channel,
    is_active: isActive,
    notes,
  }));

  console.log(JSON.stringify({ success: true, row }, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
