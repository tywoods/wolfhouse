'use strict';

/**
 * verify:staff-broadcasts
 *
 * Offline contract for Inbox Phase 4 email-first segment broadcasts:
 *   POST /staff/broadcasts
 *   GET  /staff/broadcasts/:id
 *   POST /staff/broadcasts/:id/send
 *
 * Proves:
 *   - operator auth + assertStaffClientAccess; denied/hostile client never hit Postgres
 *   - tenant slug is bound on create/get/send (no interpolation)
 *   - channel=whatsapp is rejected with a stable error and no DB write
 *   - do_not_contact view members are stored as skipped, never pending
 *   - send snapshots recipients then 501 email_broadcast_send_not_implemented
 *   - no Graph / WhatsApp Cloud send; send is not flipped to 200/dry-run
 *   - Inbox email composer (inbox-broadcast.js) POSTs create/send and displays the 501
 *     honestly ("queued locally, email delivery not wired yet")
 *
 * No live DB / network / mailbox / Meta.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..');
const MODULE_PATH = path.join(ROOT, 'scripts', 'lib', 'staff-broadcast-routes.js');
const DOMAIN_PATH = path.join(ROOT, 'scripts', 'lib', 'staff-broadcasts.js');
const OUTREACH_PATH = path.join(ROOT, 'scripts', 'lib', 'staff-customer-outreach-send.js');
const API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');
const LUNA_ALL_PATH = path.join(ROOT, 'scripts', 'verify-luna-all.js');
const PACKAGE_PATH = path.join(ROOT, 'package.json');
const SPEC_PATH = path.join(ROOT, 'docs', 'INBOX-PORTAL-REDESIGN.md');
const MIG_UP = path.join(ROOT, 'database', 'migrations', '079_broadcasts.sql');
const MIG_DOWN = path.join(ROOT, 'database', 'migrations', '079_broadcasts_down.sql');
const MIG_078 = path.join(ROOT, 'database', 'migrations', '078_luna_outbound_approvals.sql');

const {
  BROADCASTS_COLLECTION_PATH,
  BROADCAST_ID_PATH,
  BROADCAST_SEND_PATH,
  BROADCAST_ID_RE,
  BROADCAST_SEND_RE,
  BROADCAST_MIN_ROLE,
  BROADCAST_ROUTE_TABLE,
  createBroadcastRoutes,
} = require('./lib/staff-broadcast-routes');
const {
  MAX_BROADCAST_RECIPIENTS,
  CHANNEL_EMAIL,
  CHANNEL_WHATSAPP,
  ERROR_WHATSAPP_NOT_SUPPORTED,
  ERROR_VIEW_NOT_BROADCASTABLE,
  ERROR_SEND_NOT_IMPLEMENTED,
  ERROR_NOT_FOUND,
  SKIP_DO_NOT_CONTACT,
  SKIP_MISSING_EMAIL,
  SQL_INSERT_BROADCAST,
  SQL_SELECT_BROADCAST,
  SQL_SELECT_RECIPIENTS,
  SQL_INSERT_RECIPIENT,
  SQL_MARK_PENDING,
  parseBroadcastCreateBody,
  classifyBroadcastRecipients,
} = require('./lib/staff-broadcasts');
const { readStaffPortalUiSource } = require('./lib/staff-portal-ui-source');
const {
  BROADCAST_MODULE,
  INBOX_BROADCAST_INJECT_MARKER,
  injectInboxBrowserModules,
} = require('./lib/inbox-browser-source');
const { customerIsDoNotContact } = require('./lib/staff-customer-outreach-send');

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
    return true;
  }
  fail += 1;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function norm(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim();
}

function mockRes() {
  const out = { statusCode: 0, headers: {}, body: null, ended: false };
  return {
    out,
    writeHead(code, headers) {
      out.statusCode = code;
      if (headers) Object.assign(out.headers, headers);
    },
    setHeader(k, v) { out.headers[k] = v; },
    end(buf) {
      out.ended = true;
      out.body = buf == null ? '' : String(buf);
    },
  };
}

function parseBody(out) {
  if (!out.body) return null;
  try { return JSON.parse(out.body); } catch (_) { return out.body; }
}

function mockReq(bodyObj) {
  const ee = new EventEmitter();
  ee.headers = Object.assign(Object.create(null), { 'content-type': 'application/json' });
  ee._body = bodyObj;
  return ee;
}

const CLIENT = 'wolfhouse-somo';
const OTHER_CLIENT = 'sunset';
const HOSTILE = "wolf'; DROP TABLE broadcasts; --";
const CID = '11111111-1111-4111-8111-111111111111';
const BID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const STAFF = '55555555-5555-4555-8555-555555555555';

function user(o = {}) {
  return {
    staff_user_id: STAFF,
    client_id: CID,
    client_slug: CLIENT,
    role: 'operator',
    status: 'active',
    ...o,
  };
}

const EMAIL_BODY = {
  view_id: 'checked_in',
  channel: 'email',
  email_subject: 'BBQ tonight at 8pm',
  email_body: 'Hey — we are firing up the grill at 8. Come through if you are around.',
};

function makeDeps(opts = {}) {
  const audit = [];
  const sqlLog = [];
  let dbHits = 0;
  const broadcasts = opts.broadcasts || new Map();
  const recipients = opts.recipients || [];
  const viewRows = opts.viewRows || [];
  const accessDenied = opts.accessDenied === true;

  const deps = {
    DEFAULT_CLIENT: CLIENT,
    SQL_INJECT_RE: /['";\\]|--|\bDROP\b|\bALTER\b|\bTRUNCATE\b/i,
    STAFF_ACTIONS_ENABLED: opts.STAFF_ACTIONS_ENABLED !== false,
    audit,
    sqlLog,
    get dbHits() { return dbHits; },
    broadcasts,
    recipients,
    sendJSON(res, status, body) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
      return body;
    },
    send400(res, message) {
      return deps.sendJSON(res, 400, { success: false, error: message });
    },
    assertStaffClientAccess(u, clientSlug, res) {
      if (accessDenied || (opts.denySlug && clientSlug === opts.denySlug)) {
        deps.sendJSON(res, 403, { success: false, error: 'client_access_denied', client_slug: clientSlug });
        return false;
      }
      return true;
    },
    appendAuditLog(entry) { audit.push(entry); },
    readBody: async (req) => JSON.stringify(req && req._body != null ? req._body : {}),
    async withPgClient(fn) {
      dbHits += 1;
      const client = {
        async query(sql, params) {
          const n = norm(sql);
          sqlLog.push({ sql: n, params: params ? params.slice() : [] });
          if (/INSERT INTO broadcasts/i.test(n)) {
            const row = {
              id: BID,
              client_id: CID,
              client_slug: params[0],
              view_id: params[1],
              channel: params[2],
              email_subject: params[3],
              email_body: params[4],
              status: 'draft',
              created_by_staff_user_id: params[5],
              created_at: '2026-08-13T07:00:00.000Z',
              updated_at: '2026-08-13T07:00:00.000Z',
            };
            broadcasts.set(row.id, row);
            return { rows: [row] };
          }
          if (/FROM broadcasts b/i.test(n) || (/FROM broadcasts\b/i.test(n) && /SELECT/i.test(n))) {
            const id = params[0];
            const slug = params[1];
            const row = broadcasts.get(id);
            if (!row || row.client_slug !== slug) return { rows: [] };
            return { rows: [{ ...row }] };
          }
          if (/FROM broadcast_recipients/i.test(n)) {
            const id = params[0];
            return { rows: recipients.filter((r) => r.broadcast_id === id).map((r) => ({ ...r })) };
          }
          if (/INSERT INTO broadcast_recipients/i.test(n)) {
            const rec = {
              id: `rec-${recipients.length}`,
              client_id: params[0],
              broadcast_id: params[1],
              phone: params[2],
              email: params[3],
              display_name: params[4],
              status: params[5],
              skip_reason: params[6],
              created_at: '2026-08-13T07:00:01.000Z',
            };
            recipients.push(rec);
            return { rows: [rec] };
          }
          if (/UPDATE broadcasts/i.test(n)) {
            const row = broadcasts.get(params[0]);
            if (!row || row.status !== 'draft') return { rows: [] };
            row.status = 'pending';
            return { rows: [{ id: row.id, status: row.status }] };
          }
          return { rows: viewRows.slice() };
        },
      };
      return fn(client);
    },
  };
  return deps;
}

async function runCreate(deps, bodyObj, usr, query) {
  const res = mockRes();
  const routes = createBroadcastRoutes(deps);
  await routes.handleBroadcastCreate(query || { client: CLIENT }, mockReq(bodyObj), res, usr);
  return { res: res.out, body: parseBody(res.out), deps };
}

async function runGet(deps, id, usr, query) {
  const res = mockRes();
  const routes = createBroadcastRoutes(deps);
  await routes.handleBroadcastGet(id, query || { client: CLIENT }, res, usr);
  return { res: res.out, body: parseBody(res.out), deps };
}

async function runSend(deps, id, usr, query) {
  const res = mockRes();
  const routes = createBroadcastRoutes(deps);
  await routes.handleBroadcastSend(id, query || { client: CLIENT }, mockReq({}), res, usr);
  return { res: res.out, body: parseBody(res.out), deps };
}

const modSrc = fs.readFileSync(MODULE_PATH, 'utf8');
const domainSrc = fs.readFileSync(DOMAIN_PATH, 'utf8');
const outreachSrc = fs.readFileSync(OUTREACH_PATH, 'utf8');
const apiSrc = fs.readFileSync(API_PATH, 'utf8');
const lunaAllSrc = fs.readFileSync(LUNA_ALL_PATH, 'utf8');
const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
const specSrc = fs.readFileSync(SPEC_PATH, 'utf8');
const upSql = fs.readFileSync(MIG_UP, 'utf8');
const downSql = fs.readFileSync(MIG_DOWN, 'utf8');
const injectorSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'inbox-browser-source.js'), 'utf8');
const broadcastUiSrc = fs.readFileSync(BROADCAST_MODULE, 'utf8');
const columnsSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'browser', 'inbox-columns.js'), 'utf8');
const lunaSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'browser', 'inbox-luna-mode.js'), 'utf8');
const streamSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'browser', 'inbox-stream.js'), 'utf8');
const threadSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'browser', 'inbox-thread.js'), 'utf8');
const waDraftSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'browser', 'inbox-whatsapp-draft.js'), 'utf8');
const portalSrc = readStaffPortalUiSource();

(async () => {
  console.log('verify:staff-broadcasts\n');

  console.log('── contract ──');
  ok('collection path', BROADCASTS_COLLECTION_PATH === '/staff/broadcasts');
  ok('get path', BROADCAST_ID_PATH === '/staff/broadcasts/:id');
  ok('send path', BROADCAST_SEND_PATH === '/staff/broadcasts/:id/send');
  ok('minRole operator', BROADCAST_MIN_ROLE === 'operator');
  ok('route table is 3 operator routes', BROADCAST_ROUTE_TABLE.length === 3
    && BROADCAST_ROUTE_TABLE.every((r) => r.minRole === 'operator')
    && eq(BROADCAST_ROUTE_TABLE.map((r) => r.method), ['POST', 'GET', 'POST']));
  ok('GET id RE matches uuid', BROADCAST_ID_RE.test(`/staff/broadcasts/${BID}`));
  ok('GET id RE rejects send', !BROADCAST_ID_RE.test(`/staff/broadcasts/${BID}/send`));
  ok('send RE matches', BROADCAST_SEND_RE.test(`/staff/broadcasts/${BID}/send`));
  ok('recipient cap matches outreach', MAX_BROADCAST_RECIPIENTS === 50);
  ok('whatsapp error is stable', ERROR_WHATSAPP_NOT_SUPPORTED === 'whatsapp_broadcast_not_supported');
  ok('send 501 error is stable', ERROR_SEND_NOT_IMPLEMENTED === 'email_broadcast_send_not_implemented');

  console.log('\n── migration 079 ──');
  ok('078 still present', fs.existsSync(MIG_078));
  ok('079 up exists', fs.existsSync(MIG_UP));
  ok('079 down exists', fs.existsSync(MIG_DOWN));
  ok('up creates broadcasts', /CREATE TABLE broadcasts/i.test(upSql));
  ok('up creates broadcast_recipients', /CREATE TABLE broadcast_recipients/i.test(upSql));
  ok('up does not create contact_suppressions', !/CREATE TABLE contact_suppressions/i.test(upSql));
  ok('up is schema only (no DML seed)', !/\bINSERT INTO broadcasts\b/i.test(upSql));
  ok('up says do not apply live', /Do not apply it to a live DB/i.test(upSql));
  ok('down refuses nonempty', /079_down_refused/i.test(downSql));
  ok('channel check allows email', /channel IN \('email', 'whatsapp'\)/.test(upSql));

  console.log('\n── suppression reuse + no send infra ──');
  ok('domain requires outreach-send', /require\('\.\/staff-customer-outreach-send'\)/.test(domainSrc));
  ok('domain uses customerIsDoNotContact', /customerIsDoNotContact\(/.test(domainSrc));
  ok('outreach exports customerIsDoNotContact', /customerIsDoNotContact/.test(outreachSrc)
    && /customerIsDoNotContact/.test(fs.readFileSync(OUTREACH_PATH, 'utf8').slice(
      outreachSrc.lastIndexOf('module.exports'),
    )));
  ok('customerIsDoNotContact is the outreach helper', typeof customerIsDoNotContact === 'function');
  ok('domain does not mention Graph or Cloud send',
    !/graph\.microsoft|nodemailer|sendLunaWhatsAppMessage|_patched_whatsapp_cloud_send/i.test(domainSrc));
  ok('routes do not mention Graph or Cloud send',
    !/graph\.microsoft|nodemailer|sendLunaWhatsAppMessage/i.test(modSrc));
  ok('module does not call requireAuth', !/\brequireAuth\s*\(/.test(modSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')));
  ok('Inbox email composer module exists', fs.existsSync(BROADCAST_MODULE));

  console.log('\n── parse: whatsapp refused, people views only ──');
  {
    const wa = parseBroadcastCreateBody({ ...EMAIL_BODY, channel: CHANNEL_WHATSAPP });
    ok('whatsapp parse fails', wa.ok === false && wa.error === ERROR_WHATSAPP_NOT_SUPPORTED);
  }
  {
    const sms = parseBroadcastCreateBody({ ...EMAIL_BODY, channel: 'sms' });
    ok('unknown channel fails', sms.ok === false && sms.error === 'channel_not_supported');
  }
  {
    const dncView = parseBroadcastCreateBody({ ...EMAIL_BODY, view_id: 'do_not_contact' });
    ok('do_not_contact view is not broadcastable',
      dncView.ok === false && dncView.error === ERROR_VIEW_NOT_BROADCASTABLE);
  }
  {
    const conv = parseBroadcastCreateBody({ ...EMAIL_BODY, view_id: 'whatsapp' });
    ok('conversation whatsapp view is not broadcastable',
      conv.ok === false && conv.error === ERROR_VIEW_NOT_BROADCASTABLE);
  }
  {
    const okEmail = parseBroadcastCreateBody(EMAIL_BODY);
    ok('email checked_in parses', okEmail.ok === true
      && okEmail.value.channel === CHANNEL_EMAIL
      && okEmail.value.viewId === 'checked_in');
  }
  {
    const unknown = parseBroadcastCreateBody({ ...EMAIL_BODY, view_id: 'not_a_view' });
    ok('unknown view fails', unknown.ok === false && unknown.error === 'unknown_view');
  }

  console.log('\n── classify: do_not_contact excluded ──');
  {
    const classified = classifyBroadcastRecipients([
      { phone: '+34600000111', email: 'ana@wolfhouse.test', display_name: 'Ana', crm_tags: {} },
      { phone: '+34600000222', email: 'bob@wolfhouse.test', display_name: 'Bob', crm_tags: { do_not_contact: true } },
      { phone: '+34600000333', email: '', display_name: 'Cam', crm_tags: {} },
      { phone: '+34600000222', email: 'bob-dup@wolfhouse.test', display_name: 'Bob dup', crm_tags: {} },
    ]);
    ok('classify ok', classified.ok === true);
    ok('one pending (Ana)', classified.summary.pending === 1, JSON.stringify(classified.summary));
    ok('two skipped', classified.summary.skipped === 2, JSON.stringify(classified.summary));
    ok('DNC skip reason counted', classified.summary.skipped_reasons[SKIP_DO_NOT_CONTACT] === 1);
    ok('missing email skip counted', classified.summary.skipped_reasons[SKIP_MISSING_EMAIL] === 1);
    const pending = classified.classified.filter((r) => r.status === 'pending');
    ok('pending is only Ana', pending.length === 1 && pending[0].email === 'ana@wolfhouse.test');
    const dnc = classified.classified.filter((r) => r.skip_reason === SKIP_DO_NOT_CONTACT);
    ok('DNC row is skipped not pending', dnc.length === 1 && dnc[0].status === 'skipped' && dnc[0].phone === '+34600000222');
  }
  {
    const over = classifyBroadcastRecipients(
      Array.from({ length: 51 }, (_, i) => ({
        phone: `+3460000${String(1000 + i)}`,
        email: `g${i}@wolfhouse.test`,
        crm_tags: {},
      })),
    );
    ok('cap exceeded at 51', over.ok === false && over.error === 'recipient_cap_exceeded');
  }

  console.log('\n── SQL tenant binds ──');
  ok('insert binds clients.slug as $1', /FROM clients c/.test(SQL_INSERT_BROADCAST)
    && /c\.slug = \$1/.test(SQL_INSERT_BROADCAST)
    && !new RegExp(CLIENT).test(SQL_INSERT_BROADCAST));
  ok('select binds id $1 and slug $2', /b\.id = \$1/.test(SQL_SELECT_BROADCAST)
    && /c\.slug = \$2/.test(SQL_SELECT_BROADCAST)
    && /INNER JOIN clients c ON c\.id = b\.client_id/.test(SQL_SELECT_BROADCAST));
  ok('recipients scoped by broadcast_id and client_id',
    /broadcast_id = \$1/.test(SQL_SELECT_RECIPIENTS)
    && /client_id = \$2/.test(SQL_SELECT_RECIPIENTS));
  ok('recipient insert is parameterized', /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7\)/.test(SQL_INSERT_RECIPIENT));
  ok('mark pending is parameterized', /id = \$1/.test(SQL_MARK_PENDING) && /client_id = \$2/.test(SQL_MARK_PENDING));

  console.log('\n── staff-query-api wiring ──');
  ok('requires the routes module', /require\('\.\/lib\/staff-broadcast-routes'\)/.test(apiSrc));
  ok('builds routes through the DI factory', /createBroadcastRoutes\(\{/.test(apiSrc));
  const wiring = apiSrc.slice(
    apiSrc.indexOf('createBroadcastRoutes({'),
    apiSrc.indexOf('createBroadcastRoutes({') + 400,
  );
  for (const dep of ['sendJSON', 'send400', 'readBody', 'assertStaffClientAccess', 'appendAuditLog', 'withPgClient', 'DEFAULT_CLIENT', 'SQL_INJECT_RE']) {
    ok(`factory is injected ${dep}`, wiring.includes(dep));
  }
  const createDispatch = apiSrc.slice(
    apiSrc.indexOf('if (pathname === BROADCASTS_COLLECTION_PATH)'),
    apiSrc.indexOf('if (pathname === BROADCASTS_COLLECTION_PATH)') + 550,
  );
  ok('create requires operator auth before handler',
    createDispatch.includes("requireAuth(req, res, 'operator')")
    && createDispatch.indexOf("requireAuth(req, res, 'operator')") < createDispatch.indexOf('handleBroadcastCreate('));
  const sendDispatch = apiSrc.slice(
    apiSrc.indexOf('const broadcastSendMatch = BROADCAST_SEND_RE.exec(pathname);'),
    apiSrc.indexOf('const broadcastSendMatch = BROADCAST_SEND_RE.exec(pathname);') + 550,
  );
  ok('send requires operator auth before handler',
    sendDispatch.includes("requireAuth(req, res, 'operator')")
    && sendDispatch.indexOf("requireAuth(req, res, 'operator')") < sendDispatch.indexOf('handleBroadcastSend('));
  const getDispatch = apiSrc.slice(
    apiSrc.indexOf('const broadcastGetMatch = BROADCAST_ID_RE.exec(pathname);'),
    apiSrc.indexOf('const broadcastGetMatch = BROADCAST_ID_RE.exec(pathname);') + 550,
  );
  ok('get requires operator auth before handler',
    getDispatch.includes("requireAuth(req, res, 'operator')")
    && getDispatch.indexOf("requireAuth(req, res, 'operator')") < getDispatch.indexOf('handleBroadcastGet('));
  ok('send match is checked before get match',
    apiSrc.indexOf('BROADCAST_SEND_RE.exec(pathname)') < apiSrc.indexOf('BROADCAST_ID_RE.exec(pathname)')
    && apiSrc.indexOf('BROADCAST_SEND_RE.exec(pathname)') > apiSrc.indexOf('BROADCASTS_COLLECTION_PATH'));

  console.log('\n── HTTP: auth, tenant, whatsapp, DNC, 501 ──');
  {
    const deps = makeDeps({ accessDenied: true });
    const { res, body } = await runCreate(deps, EMAIL_BODY, user());
    ok('denied ACL is 403', res.statusCode === 403 && body.error === 'client_access_denied');
    ok('denied ACL never hits Postgres', deps.dbHits === 0);
  }
  {
    const deps = makeDeps();
    const { res, body } = await runCreate(deps, EMAIL_BODY, user(), { client: HOSTILE });
    ok('hostile slug is 400', res.statusCode === 400 && /invalid client slug/i.test(body.error));
    ok('hostile slug never hits Postgres', deps.dbHits === 0);
    ok('hostile slug is not in SQL', deps.sqlLog.every((e) => !String(e.params).includes(HOSTILE)));
  }
  {
    const deps = makeDeps();
    const { res, body } = await runCreate(deps, { ...EMAIL_BODY, channel: 'whatsapp' }, user());
    ok('whatsapp create is 400', res.statusCode === 400 && body.error === ERROR_WHATSAPP_NOT_SUPPORTED);
    ok('whatsapp create has a clear detail', typeof body.detail === 'string' && /email-only/i.test(body.detail));
    ok('whatsapp create never hits Postgres', deps.dbHits === 0);
  }
  {
    const deps = makeDeps();
    const { res, body } = await runCreate(deps, EMAIL_BODY, user());
    ok('email create is 201', res.statusCode === 201 && body.success === true);
    ok('email create stores draft', body.broadcast && body.broadcast.status === 'draft'
      && body.broadcast.channel === 'email'
      && body.broadcast.view_id === 'checked_in');
    ok('email create binds tenant slug as $1',
      deps.sqlLog.some((e) => /INSERT INTO broadcasts/i.test(e.sql) && e.params[0] === CLIENT));
    ok('email create does not interpolate slug',
      deps.sqlLog.every((e) => !e.sql.includes(CLIENT)));
  }
  {
    const deps = makeDeps();
    await runCreate(deps, EMAIL_BODY, user());
    const other = await runGet(deps, BID, user(), { client: OTHER_CLIENT });
    ok('other tenant GET is 404', other.res.statusCode === 404 && other.body.error === ERROR_NOT_FOUND);
    ok('other tenant GET binds the requested slug',
      deps.sqlLog.some((e) => /FROM broadcasts b/i.test(e.sql) && e.params[0] === BID && e.params[1] === OTHER_CLIENT));
    ok('other tenant GET does not leak the row', other.body.broadcast == null);
  }
  {
    const deps = makeDeps({
      viewRows: [
        { phone: '+34600000111', email: 'ana@wolfhouse.test', display_name: 'Ana', crm_tags: {} },
        { phone: '+34600000222', email: 'bob@wolfhouse.test', display_name: 'Bob', crm_tags: { do_not_contact: true } },
        { phone: '+34600000333', email: null, display_name: 'Cam', crm_tags: {} },
      ],
    });
    const created = await runCreate(deps, EMAIL_BODY, user());
    ok('seed create ok', created.res.statusCode === 201);
    const hitsBeforeSend = deps.dbHits;
    const sent = await runSend(deps, BID, user());
    ok('send is 501 not 200', sent.res.statusCode === 501 && sent.body.success === false);
    ok('send error is stable', sent.body.error === ERROR_SEND_NOT_IMPLEMENTED);
    ok('send did hit Postgres (snapshot, not a silent no-op)', deps.dbHits > hitsBeforeSend);
    ok('send stored pending status', sent.body.broadcast && sent.body.broadcast.status === 'pending');
    const pendingInserts = deps.recipients.filter((r) => r.status === 'pending');
    const dncInserts = deps.recipients.filter((r) => r.skip_reason === SKIP_DO_NOT_CONTACT);
    const missingEmail = deps.recipients.filter((r) => r.skip_reason === SKIP_MISSING_EMAIL);
    ok('DNC is not pending', pendingInserts.length === 1 && pendingInserts[0].email === 'ana@wolfhouse.test');
    ok('DNC stored as skipped', dncInserts.length === 1 && dncInserts[0].phone === '+34600000222');
    ok('missing email stored as skipped', missingEmail.length === 1 && missingEmail[0].phone === '+34600000333');
    ok('view query bound the tenant slug',
      deps.sqlLog.some((e) => e.params[0] === CLIENT && /customer_base|FROM customers/i.test(e.sql)));
    ok('send did not call a mailer', !/graph|nodemailer|whatsapp/i.test(deps.sqlLog.map((e) => e.sql).join('\n')));
    const got = await runGet(deps, BID, user());
    ok('GET after send shows pending + skipped', got.res.statusCode === 200
      && got.body.broadcast.status === 'pending'
      && got.body.summary.pending === 1
      && got.body.summary.skipped === 2);
  }
  {
    const deps = makeDeps({ denySlug: OTHER_CLIENT });
    await runCreate(deps, EMAIL_BODY, user());
    const hits = deps.dbHits;
    const sent = await runSend(deps, BID, user(), { client: OTHER_CLIENT });
    ok('send denied ACL is 403', sent.res.statusCode === 403);
    ok('send denied ACL does not add queries', deps.dbHits === hits);
  }

  console.log('\n── factory + gates registered ──');
  try {
    createBroadcastRoutes({
      sendJSON() {},
      send400() {},
      readBody() {},
      appendAuditLog() {},
      withPgClient() {},
      DEFAULT_CLIENT: CLIENT,
      SQL_INJECT_RE: /x/,
    });
    ok('missing assertStaffClientAccess throws', false);
  } catch (err) {
    ok('missing assertStaffClientAccess throws', /assertStaffClientAccess/.test(err.message));
  }
  ok('package.json has verify:staff-broadcasts',
    pkg.scripts && pkg.scripts['verify:staff-broadcasts'] === 'node scripts/verify-staff-broadcasts.js');
  ok('verify-luna-all runs this gate', /verify-staff-broadcasts\.js/.test(lunaAllSrc));
  ok('spec mentions Phase 4 broadcast API and composer',
    /migration 079/.test(specSrc)
    && /\/staff\/broadcasts/.test(specSrc)
    && /email_broadcast_send_not_implemented/.test(specSrc)
    && /inbox-broadcast\.js/.test(specSrc));

  console.log('\n── inbox UI composer (email only, honest 501) ──');
  ok('inject marker is in the portal template', apiSrc.includes(INBOX_BROADCAST_INJECT_MARKER));
  ok('injector maps inbox-broadcast.js onto the marker',
    injectorSrc.includes('INBOX_BROADCAST_INJECT_MARKER')
    && injectorSrc.includes('getInboxBroadcastBrowserSource()')
    && injectorSrc.indexOf('getInboxViewsBrowserSource()') < injectorSrc.indexOf('getInboxBroadcastBrowserSource()'));
  {
    const injected = injectInboxBrowserModules(`before\n${INBOX_BROADCAST_INJECT_MARKER}\nafter\n`);
    ok('injector splices the composer over the marker',
      injected.includes('function inboxBroadcastCreateUrl(')
      && injected.includes('function inboxBroadcastSendUrl(')
      && !injected.includes(INBOX_BROADCAST_INJECT_MARKER));
  }
  ok('composer POST create URL is /staff/broadcasts + inboxClientQuery()',
    broadcastUiSrc.includes("return '/staff/broadcasts' + inboxClientQuery();"));
  ok('composer GET URL is /staff/broadcasts/:id',
    broadcastUiSrc.includes("'/staff/broadcasts/' + encodeURIComponent(broadcastId) + inboxClientQuery()"));
  ok('composer Send URL is /staff/broadcasts/:id/send',
    broadcastUiSrc.includes("'/staff/broadcasts/' + encodeURIComponent(broadcastId) + '/send' + inboxClientQuery()"));
  ok('create body is email-only',
    broadcastUiSrc.includes("channel: 'email'")
    && !broadcastUiSrc.includes("channel: 'whatsapp'"));
  ok('no WhatsApp promo UI',
    broadcastUiSrc.includes('Channel: Email')
    && !/Channel:\s*WhatsApp/.test(broadcastUiSrc)
    && !/type="radio"/.test(broadcastUiSrc)
    && !/whatsapp_broadcast/.test(broadcastUiSrc));
  ok('honest 501 copy is stable',
    broadcastUiSrc.includes("queued locally, email delivery not wired yet")
    && broadcastUiSrc.includes("email_broadcast_send_not_implemented"));
  ok('501 is treated as blocked, not sent',
    /inboxBroadcastSetStatus\('blocked'/.test(broadcastUiSrc)
    && !/Broadcast sent/.test(broadcastUiSrc)
    && !/Email sent/.test(broadcastUiSrc)
    && !/mail went out/.test(broadcastUiSrc));
  ok('Send still 501 in domain (not flipped to 200/dry-run)',
    /status: 501/.test(domainSrc)
    && /ERROR_SEND_NOT_IMPLEMENTED/.test(domainSrc)
    && !/status: 200/.test(domainSrc.slice(domainSrc.indexOf('async function executeSendBroadcast'))));
  ok('composer does not touch four-column attributes',
    !/data-col1|data-col2|data-col4|inboxColumns/.test(broadcastUiSrc));
  ok('composer does not rewrite Luna / WhatsApp draft / SSE',
    !broadcastUiSrc.includes('/staff/bot/pause')
    && !broadcastUiSrc.includes('/staff/inbox/whatsapp/')
    && !broadcastUiSrc.includes('EventSource')
    && !broadcastUiSrc.includes('/staff/inbox/stream'));
  ok('four-column module still owns data-col*',
    columnsSrc.includes('data-col1') && columnsSrc.includes('data-col2') && columnsSrc.includes('data-col4'));
  ok('Luna mode control still in its module',
    lunaSrc.includes('function inboxLunaModeControlHtml(')
    && lunaSrc.includes("return ['auto', 'off']"));
  ok('WhatsApp draft card still in its module',
    waDraftSrc.includes('id="inbox-whatsapp-draft"')
    && waDraftSrc.includes('id="btn-whatsapp-draft-approve"'));
  ok('SSE still in inbox-stream.js',
    streamSrc.includes('new EventSource(inboxStreamUrl())')
    && streamSrc.includes('/staff/inbox/stream'));
  ok('combined portal UI has composer URLs and 501 copy',
    portalSrc.includes('/staff/broadcasts')
    && portalSrc.includes("queued locally, email delivery not wired yet")
    && portalSrc.includes('/staff/inbox/whatsapp/draft')
    && portalSrc.includes('/staff/inbox/stream')
    && portalSrc.includes('function inboxLunaModeControlHtml('));
  ok('thread still mounts WhatsApp draft off the email path',
    /if \(!isEmailConversation\) html \+= inboxWhatsAppDraftMountHtml\(\)/.test(threadSrc));
  ok('mount exists in the Inbox shell',
    /id="inbox-broadcast-root"/.test(apiSrc) && /class="inbox-broadcast-root"/.test(apiSrc));

  const sandbox = {
    escHtml: (s) => String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;'),
    inboxClientQuery: () => '?client=wolfhouse-somo',
    el: () => null,
    document: { createElement: () => ({ id: '', className: '', hidden: true, appendChild: () => {} }) },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${broadcastUiSrc}\n` +
    'this.inboxBroadcastCreateUrl = inboxBroadcastCreateUrl;\n' +
    'this.inboxBroadcastGetUrl = inboxBroadcastGetUrl;\n' +
    'this.inboxBroadcastSendUrl = inboxBroadcastSendUrl;\n' +
    'this.inboxBroadcastComposerHtml = inboxBroadcastComposerHtml;\n' +
    'this.inboxBroadcastSendFailureCopy = inboxBroadcastSendFailureCopy;\n' +
    'this.inboxBroadcastIsEmailableView = inboxBroadcastIsEmailableView;\n' +
    'this.inboxBroadcastRecipientCountHtml = inboxBroadcastRecipientCountHtml;',
    sandbox,
  );
  ok('create URL carries tenant query',
    sandbox.inboxBroadcastCreateUrl() === '/staff/broadcasts?client=wolfhouse-somo');
  ok('send URL is POST path with id',
    sandbox.inboxBroadcastSendUrl(BID) === `/staff/broadcasts/${BID}/send?client=wolfhouse-somo`);
  ok('GET URL is id path',
    sandbox.inboxBroadcastGetUrl(BID) === `/staff/broadcasts/${BID}?client=wolfhouse-somo`);
  {
    const card = sandbox.inboxBroadcastComposerHtml({
      viewId: 'checked_in',
      viewLabel: 'Checked in',
      viewCount: 12,
      subject: 'BBQ tonight',
      body: 'Grill at 8.',
    });
    ok('composer shows email segment + subject/body, no WhatsApp control',
      card.includes('Email broadcast')
      && card.includes('Channel: Email')
      && card.includes('Segment: Checked in (12)')
      && /id="inbox-broadcast-subject"/.test(card)
      && /id="inbox-broadcast-body"/.test(card)
      && /id="inbox-broadcast-create"/.test(card)
      && /id="inbox-broadcast-send"/.test(card)
      && !/WhatsApp/.test(card));
    ok('composer shows recipient count',
      sandbox.inboxBroadcastRecipientCountHtml(12, null).indexOf('12') >= 0
      && sandbox.inboxBroadcastRecipientCountHtml(12, { pending: 9, skipped: 2 }).indexOf('9') >= 0);
  }
  ok('501 copy names the honest queue message',
    sandbox.inboxBroadcastSendFailureCopy(501, ERROR_SEND_NOT_IMPLEMENTED, { pending: 9, skipped: 1 })
      .indexOf('queued locally, email delivery not wired yet') >= 0);
  ok('people views with multi_select are emailable; do_not_contact is not',
    sandbox.inboxBroadcastIsEmailableView({ multi_select: true, group: 'people' }) === true
    && sandbox.inboxBroadcastIsEmailableView({ multi_select: false, group: 'people' }) === false
    && sandbox.inboxBroadcastIsEmailableView({ multi_select: true, group: 'inbox' }) === false);

  console.log(`\n── ${fail === 0 ? 'PASSED' : 'FAILED'} (${pass} pass, ${fail} fail) ──`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
