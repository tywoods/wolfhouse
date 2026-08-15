'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const settings = require('./lib/staff-email-settings-routes');

const LOCATION = 'sunset-somo';
const MS = '22222222-2222-4222-8222-222222222222';
const GOOGLE = '33333333-3333-4333-8333-333333333333';
const gmailRow = (patch = {}) => ({ id: GOOGLE, location_id: LOCATION, provider: 'gmail_api',
  auth_mode: 'delegated_authorization_code', connector_mode: 'google_delegated_oauth',
  binding_status: 'unverified_offline', public_address: 'desk@gmail.example', ...patch });
const env = { SUNSET_EMAIL_SETTINGS_UI_ENABLED: 'true', LUNA_DEPLOYMENT: 'sunset-staging',
  LUNA_EMAIL_OAUTH_START_ENABLED: 'true', LUNA_EMAIL_GOOGLE_OAUTH_START_ENABLED: 'true' };
const locs = [{ location_id: LOCATION, active: true }];

assert.equal(settings.isSunsetEmailGoogleOAuthStartEnabled({}), false);
assert.equal(settings.isSunsetEmailGoogleOAuthStartEnabled(env), true);
for (const bad of ['TRUE', '1', true]) assert.equal(settings.isSunsetEmailGoogleOAuthStartEnabled({ ...env, LUNA_EMAIL_GOOGLE_OAUTH_START_ENABLED: bad }), false);
assert.equal(settings.isEligibleUnverifiedDelegatedEndpoint(gmailRow()), true);
for (const patch of [{provider:'microsoft_graph'}, {auth_mode:null}, {connector_mode:'microsoft_delegated_oauth'},
  {binding_status:'verified'}, {public_address:'   '}]) assert.equal(settings.isEligibleGmailEndpoint(gmailRow(patch)), false);

const msDto = settings.endpointDto({ id: MS, location_id: LOCATION, provider: 'microsoft_graph',
  auth_mode: 'delegated_authorization_code', connector_mode: 'microsoft_delegated_oauth',
  binding_status: 'unverified_offline', public_address: 'desk@outlook.example' }, { grant_present: false });
const googleDto = settings.endpointDto(gmailRow(), { grant_present: false });
assert.equal(msDto.provider, 'microsoft_graph'); assert.equal(msDto.start_eligible, true);
assert.equal(googleDto.provider, 'gmail_api'); assert.equal(googleDto.start_eligible, true);
const both = settings.computeProviderEmailSettingsActions(env, locs, [msDto]);
assert.deepEqual(both.microsoft_graph, { prepare:false, connect:true, disconnect:false, reauthorize:false });
assert.deepEqual(both.gmail_api, { prepare:true, connect:false, disconnect:false, reauthorize:false });
assert.deepEqual(settings.computeEmailSettingsActions(env, locs, [msDto]), both.microsoft_graph);

const src = fs.readFileSync(require.resolve('./browser/sunset-admin-email-settings-ui.js'), 'utf8');
new vm.Script(src);
const calls = []; const assigned = [];
const sandbox = { URL, Object, Reflect, console, window:{location:{assign(v){assigned.push(v);}}}, fetch(path, opts){
  calls.push([path, opts.body]);
  if (path.endsWith('/endpoint')) return Promise.resolve({ok:true,json:async()=>({success:true,endpoint_id:GOOGLE})});
  if (path.endsWith('/microsoft/start')) return Promise.resolve({ok:true,json:async()=>({authorization_url:'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize'})});
  return Promise.resolve({ok:true,json:async()=>({authorizationUrl: validGoogleUrl(), expiresAt:'2026-08-12T14:00:00.000Z'})});
}};
vm.runInNewContext(src, sandbox);
function validGoogleUrl(mut) { const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  [['client_id','9876543210-web_client.v2.apps.googleusercontent.com'],['response_type','code'],
   ['redirect_uri','https://staff-staging.lunafrontdesk.com/staff/email/google/callback'],['response_mode','query'],
   ['scope','openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose'],
   ['state','a'.repeat(43)],['nonce','b'.repeat(43)],['code_challenge','c'.repeat(43)],
   ['code_challenge_method','S256'],['prompt','consent']].forEach(([k,v])=>u.searchParams.append(k,v));
  if (mut) mut(u); return u.toString(); }
assert.equal(sandbox.validateGoogleAuthorizationUrl(validGoogleUrl()), validGoogleUrl());
const reorderedGoogleUrl = validGoogleUrl(u=>{
  const entries=[...u.searchParams.entries()].reverse(); u.search='';
  entries.forEach(([k,v])=>u.searchParams.append(k,v));
});
assert.equal(sandbox.validateGoogleAuthorizationUrl(reorderedGoogleUrl), reorderedGoogleUrl);
for (const hostile of [validGoogleUrl(u=>u.searchParams.append('x','1')), validGoogleUrl(u=>u.searchParams.append('scope','openid')),
  validGoogleUrl(u=>u.hostname='accounts.google.com.evil.test'), validGoogleUrl(u=>u.searchParams.set('redirect_uri','https://evil.test/cb')),
  validGoogleUrl(u=>u.searchParams.set('client_id','not-google.example'))]) assert.equal(sandbox.validateGoogleAuthorizationUrl(hostile), null);
Promise.resolve().then(()=>sandbox.postGoogleEndpointPrepare(LOCATION,'desk@gmail.example'))
  .then(id=>sandbox.postGoogleOAuthStart(LOCATION,id)).then(()=>{
    assert.deepEqual(calls, [['/staff/admin/email-settings/oauth/google/endpoint', JSON.stringify({location_id:LOCATION,public_address:'desk@gmail.example'})],
      ['/staff/admin/email-settings/oauth/google/start', JSON.stringify({location_id:LOCATION,endpoint_id:GOOGLE})]]);
    assert.equal(assigned.length,1); assert.equal(assigned[0],validGoogleUrl());
    const body = {
      _html: '',
      querySelector() { return null; },
      querySelectorAll() { return []; },
    };
    Object.defineProperty(body, 'innerHTML', {
      get() { return body._html; },
      set(v) { body._html = String(v); },
    });
    sandbox.document = { getElementById(id) { return id === 'admin-email-settings-body' ? body : null; } };
    sandbox.el = (id) => (id === 'admin-email-settings-body' ? body : null);
    sandbox.escHtml = String;
    sandbox.portalT = (k) => k;
    assert.equal(typeof sandbox.renderAdminEmailSettingsData, 'function');
    sandbox.renderAdminEmailSettingsData({
      actions: { prepare: true, connect: false, disconnect: false, reauthorize: false },
      provider_actions: {
        microsoft_graph: { prepare: true, connect: false, disconnect: false, reauthorize: false },
        gmail_api: { prepare: true, connect: false, disconnect: false, reauthorize: false },
      },
      locations: [{ location_id: LOCATION, active: true }],
      endpoints: [googleDto],
    });
    const actual = body.innerHTML;
    assert.match(actual, />Connect Microsoft email<\/button>/);
    assert.match(actual, />Connect Google email<\/button>/);
    assert.match(actual, /data-email-provider="microsoft_graph"/);
    assert.match(actual, /data-email-provider="gmail_api"/);
    assert.match(actual, /data-email-provider="imap_smtp"/);
    assert.match(actual, /Coming soon|Próximamente/);
    assert.doesNotMatch(actual, /type="password"/);
    const gmailChunk = actual.slice(actual.indexOf('data-email-provider="gmail_api"'));
    const imapChunk = actual.slice(actual.indexOf('data-email-provider="imap_smtp"'));
    assert.match(gmailChunk.slice(0, 1600), /data-email-connect="prepare"/);
    assert.doesNotMatch(gmailChunk, /data-email-disconnect|data-email-reauthorize/);
    assert.doesNotMatch(imapChunk.slice(0, 800), /data-email-connect=/);
    assert.doesNotMatch(imapChunk, /<input/);
  }).then(()=>{
    assert.ok(!src.includes('console.log(dto.authorizationUrl)'));
    console.log('ok - provider-aware Sunset Gmail settings API/browser contract');
  }).catch(e=>{ console.error(e); process.exitCode=1; });
