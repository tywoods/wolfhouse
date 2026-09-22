'use strict';

const { assertPublicHealthzBody } = require('../staff-api-healthz');

// Binding is admitted here, never inferred from the generic health body, a
// browser URL or integration-reader configuration. Neither production is admitted.
const SOURCES = Object.freeze([
  Object.freeze({ client: 'wolfhouse-somo', slug: 'wolfhouse-somo', environment: 'staging', origin: 'https://staff-staging.lunafrontdesk.com' }),
  Object.freeze({ client: 'sunset-somo', slug: 'sunset', environment: 'staging', origin: 'https://sunset-staging.lunafrontdesk.com' }),
]);

function unknown(reason, checkedAt = null, sourceKind = 'none') {
  return Object.freeze({ availability: 'unknown', checked_at: checkedAt, source_kind: sourceKind, reason });
}

// Read the decompressed stream incrementally; Content-Length is not trusted.
async function readHealthBody(response) {
  if (!response.body || typeof response.body.getReader !== 'function') throw new Error('invalid_healthz');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 4096) throw new Error('response_too_large');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    // Do not let a peer's cancellation delay extend the request deadline.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function createCrowsnestClientPortalEvidenceCollector({ transport = fetch, now = Date.now, timeoutMs = 3000 } = {}) {
  const timeout = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(timeoutMs, 3000)) : 3000;
  async function read(source) {
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(unknown('timeout', new Date(now()).toISOString(), 'staff_healthz'));
      }, timeout);
    });
    const request = (async () => {
      try {
        const response = await transport(`${source.origin}/healthz`, {
          method: 'GET', headers: { accept: 'application/json' },
          redirect: 'error', credentials: 'omit', signal: controller.signal,
        });
        if (response.status !== 200 || response.redirected) {
          if (response.body) void response.body.cancel().catch(() => {});
          return unknown('http_not_200', new Date(now()).toISOString(), 'staff_healthz');
        }
        if (!assertPublicHealthzBody(await readHealthBody(response)).ok) {
          return unknown('invalid_healthz', new Date(now()).toISOString(), 'staff_healthz');
        }
        return Object.freeze({ availability: 'live', checked_at: new Date(now()).toISOString(), source_kind: 'staff_healthz', reason: 'canonical_healthz_ok' });
      } catch (_) {
        return unknown(controller.signal.aborted ? 'timeout' : 'read_failed', new Date(now()).toISOString(), 'staff_healthz');
      }
    })();
    try { return await Promise.race([request, deadline]); }
    finally { clearTimeout(timer); controller.abort(); }
  }

  // Two admitted sources => at most two concurrent network reads, even across
  // simultaneous page loads. Failed refreshes replace old positives, never SWR.
  const cache = new Map();
  const inFlight = new Map();
  const isFresh = (entry, time) => time >= entry.startedAt && time < entry.expiresAt;
  async function readCached(source) {
    const key = `${source.client}|${source.environment}|${source.origin}`;
    const time = now();
    const cached = cache.get(key);
    if (cached && isFresh(cached, time)) return cached;
    if (inFlight.has(key)) return inFlight.get(key);
    const promise = read(source).then((evidence) => {
      const entry = { startedAt: time, expiresAt: time + 60000, evidence };
      cache.set(key, entry);
      return entry;
    }).finally(() => { inFlight.delete(key); });
    inFlight.set(key, promise);
    return promise;
  }

  return async function collect(clients = []) {
    const result = {};
    const jobs = [];
    for (const client of clients) {
      result[client.id] = { staging: unknown('source_not_admitted'), production: unknown('source_not_admitted') };
      const source = SOURCES.find((item) => item.client === client.id && item.slug === client.client_slug);
      if (!source || client.status !== 'Live') continue;
      if (!(client.environments || []).some((row) => row.kind === 'staff_portal' && row.url === source.origin
          && (!row.environment || row.environment === source.environment))) continue;
      jobs.push(readCached(source).then((entry) => ({ source, entry })));
    }
    const collected = await Promise.all(jobs);
    // A cached result can cross its expiry while the other source is loading.
    // Carry its original request-start deadline privately, not in the public DTO.
    // Revalidate at handoff, including clock rollback, before publishing evidence.
    const handedOffAt = now();
    for (const { source, entry } of collected) {
      const evidence = entry.evidence;
      const age = handedOffAt - Date.parse(evidence.checked_at);
      result[source.client][source.environment] = evidence.availability === 'live'
        && (!isFresh(entry, handedOffAt) || !Number.isFinite(age) || age < 0)
        ? unknown('evidence_expired', evidence.checked_at, evidence.source_kind)
        : evidence;
    }
    return result;
  };
}

module.exports = { createCrowsnestClientPortalEvidenceCollector, CLIENT_PORTAL_SOURCES: SOURCES };
