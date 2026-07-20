// RADAR Slice 16B — standalone staging-only budget threshold module (one RG).
//
// Declares ONLY:
//   - Microsoft.Insights/actionGroups  (parameterized ops email receiver)
//   - Microsoft.Consumption/budgets    (monthly ActualCost thresholds 80%/100%)
//
// NOT wired into infra/azure/staging/main.bicep or sunset-staging/main.bicep.
// Structurally unable to touch Container Apps, DB, Key Vault, identities,
// networking, or production. Deploy Incremental only; live apply is out of
// scope for this slice (source + offline gates only).
//
// Locked subscription: 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9
// Locked RGs (deploy once per RG): wh-staging-rg | luna-sunset-staging-rg
// Amounts: wh-staging-rg=120 USD, luna-sunset-staging-rg=40 USD (passed as param)
// No email default — opsNotifyEmail REQUIRED at deploy time; never commit a real address.

targetScope = 'resourceGroup'

@description('Monthly ActualCost budget amount in USD — locked 120 (wh-staging-rg) or 40 (luna-sunset-staging-rg)')
@minValue(1)
param amountUsd int

@description('Budget resource name — locked per RG plan fixture')
param budgetName string

@description('Action group name — one ops-email AG per RG')
param actionGroupName string

@description('Action group short name (Azure max 12 chars)')
@maxLength(12)
param actionGroupShortName string

@description('Budget period start (UTC date, first of a month). Locked example: 2026-07-01')
param budgetStartDate string

@description('Ops notify email — REQUIRED at deploy via secure overlay/env. No default; never commit a real address.')
param opsNotifyEmail string

@description('First ActualCost notification threshold percent — locked 80')
@minValue(1)
@maxValue(1000)
param thresholdPercent80 int = 80

@description('Second ActualCost notification threshold percent — locked 100')
@minValue(1)
@maxValue(1000)
param thresholdPercent100 int = 100

resource opsBudgetActionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: actionGroupName
  location: 'Global'
  properties: {
    groupShortName: actionGroupShortName
    enabled: true
    emailReceivers: [
      {
        name: 'ops-email'
        emailAddress: opsNotifyEmail
        useCommonAlertSchema: true
      }
    ]
    smsReceivers: []
    webhookReceivers: []
    armRoleReceivers: []
    azureAppPushReceivers: []
    voiceReceivers: []
    logicAppReceivers: []
    azureFunctionReceivers: []
  }
}

resource monthlyActualCostBudget 'Microsoft.Consumption/budgets@2023-11-01' = {
  name: budgetName
  properties: {
    category: 'Cost'
    amount: amountUsd
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: budgetStartDate
    }
    notifications: {
      Actual_GreaterThan_80_Percent: {
        enabled: true
        operator: 'GreaterThan'
        threshold: thresholdPercent80
        thresholdType: 'Actual'
        contactEmails: []
        contactRoles: []
        contactGroups: [
          opsBudgetActionGroup.id
        ]
      }
      Actual_GreaterThan_100_Percent: {
        enabled: true
        operator: 'GreaterThan'
        threshold: thresholdPercent100
        thresholdType: 'Actual'
        contactEmails: []
        contactRoles: []
        contactGroups: [
          opsBudgetActionGroup.id
        ]
      }
    }
  }
}

output budgetNameOut string = monthlyActualCostBudget.name
output budgetResourceId string = monthlyActualCostBudget.id
output budgetAmountUsd int = amountUsd
output actionGroupNameOut string = opsBudgetActionGroup.name
output actionGroupResourceId string = opsBudgetActionGroup.id
output thresholdPercents array = [thresholdPercent80, thresholdPercent100]
output categoryOut string = 'Cost'
output timeGrainOut string = 'Monthly'
output deploymentModeRequired string = 'Incremental'
