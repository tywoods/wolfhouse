'use strict';
const { Client } = require('pg');
const { execSync } = require('child_process');
function az(c){return execSync(c,{encoding:'utf8'}).trim();}
(async()=>{
  const wh=az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg=new Client({connectionString:wh,ssl:{rejectUnauthorized:false}});
  await pg.connect();
  const staff=await pg.query("SELECT phone_e164,is_active,role FROM staff_phone_access WHERE phone_e164 LIKE '%491726422307%' OR phone_e164 LIKE '%34600995555%'");
  const msgs=await pg.query(`
    SELECT c.phone, m.direction::text, LEFT(m.message_text,120) body, m.created_at::text,
           m.metadata->>'wamid' wamid,
           m.metadata->>'open_phone_testing' open_phone_testing,
           m.metadata->>'guest_tester_class' guest_tester_class,
           m.metadata->>'source' source
      FROM messages m JOIN conversations c ON c.id=m.conversation_id
     WHERE c.phone IN ('+491726422307','491726422307','+34600995555')
       AND m.created_at >= '2026-06-11T13:00:00Z'
     ORDER BY m.created_at DESC LIMIT 15`);
  const sends=await pg.query("SELECT status,to_phone,LEFT(message_text,80) body,created_at::text,blocked_reasons FROM guest_message_sends WHERE created_at >= '2026-06-11T13:00:00Z' ORDER BY created_at DESC LIMIT 10");
  console.log(JSON.stringify({staff_phones:staff.rows,messages:msgs.rows,guest_message_sends:sends.rows},null,2));
  await pg.end();
})().catch(e=>{console.error(e);process.exit(1);});
