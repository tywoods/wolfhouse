'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('./luna-golden-conversations'), 'utf8');
const calls = [];
let cleanupFails = false;
const cp = {
  execSync() {}, spawnSync() { throw Error('unexpected spawn'); },
  execFileSync(cmd, args) {
    calls.push(args);
    if (args.includes('--cleanup')) {
      if (cleanupFails) throw Error('teardown failed');
      return JSON.stringify({ok:true});
    }
    return JSON.stringify({ok:true, reply_text:'hello', tool_calls:[], whatsapp_suppressed:true, transport_calls:0});
  }
};
const context = {require: name => name === 'child_process' ? cp : require(name), module:{exports:{}},
  process:{env:{}, argv:['node','test'], exit(code){context.exitCode=code;}, stdout:{write(){}}, hrtime:process.hrtime}, console:{log(){},error(){}}, Date, __filename:'test'};
vm.runInNewContext(source + '\nmodule.exports.runFixture = runFixture; module.exports.main = main;', context);
const {runFixture} = context.module.exports;
const fixture = {name:'case',lang:'en',turns:[{text:'hello',expect:{reply_contains:['hello']}}]};
let result = runFixture(fixture,{verbose:false});
assert.equal(result.fails.length,0);
assert(calls.some(args => args.includes('--cleanup')), 'must clean synthetic thread, not guest phone');
assert(!calls.some(args => args.join(' ').includes('hard_delete') || args.includes('--allow-writes')));
cleanupFails = true;
result = runFixture(fixture,{verbose:false});
assert(result.fails.length > 0, 'cleanup failure must fail fixture');
const before = calls.length;
result = runFixture({...fixture,allow_writes:true},{verbose:false});
assert.equal(result.skipped,true,'mutation fixtures must SKIP');
assert.equal(calls.length,before,'skipped fixtures must perform zero calls');
const {FIXTURES, main} = context.module.exports;
function status(fx) {
  FIXTURES.splice(0,FIXTURES.length,fx);
  main();
  return context.exitCode;
}
cleanupFails = false;
assert.equal(status(fixture),0);
assert.equal(status({...fixture,allow_writes:true}),3,'SKIP is not PASS');
assert.equal(status({...fixture,expect_fail:'known',turns:[{text:'hello',expect:{reply_contains:['missing']}}]}),3,'XFAIL is not PASS');
assert.equal(status({...fixture,expect_fail:'known'}),1,'XPASS requires marker review');
cleanupFails = true;
assert.equal(status({...fixture,expect_fail:'known'}),1,'teardown cannot hide in XFAIL');
console.log('PASS golden runner safety (offline)');
