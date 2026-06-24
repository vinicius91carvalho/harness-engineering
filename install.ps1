# Install the full harness workspace into a fresh Claude Code setup (native Windows).
# Usage: irm https://raw.githubusercontent.com/vinicius91carvalho/harness-engineering/main/install.ps1 | iex
# -Yes answers yes to every prompt, -No answers no (for non-interactive runs).
param([switch]$Yes, [switch]$No)
$ErrorActionPreference = "Stop"

# Ask a yes/no question. -Yes/-No short-circuit the prompt.
function Ask($question) {
  if ($Yes) { return $true }
  if ($No)  { return $false }
  return (Read-Host "$question [y/N]") -match '^[yY]'
}

$Marketplace     = "vinicius91carvalho/harness-engineering"
$MarketplaceName = "vinicius91carvalho"
$Required        = @("harness", "ponytail")   # always installed
$Optional        = @("last30days", "remember", "context7", "skill-creator", "playwright", "claude-md-management", "typescript-lsp", "ralph-loop", "claude-code-setup", "pyright-lsp", "hookify", "rust-analyzer-lsp")   # prompted for, one by one

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

if (Ask "Enable the harness status line (context %, rate limits, git, tmux)?") { Enable-StatusLine }

if (Ask "Enable Remote Control for all sessions (control sessions from the mobile/web app)?") { Enable-RemoteControl }

foreach ($p in $Optional) {
  if (Ask "Install optional plugin '$p'?") { Install-Plugin $p } else { Write-Host "==> Skipping optional: $p" }
}

Write-Host "==> Done. Restart Claude Code to load everything."
