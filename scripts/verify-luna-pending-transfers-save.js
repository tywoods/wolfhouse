'use strict';

/**
 * Regression gate: pending_transfers on booking-create-from-plan and direction:"both"
 * on bot transfer save must persist arrival AND departure rows.
 *
 * No API key, no DB, no network.
 */

const {
  expandTransferDirectionPayloads,
  collectPendingTransferEntries,
  buildBotTransferWritePayload,
  savePendingTransfersForBooking,
} = require('./lib/staff-bot-v2-routes');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('\n── A. direction:"both" expands to arrival + departure ──');

const bothExpanded = expandTransferDirectionPayloads({
  direction: 'both',
  airport: 'Santander',
  arrival_datetime: '2026-10-01T13:00:00',
  departure_datetime: '2026-10-09T16:00:00',
});
check('A1 two payloads', bothExpanded.length === 2, bothExpanded.length);
check('A2 directions sorted', bothExpanded.map((p) => p.direction).sort().join(',') === 'arrival,departure');
check('A3 arrival time', bothExpanded.find((p) => p.direction === 'arrival').scheduled_at === '2026-10-01T13:00:00');
check('A4 departure time', bothExpanded.find((p) => p.direction === 'departure').scheduled_at === '2026-10-09T16:00:00');

console.log('\n── B. pending_transfers list (two directions) ──');

const entries = collectPendingTransferEntries({
  pending_transfers: [
    { direction: 'arrival', airport: 'Santander', scheduled_at: '2026-10-01T13:00:00' },
    { direction: 'departure', airport: 'Santander', scheduled_at: '2026-10-09T16:00:00' },
  ],
});
check('B1 two entries', entries.length === 2, entries.length);
check('B2 Santander → SDR in payload',
  buildBotTransferWritePayload(entries[0], 'bk-1', 'MB-WOLFHO-20261001-14123a', 'wolfhouse-somo', 'luna').airport_code === 'SDR');

console.log('\n── C. savePendingTransfersForBooking writes both rows ──');

const savedDirections = [];
async function mockHandlePostBookingTransfer(bookingId, req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  savedDirections.push(body.direction);
  return res.status(200).json({
    success: true,
    transfer: { id: `t-${body.direction}`, direction: body.direction, booking_id: bookingId },
  });
}

(async () => {
  const { results, saved } = await savePendingTransfersForBooking(
    {
      client_slug: 'wolfhouse-somo',
      source: 'agent_luna_whatsapp',
      pending_transfers: [
        { direction: 'arrival', airport: 'Santander', scheduled_at: '2026-10-01T13:00:00' },
        { direction: 'departure', airport: 'Santander', scheduled_at: '2026-10-09T16:00:00' },
      ],
    },
    'bk-uuid-staging',
    'MB-WOLFHO-20261001-14123a',
    { handlePostBookingTransfer: mockHandlePostBookingTransfer, DEFAULT_CLIENT: 'wolfhouse-somo' },
  );

  check('C1 two save attempts', savedDirections.length === 2, savedDirections.length);
  check('C2 arrival + departure saved', savedDirections.sort().join(',') === 'arrival,departure');
  check('C3 both write_performed', results.length === 2 && results.every((r) => r.write_performed));
  check('C4 transfers_saved populated', saved.length === 2, saved.length);

  console.log(`\n── Summary: ${passed} passed, ${failed} failed ──`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
