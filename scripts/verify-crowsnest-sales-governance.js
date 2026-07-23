'use strict';

/**
 * Deterministic RED→GREEN verifier for Luna Sales Chapter 11:
 * Scale and Governance.
 * Offline — no live DB, no Azure, no HubSpot/Maps/Apollo/live AI/outreach/writes/roles.
 */

const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const API_SCRIPT = path.join(ROOT, 'scripts', 'crowsnest-api.js');
const API_PATH = path.join(ROOT, 'scripts', 'crowsnest-api.js');
const PAGE_PATH = path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-page.js');
const SALES_PATH = path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-sales.js');
const DOC_PATH = path.join(ROOT, 'docs', 'crowsnest', 'SALES-GOVERNANCE.md');
const PRODUCT_DOC = path.join(ROOT, 'docs', 'CROWSNEST.md');
const PKG_PATH = path.join(ROOT, 'package.json');
const BASE_PORT = Number(process.env.CROWSNEST_VERIFY_SALES_GOVERNANCE_PORT) || 13380;

let pass = 0;
let fail = 0;
let child = null;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('  PASS ', name);
  } else {
    fail += 1;
    console.log('  FAIL ', name, detail ? `— ${detail}` : '');
  }
}

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function request(port, urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...(options.headers || {}) };
    if (options.username != null && options.password != null) {
      const token = Buffer.from(`${options.username}:${options.password}`).toString('base64');
      headers.Authorization = `Basic ${token}`;
    }
    let body = options.body;
    if (body != null && typeof body !== 'string' && !Buffer.isBuffer(body)) {
      body = String(body);
    }
    if (body != null && headers['Content-Length'] == null && headers['content-length'] == null) {
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method: options.method || 'GET',
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: buffer.toString('utf8'),
            buffer,
          });
        });
      },
    );
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

function extractCookiePair(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
  return list.map((entry) => String(entry).split(';')[0]).join('; ');
}

function allowHeader(res) {
  return String(res.headers.allow || res.headers.Allow || '');
}

async function assertMethodRejected(port, urlPath, method, headers, expectedAllow) {
  const res = await request(port, urlPath, { method, headers });
  ok(`${method} ${urlPath} => 405`, res.statusCode === 405, `got ${res.statusCode}`);
  ok(`${method} ${urlPath} Allow header`, allowHeader(res) === expectedAllow, allowHeader(res));
  ok(`${method} ${urlPath} method-not-allowed body`, /method not allowed/i.test(res.body));
  return res;
}

function waitForHealthz(port, timeoutMs = 15000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      request(port, '/healthz')
        .then((res) => {
          if (res.statusCode === 200) resolve();
          else retry();
        })
        .catch(retry);
    };
    function retry() {
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`Crowsnest did not become ready on port ${port}`));
        return;
      }
      setTimeout(tick, 150);
    }
    tick();
  });
}

function startServer(port, env) {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, [API_SCRIPT], {
      cwd: ROOT,
      env: { ...process.env, ...env, CROWSNEST_PORT: String(port), CROWSNEST_HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    waitForHealthz(port)
      .then(() => resolve(stderr))
      .catch((err) => {
        stopServer();
        reject(new Error(`${err.message}\n${stderr}`));
      });
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!child) {
      resolve();
      return;
    }
    const current = child;
    child = null;
    current.once('exit', () => resolve());
    current.kill('SIGTERM');
    setTimeout(() => {
      try {
        current.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, 2000);
  });
}

async function runScenario(name, port, env, steps) {
  console.log(`\n▸ ${name}`);
  await startServer(port, env);
  try {
    for (const step of steps) {
      await step(port);
    }
  } finally {
    await stopServer();
  }
}

function structuralChecks() {
  console.log('\n▸ Structural: Chapter 11 scale and governance');
  const apiSrc = read(API_PATH) || '';
  const pageSrc = read(PAGE_PATH) || '';
  const salesSrc = read(SALES_PATH) || '';
  const docSrc = read(DOC_PATH) || '';
  const productSrc = read(PRODUCT_DOC) || '';

  ok('crowsnest-sales.js exists', fs.existsSync(SALES_PATH));
  ok('sales exports getSalesGovernance', /getSalesGovernance/.test(salesSrc));
  ok(
    'sales exports governance builders',
    /buildWorkflowSafeguards/.test(salesSrc)
      && /buildHumanApprovalRules/.test(salesSrc)
      && /buildDataRetentionNotes/.test(salesSrc)
      && /buildExternalIntegrationState/.test(salesSrc)
      && /buildActionBoundaryAuditSummary/.test(salesSrc),
  );
  ok('router allowlists /sales/governance', /pathname\s*===\s*['"]\/sales\/governance['"]|\/sales\/governance/.test(apiSrc));
  ok(
    'page renders governance dashboard',
    /sales_governance|Workflow safeguards|Human-approval|Data retention|External integration|Action boundary/i.test(pageSrc),
  );
  ok('page escapes governance fields', /escapeHtml/.test(pageSrc));
  ok(
    'no automatic CRM/outreach/roles/external claims on governance page',
    !/automatic CRM write enabled|auto-send outreach enabled|roles system changed|live HubSpot sync completed|Apollo enrichment completed/i.test(pageSrc),
  );
  ok('no HubSpot/Apollo/Google SDK require in sales', !/require\(['"][^'"]*(hubspot|apollo|googleapis)/i.test(salesSrc));
  ok(
    'governance route is read-only (GET/HEAD only handler)',
    /handleSalesGovernance[\s\S]*?sendMethodNotAllowed\(res, 'GET, HEAD'\)/.test(apiSrc)
      || /async function handleSalesGovernance[\s\S]*?method !== 'GET' && method !== 'HEAD'/.test(apiSrc),
  );
  ok('governance doc exists', fs.existsSync(DOC_PATH));
  ok(
    'governance doc forbids automatic CRM/outreach, external calls, roles changes',
    /human.?approval|no automatic|no.*CRM write|no outreach|no external|no roles/i.test(docSrc),
  );
  ok('product doc mentions Chapter 11 scale and governance', /Chapter 11|Scale and Governance|sales governance/i.test(productSrc));

  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  } catch {
    pkg = null;
  }
  ok(
    'package.json has verify:crowsnest-sales-governance',
    pkg && pkg.scripts && typeof pkg.scripts['verify:crowsnest-sales-governance'] === 'string',
  );

  ok(
    'no new sales migration required for Chapter 11',
    !fs.existsSync(path.join(ROOT, 'database', 'migrations', '048_luna_sales_governance.sql'))
      && !fs.existsSync(path.join(ROOT, 'database', 'migrations', '049_luna_sales_governance.sql')),
  );
}

async function domainGovernanceChecks() {
  console.log('\n▸ Governance policy builders (domain)');
  delete require.cache[require.resolve(SALES_PATH)];
  const sales = require(SALES_PATH);

  ok('getSalesGovernance is a function', typeof sales.getSalesGovernance === 'function');
  ok('buildWorkflowSafeguards is a function', typeof sales.buildWorkflowSafeguards === 'function');
  ok('buildHumanApprovalRules is a function', typeof sales.buildHumanApprovalRules === 'function');
  ok('buildDataRetentionNotes is a function', typeof sales.buildDataRetentionNotes === 'function');
  ok('buildExternalIntegrationState is a function', typeof sales.buildExternalIntegrationState === 'function');
  ok('buildActionBoundaryAuditSummary is a function', typeof sales.buildActionBoundaryAuditSummary === 'function');
  if (typeof sales.getSalesGovernance !== 'function') return;

  const governance = await sales.getSalesGovernance();
  ok('getSalesGovernance ok', governance && governance.ok === true, JSON.stringify(governance));
  ok('governance has disclaimer', typeof governance.disclaimer === 'string' && /human|read-only|no automatic/i.test(governance.disclaimer));

  const safeguards = sales.buildWorkflowSafeguards();
  ok('workflow safeguards is a non-empty array', Array.isArray(safeguards) && safeguards.length >= 4);
  ok(
    'workflow safeguards require human approval at key gates',
    safeguards.every((s) => s && s.human_approval_required === true)
      && safeguards.some((s) => /qualification|crm|outreach|discovery|decision/i.test(`${s.id} ${s.title} ${s.summary}`)),
    JSON.stringify(safeguards),
  );

  const rules = sales.buildHumanApprovalRules();
  ok('human-approval rules is a non-empty array', Array.isArray(rules) && rules.length >= 4);
  ok(
    'human-approval rules forbid automatic CRM writes and outreach',
    rules.some((r) => /crm/i.test(`${r.id} ${r.rule}`) && /no automatic|human|manual|operator/i.test(r.rule))
      && rules.some((r) => /outreach|send/i.test(`${r.id} ${r.rule}`) && /no automatic|human|manual|draft|operator/i.test(r.rule)),
    JSON.stringify(rules),
  );
  ok(
    'human-approval rules forbid roles changes and external calls',
    rules.some((r) => /role/i.test(`${r.id} ${r.rule}`))
      && rules.some((r) => /external/i.test(`${r.id} ${r.rule}`)),
    JSON.stringify(rules),
  );

  const retention = sales.buildDataRetentionNotes();
  ok(
    'data retention notes include ownership and schema',
    retention
      && typeof retention === 'object'
      && /luna_sales|CROWSNEST_SALES_DATABASE_URL/i.test(JSON.stringify(retention))
      && /owner|ownership|operator|Crowsnest/i.test(JSON.stringify(retention)),
    JSON.stringify(retention),
  );
  ok(
    'retention explicitly separates Sales DSN from Wolfhouse',
    /Wolfhouse guest|never the Wolfhouse|dedicated.*CROWSNEST_SALES/i.test(JSON.stringify(retention)),
  );

  const integrations = sales.buildExternalIntegrationState();
  ok('external integration state is a non-empty array', Array.isArray(integrations) && integrations.length >= 4);
  ok(
    'HubSpot / Maps / Apollo / outreach listed as not live-writing',
    integrations.some((i) => /hubspot|crm/i.test(`${i.id} ${i.name}`))
      && integrations.some((i) => /maps|google/i.test(`${i.id} ${i.name}`))
      && integrations.some((i) => /apollo|enrichment/i.test(`${i.id} ${i.name}`))
      && integrations.some((i) => /outreach|smtp|whatsapp|linkedin/i.test(`${i.id} ${i.name}`)),
    JSON.stringify(integrations),
  );
  ok(
    'no integration claims live write or automatic send',
    integrations.every((i) => {
      const state = String(i.state || '').toLowerCase();
      const note = String(i.note || '').toLowerCase();
      return !/live_write|auto_send|connected_write/.test(state)
        && !/automatic write|messages are sent|live http enabled/.test(note);
    }),
    JSON.stringify(integrations),
  );
  ok(
    'integrations mark write_enabled false / not automatic',
    integrations.every((i) => i.write_enabled !== true && i.automatic !== true),
  );

  const boundaries = sales.buildActionBoundaryAuditSummary();
  ok(
    'action boundary summary has allowed_manual and forbidden_automatic',
    boundaries
      && Array.isArray(boundaries.allowed_manual)
      && Array.isArray(boundaries.forbidden_automatic)
      && boundaries.allowed_manual.length >= 3
      && boundaries.forbidden_automatic.length >= 3,
    JSON.stringify(boundaries),
  );
  ok(
    'forbidden boundaries include CRM write, outreach send, external calls, roles changes',
    boundaries.forbidden_automatic.some((a) => /crm.*write|write.*crm/i.test(`${a.id} ${a.action}`))
      && boundaries.forbidden_automatic.some((a) => /outreach|send message|smtp/i.test(`${a.id} ${a.action}`))
      && boundaries.forbidden_automatic.some((a) => /external/i.test(`${a.id} ${a.action}`))
      && boundaries.forbidden_automatic.some((a) => /role/i.test(`${a.id} ${a.action}`)),
    JSON.stringify(boundaries.forbidden_automatic),
  );
  ok(
    'allowed_manual actions are operator-triggered / audited',
    boundaries.allowed_manual.every((a) => a.human_approval_required === true || a.operator_triggered === true),
  );

  ok(
    'governance payload matches builders',
    Array.isArray(governance.workflow_safeguards)
      && Array.isArray(governance.human_approval_rules)
      && governance.data_retention
      && Array.isArray(governance.external_integrations)
      && governance.action_boundaries
      && Array.isArray(governance.action_boundaries.allowed_manual)
      && Array.isArray(governance.action_boundaries.forbidden_automatic),
  );
  ok(
    'no invented AI/agent score or roles-change fields on governance payload',
    governance.ai_score == null
      && governance.agent_priority == null
      && governance.roles_changed !== true
      && governance.automatic_crm_writes_enabled !== true
      && governance.automatic_outreach_enabled !== true,
  );
}

async function main() {
  console.log('verify:crowsnest-sales-governance — Luna Sales Chapter 11\n');

  structuralChecks();
  await domainGovernanceChecks();

  await runScenario('Protected route + 405 unsafe methods for /sales/governance', BASE_PORT, {
    CROWSNEST_AUTH_REQUIRED: 'true',
    CROWSNEST_AUTH_USERNAME: 'admin',
    CROWSNEST_AUTH_PASSWORD: 'admin',
  }, [
    async (port) => {
      const unauth = await request(port, '/sales/governance');
      ok(
        'unauthenticated GET /sales/governance redirects to /login',
        unauth.statusCode === 302 && String(unauth.headers.location || '') === '/login',
      );

      const login = await request(port, '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'username=admin&password=admin',
      });
      const cookie = extractCookiePair(login.headers['set-cookie']);
      ok('login cookie for governance', /crowsnest_session=/.test(cookie));

      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        await assertMethodRejected(port, '/sales/governance', method, { Cookie: cookie }, 'GET, HEAD');
      }

      const page = await request(port, '/sales/governance', { headers: { Cookie: cookie } });
      ok('GET /sales/governance => 200', page.statusCode === 200, `got ${page.statusCode}`);
      ok('governance heading present', /Sales governance|Scale and governance|Governance/i.test(page.body));
      ok('workflow safeguards section present', /Workflow safeguards/i.test(page.body));
      ok('human-approval rules section present', /Human-approval|Human approval/i.test(page.body));
      ok('data retention section present', /Data retention|ownership/i.test(page.body));
      ok('external integration state section present', /External integration/i.test(page.body));
      ok('action boundary audit summary present', /Action boundary/i.test(page.body));
      ok(
        'honest read-only / human-approval / no automatic actions note',
        /read-only|human.?approval|no automatic|operators decide/i.test(page.body),
      );
      ok(
        'page forbids automatic CRM writes and outreach',
        /no automatic CRM|CRM writes?.*not|not.*automatic.*CRM|manual.*CRM/i.test(page.body)
          && /no.*outreach|outreach.*draft|not.*sent|no automatic.*outreach/i.test(page.body),
      );
      ok(
        'no AI/agent / HubSpot sync / outreach send / roles-change claims',
        !/AI agent score|autonomous outreach|hubspot sync completed|outreach send completed|roles updated|role grant applied|Maps discovery ran|Apollo enrichment completed/i.test(page.body),
      );
      ok('Sales nav remains available', /href=["']\/sales["']/.test(page.body));
      ok('link back to Sales intake, review, or analytics', /href=["']\/sales["']|href=["']\/sales\/review["']|href=["']\/sales\/analytics["']/.test(page.body));
    },
  ]);

  await runScenario('Governance content is XSS-escaped and static-safe', BASE_PORT + 1, {
    CROWSNEST_AUTH_REQUIRED: 'true',
    CROWSNEST_AUTH_USERNAME: 'admin',
    CROWSNEST_AUTH_PASSWORD: 'admin',
  }, [
    async (port) => {
      const login = await request(port, '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'username=admin&password=admin',
      });
      const cookie = extractCookiePair(login.headers['set-cookie']);

      const page = await request(port, '/sales/governance', { headers: { Cookie: cookie } });
      ok('governance page => 200', page.statusCode === 200, `got ${page.statusCode}`);
      ok('no raw script tags injected in governance body', !/<script>alert\(/i.test(page.body));
      ok(
        'HubSpot / Maps / Apollo / outreach appear as non-live states',
        /HubSpot|CRM/i.test(page.body)
          && /Maps|Google/i.test(page.body)
          && /Apollo|enrichment/i.test(page.body)
          && /outreach|SMTP|WhatsApp|LinkedIn/i.test(page.body),
      );
      ok(
        'forbidden automatic actions listed',
        /forbidden|not permitted|not allowed|must not/i.test(page.body)
          && /CRM|outreach|external|role/i.test(page.body),
      );
      ok(
        'dashboard still denies automation / roles-change claims',
        !/automatic CRM write enabled|message has been sent|roles system changed|live enrichment ran/i.test(page.body),
      );
      ok(
        'luna_sales ownership / retention noted',
        /luna_sales|CROWSNEST_SALES_DATABASE_URL/i.test(page.body),
      );
    },
  ]);

  console.log(`\n── verify:crowsnest-sales-governance: ${pass} passed, ${fail} failed ──`);
  if (fail > 0) {
    console.error('verify:crowsnest-sales-governance — FAILED');
    process.exitCode = 1;
    return;
  }
  console.log('verify:crowsnest-sales-governance — ALL CHECKS PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(() => stopServer());
