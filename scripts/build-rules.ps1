#Requires -Version 7.0
param(
    [switch]$FetchOnlineLists,
    [string]$UrlhausCsvPath,
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\rules'),
    [string]$CatalogPath = (Join-Path $PSScriptRoot '..\lists\reviewed-domains.json'),
    [string]$ThreatCatalogPath = (Join-Path $PSScriptRoot '..\lists\reported-threats.json'),
    [string]$SiteAdHostsPath = (Join-Path $PSScriptRoot '..\lists\site-ad-hosts.json')
)
$ErrorActionPreference = 'Stop'
# A downloaded URL is not a reviewed domain. Keep legacy switches explicit so an
# old update command cannot silently import undated reputation into active rules.
if ($FetchOnlineLists -or $UrlhausCsvPath) {
    throw 'This reviewed build is offline only. URL feed import requires a separate dated-evidence review; existing rules are unchanged.'
}
. (Join-Path $PSScriptRoot 'reviewed-domain-tools.ps1')
. (Join-Path $PSScriptRoot 'rule-tools.ps1')
. (Join-Path $PSScriptRoot 'threat-report-tools.ps1')
$catalog = Read-ReviewedDomainCatalog $CatalogPath
$threats = Read-ThreatReportCatalog $ThreatCatalogPath
$rulesDir = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $rulesDir | Out-Null
$buildLock = [IO.File]::Open((Join-Path $rulesDir '.build.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
try {
    $sets = @{ 'ads.json' = @(); 'trackers.json' = @(); 'malware.json' = @(); 'threats.json' = $threats.Rules }
    foreach ($entry in $catalog.Domains) {
        # No independently evidenced malware exists in this contract.
        if ($entry.category -ceq 'unverified') { continue }
        $condition = [ordered]@{ resourceTypes = @($entry.browser.resourceTypes) }
        if ($entry.match -ceq 'subdomains') { $condition.urlFilter = '||' + $entry.domain + '^' }
        else { $condition.regexFilter = '^(http|https|ws|wss)://' + [regex]::Escape($entry.domain) + '(:[0-9]+)?/' }
        if ($entry.browser.domainType -cne 'any') { $condition.domainType = $entry.browser.domainType }
        $sets[$entry.category + '.json'] += [ordered]@{ id=$entry.sourceRuleId; priority=$entry.browser.priority; action=@{type='block'}; condition=$condition }
    }
    # Reviewed ad URL heuristics remain browser-specific. Never export them as domains.
    $patterns = Read-BoundedJson (Join-Path $PSScriptRoot '..\lists\browser-patterns.json') 64KB
    try {
        $allowed = @('*/ads/*.js','*/adserver/*','*/pagead/*','*/banner_ads/*','*/popunder*.js','*/prebid*.js')
        $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        if ($patterns.RootElement.ValueKind -ne 'Array' -or $patterns.RootElement.GetArrayLength() -ne $allowed.Count) { throw 'Invalid browser-only pattern list.' }
        foreach ($item in $patterns.RootElement.EnumerateArray()) {
            Assert-JsonKeys $item @('id','priority','action','condition')
            Assert-JsonKeys $item.GetProperty('action') @('type')
            $scope = $item.GetProperty('condition')
            Assert-JsonKeys $scope @('urlFilter','domainType','resourceTypes')
            $filter = Get-JsonString $scope.GetProperty('urlFilter')
            $types = @($scope.GetProperty('resourceTypes').EnumerateArray() | ForEach-Object { Get-JsonString $_ 32 })
            if ($filter -cnotin $allowed -or !$seen.Add($filter) -or
                $item.GetProperty('id').GetInt32() -ne (95 + [Array]::IndexOf($allowed, $filter)) -or
                $item.GetProperty('priority').GetInt32() -ne 1 -or
                (Get-JsonString $item.GetProperty('action').GetProperty('type')) -cne 'block' -or
                (Get-JsonString $scope.GetProperty('domainType')) -cne 'thirdParty' -or
                ($types -join ',') -cne 'script,sub_frame,image') { throw 'Unreviewed browser-only pattern or scope.' }
            $sets['ads.json'] += ($item.GetRawText() | ConvertFrom-Json -AsHashtable)
        }
    } finally { $patterns.Dispose() }
    # Ad hosts recorded on named sites by opt-in site checks. Browser-only like the
    # patterns above, never exported as catalog domains. Pages are included so a
    # click pop-up to one of these hosts is blocked too. Catalog domains are refused
    # here, so an unverified observation cannot be activated through this list.
    $siteHosts = Read-BoundedJson $SiteAdHostsPath 64KB
    $siteHostCount = 0
    try {
        $root = $siteHosts.RootElement
        Assert-JsonKeys $root @('schemaVersion','reviewKind','hosts')
        if ($root.GetProperty('schemaVersion').ValueKind -ne 'Number' -or $root.GetProperty('schemaVersion').GetInt32() -ne 1 -or
            (Get-JsonString $root.GetProperty('reviewKind')) -cne 'observed-site-ad-hosts' -or
            $root.GetProperty('hosts').ValueKind -ne 'Array' -or $root.GetProperty('hosts').GetArrayLength() -gt 500) {
            throw 'Invalid site ad host list.'
        }
        $catalogDomains = [Collections.Generic.HashSet[string]]::new([string[]]@($catalog.Domains | ForEach-Object domain), [StringComparer]::Ordinal)
        $siteSeen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($item in $root.GetProperty('hosts').EnumerateArray()) {
            Assert-JsonKeys $item @('domain','observedOnUtc','site','role','evidence')
            $domain = Get-JsonString $item.GetProperty('domain')
            $observed = Get-JsonString $item.GetProperty('observedOnUtc') 10
            $evidencePath = Get-JsonString $item.GetProperty('evidence') 200
            $null = Get-JsonString $item.GetProperty('role') 200
            $null = ConvertTo-ReviewedHostname (Get-JsonString $item.GetProperty('site'))
            $date = [DateTime]::MinValue
            if ((ConvertTo-ReviewedHostname $domain) -cne $domain -or !$siteSeen.Add($domain) -or $catalogDomains.Contains($domain) -or
                ![DateTime]::TryParseExact($observed, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture, 'None', [ref]$date) -or
                $date -gt [DateTime]::UtcNow.Date -or $evidencePath -cnotmatch '^verification/[A-Za-z0-9._/-]+\.json$' -or
                $evidencePath.Contains('..') -or !(Test-Path -LiteralPath (Join-Path $PSScriptRoot "..\$evidencePath") -PathType Leaf)) {
                throw "Invalid site ad host entry: $domain"
            }
            $sets['ads.json'] += [ordered]@{ id = 1001 + $siteHostCount++; priority = 1; action = @{ type = 'block' }; condition = [ordered]@{
                urlFilter = '||' + $domain + '^'
                resourceTypes = @('main_frame','sub_frame','script','image','xmlhttprequest','media','ping','websocket','other') } }
        }
    } finally { $siteHosts.Dispose() }
    Test-GeneratedRules -RuleSets $sets
    $outputs = @{}
    # Rules are dictionaries: sort by the key's value, not a (missing) property.
    foreach ($name in $sets.Keys) { $outputs[$name] = ConvertTo-Json -InputObject @($sets[$name] | Sort-Object { $_.id }) -Depth 8 }
    $outputs['reviewed-domains.json'] = $catalog.Json
    $outputs['threat-policy.json'] = ConvertTo-Json -InputObject $threats.Policy
    Write-RuleOutputs -Directory $rulesDir -Outputs $outputs
    Write-Host "Built $($sets['ads.json'].Count) ad rules ($siteHostCount from site checks), $($sets['trackers.json'].Count) tracker rules, $($threats.Rules.Count) exact reported-threat rules (expire $($threats.Policy.expiresAt)); $(@($catalog.Domains | Where-Object category -CEQ 'unverified').Count) unverified domains are observation only."
} finally { $buildLock.Dispose() }
