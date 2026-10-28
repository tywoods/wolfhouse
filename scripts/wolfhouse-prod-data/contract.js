'use strict';
const ALLOWLIST=['clients','rooms','beds','wh_pricing_seasons','wh_pricing_rules','wh_pricing_items','wh_services','wh_service_slots','wh_transfers','wh_business_settings'];
const OPS=/(bookings?|guests?|payments?|refunds?|invoices?|messages?|sessions?|webhooks?|idempotency|queues?|alerts?|audit|consent|quotes?)/i;
function fail(x){throw Error(x)}
function target(t){if(!t||t.host!=='178.33.91.59'||t.database!=='wolfhouse_prod'||!t.mounts?.data||!t.mounts?.backupSpool||!t.backupDestination)fail('invalid_prod_target_identity')}
function schema(names){for(const n of names)if(!ALLOWLIST.includes(n)&&!OPS.test(n))fail('unknown_table:'+n)}
function snapshot(x){schema(x.schema);for(const k of Object.keys(x.tables))if(!ALLOWLIST.includes(k))fail('forbidden_import_table:'+k);return {version:'1.0.0',...x}}
module.exports={ALLOWLIST,target,schema,snapshot};
