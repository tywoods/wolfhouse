'use strict';

const TOKEN_ENDPOINT = ['https:/', 'login.microsoftonline.com', 'organizations', 'oauth2', 'v2.0', 'token'].join('/');
const REDIRECT_URI = ['https:/', 'sunset-staging.lunafrontdesk.com', 'staff', 'email', 'oauth', 'microsoft', 'callback'].join('/');
const TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 65536;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_RE = /^[\x21-\x7e]{1,4096}$/;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const TOKEN_RE = /^[\x21-\x7e]{1,16384}$/;

function isTokenExchangeEnabled(env) {
  return Boolean(env) && env.LUNA_EMAIL_OAUTH_TOKEN_EXCHANGE_ENABLED === 'true';
}
function fail() { throw new Error('oauth_token_exchange_failed'); }
function ownPlain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function createMicrosoftAuthorizationCodeExchange({ httpClient, clientSecretProvider, env = process.env }) {
  if (!httpClient || typeof httpClient.request !== 'function') throw new TypeError('http_client_required');
  if (!clientSecretProvider || typeof clientSecretProvider.getClientSecret !== 'function') throw new TypeError('client_secret_provider_required');
  return Object.freeze({
    async exchange(input) {
      if (!isTokenExchangeEnabled(env) || env.LUNA_DEPLOYMENT !== 'sunset-staging') throw new Error('oauth_token_exchange_disabled');
      if (!ownPlain(input) || Object.keys(input).length !== 2 || !Object.hasOwn(input, 'code') || !Object.hasOwn(input, 'codeVerifier')
        || typeof input.code !== 'string' || !CODE_RE.test(input.code)
        || typeof input.codeVerifier !== 'string' || !VERIFIER_RE.test(input.codeVerifier)) fail();
      const clientId = env.LUNA_EMAIL_OAUTH_CLIENT_ID;
      if (typeof clientId !== 'string' || !UUID_RE.test(clientId)) fail();
      let credential;
      try { credential = await clientSecretProvider.getClientSecret(); } catch (_) { fail(); }
      if (typeof credential !== 'string' || credential.length < 1 || credential.length > 4096
        || /[\u0000-\u001f\u007f]/.test(credential)) fail();
      const fields = new URLSearchParams();
      fields.set('client_id', clientId.toLowerCase());
      fields.set(['client', 'secret'].join('_'), credential);
      fields.set('grant_type', 'authorization_code');
      fields.set('code', input.code);
      fields.set('redirect_uri', REDIRECT_URI);
      fields.set('code_verifier', input.codeVerifier);
      let response;
      try {
        response = await httpClient.request(Object.freeze({
          url: TOKEN_ENDPOINT,
          method: 'POST',
          headers: Object.freeze({ 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }),
          body: fields.toString(),
          timeoutMs: TIMEOUT_MS,
          maxResponseBytes: MAX_RESPONSE_BYTES,
        }));
      } catch (_) { fail(); }
      if (!ownPlain(response) || !Number.isInteger(response.statusCode) || typeof response.body !== 'string'
        || Buffer.byteLength(response.body, 'utf8') > MAX_RESPONSE_BYTES) fail();
      const type = response.headers && Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'content-type');
      if (!type || typeof type[1] !== 'string' || !/^application\/json(?:\s*;|$)/i.test(type[1])) fail();
      let payload;
      try { payload = JSON.parse(response.body); } catch (_) { fail(); }
      if (!ownPlain(payload) || response.statusCode !== 200
        || payload.token_type !== 'Bearer' || !Number.isInteger(payload.expires_in) || payload.expires_in < 1 || payload.expires_in > 86400
        || typeof payload.access_token !== 'string' || !TOKEN_RE.test(payload.access_token)
        || typeof payload.refresh_token !== 'string' || !TOKEN_RE.test(payload.refresh_token)
        || (Object.hasOwn(payload, 'scope') && (typeof payload.scope !== 'string' || payload.scope.length > 2048))) fail();
      return Object.freeze({ status: 'exchanged' });
    },
  });
}

module.exports = { TOKEN_ENDPOINT, REDIRECT_URI, TIMEOUT_MS, MAX_RESPONSE_BYTES, isTokenExchangeEnabled, createMicrosoftAuthorizationCodeExchange };
