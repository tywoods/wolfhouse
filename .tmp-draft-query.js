const {execSync}=require('child_process');
const {Client}=require('pg');
const url=execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',{encoding:'utf8'}).trim();
(async()=>{
  const c=new Client({connectionString:url,ssl:{rejectUnauthorized:false}});
  await c.connect();
  const r=await c.query("SELECT metadata->'confirmation_draft' AS draft FROM bookings WHERE id=$1::uuid",['9073415f-1501-4bdf-b1c8-ce5879c93662']);
  console.log(JSON.stringify(r.rows[0].draft,null,2));
  await c.end();
})();
