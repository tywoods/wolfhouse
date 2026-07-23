// MESSI SaaS Stage 2C2 — one-shot synthetic migrate + app-role ACA Job.
// IDs/host/DB/identity/ACR/subscription/RG derived from existing sibling resources.
// Provenance + digest image from main; @secure secrets → Job secretRefs only.
targetScope = 'resourceGroup'
param jobName string
param containerAppsLocation string
param appNamePrefix string
param appDbName string
param acrLoginServer string
param staffApiImageRepository string = 'luna-sunset-staff-api'
param staffApiImageDigest string
param provenance object
param replicaTimeout int = 900
param cpu string = '0.5'
param memory string = '1Gi'
@secure()
param adminDatabaseUrl string
@secure()
param appRolePassword string
var digestHexOk = length(staffApiImageDigest) == 71 && startsWith(staffApiImageDigest, 'sha256:') ? true : fail('staff_image_digest_required')
// Digest-only: <acr>/<repo>@sha256:<64hex> (tags rejected).
var staffApiImage = '${acrLoginServer}/${staffApiImageRepository}@${staffApiImageDigest}'
var digestLiteralGate = contains(staffApiImage, '@sha256:') ? true : fail('staff_image_digest_required')
var digestOk = digestHexOk && digestLiteralGate
var pgServerName = '${appNamePrefix}-pg-app'
var envName = '${appNamePrefix}-env'
var idName = '${appNamePrefix}-identity'
var drillTags = empty(provenance.temporaryDrill) ? {} : {
  temporaryDrill: provenance.temporaryDrill
  createdAt: provenance.createdAt
  expiresAt: provenance.expiresAt
}
var resourceTags = union({
  tenant: provenance.tenantSlug
  stage: provenance.stageTag
  owner: provenance.ownerTag
  planDigest: provenance.planDigest
  deploySha: provenance.deploySha
}, drillTags)
resource pgApp 'Microsoft.DBforPostgreSQL/flexibleServers@2023-06-01-preview' existing = { name: pgServerName }
resource appDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-06-01-preview' existing = { parent: pgApp, name: appDbName }
resource containerAppsEnv 'Microsoft.App/managedEnvironments@2023-05-01' existing = { name: envName }
resource managedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = { name: idName }
resource bootstrapJob 'Microsoft.App/jobs@2023-05-01' = if (digestOk) {
  name: jobName
  location: containerAppsLocation
  tags: resourceTags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${managedIdentity.id}': {} } }
  properties: {
    environmentId: containerAppsEnv.id
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: replicaTimeout
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      secrets: [
        { name: 'admin-database-url', value: adminDatabaseUrl }
        { name: 'app-role-password', value: appRolePassword }
      ]
      registries: [ { server: acrLoginServer, identity: managedIdentity.id } ]
    }
    template: {
      containers: [
        {
          name: 'synthetic-bootstrap'
          image: staffApiImage
          command: ['node', 'scripts/bootstrap-synthetic-tenant-db.js']
          resources: { cpu: json(cpu), memory: memory }
          env: [
            { name: 'TENANT_SLUG', value: provenance.tenantSlug }
            { name: 'EXPECTED_PG_HOST', value: pgApp.properties.fullyQualifiedDomainName }
            { name: 'EXPECTED_PG_DATABASE', value: appDb.name }
            { name: 'EXPECTED_PG_PORT', value: '5432' }
            { name: 'SUBSCRIPTION_ID', value: subscription().subscriptionId }
            { name: 'RESOURCE_GROUP_NAME', value: resourceGroup().name }
            { name: 'ACA_ENVIRONMENT_ID', value: containerAppsEnv.id }
            { name: 'POSTGRES_SERVER_ID', value: pgApp.id }
            { name: 'PLAN_DIGEST', value: provenance.planDigest }
            { name: 'DEPLOY_SHA', value: provenance.deploySha }
            { name: 'OWNER', value: provenance.ownerTag }
            { name: 'SYNTHETIC_BOOTSTRAP_ADMIN_DATABASE_URL', secretRef: 'admin-database-url' }
            { name: 'SYNTHETIC_BOOTSTRAP_APP_ROLE_PASSWORD', secretRef: 'app-role-password' }
          ]
        }
      ]
    }
  }
}
output jobName string = bootstrapJob.name
output jobId string = bootstrapJob.id
