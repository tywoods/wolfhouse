'use strict';
const { Client } = require('pg');
const { execSync } = require('child_process');
function az(c){return execSync(c,{encoding:'utf8'}).trim();}
(async()=>{
  const wh=az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg=new Client({connectionString:wh,ssl:{rejectUnauthorized:false}});
  await pg.connect();
  const ev=await pg.query(`
    SELECT id::text, guest_phone, LEFT(message_text,80) AS body, created_at::text,
           metadata->>'open_phone_testing' AS open_phone_testing,
           metadata->>'guest_tester_class' AS guest_tester_class,
           metadata->'automation_gate_context' AS automation_gate_context
      FROM guest_message_events
     WHERE created_at >= '2026-06-11T13:00:00Z'
     ORDER BY created_at DESC LIMIT 10`);
  console.log(JSON.stringify(ev.rows,null,2));
  await pg.end();
})().catch(e=>{console.error(e);process.exit(1);});
