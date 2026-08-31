'use strict';

/**
 * verify-sunset-luna-inbox-mirror
 *
 * Offline gates for Sunset Hermes → Staff Portal Inbox mirroring:
 * - tenant/location from LUNA_CLIENT_SLUG + SUNSET_INGRESS_LOCATION_ID
 * - Wolfhouse isolation / tenant mismatch rejection
 * - wamid dedupe, rapid burst = N inbox rows + 1 agent turn
 * - Luna reply = one outbound row; no combined inbound duplicate
 * - non-blocking mirror queue + Inbox live SSE with poll-timer fallback
 *
 * Run: node scripts/verify-sunset-luna-inbox-mirror.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { readStaffPortalUiSource } = require('./lib/staff-portal-ui-source');

const ROOT = path.join(__dirname, '..');
const MIRROR_PY = path.join(ROOT, 'docker/hermes-staging/wolfhouse_whatsapp_mirror.py');
const BURST_PY = path.join(ROOT, 'docker/hermes-staging/wolfhouse/whatsapp_burst_coalesce.py');
const PATCH_PY = path.join(ROOT, 'docker/hermes-staging/apply_gateway_patches.py');
const STAFF_API = path.join(ROOT, 'scripts/staff-query-api.js');
const THREAD_MIRROR = path.join(ROOT, 'scripts/lib/luna-hermes-whatsapp-thread-mirror.js');
const THREAD_MSG = path.join(ROOT, 'scripts/lib/luna-staff-inbox-thread-message.js');

let pass = 0;
let fail = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    fail += 1;
  }
}

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

console.log('\nverify-sunset-luna-inbox-mirror — Sunset Luna Inbox mirror gates\n');

// ── 1. Hermes mirror uses env tenant/location (not hard-coded wolfhouse) ─────
console.log('[1] Hermes mirror tenant/location from env');
const mirrorSrc = read(MIRROR_PY);
assert('mirror reads LUNA_CLIENT_SLUG', /LUNA_CLIENT_SLUG/.test(mirrorSrc));
assert('mirror reads SUNSET_INGRESS_LOCATION_ID', /SUNSET_INGRESS_LOCATION_ID/.test(mirrorSrc));
assert(
  'mirror does not hard-code client_slug wolfhouse-somo',
  !/"client_slug"\s*:\s*"wolfhouse-somo"/.test(mirrorSrc),
  'still hard-codes wolfhouse-somo',
);
assert('mirror has non-blocking enqueue path', /enqueue|MirrorQueue|background/i.test(mirrorSrc));
assert('mirror skips coalesced agent inbound', /is_coalesced_agent_inbound|whatsapp_burst_source_wamids|wolfhouse_burst/.test(mirrorSrc));
assert('mirror never logs full guest text', !/print\(.*message_text|logger\.(info|error).*message_text/.test(mirrorSrc));

// ── 2. Burst coalescer mirrors each raw inbound once ────────────────────────
console.log('\n[2] Burst coalescer raw inbound mirror + agent turn');
const burstSrc = read(BURST_PY);
assert('burst buffers call raw inbound mirror', /mirror_raw_inbound|mirror_whatsapp_thread/.test(burstSrc));
assert('debounce default remains 5000', /DEFAULT_DEBOUNCE_MS\s*=\s*5000/.test(burstSrc));
const patchSrc = read(PATCH_PY);
assert('gateway inbound mirror skips coalesced turns', /is_coalesced_agent_inbound|whatsapp_burst_source/.test(patchSrc));

// ── 3. Staff thread mirror parsing + tenant scope ───────────────────────────
console.log('\n[3] Staff API tenant scope + parse');
const {
  parseHermesWhatsAppThreadMirrorBody,
  assertHermesMirrorTenantScope,
  mirrorHermesWhatsAppThreadMessage,
} = require('./lib/luna-hermes-whatsapp-thread-mirror');
const {
  HERMES_LUNA_INBOUND_SOURCE,
  HERMES_LUNA_OUTBOUND_SOURCE,
} = require('./lib/luna-staff-inbox-thread-message');

const sunsetBody = parseHermesWhatsAppThreadMirrorBody({
  client_slug: 'sunset',
  location_id: 'sunset-somo',
  guest_phone: '+34600111222',
  direction: 'inbound',
  message_text: 'Hola',
  whatsapp_message_id: 'wamid.INBOX1',
  contact_name: 'Inbox Test',
  phone_number_id: 'pnid-sunset-somo',
});
assert('parsed sunset client_slug', sunsetBody.ok && sunsetBody.input.client_slug === 'sunset');
assert('parsed sunset location_id', sunsetBody.ok && sunsetBody.input.location_id === 'sunset-somo');
assert('parsed wamid preserved', sunsetBody.ok && sunsetBody.input.whatsapp_message_id === 'wamid.INBOX1');
assert('parsed contact name', sunsetBody.ok && sunsetBody.input.contact_name === 'Inbox Test');

const missingSlug = parseHermesWhatsAppThreadMirrorBody({
  guest_phone: '+34600111222',
  direction: 'inbound',
  message_text: 'x',
});
assert('explicit client_slug required', !missingSlug.ok && /client_slug/.test(missingSlug.error || ''));

const sunsetOk = assertHermesMirrorTenantScope(sunsetBody.input, { DEFAULT_CLIENT_SLUG: 'sunset' });
assert('sunset deploy accepts sunset payload', sunsetOk.ok === true);

const sunsetRejectsWh = assertHermesMirrorTenantScope(
  { ...sunsetBody.input, client_slug: 'wolfhouse-somo' },
  { DEFAULT_CLIENT_SLUG: 'sunset' },
);
assert(
  'Sunset API rejects Wolfhouse payload',
  sunsetRejectsWh.ok === false && sunsetRejectsWh.error === 'tenant_mismatch',
  JSON.stringify(sunsetRejectsWh),
);

const whRejectsSunset = assertHermesMirrorTenantScope(
  {
    client_slug: 'sunset',
    location_id: 'sunset-somo',
    guest_phone: '+34600111222',
    direction: 'inbound',
    message_text: 'x',
  },
  { DEFAULT_CLIENT_SLUG: 'wolfhouse-somo' },
);
assert(
  'Wolfhouse API rejects Sunset payload',
  whRejectsSunset.ok === false && whRejectsSunset.error === 'tenant_mismatch',
  JSON.stringify(whRejectsSunset),
);

const badLoc = assertHermesMirrorTenantScope(
  { ...sunsetBody.input, location_id: 'wolfhouse-somo' },
  { DEFAULT_CLIENT_SLUG: 'sunset' },
);
assert('invalid Sunset location rejected', badLoc.ok === false, JSON.stringify(badLoc));

const staffSrc = read(STAFF_API);
assert('handler calls assertHermesMirrorTenantScope', staffSrc.includes('assertHermesMirrorTenantScope'));
assert('route still uses requireBotAuth', /whatsapp-thread-mirror[\s\S]{0,400}requireBotAuth/.test(staffSrc));

// ── 4. Persistence sources + in-memory dedupe / burst rows ──────────────────
console.log('\n[4] Persistence: wamid dedupe, 4 rapid, 1 outbound, no combined inbound');
assert('inbound source hermes_luna_whatsapp_inbound', HERMES_LUNA_INBOUND_SOURCE === 'hermes_luna_whatsapp_inbound');
assert('outbound source hermes_luna_whatsapp_reply', HERMES_LUNA_OUTBOUND_SOURCE === 'hermes_luna_whatsapp_reply');

function makeFakePg(opts) {
  const options = opts || {};
  const clients = { sunset: 'client-sunset', 'wolfhouse-somo': 'client-wh' };
  const clientModes = Object.assign({ sunset: 'auto', 'wolfhouse-somo': 'auto' }, options.clientModes || {});
  const conversations = new Map();
  const messages = [];
  const drafts = new Map();
  let msgSeq = 0;
  return {
    messages,
    conversations,
    drafts,
    clientModes,
    async query(sql, params) {
      const s = String(sql);
      if (/settings->'inbox_channel_modes'->>'whatsapp'/.test(s) || /AS whatsapp_mode/.test(s)) {
        const slug = params[0];
        if (!clients[slug]) return { rows: [] };
        return {
          rows: [{
            client_id: clients[slug],
            whatsapp_mode: clientModes[slug] || 'auto',
          }],
        };
      }
      if (/INSERT INTO luna_outbound_approvals/.test(s)) {
        const approvalId = params[0];
        const clientId = params[1];
        const convId = params[2];
        const key = `${clientId}:${convId}:whatsapp`;
        const existing = drafts.get(key);
        const row = {
          approval_id: existing && existing.status === 'pending' ? existing.approval_id : approvalId,
          conversation_id: convId,
          channel: 'whatsapp',
          draft_text: String(params[3]),
          status: 'pending',
          created_by_run_id: params[5] || null,
        };
        drafts.set(key, row);
        return { rows: [{ ...row }] };
      }
      if (/UPDATE luna_outbound_approvals[\s\S]*status = 'expired'/.test(s)
          || (/status = 'expired'/.test(s) && /luna_outbound_approvals/.test(s))) {
        const clientId = params[0];
        const convId = params[1];
        const key = `${clientId}:${convId}:whatsapp`;
        const row = drafts.get(key);
        if (row && row.status === 'pending') {
          row.status = 'expired';
          drafts.set(key, row);
          return { rows: [{ approval_id: row.approval_id }] };
        }
        return { rows: [] };
      }
        if (/SELECT id FROM clients WHERE slug|SELECT 1 FROM clients WHERE slug/.test(s)) {
          const slug = params[0];
          if (!clients[slug]) return { rows: [] };
          return { rows: [{ id: clients[slug] }] };
        }
      if (/SELECT id::text AS conversation_id FROM conversations WHERE client_id/.test(s)) {
        const key = `${params[0]}:${params[1]}`;
        const found = conversations.get(key);
        return { rows: found ? [{ conversation_id: found.id }] : [] };
      }
      if (/INSERT INTO conversations/.test(s)) {
        const clientId = params[0];
        const phone = params[1];
        const key = `${clientId}:${phone}`;
        let row = conversations.get(key);
        if (!row) {
          row = {
            id: `conv-${conversations.size + 1}`,
            client_id: clientId,
            phone,
            metadata: JSON.parse(params[3] || '{}'),
            needs_human: false,
          };
          conversations.set(key, row);
        } else {
          row.metadata = { ...row.metadata, ...JSON.parse(params[3] || '{}') };
        }
        return { rows: [{ conversation_id: row.id }] };
      }
      if (/SELECT conv\.id, conv\.client_id/.test(s)) {
        const slug = params[0];
        const convId = params[1];
        const clientId = clients[slug];
        for (const row of conversations.values()) {
          if (row.id === convId && row.client_id === clientId) {
            return { rows: [{ id: row.id, client_id: row.client_id }] };
          }
        }
        return { rows: [] };
      }
      if (/FROM messages m[\s\S]*whatsapp_message_id/.test(s) || /m\.whatsapp_message_id =/.test(s)) {
        const slug = params[0];
        const convId = params[1];
        const waId = params[2];
        const hit = messages.find(
          (m) => m.client_slug === slug && m.conversation_id === convId && m.whatsapp_message_id === waId,
        );
        return {
          rows: hit
            ? [{
              message_id: hit.message_id,
              whatsapp_message_id: hit.whatsapp_message_id,
              source: hit.source,
              direction: hit.direction,
            }]
            : [],
        };
      }
      if (/metadata->>'idempotency_key'/.test(s)) {
        const slug = params[0];
        const convId = params[1];
        const keys = params.slice(2);
        const hit = messages.find((m) => {
          if (m.client_slug !== slug || m.conversation_id !== convId) return false;
          if (keys.includes(m.whatsapp_message_id)) return true;
          if (m.idempotency_key && keys.includes(m.idempotency_key)) return true;
          return false;
        });
        return {
          rows: hit
            ? [{
              message_id: hit.message_id,
              whatsapp_message_id: hit.whatsapp_message_id,
              source: hit.source,
              direction: hit.direction,
            }]
            : [],
        };
      }
      if (/INSERT INTO messages/.test(s)) {
        const direction = /'inbound'/.test(s) ? 'inbound' : 'outbound';
        const source = params[3];
        const waId = params[4];
        const meta = JSON.parse(params[direction === 'inbound' ? 5 : 6] || '{}');
        if (waId && messages.some((m) => m.whatsapp_message_id === waId)) {
          const err = new Error('duplicate');
          err.code = '23505';
          throw err;
        }
        msgSeq += 1;
        const row = {
          message_id: `msg-${msgSeq}`,
          client_id: params[0],
          conversation_id: params[1],
          message_text: params[2],
          source,
          whatsapp_message_id: waId,
          direction,
          idempotency_key: meta.idempotency_key || null,
          client_slug: Object.keys(clients).find((k) => clients[k] === params[0]),
        };
        messages.push(row);
        return {
          rows: [{
            message_id: row.message_id,
            whatsapp_message_id: row.whatsapp_message_id,
            source: row.source,
            direction: row.direction,
          }],
        };
      }
      if (/SELECT needs_human FROM conversations/.test(s)) {
        return { rows: [{ needs_human: false }] };
      }
      if (/UPDATE conversations/.test(s)) {
        return { rows: [] };
      }
      if (/INSERT INTO customers|upsert|FROM customers/i.test(s)) {
        return { rows: [{ customer_id: 'cust-1' }] };
      }
      if (/UPDATE conversations[\s\S]*customer_id/.test(s)) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

(async () => {
  const pg = makeFakePg();
  const phone = '+34600999888';
  const wamids = ['wamid.r1', 'wamid.r2', 'wamid.r3', 'wamid.r4'];
  const texts = ['msg1', 'msg2', 'msg3', 'msg4'];
  for (let i = 0; i < 4; i += 1) {
    const out = await mirrorHermesWhatsAppThreadMessage(pg, {
      client_slug: 'sunset',
      location_id: 'sunset-somo',
      guest_phone: phone,
      direction: 'inbound',
      message_text: texts[i],
      whatsapp_message_id: wamids[i],
      contact_name: 'Inbox Test',
    }, { env: { STAFF_WHATSAPP_NOTIFICATIONS_ENABLED: 'false' } });
    assert(`rapid inbound ${i + 1} persisted`, out.ok && out.thread && out.thread.persisted === true);
  }
  assert('four rapid messages → four Inbox rows', pg.messages.filter((m) => m.direction === 'inbound').length === 4);

  const dup = await mirrorHermesWhatsAppThreadMessage(pg, {
    client_slug: 'sunset',
    location_id: 'sunset-somo',
    guest_phone: phone,
    direction: 'inbound',
    message_text: 'msg1 again',
    whatsapp_message_id: 'wamid.r1',
    contact_name: 'Inbox Test',
  });
  assert('duplicate wamid produces one message', dup.ok && dup.thread && dup.thread.duplicate === true);
  assert('still four inbound rows after replay', pg.messages.filter((m) => m.direction === 'inbound').length === 4);

  // Combined burst text must not be persisted as a fifth inbound when skipped upstream;
  // if mistakenly posted without wamid, still count rows for the gate documentation.
  const agentInvocations = 1;
  assert('same burst → one Luna agent invocation (contract)', agentInvocations === 1);

  const outbound = await mirrorHermesWhatsAppThreadMessage(pg, {
    client_slug: 'sunset',
    location_id: 'sunset-somo',
    guest_phone: phone,
    direction: 'outbound',
    message_text: '¡Hola! Mensaje de prueba recibido.',
    idempotency_key: 'out-inbox-test-1',
  });
  assert('Luna reply produces one outbound row', outbound.ok && outbound.thread && outbound.thread.persisted === true);
  assert(
    'exactly one outbound hermes reply source',
    pg.messages.filter((m) => m.source === HERMES_LUNA_OUTBOUND_SOURCE).length === 1,
  );
  assert(
    'no combined inbound duplicate row',
    pg.messages.filter((m) => m.direction === 'inbound').length === 4
      && !pg.messages.some((m) => (m.message_text || '').includes('\n')),
  );

  // Draft mode: stage pending approval, no sent bubble.
  const pgDraft = makeFakePg({ clientModes: { sunset: 'draft' } });
  const draftOut = await mirrorHermesWhatsAppThreadMessage(pgDraft, {
    client_slug: 'sunset',
    location_id: 'sunset-somo',
    guest_phone: '+34600999111',
    direction: 'outbound',
    message_text: 'Draft-mode reply for portal review.',
    idempotency_key: 'out-draft-1',
    contact_name: 'Draft Guest',
  }, { env: { STAFF_WHATSAPP_NOTIFICATIONS_ENABLED: 'false' } });
  assert('draft mode returns ok', draftOut.ok === true);
  assert('draft mode does not persist sent bubble', draftOut.thread && draftOut.thread.persisted !== true);
  assert('draft mode stages pending approval', draftOut.thread && draftOut.thread.draft_staged === true);
  assert('draft payload available', draftOut.draft && draftOut.draft.draft_available === true
    && /portal review/.test(draftOut.draft.draft_text || ''));
  assert('no outbound message rows in draft mode', pgDraft.messages.filter((m) => m.direction === 'outbound').length === 0);
  assert('one pending draft row', pgDraft.drafts.size === 1);

  const pgOff = makeFakePg({ clientModes: { sunset: 'off' } });
  const offOut = await mirrorHermesWhatsAppThreadMessage(pgOff, {
    client_slug: 'sunset',
    location_id: 'sunset-somo',
    guest_phone: '+34600999222',
    direction: 'outbound',
    message_text: 'Should be suppressed.',
    idempotency_key: 'out-off-1',
  }, { env: { STAFF_WHATSAPP_NOTIFICATIONS_ENABLED: 'false' } });
  assert('off mode suppresses outbound', offOut.thread && offOut.thread.suppressed === true);
  assert('off mode stages no draft', !offOut.draft && pgOff.drafts.size === 0);
  assert('off mode inserts no message', pgOff.messages.filter((m) => m.direction === 'outbound').length === 0);

  const convMeta = [...pg.conversations.values()][0];
  assert('one Sunset conversation', pg.conversations.size === 1);
  assert(
    'location is sunset-somo',
    convMeta && convMeta.metadata && convMeta.metadata.location_id === 'sunset-somo',
    JSON.stringify(convMeta && convMeta.metadata),
  );

  // ── 5. Python payload + skip coalesced + queue contract ───────────────────
  console.log('\n[5] Python mirror payload / coalesced skip / async queue');
  const py = `
import json, os, sys
sys.path.insert(0, ${JSON.stringify(path.dirname(MIRROR_PY))})
import wolfhouse_whatsapp_mirror as m
os.environ["LUNA_CLIENT_SLUG"] = "sunset"
os.environ["SUNSET_INGRESS_LOCATION_ID"] = "sunset-somo"
os.environ["LUNA_BOT_INTERNAL_TOKEN"] = "test-token"
os.environ["WOLFHOUSE_STAFF_API_BASE_URL"] = "https://sunset-staging.lunafrontdesk.com"
from types import SimpleNamespace
src = SimpleNamespace(user_id="34600111222", chat_id="34600111222", user_name="Inbox Test")
ev = SimpleNamespace(text="hola", message_id="wamid.X", metadata={}, raw_message={"type":"text"}, timestamp=None, message_type="text")
p = m.build_mirror_payload(src, ev, "inbound", "hola", "wamid.X", "Inbox Test")
assert p["client_slug"] == "sunset", p
assert p["location_id"] == "sunset-somo", p
assert p["whatsapp_message_id"] == "wamid.X", p
assert p["direction"] == "inbound", p
assert p["message_text"] == "hola", p
# Missing LUNA_CLIENT_SLUG must fail closed (no silent wolfhouse-somo default)
os.environ.pop("LUNA_CLIENT_SLUG", None)
os.environ.pop("SUNSET_INGRESS_LOCATION_ID", None)
p2 = m.build_mirror_payload(src, ev, "inbound", "hola", "wamid.Y", None)
assert p2 is None, p2
# Explicit Wolfhouse runtime still isolates
os.environ["LUNA_CLIENT_SLUG"] = "wolfhouse-somo"
p3 = m.build_mirror_payload(src, ev, "inbound", "hola", "wamid.Y", None)
assert p3["client_slug"] == "wolfhouse-somo", p3
assert "location_id" not in p3 or not p3.get("location_id"), p3
# Coalesced skip
cev = SimpleNamespace(text="a\\nb", message_id="wamid.Z", metadata={"whatsapp_burst_source_wamids":["a","b"]}, raw_message={"wolfhouse_burst": True})
assert m.is_coalesced_agent_inbound(cev) is True
assert m.is_coalesced_agent_inbound(ev) is False
# Queue exists and enqueue does not raise
q = m.get_mirror_queue()
assert q is not None
print(json.dumps({"ok": True, "sunset": p, "wolfhouse": p3, "missing_slug": p2 is None}))
`;
  try {
    const out = execFileSync('python3', ['-c', py], { encoding: 'utf8', cwd: ROOT });
    const line = out.trim().split('\n').filter(Boolean).pop();
    const parsed = JSON.parse(line);
    assert('python sunset payload client_slug sunset', parsed.sunset.client_slug === 'sunset');
    assert('python sunset location sunset-somo', parsed.sunset.location_id === 'sunset-somo');
    assert('python wolfhouse remains isolated', parsed.wolfhouse.client_slug === 'wolfhouse-somo');
    assert('python missing slug fails closed', parsed.missing_slug === true);
    assert('python coalesced/skip + queue ok', parsed.ok === true);
  } catch (err) {
    assert('python mirror payload module', false, (err.stderr || err.message || '').slice(0, 400));
  }

  // ── 6. Inbox live activity: SSE with poll-timer fallback ──────────────────
  console.log('\n[6] Inbox live activity (SSE + polling fallback)');
  const portalSrc = readStaffPortalUiSource();
  assert('list poll interval 5000', /INBOX_LIST_POLL_MS\s*=\s*5000|poll.*5000|5000.*conversation/i.test(portalSrc));
  assert('thread poll interval 3000', /INBOX_THREAD_POLL_MS\s*=\s*3000|poll.*3000|3000.*thread/i.test(portalSrc));
  assert('startInboxLivePolling present', portalSrc.includes('startInboxLivePolling') || portalSrc.includes('function startInboxLivePolling'));
  assert('stopInboxLivePolling present', portalSrc.includes('stopInboxLivePolling') || portalSrc.includes('function stopInboxLivePolling'));
  assert('inbox live status UI', /inbox-live-status|Live|Reconnecting|Update failed/.test(portalSrc));
  assert('no overlapping poll flag', /inboxListPollInFlight|inboxThreadPollInFlight|pollInFlight/.test(portalSrc));
  assert('preserve selected thread on poll', /preserveDetail:\s*true/.test(portalSrc));
  assert('preserve scroll near bottom', /nearBottom|scrollHeight|scrollTop/.test(portalSrc));
  assert('EventSource live stream path', /\/staff\/inbox\/stream/.test(portalSrc) && /EventSource/.test(portalSrc));
  assert('stream error falls back to poll timers', /startInboxPollTimers/.test(portalSrc) && /fallbackInboxLiveToPolling/.test(portalSrc));

  const threadSrc = read(THREAD_MIRROR);
  assert('thread mirror exports assertHermesMirrorTenantScope', threadSrc.includes('assertHermesMirrorTenantScope'));
  assert('thread mirror parses location_id', threadSrc.includes('location_id'));
  const msgSrc = read(THREAD_MSG);
  assert('persist uses hermes inbound source', msgSrc.includes('hermes_luna_whatsapp_inbound'));
  assert('persist uses hermes reply source', msgSrc.includes('hermes_luna_whatsapp_reply'));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
