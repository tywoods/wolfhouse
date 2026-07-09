'use strict';

/**
 * Fail deploy/push prep if laptop is behind origin or Lunabox has unpulled commits.
 */

const { execSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const skipVm = process.env.WH_CHECK_REPO_SYNC_SKIP_VM === '1' ? ' --skip-vm' : '';

execSync(`node scripts/check-repo-sync.js --strict --ignore-dirty${skipVm}`, {
  cwd: ROOT,
  stdio: 'inherit',
});
