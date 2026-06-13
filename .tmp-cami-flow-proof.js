'use strict';
const https = require('https');
const { execSync } = require('child_process');

const STAFF_HOST = 'staff-staging.lunafrontdesk.com';
const ROUTE = '/staff/bot/guest-inbound-review-dry-run';

function httpsJson(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: STAFF_HOST, path, method,
      headers: {
        Accept: 'application/json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
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
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  let token = '';
  try {
    token = execSync('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv', { encoding: 'utf8' }).trim();
  } catch { /* optional */ }
  const headers = token ? { 'X-Luna-Bot-Token': token } : {};
  const phone = `+34653${String(Date.now()).slice(-6)}`;
  const turns = ['hello!', 'book a stay', 'June 22-29', '2', 'malibu', 'ill pay the deposit'];
  let ctx = null;
  const out = [];
  for (let i = 0; i < turns.length; i++) {
    const res = await httpsJson('POST', ROUTE, {
      source: 'cami_flow_proof',
      client_slug: 'wolfhouse-somo',
      channel: 'whatsapp',
      guest_phone: phone,
      message_text: turns[i],
      reference_date: '2026-06-11',
      received_at: new Date().toISOString(),
      automation_gate_context: { public_guest_automation_enabled: false, whatsapp_dry_run: true, live_send_allowed: false },
      ...(ctx ? { guest_context: ctx } : {}),
    }, headers);
    const review = res.body?.review || {};
    const r = review.result || {};
    const pipe = review.observability?.guest_reply_pipeline || r.guest_reply_pipeline || {};
    const cami = r.cami_reply_author || review.observability?.cami_reply_author || pipe.cami_reply_author || {};
    out.push({
      turn: i + 1,
      guest: turns[i],
      reply: String(review.proposed_luna_reply || '').slice(0, 160),
      reply_source: pipe.reply_source || r.final_reply_source || null,
      composer_state: r.composer_state || pipe.composer_state || null,
      cami_enabled: cami.cami_reply_author_enabled,
      cami_used: cami.cami_author_used === true || cami.author_used === true,
      cami_skipped: pipe.cami_skipped,
      cami_skip_reason: pipe.cami_skip_reason || cami.rejection_reason,
    });
    ctx = res.body?.slim_guest_context_for_next_turn || ctx;
  }
  console.log(JSON.stringify({ phone, turns: out }, null, 2));
})();
