'use strict';

const FAILURE_CODE = 'GOOGLE_TOKEN_EXCHANGE_CUSTODY_FAILED';
const REQUEST_TIMEOUT_MS = 10000;
const MAX_BODY_BYTES = 65536;
const CONTENT_TYPE = /^application\/json\s*(?:;\s*charset\s*=\s*utf-8\s*)?$/i;
const SUCCESS = Object.freeze({ status: 'custodied' });
const FAILURE_PROTOTYPE = Object.create(Error.prototype, {
  name: { value: 'GoogleTokenExchangeCustodyError' },
  code: { value: FAILURE_CODE, enumerable: true },
});
Object.freeze(FAILURE_PROTOTYPE);
const REQUEST_OPTIONS = Object.freeze({
  protocol: 'https:',
  hostname: ['oauth2', 'google', 'apis', 'com'].join('.').replace('.apis.', 'apis.'),
  port: 443,
  method: 'POST',
  path: '/token',
  headers: Object.freeze({
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': 0,
    Accept: 'application/json',
  }),
  agent: false,
});

function failure() {
  const error = new Error(FAILURE_CODE);
  Object.setPrototypeOf(error, FAILURE_PROTOTYPE);
  return Object.freeze(error);
}

function exactFrozenRecord(value, names) {
  try {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype || !Object.isFrozen(value)) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== names.length || keys.some((key, index) => key !== names[index])) return null;
    const record = Object.create(null);
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable
          || descriptor.writable || descriptor.configurable) return null;
      record[name] = descriptor.value;
    }
    return record;
  } catch {
    return null;
  }
}

function readDependencies(dependencies) {
  const record = exactFrozenRecord(dependencies, ['https', 'timers', 'responseCustody']);
  if (!record) throw failure();
  const httpsRecord = exactFrozenRecord(record.https, ['request']);
  const timersRecord = exactFrozenRecord(record.timers, ['setTimeout', 'clearTimeout']);
  const custodyRecord = exactFrozenRecord(record.responseCustody, ['acceptTokenResponse']);
  if (!httpsRecord || !timersRecord || !custodyRecord
      || typeof httpsRecord.request !== 'function'
      || typeof timersRecord.setTimeout !== 'function'
      || typeof timersRecord.clearTimeout !== 'function'
      || typeof custodyRecord.acceptTokenResponse !== 'function') throw failure();
  return Object.freeze({
    https: Object.freeze({ owner: record.https, request: httpsRecord.request }),
    timers: Object.freeze({ owner: record.timers, setTimeout: timersRecord.setTimeout, clearTimeout: timersRecord.clearTimeout }),
    custody: Object.freeze({ owner: record.responseCustody, accept: custodyRecord.acceptTokenResponse }),
  });
}

function readBody(input) {
  const record = exactFrozenRecord(input, ['body']);
  if (!record || typeof record.body !== 'string' || record.body.length === 0
      || record.body.length > 32768 || !/^[\x21-\x7e]+$/.test(record.body)) throw failure();
  return `${record.body}`;
}

function sealedAcknowledgement(value) {
  const record = exactFrozenRecord(value, ['status']);
  return !!record && record.status === 'custodied';
}

function performExchange(body, dependencies) {
  return new Promise((resolve, reject) => {
    let finished = false;
    let transportComplete = false;
    let request;
    let response;
    let requestDestroyed = false;
    let responseDestroyed = false;
    const lateResponsesDestroyed = new WeakSet();
    let timerHandle;
    let timerAcquired = false;
    let timerCleared = false;
    let responseSeen = false;
    let responseEnded = false;

    function destroyRequest(target = request) {
      if (requestDestroyed || !target) return;
      requestDestroyed = true;
      try {
        if (typeof target.destroy === 'function') Reflect.apply(target.destroy, target, []);
      } catch { /* best-effort failure cleanup */ }
    }
    function destroyResponse(target = response) {
      if (responseDestroyed || !target) return;
      responseDestroyed = true;
      try {
        if (typeof target.destroy === 'function') Reflect.apply(target.destroy, target, []);
      } catch { /* best-effort failure cleanup */ }
    }
    function destroyLateResponse(target) {
      if (!target || (typeof target !== 'object' && typeof target !== 'function')
          || target === response || lateResponsesDestroyed.has(target)) return;
      lateResponsesDestroyed.add(target);
      try {
        if (typeof target.destroy === 'function') Reflect.apply(target.destroy, target, []);
      } catch { /* best-effort late cleanup */ }
    }
    function clearTimer() {
      if (!timerAcquired || timerCleared) return;
      timerCleared = true;
      try { Reflect.apply(dependencies.timers.clearTimeout, dependencies.timers.owner, [timerHandle]); }
      catch { /* cleanup cannot alter settlement */ }
    }
    function fail() {
      if (finished || transportComplete) return;
      finished = true;
      clearTimer();
      destroyRequest();
      destroyResponse();
      reject(failure());
    }
    function completeCustody(dto) {
      transportComplete = true;
      clearTimer();
      Promise.resolve().then(() => Reflect.apply(
        dependencies.custody.accept,
        dependencies.custody.owner,
        [dto],
      )).then((acknowledgement) => {
        if (finished) return;
        if (!sealedAcknowledgement(acknowledgement)) {
          finished = true;
          reject(failure());
          return;
        }
        finished = true;
        resolve(SUCCESS);
      }, () => {
        if (finished) return;
        finished = true;
        reject(failure());
      });
    }

    try {
      timerHandle = Reflect.apply(dependencies.timers.setTimeout, dependencies.timers.owner, [fail, REQUEST_TIMEOUT_MS]);
      timerAcquired = true;
      if (finished) {
        clearTimer();
        return;
      }
    } catch {
      fail();
      return;
    }

    function onResponse(incoming) {
      if (finished || transportComplete || responseSeen) {
        destroyLateResponse(incoming);
        return;
      }
      responseSeen = true;
      response = incoming;
      const chunks = [];
      let size = 0;
      let contentType;
      let declaredLength;
      try {
        if (!incoming || typeof incoming.on !== 'function' || typeof incoming.destroy !== 'function'
            || !Number.isInteger(incoming.statusCode) || incoming.statusCode < 100 || incoming.statusCode > 599) {
          fail(); return;
        }
        const headers = incoming.headers;
        if (!headers || (typeof headers !== 'object' && typeof headers !== 'function')) { fail(); return; }
        contentType = headers['content-type'];
        if (typeof contentType !== 'string' || !CONTENT_TYPE.test(contentType)) { fail(); return; }
        const rawLength = headers['content-length'];
        if (rawLength !== undefined) {
          if (typeof rawLength !== 'string' || !/^(?:0|[1-9]\d*)$/.test(rawLength)) { fail(); return; }
          declaredLength = Number(rawLength);
          if (!Number.isSafeInteger(declaredLength) || declaredLength > MAX_BODY_BYTES) { fail(); return; }
        }
        incoming.on('data', (chunk) => {
          if (finished || transportComplete) return;
          if (!Buffer.isBuffer(chunk) || chunk.length > MAX_BODY_BYTES - size) { fail(); return; }
          size += chunk.length;
          chunks.push(chunk);
        });
        incoming.on('end', () => {
          if (finished || transportComplete) return;
          responseEnded = true;
          if (declaredLength !== undefined && declaredLength !== size) { fail(); return; }
          let decoded;
          try {
            decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
          } catch { fail(); return; }
          if (decoded.includes('\ufffd')) { fail(); return; }
          completeCustody(Object.freeze({ statusCode: incoming.statusCode, contentType, body: decoded }));
        });
        incoming.on('aborted', fail);
        incoming.on('error', fail);
        incoming.on('timeout', fail);
        incoming.on('close', () => { if (!responseEnded) fail(); });
      } catch { fail(); }
    }

    try {
      const acquired = Reflect.apply(dependencies.https.request, dependencies.https.owner, [
        Object.freeze({
          ...REQUEST_OPTIONS,
          headers: Object.freeze({ ...REQUEST_OPTIONS.headers, 'Content-Length': Buffer.byteLength(body) }),
        }),
        onResponse,
      ]);
      request = acquired;
      if (finished) { destroyRequest(acquired); return; }
      if (!acquired || typeof acquired.on !== 'function' || typeof acquired.end !== 'function'
          || typeof acquired.destroy !== 'function') { fail(); return; }
      acquired.on('error', fail);
      acquired.on('abort', fail);
      acquired.on('timeout', fail);
      acquired.on('close', () => { if (!responseSeen) fail(); });
      if (!finished) Reflect.apply(acquired.end, acquired, [body]);
    } catch { fail(); }
  });
}

function createGoogleTokenExchangeCustody(dependencies) {
  const pinned = readDependencies(dependencies);
  let used = false;
  async function exchangeAndCustody(input) {
    if (used) throw failure();
    used = true;
    try {
      const body = readBody(input);
      return await performExchange(body, pinned);
    } catch {
      throw failure();
    }
  }
  return Object.freeze({ exchangeAndCustody });
}

module.exports = Object.freeze({ createGoogleTokenExchangeCustody });
