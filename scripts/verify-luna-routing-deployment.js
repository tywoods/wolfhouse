'use strict';
const assert=require('node:assert/strict'); const fs=require('fs'); const os=require('os'); const path=require('path'); const cp=require('child_process');
const root=path.join(__dirname,'../deploy/luna-routing'); const contract=require(path.join(root,'caddy-contract'));
const unit=fs.readFileSync(path.join(root,'luna-routing-controller.service'),'utf8'); const installer=fs.readFileSync(path.join(root,'install-luna-routing.sh'),'utf8'); const env=fs.readFileSync(path.join(root,'controller.env.example'),'utf8'); const controller=fs.readFileSync(path.join(__dirname,'luna-number-routing-controller.js'),'utf8');
assert.match(unit,/^User=luna-routing$/m); assert.match(unit,/^ReadWritePaths=\/var\/lib\/luna-routing$/m); assert.doesNotMatch(unit,/\/etc\/caddy\/Caddyfile/);
assert.match(installer,/--update-contract/); assert.match(installer,/Root config is intentionally the final filesystem mutation/); assert.doesNotMatch(env,/ROOT_CADDY|CADDY_BIN|TLS_(?:CERT|KEY)/);
assert.match(controller,/http\.createServer/); assert.doesNotMatch(controller,/\/etc\/caddy\/Caddyfile|ROOT_CADDY|rootContract|rootCaddy/); assert.match(controller,/const caddyBin = '\/usr\/bin\/caddy'/);
assert.match(controller,/http:\/\/127\.0\.0\.1:18096/); assert.doesNotMatch(controller,/http:\/\/127\.0\.0\.1:0\s*\{/);
// First install validates a self-contained staged import, then the canonical candidate only
// after the final fragment exists and before the root Caddyfile changes.
const stagedValidation=installer.indexOf('validate --config "$stage/Caddyfile.validation"');
const fragmentInstall=installer.indexOf('"$stage/fragment" "$FRAGMENT"');
const finalValidation=installer.indexOf('validate --config "$stage/Caddyfile"');
const rootInstall=installer.indexOf('"$stage/Caddyfile" "$CADDYFILE"');
assert.ok(stagedValidation>0 && stagedValidation<fragmentInstall && fragmentInstall<finalValidation && finalValidation<rootInstall);
assert.match(installer,/source\.replace\(canonical,`import \$\{process\.env\.STAGED_FRAGMENT\}`\)/);
// Rollback removes a newly introduced service while its unit is addressable, restores artifacts,
// reloads restored systemd/Caddy state, and restores prior enable/active booleans while retaining
// the original exit status.
assert.match(installer,/systemctl is-enabled --quiet[\s\S]*systemctl is-active --quiet/);
const restoreLoop=installer.indexOf('for p in Caddyfile fragment env controller unit sudoers tmpfiles',installer.indexOf('cleanup(){'));
const rollbackReload=installer.indexOf("rollback_run 'daemon-reload restored units'");
const rollbackCaddy=installer.indexOf("rollback_run 'reload Caddy from restored configuration'");
const rollbackEnable=installer.indexOf("rollback_run 're-enable prior controller service'");
const rollbackRestart=installer.indexOf("rollback_run 'restart prior active controller service'");
assert.ok(restoreLoop>0 && restoreLoop<rollbackReload && rollbackReload<rollbackCaddy && rollbackCaddy<rollbackEnable && rollbackEnable<rollbackRestart);
const absentStop=installer.indexOf("rollback_run 'stop newly introduced controller service'");
const absentDisable=installer.indexOf("rollback_run 'disable newly introduced controller service'");
assert.ok(absentStop>0 && absentStop<absentDisable && absentDisable<restoreLoop); assert.match(installer,/unit_was_present.*-eq 0/);
assert.match(installer,/ROLLBACK INCOMPLETE: manual recovery is required/); assert.match(installer,/rm -rf "\$stage" "\$backup"; exit "\$rc"/);
const base=`other.example {\n  reverse_proxy /whatsapp/* 1.1.1.1\n}\n\nlunabox.lunafrontdesk.com {\n  # reverse_proxy /whatsapp/* misleading\n  reverse_proxy /x 127.0.0.1:1\n  reverse_proxy /whatsapp/* 127.0.0.1:8090\n}\n`;
const installed=contract.transform(base); assert.equal(contract.verify(installed),true); assert.equal(contract.transform(installed),installed); assert.ok(installed.indexOf('# BEGIN luna-routing-contract')<installed.indexOf('reverse_proxy /whatsapp/* 127.0.0.1:8090'));
for(const bad of [`${base}\nlunabox.lunafrontdesk.com {\n reverse_proxy /whatsapp/* x\n}\n`,base.replace('  reverse_proxy /x 127.0.0.1:1\n','  reverse_proxy /whatsapp/* x\n'),base.replace('  # reverse_proxy /whatsapp/* misleading','  import /var/lib/luna-routing/luna-number-route.caddy')]) assert.throws(()=>contract.transform(bad));
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'routing-install-')); const caddy=path.join(dir,'Caddyfile'); fs.writeFileSync(caddy,base); const run=cp.spawnSync(path.join(root,'install-luna-routing.sh'),['--dry-run'],{env:{...process.env,CADDYFILE:caddy},encoding:'utf8'}); assert.equal(run.status,0,run.stderr); assert.match(run.stdout,/no host caddy required/);
console.log('PASS transactional root-independent routing deployment and exact contract fixtures');
