'use strict';
/**
 * Run Hermes Agent locally in Docker with the WH repo mounted.
 *
 * Usage:
 *   node scripts/run-local-hermes.js setup     # create hermes-local/.env (Azure KV or prompt)
 *   node scripts/run-local-hermes.js doctor    # health check
 *   node scripts/run-local-hermes.js chat      # interactive session (AGENTS.md + SOUL.md loaded)
 *   node scripts/run-local-hermes.js ask "..." # one-shot question
 */

const { execSync, spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');
const HERMES_HOME = path.join(ROOT, 'hermes-local');
const ENV_FILE = path.join(HERMES_HOME, '.env');
const ENV_EXAMPLE = path.join(HERMES_HOME, '.env.example');
const IMAGE = 'nousresearch/hermes-agent:latest';

const cmd = (process.argv[2] || 'chat').toLowerCase();
const rest = process.argv.slice(3);

function az(args) {
  return execSync(`az ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tryKvOpenAiKey() {
  try {
    return az('keyvault secret show --vault-name wh-staging-kv --name openai-api-key --query value -o tsv');
  } catch {
    return null;
  }
}

async function promptForKey() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question('Paste OPENAI_API_KEY (input hidden): ', (answer) => {
      rl.close();
      resolve((answer || '').trim());
    });
  });
}

function writeEnv(key) {
  fs.writeFileSync(ENV_FILE, `OPENAI_API_KEY=${key.trim()}\n`, 'utf8');
  console.error('[hermes-local] wrote hermes-local/.env');
}

async function ensureEnv() {
  if (fs.existsSync(ENV_FILE)) {
    const body = fs.readFileSync(ENV_FILE, 'utf8');
    if (/^OPENAI_API_KEY=\S+/m.test(body)) return;
  }
  const fromEnv = (process.env.OPENAI_API_KEY || '').trim();
  if (fromEnv) {
    writeEnv(fromEnv);
    return;
  }
  const fromKv = tryKvOpenAiKey();
  if (fromKv) {
    writeEnv(fromKv);
    console.error('[hermes-local] loaded OPENAI_API_KEY from wh-staging-kv');
    return;
  }
  console.error('[hermes-local] No OPENAI_API_KEY found.');
  console.error('Run: node scripts/run-local-hermes.js setup');
  console.error('Or copy hermes-local/.env.example → hermes-local/.env');
  process.exit(1);
}

async function setup() {
  if (!fs.existsSync(HERMES_HOME)) {
    console.error('[hermes-local] missing hermes-local/ — re-clone the repo');
    process.exit(1);
  }
  const fromKv = tryKvOpenAiKey();
  if (fromKv) {
    writeEnv(fromKv);
    console.log('OK — key from Azure Key Vault (wh-staging-kv/openai-api-key)');
    return;
  }
  const key = await promptForKey();
  if (!key) {
    console.error('No key entered.');
    process.exit(1);
  }
  writeEnv(key);
  console.log('OK — hermes-local/.env created');
}

function dockerArgs(hermesArgv, interactive) {
  const args = ['run'];
  if (interactive) args.push('-it');
  else args.push('--rm');
  args.push(
    '--entrypoint', 'hermes',
    '-v', `${ROOT}:/workspace`,
    '-v', `${HERMES_HOME}:/opt/hermes-home`,
    '-w', '/workspace',
    '-e', 'HERMES_HOME=/opt/hermes-home',
    '--env-file', ENV_FILE,
    IMAGE,
    ...hermesArgv,
  );
  return args;
}

function runDocker(hermesArgv, interactive) {
  const args = dockerArgs(hermesArgv, interactive);
  if (interactive) {
    const child = spawn('docker', args, { stdio: 'inherit', cwd: ROOT });
    child.on('exit', (code) => process.exit(code ?? 0));
    return;
  }
  const result = spawnSync('docker', args, { stdio: 'inherit', cwd: ROOT });
  process.exit(result.status ?? 1);
}

function usage() {
  console.log(`Usage: node scripts/run-local-hermes.js <command>

Commands:
  setup     Create hermes-local/.env (Azure KV or prompt)
  doctor    Hermes environment check
  chat      Interactive chat (reads AGENTS.md + hermes-local/SOUL.md)
  ask "..." One-shot question (-q mode)

Docs: docs/HERMES-LOCAL.md`);
}

async function main() {
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  if (cmd === 'setup') {
    await setup();
    return;
  }

  await ensureEnv();

  if (cmd === 'doctor') {
    runDocker(['doctor'], false);
    return;
  }

  if (cmd === 'chat') {
    runDocker(['chat', '--cli'], true);
    return;
  }

  if (cmd === 'ask') {
    const query = rest.join(' ').trim();
    if (!query) {
      console.error('Usage: node scripts/run-local-hermes.js ask "your question"');
      process.exit(1);
    }
    runDocker(['chat', '-q', query, '-Q'], false);
    return;
  }

  usage();
  process.exit(1);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
