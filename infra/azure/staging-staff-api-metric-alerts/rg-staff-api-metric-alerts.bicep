// RADAR Slice 16F — standalone staging-only Staff API metric alerts (one RG).
//
// Declares ONLY:
//   - Microsoft.Insights/metricAlerts  (Requests 5xx + RestartCount)
//
// References (existing — never create/modify):
//   - Microsoft.Insights/actionGroups  (16B ops AG name derived from RG)
//   - Microsoft.App/containerApps      (Staff API app ARM scope only)
//
// Fail-closed hard locks (evaluated at deploy time via subscription()/resourceGroup()):
//   - Exact subscription id
//   - Exact RG → app tuple (only containerAppName may be supplied, and must match)
//   - Tenant slug + 16B action-group name derived from RG (not parameters)
//   - Metric names / operators / thresholds / severity / windows / enabled are vars
//
// NOT wired into infra/azure/staging/main.bicep or sunset-staging/main.bicep.
// Structurally unable to touch apps (create/update), identity, secrets, DB,
// network, budgets, or action groups. Deploy Incremental only (ARM mode is
// external — use the shell-free argv builder). Live apply is out of scope.

targetScope = 'resourceGroup'

@description('Staff API Container App name — ONLY overridable input; must match the locked RG/app tuple')
param containerAppName string

// --- Hard locks (fail closed) ---
var lockedSubscriptionId = '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9'
var assertSubscription = subscription().subscriptionId == lockedSubscriptionId ? true : fail('wrong_subscription')

var rgName = resourceGroup().name
var expectedContainerAppName = rgName == 'wh-staging-rg'
  ? 'wh-staging-staff-api'
  : (rgName == 'luna-sunset-staging-rg' ? 'luna-sunset-staging-staff-api' : fail('wrong_resource_group'))
var assertRgAppTuple = containerAppName == expectedContainerAppName ? true : fail('wrong_container_app')
var hardLocksSatisfied = assertSubscription && assertRgAppTuple

// Derived from RG — never parameters / never overridable
var tenantSlug = rgName == 'wh-staging-rg'
  ? 'wolfhouse'
  : (rgName == 'luna-sunset-staging-rg' ? 'sunset' : fail('wrong_resource_group'))
var actionGroupName = rgName == 'wh-staging-rg'
  ? 'wh-staging-ops-budget-ag'
  : (rgName == 'luna-sunset-staging-rg' ? 'luna-sunset-staging-ops-budget-ag' : fail('wrong_resource_group'))

// Locked metric-alert constants (vars — not parameters)
var requestsMetricName = 'Requests'
var restartMetricName = 'RestartCount'
var requests5xxOperator = 'GreaterThanOrEqual'
var restartCountOperator = 'GreaterThan'
var requests5xxThreshold = 3
var restartCountThreshold = 0
var alertSeverity = 2
var windowSize = 'PT5M'
var evaluationFrequency = 'PT1M'
var alertsEnabled = true
var metricNamespace = 'Microsoft.App/containerApps'
var timeAggregation = 'Total'
var statusCodeCategoryDimension = 'statusCodeCategory'
var statusCodeCategoryValue = '5xx'

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
    description: 'Tenant-named Staff API alert: Requests Total statusCodeCategory=5xx threshold (hard-locked; locks=${hardLocksSatisfied})'
    severity: alertSeverity
    enabled: alertsEnabled
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
          metricName: requestsMetricName
          metricNamespace: metricNamespace
          operator: requests5xxOperator
          threshold: requests5xxThreshold
          timeAggregation: timeAggregation
          criterionType: 'StaticThresholdCriterion'
          dimensions: [
            {
              name: statusCodeCategoryDimension
              operator: 'Include'
              values: [
                statusCodeCategoryValue
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
    description: 'Tenant-named Staff API alert: RestartCount Total threshold (hard-locked; locks=${hardLocksSatisfied})'
    severity: alertSeverity
    enabled: alertsEnabled
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
          metricName: restartMetricName
          metricNamespace: metricNamespace
          operator: restartCountOperator
          threshold: restartCountThreshold
          timeAggregation: timeAggregation
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
output actionGroupNameOut string = actionGroupName
output tenantSlugOut string = tenantSlug
output hardLocksSatisfiedOut bool = hardLocksSatisfied
output deploymentModeRequired string = 'Incremental'
output allowedResourceType string = 'Microsoft.Insights/metricAlerts'
