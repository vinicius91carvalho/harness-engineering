# Native Windows installer for Claude Code, Codex, and OpenCode.
[CmdletBinding()]
param(
  [switch]$Yes,
  [switch]$No,
  [switch]$DryRun,
  [ValidateSet("claude", "codex", "opencode", "all")][string]$Cli,
  [ValidateSet("user", "project", "local")][string]$Scope = "user"
)
$ErrorActionPreference = "Stop"

$MarketplaceRepo = "vinicius91carvalho/harness-engineering"
$ClaudeMarketplace = "vinicius91carvalho"
$CodexMarketplace = "harness-engineering"
$MemoryInstaller = "https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.ps1"
$Optional = @("ponytail", "remember", "context7", "skill-creator", "claude-md-management", "claude-code-setup", "hookify", "playwright", "typescript-lsp", "ralph-loop", "pyright-lsp", "rust-analyzer-lsp", "codex", "codebase-memory-mcp", "status-line", "shared-config", "mcp-servers")
$PluginClis = @{
  harness = @("claude", "codex", "opencode")
  ponytail = @("claude", "codex", "opencode")
  remember = @("claude")
  context7 = @("claude"); "skill-creator" = @("claude"); "claude-md-management" = @("claude")
  "claude-code-setup" = @("claude"); hookify = @("claude"); playwright = @("claude")
  "typescript-lsp" = @("claude"); "ralph-loop" = @("claude"); "pyright-lsp" = @("claude")
  "rust-analyzer-lsp" = @("claude"); codex = @("claude")
  "codebase-memory-mcp" = @("claude", "codex", "opencode")
  "status-line" = @("claude"); "shared-config" = @("claude"); "mcp-servers" = @("claude")
}

if ($Yes -and $No) { throw "-Yes and -No are mutually exclusive" }
$Detected = @("claude", "codex", "opencode") | Where-Object { Get-Command $_ -ErrorAction SilentlyContinue }
if ($Detected.Count -eq 0) { throw "No supported CLI found. Install Claude Code, Codex, or OpenCode." }

function Select-Host {
  if ($Cli) {
    if ($Cli -eq "all") { return $Detected }
    if ($Detected -notcontains $Cli) { throw "Requested CLI is not installed: $Cli" }
    return @($Cli)
  }
  if ($Detected.Count -eq 1) { return @($Detected[0]) }
  if ([Console]::IsInputRedirected) { throw "Multiple CLIs detected; pass -Cli claude|codex|opencode|all." }
  $cursor = 0; $choices = @($Detected) + "all"
  while ($true) {
    Write-Host "`nSelect target host (numbers, arrows, Enter):"
    for ($i = 0; $i -lt $choices.Count; $i++) {
      $prefix = if ($i -eq $cursor) { ">" } else { " " }
      Write-Host " $prefix $($i + 1)) $($choices[$i])"
    }
    $key = [Console]::ReadKey($true)
    if ($key.Key -eq "UpArrow" -and $cursor -gt 0) { $cursor--; continue }
    if ($key.Key -eq "DownArrow" -and $cursor -lt $choices.Count - 1) { $cursor++; continue }
    if ($key.Key -eq "Enter") { break }
    $number = 0
    if ([int]::TryParse([string]$key.KeyChar, [ref]$number) -and $number -ge 1 -and $number -le $choices.Count) { $cursor = $number - 1; break }
    if ($key.Key -eq "Escape") { throw "Cancelled" }
    [Console]::Beep()
  }
  if ($choices[$cursor] -eq "all") { return $Detected }
  return @($choices[$cursor])
}

$Targets = @(Select-Host)
if ($PSBoundParameters.ContainsKey("Scope") -and ($Targets.Count -ne 1 -or $Targets[0] -ne "claude")) {
  throw "-Scope is only valid when Claude is the sole selected host."
}

function Invoke-Native([string]$Exe, [string[]]$Arguments) {
  if ($DryRun) { Write-Host "DRY RUN - $Exe $($Arguments -join ' ')"; return }
  & $Exe @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Exe failed with exit code $LASTEXITCODE" }
}

$script:StagedRepo = $null
function Get-Repository {
  if ($script:StagedRepo) { return $script:StagedRepo }
  if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot ".claude-plugin/marketplace.json"))) {
    $script:StagedRepo = $PSScriptRoot
    return $script:StagedRepo
  }
  if ($DryRun) { return "<staged harness repository>" }
  $script:StagedRepo = Join-Path ([IO.Path]::GetTempPath()) ("harness-installer-" + [guid]::NewGuid())
  Invoke-Native git @("clone", "--depth", "1", "https://github.com/$MarketplaceRepo.git", $script:StagedRepo)
  return $script:StagedRepo
}

function Install-OpenCodePlugin([string]$Name) {
  if ($DryRun) { Write-Host "DRY RUN - install namespaced OpenCode skills, agents, and commands for $Name"; return }
  $source = Get-Repository
  if ($Name -eq "ponytail") {
    $source = Join-Path ([IO.Path]::GetTempPath()) ("ponytail-" + [guid]::NewGuid())
    Invoke-Native git @("clone", "--depth", "1", "https://github.com/DietrichGebert/ponytail.git", $source)
  }
  $base = Join-Path $HOME ".config/opencode"
  @("skills", "agents", "commands") | ForEach-Object { New-Item -ItemType Directory -Force (Join-Path $base $_) | Out-Null }
  Get-ChildItem (Join-Path $source "skills") -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $base "skills/$Name-$($_.Name)") -Recurse -Force
  }
  Get-ChildItem (Join-Path $source "agents/*.md") -ErrorAction SilentlyContinue | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $base "agents/$Name-$($_.Name)") -Force
  }
  Get-ChildItem (Join-Path $source "commands/*.md") -ErrorAction SilentlyContinue | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $base "commands/$Name-$($_.Name)") -Force
  }
  if ($Name -eq "harness") {
    Get-ChildItem (Join-Path $source "skills/*/SKILL.md") -ErrorAction SilentlyContinue | ForEach-Object {
      Copy-Item $_.FullName (Join-Path $base "commands/harness-$($_.Directory.Name).md") -Force
    }
  }
}

function Set-OpenCodeMemory([string]$Binary) {
  $base = Join-Path $HOME ".config/opencode"; $config = Join-Path $base "opencode.json"
  New-Item -ItemType Directory -Force $base | Out-Null
  $jsonc = Join-Path $base "opencode.jsonc"; if (Test-Path $jsonc) { $config = $jsonc }
  if (-not (Test-Path $config)) { "{}" | Set-Content $config -Encoding utf8 }
  Copy-Item $config "$config.pre-harness.bak" -Force
  $raw = Get-Content $config -Raw
  if ($config.EndsWith(".jsonc")) {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js is required to safely normalize existing OpenCode JSONC" }
    $normalizer = Join-Path (Get-Repository) "scripts/jsonc-normalize.js"
    $normalized = $raw | & node $normalizer
    if ($LASTEXITCODE -ne 0) { throw "Invalid OpenCode JSONC; backup retained at $config.pre-harness.bak" }
  } else { $normalized = $raw }
  $json = $normalized | ConvertFrom-Json
  if (-not $json.mcp) { $json | Add-Member -Force NoteProperty mcp ([pscustomobject]@{}) }
  $json.mcp | Add-Member -Force NoteProperty "codebase-memory-mcp" ([pscustomobject]@{ type="local"; command=@($Binary); enabled=$true })
  $temp = "$config.$PID.tmp"
  $json | ConvertTo-Json -Depth 20 | Set-Content $temp -Encoding utf8
  Move-Item $temp $config -Force
}

function Write-ClaudeSettings([scriptblock]$Update) {
  $dir = Join-Path $HOME ".claude"; $config = Join-Path $dir "settings.json"
  New-Item -ItemType Directory -Force $dir | Out-Null
  if (-not (Test-Path $config)) { "{}" | Set-Content $config -Encoding utf8 }
  Copy-Item $config "$config.pre-harness.bak" -Force
  $json = Get-Content $config -Raw | ConvertFrom-Json
  & $Update $json
  $temp = "$config.$PID.tmp"
  $json | ConvertTo-Json -Depth 20 | Set-Content $temp -Encoding utf8
  Move-Item $temp $config -Force
}

function Enable-ClaudeStatusLine {
  if ($DryRun) { Write-Host "DRY RUN - atomically enable the Claude status line"; return }
  $repo = Get-Repository; $script = Join-Path $repo "scripts/statusline.sh"
  if (-not (Test-Path $script)) { throw "Bundled statusline.sh is missing" }
  Write-ClaudeSettings { param($json) $json | Add-Member -Force NoteProperty statusLine ([pscustomobject]@{ type="command"; command="bash $script" }) }
}

function Apply-ClaudeSharedConfig {
  if ($DryRun) { Write-Host "DRY RUN - atomically merge Claude shared config"; return }
  $shared = Get-Content (Join-Path (Get-Repository) "config/settings.json") -Raw | ConvertFrom-Json
  Write-ClaudeSettings { param($json) foreach ($property in $shared.PSObject.Properties) { $json | Add-Member -Force NoteProperty $property.Name $property.Value } }
}

function Install-ClaudeMcpInventory {
  if ($DryRun) { Write-Host "DRY RUN - prompt for and configure Claude MCP inventory"; return }
  if ([Console]::IsInputRedirected) { Write-Warning "MCP inventory requires a console for secret prompts; skipped"; return }
  $path = Join-Path (Get-Repository) "config/mcp.json"
  if (-not (Test-Path $path)) { Write-Host "No MCP inventory found"; return }
  $servers = (Get-Content $path -Raw | ConvertFrom-Json).mcpServers
  foreach ($property in $servers.PSObject.Properties) {
    if ((Read-Host "Configure Claude MCP server $($property.Name)? [y/N]") -notmatch '^(y|yes)$') { continue }
    $json = $property.Value | ConvertTo-Json -Depth 20 -Compress
    $skip = $false
    foreach ($match in [regex]::Matches($json, '\$\{([A-Za-z0-9_]+)\}')) {
      $secret = Read-Host "Value for $($match.Groups[1].Value) (Enter skips server)" -AsSecureString
      $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret))
      if (-not $value) { $skip = $true; break }
      $json = $json.Replace($match.Value, $value)
    }
    if (-not $skip) { Invoke-Native claude @("mcp", "add-json", "--scope", "user", $property.Name, $json) }
  }
}

function Install-Memory {
  if ($DryRun) {
    Write-Host "DRY RUN - download signed codebase-memory-mcp binary with --skip-config"
    $Targets | ForEach-Object { Write-Host "DRY RUN - configure codebase-memory-mcp for $_" }
    return
  }
  $binary = Get-Command codebase-memory-mcp -ErrorAction SilentlyContinue
  if (-not $binary) {
    $installer = Join-Path ([IO.Path]::GetTempPath()) "codebase-memory-install-$PID.ps1"
    try { Invoke-WebRequest $MemoryInstaller -OutFile $installer } catch { throw "codebase-memory-mcp download failed: $_" }
    & $installer --skip-config
    if ($LASTEXITCODE -ne 0) { throw "codebase-memory-mcp installer failed" }
    $binary = Get-Command codebase-memory-mcp -ErrorAction SilentlyContinue
  }
  if (-not $binary) { throw "codebase-memory-mcp binary was not found after installation; add it to PATH and retry" }
  foreach ($target in $Targets) {
    switch ($target) {
      claude { Invoke-Native claude @("mcp", "add-json", "--scope", "user", "codebase-memory-mcp", "{`"command`":`"$($binary.Source)`",`"args`":[]}") }
      codex { Invoke-Native codex @("mcp", "add", "codebase-memory-mcp", "--", $binary.Source) }
      opencode { Set-OpenCodeMemory $binary.Source }
    }
  }
}

$Selected = if ($No) { @("harness") } elseif ($Yes) { @("harness") + $Optional } else { @("harness") }

foreach ($target in $Targets) {
  if ($target -eq "claude") {
    if ($DryRun) { Invoke-Native claude @("plugin", "marketplace", "update", $ClaudeMarketplace) }
    else {
      & claude plugin marketplace update $ClaudeMarketplace
      if ($LASTEXITCODE -ne 0) { Invoke-Native claude @("plugin", "marketplace", "add", $MarketplaceRepo) }
    }
  }
  if ($target -eq "codex") {
    if ($DryRun) { Invoke-Native codex @("plugin", "marketplace", "upgrade", $CodexMarketplace) }
    else {
      & codex plugin marketplace upgrade $CodexMarketplace
      if ($LASTEXITCODE -ne 0) { Invoke-Native codex @("plugin", "marketplace", "add", $MarketplaceRepo) }
    }
  }
}

foreach ($item in $Selected) {
  if ($item -eq "codebase-memory-mcp") { Install-Memory; continue }
  if ($item -eq "status-line") { Enable-ClaudeStatusLine; continue }
  if ($item -eq "shared-config") { Apply-ClaudeSharedConfig; continue }
  if ($item -eq "mcp-servers") { Install-ClaudeMcpInventory; continue }
  foreach ($target in $Targets) {
    if ($PluginClis[$item] -notcontains $target) { continue }
    switch ($target) {
      claude { Invoke-Native claude @("plugin", "install", "$item@$ClaudeMarketplace", "--scope", $Scope) }
      codex { Invoke-Native codex @("plugin", "add", "$item@$CodexMarketplace") }
      opencode { Install-OpenCodePlugin $item }
    }
  }
}

Write-Host "Harness installation complete for: $($Targets -join ', ')"
