'use strict';

const EMAIL_PAUSE_PATH = '/staff/admin/email-settings/pause';
// This master fence never grants a capability or changes connection/grant state.
function isEmailPauseAvailable(env, slug) {
  return (slug === 'sunset' && env.LUNA_DEPLOYMENT === 'sunset-staging'
      && env.SUNSET_EMAIL_SETTINGS_UI_ENABLED === 'true')
    || (slug === 'wolfhouse-somo' && env.LUNA_DEPLOYMENT === 'staff-staging'
      && env.WOLFHOUSE_EMAIL_SETTINGS_UI_ENABLED === 'true');
}
const SQL_SET_PAUSE = `UPDATE tenant_channel_endpoints e
   SET mail_flow_paused=$4::boolean, mail_flow_pause_updated_at=NOW(), mail_flow_pause_updated_by=$5::uuid
  FROM clients c
 WHERE c.id=e.client_id AND c.slug=$1 AND e.location_id=$2 AND e.id=$3::uuid
   AND e.channel='email' AND e.provider IN ('microsoft_graph','gmail_api','imap_smtp')
   AND e.provider_resource_id IS DISTINCT FROM 'disconnected'
 RETURNING e.id::text AS endpoint_id, e.mail_flow_paused`;

module.exports = { EMAIL_PAUSE_PATH, isEmailPauseAvailable, SQL_SET_PAUSE };
