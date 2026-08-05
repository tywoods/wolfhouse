'use strict';

const https = require('node:https');

const TOKEN_HOST = 'login.microsoftonline.com';
const TOKEN_PATH = '/organizations/oauth2/v2.0/token';
const RESPONSE_LIMIT_BYTES = 65_536;
const DEADLINE_MS = 10_000;

function fixedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function snapshotBody(input) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) return null;
  if (Object.getPrototypeOf(input) !== Object.prototype) return null;
  const keys = Reflect.ownKeys(input);
  if (keys.length !== 1 || keys[0] !== 'body') return null;
  const descriptor = Object.getOwnPropertyDescriptor(input, 'body');
  if (!descriptor || descriptor.get || descriptor.set || typeof descriptor.value !== 'string') return null;
  return descriptor.value;
}

function createMicrosoftTokenHttpTransport(deps = {}) {
  const httpsImpl = deps.httpsImpl || https;
  const timers = deps.timers || { setTimeout, clearTimeout };

  function postTokenForm(input) {
    const body = snapshotBody(input);
    if (body === null) return Promise.reject(fixedError('microsoft_token_request_invalid'));

    return new Promise((resolve, reject) => {
      let request;
      let response;
      let timer;
      let settled = false;

      function finish(error, value) {
        if (settled) return;
        settled = true;
        if (timer !== undefined) timers.clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      }

      const options = Object.freeze({
        protocol: 'https:',
        hostname: TOKEN_HOST,
        port: 443,
        method: 'POST',
        path: TOKEN_PATH,
        headers: Object.freeze({
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          Accept: 'application/json',
        }),
      });

      try {
        request = httpsImpl.request(options, (incoming) => {
          response = incoming;
          const chunks = [];
          let byteCount = 0;

          incoming.on('data', (chunk) => {
            if (settled) return;
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            byteCount += bytes.length;
            if (byteCount > RESPONSE_LIMIT_BYTES) {
              const error = fixedError('microsoft_token_response_too_large');
              finish(error);
              incoming.destroy(error);
              request.destroy(error);
              return;
            }
            chunks.push(bytes);
          });
          incoming.on('end', () => {
            if (settled) return;
            const rawContentType = incoming.headers && incoming.headers['content-type'];
            const contentType = Array.isArray(rawContentType) ? rawContentType[0] : rawContentType;
            finish(null, Object.freeze({
              statusCode: Number.isInteger(incoming.statusCode) ? incoming.statusCode : 0,
              contentType: typeof contentType === 'string' ? contentType : '',
              body: Buffer.concat(chunks, byteCount).toString('utf8'),
            }));
          });
          incoming.on('error', () => finish(fixedError('microsoft_token_transport_failed')));
        });
        request.on('error', () => finish(fixedError('microsoft_token_transport_failed')));
        timer = timers.setTimeout(() => {
          if (settled) return;
          const error = fixedError('microsoft_token_request_timed_out');
          finish(error);
          if (response && typeof response.destroy === 'function') response.destroy(error);
          request.destroy(error);
        }, DEADLINE_MS);
        request.end(body);
      } catch (_) {
        if (request && typeof request.destroy === 'function') request.destroy();
        finish(fixedError('microsoft_token_transport_failed'));
      }
    });
  }

  return Object.freeze({ postTokenForm });
}

module.exports = Object.freeze({
  TOKEN_HOST,
  TOKEN_PATH,
  RESPONSE_LIMIT_BYTES,
  DEADLINE_MS,
  createMicrosoftTokenHttpTransport,
});
