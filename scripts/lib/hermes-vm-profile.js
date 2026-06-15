'use strict';

/**
 * Hermes staging on Azure Linux VM — Lunabox (orchestrator + Luna containers).
 * Secrets live in /etc/hermes-*.env on the VM (from Key Vault) or env vars for deploy.
 */

const HERMES_VM = Object.freeze({
  RG: 'wh-staging-rg',
  LOCATION: 'northeurope',
  VM_NAME: 'lunabox',
  VM_SIZE: 'Standard_B2s',
  IMAGE: 'whstagingacr.azurecr.io/wh-hermes-staging:latest',
  ACR: 'whstagingacr',
  KV: 'wh-staging-kv',
  IDENTITY_ID:
    '/subscriptions/6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9/resourceGroups/wh-staging-rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/wh-staging-identity',

  // DNS: lunabox.lunafrontdesk.com → VM public IP (IP-only OK for first week via http://<ip>:8090)
  HOSTNAME: 'lunabox.lunafrontdesk.com',
  REPO_PATH: '/opt/wolfhouse/WH',
  DATA_ORCHESTRATOR: '/var/lib/hermes-orchestrator',
  DATA_LUNA: '/var/lib/hermes-luna',
  DATA_SHARED: '/var/lib/hermes-shared',
  COMPOSE_FILE: '/opt/wolfhouse/WH/docker/hermes-staging/docker-compose.vm.yml',
  ENV_ORCHESTRATOR: '/etc/hermes-orchestrator.env',
  ENV_LUNA: '/etc/hermes-luna.env',

  PORT_ORCHESTRATOR: 8642,
  PORT_LUNA_WEBHOOK: 8090,

  WOLFHOUSE_STAFF_API_BASE_URL: 'https://staff-staging.lunafrontdesk.com',
  WHATSAPP_VERIFY_TOKEN: 'wolfhouse_verify_token',
  WHATSAPP_PHONE_ID: '1152900101233109',

  // Luna models (OAuth only — credentials in shared auth.json, not API keys in .env)
  LUNA_MODEL_PRIMARY: 'gpt-5.5',
  LUNA_MODEL_PRIMARY_PROVIDER: 'openai-codex',
  LUNA_MODEL_FALLBACK: 'anthropic/claude-sonnet-4-6',
  LUNA_MODEL_FALLBACK_PROVIDER: 'anthropic',

  ACA_APP_NAME: 'wh-staging-hermes',
});

module.exports = { HERMES_VM };
