'use strict';

/**
 * RADAR 16A2 — read-only Azure capture guards + sanitizers.
 *
 * Fail-closed before dispatch: only subscription
 * 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 and resource groups
 * wh-staging-rg / luna-sunset-staging-rg.
 *
 * Pure evaluation helpers are offline-safe; live dispatch is opt-in via
 * scripts/capture-radar-operations-staging-readonly.js.
 */

const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const ALLOWED_SUBSCRIPTION_ID = '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9';
const ALLOWED_RESOURCE_GROUPS = Object.freeze([
  'wh-staging-rg',
  'luna-sunset-staging-rg',
]);

const FORBIDDEN_RESOURCE_GROUPS = Object.freeze([
  'wh-prod-rg',
  'wolfhouse-prod-rg',
  'luna-sunset-prod-rg',
  'production',
]);

/** Exact allowed method inventory (pre-dispatch). */
const ALLOWED_METHOD_INVENTORY = Object.freeze([
  Object.freeze({
    id: 'arm_account_show',
    method: 'GET',
    surface: 'az_cli',
    command_template: 'az account show -o json',
    rest_path: null,
    api_version: null,
    notes: 'Preflight subscription pin only',
  }),
  Object.freeze({
    id: 'arm_rg_show',
    method: 'GET',
    surface: 'arm',
    command_template: 'az group show -n {rg} -o json',
    rest_path: '/subscriptions/{sub}/resourceGroups/{rg}',
    api_version: '2021-04-01',
  }),
  Object.freeze({
    id: 'arm_resource_list',
    method: 'GET',
    surface: 'arm',
    command_template: 'az resource list -g {rg} -o json',
    rest_path: '/subscriptions/{sub}/resourceGroups/{rg}/resources',
    api_version: '2021-04-01',
  }),
  Object.freeze({
    id: 'cost_query',
    method: 'POST',
    surface: 'arm',
    command_template: 'az rest --method post --url {costUrl} --body @{body}',
    rest_path:
      '/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.CostManagement/query',
    api_version: '2023-11-01',
    notes: 'Read-only ActualCost aggregation; no budget mutation',
  }),
  Object.freeze({
    id: 'consumption_budgets_list',
    method: 'GET',
    surface: 'arm',
    command_template: 'az rest --method get --url {budgetsUrl}',
    rest_path:
      '/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Consumption/budgets',
    api_version: '2023-11-01',
  }),
  Object.freeze({
    id: 'metric_alerts_list',
    method: 'GET',
    surface: 'az_cli',
    command_template: 'az monitor metrics alert list -g {rg} -o json',
    rest_path:
      '/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Insights/metricAlerts',
    api_version: '2018-03-01',
  }),
  Object.freeze({
    id: 'activity_log_alerts_list',
    method: 'GET',
    surface: 'az_cli',
    command_template: 'az monitor activity-log alert list -g {rg} -o json',
    rest_path:
      '/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Insights/activityLogAlerts',
    api_version: '2020-10-01',
  }),
  Object.freeze({
    id: 'scheduled_query_rules_list',
    method: 'GET',
    surface: 'az_cli',
    command_template: 'az monitor scheduled-query list -g {rg} -o json',
    rest_path:
      '/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Insights/scheduledQueryRules',
    api_version: '2023-03-15-preview',
  }),
  Object.freeze({
    id: 'action_groups_list',
    method: 'GET',
    surface: 'az_cli',
    command_template: 'az monitor action-group list -g {rg} -o json',
    rest_path:
      '/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Insights/actionGroups',
    api_version: '2023-01-01',
  }),
  Object.freeze({
    id: 'diagnostic_settings_list',
    method: 'GET',
    surface: 'az_cli',
    command_template: 'az monitor diagnostic-settings list --resource {resourceId} -o json',
    rest_path: '{resourceId}/providers/Microsoft.Insights/diagnosticSettings',
    api_version: '2021-05-01-preview',
    notes: 'Sampled resources only — not an exhaustive RG scan',
  }),
  Object.freeze({
    id: 'containerapp_env_show',
    method: 'GET',
    surface: 'az_cli',
    command_template: 'az containerapp env show -g {rg} -n {name} -o json',
    rest_path:
      '/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.App/managedEnvironments/{name}',
    api_version: '2024-03-01',
  }),
  Object.freeze({
    id: 'containerapp_show',
    method: 'GET',
    surface: 'az_cli',
    command_template: 'az containerapp show -g {rg} -n {name} -o json',
    rest_path:
      '/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.App/containerApps/{name}',
    api_version: '2024-03-01',
  }),
  Object.freeze({
    id: 'containerapp_job_show',
    method: 'GET',
    surface: 'az_cli',
    command_template: 'az containerapp job show -g {rg} -n {name} -o json',
    rest_path:
      '/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.App/jobs/{name}',
    api_version: '2024-03-01',
  }),
  Object.freeze({
    id: 'postgres_flexible_show',
    method: 'GET',
    surface: 'az_cli',
    command_template: 'az postgres flexible-server show -g {rg} -n {name} -o json',
    rest_path:
      '/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.DBforPostgreSQL/flexibleServers/{name}',
    api_version: '2023-12-01-preview',
  }),
  Object.freeze({
    id: 'law_show',
    method: 'GET',
    surface: 'az_cli',
    command_template: 'az monitor log-analytics workspace show -g {rg} -n {name} -o json',
    rest_path:
      '/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.OperationalInsights/workspaces/{name}',
    api_version: '2022-10-01',
  }),
  Object.freeze({
    id: 'appinsights_show',
    method: 'GET',
    surface: 'az_cli',
    command_template: 'az monitor app-insights component show -g {rg} -a {name} -o json',
    rest_path:
      '/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Insights/components/{name}',
    api_version: '2020-02-02',
  }),
  Object.freeze({
    id: 'public_healthz_get',
    method: 'GET',
    surface: 'https',
    command_template: 'HTTPS GET https://{host}/healthz',
    rest_path: 'https://{host}/healthz',
    api_version: null,
    notes: 'Staging public hostnames only; no auth secrets',
  }),
]);

const ALLOWED_METHOD_IDS = Object.freeze(
  ALLOWED_METHOD_INVENTORY.map((m) => m.id),
);

const MUTATING_HTTP_METHODS = Object.freeze([
  'PUT', 'PATCH', 'DELETE', 'POST',
]);

const SAMPLED_DIAGNOSTIC_RESOURCES = Object.freeze([
  Object.freeze({
    rg: 'wh-staging-rg',
    name: 'wh-staging-staff-api',
    type: 'Microsoft.App/containerApps',
  }),
  Object.freeze({
    rg: 'wh-staging-rg',
    name: 'wh-staging-pg-app',
    type: 'Microsoft.DBforPostgreSQL/flexibleServers',
  }),
  Object.freeze({
    rg: 'wh-staging-rg',
    name: 'wh-staging-kv',
    type: 'Microsoft.KeyVault/vaults',
  }),
  Object.freeze({
    rg: 'wh-staging-rg',
    name: 'wh-staging-appinsights',
    type: 'Microsoft.Insights/components',
  }),
  Object.freeze({
    rg: 'wh-staging-rg',
    name: 'wh-staging-logs',
    type: 'Microsoft.OperationalInsights/workspaces',
  }),
  Object.freeze({
    rg: 'luna-sunset-staging-rg',
    name: 'luna-sunset-staging-staff-api',
    type: 'Microsoft.App/containerApps',
  }),
  Object.freeze({
    rg: 'luna-sunset-staging-rg',
    name: 'luna-sunset-staging-pg-app',
    type: 'Microsoft.DBforPostgreSQL/flexibleServers',
  }),
  Object.freeze({
    rg: 'luna-sunset-staging-rg',
    name: 'luna-sunset-staging-kv',
    type: 'Microsoft.KeyVault/vaults',
  }),
  Object.freeze({
    rg: 'luna-sunset-staging-rg',
    name: 'luna-sunset-staging-appinsights',
    type: 'Microsoft.Insights/components',
  }),
  Object.freeze({
    rg: 'luna-sunset-staging-rg',
    name: 'luna-sunset-staging-logs',
    type: 'Microsoft.OperationalInsights/workspaces',
  }),
]);

const PUBLIC_HEALTHZ_HOSTS = Object.freeze([
  'staff-staging.lunafrontdesk.com',
  'sunset-staging.lunafrontdesk.com',
]);

const SECRET_VALUE_PATH_MARKERS = Object.freeze([
  '/listSecrets',
  '/secrets/',
  'show-secret',
  'keyvault secret show',
  'az keyvault secret show',
  'az keyvault secret list',
  'connectionString',
  'instrumentationKey',
]);

const DB_SURFACE_MARKERS = Object.freeze([
  'psql ',
  'pg_connect',
  'azure postgres flexible-server execute',
  'az postgres flexible-server execute',
  'DATABASE_URL',
  'postgres://',
  'postgresql://',
]);

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function hashCanonical(value) {
  return sha256Hex(canonicalJson(value));
}

function normalizeUrl(url) {
  return String(url || '').trim();
}

function extractRgFromArmUrl(url) {
  const m = normalizeUrl(url).match(/\/resourceGroups\/([^/?]+)/i);
  return m ? decodeURIComponent(m[1]) : null;
}

function extractSubFromArmUrl(url) {
  const m = normalizeUrl(url).match(/\/subscriptions\/([^/?]+)/i);
  return m ? decodeURIComponent(m[1]) : null;
}

function isAllowedRg(rg) {
  return ALLOWED_RESOURCE_GROUPS.includes(String(rg || ''));
}

function isForbiddenRg(rg) {
  const name = String(rg || '').toLowerCase();
  if (FORBIDDEN_RESOURCE_GROUPS.map((x) => x.toLowerCase()).includes(name)) return true;
  if (/(^|-)prod($|-)/i.test(name) && !/-staging-/i.test(name) && name !== 'wh-staging-rg') {
    if (/prod/i.test(name) && !/staging/i.test(name)) return true;
  }
  return false;
}

/**
 * Pre-dispatch gate. Throws on any out-of-scope call.
 * @param {{ methodId: string, method: string, url?: string, rg?: string, command?: string }} req
 */
function assertAllowedBeforeDispatch(req) {
  const methodId = String(req && req.methodId || '');
  const method = String(req && req.method || '').toUpperCase();
  const url = normalizeUrl(req && req.url);
  const command = String(req && req.command || '');
  const rg = req && req.rg != null ? String(req.rg) : extractRgFromArmUrl(url);

  if (!ALLOWED_METHOD_IDS.includes(methodId)) {
    throw new Error(`REFUSED: methodId not in allowed inventory: ${methodId}`);
  }

  const inventory = ALLOWED_METHOD_INVENTORY.find((m) => m.id === methodId);
  if (!inventory) {
    throw new Error(`REFUSED: missing inventory entry for ${methodId}`);
  }

  if (method !== inventory.method) {
    throw new Error(
      `REFUSED: method ${method} does not match inventory ${inventory.method} for ${methodId}`,
    );
  }

  // Cost query is the only allowed POST.
  if (MUTATING_HTTP_METHODS.includes(method) && methodId !== 'cost_query') {
    throw new Error(`REFUSED: mutating method ${method} blocked for ${methodId}`);
  }

  if (url) {
    const sub = extractSubFromArmUrl(url);
    if (sub && sub !== ALLOWED_SUBSCRIPTION_ID) {
      throw new Error(`REFUSED: subscription mismatch ${sub}`);
    }
    if (rg && !isAllowedRg(rg)) {
      throw new Error(`REFUSED: resource group out of scope: ${rg}`);
    }
    if (rg && isForbiddenRg(rg)) {
      throw new Error(`REFUSED: production/forbidden RG: ${rg}`);
    }
    for (const marker of SECRET_VALUE_PATH_MARKERS) {
      if (url.toLowerCase().includes(marker.toLowerCase())) {
        throw new Error(`REFUSED: secret-value surface in URL: ${marker}`);
      }
    }
  }

  if (rg) {
    if (!isAllowedRg(rg)) {
      throw new Error(`REFUSED: resource group out of scope: ${rg}`);
    }
    if (isForbiddenRg(rg)) {
      throw new Error(`REFUSED: production/forbidden RG: ${rg}`);
    }
  }

  const blob = `${command}\n${url}`.toLowerCase();
  for (const marker of SECRET_VALUE_PATH_MARKERS) {
    if (blob.includes(marker.toLowerCase())) {
      throw new Error(`REFUSED: secret-value surface: ${marker}`);
    }
  }
  for (const marker of DB_SURFACE_MARKERS) {
    if (blob.includes(marker.toLowerCase())) {
      throw new Error(`REFUSED: DB surface: ${marker}`);
    }
  }

  // Healthz hosts whitelist
  if (methodId === 'public_healthz_get') {
    const hostMatch = url.match(/^https:\/\/([^/]+)\/healthz$/i);
    if (!hostMatch || !PUBLIC_HEALTHZ_HOSTS.includes(hostMatch[1])) {
      throw new Error(`REFUSED: healthz host not in staging allowlist: ${url}`);
    }
  }

  return true;
}

function stripSecretsDeep(value, keyHint) {
  if (Array.isArray(value)) {
    return value.map((v) => stripSecretsDeep(v, keyHint));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const lk = k.toLowerCase();
      if (
        lk.includes('connectionstring')
        || lk.includes('instrumentationkey')
        || lk.includes('password')
        || lk.includes('secret')
        || lk.includes('primarykey')
        || lk.includes('apikey')
        || lk === 'value' && /secret|password|key|token/i.test(String(keyHint || ''))
      ) {
        out[k] = typeof v === 'string' && v.length > 0 ? '[REDACTED]' : null;
        continue;
      }
      out[k] = stripSecretsDeep(v, k);
    }
    return out;
  }
  if (typeof value === 'string') {
    if (/^postgres(ql)?:\/\//i.test(value)) return '[REDACTED_DSN]';
    if (/InstrumentationKey=/i.test(value)) return '[REDACTED_AI_CONN]';
  }
  return value;
}

function suffixId(id, keep) {
  const s = String(id || '');
  if (s.length <= keep) return s;
  return s.slice(-keep);
}

function buildCaptureManifest() {
  return {
    schema_version: 1,
    slice: 'RADAR-16A2',
    title: 'Exact read-only Azure capture manifest',
    allowed_subscription_id: ALLOWED_SUBSCRIPTION_ID,
    allowed_resource_groups: [...ALLOWED_RESOURCE_GROUPS],
    forbidden_resource_groups: [...FORBIDDEN_RESOURCE_GROUPS],
    allowed_method_inventory: ALLOWED_METHOD_INVENTORY.map((m) => ({ ...m })),
    sampled_diagnostic_resources: SAMPLED_DIAGNOSTIC_RESOURCES.map((r) => ({ ...r })),
    public_healthz_hosts: [...PUBLIC_HEALTHZ_HOSTS],
    mutation_policy: {
      deploys: 0,
      restarts: 0,
      db_reads: 0,
      secret_value_reads: 0,
      guest_actions: 0,
      payment_actions: 0,
      production_queries: 0,
      azure_methods_allowed: ['GET', 'CostManagement/query POST read-only'],
    },
    pre_dispatch_rule:
      'assertAllowedBeforeDispatch must pass before any az/rest/https call',
  };
}

/**
 * Offline RED tests — must refuse production / secret / DB / mutation surfaces.
 * Returns { pass, fail, cases: [{id, ok, detail}] }.
 */
function runCaptureRedTests() {
  const cases = [];
  function red(id, fn) {
    try {
      fn();
      cases.push({ id, ok: false, detail: 'expected throw, got success' });
    } catch (err) {
      const msg = String(err && err.message || err);
      cases.push({ id, ok: /REFUSED/.test(msg), detail: msg.slice(0, 200) });
    }
  }

  red('production_rg_wh_prod', () => {
    assertAllowedBeforeDispatch({
      methodId: 'arm_rg_show',
      method: 'GET',
      rg: 'wh-prod-rg',
      url: `/subscriptions/${ALLOWED_SUBSCRIPTION_ID}/resourceGroups/wh-prod-rg`,
    });
  });

  red('production_rg_wolfhouse_prod', () => {
    assertAllowedBeforeDispatch({
      methodId: 'arm_resource_list',
      method: 'GET',
      rg: 'wolfhouse-prod-rg',
      url: `/subscriptions/${ALLOWED_SUBSCRIPTION_ID}/resourceGroups/wolfhouse-prod-rg/resources`,
    });
  });

  red('wrong_subscription', () => {
    assertAllowedBeforeDispatch({
      methodId: 'arm_rg_show',
      method: 'GET',
      rg: 'wh-staging-rg',
      url: '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/wh-staging-rg',
    });
  });

  red('secret_value_listSecrets', () => {
    assertAllowedBeforeDispatch({
      methodId: 'containerapp_show',
      method: 'GET',
      rg: 'wh-staging-rg',
      url:
        `/subscriptions/${ALLOWED_SUBSCRIPTION_ID}/resourceGroups/wh-staging-rg`
        + '/providers/Microsoft.App/containerApps/wh-staging-staff-api/listSecrets',
      command: 'az containerapp secret list',
    });
  });

  red('secret_value_kv_show', () => {
    assertAllowedBeforeDispatch({
      methodId: 'arm_resource_list',
      method: 'GET',
      rg: 'wh-staging-rg',
      command: 'az keyvault secret show --vault-name wh-staging-kv -n db-url',
      url: '',
    });
  });

  red('db_psql_surface', () => {
    assertAllowedBeforeDispatch({
      methodId: 'postgres_flexible_show',
      method: 'GET',
      rg: 'luna-sunset-staging-rg',
      command: 'psql postgresql://observer@host/db',
      url: '',
    });
  });

  red('mutation_put_budget', () => {
    assertAllowedBeforeDispatch({
      methodId: 'consumption_budgets_list',
      method: 'PUT',
      rg: 'wh-staging-rg',
      url:
        `/subscriptions/${ALLOWED_SUBSCRIPTION_ID}/resourceGroups/wh-staging-rg`
        + '/providers/Microsoft.Consumption/budgets/x',
    });
  });

  red('mutation_post_non_cost', () => {
    assertAllowedBeforeDispatch({
      methodId: 'action_groups_list',
      method: 'POST',
      rg: 'wh-staging-rg',
      url:
        `/subscriptions/${ALLOWED_SUBSCRIPTION_ID}/resourceGroups/wh-staging-rg`
        + '/providers/Microsoft.Insights/actionGroups',
    });
  });

  red('unknown_method_id', () => {
    assertAllowedBeforeDispatch({
      methodId: 'deploy_bicep',
      method: 'GET',
      rg: 'wh-staging-rg',
    });
  });

  red('healthz_prod_host', () => {
    assertAllowedBeforeDispatch({
      methodId: 'public_healthz_get',
      method: 'GET',
      url: 'https://staff.lunafrontdesk.com/healthz',
    });
  });

  const pass = cases.filter((c) => c.ok).length;
  const fail = cases.length - pass;
  return { pass, fail, cases };
}

function findAzBin() {
  const candidates = [
    process.env.AZ_BIN,
    '/opt/data/.local/bin/az',
    '/opt/data/.local/share/azure-cli-venv/bin/az',
    'az',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (c === 'az' || fs.existsSync(c)) return c;
    } catch (_) {
      /* ignore */
    }
  }
  return 'az';
}

function sleepMs(ms) {
  const seconds = Math.max(1, Math.ceil(Number(ms) / 1000));
  try {
    execFileSync('sleep', [String(seconds)], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch (_) {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* fallback busy-wait */ }
  }
}

function azJson(args, opts) {
  const az = findAzBin();
  const options = opts || {};
  const retries = options.retries != null ? options.retries : 4;
  const execOpts = { ...options };
  delete execOpts.retries;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const out = execFileSync(az, args, {
        encoding: 'utf8',
        maxBuffer: 12 * 1024 * 1024,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
        ...execOpts,
      });
      const s = String(out || '').replace(/^\uFEFF/, '').trim();
      if (!s) return null;
      const iObj = s.indexOf('{');
      const iArr = s.indexOf('[');
      let i = -1;
      if (iObj >= 0 && iArr >= 0) i = Math.min(iObj, iArr);
      else i = Math.max(iObj, iArr);
      if (i < 0) throw new Error(`az returned non-JSON: ${s.slice(0, 120)}`);
      return JSON.parse(s.slice(i));
    } catch (err) {
      lastErr = err;
      const msg = String((err && err.stderr) || (err && err.message) || err);
      if (/429|Too Many Requests|RetryAfter/i.test(msg) && attempt < retries) {
        sleepMs(8000 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function dispatchAz(methodId, method, args, meta) {
  const command = `az ${args.join(' ')}`;
  assertAllowedBeforeDispatch({
    methodId,
    method,
    command,
    rg: meta && meta.rg,
    url: meta && meta.url,
  });
  const started = new Date().toISOString();
  const raw = azJson(args);
  sleepMs(400);
  const sanitized = stripSecretsDeep(raw);
  const finished = new Date().toISOString();
  return {
    method_id: methodId,
    method,
    command,
    rest_path: (meta && meta.rest_path) || null,
    api_version: (meta && meta.api_version) || null,
    rg: (meta && meta.rg) || null,
    started_at_utc: started,
    finished_at_utc: finished,
    response_sha256: hashCanonical(sanitized),
    response: sanitized,
  };
}

function dispatchRestGet(methodId, url, meta) {
  assertAllowedBeforeDispatch({
    methodId,
    method: 'GET',
    url,
    rg: meta && meta.rg,
    command: `az rest --method get --url ${url}`,
  });
  const started = new Date().toISOString();
  const raw = azJson(['rest', '--method', 'get', '--url', url, '-o', 'json']);
  const sanitized = stripSecretsDeep(raw);
  const finished = new Date().toISOString();
  return {
    method_id: methodId,
    method: 'GET',
    command: `az rest --method get --url ${url}`,
    rest_path: url.replace(`https://management.azure.com`, ''),
    api_version: (meta && meta.api_version) || null,
    rg: (meta && meta.rg) || null,
    started_at_utc: started,
    finished_at_utc: finished,
    response_sha256: hashCanonical(sanitized),
    response: sanitized,
  };
}

function dispatchCostQuery(rg, bodyPath) {
  const url =
    `https://management.azure.com/subscriptions/${ALLOWED_SUBSCRIPTION_ID}`
    + `/resourceGroups/${rg}/providers/Microsoft.CostManagement/query`
    + '?api-version=2023-11-01';
  assertAllowedBeforeDispatch({
    methodId: 'cost_query',
    method: 'POST',
    url,
    rg,
    command: `az rest --method post --url ${url} --body @${bodyPath}`,
  });
  const started = new Date().toISOString();
  const raw = azJson(
    ['rest', '--method', 'post', '--url', url, '--body', `@${bodyPath}`, '-o', 'json'],
    { retries: 6 },
  );
  const sanitized = stripSecretsDeep(raw);
  const finished = new Date().toISOString();
  return {
    method_id: 'cost_query',
    method: 'POST',
    command: `az rest --method post --url ${url} --body @${bodyPath}`,
    rest_path:
      `/subscriptions/${ALLOWED_SUBSCRIPTION_ID}/resourceGroups/${rg}`
      + '/providers/Microsoft.CostManagement/query',
    api_version: '2023-11-01',
    rg,
    started_at_utc: started,
    finished_at_utc: finished,
    response_sha256: hashCanonical(sanitized),
    response: sanitized,
  };
}

function httpsGetJson(url) {
  // Prefer curl — Node TLS to these hostnames can stall in this environment.
  try {
    const out = execFileSync(
      'curl',
      ['-sS', '-m', '45', '-w', '\n__HTTP_STATUS__:%{http_code}', url],
      { encoding: 'utf8', maxBuffer: 1024 * 1024, windowsHide: true },
    );
    const marker = '\n__HTTP_STATUS__:';
    const idx = out.lastIndexOf(marker);
    const bodyText = idx >= 0 ? out.slice(0, idx) : out;
    const status = idx >= 0 ? Number(out.slice(idx + marker.length).trim()) : 0;
    let parsed = null;
    try {
      parsed = JSON.parse(bodyText);
    } catch (_) {
      parsed = { raw: bodyText.slice(0, 200) };
    }
    return Promise.resolve({ status, body: parsed });
  } catch (curlErr) {
    return new Promise((resolve, reject) => {
      const lib = url.startsWith('https') ? https : http;
      const req = lib.get(url, { timeout: 45000 }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try {
            parsed = JSON.parse(body);
          } catch (_) {
            parsed = { raw: body.slice(0, 200) };
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('error', (err) => reject(err || curlErr));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('healthz timeout'));
      });
    });
  }
}

async function dispatchHealthz(host) {
  const url = `https://${host}/healthz`;
  assertAllowedBeforeDispatch({
    methodId: 'public_healthz_get',
    method: 'GET',
    url,
  });
  const started = new Date().toISOString();
  const { status, body } = await httpsGetJson(url);
  const sanitized = stripSecretsDeep(body);
  const finished = new Date().toISOString();
  return {
    method_id: 'public_healthz_get',
    method: 'GET',
    command: `HTTPS GET ${url}`,
    rest_path: url,
    api_version: null,
    rg: null,
    started_at_utc: started,
    finished_at_utc: finished,
    response_sha256: hashCanonical({ status, body: sanitized }),
    response: { status, body: sanitized },
  };
}

function parseCostTotal(costResponse) {
  const cols = (costResponse && costResponse.properties && costResponse.properties.columns) || [];
  const rows = (costResponse && costResponse.properties && costResponse.properties.rows) || [];
  const costIdx = cols.findIndex((c) => /cost/i.test(c.name) && !/currency/i.test(c.name));
  const svcIdx = cols.findIndex((c) => /ServiceName|ServiceTier/i.test(c.name) || c.name === 'ServiceName');
  // Prefer MeterCategory / ServiceName grouping
  let serviceNameIdx = cols.findIndex((c) => c.name === 'ServiceName');
  if (serviceNameIdx < 0) {
    serviceNameIdx = cols.findIndex((c) => /service/i.test(c.name));
  }
  const byServiceMap = new Map();
  let total = 0;
  for (const row of rows) {
    const cost = Number(row[costIdx >= 0 ? costIdx : 0]) || 0;
    total += cost;
    const svc = serviceNameIdx >= 0 ? String(row[serviceNameIdx] || 'Unknown') : 'All';
    byServiceMap.set(svc, (byServiceMap.get(svc) || 0) + cost);
  }
  const by_service = [...byServiceMap.entries()]
    .map(([service, cost]) => ({ service, cost }))
    .sort((a, b) => b.cost - a.cost);
  return { total, by_service, currency: 'USD' };
}

function resourceId(rg, type, name) {
  return (
    `/subscriptions/${ALLOWED_SUBSCRIPTION_ID}/resourceGroups/${rg}`
    + `/providers/${type}/${name}`
  );
}

/**
 * Live capture — staging RGs only. Returns { inventory, capture_log }.
 */
async function captureStagingReadonly(opts) {
  const options = opts || {};
  const tmpDir = options.tmpDir || path.join(process.cwd(), 'tmp', 'radar-16a2-capture');
  fs.mkdirSync(tmpDir, { recursive: true });
  const log = [];

  // Preflight subscription
  const account = dispatchAz(
    'arm_account_show',
    'GET',
    ['account', 'show', '-o', 'json'],
    { rest_path: null, api_version: null },
  );
  log.push(omitResponse(account));
  if (String(account.response && account.response.id) !== ALLOWED_SUBSCRIPTION_ID) {
    throw new Error(`REFUSED: active subscription mismatch: ${account.response && account.response.id}`);
  }

  const resource_groups = {};
  for (const rg of ALLOWED_RESOURCE_GROUPS) {
    const show = dispatchAz(
      'arm_rg_show',
      'GET',
      ['group', 'show', '-n', rg, '-o', 'json'],
      {
        rg,
        url: `/subscriptions/${ALLOWED_SUBSCRIPTION_ID}/resourceGroups/${rg}?api-version=2021-04-01`,
        rest_path: `/subscriptions/${ALLOWED_SUBSCRIPTION_ID}/resourceGroups/${rg}`,
        api_version: '2021-04-01',
      },
    );
    log.push(omitResponse(show));
    const list = dispatchAz(
      'arm_resource_list',
      'GET',
      ['resource', 'list', '-g', rg, '-o', 'json'],
      {
        rg,
        url: `/subscriptions/${ALLOWED_SUBSCRIPTION_ID}/resourceGroups/${rg}/resources?api-version=2021-04-01`,
        rest_path: `/subscriptions/${ALLOWED_SUBSCRIPTION_ID}/resourceGroups/${rg}/resources`,
        api_version: '2021-04-01',
      },
    );
    log.push(omitResponse(list));
    const names = (list.response || [])
      .map((r) => r.name)
      .filter(Boolean)
      .sort();
    resource_groups[rg] = {
      location: show.response && show.response.location,
      provisioningState: show.response
        && show.response.properties
        && show.response.properties.provisioningState,
      resource_names: names,
    };
  }

  // Costs last-ish with throttle cooldown (Cost Management 429s easily)
  sleepMs(45000);
  const today = new Date();
  const from = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const to = today.toISOString().slice(0, 10);
  const body = {
    type: 'ActualCost',
    timeframe: 'Custom',
    timePeriod: { from, to },
    dataset: {
      granularity: 'None',
      aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
      grouping: [{ type: 'Dimension', name: 'ServiceName' }],
    },
  };
  const bodyPath = path.join(tmpDir, 'cost-query-body.json');
  fs.writeFileSync(bodyPath, `${JSON.stringify(body)}\n`);

  const costs_mtd = {
    timeframe: 'MonthToDate',
    currency: 'USD',
    api: 'Microsoft.CostManagement/query ActualCost',
    period: { from, to },
  };
  let combined = 0;
  for (const rg of ALLOWED_RESOURCE_GROUPS) {
    const costCall = dispatchCostQuery(rg, bodyPath);
    log.push(omitResponse(costCall));
    const parsed = parseCostTotal(costCall.response);
    costs_mtd[rg] = {
      total: parsed.total,
      by_service: parsed.by_service,
    };
    combined += parsed.total;
    sleepMs(15000);
  }
  costs_mtd.combined_total = combined;

  // Budgets
  const budgets = {};
  for (const rg of ALLOWED_RESOURCE_GROUPS) {
    const url =
      `https://management.azure.com/subscriptions/${ALLOWED_SUBSCRIPTION_ID}`
      + `/resourceGroups/${rg}/providers/Microsoft.Consumption/budgets`
      + '?api-version=2023-11-01';
    const call = dispatchRestGet('consumption_budgets_list', url, {
      rg,
      api_version: '2023-11-01',
    });
    log.push(omitResponse(call));
    const value = (call.response && call.response.value) || call.response || [];
    budgets[rg] = Array.isArray(value)
      ? value.map((b) => ({
        name: b.name,
        amount: b.properties && b.properties.amount,
        timeGrain: b.properties && b.properties.timeGrain,
        category: b.properties && b.properties.category,
        notifications_count: b.properties && b.properties.notifications
          ? Object.keys(b.properties.notifications).length
          : 0,
      }))
      : [];
  }

  // Alerts + action groups
  const alerts = {};
  const action_groups = {};
  for (const rg of ALLOWED_RESOURCE_GROUPS) {
    const metric = dispatchAz(
      'metric_alerts_list',
      'GET',
      ['monitor', 'metrics', 'alert', 'list', '-g', rg, '-o', 'json'],
      {
        rg,
        rest_path:
          `/subscriptions/${ALLOWED_SUBSCRIPTION_ID}/resourceGroups/${rg}`
          + '/providers/Microsoft.Insights/metricAlerts',
        api_version: '2018-03-01',
      },
    );
    log.push(omitResponse(metric));
    const activity = dispatchAz(
      'activity_log_alerts_list',
      'GET',
      ['monitor', 'activity-log', 'alert', 'list', '-g', rg, '-o', 'json'],
      {
        rg,
        rest_path:
          `/subscriptions/${ALLOWED_SUBSCRIPTION_ID}/resourceGroups/${rg}`
          + '/providers/Microsoft.Insights/activityLogAlerts',
        api_version: '2020-10-01',
      },
    );
    log.push(omitResponse(activity));
    let scheduled = { response: [] };
    try {
      scheduled = dispatchAz(
        'scheduled_query_rules_list',
        'GET',
        ['monitor', 'scheduled-query', 'list', '-g', rg, '-o', 'json'],
        {
          rg,
          rest_path:
            `/subscriptions/${ALLOWED_SUBSCRIPTION_ID}/resourceGroups/${rg}`
            + '/providers/Microsoft.Insights/scheduledQueryRules',
          api_version: '2023-03-15-preview',
        },
      );
      log.push(omitResponse(scheduled));
    } catch (err) {
      log.push({
        method_id: 'scheduled_query_rules_list',
        method: 'GET',
        rg,
        error: String(err && err.message || err).slice(0, 200),
        response_sha256: null,
      });
      scheduled = { response: [] };
    }
    alerts[rg] = {
      metric_alerts: (metric.response || []).map((a) => a.name),
      activity_log_alerts: (activity.response || []).map((a) => a.name),
      scheduled_query_rules: (scheduled.response || []).map((a) => a.name),
    };

    const ag = dispatchAz(
      'action_groups_list',
      'GET',
      ['monitor', 'action-group', 'list', '-g', rg, '-o', 'json'],
      {
        rg,
        rest_path:
          `/subscriptions/${ALLOWED_SUBSCRIPTION_ID}/resourceGroups/${rg}`
          + '/providers/Microsoft.Insights/actionGroups',
        api_version: '2023-01-01',
      },
    );
    log.push(omitResponse(ag));
    action_groups[rg] = (ag.response || []).map((g) => ({
      name: g.name,
      enabled: g.enabled !== false,
      email_receivers_count: (g.emailReceivers || []).length,
      sms_receivers_count: (g.smsReceivers || []).length,
      webhook_receivers_count: (g.webhookReceivers || []).length,
      arm_role_receivers: (g.armRoleReceivers || []).map((r) => r.name || r.roleId || r),
      note: g.name === 'Application Insights Smart Detection'
        ? 'Default Smart Detection group; not ops on-call notify'
        : undefined,
    }));
  }

  // Diagnostic settings — sampled only
  const diagnostic_settings = {
    sampling_policy: 'explicit_allowlist_only',
    sampled_resources: [],
    sampled_resources_with_settings: [],
    note:
      'Absence of settings is qualified to the sampled allowlist only; '
      + 'not an exhaustive claim over every resource in either RG',
  };
  for (const sample of SAMPLED_DIAGNOSTIC_RESOURCES) {
    const rid = resourceId(sample.rg, sample.type, sample.name);
    const call = dispatchAz(
      'diagnostic_settings_list',
      'GET',
      ['monitor', 'diagnostic-settings', 'list', '--resource', rid, '-o', 'json'],
      {
        rg: sample.rg,
        url: `${rid}/providers/Microsoft.Insights/diagnosticSettings?api-version=2021-05-01-preview`,
        rest_path: `${rid}/providers/Microsoft.Insights/diagnosticSettings`,
        api_version: '2021-05-01-preview',
      },
    );
    log.push(omitResponse(call));
    const value = (call.response && call.response.value) || call.response || [];
    const names = Array.isArray(value) ? value.map((d) => d.name).filter(Boolean) : [];
    diagnostic_settings.sampled_resources.push({
      rg: sample.rg,
      name: sample.name,
      type: sample.type,
      settings_count: names.length,
      setting_names: names,
    });
    if (names.length > 0) {
      diagnostic_settings.sampled_resources_with_settings.push({
        rg: sample.rg,
        name: sample.name,
        settings: names,
      });
    }
  }

  // ACA env logging
  const aca_env_logging = {};
  const envs = [
    { rg: 'wh-staging-rg', name: 'wh-staging-env' },
    { rg: 'luna-sunset-staging-rg', name: 'luna-sunset-staging-env' },
  ];
  for (const env of envs) {
    const call = dispatchAz(
      'containerapp_env_show',
      'GET',
      ['containerapp', 'env', 'show', '-g', env.rg, '-n', env.name, '-o', 'json'],
      {
        rg: env.rg,
        rest_path:
          `/subscriptions/${ALLOWED_SUBSCRIPTION_ID}/resourceGroups/${env.rg}`
          + `/providers/Microsoft.App/managedEnvironments/${env.name}`,
        api_version: '2024-03-01',
      },
    );
    log.push(omitResponse(call));
    const props = (call.response && call.response.properties) || {};
    const appLogs = props.appLogsConfiguration || {};
    const dest = appLogs.destination || null;
    const cust = appLogs.logAnalyticsConfiguration && appLogs.logAnalyticsConfiguration.customerId;
    aca_env_logging[env.name] = {
      logsDestination: dest,
      law_customer_id_suffix: cust ? suffixId(cust, 5) : undefined,
    };
  }

  // Retention + App Insights effective retention qualification
  const retention = {};
  const lawNames = [
    { rg: 'wh-staging-rg', name: 'wh-staging-logs' },
    { rg: 'luna-sunset-staging-rg', name: 'luna-sunset-staging-logs' },
  ];
  for (const law of lawNames) {
    const call = dispatchAz(
      'law_show',
      'GET',
      ['monitor', 'log-analytics', 'workspace', 'show', '-g', law.rg, '-n', law.name, '-o', 'json'],
      {
        rg: law.rg,
        rest_path:
          `/subscriptions/${ALLOWED_SUBSCRIPTION_ID}/resourceGroups/${law.rg}`
          + `/providers/Microsoft.OperationalInsights/workspaces/${law.name}`,
        api_version: '2022-10-01',
      },
    );
    log.push(omitResponse(call));
    const props = (call.response && call.response.properties) || call.response || {};
    retention[law.name] = {
      retentionInDays: props.retentionInDays,
      sku: props.sku && props.sku.name,
      dailyQuotaGb: props.workspaceCapping && props.workspaceCapping.dailyQuotaGb,
    };
  }

  const aiNames = [
    { rg: 'wh-staging-rg', name: 'wh-staging-appinsights', law: 'wh-staging-logs' },
    {
      rg: 'luna-sunset-staging-rg',
      name: 'luna-sunset-staging-appinsights',
      law: 'luna-sunset-staging-logs',
    },
  ];
  for (const ai of aiNames) {
    const call = dispatchAz(
      'appinsights_show',
      'GET',
      ['monitor', 'app-insights', 'component', 'show', '-g', ai.rg, '-a', ai.name, '-o', 'json'],
      {
        rg: ai.rg,
        rest_path:
          `/subscriptions/${ALLOWED_SUBSCRIPTION_ID}/resourceGroups/${ai.rg}`
          + `/providers/Microsoft.Insights/components/${ai.name}`,
        api_version: '2020-02-02',
      },
    );
    log.push(omitResponse(call));
    const props = call.response || {};
    const ingestionMode = props.ingestionMode || (props.properties && props.properties.IngestionMode);
    const workspaceResourceId = props.WorkspaceResourceId
      || props.workspaceResourceId
      || (props.properties && props.properties.WorkspaceResourceId);
    const componentRetention = props.retentionInDays
      || (props.properties && props.properties.RetentionInDays);
    const workspaceBased = Boolean(workspaceResourceId)
      || String(ingestionMode || '').toLowerCase() === 'loganalytics';
    const lawRetention = retention[ai.law] && retention[ai.law].retentionInDays;
    retention[ai.name] = {
      component_retentionInDays: componentRetention,
      ingestionMode: ingestionMode || null,
      workspace_based: workspaceBased,
      workspace_name: ai.law,
      workspace_resource_id_suffix: workspaceResourceId
        ? suffixId(workspaceResourceId, 24)
        : null,
      // For workspace-based App Insights, analytics query retention is LAW retention.
      effective_analytics_retentionInDays: workspaceBased ? lawRetention : componentRetention,
      qualification:
        workspaceBased
          ? 'workspace-based App Insights: effective analytics retention follows linked LAW, '
            + 'not component retentionInDays alone'
          : 'classic App Insights: component retentionInDays applies',
    };
  }

  // Container apps
  const container_apps = {};
  const apps = [
    { rg: 'wh-staging-rg', name: 'wh-staging-staff-api' },
    { rg: 'luna-sunset-staging-rg', name: 'luna-sunset-staging-staff-api' },
  ];
  for (const app of apps) {
    const call = dispatchAz(
      'containerapp_show',
      'GET',
      ['containerapp', 'show', '-g', app.rg, '-n', app.name, '-o', 'json'],
      {
        rg: app.rg,
        rest_path:
          `/subscriptions/${ALLOWED_SUBSCRIPTION_ID}/resourceGroups/${app.rg}`
          + `/providers/Microsoft.App/containerApps/${app.name}`,
        api_version: '2024-03-01',
      },
    );
    log.push(omitResponse(call));
    const props = (call.response && call.response.properties) || {};
    const template = props.template || {};
    const scale = template.scale || {};
    const containers = template.containers || [];
    const resources = (containers[0] && containers[0].resources) || {};
    const probes = containers[0] && containers[0].probes;
    const fqdn = props.configuration && props.configuration.ingress
      && props.configuration.ingress.fqdn;
    container_apps[app.name] = {
      runningStatus: props.runningStatus || props.provisioningState,
      cpu: resources.cpu,
      memory: resources.memory,
      minReplicas: scale.minReplicas,
      maxReplicas: scale.maxReplicas,
      scale_rules: scale.rules == null ? null : scale.rules,
      probes: probes == null ? null : probes,
      ingress_fqdn_suffix: fqdn ? fqdn.split('.').slice(-3).join('.') : null,
      targetPort: props.configuration && props.configuration.ingress
        && props.configuration.ingress.targetPort,
    };
  }

  // Jobs
  const jobs = [];
  const jobNames = [
    { rg: 'luna-sunset-staging-rg', name: 'luna-sunset-staging-hold-expiry' },
    { rg: 'luna-sunset-staging-rg', name: 'luna-sunset-staging-sch-obs' },
  ];
  for (const job of jobNames) {
    const call = dispatchAz(
      'containerapp_job_show',
      'GET',
      ['containerapp', 'job', 'show', '-g', job.rg, '-n', job.name, '-o', 'json'],
      {
        rg: job.rg,
        rest_path:
          `/subscriptions/${ALLOWED_SUBSCRIPTION_ID}/resourceGroups/${job.rg}`
          + `/providers/Microsoft.App/jobs/${job.name}`,
        api_version: '2024-03-01',
      },
    );
    log.push(omitResponse(call));
    const props = (call.response && call.response.properties) || {};
    const cfg = props.configuration || {};
    const schedule = cfg.scheduleTriggerConfig || {};
    const entry = {
      name: job.name,
      triggerType: cfg.triggerType,
      replicaTimeout: cfg.replicaTimeout,
    };
    if (schedule.cronExpression) entry.cronExpression = schedule.cronExpression;
    if (cfg.replicaCompletionCount != null) entry.parallelism = cfg.parallelism;
    else if (cfg.parallelism != null) entry.parallelism = cfg.parallelism;
    jobs.push(entry);
  }

  // Postgres backups
  const postgres_backups = [];
  const pgs = [
    { rg: 'wh-staging-rg', name: 'wh-staging-pg-app' },
    { rg: 'wh-staging-rg', name: 'wh-staging-pg-n8n' },
    { rg: 'luna-sunset-staging-rg', name: 'luna-sunset-staging-pg-app' },
  ];
  for (const pg of pgs) {
    const call = dispatchAz(
      'postgres_flexible_show',
      'GET',
      ['postgres', 'flexible-server', 'show', '-g', pg.rg, '-n', pg.name, '-o', 'json'],
      {
        rg: pg.rg,
        rest_path:
          `/subscriptions/${ALLOWED_SUBSCRIPTION_ID}/resourceGroups/${pg.rg}`
          + `/providers/Microsoft.DBforPostgreSQL/flexibleServers/${pg.name}`,
        api_version: '2023-12-01-preview',
      },
    );
    log.push(omitResponse(call));
    const r = call.response || {};
    postgres_backups.push({
      name: pg.name,
      version: r.version,
      sku: r.sku && r.sku.name,
      backupRetentionDays: r.backup && r.backup.backupRetentionDays,
      geoRedundant: r.backup && r.backup.geoRedundantBackup,
      state: r.state,
    });
  }

  // Public healthz
  const public_healthz = {};
  for (const host of PUBLIC_HEALTHZ_HOSTS) {
    const call = await dispatchHealthz(host);
    log.push(omitResponse(call));
    const body = (call.response && call.response.body) || {};
    public_healthz[host] = {
      path: '/healthz',
      http_status: call.response && call.response.status,
      body_status: body.status,
      service: body.service,
      auth_enabled: body.auth_enabled,
      stage: body.stage,
      dependency_fields_present: Boolean(
        body.postgres || body.stripe || body.redis || body.dependencies,
      ),
      // Config feature flags (stormglass/luna_ai) are not dependency readiness probes.
      config_flags_present: Boolean(body.stormglass || body.luna_ai),
    };
  }

  const captured_at_utc = new Date().toISOString();
  const inventory = {
    schema_version: 1,
    slice: 'RADAR-16A2',
    captured_at_utc,
    subscription_id_suffix: suffixId(ALLOWED_SUBSCRIPTION_ID, 12),
    read_only: true,
    live_mutation: false,
    scope_resource_groups: [...ALLOWED_RESOURCE_GROUPS],
    mutation_policy: buildCaptureManifest().mutation_policy,
    capture_provenance: {
      tool: 'scripts/capture-radar-operations-staging-readonly.js',
      lib: 'scripts/lib/radar-operations-azure-capture.js',
      manifest: 'fixtures/radar-operations/capture-manifest.json',
      allowed_method_ids: [...ALLOWED_METHOD_IDS],
      call_count: log.length,
      response_hashes: log.map((e) => ({
        method_id: e.method_id,
        rg: e.rg || null,
        started_at_utc: e.started_at_utc,
        response_sha256: e.response_sha256,
        rest_path: e.rest_path,
        api_version: e.api_version,
      })),
    },
    resource_groups,
    costs_mtd,
    budgets,
    alerts,
    action_groups,
    diagnostic_settings,
    aca_env_logging,
    retention,
    container_apps,
    jobs,
    postgres_backups,
    public_healthz,
  };

  return {
    inventory,
    capture_log: {
      schema_version: 1,
      slice: 'RADAR-16A2',
      captured_at_utc,
      allowed_subscription_id: ALLOWED_SUBSCRIPTION_ID,
      allowed_resource_groups: [...ALLOWED_RESOURCE_GROUPS],
      allowed_method_inventory: ALLOWED_METHOD_INVENTORY.map((m) => ({
        id: m.id,
        method: m.method,
        rest_path: m.rest_path,
        api_version: m.api_version,
      })),
      calls: log,
    },
  };
}

function omitResponse(entry) {
  const { response, ...rest } = entry;
  return rest;
}

module.exports = {
  ALLOWED_SUBSCRIPTION_ID,
  ALLOWED_RESOURCE_GROUPS,
  FORBIDDEN_RESOURCE_GROUPS,
  ALLOWED_METHOD_INVENTORY,
  ALLOWED_METHOD_IDS,
  SAMPLED_DIAGNOSTIC_RESOURCES,
  PUBLIC_HEALTHZ_HOSTS,
  sha256Hex,
  hashCanonical,
  canonicalJson,
  assertAllowedBeforeDispatch,
  stripSecretsDeep,
  buildCaptureManifest,
  runCaptureRedTests,
  captureStagingReadonly,
  parseCostTotal,
};
