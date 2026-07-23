// MESSI SaaS Stage 2C1 — runtime-phase Key Vault secrets only.
// Deploy after infra phase; never referenced by Sunset wrapper (preserves one-phase compiled parity).
targetScope = 'resourceGroup'

param keyVaultName string
param databaseUrlSecretName string
param ownerTag string
param tenantSlug string
param stageTag string = 'saas-2c1'
param planDigest string
param deploySha string
param appDatabaseUser string
param postgresAdminUser string

@secure()
param appDatabaseUrl string
@secure()
param staffSessionSecret string
@secure()
param stripeSecretKey string
@secure()
param stripeWebhookSecret string
@secure()
param metaWhatsappToken string
@secure()
param metaAppSecret string
@secure()
param metaWhatsappVerifyToken string

var appUserLower = toLower(appDatabaseUser)
var appDsnUserOk = !empty(appDatabaseUser) && appDatabaseUser != postgresAdminUser && appUserLower != 'postgres' && !contains(appUserLower, 'admin') ? true : fail('admin_app_dsn_user_rejected')
var ownershipOk = !empty(planDigest) && !empty(deploySha) && !empty(ownerTag) && !empty(tenantSlug) && appDsnUserOk ? true : fail('runtime_ownership_tuple_required')

var secretTags = {
  synthetic: 'true'
  stage: stageTag
  tenant: tenantSlug
  planDigest: planDigest
  deploySha: deploySha
  owner: ownerTag
  ownershipOk: string(ownershipOk)
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource kvDatabaseUrlSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: databaseUrlSecretName
  tags: secretTags
  properties: {
    value: appDatabaseUrl
  }
}

resource kvStripeSecretKey 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'stripe-secret-key'
  tags: secretTags
  properties: {
    value: stripeSecretKey
  }
}

resource kvStripeWebhookSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'stripe-webhook-secret'
  tags: secretTags
  properties: {
    value: stripeWebhookSecret
  }
}

resource kvStaffSessionSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'staff-session-secret'
  tags: secretTags
  properties: {
    value: staffSessionSecret
  }
}

resource kvMetaWhatsappToken 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'meta-whatsapp-token'
  tags: secretTags
  properties: {
    value: metaWhatsappToken
  }
}

resource kvMetaAppSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'meta-app-secret'
  tags: secretTags
  properties: {
    value: metaAppSecret
  }
}

resource kvMetaWhatsappVerifyToken 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'meta-whatsapp-verify-token'
  tags: secretTags
  properties: {
    value: metaWhatsappVerifyToken
  }
}

output keyVaultNameOut string = keyVaultName
output createdCount int = 7
output ownershipPlanDigest string = planDigest
output ownershipDeploySha string = deploySha
output ownershipTenant string = tenantSlug
