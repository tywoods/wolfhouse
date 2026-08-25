'use strict';
/** FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 1: draft-only provider capability/authority contract. */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  ERROR_CODE,
  ERROR_MESSAGE,
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_WIRED,
  EMAIL_LUNA_CONTROLLED_DRAFTING_ACTIVATION,
  EMAIL_LUNA_CONTROLLED_DRAFTING_LOGGING_FORBIDDEN,
  EMAIL_LUNA_CONTROLLED_DRAFTING_PROVIDER,
  EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_KEY,
  EMAIL_LUNA_CONTROLLED_DRAFTING_SCOPE_VERSION,
  EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATIONS,
  EMAIL_LUNA_CONTROLLED_DRAFTING_GRAPH_CALL_OPERATIONS,
  EMAIL_LUNA_CONTROLLED_DRAFTING_TRANSPORT_KEYS,
  EMAIL_LUNA_CONTROLLED_DRAFTING_AUTHORITY_KEYS,
  EMAIL_LUNA_CONTROLLED_DRAFTING_CREATE_REQUEST_KEYS,
  EMAIL_LUNA_CONTROLLED_DRAFTING_CREATE_RESPONSE_KEYS,
  EMAIL_LUNA_CONTROLLED_DRAFTING_RECONCILE_REQUEST_KEYS,
  EMAIL_LUNA_CONTROLLED_DRAFTING_RECONCILE_RESPONSE_KEYS,
  RECONCILE_OUTCOMES,
  EMAIL_LUNA_CONTROLLED_DRAFTING_CAPABILITY_MANIFEST,
  EMAIL_MS_CONTROLLED_DRAFTING_SCOPE_PROFILE,
  EMAIL_MS_CONTROLLED_DRAFTING_PROVIDER_FACTS,
  createEmailLunaControlledDraftingProvider,
  createEmailLunaControlledDraftingFakeTransport,
  createEmailLunaControlledDraftingGraphDraftTransport,
  pickEmailLunaControlledDraftingTransportMethods,
  resolveControlledDraftingGraphCall,
  buildControlledDraftingGetPath,
  validateControlledDraftingScopeProfile,
  validateControlledDraftingTokenResponseScope,
  attestEmailLunaControlledDraftingCapabilities,
  EMAIL_LUNA_CONTROLLED_DRAFTING_GET_SELECT,
  readControlledDraftingKnownCreateDraftId,
} = require('./lib/email-luna-controlled-drafting-provider-contract');
const contractModule = require('./lib/email-luna-controlled-drafting-provider-contract');
const {
  EMAIL_MS_DELEGATED_PHASE_B_V1_GRAPH_DELEGATED_SCOPES,
  EMAIL_MS_DELEGATED_PHASE_B_SCOPE_VERSION,
  EMAIL_MS_DELEGATED_PHASE_A_GRAPH_DELEGATED_SCOPES,
  validateMicrosoftDelegatedScopePlan,
} = require('./lib/email-microsoft-delegated-oauth-contract');
const {
  createEmailLunaControlledDraftingFakeClosedTokenLoan,
} = require('./lib/email-luna-controlled-drafting-token-loan');
const {
  HOST,
  buildCreateReplyPath,
  buildMessagePath,
  buildSendMailPath,
  REPLY_DRAFT_METHOD_KEYS,
  createMicrosoftGraphReplyDraftTransport,
} = require('./lib/email-microsoft-graph-reply-draft-transport');
const {
  mapGraphDraftObservation,
} = require('./lib/email-luna-controlled-drafting-graph-draft-transport');

const ROOT = path.join(__dirname, '..');
const LIB_ABS = path.join(ROOT, 'scripts/lib/email-luna-controlled-drafting-provider-contract.js');
const LIB_SRC = fs.readFileSync(LIB_ABS, 'utf8');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const STAFF_API_SRC = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const COMPOSE_SRC = fs.readFileSync(path.join(ROOT, 'docker/hermes-staging/docker-compose.vm.yml'), 'utf8');
const DOC_ABS = path.join(ROOT, 'docs/EMAIL-LUNA-CONTROLLED-DRAFTING-PROVIDER-CONTRACT.md');
const DOC_SRC = fs.readFileSync(DOC_ABS, 'utf8');
const TOKEN = 'atok-NEVER_LEAK-stage2-ch1-token';
const PLANTED = 'NEVER_LEAK_body_or_address';
const C = '11111111-1111-4111-8111-111111111111';
const L = '22222222-2222-4222-8222-222222222222';
const E = '44444444-4444-4444-8444-444444444444';
const MAILBOX = '22222222-2222-4222-8222-2222222222ab';
const OTHER_TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_LOCATION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_ENDPOINT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_MAILBOX = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ISSUANCE = '55555555-5555-4555-8555-555555555555';
const OPERATION = '66666666-6666-4666-8666-666666666666';
const SOURCE_MSG = 'AAMkAGI2-SRC';
const THREAD = 'AAQkAGI2-THREAD';
const RECIPIENT = 'elena@example.test';
const SUBJECT = 'Lesson availability tomorrow';
const BODY = 'Yes, the morning lesson still has space.';
const SUBJECT_DIGEST = crypto.createHash('sha256').update(SUBJECT, 'utf8').digest('hex');
const BODY_DIGEST = crypto.createHash('sha256').update(BODY, 'utf8').digest('hex');

const EXPECTED_EXPORTS = Object.freeze([
  'ERROR_CODE',
  'ERROR_MESSAGE',
  'EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_WIRED',
  'EMAIL_LUNA_CONTROLLED_DRAFTING_ACTIVATION',
  'EMAIL_LUNA_CONTROLLED_DRAFTING_LOGGING_FORBIDDEN',
  'EMAIL_LUNA_CONTROLLED_DRAFTING_PROVIDER',
  'EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_KEY',
  'EMAIL_LUNA_CONTROLLED_DRAFTING_SCOPE_VERSION',
  'EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATIONS',
  'EMAIL_LUNA_CONTROLLED_DRAFTING_GRAPH_CALL_OPERATIONS',
  'EMAIL_LUNA_CONTROLLED_DRAFTING_TRANSPORT_KEYS',
  'EMAIL_LUNA_CONTROLLED_DRAFTING_AUTHORITY_KEYS',
  'EMAIL_LUNA_CONTROLLED_DRAFTING_CREATE_REQUEST_KEYS',
  'EMAIL_LUNA_CONTROLLED_DRAFTING_CREATE_RESPONSE_KEYS',
  'EMAIL_LUNA_CONTROLLED_DRAFTING_RECONCILE_REQUEST_KEYS',
  'EMAIL_LUNA_CONTROLLED_DRAFTING_RECONCILE_RESPONSE_KEYS',
  'EMAIL_LUNA_CONTROLLED_DRAFTING_GET_SELECT',
  'RECONCILE_OUTCOMES',
  'EMAIL_LUNA_CONTROLLED_DRAFTING_CAPABILITY_MANIFEST',
  'EMAIL_MS_CONTROLLED_DRAFTING_SCOPE_PROFILE',
  'EMAIL_MS_CONTROLLED_DRAFTING_PROVIDER_FACTS',
  'createEmailLunaControlledDraftingProvider',
  'createEmailLunaControlledDraftingFakeTransport',
  'createEmailLunaControlledDraftingGraphDraftTransport',
  'pickEmailLunaControlledDraftingTransportMethods',
  'resolveControlledDraftingGraphCall',
  'buildControlledDraftingGetPath',
  'validateControlledDraftingScopeProfile',
  'validateControlledDraftingTokenResponseScope',
  'attestEmailLunaControlledDraftingCapabilities',
  'readControlledDraftingKnownCreateDraftId',
]);

function digest(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}
function authority(patch = {}) {
  return {
    client_id: C,
    location_id: L,
    location_key: 'sunset-somo',
    endpoint_id: E,
    provider: 'microsoft_graph',
    mailbox_id: MAILBOX,
    ...patch,
  };
}
function createRequest(patch = {}) {
  return {
    client_id: C,
    location_id: L,
    location_key: 'sunset-somo',
    endpoint_id: E,
    provider: 'microsoft_graph',
    mailbox_id: MAILBOX,
    inbound_provider_message_id: SOURCE_MSG,
    inbound_provider_thread_id: THREAD,
    recipient_address: RECIPIENT,
    subject: SUBJECT,
    body_text: BODY,
    subject_digest: SUBJECT_DIGEST,
    body_digest: BODY_DIGEST,
    issuance_id: ISSUANCE,
    operation_id: OPERATION,
    ...patch,
  };
}
function reconcileRequest(draftId, patch = {}) {
  return {
    client_id: C,
    location_id: L,
    location_key: 'sunset-somo',
    endpoint_id: E,
    provider: 'microsoft_graph',
    mailbox_id: MAILBOX,
    inbound_provider_message_id: SOURCE_MSG,
    inbound_provider_thread_id: THREAD,
    recipient_address: RECIPIENT,
    subject_digest: SUBJECT_DIGEST,
    body_digest: BODY_DIGEST,
    issuance_id: ISSUANCE,
    operation_id: OPERATION,
    provider_draft_id: draftId,
    ...patch,
  };
}
function makeProvider(fake = createEmailLunaControlledDraftingFakeTransport(), auth = authority()) {
  return {
    fake,
    provider: createEmailLunaControlledDraftingProvider({
      authority: auth,
      transport: pickEmailLunaControlledDraftingTransportMethods({
        createReplyDraft: fake.createReplyDraft,
        reconcileDraft: fake.reconcileDraft,
      }),
    }),
  };
}
function noLeak(value) {
  let text;
  try { text = typeof value === 'string' ? value : JSON.stringify(value); }
  catch { text = String(value); }
  return !text.includes(TOKEN) && !text.includes(PLANTED) && !text.includes('access_token')
    && !text.includes('Bearer');
}
function expectInvalid(fn) {
  let caught;
  try { fn(); }
  catch (error) { caught = error; }
  assert.ok(caught, 'expected fail-closed throw');
  assert.equal(caught.code, ERROR_CODE);
  assert.equal(caught.message, ERROR_MESSAGE);
  assert.equal(Object.isFrozen(caught), true);
  assert.equal(noLeak(caught), true);
  assert.equal(noLeak(caught.message), true);
  return caught;
}
async function expectInvalidAsync(fn) {
  let caught;
  try { await fn(); }
  catch (error) { caught = error; }
  assert.ok(caught, 'expected fail-closed throw');
  assert.equal(caught.code, ERROR_CODE);
  assert.equal(caught.message, ERROR_MESSAGE);
  assert.equal(Object.isFrozen(caught), true);
  assert.equal(noLeak(caught), true);
  return caught;
}

async function main() {
  console.log('FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 1 provider contract verifier');

  assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_WIRED, false);
  assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_ACTIVATION, false);
  assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_LOGGING_FORBIDDEN, true);
  assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_PROVIDER, 'microsoft_graph');
  assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_KEY, 'sunset-somo');
  assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_SCOPE_VERSION, 'controlled_drafting_v1');
  assert.deepEqual([...EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATIONS], ['create_reply_draft', 'reconcile_draft']);
  assert.deepEqual([...EMAIL_LUNA_CONTROLLED_DRAFTING_TRANSPORT_KEYS], ['createReplyDraft', 'reconcileDraft']);
  assert.equal(ERROR_CODE, 'EMAIL_LUNA_CONTROLLED_DRAFTING_PROVIDER_INVALID');
  console.log('  PASS  runtime remains unwired; operations are draft-create + reconcile only');

  assert.deepEqual(Object.keys(contractModule).sort(), [...EXPECTED_EXPORTS].sort());
  assert.equal(Object.isFrozen(contractModule), true);
  for (const key of [
    'send', 'sendDraft', 'sendMail', 'request', 'https', 'http', 'client',
    'createMicrosoftGraphReplyDraftTransport', 'issueGraphRequest', 'accessToken',
  ]) {
    assert.equal(Object.hasOwn(contractModule, key), false, `export must not include ${key}`);
    assert.equal(contractModule[key], undefined, `export value must not expose ${key}`);
  }
  console.log('  PASS  package export surface is closed and has no send or generic escape hatch');

  const { fake, provider } = makeProvider();
  assert.deepEqual(Object.keys(provider).sort(), ['attest', 'createReplyDraft', 'reconcileDraft']);
  assert.equal(Object.isFrozen(provider), true);
  for (const key of [
    'send', 'sendDraft', 'sendMail', 'scheduleSend', 'forward', 'createForward',
    'reply', 'replyAll', 'request', 'https', 'client', 'accessToken', 'getCalls',
  ]) {
    assert.equal(Object.hasOwn(provider, key), false, `provider must not include ${key}`);
    assert.equal(typeof provider[key], 'undefined');
  }
  assert.equal(typeof provider.createReplyDraft, 'function');
  assert.equal(typeof provider.reconcileDraft, 'function');
  assert.equal(typeof provider.attest, 'function');
  console.log('  PASS  runtime-facing provider instance exposes attest + two draft operations only');

  const manifest = attestEmailLunaControlledDraftingCapabilities();
  assert.equal(manifest, EMAIL_LUNA_CONTROLLED_DRAFTING_CAPABILITY_MANIFEST);
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(Object.isFrozen(manifest.capabilities), true);
  assert.deepEqual(Object.keys(manifest.capabilities).sort(), [
    'access_token_export', 'arbitrary_message_mutation', 'create_reply_draft', 'forward_send',
    'generic_http', 'raw_sdk', 'reconcile_draft', 'reply_send', 'schedule_send', 'send',
    'send_draft', 'send_mail',
  ].sort());
  assert.equal(manifest.capabilities.create_reply_draft, true);
  assert.equal(manifest.capabilities.reconcile_draft, true);
  assert.equal(manifest.capabilities.send, false);
  assert.equal(manifest.capabilities.send_draft, false);
  assert.equal(manifest.capabilities.send_mail, false);
  assert.equal(manifest.capabilities.schedule_send, false);
  assert.equal(manifest.capabilities.forward_send, false);
  assert.equal(manifest.capabilities.reply_send, false);
  assert.equal(manifest.capabilities.generic_http, false);
  assert.equal(manifest.capabilities.raw_sdk, false);
  assert.equal(manifest.capabilities.access_token_export, false);
  assert.equal(manifest.runtime_wired, false);
  assert.equal(manifest.activation, false);
  assert.equal(manifest.consent, false);
  assert.equal(manifest.auto_send_flag_is_not_authority, true);
  const attestation = provider.attest();
  assert.equal(attestation.capabilities.send, false);
  assert.deepEqual(attestation.authority, authority());
  assert.equal(attestation.scope_profile_id, 'controlled_drafting_v1');
  expectInvalid(() => provider.attest({ send: true }));
  console.log('  PASS  capability manifest is closed/enumerable and send capability is absent');

  assert.equal(EMAIL_MS_DELEGATED_PHASE_B_SCOPE_VERSION, 'phase_b_v1');
  assert.deepEqual([...EMAIL_MS_DELEGATED_PHASE_B_V1_GRAPH_DELEGATED_SCOPES], [
    'User.Read', 'Mail.ReadWrite', 'Mail.Send',
  ]);
  assert.deepEqual([...EMAIL_MS_DELEGATED_PHASE_A_GRAPH_DELEGATED_SCOPES], [
    'User.Read', 'Mail.ReadWrite', 'Mail.Send',
  ]);
  assert.equal(validateMicrosoftDelegatedScopePlan({
    phase: 'B',
    oidc: ['openid', 'profile', 'offline_access'],
    graph_delegated: ['User.Read', 'Mail.ReadWrite', 'Mail.Send'],
    include_email_scope: false,
  }).ok, true);
  assert.equal(validateMicrosoftDelegatedScopePlan({
    phase: 'B',
    oidc: ['openid', 'profile', 'offline_access'],
    graph_delegated: ['User.Read', 'Mail.ReadWrite'],
    include_email_scope: false,
  }).ok, false);
  assert.equal(EMAIL_MS_CONTROLLED_DRAFTING_SCOPE_PROFILE.mutates_phase_b, false);
  assert.equal(EMAIL_MS_CONTROLLED_DRAFTING_SCOPE_PROFILE.consent_activation, false);
  assert.deepEqual([...EMAIL_MS_CONTROLLED_DRAFTING_SCOPE_PROFILE.graph_delegated], [
    'User.Read', 'Mail.ReadWrite',
  ]);
  assert.equal(EMAIL_MS_CONTROLLED_DRAFTING_SCOPE_PROFILE.graph_delegated.includes('Mail.Send'), false);
  assert.equal(EMAIL_MS_CONTROLLED_DRAFTING_PROVIDER_FACTS.mail_readwrite_does_not_include_send, true);
  assert.equal(EMAIL_MS_CONTROLLED_DRAFTING_PROVIDER_FACTS.mail_send_required_to_send, true);
  assert.deepEqual(validateControlledDraftingScopeProfile({
    oidc: ['openid', 'profile', 'offline_access'],
    graph_delegated: ['User.Read', 'Mail.ReadWrite'],
    include_email_scope: false,
  }).graph_delegated, ['User.Read', 'Mail.ReadWrite']);
  expectInvalid(() => validateControlledDraftingScopeProfile({
    oidc: ['openid', 'profile', 'offline_access'],
    graph_delegated: ['User.Read', 'Mail.ReadWrite', 'Mail.Send'],
    include_email_scope: false,
  }));
  assert.equal(
    validateControlledDraftingTokenResponseScope('openid profile offline_access User.Read Mail.ReadWrite'),
    'openid profile offline_access User.Read Mail.ReadWrite',
  );
  expectInvalid(() => validateControlledDraftingTokenResponseScope(
    'openid profile offline_access User.Read Mail.ReadWrite Mail.Send',
  ));
  expectInvalid(() => validateControlledDraftingTokenResponseScope('User.Read Mail.Send'));
  console.log('  PASS  controlled-drafting scope omits Mail.Send; live Phase B contract is untouched');

  const created = await provider.createReplyDraft(createRequest());
  assert.equal(created.outcome, 'draft_created');
  assert.equal(created.provider, 'microsoft_graph');
  assert.equal(created.client_id, C);
  assert.equal(created.location_id, L);
  assert.equal(created.location_key, 'sunset-somo');
  assert.equal(created.endpoint_id, E);
  assert.equal(created.mailbox_id, MAILBOX);
  assert.equal(created.inbound_provider_message_id, SOURCE_MSG);
  assert.equal(created.inbound_provider_thread_id, THREAD);
  assert.equal(created.recipient_address, RECIPIENT);
  assert.equal(created.subject_digest, SUBJECT_DIGEST);
  assert.equal(created.body_digest, BODY_DIGEST);
  assert.equal(created.issuance_id, ISSUANCE);
  assert.equal(created.operation_id, OPERATION);
  assert.equal(typeof created.provider_draft_id, 'string');
  assert.deepEqual(Object.keys(created).sort(), [...EMAIL_LUNA_CONTROLLED_DRAFTING_CREATE_RESPONSE_KEYS].sort());
  assert.equal(Object.hasOwn(created, 'subject'), false);
  assert.equal(Object.hasOwn(created, 'body_text'), false);
  assert.equal(Object.hasOwn(created, 'accessToken'), false);
  assert.equal(noLeak(created), true);

  const present = await provider.reconcileDraft(reconcileRequest(created.provider_draft_id));
  assert.equal(present.outcome, 'draft_present');
  assert.equal(present.is_draft, true);
  assert.equal(present.provider_draft_id, created.provider_draft_id);
  assert.deepEqual(Object.keys(present).sort(), [...EMAIL_LUNA_CONTROLLED_DRAFTING_RECONCILE_RESPONSE_KEYS].sort());
  const calls = fake.getCalls();
  assert.equal(calls.filter((row) => row.operation === 'create_reply_draft').length, 1);
  assert.equal(calls.filter((row) => row.operation === 'patch_reply_draft').length, 1);
  assert.ok(calls.filter((row) => row.operation === 'reconcile_draft').length >= 1);
  assert.equal(Object.hasOwn(calls[0], 'subject'), false);
  assert.equal(Object.hasOwn(calls[0], 'body_text'), false);
  console.log('  PASS  fake transport allows create_reply_draft then reconcile_draft with bound identities');

  const createCall = resolveControlledDraftingGraphCall({
    operation: 'create_reply_draft',
    mailbox_id: MAILBOX,
    inbound_provider_message_id: SOURCE_MSG,
  });
  const patchCall = resolveControlledDraftingGraphCall({
    operation: 'patch_reply_draft',
    mailbox_id: MAILBOX,
    provider_draft_id: created.provider_draft_id,
  });
  const getCall = resolveControlledDraftingGraphCall({
    operation: 'reconcile_draft',
    mailbox_id: MAILBOX,
    provider_draft_id: created.provider_draft_id,
  });
  assert.equal(createCall.host, HOST);
  assert.equal(createCall.method, 'POST');
  assert.equal(createCall.path, buildCreateReplyPath(MAILBOX, SOURCE_MSG));
  assert.equal(createCall.path.endsWith('/createReply'), true);
  assert.equal(createCall.path.includes('/me/'), false);
  assert.equal(patchCall.method, 'PATCH');
  assert.equal(patchCall.path, buildMessagePath(MAILBOX, created.provider_draft_id, 'patch'));
  assert.equal(getCall.method, 'GET');
  assert.equal(getCall.path, buildControlledDraftingGetPath(MAILBOX, created.provider_draft_id));
  assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_GET_SELECT, 'id,isDraft,subject,body,toRecipients,conversationId');
  assert.equal(getCall.path.includes(`$select=${EMAIL_LUNA_CONTROLLED_DRAFTING_GET_SELECT}`), true);
  assert.equal(getCall.path.includes('$select=id,isDraft&') || getCall.path.endsWith('$select=id,isDraft'), false);
  const sendPath = buildMessagePath(MAILBOX, created.provider_draft_id, 'send');
  const sendMailPath = buildSendMailPath(MAILBOX);
  const allowedPaths = [createCall.path, patchCall.path, getCall.path];
  assert.equal(allowedPaths.includes(sendPath), false);
  assert.equal(allowedPaths.includes(sendMailPath), false);
  assert.equal(sendPath.endsWith('/send'), true);
  assert.equal(sendMailPath.endsWith('/sendMail'), true);
  for (const operation of [
    'send', 'send_draft', 'sendDraft', 'send_mail', 'sendMail', 'schedule_send',
    'forward', 'forward_send', 'reply_send', 'createReplyAll', 'arbitrary',
  ]) {
    expectInvalid(() => resolveControlledDraftingGraphCall({
      operation,
      mailbox_id: MAILBOX,
      inbound_provider_message_id: SOURCE_MSG,
    }));
  }
  expectInvalid(() => resolveControlledDraftingGraphCall({
    operation: 'create_reply_draft',
    mailbox_id: MAILBOX,
    inbound_provider_message_id: SOURCE_MSG,
    path: '/v1.0/users/evil/sendMail',
  }));
  expectInvalid(() => resolveControlledDraftingGraphCall({
    operation: 'create_reply_draft',
    mailbox_id: MAILBOX,
    inbound_provider_message_id: SOURCE_MSG,
    method: 'DELETE',
  }));
  console.log('  PASS  Graph mapping reuses createReply/PATCH/GET draft paths and refuses send/sendMail/arbitrary');

  assert.deepEqual([...REPLY_DRAFT_METHOD_KEYS], [
    'createReply', 'updateApprovedDraft', 'sendDraft', 'reconcileDraft',
  ]);
  const legacy = createMicrosoftGraphReplyDraftTransport();
  assert.equal(typeof legacy.sendDraft, 'function');
  assert.equal(typeof legacy.sendMail, 'function');
  console.log('  PASS  existing Gate 3 reply-draft transport still owns send; Stage 2 does not reuse it as surface');

  expectInvalid(() => pickEmailLunaControlledDraftingTransportMethods({
    createReplyDraft: fake.createReplyDraft,
    reconcileDraft: fake.reconcileDraft,
    sendDraft: () => {},
  }));
  expectInvalid(() => pickEmailLunaControlledDraftingTransportMethods({
    createReplyDraft: fake.createReplyDraft,
    reconcileDraft: fake.reconcileDraft,
    sendMail: () => {},
  }));
  expectInvalid(() => pickEmailLunaControlledDraftingTransportMethods({
    createReplyDraft: fake.createReplyDraft,
    reconcileDraft: fake.reconcileDraft,
    request: async () => ({ status: 200 }),
  }));
  expectInvalid(() => pickEmailLunaControlledDraftingTransportMethods({
    request: async () => ({ status: 200 }),
  }));
  expectInvalid(() => pickEmailLunaControlledDraftingTransportMethods({
    createReplyDraft: fake.createReplyDraft,
    reconcileDraft: fake.reconcileDraft,
    accessToken: TOKEN,
  }));
  expectInvalid(() => createEmailLunaControlledDraftingProvider({
    authority: authority(),
    transport: fake,
  }));
  expectInvalid(() => createEmailLunaControlledDraftingProvider({
    authority: authority(),
    transport: pickEmailLunaControlledDraftingTransportMethods({
      createReplyDraft: fake.createReplyDraft,
      reconcileDraft: fake.reconcileDraft,
    }),
    httpsImpl: () => {},
  }));
  console.log('  PASS  send-like methods, generic HTTP request, raw credentials, and extra factory deps fail closed');

  await expectInvalidAsync(() => provider.createReplyDraft(createRequest({ client_id: OTHER_TENANT })));
  await expectInvalidAsync(() => provider.createReplyDraft(createRequest({ location_id: OTHER_LOCATION })));
  await expectInvalidAsync(() => provider.createReplyDraft(createRequest({ location_key: 'sunset-sardinero' })));
  await expectInvalidAsync(() => provider.createReplyDraft(createRequest({ endpoint_id: OTHER_ENDPOINT })));
  await expectInvalidAsync(() => provider.createReplyDraft(createRequest({ provider: 'gmail_api' })));
  await expectInvalidAsync(() => provider.createReplyDraft(createRequest({ mailbox_id: OTHER_MAILBOX })));
  await expectInvalidAsync(() => provider.createReplyDraft(createRequest({
    inbound_provider_message_id: 'bad/id?x',
  })));
  await expectInvalidAsync(() => provider.createReplyDraft(createRequest({
    inbound_provider_thread_id: 'has space',
  })));
  await expectInvalidAsync(() => provider.createReplyDraft(createRequest({
    recipient_address: 'Elena@Example.TEST',
  })));
  await expectInvalidAsync(() => provider.createReplyDraft(createRequest({
    recipient_address: 'not-an-email',
  })));
  await expectInvalidAsync(() => provider.createReplyDraft(createRequest({
    body_digest: digest('tampered body'),
  })));
  await expectInvalidAsync(() => provider.createReplyDraft(createRequest({
    subject: SUBJECT,
    subject_digest: digest('different subject'),
  })));
  await expectInvalidAsync(() => provider.createReplyDraft(createRequest({ extra: 1 })));
  await expectInvalidAsync(() => provider.createReplyDraft(createRequest({ accessToken: TOKEN })));
  await expectInvalidAsync(() => provider.createReplyDraft(createRequest({
    path: '/v1.0/users/x/sendMail',
  })));
  const wrongRecipient = await provider.reconcileDraft(reconcileRequest(created.provider_draft_id, {
    recipient_address: 'other@example.test',
  }));
  assert.equal(wrongRecipient.outcome, 'draft_mismatch');
  const wrongThread = await provider.reconcileDraft(reconcileRequest(created.provider_draft_id, {
    inbound_provider_thread_id: 'AAQk-OTHER-THREAD',
  }));
  assert.equal(wrongThread.outcome, 'draft_mismatch');
  await expectInvalidAsync(() => provider.reconcileDraft(reconcileRequest(created.provider_draft_id, {
    mailbox_id: OTHER_MAILBOX,
  })));
  const wrongDigest = await provider.reconcileDraft(reconcileRequest(created.provider_draft_id, {
    body_digest: digest('nope'),
  }));
  assert.equal(wrongDigest.outcome, 'draft_modified');
  await expectInvalidAsync(() => provider.reconcileDraft(reconcileRequest('AAMkAGI2-MISSING')));
  console.log('  PASS  wrong tenant/location/provider/mailbox/recipient/thread/digest and extras fail closed');

  assert.deepEqual([...RECONCILE_OUTCOMES], [
    'draft_present', 'draft_modified', 'draft_not_found', 'draft_mismatch',
  ]);
  const classifying = createEmailLunaControlledDraftingFakeTransport({ classify: true });
  const classifyingProvider = createEmailLunaControlledDraftingProvider({
    authority: authority(),
    transport: pickEmailLunaControlledDraftingTransportMethods({
      createReplyDraft: classifying.createReplyDraft,
      reconcileDraft: classifying.reconcileDraft,
    }),
  });
  const classifiedCreated = await classifyingProvider.createReplyDraft(createRequest());
  const classifiedExact = await classifyingProvider.reconcileDraft(
    reconcileRequest(classifiedCreated.provider_draft_id),
  );
  assert.equal(classifiedExact.outcome, 'draft_present');
  classifying.mutateDraft(classifiedCreated.provider_draft_id, {
    subject_digest: digest('staff edited subject'),
    body_digest: digest('staff edited body'),
  });
  const classifiedModified = await classifyingProvider.reconcileDraft(
    reconcileRequest(classifiedCreated.provider_draft_id),
  );
  assert.equal(classifiedModified.outcome, 'draft_modified');
  assert.equal(classifiedModified.is_draft, true);
  classifying.mutateDraft(classifiedCreated.provider_draft_id, {
    subject_digest: SUBJECT_DIGEST,
    body_digest: BODY_DIGEST,
    recipient_address: 'other@example.test',
  });
  const classifiedMismatch = await classifyingProvider.reconcileDraft(
    reconcileRequest(classifiedCreated.provider_draft_id),
  );
  assert.equal(classifiedMismatch.outcome, 'draft_mismatch');
  classifying.deleteDraft(classifiedCreated.provider_draft_id);
  const classifiedMissing = await classifyingProvider.reconcileDraft(
    reconcileRequest(classifiedCreated.provider_draft_id),
  );
  assert.equal(classifiedMissing.outcome, 'draft_not_found');
  console.log('  PASS  classifying transport maps exact/modified/mismatch/not-found without a search API');

  const idOnlyFake = createEmailLunaControlledDraftingFakeTransport({
    classify: true,
    reconcileResult: {
      provider_draft_id: classifiedCreated.provider_draft_id,
      is_draft: true,
    },
  });
  const idOnlyProvider = createEmailLunaControlledDraftingProvider({
    authority: authority(),
    transport: pickEmailLunaControlledDraftingTransportMethods({
      createReplyDraft: idOnlyFake.createReplyDraft,
      reconcileDraft: idOnlyFake.reconcileDraft,
    }),
  });
  const idOnlyCreated = await idOnlyProvider.createReplyDraft(createRequest());
  const idOnlyReconcile = await idOnlyProvider.reconcileDraft(
    reconcileRequest(idOnlyCreated.provider_draft_id),
  );
  assert.equal(idOnlyReconcile.outcome, 'draft_mismatch');
  assert.notEqual(idOnlyReconcile.outcome, 'draft_present');
  console.log('  PASS  Graph-shaped id+isDraft-only result cannot become exact');

  function graphMessage(patch = {}) {
    return {
      id: 'AAMkAGI2-LIVE-DRAFT',
      isDraft: true,
      subject: SUBJECT,
      body: { contentType: 'text', content: BODY },
      toRecipients: [{ emailAddress: { address: RECIPIENT, name: 'Elena' } }],
      conversationId: THREAD,
      '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#messages/$entity',
      ...patch,
    };
  }
  function mockHttps(handler) {
    const captured = [];
    function request(options, onResponse) {
      captured.push({
        method: options.method,
        path: options.path,
        hostname: options.hostname,
        headers: options.headers,
      });
      const planned = handler.next ? handler.next(options, captured.length) : handler;
      const response = new EventEmitter();
      response.statusCode = planned.statusCode;
      Object.defineProperty(response, 'headers', {
        value: { 'content-type': planned.contentType === undefined ? 'application/json' : planned.contentType },
        enumerable: true,
        configurable: true,
      });
      const req = new EventEmitter();
      req.end = (body) => {
        captured[captured.length - 1].body = body || null;
        queueMicrotask(() => {
          onResponse(response);
          if (planned.body) response.emit('data', Buffer.from(planned.body, 'utf8'));
          response.emit('end');
        });
      };
      req.destroy = () => {};
      response.destroy = () => {};
      response.on = response.on.bind(response);
      response.once = response.once.bind(response);
      return req;
    }
    request.captured = captured;
    return request;
  }
  const graphHttps = mockHttps({
    next(_options, n) {
      if (n === 1) {
        return { statusCode: 201, body: JSON.stringify({ id: 'AAMkAGI2-LIVE-DRAFT', isDraft: true }) };
      }
      if (n === 2) {
        return { statusCode: 200, body: JSON.stringify({ id: 'AAMkAGI2-LIVE-DRAFT' }) };
      }
      return { statusCode: 200, body: JSON.stringify(graphMessage()) };
    },
  });
  const graphTransport = createEmailLunaControlledDraftingGraphDraftTransport({
    httpsImpl: graphHttps,
    tokenLoan: createEmailLunaControlledDraftingFakeClosedTokenLoan({ accessToken: TOKEN }),
  });
  assert.deepEqual(Object.keys(graphTransport).sort(), ['createReplyDraft', 'reconcileDraft']);
  assert.equal(typeof graphTransport.sendDraft, 'undefined');
  assert.equal(typeof graphTransport.sendMail, 'undefined');
  assert.equal(Object.hasOwn(graphTransport, 'accessToken'), false);
  const graphProvider = createEmailLunaControlledDraftingProvider({
    authority: authority(),
    transport: pickEmailLunaControlledDraftingTransportMethods(graphTransport),
  });
  const graphCreated = await graphProvider.createReplyDraft(createRequest());
  assert.equal(graphCreated.outcome, 'draft_created');
  assert.equal(graphCreated.provider_draft_id, 'AAMkAGI2-LIVE-DRAFT');
  assert.equal(graphCreated.subject_digest, SUBJECT_DIGEST);
  assert.equal(graphCreated.body_digest, BODY_DIGEST);
  const createCalls = graphHttps.captured;
  assert.equal(createCalls.length, 3);
  assert.equal(createCalls[0].method, 'POST');
  assert.equal(createCalls[0].path, buildCreateReplyPath(MAILBOX, SOURCE_MSG));
  assert.equal(createCalls[0].hostname, HOST);
  assert.equal(createCalls[1].method, 'PATCH');
  assert.equal(createCalls[1].path, buildMessagePath(MAILBOX, 'AAMkAGI2-LIVE-DRAFT', 'patch'));
  assert.equal(JSON.parse(createCalls[1].body).body.contentType, 'Text');
  assert.equal(JSON.parse(createCalls[1].body).toRecipients[0].emailAddress.address, RECIPIENT);
  assert.equal(createCalls[2].method, 'GET');
  assert.equal(createCalls[2].path, buildControlledDraftingGetPath(MAILBOX, 'AAMkAGI2-LIVE-DRAFT'));
  assert.equal(createCalls.some((row) => String(row.path).endsWith('/send')), false);
  const graphExact = await graphProvider.reconcileDraft(reconcileRequest('AAMkAGI2-LIVE-DRAFT'));
  assert.equal(graphExact.outcome, 'draft_present');

  async function reconcileShape(body, statusCode) {
    const httpsImpl = mockHttps({
      statusCode: statusCode || 200,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const transport = createEmailLunaControlledDraftingGraphDraftTransport({
      httpsImpl,
      tokenLoan: createEmailLunaControlledDraftingFakeClosedTokenLoan({ accessToken: TOKEN }),
    });
    const provider = createEmailLunaControlledDraftingProvider({
      authority: authority(),
      transport: pickEmailLunaControlledDraftingTransportMethods(transport),
    });
    return provider.reconcileDraft(reconcileRequest('AAMkAGI2-LIVE-DRAFT'));
  }
  const modified = await reconcileShape(graphMessage({ subject: 'staff changed subject' }));
  assert.equal(modified.outcome, 'draft_modified');
  const recipientMismatch = await reconcileShape(graphMessage({
    toRecipients: [{ emailAddress: { address: 'other@example.test' } }],
  }));
  assert.equal(recipientMismatch.outcome, 'draft_mismatch');
  const threadMismatch = await reconcileShape(graphMessage({ conversationId: 'AAQk-OTHER-THREAD' }));
  assert.equal(threadMismatch.outcome, 'draft_mismatch');
  const sentClosed = await reconcileShape(graphMessage({ isDraft: false }));
  assert.equal(sentClosed.outcome, 'draft_mismatch');
  assert.equal(sentClosed.is_draft, false);
  const multiple = await reconcileShape(graphMessage({
    toRecipients: [
      { emailAddress: { address: RECIPIENT } },
      { emailAddress: { address: 'cc@example.test' } },
    ],
  }));
  assert.equal(multiple.outcome, 'draft_mismatch');
  const html = await reconcileShape(graphMessage({
    body: { contentType: 'HTML', content: `<p>${BODY}</p>` },
  }));
  assert.equal(html.outcome, 'draft_mismatch');
  const extraField = await reconcileShape(graphMessage({ internetMessageId: '<extra@id>' }));
  assert.equal(extraField.outcome, 'draft_mismatch');
  const removed = await reconcileShape('{"error":{"code":"ErrorItemNotFound"}}', 404);
  assert.equal(removed.outcome, 'draft_not_found');
  const hostileBody = {};
  Object.defineProperty(hostileBody, 'contentType', { value: 'text', enumerable: true });
  Object.defineProperty(hostileBody, 'content', {
    get() { throw new Error(TOKEN); }, enumerable: true,
  });
  const hostileMapped = mapGraphDraftObservation({
    id: 'AAMkAGI2-LIVE-DRAFT',
    isDraft: true,
    subject: SUBJECT,
    body: hostileBody,
    toRecipients: [{ emailAddress: { address: RECIPIENT } }],
    conversationId: THREAD,
  }, { provider_draft_id: 'AAMkAGI2-LIVE-DRAFT', mailbox_id: MAILBOX });
  assert.equal(hostileMapped.kind, 'unusable');
  console.log('  PASS  live Graph mapping: POST→PATCH→GET; exact/modified/mismatch/sent/HTML/extras fail closed; no send');

  const timeoutHttps = mockHttps({
    next(_options, n) {
      if (n === 1) return { statusCode: 201, body: JSON.stringify({ id: 'AAMkAGI2-LOST', isDraft: true }) };
      return { statusCode: 200, body: JSON.stringify({ id: 'AAMkAGI2-LOST' }) };
    },
  });
  let timerCalls = 0;
  const slowTimers = {
    setTimeout(fn) {
      timerCalls += 1;
      if (timerCalls === 1) return 1;
      fn();
      return timerCalls;
    },
    clearTimeout() {},
  };
  const timeoutTransport = createEmailLunaControlledDraftingGraphDraftTransport({
    httpsImpl: timeoutHttps,
    tokenLoan: createEmailLunaControlledDraftingFakeClosedTokenLoan({ accessToken: TOKEN }),
    timers: slowTimers,
  });
  const timeoutProvider = createEmailLunaControlledDraftingProvider({
    authority: authority(),
    transport: pickEmailLunaControlledDraftingTransportMethods(timeoutTransport),
  });
  const timeoutErr = await expectInvalidAsync(() => timeoutProvider.createReplyDraft(createRequest()));
  assert.equal(readControlledDraftingKnownCreateDraftId(timeoutErr), 'AAMkAGI2-LOST');
  assert.equal(noLeak(timeoutErr), true);
  console.log('  PASS  PATCH/GET timeout after POST preserves known id without leaking secrets');

  const leakFake = createEmailLunaControlledDraftingFakeTransport({
    createError: new Error(`graph failed ${TOKEN} ${PLANTED}`),
  });
  const leakProvider = createEmailLunaControlledDraftingProvider({
    authority: authority(),
    transport: pickEmailLunaControlledDraftingTransportMethods({
      createReplyDraft: leakFake.createReplyDraft,
      reconcileDraft: leakFake.reconcileDraft,
    }),
  });
  await expectInvalidAsync(() => leakProvider.createReplyDraft(createRequest()));

  const malformedFake = createEmailLunaControlledDraftingFakeTransport({
    createResult: {
      provider_draft_id: 'AAMkAGI2-DRAFT',
      is_draft: true,
      access_token: TOKEN,
      error: PLANTED,
    },
  });
  const malformedProvider = createEmailLunaControlledDraftingProvider({
    authority: authority(),
    transport: pickEmailLunaControlledDraftingTransportMethods({
      createReplyDraft: malformedFake.createReplyDraft,
      reconcileDraft: malformedFake.reconcileDraft,
    }),
  });
  await expectInvalidAsync(() => malformedProvider.createReplyDraft(createRequest()));

  const sentFake = createEmailLunaControlledDraftingFakeTransport({
    createResult: { provider_draft_id: 'AAMkAGI2-DRAFT', is_draft: false },
  });
  const sentProvider = createEmailLunaControlledDraftingProvider({
    authority: authority(),
    transport: pickEmailLunaControlledDraftingTransportMethods({
      createReplyDraft: sentFake.createReplyDraft,
      reconcileDraft: sentFake.reconcileDraft,
    }),
  });
  await expectInvalidAsync(() => sentProvider.createReplyDraft(createRequest()));

  const accessor = {};
  Object.defineProperty(accessor, 'accessToken', { get() { throw new Error(TOKEN); }, enumerable: true });
  Object.defineProperty(accessor, 'client_id', { value: C, enumerable: true });
  await expectInvalidAsync(() => provider.createReplyDraft(accessor));
  expectInvalid(() => createEmailLunaControlledDraftingProvider({
    authority: new Proxy(authority(), { get(target, prop, recv) { return Reflect.get(target, prop, recv); } }),
    transport: pickEmailLunaControlledDraftingTransportMethods({
      createReplyDraft: fake.createReplyDraft,
      reconcileDraft: fake.reconcileDraft,
    }),
  }));
  console.log('  PASS  malformed responses, planted secrets, accessors, and proxies fail closed without leakage');

  assert.equal(LIB_SRC.includes('process.env'), false);
  assert.equal(LIB_SRC.includes('LUNA_AUTO_SEND_ENABLED'), false);
  assert.doesNotMatch(STAFF_API_SRC, /email-luna-controlled-drafting-provider-contract/);
  assert.doesNotMatch(COMPOSE_SRC, /CONTROLLED_DRAFTING|Mail\.ReadWrite/);
  assert.equal(PKG.scripts['verify:email-luna-controlled-drafting-provider-contract'],
    'node scripts/verify-email-luna-controlled-drafting-provider-contract.js');
  assert.match(DOC_SRC, /Chapter 1/);
  assert.match(DOC_SRC, /Mail\.Send/);
  assert.match(DOC_SRC, /Non-goals/);
  assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_AUTHORITY_KEYS.length, 6);
  assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_CREATE_REQUEST_KEYS.includes('accessToken'), false);
  assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_GRAPH_CALL_OPERATIONS.includes('send_draft'), false);
  console.log('  PASS  not composed into worker/deploy; does not rely on LUNA_AUTO_SEND_ENABLED; docs name non-goals');

  console.log('ALL OK — Stage 2 Chapter 1 controlled-drafting provider contract');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
