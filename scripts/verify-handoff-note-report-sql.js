#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { PGlite } = require('@electric-sql/pglite');
const { reportHandoffNoteFailure, FAILURE_SUMMARY } = require('./lib/luna-guest-handoff-note-report');
(async () => {
  const pg = new PGlite();
  try {
    await pg.exec(`CREATE TABLE clients(id text PRIMARY KEY, slug text);
      CREATE TABLE conversations(id text PRIMARY KEY, client_id text, phone text, metadata jsonb, needs_human boolean);
      CREATE TABLE staff_handoffs(id text, conversation_id text, summary text, status text);
      INSERT INTO clients VALUES ('wh','wolfhouse-somo'),('ss','sunset');
      INSERT INTO conversations VALUES ('c','wh','+34611174710','{}',true),
        ('s','ss','+34611174710','{}',true), ('synthetic','wh','999123456789012','{"simulator_synthetic":true}',true);
      INSERT INTO staff_handoffs VALUES ('h','c','Human requested','open'),('hs','s','Unchanged','open');`);
    const input = {client_slug: 'wolfhouse-somo', phone: '+34611174710'};
    assert.equal((await reportHandoffNoteFailure(pg, input)).ok, true);
    let rows = (await pg.query('SELECT * FROM conversations ORDER BY id')).rows;
    assert.equal(rows[0].needs_human, true);
    assert.equal(rows[0].metadata.luna_handoff_guest_note.attempts, 2);
    assert.equal(rows[0].metadata.luna_handoff_guest_note.staff_action_required, true);
    assert.deepEqual(rows[1].metadata, {});
    let summary = (await pg.query("SELECT summary FROM staff_handoffs WHERE id='h'")).rows[0].summary;
    assert.ok(summary.includes(FAILURE_SUMMARY));
    console.log('PASS failure recorded in metadata and staff-visible handoff summary; tenant isolated');
    await reportHandoffNoteFailure(pg, input);
    assert.equal((await pg.query("SELECT summary FROM staff_handoffs WHERE id='h'")).rows[0].summary, summary);
    console.log('PASS duplicate failure report is idempotent');
    await pg.exec("UPDATE conversations SET needs_human=false WHERE id='c'; UPDATE staff_handoffs SET status='resolved' WHERE id='h'");
    await reportHandoffNoteFailure(pg, input);
    assert.equal((await pg.query("SELECT needs_human FROM conversations WHERE id='c'")).rows[0].needs_human, false);
    assert.equal((await pg.query("SELECT status FROM staff_handoffs WHERE id='h'")).rows[0].status, 'resolved');
    console.log('PASS late failure report cannot reopen resolved handoff or set Needs human');
    for (const bad of [{...input,client_slug:'unknown'}, {...input,phone:'+34611174711'}, {...input,phone:'999123456789012'}]) {
      assert.equal((await reportHandoffNoteFailure(pg,bad)).ok,false);
    }
    console.log('PASS wrong tenant, wrong phone and synthetic phone cannot report');
    const route = fs.readFileSync(require.resolve('./staff-query-api'), 'utf8');
    const start = route.indexOf('async function handleBotConversationNeedsHuman');
    const branch = route.indexOf('if (body.report_handoff_note_failure === true)', start);
    assert.ok(branch > start && branch < route.indexOf('resolveAndMarkConversationNeedsHuman(pg', start));
    await pg.exec("UPDATE conversations SET metadata='{}'");
    const end = route.indexOf('\n}\n', start) + 2;
    const bindings = {
      readBody: async () => JSON.stringify({...input, report_handoff_note_failure:true}),
      sendJSON: (res, status, body) => ({status, body}),
      resolveBotHandlerTrustedClientSlug: () => 'sunset',
      DEFAULT_CLIENT: 'wolfhouse-somo', SQL_INJECT_RE: /[;]/,
      UUID_VALIDATE_RE: /^[0-9a-f-]{36}$/,
      withPgClient: fn => fn(pg), require,
      resolveAndMarkConversationNeedsHuman: () => { throw Error('report must not flag'); },
      send400: () => { throw Error('unexpected invalid request'); },
    };
    const handler = new Function(...Object.keys(bindings), route.slice(start,end) + '; return handleBotConversationNeedsHuman;')(...Object.values(bindings));
    const result = await handler({}, {}, {}, 'bot');
    assert.equal(result.status, 200);
    assert.equal(result.body.no_handoff_mutation, true);
    assert.deepEqual((await pg.query("SELECT metadata FROM conversations WHERE id='c'")).rows[0].metadata, {});
    assert.equal((await pg.query("SELECT metadata FROM conversations WHERE id='s'")).rows[0].metadata.luna_handoff_guest_note.status, 'failed');
    console.log('PASS real report-only handler uses trusted tenant and never calls flag/pause owner');
    console.log('verify-handoff-note-report-sql: 5 passed, 0 failed');
  } finally { await pg.close(); }
})().catch(err => { console.error(err); process.exitCode=1; });
