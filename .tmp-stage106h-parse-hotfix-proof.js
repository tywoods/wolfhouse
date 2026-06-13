'use strict';

const https = require('https');
const vm = require('vm');
const { execSync } = require('child_process');

const HOST = 'staff-staging.lunafrontdesk.com';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:7c8780a-stage106h-ui-parse-hotfix';

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST,
      path,
      method,
      headers: {
        Accept: 'text/html,application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, raw, headers: res.headers }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function activeRevision() {
  const rows = JSON.parse(execSync(
    'az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json',
    { encoding: 'utf8' },
  ));
  const a = rows.find((x) => x.properties.trafficWeight === 100) || {};
  return {
    name: a.name,
    health: a.properties.healthState,
    traffic: a.properties.trafficWeight,
    image: a.properties.template.containers[0].image,
  };
}

(async () => {
  const rev = activeRevision();
  const login = await req('POST', '/staff/auth/login', {
    client: 'wolfhouse-somo',
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
  const ui = await req('GET', '/staff/ui', null, cookie);
  const html = ui.raw || '';
  const scriptTag = html.indexOf('<script>');
  const endTag = html.indexOf('</script>', scriptTag);
  const scriptBlock = html.slice(scriptTag + '<script>'.length, endTag);
  const fnStart = scriptBlock.indexOf('(function(){');
  const fnEnd = scriptBlock.lastIndexOf('})();');
  const script = fnStart >= 0 && fnEnd > fnStart
    ? scriptBlock.slice(fnStart, fnEnd + '})();'.length)
    : '';

  let parseOk = false;
  let parseErr = null;
  try {
    new vm.Script(script);
    parseOk = true;
  } catch (e) {
    parseErr = e.message;
  }

  const checks = {
    deploy_healthy: rev.health === 'Healthy' && rev.traffic === 100 && rev.image === IMAGE,
    ui_status_200: ui.status === 200,
    script_extracted: script.length > 10000,
    vm_parse_ok: parseOk,
    switchToTab_global: /window\.switchToTab\s*=\s*switchToTab/.test(script),
    switchToTabOnly_global: /window\.switchToTabOnly\s*=\s*switchToTabOnly/.test(script),
    pickCalendarGuestDisplayName: /function pickCalendarGuestDisplayName/.test(script),
    bcQuoteAccommodationNote: /function bcQuoteAccommodationNote/.test(script),
    bcQuote_string_parse: /bcQuoteDigitsBeforeCent/.test(script) && !/match\(\/^7-night flat:/.test(script),
    tile_needs_human: html.includes("switchToTab('conversations','handoffs')"),
    tile_inbox: html.includes("switchToTab('conversations','inbox')"),
    tile_bed_cal: html.includes("switchToTabOnly('bed-calendar')"),
    stripe_landing: /handleStripeCheckoutSuccessLanding/.test(script),
    new_conversation: /create-conversation/.test(script),
    no_wa: !/graph\.facebook\.com/.test(script),
    no_n8n_activate: !/n8n\.cloud.*activate/i.test(script),
  };

  const failures = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  console.log(JSON.stringify({
    commit: '7c8780a',
    image: IMAGE,
    acr_run: 'cb2m',
    revision: rev,
    parse_error: parseErr,
    checks,
    failures,
    result: failures.length === 0 ? 'PASS' : (failures.length <= 2 ? 'PARTIAL' : 'FAIL'),
  }, null, 2));
  if (failures.length > 0) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
