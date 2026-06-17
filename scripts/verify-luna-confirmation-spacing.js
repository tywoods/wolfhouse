'use strict';

/**
 * verify:luna-confirmation-spacing — regression gate for the booking confirmation
 * WhatsApp formatting (spec §9.2: line breaks / short blocks, no walls of text).
 *
 * A staging booking pushed a confirmation that read as a single run-on paragraph
 * ("...officially part of the Wolfhouse family ... Booking: ... Paid: €200
 * Balance: €398 Location: <maps link> Gate code: 2684# Room: R3 ..."). Root cause:
 * the server-side confirmation builder ran `message.replace(/\s{2,}/g, ' ')`,
 * which collapsed the template's `\n\n`/`\n` block spacing into single spaces.
 *
 * This gate proves:
 *   A. tidyConfirmationWhitespace keeps newlines (only collapses horizontal space)
 *      and drops empty "Label:" lines.
 *   B. The Cami/Wolfhouse confirmation preview for wolfhouse-somo is multi-line,
 *      with one fact per line and a blank line before the maps/location link,
 *      under the WhatsApp reply-length contract.
 *
 * No API key, no DB, no network.
 */

const path = require('path');

const ROOT = path.join(__dirname, '..');
const {
  tidyConfirmationWhitespace,
  buildConfirmationPreviewFromPlaybook,
} = require(path.join(ROOT, 'scripts', 'lib', 'luna-client-messaging-playbook.js'));
const { resolveRoomNumbers } = require(path.join(ROOT, 'scripts', 'lib', 'luna-booking-confirmation-preview.js'));

const MAX_REPLY_CHARS = 900; // spec §9.1

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

console.log('\n── A. tidyConfirmationWhitespace preserves block spacing ──');

// The interpolated template the live builder produces, including the empty
// "Balance due:" artifact that the old collapse was (over-aggressively) cleaning.
const interpolated = [
  "Hi Ty ☀️ Payment received — you're officially part of the Wolfhouse family! 🌊",
  '',
  'Booking: MB-WOLFHO-20260915-cd8f5b',
  'Paid: €200',
  'Balance due: ',                 // empty value — should be dropped, not flattened
  '',
  'Address: Calle Isla de Mouro 4, Somo',
  'Gate code: 2684#',
  'Room: R3',
  '',
  "If you'd like to settle the remaining balance by card before arrival: https://lunafrontdesk.com/pay/WH-G27-AB12",
].join('\n');

const tidied = tidyConfirmationWhitespace(interpolated);
check('A1 keeps newlines (not a single line)', tidied.split('\n').length >= 8, `lines=${tidied.split('\n').length}`);
check('A2 has blank-line block separators', /\n\n/.test(tidied));
check('A3 drops empty "Balance due:" label line', !/Balance due:/.test(tidied));
check('A4 keeps non-empty fields on their own lines',
  /\nBooking: /.test('\n' + tidied) && /\nGate code: 2684#/.test(tidied) && /\nRoom: R3/.test(tidied));
check('A5 never collapses Booking+Paid onto one line',
  !/Booking:[^\n]*Paid:/.test(tidied), tidied.replace(/\n/g, '⏎'));
check('A6 collapses a stray double space inside a line',
  tidyConfirmationWhitespace('Gate code:  2684#') === 'Gate code: 2684#');

console.log('\n── B. Cami confirmation preview is WhatsApp-spaced ──');

const preview = buildConfirmationPreviewFromPlaybook('wolfhouse-somo', 'en', {
  guest_name: 'Ty',
  booking_code: 'MB-WOLFHO-20260915-cd8f5b',
  amount_paid_cents: 20000,
  balance_due_cents: 39800,
  room_number: 'R3',
  gate_code: '2684#',
});

check('B1 preview built ok', preview && preview.ok === true, preview && preview.source);
const msg = (preview && preview.message) || '';
check('B2 multi-line (>= 5 lines)', msg.split('\n').length >= 5, `lines=${msg.split('\n').length}`);
check('B3 not a wall of text (has blank-line block break)', /\n\n/.test(msg));
check('B4 Booking on its own line', /(^|\n)Booking: MB-WOLFHO-20260915-cd8f5b(\n|$)/.test(msg));
check('B5 no two adjacent labels on the same line',
  !/(Booking|Paid|Balance|Location|Gate code|Room):[^\n]*?(Paid|Balance|Location|Gate code|Room):/.test(msg),
  msg.replace(/\n/g, '⏎'));
// Blank line before the maps/location link, if a maps link is present.
if (/Location:/.test(msg)) {
  check('B6 blank line before the Location/maps block', /\n\nLocation:/.test(msg), msg.replace(/\n/g, '⏎'));
} else {
  check('B6 blank line before the Location/maps block (n/a — no maps link configured)', true);
}
check('B7 under WhatsApp reply-length contract', msg.length <= MAX_REPLY_CHARS, `len=${msg.length}`);

console.log('\n── C. Confirmation is built in the booking language (not English fallback) ──');

const defields = {
  guest_name: 'Kathi',
  booking_code: 'MB-WOLFHO-20260722-1d7fb2',
  amount_paid_cents: 20000,
  balance_due_cents: 49800,
  room_number: 'R1',
  gate_code: '2684#',
};
const dePreview = buildConfirmationPreviewFromPlaybook('wolfhouse-somo', 'de', defields);
const deMsg = (dePreview && dePreview.message) || '';
check('C1 German preview built ok', dePreview && dePreview.ok === true, dePreview && dePreview.source);
check('C2 German intro (not the English family line)',
  /Wolfhouse-Familie/.test(deMsg) && !/officially part of the Wolfhouse family/.test(deMsg),
  deMsg.split('\n')[0]);
check('C3 German factual labels (Buchung/Bezahlt/Zimmer)',
  /(^|\n)Buchung: /.test(deMsg) && /\nBezahlt: /.test(deMsg) && /\nZimmer: /.test(deMsg),
  deMsg.replace(/\n/g, '⏎'));
check('C4 no English labels leaked into German confirmation',
  !/(^|\n)(Booking|Paid|Room|Gate code): /.test(deMsg), deMsg.replace(/\n/g, '⏎'));
check('C5 German close (not the English Somo line)',
  /euch in Somo zu begrüßen/.test(deMsg) && !/Can't wait to welcome you in Somo/.test(deMsg));

const enPreview = buildConfirmationPreviewFromPlaybook('wolfhouse-somo', 'en', defields);
check('C6 English still renders English (no regression)',
  /officially part of the Wolfhouse family/.test((enPreview && enPreview.message) || ''));

console.log('\n── D. Confirmation room_number prefers assigned beds ──');
{
  const rooms = resolveRoomNumbers({ room_number: 'R2' }, 'R3', ['R3']);
  check('D1', rooms.join(',') === 'R3', `assigned R3 wins over draft R2: ${rooms.join(',')}`);
}

console.log(`\n── Summary: ${passed} passed, ${failed} failed ──`);
process.exit(failed > 0 ? 1 : 0);
