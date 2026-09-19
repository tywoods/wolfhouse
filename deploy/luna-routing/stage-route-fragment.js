'use strict';
const fs = require('fs');
const path = require('path');
const { parseRoute } = require('../../scripts/luna-number-routing-controller');

function stageRouteFragment(liveFile, seedFile, stagedFile) {
  const source = fs.existsSync(liveFile) ? liveFile : seedFile;
  const content = fs.readFileSync(source, 'utf8');
  if (!parseRoute(content)) throw new Error(`${path.basename(source)} is not a canonical route fragment`);
  fs.copyFileSync(source, stagedFile);
  return source === liveFile ? 'preserved' : 'seeded';
}

if (require.main === module) {
  const [, , liveFile, seedFile, stagedFile] = process.argv;
  if (!liveFile || !seedFile || !stagedFile) throw new Error('usage: stage-route-fragment.js LIVE SEED STAGED');
  stageRouteFragment(liveFile, seedFile, stagedFile);
}

module.exports = { stageRouteFragment };
