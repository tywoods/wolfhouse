// Sunset isolated staging — Azure Bicep draft (REVIEW ONLY — DO NOT DEPLOY)
// Parent: docs/sunset/SUNSET-PORTAL-SLICE-1-INFRA-BUILD-PLAN.md
// Runbook: infra/azure/sunset-staging/README.md
//
// SAFETY DEFAULTS (hardcoded — not overridable via parameters):
//   WHATSAPP_DRY_RUN=true
//   STAFF_ACTIONS_ENABLED=false
//   STAFF_AUTH_REQUIRED=true
//   STRIPE_WEBHOOK_SKIP_VERIFY=false
//
// All runtime secrets via Key Vault secret refs only. No secret values in this file.
// ACR Option A: reuse whstagingacr; image repo luna-sunset-staff-api only (never wh-staff-api).

targetScope = 'resourceGroup'

@description('Short environment label')
param environmentName string = 'staging'

@description('Azure region for Sunset staging resources')
param location string = resourceGroup().location

@description('Container Apps managed environment region (use northeurope if westeurope has capacity pressure)')
param containerAppsLocation string = location

@description('Locked Sunset staging name prefix — must not be wh-staging')
@allowed([
  'luna-sunset-staging'
])
param appNamePrefix string = 'luna-sunset-staging'

@description('Existing shared ACR name (Option A — reuse whstagingacr)')
param acrName string = 'whstagingacr'

@description('Resource group containing the shared ACR (read-only reference + AcrPull RBAC only)')
param acrResourceGroupName string = 'wh-staging-rg'

@description('Sunset Staff API image tag (never wh-staff-api)')
param staffApiImageTag string = '25518554bcf635b59c594dae8f930c0190609209'

@description('Postgres SKU')
param postgresSku string = 'Standard_B1ms'

@description('Postgres major version')
param postgresVersion string = '15'

@secure()
@description('Postgres admin password. Pass at deploy time only; never store in parameter files.')
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

@description('Cost attribution owner tag placeholder')
param ownerTag string = '<FILL_ME_OWNER>'

@description('Container Apps egress IPs allowed to reach Postgres. Do NOT use 0.0.0.0. Add after CAE exists.')
param postgresAllowedIpAddresses array = []

@description('Deploy Container Apps after Key Vault secrets and Staff API image exist')
param deployContainerApps bool = false

@description('Deploy luna-sunset-staging-staff-api Container App')
param deployStaffApi bool = false

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

// Image is always luna-sunset-staff-api repo (never wh-staff-api) — tag is parameterized only.
var staffApiImage = '${existingAcr.properties.loginServer}/luna-sunset-staff-api:${staffApiImageTag}'

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

// Restricted public access: no 0.0.0.0 rule. Allow only explicit Container Apps egress IPs.
resource pgFirewallRules 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-06-01-preview' = [for (ip, i) in postgresAllowedIpAddresses: {
  parent: pgApp
  name: 'AllowSunsetStagingEgress${i}'
  properties: {
    startIpAddress: ip
    endIpAddress: ip
  }
}]

// --- Container Apps environment ---
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

// --- Staff API Container App ---
resource staffApiApp 'Microsoft.App/containerApps@2023-05-01' = if (deployContainerApps && deployStaffApi) {
  name: staffApiAppName
  location: containerAppsLocation
  tags: resourceTags
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
        transport: 'http'
        allowInsecure: false
      }
      secrets: [
        {
          name: 'sunset-database-url'
          keyVaultUrl: '${kvBaseUri}/sunset-database-url'
          identity: managedIdentity.id
        }
        {
          name: 'stripe-secret-key'
          keyVaultUrl: '${kvBaseUri}/stripe-secret-key'
          identity: managedIdentity.id
        }
        {
          name: 'stripe-webhook-secret'
          keyVaultUrl: '${kvBaseUri}/stripe-webhook-secret'
          identity: managedIdentity.id
        }
        {
          name: 'staff-session-secret'
          keyVaultUrl: '${kvBaseUri}/staff-session-secret'
          identity: managedIdentity.id
        }
        {
          name: 'meta-whatsapp-token'
          keyVaultUrl: '${kvBaseUri}/meta-whatsapp-token'
          identity: managedIdentity.id
        }
      ]
      registries: [
        {
          server: existingAcr.properties.loginServer
          identity: managedIdentity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'staff-api'
          image: staffApiImage
          resources: {
            cpu: json(staffApiCpu)
            memory: staffApiMemory
          }
          env: [
            { name: 'WHATSAPP_DRY_RUN', value: 'true' }
            { name: 'STAFF_ACTIONS_ENABLED', value: 'false' }
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
          ]
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 1
      }
    }
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
output containerAppsEnvironmentName string = containerAppsEnv.name
output staffApiAppName string = staffApiAppName
output staffApiImage string = staffApiImage
output acrLoginServer string = existingAcr.properties.loginServer
output portalUrlTarget string = 'https://sunset-staging.lunafrontdesk.com'
