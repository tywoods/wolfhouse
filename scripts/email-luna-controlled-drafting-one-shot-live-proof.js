#!/usr/bin/env node
'use strict';

/**
 * Compatibility wrapper for Chapter 4C offline simulation.
 * This is not an operator live harness and cannot prove OAuth, Graph, or 098.
 * Default dry-run. Refuses production/Wolfhouse. Live Azure is structurally absent.
 */

const {
  parseArgs,
  runOfflineSimulation,
} = require('./lib/email-luna-controlled-drafting-one-shot-live-proof');

function main(argv) {
  const parsed = parseArgs(argv.slice(2));
  const result = runOfflineSimulation({
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
