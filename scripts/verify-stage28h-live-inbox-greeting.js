/**
 * Stage 28h — Live Meta open-demo Inbox transcript + greeting guard verifier.
 *
 * Usage:
 *   npm run verify:stage28h-live-inbox-greeting
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXECUTE = path.join(__dirname, 'lib', 'open-demo-whatsapp-inbound-execute.js');
const THREAD = path.join(__dirname, 'lib', 'luna-staff-inbox-thread-message.js');
const ROUTER = path.join(__dirname, 'lib', 'luna-guest-message-router.js');
const ORCH = path.join(__dirname, 'lib', 'luna-guest-automation-orchestrator-dry-run.js');
const GATE = path.join(__dirname, 'lib', 'open-demo-whatsapp-gate.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage28h-live-inbox-greeting';

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

console.log(`\nverify-stage28h-live-inbox-greeting.js  (Stage 28h)\n`);

for (const f of [EXECUTE, THREAD, ROUTER, ORCH, __filename]) {
  try {
    execSync(`node --check "${f}"`, { stdio: 'pipe' });
    pass('0', `${path.basename(f)} passes node --check`);
  } catch {
    fail('0', `${path.basename(f)} syntax error`);
  }
}

const executeSrc = fs.readFileSync(EXECUTE, 'utf8');
const threadSrc = fs.readFileSync(THREAD, 'utf8');
const routerSrc = fs.readFileSync(ROUTER, 'utf8');
const orchSrc = fs.readFileSync(ORCH, 'utf8');
const gateSrc = fs.readFileSync(GATE, 'utf8');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));

const {
  isGreetingOnlyMessage,
  runLunaGuestMessageRouterDryRun,
} = require('./lib/luna-guest-message-router');
const { runGuestAutomationOrchestratorDryRun } = require('./lib/luna-guest-automation-orchestrator-dry-run');
const {
  persistOpenDemoInboundThreadMessage,
  persistOpenDemoLiveReplyThreadMessage,
} = require('./lib/luna-staff-inbox-thread-message');

section('A. Wiring');

if (pkg.scripts[SCRIPT]) pass('A1', 'verifier npm script registered');
else fail('A1', 'verifier script missing');

if (executeSrc.includes('persistOpenDemoInboundThreadMessage')
  && executeSrc.includes('persistOpenDemoLiveReplyThreadMessage')) {
  pass('A2', 'open-demo execute persists inbound + outbound thread messages');
} else {
  fail('A2', 'thread persistence missing in execute');
}

if (threadSrc.includes('open_demo_whatsapp_inbound')
  && threadSrc.includes('luna_open_demo_live_reply')) {
  pass('A3', 'thread helper sources defined for open-demo');
} else {
  fail('A3', 'open-demo thread sources missing');
}

section('B. Safety gates unchanged');

if (gateSrc.includes('OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED')
  && executeSrc.includes('wantsCreateStripeTestLinkConfirmed')
  && !/createStripeTestLinkConfirmed\s*=\s*true/.test(executeSrc)) {
  pass('B1', 'Stripe test links only when explicitly confirmed');
} else {
  fail('B1', 'Stripe flag auto-enabled in execute');
}

if (!executeSrc.includes('runGuestConfirmationSend')) {
  pass('B2', 'no confirmation send in execute path');
} else {
  fail('B2', 'confirmation send in execute');
}

section('C. Greeting guard');

for (const msg of ['hello', 'hi', 'hey', 'hello?']) {
  if (isGreetingOnlyMessage(msg)) pass('C1', `"${msg}" detected as greeting-only`);
  else fail('C1', `"${msg}" not detected as greeting`);
}

if (!isGreetingOnlyMessage('Hi, we are 2 people interested in Malibu')) {
  pass('C2', 'booking opener is not greeting-only');
} else {
  fail('C2', 'booking opener misclassified as greeting');
}

const poisonedContext = {
  intake_state: 'staff_handoff_required',
  message_lane: 'general_question',
  result: {
    intake_state: 'staff_handoff_required',
    message_lane: 'general_question',
    readiness_state: 'staff_handoff_required',
    safe_handoff_required: true,
  },
  quote: { quote_status: 'not_ready', payment_choice_needed: false },
  payment_choice: { payment_choice_ready: false },
};

const helloRouter = runLunaGuestMessageRouterDryRun(
  { message_text: 'hello?', guest_context: poisonedContext },
  { guest_phone: '+491726422307' },
);

if (helloRouter.greeting_only && !helloRouter.safe_handoff_required) {
  pass('C3', 'hello? does not require staff handoff with poisoned context');
} else {
  fail('C3', `handoff still required: ${JSON.stringify({
    greeting_only: helloRouter.greeting_only,
    safe_handoff_required: helloRouter.safe_handoff_required,
  })}`);
}

if (helloRouter.proposed_luna_reply.includes('How can I help')) {
  pass('C4', 'greeting menu reply returned');
} else {
  fail('C4', `unexpected reply: ${helloRouter.proposed_luna_reply}`);
}

if (!helloRouter.proposed_luna_reply.includes('passing this to our team')) {
  pass('C5', 'greeting does not use handoff fallback text');
} else {
  fail('C5', 'handoff fallback leaked into greeting');
}

(async () => {
  const orch = await runGuestAutomationOrchestratorDryRun({
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    message_text: 'hello?',
    guest_phone: '+491726422307',
    guest_context: poisonedContext,
  }, { dry_run: true });

  if (orch.proposed_next_action !== 'staff_handoff_required') {
    pass('C6', `orchestrator next action is ${orch.proposed_next_action}, not handoff`);
  } else {
    fail('C6', 'orchestrator still proposes staff_handoff_required for hello?');
  }

  if (orch.proposed_luna_reply && orch.proposed_luna_reply.includes('How can I help')) {
    pass('C7', 'orchestrator uses greeting menu reply');
  } else {
    fail('C7', `orchestrator reply wrong: ${(orch.proposed_luna_reply || '').slice(0, 80)}`);
  }

  section('D. Mock thread persistence');

  const CLIENT_SLUG = 'wolfhouse-somo';
  const CONV_ID = '7361e380-1074-4441-a9e1-f92c127a4e76';
  const CLIENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const messages = [];

  const pg = {
    query: async (sql, params) => {
      const s = String(sql);
      if (s.includes('FROM messages m') && s.includes('INNER JOIN conversations')) {
        const wa = params[2];
        const gms = params[3];
        const idem = params[4];
        const found = messages.find((m) => {
          if (wa && m.whatsapp_message_id === wa) return true;
          if (gms && m.metadata && m.metadata.guest_message_send_id === gms) return true;
          if (idem && m.metadata && m.metadata.idempotency_key === idem) return true;
          return false;
        });
        return { rows: found ? [{
          message_id: found.message_id,
          whatsapp_message_id: found.whatsapp_message_id,
          source: found.source,
          direction: found.direction,
        }] : [] };
      }
      if (s.includes('FROM conversations conv') && s.includes('WHERE c.slug')) {
        if (params[1] === CONV_ID) {
          return { rows: [{ id: CONV_ID, client_id: CLIENT_ID }] };
        }
        return { rows: [] };
      }
      if (s.startsWith('INSERT INTO messages')) {
        const meta = typeof params[params.length - 1] === 'string'
          ? JSON.parse(params[params.length - 1])
          : (params[params.length - 1] || {});
        const direction = s.includes("'inbound'") ? 'inbound' : 'outbound';
        const source = params.find((p) => typeof p === 'string' && p.includes('open_demo')) || params[3];
        const row = {
          message_id: `msg-${messages.length + 1}`,
          client_id: params[0],
          conversation_id: params[1],
          direction,
          message_text: direction === 'inbound' ? params[2] : params[2],
          whatsapp_message_id: direction === 'inbound' ? params[4] : params[4],
          source: typeof source === 'string' ? source : 'unknown',
          metadata: meta,
        };
        messages.push(row);
        return { rows: [row] };
      }
      return { rows: [] };
    },
  };

  const wamid = 'wamid.stage28h.hello.inbound';
  const inbound = await persistOpenDemoInboundThreadMessage(pg, {
    client_slug: CLIENT_SLUG,
    conversation_id: CONV_ID,
    message_text: 'hello?',
    whatsapp_message_id: wamid,
  });
  if (inbound.persisted === true && messages.length === 1 && messages[0].direction === 'inbound') {
    pass('D1', 'inbound open-demo message persisted once');
  } else {
    fail('D1', `inbound persist failed: ${JSON.stringify(inbound)}`);
  }

  const inboundReplay = await persistOpenDemoInboundThreadMessage(pg, {
    client_slug: CLIENT_SLUG,
    conversation_id: CONV_ID,
    message_text: 'hello?',
    whatsapp_message_id: wamid,
  });
  if (inboundReplay.duplicate === true && messages.length === 1) {
    pass('D2', 'duplicate wamid does not duplicate inbound transcript');
  } else {
    fail('D2', `expected 1 inbound row, got ${messages.length}`);
  }

  const outbound = await persistOpenDemoLiveReplyThreadMessage(pg, {
    client_slug: CLIENT_SLUG,
    conversation_id: CONV_ID,
    message_text: 'Hey! I am Luna — How can I help?',
  }, {
    send_performed: true,
    whatsapp_message_id: 'wamid.stage28h.hello.outbound',
    guest_message_send_id: 'gms-28h',
    idempotency_key: 'open-demo:test:live-reply',
    guest_message_send_status: 'sent',
  });
  if (outbound.persisted === true && messages.length === 2 && messages[1].direction === 'outbound') {
    pass('D3', 'outbound live reply persisted');
  } else {
    fail('D3', `outbound persist failed: ${JSON.stringify(outbound)}`);
  }

  const outboundReplay = await persistOpenDemoLiveReplyThreadMessage(pg, {
    client_slug: CLIENT_SLUG,
    conversation_id: CONV_ID,
    message_text: 'Hey! I am Luna — How can I help?',
  }, {
    send_performed: false,
    idempotent_replay: true,
    success: true,
    whatsapp_message_id: 'wamid.stage28h.hello.outbound',
    guest_message_send_status: 'sent',
  });
  if (outboundReplay.duplicate === true && messages.length === 2) {
    pass('D4', 'idempotent outbound replay does not duplicate');
  } else {
    fail('D4', `expected 2 messages, got ${messages.length}`);
  }

  section('E. Orchestrator greeting bypass');

  if (orchSrc.includes('result.greeting_only')) {
    pass('E1', 'orchestrator checks greeting_only');
  } else {
    fail('E1', 'orchestrator greeting bypass missing');
  }

  if (routerSrc.includes('isGreetingOnlyMessage')) {
    pass('E2', 'router exports greeting detector');
  } else {
    fail('E2', 'greeting detector missing in router');
  }

  console.log(`\n── Summary ──\n\nResults: ${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})();
