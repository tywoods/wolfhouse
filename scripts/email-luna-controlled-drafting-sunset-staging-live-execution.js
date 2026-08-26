#!/usr/bin/env node
'use strict';

/**
 * FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4I CLI.
 * Closed exact Sunset-staging one-shot invocation. No generic --target.
 * Ordinary import of the owner stays inert. This process does not execute
 * live proof from source-test harnesses. Later reviewed operations may
 * run the exact contract once against the existing disabled Sunset artifact.
 */

const {
  runCli,
} = require('./lib/email-luna-controlled-drafting-sunset-staging-live-execution-owner');

async function main() {
  const record = await runCli(process.argv.slice(2), process.env);
  process.stdout.write(`${JSON.stringify(record)}\n`);
  if (!record || record.ok !== true) process.exitCode = 1;
}

main().catch(() => {
  process.exitCode = 1;
});
