'use strict';

/**
 * verify:staff-api-response-gzip — offline gate for optional gzip on Staff API text responses.
 *
 * Proves:
 *   - gzip round-trip equals original bytes
 *   - client without Accept-Encoding: gzip stays uncompressed
 *   - sub-threshold bodies stay uncompressed
 *   - healthz + Stripe/Meta webhook paths never compress
 *   - production wiring uses endWithOptionalGzip for sendJSON/sendHTML/UI/login
 *   - inbound webhook signature path is untouched (response-only change)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const compress = require('./lib/staff-api-response-compress');
const apiSrc = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
    return true;
  }
  fail += 1;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

function mockReq(headers, urlPath) {
  return { headers: headers || {}, url: urlPath || '/staff/query' };
}

// ── Unit: Accept-Encoding ────────────────────────────────────────────────────
ok('accepts gzip token', compress.requestAcceptsGzip(mockReq({ 'accept-encoding': 'gzip' })));
ok('accepts gzip among others', compress.requestAcceptsGzip(mockReq({ 'accept-encoding': 'br, gzip, deflate' })));
ok('rejects missing header', !compress.requestAcceptsGzip(mockReq({})));
ok('rejects empty header', !compress.requestAcceptsGzip(mockReq({ 'accept-encoding': '' })));
ok('rejects gzip;q=0', !compress.requestAcceptsGzip(mockReq({ 'accept-encoding': 'gzip;q=0' })));
ok('accepts gzip;q=0.5', compress.requestAcceptsGzip(mockReq({ 'accept-encoding': 'gzip;q=0.5' })));

// ── Unit: content types ──────────────────────────────────────────────────────
ok('html compressible', compress.isCompressibleContentType('text/html; charset=utf-8'));
ok('json compressible', compress.isCompressibleContentType('application/json'));
ok('css compressible', compress.isCompressibleContentType('text/css'));
ok('js compressible', compress.isCompressibleContentType('application/javascript'));
ok('png not compressible', !compress.isCompressibleContentType('image/png'));
ok('octet not compressible', !compress.isCompressibleContentType('application/octet-stream'));

// ── Unit: path skips ─────────────────────────────────────────────────────────
ok('skip /healthz', compress.shouldSkipCompressionPath(mockReq({}, '/healthz')));
ok('skip / healthz alias', compress.shouldSkipCompressionPath(mockReq({}, '/')));
ok('skip stripe webhook', compress.shouldSkipCompressionPath(mockReq({}, '/staff/stripe/webhook')));
ok('skip meta webhook', compress.shouldSkipCompressionPath(mockReq({}, '/staff/meta/whatsapp/webhook')));
ok('allow /staff/ui', !compress.shouldSkipCompressionPath(mockReq({}, '/staff/ui')));
ok('allow /staff/login', !compress.shouldSkipCompressionPath(mockReq({}, '/staff/login')));
ok('allow /staff/query', !compress.shouldSkipCompressionPath(mockReq({}, '/staff/query?intent=x')));

// ── Round-trip + no-gzip client + sub-threshold ──────────────────────────────
const bigJson = `${'{"ok":true,"pad":"'}${'x'.repeat(2048)}"}`;
const bigReq = mockReq({ 'accept-encoding': 'gzip, deflate' }, '/staff/query');
const gzPrep = compress.prepareCompressedBody(bigJson, {
  req: bigReq,
  contentType: 'application/json',
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});
ok('large+gzip → compressed', gzPrep.compressed === true);
ok('Content-Encoding gzip', gzPrep.headers['Content-Encoding'] === 'gzip');
ok('Vary Accept-Encoding on compress', /accept-encoding/i.test(String(gzPrep.headers.Vary || '')));
ok('Content-Length is compressed size', gzPrep.headers['Content-Length'] === gzPrep.body.length);

const roundTrip = zlib.gunzipSync(gzPrep.body).toString('utf8');
ok('gzip round-trip identical bytes', roundTrip === bigJson, `len ${roundTrip.length} vs ${bigJson.length}`);

const noAe = compress.prepareCompressedBody(bigJson, {
  req: mockReq({}, '/staff/query'),
  contentType: 'application/json',
  headers: { 'Content-Type': 'application/json' },
});
ok('no Accept-Encoding → uncompressed', noAe.compressed === false);
ok('no AE body equals original', noAe.body.toString('utf8') === bigJson);
ok('no AE has no Content-Encoding', noAe.headers['Content-Encoding'] == null);

const tiny = '{"a":1}';
const tinyPrep = compress.prepareCompressedBody(tiny, {
  req: bigReq,
  contentType: 'application/json',
  headers: { 'Content-Type': 'application/json' },
  minBytes: compress.DEFAULT_MIN_BYTES,
});
ok('sub-threshold uncompressed', tinyPrep.compressed === false);
ok('sub-threshold body unchanged', tinyPrep.body.toString('utf8') === tiny);
ok('sub-threshold still Vary', /accept-encoding/i.test(String(tinyPrep.headers.Vary || '')));

const healthzBody = JSON.stringify({ ok: true, pad: 'y'.repeat(3000) });
const hzPrep = compress.prepareCompressedBody(healthzBody, {
  req: mockReq({ 'accept-encoding': 'gzip' }, '/healthz'),
  contentType: 'application/json',
  headers: { 'Content-Type': 'application/json' },
});
ok('healthz never compresses', hzPrep.compressed === false);
ok('healthz no Content-Encoding', hzPrep.headers['Content-Encoding'] == null);

const whPrep = compress.prepareCompressedBody(healthzBody, {
  req: mockReq({ 'accept-encoding': 'gzip' }, '/staff/stripe/webhook'),
  contentType: 'application/json',
  headers: { 'Content-Type': 'application/json' },
});
ok('stripe webhook path never compresses', whPrep.compressed === false);

const metaPrep = compress.prepareCompressedBody(healthzBody, {
  req: mockReq({ 'accept-encoding': 'gzip' }, '/staff/meta/whatsapp/webhook'),
  contentType: 'application/json',
  headers: { 'Content-Type': 'application/json' },
});
ok('meta webhook path never compresses', metaPrep.compressed === false);

const pngPrep = compress.prepareCompressedBody(Buffer.alloc(4096, 1), {
  req: bigReq,
  contentType: 'image/png',
  headers: { 'Content-Type': 'image/png' },
});
ok('binary image never compresses', pngPrep.compressed === false);

// ── Double-encoding guard (Sea Dog blocker) ──────────────────────────────────
ok('hasExistingContentEncoding detects br',
  compress.hasExistingContentEncoding({ 'Content-Type': 'application/json', 'Content-Encoding': 'br' }));
ok('hasExistingContentEncoding detects lowercase key',
  compress.hasExistingContentEncoding({ 'content-encoding': 'gzip' }));
ok('hasExistingContentEncoding ignores empty',
  !compress.hasExistingContentEncoding({ 'Content-Encoding': '' }));
ok('hasExistingContentEncoding ignores missing',
  !compress.hasExistingContentEncoding({ 'Content-Type': 'application/json' }));

const brBody = 'x'.repeat(2048);
const brPrep = compress.prepareCompressedBody(brBody, {
  req: bigReq,
  headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'br' },
});
ok('existing Content-Encoding: br → not re-gzipped', brPrep.compressed === false);
ok('existing br preserved (not overwritten with gzip)',
  brPrep.headers['Content-Encoding'] === 'br');
ok('existing br body left as original bytes', brPrep.body.toString('utf8') === brBody);

const alreadyGzipPrep = compress.prepareCompressedBody(brBody, {
  req: bigReq,
  headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
});
ok('existing Content-Encoding: gzip → not double-gzipped', alreadyGzipPrep.compressed === false);
ok('existing gzip encoding preserved',
  alreadyGzipPrep.headers['Content-Encoding'] === 'gzip');

const deflatePrep = compress.prepareCompressedBody(brBody, {
  req: bigReq,
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'content-encoding': 'deflate' },
});
ok('existing content-encoding: deflate → not re-gzipped', deflatePrep.compressed === false);
ok('existing deflate preserved',
  String(deflatePrep.headers['content-encoding'] || deflatePrep.headers['Content-Encoding']) === 'deflate');

// ── UTF-8 multibyte Content-Length / round-trip ──────────────────────────────
const utf8Seed = '😀漢字é';
const utf8Body = utf8Seed.repeat(400);
const utf8JsLen = utf8Body.length;
const utf8ByteLen = Buffer.byteLength(utf8Body, 'utf8');
ok('utf8 fixture: JS length < byte length', utf8JsLen < utf8ByteLen,
  `js=${utf8JsLen} bytes=${utf8ByteLen}`);
const utf8Prep = compress.prepareCompressedBody(utf8Body, {
  req: bigReq,
  contentType: 'application/json',
  headers: { 'Content-Type': 'application/json' },
});
ok('utf8 large body compresses', utf8Prep.compressed === true);
ok('utf8 Content-Length is compressed buffer length',
  utf8Prep.headers['Content-Length'] === utf8Prep.body.length);
const utf8Rt = zlib.gunzipSync(utf8Prep.body).toString('utf8');
ok('utf8 gzip round-trip byte-identical', utf8Rt === utf8Body);
ok('utf8 rawLength is UTF-8 byte length not JS length',
  utf8Prep.rawLength === utf8ByteLen, `raw=${utf8Prep.rawLength} expected=${utf8ByteLen}`);

// ── endWithOptionalGzip mock res ─────────────────────────────────────────────
{
  let status = null;
  let headers = null;
  let ended = null;
  const res = {
    headersSent: false,
    writableEnded: false,
    __staffIncomingReq: bigReq,
    writeHead(code, h) { status = code; headers = h; },
    end(b) { ended = b; this.writableEnded = true; },
  };
  const out = compress.endWithOptionalGzip(res, 200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  }, `<html>${'z'.repeat(1500)}</html>`);
  ok('endWithOptionalGzip status 200', status === 200);
  ok('endWithOptionalGzip compressed', out.compressed === true);
  ok('endWithOptionalGzip encoding header', headers['Content-Encoding'] === 'gzip');
  ok('endWithOptionalGzip body is buffer', Buffer.isBuffer(ended));
  const htmlRt = zlib.gunzipSync(ended).toString('utf8');
  ok('endWithOptionalGzip HTML round-trip', htmlRt.startsWith('<html>') && htmlRt.includes('z'.repeat(100)));
}

// ── Production wiring (source) ───────────────────────────────────────────────
ok('requires compress helper', /staff-api-response-compress/.test(apiSrc));
ok('sendJSON uses endWithOptionalGzip',
  /function sendJSON\(res, statusCode, body\) \{[\s\S]{0,220}?endWithOptionalGzip\(res, statusCode/.test(apiSrc));
ok('sendHTML uses endWithOptionalGzip',
  /function sendHTML\(res, statusCode, html\) \{[\s\S]{0,220}?endWithOptionalGzip\(res, statusCode/.test(apiSrc));
ok('handleUI uses endWithOptionalGzip',
  /function handleUI\([\s\S]{0,400}?endWithOptionalGzip\(res, 200/.test(apiSrc));
ok('handleLoginPage uses endWithOptionalGzip',
  /function handleLoginPage\([\s\S]{0,400}?endWithOptionalGzip\(res, 200/.test(apiSrc));
ok('attaches incoming req on res', /res\.__staffIncomingReq\s*=\s*req/.test(apiSrc));

// Webhook signature verification must remain request-body based (untouched by response gzip).
ok('stripe constructEvent still present', /webhooks\.constructEvent\(rawBody/.test(apiSrc));
ok('no request-body gzip inflate added', !/gunzipSync\(\s*rawBody|createGunzip\(\)/.test(apiSrc));

// Plain-text helper (webhook-ish) must NOT route through gzip helper — keep tiny ACK plain.
const plainIdx = apiSrc.indexOf('function sendPlainText(res, statusCode, text)');
const plainSlice = plainIdx >= 0 ? apiSrc.slice(plainIdx, plainIdx + 350) : '';
ok('sendPlainText does not gzip', plainIdx >= 0 && !/endWithOptionalGzip/.test(plainSlice));

// Image asset handlers stay binary writeHead/end.
ok('logo stays image/png raw', /handleStaffPortalLogo[\s\S]{0,350}?image\/png/.test(apiSrc));

// Syntax
const check = spawnSync(process.execPath, ['--check', 'scripts/lib/staff-api-response-compress.js'], {
  cwd: root,
  encoding: 'utf8',
});
ok('node --check compress helper', check.status === 0, check.stderr || check.stdout);

console.log(`\nverify-staff-api-response-gzip: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('PASS verify:staff-api-response-gzip');
