'use strict';

/**
 * preflight-sunset-staging-bicep
 *
 * Fail-closed, read-only Sunset Bicep deployment preflight (FOUNDATION Slice 3).
 * NEVER runs deployment create/update. Incremental what-if only.
 *
 * Usage:
 *   node scripts/preflight-sunset-staging-bicep.js \
 *     --base-params infra/azure/sunset-staging/parameters.example.json \
 *     --secure-params path/to/gitignored-secure.json \
 *     --report tmp/sunset-bicep-preflight-report.json
 *
 * Secure values: gitignored --secure-params file and/or WH_SUNSET_PF_<paramName> env vars.
 * Reports never include secure values.
 */

const { execFileSync, execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  sha256File,
  loadParametersFile,
  mergeParameters,
  redactParams,
  checkGitState,
  checkAzureTarget,
  checkForbiddenReferences,
  checkParameters,
  checkAcrImage,
  evaluateWhatIfChanges,
  parseWhatIfJson,
  assertCommandSurfaceIsReadOnly,
  buildReport,
  skippedCheck,
  validateSecureParamsProvenance,
} = require('./lib/sunset-staging-bicep-preflight');

const ROOT = path.join(__dirname, '..');
const INVENTORY = path.join(
  ROOT,
  'infra/azure/sunset-staging/inventory/live-inventory.normalized.json',
);
const MAIN_BICEP = path.join(ROOT, 'infra/azure/sunset-staging/main.bicep');
const DEFAULT_BASE_PARAMS = path.join(
  ROOT,
  'infra/azure/sunset-staging/parameters.example.json',
);

const FORBIDDEN_AZ = [
  'deployment group create',
  'deployment group validate',
  'group delete',
  'containerapp update',
  'containerapp create',
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

function parseAzJson(raw) {
  const s = String(raw || '').replace(/^\uFEFF/, '').trim();
  const iObj = s.indexOf('{');
  const iArr = s.indexOf('[');
  let i = -1;
  if (iObj >= 0 && iArr >= 0) i = Math.min(iObj, iArr);
  else i = Math.max(iObj, iArr);
  if (i < 0) throw new Error('no JSON from az');
  return JSON.parse(s.slice(i));
}

function azExec(argStr, opts) {
  const low = String(argStr).toLowerCase();
  for (const bad of FORBIDDEN_AZ) {
    if (low.includes(bad)) {
      throw new Error(`refusing mutating az invocation: ${bad}`);
    }
  }
  return execSync(`${azPath()} ${argStr}`, {
    encoding: 'utf8',
    maxBuffer: (opts && opts.maxBuffer) || 20 * 1024 * 1024,
    stdio: (opts && opts.stdio) || ['ignore', 'pipe', 'pipe'],
    cwd: (opts && opts.cwd) || ROOT,
    windowsHide: true,
  });
}

function createLiveGit() {
  return {
    statusPorcelain() {
      return execFileSync('git', ['status', '--porcelain'], {
        cwd: ROOT,
        encoding: 'utf8',
      }).trim();
    },
    revParse(ref) {
      return execFileSync('git', ['rev-parse', ref], {
        cwd: ROOT,
        encoding: 'utf8',
      }).trim();
    },
  };
}

function createLiveAzure() {
  return {
    accountSubscriptionId() {
      return azExec('account show --query id -o tsv').trim();
    },
    resourceGroupExists(name) {
      try {
        azExec(`group show -n ${JSON.stringify(name)} -o tsv`);
        return true;
      } catch (_) {
        return false;
      }
    },
    acrImageExists(registry, repository, tag) {
      try {
        const out = azExec(
          `acr repository show-tags -n ${JSON.stringify(registry)} --repository ${JSON.stringify(repository)} -o tsv`,
          { maxBuffer: 10 * 1024 * 1024 },
        );
        return out.split(/\r?\n/).map((l) => l.trim()).includes(tag);
      } catch (_) {
        return false;
      }
    },
    queryCost(scopeRg) {
      const sub = this.accountSubscriptionId();
      const today = new Date();
      const from = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-01`;
      const to = today.toISOString().slice(0, 10);
      const bodyPath = path.join(ROOT, 'tmp', 'sunset-preflight-cost-body.json');
      fs.mkdirSync(path.dirname(bodyPath), { recursive: true });
      fs.writeFileSync(
        bodyPath,
        `${JSON.stringify({
          type: 'ActualCost',
          timeframe: 'Custom',
          timePeriod: { from, to },
          dataset: {
            granularity: 'None',
            aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
          },
        })}\n`,
      );
      const url = `https://management.azure.com/subscriptions/${sub}/resourceGroups/${scopeRg}/providers/Microsoft.CostManagement/query?api-version=2023-11-01`;
      const raw = azExec(
        `rest --method post --url ${JSON.stringify(url)} --body @${bodyPath} -o json`,
        { maxBuffer: 5 * 1024 * 1024 },
      );
      const j = parseAzJson(raw);
      const row = (j.properties && j.properties.rows && j.properties.rows[0]) || [null, null];
      return {
        type: 'ActualCost',
        scope: `/subscriptions/${sub}/resourceGroups/${scopeRg}`,
        period: { from, to, label: 'month-to-date' },
        amount: row[0],
        currency: row[1],
      };
    },
    whatIfIncremental(rg, templateFile, paramFiles) {
      // NEVER: deployment group create — what-if only
      let cmd =
        `deployment group what-if --resource-group ${JSON.stringify(rg)} ` +
        `--mode Incremental --template-file ${JSON.stringify(templateFile)} ` +
        `--result-format FullResourcePayloads --no-pretty-print -o json`;
      for (const pf of paramFiles) {
        cmd += ` --parameters @${pf}`;
      }
      const raw = azExec(cmd, { maxBuffer: 30 * 1024 * 1024 });
      return parseAzJson(raw);
    },
  };
}

function runTemplateGates() {
  const errors = [];
  try {
    azExec(`bicep build --file ${JSON.stringify(MAIN_BICEP)}`);
  } catch (e) {
    errors.push({ code: 'bicep_build', message: String(e.message || e).slice(0, 500) });
  }
  try {
    azExec(`bicep lint --file ${JSON.stringify(MAIN_BICEP)}`);
  } catch (e) {
    errors.push({ code: 'bicep_lint', message: String(e.message || e).slice(0, 500) });
  }
  // Clean build artifact if created
  const built = path.join(ROOT, 'infra/azure/sunset-staging/main.json');
  if (fs.existsSync(built)) fs.unlinkSync(built);

  const reconcile = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/verify-sunset-staging-bicep-reconcile.js'),
  ], { cwd: ROOT, encoding: 'utf8' });
  if (reconcile.status !== 0) {
    errors.push({ code: 'reconcile_gate', message: 'verify-sunset-staging-bicep-reconcile failed' });
  }
  const secret = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/verify-sunset-staging-iac-secret-scan.js'),
  ], { cwd: ROOT, encoding: 'utf8' });
  if (secret.status !== 0) {
    errors.push({ code: 'secret_gate', message: 'verify-sunset-staging-iac-secret-scan failed' });
  }

  const surface = assertCommandSurfaceIsReadOnly([
    fs.readFileSync(__filename, 'utf8'),
    fs.readFileSync(path.join(__dirname, 'lib/sunset-staging-bicep-preflight.js'), 'utf8'),
  ]);
  if (!surface.ok) errors.push(...surface.errors);

  return { ok: errors.length === 0, errors };
}

function parseArgs(argv) {
  const out = {
    baseParams: DEFAULT_BASE_PARAMS,
    secureParams: null,
    report: null,
    skipWhatIf: false,
    skipAcr: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--base-params') out.baseParams = path.resolve(argv[++i]);
    else if (a === '--secure-params') out.secureParams = path.resolve(argv[++i]);
    else if (a === '--report') out.report = path.resolve(argv[++i]);
    else if (a === '--skip-what-if') out.skipWhatIf = true;
    else if (a === '--skip-acr') out.skipAcr = true;
  }
  return out;
}

function runPreflight(options) {
  const opts = options || {};
  const git = opts.git || createLiveGit();
  const azure = opts.azure || createLiveAzure();
  const inventory = JSON.parse(fs.readFileSync(opts.inventoryPath || INVENTORY, 'utf8'));
  const checks = [];
  const repoRoot = opts.repoRoot || ROOT;

  // ── Local gates (no Azure cloud calls) ──────────────────────────────────
  const gitResult = checkGitState(git);
  checks.push({ name: 'git', ok: gitResult.ok, errors: gitResult.errors });
  const candidateSha = gitResult.originMaster || gitResult.head;

  const provenance = validateSecureParamsProvenance(opts.secureParams || null, {
    repoRoot,
    isTracked: opts.isTracked,
    isIgnored: opts.isIgnored,
    lstatSync: opts.lstatSync,
  });
  checks.push({
    name: 'secure_params_provenance',
    ok: provenance.ok,
    errors: provenance.errors,
  });

  const base = loadParametersFile(opts.baseParams || DEFAULT_BASE_PARAMS);
  let overlay = {};
  // Only read secure file contents after provenance passes — never print contents.
  if (opts.secureParams && provenance.ok) {
    overlay = loadParametersFile(opts.secureParams);
  }
  const params = mergeParameters(base, overlay, opts.env || process.env);

  const paramResult = checkParameters(params, candidateSha);
  // If provenance failed, keep parameters fail-closed even if env overlays look fine.
  if (!provenance.ok) {
    paramResult.ok = false;
    paramResult.errors = paramResult.errors.concat(
      provenance.errors.map((e) => ({
        code: e.code,
        message: 'secure params provenance blocked parameter acceptance',
      })),
    );
  }
  checks.push({ name: 'parameters', ok: paramResult.ok, errors: paramResult.errors });

  const forbid = checkForbiddenReferences([
    JSON.stringify(redactParams(params)),
    String(params.appNamePrefix || ''),
    String(params.appDbName || ''),
    String(params.acrResourceGroupName || ''),
  ]);
  if (String(params.resourceGroupName || '') === 'wh-staging-rg') {
    forbid.errors.push({ code: 'forbidden_rg', message: 'cannot target wh-staging-rg' });
    forbid.ok = false;
  }
  checks.push({ name: 'forbidden_refs', ok: forbid.ok, errors: forbid.errors });

  const template =
    typeof opts.templateGates === 'function'
      ? opts.templateGates()
      : runTemplateGates();
  checks.push({ name: 'template_gates', ok: template.ok, errors: template.errors });

  const localPrereqsOk = gitResult.ok && provenance.ok && paramResult.ok && forbid.ok;
  // Template is local but ACR/cost/what-if require all prerequisites including template + azure.
  let azureResult = {
    ok: false,
    errors: [],
    subscriptionId: inventory.scope.subscriptionId,
    resourceGroup: inventory.scope.resourceGroup,
  };

  if (!localPrereqsOk) {
    const reason = !gitResult.ok
      ? 'skipped_prerequisite_git'
      : !provenance.ok
        ? 'skipped_prerequisite_secure_params'
        : !paramResult.ok
          ? 'skipped_prerequisite_parameters'
          : 'skipped_prerequisite_forbidden_refs';
    checks.push(
      skippedCheck('azure_target', reason, 'Azure target not queried — local prerequisite failed'),
    );
    checks.push(skippedCheck('acr_image', reason, 'ACR not queried — local prerequisite failed'));
    checks.push(skippedCheck('what_if', reason, 'what-if not run — local prerequisite failed'));
    checks.push(skippedCheck('cost_baseline', reason, 'cost not queried — local prerequisite failed'));

    const ok = false;
    return buildReport({
      ok,
      candidateSha,
      subscriptionId: inventory.scope.subscriptionId,
      resourceGroup: inventory.scope.resourceGroup,
      costBaseline: null,
      templateHash: sha256File(MAIN_BICEP),
      checks,
      whatIf: { mode: 'Incremental', summary: null, normalized: [], skipped: true },
      parametersRedacted: redactParams(params),
    });
  }

  // ── Azure target (account + RG only) ────────────────────────────────────
  azureResult = checkAzureTarget(azure, inventory.scope);
  checks.push({ name: 'azure_target', ok: azureResult.ok, errors: azureResult.errors });

  if (!azureResult.ok) {
    const reason = 'skipped_prerequisite_azure_target';
    checks.push(skippedCheck('acr_image', reason, 'ACR not queried — Azure target failed'));
    checks.push(skippedCheck('what_if', reason, 'what-if not run — Azure target failed'));
    checks.push(skippedCheck('cost_baseline', reason, 'cost not queried — Azure target failed'));

    return buildReport({
      ok: false,
      candidateSha,
      subscriptionId: azureResult.subscriptionId || inventory.scope.subscriptionId,
      resourceGroup: inventory.scope.resourceGroup,
      costBaseline: null,
      templateHash: sha256File(MAIN_BICEP),
      checks,
      whatIf: { mode: 'Incremental', summary: null, normalized: [], skipped: true },
      parametersRedacted: redactParams(params),
    });
  }

  if (!template.ok) {
    const reason = 'skipped_prerequisite_template';
    checks.push(skippedCheck('acr_image', reason, 'ACR not queried — template gates failed'));
    checks.push(skippedCheck('what_if', reason, 'what-if not run — template gates failed'));
    checks.push(skippedCheck('cost_baseline', reason, 'cost not queried — template gates failed'));

    return buildReport({
      ok: false,
      candidateSha,
      subscriptionId: azureResult.subscriptionId,
      resourceGroup: inventory.scope.resourceGroup,
      costBaseline: null,
      templateHash: sha256File(MAIN_BICEP),
      checks,
      whatIf: { mode: 'Incremental', summary: null, normalized: [], skipped: true },
      parametersRedacted: redactParams(params),
    });
  }

  // ── Post-prerequisite Azure reads: ACR, cost, what-if ───────────────────
  if (!opts.skipAcr) {
    const acr = checkAcrImage(azure, params.staffApiImageTag || candidateSha);
    checks.push({ name: 'acr_image', ok: acr.ok, errors: acr.errors });
  } else {
    checks.push(
      skippedCheck('acr_image', 'acr_skipped', 'ACR check skipped (not allowed for live pass)'),
    );
  }

  let whatIfEval = {
    ok: false,
    errors: [{ code: 'whatif_not_run', message: 'what-if not run' }],
    summary: null,
    normalized: [],
  };
  if (!opts.skipWhatIf) {
    try {
      const paramFiles = [opts.baseParams || DEFAULT_BASE_PARAMS];
      if (opts.secureParams && provenance.ok) paramFiles.push(opts.secureParams);
      const raw = azure.whatIfIncremental(
        inventory.scope.resourceGroup,
        MAIN_BICEP,
        paramFiles,
      );
      const changes = parseWhatIfJson(raw);
      whatIfEval = evaluateWhatIfChanges(changes);
    } catch (e) {
      whatIfEval = {
        ok: false,
        errors: [{ code: 'whatif_error', message: String(e.message || e).slice(0, 500) }],
        summary: null,
        normalized: [],
      };
    }
  } else {
    whatIfEval = {
      ok: false,
      errors: [{ code: 'whatif_skipped', message: 'what-if skipped' }],
      summary: null,
      normalized: [],
    };
  }
  checks.push({
    name: 'what_if',
    ok: whatIfEval.ok,
    errors: whatIfEval.errors,
    summary: whatIfEval.summary,
  });

  let costBaseline = null;
  try {
    costBaseline = azure.queryCost(inventory.scope.resourceGroup);
    checks.push({ name: 'cost_baseline', ok: true, errors: [] });
  } catch (e) {
    checks.push({
      name: 'cost_baseline',
      ok: false,
      errors: [{ code: 'cost_query_failed', message: String(e.message || e).slice(0, 300) }],
    });
  }

  const ok = checks.every((c) => c.ok);
  return buildReport({
    ok,
    candidateSha,
    subscriptionId: azureResult.subscriptionId || inventory.scope.subscriptionId,
    resourceGroup: inventory.scope.resourceGroup,
    costBaseline,
    templateHash: sha256File(MAIN_BICEP),
    checks,
    whatIf: {
      mode: 'Incremental',
      summary: whatIfEval.summary,
      normalized: whatIfEval.normalized,
    },
    parametersRedacted: redactParams(params),
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.secureParams && !process.env.WH_SUNSET_PF_postgresAdminPassword) {
    console.error('preflight requires --secure-params <gitignored.json> or WH_SUNSET_PF_* env values');
    process.exit(2);
  }

  // Hard lock: this CLI must never offer create
  if (process.argv.join(' ').includes('create')) {
    console.error('refusing arguments that look like deployment create');
    process.exit(2);
  }

  const report = runPreflight({
    baseParams: args.baseParams,
    secureParams: args.secureParams,
    skipWhatIf: args.skipWhatIf,
    skipAcr: false,
  });

  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (args.report) {
    fs.mkdirSync(path.dirname(args.report), { recursive: true });
    fs.writeFileSync(args.report, text);
    console.log(`wrote secret-free report: ${args.report}`);
  } else {
    process.stdout.write(text);
  }
  process.exit(report.ok ? 0 : 1);
}

if (require.main === module) main();

module.exports = {
  runPreflight,
  parseArgs,
  createLiveGit,
  createLiveAzure,
  runTemplateGates,
};
