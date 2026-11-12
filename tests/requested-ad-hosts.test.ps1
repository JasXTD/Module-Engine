#Requires -Version 7.0
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot
. (Join-Path $root 'scripts/reviewed-domain-tools.ps1')
. (Join-Path $root 'scripts/requested-ad-host-tools.ps1')
$work=Join-Path ([IO.Path]::GetTempPath()) ('blockads-requested-hosts-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
$fixture=Join-Path $work 'fixture.json'
$source=Get-Content (Join-Path $root 'lists/requested-ad-hosts.json') -Raw
$script:checks=0
function Check($condition,[string]$message) { if (!$condition) { throw $message }; $script:checks++ }
function Write-Fixture($value) { [IO.File]::WriteAllText($fixture,($value | ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false)) }
$result=Read-RequestedAdHosts (Join-Path $root 'lists/requested-ad-hosts.json')
$rule=$result.Rules[0]
Check ($result.Rules.Count -eq 1 -and $rule.id -eq 200001 -and $rule.priority -eq 4 -and $rule.action.type -ceq 'block') 'explicit user preference has a bounded, separate ad rule ID and priority'
Check ($rule.condition.resourceTypes.Count -eq 12 -and $rule.condition.resourceTypes -contains 'main_frame') 'navigation and all supported resource types are covered'
foreach ($url in @('https://pxl.wheelroot.com/fixture','http://pxl.wheelroot.com:8080/fixture','https://user:pass@pxl.wheelroot.com./fixture','wss://pxl.wheelroot.com/fixture')) {
    Check ($url -match $rule.condition.regexFilter) 'exact requested host matches without contacting it'
}
foreach ($url in @('https://wheelroot.com/fixture','https://other.wheelroot.com/fixture','https://child.pxl.wheelroot.com/fixture','https://pxl.wheelroot.com.other.net/fixture','https://ordinary.net/?next=pxl.wheelroot.com/fixture')) {
    Check ($url -notmatch $rule.condition.regexFilter) 'a parent, sibling, child, lookalike or query reference is outside the request'
}
$mutations=@(
    { param($v) $v.schemaVersion=2 },
    { param($v) $v.reviewKind='confirmed-malware' },
    { param($v) $v.extra=$true },
    { param($v) $v.hosts[0].domain='*.wheelroot.com' },
    { param($v) $v.hosts[0].domain='https://pxl.wheelroot.com' },
    { param($v) $v.hosts[0].domain='PXL.WHEELROOT.COM' },
    { param($v) $v.hosts[0].match='subdomains' },
    { param($v) $v.hosts[0].requestedOn='2026-02-31' },
    { param($v) $v.hosts[0].reason='' },
    { param($v) $v.hosts[0].reason="bad`nmetadata" },
    { param($v) $v.hosts[0].extra='ignored?' },
    { param($v) $v.hosts+=@($v.hosts[0]) },
    { param($v) $v.hosts=@($v.hosts[0])*501 }
)
foreach ($mutate in $mutations) {
    $value=$source | ConvertFrom-Json -AsHashtable
    & $mutate $value
    Write-Fixture $value
    $failed=$false
    try { Read-RequestedAdHosts $fixture | Out-Null } catch { $failed=$true }
    Check $failed 'invalid requested-host data is rejected'
}
$output=Join-Path $work 'output';New-Item -ItemType Directory -Path $output | Out-Null
$sentinel=Join-Path $output 'ads.json';[IO.File]::WriteAllText($sentinel,'preserve prior output')
$failed=$false
try { & (Join-Path $root 'scripts/build-rules.ps1') -RequestedAdHostsPath $fixture -OutputDirectory $output | Out-Null } catch { $failed=$true }
Check ($failed -and [IO.File]::ReadAllText($sentinel) -ceq 'preserve prior output' -and @(Get-ChildItem $output).Count -eq 1) 'invalid user requests cannot partially publish rule outputs'
Write-Fixture @{schemaVersion=1;reviewKind='user-requested-ad-hosts';hosts=@()}
Check ((Read-RequestedAdHosts $fixture).Rules.Count -eq 0) 'an empty preference list is valid'
Write-Host "PASS: $script:checks requested-host assertions. Offline strings and temporary files only."
