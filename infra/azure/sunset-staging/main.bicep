// Sunset isolated staging — Azure Bicep (FOUNDATION Slice 2: reconciled to live inventory)
// Source of truth: infra/azure/sunset-staging/inventory/live-inventory.normalized.json
// Runbook: infra/azure/sunset-staging/README.md
//
// SAFETY DEFAULTS (hardcoded — not overridable via parameters):
//   WHATSAPP_DRY_RUN=true
//   STAFF_AUTH_REQUIRED=true
//   STAFF_AUTH_HTTPS=true
//   STRIPE_WEBHOOK_SKIP_VERIFY=false
//
// Reconciled to live (Slice 2):
//   STAFF_ACTIONS_ENABLED=true
//   containerAppsLocation=northeurope
//   staff API scale minReplicas=1 / maxReplicas=1
//   staffApiImageTag supplied explicitly via parameters (immutable digest/tag)
//
// Still unmanaged / manual (not declared here):
//   managed certificate, hold-expiry job, postgres firewall rules,
//   external DNS, operator Key Vault Secrets Officer RBAC, inline luna-bot-internal-token
// Schema observer job: declared only when deploySchemaObserverJob=true (default false).
// Dedicated observer DB role/secret are out of scope for this slice.
//
// All runtime secrets via Key Vault secret refs only. No secret values in this file.
// ACR Option A: reuse whstagingacr; image repo luna-sunset-staff-api only (never wh-staff-api).

targetScope = 'resourceGroup'

@description('Short environment label')
param environmentName string = 'staging'

@description('Azure region for non-Container-App Sunset staging resources (live: westeurope)')
param location string = 'westeurope'

@description('Container Apps environment + Staff API region (live: northeurope)')
param containerAppsLocation string = 'northeurope'

@description('Locked Sunset staging name prefix — must not be wh-staging')
@allowed([
  'luna-sunset-staging'
])
param appNamePrefix string = 'luna-sunset-staging'

@description('Existing shared ACR name (Option A — reuse whstagingacr)')
param acrName string = 'whstagingacr'

@description('Resource group containing the shared ACR (read-only reference + AcrPull RBAC only)')
param acrResourceGroupName string = 'wh-staging-rg'

@description('Sunset Staff API image tag — must be supplied explicitly for live reconcile / what-if (never wh-staff-api)')
param staffApiImageTag string

@description('Postgres SKU')
param postgresSku string = 'Standard_B1ms'

@description('Postgres major version')
param postgresVersion string = '15'

@secure()
@description('Postgres admin password. Pass at deploy/what-if time only; never store in parameter files.')
param postgresAdminPassword string

@description('Staff API container CPU')
param staffApiCpu string = '0.5'

@description('Staff API container memory')
param staffApiMemory string = '1Gi'

@description('Log Analytics retention in days')
param logRetentionDays int = 30

@description('Postgres admin username (password is secure param / KV)')
param postgresAdminUser string = 'sunsetadmin'

@description('Sunset app database name — must not be wolfhouse_staging')
@allowed([
  'sunset_staging'
])
param appDbName string = 'sunset_staging'

@description('Cost attribution owner tag (live: tywoods)')
param ownerTag string = 'tywoods'

@description('Container Apps egress IPs for Postgres firewall. Leave empty to avoid claiming live firewall rules (manual).')
param postgresAllowedIpAddresses array = []

@description('When true with deployStaffApi, declare the live Staff API Container App (reconcile/what-if)')
param deployContainerApps bool = true

@description('Declare luna-sunset-staging-staff-api Container App (live exists — true for reconcile what-if)')
param deployStaffApi bool = true

@description('When true, declare the manual schema-observer Container Apps Job (default false — source-only until approved create)')
param deploySchemaObserverJob bool = false

@description('Staff API min replicas (live: 1)')
param staffApiMinReplicas int = 1

@description('Staff API max replicas (live: 1)')
param staffApiMaxReplicas int = 1

@secure()
@description('Inline Container App secret luna-bot-internal-token value. Manual dependency — pass only at what-if/deploy time; never commit. Empty must not be deployed.')
param lunaBotInternalToken string

@description('Operational DEPLOY_SHA stamp. Required — no default; supply at what-if/deploy time only.')
param deploySha string

@description('Operational FORCE_REVISION stamp. Required — no default; supply at what-if/deploy time only.')
param forceRevision string

@secure()
@description('Sunset Somo WhatsApp E.164 number. Required — no deployable default; never commit real values.')
param sunsetSomoWhatsappNumber string

@secure()
@description('Sunset Sardinero WhatsApp E.164 number. Required — no deployable default; never commit real values.')
param sunsetSardineroWhatsappNumber string

@secure()
@description('Sunset Somo WhatsApp phone number ID. Required — no deployable default; never commit real values.')
param sunsetSomoWhatsappPhoneNumberId string

@secure()
@description('Sunset Sardinero WhatsApp phone number ID. Required — no deployable default; never commit real values.')
param sunsetSardineroWhatsappPhoneNumberId string

@secure()
@description('Sunset Somo inbox email. Required — no deployable default; never commit real values.')
param sunsetSomoInboxEmail string

@secure()
@description('Sunset Sardinero inbox email. Required — no deployable default; never commit real values.')
param sunsetSardineroInboxEmail string

@description('Existing managed certificate name (referenced only; cert resource remains unmanaged)')
param managedCertificateName string = 'mc-luna-sunset-st-sunset-staging-l-4218'

@description('Custom hostname already bound on live Staff API (DNS remains external/manual)')
param staffApiCustomDomain string = 'sunset-staging.lunafrontdesk.com'

// --- Derived names (Sunset-only) ---
var prefix = appNamePrefix
var kvName = '${prefix}-kv'
var logName = '${prefix}-logs'
var aiName = '${prefix}-appinsights'
var envName = '${prefix}-env'
var idName = '${prefix}-identity'
var staffApiAppName = '${prefix}-staff-api'
var pgServerName = '${prefix}-pg-app'

var resourceTags = {
  product: 'Luna Front Desk'
  tenant: 'sunset'
  environment: environmentName
  owner: ownerTag
  slice: 'portal-1'
}

// Live staff-api tags omit owner — keep parity for non-destructive what-if.
var staffApiTags = {
  product: 'Luna Front Desk'
  tenant: 'sunset'
  environment: environmentName
  slice: 'portal-1'
}

// Image is always luna-sunset-staff-api repo (never wh-staff-api) — tag is parameterized only.
// Literal login server matches live Option A ACR (avoids what-if reference() noise).
var staffApiImage = 'whstagingacr.azurecr.io/luna-sunset-staff-api:${staffApiImageTag}'

// --- Existing shared ACR (read-only; AcrPull RBAC only — no push, no Wolfhouse app changes) ---
resource existingAcr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: acrName
  scope: resourceGroup(acrResourceGroupName)
}

// --- Log Analytics ---
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: logName
  location: location
  tags: resourceTags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: logRetentionDays
  }
}

// --- Application Insights ---
resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: aiName
  location: location
  tags: resourceTags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
  }
}

// --- Managed identity (Sunset staging only) ---
resource managedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: idName
  location: location
  tags: resourceTags
}

// --- Key Vault (Sunset secrets only) ---
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: kvName
  location: location
  tags: resourceTags
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    enableRbacAuthorization: true
  }
}

// Key Vault Secrets User: 4633458b-17de-408a-b874-0445c86b69e6
resource kvRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, managedIdentity.id, '4633458b-17de-408a-b874-0445c86b69e6')
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
    principalId: managedIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// AcrPull on shared whstagingacr via cross-RG module (registry scope — see README limitation)
module acrPullRole 'acr-pull-role.bicep' = {
  name: 'sunsetStagingAcrPull'
  scope: resourceGroup(acrResourceGroupName)
  params: {
    acrName: acrName
    principalId: managedIdentity.properties.principalId
  }
}

// --- Postgres Flexible Server (Sunset dedicated) ---
resource pgApp 'Microsoft.DBforPostgreSQL/flexibleServers@2023-06-01-preview' = {
  name: pgServerName
  location: location
  tags: resourceTags
  sku: {
    name: postgresSku
    tier: 'Burstable'
  }
  properties: {
    version: postgresVersion
    administratorLogin: postgresAdminUser
    administratorLoginPassword: postgresAdminPassword
    storage: {
      storageSizeGB: 32
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    network: {
      publicNetworkAccess: 'Enabled'
    }
  }
}

resource appDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-06-01-preview' = {
  parent: pgApp
  name: appDbName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// Firewall rules are manual/live-owned. Default empty array declares none (incremental does not delete existing rules).
resource pgFirewallRules 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-06-01-preview' = [for (ip, i) in postgresAllowedIpAddresses: {
  parent: pgApp
  name: 'AllowSunsetStagingEgress${i}'
  properties: {
    startIpAddress: ip
    endIpAddress: ip
  }
}]

// --- Container Apps environment (always declared; live exists in northeurope) ---
resource containerAppsEnv 'Microsoft.App/managedEnvironments@2023-05-01' = {
  name: envName
  location: containerAppsLocation
  tags: resourceTags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

var kvBaseUri = 'https://${kvName}.vault.azure.net/secrets'

// Existing managed cert — referenced for hostname binding only (resource not created here).
resource existingManagedCert 'Microsoft.App/managedEnvironments/managedCertificates@2023-05-01' existing = {
  parent: containerAppsEnv
  name: managedCertificateName
}

// --- Staff API Container App ---
// Still unmanaged as resources: hold-expiry job, managed cert creation, postgres firewall, external DNS, operator KV officer RBAC.
// luna-bot-internal-token value remains a manual secure param (never committed).
resource staffApiApp 'Microsoft.App/containerApps@2023-05-01' = if (deployContainerApps && deployStaffApi) {
  name: staffApiAppName
  location: containerAppsLocation
  tags: staffApiTags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${managedIdentity.id}': {}
    }
  }
  properties: {
    environmentId: containerAppsEnv.id
    configuration: {
      ingress: {
        external: true
        targetPort: 3036
        transport: 'auto'
        allowInsecure: false
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
        customDomains: [
          {
            name: staffApiCustomDomain
            bindingType: 'SniEnabled'
            certificateId: existingManagedCert.id
          }
        ]
      }
      secrets: [
        {
          name: 'stripe-webhook-secret'
          keyVaultUrl: '${kvBaseUri}/stripe-webhook-secret'
          identity: managedIdentity.id
        }
        {
          name: 'sunset-database-url'
          keyVaultUrl: '${kvBaseUri}/sunset-database-url'
          identity: managedIdentity.id
        }
        {
          name: 'meta-whatsapp-token'
          keyVaultUrl: '${kvBaseUri}/meta-whatsapp-token'
          identity: managedIdentity.id
        }
        {
          name: 'staff-session-secret'
          keyVaultUrl: '${kvBaseUri}/staff-session-secret'
          identity: managedIdentity.id
        }
        {
          name: 'stripe-secret-key'
          keyVaultUrl: '${kvBaseUri}/stripe-secret-key'
          identity: managedIdentity.id
        }
        {
          name: 'luna-bot-internal-token'
          value: lunaBotInternalToken
        }
      ]
      registries: [
        {
          server: 'whstagingacr.azurecr.io'
          identity: managedIdentity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'luna-sunset-staging-staff-api'
          image: staffApiImage
          resources: {
            cpu: json(staffApiCpu)
            memory: staffApiMemory
          }
          env: [
            { name: 'WHATSAPP_DRY_RUN', value: 'true' }
            { name: 'STAFF_ACTIONS_ENABLED', value: 'true' }
            { name: 'STAFF_AUTH_REQUIRED', value: 'true' }
            { name: 'STAFF_AUTH_HTTPS', value: 'true' }
            { name: 'STRIPE_WEBHOOK_SKIP_VERIFY', value: 'false' }
            { name: 'STAFF_QUERY_API_PORT', value: '3036' }
            { name: 'STAFF_QUERY_API_HOST', value: '0.0.0.0' }
            { name: 'STAFF_SESSION_COOKIE_NAME', value: 'luna_staff_session' }
            { name: 'STAFF_SESSION_TTL_HOURS', value: '12' }
            { name: 'NODE_ENV', value: 'staging' }
            { name: 'WOLFHOUSE_DATABASE_URL', secretRef: 'sunset-database-url' }
            { name: 'STRIPE_SECRET_KEY', secretRef: 'stripe-secret-key' }
            { name: 'STRIPE_WEBHOOK_SECRET', secretRef: 'stripe-webhook-secret' }
            { name: 'STAFF_SESSION_SECRET', secretRef: 'staff-session-secret' }
            { name: 'META_WHATSAPP_TOKEN', secretRef: 'meta-whatsapp-token' }
            { name: 'SUNSET_ADMIN_DB_READ_ENABLED', value: 'true' }
            { name: 'SUNSET_ADMIN_WRITES_ENABLED', value: 'true' }
            { name: 'STRIPE_LINKS_ENABLED', value: 'true' }
            { name: 'STRIPE_CHECKOUT_SUCCESS_URL', value: 'https://sunset-staging.lunafrontdesk.com/staff/login?checkout=success&session_id={CHECKOUT_SESSION_ID}' }
            { name: 'STRIPE_CHECKOUT_CANCEL_URL', value: 'https://sunset-staging.lunafrontdesk.com/staff/login?checkout=cancel' }
            { name: 'NODE_OPTIONS', value: '--dns-result-order=ipv4first' }
            { name: 'SUNSET_ADMIN_JSON_OVERLAY', value: 'false' }
            { name: 'SUNSET_SOMO_WHATSAPP_NUMBER', value: sunsetSomoWhatsappNumber }
            { name: 'SUNSET_SARDINERO_WHATSAPP_NUMBER', value: sunsetSardineroWhatsappNumber }
            { name: 'SUNSET_SOMO_WHATSAPP_PHONE_NUMBER_ID', value: sunsetSomoWhatsappPhoneNumberId }
            { name: 'SUNSET_SARDINERO_WHATSAPP_PHONE_NUMBER_ID', value: sunsetSardineroWhatsappPhoneNumberId }
            { name: 'SUNSET_SOMO_INBOX_EMAIL', value: sunsetSomoInboxEmail }
            { name: 'SUNSET_SARDINERO_INBOX_EMAIL', value: sunsetSardineroInboxEmail }
            { name: 'BOT_PAUSE_CONTROLS_ENABLED', value: 'true' }
            { name: 'DEFAULT_CLIENT_SLUG', value: 'sunset' }
            // FORTRESS 15C: dedicated webhook tenant bind (15B); keep DEFAULT_CLIENT_SLUG=sunset compat.
            { name: 'STRIPE_WEBHOOK_CLIENT_SLUG', value: 'sunset' }
            { name: 'LUNA_BOT_INTERNAL_TOKEN', secretRef: 'luna-bot-internal-token' }
            { name: 'BOT_BOOKING_ENABLED', value: 'true' }
            { name: 'BOT_ADDON_REQUESTS_ENABLED', value: 'true' }
            { name: 'DEPLOY_SHA', value: deploySha }
            { name: 'FORCE_REVISION', value: forceRevision }
          ]
        }
      ]
      scale: {
        minReplicas: staffApiMinReplicas
        maxReplicas: staffApiMaxReplicas
      }
    }
  }
}

// --- Schema observer job (manual, gated; default off) ---
// Does not claim hold-expiry. Dedicated RO KV secret is a future dependency (not created here).
module schemaObserverJob 'schema-observer-job.bicep' = if (deployContainerApps && deploySchemaObserverJob) {
  name: 'schemaObserverJob'
  params: {
    // Container Apps Job names max 32 chars; keep under limit.
    jobName: '${appNamePrefix}-sch-obs'
    containerAppsLocation: containerAppsLocation
    environmentId: containerAppsEnv.id
    managedIdentityId: managedIdentity.id
    staffApiImage: staffApiImage
    kvBaseUri: kvBaseUri
    tags: resourceTags
  }
}

// --- Outputs ---
output resourceGroupName string = resourceGroup().name
output keyVaultName string = keyVault.name
output managedIdentityName string = managedIdentity.name
output managedIdentityPrincipalId string = managedIdentity.properties.principalId
output postgresServerName string = pgApp.name
output postgresFqdn string = pgApp.properties.fullyQualifiedDomainName
output databaseName string = appDb.name
output containerAppsEnvironmentName string = envName
output staffApiAppName string = staffApiAppName
output staffApiImage string = staffApiImage
output containerAppsLocationOut string = containerAppsLocation
output staffApiMinReplicasOut int = staffApiMinReplicas
output staffApiMaxReplicasOut int = staffApiMaxReplicas
output acrLoginServer string = existingAcr.properties.loginServer
output portalUrlTarget string = 'https://sunset-staging.lunafrontdesk.com'
output deploySchemaObserverJobOut bool = deploySchemaObserverJob
