# Native Windows installer for Claude Code, Codex, OpenCode, and Cursor Agent.
[CmdletBinding()]
param(
  [switch]$Yes,
  [switch]$No,
  [switch]$DryRun,
  [ValidateSet("claude", "codex", "opencode", "agent", "all")][string]$Cli,
  [ValidateSet("user", "project", "local")][string]$Scope = "user"
)
$ErrorActionPreference = "Stop"

$MarketplaceRepo = "vinicius91carvalho/harness-engineering"
$ClaudeMarketplace = "harness-engineering"
$CodexMarketplace = "harness-engineering"
$MemoryInstaller = "https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.ps1"
$Optional = @("omnigent", "ponytail", "skill-creator", "codebase-memory-mcp", "context7", "playwright", "status-line", "shared-config", "mcp-servers")
$PluginClis = @{
  harness = @("claude", "codex", "opencode", "agent")
  omnigent = @("claude", "codex", "opencode", "agent")
  ponytail = @("claude", "codex", "opencode", "agent")
  "skill-creator" = @("claude", "codex", "opencode", "agent")
  "codebase-memory-mcp" = @("claude", "codex", "opencode", "agent")
  context7 = @("claude", "codex", "opencode", "agent"); playwright = @("claude", "codex", "opencode", "agent")
  "mcp-servers" = @("claude", "codex", "opencode", "agent")
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

$Detected = @("claude", "codex", "opencode", "agent") | Where-Object { Test-CliInstalled $_ }
if ($Detected.Count -eq 0) { throw "No supported CLI found. Install Claude Code, Codex, OpenCode, or Cursor Agent." }

# Arrow-key menu that repaints the whole console each frame (Clear() first), so
# navigation never duplicates lines. single = pick one; multi = space-toggle
# checklist with a/A select-all. Mirrors select_menu in install.sh.
function Select-Menu {
  param([ValidateSet("single", "multi")][string]$Mode, [string[]]$Items, [string[]]$Checked = @(), [string]$Title)
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
        Write-Host " $pointer $box $($Items[$i])"
      } else {
        Write-Host " $pointer $($Items[$i])"
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
  if ([Console]::IsInputRedirected) { throw "Multiple CLIs detected; pass -Cli claude|codex|opencode|agent|all." }
  $choice = @(Select-Menu -Mode single -Items (@($Detected) + "all") -Title "Select target host:")[0]
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

function Remove-OpenCodePluginFiles([string]$Name) {
  $base = Join-Path $HOME ".config/opencode"
  foreach ($dir in @("skills", "agents", "commands")) {
    $dirPath = Join-Path $base $dir
    if (-not (Test-Path $dirPath)) { continue }
    Get-ChildItem "$dirPath/$Name-*" -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
  }
}

function Install-Omnigent {
  if ($DryRun) {
    Write-Host "DRY RUN - install Omnigent with the official uv runtime installer"
    Write-Host "DRY RUN - install agent bundle at $HOME/.omnigent/agents/harness-engineering"
    Write-Host "DRY RUN - bundle harness-control.mjs and generator scripts into the agent bundle"
    return
  }
  if (-not (Get-Command omni -ErrorAction SilentlyContinue) -and -not (Get-Command omnigent -ErrorAction SilentlyContinue)) {
    if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { throw "uv is required for the official Omnigent Windows installation" }
    Invoke-Native uv @("tool", "install", "--python", "3.12", "omnigent")
  }
  $source = Join-Path (Get-Repository) "omnigent/harness-engineering"
  if (-not (Test-Path (Join-Path $source "config.yaml"))) { throw "Bundled Omnigent agent is missing" }
  $destination = Join-Path $HOME ".omnigent/agents/harness-engineering"
  Remove-Item $destination -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force $destination | Out-Null
  Copy-Item (Join-Path $source "*") $destination -Recurse -Force
  # Bundle the orchestrator so the supervisor agent can call it from a known path.
  # harness-control.mjs resolves the generator via $script/../../harness-generator,
  # so the generator must live one level above the bundle dir.
  $repo = Get-Repository
  $scriptsDir = New-Item -ItemType Directory -Force (Join-Path $destination "scripts")
  $parentGenerator = New-Item -ItemType Directory -Force (Join-Path (Split-Path $destination -Parent) "harness-generator")
  Copy-Item (Join-Path $repo "skills/supervisor/scripts/harness-control.mjs") $scriptsDir -Force
  Copy-Item @(
    (Join-Path $repo "skills/generator/orchestrator.mjs"),
    (Join-Path $repo "skills/generator/reconcile.mjs"),
    (Join-Path $repo "skills/generator/claim.sh"),
    (Join-Path $repo "skills/generator/claim.ps1")
  ) $parentGenerator -Force
}

function Install-AgentPlugin([string]$Name) {
  if ($DryRun) { Write-Host "DRY RUN - install Cursor Agent plugin at $HOME/.cursor/plugins/local/$Name"; return }
  if (-not (Test-CliInstalled agent)) { throw "agent is required to install the harness Cursor Agent plugin" }
  $source = Get-Repository
  $dest = Join-Path $HOME ".cursor/plugins/local/$Name"
  New-Item -ItemType Directory -Force (Join-Path $dest ".cursor-plugin"), (Join-Path $dest "skills"), (Join-Path $dest "agents"), (Join-Path $dest "commands"), (Join-Path $dest "assets") | Out-Null
  Copy-Item (Join-Path $source ".cursor-plugin/plugin.json") (Join-Path $dest ".cursor-plugin/") -Force
  Copy-Item (Join-Path $source "skills/*") (Join-Path $dest "skills") -Recurse -Force
  Get-ChildItem (Join-Path $source "agents/*.md") -ErrorAction SilentlyContinue | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $dest "agents/") -Force
  }
  if (Test-Path (Join-Path $source "assets/banner.svg")) {
    Copy-Item (Join-Path $source "assets/banner.svg") (Join-Path $dest "assets/") -Force
  }
  if (Test-Path (Join-Path $source ".mcp.json")) { Copy-Item (Join-Path $source ".mcp.json") $dest -Force }
  if (Test-Path (Join-Path $source "AGENTS.md")) { Copy-Item (Join-Path $source "AGENTS.md") $dest -Force }
  Get-ChildItem (Join-Path $source "skills/*/SKILL.md") -ErrorAction SilentlyContinue | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $dest "commands/harness-$($_.Directory.Name).md") -Force
  }
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
    if ($Name -eq "ponytail") {
      Write-Host "DRY RUN - npm install -g @dietrichgebert/ponytail"
      Write-Host "DRY RUN - register ponytail in OpenCode plugin config"
    } else {
      Write-Host "DRY RUN - install namespaced OpenCode skills, agents, and commands for $Name"
    }
    return
  }
  if ($Name -eq "ponytail") {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "npm is required to install the ponytail OpenCode plugin" }
    Invoke-Native npm @("install", "-g", "@dietrichgebert/ponytail")
    Remove-OpenCodePluginFiles ponytail
    Set-OpenCodePlugin ponytail "@dietrichgebert/ponytail"
    return
  }
  $source = Get-Repository
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

function Read-PasteableSecret([string]$Prompt) {
  Write-Host -NoNewline "${Prompt}: "
  $value = [Text.StringBuilder]::new()
  while ($true) {
    $key = [Console]::ReadKey($true)
    if ($key.Key -eq "Enter") { Write-Host; return $value.ToString() }
    if ($key.Key -eq "C" -and ($key.Modifiers -band [ConsoleModifiers]::Control)) { throw "Cancelled" }
    if ($key.Key -eq "Backspace") {
      if ($value.Length -gt 0) {
        $value.Length--
        Write-Host -NoNewline "`b `b"
      }
      continue
    }
    if (-not [char]::IsControl($key.KeyChar)) {
      [void]$value.Append($key.KeyChar)
      Write-Host -NoNewline $key.KeyChar
    }
  }
}

function Install-McpInventory {
  if ($DryRun) { Write-Host "DRY RUN - prompt for and configure MCP inventory for: $($Targets -join ', ')"; return }
  if ([Console]::IsInputRedirected) { Write-Warning "MCP inventory requires a console for secret prompts; skipped"; return }
  $path = Join-Path (Get-Repository) "config/mcp.json"
  if (-not (Test-Path $path)) { Write-Host "No MCP inventory found"; return }
  $servers = (Get-Content $path -Raw | ConvertFrom-Json).mcpServers
  foreach ($property in $servers.PSObject.Properties) {
    if ((Read-Host "Configure MCP server $($property.Name)? [y/N]") -notmatch '^(y|yes)$') { continue }
    $json = $property.Value | ConvertTo-Json -Depth 20 -Compress
    $skip = $false
    foreach ($match in [regex]::Matches($json, '\$\{([A-Za-z0-9_]+)\}')) {
      $value = Read-PasteableSecret "Value for $($match.Groups[1].Value) (paste supported; Enter skips server)"
      if (-not $value) { $skip = $true; break }
      $json = $json.Replace($match.Value, $value)
    }
    if ($skip) { continue }
    $server = $json | ConvertFrom-Json
    foreach ($target in $Targets) {
      switch ($target) {
        claude {
          & claude mcp remove $property.Name --scope user *> $null
          Invoke-Native claude @("mcp", "add-json", "--scope", "user", $property.Name, $json)
        }
        codex {
          if ($server.url) {
            & codex mcp remove $property.Name *> $null
            & codex mcp add $property.Name --url $server.url *> $null
            if ($LASTEXITCODE -ne 0) {
              & codex mcp get $property.Name *> $null
              if ($LASTEXITCODE -ne 0) { throw "Codex MCP configuration failed for $($property.Name)" }
            }
          }
          else {
            $envArgs = @()
            if ($server.env) { $server.env.PSObject.Properties | ForEach-Object { $envArgs += @("--env", "$($_.Name)=$($_.Value)") } }
            Invoke-Native codex (@("mcp", "add", $property.Name) + $envArgs + @("--", $server.command) + @($server.args))
          }
        }
        opencode {
          $entry = if ($server.url) { [pscustomobject]@{ type="remote"; url=$server.url; enabled=$true } }
            else {
              $local = @{ type="local"; command=@($server.command) + @($server.args); enabled=$true }
              if ($server.env) { $local.environment = $server.env }
              [pscustomobject]$local
            }
          Set-OpenCodeMcp $property.Name $entry
        }
        agent {
          $entry = if ($server.url) { [pscustomobject]@{ type="http"; url=$server.url } }
            else {
              $local = @{ type="stdio"; command=$server.command; args=@($server.args) }
              if ($server.env) { $local.env = $server.env }
              [pscustomobject]$local
            }
          Set-CursorMcp $property.Name $entry
        }
      }
    }
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
  & $binary.Source config set auto_index true
  if ($LASTEXITCODE -ne 0) { throw "Could not enable codebase-memory-mcp auto-indexing" }
  foreach ($target in $Targets) {
    switch ($target) {
      claude {
        & claude mcp remove codebase-memory-mcp --scope user *> $null
        Invoke-Native claude @("mcp", "add-json", "--scope", "user", "codebase-memory-mcp", "{`"command`":`"$($binary.Source)`",`"args`":[]}")
      }
      codex { Invoke-Native codex @("mcp", "add", "codebase-memory-mcp", "--", $binary.Source) }
      opencode { Set-OpenCodeMcp "codebase-memory-mcp" ([pscustomobject]@{ type="local"; command=@($binary.Source); enabled=$true }) }
      agent { Set-CursorMcp "codebase-memory-mcp" ([pscustomobject]@{ type="stdio"; command=$binary.Source; args=@() }) }
    }
  }
}

function Install-SkillCreator {
  foreach ($target in $Targets) {
    if ($PluginClis["skill-creator"] -notcontains $target) { continue }
    switch ($target) {
      claude {
        if ($DryRun) { Write-Host "DRY RUN - install skill-creator to ~/.claude/skills/"; continue }
        $source = Join-Path (Get-Repository) "skills/skill-creator"
        $dest = Join-Path $HOME ".claude/skills/skill-creator"
        Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue
        New-Item -ItemType Directory -Force (Split-Path $dest -Parent) | Out-Null
        Copy-Item $source $dest -Recurse -Force
      }
      opencode { Install-OpenCodePlugin "skill-creator" }
      codex {
        & codex plugin marketplace upgrade $CodexMarketplace *> $null
        Invoke-Native codex @("plugin", "add", "skill-creator@$CodexMarketplace")
      }
      agent { Install-AgentPlugin "skill-creator" }
    }
  }
}

function Install-PortableMcp([string]$Name) {
  $server = if ($Name -eq "context7") {
    [pscustomobject]@{ type="http"; url="https://mcp.context7.com/mcp" }
  } else {
    [pscustomobject]@{ type="stdio"; command="npx"; args=@("-y", "@playwright/mcp@latest") }
  }
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
        if ($server.url) { Invoke-Native codex @("mcp", "add", $Name, "--url", $server.url) }
        else { Invoke-Native codex (@("mcp", "add", $Name, "--", $server.command) + @($server.args)) }
      }
      opencode {
        $entry = if ($server.url) { [pscustomobject]@{ type="remote"; url=$server.url; enabled=$true } }
          else { [pscustomobject]@{ type="local"; command=@($server.command) + @($server.args); enabled=$true } }
        Set-OpenCodeMcp $Name $entry
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
  $candidates = @("harness") + @($Optional | Where-Object { @($PluginClis[$_] | Where-Object { $Targets -contains $_ }).Count -gt 0 })
  @(Select-Menu -Mode multi -Items $candidates -Checked @("harness") -Title "Select what to install (harness recommended):")
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

foreach ($item in $Selected) {
  if ($item -eq "omnigent") { Install-Omnigent; continue }
  if ($item -eq "skill-creator") { Install-SkillCreator; continue }
  if ($item -eq "codebase-memory-mcp") { Install-Memory; continue }
  if ($item -eq "context7" -or $item -eq "playwright") { Install-PortableMcp $item; continue }
  if ($item -eq "status-line") {
    foreach ($target in $Targets) {
      if ($target -eq "claude") { Enable-ClaudeStatusLine }
      if ($target -eq "codex") { Enable-CodexStatusLine }
    }
    continue
  }
  if ($item -eq "shared-config") { Apply-ClaudeSharedConfig; continue }
  if ($item -eq "mcp-servers") { Install-McpInventory; continue }
  foreach ($target in $Targets) {
    if ($PluginClis[$item] -notcontains $target) { continue }
    switch ($target) {
      claude {
        if ($DryRun) { Invoke-Native claude @("plugin", "update", "$item@$ClaudeMarketplace", "--scope", $Scope) }
        else {
          & claude plugin update "$item@$ClaudeMarketplace" --scope $Scope
          if ($LASTEXITCODE -ne 0) { Invoke-Native claude @("plugin", "install", "$item@$ClaudeMarketplace", "--scope", $Scope) }
        }
      }
      codex {
        if ($item -eq "ponytail") {
          if ($DryRun) { Invoke-Native codex @("plugin", "marketplace", "upgrade", "ponytail") }
          else {
            & codex plugin marketplace upgrade ponytail
            if ($LASTEXITCODE -ne 0) { Invoke-Native codex @("plugin", "marketplace", "add", "https://github.com/DietrichGebert/ponytail") }
          }
          Invoke-Native codex @("plugin", "add", "ponytail@ponytail")
        } else { Invoke-Native codex @("plugin", "add", "$item@$CodexMarketplace") }
      }
      opencode { Install-OpenCodePlugin $item }
      agent { Install-AgentPlugin $item }
    }
  }
}

Write-Host "Harness installation complete for: $($Targets -join ', ')"
