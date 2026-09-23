#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict');
const cases=[
 ['email-inbound-inbox-bridge','SQL_SELECT_EVENT_BY_ID','ep'],
 ['email-inbound-inbox-bridge','SQL_SELECT_EVENT_BY_IDENTITY','ep'],
 ['email-delta-sunset-staging-worker','ELIGIBLE_SQL','e'],
 ['email-sunset-imap-inbound-poll','SQL_ELIGIBLE','e'],
 ['email-sunset-imap-inbound-poll','SQL_DISCOVER','e'],
 ['email-delegated-grant-custodian','SQL_RESOLVE_DELEGATED_READ_AUTHORITY','e'],
 ['staff-email-inbox-routes','SQL_RESOLVE','ep'],
 ['staff-email-inbox-routes','SQL_RESOLVE_SMTP','ep'],
 ['staff-broadcast-email-send','SQL_RESOLVE_BROADCAST_MAILBOX','ep'],
 ['email-luna-microsoft-auto-create-send','SQL_LOAD_AUTO_CONTEXT','ep'],
];
for(const [file,key,alias] of cases){
 const mod=require('./lib/'+file);const sql=mod[key];
 assert.equal(typeof sql,'string',file+' exports '+key);
 assert.ok(sql.includes("to_jsonb("+alias+")->>'mail_flow_paused'"),file+' '+key+' must deny paused admission');
}
console.log('PASS SQL admission fences: Graph/Google authority, IMAP poll/discovery, staff Graph/SMTP, broadcast, existing auto-send');
