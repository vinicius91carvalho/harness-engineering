# Install the full harness workspace into a fresh Claude Code setup (native Windows).
# Usage: irm https://raw.githubusercontent.com/vinicius91carvalho/harness-engineering/main/install.ps1 | iex
# -Yes selects every item, -No keeps required only (non-interactive runs).
# -DryRun walks the checklist and prints what would be installed, changing nothing.
param([switch]$Yes, [switch]$No, [switch]$DryRun)
$ErrorActionPreference = "Stop"

# Arrow-key checkbox multi-select. $items is an array of objects with Type, Key,
# Label, Checked. Required rows start checked; every row is toggleable. Returns
# the Keys of checked rows. Falls back to defaults when input is redirected or
# -Yes/-No is set (-Yes checks everything).
function Select-Menu([object[]]$items) {
  if ($Yes) { foreach ($it in $items) { $it.Checked = $true } }
  if ($Yes -or $No -or [Console]::IsInputRedirected) {
    return ($items | Where-Object { $_.Checked } | ForEach-Object { $_.Key })
  }
  $cursor = 0
  function Draw {
    for ($i = 0; $i -lt $items.Count; $i++) {
      $box = if ($items[$i].Checked) { "[x]" } else { "[ ]" }
      if ($i -eq $cursor) { Write-Host "> $box $($items[$i].Label)" -ForegroundColor Cyan }
      else                { Write-Host "  $box $($items[$i].Label)" }
    }
  }
  Write-Host ""
  Write-Host "Select with Up/Down, toggle with SPACE, confirm with ENTER:" -ForegroundColor Cyan
  Write-Host ""
  Draw
  $done = $false
  while (-not $done) {
    $k = [Console]::ReadKey($true)
    switch ($k.Key) {
      "UpArrow"   { if ($cursor -gt 0) { $cursor-- } }
      "DownArrow" { if ($cursor -lt $items.Count - 1) { $cursor++ } }
      "Spacebar"  { $items[$cursor].Checked = -not $items[$cursor].Checked }
      "Enter"     { $done = $true }
    }
    [Console]::SetCursorPosition(0, [Console]::CursorTop - $items.Count)
    Draw
  }
  Write-Host ""
  return ($items | Where-Object { $_.Checked } | ForEach-Object { $_.Key })
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
  if ($DryRun) { Write-Host "   DRY RUN - would install: $name"; return }
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
if (-not $DryRun) { try { claude plugin marketplace add $Marketplace } catch { claude plugin marketplace update $MarketplaceName } }

# Build the checklist: required plugins (pre-checked), optional plugins, then the
# two extras. Every row is toggleable — requireds are only checked by default.
$items = @()
foreach ($p in $Required) { $items += [pscustomobject]@{ Type = "plugin"; Key = $p; Label = "$p (required)"; Checked = $true } }
foreach ($p in $Optional) { $items += [pscustomobject]@{ Type = "plugin"; Key = $p; Label = $p; Checked = $false } }
$items += [pscustomobject]@{ Type = "extra"; Key = "statusline";   Label = "status line - context %, rate limits, git, tmux"; Checked = $false }
$items += [pscustomobject]@{ Type = "extra"; Key = "sharedconfig"; Label = "shared config - model, notifications, Remote Control"; Checked = $false }

$selected = Select-Menu $items

foreach ($sel in $selected) {
  switch ($sel) {
    "statusline"   { if ($DryRun) { Write-Host "   DRY RUN - would enable: status line" } else { Enable-StatusLine } }
    "sharedconfig" { if ($DryRun) { Write-Host "   DRY RUN - would apply: shared config" } else { Apply-Config; Restore-Home } }
    default        { Install-Plugin $sel }
  }
}

if (-not $selected) { Write-Host "==> Nothing selected." }
Write-Host "==> Done. Restart Claude Code to load everything."
