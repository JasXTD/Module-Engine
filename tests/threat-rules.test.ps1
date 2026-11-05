#Requires -Version 7.0
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
. (Join-Path $root 'scripts/reviewed-domain-tools.ps1')
. (Join-Path $root 'scripts/threat-report-tools.ps1')
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('blockads-threat-rules-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporary | Out-Null
$fixturePath = Join-Path $temporary 'evidence.json'
$output = Join-Path $temporary 'rules'
$builder = Join-Path $root 'scripts/build-rules.ps1'
$original = Get-Content -LiteralPath (Join-Path $root 'lists/reported-threats.json') -Raw
$script:checks = 0
function Assert-True($Condition, [string]$Description) {
    if (!$Condition) { throw "FAILED: $Description" }
    $script:checks++
}
function Snapshot {
    return (Get-ChildItem -LiteralPath $output -Filter '*.json' | Sort-Object Name | ForEach-Object {
        $_.Name + ':' + (Get-FileHash -LiteralPath $_.FullName).Hash
    }) -join ','
}
& $builder -OutputDirectory $output
$baseline = Snapshot
$catalog = $original | ConvertFrom-Json -AsHashtable
$result = Read-ThreatReportCatalog (Join-Path $root 'lists/reported-threats.json') ([DateTimeOffset]'2026-10-18T04:00:00Z')
Assert-True ($result.Rules.Count -eq 24) '24 independently dated exact hosts'
Assert-True ($result.Policy.expiresAt -ceq '2026-11-30T00:00:00Z') '90 days from conservative September 1 floor'
$display = Get-Content -LiteralPath (Join-Path $output 'threat-evidence.json') -Raw | ConvertFrom-Json -AsHashtable
Assert-True ($display.schemaVersion -eq 1 -and $display.catalog.domains.Count -eq 24) 'display bundle contains only validated reported hosts'
Assert-True ($display.rulesSha256 -ceq (Get-FileHash -LiteralPath (Join-Path $output 'threats.json')).Hash.ToLowerInvariant()) 'display bundle binds the exact published rule bytes'
Assert-True ($display.policySha256 -ceq (Get-FileHash -LiteralPath (Join-Path $output 'threat-policy.json')).Hash.ToLowerInvariant()) 'display bundle binds the exact published policy bytes'
Assert-True ($display.catalog.domains[0].observedOn -ceq $catalog.domains[0].observedOn) 'display retains month-only precision'
$unverified = (Read-ReviewedDomainCatalog (Join-Path $root 'lists/reviewed-domains.json')).Domains | Where-Object category -CEQ 'unverified'
foreach ($entry in $unverified) { Assert-True ($entry.domain -cnotin $catalog.domains.host) 'legacy unverified records remain excluded' }
for ($i = 0; $i -lt $result.Rules.Count; $i++) {
    $rule = $result.Rules[$i]
    $hostName = $catalog.domains[$i].host
    Assert-True ($rule.condition.resourceTypes.Count -eq 12 -and $rule.action.type -ceq 'block') 'all supported web resource types blocked'
    foreach ($url in @("https://$hostName/fixture", "http://${hostName}:8080/fixture", "wss://${hostName}:8443/fixture", "https://${hostName}./fixture")) {
        Assert-True ($url -match $rule.condition.regexFilter) 'exact host including root dot and port matches'
    }
    foreach ($url in @("https://child.$hostName/fixture", "https://$hostName.example/fixture", "https://prefix$hostName/fixture", "https://safe.example/$hostName/fixture")) {
        Assert-True ($url -notmatch $rule.condition.regexFilter) 'no inferred subdomain or lookalike blocking'
    }
}
foreach ($fault in @('undated','future-observation','invalid-date','old-at-review','future-review','bad-policy','scope','duplicate-host',
    'unknown-source','suspected','root-platform','unknown-field','duplicate-key','source-http','source-host','source-userinfo','source-txt','missing-section','too-many','invalid-utf8','oversized')) {
    $fixture = $original | ConvertFrom-Json -AsHashtable
    switch ($fault) {
        'undated' { $fixture.domains[0].observedOn = '' }
        'future-observation' { $fixture.domains[0].observedOn = '2026-09-10' }
        'invalid-date' { $fixture.domains[0].observedOn = '2026-09-31' }
        'old-at-review' { $fixture.domains[0].observedOn = '2026-01' }
        'future-review' { $fixture.reviewedOn = '2099-01-01' }
        'bad-policy' { $fixture.maxAgeDays = 365 }
        'scope' { $fixture.domains[0].match = 'subdomains' }
        'duplicate-host' { $fixture.domains += $fixture.domains[0] }
        'unknown-source' { $fixture.domains[0].sourceId = 'unknown' }
        'suspected' { $fixture.domains[0].role = 'suspected' }
        'root-platform' { $fixture.domains[0].host = 'workers.dev' }
        'unknown-field' { $fixture.domains[0].confidence = 100 }
        'source-http' { $fixture.sources[0].url = 'http://www.proofpoint.com/blog/report' }
        'source-host' { $fixture.sources[0].url = 'https://www.proofpoint.com.example/blog/report' }
        'source-userinfo' { $fixture.sources[0].url = 'https://test@www.proofpoint.com/blog/report' }
        'source-txt' { $fixture.sources[0].url = 'https://www.proofpoint.com/blog/report.%54Xt' }
        'missing-section' { $fixture.domains[0].Remove('section') }
        'too-many' { $fixture.domains = @($fixture.domains[0]) * 101 }
    }
    $json = $fixture | ConvertTo-Json -Depth 10
    if ($fault -eq 'duplicate-key') { $json = $json.Replace('"schemaVersion": 1', '"schemaVersion": 1, "schemaVersion": 1') }
    if ($fault -eq 'oversized') { $json = 'x' * (128KB + 1) }
    [IO.File]::WriteAllText($fixturePath, $json)
    if ($fault -eq 'invalid-utf8') { [IO.File]::WriteAllBytes($fixturePath, [byte[]](0xff, 0xfe)) }
    $rejected = $false
    try { & $builder -OutputDirectory $output -ThreatCatalogPath $fixturePath } catch { $rejected = $true }
    Assert-True $rejected "reject $fault"
    Assert-True ((Snapshot) -ceq $baseline) "failed $fault input preserves all published files"
}
# A later rebuild cannot launder evidence age. The runtime must retire this bundle.
$late = Read-ThreatReportCatalog (Join-Path $root 'lists/reported-threats.json') ([DateTimeOffset]'2027-01-01T00:00:00Z')
Assert-True ($late.Policy.expiresAt -ceq $result.Policy.expiresAt) 'rebuild does not extend expiry'
Write-Host "PASS: $script:checks threat evidence/build assertions. Isolated fixture directory: $temporary"
