// Scoped module: AcrPull for Sunset identity on shared whstagingacr (cross-RG)
targetScope = 'resourceGroup'

@description('Existing ACR name in this resource group')
param acrName string

@description('Principal ID of luna-sunset-staging-identity')
param principalId string

resource existingAcr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: acrName
}

// AcrPull: 7f951dda-4ed3-4680-a7ca-43fe172d538d — pull only, no push
resource acrPullRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(existingAcr.id, principalId, '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  scope: existingAcr
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}
