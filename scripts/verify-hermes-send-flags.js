#!/usr/bin/env node
'use strict';

/**
 * verify-hermes-send-flags
 *
 * `WHATSAPP_DRY_RUN` and `LUNA_AUTO_SEND_ENABLED` exist so no real guest can
 * receive an unintended message. They worked on the legacy JS path and nowhere in
 * Hermes — which is what actually runs on staging. This gate proves they now work
 * where it matters, and stays red if they ever stop.
 *
 * Nothing here greps for a variable name. A name being present proves nothing, so
 * every claim is made by running the shipped code:
 *
 *   Parity    `wolfhouse/send_flags.py` is executed over an env matrix and compared
 *             against the shipped JS predicates (`isWhatsappDryRun`, and the route's
 *             literal-`true` read of `LUNA_AUTO_SEND_ENABLED`) on the same values.
 *             The JS side is the oracle; the two readings cannot drift.
 *   Send      `_patched_whatsapp_cloud_send`, the real function Hermes installs over
 *             `WhatsAppCloudAdapter.send`, is invoked with a stub `gateway` package
 *             and a recording provider, so "did a message leave?" is answered by the
 *             shipped send path rather than by reading it.
 *   Pause     `wolfhouse/pause_gate.py` runs for real against a loopback server
 *             serving real `POST /staff/bot/check-guest-automation-gate` shapes, the
 *             same technique as `scripts/verify-luna-effective-mode.js`.
 *   Teeth     Three mutants (guard deleted from the send patch; dry-run flag stops
 *             being read; auto-send flag read as truthy instead of literal `true`)
 *             are applied to a throwaway copy of the tree and the checks above are
 *             re-run against it. Each mutant must break something. A gate that
 *             cannot fail is decoration.
 *
 * Also pins the three JS ⇄ Hermes rulings in `docs/LUNA-SEND-KILL-SWITCH.md`:
 * (a) Hermes quiet on needs_human, (b) keep Hermes fail-closed on the Sunset
 * carve-out, (c) email arm fail-closed. If a ruling silently changes behaviour,
 * or the decision record stops matching, this gate fails.
 *
 * Offline: no Docker, no VM, no database, no network beyond 127.0.0.1.
 *
 * Run: node scripts/verify-hermes-send-flags.js
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const { isWhatsappDryRun } = require('./lib/luna-guest-reply-send-eligibility');
const { collectEnvGateReasons } = require('./lib/luna-guest-reply-send-route');
const { resolveLunaEffectiveMode } = require('./lib/luna-effective-mode');
const {
  createStaffEmailLunaDraftRoute,
  EMAIL_LUNA_GENERATE_DRAFT_ENABLED_ENV,
  snapshotEmailLunaGenerateGateEnv,
} = require('./lib/staff-email-luna-draft-route');

const ROOT = path.join(__dirname, '..');
const HERMES_DIR = path.join(ROOT, 'docker/hermes-staging');
const DECISIONS_DOC = path.join(ROOT, 'docs/LUNA-SEND-KILL-SWITCH.md');

/** Decisions this work found. All four are settled; the gate pins each ruling. */
const DECISION_IDS = Object.freeze([
  'kill_switch_flags_unread_by_hermes',
  'needs_human_blocks_on_hermes_not_js',
  'sunset_needs_human_carveout_defeated',
  'email_pause_advisory',
]);
const DECISION_STATUSES = Object.freeze(['resolved-in-this-pr', 'awaiting-ruling', 'ruled']);
/** status + ruling pinned in docs/LUNA-SEND-KILL-SWITCH.md — must match code pins below. */
const DECISION_RECORD = Object.freeze({
  kill_switch_flags_unread_by_hermes: {
    status: 'resolved-in-this-pr',
    ruling: 'honour-both-flags-fail-closed',
  },
  needs_human_blocks_on_hermes_not_js: {
    status: 'ruled',
    ruling: 'hermes-quiet',
  },
  sunset_needs_human_carveout_defeated: {
    status: 'ruled',
    ruling: 'keep-hermes-fail-closed',
  },
  email_pause_advisory: {
    status: 'ruled',
    ruling: 'fail-closed',
  },
});

let passes = 0;
let failures = 0;

function pass(label) {
  console.log(`  PASS  ${label}`);
  passes += 1;
}

function fail(label, detail) {
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  failures += 1;
}

function check(label, condition, detail) {
  if (condition) pass(label);
  else fail(label, detail);
}

function section(title) {
  console.log(`\n${title}`);
}

// ─── the Python probe ────────────────────────────────────────────────────────────
// One script, three modes. It never imports Hermes itself: `gateway.platforms.base`
// is stubbed in `sys.modules`, which is all `_patched_whatsapp_cloud_send` needs.

const PROBE = String.raw`
import asyncio, contextlib, importlib, importlib.util, io, json, logging, os, sys, types

args = json.loads(sys.argv[1])
hermes_dir = args["hermes_dir"]
sys.path.insert(0, hermes_dir)

RUNTIME_ENV_KEYS = [
    "HERMES_ROLE", "LUNA_CLIENT_SLUG", "LUNA_BOT_INTERNAL_TOKEN",
    "WOLFHOUSE_STAFF_API_BASE_URL", "WHATSAPP_DRY_RUN", "LUNA_AUTO_SEND_ENABLED",
]


def apply_env(env):
    for key in RUNTIME_ENV_KEYS:
        os.environ.pop(key, None)
    for key, value in (env or {}).items():
        os.environ[key] = value


class SendResult:
    """Stand-in for gateway.platforms.base.SendResult (same constructor shape)."""

    def __init__(self, success=False, message_id=None, raw_response=None, **kwargs):
        self.success = success
        self.message_id = message_id
        self.raw_response = raw_response or {}


def install_gateway_stub():
    gateway = types.ModuleType("gateway")
    gateway.__path__ = []
    platforms = types.ModuleType("gateway.platforms")
    platforms.__path__ = []
    base = types.ModuleType("gateway.platforms.base")
    base.SendResult = SendResult
    platforms.base = base
    gateway.platforms = platforms
    sys.modules["gateway"] = gateway
    sys.modules["gateway.platforms"] = platforms
    sys.modules["gateway.platforms.base"] = base


def load_patches():
    spec = importlib.util.spec_from_file_location(
        "wh_apply_gateway_patches", os.path.join(hermes_dir, "apply_gateway_patches.py")
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class _Collect(logging.Handler):
    def __init__(self):
        super().__init__()
        self.records = []

    def emit(self, record):
        payload = record.args if isinstance(record.args, dict) else {}
        self.records.append({
            "logger": record.name,
            "level": record.levelname,
            "payload": payload,
            "message": record.getMessage()[:400],
        })


def run_parity(envs):
    from wolfhouse import send_flags
    out = []
    for env in envs:
        out.append({
            "env": env,
            "whatsapp_dry_run": bool(send_flags.whatsapp_dry_run(env)),
            "luna_auto_send_enabled": bool(send_flags.luna_auto_send_enabled(env)),
            "blocked_reason": (send_flags.guest_whatsapp_send_flag_block("+34600000404", env) or {}).get("blocked_reason"),
        })
    return out


def run_pause(cases):
    from wolfhouse import pause_gate
    out = []
    for case in cases:
        apply_env(case["env"])
        pause_gate._CACHE.clear()
        out.append({
            "id": case["id"],
            "paused": bool(pause_gate.guest_automation_paused(
                case["phone"], client_slug=case["client_slug"], force_refresh=True
            )),
        })
    return out


def run_send(cases):
    install_gateway_stub()
    mod = load_patches()
    out = []
    for case in cases:
        apply_env(case["env"])
        try:
            from wolfhouse import pause_gate
            pause_gate._CACHE.clear()
        except Exception:
            pass

        calls = []

        async def recorder(adapter_self, chat_id, content, reply_to=None, metadata=None):
            calls.append({"chat_id": chat_id, "content": content})
            return SendResult(success=True, message_id="wamid.PROBE", raw_response={"probe": True})

        mod._orig_whatsapp_cloud_send = recorder

        poisoned = case.get("poison_send_flags") is True
        saved = sys.modules.get("wolfhouse.send_flags")
        if poisoned:
            # An importable module that no longer exports the guard: exactly what a
            # half-deployed image looks like from inside the send path.
            sys.modules["wolfhouse.send_flags"] = types.ModuleType("wolfhouse.send_flags")

        handler = _Collect()
        root = logging.getLogger()
        prior_level = root.level
        root.addHandler(handler)
        root.setLevel(logging.INFO)
        err = io.StringIO()
        try:
            with contextlib.redirect_stderr(err):
                result = asyncio.run(
                    mod._patched_whatsapp_cloud_send(object(), case["chat_id"], case["content"])
                )
        except Exception as exc:
            result = None
            err.write(f"PROBE_EXCEPTION {type(exc).__name__}: {exc}")
        finally:
            root.removeHandler(handler)
            root.setLevel(prior_level)
            if poisoned:
                if saved is None:
                    sys.modules.pop("wolfhouse.send_flags", None)
                else:
                    sys.modules["wolfhouse.send_flags"] = saved

        out.append({
            "id": case["id"],
            "provider_calls": len(calls),
            "sent_content": calls[0]["content"] if calls else None,
            "success": getattr(result, "success", None),
            "message_id": getattr(result, "message_id", None),
            "raw_response": getattr(result, "raw_response", None),
            "stderr": err.getvalue(),
            "logs": handler.records,
        })
    return out


mode = args["mode"]
if mode == "parity":
    print(json.dumps(run_parity(args["envs"])))
elif mode == "pause":
    print(json.dumps(run_pause(args["cases"])))
elif mode == "send":
    print(json.dumps(run_send(args["cases"])))
else:
    raise SystemExit(f"unknown probe mode {mode}")
`;

let PYTHON = null;

async function resolvePython() {
  const candidates = [
    ['python3', []],
    ['python', []],
    ['py', ['-3']],
  ];
  for (const [bin, prefix] of candidates) {
    try {
      await execFileAsync(bin, [...prefix, '-c', 'import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)']);
      return { bin, prefix };
    } catch (_) {
      // try the next one
    }
  }
  return null;
}

async function probe(payload) {
  const { stdout } = await execFileAsync(
    PYTHON.bin,
    [...PYTHON.prefix, '-c', PROBE, JSON.stringify(payload)],
    { cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 },
  );
  return JSON.parse(stdout.trim().split('\n').pop());
}

// ─── the loopback Staff API ──────────────────────────────────────────────────────
// Real gate response shapes, keyed by guest phone, so `pause_gate.py` makes a real
// HTTP call and decides for itself. `requests` also lets the gate prove the flag
// check runs *before* the network call.

const GATE_RESPONSES = {
  // Nothing paused, nothing flagged: automation may continue.
  '+34600000404': {
    success: true,
    bot_paused: false,
    live_send_blocked: false,
    can_continue_guest_automation: true,
    paused: false,
    global_paused: false,
    conversation_paused: false,
    needs_human: false,
    source: 'no_pause_row',
  },
  // A staff pause row on the conversation.
  '+34600000909': {
    success: true,
    bot_paused: true,
    live_send_blocked: true,
    can_continue_guest_automation: false,
    paused: true,
    global_paused: false,
    conversation_paused: true,
    needs_human: false,
    source: 'bot_pause_states',
  },
  // Wolfhouse: needs_human with no pause row. The Staff API calls this an effective
  // pause; the legacy JS route never reads needs_human at all. Divergence (a).
  '+34600000505': {
    success: true,
    bot_paused: true,
    live_send_blocked: false,
    can_continue_guest_automation: false,
    paused: true,
    global_paused: false,
    conversation_paused: false,
    needs_human: true,
    source: 'conversations_needs_human',
  },
  // Sunset: the Staff API's deliberate carve-out — flagged for a human, yet
  // automation is explicitly allowed to continue. Divergence (b).
  '+34600000707': {
    success: true,
    bot_paused: false,
    live_send_blocked: false,
    can_continue_guest_automation: true,
    paused: false,
    global_paused: false,
    conversation_paused: false,
    needs_human: true,
    source: 'conversations_needs_human_sunset_carveout',
  },
};

function startGateServer() {
  const state = { requests: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (_) {
        body = {};
      }
      state.requests.push(body);
      const known = GATE_RESPONSES[String(body.guest_phone || '')];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(known || { success: false, lookup_error: true }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      state.port = server.address().port;
      state.baseUrl = `http://127.0.0.1:${state.port}`;
      state.close = () => new Promise((done) => server.close(done));
      resolve(state);
    });
  });
}

// ─── env matrix ──────────────────────────────────────────────────────────────────
// Every shape an operator can plausibly leave these flags in, including the ones
// that look like "off" but are not the literal the JS side demands.

const FLAG_VALUES = [null, '', 'true', 'TRUE', ' true ', 'false', 'FALSE', ' false ', '0', '1', 'off', 'on', 'yes', 'no', 'True', 'nope'];

function buildEnvMatrix() {
  const envs = [];
  for (const dryRun of FLAG_VALUES) {
    for (const autoSend of FLAG_VALUES) {
      const env = {};
      if (dryRun !== null) env.WHATSAPP_DRY_RUN = dryRun;
      if (autoSend !== null) env.LUNA_AUTO_SEND_ENABLED = autoSend;
      envs.push(env);
    }
  }
  return envs;
}

/** What the shipped JS route decides for the same env, on a Luna auto-reply. */
function jsVerdict(env) {
  const autoSendBlocked = collectEnvGateReasons(env, 'ask_missing_field').includes('luna_auto_send_not_enabled');
  return {
    whatsapp_dry_run: isWhatsappDryRun(env),
    luna_auto_send_enabled: !autoSendBlocked,
    blocked_reason: autoSendBlocked
      ? 'luna_auto_send_not_enabled'
      : (isWhatsappDryRun(env) ? 'whatsapp_dry_run_active' : null),
  };
}

// ─── send cases ──────────────────────────────────────────────────────────────────

const OPEN_FLAGS = { WHATSAPP_DRY_RUN: 'false', LUNA_AUTO_SEND_ENABLED: 'true' };
const GUEST_TEXT = 'Hola! Te confirmo la cama para el viernes.';

function sendCases(baseUrl) {
  const runtime = {
    HERMES_ROLE: 'luna',
    LUNA_CLIENT_SLUG: 'wolfhouse-somo',
    LUNA_BOT_INTERNAL_TOKEN: 'probe-token',
    WOLFHOUSE_STAFF_API_BASE_URL: baseUrl,
  };
  const active = '+34600000404';
  const paused = '+34600000909';
  return [
    { id: 'nothing_set', chat_id: active, content: GUEST_TEXT, env: { ...runtime } },
    {
      id: 'dry_run_off_but_auto_send_unset',
      chat_id: active,
      content: GUEST_TEXT,
      env: { ...runtime, WHATSAPP_DRY_RUN: 'false' },
    },
    {
      id: 'auto_send_on_but_dry_run_unset',
      chat_id: active,
      content: GUEST_TEXT,
      env: { ...runtime, LUNA_AUTO_SEND_ENABLED: 'true' },
    },
    {
      id: 'dry_run_zero_is_not_false',
      chat_id: active,
      content: GUEST_TEXT,
      env: { ...runtime, LUNA_AUTO_SEND_ENABLED: 'true', WHATSAPP_DRY_RUN: '0' },
    },
    {
      id: 'auto_send_yes_is_not_true',
      chat_id: active,
      content: GUEST_TEXT,
      env: { ...runtime, LUNA_AUTO_SEND_ENABLED: 'yes', WHATSAPP_DRY_RUN: 'false' },
    },
    {
      id: 'both_open_gate_clear',
      chat_id: active,
      content: GUEST_TEXT,
      env: { ...runtime, ...OPEN_FLAGS },
    },
    {
      id: 'both_open_conversation_paused',
      chat_id: paused,
      content: GUEST_TEXT,
      env: { ...runtime, ...OPEN_FLAGS },
    },
    {
      id: 'both_open_staff_api_unreachable',
      chat_id: active,
      content: GUEST_TEXT,
      // Port 1 on loopback: nothing listens, so the pause lookup fails.
      env: { ...runtime, ...OPEN_FLAGS, WOLFHOUSE_STAFF_API_BASE_URL: 'http://127.0.0.1:1' },
    },
    {
      id: 'guard_module_broken',
      chat_id: active,
      content: GUEST_TEXT,
      env: { ...runtime, ...OPEN_FLAGS },
      poison_send_flags: true,
    },
  ];
}

function byId(rows) {
  return new Map(rows.map((r) => [r.id, r]));
}

function blocked(row) {
  return row.provider_calls === 0;
}

function flagLog(row) {
  return (row.logs || []).find((r) => (r.payload || {}).event === 'guest_send_blocked_by_flag') || null;
}

// ─── mutants ─────────────────────────────────────────────────────────────────────

const MUTANTS = [
  {
    id: 'guard_removed_from_send_patch',
    what: 'the kill-switch block is deleted from _patched_whatsapp_cloud_send',
    apply(dir) {
      const file = path.join(dir, 'apply_gateway_patches.py');
      const src = fs.readFileSync(file, 'utf8');
      const start = src.indexOf('    # WhatsApp kill switches');
      const end = src.indexOf('    # Staff Portal pause gate', start);
      if (start < 0 || end <= start) throw new Error('kill-switch block anchors not found');
      fs.writeFileSync(file, src.slice(0, start) + src.slice(end), 'utf8');
      return !fs.readFileSync(file, 'utf8').includes('wolfhouse.send_flags');
    },
  },
  {
    id: 'dry_run_flag_stops_being_read',
    what: 'whatsapp_dry_run() always returns False',
    apply(dir) {
      const file = path.join(dir, 'wolfhouse/send_flags.py');
      const src = fs.readFileSync(file, 'utf8');
      const anchor = '    raw = _read(env, DRY_RUN_ENV)\n    if raw is None:\n        return True\n    return raw.strip().lower() != "false"';
      if (!src.includes(anchor)) throw new Error('whatsapp_dry_run body not found');
      fs.writeFileSync(file, src.replace(anchor, '    return False'), 'utf8');
      return true;
    },
  },
  {
    id: 'auto_send_flag_read_as_truthy',
    what: 'luna_auto_send_enabled() accepts any non-empty value',
    apply(dir) {
      const file = path.join(dir, 'wolfhouse/send_flags.py');
      const src = fs.readFileSync(file, 'utf8');
      const anchor = '    raw = _read(env, AUTO_SEND_ENV)\n    if raw is None:\n        return False\n    return raw.strip().lower() == "true"';
      if (!src.includes(anchor)) throw new Error('luna_auto_send_enabled body not found');
      fs.writeFileSync(file, src.replace(anchor, '    return bool(_read(env, AUTO_SEND_ENV))'), 'utf8');
      return true;
    },
  },
];

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

/** Re-run the two load-bearing observations against a mutated copy of the tree. */
async function observeMutant(dir, baseUrl) {
  const envMatrix = buildEnvMatrix();
  let parityDrift = 0;
  try {
    const parity = await probe({ mode: 'parity', hermes_dir: dir, envs: envMatrix });
    for (const row of parity) {
      const expected = jsVerdict(row.env);
      if (row.whatsapp_dry_run !== expected.whatsapp_dry_run
        || row.luna_auto_send_enabled !== expected.luna_auto_send_enabled) parityDrift += 1;
    }
  } catch (_) {
    parityDrift = -1; // probe itself broke: also a detected failure
  }

  let escaped = 0;
  try {
    const cases = sendCases(baseUrl).filter((c) => !c.poison_send_flags && c.id !== 'both_open_gate_clear');
    const rows = await probe({ mode: 'send', hermes_dir: dir, cases });
    escaped = rows.filter((r) => r.provider_calls > 0).length;
  } catch (_) {
    escaped = -1;
  }
  return { parityDrift, escaped };
}

// ─── divergence (c): the staff email Luna draft arm ──────────────────────────────
// Behavioural, not a source read: the shipped route is driven with a conversation
// whose thread is paused, and every SQL statement it issues is recorded.

const EMAIL_IDS = {
  client: '11111111-1111-4111-8111-111111111111',
  location: '22222222-2222-4222-8222-222222222222',
  endpoint: '33333333-3333-4333-8333-333333333333',
  conversation: '44444444-4444-4444-8444-444444444444',
  staff: '55555555-5555-4555-8555-555555555555',
  message: '66666666-6666-4666-8666-666666666666',
  mailbox: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  approval: '77777777-7777-4777-8777-777777777777',
};
const EMAIL_ORIGIN = 'https://staff.sunset.test';

function emailAuthorityRow() {
  return {
    client_id: EMAIL_IDS.client,
    client_slug: 'sunset',
    location_id: EMAIL_IDS.location,
    location_key: 'sunset-somo',
    endpoint_id: EMAIL_IDS.endpoint,
    conversation_id: EMAIL_IDS.conversation,
    inbound_message_id: EMAIL_IDS.message,
    channel: 'email',
    provider: 'microsoft_graph',
    provider_mailbox_id: EMAIL_IDS.mailbox,
    provider_source_message_id: 'graph-message-v1',
    endpoint_provider_mailbox_id: EMAIL_IDS.mailbox,
    event_location_id: EMAIL_IDS.location,
    subject: 'Booking question',
    body_text: 'Hola, tengo una duda sobre la reserva.',
    quoted_history: '',
    from_display_name: 'Ana',
    from_address: 'ana@example.test',
    conversation_deleted_at: null,
    conversation_status: 'open',
    latest_message_id: EMAIL_IDS.message,
    luna_draft_enabled: true,
  };
}

async function runPausedEmailDraft() {
  const sqlSeen = [];
  const sent = [];
  const actor = Object.freeze(Object.assign(Object.create(null), {
    staff_user_id: EMAIL_IDS.staff,
    client_id: EMAIL_IDS.client,
    role: 'operator',
  }));

  const route = createStaffEmailLunaDraftRoute({
    sendJSON: (_res, status, body) => { sent.push({ status, body }); return body; },
    runtimeEnv: {
      LUNA_DEPLOYMENT: 'sunset-staging',
      STAFF_PORTAL_ORIGIN: EMAIL_ORIGIN,
      [EMAIL_LUNA_GENERATE_DRAFT_ENABLED_ENV]: 'true',
      EMAIL_LUNA_DRAFT_RUNTIME_ENABLED: 'true',
    },
    // This conversation is paused: a `bot_pause_states` row exists and would be
    // returned by any lookup. The route never asks.
    withPgClient: async (fn) => fn({
      async query(sql) {
        sqlSeen.push(String(sql));
        if (/bot_pause_states/.test(String(sql))) {
          return { rows: [{ paused: true, client_slug: 'sunset', conversation_id: EMAIL_IDS.conversation }] };
        }
        return { rows: [emailAuthorityRow()] };
      },
    }),
    createLunaRuntime: () => ({
      async authorDraft() {
        return Object.freeze(Object.assign(Object.create(null), {
          status: 'draft_ready',
          subject: 'Re: Booking question',
          body: 'Hola Ana,\n\nTe cuento las opciones.\n\nUn abrazo,\nLuna',
          language: 'es',
          client_id: EMAIL_IDS.client,
          location_id: EMAIL_IDS.location,
          conversation_id: EMAIL_IDS.conversation,
          draft_only: true,
          requires_staff_review: true,
          send_allowed: false,
          auto_send_allowed: false,
        }));
      },
    }),
    saveDraftThroughStaffOwner: async () => Object.freeze({
      status: 'saved',
      conversation_id: EMAIL_IDS.conversation,
      approval_id: EMAIL_IDS.approval,
    }),
  });

  const req = new (require('events').EventEmitter)();
  req.headers = { 'content-type': 'application/json', origin: EMAIL_ORIGIN };
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify({ conversation_id: EMAIL_IDS.conversation })));
    req.emit('end');
  });
  await route.handleGenerateLunaDraft(req, {}, actor, snapshotEmailLunaGenerateGateEnv(route.runtimeEnv));

  return { outcome: sent.at(-1), sqlSeen };
}

// ─── the decision record ─────────────────────────────────────────────────────────

function parseDecisionRecord(src) {
  const rows = new Map();
  // | `id` | question | `status` | `ruling` |
  const re = /^\|\s*`([a-z0-9_]+)`\s*\|[^|]*\|\s*`([a-z-]+)`\s*\|\s*`([a-z0-9-]+)`\s*\|/gm;
  let m = re.exec(src);
  while (m) {
    rows.set(m[1], { status: m[2], ruling: m[3] });
    m = re.exec(src);
  }
  return rows;
}

// ─── main ────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nverify-hermes-send-flags — can the kill switch stop a send on the path that runs?\n');

  PYTHON = await resolvePython();
  if (!PYTHON) {
    // Not a skip. The entire claim of this gate is about Python behaviour, and an
    // unverifiable kill switch is a red one.
    fail('a python3 interpreter is available',
      'tried python3, python, py -3 — the Hermes guard cannot be proven without one');
    console.log(`\nverify-hermes-send-flags: ${passes} passed, ${failures} failed\n`);
    process.exit(1);
  }
  pass(`python interpreter found (${[PYTHON.bin, ...PYTHON.prefix].join(' ')})`);

  const gate = await startGateServer();
  let sendRows = null;
  try {
    // ── [1] Flag parsing ⇄ the shipped JS predicates ──────────────────────────
    section('[1] Flag parsing — wolfhouse/send_flags.py ⇄ the shipped JS predicates');
    {
      const envs = buildEnvMatrix();
      const parity = await probe({ mode: 'parity', hermes_dir: HERMES_DIR, envs });
      check(`env matrix covers ${envs.length} combinations of the two flags`,
        parity.length === envs.length, `${parity.length} rows`);

      const drift = [];
      const reasonDrift = [];
      for (const row of parity) {
        const expected = jsVerdict(row.env);
        if (row.whatsapp_dry_run !== expected.whatsapp_dry_run
          || row.luna_auto_send_enabled !== expected.luna_auto_send_enabled) {
          drift.push(`${JSON.stringify(row.env)} python(dry=${row.whatsapp_dry_run},auto=${row.luna_auto_send_enabled}) js(dry=${expected.whatsapp_dry_run},auto=${expected.luna_auto_send_enabled})`);
        }
        if (row.blocked_reason !== expected.blocked_reason) {
          reasonDrift.push(`${JSON.stringify(row.env)} python=${row.blocked_reason} js=${expected.blocked_reason}`);
        }
      }
      check('Python reads both flags exactly as the shipped JS predicates do',
        drift.length === 0, drift.slice(0, 4).join(' | '));
      check('and names the blocking reason with the JS route\'s own vocabulary',
        reasonDrift.length === 0, reasonDrift.slice(0, 4).join(' | '));

      const unset = parity.find((r) => Object.keys(r.env).length === 0);
      check('nothing set at all ⇒ dry run on, auto-send off, send blocked',
        unset.whatsapp_dry_run === true
        && unset.luna_auto_send_enabled === false
        && unset.blocked_reason === 'luna_auto_send_not_enabled',
        JSON.stringify(unset));
      const onlyLiteral = parity.filter((r) => r.blocked_reason === null);
      check('the only env that permits a send is the literal false/true pair',
        onlyLiteral.every((r) => String(r.env.WHATSAPP_DRY_RUN).trim().toLowerCase() === 'false'
          && String(r.env.LUNA_AUTO_SEND_ENABLED).trim().toLowerCase() === 'true'),
        `${onlyLiteral.length} permissive envs`);
    }

    // ── [2] The real send path ────────────────────────────────────────────────
    section('[2] The shipped send path — _patched_whatsapp_cloud_send, run for real');
    {
      const cases = sendCases(gate.baseUrl);
      sendRows = byId(await probe({ mode: 'send', hermes_dir: HERMES_DIR, cases }));
      check(`ran the patched send for ${cases.length} runtime states`, sendRows.size === cases.length);

      for (const id of ['nothing_set', 'dry_run_off_but_auto_send_unset', 'auto_send_on_but_dry_run_unset',
        'dry_run_zero_is_not_false', 'auto_send_yes_is_not_true']) {
        const row = sendRows.get(id);
        check(`${id}: nothing reaches the provider`, blocked(row),
          `provider called ${row.provider_calls}×`);
      }

      const nothingSet = sendRows.get('nothing_set');
      check('a blocked send returns success without a message id (no retry storm)',
        nothingSet.success === true && nothingSet.message_id === null,
        JSON.stringify({ success: nothingSet.success, message_id: nothingSet.message_id }));
      check('the SendResult says which flag suppressed it',
        (nothingSet.raw_response || {}).suppressed_guest_send_flag === true
        && nothingSet.raw_response.blocked_reason === 'luna_auto_send_not_enabled'
        && nothingSet.raw_response.flag === 'LUNA_AUTO_SEND_ENABLED',
        JSON.stringify(nothingSet.raw_response));

      const zero = sendRows.get('dry_run_zero_is_not_false');
      check('WHATSAPP_DRY_RUN=0 blocks and is reported as dry run, not as a typo swallowed',
        (zero.raw_response || {}).blocked_reason === 'whatsapp_dry_run_active',
        JSON.stringify(zero.raw_response));

      const open = sendRows.get('both_open_gate_clear');
      check('with both flags set to the literal values, the message does go out',
        open.provider_calls === 1 && open.success === true,
        `provider called ${open.provider_calls}×, success=${open.success}`);
      check('and it is the guest text that goes out, unaltered',
        open.sent_content === GUEST_TEXT, String(open.sent_content));

      const paused = sendRows.get('both_open_conversation_paused');
      check('the pause gate still blocks when the flags are open (existing behaviour intact)',
        blocked(paused)
        && (paused.raw_response || {}).suppressed_guest_automation_paused === true,
        JSON.stringify(paused.raw_response));

      const unreachable = sendRows.get('both_open_staff_api_unreachable');
      check('an unreachable Staff API still fails closed',
        blocked(unreachable), `provider called ${unreachable.provider_calls}×`);

      const brokenGuard = sendRows.get('guard_module_broken');
      check('a guard module that cannot be imported blocks the send rather than falling through',
        blocked(brokenGuard)
        && (brokenGuard.raw_response || {}).blocked_reason === 'send_flag_guard_error',
        JSON.stringify(brokenGuard.raw_response));
      check('and says so where an operator will see it',
        /send_flag_guard_error/.test(brokenGuard.stderr), brokenGuard.stderr.slice(0, 200));
    }

    // ── [3] A blocked send is observable ──────────────────────────────────────
    section('[3] Observability — a suppressed message is an event, not a silence');
    {
      const nothingSet = sendRows.get('nothing_set');
      const log = flagLog(nothingSet);
      check('a blocked send emits a warning log record', log !== null && log.level === 'WARNING',
        JSON.stringify((nothingSet.logs || []).map((l) => l.payload.event)));
      check('the record follows the pause_gate {"event": …} shape',
        log && log.payload.event === 'guest_send_blocked_by_flag' && log.payload.sent === false,
        JSON.stringify(log && log.payload));
      check('the record names the flag, its value and the value that would allow sending',
        log && log.payload.flag === 'LUNA_AUTO_SEND_ENABLED'
        && log.payload.allow_value === 'true'
        && log.payload.flag_note === 'unset',
        JSON.stringify(log && log.payload));
      check('the record reports both flags, so a two-flag misconfiguration takes one round trip',
        log && log.payload.flags
        && log.payload.flags.whatsapp_dry_run === true
        && log.payload.flags.luna_auto_send_enabled === false,
        JSON.stringify(log && log.payload.flags));
      check('container logs carry a line naming the flag and the fix',
        /LUNA_AUTO_SEND_ENABLED=true/.test(nothingSet.stderr)
        && /hermes-luna\.env/.test(nothingSet.stderr),
        nothingSet.stderr.slice(0, 240));
      check('the suppressed line reads like the pause one it sits next to',
        /^\[wolfhouse\] send blocked/.test(nothingSet.stderr.trim()),
        nothingSet.stderr.slice(0, 120));
      check('the guest phone is not printed in full',
        !/\+?34600000404/.test(nothingSet.stderr), nothingSet.stderr.slice(0, 240));

      const dryRow = sendRows.get('auto_send_on_but_dry_run_unset');
      check('the dry-run block is logged too, naming WHATSAPP_DRY_RUN',
        /WHATSAPP_DRY_RUN=false/.test(dryRow.stderr), dryRow.stderr.slice(0, 240));
    }

    // ── [4] Ordering: the flag check costs nothing and runs first ─────────────
    section('[4] Ordering — a dry-run runtime does not even ask the Staff API');
    {
      const before = gate.requests.length;
      await probe({
        mode: 'send',
        hermes_dir: HERMES_DIR,
        cases: [{
          id: 'ordering',
          chat_id: '+34600000404',
          content: GUEST_TEXT,
          env: {
            HERMES_ROLE: 'luna',
            LUNA_CLIENT_SLUG: 'wolfhouse-somo',
            LUNA_BOT_INTERNAL_TOKEN: 'probe-token',
            WOLFHOUSE_STAFF_API_BASE_URL: gate.baseUrl,
          },
        }],
      });
      check('a flag-blocked send makes no pause-gate call at all',
        gate.requests.length === before, `${gate.requests.length - before} gate requests`);

      const beforeOpen = gate.requests.length;
      await probe({
        mode: 'send',
        hermes_dir: HERMES_DIR,
        cases: [{
          id: 'ordering_open',
          chat_id: '+34600000404',
          content: GUEST_TEXT,
          env: {
            HERMES_ROLE: 'luna',
            LUNA_CLIENT_SLUG: 'wolfhouse-somo',
            LUNA_BOT_INTERNAL_TOKEN: 'probe-token',
            WOLFHOUSE_STAFF_API_BASE_URL: gate.baseUrl,
            ...OPEN_FLAGS,
          },
        }],
      });
      check('with the flags open the pause gate is consulted, as before',
        gate.requests.length === beforeOpen + 1, `${gate.requests.length - beforeOpen} gate requests`);
    }

    // ── [5] Teeth: mutate the guard, watch the gate notice ───────────────────
    section('[5] Teeth — three mutants, each of which must break something');
    {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-send-flags-mutant-'));
      try {
        // Control: an unmutated copy behaves like the real tree, so a mutant's
        // failure is the mutation and not the copying.
        const controlDir = path.join(tmpRoot, 'control');
        copyTree(HERMES_DIR, controlDir);
        const control = await observeMutant(controlDir, gate.baseUrl);
        check('control copy: no parity drift and no send escapes',
          control.parityDrift === 0 && control.escaped === 0,
          JSON.stringify(control));

        for (const mutant of MUTANTS) {
          const dir = path.join(tmpRoot, mutant.id);
          copyTree(HERMES_DIR, dir);
          let applied = false;
          try {
            applied = mutant.apply(dir) !== false;
          } catch (err) {
            fail(`mutant ${mutant.id} could be applied`, err.message);
            continue;
          }
          if (!applied) {
            fail(`mutant ${mutant.id} could be applied`, 'mutation reported no change');
            continue;
          }
          const observed = await observeMutant(dir, gate.baseUrl);
          const detected = observed.parityDrift !== 0 || observed.escaped !== 0;
          check(`${mutant.id} is caught (${mutant.what})`, detected,
            `parity drift ${observed.parityDrift}, sends escaped ${observed.escaped}`);
          console.log(`        ↳ ${mutant.id}: parity drift ${observed.parityDrift}, sends escaped ${observed.escaped}`);
        }
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    }

    // ── [6] Rulings (a) + (b): Hermes is staging SoT; keep fail-closed ────────
    section('[6] Rulings (a) + (b) — needs_human, Hermes quiet / carve-out fail-closed');
    {
      const runtime = (slug) => ({
        HERMES_ROLE: 'luna',
        LUNA_CLIENT_SLUG: slug,
        LUNA_BOT_INTERNAL_TOKEN: 'probe-token',
        WOLFHOUSE_STAFF_API_BASE_URL: gate.baseUrl,
      });
      const pauseRows = byId(await probe({
        mode: 'pause',
        hermes_dir: HERMES_DIR,
        cases: [
          { id: 'wolfhouse_needs_human', phone: '+34600000505', client_slug: 'wolfhouse-somo', env: runtime('wolfhouse-somo') },
          { id: 'sunset_carveout', phone: '+34600000707', client_slug: 'sunset', env: runtime('sunset') },
          { id: 'clear', phone: '+34600000404', client_slug: 'wolfhouse-somo', env: runtime('wolfhouse-somo') },
        ],
      }));

      // The same conversation state, put to the JS resolver (legacy; unchanged this PR).
      const jsSide = (needsHuman) => resolveLunaEffectiveMode({
        client_slug: 'wolfhouse-somo',
        channel: 'whatsapp',
        send_kind: 'ask_missing_field',
        needs_human: needsHuman,
        send_eligibility: { requires_staff: false, send_allowed_later: true, auto_send_ready: true },
        flags: { luna_auto_send_enabled: true, whatsapp_dry_run: false },
      });

      // Ruling (a): Hermes quiet is correct. Staging source of truth.
      check('(a) Hermes goes quiet on a needs_human thread with no pause row (ruling: hermes-quiet)',
        pauseRows.get('wolfhouse_needs_human').paused === true);
      check('(a) the JS legacy path still replies — unchanged this PR; needs_human advisory there',
        jsSide(true).mode === 'auto' && jsSide(true).advisory_reasons.includes('needs_human'),
        JSON.stringify(jsSide(true)));
      // Ruling (b): keep Hermes fail-closed; do not open the Python carve-out.
      check('(b) Sunset carve-out response still fails closed in pause_gate (ruling: keep-hermes-fail-closed)',
        pauseRows.get('sunset_carveout').paused === true,
        'opening the carve-out in Python would break this pin — that is not the ruling');
      check('a thread with nothing flagged is not blocked (the gate is not a brick)',
        pauseRows.get('clear').paused === false);
    }

    // ── [7] Ruling (c): email arm must be fail-closed; observe unpaid gap ─────
    section('[7] Ruling (c) — email arm fail-closed (pin ruling; observe shipped gap)');
    {
      const { outcome, sqlSeen } = await runPausedEmailDraft();
      // The prerequisite boundary now fails closed before generation regardless of
      // pause state; pause wiring remains a separate future concern if generation exists.
      check('(c) decision record pins email as fail-closed (see [8])',
        DECISION_RECORD.email_pause_advisory.ruling === 'fail-closed');
      check('(c) unavailable email generation cannot draft on a paused thread',
        outcome && outcome.status === 503 && outcome.body.success === false
        && outcome.body.error === 'luna_email_generation_capability_unavailable'
        && outcome.body.reason === 'authoritative_content_and_grounded_policy_not_configured',
        JSON.stringify(outcome && { status: outcome.status, error: outcome.body && outcome.body.error }));
      check('(c) unavailable route never asks bot_pause_states',
        sqlSeen.length > 0 && !sqlSeen.some((sql) => /bot_pause_states/.test(sql)),
        `${sqlSeen.length} statements issued`);
    }

    // ── [8] The decision record ──────────────────────────────────────────────
    section('[8] Decision record — code and document say the same thing');
    {
      const exists = fs.existsSync(DECISIONS_DOC);
      check('docs/LUNA-SEND-KILL-SWITCH.md exists', exists);
      if (exists) {
        const rows = parseDecisionRecord(fs.readFileSync(DECISIONS_DOC, 'utf8'));
        check('the document records exactly the four decisions this work found',
          [...rows.keys()].sort().join(',') === [...DECISION_IDS].sort().join(','),
          `found [${[...rows.keys()].join(', ')}]`);
        const badStatus = [...rows.entries()]
          .filter(([, row]) => !DECISION_STATUSES.includes(row.status));
        check('every decision carries a known status',
          badStatus.length === 0, badStatus.map(([id, row]) => `${id}=${row.status}`).join(' '));

        for (const id of DECISION_IDS) {
          const expected = DECISION_RECORD[id];
          const got = rows.get(id) || {};
          check(`${id} status is ${expected.status}`,
            got.status === expected.status, `status=${got.status}`);
          check(`${id} ruling is ${expected.ruling}`,
            got.ruling === expected.ruling, `ruling=${got.ruling}`);
        }
      }
    }
  } finally {
    await gate.close();
  }

  console.log(`\nverify-hermes-send-flags: ${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
