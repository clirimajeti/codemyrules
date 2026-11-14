// PSScriptAnalyzer in the loop: the parser on recorded output, and the shipped wrapper against the real pwsh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseLinterOutput, runLinters } from '../core/lib.mjs';

const WRAPPER = fileURLToPath(new URL('../core/psscriptanalyzer.ps1', import.meta.url));

test('parseLinterOutput psscriptanalyzer: every severity blocks, the settings decide which rules run', () => {
  const cwd = path.resolve('/repo');
  const rec = (Severity, RuleName) => ({ RuleName, Severity, Line: 3, Message: 'm', ScriptPath: path.join(cwd, 'src', 'a.ps1') });
  const out = JSON.stringify([rec('Error', 'PSAvoidUsingPlainTextForPassword'), rec('Warning', 'PSAvoidUsingCmdletAliases'), rec('ParseError', 'MissingEndCurlyBrace'), rec('Information', 'PSProvideCommentHelp')]);
  assert.deepEqual(parseLinterOutput('psscriptanalyzer', out, cwd).map((f) => f.severity), ['error', 'error', 'error', 'error']);
  assert.deepEqual(parseLinterOutput('psscriptanalyzer', out, cwd)[1], { file: 'src/a.ps1', line: 3, ruleId: 'PSAvoidUsingCmdletAliases', message: 'm', severity: 'error' });
  assert.deepEqual(parseLinterOutput('psscriptanalyzer', '[]', cwd), []);
});

// CI must run this against the real tools; a dev machine without pwsh skips it
const pwsh = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'if (Get-Module -ListAvailable PSScriptAnalyzer) { "ok" }'], { encoding: 'utf8' });
const ready = pwsh.stdout?.trim() === 'ok';
const opts = { skip: !ready && !process.env.CI && 'pwsh with PSScriptAnalyzer is not installed', timeout: 120000 };
const linter = (settings) => ({ name: 'psscriptanalyzer', format: 'psscriptanalyzer', tier: 'full', extensions: ['.ps1', '.psm1'],
  command: ['pwsh', '-NoProfile', '-NonInteractive', '-File', WRAPPER, ...(settings ? ['-Settings', settings] : []), '{files}'] });

test('the wrapper runs PSScriptAnalyzer on each file and the loop reads its findings', opts, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-psa-'));
  try {
    fs.writeFileSync(path.join(dir, 'PSScriptAnalyzerSettings.psd1'), "@{ IncludeRules = @('PSAvoidUsingCmdletAliases') }\n");
    fs.mkdirSync(path.join(dir, 'odd dir'));
    // a space, wildcard brackets and a leading dash: every name must reach PSScriptAnalyzer as written
    for (const f of ['a.ps1', 'odd dir/b [1].ps1', '-c.psm1']) fs.writeFileSync(path.join(dir, f), 'function Get-X {\n  gci .\n}\n');
    fs.writeFileSync(path.join(dir, 'clean.ps1'), 'Get-ChildItem .\n');
    // gone.ps1 was deleted after the edit: skipped, not a failed run
    const r = runLinters(dir, [linter('PSScriptAnalyzerSettings.psd1')], ['a.ps1', 'odd dir/b [1].ps1', '-c.psm1', 'clean.ps1', 'gone.ps1'], 120000);
    assert.deepEqual(r.notes, []);
    assert.deepEqual(r.findings.map((f) => [f.file, f.line, f.ruleId, f.severity]).sort(), [
      ['-c.psm1', 2, 'PSAvoidUsingCmdletAliases', 'error'],
      ['a.ps1', 2, 'PSAvoidUsingCmdletAliases', 'error'],
      ['odd dir/b [1].ps1', 2, 'PSAvoidUsingCmdletAliases', 'error'],
    ]);
    // one clean file is an empty list, not nothing
    assert.deepEqual(runLinters(dir, [linter('PSScriptAnalyzerSettings.psd1')], ['clean.ps1'], 120000), { findings: [], notes: [] });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the wrapper runs a custom rule module from the settings', opts, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-psa-'));
  try {
    fs.mkdirSync(path.join(dir, 'PSScriptAnalyzerRules'));
    fs.writeFileSync(path.join(dir, 'PSScriptAnalyzerRules', 'ProjectRules.psm1'), `
function Measure-NoWriteHostInModule {
  [CmdletBinding()]
  [OutputType([Microsoft.Windows.PowerShell.ScriptAnalyzer.Generic.DiagnosticRecord[]])]
  param([Parameter(Mandatory)][System.Management.Automation.Language.ScriptBlockAst]$ScriptBlockAst)
  $ScriptBlockAst.FindAll({ param($a) $a -is [System.Management.Automation.Language.CommandAst] -and $a.GetCommandName() -eq 'Write-Host' }, $false) | ForEach-Object {
    [Microsoft.Windows.PowerShell.ScriptAnalyzer.Generic.DiagnosticRecord]@{
      Message = 'Use Write-Information, not Write-Host (STYLE.md: output).'; Extent = $_.Extent
      RuleName = 'Measure-NoWriteHostInModule'; Severity = 'Error'
    }
  }
}
Export-ModuleMember -Function Measure-*
`);
    fs.writeFileSync(path.join(dir, 'PSScriptAnalyzerSettings.psd1'), "@{ CustomRulePath = @('PSScriptAnalyzerRules/ProjectRules.psm1'); IncludeRules = @('Measure-*') }\n");
    // a hit at the top and one inside a function: FindAll(..., $false) reports each once, though the rule runs per script block
    fs.writeFileSync(path.join(dir, 'a.ps1'), "Write-Host 'hi'\nfunction Get-X {\n  Write-Host 'x'\n}\n");
    const r = runLinters(dir, [linter('PSScriptAnalyzerSettings.psd1')], ['a.ps1'], 120000);
    assert.deepEqual(r.notes, []);
    assert.deepEqual(r.findings.map((f) => [f.file, f.line, f.ruleId, f.severity]).sort(), [['a.ps1', 1, 'Measure-NoWriteHostInModule', 'error'], ['a.ps1', 3, 'Measure-NoWriteHostInModule', 'error']]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a missing settings file is a failure note, not a clean run', opts, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-psa-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.ps1'), 'gci .\n');
    const r = runLinters(dir, [linter('nope.psd1')], ['a.ps1'], 120000);
    assert.deepEqual(r.findings, []);
    assert.match(r.notes.join('\n'), /^codemyrules: psscriptanalyzer failed:/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
