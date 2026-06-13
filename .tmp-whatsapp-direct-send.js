'use strict';
const { execSync } = require('child_process');

const token = execSync('az keyvault secret show --vault-name wh-staging-kv --name meta-whatsapp-token --query value -o tsv', { encoding: 'utf8' }).trim();
const phoneId = '1152900101233109';
const to = '491726422307';

(async () => {
  const url = `https://graph.facebook.com/v21.0/${phoneId}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: 'Quick staging ping from Luna — if you see this, replies are working again 🐺' },
    }),
  });
  const body = await res.json().catch(() => ({}));
  console.log(JSON.stringify({ status: res.status, ok: res.ok, body }, null, 2));
})().catch((e) => console.error(e));
