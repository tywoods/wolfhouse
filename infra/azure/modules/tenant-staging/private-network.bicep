// MESSI SaaS Stage 2C1 — synthetic-only private network foundation (RG scope).
// NAT egress for ACA infra subnet; delegated PG subnet + private DNS. No secrets.
targetScope = 'resourceGroup'

param location string
param appNamePrefix string
param tenantSlug string
param stageTag string
param ownerTag string
param planDigest string
param deploySha string

var prefix = appNamePrefix
var vnetName = '${prefix}-vnet'
var acaSubnetName = 'aca-infra'
var pgSubnetName = 'pg-delegated'
var natName = '${prefix}-nat'
var pipName = '${prefix}-nat-pip'
var dnsZoneName = 'privatelink.postgres.database.azure.com'
var dnsLinkName = '${prefix}-pg-dns-link'

var resourceTags = {
  tenant: tenantSlug
  stage: stageTag
  owner: ownerTag
  planDigest: planDigest
  deploySha: deploySha
}

resource natPublicIp 'Microsoft.Network/publicIPAddresses@2023-09-01' = {
  name: pipName
  location: location
  tags: resourceTags
  sku: {
    name: 'Standard'
    tier: 'Regional'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
  }
}

resource natGateway 'Microsoft.Network/natGateways@2023-09-01' = {
  name: natName
  location: location
  tags: resourceTags
  sku: {
    name: 'Standard'
  }
  properties: {
    publicIpAddresses: [
      {
        id: natPublicIp.id
      }
    ]
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2023-09-01' = {
  name: vnetName
  location: location
  tags: resourceTags
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.60.0.0/16'
      ]
    }
    subnets: [
      {
        name: acaSubnetName
        properties: {
          addressPrefix: '10.60.0.0/23'
          natGateway: {
            id: natGateway.id
          }
          delegations: [
            {
              name: 'aca-env'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
        }
      }
      {
        name: pgSubnetName
        properties: {
          addressPrefix: '10.60.2.0/28'
          delegations: [
            {
              name: 'pg-flex'
              properties: {
                serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers'
              }
            }
          ]
        }
      }
    ]
  }
}

resource privateDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: dnsZoneName
  location: 'global'
  tags: resourceTags
}

resource privateDnsVnetLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: privateDnsZone
  name: dnsLinkName
  location: 'global'
  tags: resourceTags
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}

output vnetId string = vnet.id
output acaInfrastructureSubnetId string = resourceId('Microsoft.Network/virtualNetworks/subnets', vnetName, acaSubnetName)
output postgresDelegatedSubnetId string = resourceId('Microsoft.Network/virtualNetworks/subnets', vnetName, pgSubnetName)
output privateDnsZoneId string = privateDnsZone.id
output privateDnsVnetLinkId string = privateDnsVnetLink.id
output natGatewayId string = natGateway.id
output natPublicIpId string = natPublicIp.id
output natPublicIpAddress string = natPublicIp.properties.ipAddress
