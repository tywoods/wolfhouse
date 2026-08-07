'use strict';

/**
 * verify:email-microsoft-graph-normalized-page — hostile offline gate.
 *
 * Offline Microsoft Graph page → max-5 canonical inbound envelopes bridge.
 * Reuses transport page/row semantics + inbound mapper/contract.
 * No network, routes, DB, OAuth, persistence, logging, or live Graph.
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
const BRIDGE_REL = 'scripts/lib/email-microsoft-graph-normalized-page.js';
const CONTRACT_REL = 'scripts/lib/email-inbound-envelope-contract.js';
const MAPPER_REL = 'scripts/lib/email-microsoft-graph-inbound-envelope-mapper.js';
const TRANSPORT_REL = 'scripts/lib/email-microsoft-graph-delegated-messages-transport.js';
const DOC_REL = 'docs/EMAIL-MAILBOX-ADAPTER-BOUNDARY.md';
const VERIFY_REL = 'scripts/verify-email-microsoft-graph-normalized-page.js';
const PKG_PATH = path.join(ROOT, 'package.json');
const DOC_PATH = path.join(ROOT, DOC_REL);
const BRIDGE_PATH = path.join(ROOT, BRIDGE_REL);
const CONTRACT_PATH = path.join(ROOT, CONTRACT_REL);
const MAPPER_PATH = path.join(ROOT, MAPPER_REL);
const TRANSPORT_PATH = path.join(ROOT, TRANSPORT_REL);

const PLANTED_BODY = 'BODY_MUST_NEVER_APPEAR_IN_PAGE_BRIDGE';
const PLANTED_TOKEN = 'ya29.NEVER_LEAK_PAGE_BRIDGE_TOKEN';
const PLANTED_NEXT = 'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=EVIL_NEXT';
const OVERSIZE = `x${'a'.repeat(3000)}`;
const VALID_ETAG = 'W/"CQAAABYAAABqZ1"';
const MAILBOX_ID = 'support@lunafrontdesk.com';
const MSG_A = 'AAMkAGI2-AAA';
const MSG_B = 'AAMkAGI2-BBB';
const MSG_C = 'AAMkAGI2-CCC';
const MSG_D = 'AAMkAGI2-DDD';
const MSG_E = 'AAMkAGI2-EEE';
const MSG_F = 'AAMkAGI2-FFF';

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
    && !s.includes('EVIL_NEXT')
    && !s.includes('client_secret=')
    && !s.includes('access_token')
    && !s.includes('@odata.nextLink')
    && !s.includes('@odata.context')
    && !s.includes('@odata.etag');
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
    throw new Error('NETWORK_FORBIDDEN_IN_NORMALIZED_PAGE_VERIFIER');
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
    id: MSG_A,
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

function pageOf(rows, extras = {}) {
  return {
    value: rows,
    ...extras,
  };
}

console.log('verify:email-microsoft-graph-normalized-page — RED→GREEN offline gate\n');
installNetworkGuards();

try {
  ok('bridge-file-exists', fs.existsSync(BRIDGE_PATH));
  ok('contract-file-exists', fs.existsSync(CONTRACT_PATH));
  ok('mapper-file-exists', fs.existsSync(MAPPER_PATH));
  ok('transport-file-exists', fs.existsSync(TRANSPORT_PATH));
  ok('doc-exists', fs.existsSync(DOC_PATH));

  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  const scripts = pkg.scripts || {};
  ok(
    'package-gate-registered',
    scripts['verify:email-microsoft-graph-normalized-page']
      === `node ${VERIFY_REL.replace(/\\/g, '/')}`,
  );
  ok(
    'package-gate-no-deploy',
    !/deploy|azure|az |graph\.microsoft|oauth/i.test(
      String(scripts['verify:email-microsoft-graph-normalized-page'] || ''),
    ),
  );

  const doc = fs.readFileSync(DOC_PATH, 'utf8');
  ok(
    'doc-mentions-normalized-page-bridge',
    /normalized.?page|page.?to.?canonical|graph.?normalized.?page/i.test(doc),
  );
  ok(
    'doc-non-persistence-ready-or-provenance',
    /non.?persistence.?ready|ImmutableId provenance|unforgeable|private boundar/i.test(doc),
  );
  ok(
    'doc-reuses-transport-and-mapper',
    /delegated.*transport|Mail\.ReadBasic/i.test(doc)
      && /inbound.?envelope.?mapper|mapMicrosoftGraph/i.test(doc),
  );

  let bridge;
  let contract;
  let mapper;
  let transport;
  try {
    bridge = require('./lib/email-microsoft-graph-normalized-page');
    contract = require('./lib/email-inbound-envelope-contract');
    mapper = require('./lib/email-microsoft-graph-inbound-envelope-mapper');
    transport = require('./lib/email-microsoft-graph-delegated-messages-transport');
    ok('modules-load', true);
  } catch (err) {
    ok('modules-load', false, String(err && err.message ? err.message : err));
    throw err;
  }

  const {
    mapMicrosoftGraphPageToInboundEnvelopes,
    GRAPH_IMMUTABLE_ID_PROVENANCE_UNAUTHENTICATED,
    EMAIL_MS_GRAPH_NORMALIZED_PAGE_PERSISTENCE_READY,
    EMAIL_MS_GRAPH_NORMALIZED_PAGE_CLAIMS_IMMUTABLE_ID_PROVENANCE,
    EMAIL_MS_GRAPH_NORMALIZED_PAGE_RUNTIME_WIRED,
    EMAIL_MS_GRAPH_NORMALIZED_PAGE_LOGGING_FORBIDDEN,
    EMAIL_MS_GRAPH_NORMALIZED_PAGE_MAX,
    EMAIL_MS_GRAPH_NORMALIZED_PAGE_SHARED_VALIDATOR_EXTRACTED,
  } = bridge;

  const {
    EMAIL_INBOUND_ENVELOPE_KEYS,
    compareInboundEmailEnvelopesForOrder,
    validateInboundEmailEnvelope,
    EMAIL_INBOUND_ENVELOPE_PERSISTENCE_FORBIDDEN,
    EMAIL_INBOUND_ENVELOPE_LOGGING_FORBIDDEN,
  } = contract;

  const {
    MICROSOFT_GRAPH_MAIL_READ_BASIC_SELECT_FIELDS,
    mapMicrosoftGraphMailReadBasicRowToInboundEnvelope,
  } = mapper;

  const {
    TOP_MAX,
    SELECT_FIELDS,
    classifyParsedMessageEnvelopeList,
  } = transport;

  // ── Flags / policy ──────────────────────────────────────────────────────
  ok(
    'max-is-transport-top-max',
    EMAIL_MS_GRAPH_NORMALIZED_PAGE_MAX === 5
      && EMAIL_MS_GRAPH_NORMALIZED_PAGE_MAX === TOP_MAX,
  );
  ok(
    'select-fields-match-transport-and-mapper',
    Array.isArray(SELECT_FIELDS)
      && Array.isArray(MICROSOFT_GRAPH_MAIL_READ_BASIC_SELECT_FIELDS)
      && SELECT_FIELDS.join(',') === MICROSOFT_GRAPH_MAIL_READ_BASIC_SELECT_FIELDS.join(',')
      && SELECT_FIELDS.join(',')
        === 'id,subject,from,receivedDateTime,isRead,conversationId,internetMessageId',
  );
  ok(
    'slice-not-persistence-ready',
    EMAIL_MS_GRAPH_NORMALIZED_PAGE_PERSISTENCE_READY === false
      && EMAIL_INBOUND_ENVELOPE_PERSISTENCE_FORBIDDEN === true,
  );
  ok(
    'slice-does-not-claim-immutable-id-provenance',
    EMAIL_MS_GRAPH_NORMALIZED_PAGE_CLAIMS_IMMUTABLE_ID_PROVENANCE === false,
  );
  ok(
    'slice-not-runtime-wired',
    EMAIL_MS_GRAPH_NORMALIZED_PAGE_RUNTIME_WIRED === false,
  );
  ok(
    'logging-forbidden',
    EMAIL_MS_GRAPH_NORMALIZED_PAGE_LOGGING_FORBIDDEN === true
      && EMAIL_INBOUND_ENVELOPE_LOGGING_FORBIDDEN === true,
  );
  ok(
    'no-shared-validator-extraction-broad-refactor',
    EMAIL_MS_GRAPH_NORMALIZED_PAGE_SHARED_VALIDATOR_EXTRACTED === false,
  );
  ok(
    'unauthenticated-provenance-token-is-frozen-object',
    GRAPH_IMMUTABLE_ID_PROVENANCE_UNAUTHENTICATED != null
      && typeof GRAPH_IMMUTABLE_ID_PROVENANCE_UNAUTHENTICATED === 'object'
      && Object.isFrozen(GRAPH_IMMUTABLE_ID_PROVENANCE_UNAUTHENTICATED),
  );

  function goodInput(patch = {}) {
    const base = {
      provider: 'microsoft_graph',
      provider_mailbox_id: MAILBOX_ID,
      page: pageOf([graphRow()]),
      graph_immutable_id_provenance: GRAPH_IMMUTABLE_ID_PROVENANCE_UNAUTHENTICATED,
    };
    return { ...base, ...patch };
  }

  // ── Happy path: single row → one canonical envelope ─────────────────────
  {
    const r = mapMicrosoftGraphPageToInboundEnvelopes(goodInput());
    ok('happy-single-ok', r && r.ok === true, ser(r));
    ok('happy-single-array-len-1', r.ok && Array.isArray(r.value) && r.value.length === 1, ser(r));
    ok('happy-single-frozen-array', r.ok && Object.isFrozen(r.value));
    ok('happy-single-frozen-envelope', r.ok && Object.isFrozen(r.value[0]));
    ok(
      'happy-single-canonical-keys',
      r.ok
        && Object.keys(r.value[0]).sort().join(',')
          === [...EMAIL_INBOUND_ENVELOPE_KEYS].sort().join(','),
      ser(r.ok ? r.value[0] : r),
    );
    ok(
      'happy-single-identity',
      r.ok
        && r.value[0].provider === 'microsoft_graph'
        && r.value[0].provider_mailbox_id === MAILBOX_ID
        && r.value[0].provider_message_id === MSG_A
        && r.value[0].sender_address === 'guest@example.com',
      ser(r),
    );
    const reval = validateInboundEmailEnvelope(r.value[0]);
    ok('happy-single-revalidates', reval.ok === true, ser(reval));
    ok('happy-single-no-raw-retention', r.ok && noLeak(r)
      && r.value[0].receivedDateTime === undefined
      && r.value[0].id === undefined
      && r.value[0].from === undefined
      && r.value[0].hasAttachments === undefined);
  }

  // ── Deterministic contract order (received_at desc, identity tie-break) ──
  {
    const rows = [
      graphRow({
        id: MSG_C,
        receivedDateTime: '2026-08-05T00:00:00Z',
        subject: 'mid-c',
      }),
      graphRow({
        id: MSG_A,
        receivedDateTime: '2026-08-10T00:00:00Z',
        subject: 'newest-a',
      }),
      graphRow({
        id: MSG_B,
        receivedDateTime: '2026-08-05T00:00:00Z',
        subject: 'mid-b',
      }),
      graphRow({
        id: MSG_D,
        receivedDateTime: '2026-08-01T00:00:00Z',
        subject: 'oldest-d',
      }),
    ];
    const r = mapMicrosoftGraphPageToInboundEnvelopes(goodInput({ page: pageOf(rows) }));
    ok('order-ok', r.ok === true && r.value.length === 4, ser(r));
    const ids = r.ok ? r.value.map((e) => e.provider_message_id) : [];
    // newest first; equal ts → identity ASC (MSG_B before MSG_C alphabetically? AAA < BBB < CCC)
    // MSG_A newest; MSG_B and MSG_C same day — B before C; MSG_D oldest
    ok(
      'order-deterministic-contract',
      ids.join(',') === [MSG_A, MSG_B, MSG_C, MSG_D].join(','),
      ids.join(','),
    );
    if (r.ok) {
      for (let i = 0; i < r.value.length - 1; i += 1) {
        ok(
          `order-adjacent-${i}`,
          compareInboundEmailEnvelopesForOrder(r.value[i], r.value[i + 1]) <= 0,
        );
      }
    }
  }

  // ── Max 5: exactly 5 ok; 6 fails closed ─────────────────────────────────
  {
    const five = [MSG_A, MSG_B, MSG_C, MSG_D, MSG_E].map((id, i) => graphRow({
      id,
      receivedDateTime: `2026-08-0${i + 1}T00:00:00Z`,
    }));
    const r5 = mapMicrosoftGraphPageToInboundEnvelopes(goodInput({ page: pageOf(five) }));
    ok('max-five-ok', r5.ok === true && r5.value.length === 5, ser(r5));

    const six = five.concat([graphRow({ id: MSG_F, receivedDateTime: '2026-08-06T00:00:00Z' })]);
    const r6 = mapMicrosoftGraphPageToInboundEnvelopes(goodInput({ page: pageOf(six) }));
    ok('max-six-fail-closed', r6.ok === false && noLeak(r6), ser(r6));
  }

  // ── Empty page ok ───────────────────────────────────────────────────────
  {
    const r = mapMicrosoftGraphPageToInboundEnvelopes(goodInput({ page: pageOf([]) }));
    ok('empty-page-ok', r.ok === true && Array.isArray(r.value) && r.value.length === 0, ser(r));
    ok('empty-page-frozen', r.ok && Object.isFrozen(r.value));
  }

  // ── Validate/discard context, nextLink, etag — never retain ─────────────
  {
    const withMeta = pageOf(
      [graphRow({ id: MSG_A, '@odata.etag': VALID_ETAG })],
      {
        '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#users(\'x\')/messages',
        '@odata.nextLink': PLANTED_NEXT,
      },
    );
    // nextLink must pass transport validator (https graph.microsoft.com messages path)
    const classified = classifyParsedMessageEnvelopeList(withMeta);
    ok(
      'transport-accepts-page-with-context-nextlink-etag',
      classified.stage === 'success' && classified.count === 1,
      ser(classified),
    );
    const r = mapMicrosoftGraphPageToInboundEnvelopes(goodInput({ page: withMeta }));
    ok('page-meta-ok', r.ok === true && r.value.length === 1, ser(r));
    ok('page-meta-no-leak-nextlink-etag-context', r.ok && noLeak(r) && noLeak(r.value), ser(r));
    ok(
      'page-meta-no-odata-keys-on-envelope',
      r.ok
        && !Object.keys(r.value[0]).some((k) => k.includes('@odata') || k.includes('etag')),
      ser(r.ok ? Object.keys(r.value[0]) : r),
    );
  }

  // ── Invalid nextLink fails (reuse transport semantics) ──────────────────
  {
    const badNext = pageOf([graphRow()], {
      '@odata.nextLink': 'https://evil.example/steal',
    });
    const r = mapMicrosoftGraphPageToInboundEnvelopes(goodInput({ page: badNext }));
    ok('bad-nextlink-fail', r.ok === false && noLeak(r), ser(r));
  }

  // ── Provenance: must be explicit; never trust caller boolean/string ──────
  {
    const missing = mapMicrosoftGraphPageToInboundEnvelopes({
      provider: 'microsoft_graph',
      provider_mailbox_id: MAILBOX_ID,
      page: pageOf([graphRow()]),
    });
    ok('provenance-missing-fail', missing.ok === false && noLeak(missing), ser(missing));

    for (const [label, forged] of [
      ['boolean-true', true],
      ['boolean-false', false],
      ['string-ImmutableId', 'ImmutableId'],
      ['string-true', 'true'],
      ['plain-object-proven', { proven: true, kind: 'ImmutableId' }],
      ['null', null],
      ['number-1', 1],
      ['forged-lookalike', Object.freeze({ kind: 'unauthenticated' })],
      ['array', []],
    ]) {
      const r = mapMicrosoftGraphPageToInboundEnvelopes(goodInput({
        graph_immutable_id_provenance: forged,
      }));
      ok(
        `provenance-forged-${label}-fail`,
        r.ok === false && noLeak(r),
        ser(r),
      );
    }

    // Module-owned unauthenticated token is the only offline success path.
    const authed = mapMicrosoftGraphPageToInboundEnvelopes(goodInput({
      graph_immutable_id_provenance: GRAPH_IMMUTABLE_ID_PROVENANCE_UNAUTHENTICATED,
    }));
    ok('provenance-unauthenticated-token-ok', authed.ok === true, ser(authed));

    // Fresh object with same shape as token must not pass (reference equality).
    const clone = Object.freeze(Object.assign(
      Object.create(Object.getPrototypeOf(GRAPH_IMMUTABLE_ID_PROVENANCE_UNAUTHENTICATED)),
      GRAPH_IMMUTABLE_ID_PROVENANCE_UNAUTHENTICATED,
    ));
    const cloneFail = mapMicrosoftGraphPageToInboundEnvelopes(goodInput({
      graph_immutable_id_provenance: clone,
    }));
    ok(
      'provenance-clone-not-reference-fail',
      cloneFail.ok === false || clone === GRAPH_IMMUTABLE_ID_PROVENANCE_UNAUTHENTICATED,
      ser(cloneFail),
    );
  }

  // ── Mailbox identity required; never inferred from page ─────────────────
  {
    const missingMb = mapMicrosoftGraphPageToInboundEnvelopes({
      provider: 'microsoft_graph',
      page: pageOf([graphRow()]),
      graph_immutable_id_provenance: GRAPH_IMMUTABLE_ID_PROVENANCE_UNAUTHENTICATED,
    });
    ok('mailbox-missing-fail', missingMb.ok === false && noLeak(missingMb), ser(missingMb));

    const emptyMb = mapMicrosoftGraphPageToInboundEnvelopes(goodInput({
      provider_mailbox_id: '',
    }));
    ok('mailbox-empty-fail', emptyMb.ok === false, ser(emptyMb));

    const overMb = mapMicrosoftGraphPageToInboundEnvelopes(goodInput({
      provider_mailbox_id: OVERSIZE,
    }));
    ok('mailbox-oversize-fail', overMb.ok === false && noLeak(overMb), ser(overMb));

    const otherMb = mapMicrosoftGraphPageToInboundEnvelopes(goodInput({
      provider_mailbox_id: 'other@lunafrontdesk.com',
    }));
    ok(
      'mailbox-explicit-not-inferred',
      otherMb.ok === true
        && otherMb.value[0].provider_mailbox_id === 'other@lunafrontdesk.com',
      ser(otherMb),
    );
  }

  // ── Provider must be microsoft_graph ────────────────────────────────────
  {
    for (const p of ['gmail_api', 'imap_smtp', 'evil', '', null, 1]) {
      const r = mapMicrosoftGraphPageToInboundEnvelopes(goodInput({ provider: p }));
      ok(`provider-reject-${String(p)}`, r.ok === false && noLeak(r), ser(r));
    }
  }

  // ── Input keyset exact; hostile extras fail ─────────────────────────────
  {
    const extra = mapMicrosoftGraphPageToInboundEnvelopes({
      ...goodInput(),
      access_token: PLANTED_TOKEN,
    });
    ok('input-extra-key-fail', extra.ok === false && noLeak(extra), ser(extra));

    const symbolKey = {};
    Object.defineProperty(symbolKey, 'provider', { value: 'microsoft_graph', enumerable: true });
    Object.defineProperty(symbolKey, 'provider_mailbox_id', {
      value: MAILBOX_ID,
      enumerable: true,
    });
    Object.defineProperty(symbolKey, 'page', {
      value: pageOf([graphRow()]),
      enumerable: true,
    });
    Object.defineProperty(symbolKey, 'graph_immutable_id_provenance', {
      value: GRAPH_IMMUTABLE_ID_PROVENANCE_UNAUTHENTICATED,
      enumerable: true,
    });
    Object.defineProperty(symbolKey, Symbol('evil'), {
      value: PLANTED_TOKEN,
      enumerable: true,
    });
    const sym = mapMicrosoftGraphPageToInboundEnvelopes(symbolKey);
    ok('input-symbol-key-fail', sym.ok === false && noLeak(sym), ser(sym));
  }

  // ── Accessors / non-enumerable / proxy fail closed ──────────────────────
  {
    const withGetter = {};
    for (const [k, v] of Object.entries({
      provider: 'microsoft_graph',
      provider_mailbox_id: MAILBOX_ID,
      page: pageOf([graphRow()]),
      graph_immutable_id_provenance: GRAPH_IMMUTABLE_ID_PROVENANCE_UNAUTHENTICATED,
    })) {
      Object.defineProperty(withGetter, k, {
        get() { return v; },
        enumerable: true,
      });
    }
    const g = mapMicrosoftGraphPageToInboundEnvelopes(withGetter);
    ok('input-accessor-fail', g.ok === false && noLeak(g), ser(g));

    if (typeof util.types.isProxy === 'function') {
      const proxied = new Proxy(goodInput(), {
        get(t, p) { return Reflect.get(t, p); },
      });
      const p = mapMicrosoftGraphPageToInboundEnvelopes(proxied);
      ok('input-proxy-fail', p.ok === false && noLeak(p), ser(p));
    }
  }

  // ── Bad page shapes / rows fail closed (no partial envelopes) ───────────
  {
    const cases = [
      ['not-object', null],
      ['array-page', [graphRow()]],
      ['missing-value', { '@odata.context': 'x' }],
      ['extra-key', { value: [graphRow()], deltaLink: 'x' }],
      ['row-hasAttachments', pageOf([{ ...graphRow(), hasAttachments: true }])],
      ['row-body', pageOf([{ ...graphRow(), body: { content: PLANTED_BODY } }])],
      ['row-missing-id', pageOf([{ ...graphRow(), id: undefined }].map((row) => {
        const r = { ...row };
        delete r.id;
        return r;
      }))],
      ['row-bad-isRead', pageOf([graphRow({ isRead: 'false' })])],
      ['row-etag-invalid', pageOf([graphRow({ '@odata.etag': '' })])],
    ];
    for (const [label, page] of cases) {
      const r = mapMicrosoftGraphPageToInboundEnvelopes(goodInput({ page }));
      ok(`page-shape-${label}-fail`, r.ok === false && noLeak(r), ser(r));
    }

    // Partial poison: one good + one bad → whole page fails, no partial list.
    const partial = pageOf([
      graphRow({ id: MSG_A }),
      { ...graphRow({ id: MSG_B }), body: { content: PLANTED_BODY } },
    ]);
    const pr = mapMicrosoftGraphPageToInboundEnvelopes(goodInput({ page: partial }));
    ok(
      'partial-poison-no-envelopes',
      pr.ok === false && noLeak(pr)
        && !(pr.value && Array.isArray(pr.value) && pr.value.length > 0),
      ser(pr),
    );
  }

  // ── Mapper reuse: same row mapping as single-row mapper ─────────────────
  {
    const row = graphRow({
      id: MSG_B,
      subject: 'Mapped subject',
      receivedDateTime: '2026-07-01T15:30:00+02:00',
    });
    const single = mapMicrosoftGraphMailReadBasicRowToInboundEnvelope({
      provider: 'microsoft_graph',
      provider_mailbox_id: MAILBOX_ID,
      row,
    });
    const page = mapMicrosoftGraphPageToInboundEnvelopes(goodInput({
      page: pageOf([row]),
    }));
    ok('mapper-reuse-ok', single.ok && page.ok && page.value.length === 1, ser({ single, page }));
    ok(
      'mapper-reuse-byte-equal-envelope',
      single.ok && page.ok
        && ser(single.value) === ser(page.value[0]),
      `single=${ser(single.value)} page=${ser(page.ok ? page.value[0] : page)}`,
    );
  }

  // ── No raw page/rows retained on success object ─────────────────────────
  {
    const page = pageOf([graphRow({ subject: PLANTED_BODY })]);
    const r = mapMicrosoftGraphPageToInboundEnvelopes(goodInput({ page }));
    ok('success-has-no-page-key', r.ok && r.page === undefined && r.rows === undefined);
    // subject is domain PII and may appear on envelope — planted body as subject is domain data.
    // Ensure OData/raw Graph keys and nextLink never appear on success surface.
    ok(
      'success-surface-keys-allowlisted',
      r.ok
        && Object.keys(r).sort().join(',') === 'ok,value'
        && Object.keys(r.value[0]).every((k) => EMAIL_INBOUND_ENVELOPE_KEYS.includes(k)),
      ser(Object.keys(r)),
    );
  }

  // ── Source static checks ────────────────────────────────────────────────
  {
    const bridgeSrc = fs.readFileSync(BRIDGE_PATH, 'utf8');
    ok(
      'bridge-requires-contract-mapper-transport',
      /email-inbound-envelope-contract/.test(bridgeSrc)
        && /email-microsoft-graph-inbound-envelope-mapper/.test(bridgeSrc)
        && /email-microsoft-graph-delegated-messages-transport/.test(bridgeSrc),
    );
    ok(
      'bridge-uses-classify-or-transport-page-semantics',
      /classifyParsedMessageEnvelopeList|acceptParsedMessageEnvelopeList/.test(bridgeSrc),
    );
    ok(
      'bridge-uses-mapper-function',
      /mapMicrosoftGraphMailReadBasicRowToInboundEnvelope/.test(bridgeSrc),
    );
    ok(
      'bridge-uses-contract-order',
      /compareInboundEmailEnvelopesForOrder/.test(bridgeSrc),
    );
    ok(
      'bridge-no-network',
      !/\bhttps?\.(request|get)\b/.test(bridgeSrc)
        && !bridgeSrc.includes('login.microsoftonline.com')
        && !/createMicrosoftGraphDelegatedMessagesTransport/.test(bridgeSrc),
    );
    ok(
      'bridge-no-db',
      !/\brequire\(['"]pg['"]\)/.test(bridgeSrc)
        && !/\bINSERT\s+INTO\b/i.test(bridgeSrc)
        && !/\bFROM\s+tenant_/i.test(bridgeSrc),
    );
    ok(
      'bridge-no-console-log',
      !/\bconsole\.(log|info|debug|warn|error)\b/.test(bridgeSrc),
    );
    ok(
      'bridge-documents-no-broad-validator-extraction',
      /SHARED_VALIDATOR_EXTRACTED\s*=\s*false|without broad refactor|no.*extract/i.test(bridgeSrc),
    );
    ok(
      'bridge-rejects-caller-boolean-provenance',
      /boolean|string|forge|reference|unforgeable|WeakMap|UNAUTHENTICATED/i.test(bridgeSrc),
    );
    ok(
      'bridge-does-not-claim-immutable-when-unauthenticated',
      /CLAIMS_IMMUTABLE_ID_PROVENANCE\s*=\s*false|does not claim|non-persistence/i.test(bridgeSrc),
    );

    // Must not invent a second envelope DTO key set.
    ok(
      'bridge-no-competing-envelope-dto-keys',
      !/ENVELOPE_DTO_KEYS\s*=/.test(bridgeSrc)
        && !/from_address/.test(bridgeSrc)
        && !/has_attachments/.test(bridgeSrc),
    );
  }

  ok('no-network-hits', networkHits === 0, `hits=${networkHits}`);
  ok('nodejs-isProxy-available', typeof util.types.isProxy === 'function');
} catch (err) {
  ok('verifier-uncaught', false, String(err && err.stack ? err.stack : err));
} finally {
  restoreNetworkGuards();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
