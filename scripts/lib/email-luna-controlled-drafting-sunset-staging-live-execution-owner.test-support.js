'use strict';

/**
 * TEST-ONLY Chapter 4I helpers. Not reachable from Staff API, live-target
 * compose, 4E CLI --execute-once, or the production execution-owner public
 * surface. Injects local deterministic fake 4H-reader / KV / token / JWKS /
 * PG adapters plus a temp receipt store and closed command runner into the
 * closed owned constructor. Production code does not import this file and
 * cannot select it by env/opts.
 *
 * @module email-luna-controlled-drafting-sunset-staging-live-execution-owner.test-support
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ownedCore = require('./email-luna-controlled-drafting-sunset-staging-live-execution-owner-owned');
const chapter4IReceipt = require('./email-luna-controlled-drafting-chapter-4i-durable-receipt');

const objectFreeze = Object.freeze;

if (ownedCore.LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER !== false) {
  throw new Error('controlled_drafting_live_execute_must_be_disabled_in_this_chapter');
}

function createReceiptStoreAt(absPath) {
  const createStore = chapter4IReceipt.createChapter4IReceiptStore;
  if (typeof createStore !== 'function') {
    throw new Error('controlled_drafting_chapter_4i_test_receipt_store_unavailable');
  }
  if (typeof absPath !== 'string' || !path.isAbsolute(absPath)) {
    throw new Error('controlled_drafting_chapter_4i_test_receipt_path_invalid');
  }
  return createStore(objectFreeze({ path: absPath }));
}

function createTempReceiptStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch4i-receipt-'));
  const receiptPath = path.join(dir, 'sunset-staging-one-shot.receipt');
  return createReceiptStoreAt(receiptPath);
}

function createClosedCommandRunner(sourceSha) {
  const sha = typeof sourceSha === 'string' ? sourceSha : 'c'.repeat(40);
  return objectFreeze({
    execFileSync(file, args) {
      if (file !== 'git') throw new Error('command_runner_unexpected');
      const cmd = Array.isArray(args) ? args[0] : null;
      if (cmd === 'rev-parse') return `${sha}\n`;
      if (cmd === 'status') return '';
      if (cmd === 'ls-files') return `${args[args.length - 1]}\n`;
      if (cmd === 'merge-base') return `${sha}\n`;
      throw new Error('command_runner_unexpected');
    },
  });
}

function createSunsetStagingLiveExecutionOwnerForTests(adapters) {
  const createOwned = ownedCore.createOwnedSunsetStagingLiveExecutionOwner;
  if (typeof createOwned !== 'function') {
    throw new Error('controlled_drafting_chapter_4i_test_constructor_unavailable');
  }
  const input = Object.assign({}, adapters);
  if (!Object.prototype.hasOwnProperty.call(input, 'receiptStore')) {
    input.receiptStore = createTempReceiptStore();
  }
  if (!Object.prototype.hasOwnProperty.call(input, 'commandRunner')) {
    input.commandRunner = createClosedCommandRunner(
      adapters && adapters.clock && false
        ? null
        : (adapters && adapters.sourceSha) || 'c'.repeat(40),
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
