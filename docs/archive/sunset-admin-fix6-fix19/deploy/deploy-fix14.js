'use strict';
const { execSync } = require('child_process');
const fs = require('fs');

const localConfig = fs.readFileSync('G:/Luna/Sunset/scripts/lib/tenant-business-config.js', 'utf8');
const localWrites = fs.readFileSync('G:/Luna/Sunset/scripts/lib/tenant-admin-writes.js', 'utf8');

if (!localConfig.includes('surf_packs')) throw new Error('local config missing surf_packs');
if (!localWrites.includes('ensureLessonTimeCapacityColumn')) throw new Error('local writes missing ensure');

execSync('scp G:/Luna/Sunset/scripts/lib/tenant-business-config.js G:/Luna/Sunset/scripts/lib/tenant-admin-writes.js lunabox:/opt/wolfhouse/WH/scripts/lib/', { stdio: 'inherit' });

const verify = execSync('ssh lunabox "grep -c surf_packs /opt/wolfhouse/WH/scripts/lib/tenant-business-config.js; grep -c ensureLessonTimeCapacityColumn /opt/wolfhouse/WH/scripts/lib/tenant-admin-writes.js"', { encoding: 'utf8' });
console.log('verify counts:', verify.trim());

const deploy = execSync("ssh lunabox 'cd /opt/wolfhouse/WH && SHA=$(git rev-parse --short HEAD) && TAG=\"${SHA}-admin-portal-fix14-$(date +%Y%m%d%H%M%S)\" && echo BUILD_TAG=$TAG && az acr build --registry whstagingacr --file Dockerfile.luna-sunset-staff-api --image luna-sunset-staff-api:$TAG . && az containerapp update -g luna-sunset-staging-rg -n luna-sunset-staging-staff-api --image whstagingacr.azurecr.io/luna-sunset-staff-api:$TAG -o none && echo DEPLOYED=$TAG'", { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 600000 });
console.log(deploy);
