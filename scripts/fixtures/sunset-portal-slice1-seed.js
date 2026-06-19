'use strict';

/**
 * Sunset Portal Slice 1 — staging demo seed (dry-run by default).
 *
 *   node scripts/fixtures/sunset-portal-slice1-seed.js
 *   ALLOW_SUNSET_DEMO_SEED=1 node scripts/fixtures/sunset-portal-slice1-seed.js --execute
 *
 * Writes require ALLOW_SUNSET_DEMO_SEED=1, --execute, and a localhost/test DB URL only.
 */

const {
  DEMO_TAG,
  parseCliArgs,
  getDatabaseUrl,
  assertExecuteGates,
  loadManifest,
  validateManifest,
  normalizePhone,
  demoMetadata,
  mapServiceRecords,
  buildSeedPlan,
  printSeedPlan,
} = require('./sunset-portal-slice1-guards');

const BOOKING_CODE_PREFIX = 'SUNSET-DEMO';

function paymentStatusFromManifest(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'paid') return 'paid';
  if (s === 'unpaid' || s === 'pending') return 'pending';
  return 'not_requested';
}

function bookingStatusFromManifest(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'demo_pending' || s === 'payment_pending') return 'payment_pending';
  return 'confirmed';
}

function buildBookingCode(index) {
  return `${BOOKING_CODE_PREFIX}-${String(index + 1).padStart(3, '0')}`;
}

function lastInboundPreview(turns) {
  const inbound = [...(turns || [])].reverse().find((t) => t.role === 'guest');
  return inbound ? String(inbound.message).slice(0, 240) : null;
}

function planMessageRows(manifest) {
  const rows = [];
  for (const conv of manifest.conversations) {
    conv.turns.forEach((turn, idx) => {
      rows.push({
        conversation_id: conv.conversation_id,
        manifest_turn_id: `${conv.conversation_id}-t${turn.turn}-${turn.role}-${idx}`,
        direction: turn.role === 'guest' ? 'inbound' : 'outbound',
        body: turn.message,
      });
    });
  }
  return rows;
}

async function executeSeed(manifest, plan, opts) {
  const { withPgClient } = require('../lib/pg-connect');
  const summary = {
    inserted: {},
    skipped: {},
    refreshed: {},
  };

  const bump = (bucket, table, n = 1) => {
    summary[bucket][table] = (summary[bucket][table] || 0) + n;
  };

  await withPgClient(async (pg) => {
    const clientRes = await pg.query('SELECT id FROM clients WHERE slug = $1 LIMIT 1', ['sunset']);
    if (clientRes.rows.length === 0) {
      throw new Error('clients.slug=sunset not found — create tenant client before seeding');
    }
    const clientId = clientRes.rows[0].id;

    const bookingIdByCode = new Map();

    for (let i = 0; i < manifest.booking_service_records.length; i += 1) {
      const rec = manifest.booking_service_records[i];
      const bookingCode = buildBookingCode(i);
      const existingBooking = await pg.query(
        `SELECT b.id::text AS id FROM bookings b
         INNER JOIN clients c ON c.id = b.client_id
         WHERE c.slug = 'sunset' AND b.booking_code = $1
         LIMIT 1`,
        [bookingCode],
      );

      let bookingId;
      if (existingBooking.rows.length > 0) {
        bookingId = existingBooking.rows[0].id;
        bump('skipped', 'bookings');
        if (opts.forceRefresh) {
          await pg.query(
            `UPDATE bookings SET updated_at = NOW(), guest_name = $3
             WHERE id = $1::uuid AND client_id = $2::uuid`,
            [bookingId, clientId, rec.guest_name || null],
          );
          bump('refreshed', 'bookings');
        }
      } else {
        const ins = await pg.query(
          `INSERT INTO bookings (
             client_id, booking_code, guest_name, phone, status, check_in, check_out, metadata
           ) VALUES (
             $1, $2, $3, $4, $5::booking_status, $6::date, ($6::date + INTERVAL '1 day')::date, $7::jsonb
           )
           RETURNING id::text AS id`,
          [
            clientId,
            bookingCode,
            rec.guest_name || null,
            normalizePhone(rec.guest_phone),
            bookingStatusFromManifest(rec.booking_status),
            rec.date,
            JSON.stringify(demoMetadata({
              manifest_record_id: rec.record_id,
              manifest_service_type: rec.service_type,
            })),
          ],
        );
        bookingId = ins.rows[0].id;
        bump('inserted', 'bookings');
      }
      bookingIdByCode.set(rec.record_id, bookingId);

      const mapped = mapServiceRecords(rec);
      for (const svc of mapped) {
        const existingSvc = await pg.query(
          `SELECT id::text AS id FROM booking_service_records
           WHERE client_slug = 'sunset'
             AND metadata->>'source' = $1
             AND metadata->>'manifest_record_id' = $2
             AND metadata->>'db_service_type' = $3
             AND COALESCE(metadata->>'bundle_part', '') = COALESCE($4::text, '')
           LIMIT 1`,
          [DEMO_TAG, rec.record_id, svc.db_service_type, svc.metadata.bundle_part || null],
        );

        if (existingSvc.rows.length > 0) {
          bump('skipped', 'booking_service_records');
          if (opts.forceRefresh) {
            await pg.query(
              `UPDATE booking_service_records
                  SET updated_at = NOW(), service_date = $2::date, guest_name = $3
                WHERE id = $1::uuid`,
              [existingSvc.rows[0].id, rec.date, rec.guest_name || null],
            );
            bump('refreshed', 'booking_service_records');
          }
          continue;
        }

        await pg.query(
          `INSERT INTO booking_service_records (
             client_slug, booking_id, booking_code, guest_name, service_type, service_date,
             quantity, status, amount_due_cents, amount_paid_cents, payment_status, source, metadata
           ) VALUES (
             'sunset', $1::uuid, $2, $3, $4, $5::date,
             $6, 'confirmed', $7, 0, $8, 'staff_manual', $9::jsonb
           )`,
          [
            bookingId,
            bookingCode,
            rec.guest_name || null,
            svc.db_service_type,
            rec.date,
            svc.quantity,
            Math.max(0, Math.round(Number(rec.amount_eur || rec.amount_eur_total || 0) * 100)),
            paymentStatusFromManifest(rec.payment_status),
            JSON.stringify({
              ...svc.metadata,
              db_service_type: svc.db_service_type,
            }),
          ],
        );
        bump('inserted', 'booking_service_records');
      }
    }

    for (const conv of manifest.conversations) {
      const phone = normalizePhone(conv.guest_phone);
      const metadata = demoMetadata({
        manifest_id: conv.conversation_id,
        channel: conv.channel || 'whatsapp',
        demo_status: conv.status || null,
      });

      const existingConv = await pg.query(
        `SELECT id::text AS id FROM conversations
         WHERE client_id = $1::uuid AND phone = $2
         LIMIT 1`,
        [clientId, phone],
      );

      let conversationId;
      if (existingConv.rows.length > 0) {
        conversationId = existingConv.rows[0].id;
        bump('skipped', 'conversations');
        if (opts.forceRefresh) {
          await pg.query(
            `UPDATE conversations
                SET updated_at = NOW(),
                    last_message_preview = $2,
                    metadata = metadata || $3::jsonb
              WHERE id = $1::uuid`,
            [conversationId, lastInboundPreview(conv.turns), JSON.stringify(metadata)],
          );
          bump('refreshed', 'conversations');
        }
      } else {
        const ins = await pg.query(
          `INSERT INTO conversations (
             client_id, phone, display_name, status, bot_mode, conversation_stage,
             last_message_preview, metadata, session_state
           ) VALUES (
             $1::uuid, $2, $3, 'open'::conversation_status, 'bot'::bot_mode, 'sunset_demo_slice1',
             $4, $5::jsonb, $6::jsonb
           )
           RETURNING id::text AS id`,
          [
            clientId,
            phone,
            conv.guest_name || null,
            lastInboundPreview(conv.turns),
            JSON.stringify(metadata),
            JSON.stringify({ source: DEMO_TAG, channel: conv.channel || 'whatsapp' }),
          ],
        );
        conversationId = ins.rows[0].id;
        bump('inserted', 'conversations');
      }

      for (let idx = 0; idx < conv.turns.length; idx += 1) {
        const turn = conv.turns[idx];
        const manifestTurnId = `${conv.conversation_id}-t${turn.turn}-${turn.role}-${idx}`;
        const existingMsg = await pg.query(
          `SELECT id::text AS id FROM messages
           WHERE conversation_id = $1::uuid
             AND metadata->>'source' = $2
             AND metadata->>'manifest_turn_id' = $3
           LIMIT 1`,
          [conversationId, DEMO_TAG, manifestTurnId],
        );

        if (existingMsg.rows.length > 0) {
          bump('skipped', 'messages');
          continue;
        }

        await pg.query(
          `INSERT INTO messages (
             client_id, conversation_id, direction, message_text, metadata, source
           ) VALUES (
             $1::uuid, $2::uuid, $3::message_direction, $4, $5::jsonb, 'demo_seed'
           )`,
          [
            clientId,
            conversationId,
            turn.role === 'guest' ? 'inbound' : 'outbound',
            turn.message,
            JSON.stringify(demoMetadata({
              manifest_id: conv.conversation_id,
              manifest_turn_id: manifestTurnId,
              turn: turn.turn,
              role: turn.role,
            })),
          ],
        );
        bump('inserted', 'messages');
      }

      if (conv.demo_state && conv.demo_state.handoff_needed) {
        const existingHandoff = await pg.query(
          `SELECT id::text AS id FROM staff_handoffs
           WHERE conversation_id = $1::uuid
             AND metadata->>'source' = $2
           LIMIT 1`,
          [conversationId, DEMO_TAG],
        );
        if (existingHandoff.rows.length > 0) {
          bump('skipped', 'staff_handoffs');
        } else {
          await pg.query(
            `INSERT INTO staff_handoffs (
               client_id, conversation_id, phone, reason_code, summary, metadata, priority, status
             ) VALUES (
               $1::uuid, $2::uuid, $3, 'sunset_demo_kids_lesson', $4, $5::jsonb, 'normal', 'open'
             )`,
            [
              clientId,
              conversationId,
              phone,
              'Kids lesson age check — demo handoff for Sunset portal Slice 1',
              JSON.stringify(demoMetadata({
                manifest_id: conv.conversation_id,
                handoff_type: 'kids_lesson_age_check',
              })),
            ],
          );
          bump('inserted', 'staff_handoffs');
        }
      }
    }
  });

  console.log('\nEXECUTE summary:');
  console.log(`  inserted:  ${JSON.stringify(summary.inserted)}`);
  console.log(`  skipped:   ${JSON.stringify(summary.skipped)}`);
  console.log(`  refreshed: ${JSON.stringify(summary.refreshed)}`);
  return summary;
}

async function main() {
  const opts = parseCliArgs();
  if (opts.help) {
    console.log('Usage: node scripts/fixtures/sunset-portal-slice1-seed.js [--execute] [--force-refresh]');
    process.exit(0);
  }

  const manifest = validateManifest(loadManifest());
  const plan = buildSeedPlan(manifest);
  const gate = assertExecuteGates(opts, getDatabaseUrl());
  const mode = gate.mode === 'execute' ? 'EXECUTE (localhost/test DB only)' : 'DRY-RUN';

  printSeedPlan(plan, mode);

  if (!opts.execute) {
    console.log('\nNo writes performed (dry-run). Pass --execute with ALLOW_SUNSET_DEMO_SEED=1 to write.');
    process.exit(0);
  }

  await executeSeed(manifest, plan, opts);
  console.log('\nsunset-portal-slice1-seed — execute complete');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`\nFAIL — ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  main,
  buildBookingCode,
  planMessageRows,
  executeSeed,
};
