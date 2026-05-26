# Test Phase 2d Send Confirmation (Postgres trigger + dry-run WhatsApp).
# Usage:
#   .\scripts\test-phase2d-send-confirmation.ps1 -BookingCode "WH-recSyn7QcPdVrYa1D"
#   .\scripts\test-phase2d-send-confirmation.ps1 -BookingId "uuid-here"
param(
  [string]$BookingCode,
  [string]$BookingId,
  [string]$WebhookUrl = 'http://localhost:5678/webhook/send-confirmation-local',
  [int]$MaxWaitSeconds = 20,
  [int]$PollIntervalSeconds = 2
)

if (-not $BookingCode -and -not $BookingId) {
  Write-Host 'Provide -BookingCode or -BookingId' -ForegroundColor Red
  exit 1
}

function Get-BookingState {
  param([string]$Id)
  $sql = 'SELECT status, payment_status, send_confirmation, confirmation_sent_at IS NOT NULL AS confirmation_sent FROM bookings WHERE id = ''' + $Id + ''';'
  $raw = docker exec wolfhouse-postgres psql -U wolfhouse -d wolfhouse -t -A -F '|' -c $sql 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $raw) { return $null }
  $parts = $raw.Trim() -split '\|'
  if ($parts.Count -lt 4) { return $null }
  return [pscustomobject]@{
    status = $parts[0].Trim()
    payment_status = $parts[1].Trim()
    send_confirmation = $parts[2].Trim()
    confirmation_sent = $parts[3].Trim()
  }
}

function Show-BookingRow {
  param([string]$Id)
  $sql = 'SELECT booking_code, status, payment_status, send_confirmation, confirmation_sent_at IS NOT NULL AS confirmation_sent FROM bookings WHERE id = ''' + $Id + ''';'
  docker exec wolfhouse-postgres psql -U wolfhouse -d wolfhouse -c $sql
}

if ($BookingCode -and -not $BookingId) {
  $idSql = 'SELECT id FROM bookings WHERE booking_code = ''' + $BookingCode + ''' LIMIT 1;'
  $BookingId = (docker exec wolfhouse-postgres psql -U wolfhouse -d wolfhouse -t -A -c $idSql).Trim()
  if (-not $BookingId) {
    Write-Host ('No Postgres row for booking_code ' + $BookingCode) -ForegroundColor Red
    exit 1
  }
}

Write-Host ('Booking UUID: ' + $BookingId)
Write-Host ''
Write-Host '1. BEFORE state...'
Show-BookingRow -Id $BookingId
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host ''
Write-Host '2. Trigger send-confirmation-local webhook...'
$body = @{ booking_id = $BookingId } | ConvertTo-Json

try {
  Invoke-RestMethod -Method POST -Uri $WebhookUrl -ContentType 'application/json' -Body $body | Out-Null
  Write-Host 'Webhook accepted (workflow runs async in n8n).' -ForegroundColor Green
} catch {
  Write-Host 'Webhook call failed:' -ForegroundColor Yellow
  Write-Host $_.Exception.Message
}

Write-Host ''
Write-Host ('3. Polling for confirmed state (up to ' + $MaxWaitSeconds + 's, every ' + $PollIntervalSeconds + 's)...')

$deadline = (Get-Date).AddSeconds($MaxWaitSeconds)
$confirmed = $false

while ((Get-Date) -lt $deadline) {
  $state = Get-BookingState -Id $BookingId
  if ($state) {
    $isConfirmed = (
      $state.status -eq 'confirmed' -and
      $state.send_confirmation -eq 'f' -and
      $state.confirmation_sent -eq 't'
    )
    if ($isConfirmed) {
      $confirmed = $true
      break
    }
    Write-Host ('  still pending: status=' + $state.status + ' send_confirmation=' + $state.send_confirmation + ' confirmation_sent=' + $state.confirmation_sent)
  }
  Start-Sleep -Seconds $PollIntervalSeconds
}

Write-Host ''
if ($confirmed) {
  Write-Host 'OK: booking confirmed in Postgres.' -ForegroundColor Green
} else {
  Write-Host ('Timeout after ' + $MaxWaitSeconds + 's - workflow may still be running. Check n8n execution log.') -ForegroundColor Yellow
}

Write-Host ''
Write-Host '4. AFTER state...'
Show-BookingRow -Id $BookingId

Write-Host ''
if ($confirmed) {
  Write-Host 'Expected: status=confirmed, send_confirmation=false, confirmation_sent=true'
  exit 0
}

Write-Host 'Expected after success: status=confirmed, send_confirmation=false, confirmation_sent=true'
Write-Host 'Open n8n: Wolfhouse - Send Confirmation (local)'
exit 1
