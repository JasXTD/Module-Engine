#Requires -Version 7.0
# Converts local EasyList-format snapshots into browser rules and site-specific
# hiding rules. Offline only: list lines are data; nothing is fetched or resolved.
# Filters that need runtime features this extension does not have are skipped and
# counted, never approximated with a broader rule.

$CommunityTypeMap = @{
    script = 'script'; image = 'image'; stylesheet = 'stylesheet'; css = 'stylesheet'; object = 'object'
    xmlhttprequest = 'xmlhttprequest'; xhr = 'xmlhttprequest'; subdocument = 'sub_frame'; frame = 'sub_frame'
    ping = 'ping'; beacon = 'ping'; media = 'media'; font = 'font'; websocket = 'websocket'; other = 'other'
}
# Chrome guarantees each extension 30,000 enabled static rules; leave room for
# BlockAds' own ad, tracker and threat rulesets.
$CommunityMaxRules = 29000
$CommunityDomainChunk = 1000
$CommunityProcedural = [regex]'(?i):(-abp-|has-text|contains|xpath|matches-|upward|min-text-length|watch-attr|others|remove|style|if\(|if-not|nth-ancestor|matches-path|matches-media)'
$CommunityCosmetic = [regex]'^(?<domains>[^\s/|^$@#]*)(?<sep>#@?[?$%]?#|\$@?\$)(?<body>.+)$'
$CommunityDomainOnly = [regex]'^\|\|(?<host>[^/^*|:?=&]+)\^\|?$'
$CommunityOptions = [regex]'^[A-Za-z0-9~_,=|.*:/\-]+$'

function ConvertTo-CommunityHost([string]$Value) {
    if (!$Value -or $Value.Length -gt 253) { return $null }
    $hostName = $Value.ToLowerInvariant().TrimEnd('.')
    if ($hostName -match '[^\x21-\x7e]') {
        try { $hostName = [Globalization.IdnMapping]::new().GetAscii($hostName).ToLowerInvariant() } catch { return $null }
    }
    $labels = $hostName.Split('.')
    if ($labels.Count -lt 2) { return $null }
    foreach ($label in $labels) { if ($label -notmatch '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$') { return $null } }
    return $hostName
}

function Read-CommunityListCatalog([string]$Path) {
    $document = Read-BoundedJson $Path 64KB
    try {
        $root = $document.RootElement
        Assert-JsonKeys $root @('schemaVersion','reviewKind','lists')
        if ($root.GetProperty('schemaVersion').ValueKind -ne 'Number' -or $root.GetProperty('schemaVersion').GetInt32() -ne 1 -or
            (Get-JsonString $root.GetProperty('reviewKind')) -cne 'community-filter-snapshots' -or
            $root.GetProperty('lists').ValueKind -ne 'Array' -or $root.GetProperty('lists').GetArrayLength() -gt 10) {
            throw 'Invalid community list catalog.'
        }
        $base = Split-Path ([IO.Path]::GetFullPath($Path)) -Parent
        $ids = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        $lists = foreach ($item in $root.GetProperty('lists').EnumerateArray()) {
            Assert-JsonKeys $item @('id','title','file','source','license','downloadedAtUtc','sha256')
            $entry = [ordered]@{}
            foreach ($key in @('id','title','file','source','license','downloadedAtUtc','sha256')) { $entry[$key] = Get-JsonString $item.GetProperty($key) 300 }
            $downloaded = [DateTimeOffset]::MinValue
            if ($entry.id -cnotmatch '^[a-z0-9-]{1,40}$' -or !$ids.Add($entry.id) -or
                $entry.file -cnotmatch '^community/[A-Za-z0-9._-]+\.txt$' -or $entry.source -cnotmatch '^https://[^\s]+$' -or
                $entry.sha256 -cnotmatch '^[0-9a-f]{64}$' -or $entry.downloadedAtUtc -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$' -or
                ![DateTimeOffset]::TryParse($entry.downloadedAtUtc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$downloaded) -or
                $downloaded -gt [DateTimeOffset]::UtcNow.AddMinutes(5)) {
                throw "Invalid community list entry: $($entry.id)"
            }
            $file = Join-Path $base $entry.file
            $info = Get-Item -LiteralPath $file -ErrorAction Stop
            if ($info.Length -gt 8MB) { throw "Community list is too large: $($entry.id)" }
            $bytes = [IO.File]::ReadAllBytes($file)
            if ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant() -cne $entry.sha256) {
                throw "Community list $($entry.id) does not match its recorded SHA-256. Update the catalog deliberately after reviewing a new snapshot."
            }
            $entry.text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
            $entry
        }
        return @($lists)
    } finally { $document.Dispose() }
}

# $ProtectedDomains are BlockAds' own blocked domains. Community exceptions may
# undo community blocks only, so they never apply to requests for these domains.
function ConvertFrom-CommunityLists($Lists, [string[]]$ProtectedDomains = @()) {
    $protectedSet = [Collections.Generic.HashSet[string]]::new([string[]]$ProtectedDomains, [StringComparer]::Ordinal)
    $isProtected = { param($hostName)
        $labels = $hostName.Split('.')
        for ($i = 0; $i -lt $labels.Count - 1; $i++) { if ($protectedSet.Contains(($labels[$i..($labels.Count - 1)] -join '.'))) { return $true } }
        foreach ($domain in $protectedSet) { if ($domain.EndsWith('.' + $hostName)) { return $true } }
        return $false
    }
    $limitedExceptions = 0
    $skipped = @{}
    $skip = { param($reason) $skipped[$reason] = 1 + ($skipped[$reason] ?? 0) }
    $hide = @{}
    $allow = @{}
    $groups = [ordered]@{}
    $single = [ordered]@{}
    $infoLists = @()
    foreach ($list in $Lists) {
        $header = @{}
        foreach ($line in $list.text -split "`r?`n") {
            $line = $line.Trim()
            if (!$line) { continue }
            if ($line[0] -eq '!' -or $line[0] -eq '[') {
                if ($line -match '^!\s*(Version|Last modified|Title):\s*(.+)$' -and !$header.ContainsKey($Matches[1])) { $header[$Matches[1]] = $Matches[2].Trim() }
                continue
            }
            $cosmetic = $CommunityCosmetic.Match($line)
            if ($cosmetic.Success) {
                $sep = $cosmetic.Groups['sep'].Value
                if ($sep -cne '##' -and $sep -cne '#@#') { & $skip 'cosmetic: scriptlet, procedural or HTML filter'; continue }
                $domainText = $cosmetic.Groups['domains'].Value
                if (!$domainText) { & $skip ($sep -ceq '##' ? 'cosmetic: generic (all sites)' : 'cosmetic: generic exception'); continue }
                $selector = $cosmetic.Groups['body'].Value.Trim()
                if ($selector.Length -gt 1000 -or $selector -match '[{}]|/\*' -or $selector.StartsWith('+js(') -or $CommunityProcedural.IsMatch($selector)) {
                    & $skip 'cosmetic: procedural or unsafe selector'; continue
                }
                $domains = @($domainText.Split(',') | ForEach-Object { if ($_ -match '^[~]|\*') { $null } else { ConvertTo-CommunityHost $_ } })
                if ($domains -contains $null -or !$domains.Count) { & $skip 'cosmetic: negated, wildcard or invalid domain'; continue }
                $target = $sep -ceq '##' ? $hide : $allow
                foreach ($domain in $domains) {
                    if (!$target.ContainsKey($domain)) { $target[$domain] = [Collections.Generic.SortedSet[string]]::new([StringComparer]::Ordinal) }
                    $null = $target[$domain].Add($selector)
                }
                continue
            }

            $exception = $line.StartsWith('@@')
            $text = $exception ? $line.Substring(2) : $line
            # /.../ is a regular expression, with or without $options; its body may contain $.
            if ($text.Length -gt 2 -and $text -match '^/.+/(\$[^$]*)?$') { & $skip 'network: regular expression'; continue }
            $pattern = $text
            $options = @()
            $dollar = $text.LastIndexOf('$')
            if ($dollar -ge 0) {
                # Options with quotes, spaces or other syntax are unsupported, not part of the URL.
                if (!$CommunityOptions.IsMatch($text.Substring($dollar + 1))) { & $skip 'network: unsupported option syntax'; continue }
                $pattern = $text.Substring(0, $dollar)
                $options = $text.Substring($dollar + 1).Split(',')
            }

            $condition = [ordered]@{}
            $types = [Collections.Generic.SortedSet[string]]::new([StringComparer]::Ordinal)
            $excludedTypes = [Collections.Generic.SortedSet[string]]::new([StringComparer]::Ordinal)
            $initiators = [Collections.Generic.SortedSet[string]]::new([StringComparer]::Ordinal)
            $excludedInitiators = [Collections.Generic.SortedSet[string]]::new([StringComparer]::Ordinal)
            $important = $false
            $pageLoad = $false
            $reason = $null
            foreach ($rawOption in $options) {
                $option = $rawOption.Trim().ToLowerInvariant()
                if (!$option) { continue }
                $negated = $option.StartsWith('~')
                $name = $option.TrimStart('~')
                if ($name -in @('third-party','3p')) { $condition.domainType = $negated ? 'firstParty' : 'thirdParty' }
                elseif ($name -in @('first-party','1p')) { $condition.domainType = $negated ? 'thirdParty' : 'firstParty' }
                elseif ($name -match '^(domain|from)=(.+)$') {
                    foreach ($domain in $Matches[2].Split('|')) {
                        $negative = $domain.StartsWith('~')
                        $hostName = $domain.Contains('*') ? $null : (ConvertTo-CommunityHost $domain.TrimStart('~'))
                        if (!$hostName) { $reason = 'network: wildcard or invalid domain option'; break }
                        $null = ($negative ? $excludedInitiators : $initiators).Add($hostName)
                    }
                }
                elseif ($name -ceq 'match-case') { $condition.isUrlFilterCaseSensitive = $true }
                elseif ($name -ceq 'important' -and !$negated) { $important = $true }
                elseif ($name -ceq 'popup' -and !$negated) { $null = $types.Add('main_frame'); $pageLoad = $true }
                elseif ($name -in @('document','doc') -and !$negated -and !$exception) { $null = $types.Add('main_frame'); $pageLoad = $true }
                elseif ($CommunityTypeMap.ContainsKey($name)) { $null = ($negated ? $excludedTypes : $types).Add($CommunityTypeMap[$name]) }
                else { $reason = "network: unsupported option $($name -replace '=.*$', '=')" }
                if ($reason) { break }
            }
            if (!$reason -and $exception -and $important) { $reason = 'network: important exception' }
            if ($reason) { & $skip $reason; continue }

            if ($types.Count) {
                $types.ExceptWith($excludedTypes)
                if (!$types.Count) { & $skip 'network: no resource types left'; continue }
                $condition.resourceTypes = @($types)
            } elseif ($excludedTypes.Count) {
                # Without resourceTypes the browser default excludes page loads; keep that.
                $null = $excludedTypes.Add('main_frame')
                $condition.excludedResourceTypes = @($excludedTypes)
            }
            if ($initiators.Count) { $condition.initiatorDomains = @($initiators) }
            if ($excludedInitiators.Count) { $condition.excludedInitiatorDomains = @($excludedInitiators) }
            # Browser rules cannot tell a pop-up from a normal page load. A pop-up or
            # page pattern not tied to one host applies only to loads started by
            # another site, so a site's own redirect links keep working.
            if ($pageLoad -and !$exception -and !$pattern.StartsWith('||') -and !$condition.Contains('domainType')) { $condition.domainType = 'thirdParty' }
            $action = $exception ? 'allow' : 'block'
            $priority = $exception ? 2 : ($important ? 3 : 1)
            # Same options in any order give the same key, so equivalent filters merge.
            $key = "$action|$priority|" + (($condition.Keys | Sort-Object | ForEach-Object { "$_=$(@($condition[$_]) -join ',')" }) -join ';')

            $domainOnly = $CommunityDomainOnly.Match($pattern)
            $anchoredHost = $pattern -match '^\|\|(?<host>[a-z0-9.-]+)' ? (ConvertTo-CommunityHost $Matches['host']) : $null
            if ($exception -and $anchoredHost -and (& $isProtected $anchoredHost)) { $limitedExceptions++; & $skip 'network: exception for a BlockAds-blocked domain'; continue }
            if ($domainOnly.Success) {
                $hostName = ConvertTo-CommunityHost $domainOnly.Groups['host'].Value
                if (!$hostName) { & $skip 'network: invalid host'; continue }
                if (!$groups.Contains($key)) { $groups[$key] = @{ action = $action; priority = $priority; condition = $condition; hosts = [Collections.Generic.SortedSet[string]]::new([StringComparer]::Ordinal) } }
                $null = $groups[$key].hosts.Add($hostName)
                continue
            }
            if ($pattern -match '^[|*]*$' -or $pattern.Length -lt 4) { & $skip 'network: pattern too short or broad'; continue }
            if ($pattern.StartsWith('||*') -or $pattern -match '[^\x20-\x7e]') { & $skip 'network: unsupported pattern syntax'; continue }
            $condition.urlFilter = $pattern
            if ($exception -and !$anchoredHost -and $protectedSet.Count) {
                # A path exception could match any host; keep it off BlockAds' domains.
                $condition.excludedRequestDomains = @($ProtectedDomains | Sort-Object -Unique)
                $limitedExceptions++
            }
            $single["$key|$pattern"] = [ordered]@{ priority = $priority; action = @{ type = $action }; condition = $condition }
        }
        $infoLists += [ordered]@{ id = $list.id; title = $header['Title'] ?? $list.title; version = $header['Version']; lastModified = $header['Last modified']
            source = $list.source; license = $list.license; downloadedAtUtc = $list.downloadedAtUtc; sha256 = $list.sha256 }
    }

    $rules = [Collections.Generic.List[object]]::new()
    $groupedHosts = 0
    foreach ($group in $groups.Values) {
        $hosts = @($group.hosts)
        $groupedHosts += $hosts.Count
        for ($offset = 0; $offset -lt $hosts.Count; $offset += $CommunityDomainChunk) {
            $condition = [ordered]@{ requestDomains = @($hosts[$offset..([Math]::Min($offset + $CommunityDomainChunk, $hosts.Count) - 1)]) }
            foreach ($key in $group.condition.Keys) { $condition[$key] = $group.condition[$key] }
            $rules.Add([ordered]@{ id = $rules.Count + 1; priority = $group.priority; action = @{ type = $group.action }; condition = $condition })
        }
    }
    foreach ($rule in $single.Values) { $rules.Add([ordered]@{ id = $rules.Count + 1; priority = $rule.priority; action = $rule.action; condition = $rule.condition }) }
    if ($rules.Count -gt $CommunityMaxRules) { throw "Community lists produce $($rules.Count) rules; the limit is $CommunityMaxRules." }

    $toMap = { param($map) $sorted = [ordered]@{}; foreach ($key in ($map.Keys | Sort-Object)) { $sorted[$key] = @($map[$key]) }; $sorted }
    $hideMap = & $toMap $hide
    $selectorCount = 0
    foreach ($value in $hideMap.Values) { $selectorCount += $value.Count }
    $skippedSorted = [ordered]@{}
    foreach ($key in ($skipped.Keys | Sort-Object)) { $skippedSorted[$key] = $skipped[$key] }
    return @{
        Rules = $rules
        Cosmetic = [ordered]@{ hide = $hideMap; allow = (& $toMap $allow) }
        Info = [ordered]@{ schemaVersion = 1; lists = $infoLists; networkRules = $rules.Count; groupedDomains = $groupedHosts
            cosmeticSites = $hideMap.Count; cosmeticSelectors = $selectorCount; exceptionsLimitedForBlockAdsRules = $limitedExceptions
            skipped = $skippedSorted }
    }
}

function Test-CommunityRules($Rules) {
    $validTypes = @('main_frame','sub_frame','stylesheet','script','image','font','object','xmlhttprequest','ping','media','websocket','other')
    $ids = [Collections.Generic.HashSet[int]]::new()
    foreach ($rule in $Rules) {
        $condition = $rule.condition
        $types = @($condition.resourceTypes) + @($condition.excludedResourceTypes) | Where-Object { $_ }
        if ($rule.id -lt 1 -or !$ids.Add($rule.id) -or $rule.priority -notin @(1, 2, 3) -or $rule.action.type -notin @('block','allow') -or
            (($null -ne $condition.urlFilter) -eq ($null -ne $condition.requestDomains)) -or
            ($condition.urlFilter -and ($condition.urlFilter.StartsWith('||*') -or $condition.urlFilter -match '[^\x20-\x7e]')) -or
            @($types | Where-Object { $_ -notin $validTypes }).Count -or
            ($condition.resourceTypes -and $condition.excludedResourceTypes)) {
            throw "Invalid community rule $($rule.id)."
        }
    }
}

# One rule (or one site) per line keeps snapshot updates reviewable in diffs.
function ConvertTo-LineJson($Items) {
    if (!@($Items).Count) { return '[]' }
    return "[`n" + ((@($Items) | ForEach-Object { ConvertTo-Json -InputObject $_ -Compress -Depth 8 }) -join ",`n") + "`n]"
}
function ConvertTo-CosmeticJson($Cosmetic) {
    $sections = foreach ($name in @('hide','allow')) {
        $lines = foreach ($key in $Cosmetic[$name].Keys) { '    ' + (ConvertTo-Json -InputObject $key -Compress) + ': ' + (ConvertTo-Json -InputObject @($Cosmetic[$name][$key]) -Compress) }
        "  `"$name`": {" + ($lines ? "`n" + ($lines -join ",`n") + "`n  }" : '}')
    }
    return "{`n" + ($sections -join ",`n") + "`n}"
}
