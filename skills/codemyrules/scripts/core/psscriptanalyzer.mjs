// PSScriptAnalyzer (PowerShell) in the lint loop. Its wrapper, psscriptanalyzer.ps1 beside this file,
// runs Invoke-ScriptAnalyzer on each file and prints one JSON array with the severity by name.

export const FORMAT = 'psscriptanalyzer';

// findings with the file as PSScriptAnalyzer reports it (absolute). Every finding blocks, as with Ruff: built-in
// severities are fixed (named parameters and correct casing are only Information), and the settings file decides
// which rules run
export const findings = (data) => data.map((m) => ({
  file: m.ScriptPath, line: m.Line ?? 0, ruleId: m.RuleName, message: m.Message, severity: 'error',
}));

// config errors for one loop.json linter entry of this format; exists(path) checks a path from the folder the linter runs in
export function validate(l, at, exists) {
  const errs = [];
  if (l.tier === 'fast') errs.push(`${at}: PowerShell and PSScriptAnalyzer need seconds to start, too slow for every edit; put it in the full tier`);
  const i = Array.isArray(l.command) ? l.command.indexOf('-Settings') : -1;
  const settings = i >= 0 ? l.command[i + 1] : undefined;
  if (settings && settings !== '{files}' && !exists(settings)) errs.push(`${at}: the settings "${settings}" after -Settings do not exist in the project; every run would fail`);
  return errs;
}
