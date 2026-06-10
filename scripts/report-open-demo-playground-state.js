#!/usr/bin/env node
'use strict';

/**
 * Stage 28f — Read-only open-demo staging playground state report.
 *
 * Usage:
 *   node scripts/report-open-demo-playground-state.js [--phone +491726422307] [--limit 20] [--json]
 *   npm run report:open-demo-playground
 */

const { Client } = require('pg');
const {
  CLIENT_SLUG,
  DEFAULT_BASE_URL,
  assertNotProductionDb,
  defaultConnectionString,
  fetchMetaCallback,
  fetchN8nWorkflowStatus,
  fetchStaffApiGates,
  parseBaseArgs,
  parsePhoneVariants,
  redactUrl,
  trimStr,
} = require('./lib/open-demo-playground-common');

function printHelp() {
  console.log(`
report-open-demo-playground-state.js — read-only staging playground report

Flags:
  --phone <e164>     Guest phone (default: +491726422307)
  --limit <n>        Row limit (default: 20)
  --json             JSON output
  --base-url <url>   Staff API base URL (default: ${DEFAULT_BASE_URL})
  --db-url <url>     Postgres URL (default: WOLFHOUSE_DATABASE_URL / local)
`);
}

async function loadOwnerStatus(pg, phone) {
  const { raw, e164 } = parsePhoneVariants(phone);
  const res = await pg.query(
    `SELECT role, is_active::text AS is_active, phone_e164, phone_normalized, updated_at::text
       FROM staff_phone_access
      WHERE client_slug = $1
        AND (phone_normalized = $2 OR phone_e164 = $3 OR phone_e164 = $4)
      ORDER BY updated_at DESC
      LIMIT 5`,
    [CLIENT_SLUG, raw, e164, phone],
  );
  return res.rows;
}

async function loadConversations(pg, phone, limit) {
  const { raw, e164 } = parsePhoneVariants(phone);
  const res = await pg.query(
    `SELECT conv.id::text, conv.phone, conv.status::text, conv.updated_at::text,
            conv.metadata->'guest_context'->>'booking_code' AS ctx_booking_code,
            conv.metadata->'guest_context'->>'payment_choice_ready' AS payment_choice_ready
       FROM conversations conv
       JOIN clients cl ON cl.id = conv.client_id
      WHERE cl.slug = $1
        AND (conv.phone IN ($2, $3, $4) OR REPLACE(COALESCE(conv.phone, ''), '+', '') = $5)
      ORDER BY conv.updated_at DESC
      LIMIT $6`,
    [CLIENT_SLUG, e164, raw, phone, raw, limit],
  );
  return res.rows;
}

async function loadBookings(pg, phone, limit) {
  const { raw, e164 } = parsePhoneVariants(phone);
  const res = await pg.query(
    `SELECT b.id::text AS booking_id, b.booking_code, b.status::text, b.payment_status::text,
            b.check_in::text, b.check_out::text, b.phone, b.email, b.guest_name,
            b.confirmation_sent_at::text, b.created_at::text, b.updated_at::text
       FROM bookings b
       JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1
        AND (
          b.phone IN ($2, $3, $4)
          OR REPLACE(COALESCE(b.phone, ''), '+', '') = $5
          OR b.email LIKE 'open-demo+%@example.test'
          OR b.booking_code LIKE 'WH-G27-%'
        )
      ORDER BY b.created_at DESC
      LIMIT $6`,
    [CLIENT_SLUG, e164, raw, phone, raw, limit],
  );
  return res.rows;
}

async function loadBookingDetails(pg, bookingIds) {
  if (!bookingIds.length) return { beds: [], payments: [] };
  const beds = await pg.query(
    `SELECT bb.booking_id::text, bb.bed_code, bb.room_code
       FROM booking_beds bb
      WHERE bb.booking_id = ANY($1::uuid[])
      ORDER BY bb.booking_id, bb.bed_code`,
    [bookingIds],
  );
  const payments = await pg.query(
    `SELECT p.id::text AS payment_id, p.booking_id::text, p.status::text, p.payment_kind::text,
            p.amount_due_cents, p.amount_paid_cents, p.stripe_checkout_session_id,
            p.checkout_url, p.created_at::text, p.updated_at::text
       FROM payments p
      WHERE p.booking_id = ANY($1::uuid[])
      ORDER BY p.booking_id, p.created_at`,
    [bookingIds],
  );
  return { beds: beds.rows, payments: payments.rows };
}

async function loadDemoCalendarBlocks(pg, limit) {
  const res = await pg.query(
    `SELECT b.booking_code, b.status::text AS booking_status, b.payment_status::text,
            b.check_in::text, b.check_out::text, bb.bed_code, bb.room_code
       FROM booking_beds bb
       JOIN bookings b ON b.id = bb.booking_id
       JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1
        AND bb.room_code LIKE 'DEMO-R%'
        AND LOWER(b.status::text) NOT IN ('cancelled', 'canceled', 'expired')
        AND b.check_out >= CURRENT_DATE
      ORDER BY b.check_in, bb.bed_code
      LIMIT $2`,
    [CLIENT_SLUG, limit],
  );
  return res.rows;
}

function groupByBookingId(rows) {
  const map = new Map();
  for (const row of rows) {
    const id = row.booking_id;
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(row);
  }
  return map;
}

function enrichBookings(bookings, beds, payments) {
  const bedsBy = groupByBookingId(beds);
  const paysBy = groupByBookingId(payments);
  return bookings.map((b) => ({
    ...b,
    assigned_beds: bedsBy.get(b.booking_id) || [],
    payments: paysBy.get(b.booking_id) || [],
  }));
}

function printHuman(report) {
  console.log('\n── Open Demo Playground State (read-only) ──');
  console.log(`Staff API: ${report.staff_api.base_url}`);
  console.log(`Database:  ${report.database.target}`);

  console.log('\nGates:');
  if (report.gates.status === 'checked') {
    for (const [k, v] of Object.entries(report.gates.values || {})) {
      console.log(`  ${k} = ${v}`);
    }
  } else {
    console.log(`  not checked (${report.gates.reason || 'unknown'})`);
  }

  console.log('\nMeta callback:');
  if (report.meta_callback.status === 'checked') {
    console.log(`  display_phone_number: ${report.meta_callback.display_phone_number}`);
    console.log(`  webhook_callback_url: ${report.meta_callback.webhook_callback_url}`);
  } else {
    console.log(`  not checked (${report.meta_callback.reason || 'unknown'})`);
  }

  console.log('\nn8n:');
  if (report.n8n.status === 'checked') {
    console.log(`  workflow_id: ${report.n8n.workflow_id}`);
    console.log(`  workflow_active: ${report.n8n.workflow_active}`);
    console.log(`  webhook_entity_rows: ${report.n8n.webhook_entity_rows}`);
  } else {
    console.log(`  not checked (${report.n8n.reason || 'unknown'})`);
  }

  console.log(`\nOwner status (${report.phone}):`);
  if (!report.owner_status.length) console.log('  (no staff_phone_access row)');
  for (const row of report.owner_status) {
    console.log(`  role=${row.role} is_active=${row.is_active} phone=${row.phone_e164 || row.phone_normalized}`);
  }

  console.log(`\nRecent conversations (${report.conversations.length}):`);
  for (const c of report.conversations) {
    console.log(`  ${c.updated_at} id=${c.id} booking=${c.ctx_booking_code || '-'} payment_choice_ready=${c.payment_choice_ready || '-'}`);
  }

  console.log(`\nRecent open-demo bookings (${report.bookings.length}):`);
  for (const b of report.bookings) {
    const beds = (b.assigned_beds || []).map((x) => x.bed_code).join(', ') || '-';
    const pays = (b.payments || []).map((p) => `${p.status}/${p.payment_kind}`).join(', ') || '-';
    console.log(`  ${b.booking_code} status=${b.status} payment_status=${b.payment_status} ${b.check_in}→${b.check_out}`);
    console.log(`    phone=${b.phone} email=${b.email} beds=${beds} payments=${pays} confirmation_sent_at=${b.confirmation_sent_at || 'null'}`);
  }

  console.log(`\nDemo calendar blocks DEMO-R* (${report.demo_calendar_blocks.length}):`);
  for (const row of report.demo_calendar_blocks) {
    console.log(`  ${row.booking_code} ${row.check_in}→${row.check_out} ${row.room_code}/${row.bed_code} (${row.booking_status}/${row.payment_status})`);
  }
  console.log('');
}

async function main() {
  const flags = parseBaseArgs(process.argv.slice(2));
  if (flags.help) {
    printHelp();
    process.exit(0);
  }
  if (flags.unknown && flags.unknown.length) {
    console.error(`Unknown arguments: ${flags.unknown.join(', ')}`);
    process.exit(1);
  }

  const dbUrl = flags.dbUrl || defaultConnectionString();
  assertNotProductionDb(dbUrl);

  const [gates, metaCallback, n8n] = await Promise.all([
    Promise.resolve(fetchStaffApiGates()),
    fetchMetaCallback(),
    fetchN8nWorkflowStatus(),
  ]);

  const pg = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('azure') ? { rejectUnauthorized: false } : undefined });
  await pg.connect();

  try {
    const bookings = await loadBookings(pg, flags.phone, flags.limit);
    const bookingIds = bookings.map((b) => b.booking_id);
    const { beds, payments } = await loadBookingDetails(pg, bookingIds);

    const report = {
      tool: 'report-open-demo-playground-state',
      read_only: true,
      generated_at: new Date().toISOString(),
      phone: flags.phone,
      staff_api: { base_url: flags.baseUrl },
      database: { target: redactUrl(dbUrl) },
      gates: gates.status === 'checked'
        ? { status: 'checked', values: gates.gates }
        : { status: 'not_checked', reason: gates.reason },
      meta_callback: metaCallback,
      n8n,
      owner_status: await loadOwnerStatus(pg, flags.phone),
      conversations: await loadConversations(pg, flags.phone, flags.limit),
      bookings: enrichBookings(bookings, beds, payments),
      demo_calendar_blocks: await loadDemoCalendarBlocks(pg, flags.limit),
    };

    if (flags.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printHuman(report);
    }
  } finally {
    await pg.end();
  }
}

main().catch((err) => {
  console.error(`report failed: ${err.message}`);
  process.exit(1);
});
