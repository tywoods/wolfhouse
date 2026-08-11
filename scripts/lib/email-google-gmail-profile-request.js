'use strict';

const { types: utilTypes } = require('node:util');

const FAILURE_CODE = 'GOOGLE_GMAIL_PROFILE_REQUEST_FAILED';
const CONFIG_KEYS = Object.freeze(['requestTimeoutMs', 'responseBytesMax']);
const DEPENDENCY_KEYS = Object.freeze(['https', 'timers']);
const HTTPS_KEYS = Object.freeze(['request']);
const TIMER_KEYS = Object.freeze(['setTimeout', 'clearTimeout']);
const INPUT_KEYS = Object.freeze(['accessToken']);
const RESULT_KEYS = Object.freeze(['emailAddress', 'historyId']);
const OPTIONAL_TOTAL_KEYS = Object.freeze(['messagesTotal', 'threadsTotal']);
const REQUEST_TIMEOUT_MS = 5000;
const RESPONSE_BYTES_MAX = 16384;
const ACCESS_TOKEN_MAX = 8192;
const EMAIL_MAX = 320;
const TOTAL_MAX = 4294967295;
const HOSTNAME = 'gmail.googleapis.com';
const REQUEST_PATH = '/gmail/v1/users/me/profile';
const CONTENT_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*utf-8\s*)?$/i;
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;
const HISTORY_ID = /^(?:0|[1-9][0-9]*)$/;
const EMAIL_SHAPE = /^[^@]+@[^@]+$/;
const CONTENT_LENGTH = /^(?:0|[1-9]\d*)$/;

const ObjectFreeze = Object.freeze;
const ObjectIsFrozen = Object.isFrozen;
const ObjectGetPrototypeOf = Object.getPrototypeOf;
const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const ObjectCreate = Object.create;
const ObjectSetPrototypeOf = Object.setPrototypeOf;
const ObjectHasOwn = Object.hasOwn
  ? Object.hasOwn.bind(Object)
  : (target, key) => Object.prototype.hasOwnProperty.call(target, key);
const ReflectOwnKeys = Reflect.ownKeys.bind(Reflect);
const ReflectApply = Reflect.apply.bind(Reflect);
const RegExpTest = RegExp.prototype.test;
const StringTrim = String.prototype.trim;
const ArraySome = Array.prototype.some;
const ArrayIncludes = Array.prototype.includes;
const ArrayPush = Array.prototype.push;
const NumberIsInteger = Number.isInteger.bind(Number);
const NumberIsSafeInteger = Number.isSafeInteger.bind(Number);
const NumberConstructor = Number;
const BufferIsBuffer = Buffer.isBuffer.bind(Buffer);
const BufferFrom = Buffer.from.bind(Buffer);
const BufferConcat = Buffer.concat.bind(Buffer);

const BufferAlloc = Buffer.alloc.bind(Buffer);
const JsonParse = JSON.parse.bind(JSON);
const ArrayIsArray = Array.isArray.bind(Array);
const StringFrom = String;
const PinnedTextDecoder = TextDecoder;
const TextDecoderDecode = TextDecoder.prototype.decode;
const ErrorConstructor = Error;
const PromiseConstructor = Promise;
const PromiseReject = Promise.reject;
const PromiseCatch = Promise.prototype.catch;
const WeakSetConstructor = WeakSet;
const WeakSetHas = WeakSet.prototype.has;
const WeakSetAdd = WeakSet.prototype.add;
const PinnedIsProxy = utilTypes && typeof utilTypes.isProxy === 'function'
  ? utilTypes.isProxy.bind(utilTypes)
  : null;

const FAILURE_PROTOTYPE = ObjectCreate(Error.prototype);
Object.defineProperty(FAILURE_PROTOTYPE, 'name', {
  value: 'GoogleGmailProfileRequestError',
  writable: false,
  enumerable: false,
  configurable: false,
});
ObjectFreeze(FAILURE_PROTOTYPE);

function failure() {
  const error = new ErrorConstructor(FAILURE_CODE);
  ObjectSetPrototypeOf(error, FAILURE_PROTOTYPE);
  error.code = FAILURE_CODE;
  return ObjectFreeze(error);
}

function isProxyValue(value) {
  try {
    if (typeof PinnedIsProxy !== 'function') return true;
    return PinnedIsProxy(value) === true;
  } catch {
    return true;
  }
}

function exactFrozenRecord(value, names) {
  try {
    if (value === null || value === undefined || isProxyValue(value)) return null;
    if (ObjectGetPrototypeOf(value) !== Object.prototype || !ObjectIsFrozen(value)) return null;
    const keys = ReflectOwnKeys(value);
    if (keys.length !== names.length
        || ReflectApply(ArraySome, keys, [(key, index) => key !== names[index]])) return null;
    const record = ObjectCreate(null);
    for (const name of names) {
      const descriptor = ObjectGetOwnPropertyDescriptor(value, name);
      if (!descriptor || !ObjectHasOwn(descriptor, 'value') || !descriptor.enumerable
          || descriptor.writable || descriptor.configurable) {
        return null;
      }
      record[name] = descriptor.value;
    }
    return record;
  } catch {
    return null;
  }
}

function readConfiguration(configuration) {
  const record = exactFrozenRecord(configuration, CONFIG_KEYS);
  if (!record
      || record.requestTimeoutMs !== REQUEST_TIMEOUT_MS
      || record.responseBytesMax !== RESPONSE_BYTES_MAX) {
    throw failure();
  }
  return ObjectFreeze({
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    responseBytesMax: RESPONSE_BYTES_MAX,
  });
}

function readDependencies(dependencies) {
  const record = exactFrozenRecord(dependencies, DEPENDENCY_KEYS);
  if (!record) throw failure();
  const httpsRecord = exactFrozenRecord(record.https, HTTPS_KEYS);
  const timersRecord = exactFrozenRecord(record.timers, TIMER_KEYS);
  if (!httpsRecord || !timersRecord
      || typeof httpsRecord.request !== 'function'
      || typeof timersRecord.setTimeout !== 'function'
      || typeof timersRecord.clearTimeout !== 'function') {
    throw failure();
  }
  return ObjectFreeze({
    https: ObjectFreeze({ owner: record.https, request: httpsRecord.request }),
    timers: ObjectFreeze({
      owner: record.timers,
      setTimeout: timersRecord.setTimeout,
      clearTimeout: timersRecord.clearTimeout,
    }),
  });
}

function readAccessToken(input) {
  const record = exactFrozenRecord(input, INPUT_KEYS);
  if (!record) throw failure();
  const token = record.accessToken;
  if (typeof token !== 'string'
      || token.length < 1
      || token.length > ACCESS_TOKEN_MAX
      || !ReflectApply(RegExpTest, VISIBLE_ASCII, [token])) {
    throw failure();
  }
  return StringFrom(token);
}

function isNonNegativeUint32(value) {
  return typeof value === 'number'
    && NumberIsInteger(value)
    && value >= 0
    && value <= TOTAL_MAX;
}

function isEmailAddress(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= EMAIL_MAX
    && value === ReflectApply(StringTrim, value, [])
    && ReflectApply(RegExpTest, VISIBLE_ASCII, [value])
    && ReflectApply(RegExpTest, EMAIL_SHAPE, [value]);
}

function isHistoryId(value) {
  return typeof value === 'string' && ReflectApply(RegExpTest, HISTORY_ID, [value]);
}

function parseProfileBody(text) {
  let parsed;
  try {
    parsed = JsonParse(text);
  } catch {
    throw failure();
  }
  if (parsed === null || typeof parsed !== 'object' || ArrayIsArray(parsed)
      || ObjectGetPrototypeOf(parsed) !== Object.prototype) {
    throw failure();
  }
  let keys;
  try {
    keys = ReflectOwnKeys(parsed);
  } catch {
    throw failure();
  }
  if (ReflectApply(ArraySome, keys, [(key) => typeof key !== 'string'])) throw failure();
  if (!ReflectApply(ArrayIncludes, keys, ['emailAddress'])
      || !ReflectApply(ArrayIncludes, keys, ['historyId'])) throw failure();
  if (keys.length < 2 || keys.length > 4
      || ReflectApply(ArraySome, keys, [(key) => key !== 'emailAddress' && key !== 'historyId'
        && key !== 'messagesTotal' && key !== 'threadsTotal'])) throw failure();
  const emailAddress = parsed.emailAddress;
  const historyId = parsed.historyId;
  if (!isEmailAddress(emailAddress) || !isHistoryId(historyId)) throw failure();
  if (ObjectHasOwn(parsed, 'messagesTotal') && !isNonNegativeUint32(parsed.messagesTotal)) {
    throw failure();
  }
  if (ObjectHasOwn(parsed, 'threadsTotal') && !isNonNegativeUint32(parsed.threadsTotal)) {
    throw failure();
  }
  return ObjectFreeze({ emailAddress, historyId });
}

function chunkToBuffer(chunk) {
  if (BufferIsBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return BufferFrom(chunk, 'utf8');
  return null;
}

function readHeader(headers, name) {
  if (!headers || (typeof headers !== 'object' && typeof headers !== 'function')) {
    return undefined;
  }
  try {
    return headers[name];
  } catch {
    return undefined;
  }
}

function performGetProfile(accessToken, configuration, dependencies) {
  return new PromiseConstructor((resolve, reject) => {
    let finished = false;
    let request;
    let response;
    let requestDestroyed = false;
    let responseDestroyed = false;
    let timerHandle;
    let timerAcquired = false;
    let timerCleared = false;
    let responseSeen = false;
    let responseEnded = false;
    const lateResponses = new WeakSetConstructor();
    const maxBytes = configuration.responseBytesMax;
    const timeoutMs = configuration.requestTimeoutMs;

    function destroyRequest(target = request) {
      if (requestDestroyed || !target) return;
      requestDestroyed = true;
      try {
        if (typeof target.destroy === 'function') ReflectApply(target.destroy, target, []);
      } catch { /* best-effort cleanup */ }
    }

    function destroyResponse(target = response) {
      if (responseDestroyed || !target) return;
      responseDestroyed = true;
      try {
        if (typeof target.destroy === 'function') ReflectApply(target.destroy, target, []);
      } catch { /* best-effort cleanup */ }
    }

    function destroyLateResponse(target) {
      if (!target || (typeof target !== 'object' && typeof target !== 'function') || target === response) {
        return;
      }
      if (ReflectApply(WeakSetHas, lateResponses, [target])) return;
      ReflectApply(WeakSetAdd, lateResponses, [target]);
      try {
        if (typeof target.destroy === 'function') ReflectApply(target.destroy, target, []);
      } catch { /* best-effort late cleanup */ }
    }

    function clearTimer() {
      if (!timerAcquired || timerCleared) return;
      timerCleared = true;
      try {
        ReflectApply(dependencies.timers.clearTimeout, dependencies.timers.owner, [timerHandle]);
      } catch { /* cleanup cannot alter settlement */ }
    }

    function fail() {
      if (finished) return;
      finished = true;
      clearTimer();
      destroyRequest();
      destroyResponse();
      reject(failure());
    }

    function succeed(result) {
      if (finished) return;
      finished = true;
      clearTimer();
      resolve(result);
    }

    try {
      timerHandle = ReflectApply(dependencies.timers.setTimeout, dependencies.timers.owner, [fail, timeoutMs]);
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
      if (finished || responseSeen) {
        destroyLateResponse(incoming);
        return;
      }
      responseSeen = true;
      response = incoming;
      const chunks = [];
      let size = 0;
      let declaredLength;

      try {
        if (!incoming || typeof incoming.on !== 'function' || typeof incoming.destroy !== 'function'
            || incoming.statusCode !== 200) {
          fail();
          return;
        }
        const headers = incoming.headers;
        if (!headers || (typeof headers !== 'object' && typeof headers !== 'function')) {
          fail();
          return;
        }
        const contentType = readHeader(headers, 'content-type');
        if (typeof contentType !== 'string' || !ReflectApply(RegExpTest, CONTENT_TYPE, [contentType])) {
          fail();
          return;
        }
        const location = readHeader(headers, 'location');
        if (ArrayIsArray(location)) {
          fail();
          return;
        }
        const rawLength = readHeader(headers, 'content-length');
        if (rawLength !== undefined) {
          if (typeof rawLength !== 'string' || !ReflectApply(RegExpTest, CONTENT_LENGTH, [rawLength])) {
            fail();
            return;
          }
          declaredLength = NumberConstructor(rawLength);
          if (!NumberIsSafeInteger(declaredLength) || declaredLength > maxBytes) {
            fail();
            return;
          }
        }

        incoming.on('data', (chunk) => {
          if (finished) return;
          const bytes = chunkToBuffer(chunk);
          if (!bytes || bytes.length > maxBytes - size) {
            fail();
            return;
          }
          size += bytes.length;
          ReflectApply(ArrayPush, chunks, [bytes]);
        });
        incoming.on('end', () => {
          if (finished) return;
          responseEnded = true;
          if (declaredLength !== undefined && declaredLength !== size) {
            fail();
            return;
          }
          let decoded;
          try {
            const body = size === 0 ? BufferAlloc(0) : BufferConcat(chunks, size);
            const decoder = new PinnedTextDecoder('utf-8', { fatal: true });
            decoded = ReflectApply(TextDecoderDecode, decoder, [body]);
          } catch {
            fail();
            return;
          }
          try {
            succeed(parseProfileBody(decoded));
          } catch {
            fail();
          }
        });
        incoming.on('aborted', fail);
        incoming.on('error', fail);
        incoming.on('timeout', fail);
        incoming.on('close', () => {
          if (!responseEnded) fail();
        });
      } catch {
        fail();
      }
    }

    try {
      const options = ObjectFreeze({
        protocol: 'https:',
        hostname: HOSTNAME,
        port: 443,
        method: 'GET',
        path: REQUEST_PATH,
        headers: ObjectFreeze({
          Authorization: 'Bearer ' + accessToken,
          Accept: 'application/json',
        }),
      });
      const acquired = ReflectApply(dependencies.https.request, dependencies.https.owner, [
        options,
        onResponse,
      ]);
      request = acquired;
      if (finished) {
        destroyRequest(acquired);
        return;
      }
      if (!acquired || typeof acquired.on !== 'function' || typeof acquired.end !== 'function'
          || typeof acquired.destroy !== 'function') {
        fail();
        return;
      }
      acquired.on('error', fail);
      acquired.on('abort', fail);
      acquired.on('timeout', fail);
      acquired.on('close', () => {
        if (!responseSeen) fail();
      });
      if (!finished) ReflectApply(acquired.end, acquired, []);
    } catch {
      fail();
    }
  });
}

function createGoogleGmailProfileRequest(configuration, dependencies) {
  const pinnedConfiguration = readConfiguration(configuration);
  const pinnedDependencies = readDependencies(dependencies);
  let used = false;

  function getProfile(input) {
    if (used) return ReflectApply(PromiseReject, PromiseConstructor, [failure()]);
    used = true;
    try {
      const accessToken = readAccessToken(input);
      return ReflectApply(PromiseCatch,
        performGetProfile(accessToken, pinnedConfiguration, pinnedDependencies), [() => {
        throw failure();
        }]);
    } catch {
      return ReflectApply(PromiseReject, PromiseConstructor, [failure()]);
    }
  }

  return ObjectFreeze({ getProfile });
}

module.exports = ObjectFreeze({ createGoogleGmailProfileRequest });
