'use strict';

const AAD_VERSION = 'v1';
const PROVIDER = 'microsoft_graph';
const DEFAULT_QUERY_VERSION = 'ms_messages_delta_from_now_v2';
const CURSOR_KINDS = Object.freeze(['nextLink', 'deltaLink']);
const UUID_CANON = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fail() { return Object.freeze({ ok: false, code: 'aad_invalid' }); }
function ok(value) { return Object.freeze({ ok: true, value }); }
function parsePositiveSafeInt(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER
      ? value : null;
  }
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) {
    if (value.length > 16) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 && String(parsed) === value
      ? parsed : null;
  }
  if (typeof value === 'bigint') {
    return value >= 1n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  }
  return null;
}
function canonicalUuid(value) {
  const text = String(value).trim().toLowerCase();
  return UUID_CANON.test(text) ? text : null;
}

function buildDeltaCursorEnvelopeAadV1(input) {
  if (!input || typeof input !== 'object') throw new Error('aad_identity_invalid');
  const clientId = canonicalUuid(input.clientId);
  const endpointId = canonicalUuid(input.endpointId);
  const providerTenantId = canonicalUuid(input.providerTenantId);
  const providerMailboxId = canonicalUuid(input.providerMailboxId);
  const generation = parsePositiveSafeInt(input.ingestionGeneration);
  if (!clientId || !endpointId) throw new Error('aad_identity_invalid');
  if (input.provider !== PROVIDER) throw new Error('aad_provider_invalid');
  if (!providerTenantId) throw new Error('aad_tenant_invalid');
  if (!providerMailboxId) throw new Error('aad_mailbox_invalid');
  if (!CURSOR_KINDS.includes(input.cursorKind)) throw new Error('aad_cursor_kind_invalid');
  if (!generation) throw new Error('aad_generation_invalid');
  const queryVersion = input.queryVersion == null ? DEFAULT_QUERY_VERSION : input.queryVersion;
  if (queryVersion !== DEFAULT_QUERY_VERSION) throw new Error('aad_query_version_invalid');
  return Buffer.from([
    AAD_VERSION,
    'delta_cursor_aad_v1',
    `client_id=${clientId}`,
    `endpoint_id=${endpointId}`,
    `provider=${PROVIDER}`,
    `provider_tenant_id=${providerTenantId}`,
    `provider_mailbox_id=${providerMailboxId}`,
    `ingestion_generation=${generation}`,
    `query_version=${queryVersion}`,
    `cursor_kind=${input.cursorKind}`,
  ].join('\n'), 'utf8');
}

function parseDeltaCursorEnvelopeAadV1(aad) {
  try {
    if (!Buffer.isBuffer(aad) || aad.length < 1 || aad.length > 4096) return fail();
    const text = aad.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(aad) || /[\r\0]/.test(text)) return fail();
    const lines = text.split('\n');
    if (lines.length !== 10 || lines[0] !== AAD_VERSION || lines[1] !== 'delta_cursor_aad_v1') return fail();
    const field = (line, key) => {
      const prefix = `${key}=`;
      if (typeof line !== 'string' || !line.startsWith(prefix)) return null;
      const value = line.slice(prefix.length);
      return value.length > 0 ? value : null;
    };
    const clientId = field(lines[2], 'client_id');
    const endpointId = field(lines[3], 'endpoint_id');
    const provider = field(lines[4], 'provider');
    const providerTenantId = field(lines[5], 'provider_tenant_id');
    const providerMailboxId = field(lines[6], 'provider_mailbox_id');
    const generationText = field(lines[7], 'ingestion_generation');
    const queryVersion = field(lines[8], 'query_version');
    const cursorKind = field(lines[9], 'cursor_kind');
    const generation = parsePositiveSafeInt(generationText);
    if (!clientId || !endpointId || !providerTenantId || !providerMailboxId || !generation
        || !UUID_CANON.test(clientId) || !UUID_CANON.test(endpointId)
        || !UUID_CANON.test(providerTenantId) || !UUID_CANON.test(providerMailboxId)
        || provider !== PROVIDER || queryVersion !== DEFAULT_QUERY_VERSION
        || !CURSOR_KINDS.includes(cursorKind)) return fail();
    const rebuilt = buildDeltaCursorEnvelopeAadV1({
      clientId, endpointId, provider, providerTenantId, providerMailboxId,
      ingestionGeneration: generation, queryVersion, cursorKind,
    });
    if (!rebuilt.equals(aad)) return fail();
    return ok(Object.freeze({
      client_id: clientId,
      endpoint_id: endpointId,
      provider,
      provider_tenant_id: providerTenantId,
      provider_mailbox_id: providerMailboxId,
      ingestion_generation: generation,
      query_version: queryVersion,
      cursor_kind: cursorKind,
    }));
  } catch {
    return fail();
  }
}

module.exports = Object.freeze({
  buildDeltaCursorEnvelopeAadV1,
  parseDeltaCursorEnvelopeAadV1,
});
