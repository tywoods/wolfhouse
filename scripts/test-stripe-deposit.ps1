# Create a Stripe Checkout session (deposit_only) via local n8n Phase 2b workflow.
# Usage: .\scripts\test-stripe-deposit.ps1 -BookingId "uuid-here"
param(
  [Parameter(Mandatory = $true)]
  [string]$BookingId,
  [string]$PaymentKind = "deposit_only",
  [string]$WebhookUrl = "http://localhost:5678/webhook/create-payment-session"
)

$body = @{
  booking_id   = $BookingId
  payment_kind = $PaymentKind
} | ConvertTo-Json

Write-Host "POST $WebhookUrl"
Write-Host "Body: $body"

try {
  $resp = Invoke-RestMethod -Method POST -Uri $WebhookUrl -ContentType "application/json" -Body $body
  $resp | ConvertTo-Json -Depth 6
  if ($resp.checkout_url) {
    Write-Host ""
    Write-Host "Open checkout URL in browser:" -ForegroundColor Green
    Write-Host $resp.checkout_url
  }
} catch {
  Write-Host "Request failed:" -ForegroundColor Red
  Write-Host $_.Exception.Message
  if ($_.ErrorDetails.Message) {
    Write-Host $_.ErrorDetails.Message
  }
  exit 1
}
