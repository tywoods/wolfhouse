'use strict';
/** EMAIL-M1-020 bounded scheduler. Durable page concurrency remains owned by the
 * delta state store lease; this process-local fence only prevents timer overlap. */
const ELIGIBLE_SQL = `
SELECT e.client_id::text AS client_id, tl.id::text AS location_id,
       e.id::text AS endpoint_id, e.location_id AS endpoint_location_id
FROM tenant_channel_endpoints e
JOIN clients c ON c.id=e.client_id
JOIN tenant_locations tl ON tl.client_id=e.client_id AND tl.location_id=e.location_id
JOIN tenant_email_delegated_grants g ON g.client_id=e.client_id AND g.endpoint_id=e.id
WHERE e.channel = 'email'
  AND c.slug = 'sunset'
  AND e.provider = 'microsoft_graph'
  AND e.binding_status = 'verified'
  AND e.inbound_enabled = true
  AND e.outbound_enabled = false
  -- active is an outbound routing switch; verified inbound authority remains
  -- canonical when outbound preparation deliberately leaves it false.
  AND g.grant_status = 'active'
  AND g.reconcile_state = 'clean'
  AND g.revoked_at IS NULL
  AND g.grant_lease_owner IS NULL
  AND g.grant_lease_token IS NULL
  AND g.grant_lease_until IS NULL
ORDER BY e.id
LIMIT 2`.replace(/\s+/g,' ').trim();
const ACTIVATION_BOUNDARY_SQL = `
WITH initialized AS (
  INSERT INTO tenant_email_delta_activation_boundaries (client_id, endpoint_id, location_id)
  VALUES ($1::uuid, $2::uuid, $3::text)
  ON CONFLICT (client_id, endpoint_id) DO NOTHING
  RETURNING activation_watermark
), durable_boundary AS (
  SELECT activation_watermark FROM initialized
  UNION ALL
  SELECT activation_watermark
  FROM tenant_email_delta_activation_boundaries
  WHERE client_id=$1::uuid AND endpoint_id=$2::uuid AND location_id=$3::text
    AND NOT EXISTS (SELECT 1 FROM initialized)
)
SELECT to_char(activation_watermark AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS activation_watermark
FROM durable_boundary
LIMIT 1`.replace(/\s+/g,' ').trim();
const UNPROJECTED_SQL = `
SELECT ev.id::text AS id, ev.provider, ev.provider_mailbox_id,
       ev.provider_message_id
FROM tenant_email_inbound_events ev
LEFT JOIN tenant_email_inbound_inbox_projections p ON p.inbound_event_id=ev.id
WHERE ev.client_id=$1::uuid AND ev.location_id=$2::uuid AND ev.endpoint_id=$3::uuid
  AND p.inbound_event_id IS NULL
ORDER BY ev.received_at, ev.id
LIMIT 5`.replace(/\s+/g,' ').trim();
function createEmailDeltaSunsetStagingWorker(deps){
 if(!deps||typeof deps.query!=='function'||typeof deps.runPage!=='function'||typeof deps.projectEvent!=='function'||!deps.timers||typeof deps.timers.setTimeout!=='function'||typeof deps.timers.clearTimeout!=='function'||!Number.isInteger(deps.intervalMs)||deps.intervalMs<60000||deps.intervalMs>120000) throw new Error('email_delta_worker_invalid');
 let running=false,timer=null,stopped=true;
 async function tick(){
  if(running)return Object.freeze({status:'overlap_skipped'}); running=true;
  try{
   const found=await deps.query(ELIGIBLE_SQL,[]); const rows=found&&Array.isArray(found.rows)?found.rows:[];
   if(rows.length!==1)return Object.freeze({status:'ineligible'});
   const r=rows[0];
   const boundary=await deps.query(ACTIVATION_BOUNDARY_SQL,[r.client_id,r.endpoint_id,r.endpoint_location_id]);
   const watermark=boundary&&boundary.rows&&boundary.rows[0]&&boundary.rows[0].activation_watermark;
   if(typeof watermark!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(watermark)) throw new Error('email_delta_activation_boundary_unavailable');
   const authority=Object.freeze({clientId:r.client_id,locationId:r.location_id,endpointId:r.endpoint_id,activationWatermark:watermark});
   await deps.runPage(authority); // exactly one Graph page; durable owner holds lease/state
   const pending=await deps.query(UNPROJECTED_SQL,[r.client_id,r.location_id,r.endpoint_id]);
   for(const event of (pending.rows||[])) await deps.projectEvent(Object.freeze({
     ...authority,inboundEventId:event.id,provider:event.provider,
     providerMailboxId:event.provider_mailbox_id,providerMessageId:event.provider_message_id,
   }));
   return Object.freeze({status:'completed'});
  }finally{running=false;}
 }
 function arm(){if(stopped)return;timer=deps.timers.setTimeout(async()=>{try{await tick();}catch(_err){console.error('email_delta_worker_tick_failed');}finally{arm();}},deps.intervalMs);}
 function start(){if(!stopped)return;stopped=false;arm();}
 function stop(){stopped=true;if(timer!==null){deps.timers.clearTimeout(timer);timer=null;}}
 return Object.freeze({tick,start,stop});
}
module.exports=Object.freeze({ELIGIBLE_SQL,ACTIVATION_BOUNDARY_SQL,UNPROJECTED_SQL,createEmailDeltaSunsetStagingWorker});
