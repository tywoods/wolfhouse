#!/usr/bin/env node
'use strict';

/**
 * Operator CLI for Chapter 4C one-shot live-proof. Default dry-run.
 * Refuses production/Wolfhouse. Live Azure mode is structurally absent.
 */

const {
  parseArgs,
  runOneShotLiveProof,
} = require('./lib/email-luna-controlled-drafting-one-shot-live-proof');

function main(argv) {
  const parsed = parseArgs(argv.slice(2));
  const result = runOneShotLiveProof({
    parsed,
    env: process.env,
    argv: argv.slice(2),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result || result.ok !== true) process.exitCode = 1;
}

if (require.main === module) {
  main(process.argv);
}

module.exports = Object.freeze({ main, parseArgs });
