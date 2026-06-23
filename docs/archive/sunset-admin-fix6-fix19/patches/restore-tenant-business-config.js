'use strict';
const { execSync } = require('child_process');
const fs = require('fs');
const outPath = 'G:/Luna/Sunset/scripts/lib/tenant-business-config.js';
const cmd = 'ssh lunabox "cd /opt/wolfhouse/WH && git show HEAD:scripts/lib/tenant-business-config.js"';
const content = execSync(cmd, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
fs.writeFileSync(outPath, content, 'utf8');
console.log('written bytes', Buffer.byteLength(content), 'surf_packs', (content.match(/surf_packs/g) || []).length);
