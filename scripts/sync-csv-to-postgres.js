/**
 * One-way import from Airtable CSV exports → local Postgres (client_id schema).
 * Does NOT call hosted Airtable or n8n. Re-run anytime after refreshing CSVs in database/.
 *
 * Usage: npm install && npm run db:sync
 */
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });
const { readCsvFile } = require('./lib/parse-csv');

const DB_DIR = path.join(__dirname, '..', 'database');
const CLIENT_SLUG = 'wolfhouse-somo';

const connectionString =
  process.env.WOLFHOUSE_DATABASE_URL ||
  `postgres://${process.env.WOLFHOUSE_DB_USER || 'wolfhouse'}:${process.env.WOLFHOUSE_DB_PASSWORD}@localhost:${process.env.WOLFHOUSE_DB_PORT || 5433}/${process.env.WOLFHOUSE_DB_NAME || 'wolfhouse'}`;

function bookingCodeToAirtableId(bookingCode) {
  if (!bookingCode) return null;
  const s = String(bookingCode).trim();
  if (!s.startsWith('WH-')) return null;
  return s.slice(3);
}

function parseDate(value) {
  if (!value) return null;
  const v = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const [, d, mo, y] = m;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return null;
}

function parseMoneyToCents(value) {
  if (!value) return null;
  const n = parseFloat(String(value).replace(/[^0-9.-]/g, ''));
  if (Number.isNaN(n)) return null;
  return Math.round(n * 100);
}

/** Deposit required: null when 0/empty so Create Payment Session uses STRIPE_DEFAULT_DEPOSIT_CENTS */
function parseDepositRequiredCents(value) {
  const cents = parseMoneyToCents(value);
  return cents != null && cents > 0 ? cents : null;
}

function mapBookingStatus(s) {
  const k = String(s || '').trim();
  const map = {
    Hold: 'hold',
    Payment_Pending: 'payment_pending',
    Confirmed: 'confirmed',
    Cancelled: 'cancelled',
    Expired: 'expired',
    Needs_Review: 'needs_review',
    Checked_In: 'checked_in',
    Blocked: 'blocked',
  };
  return map[k] || 'hold';
}

function mapPaymentStatus(s) {
  const k = String(s || '').trim().toLowerCase();
  const map = {
    not_requested: 'not_requested',
    waiting_payment: 'waiting_payment',
    payment_pending: 'waiting_payment',
    deposit_paid: 'deposit_paid',
    paid: 'paid',
    refunded: 'refunded',
    failed: 'failed',
  };
  return map[k] || 'not_requested';
}

function mapAssignmentStatus(s) {
  const k = String(s || '').trim();
  const map = {
    Unassigned: 'unassigned',
    Assigning: 'assigning',
    Assigned: 'assigned',
    'Needs Review': 'needs_review',
  };
  return map[k] || 'unassigned';
}

function mapAvailability(s) {
  const k = String(s || '').trim();
  const map = {
    'Not Checked': 'unknown',
    Available: 'available',
    Conflict: 'conflict',
    'Needs Review': 'needs_review',
  };
  return map[k] || 'unknown';
}

function mapBookingSource(s) {
  const k = String(s || '').trim();
  if (k === 'Manual Staff') return 'manual_staff';
  if (k === 'Operator') return 'operator';
  if (k.includes('WhatsApp') || k === 'AI WhatsApp') return 'whatsapp';
  return 'other';
}

function mapPackageCode(name) {
  if (!name) return null;
  return String(name).trim().toLowerCase();
}

function mapBlockType(s) {
  const k = String(s || '').trim().toLowerCase();
  if (k.includes('whole')) return 'whole_room';
  if (k.includes('partial')) return 'partial';
  if (!k) return 'none';
  return 'other';
}

function mapBotMode(s) {
  const k = String(s || '').trim().toLowerCase();
  if (k === 'human_active' || k === 'staff') return 'staff';
  if (k === 'paused') return 'paused';
  return 'bot';
}

async function main() {
  const client = new Client({ connectionString });
  await client.connect();

  const { rows: clientRows } = await client.query(
    `SELECT id FROM clients WHERE slug = $1`,
    [CLIENT_SLUG]
  );
  if (!clientRows.length) {
    throw new Error(`Client ${CLIENT_SLUG} not found. Run docker compose / seed first.`);
  }
  const clientId = clientRows[0].id;

  const { rows: packageRows } = await client.query(
    `SELECT id, code FROM packages WHERE client_id = $1`,
    [clientId]
  );
  const packageByCode = Object.fromEntries(packageRows.map((p) => [p.code, p.id]));

  const { rows: bedRows } = await client.query(
    `SELECT id, bed_code FROM beds WHERE client_id = $1`,
    [clientId]
  );
  const bedByCode = Object.fromEntries(bedRows.map((b) => [b.bed_code, b.id]));

  const stats = {
    guests: 0,
    bookings: 0,
    booking_beds: 0,
    conversations: 0,
    messages: 0,
  };

  await client.query('BEGIN');

  try {
    // --- Guests (from bookings + conversations) ---
    const guestByPhone = new Map();
    async function upsertGuest(phone, name, email, language) {
      if (!phone) return null;
      const p = String(phone).trim();
      if (guestByPhone.has(p)) return guestByPhone.get(p);
      const existing = await client.query(
        `SELECT id FROM guests WHERE client_id = $1 AND phone = $2`,
        [clientId, p]
      );
      let id;
      if (existing.rows.length) {
        id = existing.rows[0].id;
        await client.query(
          `UPDATE guests SET
             full_name = COALESCE($1, full_name),
             email = COALESCE($2, email),
             language = COALESCE($3, language),
             updated_at = NOW()
           WHERE id = $4`,
          [name || null, email || null, language || 'en', id]
        );
      } else {
        const ins = await client.query(
          `INSERT INTO guests (client_id, phone, full_name, email, language)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [clientId, p, name || null, email || null, language || 'en']
        );
        id = ins.rows[0].id;
      }
      guestByPhone.set(p, id);
      return id;
    }

    // --- Bookings ---
    const bookingByCode = new Map();
    const bookingsCsv = readCsvFile(path.join(DB_DIR, 'Bookings-Grid view.csv'));

    for (const row of bookingsCsv) {
      const bookingCode = row['Booking ID'];
      if (!bookingCode) continue;

      const phone = row.Phone || null;
      const guestId = await upsertGuest(phone, row['Guest Name'], row.Email, null);
      const pkg = mapPackageCode(row.Package);
      const packageId = pkg ? packageByCode[pkg] : null;
      const guestCount = Math.max(1, parseInt(row['Guest Count'], 10) || 1);

      const res = await client.query(
        `INSERT INTO bookings (
          client_id, guest_id, package_id, airtable_record_id, booking_code,
          guest_name, phone, email, status, payment_status, assignment_status,
          availability_check_status, check_in, check_out, guest_count, package_code,
          hold_expires_at, send_confirmation, guest_gender_group_type,
          requested_room_type, room_preference, rooming_notes, rooming_confidence,
          needs_rooming_review, booking_source, staff_notes, conflict_notes,
          operator_name, block_type, payment_option, payment_notes,
          deposit_required_cents, deposit_paid_cents, balance_due_cents, total_amount_cents, amount_paid_cents,
          primary_room_code, metadata
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38
        )
        ON CONFLICT (client_id, booking_code) DO UPDATE SET
          guest_id = EXCLUDED.guest_id,
          package_id = EXCLUDED.package_id,
          airtable_record_id = EXCLUDED.airtable_record_id,
          guest_name = EXCLUDED.guest_name,
          phone = EXCLUDED.phone,
          email = EXCLUDED.email,
          status = EXCLUDED.status,
          payment_status = EXCLUDED.payment_status,
          assignment_status = EXCLUDED.assignment_status,
          availability_check_status = EXCLUDED.availability_check_status,
          check_in = EXCLUDED.check_in,
          check_out = EXCLUDED.check_out,
          guest_count = EXCLUDED.guest_count,
          package_code = EXCLUDED.package_code,
          send_confirmation = EXCLUDED.send_confirmation,
          updated_at = NOW()
        RETURNING id`,
        [
          clientId,
          guestId,
          packageId,
          bookingCodeToAirtableId(bookingCode),
          bookingCode,
          row['Guest Name'] || null,
          phone,
          row.Email || null,
          mapBookingStatus(row.Status),
          mapPaymentStatus(row['Payment Status']),
          mapAssignmentStatus(row['Assignment Status']),
          mapAvailability(row['Availability Check Status']),
          parseDate(row['Check In']),
          parseDate(row['Check Out']),
          guestCount,
          pkg,
          null,
          String(row['Send Confirmation'] || '').toLowerCase() === 'checked',
          row['Guest Gender / Group Type'] || null,
          row['Requested Room Type'] || null,
          row['Room Preference'] || null,
          row['Rooming Notes'] || null,
          parseFloat(row['Rooming Confidence']) || null,
          String(row['Needs Rooming Review'] || '').toLowerCase() === 'checked',
          mapBookingSource(row['Booking Source']),
          row['Staff Notes'] || null,
          row['Conflict Notes'] || null,
          row['Operator Name'] || null,
          mapBlockType(row['Block Type']),
          row['Payment Option'] || null,
          row['Payment Notes'] || null,
          parseDepositRequiredCents(row['Deposit Required']),
          parseMoneyToCents(row['Deposit Paid']),
          parseMoneyToCents(row['Balance Due']),
          parseMoneyToCents(row['Total Amount']),
          parseMoneyToCents(row['Amount Paid']),
          row['Room ID'] || null,
          JSON.stringify({ payment_link: row['Payment Link'] || null, csv_import: true }),
        ]
      );

      bookingByCode.set(bookingCode, res.rows[0].id);
      stats.bookings += 1;
    }

    const { rows: guestCountRows } = await client.query(
      `SELECT COUNT(*)::int AS c FROM guests WHERE client_id = $1`,
      [clientId]
    );
    stats.guests = guestCountRows[0].c;

    // Replace bed assignments on each sync (Phase 1 idempotent refresh)
    await client.query(`DELETE FROM booking_beds WHERE client_id = $1`, [clientId]);

    // --- Booking beds ---
    const bedsCsv = readCsvFile(path.join(DB_DIR, 'Booking Beds-Active Bed Assignments.csv'));
    for (const row of bedsCsv) {
      const bookingCode = row['Booking ID'];
      const bookingId = bookingByCode.get(bookingCode);
      const bedId = bedByCode[row.Bed];
      if (!bookingId || !bedId) continue;
      const label = row['Assignment ID'] || `${row.Bed}-${bookingCode}`;
      await client.query(
        `INSERT INTO booking_beds (
          client_id, booking_id, bed_id, assignment_label, assignment_type, assignment_notes,
          assignment_start_date, assignment_end_date, planning_row_label,
          guest_name, room_code, bed_code
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          clientId,
          bookingId,
          bedId,
          label,
          row['Assignment Type'] || null,
          row['Assignment Notes'] || null,
          parseDate(row['Assignment Start Date']) || parseDate(row['Check In']),
          parseDate(row['Assignment End Date']) || parseDate(row['Check Out']),
          row['Planning Row Label'] || null,
          row['Guest Name'] || null,
          row['Room ID'] || row.Room || null,
          row.Bed,
        ]
      );
      stats.booking_beds += 1;
    }

    // --- Conversations ---
    const convByPhone = new Map();
    const convCsv = readCsvFile(path.join(DB_DIR, 'Conversations-Grid view.csv'));
    for (const row of convCsv) {
      const phone = row.Phone;
      if (!phone) continue;
      const guestId = await upsertGuest(phone, row['Guest Name'], row.Email, row.Language);

      let sessionState = {};
      try {
        if (row['Session State']) sessionState = JSON.parse(row['Session State']);
      } catch {
        sessionState = {};
      }

      let currentHoldId = null;
      const holdCode = row['Current Hold ID'];
      if (holdCode && bookingByCode.has(holdCode)) {
        currentHoldId = bookingByCode.get(holdCode);
      }

      const res = await client.query(
        `INSERT INTO conversations (
          client_id, guest_id, display_name, phone, email, language,
          session_state, conversation_summary, last_message_preview, last_bot_reply,
          needs_human, status, conversation_stage, bot_mode, current_hold_booking_id,
          pending_action, staff_reply_draft, human_notes, internal_staff_notes
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
        )
        ON CONFLICT (client_id, phone) DO UPDATE SET
          guest_id = EXCLUDED.guest_id,
          display_name = EXCLUDED.display_name,
          session_state = EXCLUDED.session_state,
          conversation_summary = EXCLUDED.conversation_summary,
          last_message_preview = EXCLUDED.last_message_preview,
          last_bot_reply = EXCLUDED.last_bot_reply,
          needs_human = EXCLUDED.needs_human,
          conversation_stage = EXCLUDED.conversation_stage,
          bot_mode = EXCLUDED.bot_mode,
          current_hold_booking_id = EXCLUDED.current_hold_booking_id,
          updated_at = NOW()
        RETURNING id`,
        [
          clientId,
          guestId,
          row.Name || null,
          phone,
          row.Email || null,
          row.Language || 'en',
          JSON.stringify(sessionState),
          row['Conversation Summary'] || null,
          row['Last Message'] || null,
          row['Last Bot Reply'] || null,
          String(row['Needs Human'] || '').toLowerCase() === 'checked',
          'open',
          row['Conversation Stage'] || null,
          mapBotMode(row['Bot Mode']),
          currentHoldId,
          row['Pending Action'] || null,
          row['Staff Reply Draft'] || null,
          row['Human Notes'] || null,
          row['Internal Staff Notes'] || null,
        ]
      );
      convByPhone.set(phone, res.rows[0].id);
      stats.conversations += 1;
    }

    await client.query(`DELETE FROM messages WHERE client_id = $1`, [clientId]);

    // --- Messages ---
    const msgCsv = readCsvFile(path.join(DB_DIR, 'Messages-Grid view.csv'));
    for (const row of msgCsv) {
      const phone = row['Conversation Phone'];
      const conversationId = convByPhone.get(phone);
      if (!conversationId) continue;

      const direction =
        String(row.Direction || '').toLowerCase() === 'inbound' ? 'inbound' : 'outbound';

      const waId = row['WhatsApp Message ID'] || null;
      if (waId) {
        const dup = await client.query(
          `SELECT 1 FROM messages WHERE client_id = $1 AND whatsapp_message_id = $2`,
          [clientId, waId]
        );
        if (dup.rows.length) continue;
      }

      await client.query(
        `INSERT INTO messages (
          client_id, conversation_id, direction, message_text, message_type, language,
          route, whatsapp_message_id, source, conversation_stage, chat_line, chat_display
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          clientId,
          conversationId,
          direction,
          row['Message Text'] || '',
          row['Message Type'] || null,
          row.Language || null,
          row.Route || null,
          row['WhatsApp Message ID'] || null,
          row.Source || 'whatsapp',
          row['Conversation Stage'] || null,
          row['Chat Line'] || null,
          row['Chat Display'] || null,
        ]
      );
      stats.messages += 1;
    }

    await client.query(
      `INSERT INTO workflow_events (client_id, workflow_name, event_level, message, payload)
       VALUES ($1, 'phase1-csv-sync', 'info', 'CSV import completed', $2)`,
      [clientId, JSON.stringify({ stats, at: new Date().toISOString() })]
    );

    await client.query('COMMIT');
    console.log('CSV sync complete:', stats);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
