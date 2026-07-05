'use strict';

/**
 * Staging Azure Container Apps Job for automated staff notifications runner.
 *
 * DEFAULT IS DRY-RUN: prints `az` commands only. Nothing is created/updated unless
 * `--apply` AND env STAFF_AUTOMATED_NOTIFICATIONS_JOB_DEPLOY_APPLY=1.
 *
 * The job runs `scripts/run-staff-automated-notifications.js` on a schedule (every 5
 * minutes UTC). Europe/Madrid due logic stays in the runner. No in-process timers.
 *
 * Usage:
 *   node scripts/deploy-staff-automated-notifications-job.js
 *   node scripts/deploy-staff-automated-notifications-job.js --apply   # requires env gate
 *   node scripts/deploy-staff-automated-notifications-job.js --live --allowed-phones=+34... --apply
 *   node scripts/deploy-staff-automated-notifications-job.js --disable --apply
 *   node scripts/deploy-staff-automated-notifications-job.js --delete --apply
 */

const { spawnSync } = require('child_process');
const { checkStaffAutomatedNotificationsLiveGates } = require('./lib/staff-automated-notifications');

const ENV_APPLY_FLAG = 'STAFF_AUTOMATED_NOTIFICATIONS_JOB_DEPLOY_APPLY';

const STAGING_JOB_PROFILE = Object.freeze({
  resourceGroup: 'wh-staging-rg',
  environment: 'wh-staging-env',
  jobName: 'wh-staging-staff-automated-notifications',
  staffApiApp: 'wh-staging-staff-api',
  acrLoginServer: 'whstagingacr.azurecr.io',
  imageRepo: 'wh-staff-api',
  kvUrl: 'https://wh-staging-kv.vault.azure.net',
  identityId:
    '/subscriptions/6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9/resourceGroups/wh-staging-rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/wh-staging-identity',
  cronExpression: '*/5 * * * *',
  defaultClient: 'wolfhouse-somo',
  defaultWindowMinutes: 5,
});

const KV_SECRET_BINDINGS = [
  { caSecret: 'wolfhouse-database-url', kvSecret: 'wolfhouse-database-url' },
  { caSecret: 'openai-api-key', kvSecret: 'openai-api-key' },
  { caSecret: 'meta-whatsapp-token', kvSecret: 'meta-whatsapp-token' },
  { caSecret: 'meta-whatsapp-phone-id', kvSecret: 'meta-whatsapp-phone-id' },
];

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function parseDeployArgs(argv) {
  const out = {
    apply: false,
    prod: false,
    live: false,
    disable: false,
    deleteJob: false,
    client: STAGING_JOB_PROFILE.defaultClient,
    location: null,
    windowMinutes: STAGING_JOB_PROFILE.defaultWindowMinutes,
    image: null,
    allowedPhones: trimStr(process.env.STAFF_AUTOMATED_NOTIFICATIONS_ALLOWED_PHONES),
  };
  for (const arg of argv) {
    if (arg === '--apply') out.apply = true;
    else if (arg === '--prod') out.prod = true;
    else if (arg === '--live') out.live = true;
    else if (arg === '--disable') out.disable = true;
    else if (arg === '--delete') out.deleteJob = true;
    else if (arg.startsWith('--client=')) out.client = trimStr(arg.slice(9));
    else if (arg.startsWith('--location=')) out.location = trimStr(arg.slice(11)) || null;
    else if (arg.startsWith('--window-minutes=')) {
      out.windowMinutes = parseInt(arg.slice(17), 10);
    } else if (arg.startsWith('--image=')) out.image = trimStr(arg.slice(8));
    else if (arg.startsWith('--allowed-phones=')) out.allowedPhones = trimStr(arg.slice(17));
  }
  if (!Number.isFinite(out.windowMinutes) || out.windowMinutes < 0) {
    out.windowMinutes = STAGING_JOB_PROFILE.defaultWindowMinutes;
  }
  return out;
}

function refuseProd(opts) {
  if (!opts || !opts.prod) return null;
  return 'Production automated notification jobs are not supported in this slice. Omit --prod (staging only).';
}

function validateJobDeployOptions(opts) {
  const errors = [];
  const prodError = refuseProd(opts);
  if (prodError) errors.push(prodError);
  if (opts.disable && opts.deleteJob) {
    errors.push('Use either --disable or --delete, not both.');
  }
  if (opts.live && (opts.disable || opts.deleteJob)) {
    errors.push('--live cannot be combined with --disable or --delete.');
  }
  if (opts.live) {
    const gate = checkStaffAutomatedNotificationsLiveGates({
      liveFlag: true,
      env: {
        STAFF_AUTOMATED_NOTIFICATIONS_LIVE_ENABLED: 'true',
        WHATSAPP_DRY_RUN: 'false',
        STAFF_AUTOMATED_NOTIFICATIONS_ALLOWED_PHONES: opts.allowedPhones,
      },
    });
    if (!gate.ok) {
      errors.push(`Live scheduled mode blocked: ${gate.reasons.join(', ')}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function buildRunnerArgs(opts) {
  const args = [
    'scripts/run-staff-automated-notifications.js',
    `--client=${opts.client}`,
    `--window-minutes=${opts.windowMinutes}`,
  ];
  if (opts.location) args.push(`--location=${opts.location}`);
  if (opts.live) args.push('--live');
  return args;
}

function buildJobEnvVars(opts) {
  const env = {
    NODE_ENV: 'staging',
    DEFAULT_CLIENT: opts.client,
    LUNA_AI_PROVIDER: 'openai',
    LUNA_AI_MODEL: 'gpt-4o-mini',
    WOLFHOUSE_DATABASE_URL: 'secretref:wolfhouse-database-url',
    OPENAI_API_KEY: 'secretref:openai-api-key',
    WHATSAPP_CLOUD_ACCESS_TOKEN: 'secretref:meta-whatsapp-token',
    WHATSAPP_PHONE_NUMBER_ID: 'secretref:meta-whatsapp-phone-id',
  };
  if (opts.live) {
    env.WHATSAPP_DRY_RUN = 'false';
    env.STAFF_AUTOMATED_NOTIFICATIONS_LIVE_ENABLED = 'true';
    env.STAFF_AUTOMATED_NOTIFICATIONS_ALLOWED_PHONES = opts.allowedPhones;
  } else {
    env.WHATSAPP_DRY_RUN = 'true';
    env.STAFF_AUTOMATED_NOTIFICATIONS_LIVE_ENABLED = 'false';
  }
  return env;
}

function kvSecretRef(kvSecret) {
  const { kvUrl, identityId } = STAGING_JOB_PROFILE;
  return `keyvaultref:${kvUrl}/secrets/${kvSecret},identityref:${identityId}`;
}

function buildSecretSetArgs() {
  return KV_SECRET_BINDINGS.map(
    ({ caSecret, kvSecret }) => `${caSecret}=${kvSecretRef(kvSecret)}`,
  );
}

function envVarsToAzArgs(envVars) {
  return Object.entries(envVars).map(([key, value]) => `${key}=${value}`);
}

function shellQuote(arg) {
  const s = String(arg);
  if (/^[A-Za-z0-9_./:=+-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function formatCommand(argv) {
  return argv.map(shellQuote).join(' ');
}

function buildJobDeployPlan(opts, { image = opts.image || '<staff-api-image>' } = {}) {
  const profile = STAGING_JOB_PROFILE;
  const runnerArgs = buildRunnerArgs(opts);
  const envVars = buildJobEnvVars(opts);
  const commands = [];

  if (opts.deleteJob) {
    commands.push({
      label: 'delete job',
      argv: [
        'az', 'containerapp', 'job', 'delete',
        '-g', profile.resourceGroup,
        '-n', profile.jobName,
        '--yes',
      ],
    });
    return {
      action: 'delete',
      mode: opts.live ? 'live' : 'dry_run',
      target: 'staging',
      jobName: profile.jobName,
      resourceGroup: profile.resourceGroup,
      image,
      cronExpression: profile.cronExpression,
      runnerCommand: 'node',
      runnerArgs,
      envVars,
      commands,
    };
  }

  if (opts.disable) {
    commands.push({
      label: 'disable schedule (Manual trigger)',
      argv: [
        'az', 'containerapp', 'job', 'update',
        '-g', profile.resourceGroup,
        '-n', profile.jobName,
        '--trigger-type', 'Manual',
      ],
    });
    return {
      action: 'disable',
      mode: opts.live ? 'live' : 'dry_run',
      target: 'staging',
      jobName: profile.jobName,
      resourceGroup: profile.resourceGroup,
      image,
      cronExpression: null,
      runnerCommand: 'node',
      runnerArgs,
      envVars,
      commands,
    };
  }

  commands.push({
    label: 'assign managed identity',
    argv: [
      'az', 'containerapp', 'job', 'identity', 'assign',
      '-g', profile.resourceGroup,
      '-n', profile.jobName,
      '--user-assigned', profile.identityId,
    ],
  });
  commands.push({
    label: 'bind Key Vault secrets',
    argv: [
      'az', 'containerapp', 'job', 'secret', 'set',
      '-g', profile.resourceGroup,
      '-n', profile.jobName,
      '--secrets', ...buildSecretSetArgs(),
    ],
  });

  const createOrUpdateBase = [
    'az', 'containerapp', 'job', 'create',
    '-g', profile.resourceGroup,
    '-n', profile.jobName,
    '--environment', profile.environment,
    '--trigger-type', 'Schedule',
    '--cron-expression', profile.cronExpression,
    '--replica-timeout', '900',
    '--replica-retry-limit', '0',
    '--replica-completion-count', '1',
    '--parallelism', '1',
    '--image', image,
    '--cpu', '0.25',
    '--memory', '0.5Gi',
    '--command', 'node',
    '--args', ...runnerArgs,
    '--registry-server', profile.acrLoginServer,
    '--registry-identity', profile.identityId,
    '--set-env-vars', ...envVarsToAzArgs(envVars),
  ];

  commands.push({
    label: 'create scheduled job (or update via az containerapp job update if exists)',
    argv: createOrUpdateBase,
  });
  commands.push({
    label: 'update job image/args/env if job already exists',
    argv: [
      'az', 'containerapp', 'job', 'update',
      '-g', profile.resourceGroup,
      '-n', profile.jobName,
      '--image', image,
      '--command', 'node',
      '--args', ...runnerArgs,
      '--cron-expression', profile.cronExpression,
      '--trigger-type', 'Schedule',
      '--set-env-vars', ...envVarsToAzArgs(envVars),
    ],
  });

  return {
    action: 'upsert',
    mode: opts.live ? 'live' : 'dry_run',
    target: 'staging',
    jobName: profile.jobName,
    resourceGroup: profile.resourceGroup,
    image,
    cronExpression: profile.cronExpression,
    runnerCommand: 'node',
    runnerArgs,
    envVars,
    commands,
  };
}

function resolveStaffApiImage() {
  const profile = STAGING_JOB_PROFILE;
  const show = spawnSync('az', [
    'containerapp', 'show',
    '-g', profile.resourceGroup,
    '-n', profile.staffApiApp,
    '--query', 'properties.template.containers[0].image',
    '-o', 'tsv',
  ], { encoding: 'utf8' });
  if (show.status === 0 && trimStr(show.stdout)) {
    return trimStr(show.stdout);
  }
  return `${profile.acrLoginServer}/${profile.imageRepo}:<staff-api-image>`;
}

function runAz(argv) {
  const res = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (res.status !== 0) {
    const err = new Error(`az command failed (${argv.slice(0, 4).join(' ')}...)`);
    err.stdout = res.stdout;
    err.stderr = res.stderr;
    err.status = res.status;
    throw err;
  }
  return res.stdout;
}

function printPlan(plan, { apply }) {
  console.log('Automated staff notifications — Azure Container Apps Job deploy plan');
  console.log(`  target:          ${plan.target}`);
  console.log(`  action:          ${plan.action}`);
  console.log(`  mode:            ${plan.mode}`);
  console.log(`  resource group:  ${plan.resourceGroup}`);
  console.log(`  job name:        ${plan.jobName}`);
  if (plan.cronExpression) console.log(`  schedule (UTC):  ${plan.cronExpression} (every 5 minutes)`);
  console.log(`  image:           ${plan.image}`);
  console.log(`  runner:          node ${plan.runnerArgs.join(' ')}`);
  console.log('');
  console.log('Environment (non-secret):');
  for (const [key, value] of Object.entries(plan.envVars)) {
    if (String(value).startsWith('secretref:')) continue;
    console.log(`  ${key}=${value}`);
  }
  console.log('');
  if (!apply) {
    console.log('DRY-RUN — no Azure changes. Commands that would run:\n');
  } else {
    console.log('APPLY — executing Azure commands:\n');
  }
  for (const step of plan.commands) {
    console.log(`# ${step.label}`);
    console.log(formatCommand(step.argv));
    console.log('');
  }
}

function main() {
  const opts = parseDeployArgs(process.argv.slice(2));
  const validation = validateJobDeployOptions(opts);
  if (!validation.ok) {
    console.error('Deploy blocked:');
    for (const err of validation.errors) console.error(`  • ${err}`);
    process.exit(1);
  }

  if (opts.apply && process.env[ENV_APPLY_FLAG] !== '1') {
    console.error(`Apply blocked — set ${ENV_APPLY_FLAG}=1 to create/update/delete the staging job.`);
    process.exit(1);
  }

  const image = opts.image || resolveStaffApiImage();
  const plan = buildJobDeployPlan(opts, { image });
  printPlan(plan, { apply: opts.apply });

  if (!opts.apply) {
    console.log(`To apply: ${ENV_APPLY_FLAG}=1 node scripts/deploy-staff-automated-notifications-job.js ${opts.live ? '--live ' : ''}${opts.disable ? '--disable ' : ''}${opts.deleteJob ? '--delete ' : ''}--apply`);
    return;
  }

  for (const step of plan.commands) {
    console.error(`[apply] ${step.label}`);
    try {
      runAz(step.argv);
    } catch (err) {
      if (plan.action === 'upsert' && /create scheduled job/.test(step.label)) {
        console.error('[apply] create failed (job may already exist) — continuing to update step');
        continue;
      }
      console.error(String(err.message || err));
      if (err.stderr) console.error(err.stderr.trim());
      process.exit(err.status || 1);
    }
  }
  console.log('Done.');
}

if (require.main === module) {
  main();
}

module.exports = {
  ENV_APPLY_FLAG,
  STAGING_JOB_PROFILE,
  parseDeployArgs,
  refuseProd,
  validateJobDeployOptions,
  buildRunnerArgs,
  buildJobEnvVars,
  buildJobDeployPlan,
};
