'use strict';

/**
 * Microsoft Graph mailbox adapter boundary (Luna email Slice 2A).
 *
 * Pure offline factory: validated microsoft_graph endpoint + injected secret
 * provider + injected HTTP transport. Implements listMessageEnvelopes({top})
 * only (app-only client_credentials token then Graph messages GET).
 *
 * No network default, no SDK, no DB, no credential cache, no access_token
 * secret-material shortcut. Credentials and tokens are discarded after use.
 *
 * Params policy for listMessageEnvelopes(params):
 *   - params may be undefined (default top=10) OR a plain own-data-property
 *     object with exact optional key `top` only.
 *   - Shape/allowlist/accessor failures → stable `params_invalid`
 *     (no raw input in details).
 *   - Present `top` that is not an integer in [TOP_MIN, TOP_MAX] → `top_invalid`.
 *
 * Successful token/Graph JSON responses require exactly one valid string
 * Content-Type whose media type is application/json (parameters allowed).
 *
 * Access tokens used in Authorization must pass bounded strict validation:
 * RFC 6750 b64token grammar (ASCII visible non-whitespace [A-Za-z0-9\-._~+/]
 * plus optional trailing '=' padding), max length; reject all non-ASCII,
 * Unicode whitespace/line terminators/controls, embedded '=', and invalid
 * punctuation.
 *
 * @module email-microsoft-graph-adapter
 */

const {
  validateEmailMailboxProviderId,
  validateEmailMailboxCapabilities,
  validateEmailMailboxSecretRef,
  validateCanonicalLocationId,
  normalizeEmailPublicAddress,
  EMAIL_MAILBOX_CAPABILITY_KEYS,
} = require('./email-mailbox-adapter-contract');

const {
  validateEmailSecretProvider,
  resolveEmailMailboxSecret,
} = require('./email-secret-provider-contract');

const {
  validateEmailHttpTransport,
  EMAIL_HTTP_TRANSPORT_TIMEOUT,
} = require('./email-http-transport-contract');

const PROVIDER_ID = 'microsoft_graph';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PUBLIC_ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Exact endpoint input keys (optional provider_resource_id only extra). */
const ENDPOINT_REQUIRED_KEYS = Object.freeze([
  'client_id',
  'location_id',
  'provider',
  'public_address',
  'secret_ref',
  'capabilities',
]);

const ENDPOINT_OPTIONAL_KEYS = Object.freeze([
  'provider_resource_id',
]);

const ENDPOINT_KEY_SET = new Set([
  ...ENDPOINT_REQUIRED_KEYS,
  ...ENDPOINT_OPTIONAL_KEYS,
]);

/** Forbidden injection / credential fields on endpoint input. */
const ENDPOINT_FORBIDDEN_KEYS = Object.freeze([
  'host',
  'url',
  'base_url',
  'token_url',
  'graph_url',
  'graph_host',
  'authority',
  'tenant_id',
  'client_secret',
  'access_token',
  'Authorization',
  'authorization',
  'secretProvider',
  'secret_provider',
  'transport',
  'locationAuthority',
  'location_authority',
  'token',
  'password',
  'api_key',
]);

/** Exact secret-material keys after resolve. No access_token shortcut. */
const SECRET_MATERIAL_KEYS = Object.freeze([
  'tenant_id',
  'client_id',
  'client_secret',
]);
const SECRET_MATERIAL_KEY_SET = new Set(SECRET_MATERIAL_KEYS);

/** Fixed Graph $select allowlist (Mail.ReadBasic-safe envelope fields). */
const GRAPH_MESSAGE_SELECT = Object.freeze([
  'id',
  'subject',
  'from',
  'receivedDateTime',
  'isRead',
  'conversationId',
  'hasAttachments',
  'internetMessageId',
]);

/**
 * Mapped envelope DTO keys (fresh object per row).
 *
 * LEGACY PROVIDER/TRANSPORT-ROW COMPATIBILITY SURFACE only.
 * Canonical normalized domain envelope lives in
 * `email-inbound-envelope-contract` (EMAIL_INBOUND_ENVELOPE_KEYS). Convert with
 * `convertLegacyGraphTransportEnvelopeToInbound` — do not treat this DTO as a
 * second domain meaning. Existing listMessageEnvelopes consumers keep this shape.
 */
const ENVELOPE_DTO_KEYS = Object.freeze([
  'id',
  'subject',
  'from_address',
  'from_name',
  'received_at',
  'is_read',
  'conversation_id',
  'has_attachments',
  'internet_message_id',
]);

/** Classifier: adapter list DTO is not the canonical inbound domain envelope. */
const GRAPH_TRANSPORT_ENVELOPE_SURFACE = 'legacy_provider_transport_row_compatibility';

/**
 * Exact own-data keys allowed on a transport.response object.
 * Extras / symbols / accessors → fail closed (no ignored extras).
 */
const TRANSPORT_RESPONSE_KEYS = Object.freeze([
  'status',
  'headers',
  'body',
]);
const TRANSPORT_RESPONSE_KEY_SET = new Set(TRANSPORT_RESPONSE_KEYS);

/** Exact own-data keys required on each Graph message row (matches $select). */
const GRAPH_MESSAGE_ROW_KEY_SET = new Set(GRAPH_MESSAGE_SELECT);

/** Nested `from` own-data keys when non-null. */
const GRAPH_FROM_KEYS = Object.freeze(['emailAddress']);
const GRAPH_FROM_KEY_SET = new Set(GRAPH_FROM_KEYS);

/** Nested `emailAddress` own-data keys when non-null. */
const GRAPH_EMAIL_ADDRESS_KEYS = Object.freeze(['address', 'name']);
const GRAPH_EMAIL_ADDRESS_KEY_SET = new Set(GRAPH_EMAIL_ADDRESS_KEYS);

/**
 * Exact Graph list envelope own-data keys for this non-pagination slice.
 * Only `value` — no @odata.* / nextLink metadata accepted.
 */
const GRAPH_LIST_ENVELOPE_KEYS = Object.freeze(['value']);
const GRAPH_LIST_ENVELOPE_KEY_SET = new Set(GRAPH_LIST_ENVELOPE_KEYS);

const TOKEN_HOST = 'login.microsoftonline.com';
const TOKEN_PATH_SUFFIX = '/oauth2/v2.0/token';
const GRAPH_HOST = 'graph.microsoft.com';
const GRAPH_MESSAGES_PREFIX = '/v1.0/users/';
const GRAPH_MESSAGES_SUFFIX = '/messages';
const TOKEN_SCOPE = 'https://graph.microsoft.com/.default';
const TOKEN_GRANT = 'client_credentials';

const TOP_MIN = 1;
const TOP_MAX = 50;
const DEFAULT_TOP = 10;

/** Reasonable upper bound for Bearer access_token before Authorization construction. */
const ACCESS_TOKEN_MAX_LEN = 8192;

const FACTORY_KEY_SET = new Set(['endpoint', 'secretProvider', 'transport']);

function isPlainObject(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function fail(error, details) {
  const out = { ok: false, error: String(error) };
  if (details !== undefined) out.details = details;
  return out;
}

function ok(value) {
  return value === undefined ? { ok: true } : { ok: true, value };
}

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

/**
 * Read an own data property without invoking getters/setters.
 * Rejects accessor descriptors; does not walk the prototype chain for value.
 * @param {object} obj
 * @param {string|symbol} key
 * @returns {{present:false}|{present:true,accessor:true}|{present:true,value:unknown}}
 */
function readOwnDataProp(obj, key) {
  if (obj == null || (typeof obj !== 'object' && typeof obj !== 'function')) {
    return { present: false };
  }
  if (!Object.prototype.hasOwnProperty.call(obj, key)) {
    return { present: false };
  }
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  if (!desc) return { present: false };
  if (typeof desc.get === 'function' || typeof desc.set === 'function') {
    return { present: true, accessor: true };
  }
  return { present: true, value: desc.value };
}

/**
 * Ensure plain object has no own accessor properties and no symbol keys.
 * Returns a fresh copy of own data string-key properties only (values as-is).
 * Does not invoke getters.
 * @param {unknown} obj
 * @returns {{ok:true,value:object}|{ok:false,reason:string,key?:string}}
 */
function snapshotOwnDataProps(obj) {
  if (!isPlainObject(obj)) {
    return { ok: false, reason: 'must_be_object' };
  }
  // Null prototype ensures keys such as `__proto__` become ordinary own data
  // properties instead of invoking inherited setters and disappearing from
  // subsequent exact-key allowlist checks.
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(obj)) {
    if (typeof key === 'symbol') {
      return { ok: false, reason: 'symbol_key' };
    }
    const read = readOwnDataProp(obj, key);
    if (!read.present) continue;
    if (read.accessor) {
      return { ok: false, reason: 'accessor', key };
    }
    out[key] = read.value;
  }
  return { ok: true, value: out };
}

/**
 * True iff snapshotted object own string keys are a subset of allowSet
 * (no unknown extras). Does not require all allowSet keys to be present.
 * @param {object} snap
 * @param {Set<string>} allowSet
 */
function ownKeysSubsetOf(snap, allowSet) {
  for (const key of Object.keys(snap)) {
    if (!allowSet.has(key)) return false;
  }
  return true;
}

/**
 * True iff snapshotted object own string keys are exactly exactKeys (set equality).
 * @param {object} snap
 * @param {readonly string[]} exactKeys
 * @param {Set<string>} exactSet
 */
function ownKeysExactly(snap, exactKeys, exactSet) {
  const keys = Object.keys(snap);
  if (keys.length !== exactKeys.length) return false;
  for (const key of keys) {
    if (!exactSet.has(key)) return false;
  }
  return true;
}

/**
 * Validate factory endpoint input: exact keys, microsoft_graph only, no host/url injection.
 * Own data properties only — accessors/symbols rejected without invoking getters.
 * @param {unknown} endpoint
 * @returns {{ok:true,value:object}|{ok:false,error:string,details?:object}}
 */
function validateMicrosoftGraphEndpoint(endpoint) {
  const snap = snapshotOwnDataProps(endpoint);
  if (!snap.ok) {
    return fail('endpoint_invalid', { reason: snap.reason });
  }
  const ep = snap.value;

  for (const key of Object.keys(ep)) {
    if (ENDPOINT_FORBIDDEN_KEYS.includes(key)) {
      return fail('endpoint_forbidden_field', { field: key });
    }
    if (!ENDPOINT_KEY_SET.has(key)) {
      return fail('endpoint_unknown_key', { key });
    }
  }

  for (const required of ENDPOINT_REQUIRED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(ep, required)) {
      return fail('endpoint_missing_key', { key: required });
    }
  }

  const clientId = trimStr(ep.client_id);
  if (!clientId || !UUID_RE.test(clientId)) {
    return fail('client_id_invalid');
  }

  const location = validateCanonicalLocationId(ep.location_id);
  if (!location.ok) return location;

  const provider = validateEmailMailboxProviderId(ep.provider);
  if (!provider.ok) return provider;
  if (provider.value !== PROVIDER_ID) {
    return fail('provider_not_microsoft_graph', { provider: provider.value });
  }

  const publicAddress = normalizeEmailPublicAddress(ep.public_address);
  if (!publicAddress || !PUBLIC_ADDRESS_RE.test(publicAddress)) {
    return fail('public_address_invalid');
  }

  const secretRef = validateEmailMailboxSecretRef(ep.secret_ref);
  if (!secretRef.ok) {
    // Do not echo secret_ref.
    return fail('secret_ref_invalid', secretRef.details ? { reason: secretRef.error } : undefined);
  }

  const caps = validateEmailMailboxCapabilities(ep.capabilities);
  if (!caps.ok) return caps;

  let providerResourceId = null;
  if (Object.prototype.hasOwnProperty.call(ep, 'provider_resource_id')
      && ep.provider_resource_id != null
      && ep.provider_resource_id !== '') {
    if (typeof ep.provider_resource_id !== 'string') {
      return fail('provider_resource_id_invalid');
    }
    // Reject path/query injection attempts in resource id.
    const raw = ep.provider_resource_id;
    if (raw !== raw.trim() || /[/?#\s]/.test(raw) || raw.includes('..')) {
      return fail('provider_resource_id_invalid');
    }
    providerResourceId = raw.trim();
    if (!providerResourceId) {
      return fail('provider_resource_id_invalid');
    }
  }

  const frozenCaps = {};
  for (const k of EMAIL_MAILBOX_CAPABILITY_KEYS) {
    frozenCaps[k] = caps.value[k] === true;
  }

  return ok(Object.freeze({
    client_id: clientId.toLowerCase(),
    location_id: location.value,
    provider: PROVIDER_ID,
    public_address: publicAddress,
    secret_ref: secretRef.value,
    provider_resource_id: providerResourceId,
    capabilities: Object.freeze(frozenCaps),
  }));
}

/**
 * Strict app-only secret material — exact three keys, non-empty strings, no nesting.
 * Rejects access_token shortcut and any extra/nested keys.
 * Own data properties only — accessors/symbols rejected without invoking getters.
 * @param {unknown} material
 * @returns {{ok:true,value:{tenant_id:string,client_id:string,client_secret:string}}|{ok:false,error:string}}
 */
function validateAppOnlySecretMaterial(material) {
  const snap = snapshotOwnDataProps(material);
  if (!snap.ok) {
    return fail('secret_material_invalid', { reason: snap.reason });
  }
  const mat = snap.value;

  const keys = Object.keys(mat);
  for (const key of keys) {
    if (!SECRET_MATERIAL_KEY_SET.has(key)) {
      return fail('secret_material_invalid', { reason: 'unknown_key' });
    }
  }
  for (const required of SECRET_MATERIAL_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(mat, required)) {
      return fail('secret_material_invalid', { reason: 'missing_key' });
    }
    const v = mat[required];
    if (typeof v !== 'string') {
      return fail('secret_material_invalid', { reason: 'non_string' });
    }
    if (!v || v.trim() !== v || !v.trim()) {
      return fail('secret_material_invalid', { reason: 'empty_or_whitespace' });
    }
    // Reject multi-line / control characters in material values.
    if (/[\r\n\0]/.test(v)) {
      return fail('secret_material_invalid', { reason: 'control_chars' });
    }
  }
  // access_token shortcut is forbidden (caught as unknown_key if present).
  if (Object.prototype.hasOwnProperty.call(mat, 'access_token')) {
    return fail('secret_material_invalid', { reason: 'access_token_shortcut_forbidden' });
  }

  return ok(Object.freeze({
    tenant_id: mat.tenant_id,
    client_id: mat.client_id,
    client_secret: mat.client_secret,
  }));
}

function buildTokenUrl(tenantId) {
  // encodeURIComponent on tenant segment only; host/path fixed.
  return `https://${TOKEN_HOST}/${encodeURIComponent(tenantId)}${TOKEN_PATH_SUFFIX}`;
}

function buildMessagesUrl(userKey, top) {
  const select = GRAPH_MESSAGE_SELECT.join(',');
  const pathUser = encodeURIComponent(userKey);
  return `https://${GRAPH_HOST}${GRAPH_MESSAGES_PREFIX}${pathUser}${GRAPH_MESSAGES_SUFFIX}`
    + `?$top=${top}&$select=${select}`;
}

function buildTokenFormBody(creds) {
  // application/x-www-form-urlencoded; values encoded.
  const params = new URLSearchParams();
  params.set('grant_type', TOKEN_GRANT);
  params.set('client_id', creds.client_id);
  params.set('client_secret', creds.client_secret);
  params.set('scope', TOKEN_SCOPE);
  return params.toString();
}

/**
 * Map token HTTP status to stable sanitized error code.
 * @param {number} status
 */
function mapTokenStatusError(status) {
  if (!Number.isInteger(status)) return 'token_response_malformed';
  if (status >= 400 && status < 500) return 'token_http_4xx';
  if (status >= 500 && status < 600) return 'token_http_5xx';
  return 'token_response_malformed';
}

/**
 * Map Graph HTTP status to stable sanitized error code.
 * @param {number} status
 */
function mapGraphStatusError(status) {
  if (!Number.isInteger(status)) return 'graph_response_malformed';
  if (status === 401) return 'graph_http_401';
  if (status === 403) return 'graph_http_403';
  if (status === 404) return 'graph_http_404';
  if (status === 429) return 'graph_http_429';
  if (status >= 500 && status < 600) return 'graph_http_5xx';
  if (status >= 400 && status < 500) return 'graph_http_4xx';
  return 'graph_response_malformed';
}

/**
 * Parse JSON body without leaking content on failure.
 * @param {unknown} body
 * @returns {{ok:true,value:unknown}|{ok:false}}
 */
function parseJsonBody(body) {
  if (typeof body !== 'string') return { ok: false };
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch (_e) {
    return { ok: false };
  }
}

/**
 * Validate transport response shape with **exact** own-data key allowlist:
 * only `status`, `headers`, `body` (status required). Unknown string keys,
 * symbol keys, and accessors → fail closed without invoking getters.
 * Extra keys are not ignored.
 * @param {unknown} res
 */
function readTransportResponse(res) {
  const snap = snapshotOwnDataProps(res);
  if (!snap.ok) return { ok: false };
  const r = snap.value;
  // Exact allowlist: reject any own string key outside status/headers/body.
  if (!ownKeysSubsetOf(r, TRANSPORT_RESPONSE_KEY_SET)) return { ok: false };
  if (!Object.prototype.hasOwnProperty.call(r, 'status')) return { ok: false };
  const status = r.status;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 0) {
    return { ok: false };
  }
  const body = Object.prototype.hasOwnProperty.call(r, 'body') ? r.body : '';
  // Headers: snapshot own data props only (no accessors); arrays/non-plain rejected.
  let headers = {};
  if (Object.prototype.hasOwnProperty.call(r, 'headers') && r.headers != null) {
    const hSnap = snapshotOwnDataProps(r.headers);
    if (!hSnap.ok) return { ok: false };
    headers = hSnap.value;
  }
  return {
    ok: true,
    status,
    body: body === undefined || body === null ? '' : body,
    headers,
  };
}

/** Bounded Content-Type value length for strict JSON media-type parsing. */
const CONTENT_TYPE_MAX_LEN = 128;

/**
 * RFC 7230 tchar: "!" / "#" / "$" / "%" / "&" / "'" / "*" / "+" / "-" / "." /
 * "^" / "_" / "`" / "|" / "~" / DIGIT / ALPHA
 * @param {number} c char code
 */
function isHttpTcharCode(c) {
  if (c >= 0x30 && c <= 0x39) return true; // DIGIT
  if (c >= 0x41 && c <= 0x5a) return true; // ALPHA upper
  if (c >= 0x61 && c <= 0x7a) return true; // ALPHA lower
  switch (c) {
    case 0x21: // !
    case 0x23: // #
    case 0x24: // $
    case 0x25: // %
    case 0x26: // &
    case 0x27: // '
    case 0x2a: // *
    case 0x2b: // +
    case 0x2d: // -
    case 0x2e: // .
    case 0x5e: // ^
    case 0x5f: // _
    case 0x60: // `
    case 0x7c: // |
    case 0x7e: // ~
      return true;
    default:
      return false;
  }
}

/**
 * Strict parser: exactly one HTTP media type `application/json` (case-insensitive)
 * with zero or more valid `;` parameters (token=token / token=quoted-string).
 * Rejects empty/trailing parameters, CR/LF/controls/DEL, commas/multiple media
 * types, invalid parameter tokens, malformed/unclosed quotes, injection.
 * Not a permissive split-on-first-semicolon.
 *
 * @param {string} ct
 * @returns {boolean}
 */
function isStrictApplicationJsonContentType(ct) {
  if (typeof ct !== 'string' || !ct) return false;
  if (ct.length > CONTENT_TYPE_MAX_LEN) return false;

  // Reject C0 controls (incl. CR/LF/HTAB-as-control path), DEL, and commas
  // (multi-value / injection). OWS around parameters uses SP only below.
  for (let i = 0; i < ct.length; i += 1) {
    const c = ct.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return false;
    if (c === 0x2c) return false; // comma → multiple media types
  }

  // No leading/trailing SP on the whole value (strict).
  if (ct.charCodeAt(0) === 0x20 || ct.charCodeAt(ct.length - 1) === 0x20) {
    return false;
  }

  let i = 0;
  const len = ct.length;

  // type "/" subtype  (both tokens)
  const typeStart = i;
  while (i < len && isHttpTcharCode(ct.charCodeAt(i))) i += 1;
  if (i === typeStart) return false;
  if (i >= len || ct.charCodeAt(i) !== 0x2f) return false; // /
  i += 1;
  const subtypeStart = i;
  while (i < len && isHttpTcharCode(ct.charCodeAt(i))) i += 1;
  if (i === subtypeStart) return false;

  const mediaType = ct.slice(typeStart, i).toLowerCase();
  if (mediaType !== 'application/json') return false;

  // *( OWS ";" OWS parameter )  — OWS here is SP only (HTAB already rejected)
  while (i < len) {
    // optional SP before ";"
    while (i < len && ct.charCodeAt(i) === 0x20) i += 1;
    if (i >= len) {
      // trailing SP after media type or last param without another ";"
      return false;
    }
    if (ct.charCodeAt(i) !== 0x3b) return false; // must be ;
    i += 1;
    // optional SP after ";"
    while (i < len && ct.charCodeAt(i) === 0x20) i += 1;
    // empty / trailing parameter (e.g. "application/json;" or "; ")
    if (i >= len) return false;

    // parameter name = token
    const nameStart = i;
    while (i < len && isHttpTcharCode(ct.charCodeAt(i))) i += 1;
    if (i === nameStart) return false;
    if (i >= len || ct.charCodeAt(i) !== 0x3d) return false; // =
    i += 1;
    if (i >= len) return false;

    if (ct.charCodeAt(i) === 0x22) {
      // quoted-string = DQUOTE *( qdtext / quoted-pair ) DQUOTE
      i += 1; // opening "
      let closed = false;
      while (i < len) {
        const c = ct.charCodeAt(i);
        if (c === 0x22) {
          closed = true;
          i += 1;
          break;
        }
        if (c === 0x5c) {
          // quoted-pair = "\" ( HTAB / SP / VCHAR / obs-text )
          i += 1;
          if (i >= len) return false;
          const q = ct.charCodeAt(i);
          // CTLs already banned globally; still require a following char in VCHAR/SP range
          if (q <= 0x1f || q === 0x7f) return false;
          i += 1;
          continue;
        }
        // qdtext: SP / %x21 / %x23-5B / %x5D-7E (HTAB/CTL already rejected)
        if (
          c === 0x20
          || c === 0x21
          || (c >= 0x23 && c <= 0x5b)
          || (c >= 0x5d && c <= 0x7e)
        ) {
          i += 1;
          continue;
        }
        return false;
      }
      if (!closed) return false;
    } else {
      // token value
      const valStart = i;
      while (i < len && isHttpTcharCode(ct.charCodeAt(i))) i += 1;
      if (i === valStart) return false;
    }
  }

  return true;
}

/**
 * For successful JSON responses: require exactly one valid string Content-Type
 * whose media type is application/json (parameters like charset allowed).
 * Case-insensitive header name matching. Rejects missing, non-string, arrays,
 * duplicate case variants, conflicting duplicates, wrong media types, malformed,
 * empty/trailing parameters, CR/LF/control/DEL, commas, injection, unclosed quotes.
 * Hostile header values are never returned to callers.
 *
 * @param {object} headers already own-data snapshot
 * @returns {{ok:true}|{ok:false}}
 */
function validateSuccessfulJsonContentType(headers) {
  if (!isPlainObject(headers)) return { ok: false };

  const contentTypeValues = [];
  for (const key of Object.keys(headers)) {
    if (String(key).toLowerCase() === 'content-type') {
      contentTypeValues.push(headers[key]);
    }
  }

  if (contentTypeValues.length === 0) return { ok: false };
  if (contentTypeValues.length > 1) return { ok: false };

  const ct = contentTypeValues[0];
  if (typeof ct !== 'string') return { ok: false };
  if (!isStrictApplicationJsonContentType(ct)) return { ok: false };

  return { ok: true };
}

/**
 * Bounded strict access-token validation before Authorization construction.
 *
 * Conservative Graph bearer grammar aligned with RFC 6750 b64token:
 *   b64token = 1*( ALPHA / DIGIT / "-" / "." / "_" / "~" / "+" / "/" ) *"="
 *
 * Accepts realistic JWT / base64url / b64token strings (incl. trailing '=').
 * Rejects: empty/non-string/overlong; every non-ASCII code point; all Unicode
 * whitespace/line terminators/controls (incl. U+00A0, U+0085, U+2028/U+2029);
 * C0/DEL/ASCII space; invalid punctuation; embedded or leading '=';
 * malformed padding (any non-'=' after padding starts).
 *
 * @param {unknown} accessToken
 * @returns {boolean}
 */
function isStrictAccessToken(accessToken) {
  if (typeof accessToken !== 'string' || !accessToken) return false;
  if (accessToken.length > ACCESS_TOKEN_MAX_LEN) return false;

  let i = 0;
  let sawTokenChar = false;
  for (; i < accessToken.length; i += 1) {
    const c = accessToken.charCodeAt(i);
    // RFC 6750 b64token body: ALPHA / DIGIT / "-" / "." / "_" / "~" / "+" / "/"
    const isAlpha = (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A);
    const isDigit = c >= 0x30 && c <= 0x39;
    const isExtra = c === 0x2D // -
      || c === 0x2E // .
      || c === 0x5F // _
      || c === 0x7E // ~
      || c === 0x2B // +
      || c === 0x2F; // /
    if (isAlpha || isDigit || isExtra) {
      sawTokenChar = true;
      continue;
    }
    if (c === 0x3D) {
      // Padding region starts — must be only trailing '=' from here.
      break;
    }
    // Any other code point: non-ASCII, whitespace, controls, invalid punct.
    return false;
  }
  if (!sawTokenChar) return false;
  for (; i < accessToken.length; i += 1) {
    if (accessToken.charCodeAt(i) !== 0x3D) return false;
  }
  return true;
}

/**
 * Extract Bearer access_token from token response. Fail closed on wrong type / missing.
 * Applies bounded strict token validation (no CRLF/header-injection/whitespace/controls).
 * @param {unknown} parsed
 */
function extractAccessToken(parsed) {
  const snap = snapshotOwnDataProps(parsed);
  if (!snap.ok) return { ok: false };
  const p = snap.value;

  if (!Object.prototype.hasOwnProperty.call(p, 'access_token')) {
    return { ok: false };
  }
  if (!Object.prototype.hasOwnProperty.call(p, 'token_type')) {
    return { ok: false };
  }
  const tokenType = p.token_type;
  if (typeof tokenType !== 'string' || tokenType.toLowerCase() !== 'bearer') {
    return { ok: false };
  }
  const accessToken = p.access_token;
  if (!isStrictAccessToken(accessToken)) {
    return { ok: false };
  }
  return { ok: true, accessToken };
}

/**
 * Map one Graph message row to a fresh allowlisted envelope DTO.
 * Fail closed if required fields malformed.
 *
 * Exact own-data key policy (no ignored extras):
 *   - row keys must be exactly GRAPH_MESSAGE_SELECT
 *     (id, subject, from, receivedDateTime, isRead, conversationId,
 *      hasAttachments, internetMessageId)
 *   - reject body / uniqueBody / internetMessageHeaders / @odata.* / unknown /
 *     symbol / accessor keys without invocation; no partial DTO output
 *   - nested `from` (if non-null): exact own key `emailAddress` only
 *   - nested `emailAddress` (if non-null): exact own keys `address`, `name`
 *
 * @param {unknown} row
 * @returns {{ok:true,value:object}|{ok:false}}
 */
function mapMessageEnvelope(row) {
  const rowSnap = snapshotOwnDataProps(row);
  if (!rowSnap.ok) return { ok: false };
  const r = rowSnap.value;
  // Exact selected Graph row keys — extras fail closed (no partial).
  if (!ownKeysExactly(r, GRAPH_MESSAGE_SELECT, GRAPH_MESSAGE_ROW_KEY_SET)) {
    return { ok: false };
  }

  if (typeof r.id !== 'string' || !r.id) return { ok: false };

  // subject may be null or string
  let subject = null;
  if (r.subject != null) {
    if (typeof r.subject !== 'string') return { ok: false };
    subject = r.subject;
  }

  let fromAddress = null;
  let fromName = null;
  if (r.from != null) {
    const fromSnap = snapshotOwnDataProps(r.from);
    if (!fromSnap.ok) return { ok: false };
    const fromObj = fromSnap.value;
    // Exact own data key emailAddress only when from is non-null.
    if (!ownKeysExactly(fromObj, GRAPH_FROM_KEYS, GRAPH_FROM_KEY_SET)) {
      return { ok: false };
    }
    if (fromObj.emailAddress != null) {
      const eaSnap = snapshotOwnDataProps(fromObj.emailAddress);
      if (!eaSnap.ok) return { ok: false };
      const emailAddress = eaSnap.value;
      // Exact own data keys address, name when emailAddress is non-null.
      if (!ownKeysExactly(
        emailAddress,
        GRAPH_EMAIL_ADDRESS_KEYS,
        GRAPH_EMAIL_ADDRESS_KEY_SET,
      )) {
        return { ok: false };
      }
      if (emailAddress.address != null) {
        if (typeof emailAddress.address !== 'string') return { ok: false };
        fromAddress = emailAddress.address;
      }
      if (emailAddress.name != null) {
        if (typeof emailAddress.name !== 'string') return { ok: false };
        fromName = emailAddress.name;
      }
    }
  }

  if (typeof r.receivedDateTime !== 'string' || !r.receivedDateTime) {
    return { ok: false };
  }

  if (r.isRead !== true && r.isRead !== false) return { ok: false };

  let conversationId = null;
  if (r.conversationId != null) {
    if (typeof r.conversationId !== 'string') return { ok: false };
    conversationId = r.conversationId;
  }

  if (r.hasAttachments !== true && r.hasAttachments !== false) return { ok: false };

  let internetMessageId = null;
  if (r.internetMessageId != null) {
    if (typeof r.internetMessageId !== 'string') return { ok: false };
    internetMessageId = r.internetMessageId;
  }

  // Fresh allowlisted DTO — never copy body / uniqueBody / headers / raw row.
  const dto = {
    id: r.id,
    subject,
    from_address: fromAddress,
    from_name: fromName,
    received_at: r.receivedDateTime,
    is_read: r.isRead === true,
    conversation_id: conversationId,
    has_attachments: r.hasAttachments === true,
    internet_message_id: internetMessageId,
  };
  // Ensure exact key set.
  for (const k of Object.keys(dto)) {
    if (!ENVELOPE_DTO_KEYS.includes(k)) return { ok: false };
  }
  return { ok: true, value: Object.freeze(dto) };
}

/**
 * Parse Graph list messages response into envelope DTOs. Fail closed; no partial.
 * Exact own-data key `value` only for this non-pagination slice (no @odata.* /
 * nextLink / unknown extras). Accessors/symbols rejected without invocation.
 * @param {unknown} parsed
 */
function mapMessagesResponse(parsed) {
  const snap = snapshotOwnDataProps(parsed);
  if (!snap.ok) return { ok: false };
  const p = snap.value;
  if (!ownKeysExactly(p, GRAPH_LIST_ENVELOPE_KEYS, GRAPH_LIST_ENVELOPE_KEY_SET)) {
    return { ok: false };
  }
  if (!Object.prototype.hasOwnProperty.call(p, 'value')) return { ok: false };
  if (!Array.isArray(p.value)) return { ok: false };

  const envelopes = [];
  for (const row of p.value) {
    const mapped = mapMessageEnvelope(row);
    if (!mapped.ok) return { ok: false };
    envelopes.push(mapped.value);
  }
  return { ok: true, value: envelopes };
}

/**
 * Validate listMessageEnvelopes params.
 * undefined → default top; else plain own-data object with optional key `top` only.
 *
 * Error codes (stable, no raw input in details):
 *   - params_invalid — shape/allowlist/accessor/symbol/null/array/unknown key
 *   - top_invalid — top present but not integer in [TOP_MIN, TOP_MAX]
 *
 * @param {unknown} params
 * @returns {{ok:true,top:number}|{ok:false,error:string}}
 */
function validateListMessageEnvelopesParams(params) {
  if (params === undefined) {
    return { ok: true, top: DEFAULT_TOP };
  }
  // Strict null rejection (null is typeof object).
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    return { ok: false, error: 'params_invalid' };
  }
  const snap = snapshotOwnDataProps(params);
  if (!snap.ok) {
    return { ok: false, error: 'params_invalid' };
  }
  const p = snap.value;
  for (const key of Object.keys(p)) {
    if (key !== 'top') {
      return { ok: false, error: 'params_invalid' };
    }
  }
  if (!Object.prototype.hasOwnProperty.call(p, 'top')) {
    return { ok: true, top: DEFAULT_TOP };
  }
  const topRaw = p.top;
  if (typeof topRaw !== 'number'
      || !Number.isInteger(topRaw)
      || topRaw < TOP_MIN
      || topRaw > TOP_MAX) {
    return { ok: false, error: 'top_invalid' };
  }
  return { ok: true, top: topRaw };
}

/**
 * @param {object} opts
 * @param {object} opts.endpoint untrusted endpoint identity fields
 * @param {object} opts.secretProvider injected secret provider
 * @param {object} opts.transport injected HTTP transport
 * @returns {{ok:true,adapter:object}|{ok:false,error:string,details?:object}}
 */
function createMicrosoftGraphMailboxAdapter(opts) {
  const optsSnap = snapshotOwnDataProps(opts);
  if (!optsSnap.ok) {
    return fail('adapter_deps_invalid', { reason: optsSnap.reason || 'must_be_object' });
  }
  const o = optsSnap.value;

  // Reject unknown top-level factory keys beyond the allowlist.
  for (const key of Object.keys(o)) {
    if (!FACTORY_KEY_SET.has(key)) {
      return fail('adapter_deps_invalid', { reason: 'unknown_key', key });
    }
  }

  if (!Object.prototype.hasOwnProperty.call(o, 'endpoint')) {
    return fail('adapter_deps_invalid', { reason: 'endpoint_required' });
  }
  if (!Object.prototype.hasOwnProperty.call(o, 'secretProvider')) {
    return fail('adapter_deps_invalid', { reason: 'secretProvider_required' });
  }
  if (!Object.prototype.hasOwnProperty.call(o, 'transport')) {
    return fail('adapter_deps_invalid', { reason: 'transport_required' });
  }

  const endpointResult = validateMicrosoftGraphEndpoint(o.endpoint);
  if (!endpointResult.ok) return endpointResult;

  const sp = validateEmailSecretProvider(o.secretProvider);
  if (!sp.ok) return sp;

  const tr = validateEmailHttpTransport(o.transport);
  if (!tr.ok) return tr;

  const endpoint = endpointResult.value;
  // Keep validated provider/transport object references (functions are data props).
  const secretProvider = o.secretProvider;
  const transport = o.transport;

  const userKey = endpoint.provider_resource_id || endpoint.public_address;

  const adapter = Object.freeze({
    kind: 'microsoft_graph',
    getIdentity() {
      return Object.freeze({
        provider: endpoint.provider,
        public_address: endpoint.public_address,
        capabilities: endpoint.capabilities,
        client_id: endpoint.client_id,
        location_id: endpoint.location_id,
      });
    },
    getCapabilities() {
      return endpoint.capabilities;
    },
    /**
     * List basic message envelopes for the scoped mailbox.
     * @param {{ top?: number }} [params]
     * @returns {Promise<{ok:true,value:object[]}|{ok:false,error:string}>}
     */
    async listMessageEnvelopes(params) {
      const paramsCheck = validateListMessageEnvelopesParams(params);
      if (!paramsCheck.ok) {
        return fail(paramsCheck.error);
      }
      const top = paramsCheck.top;

      // 1) Resolve secret material (opaque ref only). Discard after request path.
      const resolved = await resolveEmailMailboxSecret(
        secretProvider,
        endpoint.secret_ref,
      );
      if (!resolved.ok) {
        // secret_ref_invalid / secret_resolve_failed / secret_provider_invalid
        if (resolved.error === 'secret_ref_invalid') {
          return fail('secret_ref_invalid');
        }
        if (resolved.error === 'secret_provider_invalid') {
          return fail('secret_provider_invalid');
        }
        return fail('secret_resolve_failed');
      }

      const materialCheck = validateAppOnlySecretMaterial(resolved.value);
      // Drop reference to raw resolved container early on failure path.
      if (!materialCheck.ok) {
        return fail('secret_material_invalid');
      }
      const creds = materialCheck.value;

      // 2) Token request via injected transport (never cache).
      const tokenUrl = buildTokenUrl(creds.tenant_id);
      const tokenBody = buildTokenFormBody(creds);
      let tokenResRaw;
      try {
        tokenResRaw = await transport.request({
          method: 'POST',
          url: tokenUrl,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: tokenBody,
          timeout_ms: EMAIL_HTTP_TRANSPORT_TIMEOUT.TOKEN_MS,
        });
      } catch (_err) {
        return fail('transport_error');
      }

      const tokenRes = readTransportResponse(tokenResRaw);
      if (!tokenRes.ok) {
        return fail('token_response_malformed');
      }
      if (tokenRes.status !== 200) {
        return fail(mapTokenStatusError(tokenRes.status));
      }
      // Successful token JSON: require exactly one application/json Content-Type.
      if (!validateSuccessfulJsonContentType(tokenRes.headers).ok) {
        return fail('token_response_malformed');
      }
      if (typeof tokenRes.body !== 'string') {
        return fail('token_response_malformed');
      }
      const tokenParsed = parseJsonBody(tokenRes.body);
      if (!tokenParsed.ok) {
        return fail('token_response_malformed');
      }
      const tokenExtract = extractAccessToken(tokenParsed.value);
      if (!tokenExtract.ok) {
        return fail('token_response_malformed');
      }
      const accessToken = tokenExtract.accessToken;

      // 3) Graph messages GET (Authorization only on this transport request).
      const messagesUrl = buildMessagesUrl(userKey, top);
      let graphResRaw;
      try {
        graphResRaw = await transport.request({
          method: 'GET',
          url: messagesUrl,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
          },
          timeout_ms: EMAIL_HTTP_TRANSPORT_TIMEOUT.GRAPH_MS,
        });
      } catch (_err) {
        return fail('transport_error');
      } finally {
        // Discard token/creds references as soon as request is issued.
        // (Local bindings go out of scope after function return.)
      }

      // Explicitly avoid retaining token in outer scope beyond this block.
      // accessToken is only used above for the Authorization header.

      const graphRes = readTransportResponse(graphResRaw);
      if (!graphRes.ok) {
        return fail('graph_response_malformed');
      }
      if (graphRes.status !== 200) {
        return fail(mapGraphStatusError(graphRes.status));
      }
      // Successful Graph JSON: require exactly one application/json Content-Type.
      if (!validateSuccessfulJsonContentType(graphRes.headers).ok) {
        return fail('graph_response_malformed');
      }
      if (typeof graphRes.body !== 'string') {
        return fail('graph_response_malformed');
      }
      const graphParsed = parseJsonBody(graphRes.body);
      if (!graphParsed.ok) {
        return fail('graph_response_malformed');
      }
      const mapped = mapMessagesResponse(graphParsed.value);
      if (!mapped.ok) {
        return fail('graph_response_malformed');
      }
      return ok(mapped.value);
    },
  });

  return ok(adapter);
}

module.exports = {
  createMicrosoftGraphMailboxAdapter,
  validateMicrosoftGraphEndpoint,
  validateAppOnlySecretMaterial,
  validateListMessageEnvelopesParams,
  extractAccessToken,
  isStrictAccessToken,
  validateSuccessfulJsonContentType,
  mapMessageEnvelope,
  mapMessagesResponse,
  readTransportResponse,
  GRAPH_MESSAGE_SELECT,
  ENVELOPE_DTO_KEYS,
  GRAPH_TRANSPORT_ENVELOPE_SURFACE,
  SECRET_MATERIAL_KEYS,
  ENDPOINT_REQUIRED_KEYS,
  TOKEN_SCOPE,
  TOKEN_GRANT,
  TOKEN_HOST,
  GRAPH_HOST,
  TOP_MIN,
  TOP_MAX,
  ACCESS_TOKEN_MAX_LEN,
  CONTENT_TYPE_MAX_LEN,
  isStrictApplicationJsonContentType,
  buildTokenUrl,
  buildMessagesUrl,
  buildTokenFormBody,
  TRANSPORT_RESPONSE_KEYS,
  GRAPH_LIST_ENVELOPE_KEYS,
};
