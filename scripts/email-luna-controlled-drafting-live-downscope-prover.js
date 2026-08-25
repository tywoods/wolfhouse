'use strict';

/**
 * FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4E/4G CLI.
 * Source/offline operator entry. Default is preparation/attestation only.
 * `--target sunset-staging` is the sole live target name; `--target live`
 * remains refused. `--execute-once` is gated and is NOT authorized to
 * acquire Azure/KV/live PG/Microsoft in this chapter. Live proof is
 * NOT EXECUTED here.
 */

const {
  runCli,
} = require('./lib/email-luna-controlled-drafting-live-downscope-prover');

function main() {
  const record = runCli(process.argv.slice(2), process.env);
  process.stdout.write(`${JSON.stringify(record)}\n`);
  if (!record || record.ok !== true) process.exitCode = 1;
}

main();
