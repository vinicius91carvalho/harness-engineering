param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Args
)
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& node (Join-Path $ScriptDir "lib/claim-lease-cli.mjs") @Args
exit $LASTEXITCODE
