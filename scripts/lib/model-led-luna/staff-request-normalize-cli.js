#!/usr/bin/env node
'use strict';
// Deliberately admission/normalization ONLY. Never load an issuer key or signer.
function execute(payload) {
 return require('./staff-owner-http-receipt').normalize(payload.input,payload.choices||[],payload.turn_id||'fixture');
}
function handle(payload) {
 if(payload.command==='normalize') return execute(payload);
 if(payload.command==='verify') return require('./staff-owner-http-receipt').verify(payload);
 throw new Error('unknown command: issuance is available only in the real Staff HTTP runner');
}
if(require.main===module) {
 if(process.argv.includes('--server')) {
  require('node:readline').createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',line=>{
   try {process.stdout.write(JSON.stringify(handle(JSON.parse(line)))+'\n');}
   catch(e){process.stdout.write(JSON.stringify({ok:false,code:'adapter_error',error:e.message})+'\n');}
  });
 } else {
  try{process.stdout.write(JSON.stringify(handle(JSON.parse(require('node:fs').readFileSync(0,'utf8')))));}
  catch(e){process.stderr.write(e.message+'\n');process.exitCode=1;}
 }
}
module.exports={execute,handle};
