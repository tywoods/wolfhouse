# Stage 7.3e Azure proof - manual login test
# Run in your terminal:
#   $env:STAFF_PW = "your-password"
#   .\scripts\test-azure-login-proof.ps1

param(
  [string]$Email = "ty@wolfhouse.io",
  [string]$Client = "wolfhouse-somo"
)

$base = "https://wh-staging-staff-api.braveplant-5c685569.northeurope.azurecontainerapps.io"

if (-not $env:STAFF_PW) {
  $pwSec = Read-Host -AsSecureString "Ty password"
  $pw = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($pwSec))
} else {
  $pw = $env:STAFF_PW
}

$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession

Write-Host "`n--- POST /staff/auth/login ---"
$body = @{ client=$Client; email=$Email; password=$pw } | ConvertTo-Json
$r = Invoke-WebRequest -Uri "$base/staff/auth/login" -Method POST -Body $body -ContentType "application/json" -WebSession $session -UseBasicParsing
Write-Host "Status: $($r.StatusCode)"
$d = $r.Content | ConvertFrom-Json
Write-Host "success: $($d.success), role: $($d.user.role), client: $($d.user.client_slug)"
Write-Host "Cookie count: $($session.Cookies.Count)"

Write-Host "`n--- GET /staff/ui (authenticated) ---"
$r2 = Invoke-WebRequest -Uri "$base/staff/ui" -UseBasicParsing -WebSession $session
Write-Host "Status: $($r2.StatusCode)"
Write-Host "Contains Luna Front Desk: $($r2.Content.Contains('Luna Front Desk'))"
Write-Host "Contains Sign out: $($r2.Content.Contains('Sign out'))"

Write-Host "`n--- GET /staff/intents (authenticated) ---"
$r3 = Invoke-WebRequest -Uri "$base/staff/intents" -UseBasicParsing -WebSession $session -Headers @{Accept="application/json"}
Write-Host "Status: $($r3.StatusCode)"
$d3 = $r3.Content | ConvertFrom-Json
Write-Host "total: $($d3.total), success: $($d3.success)"

Write-Host "`n--- POST /staff/auth/logout ---"
$r4 = Invoke-WebRequest -Uri "$base/staff/auth/logout" -Method POST -UseBasicParsing -WebSession $session
Write-Host "Status: $($r4.StatusCode)"
$d4 = $r4.Content | ConvertFrom-Json
Write-Host "success: $($d4.success)"

Write-Host "`nAzure login proof DONE"
