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
    $siteHostsJson = [IO.File]::ReadAllText((Join-Path $project 'lists/site-ad-hosts.json'))
    $siteHostCount = ($siteHostsJson | ConvertFrom-Json).hosts.Count
    Assert-True ($adRules.Count -eq 100 + $siteHostCount) 'reviewed ad domains, browser-only patterns and site ad hosts preserved'
    $siteRules = @($adRules | Where-Object id -GE 1001)
    Assert-True ($siteRules.Count -eq $siteHostCount -and @($siteRules | Where-Object { $_.condition.resourceTypes -notcontains 'main_frame' }).Count -eq 0) 'site ad hosts also block pop-up pages'
    $ids = @($adRules.id)
    Assert-True (($ids -join ',') -ceq ((@($ids | Sort-Object) -join ','))) 'generated rules are ordered by id'
    Assert-True ((Get-Content (Join-Path $output 'ads.json') -Raw) -notmatch "`r") 'generated rules use LF line endings'
    $realCommunity = @(Get-Content (Join-Path $output 'community.json') -Raw | ConvertFrom-Json)
    Assert-True ($realCommunity.Count -gt 0 -and $realCommunity.Count -le 29000) 'community snapshot rules fit the guaranteed browser rule budget'
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
    # Site ad host list: every malformed or unsafe entry is refused without changing outputs.
    $sitePath = Join-Path $temporary 'site-ad-hosts.json'
    $validSite = $siteHostsJson | ConvertFrom-Json -AsHashtable
    $catalogAd = ($catalogJson | ConvertFrom-Json).domains | Where-Object category -CEQ 'ads' | Select-Object -First 1
    $catalogUnverified = ($catalogJson | ConvertFrom-Json).domains | Where-Object category -CEQ 'unverified' | Select-Object -First 1
    foreach ($fault in @('domain','uppercase','duplicate','catalog-ad','catalog-unverified','future','date','evidence-path','evidence-missing',
        'unknown-field','missing-field','kind','site')) {
        $site = $siteHostsJson | ConvertFrom-Json -AsHashtable
        switch ($fault) {
            'domain' { $site.hosts[0].domain = 'ad.fixture-unit.net/path' }
            'uppercase' { $site.hosts[0].domain = 'A-ADS.com' }
            'duplicate' { $site.hosts += $site.hosts[0] }
            'catalog-ad' { $site.hosts[0].domain = $catalogAd.domain }
            'catalog-unverified' { $site.hosts[0].domain = $catalogUnverified.domain }
            'future' { $site.hosts[0].observedOnUtc = '2099-01-01' }
            'date' { $site.hosts[0].observedOnUtc = '2026-02-30' }
            'evidence-path' { $site.hosts[0].evidence = 'verification/../manifest.json' }
            'evidence-missing' { $site.hosts[0].evidence = 'verification/missing/none.json' }
            'unknown-field' { $site.hosts[0].command = 'inert-text' }
            'missing-field' { $site.hosts[0].Remove('role') }
            'kind' { $site.reviewKind = 'remote-feed' }
            'site' { $site.hosts[0].site = 'not a host' }
        }
        [IO.File]::WriteAllText($sitePath, (ConvertTo-Json -InputObject $site -Depth 6), [Text.UTF8Encoding]::new($false))
        Assert-FailedUnchanged { & $builder -OutputDirectory $output -SiteAdHostsPath $sitePath } "site ad host $fault"
    }
    $validSite.hosts = @()
    [IO.File]::WriteAllText($sitePath, (ConvertTo-Json -InputObject $validSite -Depth 6), [Text.UTF8Encoding]::new($false))
    & $builder -OutputDirectory $output -SiteAdHostsPath $sitePath
    Assert-True ((Get-Content (Join-Path $output 'ads.json') -Raw | ConvertFrom-Json).Count -eq 100) 'empty site ad host list adds no rules'
    # Community lists: convert a synthetic EasyList-format snapshot (inert strings only).
    $communityRoot = Join-Path $temporary 'community-lists'
    New-Item -ItemType Directory -Path (Join-Path $communityRoot 'community') -Force | Out-Null
    $protectedAd = (($catalogJson | ConvertFrom-Json).domains | Where-Object category -CEQ 'ads' | Select-Object -First 1).domain
    $listText = @"
[Adblock Plus 2.0]
! Title: Fixture list
! Version: 7
||ads-one.fixture-unit.net^
||ads-two.fixture-unit.net^
||tp-only.fixture-unit.net^`$third-party
||scripts.fixture-unit.net^`$third-party,script
/banner-ad/*`$image,domain=news.fixture-unit.net|~shop.news.fixture-unit.net
||imp.fixture-unit.net/track^`$important
@@||ads-one.fixture-unit.net/allowed.js`$script,domain=partner.fixture-unit.net
@@/ad-loader.js`$domain=video.fixture-unit.net
@@||$protectedAd/x.js
||popunder.fixture-unit.net^`$popup
/popclick?zone=`$popup
/^https?:\/\/regex\.fixture-unit\.net/`$script
||csp.fixture-unit.net^`$csp=script-src 'none'
||rewrite.fixture-unit.net^`$rewrite=abp-resource:blank-js
##.generic-ad
news.fixture-unit.net##.side-ad
news.fixture-unit.net,blog.fixture-unit.net###top-banner
shop.news.fixture-unit.net#@#.side-ad
~skip.fixture-unit.net##.skip-ad
news.fixture-unit.net##div:has-text(Sponsored)
news.fixture-unit.net##.evil { background: red }
news.fixture-unit.net#`$#abort-on-property-read ads
"@
    $communityPath = Join-Path $communityRoot 'community-lists.json'
    function Write-CommunityList([string]$Name, [string]$Text) {
        $path = Join-Path $communityRoot "community/$Name"
        [IO.File]::WriteAllText($path, $Text, [Text.UTF8Encoding]::new($false))
        return [ordered]@{ id = 'fixture'; title = 'Fixture list'; file = "community/$Name"; source = 'https://lists.fixture-unit.net/fixture.txt'
            license = 'Test fixture'; downloadedAtUtc = '2026-10-19T00:00:00Z'; sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
    function Write-CommunityCatalog($Lists, [string]$Kind = 'community-filter-snapshots') {
        [IO.File]::WriteAllText($communityPath, (ConvertTo-Json -InputObject ([ordered]@{ schemaVersion = 1; reviewKind = $Kind; lists = @($Lists) }) -Depth 6), [Text.UTF8Encoding]::new($false))
    }
    $fixtureList = Write-CommunityList 'fixture.txt' $listText
    Write-CommunityCatalog @($fixtureList)
    & $builder -OutputDirectory $output -CommunityListsPath $communityPath
    $community = @(Get-Content (Join-Path $output 'community.json') -Raw | ConvertFrom-Json)
    $cosmetic = Get-Content (Join-Path $output 'community-cosmetic.json') -Raw | ConvertFrom-Json -AsHashtable
    $info = Get-Content (Join-Path $output 'community-info.json') -Raw | ConvertFrom-Json
    $byFilter = { param($filter) @($community | Where-Object { $_.condition.urlFilter -ceq $filter }) }
    $byHost = { param($hostName) @($community | Where-Object { $_.condition.requestDomains -contains $hostName }) }
    $plain = & $byHost 'ads-one.fixture-unit.net'
    Assert-True ($plain.Count -eq 1 -and (@($plain[0].condition.requestDomains) -join ',') -ceq 'ads-one.fixture-unit.net,ads-two.fixture-unit.net' -and
        !$plain[0].condition.domainType -and !$plain[0].condition.resourceTypes) 'plain domain filters merge into one domain-list rule'
    $tp = & $byHost 'tp-only.fixture-unit.net'
    Assert-True ($tp[0].condition.domainType -ceq 'thirdParty' -and !$tp[0].condition.resourceTypes) 'third-party option is preserved'
    $scriptRule = & $byHost 'scripts.fixture-unit.net'
    Assert-True ($scriptRule[0].condition.domainType -ceq 'thirdParty' -and (@($scriptRule[0].condition.resourceTypes) -join ',') -ceq 'script') 'resource type option is preserved'
    $banner = & $byFilter '/banner-ad/*'
    Assert-True ((@($banner[0].condition.initiatorDomains) -join ',') -ceq 'news.fixture-unit.net' -and
        (@($banner[0].condition.excludedInitiatorDomains) -join ',') -ceq 'shop.news.fixture-unit.net' -and
        (@($banner[0].condition.resourceTypes) -join ',') -ceq 'image') 'domain= option becomes included and excluded sites'
    Assert-True ((& $byFilter '||imp.fixture-unit.net/track^')[0].priority -eq 3) 'important filters outrank exceptions'
    $partner = & $byFilter '||ads-one.fixture-unit.net/allowed.js'
    Assert-True ($partner[0].action.type -ceq 'allow' -and $partner[0].priority -eq 2) 'exceptions become allow rules below reported threats'
    Assert-True ((& $byFilter '/ad-loader.js')[0].condition.excludedRequestDomains -contains $protectedAd) 'path exceptions exclude BlockAds-blocked domains'
    Assert-True (!(& $byFilter "||$protectedAd/x.js").Count) 'exceptions for BlockAds-blocked domains are dropped'
    $pop = & $byHost 'popunder.fixture-unit.net'
    Assert-True ((@($pop[0].condition.resourceTypes) -join ',') -ceq 'main_frame' -and !$pop[0].condition.domainType) 'host pop-up filters block page loads to that host'
    Assert-True ((& $byFilter '/popclick?zone=')[0].condition.domainType -ceq 'thirdParty') 'site-agnostic pop-up patterns apply only to loads from another site'
    Assert-True (!@($community | Where-Object { "$($_.condition.urlFilter) $($_.condition.requestDomains)" -match 'regex|csp|rewrite' }).Count -and
        $info.skipped.'network: regular expression' -eq 1 -and $info.skipped.'network: unsupported option syntax' -eq 1 -and
        $info.skipped.'network: unsupported option rewrite=' -eq 1) 'regex and unsupported-option filters are skipped and counted'
    $allSelectors = @($cosmetic.hide.Values | ForEach-Object { $_ })
    Assert-True ((@($cosmetic.hide['news.fixture-unit.net']) -join ',') -ceq '#top-banner,.side-ad' -and
        (@($cosmetic.hide['blog.fixture-unit.net']) -join ',') -ceq '#top-banner' -and
        (@($cosmetic.allow['shop.news.fixture-unit.net']) -join ',') -ceq '.side-ad') 'site hiding rules and exceptions are grouped by site'
    Assert-True (!$cosmetic.hide.ContainsKey('skip.fixture-unit.net') -and $allSelectors -notcontains '.generic-ad' -and
        !($allSelectors -match 'has-text|evil|abort')) 'generic, excluded-scope and procedural rules stay outside the site map; unsafe selectors are skipped'
    Assert-True ($cosmetic.procedural.Count -eq 1 -and $cosmetic.procedural[0].procedure.ops[0].value -ceq 'Sponsored') 'supported procedures are compiled separately without broadening the CSS map'
    Assert-True ($cosmetic.generic -contains '.generic-ad' -and $cosmetic.scoped[0].exclude -contains 'skip.fixture-unit.net') 'generic and negated filters retain their proper scopes'
    Assert-True ($info.lists[0].version -ceq '7' -and $info.networkRules -eq $community.Count -and $info.cosmeticSelectors -eq 3) 'snapshot version and counts are recorded'
    foreach ($fault in @('hash','unknown-field','path','source','future','duplicate-id','kind')) {
        $bad = $fixtureList | ConvertTo-Json | ConvertFrom-Json -AsHashtable
        $lists = @($bad)
        $kind = 'community-filter-snapshots'
        switch ($fault) {
            'hash' { $bad.sha256 = '0' * 64 }
            'unknown-field' { $bad.command = 'inert-text' }
            'path' { $bad.file = 'community/../../outside.txt' }
            'source' { $bad.source = 'http://lists.fixture-unit.net/fixture.txt' }
            'future' { $bad.downloadedAtUtc = '2099-01-01T00:00:00Z' }
            'duplicate-id' { $lists = @($bad, $bad) }
            'kind' { $kind = 'remote-feed' }
        }
        Write-CommunityCatalog $lists $kind
        Assert-FailedUnchanged { & $builder -OutputDirectory $output -CommunityListsPath $communityPath } "community list $fault"
    }
    Write-CommunityCatalog @(Write-CommunityList 'too-many.txt' ((1..29001 | ForEach-Object { "/fixture-path-$_/*" }) -join "`n"))
    Assert-FailedUnchanged { & $builder -OutputDirectory $output -CommunityListsPath $communityPath } 'community rule budget'
    Write-CommunityCatalog @()
    & $builder -OutputDirectory $output -CommunityListsPath $communityPath
    Assert-True ((Get-Content (Join-Path $output 'community.json') -Raw).Trim() -ceq '[]') 'no snapshots build an empty community ruleset'
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
