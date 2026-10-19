#Requires -Version 7.0
$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('blockads-rules-test-' + [Guid]::NewGuid().ToString('N'))
$output = Join-Path $temporary 'rules'
$builder = Join-Path $project 'scripts/build-rules.ps1'
New-Item -ItemType Directory -Path $temporary | Out-Null
. (Join-Path $project 'scripts/rule-tools.ps1')
. (Join-Path $project 'scripts/reviewed-domain-tools.ps1')
$script:checks = 0
function Assert-True($Condition, [string]$Message) {
    if (!$Condition) { throw "FAIL: $Message" }
    $script:checks++
}
function Get-OutputSnapshot {
    return ((Get-ChildItem -LiteralPath $output -Filter '*.json' | Sort-Object Name |
        ForEach-Object { $_.Name + ':' + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }) -join '|')
}
function Assert-FailedUnchanged([scriptblock]$Operation, [string]$Name) {
    $before = Get-OutputSnapshot
    $failed = $false
    try { & $Operation | Out-Null } catch { $failed = $true }
    Assert-True $failed "$Name must report failure"
    Assert-True ((Get-OutputSnapshot) -ceq $before) "$Name must preserve generated files"
}
$fixturePath = Join-Path $temporary 'fixture.json'
$catalogJson = [IO.File]::ReadAllText((Join-Path $project 'lists/reviewed-domains.json'))
function New-Fixture {
    $fixture = $catalogJson | ConvertFrom-Json -AsHashtable
    $fixture.reviewedAtUtc = '2026-10-18T01:00:00Z'
    $fixture.domains = @(
        ($fixture.domains | Where-Object category -CEQ 'ads' | Select-Object -First 1),
        ($fixture.domains | Where-Object category -CEQ 'trackers' | Select-Object -First 1),
        ($fixture.domains | Where-Object category -CEQ 'unverified' | Select-Object -First 1)
    )
    $fixture.domains[0].domain = 'ad.fixture-unit.net'
    $fixture.domains[1].domain = 'exact.fixture-unit.net'
    $fixture.domains[1].match = 'exact'
    $fixture.domains[2].domain = 'unverified.fixture-unit.net'
    foreach ($domain in $fixture.domains) { $domain.sourceRuleId = 1 }
    return $fixture
}
function Write-Fixture($Value) {
    [IO.File]::WriteAllText($fixturePath, (ConvertTo-Json -InputObject $Value -Depth 12), [Text.UTF8Encoding]::new($false))
}
try {
    & $builder -OutputDirectory $output
    $adRules = Get-Content (Join-Path $output 'ads.json') -Raw | ConvertFrom-Json
    $trackers = Get-Content (Join-Path $output 'trackers.json') -Raw | ConvertFrom-Json
    $malware = Get-Content (Join-Path $output 'malware.json') -Raw | ConvertFrom-Json
    $catalog = Read-ReviewedDomainCatalog (Join-Path $output 'reviewed-domains.json')
    Assert-True ($adRules.Count -eq 100) 'reviewed ad domain and browser-only patterns preserved'
    Assert-True ($trackers.Count -eq 80) 'tracker rules preserved'
    Assert-True (@($malware).Count -eq 0) 'no unsupported malware blocking'
    Assert-True ($catalog.Domains.Count -eq 247) 'all reviewed domains exported'
    Assert-True (@($catalog.Domains | Where-Object category -CEQ 'unverified').Count -eq 73) 'unverified domains retained separately'
    foreach ($entry in $catalog.Domains | Where-Object category -CEQ 'unverified') {
        Assert-True (($adRules.condition.urlFilter + $trackers.condition.urlFilter) -cnotcontains ('||' + $entry.domain + '^')) 'unverified domain is absent from active rules'
    }
    Assert-True (@($trackers | Where-Object { $_.condition.domainType -cne 'thirdParty' }).Count -eq 0) 'third-party tracker scope preserved'
    $snapshot = Get-OutputSnapshot
    & $builder -OutputDirectory $output
    Assert-True ((Get-OutputSnapshot) -ceq $snapshot) 'offline rebuild is deterministic'
    # These legacy switches now fail immediately; the old network implementation was removed.
    Assert-FailedUnchanged { & $builder -OutputDirectory $output -FetchOnlineLists } 'retired online import'
    Assert-FailedUnchanged { & $builder -OutputDirectory $output -UrlhausCsvPath 'unused.csv' } 'unreviewed URL import'
    Assert-True ((ConvertTo-ReviewedHostname 'UPPER.fixture-unit.net.') -ceq 'upper.fixture-unit.net') 'hostname normalization'
    # Build an exact-host fixture; these inert strings are never resolved or requested.
    Write-Fixture (New-Fixture)
    & $builder -OutputDirectory $output -CatalogPath $fixturePath
    $exact = (Get-Content (Join-Path $output 'trackers.json') -Raw | ConvertFrom-Json)[0].condition.regexFilter
    Assert-True ('https://exact.fixture-unit.net:8443/a.js' -cmatch $exact) 'exact rule matches the apex'
    foreach ($url in @('https://child.exact.fixture-unit.net/a.js','https://badexact.fixture-unit.net/a.js','https://exact.fixture-unit.net.evil.net/a.js')) {
        Assert-True ($url -cnotmatch $exact) 'exact rule excludes children and suffix traps'
    }
    foreach ($hostName in @('a.invalid','a.test','a.example','example.com','sub.example.net','a.local','a.onion','co.uk','com.au',
        'localhost','192.0.2.1','[::1]','a..com','-a.com','*.fixture-unit.net','UPPER.fixture-unit.net','ad.fixture-unit.net.','ad.fixture-unit.net/route')) {
        $fixture = New-Fixture
        $fixture.domains[0].domain = $hostName
        Write-Fixture $fixture
        Assert-FailedUnchanged { & $builder -OutputDirectory $output -CatalogPath $fixturePath } "invalid domain $hostName"
    }
    foreach ($fault in @('duplicate-domain','duplicate-source','duplicate-rule','missing-source','category','category-source','freshness',
        'expiry','future-review','hash','unknown-field','missing-field','scope','resource','duplicate-resource','priority','record-limit')) {
        $fixture = New-Fixture
        switch ($fault) {
            'duplicate-domain' { $fixture.domains += $fixture.domains[0] }
            'duplicate-source' { $fixture.sources[1] = $fixture.sources[0] }
            'duplicate-rule' { $entry = ($fixture.domains[0] | ConvertTo-Json -Depth 8 | ConvertFrom-Json -AsHashtable); $entry.domain='other.fixture-unit.net'; $fixture.domains += $entry }
            'missing-source' { $fixture.domains[0].sourceId = 'missing' }
            'category' { $fixture.domains[0].category = 'malware' }
            'category-source' { $fixture.domains[0].category = 'trackers' }
            'freshness' { $fixture.sources[0].lastVerifiedUtc = '2026-10-18T00:00:00Z' }
            'expiry' { $fixture.sources[0].expiresUtc = '2099-01-01T00:00:00Z' }
            'future-review' { $fixture.reviewedAtUtc = '2099-01-01T00:00:00Z' }
            'hash' { $fixture.sources[0].sha256 = 'not-a-hash' }
            'unknown-field' { $fixture.domains[0].command = 'inert-text' }
            'missing-field' { $fixture.domains[0].Remove('match') }
            'scope' { $fixture.domains[0].browser.domainType = 'unknown' }
            'resource' { $fixture.domains[0].browser.resourceTypes = @('beacon') }
            'duplicate-resource' { $fixture.domains[0].browser.resourceTypes = @('script','script') }
            'priority' { $fixture.domains[0].browser.priority = 10000 }
            'record-limit' { $fixture.domains = @($fixture.domains[0]) * 5001 }
        }
        Write-Fixture $fixture
        Assert-FailedUnchanged { & $builder -OutputDirectory $output -CatalogPath $fixturePath } $fault
    }
    [IO.File]::WriteAllText($fixturePath, $catalogJson.Replace('"schemaVersion": 1', '"schemaVersion": 1, "schemaVersion": 1'))
    Assert-FailedUnchanged { & $builder -OutputDirectory $output -CatalogPath $fixturePath } 'duplicate JSON key'
    [IO.File]::WriteAllBytes($fixturePath, [byte[]](0xff, 0xfe))
    Assert-FailedUnchanged { & $builder -OutputDirectory $output -CatalogPath $fixturePath } 'invalid UTF-8'
    [IO.File]::WriteAllText($fixturePath, ('x' * (1MB + 1)))
    Assert-FailedUnchanged { & $builder -OutputDirectory $output -CatalogPath $fixturePath } 'oversized catalog'
    $lock = [IO.File]::Open((Join-Path $output '.build.lock'), 'Open', 'ReadWrite', 'None')
    try { Assert-FailedUnchanged { & $builder -OutputDirectory $output } 'concurrent build' }
    finally { $lock.Dispose() }

    # Transactional publication: fail after the first replacement, preserving both old files.
    $publish = Join-Path $temporary 'publication'
    New-Item -ItemType Directory -Path $publish | Out-Null
    [IO.File]::WriteAllText((Join-Path $publish 'a.json'), 'old a')
    [IO.File]::WriteAllText((Join-Path $publish 'b.json'), 'old b')
    $held = [IO.File]::Open((Join-Path $publish 'b.json'), 'Open', 'Read', 'Read')
    $failed = $false
    try { Write-RuleOutputs $publish @{ 'a.json' = 'new a'; 'b.json' = 'new b' } }
    catch { $failed = $true }
    finally { $held.Dispose() }
    Assert-True $failed 'publication error is surfaced'
    Assert-True ([IO.File]::ReadAllText((Join-Path $publish 'a.json')) -ceq 'old a') 'published file rolled back'
    Assert-True ([IO.File]::ReadAllText((Join-Path $publish 'b.json')) -ceq 'old b') 'unpublished file unchanged'
    Assert-True (@(Get-ChildItem -LiteralPath $publish -Filter '*.tmp' -Force).Count -eq 0) 'staging files cleaned up'

    # Export to a disposable fake checkout, never the running application's directory.
    $fakeRoot = Join-Path $temporary 'CyberAssist'
    New-Item -ItemType Directory -Path (Join-Path $fakeRoot 'CyberAssist/Intel') -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $fakeRoot 'CyberAssist/CyberAssist.Core.csproj'), '<Project />')
    $exporter = Join-Path $project 'scripts/export-cyberassist.ps1'
    & $exporter -CyberAssistRoot $fakeRoot
    & $exporter -CyberAssistRoot $fakeRoot -Check
    Assert-True ((Read-ReviewedDomainCatalog (Join-Path $fakeRoot 'CyberAssist/Intel/reviewed-domains.json')).Domains.Count -eq 247) 'export is validated and complete'
    [IO.File]::AppendAllText((Join-Path $fakeRoot 'CyberAssist/Intel/reviewed-domains.json'), 'tamper')
    $failed = $false
    try { & $exporter -CyberAssistRoot $fakeRoot -Check } catch { $failed = $true }
    Assert-True $failed 'export drift check fails on changed data'
    Write-Host "PASS: $script:checks offline rule/import assertions. No fetching branch, DNS or external requests executed."
} finally {
    $resolved = [IO.Path]::GetFullPath($temporary)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (!$resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path $resolved -Leaf) -notlike 'blockads-rules-test-*') { throw 'Unsafe test cleanup path.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
