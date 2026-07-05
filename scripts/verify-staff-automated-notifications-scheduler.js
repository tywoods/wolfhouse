'use strict';

/**
 * Verifier for staging Azure Container Apps Job deploy plan (no Azure network).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const deployPath = path.join(ROOT, 'scripts', 'deploy-staff-automated-notifications-job.js');
const runnerPath = path.join(ROOT, 'scripts', 'run-staff-automated-notifications.js');
const libPath = path.join(ROOT, 'scripts', 'lib', 'staff-automated-notifications.js');
const pkgPath = path.join(ROOT, 'package.json');

const {
  STAGING_JOB_PROFILE,
  parseDeployArgs,
  refuseProd,
  validateJobDeployOptions,
  buildJobDeployPlan,
  buildRunnerArgs,
} = require('./deploy-staff-automated-notifications-job');

let pass = 0;
let fail = 0;

function ok(name, cond) {
  if (cond) {
    pass += 1;
    console.log('  PASS ', name);
  } else {
    fail += 1;
    console.log('  FAIL ', name);
  }
}

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

console.log('verify:staff-automated-notifications-scheduler\n');

const deploy = fs.existsSync(deployPath) ? read(deployPath) : '';
const runner = fs.existsSync(runnerPath) ? read(runnerPath) : '';
const lib = fs.existsSync(libPath) ? read(libPath) : '';
const pkg = fs.existsSync(pkgPath) ? read(pkgPath) : '';

console.log('── deploy script exists ──');
ok('deploy-staff-automated-notifications-job.js exists', !!deploy);
ok('exports buildJobDeployPlan', /buildJobDeployPlan/.test(deploy));
ok('exports validateJobDeployOptions', /validateJobDeployOptions/.test(deploy));
ok('exports refuseProd', /refuseProd/.test(deploy));

console.log('\n── staging target ──');
ok('resource group wh-staging-rg', STAGING_JOB_PROFILE.resourceGroup === 'wh-staging-rg');
ok('job name wh-staging-staff-automated-notifications', STAGING_JOB_PROFILE.jobName === 'wh-staging-staff-automated-notifications');
ok('uses wh-staging-env', STAGING_JOB_PROFILE.environment === 'wh-staging-env');
ok('references wh-staging-staff-api image source', STAGING_JOB_PROFILE.staffApiApp === 'wh-staging-staff-api');

console.log('\n── prod refusal ──');
ok('refuseProd blocks --prod', !!refuseProd({ prod: true }));
ok('validateJobDeployOptions rejects prod', !validateJobDeployOptions({ prod: true }).ok);

console.log('\n── default dry-run / no in-process scheduler ──');
const defaultOpts = parseDeployArgs([]);
ok('default is not live', defaultOpts.live === false);
ok('default is not apply', defaultOpts.apply === false);
ok('deploy requires apply env gate', /STAFF_AUTOMATED_NOTIFICATIONS_JOB_DEPLOY_APPLY/.test(deploy));
ok('no setInterval in deploy script', !/setInterval\s*\(/.test(deploy));
ok('no node-cron in deploy script', !/node-cron|scheduleJob\s*\(/.test(deploy));
ok('no setInterval added to runner', !/setInterval\s*\(/.test(runner));
ok('no node-cron added to lib', !/node-cron|scheduleJob\s*\(/.test(lib));

console.log('\n── job uses existing runner ──');
const dryPlan = buildJobDeployPlan(parseDeployArgs([]), { image: 'whstagingacr.azurecr.io/wh-staff-api:test' });
ok('runner args include run-staff-automated-notifications.js', dryPlan.runnerArgs[0].includes('run-staff-automated-notifications.js'));
ok('default client wolfhouse-somo', dryPlan.runnerArgs.some((a) => a === '--client=wolfhouse-somo'));
ok('default window-minutes 5', dryPlan.runnerArgs.some((a) => a === '--window-minutes=5'));
ok('dry plan mode dry_run', dryPlan.mode === 'dry_run');
ok('dry plan WHATSAPP_DRY_RUN true', dryPlan.envVars.WHATSAPP_DRY_RUN === 'true');
ok('dry plan LIVE_ENABLED false', dryPlan.envVars.STAFF_AUTOMATED_NOTIFICATIONS_LIVE_ENABLED === 'false');
ok('dry runner args omit --live', !dryPlan.runnerArgs.includes('--live'));

console.log('\n── schedule ──');
ok('cron every 5 minutes', dryPlan.cronExpression === '*/5 * * * *');
ok('plan includes Schedule trigger command', dryPlan.commands.some((c) => c.argv.includes('Schedule')));
ok('dedupe overlap comment in deploy script', /schedule interval.*overlap.*dedupe/i.test(deploy));

console.log('\n── apply command order ──');
const upsertLabels = dryPlan.commands.map((c) => c.label);
const createIdx = upsertLabels.findIndex((l) => /create scheduled job/i.test(l));
const identityIdx = upsertLabels.findIndex((l) => /assign managed identity/i.test(l));
const secretIdx = upsertLabels.findIndex((l) => /bind Key Vault secrets/i.test(l));
const updateIdx = upsertLabels.findIndex((l) => /update job image/i.test(l));
ok('create job before identity assign', createIdx >= 0 && identityIdx >= 0 && createIdx < identityIdx);
ok('create job before secret set', createIdx >= 0 && secretIdx >= 0 && createIdx < secretIdx);
ok('identity assign before secret set', identityIdx >= 0 && secretIdx >= 0 && identityIdx < secretIdx);
ok('secret set before final update', secretIdx >= 0 && updateIdx >= 0 && secretIdx < updateIdx);

console.log('\n── live gates ──');
const liveBlocked = validateJobDeployOptions({ live: true, allowedPhones: '' });
ok('live without allowlist blocked', !liveBlocked.ok);
const livePlan = buildJobDeployPlan(parseDeployArgs([
  '--live',
  '--allowed-phones=+34900000001',
]), { image: 'whstagingacr.azurecr.io/wh-staff-api:test' });
ok('live plan mode live', livePlan.mode === 'live');
ok('live runner includes --live flag', livePlan.runnerArgs.includes('--live'));
ok('live env WHATSAPP_DRY_RUN false', livePlan.envVars.WHATSAPP_DRY_RUN === 'false');
ok('live env LIVE_ENABLED true', livePlan.envVars.STAFF_AUTOMATED_NOTIFICATIONS_LIVE_ENABLED === 'true');
ok('live env allowlist set', livePlan.envVars.STAFF_AUTOMATED_NOTIFICATIONS_ALLOWED_PHONES === '+34900000001');
ok('live validate passes with allowlist', validateJobDeployOptions({
  live: true,
  allowedPhones: '+34900000001',
}).ok);

console.log('\n── secrets/env wiring ──');
ok('WOLFHOUSE_DATABASE_URL secretref', dryPlan.envVars.WOLFHOUSE_DATABASE_URL === 'secretref:wolfhouse-database-url');
ok('OPENAI_API_KEY secretref', dryPlan.envVars.OPENAI_API_KEY === 'secretref:openai-api-key');
ok('WHATSAPP_CLOUD_ACCESS_TOKEN secretref', dryPlan.envVars.WHATSAPP_CLOUD_ACCESS_TOKEN === 'secretref:meta-whatsapp-token');
ok('WHATSAPP_PHONE_NUMBER_ID secretref', dryPlan.envVars.WHATSAPP_PHONE_NUMBER_ID === 'secretref:meta-whatsapp-phone-id');
ok('LUNA_AI_PROVIDER set', dryPlan.envVars.LUNA_AI_PROVIDER === 'openai');

console.log('\n── disable/delete ──');
const disablePlan = buildJobDeployPlan(parseDeployArgs(['--disable']));
ok('disable switches Manual trigger', disablePlan.commands.some((c) => c.argv.includes('Manual')));
const deletePlan = buildJobDeployPlan(parseDeployArgs(['--delete']));
ok('delete command present', deletePlan.action === 'delete');

console.log('\n── package.json ──');
ok('verify:staff-automated-notifications-scheduler script', /verify:staff-automated-notifications-scheduler/.test(pkg));
ok('scheduler included in verify bundle', /verify-staff-automated-notifications-scheduler/.test(pkg));

console.log('\n── CLI dry-run smoke ──');
const cliDry = spawnSync(process.execPath, [deployPath], { cwd: ROOT, encoding: 'utf8' });
ok('deploy script exits 0 dry-run', cliDry.status === 0);
ok('dry-run prints az containerapp job', `${cliDry.stdout || ''}`.includes('az containerapp job'));
ok('dry-run mentions DRY-RUN', `${cliDry.stdout || ''}`.includes('DRY-RUN'));

const cliProd = spawnSync(process.execPath, [deployPath, '--prod'], { cwd: ROOT, encoding: 'utf8' });
ok('--prod exits non-zero', cliProd.status !== 0);

const cliLiveBlocked = spawnSync(process.execPath, [deployPath, '--live'], { cwd: ROOT, encoding: 'utf8' });
ok('--live without allowlist exits non-zero', cliLiveBlocked.status !== 0);

console.log('\n── regression verifiers ──');
for (const script of [
  'verify-staff-automated-notifications-live.js',
  'verify-staff-automated-notifications-runner.js',
]) {
  const out = spawnSync(process.execPath, [`scripts/${script}`], { cwd: ROOT, encoding: 'utf8' });
  ok(`${script} passes`, out.status === 0);
  if (out.status !== 0) console.log(`${out.stdout || ''}${out.stderr || ''}`.trim());
}

console.log(`\n── staff-automated-notifications-scheduler: ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
