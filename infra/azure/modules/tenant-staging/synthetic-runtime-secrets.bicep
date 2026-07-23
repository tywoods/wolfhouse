// Stage 2C3 synthetic runtime KV secrets. This module is used only by runtime-prereqs.
targetScope = 'resourceGroup'
param keyVaultName string
param provenance object
@secure()
param appDatabasePassword string
param postgresFqdn string
param derivedDatabaseName string
@secure()
param staffSessionSecret string
@secure()
param lunaBotInternalToken string
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
param tenantSlug string

var tenantSlugLower = toLower(tenantSlug)
var expectedAppUser = '${tenantSlugLower}_app'
var databaseUrlSecretName = '${tenantSlugLower}-database-url'
// Every caller-controlled DSN component is encoded. Host, port, TLS mode, user and DB
// identity are deployment-derived, so password metacharacters cannot inject authority/query data.
var appDatabaseUrl = 'postgresql://${uriComponent(expectedAppUser)}:${uriComponent(appDatabasePassword)}@${postgresFqdn}:5432/${uriComponent(derivedDatabaseName)}?sslmode=require'
var expectedInboxA = '${tenantSlugLower}-a@inbox.${tenantSlugLower}.invalid'
var expectedInboxB = '${tenantSlugLower}-b@inbox.${tenantSlugLower}.invalid'
var resourceTags = {
  tenant: provenance.tenantSlug
  stage: provenance.stageTag
  owner: provenance.ownerTag
  planDigest: provenance.planDigest
  deploySha: provenance.deploySha
}
var stripeSecretOk = stripeSecretKey == '***' ? true : fail('stripe_secret_sentinel')
var stripeWebhookOk = stripeWebhookSecret == 'whsec_disabled' ? true : fail('stripe_webhook_sentinel')
var metaTokenOk = metaWhatsappToken == 'EAAG_disabled' ? true : fail('meta_token_sentinel')
var metaAppOk = metaAppSecret == 'meta_app_secret_disabled' ? true : fail('meta_app_secret_sentinel')
var metaVerifyOk = metaWhatsappVerifyToken == 'meta_verify_disabled' ? true : fail('meta_verify_sentinel')
var waNumOk = locationWhatsappNumberA == '+10000000001' && locationWhatsappNumberB == '+10000000002' ? true : fail('synthetic_whatsapp_number_sentinel')
var waIdOk = locationWhatsappPhoneNumberIdA == '1000000000000001' && locationWhatsappPhoneNumberIdB == '1000000000000002' ? true : fail('synthetic_whatsapp_phone_id_sentinel')
var inboxOk = locationInboxEmailA == expectedInboxA && locationInboxEmailB == expectedInboxB ? true : fail('synthetic_inbox_invalid_required')
var fixedSecretNames = [
  'stripe-webhook-secret'
  'meta-whatsapp-token'
  'meta-app-secret'
  'meta-whatsapp-verify-token'
  'staff-session-secret'
  'stripe-secret-key'
  'luna-bot-internal-token'
  'tenant-loc-1-wa-number'
  'tenant-loc-1-wa-phone-id'
  'tenant-loc-1-inbox-email'
  'tenant-loc-2-wa-number'
  'tenant-loc-2-wa-phone-id'
  'tenant-loc-2-inbox-email'
]
var uniqueDatabaseSecretOk = !contains(fixedSecretNames, databaseUrlSecretName) ? true : fail('duplicate_runtime_secret_name')
var gatesOk = stripeSecretOk && stripeWebhookOk && metaTokenOk && metaAppOk && metaVerifyOk && waNumOk && waIdOk && inboxOk && uniqueDatabaseSecretOk
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = { name: keyVaultName }
var secretNames = concat([
  'stripe-webhook-secret'
  databaseUrlSecretName
], skip(fixedSecretNames, 1))
var secretValues = [
  stripeWebhookSecret
  appDatabaseUrl
  metaWhatsappToken
  metaAppSecret
  metaWhatsappVerifyToken
  staffSessionSecret
  stripeSecretKey
  lunaBotInternalToken
  locationWhatsappNumberA
  locationWhatsappPhoneNumberIdA
  locationInboxEmailA
  locationWhatsappNumberB
  locationWhatsappPhoneNumberIdB
  locationInboxEmailB
]
resource runtimeSecrets 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = [for (name, i) in secretNames: if (gatesOk) {
  parent: keyVault
  name: name
  tags: resourceTags
  properties: {
    value: secretValues[i]
  }
}]
output secretNames array = secretNames
output secretsReady bool = gatesOk
