# codemyrules: runs PSScriptAnalyzer on the given files and prints one JSON array of findings for the lint loop.
# Invoke-ScriptAnalyzer takes one -Path, so this loops over the files; -AsArray keeps one finding a list.
# Needs PowerShell 7 (pwsh): Windows PowerShell 5.1 has no ConvertTo-Json -AsArray.
param(
  [string]$Settings,
  [Parameter(ValueFromRemainingArguments)][string[]]$Files
)
$ErrorActionPreference = 'Stop'
Import-Module PSScriptAnalyzer
$opts = @{}
# a settings file that does not exist must fail, not fall back to the default rules
if ($Settings) { $opts.Settings = (Resolve-Path -LiteralPath $Settings).ProviderPath }
$found = foreach ($f in $Files) {
  # a file deleted since the edit has nothing to lint
  if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { continue }
  # -Path takes wildcards, so a name like "a [1].ps1" is escaped to mean itself
  Invoke-ScriptAnalyzer -Path ([WildcardPattern]::Escape((Resolve-Path -LiteralPath $f).ProviderPath)) @opts
}
$out = @($found | Select-Object RuleName, Severity, Line, Message, ScriptPath)
# piped, not -InputObject, which -AsArray wraps in a second array; an empty pipe prints nothing, so [] by hand
if ($out.Count) { $out | ConvertTo-Json -AsArray -Depth 2 -EnumsAsStrings } else { '[]' }
