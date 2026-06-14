'use strict';
/** One-shot bootstrap for Hermes /opt/data on ephemeral ACA storage. */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const RG = 'wh-staging-rg';
const APP = 'wh-staging-hermes';
const configB64 = Buffer.from(
  'model:\n  default: gpt-4o-mini\n  provider: openai-api\n  api_mode: chat_completions\nagent:\n  reasoning_effort: none\n',
).toString('base64');
const soulPath = path.join(__dirname, '..', 'docker', 'hermes-staging', 'SOUL.md');
const soulB64 = fs.readFileSync(soulPath, 'utf8').toString('base64');

function exec(cmd) {
  return execSync(`az containerapp exec -g ${RG} -n ${APP} --command "${cmd}"`, {
    encoding: 'utf8',
    maxBuffer: 5 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

try {
  exec(`sh -c echo ${configB64} | base64 -d > /opt/data/config.yaml`);
  exec(`sh -c echo ${soulB64} | base64 -d > /opt/data/SOUL.md`);
  exec('hermes config set model.default gpt-4o-mini');
  exec('hermes config set model.provider openai-api');
  exec('sh -c grep -q ^OPENAI_API_KEY= /opt/data/.env || printenv OPENAI_API_KEY | sed s/^/OPENAI_API_KEY=/ >> /opt/data/.env');
  console.log(JSON.stringify({ ok: true, soul_deployed: true }, null, 2));
} catch (e) {
  console.error(e.stderr || e.message || e);
  process.exit(1);
}
