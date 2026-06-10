/**
 * Stage 28h.6 — Verifier for Staff Portal Fresh Start (reset-luna-context).
 *
 * Usage:
 *   npm run verify:stage28h6-fresh-start-button
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WRITES = path.join(__dirname, 'lib', 'staff-conversation-writes.js');
const API = path.join(__dirname, 'staff-query-api.js');
const DOC = path.join(ROOT, 'docs', 'STAGE-28H6-FRESH-START-CONTEXT-RESET.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage28h6-fresh-start-button';

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

console.log(`\nverify-stage28h6-fresh-start-button.js  (Stage 28h.6)\n`);

for (const f of [WRITES, API, __filename]) {
  try {
    execSync(`node --check "${f}"`, { stdio: 'pipe' });
    pass('0', `${path.basename(f)} passes node --check`);
  } catch {
    fail('0', `${path.basename(f)} syntax error`);
  }
}

const writesSrc = fs.readFileSync(WRITES, 'utf8');
const apiSrc = fs.readFileSync(API, 'utf8');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));

const {
  resetLunaConversationContext,
  stripLunaContextFromMetadata,
} = require('./lib/staff-conversation-writes');

section('A. Wiring');

if (pkg.scripts[SCRIPT]) pass('A1', 'verifier npm script registered');
else fail('A1', 'verifier script missing');

if (fs.existsSync(DOC)) pass('A2', 'STAGE-28H6 doc exists');
else fail('A2', 'doc missing');

if (apiSrc.includes('btn-fresh-start') && apiSrc.includes('Fresh Start')) {
  pass('A3', 'Inbox button labeled Fresh Start');
} else {
  fail('A3', 'Fresh Start button missing');
}

if (apiSrc.includes('reset-luna-context') && apiSrc.includes('wireFreshStart')) {
  pass('A4', 'UI wires reset-luna-context');
} else {
  fail('A4', 'reset-luna-context wiring missing');
}

if (!apiSrc.includes("fetch('/staff/conversations/' + encodeURIComponent(convId) + '/clear-messages'")) {
  pass('A5', 'Inbox button does not call clear-messages');
} else {
  fail('A5', 'Inbox still calls destructive clear-messages');
}

if (apiSrc.includes('handleConversationResetLunaContext')
  && apiSrc.includes('isStagingResetEnvironment')) {
  pass('A6', 'reset handler has staging guard');
} else {
  fail('A6', 'staging guard missing on reset handler');
}

if (apiSrc.includes("requireAuth(req, res, 'operator')")
  && apiSrc.includes('handleConversationResetLunaContext')) {
  pass('A7', 'operator auth on reset route');
} else {
  fail('A7', 'operator auth missing');
}

section('B. Metadata strip helper');

const stripped = stripLunaContextFromMetadata({
  luna_guest_context: { quote_status: 'ready', payment_choice_needed: true },
  luna_inbound_reviews: { key1: { review: {} } },
  guest_context: { intake_state: 'ready' },
  last_inbound_message_id: 'wamid.1',
  last_inbound_at: '2026-06-10',
  source: 'luna_inbound_review_dry_run',
  channel: 'whatsapp',
  staff_note: 'keep-me',
});

if (!stripped.luna_guest_context && !stripped.luna_inbound_reviews && !stripped.guest_context) {
  pass('B1', 'strip removes luna_guest_context and luna_inbound_reviews');
} else {
  fail('B1', `strip left poison keys: ${JSON.stringify(stripped)}`);
}

if (stripped.staff_note === 'keep-me') pass('B2', 'unrelated metadata preserved');
else fail('B2', 'unrelated metadata lost');

section('C. resetLunaConversationContext — no destructive side effects');

(async () => {
  const queries = [];
  const pg = {
    query: async (sql, params) => {
      queries.push({ sql: String(sql), params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT conv.id::text AS conversation_id, conv.metadata')) {
        return {
          rows: [{
            conversation_id: '7361e380-1074-4441-a9e1-f92c127a4e76',
            metadata: {
              luna_guest_context: { quote: { quote_status: 'ready' } },
              luna_inbound_reviews: { idem1: {} },
              staff_note: 'persist',
            },
          }],
        };
      }
      if (sql.includes('UPDATE conversations conv')) return { rows: [{ conversation_id: '7361e380-1074-4441-a9e1-f92c127a4e76' }] };
      if (sql.includes('COUNT(*)::int AS n')) return { rows: [{ n: 11 }] };
      return { rows: [], rowCount: 0 };
    },
  };

  const result = await resetLunaConversationContext(pg, 'wolfhouse-somo', '7361e380-1074-4441-a9e1-f92c127a4e76');
  const sqlBlob = queries.map((q) => q.sql).join('\n');

  if (result.found && result.context_cleared) pass('C1', 'reset returns found + context_cleared');
  else fail('C1', `unexpected result: ${JSON.stringify(result)}`);

  if (result.messages_preserved === 11) pass('C2', 'reports messages preserved count');
  else fail('C2', `messages_preserved=${result.messages_preserved}`);

  if (!/DELETE\s+FROM\s+messages/i.test(sqlBlob)) pass('C3', 'no DELETE FROM messages');
  else fail('C3', 'reset deleted messages');

  if (!/guest_message_events/i.test(sqlBlob)) pass('C4', 'no guest_message_events touch');
  else fail('C4', 'reset touched guest_message_events');

  if (!/bookings|payments|booking_beds/i.test(sqlBlob)) pass('C5', 'no bookings/payments/booking_beds touch');
  else fail('C5', 'reset touched booking tables');

  const upd = queries.find((q) => q.sql.includes('UPDATE conversations conv'));
  if (upd) {
    const meta = JSON.parse(upd.params[2]);
    if (!meta.luna_guest_context && !meta.luna_inbound_reviews && meta.staff_note === 'persist') {
      pass('C6', 'UPDATE metadata clears Luna keys only');
    } else {
      fail('C6', `bad metadata payload: ${JSON.stringify(meta)}`);
    }
    if (upd.sql.includes('staff_reply_draft = NULL')
      && upd.sql.includes('pending_action = NULL')
      && upd.sql.includes('last_bot_reply = NULL')) {
      pass('C7', 'UPDATE clears draft/pending/bot reply fields');
    } else {
      fail('C7', 'draft/pending fields not cleared');
    }
  } else {
    fail('C6', 'no UPDATE conversations query');
    fail('C7', 'no UPDATE conversations query');
  }

  section('D. Legacy clear-messages preserved but not default');

  if (writesSrc.includes('clearConversationMessages')
    && apiSrc.includes('handleConversationClearMessages')) {
    pass('D1', 'legacy clear-messages endpoint still exists');
  } else {
    fail('D1', 'legacy clear-messages missing');
  }

  if (writesSrc.includes('resetLunaConversationContext')) {
    pass('D2', 'resetLunaConversationContext exported');
  } else {
    fail('D2', 'resetLunaConversationContext missing');
  }

  section('E. Scope guard');

  const resetHandler = apiSrc.slice(
    apiSrc.indexOf('async function handleConversationResetLunaContext'),
    apiSrc.indexOf('async function handleConversationClearMessages'),
  );
  if (!/stripe|whatsapp|confirmation|n8n/i.test(resetHandler)) {
    pass('E1', 'reset handler has no Stripe/WhatsApp/confirmation/n8n side effects');
  } else {
    fail('E1', 'forbidden side effect in reset handler');
  }

  if (!/DELETE\s+FROM\s+messages/i.test(writesSrc.match(/async function resetLunaConversationContext[\s\S]*?^async function/m)?.[0] || '')) {
    pass('E2', 'reset helper does not delete messages');
  } else {
    fail('E2', 'reset helper deletes messages');
  }

  console.log(`\n── Summary ──\n\nResults: ${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})();
