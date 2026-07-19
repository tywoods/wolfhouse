// Standalone module: Key Vault Secrets User for Lunabox wh-staging-identity
// on existing luna-sunset-staging-kv (FOUNDATION Slice 14H).
//
// Resolves the Slice 14G live credential-preflight 403 (principal lacks get/list
// on this vault). Plan/prove only in 14H — do NOT wire into main.bicep, do NOT
// deploy, do NOT run what-if from this slice.
//
// Locked principalId: e3136eed-948b-4947-a26e-50a33b45a41a (wh-staging-identity)
// Locked role: Key Vault Secrets User 4633458b-17de-408a-b874-0445c86b69e6
// Locked scope: existing vault only (not RG / subscription / wildcard)

targetScope = 'resourceGroup'

@description('Existing Key Vault name — locked luna-sunset-staging-kv')
param keyVaultName string

@description('Principal ID of wh-staging-identity — locked e3136eed-948b-4947-a26e-50a33b45a41a')
param principalId string

resource existingKeyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

// Key Vault Secrets User: 4633458b-17de-408a-b874-0445c86b69e6 — get/list secrets only
resource kvSecretsUserRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(existingKeyVault.id, principalId, '4633458b-17de-408a-b874-0445c86b69e6')
  scope: existingKeyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

output roleAssignmentName string = kvSecretsUserRoleAssignment.name
output scopeResourceId string = existingKeyVault.id
output principalIdOut string = principalId
output roleDefinitionId string = '4633458b-17de-408a-b874-0445c86b69e6'
output principalType string = 'ServicePrincipal'
