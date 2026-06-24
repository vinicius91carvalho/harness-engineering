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
$Required        = @("harness", "ponytail", "context7", "remember", "skill-creator", "claude-md-management", "claude-code-setup", "hookify", "playwright")   # always installed
$Optional        = @("last30days", "typescript-lsp", "ralph-loop", "pyright-lsp", "rust-analyzer-lsp", "codex")   # prompted for, one by one

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

# Ensure jq is available, installing via winget/choco/scoop if missing.
function Ensure-Jq {
  if (Get-Command jq -ErrorAction SilentlyContinue) { return $true }
  Write-Host "==> jq not found - attempting to install it"
  if     (Get-Command winget -ErrorAction SilentlyContinue) { winget install --id jqlang.jq -e --silent }
  elseif (Get-Command choco  -ErrorAction SilentlyContinue) { choco install jq -y }
  elseif (Get-Command scoop  -ErrorAction SilentlyContinue) { scoop install jq }
  else { Write-Warning "no supported package manager - install jq by hand"; return $false }
  [bool](Get-Command jq -ErrorAction SilentlyContinue)
}

# Merge the bundled shareable config into ~/.claude/settings.json (the file's keys win).
# Warns and continues on any failure.
function Apply-Config {
  try {
    $cfgFile = Get-ChildItem (Join-Path $HOME ".claude\plugins\cache\*\harness\*\config\settings.json") -ErrorAction SilentlyContinue |
               Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $cfgFile) { Write-Warning "shared config not found - is the harness plugin installed?"; return }
    $settings = Join-Path $HOME ".claude\settings.json"
    New-Item -ItemType Directory -Force -Path (Split-Path $settings) | Out-Null
    $cfg = if (Test-Path $settings) { Get-Content $settings -Raw | ConvertFrom-Json } else { [PSCustomObject]@{} }
    $shared = Get-Content $cfgFile.FullName -Raw | ConvertFrom-Json
    foreach ($p in $shared.PSObject.Properties) { $cfg | Add-Member -Force -NotePropertyName $p.Name -NotePropertyValue $p.Value }
    $cfg | ConvertTo-Json -Depth 10 | Set-Content $settings
    Write-Host "==> Shared config merged into $settings"
  } catch { Write-Warning "could not apply shared config: $_" }
}

# Restore loose user content (skills/commands/agents/hooks, keybindings.json,
# global CLAUDE.md) that /harness:update-project backed up into config/home/.
# A no-op when nothing was backed up. Existing files are overwritten.
function Restore-Home {
  $src = Get-ChildItem (Join-Path $HOME ".claude\plugins\cache\*\harness\*\config\home") -Directory -ErrorAction SilentlyContinue |
         Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $src -or -not (Get-ChildItem $src.FullName -Force -ErrorAction SilentlyContinue)) { return }
  Copy-Item (Join-Path $src.FullName "*") (Join-Path $HOME ".claude") -Recurse -Force
  Write-Host "==> Restored backed-up user content into $(Join-Path $HOME '.claude')"
}

Write-Host "==> Adding marketplace: $Marketplace"
try { claude plugin marketplace add $Marketplace } catch { claude plugin marketplace update $MarketplaceName }

foreach ($p in $Required) { Install-Plugin $p }

if (Ask "Enable the harness status line (context %, rate limits, git, tmux)?") { Enable-StatusLine }

if (Ask "Apply Vinicius's shared Claude config (model, notifications, Remote Control on startup)?") { Apply-Config; Restore-Home }

foreach ($p in $Optional) {
  if (Ask "Install optional plugin '$p'?") { Install-Plugin $p } else { Write-Host "==> Skipping optional: $p" }
}

Write-Host "==> Done. Restart Claude Code to load everything."
