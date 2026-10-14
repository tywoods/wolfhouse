'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),vm=require('node:vm');
const {createRequire}=require('node:module');
const root=path.resolve(__dirname,'..'),req=createRequire(path.join(root,'package.json'));
const {PGlite}=req('@electric-sql/pglite');
const acorn=req('acorn');
const src=fs.readFileSync(path.join(root,'scripts/staff-query-api.js'),'utf8');
const ast=acorn.parse(src,{ecmaVersion:'latest'});
const names=['inboxChannelModeFromValue','inboxChannelModesFromUnknown','inboxChannelModeStoreFromValue','inboxChannelModesStoreFromUnknown','loadClientInboxChannelModesStore','saveClientInboxChannelModes'];
const funcs=names.map(name=>{const n=ast.body.find(n=>n.type==='FunctionDeclaration'&&n.id.name===name);assert(n,name);return src.slice(n.start,n.end);}).join('\n');
const {createEmailInboxChannelModeStore}=req('./scripts/lib/email-inbox-channel-mode');
(async()=>{
 const db=new PGlite(),id='00000000-0000-4000-8000-000000000001';
 await db.exec(`CREATE TABLE clients(id uuid PRIMARY KEY,settings jsonb); INSERT INTO clients VALUES('${id}','{}');`);
 const pg={query:(sql,args)=>db.query(sql,args)},withPgClient=fn=>fn(pg);
 const store=createEmailInboxChannelModeStore({withPgClient}),scope={withPgClient};vm.createContext(scope);vm.runInContext(funcs,scope);
 for(const kinds of [['canonical','canonical'],['prefs','prefs'],['canonical','prefs'],['prefs','canonical']]){
  await db.query('UPDATE clients SET settings=$1::jsonb WHERE id=$2::uuid',[JSON.stringify({other:'keep',inbox_channel_modes:{whatsapp:'auto',email:'auto'}}),id]);
  const call=(kind,channel)=>kind==='canonical'?store.putChannelMode(id,channel,'off'):scope.saveClientInboxChannelModes(id,{[channel]:'off'});
  await Promise.all([call(kinds[0],'whatsapp'),call(kinds[1],'email')]);
  const settings=(await db.query('SELECT settings FROM clients WHERE id=$1::uuid',[id])).rows[0].settings;
  assert.deepEqual(settings.inbox_channel_modes,{whatsapp:'off',email:'off'});assert.equal(settings.other,'keep');
 }
 await db.close();console.log('verify-sim8-channel-mode-concurrency PASS: four writer pairings preserve concurrent WhatsApp Off + Email Off');
})().catch(e=>{console.error(e);process.exit(1);});
