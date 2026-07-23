#!/usr/bin/env node
'use strict';
/** verify:messi-saas-stage2b-tenant-runtime-config — MESSI SaaS Stage 2B public runtime gate. */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const BASE = 'ee7a37a459129186b3c506f27af4d43254e3cf73';
const FILES = [
  'scripts/lib/tenant-business-config.js',
  'scripts/lib/sunset-inbox-channel-config.js',
  'scripts/lib/tenant-admin-writes.js',
  'scripts/staff-query-api.js',
  // tenant-staging main.bicep owned by Stage 2A/2C1 IaC budgets after MOVE
  'scripts/verify-messi-saas-stage2b-tenant-runtime-config.js',
  'scripts/verify-messi-saas-stage2a-tenant-staging-iac.js',
  'package.json',
];
let pass = 0; let fail = 0;
const ok = (n, c, d) => {
  if (c) { pass += 1; console.log(`  PASS  ${n}`); }
  else { fail += 1; console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); }
};
const red = (n, c, d) => ok(`RED ${n}`, c, d);
const green = (n, c, d) => ok(`GREEN ${n}`, c, d);
const UUID = '00000000-0000-4000-8000-000000000001';

function diffStat() {
  const out = execFileSync('git', ['diff', '--ignore-cr-at-eol', '--numstat', BASE, '--', ...FILES], {
    cwd: ROOT, encoding: 'utf8',
  }).trim();
  let rawAdd = 0; let rawDel = 0; const perFile = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const [a, d, file] = line.split('\t');
    const add = a === '-' ? 0 : Number(a); const del = d === '-' ? 0 : Number(d);
    rawAdd += add; rawDel += del; perFile.push({ file, add, del });
  }
  for (const rel of FILES) {
    if (perFile.some((p) => p.file === rel)) continue;
    const abs = path.join(ROOT, rel); if (!fs.existsSync(abs)) continue;
    let baseLines = 0;
    try {
      baseLines = execFileSync('git', ['show', `${BASE}:${rel}`], { cwd: ROOT, encoding: 'utf8' })
        .split(/\r?\n/).length;
    } catch (_) { /* new */ }
    const cur = fs.readFileSync(abs, 'utf8').split(/\r?\n/).length;
    if (!baseLines) { rawAdd += cur; perFile.push({ file: rel, add: cur, del: 0 }); }
  }
  return { rawAdd, rawDel, net: rawAdd - rawDel, files: perFile.length, perFile };
}

const validSynth = () => ({
  version: 1, tenant_slug: 'synthdemo',
  permissions: {
    admin_db_read: false, admin_writes: false, stripe_links: false,
    staff_actions: false, whatsapp_dry_run: true,
  },
  locations: [
    { location_id: 'synthdemo-a', display_name: 'Synth A', channel_slot: 1 },
    { location_id: 'synthdemo-b', display_name: 'Synth B', channel_slot: 2 },
  ],
});
function synthEnv(extra) {
  const slot = (n, phone, pid, email) => ({
    [`TENANT_LOCATION_${n}_WHATSAPP_NUMBER`]: phone,
    [`TENANT_LOCATION_${n}_WHATSAPP_PHONE_NUMBER_ID`]: pid,
    [`TENANT_LOCATION_${n}_INBOX_EMAIL`]: email,
  });
  return {
    TENANT_RUNTIME_CONFIG_JSON: JSON.stringify(validSynth()),
    ...slot(1, '+10000000001', 'pid-a', 'a@example.invalid'),
    ...slot(2, '+10000000002', 'pid-b', 'b@example.invalid'),
    DEFAULT_CLIENT_SLUG: 'synthdemo', PATH: '/leak/path/bin',
    DATABASE_URL: 'postgres://leak:leak@db/leak',
    STRIPE_SECRET_KEY: ['sk', 'test', 'SHOULD_NOT_LEAK_IN_RESPONSE'].join('_'),
    STAFF_ACTIONS_ENABLED: 'true', STRIPE_LINKS_ENABLED: 'true', WHATSAPP_DRY_RUN: 'false',
    SUNSET_ADMIN_WRITES_ENABLED: 'true', SUNSET_ADMIN_DB_READ_ENABLED: 'true',
    ...(extra || {}),
  };
}

function httpRequest(port, method, urlPath, headers, bodyStr) {
  return new Promise((resolve, reject) => {
    const payload = bodyStr == null ? null : Buffer.from(String(bodyStr), 'utf8');
    const hdrs = { ...(headers || {}) };
    if (payload) hdrs['content-length'] = String(payload.length);
    const req = http.request({
      host: '127.0.0.1', port, method, path: urlPath, headers: hdrs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const bodyRaw = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = JSON.parse(bodyRaw); } catch (_) { body = null; }
        resolve({ status: res.statusCode, bodyRaw, body });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const MUTATION_CASES = [
  ['handoff', `/staff/handoff/${UUID}/resolve`, '{"confirm":true,"resolution":"x"}'],
  ['uuid_payment', `/staff/payments/${UUID}/create-stripe-link`],
  ['service_record_payment', `/staff/bookings/${UUID}/service-records/create-payment-link`],
  ['bot_stripe', `/staff/bot/payments/${UUID}/create-stripe-link`],
  ['addon_payment', '/staff/bookings/generate-payment-link', '{"client_slug":"synthdemo"}'],
  ['guest_payment', `/staff/bot/booking-guests/${UUID}/create-payment-link`],
  ['manual_booking', '/staff/manual-bookings/create'],
  ['inbox_send_reply', '/staff/inbox/send-reply'],
  ['bot_confirmation', '/staff/bot/bookings/send-confirmation'],
  ['bot_guest_reply', '/staff/bot/guest-reply-send'],
  ['admin_mutation', '/staff/admin/config/prices'],
  ['ordinary_staff_mutation', '/staff/bookings/cancel'],
].map(([name, path, body]) => ({ name, method: 'POST', path, body: body || '{}' }));

async function runStaffApiHttpProbes() {
  const prev = { ...process.env };
  for (const k of Object.keys(process.env)) {
    if (/^STAFF_|^LUNA_BOT_|^STRIPE_|^BOT_|^META_|^TENANT_|^SUNSET_|^WHATSAPP_|^DEFAULT_CLIENT|^PATH$|^DATABASE_URL$/.test(k)) {
      delete process.env[k];
    }
  }
  Object.assign(process.env, synthEnv(), {
    NODE_ENV: 'test', STAFF_API_FORTRESS_OFFLINE_LISTENER: '1', STAFF_RUNTIME_PROFILE: 'test',
    STAFF_AUTH_REQUIRED: 'true', STAFF_AUTH_HTTPS: 'false', STAFF_QUERY_API_HOST: '127.0.0.1',
    LUNA_BOT_INTERNAL_TOKEN: 'stage2b_bot_token_offline_test_01_xxxx', LUNA_BOT_CLIENT_SLUG: 'synthdemo',
    BOT_BOOKING_ENABLED: 'true', STRIPE_CHECKOUT_SUCCESS_URL: 'https://example.test/success',
    STRIPE_CHECKOUT_CANCEL_URL: 'https://example.test/cancel',
  });
  for (const key of Object.keys(require.cache)) {
    if (/staff-query-api\.js$|tenant-business-config\.js$|sunset-inbox-channel-config\.js$|tenant-admin-writes\.js$/.test(key)) {
      delete require.cache[key];
    }
  }
  let helperSideEffects = 0;
  const api = require('./staff-query-api');
  api.setFortress15j3OfflineSeams({
    withPgClient: async (fn) => {
      helperSideEffects += 1;
      return fn({
        query: async () => {
          helperSideEffects += 1;
          return { rows: [], rowCount: 0 };
        },
      });
    },
    canAccessClient: () => true,
    resolveSessionUser: () => ({
      staff_user_id: 'stage2b-staff-1', email: 'stage2b@example.test',
      role: 'admin', status: 'active', client_slug: 'synthdemo',
    }),
  });
  await new Promise((resolve, reject) => {
    api.server.once('error', reject);
    api.server.listen(0, '127.0.0.1', resolve);
  });
  const port = api.server.address().port;
  const cookie = `${api.COOKIE_NAME}=stage2b-session`;
  // Session auth on bot aliases (bot-token principal requires baseline slug registry).
  const get = (u) => httpRequest(port, 'GET', u, { cookie });
  try {
    const beforeMut = helperSideEffects;
    const mutations = {};
    for (const c of MUTATION_CASES) {
      const hdr = { cookie, 'content-type': 'application/json' };
      const before = helperSideEffects;
      mutations[c.name] = {
        ...(await httpRequest(port, c.method, c.path, hdr, c.body || '{}')),
        sideEffectsBefore: before,
        sideEffectsAfter: helperSideEffects,
      };
    }
    return {
      helperSideEffects,
      mutationSideEffectsDelta: helperSideEffects - beforeMut,
      mutations,
      inboxA: await get('/staff/conversations?client=synthdemo&location=synthdemo-a'),
      inboxB: await get('/staff/conversations?client=synthdemo&location=synthdemo-b'),
      admin: await get('/staff/admin/config?client=synthdemo'),
      sunsetInbox: await get('/staff/conversations?client=sunset&location=sunset-somo'),
    };
  } finally {
    await new Promise((resolve) => api.server.close(resolve));
    api.setFortress15j3OfflineSeams(null);
    Object.keys(process.env).forEach((k) => delete process.env[k]);
    Object.assign(process.env, prev);
  }
}

console.log('verify:messi-saas-stage2b-tenant-runtime-config — Stage 2B\n');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
red('package_script', pkg.scripts && pkg.scripts['verify:messi-saas-stage2b-tenant-runtime-config']
  === 'node scripts/verify-messi-saas-stage2b-tenant-runtime-config.js');
const tbc = require('./lib/tenant-business-config');
const inbox = require('./lib/sunset-inbox-channel-config');
const staffSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
red('runtime_api', typeof tbc.parseTenantRuntimeConfig === 'function'
  && typeof tbc.loadTenantRuntimeConfig === 'function'
  && typeof tbc.resolveTenantRuntimeChannel === 'function'
  && typeof tbc.effectiveTenantPermission === 'function'
  && typeof tbc.tenantLocationChannelEnvKeys === 'function'
  && typeof tbc.authorizeAuthenticatedStaffRoute === 'function'
  && tbc.TENANT_RUNTIME_CONFIG_ENV === 'TENANT_RUNTIME_CONFIG_JSON');
red('inbox_generic_resolve', typeof inbox.resolveTenantInboxChannelConfig === 'function');
red('central_authz_wired', /authorizeAuthenticatedStaffRoute/.test(staffSrc)
  && /enforceAuthenticatedStaffRouteAuthz/.test(staffSrc)
  && /function requireAuth[\s\S]{0,900}enforceAuthenticatedStaffRouteAuthz/.test(staffSrc)
  && /function requireBotAuth[\s\S]{0,2200}enforceAuthenticatedStaffRouteAuthz/.test(staffSrc)
  && /handleResolveHandoff[\s\S]{0,3500}enforceAuthenticatedStaffRouteAuthz/.test(staffSrc));

{
  green('generic_parse_ok', tbc.parseTenantRuntimeConfig(validSynth()).ok === true);
  const env = synthEnv();
  const loaded = tbc.loadTenantRuntimeConfig({ clientSlug: 'synthdemo', env });
  green('generic_load_identity', loaded.ok && loaded.config.tenant_slug === 'synthdemo'
    && loaded.config.locations.map((l) => l.location_id).join(',') === 'synthdemo-a,synthdemo-b');
  const p = loaded.config.permissions;
  green('disabled_defaults', p.admin_db_read === false && p.admin_writes === false
    && p.stripe_links === false && p.staff_actions === false && p.whatsapp_dry_run === true);
  const ch = tbc.resolveTenantRuntimeChannel(loaded.config, 'synthdemo-a', env);
  green('channel_slot_resolve', ch.ok && ch.whatsapp_number === '+10000000001'
    && ch.whatsapp_phone_number_id === 'pid-a'
    && !Object.prototype.hasOwnProperty.call(ch, 'refs')
    && !JSON.stringify(ch).includes('TENANT_LOCATION_'));
  const partial = { ...env }; delete partial.TENANT_LOCATION_1_WHATSAPP_PHONE_NUMBER_ID;
  green('channel_atomic_required', tbc.resolveTenantRuntimeChannel(loaded.config, 'synthdemo-a', partial)
    .reason === 'missing_channel_slot_config');
  const noEmail = { ...env }; delete noEmail.TENANT_LOCATION_1_INBOX_EMAIL;
  const chNoEmail = tbc.resolveTenantRuntimeChannel(loaded.config, 'synthdemo-a', noEmail);
  green('inbox_email_optional', chNoEmail.ok && chNoEmail.inbox_email === '');
  green('perm_and_fail_closed', tbc.effectiveTenantPermission('synthdemo', 'staff_actions', env) === false
    && tbc.effectiveTenantPermission('synthdemo', 'whatsapp_dry_run', env) === true
    && tbc.effectiveTenantPermission('other', 'staff_actions', { STAFF_ACTIONS_ENABLED: 'true' }) === false);
  green('central_deny_mutation', tbc.authorizeAuthenticatedStaffRoute({
    clientSlug: 'synthdemo', method: 'POST', pathname: '/staff/bookings/cancel', env,
  }).body.reason_code === 'staff_actions_disabled');
  green('central_deny_admin_read', tbc.authorizeAuthenticatedStaffRoute({
    clientSlug: 'synthdemo', method: 'GET', pathname: '/staff/admin/config', env,
  }).body.reason_code === 'admin_db_read_disabled');
  green('central_process_legacy', tbc.authorizeAuthenticatedStaffRoute({
    clientSlug: 'sunset', method: 'POST', pathname: '/staff/bookings/cancel', env,
  }).mode === 'process_level' && tbc.authorizeAuthenticatedStaffRoute({
    clientSlug: 'wolfhouse-somo', method: 'POST', pathname: '/staff/bookings/cancel',
    env: { STAFF_ACTIONS_ENABLED: 'true' },
  }).mode === 'process_level');
  green('central_unresolved_deny', tbc.authorizeAuthenticatedStaffRoute({
    clientSlug: '', method: 'POST', pathname: '/staff/bookings/cancel', env,
  }).body.reason_code === 'unresolved_tenant_scope');
}

{
  const mutate = (fn) => { const c = validSynth(); fn(c); return c; };
  const bad = [
    ['reject_env_ref', mutate((c) => { c.locations[0].channels = { whatsapp_number: { env: 'X' } }; delete c.locations[0].channel_slot; }), null],
    ['reject_secretRef', mutate((c) => { c.locations[0].channels = { whatsapp_number: { secretRef: 'x' } }; delete c.locations[0].channel_slot; }), null],
    ['reject_unknown_top', { ...validSynth(), extra: true }, 'unknown_top_level_key'],
    ['reject_unknown_perm', mutate((c) => { c.permissions.extra = false; }), 'unknown_permission_key'],
    ['reject_unknown_loc', mutate((c) => { c.locations[0].timezone = 'UTC'; }), 'unknown_location_key'],
    ['reject_string_version', { ...validSynth(), version: '1' }, 'malformed_config'],
    ['reject_missing_display_name', mutate((c) => { delete c.locations[0].display_name; }), 'malformed_config'],
    ['reject_reserved', { ...validSynth(), tenant_slug: 'wh' }, 'reserved_tenant_slug'],
    ['reject_cross_tenant_location', mutate((c) => { c.locations[0].location_id = 'sunset-somo'; }), 'cross_tenant_location'],
    ['reject_unbounded_slot', mutate((c) => { c.locations[0].channel_slot = 99; }), null],
  ];
  for (const [n, cfg, reason] of bad) {
    const r = tbc.parseTenantRuntimeConfig(cfg);
    red(n, reason ? r.reason === reason : r.ok === false);
  }
  const inheritedTop = Object.assign(Object.create({ evil: true }), validSynth());
  const inheritedPerms = validSynth(); inheritedPerms.permissions = Object.create(validSynth().permissions);
  const inheritedLoc = validSynth(); inheritedLoc.locations[0] = Object.create(validSynth().locations[0]);
  red('reject_inherited_schema', [inheritedTop, inheritedPerms, inheritedLoc]
    .every((cfg) => tbc.parseTenantRuntimeConfig(cfg).ok === false));
}

{
  const sunsetEnv = {
    SUNSET_SOMO_WHATSAPP_NUMBER: '+34000000001',
    SUNSET_SARDINERO_WHATSAPP_NUMBER: '+34000000002',
    SUNSET_SOMO_WHATSAPP_PHONE_NUMBER_ID: 'sunset-pid-somo',
    SUNSET_SARDINERO_WHATSAPP_PHONE_NUMBER_ID: 'sunset-pid-sardi',
    SUNSET_SOMO_INBOX_EMAIL: 'somo@example.invalid',
    SUNSET_SARDINERO_INBOX_EMAIL: 'sardi@example.invalid',
    SUNSET_ADMIN_WRITES_ENABLED: 'true', STAFF_ACTIONS_ENABLED: 'true',
  };
  green('legacy_and_inbox', tbc.loadTenantRuntimeConfig({ clientSlug: 'sunset', env: sunsetEnv }).source === 'legacy_sunset'
    && inbox.resolveSunsetInboxChannelConfig('sunset-somo', sunsetEnv).whatsapp_number === '+34000000001'
    && tbc.effectiveTenantPermission('wolfhouse-somo', 'staff_actions', { STAFF_ACTIONS_ENABLED: 'true' }) === true
    && inbox.resolveTenantInboxChannelConfig('synthdemo', 'synthdemo-a', synthEnv()).whatsapp_number === '+10000000001');
}

{
  const mod = fs.readFileSync(path.join(ROOT, 'infra/azure/modules/tenant-staging/main.bicep'), 'utf8');
  const fix = JSON.parse(fs.readFileSync(path.join(ROOT, 'infra/azure/modules/tenant-staging/parameters.synthetic.json'), 'utf8'));
  const fv = (k) => fix.parameters[k] && fix.parameters[k].value;
  green('bicep_generic_only', /genericRuntimeEnv/.test(mod) && /TENANT_LOCATION_1_WHATSAPP_NUMBER/.test(mod)
    && /channel_slot:\s*1/.test(mod) && /enableGenericRuntimeEnv\s*=\s*!isLockedLiveSunset/.test(mod)
    && !/channels:\s*\{[\s\S]*env:/.test(mod)
    && fv('enableSunsetRuntimeEnv') === false && fv('staffActionsEnabled') === 'false'
    && fv('stripeLinksEnabled') === 'false' && fv('whatsappDryRun') === 'true');
}

(async () => {
  const probe = await runStaffApiHttpProbes();
  const leakRe = new RegExp(['PATH', 'DATABASE_URL', 'STRIPE_SECRET_KEY',
    ['sk', 'test', 'SHOULD_NOT_LEAK'].join('_'), '/leak/path'].join('|'));
  const { inboxA: a, inboxB: b, admin, sunsetInbox: sun, mutations } = probe;
  green('http_generic_channels', a.status === 200 && a.body && a.body.channel_config
    && a.body.channel_config.whatsapp_number === '+10000000001' && a.body.location_id === 'synthdemo-a'
    && b.status === 200 && b.body && b.body.channel_config
    && b.body.channel_config.whatsapp_number === '+10000000002' && !leakRe.test(a.bodyRaw + b.bodyRaw));
  green('http_admin_denied', admin.status === 403 && admin.body
    && (admin.body.reason_code === 'admin_db_read_disabled' || admin.body.error));
  let denyBeforeHelpers = true;
  for (const c of MUTATION_CASES) {
    const r = mutations[c.name];
    const denied = r.status === 403 && r.body && (
      /staff_actions_disabled|stripe_links_disabled|whatsapp_dry_run_enforced|admin_writes_disabled|admin_db_read_disabled/.test(String(r.body.reason_code || ''))
      || r.body.staff_actions_enabled === false
      || /disabled|forbidden|tenant_route/i.test(String(r.body.error || ''))
    );
    if (r.sideEffectsAfter !== r.sideEffectsBefore) denyBeforeHelpers = false;
    green(`http_deny_${c.name}`, denied, `status=${r.status}`);
  }
  green('http_deny_before_helper_side_effects', denyBeforeHelpers
    && probe.mutationSideEffectsDelta === 0, `delta=${probe.mutationSideEffectsDelta}`);
  green('http_no_secret_or_sunset_break', [a, b, admin, sun, ...Object.values(mutations)]
    .every((r) => !leakRe.test(r.bodyRaw || '')) && [200, 401, 403, 500].includes(sun.status));

  const st = diffStat();
  console.log('\n── budget ──');
  console.log(JSON.stringify({
    files: st.files, rawAdd: st.rawAdd, rawDel: st.rawDel, net: st.net, perFile: st.perFile,
  }, null, 2));
  ok('budget_files', st.files <= 8, `files=${st.files}`);
  ok('budget_net', st.net <= 875, `net=${st.net}`);
  try {
    execFileSync('git', ['-c', 'core.whitespace=trailing-space,space-before-tab,cr-at-eol',
      'diff', '--check', BASE, '--', ...FILES], { cwd: ROOT, stdio: 'pipe' });
    ok('diff_check_clean', true);
  } catch (err) {
    ok('diff_check_clean', false, (err.stdout || err.stderr || err.message || '').toString().slice(0, 400));
  }
  console.log(`\nRESULT: ${fail === 0 ? 'PASS' : 'FAIL'}  pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
