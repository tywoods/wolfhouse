'use strict';

/**
 * Enable repo git hooks (pre-push runs check-repo-sync).
 * Run once per clone: node scripts/setup-git-hooks.js
 */

const { execSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

execSync('git config core.hooksPath .githooks', { cwd: ROOT, stdio: 'inherit' });
console.log('✓ Git hooks enabled — pre-push runs check-repo-sync (--strict --ignore-dirty)');
