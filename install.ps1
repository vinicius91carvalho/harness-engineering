# Install the full harness workspace into a fresh Claude Code, Opencode, or Codex setup (native Windows).
# Usage: irm https://raw.githubusercontent.com/vinicius91carvalho/harness-engineering/main/install.ps1 | iex
# -Yes selects every item, -No keeps required only (non-interactive runs).
# -DryRun walks the checklist and prints what would be installed, changing nothing.
param([switch]$Yes, [switch]$No, [switch]$DryRun, [ValidateSet("user","project","local")]$Scope)
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

function Select-Scope {
  if ($Scope) { return $Scope }
  if ($Yes) { return "user" }
  if ([Console]::IsInputRedirected) { return "user" }

  $scopes = @(
    @{ Key = "user";    Label = "user    — available across all projects" }
    @{ Key = "project"; Label = "project — only in the current directory (.claude-plugin/)" }
    @{ Key = "local";   Label = "local   — only in the current directory (private, not shared)" }
  )

  Write-Host ""
  Write-Host "Installation scope:" -ForegroundColor Cyan
  for ($i = 0; $i -lt $scopes.Count; $i++) {
    $num = $i + 1
    Write-Host "  $num) $($scopes[$i].Label)"
  }
  Write-Host ""
  Write-Host "Select scope [1-3] (default: 1): " -NoNewline -ForegroundColor Cyan

  $cursor = 0
  $done = $false
  while (-not $done) {
    $k = [Console]::ReadKey($true)
    switch ($k.KeyChar) {
      '1' { $cursor = 0; $done = $true }
      '2' { $cursor = 1; $done = $true }
      '3' { $cursor = 2; $done = $true }
      "`n" { $done = $true }
      "`r" { $done = $true }
    }
  }
  Write-Host ""
  return $scopes[$cursor].Key
}

$Marketplace     = "vinicius91carvalho/harness-engineering"
$MarketplaceName = "vinicius91carvalho"
$Required        = @("harness")
$Optional        = @("ponytail", "context7", "remember", "skill-creator", "claude-md-management", "claude-code-setup", "hookify", "playwright", "typescript-lsp", "ralph-loop", "pyright-lsp", "rust-analyzer-lsp", "codex")

# CLI support per plugin (space-separated list of supported CLIs)
$PluginClis = @{
  "harness"              = @("claude", "opencode", "codex")
  "ponytail"             = @("claude", "opencode")
  "context7"             = @("claude")
  "remember"             = @("claude")
  "skill-creator"        = @("claude")
  "claude-md-management" = @("claude")
  "claude-code-setup"    = @("claude")
  "hookify"              = @("claude")
  "playwright"           = @("claude")
  "typescript-lsp"       = @("claude")
  "ralph-loop"           = @("claude")
  "pyright-lsp"          = @("claude")
  "rust-analyzer-lsp"    = @("claude")
  "codex"                = @("claude")
}

function Test-PluginSupported([string]$plugin, [string]$clis) {
  foreach ($cli in $clis -split ' ') {
    if ($PluginClis.ContainsKey($plugin) -and $PluginClis[$plugin] -contains $cli) { return $true }
  }
  return $false
}

# Detect ALL available CLIs
$DetectedClis = @()
if (Get-Command claude -ErrorAction SilentlyContinue)   { $DetectedClis += "claude" }
if (Get-Command codex -ErrorAction SilentlyContinue)    { $DetectedClis += "codex" }
if (Get-Command opencode -ErrorAction SilentlyContinue) { $DetectedClis += "opencode" }

if ($DetectedClis.Count -eq 0) {
  Write-Error "No supported CLI found. Install one of: Claude Code, Opencode, or Codex."
  Write-Host "  Claude Code:  https://claude.com/claude-code"
  Write-Host "  Opencode:     https://opencode.ai"
  Write-Host "  Codex:        https://github.com/openai/codex"
  exit 1
}

# Let user pick which CLI to install for (or all)
if ($DetectedClis.Count -eq 1) {
  $CLI = $DetectedClis[0]
  Write-Host "==> Detected CLI: $CLI"
} elseif ($Yes -or $No -or [Console]::IsInputRedirected) {
  $CLI = $DetectedClis -join " "
  Write-Host "==> Detected CLIs: $($DetectedClis -join ', ') (installing for all)"
} else {
  Write-Host ""
  Write-Host "Detected CLIs:" -ForegroundColor Cyan
  for ($i = 0; $i -lt $DetectedClis.Count; $i++) {
    Write-Host "  $($i+1)) $($DetectedClis[$i])"
  }
  Write-Host "  $($DetectedClis.Count+1)) all (install for every detected CLI)"
  Write-Host ""
  Write-Host "Select CLI [1-$($DetectedClis.Count+1)] (default: 1): " -NoNewline -ForegroundColor Cyan
  $choice = [Console]::ReadKey($true)
  $num = [int]$choice.KeyChar - 48
  if ($num -eq ($DetectedClis.Count + 1) -or $num -lt 1 -or $num -gt ($DetectedClis.Count + 1)) {
    $CLI = $DetectedClis -join " "
    Write-Host "all"
  } else {
    $CLI = $DetectedClis[$num - 1]
    Write-Host $CLI
  }
}
Write-Host ""

function Install-Plugin($name) {
  if ($DryRun) { Write-Host "   DRY RUN - would install: $name"; return }
  foreach ($cli in $CLI -split ' ') {
    switch ($cli) {
      "claude" {
        Write-Host "==> Installing: $name@$MarketplaceName (--scope $selectedScope)"
        try { claude plugin install "$name@$MarketplaceName" --scope $selectedScope } catch { Write-Warning "skipped $name - already installed or failed" }
      }
      "codex" {
        Write-Host "==> Installing: $name for Codex"
        Install-CodexPlugin $name
      }
      "opencode" {
        Write-Host "==> Installing: $name for Opencode"
        Install-OpencodePlugin $name
      }
    }
  }
}

function Install-OpencodePlugin([string]$pluginName) {
  $userCfg = Join-Path $HOME ".config\opencode\opencode.jsonc"
  $repoCfg = Join-Path $PSScriptRoot "opencode.json"
  if (-not (Test-Path $repoCfg)) { Write-Warning "opencode.json not found in repo - skipping"; return }

  New-Item -ItemType Directory -Force -Path (Split-Path $userCfg) | Out-Null
  if (-not (Test-Path $userCfg)) { '{}' | Set-Content $userCfg }

  # Read harness config and merge agents/commands into user config
  $harness = Get-Content $repoCfg -Raw | ConvertFrom-Json
  $user = Get-Content $userCfg -Raw | ConvertFrom-Json

  # Merge skills.paths
  if (-not $user.skills) { $user | Add-Member -Force -NotePropertyName skills -NotePropertyValue ([PSCustomObject]@{ paths = @() }) }
  $paths = @($user.skills.paths)
  if ($paths -notcontains "./skills") { $paths += "./skills" }
  $user.skills.paths = $paths

  # Merge agents (add only missing ones)
  if (-not $user.agent) { $user | Add-Member -Force -NotePropertyName agent -NotePropertyValue ([PSCustomObject]@{}) }
  if ($harness.agent) {
    foreach ($prop in $harness.agent.PSObject.Properties) {
      if (-not ($user.agent.PSObject.Properties | Where-Object { $_.Name -eq $prop.Name })) {
        $user.agent | Add-Member -NotePropertyName $prop.Name -NotePropertyValue $prop.Value
      }
    }
  }

  # Merge commands (add only missing ones)
  if (-not $user.command) { $user | Add-Member -Force -NotePropertyName command -NotePropertyValue ([PSCustomObject]@{}) }
  if ($harness.command) {
    foreach ($prop in $harness.command.PSObject.Properties) {
      if (-not ($user.command.PSObject.Properties | Where-Object { $_.Name -eq $prop.Name })) {
        $user.command | Add-Member -NotePropertyName $prop.Name -NotePropertyValue $prop.Value
      }
    }
  }

  # Append AGENTS.md to instructions
  if (-not $user.instructions) { $user | Add-Member -Force -NotePropertyName instructions -NotePropertyValue @() }
  $instrs = @($user.instructions)
  if ($instrs -notcontains "AGENTS.md") { $instrs += "AGENTS.md" }
  $user.instructions = $instrs

  $user | ConvertTo-Json -Depth 10 | Set-Content $userCfg
  Write-Host "==> Updated opencode config: $userCfg"
}

function Install-CodexPlugin([string]$pluginName) {
  $codexCfg = ".codex-plugin\plugin.json"
  $repoCfg = Join-Path $PSScriptRoot ".codex-plugin\plugin.json"
  if (-not (Test-Path $repoCfg)) { Write-Warning "codex plugin.json not found in repo - skipping"; return }

  New-Item -ItemType Directory -Force -Path (Split-Path $codexCfg) | Out-Null

  if (-not (Test-Path $codexCfg)) {
    Copy-Item $repoCfg $codexCfg
    Write-Host "==> Created $codexCfg"
    return
  }

  # Merge agent/command blocks from harness opencode.json
  $repoOc = Join-Path $PSScriptRoot "opencode.json"
  if (Test-Path $repoOc) {
    $harness = Get-Content $repoOc -Raw | ConvertFrom-Json
    $codex = Get-Content $codexCfg -Raw | ConvertFrom-Json

    if (-not $codex.agent) { $codex | Add-Member -Force -NotePropertyName agent -NotePropertyValue ([PSCustomObject]@{}) }
    if ($harness.agent) {
      foreach ($prop in $harness.agent.PSObject.Properties) {
        if (-not ($codex.agent.PSObject.Properties | Where-Object { $_.Name -eq $prop.Name })) {
          $codex.agent | Add-Member -NotePropertyName $prop.Name -NotePropertyValue $prop.Value
        }
      }
    }

    if (-not $codex.command) { $codex | Add-Member -Force -NotePropertyName command -NotePropertyValue ([PSCustomObject]@{}) }
    if ($harness.command) {
      foreach ($prop in $harness.command.PSObject.Properties) {
        if (-not ($codex.command.PSObject.Properties | Where-Object { $_.Name -eq $prop.Name })) {
          $codex.command | Add-Member -NotePropertyName $prop.Name -NotePropertyValue $prop.Value
        }
      }
    }

    $codex | ConvertTo-Json -Depth 10 | Set-Content $codexCfg
    Write-Host "==> Updated codex config: $codexCfg"
  }
}

function Enable-StatusLine {
  foreach ($cli in $CLI -split ' ') {
    switch ($cli) {
      "claude" {
        $script = Get-ChildItem (Join-Path $HOME ".claude\plugins\cache\*\harness\*\scripts\statusline.sh") -ErrorAction SilentlyContinue |
                  Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if (-not $script) { Write-Warning "statusline.sh not found - is the harness plugin installed?"; continue }
        $settings = Join-Path $HOME ".claude\settings.json"
        New-Item -ItemType Directory -Force -Path (Split-Path $settings) | Out-Null
        $cfg = if (Test-Path $settings) { Get-Content $settings -Raw | ConvertFrom-Json } else { [PSCustomObject]@{} }
        $cfg | Add-Member -Force -NotePropertyName statusLine -NotePropertyValue ([PSCustomObject]@{ type = "command"; command = "bash $($script.FullName)" })
        $cfg | ConvertTo-Json -Depth 10 | Set-Content $settings
        Write-Host "==> Status line enabled in $settings"
      }
      "opencode" {
        $script = Join-Path $PSScriptRoot "scripts\statusline.sh"
        if (-not (Test-Path $script)) { Write-Warning "statusline.sh not found"; continue }
        $userCfg = Join-Path $HOME ".config\opencode\opencode.jsonc"
        New-Item -ItemType Directory -Force -Path (Split-Path $userCfg) | Out-Null
        if (-not (Test-Path $userCfg)) { '{}' | Set-Content $userCfg }
        # Use jq to add statusLine (JSONC needs comment stripping)
        if (Ensure-Jq) {
          $tmp = [System.IO.Path]::GetTempFileName()
          $raw = Get-Content $userCfg -Raw
          # Strip JSONC comments and trailing commas for jq
          $clean = $raw -replace '//.*$', '' -replace '/\*.*?\*/', '' -replace ',\s*}', '}' -replace ',\s*]', ']'
          $clean | jq --arg cmd "bash $script" '.statusLine = {type:"command", command:$cmd}' | Set-Content $tmp
          Move-Item $tmp $userCfg -Force
          Write-Host "==> Status line enabled in $userCfg"
        } else {
          Write-Host "   (jq required - add statusLine to $userCfg manually)"
        }
      }
    }
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
    foreach ($cli in $CLI -split ' ') {
      switch ($cli) {
        "claude" {
          $cfgFile = Get-ChildItem (Join-Path $HOME ".claude\plugins\cache\*\harness\*\config\settings.json") -ErrorAction SilentlyContinue |
                     Sort-Object LastWriteTime -Descending | Select-Object -First 1
          if (-not $cfgFile) { Write-Warning "shared config not found - is the harness plugin installed?"; continue }
          $settings = Join-Path $HOME ".claude\settings.json"
          New-Item -ItemType Directory -Force -Path (Split-Path $settings) | Out-Null
          $cfg = if (Test-Path $settings) { Get-Content $settings -Raw | ConvertFrom-Json } else { [PSCustomObject]@{} }
          $shared = Get-Content $cfgFile.FullName -Raw | ConvertFrom-Json
          foreach ($p in $shared.PSObject.Properties) { $cfg | Add-Member -Force -NotePropertyName $p.Name -NotePropertyValue $p.Value }
          $cfg | ConvertTo-Json -Depth 10 | Set-Content $settings
          Write-Host "==> Shared config merged into $settings"
        }
        "opencode" {
          $cfgFile = Join-Path $PSScriptRoot "config\settings.json"
          if (-not (Test-Path $cfgFile)) { continue }
          $userCfg = Join-Path $HOME ".config\opencode\opencode.jsonc"
          New-Item -ItemType Directory -Force -Path (Split-Path $userCfg) | Out-Null
          if (-not (Test-Path $userCfg)) { '{}' | Set-Content $userCfg }
          if (Ensure-Jq) {
            $tmp = [System.IO.Path]::GetTempFileName()
            $clean = (Get-Content $userCfg -Raw) -replace '//.*$', '' -replace '/\*.*?\*/', '' -replace ',\s*}', '}' -replace ',\s*]', ']'
            $clean | jq -s '.[0] * .[1]' - (Get-Content $cfgFile -Raw) | Set-Content $tmp
            Move-Item $tmp $userCfg -Force
            Write-Host "==> Shared config merged into $userCfg"
          }
        }
      }
    }
  } catch { Write-Warning "could not apply shared config: $_" }
}

function Restore-Home {
  foreach ($cli in $CLI -split ' ') {
    switch ($cli) {
      "claude" {
        $src = Get-ChildItem (Join-Path $HOME ".claude\plugins\cache\*\harness\*\config\home") -Directory -ErrorAction SilentlyContinue |
               Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if (-not $src -or -not (Get-ChildItem $src.FullName -Force -ErrorAction SilentlyContinue)) { continue }
        Copy-Item (Join-Path $src.FullName "*") (Join-Path $HOME ".claude") -Recurse -Force
        Write-Host "==> Restored backed-up user content into $(Join-Path $HOME '.claude')"
      }
      "opencode" {
        $src = Join-Path $PSScriptRoot "config\home"
        if (-not (Test-Path $src) -or -not (Get-ChildItem $src -Force -ErrorAction SilentlyContinue)) { continue }
        $dest = Join-Path $HOME ".config\opencode"
        New-Item -ItemType Directory -Force -Path $dest | Out-Null
        Copy-Item (Join-Path $src "*") $dest -Recurse -Force
        Write-Host "==> Restored backed-up user content into $dest"
      }
    }
  }
}

function Install-Mcps {
  if (-not (Ensure-Jq)) { Write-Host "   (jq required - add MCP servers by hand, see README)"; return }

  # Find config/mcp.json from plugin cache or local repo
  $cfgFile = Get-ChildItem (Join-Path $HOME ".claude\plugins\cache\*\harness\*\config\mcp.json") -ErrorAction SilentlyContinue |
             Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $cfgFile -and (Test-Path (Join-Path $PSScriptRoot "config\mcp.json"))) {
    $cfgFile = Get-Item (Join-Path $PSScriptRoot "config\mcp.json")
  }
  if (-not $cfgFile) { Write-Host "   (no MCP inventory found - nothing to add)"; return }
  $mcp = (Get-Content $cfgFile.FullName -Raw | ConvertFrom-Json).mcpServers
  if (-not $mcp) { Write-Host "   (no MCP servers in inventory)"; return }

  foreach ($cli in $CLI -split ' ') {
    switch ($cli) {
      "claude" {
        if ([Console]::IsInputRedirected) { Write-Host "   (no interactive console - skipping MCP setup)"; continue }
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
      }
      "opencode" {
        if ([Console]::IsInputRedirected) {
          Write-Host "   (no terminal - adding MCP servers without unresolved secrets)"
          $servers = @{}
          foreach ($name in $mcp.PSObject.Properties.Name) {
            $server = $mcp.$name
            $json = $server | ConvertTo-Json -Depth 10 -Compress
            $hasPlaceholder = [regex]::IsMatch($json, '\$\{[A-Za-z0-9_]+\}')
            if (-not $hasPlaceholder) { $servers[$name] = $server }
          }
          if ($servers.Count -gt 0) {
            $mcpObj = [PSCustomObject]@{ mcpServers = [PSCustomObject]@{} }
            foreach ($k in $servers.Keys) { $mcpObj.mcpServers | Add-Member -NotePropertyName $k -NotePropertyValue $servers[$k] }
            $mcpObj | ConvertTo-Json -Depth 10 | Set-Content ".mcp.json"
            Write-Host "==> Added MCP servers to .mcp.json (servers needing secrets were skipped)"
          }
          continue
        }
        $mergedMcp = @{}
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
          $mergedMcp[$name] = $server
          Write-Host "==> Selected MCP server: $name"
        }
        if ($mergedMcp.Count -gt 0) {
          $mcpObj = [PSCustomObject]@{ mcpServers = [PSCustomObject]@{} }
          foreach ($k in $mergedMcp.Keys) { $mcpObj.mcpServers | Add-Member -NotePropertyName $k -NotePropertyValue $mergedMcp[$k] }
          if (-not (Test-Path ".mcp.json")) {
            $mcpObj | ConvertTo-Json -Depth 10 | Set-Content ".mcp.json"
            Write-Host "==> Created .mcp.json with selected MCP servers"
          } else {
            # Merge into existing .mcp.json
            $existing = Get-Content ".mcp.json" -Raw | ConvertFrom-Json
            foreach ($k in $mergedMcp.Keys) {
              if (-not ($existing.mcpServers.PSObject.Properties | Where-Object { $_.Name -eq $k })) {
                $existing.mcpServers | Add-Member -NotePropertyName $k -NotePropertyValue $mergedMcp[$k]
              }
            }
            $existing | ConvertTo-Json -Depth 10 | Set-Content ".mcp.json"
            Write-Host "==> Updated .mcp.json with selected MCP servers"
          }
          # Also write MCP into opencode.json
          $userCfg = Join-Path $HOME ".config\opencode\opencode.jsonc"
          New-Item -ItemType Directory -Force -Path (Split-Path $userCfg) | Out-Null
          if (-not (Test-Path $userCfg)) { '{}' | Set-Content $userCfg }
          $clean = (Get-Content $userCfg -Raw) -replace '//.*$', '' -replace '/\*.*?\*/', '' -replace ',\s*}', '}' -replace ',\s*]', ']'
          $tmp = [System.IO.Path]::GetTempFileName()
          $mcJson = $mcpObj.mcpServers | ConvertTo-Json -Depth 10 -Compress
          $clean | jq --argjson mc "$mcJson" '.mcp = ((.mcp // {}) * $mc)' | Set-Content $tmp
          Move-Item $tmp $userCfg -Force
          Write-Host "==> MCP servers configured in $userCfg"
        }
      }
      "codex" {
        if ([Console]::IsInputRedirected) {
          Write-Host "   (no terminal - adding MCP servers without unresolved secrets)"
          $servers = @{}
          foreach ($name in $mcp.PSObject.Properties.Name) {
            $server = $mcp.$name
            $json = $server | ConvertTo-Json -Depth 10 -Compress
            $hasPlaceholder = [regex]::IsMatch($json, '\$\{[A-Za-z0-9_]+\}')
            if (-not $hasPlaceholder) { $servers[$name] = $server }
          }
          if ($servers.Count -gt 0) {
            $mcpObj = [PSCustomObject]@{ mcpServers = [PSCustomObject]@{} }
            foreach ($k in $servers.Keys) { $mcpObj.mcpServers | Add-Member -NotePropertyName $k -NotePropertyValue $servers[$k] }
            $mcpObj | ConvertTo-Json -Depth 10 | Set-Content ".mcp.json"
            Write-Host "==> Added MCP servers to .mcp.json (servers needing secrets were skipped)"
          }
          continue
        }
        $mergedMcp = @{}
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
          $mergedMcp[$name] = $server
          Write-Host "==> Selected MCP server: $name"
        }
        if ($mergedMcp.Count -gt 0) {
          $mcpObj = [PSCustomObject]@{ mcpServers = [PSCustomObject]@{} }
          foreach ($k in $mergedMcp.Keys) { $mcpObj.mcpServers | Add-Member -NotePropertyName $k -NotePropertyValue $mergedMcp[$k] }
          if (-not (Test-Path ".mcp.json")) {
            $mcpObj | ConvertTo-Json -Depth 10 | Set-Content ".mcp.json"
            Write-Host "==> Created .mcp.json with selected MCP servers"
          } else {
            $existing = Get-Content ".mcp.json" -Raw | ConvertFrom-Json
            foreach ($k in $mergedMcp.Keys) {
              if (-not ($existing.mcpServers.PSObject.Properties | Where-Object { $_.Name -eq $k })) {
                $existing.mcpServers | Add-Member -NotePropertyName $k -NotePropertyValue $mergedMcp[$k]
              }
            }
            $existing | ConvertTo-Json -Depth 10 | Set-Content ".mcp.json"
            Write-Host "==> Updated .mcp.json with selected MCP servers"
          }
        }
      }
    }
  }
}

# Add marketplace for Claude Code
if ($CLI -match 'claude') {
  Write-Host "==> Adding marketplace: $Marketplace"
  if (-not $DryRun) { try { claude plugin marketplace add $Marketplace } catch { claude plugin marketplace update $MarketplaceName } }
}

# Select installation scope (only for Claude Code)
if ($CLI -match 'claude') {
  $selectedScope = Select-Scope
  Write-Host "==> Installation scope: $selectedScope"
}

$items = @()
foreach ($p in $Required) {
  if (Test-PluginSupported $p $CLI) {
    $items += [pscustomobject]@{ Type = "plugin"; Key = $p; Label = $p; Checked = $true }
  } else {
    Write-Host "   (skipped $p - not supported by any detected CLI)"
  }
}
foreach ($p in $Optional) {
  if (Test-PluginSupported $p $CLI) {
    $items += [pscustomobject]@{ Type = "plugin"; Key = $p; Label = $p; Checked = $false }
  }
}
if ($CLI -match 'claude') {
  $items += [pscustomobject]@{ Type = "extra"; Key = "statusline";   Label = "status line - context %, rate limits, git, tmux"; Checked = $false }
  $items += [pscustomobject]@{ Type = "extra"; Key = "sharedconfig"; Label = "shared config - model, notifications, Remote Control"; Checked = $false }
  $items += [pscustomobject]@{ Type = "extra"; Key = "mcpservers";   Label = "MCP servers - pick which, with your API keys"; Checked = $false }
}
if ($CLI -match 'opencode') {
  $items += [pscustomobject]@{ Type = "extra"; Key = "statusline";   Label = "status line - context %, rate limits, git, tmux"; Checked = $false }
  $items += [pscustomobject]@{ Type = "extra"; Key = "mcpservers";   Label = "MCP servers - pick which, with your API keys"; Checked = $false }
}
if ($CLI -match 'codex') {
  $items += [pscustomobject]@{ Type = "extra"; Key = "mcpservers";   Label = "MCP servers - pick which, with your API keys"; Checked = $false }
}

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
Write-Host "==> Done. Restart your CLI to load everything."
