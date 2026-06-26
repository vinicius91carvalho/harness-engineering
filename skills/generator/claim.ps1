param(
  [ValidateSet("lock-acquire", "lock-release")][string]$Action,
  [Parameter(Mandatory=$true)][string]$Repo,
  [string]$Name = "generator-state",
  [int]$TimeoutSeconds = 30
)
$ErrorActionPreference = "Stop"
$gitDir = (& git -C $Repo rev-parse --path-format=absolute --git-common-dir).Trim()
if ($LASTEXITCODE -ne 0) { throw "Not a git repository: $Repo" }
$lock = Join-Path $gitDir "$Name.lock.d"

if ($Action -eq "lock-release") {
  Remove-Item (Join-Path $lock "owner") -Force -ErrorAction SilentlyContinue
  Remove-Item $lock -Force -ErrorAction SilentlyContinue
  Write-Output "released"
  exit 0
}

$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
while ($true) {
  try {
    New-Item -ItemType Directory -Path $lock -ErrorAction Stop | Out-Null
    Set-Content (Join-Path $lock "owner") $PID -NoNewline
    Write-Output $lock
    exit 0
  } catch {
    $ownerFile = Join-Path $lock "owner"
    $owner = if (Test-Path $ownerFile) { Get-Content $ownerFile -Raw } else { $null }
    if ($owner -and -not (Get-Process -Id $owner -ErrorAction SilentlyContinue)) {
      Remove-Item $ownerFile -Force -ErrorAction SilentlyContinue
      Remove-Item $lock -Force -ErrorAction SilentlyContinue
      continue
    }
    if ([DateTime]::UtcNow -ge $deadline) { throw "Timed out waiting for lock: $lock" }
    Start-Sleep -Milliseconds 100
  }
}
