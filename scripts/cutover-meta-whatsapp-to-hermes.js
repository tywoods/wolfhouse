'use strict';
/**
 * Point Meta demo phone webhook override to Hermes staging.
 * App Dashboard URL alone is NOT enough — phone_number override wins for inbound messages.
 *
 * Usage:
 *   node scripts/cutover-meta-whatsapp-to-hermes.js status
 *   node scripts/cutover-meta-whatsapp-to-hermes.js apply
 */

const https = require('https');
const { execSync } = require('child_process');

const PHONE_ID = '1152900101233109';
const VERIFY_TOKEN = 'wolfhouse_verify_token';
const HERMES_CALLBACK =
  process.env.HERMES_CALLBACK_URL ||
  'https://lunabox.lunafrontdesk.com/whatsapp/webhook';

const cmd = (process.argv[2] || 'status').toLowerCase();

function az(args) {
  return execSync(`az ${args}`, { encoding: 'utf8' }).trim();
}

function graphGet(token) {
  return new Promise((resolve, reject) => {
    const url = `https://graph.facebook.com/v21.0/${PHONE_ID}?fields=display_phone_number,webhook_configuration&access_token=${encodeURIComponent(token)}`;
    https.get(url, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch { resolve({ raw: buf }); }
      });
    }).on('error', reject);
  });
}

function graphOverride(token, callbackUrl) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      webhook_configuration: JSON.stringify({
        override_callback_uri: callbackUrl,
        verify_token: VERIFY_TOKEN,
      }),
      access_token: token,
    });
    const data = params.toString();
    const req = https.request({
      hostname: 'graph.facebook.com',
      path: `/v21.0/${PHONE_ID}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const token = az('keyvault secret show --vault-name wh-staging-kv --name meta-whatsapp-token --query value -o tsv');
  const before = await graphGet(token);
  const effective = before?.webhook_configuration?.phone_number
    || before?.webhook_configuration?.application
    || null;

  if (cmd === 'status') {
    console.log(JSON.stringify({
      phone_id: PHONE_ID,
      display_phone_number: before?.display_phone_number,
      webhook_configuration: before?.webhook_configuration,
      effective_inbound_url: effective,
      hermes_target: HERMES_CALLBACK,
      points_to_hermes: effective === HERMES_CALLBACK,
      note: effective !== HERMES_CALLBACK
        ? 'Inbound WhatsApp still goes to Luna Staff API until phone_number override is updated.'
        : 'Phone override points to Hermes.',
    }, null, 2));
    return;
  }

  if (cmd === 'apply') {
    if (effective === HERMES_CALLBACK) {
      console.log(JSON.stringify({ ok: true, already: true, effective_inbound_url: effective }, null, 2));
      return;
    }
    const override = await graphOverride(token, HERMES_CALLBACK);
    await new Promise((r) => setTimeout(r, 2000));
    const after = await graphGet(token);
    const newEffective = after?.webhook_configuration?.phone_number
      || after?.webhook_configuration?.application;
    const ok = newEffective === HERMES_CALLBACK && override.status === 200;
    console.log(JSON.stringify({
      ok,
      before: before?.webhook_configuration,
      override_response: override,
      after: after?.webhook_configuration,
      effective_inbound_url: newEffective,
      next: 'Send a WhatsApp test message; curl Hermes /health and check accepted counter.',
    }, null, 2));
    if (!ok) process.exit(1);
    return;
  }

  console.error('Usage: node scripts/cutover-meta-whatsapp-to-hermes.js status|apply');
  process.exit(1);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
