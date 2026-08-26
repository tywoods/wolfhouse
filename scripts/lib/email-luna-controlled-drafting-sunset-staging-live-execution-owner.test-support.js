'use strict';

/**
 * TEST-ONLY Chapter 4I helpers. Not reachable from Staff API, live-target
 * compose, 4E CLI --execute-once, or the production CLI driver. Injects
 * local deterministic fake 4H-reader / KV / token / JWKS / PG adapters
 * plus a temp receipt store and closed git command runner into the pure
 * proof-core constructor. Production code does not import this file and
 * cannot select it by env/opts.
 *
 * @module email-luna-controlled-drafting-sunset-staging-live-execution-owner.test-support
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const proofCore = require('./email-luna-controlled-drafting-chapter-4i-proof-core');
const chapter4IReceipt = require('./email-luna-controlled-drafting-chapter-4i-durable-receipt');

const objectFreeze = Object.freeze;

if (proofCore.LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER !== false) {
  throw new Error('controlled_drafting_live_execute_must_be_disabled_in_this_chapter');
}

function gitCommand(args) {
  const list = Array.isArray(args) ? args.slice() : [];
  let i = 0;
  while (i < list.length) {
    if (list[i] === '--no-replace-objects') {
      i += 1;
      continue;
    }
    if (list[i] === '-c' && i + 1 < list.length) {
      i += 2;
      continue;
    }
    break;
  }
  return list.slice(i);
}

function createReceiptStoreAt(absPath) {
  const createStore = chapter4IReceipt.createChapter4IReceiptStoreAt;
  if (typeof createStore !== 'function') {
    throw new Error('controlled_drafting_chapter_4i_test_receipt_store_unavailable');
  }
  if (typeof absPath !== 'string' || !path.isAbsolute(absPath)) {
    throw new Error('controlled_drafting_chapter_4i_test_receipt_path_invalid');
  }
  return createStore(absPath);
}

function createTempReceiptStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch4i-receipt-'));
  const receiptPath = path.join(dir, 'sunset-staging-one-shot.receipt');
  return createReceiptStoreAt(receiptPath);
}

function createClosedCommandRunner(sourceSha, sourceTree, opts) {
  const sha = typeof sourceSha === 'string' ? sourceSha : 'c'.repeat(40);
  const tree = typeof sourceTree === 'string' ? sourceTree : 'd'.repeat(40);
  const statusOut = opts && typeof opts.status === 'string' ? opts.status : '';
  const ancestor = !opts || opts.ancestor !== false;
  return objectFreeze({
    execFileSync(file, args) {
      if (file !== 'git') throw new Error('command_runner_unexpected');
      const cmd = gitCommand(args);
      const name = cmd[0];
      if (name === 'rev-parse') {
        const spec = cmd[cmd.length - 1];
        if (spec === 'HEAD^{tree}') return `${tree}\n`;
        return `${sha}\n`;
      }
      if (name === 'status') return statusOut;
      if (name === 'ls-files') return `${cmd[cmd.length - 1]}\n`;
      if (name === 'merge-base') {
        if (ancestor !== true) {
          const err = new Error('not_ancestor');
          err.status = 1;
          throw err;
        }
        return '';
      }
      throw new Error('command_runner_unexpected');
    },
  });
}

function createSunsetStagingLiveExecutionOwnerForTests(adapters) {
  const createOwned = proofCore.createOwnedSunsetStagingLiveExecutionOwner;
  if (typeof createOwned !== 'function') {
    throw new Error('controlled_drafting_chapter_4i_test_constructor_unavailable');
  }
  const input = Object.assign({}, adapters);
  if (!Object.prototype.hasOwnProperty.call(input, 'receiptStore')) {
    input.receiptStore = createTempReceiptStore();
  }
  if (!Object.prototype.hasOwnProperty.call(input, 'commandRunner')) {
    input.commandRunner = createClosedCommandRunner(
      adapters && adapters.sourceSha,
      adapters && adapters.sourceTree,
    );
  }
  return createOwned(input);
}

module.exports = objectFreeze({
  createSunsetStagingLiveExecutionOwnerForTests,
  createTempReceiptStore,
  createReceiptStoreAt,
  createClosedCommandRunner,
});
