// Standalone module: Lunabox egress firewall rule on existing Sunset staging
// PostgreSQL Flexible Server (FOUNDATION Slice 14N).
//
// Declares exactly one rule AllowLunaboxEgress for IPv4 20.238.124.76.
// References existing luna-sunset-staging-pg-app — do NOT wire into main.bicep,
// do NOT deploy full main.bicep, do NOT alter existing CAE/App egress rules.
//
// Locked apply is via the gated ARM REST adapter (one PUT of this rule resource).

targetScope = 'resourceGroup'

@description('Existing PostgreSQL Flexible Server name — locked luna-sunset-staging-pg-app')
param postgresServerName string

@description('Firewall rule name — locked AllowLunaboxEgress')
param firewallRuleName string

@description('Start IPv4 — locked 20.238.124.76 (single host; must equal endIpAddress)')
param startIpAddress string

@description('End IPv4 — locked 20.238.124.76 (single host; must equal startIpAddress)')
param endIpAddress string

resource existingPgApp 'Microsoft.DBforPostgreSQL/flexibleServers@2023-06-01-preview' existing = {
  name: postgresServerName
}

resource lunaboxEgressRule 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-06-01-preview' = {
  parent: existingPgApp
  name: firewallRuleName
  properties: {
    startIpAddress: startIpAddress
    endIpAddress: endIpAddress
  }
}

output firewallRuleNameOut string = lunaboxEgressRule.name
output firewallRuleResourceId string = lunaboxEgressRule.id
output startIpAddressOut string = lunaboxEgressRule.properties.startIpAddress
output endIpAddressOut string = lunaboxEgressRule.properties.endIpAddress
output postgresServerNameOut string = existingPgApp.name
