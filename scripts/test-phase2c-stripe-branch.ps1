# Test Phase 2c Stripe branch dependencies (Postgres lookup + Create Payment Session).
# Does not run full Main workflow.
# Usage: .\scripts\test-phase2c-stripe-branch.ps1 -BookingCode "WH-rec1234"
param(
  [Parameter(Mandatory = $true)]
  [string]$BookingCode,
  [string]$CreateSessionUrl = 'http://localhost:5678/webhook/create-payment-session'
)

Write-Host "Booking code: $BookingCode"
Write-Host ''

Write-Host '1. Postgres lookup...'
$lookupSql = "SELECT id, booking_code, payment_status FROM bookings WHERE booking_code = '$BookingCode' AND client_id = (SELECT id FROM clients WHERE slug = 'wolfhouse-somo') LIMIT 1;"
docker exec wolfhouse-postgres psql -U wolfhouse -d wolfhouse -c $lookupSql
if ($LASTEXITCODE -ne 0) { exit 1 }

$idSql = "SELECT id FROM bookings WHERE booking_code = '$BookingCode' AND client_id = (SELECT id FROM clients WHERE slug = 'wolfhouse-somo') LIMIT 1;"
$bookingId = (docker exec wolfhouse-postgres psql -U wolfhouse -d wolfhouse -t -A -c $idSql).Trim()

if (-not $bookingId) {
  Write-Host 'No Postgres UUID for booking_code - run Main (local Stripe) or db:sync first.' -ForegroundColor Red
  exit 1
}

Write-Host ''
Write-Host "UUID: $bookingId"
Write-Host '2. Create Payment Session...'

$body = @{ booking_id = $bookingId; payment_kind = 'deposit_only' } | ConvertTo-Json

try {
  $resp = Invoke-RestMethod -Method POST -Uri $CreateSessionUrl -ContentType 'application/json' -Body $body
  $resp | ConvertTo-Json -Depth 6
  if ($resp.checkout_url) {
    Write-Host ''
    Write-Host 'OK: checkout_url ready for Airtable Payment Link' -ForegroundColor Green
    Write-Host $resp.checkout_url
  } else {
    Write-Host 'No checkout_url returned' -ForegroundColor Red
    exit 1
  }
} catch {
  Write-Host 'Create Payment Session failed:' -ForegroundColor Red
  Write-Host $_.Exception.Message
  if ($_.ErrorDetails.Message) {
    Write-Host $_.ErrorDetails.Message
  }
  exit 1
}
