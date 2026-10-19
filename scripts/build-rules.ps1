#Requires -Version 7.0
param(
    [switch]$FetchOnlineLists,
    [string]$UrlhausCsvPath,
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\rules'),
    [string]$CatalogPath = (Join-Path $PSScriptRoot '..\lists\reviewed-domains.json'),
    [string]$ThreatCatalogPath = (Join-Path $PSScriptRoot '..\lists\reported-threats.json')
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
    Test-GeneratedRules -RuleSets $sets
    $outputs = @{}
    foreach ($name in $sets.Keys) { $outputs[$name] = ConvertTo-Json -InputObject @($sets[$name] | Sort-Object id) -Depth 8 }
    $outputs['reviewed-domains.json'] = $catalog.Json
    $outputs['threat-policy.json'] = ConvertTo-Json -InputObject $threats.Policy
    Write-RuleOutputs -Directory $rulesDir -Outputs $outputs
    Write-Host "Built $($sets['ads.json'].Count) ad rules, $($sets['trackers.json'].Count) tracker rules, $($threats.Rules.Count) exact reported-threat rules (expire $($threats.Policy.expiresAt)); $(@($catalog.Domains | Where-Object category -CEQ 'unverified').Count) unverified domains are observation only."
} finally { $buildLock.Dispose() }
