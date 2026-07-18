// FOUNDATION Slice 6 — manual schema-observer Container Apps Job (source only).
// Disabled unless main.bicep sets deploySchemaObserverJob=true.
// Does not claim hold-expiry. Does not create the dedicated DB role/secret.
// No schedule, no ingress/public endpoint, zero idle cost when not triggered.

@description('Job resource name')
param jobName string

@description('Container Apps location (live CAE: northeurope)')
param containerAppsLocation string

@description('Existing Sunset Container Apps environment resource id')
param environmentId string

@description('Existing Sunset user-assigned managed identity resource id')
param managedIdentityId string

@description('Immutable Staff API image (luna-sunset-staff-api only)')
param staffApiImage string

@description('Key Vault base secrets URI, e.g. https://luna-sunset-staging-kv.vault.azure.net/secrets')
param kvBaseUri string

@description('Future dedicated read-only observer DSN secret name (not sunset-database-url)')
param observerDatabaseSecretName string = 'sunset-schema-observer-database-url'

@description('Replica timeout seconds (bounded)')
param replicaTimeout int = 120

@description('Replica retry limit (bounded)')
param replicaRetryLimit int = 1

@description('Job container CPU')
param cpu string = '0.25'

@description('Job container memory')
param memory string = '0.5Gi'

@description('Resource tags')
param tags object = {}

resource schemaObserverJob 'Microsoft.App/jobs@2023-05-01' = {
  name: jobName
  location: containerAppsLocation
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${managedIdentityId}': {}
    }
  }
  properties: {
    environmentId: environmentId
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: replicaTimeout
      replicaRetryLimit: replicaRetryLimit
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      secrets: [
        {
          name: 'sunset-schema-observer-database-url'
          keyVaultUrl: '${kvBaseUri}/${observerDatabaseSecretName}'
          identity: managedIdentityId
        }
      ]
      registries: [
        {
          server: 'whstagingacr.azurecr.io'
          identity: managedIdentityId
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'schema-observer'
          image: staffApiImage
          command: [
            'node'
            'scripts/observe-sunset-schema-drift.js'
          ]
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          env: [
            { name: 'DEFAULT_CLIENT_SLUG', value: 'sunset' }
            { name: 'WHATSAPP_DRY_RUN', value: 'true' }
            { name: 'NODE_ENV', value: 'staging' }
            {
              name: 'SUNSET_SCHEMA_OBSERVER_DATABASE_URL'
              secretRef: 'sunset-schema-observer-database-url'
            }
          ]
        }
      ]
    }
  }
}

output jobName string = schemaObserverJob.name
output jobId string = schemaObserverJob.id
