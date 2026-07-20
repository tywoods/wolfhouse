'use strict';

/**
 * RADAR Slice 16Q — operator CLI for controlled ACA database-readiness failure drill.
 *
 * Default: dry-run (plan only; no Azure mutation).
 * Live apply: requires --tenant wolfhouse|sunset AND --apply AND --confirm RADAR-16Q-READINESS-FAILURE-DRILL.
 *
 * This slice ships source-only. Do not execute live apply from the 16Q commit.
 */

const { execFileSync, execSync } = require('child_process');
const https = require('https');
const http = require('http');
const path = require('path');

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
    `Pinned image SHA: ${harness.IMAGE_SHA_SHORT}`,
    `Pinned master: ${harness.MASTER_BASIS}`,
    `Database env: ${harness.DATABASE_ENV_NAME}`,
    '',
    'Refuse: production hosts/RGs, dirty/unsynced repo, wrong master/image,',
    'missing probes/secretRef, multi-revision traffic, ambiguous state.',
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

function azJson(args) {
  const out = execFileSync('az', args.concat(['-o', 'json']), {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(out || 'null');
}

function showApp(tenant) {
  return azJson([
    'containerapp', 'show',
    '--name', tenant.containerApp,
    '--resource-group', tenant.resourceGroup,
  ]);
}

function listRevisions(tenant) {
  return azJson([
    'containerapp', 'revision', 'list',
    '--name', tenant.containerApp,
    '--resource-group', tenant.resourceGroup,
  ]);
}

function applyTemplate(tenant, appResource, meta) {
  const fs = require('fs');
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'radar16q-apply-'));
  const file = path.join(tmp, `${meta && meta.purpose ? meta.purpose : 'template'}.json`);
  // Azure CLI --yaml accepts JSON. Never write secret values from Key Vault —
  // we only pass template/env shapes already present in the show payload
  // (secretRef names or the intentional unreachable non-secret DSN).
  const payload = {
    type: appResource.type || 'Microsoft.App/containerApps',
    name: appResource.name || tenant.containerApp,
    location: appResource.location,
    identity: appResource.identity,
    properties: {
      template: appResource.properties.template,
    },
  };
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  try {
    execFileSync(
      'az',
      [
        'containerapp', 'update',
        '--name', tenant.containerApp,
        '--resource-group', tenant.resourceGroup,
        '--yaml', file,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
    );
  } finally {
    try { fs.unlinkSync(file); } catch (_) { /* ignore */ }
    try { fs.rmdirSync(tmp); } catch (_) { /* ignore */ }
  }
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const lib = String(url).startsWith('http://') ? http : https;
    const req = lib.get(url, { timeout: 10000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks).toString('utf8').slice(0, 2000),
        });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('http_timeout'));
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
    console.error(`REFUSED ${err.code || 'cli'}: ${err.message}`);
    return 2;
  }
  if (parsed.help) {
    printHelp();
    return 0;
  }

  try {
    const result = await harness.runHarness({
      parsed,
      deps: {
        execGit,
        execAssertRepoSync,
        showApp,
        showAppAfter: showApp,
        listRevisions,
        applyTemplate,
        httpGet,
      },
    });
    if (result.help) {
      printHelp();
      return 0;
    }
    // Machine-readable redacted evidence path + summary (no secrets).
    console.log(JSON.stringify({
      ok: true,
      mode: result.mode,
      live_mutation: result.live_mutation === true,
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
      code: err && err.code,
      message: err && err.message,
      detail: err && err.detail ? harness.redactSecretsDeep(err.detail) : undefined,
    }, null, 2));
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { main, showApp, listRevisions, applyTemplate, httpGet };
