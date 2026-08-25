'use strict';

/**
 * FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4E CLI.
 * Source/offline only. Live Microsoft downscope is structurally absent.
 * This process never loads Azure, KV, live PG, or tokens.
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
