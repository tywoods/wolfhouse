// Sunset isolated staging — locked wrapper over reusable tenant-staging module.
// Source of truth inventory: infra/azure/sunset-staging/inventory/live-inventory.normalized.json
// Runbook: infra/azure/sunset-staging/README.md

targetScope = 'resourceGroup'

@description('Short environment label — locked staging only')
@allowed([
  'staging'
])
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

@description('Future 16B operations action group resource ID (subscription-pinned/owned). Used by RADAR 16L capacity-pressure alerts.')
param opsActionGroupResourceId string = '/subscriptions/6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9/resourceGroups/luna-sunset-staging-rg/providers/Microsoft.Insights/actionGroups/luna-sunset-staging-ops-budget-ag'

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

// Locked Sunset enablement / identity (byte/semantic contract for live staging).
var lockedTenantSlug = 'sunset'
var lockedAssertedRg = 'luna-sunset-staging-rg'
var lockedStaffActionsEnabled = 'true'
var lockedStripeLinksEnabled = 'true'
var lockedWhatsappDryRun = 'true'
var lockedStaffApiContainerName = 'luna-sunset-staging-staff-api'
var lockedDatabaseUrlSecretName = 'sunset-database-url'
var lockedCapacityAlertNamePrefix = 'sunset'
var lockedOpsActionGroupName = 'luna-sunset-staging-ops-budget-ag'
var lockedPortalUrlTarget = 'https://sunset-staging.lunafrontdesk.com'
var lockedFirewallRuleNamePrefix = 'AllowSunsetStagingEgress'
var lockedAcrPullModuleName = 'sunsetStagingAcrPull'
var lockedAcrLoginServer = 'whstagingacr.azurecr.io'
var lockedStaffApiImageRepository = 'luna-sunset-staff-api'
var lockedEnableSunsetRuntimeEnv = true
var lockedSchemaObserverJobName = 'luna-sunset-staging-sch-obs'
var lockedSchemaObserverDatabaseSecretName = 'sunset-schema-observer-database-url'

// Hard-fail outside exact Sunset RG / prefix / DB (prefix+DB also @allowed).
var sunsetWrapperLockRg = resourceGroup().name == lockedAssertedRg ? true : fail('sunset_wrapper_wrong_rg')
var sunsetWrapperLockPrefix = appNamePrefix == 'luna-sunset-staging' ? true : fail('sunset_wrapper_wrong_prefix')
var sunsetWrapperLockDb = appDbName == 'sunset_staging' ? true : fail('sunset_wrapper_wrong_db')
var sunsetWrapperLocks = sunsetWrapperLockRg && sunsetWrapperLockPrefix && sunsetWrapperLockDb

module tenantStaging '../modules/tenant-staging/main.bicep' = {
  name: sunsetWrapperLocks ? 'sunsetTenantStaging' : 'sunsetTenantStaging'
  params: {
    tenantSlug: lockedTenantSlug
    environmentName: environmentName
    location: location
    containerAppsLocation: containerAppsLocation
    appNamePrefix: appNamePrefix
    assertedResourceGroupName: lockedAssertedRg
    acrName: acrName
    acrResourceGroupName: acrResourceGroupName
    acrPullModuleName: lockedAcrPullModuleName
    acrLoginServer: lockedAcrLoginServer
    staffApiImageRepository: lockedStaffApiImageRepository
    staffApiImageTag: staffApiImageTag
    staffApiContainerName: lockedStaffApiContainerName
    enableSunsetRuntimeEnv: lockedEnableSunsetRuntimeEnv
    schemaObserverJobName: lockedSchemaObserverJobName
    schemaObserverDatabaseSecretName: lockedSchemaObserverDatabaseSecretName
    postgresSku: postgresSku
    postgresVersion: postgresVersion
    postgresAdminPassword: postgresAdminPassword
    staffApiCpu: staffApiCpu
    staffApiMemory: staffApiMemory
    logRetentionDays: logRetentionDays
    postgresAdminUser: postgresAdminUser
    appDbName: appDbName
    ownerTag: ownerTag
    postgresAllowedIpAddresses: postgresAllowedIpAddresses
    firewallRuleNamePrefix: lockedFirewallRuleNamePrefix
    deployContainerApps: deployContainerApps
    deployStaffApi: deployStaffApi
    deploySchemaObserverJob: deploySchemaObserverJob
    staffApiMinReplicas: staffApiMinReplicas
    staffApiMaxReplicas: staffApiMaxReplicas
    opsActionGroupResourceId: opsActionGroupResourceId
    opsActionGroupName: lockedOpsActionGroupName
    lunaBotInternalToken: lunaBotInternalToken
    deploySha: deploySha
    forceRevision: forceRevision
    locationWhatsappNumberA: sunsetSomoWhatsappNumber
    locationWhatsappNumberB: sunsetSardineroWhatsappNumber
    locationWhatsappPhoneNumberIdA: sunsetSomoWhatsappPhoneNumberId
    locationWhatsappPhoneNumberIdB: sunsetSardineroWhatsappPhoneNumberId
    locationInboxEmailA: sunsetSomoInboxEmail
    locationInboxEmailB: sunsetSardineroInboxEmail
    managedCertificateName: managedCertificateName
    staffApiCustomDomain: staffApiCustomDomain
    databaseUrlSecretName: lockedDatabaseUrlSecretName
    staffActionsEnabled: lockedStaffActionsEnabled
    stripeLinksEnabled: lockedStripeLinksEnabled
    whatsappDryRun: lockedWhatsappDryRun
    capacityAlertNamePrefix: lockedCapacityAlertNamePrefix
    portalUrlTarget: lockedPortalUrlTarget
  }
}

// --- Outputs (stable Sunset contract) ---
output resourceGroupName string = tenantStaging.outputs.resourceGroupName
output keyVaultName string = tenantStaging.outputs.keyVaultName
output managedIdentityName string = tenantStaging.outputs.managedIdentityName
output managedIdentityPrincipalId string = tenantStaging.outputs.managedIdentityPrincipalId
output postgresServerName string = tenantStaging.outputs.postgresServerName
output postgresFqdn string = tenantStaging.outputs.postgresFqdn
output databaseName string = tenantStaging.outputs.databaseName
output containerAppsEnvironmentName string = tenantStaging.outputs.containerAppsEnvironmentName
output staffApiAppName string = tenantStaging.outputs.staffApiAppName
output staffApiImage string = tenantStaging.outputs.staffApiImage
output containerAppsLocationOut string = tenantStaging.outputs.containerAppsLocationOut
output staffApiMinReplicasOut int = tenantStaging.outputs.staffApiMinReplicasOut
output staffApiMaxReplicasOut int = tenantStaging.outputs.staffApiMaxReplicasOut
output acrLoginServer string = tenantStaging.outputs.acrLoginServer
output portalUrlTarget string = tenantStaging.outputs.portalUrlTarget
output deploySchemaObserverJobOut bool = tenantStaging.outputs.deploySchemaObserverJobOut
