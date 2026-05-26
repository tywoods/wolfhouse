# Phase 3b.2c — POST local assign-beds-to-booking webhook (test helper).
# Requires: local n8n + imported "Bed Assignment (local PG)" workflow ACTIVE.
# Deactivate hosted Bed Assignment on local n8n to avoid path conflicts.
param(
  [string]$RecordId = '',
  [string]$BookingCode = '',
  [string]$BaseUrl = 'http://localhost:5678/webhook'
)

$ErrorActionPreference = 'Stop'

if (-not $RecordId -and -not $BookingCode) {
  Write-Host 'Provide -RecordId recXXXXXXXX or -BookingCode WH-recXXXXXXXX' -ForegroundColor Red
  exit 1
}

if ($RecordId -match '^WH-(.+)$') {
  $RecordId = $Matches[1]
}
if ($BookingCode -match '^WH-(.+)$' -and -not $RecordId) {
  $suffix = $Matches[1]
  if ($suffix -match '^rec') {
    $RecordId = $suffix
  }
}
if ($RecordId -match '^rec' -and -not $BookingCode) {
  $BookingCode = "WH-$RecordId"
}

$body = @{}
if ($RecordId) { $body.record_id = $RecordId }
if ($BookingCode) { $body.booking_code = $BookingCode }

$json = $body | ConvertTo-Json -Compress
$uri = "$BaseUrl/assign-beds-to-booking"

Write-Host "POST $uri"
Write-Host "Body: $json"
Write-Host ''

try {
  $response = Invoke-RestMethod -Method POST -Uri $uri -Body $json -ContentType 'application/json' -TimeoutSec 300
  $response | ConvertTo-Json -Depth 8
  if ($response.ok -eq $true) {
    Write-Host "`nOK: $($response.message) (pg_inserted=$($response.pg_inserted_count) skipped=$($response.pg_skipped_count))" -ForegroundColor Green
    exit 0
  }
  if ($response.idempotent -eq $true -and -not $response.partial_failure) {
    Write-Host "`nOK: idempotent (pg_inserted=$($response.pg_inserted_count))" -ForegroundColor Green
    exit 0
  }
  if ($response.assignment_conflict) {
    Write-Host "`nCONFLICT: assignment could not complete" -ForegroundColor Yellow
    exit 2
  }
  if ($response.partial_failure) {
    Write-Host "`nPARTIAL: $($response.partial_failure)" -ForegroundColor Yellow
    if ($response.errors) {
      Write-Host "errors: $($response.errors -join '; ')" -ForegroundColor Yellow
    }
    exit 2
  }
  if ($response.skipped_reason) {
    Write-Host "`nSKIPPED: $($response.skipped_reason) (set Airtable Assignment Status to Unassigned for full PG+AT path)" -ForegroundColor Yellow
    exit 0
  }
  Write-Host "`nFAILED: $($response.message)" -ForegroundColor Red
  if ($response.errors) {
    Write-Host "errors: $($response.errors -join '; ')" -ForegroundColor Red
  }
  exit 1
}
catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  if ($_.ErrorDetails.Message) {
    Write-Host $_.ErrorDetails.Message -ForegroundColor Red
  }
  exit 1
}
