# Install the full harness workspace into a fresh Claude Code setup (native Windows).
# Usage: irm https://raw.githubusercontent.com/vinicius91carvalho/harness-engineering/master/install.ps1 | iex
$ErrorActionPreference = "Stop"

$Marketplace     = "vinicius91carvalho/harness-engineering"
$MarketplaceName = "vinicius91carvalho"
$Required        = @("harness", "ponytail")   # always installed
$Optional        = @("last30days")            # prompted for, one by one

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Write-Error "Claude Code CLI not found. Install it first: https://claude.com/claude-code"
  exit 1
}

function Install-Plugin($name) {
  Write-Host "==> Installing: $name@$MarketplaceName"
  try { claude plugin install "$name@$MarketplaceName" } catch { Write-Warning "skipped $name - already installed or failed" }
}

# Point ~/.claude/settings.json at the bundled status line. Idempotent.
function Enable-StatusLine {
  $script = Get-ChildItem (Join-Path $HOME ".claude\plugins\cache\*\harness\*\scripts\statusline.sh") -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $script) { Write-Warning "statusline.sh not found - is the harness plugin installed?"; return }
  $settings = Join-Path $HOME ".claude\settings.json"
  New-Item -ItemType Directory -Force -Path (Split-Path $settings) | Out-Null
  $cfg = if (Test-Path $settings) { Get-Content $settings -Raw | ConvertFrom-Json } else { [PSCustomObject]@{} }
  $cfg | Add-Member -Force -NotePropertyName statusLine -NotePropertyValue ([PSCustomObject]@{ type = "command"; command = "bash $($script.FullName)" })
  $cfg | ConvertTo-Json -Depth 10 | Set-Content $settings
  Write-Host "==> Status line enabled in $settings"
}

# Set remoteControlAtStartup so Remote Control connects for every session. Idempotent.
function Enable-RemoteControl {
  $settings = Join-Path $HOME ".claude\settings.json"
  New-Item -ItemType Directory -Force -Path (Split-Path $settings) | Out-Null
  $cfg = if (Test-Path $settings) { Get-Content $settings -Raw | ConvertFrom-Json } else { [PSCustomObject]@{} }
  $cfg | Add-Member -Force -NotePropertyName remoteControlAtStartup -NotePropertyValue $true
  $cfg | ConvertTo-Json -Depth 10 | Set-Content $settings
  Write-Host "==> Remote Control enabled for all sessions in $settings"
}

Write-Host "==> Adding marketplace: $Marketplace"
try { claude plugin marketplace add $Marketplace } catch { claude plugin marketplace update $MarketplaceName }

foreach ($p in $Required) { Install-Plugin $p }

$ans = Read-Host "Enable the harness status line (context %, rate limits, git, tmux)? [y/N]"
if ($ans -match '^[yY]') { Enable-StatusLine }

$ans = Read-Host "Enable Remote Control for all sessions (control sessions from the mobile/web app)? [y/N]"
if ($ans -match '^[yY]') { Enable-RemoteControl }

foreach ($p in $Optional) {
  $ans = Read-Host "Install optional plugin '$p'? [y/N]"
  if ($ans -match '^[yY]') { Install-Plugin $p } else { Write-Host "==> Skipping optional: $p" }
}

Write-Host "==> Done. Restart Claude Code to load everything."
