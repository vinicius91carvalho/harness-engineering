# Native Windows installer for Claude Code, Codex, OpenCode, Pi, and Cursor Agent.
[CmdletBinding()]
param(
  [switch]$Yes,
  [switch]$No,
  [switch]$DryRun,
  [string]$Version,
  [ValidateSet("claude", "codex", "opencode", "pi", "agent", "all")][string]$Cli,
  [ValidateSet("user", "project", "local")][string]$Scope = "user"
)
$ErrorActionPreference = "Stop"

$MarketplaceRepo = "vinicius91carvalho/harness-engineering"
$ClaudeMarketplace = "harness-engineering"
$CodexMarketplace = "harness-engineering"
$NoMistakesInstaller = "https://raw.githubusercontent.com/kunchenguid/no-mistakes/main/docs/install.ps1"
$TreehouseInstaller = "https://kunchenguid.github.io/treehouse/install.ps1"
$RepoRoot = if ($PSScriptRoot) { $PSScriptRoot } else { $null }
$DefaultOptional = @("hallmark", "no-mistakes", "treehouse", "skill-creator", "playwright", "crawl4ai", "status-line", "shared-config")
$Optional = $DefaultOptional
if ($RepoRoot -and (Test-Path (Join-Path $RepoRoot "config/installable-catalog.json")) -and (Get-Command node -ErrorAction SilentlyContinue)) {
  $catalogOptional = & node (Join-Path $RepoRoot "scripts/install-reconcile.mjs") optional-ids 2>$null
  if ($LASTEXITCODE -eq 0 -and $catalogOptional) { $Optional = $catalogOptional -split '\s+' }
}
$ReceiptDir = Join-Path $HOME ".local/share/harness"
$PluginClis = @{
  harness = @("claude", "codex", "opencode", "pi", "agent")
  "skill-creator" = @("claude", "codex", "opencode", "pi", "agent")
  hallmark = @("claude", "codex", "opencode", "agent")
  "no-mistakes" = @("claude", "codex", "opencode", "pi", "agent")
  treehouse = @("claude", "codex", "opencode", "agent")
  playwright = @("claude", "codex", "opencode", "agent")
  crawl4ai = @("claude", "codex", "opencode", "pi", "agent")
  "status-line" = @("claude", "codex"); "shared-config" = @("claude")
}

if ($Yes -and $No) { throw "-Yes and -No are mutually exclusive" }
$Node = Get-Command node -ErrorAction SilentlyContinue
if (-not $Node) { throw "Node.js 18 or newer is required." }
$NodeVersion = & node -p "process.versions.node.split('.')[0]"
$NodeMajor = 0
if ($LASTEXITCODE -ne 0 -or -not [int]::TryParse(([string]$NodeVersion).Trim(), [ref]$NodeMajor) -or $NodeMajor -lt 18) {
  throw "Node.js 18 or newer is required."
}

function Test-CliInstalled([string]$Name) {
  if (Get-Command $Name -ErrorAction SilentlyContinue) { return $true }
  if ($Name -ne "opencode" -and $Name -ne "agent") { return $false }
  if ($Name -eq "agent") {
    foreach ($path in @($env:CURSOR_AGENT_BIN, (Join-Path $HOME ".local/bin/agent.exe"), (Join-Path $HOME ".local/bin/agent"), (Join-Path $HOME "bin/agent.exe"), (Join-Path $HOME "bin/agent"))) {
      if ($path -and (Test-Path $path -PathType Leaf)) { return $true }
    }
    return $false
  }
  # The official OpenCode installer writes here before the updated PATH is
  # visible to the current shell. Also honor its documented custom locations.
  $directories = @($env:OPENCODE_INSTALL_DIR, $env:XDG_BIN_DIR, (Join-Path $HOME "bin"), (Join-Path $HOME ".opencode/bin")) |
    Where-Object { $_ }
  foreach ($directory in $directories) {
    foreach ($executable in @("opencode", "opencode.exe")) {
      if (Test-Path (Join-Path $directory $executable) -PathType Leaf) { return $true }
    }
  }
  return $false
}

$Detected = @("claude", "codex", "opencode", "pi", "agent") | Where-Object { Test-CliInstalled $_ }
if ($Detected.Count -eq 0) { throw "No supported CLI found. Install Claude Code, Codex, OpenCode, Pi, or Cursor Agent." }

$script:MenuDim = [char]27 + "[2m"
$script:MenuReset = [char]27 + "[0m"

function Get-MenuBlurb([string]$Kind, [string]$Item) {
  switch ("${Kind}:${Item}") {
    "host:claude" { return "Anthropic agentic coding CLI with plugins, skills, and MCP." }
    "host:codex" { return "OpenAI Codex CLI with plugins and MCP support." }
    "host:opencode" { return "Open-source AI coding agent with skills, agents, and MCP." }
    "host:pi" { return "Pi CLI for headless agent workflows." }
    "host:agent" { return "Cursor Agent CLI for headless workflows in Cursor." }
    "host:all" { return "Install to every detected host above." }
    "install:harness" { return "Spec→build→QA pipeline with planner, generator, evaluator, supervisor, learning loop, and project backup." }
    "install:hallmark" { return "Anti-AI-slop design skill. Installs the hallmark skill globally via npx skills." }
    "install:no-mistakes" { return "Git push gate with AI validation. Installs the upstream binary; run no-mistakes init per repository afterward." }
    "install:treehouse" { return "Reusable git worktree pool for agents. Installs the upstream treehouse CLI." }
    "install:skill-creator" { return "Multi-agent pipeline to create, evaluate, benchmark, and refine AI coding skills." }
    "install:playwright" { return "Browser automation and E2E testing through Microsoft official Playwright MCP server." }
    "install:crawl4ai" { return "Web crawling and structured extraction. Installs the Python package plus a bundled skill per host." }
    "install:status-line" { return "Custom status bar for Claude; built-in status items for Codex (model, git branch, context usage)." }
    "install:shared-config" { return "Atomically merge the project shareable Claude settings while preserving your existing preferences." }
    default { return "" }
  }
}

function Write-MenuItem([string]$Pointer, [string]$Item, [string]$Box, [string]$LabelKind) {
  if ($Box) { Write-Host " $Pointer $Box $Item" } else { Write-Host " $Pointer $Item" }
  $blurb = Get-MenuBlurb $LabelKind $Item
  if (-not $blurb) { return }
  $indent = if ($Box) { "      " } else { "    " }
  Write-Host ("$indent$($script:MenuDim)$blurb$($script:MenuReset)")
}

# Arrow-key menu that repaints the whole console each frame (Clear() first), so
# navigation never duplicates lines. single = pick one; multi = space-toggle
# checklist with a/A select-all. Mirrors select_menu in install.sh.
function Select-Menu {
  param(
    [ValidateSet("single", "multi")][string]$Mode,
    [string[]]$Items,
    [string[]]$Checked = @(),
    [string]$Title,
    [ValidateSet("", "host", "install")][string]$LabelKind = ""
  )
  if ($Items.Count -eq 0) { return @() }
  $cursor = 0
  $state = @{}; foreach ($item in $Items) { $state[$item] = ($Checked -contains $item) }
  while ($true) {
    [Console]::Clear()
    Write-Host "$Title`n"
    for ($i = 0; $i -lt $Items.Count; $i++) {
      $pointer = if ($i -eq $cursor) { ">" } else { " " }
      if ($Mode -eq "multi") {
        $box = if ($state[$Items[$i]]) { "[x]" } else { "[ ]" }
        Write-MenuItem $pointer $Items[$i] $box $LabelKind
      } else {
        Write-MenuItem $pointer $Items[$i] "" $LabelKind
      }
    }
    $hint = if ($Mode -eq "multi") { "space: toggle   a: all/none   enter: confirm" } else { "enter: select" }
    Write-Host "`n  up/down: move   $hint   q: cancel"
    $key = [Console]::ReadKey($true)
    if ($key.Key -eq "UpArrow") { if ($cursor -gt 0) { $cursor-- }; continue }
    if ($key.Key -eq "DownArrow") { if ($cursor -lt $Items.Count - 1) { $cursor++ }; continue }
    if ($key.Key -eq "Enter") { break }
    if ($key.Key -eq "Escape" -or $key.KeyChar -eq 'q' -or $key.KeyChar -eq 'Q') { throw "Cancelled" }
    if ($Mode -eq "multi" -and $key.KeyChar -eq ' ') { $state[$Items[$cursor]] = -not $state[$Items[$cursor]]; continue }
    if ($Mode -eq "multi" -and ($key.KeyChar -eq 'a' -or $key.KeyChar -eq 'A')) {
      $allOn = @($Items | Where-Object { -not $state[$_] }).Count -eq 0
      foreach ($item in $Items) { $state[$item] = -not $allOn }
      continue
    }
    $number = 0
    if ([int]::TryParse([string]$key.KeyChar, [ref]$number) -and $number -ge 1 -and $number -le $Items.Count) {
      $cursor = $number - 1
      if ($Mode -eq "single") { break }
    }
  }
  if ($Mode -eq "multi") { return @($Items | Where-Object { $state[$_] }) }
  return @($Items[$cursor])
}

function Select-Host {
  if ($Cli) {
    if ($Cli -eq "all") { return $Detected }
    if ($Detected -notcontains $Cli) { throw "Requested CLI is not installed: $Cli" }
    return @($Cli)
  }
  if ($Detected.Count -eq 1) { return @($Detected[0]) }
  if ([Console]::IsInputRedirected) { throw "Multiple CLIs detected; pass -Cli claude|codex|opencode|pi|agent|all." }
  $choice = @(Select-Menu -Mode single -Items (@($Detected) + "all") -Title "Select target host:" -LabelKind host)[0]
  if ($choice -eq "all") { return $Detected }
  return @($choice)
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
$script:InstallRef = $Version
if (-not $script:InstallRef) { $script:InstallRef = $env:VERSION }
if (-not $script:InstallRef) { $script:InstallRef = $env:HARNESS_INSTALL_REF }

function Resolve-InstallRef {
  if ($script:InstallRef) { return $script:InstallRef }
  $tags = @()
  $output = & git ls-remote --tags --refs "https://github.com/$MarketplaceRepo.git" 2>$null
  foreach ($line in $output) {
    if ($line -match 'refs/tags/(v\d+\.\d+\.\d+)$') { $tags += $Matches[1] }
  }
  if ($tags.Count -eq 0) { throw "could not resolve latest release tag" }
  return ($tags | Sort-Object { [version]($_ -replace '^v', '') } | Select-Object -Last 1)
}

function Get-CatalogRepo {
  if ($script:StagedRepo -and (Test-Path (Join-Path $script:StagedRepo "config/installable-catalog.json"))) {
    return $script:StagedRepo
  }
  if ($RepoRoot -and (Test-Path (Join-Path $RepoRoot "config/installable-catalog.json"))) {
    return $RepoRoot
  }
  return $null
}

function Get-ModuleHosts([string]$Name) {
  $repo = Get-CatalogRepo
  if ($repo -and (Test-Path (Join-Path $repo "scripts/install-reconcile.mjs"))) {
    $hosts = & node (Join-Path $repo "scripts/install-reconcile.mjs") hosts $Name 2>$null
    if ($LASTEXITCODE -eq 0 -and $hosts) { return $hosts -split '\s+' }
  }
  return $PluginClis[$Name]
}

function Write-InstallReceipt([string]$Module, $Payload) {
  if ($DryRun) { return }
  $repo = Get-CatalogRepo
  if (-not $repo) { return }
  $json = ($Payload | ConvertTo-Json -Compress)
  New-Item -ItemType Directory -Force $ReceiptDir | Out-Null
  & node (Join-Path $repo "scripts/install-reconcile.mjs") record-receipt $ReceiptDir $Module $json *> $null
}

function Invoke-Reconcile([string[]]$Arguments) {
  $repo = Get-Repository
  if ($repo -eq "<staged harness repository>") { return }
  & node (Join-Path $repo "scripts/install-reconcile.mjs") @Arguments
  if ($LASTEXITCODE -ne 0) { throw "install reconcile failed: $($Arguments -join ' ')" }
}

function Get-Repository {
  if ($script:StagedRepo) { return $script:StagedRepo }
  if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot ".claude-plugin/marketplace.json"))) {
    $script:StagedRepo = $PSScriptRoot
    return $script:StagedRepo
  }
  if ($DryRun) {
    try { $ref = Resolve-InstallRef } catch {
      $ref = if ($script:InstallRef) { $script:InstallRef } else { "latest-release-tag" }
    }
    Write-Host "DRY RUN - git clone --depth 1 --branch $ref https://github.com/$MarketplaceRepo.git <temp>"
    return "<staged harness repository>"
  }
  $ref = Resolve-InstallRef
  Write-Host "install.ps1: staging release $ref"
  $script:StagedRepo = Join-Path ([IO.Path]::GetTempPath()) ("harness-installer-" + [guid]::NewGuid())
  Invoke-Native git @("clone", "--depth", "1", "--branch", $ref, "https://github.com/$MarketplaceRepo.git", $script:StagedRepo)
  return $script:StagedRepo
}

function Remove-OpenCodePluginFiles([string]$Name) {
  $base = Join-Path $HOME ".config/opencode"
  foreach ($dir in @("skills", "agents", "commands")) {
    $dirPath = Join-Path $base $dir
    if (-not (Test-Path $dirPath)) { continue }
    Get-ChildItem "$dirPath/$Name-*" -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
  }
}

function Remove-StaleAgentPluginPollution([string]$Name) {
  if ($DryRun) { return }
  $dest = Join-Path $HOME ".cursor/plugins/local/$Name"
  if (-not (Test-Path $dest)) { return }
  $polluted = $false
  if (Test-Path (Join-Path $dest "skills/supervisor")) { $polluted = $true }
  $manifest = Join-Path $dest ".cursor-plugin/plugin.json"
  if (Test-Path $manifest) {
    try {
      $json = Get-Content $manifest -Raw | ConvertFrom-Json
      if ($json.name -eq "harness") { $polluted = $true }
    } catch { $polluted = $true }
  }
  if ($polluted) { Remove-Item $dest -Recurse -Force }
}

function Install-AgentPlugin([string]$Name) {
  if ($DryRun) { Write-Host "DRY RUN - install Cursor Agent plugin at $HOME/.cursor/plugins/local/$Name"; return }
  if (-not (Test-CliInstalled agent)) { throw "agent is required to install the harness Cursor Agent plugin" }
  $source = Get-Repository
  $dest = Join-Path $HOME ".cursor/plugins/local/$Name"
  Invoke-Reconcile @("project-agent", $Name, $source, $dest)
}

function Set-CursorMcp([string]$Name, $Entry) {
  $dir = Join-Path $HOME ".cursor"; $config = Join-Path $dir "mcp.json"
  New-Item -ItemType Directory -Force $dir | Out-Null
  if (-not (Test-Path $config)) { "{}" | Set-Content $config -Encoding utf8 }
  Copy-Item $config "$config.pre-harness.bak" -Force
  $json = Get-Content $config -Raw | ConvertFrom-Json
  if (-not $json.mcpServers) { $json | Add-Member -Force NoteProperty mcpServers ([pscustomobject]@{}) }
  $json.mcpServers | Add-Member -Force NoteProperty $Name $Entry
  $temp = "$config.$PID.tmp"
  $json | ConvertTo-Json -Depth 20 | Set-Content $temp -Encoding utf8
  Move-Item $temp $config -Force
}

function Install-OpenCodePlugin([string]$Name) {
  if ($DryRun) {
    Write-Host "DRY RUN - install namespaced OpenCode skills, agents, and commands for $Name"
    return
  }
  $source = Get-Repository
  $base = Join-Path $HOME ".config/opencode"
  @("skills", "agents", "commands") | ForEach-Object { New-Item -ItemType Directory -Force (Join-Path $base $_) | Out-Null }
  if (Test-Path (Join-Path $source "packages/$Name")) {
    Invoke-Reconcile @("project-bundle", $Name, (Join-Path $base "skills/$Name"))
    return
  }
  if ($Name -eq "harness") {
    Invoke-Reconcile @("project-harness-opencode", $source, $base)
    return
  }
  Get-ChildItem (Join-Path $source "skills") -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $base "skills/$Name-$($_.Name)") -Recurse -Force
  }
  Get-ChildItem (Join-Path $source "agents/*.md") -ErrorAction SilentlyContinue | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $base "agents/$Name-$($_.Name)") -Force
  }
  Get-ChildItem (Join-Path $source "commands/*.md") -ErrorAction SilentlyContinue | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $base "commands/$Name-$($_.Name)") -Force
  }
}

function Set-OpenCodeConfig([scriptblock]$Update) {
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
  & $Update $json
  $temp = "$config.$PID.tmp"
  $json | ConvertTo-Json -Depth 20 | Set-Content $temp -Encoding utf8
  Move-Item $temp $config -Force
}

function Set-OpenCodeMcp([string]$Name, $Entry) {
  Set-OpenCodeConfig {
    param($json)
    if (-not $json.mcp) { $json | Add-Member -Force NoteProperty mcp ([pscustomobject]@{}) }
    $json.mcp | Add-Member -Force NoteProperty $Name $Entry
  }
}

function Set-OpenCodePlugin([string]$Name, [string]$Spec) {
  Set-OpenCodeConfig {
    param($json)
    if (-not $json.plugin) { $json | Add-Member -Force NoteProperty plugin @() }
    $plugins = [System.Collections.ArrayList]::new($json.plugin)
    if ($plugins -notcontains $Spec) { [void]$plugins.Add($Spec); $json.plugin = $plugins.ToArray() }
  }
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
  $dir = Join-Path $HOME ".claude"; New-Item -ItemType Directory -Force $dir | Out-Null
  $dest = Join-Path $dir "statusline.sh"
  Copy-Item $script $dest -Force
  Write-ClaudeSettings { param($json) $json | Add-Member -Force NoteProperty statusLine ([pscustomobject]@{ type="command"; command="bash $dest" }) }
}

# ponytail: assumes any existing `status_line = [...]` line is single-line
# (matches what this installer and Codex itself write); a hand-edited
# multi-line array would leave orphaned continuation lines behind.
function Enable-CodexStatusLine {
  if ($DryRun) { Write-Host "DRY RUN - atomically enable the Codex status line"; return }
  $dir = Join-Path $HOME ".codex"; $cfg = Join-Path $dir "config.toml"
  New-Item -ItemType Directory -Force $dir | Out-Null
  if (-not (Test-Path $cfg)) { "" | Set-Content $cfg -Encoding utf8 }
  Copy-Item $cfg "$cfg.pre-harness.bak" -Force
  $statusLine = 'status_line = ["model", "current-dir", "git-branch", "context-used", "five-hour-limit", "weekly-limit"]'
  $output = [System.Collections.Generic.List[string]]::new()
  $inTui = $false; $done = $false
  foreach ($line in (Get-Content $cfg)) {
    if ($line -match '^\[tui\]') { $output.Add($line); $inTui = $true; continue }
    if ($line -match '^\[') {
      if ($inTui -and -not $done) { $output.Add($statusLine); $done = $true }
      $inTui = $false; $output.Add($line); continue
    }
    if ($inTui -and $line -match '^status_line\s*=') { $output.Add($statusLine); $done = $true; continue }
    $output.Add($line)
  }
  if ($inTui -and -not $done) { $output.Add($statusLine); $done = $true }
  if (-not $done) { $output.Add(""); $output.Add("[tui]"); $output.Add($statusLine) }
  $temp = "$cfg.$PID.tmp"
  $output | Set-Content $temp -Encoding utf8
  Move-Item $temp $cfg -Force
}

function Apply-ClaudeSharedConfig {
  if ($DryRun) { Write-Host "DRY RUN - atomically merge Claude shared config"; return }
  $shared = Get-Content (Join-Path (Get-Repository) "config/settings.json") -Raw | ConvertFrom-Json
  Write-ClaudeSettings { param($json) foreach ($property in $shared.PSObject.Properties) { $json | Add-Member -Force NoteProperty $property.Name $property.Value } }
}

function Install-SkillCreator {
  foreach ($target in $Targets) {
    if ((Get-ModuleHosts "skill-creator") -notcontains $target) { continue }
    switch ($target) {
      claude {
        if ($DryRun) { Write-Host "DRY RUN - install skill-creator to ~/.claude/skills/"; continue }
        $dest = Join-Path $HOME ".claude/skills/skill-creator"
        New-Item -ItemType Directory -Force (Split-Path $dest -Parent) | Out-Null
        Invoke-Reconcile @("project-bundle", "skill-creator", $dest)
      }
      opencode { Install-OpenCodePlugin "skill-creator" }
      codex {
        & codex plugin marketplace upgrade $CodexMarketplace *> $null
        Invoke-Native codex @("plugin", "add", "skill-creator@$CodexMarketplace")
      }
      pi {
        if ($DryRun) { Write-Host "DRY RUN - install skill-creator to ~/.agents/skills/skill-creator"; continue }
        $dest = Join-Path $HOME ".agents/skills/skill-creator"
        New-Item -ItemType Directory -Force (Split-Path $dest -Parent) | Out-Null
        Invoke-Reconcile @("project-bundle", "skill-creator", $dest)
      }
      agent { Install-AgentPlugin "skill-creator" }
    }
  }
}

function Install-Crawl4AiSkill([string]$Destination) {
  New-Item -ItemType Directory -Force (Split-Path $Destination -Parent) | Out-Null
  Invoke-Reconcile @("project-bundle", "crawl4ai", $Destination)
}

function Install-Crawl4AiPip {
  if ($DryRun) {
    Write-Host "DRY RUN - pip install -U crawl4ai"
    Write-Host "DRY RUN - crawl4ai-setup"
    Write-Host "DRY RUN - crawl4ai-doctor"
    return
  }
  $venv = Join-Path $HOME ".local/share/harness/crawl4ai-venv"
  $pip = Get-Command pip3 -ErrorAction SilentlyContinue
  if (-not $pip) { $pip = Get-Command pip -ErrorAction SilentlyContinue }
  $python = Get-Command python3 -ErrorAction SilentlyContinue
  if (-not $python) { $python = Get-Command python -ErrorAction SilentlyContinue }
  $installed = $false
  if ($pip) {
    try { Invoke-Native $pip.Source @("install", "-U", "crawl4ai"); $installed = $true } catch { }
  }
  if (-not $installed -and $python) {
    try { Invoke-Native $python.Source @("-m", "pip", "install", "-U", "crawl4ai"); $installed = $true } catch { }
  }
  if (-not $installed) {
    if (-not $python) { throw "python is required to install crawl4ai in a virtual environment" }
    if (-not (Test-Path (Join-Path $venv "Scripts/python.exe")) -and -not (Test-Path (Join-Path $venv "bin/python"))) {
      Invoke-Native $python.Source @("-m", "venv", $venv)
    }
    $venvPip = if (Test-Path (Join-Path $venv "Scripts/pip.exe")) { Join-Path $venv "Scripts/pip.exe" } else { Join-Path $venv "bin/pip" }
    Invoke-Native $venvPip @("install", "-U", "crawl4ai")
    $bin = if (Test-Path (Join-Path $venv "Scripts")) { Join-Path $venv "Scripts" } else { Join-Path $venv "bin" }
    $localBin = Join-Path $HOME ".local/bin"
    New-Item -ItemType Directory -Force $localBin | Out-Null
    foreach ($tool in @("crawl4ai-setup", "crawl4ai-doctor")) {
      $source = Join-Path $bin $tool
      if (Test-Path $source) { Copy-Item $source (Join-Path $localBin $tool) -Force }
    }
    if ($env:PATH -notlike "*$localBin*") { $env:PATH = "$localBin$([IO.Path]::PathSeparator)$env:PATH" }
  }
  $setup = Get-Command crawl4ai-setup -ErrorAction SilentlyContinue
  if (-not $setup) { throw "crawl4ai-setup not found after pip install" }
  Invoke-Native $setup.Source
  $doctor = Get-Command crawl4ai-doctor -ErrorAction SilentlyContinue
  if (-not $doctor) { throw "crawl4ai-doctor not found after pip install" }
  Invoke-Native $doctor.Source
  $crawlVersion = try {
    if ($pip) { (& $pip.Source show crawl4ai 2>$null | Select-String '^Version:' | ForEach-Object { $_.Line.Split(':')[1].Trim() }) }
    elseif ($python) { (& $python.Source -m pip show crawl4ai 2>$null | Select-String '^Version:' | ForEach-Object { $_.Line.Split(':')[1].Trim() }) }
  } catch { $null }
  Write-InstallReceipt crawl4ai @{ pip = "crawl4ai"; version = ($crawlVersion ?? "unknown") }
}

function Install-Crawl4Ai {
  Install-Crawl4AiPip
  foreach ($target in $Targets) {
    if ((Get-ModuleHosts "crawl4ai") -notcontains $target) { continue }
    switch ($target) {
      claude {
        if ($DryRun) { Write-Host "DRY RUN - install crawl4ai skill to ~/.claude/skills/crawl4ai"; continue }
        Install-Crawl4AiSkill (Join-Path $HOME ".claude/skills/crawl4ai")
      }
      opencode {
        if ($DryRun) { Write-Host "DRY RUN - install crawl4ai skill to ~/.config/opencode/skills/crawl4ai"; continue }
        $base = if ($env:XDG_CONFIG_HOME) { Join-Path $env:XDG_CONFIG_HOME "opencode" } else { Join-Path $HOME ".config/opencode" }
        Install-Crawl4AiSkill (Join-Path $base "skills/crawl4ai")
      }
      { $_ -in @("codex", "pi") } {
        if ($DryRun) { Write-Host "DRY RUN - install crawl4ai skill to ~/.agents/skills/crawl4ai"; continue }
        Install-Crawl4AiSkill (Join-Path $HOME ".agents/skills/crawl4ai")
      }
      agent {
        if ($DryRun) { Write-Host "DRY RUN - install crawl4ai skill to ~/.cursor/skills/crawl4ai"; continue }
        Install-Crawl4AiSkill (Join-Path $HOME ".cursor/skills/crawl4ai")
      }
    }
  }
}

function Install-Hallmark {
  if ($DryRun) {
    Write-Host "DRY RUN - npx skills add nutlope/hallmark --skill hallmark -g"
    return
  }
  if (-not (Get-Command npx -ErrorAction SilentlyContinue)) { throw "npx is required to install the hallmark skill" }
  Invoke-Native npx @("skills", "add", "nutlope/hallmark", "--skill", "hallmark", "-g")
  Write-InstallReceipt hallmark @{ skills = "nutlope/hallmark"; skill = "hallmark"; global = $true }
}

function Install-NoMistakes {
  if ($DryRun) {
    Write-Host "DRY RUN - irm $NoMistakesInstaller | iex"
    Write-Host "DRY RUN - note: run no-mistakes init in each repository you want to gate (not run by the harness installer)"
    return
  }
  try { Invoke-Expression (Invoke-WebRequest $NoMistakesInstaller -UseBasicParsing).Content }
  catch { throw "no-mistakes installer failed: $_" }
  $binary = Get-Command no-mistakes -ErrorAction SilentlyContinue
  $version = if ($binary) { try { & $binary.Source --version 2>$null } catch { "unknown" } } else { "unknown" }
  Write-InstallReceipt no-mistakes @{ binary = ($binary.Source ?? "unknown"); version = ($version ?? "unknown") }
  Write-Host "install.ps1: run no-mistakes init in each repository you want to gate"
}

function Install-Treehouse {
  if ($DryRun) {
    Write-Host "DRY RUN - irm $TreehouseInstaller | iex"
    return
  }
  try { Invoke-Expression (Invoke-WebRequest $TreehouseInstaller -UseBasicParsing).Content }
  catch { throw "treehouse installer failed: $_" }
  $binary = Get-Command treehouse -ErrorAction SilentlyContinue
  $version = if ($binary) { try { & $binary.Source --version 2>$null } catch { "unknown" } } else { "unknown" }
  Write-InstallReceipt treehouse @{ binary = ($binary.Source ?? "unknown"); version = ($version ?? "unknown") }
}

function Install-PlaywrightMcp {
  $Name = "playwright"
  $server = [pscustomobject]@{ type="stdio"; command="npx"; args=@("-y", "@playwright/mcp@latest") }
  if ($DryRun) { Write-Host "DRY RUN - configure $Name MCP for: $($Targets -join ', ')"; return }
  $json = $server | ConvertTo-Json -Compress
  foreach ($target in $Targets) {
    switch ($target) {
      claude {
        & claude mcp remove $Name --scope user *> $null
        Invoke-Native claude @("mcp", "add-json", "--scope", "user", $Name, $json)
      }
      codex {
        & codex mcp remove $Name *> $null
        Invoke-Native codex (@("mcp", "add", $Name, "--", $server.command) + @($server.args))
      }
      opencode {
        Set-OpenCodeMcp $Name ([pscustomobject]@{ type="local"; command=@($server.command) + @($server.args); enabled=$true })
      }
      agent { Set-CursorMcp $Name $server }
    }
  }
}

$Selected = if ($No) {
  @("harness")
} elseif ($Yes) {
  @("harness") + $Optional
} elseif ([Console]::IsInputRedirected) {
  @("harness")
} else {
  $candidates = @("harness") + @($Optional | Where-Object { @((Get-ModuleHosts $_) | Where-Object { $Targets -contains $_ }).Count -gt 0 })
  @(Select-Menu -Mode multi -Items $candidates -Checked @("harness") -Title "Select what to install (harness recommended):" -LabelKind install)
}

foreach ($target in $Targets) {
  if ($target -eq "claude") {
    if ($DryRun) { Invoke-Native claude @("plugin", "marketplace", "update", $ClaudeMarketplace) }
    else {
      & claude plugin marketplace update $ClaudeMarketplace
      if ($LASTEXITCODE -ne 0) { Invoke-Native claude @("plugin", "marketplace", "add", "https://github.com/$MarketplaceRepo.git") }
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

if ($DryRun) {
  $localCheckout = $PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot ".claude-plugin/marketplace.json"))
  if (-not $localCheckout) { [void](Get-Repository) }
}

foreach ($item in $Selected) {
  if ($item -eq "skill-creator") { Install-SkillCreator; continue }
  if ($item -eq "crawl4ai") { Install-Crawl4Ai; continue }
  if ($item -eq "hallmark") { Install-Hallmark; continue }
  if ($item -eq "no-mistakes") { Install-NoMistakes; continue }
  if ($item -eq "treehouse") { Install-Treehouse; continue }
  if ($item -eq "playwright") { Install-PlaywrightMcp; continue }
  if ($item -eq "status-line") {
    foreach ($target in $Targets) {
      if ($target -eq "claude") { Enable-ClaudeStatusLine }
      if ($target -eq "codex") { Enable-CodexStatusLine }
    }
    continue
  }
  if ($item -eq "shared-config") { Apply-ClaudeSharedConfig; continue }
  foreach ($target in $Targets) {
    if ((Get-ModuleHosts $item) -notcontains $target) { continue }
    switch ($target) {
      claude {
        if ($DryRun) { Invoke-Native claude @("plugin", "update", "$item@$ClaudeMarketplace", "--scope", $Scope) }
        else {
          & claude plugin update "$item@$ClaudeMarketplace" --scope $Scope
          if ($LASTEXITCODE -ne 0) { Invoke-Native claude @("plugin", "install", "$item@$ClaudeMarketplace", "--scope", $Scope) }
        }
      }
      codex { Invoke-Native codex @("plugin", "add", "$item@$CodexMarketplace") }
      opencode { Install-OpenCodePlugin $item }
      agent {
        if ($item -eq "harness") { Install-AgentPlugin $item }
        else { Remove-StaleAgentPluginPollution $item }
      }
    }
  }
}

Write-Host "Harness installation complete for: $($Targets -join ', ')"
