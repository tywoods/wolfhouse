'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { renderCrowsnestPage } = require('./lib/crowsnest/crowsnest-page');

const html = renderCrowsnestPage({
  view: 'communications',
  cspNonce: 'test-nonce',
  whatsappIdentity: {
    ok: true,
    profileId: '2000000000000001',
    numberDisplay: 'configured ···0001',
  },
});

assert.match(html, /Current binding/i);
assert.match(html, /configured ···0001/);
assert.match(html, /policy off · delivery unknown/);
assert.doesNotMatch(html, /router off/i);
assert.doesNotMatch(html, /staging-es-34663439419|\+34 663 43 94 19/);
assert.match(html, /Sunset/);
assert.match(html, /Wolfhouse/);
assert.match(html, /Save routing/i);
assert.match(html, /Confirm routing change/i);
assert.match(html, /old Luna/i);
assert.match(html, /new Luna/i);
assert.match(html, /who changed/i);
assert.match(html, /when/i);
assert.match(html, /\/api\/communications\/luna-number-route/);
assert.match(html, /number_id:payload\.number_id/);
assert.doesNotMatch(html, /routing_delivery \|\| 'off'/);
assert.match(html, /routing_delivery_unobserved/);
assert.match(html, /flip-to-sunset/);
assert.match(html, /rollback-to-wolfhouse/);
assert.match(html, /crypto\.randomUUID\(\)/);
assert.match(html, /expected_revision/);
assert.match(html, /target_luna/);
assert.match(html, /revision/);
assert.match(html, /Routing saved and verified/);
assert.match(html, /audit_readback_missing/);
assert.match(html, /applied\.audit/);
assert.doesNotMatch(html, /new Date\(\)\.toLocaleString/);
assert.doesNotMatch(html, /Authenticated operator/);
assert.doesNotMatch(html, /\/api\/staging\/luna-routing\//);
assert.doesNotMatch(html, /request\(['\"](?:targets|effective|confirm|apply|audit)['\"]/);
assert.doesNotMatch(html, /type=["']text["'][^>]*name=["'](?:phone|host|command|shell)/i);
assert.doesNotMatch(html, /8094|\/sethome|child_process|exec\(|spawn\(/i);

const apiSource = fs.readFileSync(path.join(__dirname, 'crowsnest-api.js'), 'utf8');
assert.match(apiSource, /pathname\.startsWith\(LUNA_ROUTING_PREFIX\)/);
assert.match(apiSource, /CROWSNEST_LUNA_ROUTING_CONTROLLER_URL/);
assert.match(apiSource, /unknown_or_production_number_denied/);
assert.match(apiSource, /isBrowserUiAuthorized\(req\)/);
assert.match(apiSource, /isTrustedSessionMutationOrigin/);
assert.match(apiSource, /CROWSNEST_PUBLIC_ORIGIN/);
assert.match(apiSource, /origin_rejected/);
assert.match(apiSource, /serializeBrowserOrigin/);
assert.doesNotMatch(
  apiSource,
  /if\s*\(\s*!expectedOrigin\s*\|\|\s*String\(req\.headers\.origin/,
  'must not hard-fail session routing solely because CROWSNEST_PUBLIC_ORIGIN is unset',
);
assert.match(html, /nonce=["']test-nonce["']/);

const vm = require('vm');
const os = require('os');
const ctl = require('./luna-number-routing-controller');
const routing = require('./lib/crowsnest/crowsnest-luna-number-routing');

function communicationsScript(source) {
  const script = [...source.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1])
    .find((body) => body.includes("const API = '/api/communications/luna-number-route'"));
  assert.ok(script, 'rendered communications script missing');
  return script;
}

function browser(source, fetchImpl) {
  const nodes = new Map();
  function node(selector) {
    if (!nodes.has(selector)) {
      nodes.set(selector, {
        textContent: '',
        value: '',
        disabled: false,
        dataset: {},
        open: false,
        listeners: {},
        addEventListener(type, callback) { this.listeners[type] = callback; },
        showModal() { this.open = true; },
        close() { this.open = false; },
      });
    }
    return nodes.get(selector);
  }
  node('[data-current-number]').textContent = source.match(/<p data-current-number>([^<]*)<\/p>/)[1];
  node('[data-current-binding]').textContent = source.match(/<p[^>]*data-current-binding>([^<]*)<\/p>/)[1];
  node('[data-save-routing]').disabled = true;
  node('#routing-number').value = '2000000000000001';
  node('#routing-target').value = 'wolfhouse';
  vm.runInNewContext(communicationsScript(source), {
    document: { querySelector: () => ({ querySelector: node }) },
    crypto: { randomUUID: () => '12345678-1234-4234-8234-123456789abc' },
    fetch: async (url, options) => fetchImpl(url, options),
  }, { filename: 'communications-script.js' });
  return node;
}

function jsonResponse(status, data) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function wolfhouseConfig(target) {
  return {
    apps: { http: { servers: { fixture: { routes: [{
      match: [{ host: [ctl.FRANCE_STAGING_SITE], path: [ctl.EXACT_PATH] }],
      terminal: true,
      handle: [{ handler: 'subroute', routes: [{ handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: ctl.TARGETS[target] }] }] }] }],
    }] } } } },
  };
}

(async () => {
  const active = {
    ok: true,
    phone_number_id: '2000000000000001',
    routing_policy: 'off',
    routing_delivery: 'active',
    route: { target_luna: 'wolfhouse', revision: 'a'.repeat(64) },
    audit: null,
  };
  const loaded = browser(html, async () => jsonResponse(200, active));
  await settle();
  assert.equal(loaded('[data-save-routing]').disabled, false);
  assert.match(loaded('[data-current-number]').textContent, /policy off · delivery active/);
  assert.doesNotMatch(loaded('[data-current-number]').textContent, /router off/i);

  for (const mode of ['missing_delivery', 'off_delivery', 'unavailable_delivery']) {
    const data = { ...active };
    if (mode === 'missing_delivery') delete data.routing_delivery;
    else data.routing_delivery = mode === 'off_delivery' ? 'off' : 'unavailable';
    const failed = browser(html, async () => jsonResponse(200, data));
    await settle();
    assert.equal(failed('[data-save-routing]').disabled, true, mode);
    assert.match(failed('[data-current-number]').textContent, /policy off · delivery (unknown|unavailable)/, mode);
    assert.doesNotMatch(failed('[data-current-number]').textContent, /router off/i, mode);
  }

  const routeEnv = {
    CROWSNEST_ENVIRONMENT: 'staging',
    CROWSNEST_LUNA_ROUTING_CONTROLLER_URL: 'https://controller.example.invalid/_internal/luna-routing/v1/routes/meta-whatsapp-verified-webhook',
    CROWSNEST_LUNA_ROUTING_CONTROLLER_HMAC_KEY: 'k'.repeat(32),
    CROWSNEST_COMMS_DATABASE_URL: 'postgres://unused-fixture',
  };
  for (const mode of ['absent', 'failed', 'contradictory']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-label-'));
    const fragment = path.join(dir, 'fragment.caddy');
    fs.writeFileSync(fragment, ctl.managedBlock('wolfhouse'));
    let hostCommands = 0;
    const reader = ctl.createController({
      mutationsEnabled: false,
      fragmentFile: fragment,
      stateDir: dir,
      expectedSite: ctl.FRANCE_STAGING_SITE,
      fetch: async () => {
        if (mode === 'failed') throw new Error('caddy unavailable');
        if (mode === 'absent') return jsonResponse(200, { apps: { http: { servers: { fixture: { routes: [] } } } } });
        return jsonResponse(200, wolfhouseConfig(mode === 'contradictory' ? 'sunset' : 'wolfhouse'));
      },
      exec: async () => { hostCommands += 1; throw new Error('host command prohibited'); },
    });
    let controllerStatus = 200;
    let controllerBody;
    try {
      controllerBody = { ok: true, route: await reader.state() };
    } catch (error) {
      controllerStatus = 503;
      controllerBody = { ok: false, code: error.code || 'route_readback_failed' };
    }
    const wrapped = await routing.readLunaNumberRoute({
      env: routeEnv,
      auditStore: { latest: async () => null },
      transport: async () => jsonResponse(controllerStatus, controllerBody),
    });
    assert.equal(controllerStatus, 503, mode);
    assert.equal(wrapped.code, 'route_readback_failed', mode);
    assert.equal(hostCommands, 0, mode);
    const ui = browser(html, async () => jsonResponse(wrapped.status || 503, wrapped));
    await settle();
    assert.equal(ui('[data-save-routing]').disabled, true, mode);
    assert.match(ui('[data-current-number]').textContent, /policy off · delivery (unknown|unavailable)/, mode);
    assert.doesNotMatch(ui('[data-current-number]').textContent, /router off/i, mode);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('PASS verify:crowsnest-communications-routing');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
