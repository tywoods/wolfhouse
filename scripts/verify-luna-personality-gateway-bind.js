#!/usr/bin/env node
'use strict';

/**
 * verify:luna-personality-gateway-bind
 *
 * Offline AST + sentinel-agent tests for personality bind indentation.
 * Uses real apply_gateway_patches emission. No provider or network.
 */

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const py = spawnSync('python3', ['-m', 'unittest', 'wolfhouse.test_luna_personality_gateway_bind'], {
  cwd: path.join(ROOT, 'docker/hermes-staging'),
  encoding: 'utf8',
});
if (py.stdout) process.stdout.write(py.stdout);
if (py.stderr) process.stderr.write(py.stderr);
if (py.status !== 0) {
  console.error('verify:luna-personality-gateway-bind failed');
  process.exit(py.status == null ? 1 : py.status);
}
console.log('verify:luna-personality-gateway-bind: ok');
process.exit(0);
