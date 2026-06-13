'use strict';
/**
 * Wire Hermes Desktop to the Wolfhouse WH repo (Windows-friendly).
 *
 * Usage:
 *   node scripts/setup-hermes-desktop.js
 *
 * Copies project SOUL + OpenAI config into %USERPROFILE%\.hermes
 * and prints Desktop workspace steps.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PROJECT_HERMES = path.join(ROOT, 'hermes-local');
const DESKTOP_HOME = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');

function az(args) {
  return execSync(`az ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function readKey() {
  const localEnv = path.join(PROJECT_HERMES, '.env');
  if (fs.existsSync(localEnv)) {
    const m = fs.readFileSync(localEnv, 'utf8').match(/^OPENAI_API_KEY=(.+)$/m);
    if (m?.[1]?.trim()) return m[1].trim();
  }
  if (process.env.OPENAI_API_KEY?.trim()) return process.env.OPENAI_API_KEY.trim();
  try {
    return az('keyvault secret show --vault-name wh-staging-kv --name openai-api-key --query value -o tsv');
  } catch {
    return null;
  }
}

function mergeOpenAiKey(envPath, key) {
  let body = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  if (/^OPENAI_API_KEY=/m.test(body)) {
    body = body.replace(/^OPENAI_API_KEY=.*$/m, `OPENAI_API_KEY=${key}`);
  } else {
    body = `${body.replace(/\s*$/, '')}\nOPENAI_API_KEY=${key}\n`;
  }
  fs.writeFileSync(envPath, body, 'utf8');
}

function main() {
  fs.mkdirSync(DESKTOP_HOME, { recursive: true });

  const soulSrc = path.join(PROJECT_HERMES, 'SOUL.md');
  const soulDst = path.join(DESKTOP_HOME, 'SOUL.md');
  if (fs.existsSync(soulSrc)) {
    fs.copyFileSync(soulSrc, soulDst);
    console.log(`OK — SOUL.md → ${soulDst}`);
  }

  const cfgSrc = path.join(PROJECT_HERMES, 'config.yaml');
  const cfgDst = path.join(DESKTOP_HOME, 'config.yaml');
  if (fs.existsSync(cfgSrc)) {
    fs.copyFileSync(cfgSrc, cfgDst);
    console.log(`OK — config.yaml → ${cfgDst}`);
  }

  const key = readKey();
  const envDst = path.join(DESKTOP_HOME, '.env');
  if (key) {
    mergeOpenAiKey(envDst, key);
    console.log(`OK — OPENAI_API_KEY in ${envDst}`);
  } else {
    console.warn('WARN — no OPENAI_API_KEY; add to %USERPROFILE%\\.hermes\\.env or run node scripts/run-local-hermes.js setup');
  }

  const agents = path.join(ROOT, 'AGENTS.md');
  if (!fs.existsSync(agents)) {
    console.warn('WARN — AGENTS.md missing in repo root');
  }

  console.log('');
  console.log('Hermes Desktop — set workspace to this repo:');
  console.log(`  ${ROOT}`);
  console.log('');
  console.log('In Desktop:');
  console.log('  1. Settings → Workspace → Working Directory → paste path above');
  console.log('  2. Or close Desktop and run:');
  console.log(`     hermes desktop --cwd "${ROOT}"`);
  console.log('  3. New chat session (old sessions may remember a different folder)');
  console.log('');
  console.log('AGENTS.md in the repo root loads automatically when workspace = WH.');
  console.log('Docs: docs/HERMES-LOCAL.md');
}

main();
