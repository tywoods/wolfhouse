'use strict';

/**
 * Optional read-only collector for Sunset staging live inventory.
 * Requires Azure CLI login. Never mutates Azure.
 *
 * Usage:
 *   node scripts/inventory-sunset-staging-live.js --out tmp/sunset-live-raw
 *
 * This script only writes local files. Commit path is the sanitized fixture under
 * infra/azure/sunset-staging/inventory/ (hand-normalized / verifier-gated).
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RG = 'luna-sunset-staging-rg';
const APP = 'luna-sunset-staging-staff-api';
const FORBIDDEN_MUTATION = [
  'deployment group create',
  'group delete',
  'containerapp update',
  'containerapp revision restart',
  'keyvault secret set',
  'acr build',
];

function azPath() {
  if (process.platform === 'win32') {
    return '"C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd"';
  }
  return 'az';
}

function azJson(argStr) {
  const cmd = `${azPath()} ${argStr} -o json`;
  // Guard: refuse if caller somehow injected a mutation verb.
  const low = argStr.toLowerCase();
  for (const bad of FORBIDDEN_MUTATION) {
    if (low.includes(bad)) {
      throw new Error(`refusing mutating az invocation: ${bad}`);
    }
  }
  const out = execSync(cmd, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const s = String(out).replace(/^\uFEFF/, '').trim();
  const iObj = s.indexOf('{');
  const iArr = s.indexOf('[');
  let i = -1;
  if (iObj >= 0 && iArr >= 0) i = Math.min(iObj, iArr);
  else i = Math.max(iObj, iArr);
  if (i < 0) throw new Error(`no JSON from: ${argStr}`);
  return JSON.parse(s.slice(i));
}

function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outDir = path.resolve(
    outIdx >= 0 ? args[outIdx + 1] : path.join(ROOT, 'tmp/sunset-staging-live-raw'),
  );
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`[inventory] read-only export for ${RG} / ${APP}`);
  console.log(`[inventory] out=${outDir}`);

  const today = new Date();
  const from = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const to = today.toISOString().slice(0, 10);
  const costBody = {
    type: 'ActualCost',
    timeframe: 'Custom',
    timePeriod: { from, to },
    dataset: {
      granularity: 'None',
      aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
    },
  };
  fs.writeFileSync(path.join(outDir, 'cost-query-body.json'), `${JSON.stringify(costBody)}\n`);

  const writes = [
    ['resources-summary.json', `resource list -g ${RG} --query "[].{name:name,type:type,location:location,tags:tags}"`],
    ['identity.json', `identity show -g ${RG} -n luna-sunset-staging-identity`],
    ['keyvault.json', `keyvault show -g ${RG} -n luna-sunset-staging-kv`],
    ['keyvault-secret-names.json', `keyvault secret list --vault-name luna-sunset-staging-kv --query "[].{name:name,enabled:attributes.enabled}"`],
    ['postgres.json', `postgres flexible-server show -g ${RG} -n luna-sunset-staging-pg-app`],
    ['postgres-dbs.json', `postgres flexible-server db list -g ${RG} -s luna-sunset-staging-pg-app`],
    ['postgres-firewall.json', `postgres flexible-server firewall-rule list -g ${RG} -n luna-sunset-staging-pg-app`],
    ['log-analytics.json', `monitor log-analytics workspace show -g ${RG} -n luna-sunset-staging-logs`],
    ['appinsights.json', `monitor app-insights component show -g ${RG} -a luna-sunset-staging-appinsights`],
    ['cae.json', `containerapp env show -g ${RG} -n luna-sunset-staging-env`],
    ['containerapp.json', `containerapp show -g ${RG} -n ${APP}`],
    ['revisions.json', `containerapp revision list -g ${RG} -n ${APP}`],
    ['ingress.json', `containerapp ingress show -g ${RG} -n ${APP}`],
    ['hostnames.json', `containerapp hostname list -g ${RG} -n ${APP}`],
    ['job-hold-expiry.json', `containerapp job show -g ${RG} -n luna-sunset-staging-hold-expiry`],
    ['managed-certs.json', `containerapp env certificate list -g ${RG} -n luna-sunset-staging-env`],
    ['acr-shared.json', `acr show -g wh-staging-rg -n whstagingacr --query "{name:name,loginServer:loginServer,id:id,resourceGroup:resourceGroup,sku:sku.name,location:location}"`],
  ];

  for (const [name, argStr] of writes) {
    const json = azJson(argStr);
    fs.writeFileSync(path.join(outDir, name), `${JSON.stringify(json, null, 2)}\n`);
    console.log(`[inventory] wrote ${name}`);
  }

  const sub = azJson('account show --query "{id:id}"').id;
  const cost = azJson(
    `rest --method post --url "https://management.azure.com/subscriptions/${sub}/resourceGroups/${RG}/providers/Microsoft.CostManagement/query?api-version=2023-11-01" --body "@${path.join(outDir, 'cost-query-body.json')}"`,
  );
  fs.writeFileSync(path.join(outDir, 'cost.json'), `${JSON.stringify(cost, null, 2)}\n`);

  const principalId = azJson(`identity show -g ${RG} -n luna-sunset-staging-identity --query principalId`);
  const pid = typeof principalId === 'string' ? principalId : String(principalId);
  const rbac = azJson(`role assignment list --assignee ${pid} --all`);
  fs.writeFileSync(path.join(outDir, 'rbac-identity-all.json'), `${JSON.stringify(rbac, null, 2)}\n`);

  console.log('[inventory] done (raw only — sanitize before commit)');
}

main();
