'use strict';
const { Client } = require('pg');
const { execSync } = require('child_process');

const LIVE_PHONE = '+34600995581';
const CLIENT = 'wolfhouse-somo';
const PROOF_START = new Date(Date.now() - 8 * 60 * 1000).toISOString();

const HANDOFF_RE = /looping in our Wolfhouse team|passing this to our team|hand off|handoff|staff will follow up|follow up soon/i;
const STALL_RE = /I can look into it|not confirming availability yet/i;
const WELCOME_RE = /i can help you book a stay|checking some info/i;

(async () => {
  const whUrl = execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
  if (!/staging|wolfhouse_staging/i.test(whUrl)) throw new Error('not staging');
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const phoneRaw = LIVE_PHONE.replace(/^\+/, '');

  const msgs = (await pg.query(`
    SELECT m.direction::text, m.message_text AS body, m.created_at::text
      FROM messages m
     INNER JOIN conversations c ON c.id = m.conversation_id
     INNER JOIN clients cl ON cl.id = c.client_id
     WHERE cl.slug = $3 AND (c.phone = $1 OR c.phone = $2)
       AND m.created_at >= $4::timestamptz
     ORDER BY m.created_at ASC`, [LIVE_PHONE, phoneRaw, CLIENT, PROOF_START])).rows;

  const sends = (await pg.query(`
    SELECT idempotency_key, status, to_phone, send_kind, LEFT(message_text, 800) AS message_text, created_at::text
      FROM guest_message_sends
     WHERE created_at >= $1::timestamptz AND (to_phone = $2 OR to_phone = $3)
     ORDER BY created_at ASC`, [PROOF_START, LIVE_PHONE, phoneRaw])).rows;

  const bookings = (await pg.query(
    'SELECT id, status, check_in::text, check_out::text, guest_count, created_at::text FROM bookings WHERE created_at >= $1::timestamptz ORDER BY created_at DESC LIMIT 5',
    [PROOF_START])).rows;

  const payments = (await pg.query(
    'SELECT id, status, stripe_checkout_session_id, created_at::text FROM payments WHERE created_at >= $1::timestamptz ORDER BY created_at DESC LIMIT 5',
    [PROOF_START])).rows;

  const confirmSends = (await pg.query(
    `SELECT COUNT(*)::int AS n FROM guest_message_sends
      WHERE created_at >= $1::timestamptz AND (to_phone = $2 OR to_phone = $3) AND send_kind ILIKE '%confirm%'`,
    [PROOF_START, LIVE_PHONE, phoneRaw])).rows[0].n;

  await pg.end();

  const outbound = msgs.filter((m) => m.direction === 'outbound' || m.direction === 'outgoing');
  const inbound = msgs.filter((m) => m.direction === 'inbound' || m.direction === 'incoming');
  const pkgReply = outbound.find((m) => /malibu/i.test(m.body) && /uluwatu/i.test(m.body)) || { body: '' };
  const quoteReply = outbound[5] || outbound[outbound.length - 1] || { body: '' };
  const depositReply = outbound[6] || { body: '' };
  const midOut = outbound.slice(1, 4);

  const checks = {
    inbound_count_7: inbound.length === 7,
    outbound_count_7: outbound.length === 7,
    sends_recorded: sends.length >= outbound.length,
    package_reply_has_line_breaks_db: /\n/.test(pkgReply.body),
    package_reply_has_three_packages: /malibu/i.test(pkgReply.body) && /uluwatu/i.test(pkgReply.body) && /waimea/i.test(pkgReply.body),
    whatsapp_send_preserves_line_breaks: sends.some((s) => /\n/.test(String(s.message_text || ''))),
    quote_reply_has_payment_choice: /deposit|full payment|pay in full/i.test(quoteReply.body),
    quote_reply_has_total: /€|total|1080/i.test(quoteReply.body),
    quote_reply_no_stall: !STALL_RE.test(quoteReply.body),
    quote_reply_no_handoff: !HANDOFF_RE.test(quoteReply.body),
    mid_no_welcome_repeat: !midOut.some((m) => WELCOME_RE.test(m.body)),
    no_confirmation_sends: confirmSends === 0,
    deposit_booking_or_hold: bookings.length >= 1 || payments.length >= 1,
    stripe_test_only: payments.every((p) => !p.stripe_checkout_session_id || /test/i.test(p.stripe_checkout_session_id) || /cs_test/i.test(p.stripe_checkout_session_id)),
    deposit_reply_has_stripe_or_hold: /stripe|deposit|hold|link|reserve/i.test(depositReply.body) || payments.length >= 1,
  };

  console.log(JSON.stringify({
    proof_start: PROOF_START,
    transcript: msgs,
    live_sends: sends,
    bookings,
    payments,
    checks,
    result: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL',
  }, null, 2));
})().catch((e) => { console.error(e.message || e); process.exit(1); });
