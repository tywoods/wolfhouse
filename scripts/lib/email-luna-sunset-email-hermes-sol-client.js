'use strict';

/**
 * MAIL-MVP-007 — authenticated Staff→Hermes draft-plan client.
 *
 * Bounded body/response/timeouts. Fail closed. Never logs guest content,
 * notes, prompts, email, phone, tokens, or secrets.
 */

const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const crypto = require('node:crypto');
const util = require('node:util');
const {
  HERMES_SOL_REQUEST_SCHEMA,
  HERMES_SOL_TEMPLATE_REQUEST_SCHEMA,
  HERMES_SOL_DRAFT_PATH,
  HERMES_SOL_TENANT,
  HERMES_SOL_LOCATION_KEY,
  PRIVATE_STAFF_TRUST,
  MAX_RESULT_JSON_BYTES,
  parseDraftPlanResult,
  parseTemplatePlanResult,
  closedRuntimeMarker,
} = require('./email-luna-sunset-email-hermes-sol-contract');
const {
  resolveSunsetEmailHermesSolClientConfig,
} = require('./email-luna-sunset-email-hermes-sol-activation');

const isProxy = util.types.isProxy.bind(undefined);
const freeze = Object.freeze;
const create = Object.create;
const getDesc = Object.getOwnPropertyDescriptor;
const hasOwn = Object.hasOwn;
const NativePromise = Promise;

function ownData(value, key) {
  try {
    const descriptor = getDesc(value, key);
    return descriptor && hasOwn(descriptor, 'value') && descriptor.enumerable && !descriptor.get && !descriptor.set
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function fail(reason) {
  return freeze({ status: 'error', reason: reason || 'model_provider_error', planJson: null, marker: null });
}

function spkiSha256Hex(cert) {
  try {
    const x509 = new crypto.X509Certificate(cert);
    const der = x509.publicKey.export({ type: 'spki', format: 'der' });
    return crypto.createHash('sha256').update(der).digest('hex');
  } catch {
    return null;
  }
}

function pinnedIdentityCheck(expectedPin, loopback, serverName) {
  return function checkServerIdentity(host, cert) {
    if (loopback) return undefined;
    const identityHost = serverName || host;
    const hostnameError = tls.checkServerIdentity(identityHost, cert);
    if (hostnameError) return hostnameError;
    if (expectedPin) {
      const pin = spkiSha256Hex(cert);
      if (pin !== expectedPin) {
        const error = new Error('tls_pin_mismatch');
        error.code = 'HERMES_SOL_TLS_PIN';
        return error;
      }
    }
    return undefined;
  };
}

function unavailable() {
  return freeze({ status: 'unavailable', reason: 'hermes_unavailable', planJson: null, marker: null });
}

function defaultHttpRequest(input) {
  return new NativePromise((resolve, reject) => {
    const method = ownData(input, 'method');
    const urlText = ownData(input, 'url');
    const body = ownData(input, 'body');
    const timeoutMs = ownData(input, 'timeout_ms');
    const headersIn = ownData(input, 'headers');
    if (method !== 'POST' || typeof urlText !== 'string' || typeof body !== 'string') {
      reject(new Error('invalid_http_request'));
      return;
    }
    let url;
    try { url = new URL(urlText); } catch {
      reject(new Error('invalid_http_request'));
      return;
    }
    const lib = url.protocol === 'https:' ? https : http;
    const headers = create(null);
    headers['content-type'] = 'application/json';
    headers.accept = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(body, 'utf8'));
    if (headersIn && typeof headersIn === 'object' && !isProxy(headersIn) && !Array.isArray(headersIn)) {
      const auth = ownData(headersIn, 'authorization') || ownData(headersIn, 'Authorization');
      if (typeof auth === 'string') headers.authorization = auth;
    }
    const tlsPin = ownData(input, 'tlsPin') || ownData(input, 'tls_pin');
    const tlsServerName = ownData(input, 'tlsServerName') || ownData(input, 'servername');
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
    if (url.protocol === 'http:' && !loopback) {
      reject(Object.assign(new Error('plaintext_http_forbidden'), { code: 'HERMES_SOL_PLAINTEXT' }));
      return;
    }
    if (url.protocol === 'https:' && !loopback && tlsPin && typeof tlsPin !== 'string') {
      reject(Object.assign(new Error('tls_pin_required'), { code: 'HERMES_SOL_TLS_PIN' }));
      return;
    }
    const requestOptions = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search || ''}`,
      method: 'POST',
      headers,
      timeout: Number.isSafeInteger(timeoutMs) ? timeoutMs : 15000,
    };
    if (url.protocol === 'https:') {
      requestOptions.rejectUnauthorized = true;
      requestOptions.servername = typeof tlsServerName === 'string' && tlsServerName
        ? tlsServerName
        : url.hostname;
      requestOptions.checkServerIdentity = pinnedIdentityCheck(
        typeof tlsPin === 'string' ? tlsPin.toLowerCase() : '',
        loopback,
        requestOptions.servername,
      );
      const ca = ownData(input, 'ca');
      if (typeof ca === 'string' && ca) requestOptions.ca = ca;
    }
    const req = lib.request(requestOptions, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_RESULT_JSON_BYTES) {
          req.destroy();
          reject(Object.assign(new Error('oversized'), { code: 'HERMES_SOL_OVERSIZED' }));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        resolve(freeze({
          status: res.statusCode || 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      });
    });
    req.on('timeout', () => {
      req.destroy();
      const error = new Error('timeout');
      error.code = 'EMAIL_LUNA_AUTHOR_TIMEOUT';
      reject(error);
    });
    req.on('error', (error) => {
      if (error && error.code === 'EMAIL_LUNA_AUTHOR_TIMEOUT') {
        reject(error);
        return;
      }
      if (error && (error.code === 'HERMES_SOL_TLS_PIN' || error.code === 'HERMES_SOL_PLAINTEXT')) {
        reject(error);
        return;
      }
      const wrapped = new Error('network');
      wrapped.code = 'HERMES_SOL_UNAVAILABLE';
      reject(wrapped);
    });
    req.write(body);
    req.end();
  });
}

function snapshotAuthority(authority) {
  if (!authority || typeof authority !== 'object' || isProxy(authority) || Array.isArray(authority)) {
    return null;
  }
  const out = create(null);
  for (const key of ['client_id', 'location_id', 'location_key', 'conversation_id', 'endpoint_id', 'inbound_message_id']) {
    const value = ownData(authority, key);
    if (typeof value !== 'string' || !value) return null;
    out[key] = value;
  }
  if (out.location_key !== HERMES_SOL_LOCATION_KEY) return null;
  return freeze(out);
}

function snapshotEmail(content) {
  if (!content || typeof content !== 'object' || isProxy(content) || Array.isArray(content)) return null;
  const out = create(null);
  out.subject = typeof ownData(content, 'subject') === 'string' ? ownData(content, 'subject') : '';
  out.body_text = typeof ownData(content, 'body_text') === 'string' ? ownData(content, 'body_text') : '';
  out.quoted_history = typeof ownData(content, 'quoted_history') === 'string' ? ownData(content, 'quoted_history') : '';
  out.from_display_name = typeof ownData(content, 'from_display_name') === 'string' ? ownData(content, 'from_display_name') : '';
  out.from_address = typeof ownData(content, 'from_address') === 'string' ? ownData(content, 'from_address') : '';
  return freeze(out);
}

function createEmailLunaSunsetEmailHermesSolClient(configuration) {
  const env = configuration && ownData(configuration, 'env') ? configuration.env : configuration;
  const resolved = resolveSunsetEmailHermesSolClientConfig(env);
  if (!resolved) {
    const error = new Error('sunset_email_hermes_sol_disabled');
    error.code = 'EMAIL_LUNA_HERMES_SOL_DISABLED';
    throw error;
  }
  const requestFn = configuration && typeof ownData(configuration, 'request') === 'function'
    ? ownData(configuration, 'request')
    : (configuration && configuration.request) || defaultHttpRequest;
  const timeoutMs = configuration && Number.isSafeInteger(configuration.timeoutMs)
    ? configuration.timeoutMs
    : resolved.timeoutMs;
  const seen = new Set();

  async function postEnvelope(envelope, parser) {
    const authority = snapshotAuthority(envelope && envelope.authority);
    const email = snapshotEmail(envelope && envelope.untrusted_email);
    const language = envelope && envelope.language === 'es' ? 'es' : 'en';
    const goals = typeof (envelope && envelope.goals) === 'string' ? envelope.goals : '';
    const schema = envelope && envelope.schema === HERMES_SOL_TEMPLATE_REQUEST_SCHEMA
      ? HERMES_SOL_TEMPLATE_REQUEST_SCHEMA
      : HERMES_SOL_REQUEST_SCHEMA;
    if (!authority || !email) return fail('authority_mismatch');
    const requestId = crypto.randomUUID();
    if (seen.has(requestId)) return fail('replay');
    seen.add(requestId);
    if (seen.size > 4096) seen.clear();
    const bodyObj = {
      schema,
      tenant_id: HERMES_SOL_TENANT,
      location_key: HERMES_SOL_LOCATION_KEY,
      client_id: authority.client_id,
      location_id: authority.location_id,
      conversation_id: authority.conversation_id,
      endpoint_id: authority.endpoint_id,
      inbound_message_id: authority.inbound_message_id,
      language,
      untrusted_email: {
        subject: email.subject,
        body_text: email.body_text,
        quoted_history: email.quoted_history,
        from_display_name: email.from_display_name,
        from_address: email.from_address,
      },
      private_staff_goals: {
        trust: PRIVATE_STAFF_TRUST,
        goals,
      },
      request_id: requestId,
    };
    let body;
    try { body = JSON.stringify(bodyObj); } catch { return fail('malformed'); }
    let response;
    try {
      const pending = requestFn({
        method: 'POST',
        url: `${resolved.baseUrl}${HERMES_SOL_DRAFT_PATH}`,
        headers: { authorization: `Bearer ${resolved.token}`, 'content-type': 'application/json' },
        body,
        timeout_ms: timeoutMs,
        tlsPin: resolved.tlsPin || '',
        tlsServerName: resolved.tlsServerName || '',
      });
      if (!pending || typeof pending.then !== 'function') return unavailable();
      response = await pending;
    } catch (error) {
      if (error && error.code === 'EMAIL_LUNA_AUTHOR_TIMEOUT') {
        const timeout = new Error('timeout');
        timeout.code = 'EMAIL_LUNA_AUTHOR_TIMEOUT';
        throw timeout;
      }
      if (error && (error.code === 'HERMES_SOL_TLS_PIN' || error.code === 'HERMES_SOL_PLAINTEXT')) {
        return fail('provenance_mismatch');
      }
      if (error && error.code === 'HERMES_SOL_OVERSIZED') return fail('malformed');
      return unavailable();
    }
    const status = ownData(response, 'status');
    const raw = ownData(response, 'body');
    if (!Number.isSafeInteger(status) || typeof raw !== 'string') return fail('malformed');
    if (status === 401 || status === 403) return fail('authority_mismatch');
    if (status >= 500) return unavailable();
    if (status !== 200) return fail('malformed');
    const parsed = parser(raw, authority);
    if (!parsed || parsed.ok !== true) {
      return fail(parsed && parsed.reason === 'provenance_mismatch' ? 'provenance_mismatch' : 'malformed');
    }
    const marker = closedRuntimeMarker(parsed.value.provenance);
    if (!marker) return fail('provenance_mismatch');
    return freeze({
      status: 'ok',
      reason: null,
      planJson: parsed.value.actsJson || parsed.value.planJson,
      marker,
      provenance: parsed.value.provenance,
    });
  }

  return freeze({
    requestNaturalPlan(envelope) {
      return postEnvelope(envelope, parseDraftPlanResult);
    },
    requestTemplatePlan(envelope) {
      return postEnvelope({
        ...envelope,
        schema: HERMES_SOL_TEMPLATE_REQUEST_SCHEMA,
      }, parseTemplatePlanResult);
    },
    diagnostics() {
      return freeze({
        enabled: true,
        provider: resolved.provider,
        model: resolved.model,
        runtime: resolved.runtime,
      });
    },
  });
}

module.exports = freeze({
  createEmailLunaSunsetEmailHermesSolClient,
  defaultHttpRequest,
  spkiSha256Hex,
  pinnedIdentityCheck,
});
