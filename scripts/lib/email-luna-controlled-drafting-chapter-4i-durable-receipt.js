'use strict';

/**
 * FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4I — operator-owned
 * durable one-shot receipt/lease. File-backed. Canonical production path
 * is not caller-chosen and is not stored in the repo. Survives new Node
 * processes and worker threads. Does not use Postgres, OAuth grants,
 * 097/098, or flags.
 *
 * This is a data-only helper: importing it performs no claim, no mkdir,
 * and no network. Creating a store at a path is local file I/O only and
 * cannot initiate live adapters.
 *
 * Boundary: O_CREAT|O_EXCL plus fsync is an accidental/concurrent replay
 * guard. It does not stop a malicious same-UID operator who deletes or
 * replaces the receipt. Deletion/replacement is a prohibited manual
 * override and requires fresh explicit user authorization. The actual
 * no-retry authority is the operator's one-run authorization plus the
 * terminal uncertainty policy.
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

const TERMINAL_STATES = objectFreeze([
  RECEIPT_STATES.terminal_success,
  RECEIPT_STATES.terminal_unknown,
  RECEIPT_STATES.terminal_refused,
]);

const RECEIPT_KEYS = objectFreeze([
  'chapter_id',
  'source_sha',
  'source_tree',
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

function failure(code) {
  const error = new Error(ERROR_MESSAGE);
  error.code = ERROR_CODE;
  if (typeof code === 'string' && DETAIL_RE.test(code)) error.detail = code;
  objectFreeze(error);
  return error;
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

function lstatNoFollow(absPath) {
  try {
    return fs.lstatSync(absPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw failure('operator_receipt_unproven');
  }
}

function inspectReceiptDirectory(dirPath) {
  if (typeof dirPath !== 'string' || !path.isAbsolute(dirPath) || dirPath.includes('\0')) {
    throw failure('operator_receipt_unproven');
  }
  const resolved = path.resolve(dirPath);
  const st = lstatNoFollow(resolved);
  if (!st) {
    return objectFreeze({
      path: resolved,
      exists: false,
      ready: false,
      reason: 'receipt_dir_missing',
    });
  }
  if (st.isSymbolicLink()) throw failure('operator_receipt_symlink');
  if (!st.isDirectory()) throw failure('operator_receipt_unproven');
  let real;
  try {
    real = fs.realpathSync(resolved);
  } catch (_) {
    throw failure('operator_receipt_unproven');
  }
  if (real !== resolved) throw failure('operator_receipt_symlink');
  const mode = st.mode & 0o777;
  if (mode !== DIR_MODE) throw failure('operator_receipt_dir_mode');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw failure('operator_receipt_dir_owner');
  }
  return objectFreeze({
    path: resolved,
    exists: true,
    ready: true,
    reason: null,
  });
}

function inspectReceiptPath(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.includes('\0')) {
    throw failure('operator_receipt_unproven');
  }
  if (filePath.includes('..')) throw failure('operator_receipt_unproven');
  const resolved = path.resolve(filePath);
  const dir = path.dirname(resolved);
  const dirInfo = inspectReceiptDirectory(dir);
  const st = lstatNoFollow(resolved);
  if (!st) {
    return objectFreeze({
      path: resolved,
      dir: dirInfo,
      exists: false,
      status: null,
      reason: dirInfo.ready === true ? 'receipt_absent' : dirInfo.reason,
    });
  }
  if (st.isSymbolicLink()) throw failure('operator_receipt_symlink');
  if (!st.isFile()) throw failure('operator_receipt_unproven');
  const mode = st.mode & 0o777;
  if (mode !== RECEIPT_MODE) throw failure('operator_receipt_mode');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw failure('operator_receipt_owner');
  }
  const record = parseReceiptBuffer(fs.readFileSync(resolved));
  const status = ownData(record, 'status');
  const blocking = status !== null && status !== undefined;
  return objectFreeze({
    path: resolved,
    dir: dirInfo,
    exists: true,
    status,
    blocking: blocking === true,
    reason: blocking === true ? 'operator_receipt_replay' : null,
    record,
  });
}

function writeReceiptAtomic(filePath, record) {
  const dir = path.dirname(filePath);
  inspectReceiptDirectory(dir);
  const existing = lstatNoFollow(filePath);
  if (existing && existing.isSymbolicLink()) throw failure('operator_receipt_symlink');
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
  const tmpStat = lstatNoFollow(tmp);
  if (!tmpStat || tmpStat.isSymbolicLink()) {
    try { fs.unlinkSync(tmp); } catch (_) { /* sanitized */ }
    throw failure('operator_receipt_symlink');
  }
  fs.renameSync(tmp, filePath);
  fsyncDirectory(dir);
}

function claimReceiptAt(filePath, payload) {
  inspectReceiptDirectory(path.dirname(filePath));
  const existing = lstatNoFollow(filePath);
  if (existing) {
    if (existing.isSymbolicLink()) throw failure('operator_receipt_symlink');
    throw failure('operator_receipt_replay');
  }
  const record = allowlistedReceipt(payload);
  let fd;
  try {
    fd = fs.openSync(
      filePath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
      RECEIPT_MODE,
    );
  } catch (err) {
    if (err && err.code === 'EEXIST') throw failure('operator_receipt_replay');
    if (err && (err.code === 'ELOOP' || err.code === 'EMLINK')) throw failure('operator_receipt_symlink');
    throw failure('operator_receipt_unproven');
  }
  try {
    fs.writeSync(fd, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(fd);
    try { fs.fchmodSync(fd, RECEIPT_MODE); } catch (_) { /* sanitized */ }
  } catch (err) {
    try { fs.closeSync(fd); } catch (_) { /* sanitized */ }
    throw failure('operator_receipt_unproven');
  }
  try {
    fs.closeSync(fd);
  } catch (_) { /* sanitized */ }
  fsyncDirectory(path.dirname(filePath));
  const after = lstatNoFollow(filePath);
  if (!after || after.isSymbolicLink() || !after.isFile()) throw failure('operator_receipt_symlink');
  return record;
}

function readReceiptAt(filePath) {
  const st = lstatNoFollow(filePath);
  if (!st) return null;
  if (st.isSymbolicLink()) throw failure('operator_receipt_symlink');
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

function createChapter4IReceiptStoreAt(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.includes('\0')) {
    throw failure('operator_receipt_unproven');
  }
  if (filePath.includes('..')) throw failure('operator_receipt_unproven');
  const resolved = path.resolve(filePath);
  let claimedInThisHandle = false;
  return objectFreeze({
    path: resolved,
    claimedInThisHandle() {
      return claimedInThisHandle === true;
    },
    inspect() {
      return inspectReceiptPath(resolved);
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

function createCanonicalOperatorReceiptStore() {
  return createChapter4IReceiptStoreAt(OPERATOR_RECEIPT_PATH);
}

module.exports = objectFreeze({
  ERROR_CODE,
  ERROR_MESSAGE,
  CHAPTER_ID,
  OPERATOR_RECEIPT_DIR,
  OPERATOR_RECEIPT_FILENAME,
  OPERATOR_RECEIPT_PATH,
  RECEIPT_STATES,
  TERMINAL_STATES,
  RECEIPT_KEYS,
  RECEIPT_MODE,
  DIR_MODE,
  inspectReceiptDirectory,
  inspectReceiptPath,
  createChapter4IReceiptStoreAt,
  createCanonicalOperatorReceiptStore,
});
