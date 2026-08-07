'use strict';

/**
 * verify:email-inbound-batch-processor — offline hostile gate.
 *
 * Provider-neutral inbound batch processor over canonical envelopes only.
 * No network, routes, DB, OAuth, persistence, logging, or live provider I/O.
 * Prefer observable behavior over source-regex inflation.
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
const PROCESSOR_REL = 'scripts/lib/email-inbound-batch-processor.js';
const CONTRACT_REL = 'scripts/lib/email-inbound-envelope-contract.js';
const DOC_REL = 'docs/EMAIL-MAILBOX-ADAPTER-BOUNDARY.md';
const VERIFY_REL = 'scripts/verify-email-inbound-batch-processor.js';
const PKG_PATH = path.join(ROOT, 'package.json');
const DOC_PATH = path.join(ROOT, DOC_REL);
const PROCESSOR_PATH = path.join(ROOT, PROCESSOR_REL);
const CONTRACT_PATH = path.join(ROOT, CONTRACT_REL);

const PLANTED_BODY = 'BODY_MUST_NEVER_APPEAR_IN_BATCH_PROCESSOR';
const PLANTED_TOKEN = 'ya29.NEVER_LEAK_BATCH_PROCESSOR_TOKEN';
const PLANTED_SUBJECT = 'SUBJECT_PII_MUST_NOT_APPEAR_ON_RESULT';
const PLANTED_MSG = 'MSG_ID_MUST_NOT_APPEAR_ON_RESULT';
const PLANTED_MAILBOX = 'mailbox-pii@example.com';
const OVERSIZE = `x${'a'.repeat(3000)}`;
const MAILBOX_ID = 'support@lunafrontdesk.com';
const MSG_A = 'AAMkAGI2-AAA';
const MSG_B = 'AAMkAGI2-BBB';
const MSG_C = 'AAMkAGI2-CCC';
const MSG_D = 'AAMkAGI2-DDD';

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
    && !s.includes(PLANTED_SUBJECT)
    && !s.includes(PLANTED_MSG)
    && !s.includes(PLANTED_MAILBOX)
    && !s.includes('client_secret=')
    && !s.includes('access_token')
    && !s.includes('Authorization');
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
    throw new Error('NETWORK_FORBIDDEN_IN_INBOUND_BATCH_PROCESSOR_VERIFIER');
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

function validEnvelope(patch = {}) {
  return {
    provider: 'microsoft_graph',
    provider_mailbox_id: MAILBOX_ID,
    provider_message_id: MSG_A,
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

function ackConsumer() {
  return async function consumer() {
    return { acknowledged: true };
  };
}

function trackingConsumer() {
  const state = {
    calls: 0,
    lastEnvelopes: null,
    lastFrozen: false,
  };
  const consumer = async function consumer(envelopes) {
    state.calls += 1;
    state.lastEnvelopes = envelopes;
    state.lastFrozen = Object.isFrozen(envelopes)
      && (!envelopes.length || Object.isFrozen(envelopes[0]));
    return { acknowledged: true };
  };
  return { consumer, state };
}

console.log('verify:email-inbound-batch-processor — RED→GREEN offline gate\n');
installNetworkGuards();

(async () => {
  try {
    ok('processor-file-exists', fs.existsSync(PROCESSOR_PATH));
    ok('contract-file-exists', fs.existsSync(CONTRACT_PATH));
    ok('doc-exists', fs.existsSync(DOC_PATH));

    const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
    const scripts = pkg.scripts || {};
    ok(
      'package-gate-registered',
      scripts['verify:email-inbound-batch-processor']
        === `node ${VERIFY_REL.replace(/\\/g, '/')}`,
    );
    ok(
      'package-gate-no-deploy',
      !/deploy|azure|az |graph\.microsoft|oauth/i.test(
        String(scripts['verify:email-inbound-batch-processor'] || ''),
      ),
    );

    const doc = fs.readFileSync(DOC_PATH, 'utf8');
    ok(
      'doc-mentions-inbound-batch-processor',
      /inbound.?batch.?processor|email-inbound-batch-processor/i.test(doc),
    );
    ok(
      'doc-mentions-consumer-loan-contract',
      /non.?retention|no.?log|no.?persist|consumer/i.test(doc)
        && /all-or-nothing|validate entire batch|within.?batch/i.test(doc),
    );
    ok(
      'doc-no-durable-idempotency-claim',
      /not.*durable|no durable|idempotency.?claim.*false|within this batch only/i.test(doc),
    );

    let processor;
    let contract;
    try {
      processor = require('./lib/email-inbound-batch-processor');
      contract = require('./lib/email-inbound-envelope-contract');
      ok('modules-load', true);
    } catch (err) {
      ok('modules-load', false, String(err && err.message ? err.message : err));
      throw err;
    }

    const {
      processInboundEmailBatch,
      EMAIL_INBOUND_BATCH_MAX,
      EMAIL_INBOUND_BATCH_PROCESSOR_RUNTIME_WIRED,
      EMAIL_INBOUND_BATCH_PROCESSOR_PERSISTENCE_FORBIDDEN,
      EMAIL_INBOUND_BATCH_PROCESSOR_LOGGING_FORBIDDEN,
      EMAIL_INBOUND_BATCH_PROCESSOR_DURABLE_IDEMPOTENCY_CLAIM,
      EMAIL_INBOUND_BATCH_CONSUMER_NON_RETENTION,
      EMAIL_INBOUND_BATCH_CONSUMER_NO_LOG,
      EMAIL_INBOUND_BATCH_CONSUMER_NO_PERSIST,
    } = processor;

    const {
      EMAIL_INBOUND_ENVELOPE_KEYS,
      validateInboundEmailEnvelope,
      compareInboundEmailEnvelopesForOrder,
      inboundEmailEnvelopeIdentityTuple,
      EMAIL_INBOUND_ENVELOPE_PERSISTENCE_FORBIDDEN,
      EMAIL_INBOUND_ENVELOPE_LOGGING_FORBIDDEN,
    } = contract;

    // ── Flags / policy ────────────────────────────────────────────────────
    ok(
      'batch-max-bounded',
      Number.isInteger(EMAIL_INBOUND_BATCH_MAX)
        && EMAIL_INBOUND_BATCH_MAX >= 5
        && EMAIL_INBOUND_BATCH_MAX <= 50,
    );
    ok(
      'not-runtime-wired',
      EMAIL_INBOUND_BATCH_PROCESSOR_RUNTIME_WIRED === false,
    );
    ok(
      'persistence-forbidden',
      EMAIL_INBOUND_BATCH_PROCESSOR_PERSISTENCE_FORBIDDEN === true
        && EMAIL_INBOUND_ENVELOPE_PERSISTENCE_FORBIDDEN === true,
    );
    ok(
      'logging-forbidden',
      EMAIL_INBOUND_BATCH_PROCESSOR_LOGGING_FORBIDDEN === true
        && EMAIL_INBOUND_ENVELOPE_LOGGING_FORBIDDEN === true,
    );
    ok(
      'no-durable-idempotency-claim',
      EMAIL_INBOUND_BATCH_PROCESSOR_DURABLE_IDEMPOTENCY_CLAIM === false,
    );
    ok(
      'consumer-loan-flags',
      EMAIL_INBOUND_BATCH_CONSUMER_NON_RETENTION === true
        && EMAIL_INBOUND_BATCH_CONSUMER_NO_LOG === true
        && EMAIL_INBOUND_BATCH_CONSUMER_NO_PERSIST === true,
    );
    ok(
      'process-is-async-function',
      typeof processInboundEmailBatch === 'function'
        && processInboundEmailBatch.constructor.name === 'AsyncFunction',
    );

    // ── Happy path: single envelope ───────────────────────────────────────
    {
      const { consumer, state } = trackingConsumer();
      const r = await processInboundEmailBatch({
        envelopes: [validEnvelope({ subject: PLANTED_SUBJECT, provider_message_id: PLANTED_MSG })],
        consumer,
      });
      ok('happy-single-ok', r && r.ok === true, ser(r));
      ok(
        'happy-single-identity-free-counts',
        r.ok
          && r.value.status === 'processed'
          && r.value.input_count === 1
          && r.value.delivered_count === 1
          && r.value.duplicate_count === 0,
        ser(r),
      );
      ok(
        'happy-single-frozen-result',
        r.ok && Object.isFrozen(r) && Object.isFrozen(r.value),
      );
      ok(
        'happy-single-result-keys-allowlisted',
        r.ok
          && Object.keys(r.value).sort().join(',')
            === ['delivered_count', 'duplicate_count', 'input_count', 'status'].sort().join(','),
        ser(r.ok ? Object.keys(r.value) : r),
      );
      ok(
        'happy-single-no-pii-ids-envelopes-on-result',
        r.ok
          && noLeak(r)
          && r.value.envelopes === undefined
          && r.value.provider === undefined
          && r.value.provider_mailbox_id === undefined
          && r.value.provider_message_id === undefined
          && r.value.subject === undefined,
        ser(r),
      );
      ok('happy-single-consumer-once', state.calls === 1, String(state.calls));
      ok(
        'happy-single-consumer-fresh-frozen',
        state.calls === 1
          && state.lastFrozen
          && Array.isArray(state.lastEnvelopes)
          && state.lastEnvelopes.length === 1
          && state.lastEnvelopes[0].provider_message_id === PLANTED_MSG,
        ser(state.lastEnvelopes && state.lastEnvelopes[0]),
      );
      const reval = validateInboundEmailEnvelope(state.lastEnvelopes[0]);
      ok('happy-single-loaned-revalidates', reval.ok === true, ser(reval));
      ok(
        'happy-single-loaned-canonical-keys',
        reval.ok
          && Object.keys(reval.value).sort().join(',')
            === [...EMAIL_INBOUND_ENVELOPE_KEYS].sort().join(','),
      );
    }

    // ── Empty batch: still one consumer call, zero counts ─────────────────
    {
      const { consumer, state } = trackingConsumer();
      const r = await processInboundEmailBatch({ envelopes: [], consumer });
      ok('empty-ok', r.ok === true && r.value.input_count === 0
        && r.value.delivered_count === 0 && r.value.duplicate_count === 0, ser(r));
      ok('empty-consumer-once', state.calls === 1 && state.lastEnvelopes
        && state.lastEnvelopes.length === 0 && Object.isFrozen(state.lastEnvelopes));
    }

    // ── Deterministic canonical sort before consumer ──────────────────────
    {
      const { consumer, state } = trackingConsumer();
      const envelopes = [
        validEnvelope({
          provider_message_id: MSG_C,
          received_at: '2026-08-05T00:00:00.000Z',
        }),
        validEnvelope({
          provider_message_id: MSG_A,
          received_at: '2026-08-10T00:00:00.000Z',
        }),
        validEnvelope({
          provider_message_id: MSG_B,
          received_at: '2026-08-05T00:00:00.000Z',
        }),
        validEnvelope({
          provider_message_id: MSG_D,
          received_at: '2026-08-01T00:00:00.000Z',
        }),
      ];
      const r = await processInboundEmailBatch({ envelopes, consumer });
      ok('order-ok', r.ok === true && r.value.delivered_count === 4, ser(r));
      const ids = state.lastEnvelopes
        ? state.lastEnvelopes.map((e) => e.provider_message_id)
        : [];
      ok(
        'order-deterministic-contract',
        ids.join(',') === [MSG_A, MSG_B, MSG_C, MSG_D].join(','),
        ids.join(','),
      );
      if (state.lastEnvelopes) {
        for (let i = 0; i < state.lastEnvelopes.length - 1; i += 1) {
          ok(
            `order-adjacent-${i}`,
            compareInboundEmailEnvelopesForOrder(
              state.lastEnvelopes[i],
              state.lastEnvelopes[i + 1],
            ) <= 0,
          );
        }
      }
    }

    // ── Within-batch dedup by identity tuple only ─────────────────────────
    {
      const { consumer, state } = trackingConsumer();
      const envelopes = [
        validEnvelope({
          provider_message_id: MSG_A,
          received_at: '2026-08-06T12:00:00.000Z',
          subject: 'first-copy',
        }),
        validEnvelope({
          provider_message_id: MSG_B,
          received_at: '2026-08-07T12:00:00.000Z',
          subject: 'unique-b',
        }),
        validEnvelope({
          provider_message_id: MSG_A,
          received_at: '2026-08-06T12:00:00.000Z',
          subject: 'dup-copy',
          internet_message_id: '<other@example.com>',
        }),
      ];
      const r = await processInboundEmailBatch({ envelopes, consumer });
      ok(
        'dedup-counts',
        r.ok
          && r.value.input_count === 3
          && r.value.delivered_count === 2
          && r.value.duplicate_count === 1,
        ser(r),
      );
      ok('dedup-consumer-once', state.calls === 1);
      const ids = state.lastEnvelopes
        ? state.lastEnvelopes.map((e) => e.provider_message_id)
        : [];
      ok(
        'dedup-keeps-unique-identities',
        ids.includes(MSG_A) && ids.includes(MSG_B) && ids.length === 2,
        ids.join(','),
      );
      // internet_message_id is metadata only — does not create separate identity.
      const idA = inboundEmailEnvelopeIdentityTuple(state.lastEnvelopes.find(
        (e) => e.provider_message_id === MSG_A,
      ));
      ok('dedup-identity-tuple-ok', idA.ok === true, ser(idA));
    }

    // ── Same internet_message_id on distinct provider ids is NOT a dedup ──
    {
      const { consumer, state } = trackingConsumer();
      const envelopes = [
        validEnvelope({
          provider_message_id: MSG_A,
          internet_message_id: '<shared@example.com>',
        }),
        validEnvelope({
          provider_message_id: MSG_B,
          internet_message_id: '<shared@example.com>',
        }),
      ];
      const r = await processInboundEmailBatch({ envelopes, consumer });
      ok(
        'imid-not-dedup-key',
        r.ok && r.value.delivered_count === 2 && r.value.duplicate_count === 0,
        ser(r),
      );
      ok('imid-not-dedup-delivered-two', state.lastEnvelopes
        && state.lastEnvelopes.length === 2);
    }

    // ── Mixed provider / mailbox prefix → fail; no consumer ───────────────
    {
      const { consumer, state } = trackingConsumer();
      const mixedProvider = await processInboundEmailBatch({
        envelopes: [
          validEnvelope({ provider: 'microsoft_graph' }),
          validEnvelope({ provider: 'gmail_api', provider_message_id: MSG_B }),
        ],
        consumer,
      });
      ok(
        'mixed-provider-fail',
        mixedProvider.ok === false && noLeak(mixedProvider) && state.calls === 0,
        ser(mixedProvider),
      );

      const mixedMailbox = await processInboundEmailBatch({
        envelopes: [
          validEnvelope({ provider_mailbox_id: MAILBOX_ID }),
          validEnvelope({
            provider_mailbox_id: PLANTED_MAILBOX,
            provider_message_id: MSG_B,
            subject: PLANTED_SUBJECT,
          }),
        ],
        consumer,
      });
      ok(
        'mixed-mailbox-fail-no-consumer-no-leak',
        mixedMailbox.ok === false
          && state.calls === 0
          && noLeak(mixedMailbox),
        ser(mixedMailbox),
      );
    }

    // ── Malformed envelope → fail whole batch; no consumer ────────────────
    {
      const { consumer, state } = trackingConsumer();
      const cases = [
        ['missing-provider', { ...validEnvelope(), provider: undefined }],
        ['bad-timestamp', validEnvelope({ received_at: 'not-an-instant' })],
        ['extra-key', { ...validEnvelope(), body: PLANTED_BODY }],
        ['oversize-subject', validEnvelope({ subject: OVERSIZE })],
        ['null-envelope', null],
        ['string-envelope', 'evil'],
      ];
      // Clean missing-provider case properly (delete key).
      const missing = validEnvelope();
      delete missing.provider;
      cases[0][1] = missing;

      for (const [label, env] of cases) {
        state.calls = 0;
        const r = await processInboundEmailBatch({
          envelopes: [validEnvelope({ provider_message_id: MSG_B }), env],
          consumer,
        });
        ok(
          `malformed-${label}-fail-no-consumer`,
          r.ok === false && state.calls === 0 && noLeak(r),
          ser(r),
        );
      }
    }

    // ── Proxy / accessor / symbol / non-enumerable / inherited input ───────
    {
      const { consumer, state } = trackingConsumer();

      if (typeof util.types.isProxy === 'function') {
        const proxied = new Proxy({
          envelopes: [validEnvelope()],
          consumer,
        }, {
          get(t, p) { return Reflect.get(t, p); },
        });
        const r = await processInboundEmailBatch(proxied);
        ok(
          'input-proxy-fail-no-consumer',
          r.ok === false && state.calls === 0 && noLeak(r),
          ser(r),
        );
      }

      const withGetter = {};
      Object.defineProperty(withGetter, 'envelopes', {
        get() { return [validEnvelope()]; },
        enumerable: true,
      });
      Object.defineProperty(withGetter, 'consumer', {
        value: consumer,
        enumerable: true,
      });
      const g = await processInboundEmailBatch(withGetter);
      ok(
        'input-accessor-fail-no-consumer',
        g.ok === false && state.calls === 0 && noLeak(g),
        ser(g),
      );

      const withSymbol = {
        envelopes: [validEnvelope()],
        consumer,
      };
      Object.defineProperty(withSymbol, Symbol('evil'), {
        value: PLANTED_TOKEN,
        enumerable: true,
      });
      const s = await processInboundEmailBatch(withSymbol);
      ok(
        'input-symbol-fail-no-consumer',
        s.ok === false && state.calls === 0 && noLeak(s),
        ser(s),
      );

      const withNonEnum = {
        envelopes: [validEnvelope()],
        consumer,
      };
      Object.defineProperty(withNonEnum, 'hidden', {
        value: PLANTED_TOKEN,
        enumerable: false,
      });
      // Non-enumerable extra key on an otherwise valid input: snapshot rejects.
      const ne = await processInboundEmailBatch(withNonEnum);
      ok(
        'input-nonenumerable-fail-no-consumer',
        ne.ok === false && state.calls === 0 && noLeak(ne),
        ser(ne),
      );

      // Inherited consumer / envelopes must not be honored.
      const proto = {
        envelopes: [validEnvelope()],
        consumer,
      };
      const inherited = Object.create(proto);
      const inh = await processInboundEmailBatch(inherited);
      ok(
        'input-inherited-fail-no-consumer',
        inh.ok === false && state.calls === 0 && noLeak(inh),
        ser(inh),
      );

      // Proxy envelope array rejected.
      if (typeof util.types.isProxy === 'function') {
        state.calls = 0;
        const proxyArr = new Proxy([validEnvelope()], {
          get(t, p) { return Reflect.get(t, p); },
        });
        const pa = await processInboundEmailBatch({
          envelopes: proxyArr,
          consumer,
        });
        ok(
          'envelopes-proxy-array-fail-no-consumer',
          pa.ok === false && state.calls === 0 && noLeak(pa),
          ser(pa),
        );
      }

      // Accessor on envelope element rejected via canonical validate path.
      state.calls = 0;
      const accessorEnv = {};
      for (const [k, v] of Object.entries(validEnvelope())) {
        Object.defineProperty(accessorEnv, k, {
          get() { return v; },
          enumerable: true,
        });
      }
      const ae = await processInboundEmailBatch({
        envelopes: [accessorEnv],
        consumer,
      });
      ok(
        'envelope-accessor-fail-no-consumer',
        ae.ok === false && state.calls === 0 && noLeak(ae),
        ser(ae),
      );
    }

    // ── Consumer result fail-closed; input already validated ──────────────
    {
      const badAcks = [
        ['missing', undefined],
        ['null', null],
        ['false-ack', { acknowledged: false }],
        ['extra-key', { acknowledged: true, token: PLANTED_TOKEN }],
        ['string', 'acknowledged'],
        ['empty-object', {}],
        ['accessor-ack', (() => {
          const o = {};
          Object.defineProperty(o, 'acknowledged', {
            get() { return true; },
            enumerable: true,
          });
          return o;
        })()],
      ];
      for (const [label, result] of badAcks) {
        const r = await processInboundEmailBatch({
          envelopes: [validEnvelope({ subject: PLANTED_SUBJECT })],
          consumer: async () => result,
        });
        ok(
          `consumer-ack-${label}-fail-closed`,
          r.ok === false && noLeak(r),
          ser(r),
        );
      }

      const threw = await processInboundEmailBatch({
        envelopes: [validEnvelope()],
        consumer: async () => {
          throw new Error(PLANTED_BODY);
        },
      });
      ok(
        'consumer-throw-fail-closed-no-leak',
        threw.ok === false && noLeak(threw),
        ser(threw),
      );
    }

    // ── Consumer not a function; missing keys; extras ─────────────────────
    {
      const notFn = await processInboundEmailBatch({
        envelopes: [validEnvelope()],
        consumer: { call: true },
      });
      ok('consumer-not-function-fail', notFn.ok === false && noLeak(notFn), ser(notFn));

      const missingConsumer = await processInboundEmailBatch({
        envelopes: [validEnvelope()],
      });
      ok(
        'missing-consumer-fail',
        missingConsumer.ok === false && noLeak(missingConsumer),
        ser(missingConsumer),
      );

      const missingEnvelopes = await processInboundEmailBatch({
        consumer: ackConsumer(),
      });
      ok(
        'missing-envelopes-fail',
        missingEnvelopes.ok === false && noLeak(missingEnvelopes),
        ser(missingEnvelopes),
      );

      const extra = await processInboundEmailBatch({
        envelopes: [validEnvelope()],
        consumer: ackConsumer(),
        access_token: PLANTED_TOKEN,
      });
      ok('input-extra-key-fail', extra.ok === false && noLeak(extra), ser(extra));

      const over = [];
      for (let i = 0; i < EMAIL_INBOUND_BATCH_MAX + 1; i += 1) {
        over.push(validEnvelope({
          provider_message_id: `msg-${i}`,
          received_at: '2026-08-06T12:00:00.000Z',
        }));
      }
      const overR = await processInboundEmailBatch({
        envelopes: over,
        consumer: ackConsumer(),
      });
      ok('over-max-fail', overR.ok === false && noLeak(overR), ser(overR));
    }

    // ── Exactly one await: consumer is async and observed once ────────────
    {
      let calls = 0;
      const r = await processInboundEmailBatch({
        envelopes: [
          validEnvelope({ provider_message_id: MSG_A }),
          validEnvelope({ provider_message_id: MSG_A }),
        ],
        consumer: async (envs) => {
          calls += 1;
          await Promise.resolve();
          ok('consumer-sees-deduped', envs.length === 1, String(envs.length));
          return { acknowledged: true };
        },
      });
      ok('awaited-consumer-once-after-dedup', r.ok && calls === 1, ser({ r, calls }));
    }

    // ── Sync consumer still accepted via await ────────────────────────────
    {
      const r = await processInboundEmailBatch({
        envelopes: [validEnvelope()],
        consumer: () => ({ acknowledged: true }),
      });
      ok('sync-consumer-ok', r.ok === true, ser(r));
    }

    // ── Gmail envelope accepted (provider-neutral; no Graph import) ───────
    {
      const { consumer, state } = trackingConsumer();
      const r = await processInboundEmailBatch({
        envelopes: [
          validEnvelope({
            provider: 'gmail_api',
            provider_mailbox_id: 'inbox@example.com',
            provider_message_id: 'gmail-1',
          }),
        ],
        consumer,
      });
      ok(
        'gmail-provider-ok',
        r.ok === true
          && state.calls === 1
          && state.lastEnvelopes[0].provider === 'gmail_api',
        ser(r),
      );
    }

    // ── Zero network ──────────────────────────────────────────────────────
    ok('network-hits-zero', networkHits === 0, String(networkHits));

    // ── Minimal source boundary checks (not regex inflation) ──────────────
    {
      const src = fs.readFileSync(PROCESSOR_PATH, 'utf8');
      ok(
        'src-requires-canonical-contract-only',
        /require\('\.\/email-inbound-envelope-contract'\)/.test(src),
      );
      ok(
        'src-uses-validate-identity-order',
        /validateInboundEmailEnvelope/.test(src)
          && /inboundEmailEnvelopeIdentityTuple/.test(src)
          && /compareInboundEmailEnvelopesForOrder/.test(src),
      );
      ok(
        'src-no-graph-provider-imports',
        !/email-microsoft-graph/.test(src)
          && !/email-microsoft-/.test(src)
          && !/graph\.microsoft\.com/.test(src)
          && !/login\.microsoftonline\.com/.test(src)
          && !/gmail|imap_smtp-adapter|microsoft-graph-adapter/.test(src),
      );
      ok(
        'src-does-not-redefine-envelope-key-list',
        !/EMAIL_INBOUND_ENVELOPE_KEYS\s*=/.test(src)
          && !/const\s+ENVELOPE_KEYS\s*=/.test(src),
      );
      ok(
        'src-no-network-db-routes',
        !/\bhttps?\.(request|get)\b/.test(src)
          && !/\bnet\.connect\b/.test(src)
          && !/\bpg\.|postgres|createPool|mongodb\b/i.test(src)
          && !/express|staff-query-api|router\.(get|post)/i.test(src),
      );
      ok(
        'src-documents-no-durable-idempotency',
        /DURABLE_IDEMPOTENCY_CLAIM\s*=\s*false/.test(src)
          || /durable idempotency/i.test(src),
      );
      ok(
        'src-single-awaited-consumer',
        /await\s+consumer\s*\(/.test(src),
      );
    }

    // Sanity: contract still independent.
    {
      const c = validateInboundEmailEnvelope(validEnvelope());
      ok('contract-still-validates', c.ok === true, ser(c));
    }

    assert.equal(fail, 0, `expected 0 failures, got ${fail}`);
    console.log(`\nPASS ${pass}  FAIL ${fail}`);
    restoreNetworkGuards();
    process.exit(0);
  } catch (err) {
    restoreNetworkGuards();
    console.error('\nVerifier crashed:', err && err.stack ? err.stack : err);
    console.log(`\nPASS ${pass}  FAIL ${fail + 1}`);
    process.exit(1);
  }
})();
