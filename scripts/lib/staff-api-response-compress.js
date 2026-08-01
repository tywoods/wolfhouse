'use strict';

/**
 * Optional gzip for Staff API text responses (response path only).
 * Built-in zlib — no new dependency. Skips healthz + Stripe/Meta webhooks.
 */

const zlib = require('zlib');
const url = require('url');

const DEFAULT_MIN_BYTES = 1024;

/** Content-Types eligible for gzip (charset parameters allowed). */
const COMPRESSIBLE_TYPE_RE =
  /^(text\/html|application\/json|text\/css|application\/javascript|text\/javascript)(\s*;.*)?$/i;

const SKIP_COMPRESSION_PATHS = new Set([
  '/', // public healthz alias (see staff-query-api router)
  '/healthz',
  '/staff/stripe/webhook',
  '/staff/meta/whatsapp/webhook',
]);

function normalizePathname(reqOrUrl) {
  const raw = typeof reqOrUrl === 'string'
    ? reqOrUrl
    : (reqOrUrl && reqOrUrl.url != null ? String(reqOrUrl.url) : '/');
  let pathname = '/';
  try {
    pathname = url.parse(raw, false).pathname || '/';
  } catch (_) {
    pathname = '/';
  }
  pathname = String(pathname).replace(/\/+$/, '') || '/';
  return pathname;
}

function shouldSkipCompressionPath(reqOrUrl) {
  return SKIP_COMPRESSION_PATHS.has(normalizePathname(reqOrUrl));
}

/**
 * True when Accept-Encoding includes gzip with q>0 (missing/empty → false).
 */
function requestAcceptsGzip(req) {
  if (!req || !req.headers) return false;
  const ae = req.headers['accept-encoding'];
  if (ae == null || ae === '') return false;
  const parts = String(ae).split(',');
  for (let i = 0; i < parts.length; i += 1) {
    const seg = parts[i].trim();
    if (!seg) continue;
    const bits = seg.split(';').map((s) => s.trim());
    const token = String(bits[0] || '').toLowerCase();
    if (token !== 'gzip') continue;
    let q = 1;
    for (let j = 1; j < bits.length; j += 1) {
      const m = /^q\s*=\s*([0-9.]+)$/i.exec(bits[j]);
      if (m) {
        q = Number(m[1]);
        if (!Number.isFinite(q)) q = 0;
      }
    }
    if (q > 0) return true;
  }
  return false;
}

function isCompressibleContentType(contentType) {
  if (contentType == null || contentType === '') return false;
  return COMPRESSIBLE_TYPE_RE.test(String(contentType).trim());
}

function mergeVaryAcceptEncoding(headers) {
  const out = Object.assign({}, headers || {});
  const varyKey = Object.keys(out).find((k) => k.toLowerCase() === 'vary');
  if (!varyKey) {
    out.Vary = 'Accept-Encoding';
    return out;
  }
  const existing = String(out[varyKey] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const has = existing.some((v) => v.toLowerCase() === 'accept-encoding');
  if (!has) existing.push('Accept-Encoding');
  out[varyKey] = existing.join(', ');
  return out;
}

function toBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  if (body == null) return Buffer.alloc(0);
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  return Buffer.from(String(body), 'utf8');
}

/**
 * Decide whether/how to gzip a response body.
 * @returns {{ body: Buffer, headers: object, compressed: boolean, rawLength: number }}
 */
function prepareCompressedBody(body, opts) {
  opts = opts || {};
  const req = opts.req || null;
  const contentType = opts.contentType
    || (opts.headers && (opts.headers['Content-Type'] || opts.headers['content-type']))
    || '';
  const minBytes = opts.minBytes != null ? Number(opts.minBytes) : DEFAULT_MIN_BYTES;
  const forceOff = opts.compress === false;

  let headers = Object.assign({}, opts.headers || {});
  const buf = toBuffer(body);
  const rawLength = buf.length;

  const pathSkip = shouldSkipCompressionPath(req);
  const accepts = requestAcceptsGzip(req);
  const typeOk = isCompressibleContentType(contentType);
  const aboveMin = rawLength >= minBytes;

  // Vary when this path/type *could* choose encoding (not webhooks/healthz).
  if (!pathSkip && typeOk) {
    headers = mergeVaryAcceptEncoding(headers);
  }

  const canCompress = !forceOff && req && !pathSkip && accepts && typeOk && aboveMin;
  if (!canCompress) {
    if (headers['Content-Length'] == null && headers['content-length'] == null) {
      headers['Content-Length'] = rawLength;
    }
    return { body: buf, headers, compressed: false, rawLength };
  }

  const gz = zlib.gzipSync(buf);
  headers['Content-Encoding'] = 'gzip';
  // Replace any prior Content-Length with compressed size.
  const clKey = Object.keys(headers).find((k) => k.toLowerCase() === 'content-length');
  if (clKey) delete headers[clKey];
  headers['Content-Length'] = gz.length;
  headers = mergeVaryAcceptEncoding(headers);
  return { body: gz, headers, compressed: true, rawLength };
}

/**
 * writeHead + end with optional gzip. Reads req from opts.req or res.__staffIncomingReq.
 */
function endWithOptionalGzip(res, statusCode, headers, body, opts) {
  opts = opts || {};
  const req = opts.req || (res && res.__staffIncomingReq) || null;
  const prepared = prepareCompressedBody(body, {
    req,
    contentType: headers && (headers['Content-Type'] || headers['content-type']),
    headers,
    minBytes: opts.minBytes,
    compress: opts.compress,
  });
  if (!res || res.headersSent || res.writableEnded) {
    return prepared;
  }
  res.writeHead(statusCode, prepared.headers);
  res.end(prepared.body);
  return prepared;
}

module.exports = {
  DEFAULT_MIN_BYTES,
  SKIP_COMPRESSION_PATHS,
  normalizePathname,
  shouldSkipCompressionPath,
  requestAcceptsGzip,
  isCompressibleContentType,
  mergeVaryAcceptEncoding,
  prepareCompressedBody,
  endWithOptionalGzip,
};
