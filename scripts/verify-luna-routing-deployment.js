'use strict';
const assert=require('node:assert/strict'); const fs=require('fs'); const os=require('os'); const path=require('path'); const cp=require('child_process');
const root=path.join(__dirname,'../deploy/luna-routing'); const contract=require(path.join(root,'caddy-contract'));
const systemdUnitGuard=require(path.join(root,'validate-systemd-unit'));
const unit=fs.readFileSync(path.join(root,'luna-routing-controller.service'),'utf8'); const installer=fs.readFileSync(path.join(root,'install-luna-routing.sh'),'utf8'); const systemdGuardSource=fs.readFileSync(path.join(root,'validate-systemd-unit.js'),'utf8'); const env=fs.readFileSync(path.join(root,'controller.env.example'),'utf8'); const readme=fs.readFileSync(path.join(root,'README.md'),'utf8'); const controller=fs.readFileSync(path.join(__dirname,'luna-number-routing-controller.js'),'utf8');
assert.match(unit,/^User=luna-routing$/m); assert.match(unit,/^ReadWritePaths=\/var\/lib\/luna-routing$/m); assert.doesNotMatch(unit,/\/etc\/caddy\/Caddyfile/);
assert.match(unit,/^CapabilityBoundingSet=$/m);
assert.equal(fs.existsSync(path.join(root,'luna-routing.sudoers')),false,'obsolete controller sudoers source must not exist');
assert.match(installer,/--update-contract/); assert.match(installer,/Root config is intentionally the final filesystem mutation/); assert.doesNotMatch(env,/ROOT_CADDY|CADDY_BIN|TLS_(?:CERT|KEY)/);
assert.match(installer,/NODE_BIN=\/usr\/bin\/node/); assert.doesNotMatch(installer,/LUNA_ROUTING_TEST_NODE_BIN/,'shipped installer must not allow its systemd Node runtime to be overridden'); assert.doesNotMatch(installer,/(^|[;&|]\s*)node\s/m,'installer must not resolve Node through PATH');
assert.match(controller,/http\.createServer/); assert.doesNotMatch(controller,/ROOT_CADDY|rootContract|rootCaddy/); assert.match(controller,/const caddyBin = '\/usr\/bin\/caddy'/);
assert.match(env,/^LUNA_ROUTING_SITE=lunabox\.lunafrontdesk\.com$/m); assert.match(env,/^LUNA_ROUTING_MUTATIONS_ENABLED=false$/m); assert.match(installer,/validate-controller-env\.js" "\$CONTROLLER_ENV"/); assert.doesNotMatch(installer,/grep -c '\^LUNA_ROUTING_MUTATIONS_ENABLED='/);
assert.match(controller,/run\(caddyBin, \['reload', '--config', '\/etc\/caddy\/Caddyfile', '--adapter', 'caddyfile'\]\)/);
assert.doesNotMatch(controller,/\/usr\/bin\/sudo|systemctl', 'reload', 'caddy/);
assert.match(installer,/rm -f \/etc\/sudoers\.d\/luna-routing/);
assert.match(controller,/http:\/\/127\.0\.0\.1:18096/); assert.doesNotMatch(controller,/http:\/\/127\.0\.0\.1:0\s*\{/);
// First install validates a self-contained staged import, then the canonical candidate only
// after the final fragment exists and before the root Caddyfile changes.
const stagedValidation=installer.indexOf('validate --config "$stage/Caddyfile.validation"');
const fragmentInstall=installer.indexOf('"$stage/fragment" "$FRAGMENT"');
const finalValidation=installer.indexOf('validate --config "$stage/Caddyfile"');
const rootInstall=installer.indexOf('"$stage/Caddyfile" "$CADDYFILE"');
assert.ok(stagedValidation>0 && stagedValidation<fragmentInstall && fragmentInstall<finalValidation && finalValidation<rootInstall);
assert.match(installer,/source\.replace\(canonical,`import \$\{process\.env\.STAGED_FRAGMENT\}`\)/);
assert.match(installer,/stage-route-fragment\.js" "\$FRAGMENT"/);
assert.ok(installer.indexOf('stage-route-fragment.js" "$FRAGMENT"') < installer.indexOf('STAGED_FRAGMENT="$stage/fragment"'));
const sunset='handle /whatsapp/webhook {\n  reverse_proxy 127.0.0.1:8094\n}\n';
const routingController=require(path.join(__dirname,'luna-number-routing-controller'));
assert.equal(routingController.parseRoute(sunset).target_luna,'sunset');
const groupedEffective=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/crowsnest-routing/managed-handle-adapted-grouped.json'),'utf8'));
assert.equal(routingController.exactRouteFromJson(groupedEffective,routingController.FRANCE_STAGING_SITE).target_luna,'wolfhouse');
const wrongHostEffective=structuredClone(groupedEffective); wrongHostEffective.apps.http.servers.staging.routes[0].match[0].host=['wrong-host.example.test'];
assert.equal(routingController.exactRouteFromJson(wrongHostEffective,routingController.FRANCE_STAGING_SITE),null);
for (const [name, hostMatch] of [
  ['multi-host shadow',[routingController.FRANCE_STAGING_SITE,'other.example.test']],
  ['wildcard shadow',['*.lunafrontdesk.com']],
]) {
  const shadow=structuredClone(groupedEffective);
  const competing=structuredClone(shadow.apps.http.servers.staging.routes[0]);
  competing.match[0].host=hostMatch;
  competing.handle[0].routes[0].handle[0].upstreams[0].dial='127.0.0.1:8094';
  shadow.apps.http.servers.staging.routes.unshift(competing);
  assert.equal(routingController.exactRouteFromJson(shadow,routingController.FRANCE_STAGING_SITE),null,name);
}
const hostOrHostlessShadow=structuredClone(groupedEffective);
const competingAlternative=structuredClone(hostOrHostlessShadow.apps.http.servers.staging.routes[0]);
competingAlternative.match.push({path:['/*']});
competingAlternative.handle[0].routes[0].handle[0].upstreams[0].dial='127.0.0.1:8094';
hostOrHostlessShadow.apps.http.servers.staging.routes.unshift(competingAlternative);
assert.equal(routingController.exactRouteFromJson(hostOrHostlessShadow,routingController.FRANCE_STAGING_SITE),null,'host-or-hostless shadow');
const hostOrHostlessEffective=structuredClone(groupedEffective); hostOrHostlessEffective.apps.http.servers.staging.routes[0].match.push({path:['/*']});
assert.equal(routingController.exactRouteFromJson(hostOrHostlessEffective,routingController.FRANCE_STAGING_SITE),null,'host matcher alternatives must not weaken hostname binding');
const arbitraryGroup=structuredClone(groupedEffective); arbitraryGroup.apps.http.servers.staging.routes[0].handle[0].routes[0].group='operator-defined';
assert.equal(routingController.exactRouteFromJson(arbitraryGroup,routingController.FRANCE_STAGING_SITE),null);
const liveGroupedEffective=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/crowsnest-routing/managed-handle-live-grouped.json'),'utf8'));
assert.equal(routingController.exactRouteFromJson(liveGroupedEffective,routingController.FRANCE_STAGING_SITE).target_luna,'wolfhouse');
for (const fixture of ['native-ancestor-path-excludes-webhook.json','native-ancestor-get-only.json']) {
  const constrained=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/crowsnest-routing',fixture),'utf8'));
  assert.equal(routingController.exactRouteFromJson(constrained,routingController.FRANCE_STAGING_SITE),null,`${fixture} must preserve or reject enclosing constraints`);
}
const liveHostOrHostless=structuredClone(liveGroupedEffective); liveHostOrHostless.apps.http.servers.staging.routes[0].match.push({path:['/*']});
assert.equal(routingController.exactRouteFromJson(liveHostOrHostless,routingController.FRANCE_STAGING_SITE),null,'ancestor host matcher alternatives must not weaken hostname binding');
const liveExactRoute=liveGroupedEffective.apps.http.servers.staging.routes[0].handle[0].routes[0];
for (const mutate of [
  route => { route.group='operator-defined'; },
  route => { route.terminal=true; },
  route => { delete route.group; },
]) {
  const adversarial=structuredClone(liveGroupedEffective); mutate(adversarial.apps.http.servers.staging.routes[0].handle[0].routes[0]);
  assert.equal(routingController.exactRouteFromJson(adversarial,routingController.FRANCE_STAGING_SITE),null,'live grouped outer route must retain its canonical group-only form');
}
assert.equal(liveExactRoute.group,'group3');
for (const [name, mutate] of [
  ['outer route unknown field', route => { route.behavior='unexpected'; }],
  ['subroute handler unknown field', route => { route.handle[0].behavior='unexpected'; }],
  ['reverse proxy handler unknown field', route => { route.handle[0].routes[0].handle[0].behavior='unexpected'; }],
  ['reverse proxy transport', route => { route.handle[0].routes[0].handle[0].transport={protocol:'http'}; }],
]) {
  const adversarial=structuredClone(groupedEffective); mutate(adversarial.apps.http.servers.staging.routes[0]);
  assert.equal(routingController.exactRouteFromJson(adversarial,routingController.FRANCE_STAGING_SITE),null,`${name} must fail closed`);
}
const nonCanonicalOuterTerminal=structuredClone(groupedEffective); nonCanonicalOuterTerminal.apps.http.servers.staging.routes[0].terminal=false;
assert.equal(routingController.exactRouteFromJson(nonCanonicalOuterTerminal,routingController.FRANCE_STAGING_SITE),null,'outer terminal must retain its canonical value');
const stageFragment=require(path.join(root,'stage-route-fragment')).stageRouteFragment; const fragmentDir=fs.mkdtempSync(path.join(os.tmpdir(),'route-fragment-')); const live=path.join(fragmentDir,'live'); const seed=path.join(root,'luna-number-route.caddy'); const staged=path.join(fragmentDir,'staged');
assert.equal(stageFragment(live,seed,staged),'seeded'); assert.equal(fs.readFileSync(staged,'utf8'),fs.readFileSync(seed,'utf8'));
fs.writeFileSync(live,sunset); assert.equal(stageFragment(live,seed,staged),'preserved'); assert.equal(fs.readFileSync(staged,'utf8'),sunset);
fs.writeFileSync(live,'unknown route\n'); assert.throws(()=>stageFragment(live,seed,staged),/not a canonical route fragment/);
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
const absentStop=installer.indexOf("rollback_run 'stop controller before artifact restore'");
const absentDisable=installer.indexOf("rollback_run 'disable newly introduced controller service'");
assert.ok(absentStop>0 && absentStop<absentDisable && absentDisable<restoreLoop); assert.match(installer,/unit_was_present.*-eq 0/);
assert.match(installer,/ROLLBACK INCOMPLETE: manual recovery is required/); assert.match(installer,/RECOVERY BACKUP PRESERVED/); assert.match(installer,/\[ "\$rollback_failure" -ne 0 \] \|\| rm -rf "\$backup"/);
const base=`other.example {\n  reverse_proxy /whatsapp/* 1.1.1.1\n}\n\nlunabox.lunafrontdesk.com {\n  # reverse_proxy /whatsapp/* misleading\n  reverse_proxy /x 127.0.0.1:1\n  reverse_proxy /whatsapp/* 127.0.0.1:8090\n}\n`;
const installed=contract.transform(base); assert.equal(contract.verify(installed),true); assert.equal(contract.transform(installed),installed); assert.ok(installed.indexOf('# BEGIN luna-routing-contract')<installed.indexOf('reverse_proxy /whatsapp/* 127.0.0.1:8090')); assert.match(installed,/handle \/whatsapp\/routing-proof \{\n\s+reverse_proxy 127\.0\.0\.1:8094\n\s+\}/);
for(const bad of [`${base}\nlunabox.lunafrontdesk.com {\n reverse_proxy /whatsapp/* x\n}\n`,base.replace('  reverse_proxy /x 127.0.0.1:1\n','  reverse_proxy /whatsapp/* x\n'),base.replace('  # reverse_proxy /whatsapp/* misleading','  import /var/lib/luna-routing/luna-number-route.caddy')]) assert.throws(()=>contract.transform(bad));
const franceSite='whatsapp-staging.lunafrontdesk.com';
const freshFrance=`admin.example {\n  reverse_proxy 127.0.0.1:3000\n}\n\n${franceSite} {\n}\n`;
const franceInstalled=contract.transform(freshFrance,{site:franceSite});
assert.equal(contract.verify(franceInstalled,{site:franceSite}),true);
assert.doesNotMatch(franceInstalled,/reverse_proxy \/whatsapp\/\*/);
assert.doesNotMatch(franceInstalled,/import \/var\/lib\/luna-routing\/luna-number-route\.caddy/);
assert.match(franceInstalled,/handle \/_internal\/luna-routing\/v1\/routes\/meta-whatsapp-verified-webhook/);
assert.match(franceInstalled,/handle \/whatsapp\/routing-proof/);
assert.ok(franceInstalled.includes('admin.example {\n  reverse_proxy 127.0.0.1:3000\n}'));
for (const body of [
  '  handle /whatsapp/webhook {\n    reverse_proxy 127.0.0.1:8090\n  }\n',
  '  handle /whatsapp/* {\n    reverse_proxy 127.0.0.1:8090\n  }\n',
  '  @deliveries path /whatsapp/*\n  reverse_proxy @deliveries 127.0.0.1:8090\n',
  '  reverse_proxy 127.0.0.1:8090\n',
  '  import /etc/caddy/delivery-routes.caddy\n',
]) assert.throws(()=>contract.transform(freshFrance.replace(`${franceSite} {\n}`,`${franceSite} {\n${body}}`),{site:franceSite}),/non-delivery|forbidden/);
for (const inherited of ['constructor','toString','__proto__']) assert.throws(()=>contract.transform(`${inherited} {\n}\n`,{site:inherited}),/allowlisted/);
assert.throws(()=>contract.transform(franceInstalled.replace(`${franceSite} {\n`,`${franceSite} {\n  import /etc/caddy/delivery-routes.caddy\n`),{site:franceSite}),/non-delivery|forbidden|partial/);
const legacyWithContract=contract.transform(`lunabox.lunafrontdesk.com {\n  reverse_proxy /whatsapp/* 127.0.0.1:8090\n}\n\n${franceSite} {\n}\n`);
assert.throws(()=>contract.transform(legacyWithContract,{site:franceSite,update:true}),/owned by another site/);
assert.throws(()=>contract.transform(freshFrance,{site:'wildcard.example'}),/allowlisted/);
assert.throws(()=>contract.transform(`${freshFrance}\n${franceSite} {\n}\n`,{site:franceSite}),/exactly one unambiguous/);
for (const alias of [`https://${franceSite}`,`${franceSite}, other.example.test`]) {
  assert.throws(()=>contract.transform(`${freshFrance}\n${alias} {\n  reverse_proxy 127.0.0.1:8090\n}\n`,{site:franceSite}),/exactly one unambiguous/);
}
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'routing-install-')); const caddy=path.join(dir,'Caddyfile'); fs.writeFileSync(caddy,base);
const installerPath=path.join(root,'install-luna-routing.sh');
const runtimeDir=path.join(dir,'runtime'); fs.mkdirSync(runtimeDir);
const goodNode=path.join(runtimeDir,'good-node'); fs.writeFileSync(goodNode,`#!/bin/sh\n[ "$1" != --version ] || { echo v22.23.3; exit 0; }\nexec ${process.execPath} "$@"\n`); fs.chmodSync(goodNode,0o755);
const runInstallerWithNode=(nodeBin,args=['--dry-run'],extraEnv={})=>{
  const testInstaller=path.join(root,`.install-luna-routing.test-${process.pid}-${Math.random().toString(16).slice(2)}.sh`);
  const emulated=installer.replace('NODE_BIN=/usr/bin/node',`NODE_BIN=${nodeBin}`);
  assert.notEqual(emulated,installer,'test harness must replace the fixed runtime assignment');
  fs.writeFileSync(testInstaller,emulated,{mode:0o755});
  try { return cp.spawnSync(testInstaller,args,{env:{...process.env,...extraEnv},encoding:'utf8'}); }
  finally { fs.rmSync(testInstaller,{force:true}); }
};
const run=runInstallerWithNode(goodNode,['--dry-run'],{CADDYFILE:caddy}); assert.equal(run.status,0,run.stderr); assert.match(run.stdout,/no host caddy required/);
const missingRuntime=runInstallerWithNode(path.join(runtimeDir,'missing-node'),['--dry-run'],{CADDYFILE:caddy});
assert.notEqual(missingRuntime.status,0); assert.match(missingRuntime.stderr,/required Node runtime is missing or not executable/);
const wrongNode=path.join(runtimeDir,'wrong-node'); fs.writeFileSync(wrongNode,'#!/bin/sh\nprintf "v20.0.0\\n"\n'); fs.chmodSync(wrongNode,0o755);
const wrongRuntime=runInstallerWithNode(wrongNode,['--dry-run'],{CADDYFILE:caddy});
assert.notEqual(wrongRuntime.status,0); assert.match(wrongRuntime.stderr,/requires Node 22\.23\.3/);
const shadowDir=path.join(dir,'shadow'); fs.mkdirSync(shadowDir); const shadowNode=path.join(shadowDir,'node'); fs.writeFileSync(shadowNode,'#!/bin/sh\necho PATH_NODE_USED >&2\nexit 99\n'); fs.chmodSync(shadowNode,0o755);
const shadowRun=runInstallerWithNode(goodNode,['--dry-run'],{CADDYFILE:caddy,PATH:`${shadowDir}:${process.env.PATH}`});
assert.equal(shadowRun.status,0,shadowRun.stderr); assert.doesNotMatch(shadowRun.stderr,/PATH_NODE_USED/);
const franceCaddy=path.join(dir,'FranceCaddyfile'); fs.writeFileSync(franceCaddy,freshFrance); const franceRun=runInstallerWithNode(goodNode,['--dry-run'],{CADDYFILE:franceCaddy,LUNA_ROUTING_SITE:franceSite}); assert.equal(franceRun.status,0,franceRun.stderr);
const envValidator=path.join(root,'validate-controller-env.js');
const validEnv=['LUNA_ROUTING_CONTROLLER_PORT=8096','LUNA_ROUTING_CONTROLLER_HMAC_KEY='+('a'.repeat(32)),'LUNA_ROUTING_INGRESS_PROOF_KEY='+('b'.repeat(32)),'LUNA_ROUTING_INGRESS_PROOF_URL=https://staging.example.invalid/proof','LUNA_ROUTING_MUTATIONS_ENABLED=false',`LUNA_ROUTING_SITE=${franceSite}`,''].join('\n');
for (const [name, extra] of [
  ['leading whitespace override',' LUNA_ROUTING_MUTATIONS_ENABLED=true\n'],
  ['key whitespace override','LUNA_ROUTING_MUTATIONS_ENABLED =true\n'],
  ['site whitespace override',' LUNA_ROUTING_SITE=lunabox.lunafrontdesk.com\n'],
  ['unknown assignment','UNREVIEWED_OPTION=true\n'],
  ['quoted runtime value','LUNA_ROUTING_CONTROLLER_HMAC_KEY="'+('c'.repeat(32))+'"\n'],
  ['escaped runtime value','LUNA_ROUTING_CONTROLLER_HMAC_KEY='+('c'.repeat(31))+'\\x63\n'],
]) {
  const filename=path.join(dir,`${name.replaceAll(' ','-')}.env`); fs.writeFileSync(filename,validEnv+extra);
  const checked=cp.spawnSync(process.execPath,[envValidator,filename,franceSite],{encoding:'utf8'});
  assert.notEqual(checked.status,0,`${name} must be rejected`);
}
const validEnvFile=path.join(dir,'valid.env'); fs.writeFileSync(validEnvFile,validEnv);
assert.equal(cp.spawnSync(process.execPath,[envValidator,validEnvFile,franceSite],{encoding:'utf8'}).status,0);
assert.match(installer,/fragment\.validation/,'staged fragment needs an isolated Caddy validation wrapper');
assert.match(installer,/systemctl restart luna-routing-controller\.service/,'installed controller generation must be restarted');
assert.match(installer,/systemctl is-active --quiet caddy/,'Caddy must be an active precondition');
assert.match(systemdGuardSource,/controller service overrides are unsupported/,'unit overrides must be refused');
const systemdRoot=fs.mkdtempSync(path.join(os.tmpdir(),'routing-systemd-'));
for (const [relative, expected] of [
  ['etc/systemd/system/service.d/override.conf',/overrides are unsupported/],
  ['etc/systemd/system/luna-.service.d/override.conf',/overrides are unsupported/],
  ['etc/systemd/system/luna-routing-.service.d/override.conf',/overrides are unsupported/],
  ['etc/systemd/system.control/service.d/override.conf',/overrides are unsupported/],
  ['run/systemd/generator.early/luna-routing-controller.service.d/override.conf',/overrides are unsupported/],
  ['usr/lib/systemd/system/luna-routing-controller.service',/noncanonical controller unit/],
]) {
  const caseRoot=path.join(systemdRoot,relative.replaceAll('/','-')); fs.mkdirSync(path.join(caseRoot,path.dirname(relative)),{recursive:true}); fs.writeFileSync(path.join(caseRoot,relative),'[Service]\nEnvironmentFile=/tmp/unsafe.env\n');
  assert.throws(()=>systemdUnitGuard.assertCanonicalUnitLayout(caseRoot),expected,relative);
}
assert.doesNotThrow(()=>systemdUnitGuard.assertCanonicalUnitLayout(fs.mkdtempSync(path.join(systemdRoot,'clean-'))));
assert.doesNotThrow(()=>systemdUnitGuard.assertEffectiveUnit('/etc/systemd/system/luna-routing-controller.service','','/etc/luna-routing/controller.env (ignore_errors=no)'));
for (const args of [
  ['/usr/lib/systemd/system/luna-routing-controller.service','','/etc/luna-routing/controller.env (ignore_errors=no)'],
  ['/etc/systemd/system/luna-routing-controller.service','/etc/systemd/system/service.d/override.conf','/etc/luna-routing/controller.env (ignore_errors=no)'],
  ['/etc/systemd/system/luna-routing-controller.service','','/etc/luna-routing/controller.env (ignore_errors=no) /tmp/unsafe.env (ignore_errors=no)'],
]) assert.throws(()=>systemdUnitGuard.assertEffectiveUnit(...args),/effective controller/);
assert.match(installer,/systemctl show --property=FragmentPath --value luna-routing-controller\.service/,'effective fragment path must be verified');
assert.match(installer,/systemctl show --property=DropInPaths --value luna-routing-controller\.service/,'effective drop-ins must be verified');
assert.match(installer,/systemctl show --property=EnvironmentFiles --value luna-routing-controller\.service/,'effective environment files must be verified');
assert.match(systemdGuardSource,/noncanonical controller unit is unsupported/,'vendor, runtime, control and generated units must be refused');
assert.match(installer,/symbolic link is unsupported/,'managed destinations must reject symlinks');
assert.match(installer,/service_commands_started.*rollback_failure.*-eq 0/s,'service restoration must be gated on complete artifact restoration');
assert.match(installer,/RECOVERY BACKUP PRESERVED/,'incomplete rollback must preserve recovery evidence');
assert.doesNotMatch(installer,/rm -rf "\$stage" "\$backup"; exit "\$rc"/,'backup must not be unconditionally deleted');
assert.doesNotMatch(readme,/authenticated POST returning `403 mutations_disabled`/,'France host acceptance must not send a mutation POST');
assert.match(readme,/authenticated GET/); assert.match(readme,/offline synthetic HMAC rejection/);
console.log('PASS transactional root-independent routing deployment and exact contract fixtures');
