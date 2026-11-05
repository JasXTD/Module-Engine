#Requires -Version 7.0
param(
    [Parameter(Mandatory)][string]$CyberAssistRoot,
    [switch]$Check
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'reviewed-domain-tools.ps1')
. (Join-Path $PSScriptRoot 'rule-tools.ps1')
$source = Join-Path $PSScriptRoot '..\rules\reviewed-domains.json'
$catalog = Read-ReviewedDomainCatalog $source
$current = Read-ReviewedDomainCatalog (Join-Path $PSScriptRoot '..\lists\reviewed-domains.json')
if ($catalog.Json -cne $current.Json) { throw 'Generated catalog differs from reviewed source. Rebuild Module Engine first.' }
$root = [IO.Path]::GetFullPath($CyberAssistRoot)
if (!(Test-Path -LiteralPath (Join-Path $root 'CyberAssist\CyberAssist.Core.csproj') -PathType Leaf)) { throw 'Expected the CyberAssist repository root.' }
$directory = Join-Path $root 'CyberAssist\Intel'
$target = Join-Path $directory 'reviewed-domains.json'
for ($candidate = $directory; $candidate; $candidate = [IO.Path]::GetDirectoryName($candidate)) {
    if ((Get-Item -LiteralPath $candidate -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Import path must not cross a reparse point.' }
}
if ((Test-Path -LiteralPath $target) -and ((Get-Item -LiteralPath $target).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Import target must be a regular file.' }
$bytes = [Text.UTF8Encoding]::new($false).GetBytes($catalog.Json + "`n")
function Test-ImportMatches {
    return (Test-Path -LiteralPath $target) -and (Get-Item -LiteralPath $target -Force).Length -eq $bytes.Length -and
        ([Convert]::ToBase64String([IO.File]::ReadAllBytes($target)) -ceq [Convert]::ToBase64String($bytes))
}
if ($Check) {
    if (!(Test-ImportMatches)) { throw 'CyberAssist embedded catalog is out of sync. Run this exporter without -Check, then rebuild in isolation.' }
    Write-Host "PASS: CyberAssist catalog matches all $($catalog.Domains.Count) reviewed domains."
    return
}
$buildLock = [IO.File]::Open((Join-Path $directory '.domain-import.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
try {
    if (Test-ImportMatches) { Write-Host 'Catalog already matches; no files changed.'; return }
    $backup = Join-Path $root ('.artifacts\domain-imports\' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    if (Test-Path -LiteralPath $target) { Copy-Item -LiteralPath $target -Destination (Join-Path $backup 'reviewed-domains.before.json') }
    Write-RuleOutputs -Directory $directory -Outputs @{ 'reviewed-domains.json' = $catalog.Json }
    Write-Host "Imported $($catalog.Domains.Count) observation-only domains into source. Backup: $backup. Build required; no running application was changed."
} finally { $buildLock.Dispose() }
