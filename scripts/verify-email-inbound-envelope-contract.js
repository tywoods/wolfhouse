'use strict';

/**
 * verify:email-inbound-envelope-contract — offline inbound envelope contract + MS mapper.
 *
 * Contract slice only: no DB, runtime wiring, polling, Graph calls, OAuth, bodies,
 * attachments, drafts, sends, deploy, or activation.
 */

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const util = require('util');

const ROOT = path.join(__dirname, '..');
const CONTRACT_REL = 'scripts/lib/email-inbound-envelope-contract.js';
const MAPPER_REL = 'scripts/lib/email-microsoft-graph-inbound-envelope-mapper.js';
const DOC_REL = 'docs/EMAIL-MAILBOX-ADAPTER-BOUNDARY.md';
const VERIFY_REL = 'scripts/verify-email-inbound-envelope-contract.js';
const PKG_PATH = path.join(ROOT, 'package.json');
const DOC_PATH = path.join(ROOT, DOC_REL);
const CONTRACT_PATH = path.join(ROOT, CONTRACT_REL);
const MAPPER_PATH = path.join(ROOT, MAPPER_REL);

const PLANTED_BODY = 'BODY_MUST_NEVER_APPEAR';
const PLANTED_TOKEN = 'ya29.NEVER_LEAK_TOKEN';
const OVERSIZE = `x${'a'.repeat(3000)}`;
const VALID_ETAG = 'W/"CQAAABYAAABqZ1"';
const MAILBOX_ID = 'support@lunafrontdesk.com';
const MSG_ID = 'AAMkAGI2TG93AAA=';

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
    return true;
  }
  fail += 1;
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

function ser(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

function noLeak(v) {
  const s = typeof v === 'string' ? v : ser(v);
  return !s.includes(PLANTED_BODY)
    && !s.includes(PLANTED_TOKEN)
    && !s.includes('client_secret=')
    && !s.includes('access_token');
}

const origLookup = dns.lookup;
const origLookupService = dns.lookupService;
const origResolve4 = dns.resolve4;
const origConnect = net.Socket.prototype.connect;
const origHttp = http.request;
const origHttps = https.request;
let networkHits = 0;

function installNetworkGuards() {
  networkHits = 0;
  const bump = () => {
    networkHits += 1;
    throw new Error('NETWORK_FORBIDDEN_IN_INBOUND_ENVELOPE_VERIFIER');
  };
  dns.lookup = dns.lookupService = dns.resolve4 = function blockedDns() { bump(); };
  net.Socket.prototype.connect = function blockedConnect() { bump(); };
  http.request = https.request = function blockedHttp() { bump(); };
}

function restoreNetworkGuards() {
  dns.lookup = origLookup;
  dns.lookupService = origLookupService;
  dns.resolve4 = origResolve4;
  net.Socket.prototype.connect = origConnect;
  http.request = origHttp;
  https.request = origHttps;
}

function graphRow(patch = {}) {
  const base = {
    id: MSG_ID,
    subject: 'Surf weekend',
    from: {
      emailAddress: {
        address: 'guest@example.com',
        name: 'Guest',
      },
    },
    receivedDateTime: '2026-08-06T12:00:00Z',
    isRead: false,
    conversationId: 'AAQkAGConv=',
    internetMessageId: '<msg.1@example.com>',
  };
  return { ...base, ...patch };
}

function validEnvelope(patch = {}) {
  return {
    provider: 'microsoft_graph',
    provider_mailbox_id: MAILBOX_ID,
    provider_message_id: MSG_ID,
    received_at: '2026-08-06T12:00:00.000Z',
    subject: 'Surf weekend',
    sender_display_name: 'Guest',
    sender_address: 'guest@example.com',
    is_read: false,
    conversation_id: 'AAQkAGConv=',
    internet_message_id: '<msg.1@example.com>',
    ...patch,
  };
}

console.log('verify:email-inbound-envelope-contract — RED→GREEN offline gate\n');
installNetworkGuards();

try {
  ok('contract-file-exists', fs.existsSync(CONTRACT_PATH));
  ok('mapper-file-exists', fs.existsSync(MAPPER_PATH));
  ok('doc-exists', fs.existsSync(DOC_PATH));

  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  const scripts = pkg.scripts || {};
  ok(
    'package-gate-registered',
    scripts['verify:email-inbound-envelope-contract']
      === `node ${VERIFY_REL.replace(/\\/g, '/')}`,
  );
  ok(
    'package-gate-no-deploy',
    !/deploy|azure|az |graph\.microsoft|oauth/i.test(
      String(scripts['verify:email-inbound-envelope-contract'] || ''),
    ),
  );

  const doc = fs.readFileSync(DOC_PATH, 'utf8');
  ok('doc-mentions-inbound-envelope', /inbound email.?envelope|email-inbound-envelope/i.test(doc));
  ok('doc-mentions-pii-custody', /PII/i.test(doc) && /persist|persistence/i.test(doc)
    && /log/i.test(doc) && /forbid|forbidden|deferred|custody/i.test(doc));
  ok('doc-excludes-bodies-attachments', /exclud|must not|never/i.test(doc)
    && /bod(y|ies)/i.test(doc) && /attachment/i.test(doc));

  let contract;
  let mapper;
  try {
    contract = require('./lib/email-inbound-envelope-contract');
    mapper = require('./lib/email-microsoft-graph-inbound-envelope-mapper');
    ok('modules-load', true);
  } catch (err) {
    ok('modules-load', false, String(err && err.message ? err.message : err));
    throw err;
  }

  const {
    EMAIL_INBOUND_ENVELOPE_KEYS,
    EMAIL_INBOUND_ENVELOPE_PII_KEYS,
    EMAIL_INBOUND_ENVELOPE_PROVIDERS,
    EMAIL_INBOUND_ENVELOPE_PERSISTENCE_FORBIDDEN,
    EMAIL_INBOUND_ENVELOPE_LOGGING_FORBIDDEN,
    EMAIL_INBOUND_ENVELOPE_STRING_MAX,
    validateInboundEmailEnvelope,
  } = contract;

  const {
    MICROSOFT_GRAPH_MAIL_READ_BASIC_SELECT_FIELDS,
    mapMicrosoftGraphMailReadBasicRowToInboundEnvelope,
  } = mapper;

  ok('providers-include-future-adapters', Array.isArray(EMAIL_INBOUND_ENVELOPE_PROVIDERS)
    && EMAIL_INBOUND_ENVELOPE_PROVIDERS.includes('microsoft_graph')
    && EMAIL_INBOUND_ENVELOPE_PROVIDERS.includes('gmail_api')
    && EMAIL_INBOUND_ENVELOPE_PROVIDERS.includes('imap_smtp'));
  ok('persistence-forbidden-flag', EMAIL_INBOUND_ENVELOPE_PERSISTENCE_FORBIDDEN === true);
  ok('logging-forbidden-flag', EMAIL_INBOUND_ENVELOPE_LOGGING_FORBIDDEN === true);
  ok('string-max-bounded', Number.isInteger(EMAIL_INBOUND_ENVELOPE_STRING_MAX)
    && EMAIL_INBOUND_ENVELOPE_STRING_MAX >= 256
    && EMAIL_INBOUND_ENVELOPE_STRING_MAX <= 2048);
  ok('pii-keys-documented', Array.isArray(EMAIL_INBOUND_ENVELOPE_PII_KEYS)
    && EMAIL_INBOUND_ENVELOPE_PII_KEYS.includes('subject')
    && EMAIL_INBOUND_ENVELOPE_PII_KEYS.includes('sender_display_name')
    && EMAIL_INBOUND_ENVELOPE_PII_KEYS.includes('sender_address')
    && EMAIL_INBOUND_ENVELOPE_PII_KEYS.includes('internet_message_id'));
  ok(
    'exact-envelope-keys',
    Array.isArray(EMAIL_INBOUND_ENVELOPE_KEYS)
      && EMAIL_INBOUND_ENVELOPE_KEYS.join(',') === [
        'provider',
        'provider_mailbox_id',
        'provider_message_id',
        'received_at',
        'subject',
        'sender_display_name',
        'sender_address',
        'is_read',
        'conversation_id',
        'internet_message_id',
      ].join(','),
  );
  ok(
    'mail-readbasic-select-no-body-attachments',
    Array.isArray(MICROSOFT_GRAPH_MAIL_READ_BASIC_SELECT_FIELDS)
      && MICROSOFT_GRAPH_MAIL_READ_BASIC_SELECT_FIELDS.join(',')
        === 'id,subject,from,receivedDateTime,isRead,conversationId,internetMessageId'
      && !MICROSOFT_GRAPH_MAIL_READ_BASIC_SELECT_FIELDS.includes('hasAttachments')
      && !MICROSOFT_GRAPH_MAIL_READ_BASIC_SELECT_FIELDS.includes('body'),
  );

  // ── Happy path: validate normalized envelope ─────────────────────────────
  {
    const r = validateInboundEmailEnvelope(validEnvelope());
    ok('validate-happy-ok', r.ok === true, ser(r));
    ok('validate-happy-frozen', r.ok && Object.isFrozen(r) && Object.isFrozen(r.value));
    ok('validate-happy-keys', r.ok
      && Object.keys(r.value).sort().join(',') === [...EMAIL_INBOUND_ENVELOPE_KEYS].sort().join(','));
    ok('validate-happy-no-raw-retention', r.ok && r.value.raw === undefined
      && r.value.row === undefined && r.value['@odata.etag'] === undefined);
  }

  // ── Happy path: Microsoft fixtures → mapper ──────────────────────────────
  {
    const mapped = mapMicrosoftGraphMailReadBasicRowToInboundEnvelope({
      provider: 'microsoft_graph',
      provider_mailbox_id: MAILBOX_ID,
      row: graphRow(),
    });
    ok('mapper-happy-ok', mapped.ok === true, ser(mapped));
    ok('mapper-happy-frozen', mapped.ok && Object.isFrozen(mapped) && Object.isFrozen(mapped.value));
    ok('mapper-happy-provider-mailbox', mapped.ok
      && mapped.value.provider === 'microsoft_graph'
      && mapped.value.provider_mailbox_id === MAILBOX_ID
      && mapped.value.provider_message_id === MSG_ID);
    ok('mapper-happy-triage-fields', mapped.ok
      && mapped.value.subject === 'Surf weekend'
      && mapped.value.sender_address === 'guest@example.com'
      && mapped.value.sender_display_name === 'Guest'
      && mapped.value.is_read === false
      && mapped.value.conversation_id === 'AAQkAGConv='
      && mapped.value.internet_message_id === '<msg.1@example.com>');
    ok('mapper-happy-no-graph-field-names', mapped.ok
      && mapped.value.receivedDateTime === undefined
      && mapped.value.conversationId === undefined
      && mapped.value.internetMessageId === undefined
      && mapped.value.isRead === undefined
      && mapped.value.from === undefined
      && mapped.value.id === undefined);
    const revalidated = validateInboundEmailEnvelope(mapped.value);
    ok('mapper-output-revalidates', revalidated.ok === true, ser(revalidated));
  }

  {
    const withEtag = mapMicrosoftGraphMailReadBasicRowToInboundEnvelope({
      provider: 'microsoft_graph',
      provider_mailbox_id: MAILBOX_ID,
      row: graphRow({ '@odata.etag': VALID_ETAG }),
    });
    ok('mapper-optional-etag-accepted-discarded', withEtag.ok === true
      && withEtag.value['@odata.etag'] === undefined
      && !ser(withEtag).includes(VALID_ETAG), ser(withEtag));
  }

  {
    const nullables = mapMicrosoftGraphMailReadBasicRowToInboundEnvelope({
      provider: 'microsoft_graph',
      provider_mailbox_id: MAILBOX_ID,
      row: graphRow({
        subject: null,
        from: null,
        conversationId: null,
        internetMessageId: null,
      }),
    });
    ok('mapper-nullables', nullables.ok === true
      && nullables.value.subject === null
      && nullables.value.sender_address === null
      && nullables.value.sender_display_name === null
      && nullables.value.conversation_id === null
      && nullables.value.internet_message_id === null, ser(nullables));
  }

  // ── Hostile: proxy / accessor / symbol / inherited ───────────────────────
  {
    const proxyEnv = new Proxy(validEnvelope(), {
      get(t, p) { return t[p]; },
    });
    const r = validateInboundEmailEnvelope(proxyEnv);
    ok('validate-rejects-proxy', r.ok === false, ser(r));
  }
  {
    const accessor = validEnvelope();
    Object.defineProperty(accessor, 'subject', {
      get() { throw new Error(PLANTED_BODY); },
      enumerable: true,
    });
    const r = validateInboundEmailEnvelope(accessor);
    ok('validate-rejects-accessor', r.ok === false && noLeak(r), ser(r));
  }
  {
    const sym = validEnvelope();
    Object.defineProperty(sym, Symbol('secret'), { value: PLANTED_TOKEN, enumerable: true });
    const r = validateInboundEmailEnvelope(sym);
    ok('validate-rejects-symbol', r.ok === false && noLeak(r), ser(r));
  }
  {
    const inherited = Object.create({ subject: PLANTED_BODY });
    Object.assign(inherited, validEnvelope({ subject: undefined }));
    delete inherited.subject;
    const r = validateInboundEmailEnvelope(inherited);
    ok('validate-rejects-inherited-or-missing', r.ok === false && noLeak(r), ser(r));
  }
  {
    const proxyRow = new Proxy(graphRow(), {});
    const r = mapMicrosoftGraphMailReadBasicRowToInboundEnvelope({
      provider: 'microsoft_graph',
      provider_mailbox_id: MAILBOX_ID,
      row: proxyRow,
    });
    ok('mapper-rejects-proxy-row', r.ok === false && noLeak(r), ser(r));
  }
  {
    const accessorRow = graphRow();
    Object.defineProperty(accessorRow, 'subject', {
      get() { throw new Error(PLANTED_BODY); },
      enumerable: true,
    });
    const r = mapMicrosoftGraphMailReadBasicRowToInboundEnvelope({
      provider: 'microsoft_graph',
      provider_mailbox_id: MAILBOX_ID,
      row: accessorRow,
    });
    ok('mapper-rejects-accessor-row', r.ok === false && noLeak(r), ser(r));
  }

  // ── Hostile: unknown / dangerous / body / attachment keys ────────────────
  {
    const unknown = validateInboundEmailEnvelope(validEnvelope({ preview: 'x' }));
    ok('validate-rejects-unknown-preview', unknown.ok === false, ser(unknown));
  }
  {
    const body = validateInboundEmailEnvelope(validEnvelope({ body: PLANTED_BODY }));
    ok('validate-rejects-body', body.ok === false && noLeak(body), ser(body));
  }
  {
    const attachments = validateInboundEmailEnvelope(validEnvelope({
      has_attachments: true,
      attachments: [{ name: PLANTED_BODY }],
    }));
    ok('validate-rejects-attachments', attachments.ok === false && noLeak(attachments), ser(attachments));
  }
  {
    const dangerous = validateInboundEmailEnvelope({
      ...validEnvelope(),
      __proto__: { polluted: true },
    });
    // Spread may not keep __proto__ as own key; force own dangerous key.
    const forced = validEnvelope();
    Object.defineProperty(forced, '__proto__', {
      value: { polluted: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const r = validateInboundEmailEnvelope(forced);
    ok('validate-rejects-dangerous-key', r.ok === false || dangerous.ok === false, ser(r));
  }
  {
    const graphBody = mapMicrosoftGraphMailReadBasicRowToInboundEnvelope({
      provider: 'microsoft_graph',
      provider_mailbox_id: MAILBOX_ID,
      row: graphRow({ body: { content: PLANTED_BODY } }),
    });
    ok('mapper-rejects-body', graphBody.ok === false && noLeak(graphBody), ser(graphBody));
  }
  {
    const graphAtt = mapMicrosoftGraphMailReadBasicRowToInboundEnvelope({
      provider: 'microsoft_graph',
      provider_mailbox_id: MAILBOX_ID,
      row: graphRow({ hasAttachments: true }),
    });
    ok('mapper-rejects-hasAttachments', graphAtt.ok === false, ser(graphAtt));
  }
  {
    const uniqueBody = mapMicrosoftGraphMailReadBasicRowToInboundEnvelope({
      provider: 'microsoft_graph',
      provider_mailbox_id: MAILBOX_ID,
      row: graphRow({ uniqueBody: { content: PLANTED_BODY } }),
    });
    ok('mapper-rejects-uniqueBody', uniqueBody.ok === false && noLeak(uniqueBody), ser(uniqueBody));
  }
  {
    const headers = mapMicrosoftGraphMailReadBasicRowToInboundEnvelope({
      provider: 'microsoft_graph',
      provider_mailbox_id: MAILBOX_ID,
      row: graphRow({ internetMessageHeaders: [{ name: 'To', value: PLANTED_BODY }] }),
    });
    ok('mapper-rejects-headers', headers.ok === false && noLeak(headers), ser(headers));
  }

  // ── Hostile: missing / oversize / bad timestamp / wrong provider ─────────
  {
    const obj = validEnvelope();
    delete obj.provider_message_id;
    const r = validateInboundEmailEnvelope(obj);
    ok('validate-rejects-missing-message-id', r.ok === false, ser(r));
  }
  {
    const oversize = validateInboundEmailEnvelope(validEnvelope({ subject: OVERSIZE }));
    ok('validate-rejects-oversize-subject', oversize.ok === false, ser(oversize));
  }
  {
    const badTs = validateInboundEmailEnvelope(validEnvelope({ received_at: 'not-a-timestamp' }));
    ok('validate-rejects-bad-timestamp', badTs.ok === false, ser(badTs));
  }
  {
    const inferred = mapMicrosoftGraphMailReadBasicRowToInboundEnvelope({
      provider: 'microsoft_graph',
      row: graphRow(),
    });
    ok('mapper-requires-explicit-mailbox', inferred.ok === false, ser(inferred));
  }
  {
    const wrongProvider = mapMicrosoftGraphMailReadBasicRowToInboundEnvelope({
      provider: 'gmail_api',
      provider_mailbox_id: MAILBOX_ID,
      row: graphRow(),
    });
    ok('mapper-rejects-non-graph-provider', wrongProvider.ok === false, ser(wrongProvider));
  }
  {
    const missingProvider = mapMicrosoftGraphMailReadBasicRowToInboundEnvelope({
      provider_mailbox_id: MAILBOX_ID,
      row: graphRow(),
    });
    ok('mapper-requires-explicit-provider', missingProvider.ok === false, ser(missingProvider));
  }
  {
    const badEtag = mapMicrosoftGraphMailReadBasicRowToInboundEnvelope({
      provider: 'microsoft_graph',
      provider_mailbox_id: MAILBOX_ID,
      row: graphRow({ '@odata.etag': '' }),
    });
    ok('mapper-rejects-empty-etag', badEtag.ok === false, ser(badEtag));
  }
  {
    const oversizeEtag = mapMicrosoftGraphMailReadBasicRowToInboundEnvelope({
      provider: 'microsoft_graph',
      provider_mailbox_id: MAILBOX_ID,
      row: graphRow({ '@odata.etag': `W/"${'a'.repeat(3000)}"` }),
    });
    ok('mapper-rejects-oversize-etag', oversizeEtag.ok === false, ser(oversizeEtag));
  }
  {
    const oversizeId = mapMicrosoftGraphMailReadBasicRowToInboundEnvelope({
      provider: 'microsoft_graph',
      provider_mailbox_id: MAILBOX_ID,
      row: graphRow({ id: OVERSIZE }),
    });
    ok('mapper-rejects-oversize-id', oversizeId.ok === false, ser(oversizeId));
  }

  // ── Hostile: duplicate / recipients / links / tokens on envelope ─────────
  {
    const recipients = validateInboundEmailEnvelope(validEnvelope({
      to_recipients: ['a@b.c'],
      cc_recipients: ['d@e.f'],
    }));
    ok('validate-rejects-recipients', recipients.ok === false, ser(recipients));
  }
  {
    const links = validateInboundEmailEnvelope(validEnvelope({
      web_link: 'https://outlook.office365.com/owa/?ItemID=x',
    }));
    ok('validate-rejects-links', links.ok === false, ser(links));
  }
  {
    const token = validateInboundEmailEnvelope(validEnvelope({
      access_token: PLANTED_TOKEN,
    }));
    ok('validate-rejects-token-field', token.ok === false && noLeak(token), ser(token));
  }
  {
    // Duplicate: Graph camelCase identity fields must not appear on normalized DTO input.
    const dupGraph = validateInboundEmailEnvelope(validEnvelope({
      conversationId: 'dup',
      receivedDateTime: '2026-01-01T00:00:00Z',
    }));
    ok('validate-rejects-graph-field-names', dupGraph.ok === false, ser(dupGraph));
  }
  {
    const nestedFrom = validateInboundEmailEnvelope(validEnvelope({
      from: { emailAddress: { address: 'x@y.z', name: 'n' } },
    }));
    ok('validate-rejects-nested-from', nestedFrom.ok === false, ser(nestedFrom));
  }
  {
    // Mapper input bag: unknown keys fail closed (exact schema).
    const extra = mapMicrosoftGraphMailReadBasicRowToInboundEnvelope({
      provider: 'microsoft_graph',
      provider_mailbox_id: MAILBOX_ID,
      row: graphRow(),
      access_token: PLANTED_TOKEN,
    });
    ok('mapper-rejects-unknown-input-keys', extra.ok === false && noLeak(extra), ser(extra));
  }

  // ── Immutability: mutate attempts must not stick ─────────────────────────
  {
    const r = validateInboundEmailEnvelope(validEnvelope());
    assert.equal(r.ok, true);
    try {
      r.value.subject = PLANTED_BODY;
    } catch (_e) { /* frozen */ }
    ok('envelope-immutable', r.value.subject === 'Surf weekend' && noLeak(r.value));
  }

  // ── Source static checks: no Graph names in contract module ──────────────
  {
    const contractSrc = fs.readFileSync(CONTRACT_PATH, 'utf8');
    ok('contract-no-odata', !contractSrc.includes('@odata'));
    ok('contract-no-graph-camel', !/\breceivedDateTime\b/.test(contractSrc)
      && !/\bconversationId\b/.test(contractSrc)
      && !/\binternetMessageId\b/.test(contractSrc)
      && !/\bisRead\b/.test(contractSrc));
    ok('contract-no-network', !/\bhttps?\.(request|get)\b/.test(contractSrc)
      && !contractSrc.includes('graph.microsoft.com'));
    const mapperSrc = fs.readFileSync(MAPPER_PATH, 'utf8');
    ok('mapper-no-network', !/\bhttps?\.(request|get)\b/.test(mapperSrc)
      && !mapperSrc.includes('login.microsoftonline.com'));
    ok('mapper-discards-etag-comment', /etag/i.test(mapperSrc) && /discard/i.test(mapperSrc));
    ok('mapper-no-db', !/\brequire\(['"]pg['"]\)/.test(mapperSrc)
      && !/\bpostgres\b/i.test(mapperSrc)
      && !/\bINSERT\s+INTO\b/i.test(mapperSrc)
      && !/\bFROM\s+tenant_/i.test(mapperSrc));
  }

  ok('no-network-hits', networkHits === 0, `hits=${networkHits}`);

  // util.types.isProxy available (mapper/contract may use it)
  ok('nodejs-isProxy-available', typeof util.types.isProxy === 'function');
} catch (err) {
  ok('verifier-uncaught', false, String(err && err.stack ? err.stack : err));
} finally {
  restoreNetworkGuards();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
