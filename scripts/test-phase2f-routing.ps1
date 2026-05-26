# Phase 2f — routing tests (resolver unit tests + optional Main test webhook).
# Usage:
#   .\scripts\test-phase2f-routing.ps1
#   .\scripts\test-phase2f-routing.ps1 -RunResolverOnly
param(
  [switch]$RunResolverOnly
)

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host '=== Phase 2f: Booking State Resolver unit tests ===' -ForegroundColor Cyan
node scripts/test-booking-state-resolver.js
if ($LASTEXITCODE -ne 0) { exit 1 }

if ($RunResolverOnly) {
  Write-Host ''
  Write-Host 'Resolver tests passed (RunResolverOnly).' -ForegroundColor Green
  exit 0
}

Write-Host ''
Write-Host '=== Rebuild Main (local Stripe) fork ===' -ForegroundColor Cyan
node scripts/build-main-local-stripe.js
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host ''
Write-Host 'Fork regenerated. Import into local n8n and run Main test webhook for E2E.' -ForegroundColor Green
Write-Host 'See docs/PHASE-2f.md for Jamy-style acceptance message.'
