# Install the full harness workspace into a fresh Claude Code, Opencode, or Codex setup (native Windows).
# Usage: irm https://raw.githubusercontent.com/vinicius91carvalho/harness-engineering/main/install.ps1 | iex
# -Yes selects every item, -No keeps required only (non-interactive runs).
# -DryRun walks the checklist and prints what would be installed, changing nothing.
param([switch]$Yes, [switch]$No, [switch]$DryRun)
$ErrorActionPreference = "Stop"

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
$Required        = @("harness", "ponytail", "context7", "remember", "skill-creator", "claude-md-management", "claude-code-setup", "hookify", "playwright")
$Optional        = @("typescript-lsp", "ralph-loop", "pyright-lsp", "rust-analyzer-lsp", "codex")

# Detect available CLIs
$CLI = $null
if (Get-Command claude -ErrorAction SilentlyContinue) { $CLI = "claude" }
if (Get-Command codex -ErrorAction SilentlyContinue)  { $CLI = "codex" }
if (Get-Command opencode -ErrorAction SilentlyContinue) { $CLI = "opencode" }

if (-not $CLI) {
  Write-Error "No supported CLI found. Install one of: Claude Code, Opencode, or Codex."
  Write-Host "  Claude Code:  https://claude.com/claude-code"
  Write-Host "  Opencode:     https://opencode.ai"
  Write-Host "  Codex:        https://github.com/openai/codex"
  exit 1
}

Write-Host "==> Detected CLI: $CLI"

function Install-Plugin($name) {
  if ($DryRun) { Write-Host "   DRY RUN - would install: $name"; return }
  switch ($CLI) {
    "claude" {
      Write-Host "==> Installing: $name@$MarketplaceName"
      try { claude plugin install "$name@$MarketplaceName" } catch { Write-Warning "skipped $name - already installed or failed" }
    }
    "codex" {
      Write-Host "==> Codex: $name (ensure .codex-plugin/plugin.json is present)"
    }
    "opencode" {
      Write-Host "==> Opencode: $name (ensure opencode.json references this plugin)"
    }
  }
}

function Enable-StatusLine {
  if ($CLI -eq "claude") {
    $script = Get-ChildItem (Join-Path $HOME ".claude\plugins\cache\*\harness\*\scripts\statusline.sh") -ErrorAction SilentlyContinue |
              Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $script) { Write-Warning "statusline.sh not found - is the harness plugin installed?"; return }
    $settings = Join-Path $HOME ".claude\settings.json"
    New-Item -ItemType Directory -Force -Path (Split-Path $settings) | Out-Null
    $cfg = if (Test-Path $settings) { Get-Content $settings -Raw | ConvertFrom-Json } else { [PSCustomObject]@{} }
    $cfg | Add-Member -Force -NotePropertyName statusLine -NotePropertyValue ([PSCustomObject]@{ type = "command"; command = "bash $($script.FullName)" })
    $cfg | ConvertTo-Json -Depth 10 | Set-Content $settings
    Write-Host "==> Status line enabled in $settings"
  } else {
    Write-Host "   (status line: add scripts/statusline.sh path to your CLI config manually)"
  }
}

function Ensure-Jq {
  if (Get-Command jq -ErrorAction SilentlyContinue) { return $true }
  Write-Host "==> jq not found - attempting to install it"
  if     (Get-Command winget -ErrorAction SilentlyContinue) { winget install --id jqlang.jq -e --silent }
  elseif (Get-Command choco  -ErrorAction SilentlyContinue) { choco install jq -y }
  elseif (Get-Command scoop  -ErrorAction SilentlyContinue) { scoop install jq }
  else { Write-Warning "no supported package manager - install jq by hand"; return $false }
  [bool](Get-Command jq -ErrorAction SilentlyContinue)
}

function Apply-Config {
  try {
    if ($CLI -eq "claude") {
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
    } else {
      Write-Host "   (shared config: apply config/settings.json keys to your CLI config manually)"
    }
  } catch { Write-Warning "could not apply shared config: $_" }
}

function Restore-Home {
  if ($CLI -eq "claude") {
    $src = Get-ChildItem (Join-Path $HOME ".claude\plugins\cache\*\harness\*\config\home") -Directory -ErrorAction SilentlyContinue |
           Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $src -or -not (Get-ChildItem $src.FullName -Force -ErrorAction SilentlyContinue)) { return }
    Copy-Item (Join-Path $src.FullName "*") (Join-Path $HOME ".claude") -Recurse -Force
    Write-Host "==> Restored backed-up user content into $(Join-Path $HOME '.claude')"
  }
}

function Install-Mcps {
  if (-not (Ensure-Jq)) { Write-Host "   (jq required - add MCP servers by hand, see README)"; return }
  $cfgFile = Get-ChildItem (Join-Path $HOME ".claude\plugins\cache\*\harness\*\config\mcp.json") -ErrorAction SilentlyContinue |
             Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $cfgFile) { Write-Host "   (no MCP inventory found - nothing to add)"; return }
  $mcp = (Get-Content $cfgFile.FullName -Raw | ConvertFrom-Json).mcpServers
  if (-not $mcp) { Write-Host "   (no MCP servers in inventory)"; return }

  if ($CLI -eq "claude") {
    if ([Console]::IsInputRedirected) { Write-Host "   (no interactive console - skipping MCP setup)"; return }
    foreach ($name in $mcp.PSObject.Properties.Name) {
      $server = $mcp.$name
      $type = if ($server.type) { $server.type } else { "stdio" }
      $ans = Read-Host "`nAdd MCP server `"$name`" ($type)? [y/N]"
      if ($ans -notmatch '^(y|yes)$') { Write-Host "   (skipped $name)"; continue }
      $json = $server | ConvertTo-Json -Depth 10 -Compress
      $phs = [regex]::Matches($json, '\$\{([A-Za-z0-9_]+)\}') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique
      $skip = $false
      foreach ($var in $phs) {
        $sec = Read-Host "  Value for $var (or ENTER to skip $name)" -AsSecureString
        $val = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
        if ([string]::IsNullOrEmpty($val)) { Write-Host "   (skipped $name - no $var provided)"; $skip = $true; break }
        $json = $json.Replace('${' + $var + '}', $val)
      }
      if ($skip) { continue }
      try { claude mcp add-json --scope user $name $json; Write-Host "==> Added MCP server: $name" } catch { Write-Warning "failed to add $name" }
    }
  } else {
    # For opencode/codex, create .mcp.json at project root
    if (-not (Test-Path ".mcp.json")) {
      $mcpObj = @{ mcpServers = $mcp }
      $mcpObj | ConvertTo-Json -Depth 10 | Set-Content ".mcp.json"
      Write-Host "==> Created .mcp.json with MCP server inventory"
    } else {
      Write-Host "   (.mcp.json already exists - merge manually if needed)"
    }
  }
}

# Add marketplace for Claude Code
if ($CLI -eq "claude") {
  Write-Host "==> Adding marketplace: $Marketplace"
  if (-not $DryRun) { try { claude plugin marketplace add $Marketplace } catch { claude plugin marketplace update $MarketplaceName } }
}

$items = @()
foreach ($p in $Required) { $items += [pscustomobject]@{ Type = "plugin"; Key = $p; Label = "$p (required)"; Checked = $true } }
foreach ($p in $Optional) { $items += [pscustomobject]@{ Type = "plugin"; Key = $p; Label = $p; Checked = $false } }
$items += [pscustomobject]@{ Type = "extra"; Key = "statusline";   Label = "status line - context %, rate limits, git, tmux"; Checked = $false }
$items += [pscustomobject]@{ Type = "extra"; Key = "sharedconfig"; Label = "shared config - model, notifications, Remote Control"; Checked = $false }
$items += [pscustomobject]@{ Type = "extra"; Key = "mcpservers";   Label = "MCP servers - pick which, with your API keys"; Checked = $false }

$selected = Select-Menu $items

foreach ($sel in $selected) {
  switch ($sel) {
    "statusline"   { if ($DryRun) { Write-Host "   DRY RUN - would enable: status line" } else { Enable-StatusLine } }
    "sharedconfig" { if ($DryRun) { Write-Host "   DRY RUN - would apply: shared config" } else { Apply-Config; Restore-Home } }
    "mcpservers"   { if ($DryRun) { Write-Host "   DRY RUN - would prompt for MCP servers" } else { Install-Mcps } }
    default        { Install-Plugin $sel }
  }
}

if (-not $selected) { Write-Host "==> Nothing selected." }
Write-Host "==> Done. Restart $CLI to load everything."
