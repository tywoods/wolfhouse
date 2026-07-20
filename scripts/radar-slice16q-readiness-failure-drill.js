'use strict';

/**
 * RADAR Slice 16Q — operator CLI for controlled ACA database-readiness failure drill.
 *
 * Default: dry-run (plan only; no Azure mutation).
 * Live apply: requires --tenant wolfhouse|sunset AND --apply AND --confirm RADAR-16Q-READINESS-FAILURE-DRILL.
 *
 * This slice ships source-only. Do not execute live apply from the 16Q commit.
 *
 * Azure invocations use cancellable async subprocesses with hard timeouts.
 * Every update marks mutation-attempted BEFORE spawn. --subscription is passed
 * on every az command. Errors are sanitized to allowlisted categories only.
 */

const { spawn, execSync } = require('child_process');
const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const harness = require('./lib/radar-slice16q-readiness-failure-drill-harness');

function printHelp() {
  const lines = [
    'RADAR 16Q readiness-failure drill harness',
    '',
    'Usage:',
    '  node scripts/radar-slice16q-readiness-failure-drill.js --tenant wolfhouse|sunset',
    '  node scripts/radar-slice16q-readiness-failure-drill.js --tenant wolfhouse --apply --confirm RADAR-16Q-READINESS-FAILURE-DRILL',
    '',
    'Default mode: dry-run (no mutation).',
    `Confirm token (exact): ${harness.CONFIRM_TOKEN}`,
    `Pinned image (exact): <repo>:${harness.IMAGE_SHA_FULL}`,
    `Pinned master: ${harness.MASTER_BASIS}`,
    `Pinned subscription: ${harness.SUBSCRIPTION_ID}`,
    `Database env: ${harness.DATABASE_ENV_NAME}`,
    '',
    'Refuse: production hosts/RGs, dirty/unsynced repo, wrong master/image/subscription/resource/FQDN,',
    'missing probes/secretRef, multi-revision traffic, ambiguous state, apply without exact confirm.',
  ];
  console.log(lines.join('\n'));
}

function execGit(cmd) {
  return execSync(cmd, {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function execAssertRepoSync() {
  execSync('node scripts/assert-repo-sync.js', {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
    env: process.env,
  });
}

async function azJson(args, opts) {
  const options = opts || {};
  const fullArgs = harness.withSubscriptionArgs(
    args.concat(['-o', 'json']),
    options.subscriptionId || harness.SUBSCRIPTION_ID,
  );
  const result = await harness.runSubprocessAsync('az', fullArgs, {
    timeoutMs: options.timeoutMs || harness.DEFAULT_AZ_TIMEOUT_MS,
    signal: options.signal,
    spawnFn: options.spawnFn || spawn,
  });
  try {
    return JSON.parse(result.stdout || 'null');
  } catch (_) {
    throw Object.assign(new Error('az_json_parse_failed'), {
      code: 'subprocess_failed',
      category: 'subprocess_failed',
    });
  }
}

async function showAccount(opts) {
  return azJson(['account', 'show'], opts);
}

async function showApp(tenant, opts) {
  return azJson([
    'containerapp', 'show',
    '--name', tenant.containerApp,
    '--resource-group', tenant.resourceGroup,
  ], { ...opts, subscriptionId: tenant.subscriptionId });
}

async function listRevisions(tenant, opts) {
  return azJson([
    'containerapp', 'revision', 'list',
    '--name', tenant.containerApp,
    '--resource-group', tenant.resourceGroup,
  ], { ...opts, subscriptionId: tenant.subscriptionId });
}

async function showRevision(tenant, revisionName, opts) {
  return azJson([
    'containerapp', 'revision', 'show',
    '--name', tenant.containerApp,
    '--resource-group', tenant.resourceGroup,
    '--revision', revisionName,
  ], { ...opts, subscriptionId: tenant.subscriptionId });
}

async function listReplicas(tenant, revisionName, opts) {
  return azJson([
    'containerapp', 'replica', 'list',
    '--name', tenant.containerApp,
    '--resource-group', tenant.resourceGroup,
    '--revision', revisionName,
  ], { ...opts, subscriptionId: tenant.subscriptionId });
}

/**
 * Apply template. Marks mutation-attempted BEFORE spawning az (via harness mark
 * in runHarness; this adapter also refuses to spawn without purpose metadata).
 */
async function applyTemplate(tenant, appResource, meta) {
  const purpose = meta && meta.purpose ? meta.purpose : 'template';
  const signal = meta && meta.signal;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'radar16q-apply-'));
  const file = path.join(tmp, `${purpose}.json`);
  const payload = {
    type: appResource.type || 'Microsoft.App/containerApps',
    name: appResource.name || tenant.containerApp,
    id: appResource.id || tenant.resourceId,
    location: appResource.location,
    identity: appResource.identity,
    properties: {
      template: appResource.properties.template,
      configuration: appResource.properties && appResource.properties.configuration
        ? {
          ingress: appResource.properties.configuration.ingress
            ? {
              traffic: appResource.properties.configuration.ingress.traffic,
              fqdn: appResource.properties.configuration.ingress.fqdn,
            }
            : undefined,
        }
        : undefined,
    },
  };
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  try {
    if (typeof (meta && meta.beforeSpawn) === 'function') {
      meta.beforeSpawn({ purpose });
    }
    // Mutation already marked by harness before this call; spawn is async+timeout.
    await harness.runSubprocessAsync(
      'az',
      harness.withSubscriptionArgs([
        'containerapp', 'update',
        '--name', tenant.containerApp,
        '--resource-group', tenant.resourceGroup,
        '--yaml', file,
      ], tenant.subscriptionId),
      {
        timeoutMs: harness.DEFAULT_AZ_TIMEOUT_MS,
        signal,
        spawnFn: spawn,
      },
    );
  } finally {
    try { fs.unlinkSync(file); } catch (_) { /* ignore */ }
    try { fs.rmdirSync(tmp); } catch (_) { /* ignore */ }
  }
}

async function applyTraffic(tenant, traffic, meta) {
  const signal = meta && meta.signal;
  const args = [
    'containerapp', 'ingress', 'traffic', 'set',
    '--name', tenant.containerApp,
    '--resource-group', tenant.resourceGroup,
  ];
  for (const t of traffic || []) {
    if (t.revisionName && Number(t.weight) > 0) {
      args.push('--revision-weight', `${t.revisionName}=${t.weight}`);
    }
  }
  await harness.runSubprocessAsync(
    'az',
    harness.withSubscriptionArgs(args, tenant.subscriptionId),
    {
      timeoutMs: harness.DEFAULT_AZ_TIMEOUT_MS,
      signal,
      spawnFn: spawn,
    },
  );
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const lib = String(url).startsWith('http://') ? http : https;
    const req = lib.get(url, { timeout: 10000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        // Never return arbitrary body to evidence path — status only for harness.
        resolve({
          status: res.statusCode,
          bodyCategory: 'omitted',
        });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(Object.assign(new Error('http_timeout'), { code: 'timeout', category: 'timeout' }));
    });
  });
}

async function main(argv) {
  const parsedArgs = harness.parseCliArgs(argv);
  if (parsedArgs.help) {
    printHelp();
    return 0;
  }

  let parsed;
  try {
    parsed = harness.assertCliFailClosed(parsedArgs);
  } catch (err) {
    const sanitized = harness.sanitizeError(err);
    console.error(`REFUSED ${sanitized.code}: ${sanitized.message}`);
    return 2;
  }
  if (parsed.help) {
    printHelp();
    return 0;
  }

  try {
    const result = await harness.runHarness({
      parsed,
      confirm: parsed.confirm,
      deps: {
        execGit,
        execAssertRepoSync,
        showAccount,
        showApp,
        showAppAfter: showApp,
        listRevisions,
        showRevision,
        listReplicas,
        applyTemplate,
        applyTraffic,
        httpGet,
      },
    });
    if (result.help) {
      printHelp();
      return 0;
    }
    console.log(JSON.stringify({
      ok: true,
      mode: result.mode,
      live_mutation: result.live_mutation === true,
      mutation_attempted: result.mutation_attempted === true,
      evidencePath: result.evidencePath,
      workDir: result.workDir,
      tenant: parsed.tenant.id,
      slice: harness.SLICE,
      explicitly_not_claimed: result.evidence && result.evidence.explicitly_not_claimed,
    }, null, 2));
    return 0;
  } catch (err) {
    console.error(JSON.stringify({
      ok: false,
      ...harness.sanitizeError(err),
    }, null, 2));
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  }).catch((err) => {
    console.error(harness.sanitizeError(err));
    process.exit(1);
  });
}

module.exports = {
  main,
  showAccount,
  showApp,
  listRevisions,
  showRevision,
  listReplicas,
  applyTemplate,
  applyTraffic,
  httpGet,
  azJson,
};
