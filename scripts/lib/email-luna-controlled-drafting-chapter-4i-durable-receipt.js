'use strict';

/**
 * FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4I — operator-owned
 * durable one-shot receipt/lease. File-backed. Not caller-chosen in
 * production. Not stored in the repo. Survives new Node processes and
 * worker threads. Does not use Postgres, OAuth grants, 097/098, or flags.
 *
 * @module email-luna-controlled-drafting-chapter-4i-durable-receipt
 */

const fs = require('node:fs');
const path = require('node:path');
const { isProxySurface, ownData } = require('./email-luna-controlled-drafting-closed-data');

const objectFreeze = Object.freeze;
const objectCreate = Object.create;
const arrayIsArray = Array.isArray;

const ERROR_CODE = 'EMAIL_LUNA_CONTROLLED_DRAFTING_CHAPTER_4I_LIVE_EXECUTION_INVALID';
const ERROR_MESSAGE = 'Email Luna controlled drafting Chapter 4I live execution failed.';
const CHAPTER_ID = 'chapter_4i';
const DETAIL_RE = /^[a-z][a-z0-9_]{0,63}$/;
const OPERATOR_RECEIPT_DIR = '/var/lib/wolfhouse/full-sail-chapter-4i';
const OPERATOR_RECEIPT_FILENAME = 'sunset-staging-one-shot.receipt';
const OPERATOR_RECEIPT_PATH = path.join(OPERATOR_RECEIPT_DIR, OPERATOR_RECEIPT_FILENAME);
const RECEIPT_MODE = 0o600;
const DIR_MODE = 0o700;

const RECEIPT_STATES = objectFreeze({
  claimed: 'claimed',
  refresh_1_started: 'refresh_1_started',
  refresh_1_completed: 'refresh_1_completed',
  refresh_2_started: 'refresh_2_started',
  refresh_2_completed: 'refresh_2_completed',
  terminal_success: 'terminal_success',
  terminal_unknown: 'terminal_unknown',
  terminal_refused: 'terminal_refused',
});

const RECEIPT_KEYS = objectFreeze([
  'chapter_id',
  'source_sha',
  'deploy_sha',
  'revision',
  'digest',
  'deployment',
  'tenant',
  'database',
  'resource_group',
  'app_name',
  'operator_nonce',
  'confirm_issued_at',
  'status',
  'refresh_call_count',
  'local_receipt_write_count',
  'custody_write_count',
  'operational_write_count',
  'claimed_at',
  'updated_at',
]);

const OWNED_4I = 'email-luna-controlled-drafting-sunset-staging-live-execution-owner-owned.js';
const TEST_SUPPORT = 'email-luna-controlled-drafting-sunset-staging-live-execution-owner.test-support.js';

function failure(code) {
  const error = new Error(ERROR_MESSAGE);
  error.code = ERROR_CODE;
  if (typeof code === 'string' && DETAIL_RE.test(code)) error.detail = code;
  objectFreeze(error);
  return error;
}

function authenticLibCaller(allowedBasenames) {
  const libDir = fs.realpathSync(__dirname);
  const self = fs.realpathSync(__filename);
  const previous = Error.prepareStackTrace;
  let stack;
  try {
    Error.prepareStackTrace = (_, frames) => frames;
    const err = new Error();
    Error.captureStackTrace(err, authenticLibCaller);
    stack = err.stack;
  } catch (_) {
    return false;
  } finally {
    Error.prepareStackTrace = previous;
  }
  if (!arrayIsArray(stack) || stack.length < 1) return false;
  for (let i = 0; i < stack.length; i += 1) {
    const frame = stack[i];
    if (!frame || typeof frame.getFileName !== 'function') continue;
    const file = frame.getFileName();
    if (typeof file !== 'string' || file.length < 1) continue;
    let real;
    try {
      real = fs.realpathSync(file);
    } catch (_) {
      continue;
    }
    if (real === self) continue;
    if (path.dirname(real) !== libDir) return false;
    return allowedBasenames.indexOf(path.basename(real)) !== -1;
  }
  return false;
}

function allowlistedReceipt(fields) {
  const obj = objectCreate(null);
  for (let i = 0; i < RECEIPT_KEYS.length; i += 1) {
    const key = RECEIPT_KEYS[i];
    obj[key] = fields[key] === undefined ? null : fields[key];
  }
  return objectFreeze(obj);
}

function parseReceiptBuffer(buf) {
  let parsed;
  try {
    parsed = JSON.parse(String(buf));
  } catch (_) {
    throw failure('operator_receipt_unproven');
  }
  if (!parsed || typeof parsed !== 'object' || arrayIsArray(parsed) || isProxySurface(parsed)) {
    throw failure('operator_receipt_unproven');
  }
  const fields = objectCreate(null);
  for (let i = 0; i < RECEIPT_KEYS.length; i += 1) {
    const key = RECEIPT_KEYS[i];
    fields[key] = ownData(parsed, key);
  }
  return allowlistedReceipt(fields);
}

function fsyncDirectory(dirPath) {
  try {
    const fd = fs.openSync(dirPath, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
    /* directory fsync is not supported on every filesystem */
  }
}

function writeReceiptAtomic(filePath, record) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  const body = `${JSON.stringify(record)}\n`;
  const fd = fs.openSync(tmp, 'w', RECEIPT_MODE);
  try {
    fs.writeSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.chmodSync(tmp, RECEIPT_MODE);
  } catch (_) { /* sanitized */ }
  fs.renameSync(tmp, filePath);
  fsyncDirectory(dir);
}

function claimReceiptAt(filePath, payload) {
  const record = allowlistedReceipt(payload);
  let fd;
  try {
    fd = fs.openSync(
      filePath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      RECEIPT_MODE,
    );
  } catch (err) {
    if (err && err.code === 'EEXIST') throw failure('operator_receipt_replay');
    throw failure('operator_receipt_unproven');
  }
  try {
    fs.writeSync(fd, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(fd);
  } catch (err) {
    try { fs.closeSync(fd); } catch (_) { /* sanitized */ }
    throw failure('operator_receipt_unproven');
  }
  try {
    fs.closeSync(fd);
  } catch (_) { /* sanitized */ }
  fsyncDirectory(path.dirname(filePath));
  return record;
}

function readReceiptAt(filePath) {
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw failure('operator_receipt_unproven');
  }
  return parseReceiptBuffer(buf);
}

function advanceReceiptAt(filePath, status, extra) {
  const current = readReceiptAt(filePath);
  if (!current) throw failure('operator_receipt_unproven');
  const writes = typeof current.local_receipt_write_count === 'number'
    ? current.local_receipt_write_count + 1
    : 1;
  const next = allowlistedReceipt(Object.assign({}, current, extra || {}, {
    status,
    local_receipt_write_count: writes,
    updated_at: extra && extra.updated_at ? extra.updated_at : new Date().toISOString(),
  }));
  writeReceiptAtomic(filePath, next);
  return next;
}

function createStoreAt(filePath) {
  const resolved = path.resolve(filePath);
  if (!path.isAbsolute(resolved)) throw failure('operator_receipt_unproven');
  let claimedInThisHandle = false;
  return objectFreeze({
    path: resolved,
    claimedInThisHandle() {
      return claimedInThisHandle === true;
    },
    claim(payload) {
      const record = claimReceiptAt(resolved, payload);
      claimedInThisHandle = true;
      return record;
    },
    read() {
      return readReceiptAt(resolved);
    },
    advance(status, extra) {
      return advanceReceiptAt(resolved, status, extra);
    },
  });
}

function createChapter4IReceiptStore(input) {
  if (input === undefined || input === null) {
    return createStoreAt(OPERATOR_RECEIPT_PATH);
  }
  if (!input || typeof input !== 'object' || isProxySurface(input) || arrayIsArray(input)) {
    throw failure('caller_input_refused');
  }
  const keys = Reflect.ownKeys(input);
  if (keys.length !== 1 || keys[0] !== 'path') throw failure('caller_input_refused');
  if (authenticLibCaller([OWNED_4I, TEST_SUPPORT]) !== true) {
    throw failure('caller_input_refused');
  }
  const customPath = ownData(input, 'path');
  if (typeof customPath !== 'string' || !path.isAbsolute(customPath)) {
    throw failure('operator_receipt_unproven');
  }
  if (customPath.includes('\0') || customPath.includes('..')) {
    throw failure('operator_receipt_unproven');
  }
  return createStoreAt(customPath);
}

function prepareOperatorReceiptDirectory() {
  try {
    fs.mkdirSync(OPERATOR_RECEIPT_DIR, { recursive: true, mode: DIR_MODE });
    fs.chmodSync(OPERATOR_RECEIPT_DIR, DIR_MODE);
  } catch (_) {
    throw failure('operator_receipt_unproven');
  }
}

const PUBLIC_KEYS = objectFreeze([
  'ERROR_CODE',
  'ERROR_MESSAGE',
  'CHAPTER_ID',
  'OPERATOR_RECEIPT_DIR',
  'OPERATOR_RECEIPT_FILENAME',
  'OPERATOR_RECEIPT_PATH',
  'RECEIPT_STATES',
  'RECEIPT_KEYS',
]);

const publicSurface = objectFreeze({
  ERROR_CODE,
  ERROR_MESSAGE,
  CHAPTER_ID,
  OPERATOR_RECEIPT_DIR,
  OPERATOR_RECEIPT_FILENAME,
  OPERATOR_RECEIPT_PATH,
  RECEIPT_STATES,
  RECEIPT_KEYS,
});

module.exports = new Proxy(publicSurface, {
  get(target, prop) {
    if (prop === 'createChapter4IReceiptStore') {
      if (authenticLibCaller([OWNED_4I, TEST_SUPPORT]) !== true) return undefined;
      return createChapter4IReceiptStore;
    }
    if (prop === 'prepareOperatorReceiptDirectory') {
      if (authenticLibCaller([OWNED_4I, TEST_SUPPORT]) !== true) return undefined;
      return prepareOperatorReceiptDirectory;
    }
    return target[prop];
  },
  has(target, prop) {
    if (prop === 'createChapter4IReceiptStore' || prop === 'prepareOperatorReceiptDirectory') {
      return false;
    }
    return Object.prototype.hasOwnProperty.call(target, prop);
  },
  ownKeys() {
    return PUBLIC_KEYS.slice();
  },
  getOwnPropertyDescriptor(target, prop) {
    if (prop === 'createChapter4IReceiptStore' || prop === 'prepareOperatorReceiptDirectory') {
      return undefined;
    }
    return Object.getOwnPropertyDescriptor(target, prop);
  },
  set() { return false; },
  defineProperty() { return false; },
  deleteProperty() { return false; },
});
