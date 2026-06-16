'use strict';

/**
 * Fail deploy/push prep if laptop is behind origin or Lunabox has unpulled commits.
 */

const { execSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

execSync('node scripts/check-repo-sync.js --strict --ignore-dirty', {
  cwd: ROOT,
  stdio: 'inherit',
});
