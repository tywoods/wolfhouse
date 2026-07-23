// MESSI SaaS Stage 2A — reusable tenant-staging stack (RG scope).
targetScope = 'resourceGroup'
param tenantSlug string
param environmentName string = 'staging'
param location string
param containerAppsLocation string
param appNamePrefix string
param assertedResourceGroupName string
param acrName string = 'whstagingacr'
param acrResourceGroupName string = 'wh-staging-rg'
param acrPullModuleName string = 'tenantStagingAcrPull'
param acrLoginServer string
param staffApiImageRepository string
param staffApiImageTag string
param staffApiContainerName string
param enableSunsetRuntimeEnv bool = false
param schemaObserverJobName string = ''
param schemaObserverDatabaseSecretName string = ''
param postgresSku string = 'Standard_B1ms'
param postgresVersion string = '15'
@secure()
param postgresAdminPassword string
param staffApiCpu string = '0.5'
param staffApiMemory string = '1Gi'
param logRetentionDays int = 30
param postgresAdminUser string
param appDbName string
param ownerTag string = 'tywoods'
param postgresAllowedIpAddresses array = []
param firewallRuleNamePrefix string = 'AllowTenantStagingEgress'
param deployContainerApps bool = true
param deployStaffApi bool = true
param deploySchemaObserverJob bool = false
param staffApiMinReplicas int = 1
param staffApiMaxReplicas int = 1
param opsActionGroupResourceId string
param opsActionGroupName string
@secure()
param lunaBotInternalToken string
param deploySha string
param forceRevision string
@secure()
param locationWhatsappNumberA string
@secure()
param locationWhatsappNumberB string
@secure()
param locationWhatsappPhoneNumberIdA string
@secure()
param locationWhatsappPhoneNumberIdB string
@secure()
param locationInboxEmailA string
@secure()
param locationInboxEmailB string
param managedCertificateName string
param staffApiCustomDomain string
param databaseUrlSecretName string
param staffActionsEnabled string
param stripeLinksEnabled string
param whatsappDryRun string
param capacityAlertNamePrefix string
param portalUrlTarget string
param planDigest string = ''
param stageTag string = 'saas-2c1'
param deployBootstrapJob bool = false
param bootstrapJobImageDigest string = ''
@secure()
param bootstrapAdminDatabaseUrl string = ''
@secure()
param bootstrapAppRolePassword string = ''
// Stage 2C3 is deliberately two deployments. The apply owner waits for RBAC
// propagation/readback after runtime-prereqs before asserting runtime-app.
@allowed([
  'none'
  'runtime-prereqs'
  'runtime-app'
])
param runtimeDeploymentPhase string = 'none'
param runtimePrereqsVerified bool = false
param staffApiImageDigest string = ''
@secure()
param appDatabasePassword string = ''
@secure()
param staffSessionSecret string = ''
@secure()
param stripeSecretKey string = ''
@secure()
param stripeWebhookSecret string = ''
@secure()
param metaWhatsappToken string = ''
@secure()
param metaAppSecret string = ''
@secure()
param metaWhatsappVerifyToken string = ''
// --- Locked-live Sunset tuple + synthetic safety ---
var tenantSlugLower = toLower(tenantSlug)
var isLockedLiveSunset = tenantSlugLower == 'sunset' && assertedResourceGroupName == 'luna-sunset-staging-rg' && resourceGroup().name == 'luna-sunset-staging-rg' && appNamePrefix == 'luna-sunset-staging' && appDbName == 'sunset_staging' && environmentName == 'staging'
var enablePrivateNetwork = !isLockedLiveSunset
var sunsetSlugTupleOk = tenantSlugLower != 'sunset' || isLockedLiveSunset ? true : fail('sunset_slug_requires_locked_live_tuple')
var reservedSlug = tenantSlugLower == 'wolfhouse' || tenantSlugLower == 'wh' || startsWith(tenantSlugLower, 'wolfhouse')
var reservedSlugOk = isLockedLiveSunset || !reservedSlug ? true : fail('reserved_slug_in_synthetic_mode')
var sunsetEnvLockOk = !enableSunsetRuntimeEnv || isLockedLiveSunset ? true : fail('sunset_env_requires_locked_live')

var prefixLower = toLower(appNamePrefix)
var rgLower = toLower(assertedResourceGroupName)
var stagingPrefixOk = contains(prefixLower, 'staging') && !contains(prefixLower, 'prod') ? true : fail('non_staging_prefix')
var stagingRgOk = endsWith(rgLower, '-staging-rg') && !contains(rgLower, 'prod') ? true : fail('non_staging_rg')
var noWhStagingPrefix = appNamePrefix != 'wh-staging' ? true : fail('forbidden_wh_staging_prefix')
var deployScopeOk = resourceGroup().name == assertedResourceGroupName ? true : fail('wrong_resource_group')
var environmentStagingOk = environmentName == 'staging' ? true : fail('non_staging_environment')
var ownershipOk = isLockedLiveSunset || (!empty(planDigest) && !empty(deploySha) && !empty(ownerTag) && !empty(tenantSlug)) ? true : fail('synthetic_ownership_tuple_required')
var privateFirewallOk = !enablePrivateNetwork || length(postgresAllowedIpAddresses) == 0 ? true : fail('private_network_no_firewall')
var bootstrapJobGateOk = !deployBootstrapJob || (enablePrivateNetwork && !empty(bootstrapJobImageDigest) && startsWith(bootstrapJobImageDigest, 'sha256:') && length(bootstrapJobImageDigest) == 71 && !empty(bootstrapAdminDatabaseUrl) && !empty(bootstrapAppRolePassword)) ? true : fail('bootstrap_job_requires_private_digest_secrets')
var runtimePrereqsPhase = enablePrivateNetwork && deployStaffApi && runtimeDeploymentPhase == 'runtime-prereqs'
var runtimeAppRequested = runtimeDeploymentPhase == 'runtime-app'
var phaseExclusiveOk = !(deployBootstrapJob && runtimeDeploymentPhase != 'none') ? true : fail('runtime_bootstrap_phase_conflict')
var runtimeVerifiedOk = !runtimeAppRequested || runtimePrereqsVerified ? true : fail('runtime_prereqs_verification_required')
var syntheticRuntimePhase = enablePrivateNetwork && deployStaffApi && runtimeAppRequested && runtimeVerifiedOk && !deployBootstrapJob
var useCustomDomain = isLockedLiveSunset
var useDigestImage = syntheticRuntimePhase

// Synthetic outbound is derived false — not merely caller-requested.
var effectiveWhatsappDryRun = isLockedLiveSunset ? whatsappDryRun : 'true'
var effectiveStripeLinksEnabled = isLockedLiveSunset ? stripeLinksEnabled : 'false'
var effectiveStaffActionsEnabled = isLockedLiveSunset ? staffActionsEnabled : 'false'
var effectiveFirewallIps = enablePrivateNetwork ? [] : postgresAllowedIpAddresses

var safetyLocksSatisfied = sunsetSlugTupleOk && reservedSlugOk && sunsetEnvLockOk && stagingPrefixOk && stagingRgOk && noWhStagingPrefix && deployScopeOk && environmentStagingOk && ownershipOk && privateFirewallOk && bootstrapJobGateOk && phaseExclusiveOk && runtimeVerifiedOk

var prefix = appNamePrefix
var kvName = '${prefix}-kv'
var logName = '${prefix}-logs'
var aiName = '${prefix}-appinsights'
var envName = '${prefix}-env'
var idName = '${prefix}-identity'
var staffApiAppName = '${prefix}-staff-api'
var pgServerName = '${prefix}-pg-app'
var runtimeDatabaseUrlSecretName = '${tenantSlugLower}-database-url'
var effectiveDatabaseUrlSecretName = enablePrivateNetwork ? runtimeDatabaseUrlSecretName : databaseUrlSecretName
var pgLocation = enablePrivateNetwork ? containerAppsLocation : location
var resolvedSchemaObserverJobName = empty(schemaObserverJobName) ? '${appNamePrefix}-sch-obs' : schemaObserverJobName
var resolvedSchemaObserverSecretName = empty(schemaObserverDatabaseSecretName) ? '${tenantSlug}-schema-observer-database-url' : schemaObserverDatabaseSecretName

// Exact pre-2C1 Sunset tags — synthetic ownership must not leak into locked-live.
var sunsetResourceTags = {
  product: 'Luna Front Desk'
  tenant: tenantSlug
  environment: environmentName
  owner: ownerTag
  slice: 'portal-1'
  safetyLocksSatisfied: string(safetyLocksSatisfied)
}
var syntheticOwnershipTags = {
  tenant: tenantSlug
  stage: stageTag
  owner: ownerTag
  planDigest: planDigest
  deploySha: deploySha
}
var resourceTags = union(sunsetResourceTags, enablePrivateNetwork ? {
  stage: stageTag
  planDigest: planDigest
  deploySha: deploySha
} : {})
var staffApiTags = union({
  product: 'Luna Front Desk'
  tenant: tenantSlug
  environment: environmentName
  slice: 'portal-1'
}, enablePrivateNetwork ? {
  stage: stageTag
  planDigest: planDigest
  deploySha: deploySha
  owner: ownerTag
} : {})
var staffApiImageTagged = '${acrLoginServer}/${staffApiImageRepository}:${staffApiImageTag}'
var staffApiImageDigestRef = '${acrLoginServer}/${staffApiImageRepository}@${staffApiImageDigest}'
var digestGateOk = !useDigestImage || (length(staffApiImageDigest) == 71 && startsWith(staffApiImageDigest, 'sha256:')) ? true : fail('staff_image_digest_required')
var staffApiImage = useDigestImage ? staffApiImageDigestRef : staffApiImageTagged
var imageRegistryOk = startsWith(staffApiImage, '${acrLoginServer}/') && !contains(staffApiImage, 'wh-staff-api') ? true : fail('image_registry_mismatch')
var acrLoginServerMatches = acrLoginServer == '${acrName}.azurecr.io' ? true : fail('acr_login_server_mismatch')
var registryLocksOk = imageRegistryOk && acrLoginServerMatches && safetyLocksSatisfied && digestGateOk
// --- Existing shared ACR (read-only; AcrPull RBAC only — no push, no Wolfhouse app changes) ---

resource existingAcr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: acrName
  scope: resourceGroup(acrResourceGroupName)
}
// --- Log Analytics ---

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: logName
  location: location
  tags: union(resourceTags, { registryLocksOk: string(registryLocksOk) })
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

resource kvRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, managedIdentity.id, '4633458b-17de-408a-b874-0445c86b69e6')
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
    principalId: managedIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

module acrPullRole '../../sunset-staging/acr-pull-role.bicep' = {
  name: acrPullModuleName
  scope: resourceGroup(acrResourceGroupName)
  params: {
    acrName: acrName
    principalId: managedIdentity.properties.principalId
  }
}

module privateNetwork './private-network.bicep' = if (enablePrivateNetwork) {
  name: 'privateNetwork'
  params: {
    location: containerAppsLocation
    appNamePrefix: appNamePrefix
    tenantSlug: tenantSlug
    stageTag: stageTag
    ownerTag: ownerTag
    planDigest: planDigest
    deploySha: deploySha
  }
}
// --- Postgres Flexible Server (Sunset public / synthetic private) ---

resource pgApp 'Microsoft.DBforPostgreSQL/flexibleServers@2023-06-01-preview' = {
  name: pgServerName
  location: pgLocation
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
    network: enablePrivateNetwork ? {
      delegatedSubnetResourceId: privateNetwork!.outputs.postgresDelegatedSubnetId
      privateDnsZoneArmResourceId: privateNetwork!.outputs.privateDnsZoneId
      publicNetworkAccess: 'Disabled'
    } : {
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

resource pgFirewallRules 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-06-01-preview' = [for (ip, i) in effectiveFirewallIps: {
  parent: pgApp
  name: '${firewallRuleNamePrefix}${i}'
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
  properties: union({
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }, enablePrivateNetwork ? {
    vnetConfiguration: {
      infrastructureSubnetId: privateNetwork!.outputs.acaInfrastructureSubnetId
      internal: false
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
  } : {})
}
var kvBaseUri = 'https://${kvName}.vault.azure.net/secrets'
// ACA-generated TLS FQDN (one deployment — env.defaultDomain; no custom domain/cert on synthetic).
var staffApiGeneratedFqdn = '${staffApiAppName}.${containerAppsEnv.properties.defaultDomain}'
var staffApiGeneratedUrl = 'https://${staffApiGeneratedFqdn}'
var checkoutSuccessUrl = useCustomDomain ? 'https://${staffApiCustomDomain}/staff/login?checkout=success&session_id={CHECKOUT_SESSION_ID}' : '${staffApiGeneratedUrl}/staff/login?checkout=success&session_id={CHECKOUT_SESSION_ID}'
var checkoutCancelUrl = useCustomDomain ? 'https://${staffApiCustomDomain}/staff/login?checkout=cancel' : '${staffApiGeneratedUrl}/staff/login?checkout=cancel'
var effectivePortalUrlTarget = useCustomDomain ? portalUrlTarget : staffApiGeneratedUrl

resource existingManagedCert 'Microsoft.App/managedEnvironments/managedCertificates@2023-05-01' existing = if (useCustomDomain) {
  parent: containerAppsEnv
  name: managedCertificateName
}
// --- Staff API env (Sunset admin/location only when enableSunsetRuntimeEnv) ---
var baseStaffEnv = [
  { name: 'WHATSAPP_DRY_RUN', value: effectiveWhatsappDryRun }
  { name: 'STAFF_ACTIONS_ENABLED', value: effectiveStaffActionsEnabled }
  { name: 'STAFF_AUTH_REQUIRED', value: 'true' }
  { name: 'STAFF_AUTH_HTTPS', value: 'true' }
  { name: 'STRIPE_WEBHOOK_SKIP_VERIFY', value: 'false' }
  { name: 'STAFF_QUERY_API_PORT', value: '3036' }
  { name: 'STAFF_QUERY_API_HOST', value: '0.0.0.0' }
  { name: 'STAFF_SESSION_COOKIE_NAME', value: 'luna_staff_session' }
  { name: 'STAFF_SESSION_TTL_HOURS', value: '12' }
  { name: 'NODE_ENV', value: 'staging' }
  { name: 'WOLFHOUSE_DATABASE_URL', secretRef: syntheticRuntimePhase ? runtimeDatabaseUrlSecretName : databaseUrlSecretName }
  { name: 'STRIPE_SECRET_KEY', secretRef: 'stripe-secret-key' }
  { name: 'STRIPE_WEBHOOK_SECRET', secretRef: 'stripe-webhook-secret' }
  { name: 'STAFF_SESSION_SECRET', secretRef: 'staff-session-secret' }
  { name: 'META_WHATSAPP_TOKEN', secretRef: 'meta-whatsapp-token' }
  { name: 'META_APP_SECRET', secretRef: 'meta-app-secret' }
  { name: 'META_WHATSAPP_VERIFY_TOKEN', secretRef: 'meta-whatsapp-verify-token' }
  { name: 'META_WEBHOOK_SKIP_VERIFY', value: 'false' }
  { name: 'STRIPE_LINKS_ENABLED', value: effectiveStripeLinksEnabled }
  { name: 'STRIPE_CHECKOUT_SUCCESS_URL', value: checkoutSuccessUrl }
  { name: 'STRIPE_CHECKOUT_CANCEL_URL', value: checkoutCancelUrl }
  { name: 'NODE_OPTIONS', value: '--dns-result-order=ipv4first' }
  { name: 'BOT_PAUSE_CONTROLS_ENABLED', value: 'true' }
  { name: 'DEFAULT_CLIENT_SLUG', value: tenantSlug }
  { name: 'STAFF_API_INGRESS_TENANT_SLUG', value: tenantSlug }
  { name: 'STRIPE_WEBHOOK_CLIENT_SLUG', value: tenantSlug }
  { name: 'LUNA_BOT_INTERNAL_TOKEN', secretRef: 'luna-bot-internal-token' }
  { name: 'BOT_BOOKING_ENABLED', value: 'true' }
  { name: 'BOT_ADDON_REQUESTS_ENABLED', value: 'true' }
  { name: 'DEPLOY_SHA', value: deploySha }
  { name: 'FORCE_REVISION', value: forceRevision }
]
var sunsetAdminLocationEnv = [
  { name: 'SUNSET_ADMIN_DB_READ_ENABLED', value: 'true' }
  { name: 'SUNSET_ADMIN_WRITES_ENABLED', value: 'true' }
  { name: 'SUNSET_ADMIN_JSON_OVERLAY', value: 'false' }
  { name: 'SUNSET_SOMO_WHATSAPP_NUMBER', value: locationWhatsappNumberA }
  { name: 'SUNSET_SARDINERO_WHATSAPP_NUMBER', value: locationWhatsappNumberB }
  { name: 'SUNSET_SOMO_WHATSAPP_PHONE_NUMBER_ID', value: locationWhatsappPhoneNumberIdA }
  { name: 'SUNSET_SARDINERO_WHATSAPP_PHONE_NUMBER_ID', value: locationWhatsappPhoneNumberIdB }
  { name: 'SUNSET_SOMO_INBOX_EMAIL', value: locationInboxEmailA }
  { name: 'SUNSET_SARDINERO_INBOX_EMAIL', value: locationInboxEmailB }
]

// Stage 2B — generic runtime: channel_slot integers in JSON; fixed TENANT_LOCATION_N_* from @secure params.
var enableGenericRuntimeEnv = !isLockedLiveSunset
var genericRuntimeConfig = {
  version: 1
  tenant_slug: tenantSlug
  permissions: {
    admin_db_read: false
    admin_writes: false
    stripe_links: false
    staff_actions: false
    whatsapp_dry_run: true
  }
  locations: [
    {
      location_id: '${tenantSlug}-a'
      display_name: '${tenantSlug} A'
      channel_slot: 1
    }
    {
      location_id: '${tenantSlug}-b'
      display_name: '${tenantSlug} B'
      channel_slot: 2
    }
  ]
}
var genericRuntimeEnvPlain = [
  { name: 'TENANT_RUNTIME_CONFIG_JSON', value: string(genericRuntimeConfig) }
  { name: 'TENANT_LOCATION_1_WHATSAPP_NUMBER', value: locationWhatsappNumberA }
  { name: 'TENANT_LOCATION_1_WHATSAPP_PHONE_NUMBER_ID', value: locationWhatsappPhoneNumberIdA }
  { name: 'TENANT_LOCATION_1_INBOX_EMAIL', value: locationInboxEmailA }
  { name: 'TENANT_LOCATION_2_WHATSAPP_NUMBER', value: locationWhatsappNumberB }
  { name: 'TENANT_LOCATION_2_WHATSAPP_PHONE_NUMBER_ID', value: locationWhatsappPhoneNumberIdB }
  { name: 'TENANT_LOCATION_2_INBOX_EMAIL', value: locationInboxEmailB }
]
var genericRuntimeEnvSecrets = [
  { name: 'TENANT_RUNTIME_CONFIG_JSON', value: string(genericRuntimeConfig) }
  { name: 'TENANT_LOCATION_1_WHATSAPP_NUMBER', secretRef: 'tenant-loc-1-wa-number' }
  { name: 'TENANT_LOCATION_1_WHATSAPP_PHONE_NUMBER_ID', secretRef: 'tenant-loc-1-wa-phone-id' }
  { name: 'TENANT_LOCATION_1_INBOX_EMAIL', secretRef: 'tenant-loc-1-inbox-email' }
  { name: 'TENANT_LOCATION_2_WHATSAPP_NUMBER', secretRef: 'tenant-loc-2-wa-number' }
  { name: 'TENANT_LOCATION_2_WHATSAPP_PHONE_NUMBER_ID', secretRef: 'tenant-loc-2-wa-phone-id' }
  { name: 'TENANT_LOCATION_2_INBOX_EMAIL', secretRef: 'tenant-loc-2-inbox-email' }
]
var genericRuntimeEnv = syntheticRuntimePhase ? genericRuntimeEnvSecrets : genericRuntimeEnvPlain

var staffApiCoreSecrets = [
  {
    name: 'stripe-webhook-secret'
    keyVaultUrl: '${kvBaseUri}/stripe-webhook-secret'
    identity: managedIdentity.id
  }
  {
    name: databaseUrlSecretName
    keyVaultUrl: '${kvBaseUri}/${databaseUrlSecretName}'
    identity: managedIdentity.id
  }
  {
    name: 'meta-whatsapp-token'
    keyVaultUrl: '${kvBaseUri}/meta-whatsapp-token'
    identity: managedIdentity.id
  }
  {
    name: 'meta-app-secret'
    keyVaultUrl: '${kvBaseUri}/meta-app-secret'
    identity: managedIdentity.id
  }
  {
    name: 'meta-whatsapp-verify-token'
    keyVaultUrl: '${kvBaseUri}/meta-whatsapp-verify-token'
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
]
var staffApiLunaInline = [
  {
    name: 'luna-bot-internal-token'
    value: lunaBotInternalToken
  }
]
var staffApiLunaKv = [
  {
    name: 'luna-bot-internal-token'
    keyVaultUrl: '${kvBaseUri}/luna-bot-internal-token'
    identity: managedIdentity.id
  }
]
var staffApiChannelSecrets = [
  { name: 'tenant-loc-1-wa-number', keyVaultUrl: '${kvBaseUri}/tenant-loc-1-wa-number', identity: managedIdentity.id }
  { name: 'tenant-loc-1-wa-phone-id', keyVaultUrl: '${kvBaseUri}/tenant-loc-1-wa-phone-id', identity: managedIdentity.id }
  { name: 'tenant-loc-1-inbox-email', keyVaultUrl: '${kvBaseUri}/tenant-loc-1-inbox-email', identity: managedIdentity.id }
  { name: 'tenant-loc-2-wa-number', keyVaultUrl: '${kvBaseUri}/tenant-loc-2-wa-number', identity: managedIdentity.id }
  { name: 'tenant-loc-2-wa-phone-id', keyVaultUrl: '${kvBaseUri}/tenant-loc-2-wa-phone-id', identity: managedIdentity.id }
  { name: 'tenant-loc-2-inbox-email', keyVaultUrl: '${kvBaseUri}/tenant-loc-2-inbox-email', identity: managedIdentity.id }
]
var runtimeStaffApiCoreSecrets = [for secret in staffApiCoreSecrets: secret.name == databaseUrlSecretName ? {
  name: runtimeDatabaseUrlSecretName
  keyVaultUrl: '${kvBaseUri}/${runtimeDatabaseUrlSecretName}'
  identity: managedIdentity.id
} : secret]
var staffApiSecrets = syntheticRuntimePhase
  ? concat(runtimeStaffApiCoreSecrets, staffApiLunaKv, staffApiChannelSecrets)
  : concat(staffApiCoreSecrets, staffApiLunaInline)

var runtimeSecretsProvenance = {
  tenantSlug: tenantSlug
  ownerTag: ownerTag
  planDigest: planDigest
  deploySha: deploySha
  stageTag: 'saas-2c3'
}
module syntheticRuntimeSecrets './synthetic-runtime-secrets.bicep' = if (runtimePrereqsPhase) {
  name: 'syntheticRuntimeSecrets'
  params: {
    keyVaultName: kvName
    provenance: runtimeSecretsProvenance
    appDatabasePassword: appDatabasePassword
    postgresFqdn: pgApp.properties.fullyQualifiedDomainName
    derivedDatabaseName: appDb.name
    staffSessionSecret: staffSessionSecret
    lunaBotInternalToken: lunaBotInternalToken
    stripeSecretKey: stripeSecretKey
    stripeWebhookSecret: stripeWebhookSecret
    metaWhatsappToken: metaWhatsappToken
    metaAppSecret: metaAppSecret
    metaWhatsappVerifyToken: metaWhatsappVerifyToken
    locationWhatsappNumberA: locationWhatsappNumberA
    locationWhatsappNumberB: locationWhatsappNumberB
    locationWhatsappPhoneNumberIdA: locationWhatsappPhoneNumberIdA
    locationWhatsappPhoneNumberIdB: locationWhatsappPhoneNumberIdB
    locationInboxEmailA: locationInboxEmailA
    locationInboxEmailB: locationInboxEmailB
    tenantSlug: tenantSlug
  }
  dependsOn: [
    keyVault
  ]
}

// --- Staff API Container App ---

resource staffApiApp 'Microsoft.App/containerApps@2023-05-01' = if (deployContainerApps && deployStaffApi && (!enablePrivateNetwork || syntheticRuntimePhase)) {
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
        customDomains: useCustomDomain ? [
          {
            name: staffApiCustomDomain
            bindingType: 'SniEnabled'
            certificateId: existingManagedCert.id
          }
        ] : []
      }
      secrets: staffApiSecrets
      registries: [
        {
          server: acrLoginServer
          identity: managedIdentity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: staffApiContainerName
          image: staffApiImage
          resources: {
            cpu: json(staffApiCpu)
            memory: staffApiMemory
          }
          env: concat(baseStaffEnv, enableSunsetRuntimeEnv ? sunsetAdminLocationEnv : [], enableGenericRuntimeEnv ? genericRuntimeEnv : [])
          // RADAR 16I — ACA probes (port must match ingress targetPort 3036).
          probes: [
            {
              type: 'Startup'
              httpGet: {
                path: '/healthz'
                port: 3036
              }
              initialDelaySeconds: 10
              periodSeconds: 10
              timeoutSeconds: 5
              failureThreshold: 30
              successThreshold: 1
            }
            {
              type: 'Liveness'
              httpGet: {
                path: '/healthz'
                port: 3036
              }
              initialDelaySeconds: 30
              periodSeconds: 20
              timeoutSeconds: 5
              failureThreshold: 3
              successThreshold: 1
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/readyz'
                port: 3036
              }
              initialDelaySeconds: 5
              periodSeconds: 10
              timeoutSeconds: 5
              failureThreshold: 3
              successThreshold: 1
            }
          ]
        }
      ]
      scale: {
        minReplicas: staffApiMinReplicas
        maxReplicas: staffApiMaxReplicas
      }
    }
  }
  dependsOn: [
    kvRoleAssignment
    acrPullRole
  ]
}
// RADAR 16L — Staff API capacity-pressure metric alerts (source-partial only).
var radar16lLockedSubscriptionId = '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9'
var radar16lOwnedOpsActionGroupResourceId = '/subscriptions/${radar16lLockedSubscriptionId}/resourceGroups/${assertedResourceGroupName}/providers/Microsoft.Insights/actionGroups/${opsActionGroupName}'
var radar16lAssertSubscription = subscription().subscriptionId == radar16lLockedSubscriptionId ? true : fail('wrong_subscription')
var radar16lAssertRg = resourceGroup().name == assertedResourceGroupName ? true : fail('wrong_resource_group')
var radar16lAssertOpsAg = opsActionGroupResourceId == radar16lOwnedOpsActionGroupResourceId ? true : fail('wrong_ops_action_group')
var radar16lCapacityLocksSatisfied = radar16lAssertSubscription && radar16lAssertRg && radar16lAssertOpsAg && safetyLocksSatisfied && registryLocksOk
var radar16lAlertSeverity = 2
var radar16lWindowSize = 'PT15M'
var radar16lEvaluationFrequency = 'PT5M'
var radar16lAlertsEnabled = true
var radar16lMetricNamespace = 'Microsoft.App/containerApps'
var radar16lTimeAggregation = 'Average'
var radar16lCapacityOperator = 'GreaterThan'
var radar16lCapacityThreshold = 80
var radar16lCpuMetricName = 'CpuPercentage'
var radar16lMemoryMetricName = 'MemoryPercentage'

resource staffApiCpuPressureAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = if (deployContainerApps && deployStaffApi && (!enablePrivateNetwork || syntheticRuntimePhase)) {
  name: '${capacityAlertNamePrefix}-staff-api-cpu-pressure'
  location: 'global'
  tags: enablePrivateNetwork ? syntheticOwnershipTags : {}
  properties: {
    description: '${capacityAlertNamePrefix == 'sunset' ? 'Sunset' : tenantSlug} Staff API capacity pressure: CpuPercentage Average > 80 (RADAR 16L; locks=${radar16lCapacityLocksSatisfied})'
    severity: radar16lAlertSeverity
    enabled: radar16lAlertsEnabled
    scopes: [
      staffApiApp.id
    ]
    evaluationFrequency: radar16lEvaluationFrequency
    windowSize: radar16lWindowSize
    autoMitigate: true
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'CpuPercentageAverage'
          metricName: radar16lCpuMetricName
          metricNamespace: radar16lMetricNamespace
          operator: radar16lCapacityOperator
          threshold: radar16lCapacityThreshold
          timeAggregation: radar16lTimeAggregation
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: [
      {
        actionGroupId: opsActionGroupResourceId
      }
    ]
  }
}

resource staffApiMemoryPressureAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = if (deployContainerApps && deployStaffApi && (!enablePrivateNetwork || syntheticRuntimePhase)) {
  name: '${capacityAlertNamePrefix}-staff-api-memory-pressure'
  location: 'global'
  tags: enablePrivateNetwork ? syntheticOwnershipTags : {}
  properties: {
    description: '${capacityAlertNamePrefix == 'sunset' ? 'Sunset' : tenantSlug} Staff API capacity pressure: MemoryPercentage Average > 80 (RADAR 16L; locks=${radar16lCapacityLocksSatisfied})'
    severity: radar16lAlertSeverity
    enabled: radar16lAlertsEnabled
    scopes: [
      staffApiApp.id
    ]
    evaluationFrequency: radar16lEvaluationFrequency
    windowSize: radar16lWindowSize
    autoMitigate: true
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'MemoryPercentageAverage'
          metricName: radar16lMemoryMetricName
          metricNamespace: radar16lMetricNamespace
          operator: radar16lCapacityOperator
          threshold: radar16lCapacityThreshold
          timeAggregation: radar16lTimeAggregation
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: [
      {
        actionGroupId: opsActionGroupResourceId
      }
    ]
  }
}
// --- Schema observer job (manual, gated; default off) ---

module schemaObserverJob '../../sunset-staging/schema-observer-job.bicep' = if (deployContainerApps && deploySchemaObserverJob) {
  name: 'schemaObserverJob'
  params: {
    jobName: resolvedSchemaObserverJobName
    containerAppsLocation: containerAppsLocation
    environmentId: containerAppsEnv.id
    managedIdentityId: managedIdentity.id
    staffApiImage: staffApiImage
    kvBaseUri: kvBaseUri
    observerDatabaseSecretName: resolvedSchemaObserverSecretName
    tags: resourceTags
  }
}

// Stage 2C2 — conditional synthetic bootstrap Job (private network only).
var bootstrapJobName = '${prefix}-bootstrap'
var bootstrapProvenance = {
  tenantSlug: tenantSlug
  ownerTag: ownerTag
  planDigest: planDigest
  deploySha: deploySha
  stageTag: 'saas-2c2'
}
module syntheticBootstrapJob './synthetic-bootstrap-job.bicep' = if (enablePrivateNetwork && deployBootstrapJob && bootstrapJobGateOk) {
  name: 'syntheticBootstrapJob'
  params: {
    jobName: bootstrapJobName
    containerAppsLocation: containerAppsLocation
    appNamePrefix: prefix
    appDbName: appDbName
    acrLoginServer: acrLoginServer
    staffApiImageRepository: staffApiImageRepository
    staffApiImageDigest: bootstrapJobImageDigest
    provenance: bootstrapProvenance
    adminDatabaseUrl: bootstrapAdminDatabaseUrl
    appRolePassword: bootstrapAppRolePassword
  }
  dependsOn: [
    pgApp
    appDb
    containerAppsEnv
    managedIdentity
    acrPullRole
  ]
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

output staffApiImage string = (deployContainerApps && deployStaffApi && (!enablePrivateNetwork || syntheticRuntimePhase)) ? staffApiApp!.properties.template.containers[0].image : ''

output containerAppsLocationOut string = containerAppsLocation

output staffApiMinReplicasOut int = (deployContainerApps && deployStaffApi && (!enablePrivateNetwork || syntheticRuntimePhase)) ? staffApiApp!.properties.template.scale.minReplicas : 0

output staffApiMaxReplicasOut int = (deployContainerApps && deployStaffApi && (!enablePrivateNetwork || syntheticRuntimePhase)) ? staffApiApp!.properties.template.scale.maxReplicas : 0

output acrLoginServer string = existingAcr.properties.loginServer

output portalUrlTarget string = effectivePortalUrlTarget

output staffApiFqdn string = (deployContainerApps && deployStaffApi && (!enablePrivateNetwork || syntheticRuntimePhase)) ? staffApiApp!.properties.configuration.ingress.fqdn : ''

output staffApiUrl string = (deployContainerApps && deployStaffApi && (!enablePrivateNetwork || syntheticRuntimePhase)) ? 'https://${staffApiApp!.properties.configuration.ingress.fqdn}' : ''

output staffApiResourceId string = (deployContainerApps && deployStaffApi && (!enablePrivateNetwork || syntheticRuntimePhase)) ? staffApiApp!.id : ''

output staffApiLatestRevisionName string = (deployContainerApps && deployStaffApi && (!enablePrivateNetwork || syntheticRuntimePhase)) ? staffApiApp!.properties.latestRevisionName : ''

output deploySchemaObserverJobOut bool = deploySchemaObserverJob

output privateNetworkEnabled bool = enablePrivateNetwork

output vnetId string = enablePrivateNetwork ? privateNetwork!.outputs.vnetId : ''

output acaInfrastructureSubnetId string = enablePrivateNetwork ? privateNetwork!.outputs.acaInfrastructureSubnetId : ''

output postgresDelegatedSubnetId string = enablePrivateNetwork ? privateNetwork!.outputs.postgresDelegatedSubnetId : ''

output privateDnsZoneId string = enablePrivateNetwork ? privateNetwork!.outputs.privateDnsZoneId : ''

output privateDnsVnetLinkId string = enablePrivateNetwork ? privateNetwork!.outputs.privateDnsVnetLinkId : ''

output natGatewayId string = enablePrivateNetwork ? privateNetwork!.outputs.natGatewayId : ''

output natPublicIpId string = enablePrivateNetwork ? privateNetwork!.outputs.natPublicIpId : ''

output natPublicIpAddress string = enablePrivateNetwork ? privateNetwork!.outputs.natPublicIpAddress : ''

output postgresServerId string = pgApp.id

output postgresPrivateFqdn string = pgApp.properties.fullyQualifiedDomainName

output containerAppsEnvironmentId string = containerAppsEnv.id
