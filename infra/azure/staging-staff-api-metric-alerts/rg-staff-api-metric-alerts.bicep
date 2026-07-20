// RADAR Slice 16F — standalone staging-only Staff API metric alerts (one RG).
//
// Declares ONLY:
//   - Microsoft.Insights/metricAlerts  (Requests 5xx + RestartCount)
//
// References (existing — never create/modify):
//   - Microsoft.Insights/actionGroups  (per-RG ops AG name from 16B)
//   - Microsoft.App/containerApps      (Staff API app ARM scope only)
//
// NOT wired into infra/azure/staging/main.bicep or sunset-staging/main.bicep.
// Structurally unable to touch apps (create/update), identity, secrets, DB,
// network, budgets, or action groups. Deploy Incremental only; live apply is
// out of scope for this slice (source + offline gates only).
//
// Locked subscription: 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9
// Locked pairs (deploy once per RG):
//   wh-staging-rg            → wh-staging-staff-api            + wh-staging-ops-budget-ag            (tenant wolfhouse)
//   luna-sunset-staging-rg   → luna-sunset-staging-staff-api   + luna-sunset-staging-ops-budget-ag   (tenant sunset)

targetScope = 'resourceGroup'

@description('Staff API Container App name — locked per RG plan (wh-staging-staff-api | luna-sunset-staging-staff-api)')
param containerAppName string

@description('Existing 16B ops action group name — referenced only; never created or modified')
param actionGroupName string

@description('Tenant slug for alert resource names (wolfhouse | sunset)')
param tenantSlug string

@description('Requests 5xx Total threshold — locked 3 (operator GreaterThanOrEqual)')
@minValue(1)
param requests5xxThreshold int = 3

@description('RestartCount Total threshold — locked 0 (operator GreaterThan)')
@minValue(0)
param restartCountThreshold int = 0

@description('Alert severity — locked 2')
@minValue(0)
@maxValue(4)
param alertSeverity int = 2

@description('Metric window size — locked PT5M')
param windowSize string = 'PT5M'

@description('Evaluation frequency — locked PT1M')
param evaluationFrequency string = 'PT1M'

// Existing 16B ops action group — reference only (no create/modify).
resource opsActionGroup 'Microsoft.Insights/actionGroups@2023-01-01' existing = {
  name: actionGroupName
}

var containerAppResourceId = resourceId('Microsoft.App/containerApps', containerAppName)
var requests5xxAlertName = '${tenantSlug}-staff-api-requests-5xx'
var restartCountAlertName = '${tenantSlug}-staff-api-restart-count'

resource requests5xxAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: requests5xxAlertName
  location: 'global'
  properties: {
    description: 'Tenant-named Staff API alert: Requests Total statusCodeCategory=5xx threshold'
    severity: alertSeverity
    enabled: true
    scopes: [
      containerAppResourceId
    ]
    evaluationFrequency: evaluationFrequency
    windowSize: windowSize
    autoMitigate: true
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'Requests5xxTotal'
          metricName: 'Requests'
          metricNamespace: 'Microsoft.App/containerApps'
          operator: 'GreaterThanOrEqual'
          threshold: requests5xxThreshold
          timeAggregation: 'Total'
          criterionType: 'StaticThresholdCriterion'
          dimensions: [
            {
              name: 'statusCodeCategory'
              operator: 'Include'
              values: [
                '5xx'
              ]
            }
          ]
        }
      ]
    }
    actions: [
      {
        actionGroupId: opsActionGroup.id
      }
    ]
  }
}

resource restartCountAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: restartCountAlertName
  location: 'global'
  properties: {
    description: 'Tenant-named Staff API alert: RestartCount Total threshold'
    severity: alertSeverity
    enabled: true
    scopes: [
      containerAppResourceId
    ]
    evaluationFrequency: evaluationFrequency
    windowSize: windowSize
    autoMitigate: true
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'RestartCountTotal'
          metricName: 'RestartCount'
          metricNamespace: 'Microsoft.App/containerApps'
          operator: 'GreaterThan'
          threshold: restartCountThreshold
          timeAggregation: 'Total'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: [
      {
        actionGroupId: opsActionGroup.id
      }
    ]
  }
}

output requests5xxAlertNameOut string = requests5xxAlert.name
output restartCountAlertNameOut string = restartCountAlert.name
output containerAppScope string = containerAppResourceId
output actionGroupResourceId string = opsActionGroup.id
output tenantSlugOut string = tenantSlug
output deploymentModeRequired string = 'Incremental'
output allowedResourceType string = 'Microsoft.Insights/metricAlerts'
