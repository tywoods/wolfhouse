'use strict';
/**
 * Hermes staging on Azure Linux VM (orchestrator + Luna containers).
 *
 * Usage:
 *   node scripts/deploy-staging-hermes-vm.js status
 *   node scripts/deploy-staging-hermes-vm.js build-image
 *   node scripts/deploy-staging-hermes-vm.js create-vm
 *   node scripts/deploy-staging-hermes-vm.js write-env-files   # local: hermes-vm-env/*.env for scp
 *   node scripts/deploy-staging-hermes-vm.js bootstrap-remote  # ssh: provision + env + compose up
 *   node scripts/deploy-staging-hermes-vm.js prune-images     # ssh: docker image prune -af on Lunabox
 *   node scripts/deploy-staging-hermes-vm.js verify
 *   node scripts/deploy-staging-hermes-vm.js check-repo-sync [--strict]
 *   node scripts/deploy-staging-hermes-vm.js sync-repo   # legacy: laptop → VM bundle
 *
 * See docs/HERMES-AZURE-VM.md
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { HERMES_VM } = require('./lib/hermes-vm-profile');

const ROOT = path.resolve(__dirname, '..');
const ENV_OUT = path.join(ROOT, 'hermes-vm-env');

function az(args, opts = {}) {
  const silent = opts.silent;
  try {
    const out = execSync(`az ${args}`, {
      encoding: 'utf8',
      stdio: silent ? ['ignore', 'pipe', 'pipe'] : ['inherit', 'pipe', 'pipe'],
      maxBuffer: 20 * 1024 * 1024,
    });
    return (out || '').trim();
  } catch (e) {
    const msg = String(e.stderr || e.message || e);
    if (!opts.allowFail) {
      e.stderr = msg;
      throw e;
    }
    return null;
  }
}

function kvSecret(name) {
  return az(`keyvault secret show --vault-name ${HERMES_VM.KV} --name ${name} --query value -o tsv`, {
    silent: true,
    allowFail: true,
  });
}

function vmExists() {
  const out = az(`vm show -g ${HERMES_VM.RG} -n ${HERMES_VM.VM_NAME} --query name -o tsv`, { silent: true, allowFail: true });
  return Boolean(out);
}

function vmPublicIp() {
  return az(
    `vm show -g ${HERMES_VM.RG} -n ${HERMES_VM.VM_NAME} -d --query publicIps -o tsv`,
    { silent: true, allowFail: true },
  );
}

function curlCode(url) {
  try {
    return execSync(`curl.exe -s -m 15 -o NUL -w "%{http_code}" ${url}`, { encoding: 'utf8' }).trim();
  } catch {
    return '000';
  }
}

function status() {
  const out = {
    rg: HERMES_VM.RG,
    vm: HERMES_VM.VM_NAME,
    hostname: HERMES_VM.HOSTNAME,
    vm_exists: vmExists(),
    public_ip: vmExists() ? vmPublicIp() : null,
    image: HERMES_VM.IMAGE,
    ports: { orchestrator: HERMES_VM.PORT_ORCHESTRATOR, luna_webhook: HERMES_VM.PORT_LUNA_WEBHOOK },
    compose: HERMES_VM.COMPOSE_FILE,
    aca_app: HERMES_VM.ACA_APP_NAME,
    meta_webhook_url: `https://${HERMES_VM.HOSTNAME}/whatsapp/webhook`,
  };
  console.log(JSON.stringify(out, null, 2));
}

function assertSoulClean() {
  console.error('[vm] check-soul-clean (prebuild)...');
  execSync('node scripts/check-soul-clean.js', { cwd: ROOT, stdio: 'inherit' });
}

function assertRepoSync() {
  console.error('[vm] assert-repo-sync (prebuild)...');
  execSync('node scripts/assert-repo-sync.js', { cwd: ROOT, stdio: 'inherit' });
}

function assertI18nGuestCopy() {
  // Ratcheted i18n gate: fails only on NEW untranslated guest-copy keys (a regression),
  // never on the pre-existing translation debt captured in the baseline. Fast + static.
  console.error('[vm] i18n guest-copy lint (prebuild)...');
  execSync('node scripts/check-i18n-guest-copy.js', { cwd: ROOT, stdio: 'inherit' });
}

function assertGoldenSuite() {
  // Pre-deploy regression gate: replay the golden guest conversations against the
  // locally-running hermes-luna container before we build/ship. --gate runs the
  // read-only fixtures only (never the --allow-writes ones, so a deploy can't
  // create real Stripe-TEST bookings). Skips (does not block) when no local
  // hermes-luna is running, or when SKIP_GOLDEN_GATE=1 for an emergency deploy.
  if (process.env.SKIP_GOLDEN_GATE === '1') {
    console.error('[vm] WARN: golden gate SKIPPED via SKIP_GOLDEN_GATE=1.');
    return;
  }
  const docker = process.env.SIM_DOCKER || 'sudo docker';
  let running = '';
  try { running = execSync(`${docker} ps --format '{{.Names}}'`, { cwd: ROOT, encoding: 'utf8' }); } catch (_) { /* docker absent */ }
  if (!/(^|\n)hermes-luna(\n|$)/.test(running)) {
    console.error('[vm] WARN: golden gate SKIPPED — no local hermes-luna container running. Run the suite manually before shipping.');
    return;
  }
  console.error('[vm] golden-conversation gate (prebuild)...');
  execSync('node scripts/luna-golden-conversations.js --gate', {
    cwd: ROOT, stdio: 'inherit', env: { ...process.env, SIM_DOCKER: docker },
  });
}

function buildImage() {
  assertRepoSync();
  assertSoulClean();
  assertI18nGuestCopy();
  assertGoldenSuite();
  const sha = execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
  console.error(`[vm] building staging image on ACR (git ${sha})...`);
  az(
    `acr build --registry ${HERMES_VM.ACR} `
    + `--image wh-hermes-staging:latest `
    + `--image wh-hermes-staging:${sha} `
    + `--file docker/hermes-staging/Dockerfile docker/hermes-staging`,
  );
  console.log(JSON.stringify({ ok: true, image: HERMES_VM.IMAGE, git_sha: sha, tagged: `wh-hermes-staging:${sha}` }, null, 2));
}

function ensureNsgRules() {
  const nsgName = az(
    `vm show -g ${HERMES_VM.RG} -n ${HERMES_VM.VM_NAME} --query "networkProfile.networkInterfaces[0].id" -o tsv`,
    { silent: true },
  );
  if (!nsgName) return;
  const nicId = nsgName;
  const nicNsg = az(`network nic show --ids ${nicId} --query "networkSecurityGroup.id" -o tsv`, { silent: true, allowFail: true });
  let nsg = 'lunaboxNSG';
  if (nicNsg) {
    const m = nicNsg.match(/networkSecurityGroups\/([^/]+)$/);
    if (m) nsg = m[1];
  }
  const rules = [
    { name: 'allow-https', port: '443', priority: 1001 },
    { name: 'allow-hermes-orchestrator', port: String(HERMES_VM.PORT_ORCHESTRATOR), priority: 1002 },
    { name: 'allow-hermes-luna-webhook', port: String(HERMES_VM.PORT_LUNA_WEBHOOK), priority: 1003 },
  ];
  for (const r of rules) {
    console.error(`[vm] NSG rule ${r.name} (${r.port})...`);
    try {
      az([
        'network nsg rule create',
        `-g ${HERMES_VM.RG}`,
        `--nsg-name ${nsg}`,
        `-n ${r.name}`,
        `--priority ${r.priority}`,
        '--access Allow',
        '--protocol Tcp',
        '--destination-port-ranges',
        r.port,
        '--source-address-prefixes',
        '*',
        '-o none',
      ].join(' '));
    } catch (e) {
      if (!/already exists|Conflict/i.test(String(e.stderr || e.message))) throw e;
    }
  }
}

function ensureVmAcrPull() {
  console.error('[vm] assigning staging identity for ACR pull...');
  try {
    az(`vm identity assign -g ${HERMES_VM.RG} -n ${HERMES_VM.VM_NAME} --identities ${HERMES_VM.IDENTITY_ID} -o none`);
  } catch (e) {
    if (!/already assigned|Conflict/i.test(String(e.stderr || e.message))) throw e;
  }
}

function createVm() {
  if (vmExists()) {
    console.error(`[vm] ${HERMES_VM.VM_NAME} already exists`);
    status();
    return;
  }
  console.error('[vm] creating Ubuntu VM (SSH NSG rule; HTTPS + Hermes ports added after)...');
  az([
    'vm create',
    `-g ${HERMES_VM.RG}`,
    `-n ${HERMES_VM.VM_NAME}`,
    `-l ${HERMES_VM.LOCATION}`,
    '--image Ubuntu2204',
    `--size ${HERMES_VM.VM_SIZE}`,
    '--admin-username azureuser',
    '--generate-ssh-keys',
    '--public-ip-sku Standard',
    '--nsg-rule SSH',
    '-o json',
  ].join(' '));
  ensureNsgRules();
  ensureVmAcrPull();
  status();
}

function writeEnvFiles() {
  let apiServerKey = kvSecret('hermes-api-server-key');
  if (!apiServerKey) {
    try {
      apiServerKey = az(
        'containerapp secret show -g wh-staging-rg -n wh-staging-hermes --secret-name hermes-api-server-key --query value -o tsv',
        { silent: true, allowFail: true },
      );
    } catch { /* ignore */ }
  }
  if (!apiServerKey) {
    apiServerKey = crypto.randomBytes(32).toString('hex');
    console.error('[vm] WARN: no hermes-api-server-key in KV — generated a new key for this deploy');
  }
  const anthropicToken = process.env.ANTHROPIC_TOKEN || kvSecret('anthropic-setup-token') || '';
  const orch = {
    DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN || kvSecret('discord-bot-token') || '',
    DISCORD_ALLOWED_USERS: process.env.DISCORD_ALLOWED_USERS || '',
    API_SERVER_KEY: apiServerKey,
    ANTHROPIC_TOKEN: anthropicToken,
    WOLFHOUSE_STAFF_API_BASE_URL: HERMES_VM.WOLFHOUSE_STAFF_API_BASE_URL,
  };
  const luna = {
    API_SERVER_KEY: apiServerKey,
    ANTHROPIC_TOKEN: anthropicToken,
    WHATSAPP_CLOUD_ACCESS_TOKEN: kvSecret('meta-whatsapp-token') || '',
    WHATSAPP_CLOUD_PHONE_NUMBER_ID: kvSecret('meta-whatsapp-phone-id') || HERMES_VM.WHATSAPP_PHONE_ID,
    WHATSAPP_CLOUD_APP_SECRET: kvSecret('whatsapp-app-secret') || '',
    WHATSAPP_CLOUD_VERIFY_TOKEN: HERMES_VM.WHATSAPP_VERIFY_TOKEN,
    WOLFHOUSE_STAFF_API_BASE_URL: HERMES_VM.WOLFHOUSE_STAFF_API_BASE_URL,
    LUNA_BOT_INTERNAL_TOKEN: kvSecret('luna-bot-internal-token') || '',
  };
  fs.mkdirSync(ENV_OUT, { recursive: true });
  const orchBody = Object.entries(orch)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
    .concat('\n');
  const lunaBody = Object.entries(luna)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
    .concat('\n');
  fs.writeFileSync(path.join(ENV_OUT, 'hermes-orchestrator.env'), orchBody, 'utf8');
  fs.writeFileSync(path.join(ENV_OUT, 'hermes-luna.env'), lunaBody, 'utf8');
  console.log(JSON.stringify({
    ok: true,
    orchestrator_env: path.join(ENV_OUT, 'hermes-orchestrator.env'),
    luna_env: path.join(ENV_OUT, 'hermes-luna.env'),
    note: 'Orchestrator: set DISCORD_BOT_TOKEN (you have it) via env or KV discord-bot-token. Luna: OAuth only — no OPENAI_API_KEY in .env.',
  }, null, 2));
}

function ssh(cmd) {
  const ip = vmPublicIp();
  if (!ip) {
    console.error('FAIL — VM has no public IP');
    process.exit(1);
  }
  const home = process.env.USERPROFILE || process.env.HOME;
  const key = path.join(home, '.ssh', 'id_rsa');
  const keyArg = fs.existsSync(key) ? `-i ${key}` : '';
  execSync(`ssh -o StrictHostKeyChecking=accept-new ${keyArg} azureuser@${ip} "${cmd.replace(/"/g, '\\"')}"`, {
    stdio: 'inherit',
  });
}

function scpToVm(local, remote) {
  const ip = vmPublicIp();
  if (!ip) {
    console.error('FAIL — VM has no public IP');
    process.exit(1);
  }
  const home = process.env.USERPROFILE || process.env.HOME;
  const key = path.join(home, '.ssh', 'id_rsa');
  const keyArg = fs.existsSync(key) ? `-i ${key}` : '';
  execSync(`scp -o StrictHostKeyChecking=accept-new ${keyArg} ${local} azureuser@${ip}:${remote}`, {
    stdio: 'inherit',
  });
}

function checkRepoSync() {
  const args = process.argv.slice(3);
  const extra = args.length ? args.join(' ') : '';
  execSync(`node scripts/check-repo-sync.js ${extra}`.trim(), { cwd: ROOT, stdio: 'inherit' });
}

function sshOut(cmd) {
  const ip = vmPublicIp();
  if (!ip) return null;
  const home = process.env.USERPROFILE || process.env.HOME;
  const key = path.join(home, '.ssh', 'id_rsa');
  const keyArg = fs.existsSync(key) ? `-i ${key}` : '';
  try {
    return execSync(
      `ssh -o StrictHostKeyChecking=accept-new ${keyArg} azureuser@${ip} "${cmd.replace(/"/g, '\\"')}"`,
      { encoding: 'utf8' },
    ).trim();
  } catch {
    return null;
  }
}

function syncRepo() {
  if (!vmExists()) {
    console.error('FAIL — VM missing');
    process.exit(1);
  }
  console.error('[vm] check-repo-sync before bundle push...');
  try {
    execSync('node scripts/check-repo-sync.js --strict', { cwd: ROOT, stdio: 'inherit' });
  } catch {
    console.error('FAIL — Lunabox may be ahead or dirty. Pull Captain commits first (see docs/GITHUB-REPO-SETUP.md).');
    process.exit(1);
  }
  const branch = execSync('git branch --show-current', { cwd: ROOT, encoding: 'utf8' }).trim() || 'master';
  const bundleLocal = path.join(ROOT, '.wh-sync.bundle');
  const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  console.error(`[vm] creating bundle from ${branch}...`);
  execSync(`git bundle create ${bundleLocal} ${branch}`, { cwd: ROOT, stdio: 'inherit' });
  scpToVm(bundleLocal, '/tmp/wh-sync.bundle');
  ssh(`sudo mv ${HERMES_VM.REPO_PATH} ${HERMES_VM.REPO_PATH}.bak.${stamp} 2>/dev/null || true`);
  ssh(`sudo mkdir -p ${path.posix.dirname(HERMES_VM.REPO_PATH)}`);
  ssh(`sudo git clone /tmp/wh-sync.bundle ${HERMES_VM.REPO_PATH}`);
  ssh(`sudo chown -R azureuser:azureuser ${HERMES_VM.REPO_PATH}`);
  const head = sshOut(`git -C ${HERMES_VM.REPO_PATH} rev-parse HEAD`);
  try { fs.unlinkSync(bundleLocal); } catch { /* ignore */ }
  console.log(JSON.stringify({ ok: true, branch, head, backup: `${HERMES_VM.REPO_PATH}.bak.${stamp}` }, null, 2));
}

function pruneRemoteImages() {
  if (!vmExists()) {
    console.error('[vm] skip image prune — VM missing');
    return;
  }
  console.error('[vm] pruning unused Docker images on Lunabox (docker image prune -af)...');
  const before = sshOut('df -h / | tail -1') || '';
  if (before) console.error(`[vm] disk before prune: ${before}`);
  ssh('sudo docker image prune -af');
  const after = sshOut('df -h / | tail -1') || '';
  if (after) console.error(`[vm] disk after prune: ${after}`);
}

function bootstrapRemote() {
  if (!vmExists()) {
    console.error('FAIL — VM missing. Run: node scripts/deploy-staging-hermes-vm.js create-vm');
    process.exit(1);
  }
  writeEnvFiles();
  const ip = vmPublicIp();
  const home = process.env.USERPROFILE || process.env.HOME;
  const key = path.join(home, '.ssh', 'id_rsa');
  const keyArg = fs.existsSync(key) ? `-i ${key}` : '';
  const scp = (local, remote) => {
    execSync(`scp -o StrictHostKeyChecking=accept-new ${keyArg} ${local} azureuser@${ip}:${remote}`, { stdio: 'inherit' });
  };
  scp(path.join(ENV_OUT, 'hermes-orchestrator.env'), '/tmp/hermes-orchestrator.env');
  scp(path.join(ENV_OUT, 'hermes-luna.env'), '/tmp/hermes-luna.env');
  scp(path.join(ROOT, 'scripts', 'provision-hermes-vm.sh'), '/tmp/provision-hermes-vm.sh');
  const composeLocal = path.join(ROOT, 'docker', 'hermes-staging', 'docker-compose.vm.yml');
  ssh('mkdir -p /tmp/hermes-staging');
  scp(composeLocal, '/tmp/hermes-staging/docker-compose.vm.yml');
  ssh('sed -i "s/\\r$//" /tmp/provision-hermes-vm.sh');
  ssh('sudo bash /tmp/provision-hermes-vm.sh');
  ssh('sudo mkdir -p /opt/wolfhouse/WH/docker/hermes-staging && sudo cp /tmp/hermes-staging/docker-compose.vm.yml /opt/wolfhouse/WH/docker/hermes-staging/docker-compose.vm.yml');
  ssh('sudo mv /tmp/hermes-orchestrator.env /etc/hermes-orchestrator.env && sudo mv /tmp/hermes-luna.env /etc/hermes-luna.env && sudo chmod 600 /etc/hermes-*.env');
  const acrToken = az(
    `acr login --name ${HERMES_VM.ACR} --expose-token --output tsv --query accessToken`,
    { silent: true },
  );
  if (acrToken) {
    ssh(
      `echo ${acrToken} | sudo docker login ${HERMES_VM.ACR}.azurecr.io -u 00000000-0000-0000-0000-000000000000 --password-stdin`,
    );
  }
  ssh(`sudo docker pull ${HERMES_VM.IMAGE}`);
  ssh(
    `test -f ${HERMES_VM.COMPOSE_FILE} && sudo docker compose -f ${HERMES_VM.COMPOSE_FILE} pull && sudo docker compose -f ${HERMES_VM.COMPOSE_FILE} up -d || echo "WARN: repo missing at ${HERMES_VM.REPO_PATH} — clone WH then compose up"`,
  );
  pruneRemoteImages();
  console.log(JSON.stringify({ ok: true, public_ip: ip }, null, 2));
}

function verify() {
  const ip = vmPublicIp();
  if (!ip) {
    console.error('FAIL — no VM public IP');
    process.exit(1);
  }
  const orchHealth = curlCode(`http://${ip}:${HERMES_VM.PORT_ORCHESTRATOR}/health`);
  const lunaHealth = curlCode(`http://${ip}:${HERMES_VM.PORT_LUNA_WEBHOOK}/health`);
  const ok = orchHealth === '200' || orchHealth === '204' || lunaHealth === '200' || lunaHealth === '204';
  console.log(JSON.stringify({
    ok,
    public_ip: ip,
    orchestrator_health: { url: `http://${ip}:${HERMES_VM.PORT_ORCHESTRATOR}/health`, code: orchHealth },
    luna_health: { url: `http://${ip}:${HERMES_VM.PORT_LUNA_WEBHOOK}/health`, code: lunaHealth },
    meta_webhook_url: `https://${HERMES_VM.HOSTNAME}/whatsapp/webhook`,
    note: ok ? 'At least one gateway healthy. Point Meta webhook after Caddy TLS is live.' : 'Gateways not healthy — check docker logs on VM.',
  }, null, 2));
  if (!ok) process.exit(1);
}

const cmd = (process.argv[2] || 'status').toLowerCase();
const handlers = {
  status,
  'build-image': buildImage,
  'create-vm': createVm,
  'write-env-files': writeEnvFiles,
  'bootstrap-remote': bootstrapRemote,
  'prune-images': pruneRemoteImages,
  verify,
  'check-repo-sync': checkRepoSync,
  'sync-repo': syncRepo,
};
const fn = handlers[cmd];
if (!fn) {
  console.error(`Unknown command: ${cmd}`);
  process.exit(1);
}
fn();
