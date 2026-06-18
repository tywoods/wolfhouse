'use strict';

/*
 * Luna booking debrief — Phase-1 self-improvement loop (manual trigger).
 *
 * Reads a REAL guest conversation from the live hermes-luna agent store
 * (/opt/data/state.db on Lunabox: messages + tool_calls per session), runs the
 * failure detectors over what Luna actually said and did, enriches with the
 * booking's payment state via the bot API, and prints a structured debrief:
 * what went right, what went wrong, root cause, and the golden fixture to lock.
 *
 * This is the automated version of the by-hand debrief we did for Borja
 * (MB-WOLFHO-20261001 — transfer not logged, yoga billed-but-unscheduled).
 *
 * Usage (run on Lunabox — needs the live container):
 *   node scripts/luna-debrief-booking.js --booking MB-WOLFHO-20261001-f2787b
 *   node scripts/luna-debrief-booking.js --session 20260618_074816_f8def735
 *   node scripts/luna-debrief-booking.js --phone 496134147234 [--json]
 *
 * SIM_DOCKER="sudo docker" on hosts where node lacks docker-group access.
 */

const { execFileSync } = require('child_process');

const CONTAINER = process.env.HERMES_CONTAINER || 'hermes-luna';
const DOCKER = (process.env.SIM_DOCKER || 'docker').trim().split(/\s+/);
const dockerArgs = (rest) => [...DOCKER.slice(1), ...rest];

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
function arg(name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; }
const SEL = { session: arg('--session'), booking: arg('--booking'), phone: arg('--phone') };
if (!SEL.session && !SEL.booking && !SEL.phone) {
  console.error('need one of --session <id> | --booking <code> | --phone <digits>');
  process.exit(2);
}

const BOOKING_CODE_RE = /\b[A-Z]{2}-WOLFHO-\d{8}-[0-9a-fA-F]{6}\b/g;
const LEAK_PHRASES = ['il sistema', 'sistema non', 'verifica manuale', 'richiede verifica',
  'the system', 'quote tool', 'the tool', 'backend', 'tool call', 'plugin', 'staff-query', '422'];

// ---- pull the real conversation out of the agent store -----------------------
// state.db lives inside the container; extract the resolved session's messages as
// JSON via an embedded python reader (sqlite + FTS), piped over docker exec stdin.
const PY_EXTRACT = `
import sqlite3, json, sys
sel = json.loads(sys.argv[1])
c = sqlite3.connect("/opt/data/state.db")
c.row_factory = sqlite3.Row
sid = sel.get("session")
if not sid and sel.get("booking"):
    # locate the session whose transcript mentions the booking code (FTS, then LIKE)
    code = sel["booking"]; stamp = code.split("-")[2] if code.count("-") >= 2 else code
    try:
        r = list(c.execute("SELECT session_id, COUNT(*) n FROM messages WHERE rowid IN "
                           "(SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?) "
                           "GROUP BY session_id ORDER BY n DESC", (stamp,)))
    except Exception:
        r = []
    if not r:
        r = list(c.execute("SELECT session_id, COUNT(*) n FROM messages WHERE content LIKE ? "
                           "GROUP BY session_id ORDER BY n DESC", ("%"+code+"%",)))
    sid = r[0]["session_id"] if r else None
if not sid and sel.get("phone"):
    ph = "".join(ch for ch in sel["phone"] if ch.isdigit())
    r = list(c.execute("SELECT session_id, MAX(timestamp) t FROM messages WHERE session_id IN "
                       "(SELECT session_id FROM sessions WHERE session_key LIKE ?) "
                       "GROUP BY session_id ORDER BY t DESC", ("%"+ph+"%",)))
    sid = r[0]["session_id"] if r else None
if not sid:
    print(json.dumps({"error": "session not found"})); sys.exit(0)
rows = list(c.execute("SELECT role, content, tool_name, tool_calls, timestamp FROM messages "
                      "WHERE session_id=? AND active=1 ORDER BY id", (sid,)))
msgs = []
for r in rows:
    tc = None
    if r["tool_calls"]:
        try: tc = json.loads(r["tool_calls"])
        except Exception: tc = r["tool_calls"]
    msgs.append({"role": r["role"], "content": r["content"], "tool_name": r["tool_name"],
                 "tool_calls": tc, "timestamp": r["timestamp"]})
print(json.dumps({"session_id": sid, "messages": msgs}))
`;

function pull() {
  const out = execFileSync(DOCKER[0], dockerArgs(['exec', '-i', CONTAINER, 'python3', '-', JSON.stringify(SEL)]),
    { input: PY_EXTRACT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out);
}

function bookingPaymentState(code) {
  try {
    const sh = `BASE=$(grep '^WOLFHOUSE_STAFF_API_BASE_URL=' /opt/data/.env | cut -d= -f2); ` +
      `TOK=$(grep '^LUNA_BOT_INTERNAL_TOKEN=' /opt/data/.env | cut -d= -f2); ` +
      `curl -s -X POST "$BASE/staff/bot/payments/status" -H "X-Luna-Bot-Token: $TOK" ` +
      `-H 'Content-Type: application/json' -d '{"client_slug":"wolfhouse-somo","booking_code":"${code}"}'`;
    const out = execFileSync(DOCKER[0], dockerArgs(['exec', CONTAINER, 'sh', '-lc', sh]),
      { encoding: 'utf8', timeout: 30000 });
    return JSON.parse(out);
  } catch (_) { return null; }
}

// ---- detectors ---------------------------------------------------------------
// Each returns {ok, severity, title, detail, fix} — the failure modes the loop
// learns from. Borja's two misses (transfer, scheduling) are first-class here.
function toolNames(msgs) {
  const names = [];
  for (const m of msgs) {
    if (m.tool_name) names.push(m.tool_name);
    for (const t of (Array.isArray(m.tool_calls) ? m.tool_calls : []))
      if (t && (t.name || (t.function && t.function.name))) names.push(t.name || t.function.name);
  }
  return names;
}
function assistantText(msgs) {
  return msgs.filter((m) => m.role === 'assistant' && m.content).map((m) => m.content).join('\n');
}
function guestText(msgs) {
  return msgs.filter((m) => m.role === 'user' && m.content).map((m) => m.content).join('\n').toLowerCase();
}

function detect(trace, pay) {
  const msgs = trace.messages || [];
  const tools = toolNames(msgs);
  const reply = assistantText(msgs);
  const guest = guestText(msgs);
  const findings = [];
  const has = (n) => tools.includes(n);

  // 1. Transfer logged? Fires when the guest raised it, OR for a package booking
  // (Malibu/Uluwatu/Waimea include the free shuttle, so Luna must address + log it) —
  // the Borja case: package booked, shuttle never logged.
  const shuttleWanted = /(shuttle|transfer|pick.?up|airport|recogida|traslado|navetta)/.test(guest);
  const packageBooking = has('create_booking_from_plan') && /(malibu|uluwatu|waimea)/.test((guest + '\n' + reply).toLowerCase());
  if ((shuttleWanted || packageBooking) && !has('save_transfer_request')) {
    findings.push({ ok: false, severity: 'high', title: 'shuttle/transfer never logged',
      detail: (packageBooking ? 'Package booking (shuttle included) ' : 'Guest raised the shuttle ') +
        'but save_transfer_request was never called → no transfer on the booking record (the Borja transfer miss).',
      fix: 'SOUL: for package bookings address the shuttle, and after create always save_transfer_request (booking_code + direction[s]) even before times are known; not handled until write_performed:true.' });
  }

  // 2. Dated service scheduled, or billed-but-hanging?
  const addedService = has('add_service_to_booking');
  const datedServiceWanted = /(yoga|lesson|lezione|clase|class|surf lesson)/.test(guest);
  if (addedService || datedServiceWanted) {
    const scheduledOnDate = msgs.some((m) => JSON.stringify(m.tool_calls || '').includes('service_date'));
    if (!scheduledOnDate) {
      findings.push({ ok: false, severity: 'high', title: 'dated service billed but not scheduled',
        detail: 'A dated service (yoga/lesson) was added without a service_date → billed but never placed on a day (the Borja yoga miss).',
        fix: 'SOUL: ask which day(s) and pass service_date per session on add_service_to_booking; never hand off just to schedule.' });
    }
  }

  // 3. Needless staff handoff
  if (has('flag_needs_human')) {
    findings.push({ ok: false, severity: 'medium', title: 'staff handoff fired',
      detail: 'flag_needs_human was called — confirm it was a genuine human-needed case, not an add-on/scheduling Luna can self-serve.',
      fix: 'If it was scheduling/add-on/transfer, that is a self-serve path — tighten SOUL so she completes it instead of punting.' });
  }

  // 4. Internal leak to the guest
  const leak = LEAK_PHRASES.find((p) => reply.toLowerCase().includes(p));
  if (leak) {
    findings.push({ ok: false, severity: 'high', title: `internal detail leaked to guest ("${leak}")`,
      detail: 'An internal/system phrase reached the guest-facing reply.',
      fix: 'Output-guard scrub + SOUL: never expose system/tool/backend wording.' });
  }

  // 5. Payment-state sanity (from the bot read)
  if (pay && Array.isArray(pay.payment_records)) {
    const addon = pay.payment_records.find((r) => r.payment_kind === 'addon_service');
    if (addon && finding2Unscheduled(msgs)) {
      findings.push({ ok: false, severity: 'info', title: 'add-on charged on the ledger',
        detail: `addon_service payment present (${(addon.amount_due_cents / 100).toFixed(2)} ${pay.payment_records[0].currency || 'EUR'}) — confirm it was scheduled, not just billed.`,
        fix: 'Cross-check finding #2.' });
    }
  }
  return { tools, findings };
}
function finding2Unscheduled(msgs) {
  return !msgs.some((m) => JSON.stringify(m.tool_calls || '').includes('service_date'));
}

// ---- report ------------------------------------------------------------------
function main() {
  const trace = pull();
  if (trace.error) { console.error(`debrief: ${trace.error}`); process.exit(1); }
  const codes = [...new Set((assistantText(trace.messages).match(BOOKING_CODE_RE) || []))];
  const code = SEL.booking || codes[0] || null;
  const pay = code ? bookingPaymentState(code) : null;
  const { tools, findings } = detect(trace, pay);

  if (JSON_OUT) {
    console.log(JSON.stringify({ session_id: trace.session_id, booking_code: code, tools, findings }, null, 2));
    process.exit(findings.some((f) => !f.ok) ? 1 : 0);
  }

  const turns = trace.messages.filter((m) => m.role === 'user').length;
  console.log(`\n=== Luna debrief — session ${trace.session_id} ===`);
  console.log(`booking: ${code || '(none found)'}   guest turns: ${turns}   tools used: ${[...new Set(tools)].join(', ') || 'none'}`);
  if (pay && pay.payment_records) {
    const p = pay.payment_records[0] || {};
    console.log(`payment: ${p.booking_payment_status || '?'} — paid €${((p.amount_paid_cents || 0) / 100).toFixed(0)}, balance €${((p.balance_due_cents || 0) / 100).toFixed(0)}`);
  }
  const issues = findings.filter((f) => !f.ok);
  if (!issues.length) {
    console.log('\n✓ no issues detected — clean run.');
  } else {
    console.log(`\n⚠ ${issues.length} issue(s):`);
    for (const f of issues) {
      console.log(`\n  [${f.severity}] ${f.title}`);
      console.log(`    what: ${f.detail}`);
      console.log(`    fix:  ${f.fix}`);
    }
    console.log('\n  → lock each confirmed issue as a golden fixture so it cannot regress.');
  }
  console.log('');
  process.exit(issues.length ? 1 : 0);
}

main();
