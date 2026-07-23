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
// --- Locked-live Sunset tuple + synthetic safety ---
var tenantSlugLower = toLower(tenantSlug)
var isLockedLiveSunset = tenantSlugLower == 'sunset' && assertedResourceGroupName == 'luna-sunset-staging-rg' && resourceGroup().name == 'luna-sunset-staging-rg' && appNamePrefix == 'luna-sunset-staging' && appDbName == 'sunset_staging' && environmentName == 'staging'
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

// Synthetic outbound is derived false — not merely caller-requested.
var effectiveWhatsappDryRun = isLockedLiveSunset ? whatsappDryRun : 'true'
var effectiveStripeLinksEnabled = isLockedLiveSunset ? stripeLinksEnabled : 'false'
var effectiveStaffActionsEnabled = isLockedLiveSunset ? staffActionsEnabled : 'false'

var safetyLocksSatisfied = sunsetSlugTupleOk && reservedSlugOk && sunsetEnvLockOk && stagingPrefixOk && stagingRgOk && noWhStagingPrefix && deployScopeOk && environmentStagingOk

var prefix = appNamePrefix
var kvName = '${prefix}-kv'
var logName = '${prefix}-logs'
var aiName = '${prefix}-appinsights'
var envName = '${prefix}-env'
var idName = '${prefix}-identity'
var staffApiAppName = '${prefix}-staff-api'
var pgServerName = '${prefix}-pg-app'
var resolvedSchemaObserverJobName = empty(schemaObserverJobName) ? '${appNamePrefix}-sch-obs' : schemaObserverJobName
var resolvedSchemaObserverSecretName = empty(schemaObserverDatabaseSecretName) ? '${tenantSlug}-schema-observer-database-url' : schemaObserverDatabaseSecretName

var resourceTags = {
  product: 'Luna Front Desk'
  tenant: tenantSlug
  environment: environmentName
  owner: ownerTag
  slice: 'portal-1'
  safetyLocksSatisfied: string(safetyLocksSatisfied)
}
var staffApiTags = {
  product: 'Luna Front Desk'
  tenant: tenantSlug
  environment: environmentName
  slice: 'portal-1'
}
var staffApiImage = '${acrLoginServer}/${staffApiImageRepository}:${staffApiImageTag}'
var imageRegistryOk = startsWith(staffApiImage, '${acrLoginServer}/') && !contains(staffApiImage, 'wh-staff-api') ? true : fail('image_registry_mismatch')
var acrLoginServerMatches = acrLoginServer == '${acrName}.azurecr.io' ? true : fail('acr_login_server_mismatch')
var registryLocksOk = imageRegistryOk && acrLoginServerMatches && safetyLocksSatisfied
var checkoutSuccessUrl = 'https://${staffApiCustomDomain}/staff/login?checkout=success&session_id={CHECKOUT_SESSION_ID}'
var checkoutCancelUrl = 'https://${staffApiCustomDomain}/staff/login?checkout=cancel'
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

resource pgFirewallRules 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-06-01-preview' = [for (ip, i) in postgresAllowedIpAddresses: {
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

resource existingManagedCert 'Microsoft.App/managedEnvironments/managedCertificates@2023-05-01' existing = {
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
  { name: 'WOLFHOUSE_DATABASE_URL', secretRef: databaseUrlSecretName }
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

// --- Staff API Container App ---

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
        {
          name: 'luna-bot-internal-token'
          value: lunaBotInternalToken
        }
      ]
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
          env: concat(baseStaffEnv, enableSunsetRuntimeEnv ? sunsetAdminLocationEnv : [])
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

resource staffApiCpuPressureAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = if (deployContainerApps && deployStaffApi) {
  name: '${capacityAlertNamePrefix}-staff-api-cpu-pressure'
  location: 'global'
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

resource staffApiMemoryPressureAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = if (deployContainerApps && deployStaffApi) {
  name: '${capacityAlertNamePrefix}-staff-api-memory-pressure'
  location: 'global'
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

output portalUrlTarget string = portalUrlTarget

output deploySchemaObserverJobOut bool = deploySchemaObserverJob
