'use strict';

// Offline regression over the actual emitted portal functions. No API/DB calls.
const assert = require('node:assert/strict');
const vm = require('node:vm');
Object.assign(process.env, {
  NODE_ENV: 'test', STAFF_UI_BUILDER_TEST_SEAM: '1',
  STAFF_AUTH_REQUIRED: 'false', STAFF_AUTH_ALLOW_OPEN: 'true',
  DEFAULT_CLIENT_SLUG: 'wolfhouse-somo',
});
delete process.env.LUNA_DEPLOYMENT;
const { buildUiHtmlForOfflineTest } = require('./staff-query-api');

function emittedFunction(html, name) {
  const start = html.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'emitted function exists: ' + name);
  const end = html.indexOf('\n}', start);
  assert.notEqual(end, -1, 'emitted function ends: ' + name);
  return html.slice(start, end + 2);
}

const services = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'Lesson <A> & "B"', price_cents: 12345, price_unit: 'per_lesson', per_guest: true },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Lesson <A> & "B"', price_cents: 23456, price_unit: 'per_lesson', per_guest: false },
  { id: '33333333-3333-4333-8333-333333333333', name: 'Daily bike', price_cents: 1700, price_unit: 'per_day', per_guest: true },
  { id: '44444444-4444-4444-8444-444444444444', name: 'Flat transfer', price_cents: 4200, price_unit: 'per_stay', per_guest: false },
  { id: '55555555-5555-4555-8555-555555555555', name: 'Stay guest', price_cents: 3200, price_unit: 'per_stay', per_guest: true },
];
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); }
}

for (const client of ['wolfhouse-somo', 'sunset']) {
  const html = buildUiHtmlForOfflineTest(0, client);
  const state = { client };
  const ctx = vm.createContext({
    bcServiceCatalog: structuredClone(services),
    // DOM seam used by the real getBcClient; this is renderer proof, not auth proof.
    el: id => { assert.equal(id, 'bc-client'); return { value: state.client }; },
  });
  // getBcClient is a single-line emitted function; do not consume its next neighbor.
  const getClient = html.match(/function getBcClient\(\)\{[^\n]+\}/);
  assert.ok(getClient, 'real client accessor emitted');
  vm.runInContext(getClient[0] + '\n' + ['escHtml', 'bcServiceCatalogOptionsHtml', 'bcAddServiceEntryRowHtml']
    .map(name => emittedFunction(html, name)).join('\n'), ctx);
  const before = JSON.stringify(ctx.bcServiceCatalog);
  const options = ctx.bcServiceCatalogOptionsHtml();
  const row = ctx.bcAddServiceEntryRowHtml('offline-row');
  const lessonUnit = client === 'wolfhouse-somo' ? '/lesson' : '/stay';
  const expectedTexts = [
    'Lesson &lt;A&gt; &amp; &quot;B&quot; — €123.45' + lessonUnit + '/guest',
    'Lesson &lt;A&gt; &amp; &quot;B&quot; — €234.56' + lessonUnit,
    'Daily bike — €17.00/day/guest',
    'Flat transfer — €42.00/stay',
    'Stay guest — €32.00/stay/guest',
  ];
  services.forEach((service, index) => {
    const expected = '<option value="service:' + service.id + '">' + expectedTexts[index] + '</option>';
    check(client + ' unit/price/identity ' + index, () => assert.ok(options.includes(expected), expected));
    check(client + ' actual entry row option ' + index, () => assert.ok(row.includes(expected), expected));
  });
  check(client + ' catalog order and option count', () => {
    assert.deepEqual([...options.matchAll(/value="service:([^"]+)"/g)].map(m => m[1]), services.map(s => s.id));
  });
  check(client + ' no data or money mutation', () => assert.equal(JSON.stringify(ctx.bcServiceCatalog), before));
  check(client + ' built-in operational options preserved', () => {
    for (const value of ['wetsuit', 'soft_board', 'hard_board', 'surf_lesson', 'yoga', 'meals']) {
      assert.ok(row.includes('<option value="' + value + '">'));
    }
    assert.ok(row.includes('min="1" value="1"'));
  });
  check(client + ' escapes names without markup injection', () => {
    assert.ok(!options.includes('<A>')); assert.ok(options.includes('&lt;A&gt;'));
  });
  // Context is resolved per render, not cached or inferred from the service name.
  state.client = client === 'wolfhouse-somo' ? 'sunset' : 'wolfhouse-somo';
  check(client + ' current client used after switch', () => {
    const wanted = state.client === 'wolfhouse-somo' ? '/lesson/guest' : '/stay/guest';
    assert.ok(ctx.bcServiceCatalogOptionsHtml().includes('€123.45' + wanted));
  });
  for (const otherClient of ['sunset', 'wolfhouse', 'wolfhouse-somo-shadow']) {
    state.client = otherClient;
    check(client + ' no lesson-label activation for ' + otherClient, () => {
      assert.ok(ctx.bcServiceCatalogOptionsHtml().includes('€123.45/stay/guest'));
    });
  }
  state.client = ' wolfhouse-somo ';
  check(client + ' existing client whitespace normalization', () => {
    assert.ok(ctx.bcServiceCatalogOptionsHtml().includes('€123.45/lesson/guest'));
  });
  ctx.bcServiceCatalog = [];
  check(client + ' empty catalog remains empty', () => assert.equal(ctx.bcServiceCatalogOptionsHtml(), ''));
  ctx.bcServiceCatalog = [null, { name: 'no ID' }];
  check(client + ' invalid missing-ID entries remain skipped', () => assert.equal(ctx.bcServiceCatalogOptionsHtml(), ''));
}
console.log(`RESULT ${passed} passed; ${failed} failed (emitted renderer only; not live or persistence proof)`);
process.exitCode = failed ? 1 : 0;
