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
    EMAIL_INBOUND_ENVELOPE_IDENTITY_KEYS,
    EMAIL_INBOUND_ENVELOPE_ORDER_DIRECTION,
    EMAIL_INBOUND_ENVELOPE_TIE_BREAK_KEYS,
    EMAIL_INBOUND_MICROSOFT_DURABLE_IDENTITY_REQUIRES_IMMUTABLE_ID,
    EMAIL_INBOUND_MICROSOFT_MAPPER_CLAIMS_IMMUTABLE_ID_PROVENANCE,
    EMAIL_INBOUND_ENVELOPE_RUNTIME_WIRED,
    EMAIL_INBOUND_LEGACY_GRAPH_TRANSPORT_ENVELOPE_KEYS,
    validateInboundEmailEnvelope,
    inboundEmailEnvelopeIdentityTuple,
    areInboundEmailEnvelopesDuplicate,
    compareInboundEmailEnvelopesForOrder,
    convertLegacyGraphTransportEnvelopeToInbound,
  } = contract;

  const {
    MICROSOFT_GRAPH_MAIL_READ_BASIC_SELECT_FIELDS,
    mapMicrosoftGraphMailReadBasicRowToInboundEnvelope,
  } = mapper;

  // Adapter transport surface (legacy) — classify, do not import runtime wiring.
  const graphAdapter = require('./lib/email-microsoft-graph-adapter');
  const {
    ENVELOPE_DTO_KEYS: GRAPH_ADAPTER_ENVELOPE_DTO_KEYS,
    GRAPH_TRANSPORT_ENVELOPE_SURFACE,
  } = graphAdapter;

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

  // ── Blocker 1: reject impossible calendar timestamps (no Date.parse rollover) ──
  {
    const impossible = [
      '2026-02-30T12:00:00Z',       // Feb 30 rolls to Mar 2 via Date.parse
      '2026-04-31T00:00:00Z',       // Apr 31 rolls to May 1
      '2025-02-29T00:00:00Z',       // non-leap Feb 29 rolls to Mar 1
      '2026-00-10T00:00:00Z',       // month 0
      '2026-13-01T00:00:00Z',       // month 13
      '2026-01-32T00:00:00Z',       // day 32
      '2026-01-15T24:00:00Z',       // hour 24
      '2026-01-15T12:60:00Z',       // minute 60
      '2026-01-15T12:00:60Z',       // second 60
    ];
    let allReject = true;
    for (const ts of impossible) {
      const r = validateInboundEmailEnvelope(validEnvelope({ received_at: ts }));
      if (r.ok !== false) {
        allReject = false;
        ok(`validate-rejects-impossible-calendar-${ts}`, false, ser(r));
      }
    }
    ok('validate-rejects-impossible-calendar-timestamps', allReject);
  }
  {
    // Valid leap day + month boundary + offset canonical equivalence
    const leap = validateInboundEmailEnvelope(validEnvelope({
      received_at: '2024-02-29T23:59:59.123Z',
    }));
    ok('validate-accepts-leap-year-feb29', leap.ok === true
      && leap.value.received_at === '2024-02-29T23:59:59.123Z', ser(leap));
    const monthEnd = validateInboundEmailEnvelope(validEnvelope({
      received_at: '2026-01-31T00:00:00Z',
    }));
    ok('validate-accepts-month-day-boundary', monthEnd.ok === true
      && monthEnd.value.received_at === '2026-01-31T00:00:00.000Z', ser(monthEnd));
    const offset = validateInboundEmailEnvelope(validEnvelope({
      received_at: '2026-08-06T12:00:00+02:00',
    }));
    ok('validate-offset-canonical-equivalence', offset.ok === true
      && offset.value.received_at === '2026-08-06T10:00:00.000Z', ser(offset));
    const offsetMs = validateInboundEmailEnvelope(validEnvelope({
      received_at: '2026-08-06T10:00:00.000Z',
    }));
    ok('validate-offset-and-zulu-same-instant', offset.ok && offsetMs.ok
      && offset.value.received_at === offsetMs.value.received_at, ser({ offset, offsetMs }));
  }

  // ── Remaining blocker: Date.UTC 1900 low-year map + year-range round-trip ──
  {
    // Years 0000-0099 must stay four-digit low years (Date.UTC maps 0-99 → 1900-1999).
    const low = validateInboundEmailEnvelope(validEnvelope({
      received_at: '0001-06-15T12:34:56.789Z',
    }));
    ok('validate-accepts-low-year-four-digit', low.ok === true
      && low.value.received_at === '0001-06-15T12:34:56.789Z'
      && !low.value.received_at.startsWith('19'), ser(low));

    const y0 = validateInboundEmailEnvelope(validEnvelope({
      received_at: '0000-01-01T00:00:00Z',
    }));
    ok('validate-accepts-year-0000', y0.ok === true
      && y0.value.received_at === '0000-01-01T00:00:00.000Z', ser(y0));

    const y99 = validateInboundEmailEnvelope(validEnvelope({
      received_at: '0099-12-31T23:59:59.999Z',
    }));
    ok('validate-accepts-year-0099', y99.ok === true
      && y99.value.received_at === '0099-12-31T23:59:59.999Z'
      && !y99.value.received_at.startsWith('19'), ser(y99));

    // Year 0000 is leap (divisible by 400) under proleptic Gregorian.
    const leap0 = validateInboundEmailEnvelope(validEnvelope({
      received_at: '0000-02-29T00:00:00.000Z',
    }));
    ok('validate-accepts-year-0000-leap-feb29', leap0.ok === true
      && leap0.value.received_at === '0000-02-29T00:00:00.000Z', ser(leap0));

    const nonLeap1 = validateInboundEmailEnvelope(validEnvelope({
      received_at: '0001-02-29T00:00:00.000Z',
    }));
    ok('validate-rejects-year-0001-non-leap-feb29', nonLeap1.ok === false, ser(nonLeap1));

    // High four-digit year preserved.
    const high = validateInboundEmailEnvelope(validEnvelope({
      received_at: '9999-12-31T23:59:59.999Z',
    }));
    ok('validate-accepts-high-year-9999', high.ok === true
      && high.value.received_at === '9999-12-31T23:59:59.999Z', ser(high));

    // Positive offset that canonicalizes below year 0000 must be rejected.
    const below = validateInboundEmailEnvelope(validEnvelope({
      received_at: '0000-01-01T00:00:00+00:01',
    }));
    ok('validate-rejects-positive-offset-canonical-year-below-0000',
      below.ok === false, ser(below));

    // Negative offset that canonicalizes above year 9999 must be rejected
    // (would otherwise emit expanded +010000 year and break re-validation).
    const above = validateInboundEmailEnvelope(validEnvelope({
      received_at: '9999-12-31T23:59:59.999-00:01',
    }));
    ok('validate-rejects-negative-offset-canonical-year-above-9999',
      above.ok === false, ser(above));

    // Offset boundaries that remain inside 0000-9999 must accept and canonicalize.
    const posBoundary = validateInboundEmailEnvelope(validEnvelope({
      received_at: '0000-01-01T00:01:00+00:01',
    }));
    ok('validate-accepts-positive-offset-boundary-in-range', posBoundary.ok === true
      && posBoundary.value.received_at === '0000-01-01T00:00:00.000Z', ser(posBoundary));

    const negBoundary = validateInboundEmailEnvelope(validEnvelope({
      received_at: '9999-12-31T23:58:59.999-00:01',
    }));
    ok('validate-accepts-negative-offset-boundary-in-range', negBoundary.ok === true
      && negBoundary.value.received_at === '9999-12-31T23:59:59.999Z', ser(negBoundary));

    // Every accepted input must canonicalize to a form the same validator
    // accepts unchanged (fixed point under validate).
    const roundTripCases = [
      '0000-01-01T00:00:00Z',
      '0000-02-29T00:00:00.000Z',
      '0001-06-15T12:34:56.789Z',
      '0099-12-31T23:59:59.999Z',
      '0100-01-01T00:00:00Z',
      '1900-02-28T12:00:00Z',
      '2024-02-29T23:59:59.123Z',
      '2026-08-06T12:00:00+02:00',
      '2026-08-06T10:00:00.000Z',
      '0000-01-01T00:01:00+00:01',
      '9999-12-31T23:58:59.999-00:01',
      '9999-12-31T23:59:59.999Z',
    ];
    let allRoundTrip = true;
    for (const ts of roundTripCases) {
      const r1 = validateInboundEmailEnvelope(validEnvelope({ received_at: ts }));
      if (!r1.ok) {
        allRoundTrip = false;
        ok(`validate-round-trip-accepts-${ts}`, false, ser(r1));
        continue;
      }
      const r2 = validateInboundEmailEnvelope(validEnvelope({
        received_at: r1.value.received_at,
      }));
      if (!r2.ok || r2.value.received_at !== r1.value.received_at) {
        allRoundTrip = false;
        ok(`validate-round-trip-stable-${ts}`, false, ser({ first: r1, second: r2 }));
      }
    }
    ok('validate-canonical-round-trip-stable', allRoundTrip);
  }

  // ── Blocker 4: reject non-enumerable contract fields consistently ────────
  {
    const nonEnumRequired = validEnvelope();
    Object.defineProperty(nonEnumRequired, 'subject', {
      value: 'Surf weekend',
      enumerable: false,
      writable: true,
      configurable: true,
    });
    const r = validateInboundEmailEnvelope(nonEnumRequired);
    ok('validate-rejects-non-enumerable-required-field', r.ok === false, ser(r));
  }
  {
    const nonEnumExtra = validEnvelope();
    Object.defineProperty(nonEnumExtra, 'hidden_preview', {
      value: PLANTED_BODY,
      enumerable: false,
      writable: true,
      configurable: true,
    });
    const r = validateInboundEmailEnvelope(nonEnumExtra);
    ok('validate-rejects-non-enumerable-extra-field', r.ok === false && noLeak(r), ser(r));
  }
  {
    const nonEnumInput = {
      provider: 'microsoft_graph',
      provider_mailbox_id: MAILBOX_ID,
      row: graphRow(),
    };
    Object.defineProperty(nonEnumInput, 'provider', {
      value: 'microsoft_graph',
      enumerable: false,
      writable: true,
      configurable: true,
    });
    const r = mapMicrosoftGraphMailReadBasicRowToInboundEnvelope(nonEnumInput);
    ok('mapper-rejects-non-enumerable-input-field', r.ok === false, ser(r));
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

  // ── Blocker 2: one canonical domain envelope + legacy transport conversion ──
  {
    ok(
      'canonical-envelope-keys-frozen',
      Array.isArray(EMAIL_INBOUND_ENVELOPE_KEYS)
        && Object.isFrozen(EMAIL_INBOUND_ENVELOPE_KEYS),
    );
    ok(
      'legacy-graph-transport-keys-classified',
      Array.isArray(EMAIL_INBOUND_LEGACY_GRAPH_TRANSPORT_ENVELOPE_KEYS)
        && EMAIL_INBOUND_LEGACY_GRAPH_TRANSPORT_ENVELOPE_KEYS.join(',')
          === [
            'id',
            'subject',
            'from_address',
            'from_name',
            'received_at',
            'is_read',
            'conversation_id',
            'has_attachments',
            'internet_message_id',
          ].join(','),
    );
    ok(
      'adapter-envelope-is-legacy-transport-surface',
      GRAPH_TRANSPORT_ENVELOPE_SURFACE === 'legacy_provider_transport_row_compatibility'
        && Array.isArray(GRAPH_ADAPTER_ENVELOPE_DTO_KEYS)
        && GRAPH_ADAPTER_ENVELOPE_DTO_KEYS.join(',')
          === EMAIL_INBOUND_LEGACY_GRAPH_TRANSPORT_ENVELOPE_KEYS.join(','),
    );
    // Adapter consumers keep has_attachments / from_* — domain envelope does not.
    ok(
      'canonical-domain-excludes-has-attachments-and-from-aliases',
      !EMAIL_INBOUND_ENVELOPE_KEYS.includes('has_attachments')
        && !EMAIL_INBOUND_ENVELOPE_KEYS.includes('from_address')
        && !EMAIL_INBOUND_ENVELOPE_KEYS.includes('from_name')
        && !EMAIL_INBOUND_ENVELOPE_KEYS.includes('id')
        && EMAIL_INBOUND_ENVELOPE_KEYS.includes('provider_message_id')
        && EMAIL_INBOUND_ENVELOPE_KEYS.includes('sender_address'),
    );
    const legacyRow = {
      id: MSG_ID,
      subject: 'Surf weekend',
      from_address: 'guest@example.com',
      from_name: 'Guest',
      received_at: '2026-08-06T12:00:00Z',
      is_read: false,
      conversation_id: 'AAQkAGConv=',
      has_attachments: true,
      internet_message_id: '<msg.1@example.com>',
    };
    const converted = convertLegacyGraphTransportEnvelopeToInbound({
      provider: 'microsoft_graph',
      provider_mailbox_id: MAILBOX_ID,
      legacy: legacyRow,
    });
    ok('legacy-transport-conversion-ok', converted.ok === true, ser(converted));
    ok('legacy-transport-conversion-canonical-keys', converted.ok
      && Object.keys(converted.value).sort().join(',')
        === [...EMAIL_INBOUND_ENVELOPE_KEYS].sort().join(','));
    ok('legacy-transport-conversion-maps-identity-and-sender', converted.ok
      && converted.value.provider === 'microsoft_graph'
      && converted.value.provider_mailbox_id === MAILBOX_ID
      && converted.value.provider_message_id === MSG_ID
      && converted.value.sender_address === 'guest@example.com'
      && converted.value.sender_display_name === 'Guest'
      && converted.value.has_attachments === undefined
      && converted.value.from_address === undefined
      && converted.value.id === undefined, ser(converted));
    const revalidated = validateInboundEmailEnvelope(converted.value);
    ok('legacy-transport-conversion-revalidates', revalidated.ok === true, ser(revalidated));
    // has_attachments is transport-only metadata and is not a domain field.
    ok('legacy-transport-conversion-discards-has-attachments', converted.ok
      && !Object.prototype.hasOwnProperty.call(converted.value, 'has_attachments'));
  }

  // ── Blocker 3: identity / dedup / order / tie-break / ImmutableId semantics ──
  {
    ok(
      'identity-tuple-keys-normative',
      Array.isArray(EMAIL_INBOUND_ENVELOPE_IDENTITY_KEYS)
        && EMAIL_INBOUND_ENVELOPE_IDENTITY_KEYS.join(',')
          === 'provider,provider_mailbox_id,provider_message_id',
    );
    ok(
      'order-direction-newest-first',
      EMAIL_INBOUND_ENVELOPE_ORDER_DIRECTION === 'received_at_desc',
    );
    ok(
      'tie-break-keys-deterministic',
      Array.isArray(EMAIL_INBOUND_ENVELOPE_TIE_BREAK_KEYS)
        && EMAIL_INBOUND_ENVELOPE_TIE_BREAK_KEYS.join(',')
          === 'provider,provider_mailbox_id,provider_message_id',
    );
    ok(
      'microsoft-durable-identity-requires-immutable-id',
      EMAIL_INBOUND_MICROSOFT_DURABLE_IDENTITY_REQUIRES_IMMUTABLE_ID === true,
    );
    ok(
      'mapper-does-not-claim-immutable-id-provenance',
      EMAIL_INBOUND_MICROSOFT_MAPPER_CLAIMS_IMMUTABLE_ID_PROVENANCE === false,
    );
    ok(
      'inbound-envelope-not-runtime-wired',
      EMAIL_INBOUND_ENVELOPE_RUNTIME_WIRED === false,
    );

    const a = validateInboundEmailEnvelope(validEnvelope({
      internet_message_id: '<same@example.com>',
    })).value;
    const b = validateInboundEmailEnvelope(validEnvelope({
      internet_message_id: '<other@example.com>',
    })).value;
    const c = validateInboundEmailEnvelope(validEnvelope({
      provider_message_id: 'OTHER-ID',
      internet_message_id: '<same@example.com>',
    })).value;
    const dNull = validateInboundEmailEnvelope(validEnvelope({
      internet_message_id: null,
    })).value;
    const eNull = validateInboundEmailEnvelope(validEnvelope({
      internet_message_id: null,
    })).value;

    const idA = inboundEmailEnvelopeIdentityTuple(a);
    ok('identity-tuple-excludes-internet-message-id', idA.ok
      && idA.value.provider === 'microsoft_graph'
      && idA.value.provider_mailbox_id === MAILBOX_ID
      && idA.value.provider_message_id === MSG_ID
      && idA.value.internet_message_id === undefined
      && Object.keys(idA.value).join(',') === EMAIL_INBOUND_ENVELOPE_IDENTITY_KEYS.join(','),
    ser(idA));

    ok('dedup-same-identity-different-internet-message-id',
      areInboundEmailEnvelopesDuplicate(a, b) === true);
    ok('dedup-different-identity-same-internet-message-id',
      areInboundEmailEnvelopesDuplicate(a, c) === false);
    ok('dedup-null-internet-message-id-same-identity',
      areInboundEmailEnvelopesDuplicate(dNull, eNull) === true);
    ok('dedup-null-internet-message-id-not-cross-identity',
      areInboundEmailEnvelopesDuplicate(dNull, c) === false);

    // Ordering: newer received_at first; equal received_at → identity tuple ASC tie-break.
    const older = validateInboundEmailEnvelope(validEnvelope({
      received_at: '2026-08-01T00:00:00.000Z',
      provider_message_id: 'ZZZ',
    })).value;
    const newer = validateInboundEmailEnvelope(validEnvelope({
      received_at: '2026-08-10T00:00:00.000Z',
      provider_message_id: 'AAA',
    })).value;
    const sameTsLow = validateInboundEmailEnvelope(validEnvelope({
      received_at: '2026-08-05T00:00:00.000Z',
      provider_message_id: 'AAA',
    })).value;
    const sameTsHigh = validateInboundEmailEnvelope(validEnvelope({
      received_at: '2026-08-05T00:00:00.000Z',
      provider_message_id: 'BBB',
    })).value;
    ok('order-newer-before-older',
      compareInboundEmailEnvelopesForOrder(newer, older) < 0
        && compareInboundEmailEnvelopesForOrder(older, newer) > 0);
    ok('order-tie-break-by-identity-asc',
      compareInboundEmailEnvelopesForOrder(sameTsLow, sameTsHigh) < 0
        && compareInboundEmailEnvelopesForOrder(sameTsHigh, sameTsLow) > 0);
    ok('order-equal-when-identity-and-time-equal',
      compareInboundEmailEnvelopesForOrder(a, b) === 0);
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
    ok('contract-documents-immutable-id-requirement',
      /ImmutableId/i.test(contractSrc)
        && /durable/i.test(contractSrc)
        && /persist/i.test(contractSrc));
    ok('contract-documents-identity-dedup-order',
      /identity/i.test(contractSrc)
        && /dedup/i.test(contractSrc)
        && /tie-?break/i.test(contractSrc)
        && /received_at_desc|newest/i.test(contractSrc));
    const mapperSrc = fs.readFileSync(MAPPER_PATH, 'utf8');
    ok('mapper-no-network', !/\bhttps?\.(request|get)\b/.test(mapperSrc)
      && !mapperSrc.includes('login.microsoftonline.com'));
    ok('mapper-discards-etag-comment', /etag/i.test(mapperSrc) && /discard/i.test(mapperSrc));
    ok('mapper-no-db', !/\brequire\(['"]pg['"]\)/.test(mapperSrc)
      && !/\bpostgres\b/i.test(mapperSrc)
      && !/\bINSERT\s+INTO\b/i.test(mapperSrc)
      && !/\bFROM\s+tenant_/i.test(mapperSrc));
    ok('mapper-no-immutable-id-provenance-claim',
      !/claims?\s+.*ImmutableId|ImmutableId.*proven/i.test(mapperSrc)
        || /does not claim|no.*ImmutableId provenance|not.*ImmutableId/i.test(mapperSrc));
    const adapterSrc = fs.readFileSync(
      path.join(ROOT, 'scripts/lib/email-microsoft-graph-adapter.js'),
      'utf8',
    );
    ok('adapter-classifies-legacy-transport-surface',
      /legacy_provider_transport_row_compatibility/.test(adapterSrc)
        && /canonical|inbound-envelope-contract/i.test(adapterSrc));
    ok('doc-classifies-canonical-vs-legacy-transport',
      /canonical/i.test(doc)
        && /legacy|transport.?row|compatibility/i.test(doc)
        && /ImmutableId/i.test(doc)
        && /identity/i.test(doc)
        && /dedup/i.test(doc));
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
