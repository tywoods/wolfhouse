# Phase 3b.3b — POST local reassign-booking-beds webhook (test helper).
# Requires: local n8n + imported "Reassign Bed Assignments (local PG)" ACTIVE.
# Requires: local "Bed Assignment (local PG)" ACTIVE on assign-beds-to-booking.
# Deactivate hosted Reassign (and hosted Assign) on local n8n to avoid path conflicts.
param(
  [string]$RecordId = '',
  [string]$BookingCode = '',
  [int]$GuestCount = 0,
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
if ($GuestCount -gt 0) { $body.guest_count = $GuestCount }

$json = $body | ConvertTo-Json -Compress
$uri = "$BaseUrl/reassign-booking-beds"

Write-Host "POST $uri"
Write-Host "Body: $json"
Write-Host ''

try {
  $response = Invoke-RestMethod -Method POST -Uri $uri -Body $json -ContentType 'application/json'
  $response | ConvertTo-Json -Depth 8
  if ($response.ok -eq $true) {
    Write-Host "`nOK: $($response.message) (pg_deleted=$($response.pg_deleted_count) pg_inserted=$($response.pg_inserted_count))" -ForegroundColor Green
    exit 0
  }
  if ($response.partial_failure) {
    Write-Host "`nPARTIAL: $($response.partial_failure)" -ForegroundColor Yellow
    if ($response.errors) {
      Write-Host "errors: $($response.errors -join '; ')" -ForegroundColor Yellow
    }
    exit 2
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
