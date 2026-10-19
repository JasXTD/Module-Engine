#Requires -Version 7.0
# Closed offline contract. Strings are data; this file performs no network operations.
$ReviewedDomainMaxBytes = 1MB
$ReviewedDomainMaxEntries = 5000

function Read-BoundedJson([string]$Path, [int]$Limit = $ReviewedDomainMaxBytes) {
    $file = Get-Item -LiteralPath $Path -ErrorAction Stop
    if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Expected a regular JSON file.' }
    $stream = [IO.File]::Open($file.FullName, 'Open', 'Read', 'Read')
    try {
        if ($stream.Length -gt $Limit) { throw 'JSON exceeds the size limit.' }
        $bytes = [byte[]]::new([int]$stream.Length)
        $offset = 0
        while ($offset -lt $bytes.Length) {
            $count = $stream.Read($bytes, $offset, $bytes.Length - $offset)
            if (!$count) { throw 'Incomplete JSON file.' }
            $offset += $count
        }
        $json = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
        $options = [Text.Json.JsonDocumentOptions]::new()
        $options.MaxDepth = 12
        return [Text.Json.JsonDocument]::Parse($json, $options)
    } finally { $stream.Dispose() }
}

function Assert-JsonKeys($Value, [string[]]$Keys) {
    if ($Value.ValueKind -ne 'Object') { throw 'Expected a JSON object.' }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($property in $Value.EnumerateObject()) {
        if (!$seen.Add($property.Name) -or $property.Name -cnotin $Keys) { throw "Unknown or duplicate field: $($property.Name)" }
    }
    if ($seen.Count -ne $Keys.Count) { throw 'Missing required JSON field.' }
}

function Get-JsonString($Value, [int]$Max = 253) {
    if ($Value.ValueKind -ne 'String') { throw 'Expected a JSON string.' }
    $text = $Value.GetString()
    if (!$text.Length -or $text.Length -gt $Max -or $text -match '[\x00-\x1f\x7f]') { throw 'Invalid or oversized string.' }
    return $text
}

function ConvertTo-ReviewedHostname([string]$Value) {
    if (!$Value -or $Value.Length -gt 254 -or $Value -match '[\s/\\:*^|@?#%_]' -or $Value -match '[^\x21-\x7e]') { throw 'Expected an ASCII DNS hostname.' }
    $hostName = $Value.ToLowerInvariant() -replace '\.$', ''
    if ($hostName.Length -gt 253) { throw 'Hostname is too long.' }
    $labels = $hostName.Split('.')
    if ($labels.Count -lt 2 -or $labels[-1] -notmatch '^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$') { throw 'Invalid DNS suffix.' }
    foreach ($label in $labels) {
        if ($label -notmatch '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$') { throw 'Invalid DNS label.' }
        if ($label.StartsWith('xn--')) {
            $idn = [Globalization.IdnMapping]::new()
            $idn.UseStd3AsciiRules = $true
            if ($idn.GetAscii($idn.GetUnicode($label)).ToLowerInvariant() -cne $label) { throw 'Invalid IDN label.' }
        }
    }
    if ($labels[-1] -in @('example','test','invalid','localhost','local','internal','onion','alt','home','lan','corp','arpa') -or
        $hostName -match '(^|\.)example\.(com|net|org)$' -or
        ($labels.Count -eq 2 -and $labels[-1].Length -eq 2 -and $labels[0] -in @('ac','co','com','edu','gov','net','org'))) {
        throw 'Reserved, local, or overly broad hostname.'
    }
    return $hostName
}

function Read-ReviewedDomainCatalog([string]$Path) {
    $document = Read-BoundedJson $Path
    try {
        $root = $document.RootElement
        Assert-JsonKeys $root @('schemaVersion','reviewKind','reviewedAtUtc','sources','domains')
        if ($root.GetProperty('schemaVersion').GetInt32() -ne 1 -or
            (Get-JsonString $root.GetProperty('reviewKind')) -cne 'offline-structure-only') { throw 'Unsupported review contract.' }
        $reviewed = Get-JsonString $root.GetProperty('reviewedAtUtc') 40
        $time = [DateTimeOffset]::MinValue
        if ($reviewed -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$' -or
            ![DateTimeOffset]::TryParse($reviewed, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$time) -or
            $time -gt [DateTimeOffset]::UtcNow.AddMinutes(5)) { throw 'Invalid structural-review timestamp.' }
        $sources = $root.GetProperty('sources')
        $domains = $root.GetProperty('domains')
        if ($sources.ValueKind -ne 'Array' -or $sources.GetArrayLength() -notin 1..3 -or
            $domains.ValueKind -ne 'Array' -or $domains.GetArrayLength() -gt $ReviewedDomainMaxEntries) { throw 'Invalid catalog bounds.' }
        $sourceIds = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($source in $sources.EnumerateArray()) {
            Assert-JsonKeys $source @('id','path','sha256','evidence','lastVerifiedUtc','expiresUtc')
            $id = Get-JsonString $source.GetProperty('id') 64
            if ($id -cnotin @('blockads-ads','blockads-trackers','blockads-malware') -or !$sourceIds.Add($id)) { throw 'Invalid or duplicate source.' }
            if ((Get-JsonString $source.GetProperty('path')) -cne ('rules/' + $id.Substring(9) + '.json') -or
                (Get-JsonString $source.GetProperty('sha256') 64) -cnotmatch '^[0-9a-f]{64}$' -or
                (Get-JsonString $source.GetProperty('evidence')) -cne 'unverified-local-list' -or
                $source.GetProperty('lastVerifiedUtc').ValueKind -ne 'Null' -or $source.GetProperty('expiresUtc').ValueKind -ne 'Null') {
                throw 'Invalid source provenance; this contract cannot assert verified reputation or freshness.'
            }
        }
        $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        $sourceRules = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        $entries = [Collections.Generic.List[object]]::new()
        $types = @('main_frame','sub_frame','stylesheet','script','image','font','object','xmlhttprequest','ping','media','websocket','other')
        foreach ($entry in $domains.EnumerateArray()) {
            Assert-JsonKeys $entry @('domain','match','category','sourceId','sourceRuleId','browser')
            $domain = Get-JsonString $entry.GetProperty('domain')
            if ((ConvertTo-ReviewedHostname $domain) -cne $domain -or !$seen.Add($domain)) { throw 'Noncanonical or duplicate domain.' }
            $mode = Get-JsonString $entry.GetProperty('match') 16
            $category = Get-JsonString $entry.GetProperty('category') 16
            $sourceId = Get-JsonString $entry.GetProperty('sourceId') 64
            $ruleId = $entry.GetProperty('sourceRuleId').GetInt32()
            $expectedSource = if ($category -ceq 'unverified') { 'blockads-malware' } else { 'blockads-' + $category }
            if ($mode -cnotin @('exact','subdomains') -or $category -cnotin @('ads','trackers','unverified') -or
                !$sourceIds.Contains($sourceId) -or $sourceId -cne $expectedSource -or $ruleId -lt 1 -or $ruleId -gt 100000 -or
                !$sourceRules.Add("${sourceId}:$ruleId")) { throw 'Invalid category, scope or source rule.' }
            $browser = $entry.GetProperty('browser')
            Assert-JsonKeys $browser @('priority','domainType','resourceTypes')
            $priority = $browser.GetProperty('priority').GetInt32()
            $domainType = Get-JsonString $browser.GetProperty('domainType') 16
            $resourceTypes = $browser.GetProperty('resourceTypes')
            if ($priority -notin 1..2 -or $domainType -cnotin @('any','thirdParty','firstParty') -or
                $resourceTypes.ValueKind -ne 'Array' -or $resourceTypes.GetArrayLength() -notin 1..12) { throw 'Invalid browser scope.' }
            $typeSet = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
            $resourceList = @()
            foreach ($type in $resourceTypes.EnumerateArray()) {
                $name = Get-JsonString $type 32
                if ($name -cnotin $types -or !$typeSet.Add($name)) { throw 'Unknown or duplicate resource type.' }
                $resourceList += $name
            }
            $entries.Add([ordered]@{ domain=$domain; match=$mode; category=$category; sourceId=$sourceId; sourceRuleId=$ruleId;
                browser=[ordered]@{priority=$priority;domainType=$domainType;resourceTypes=$resourceList} })
        }
        return [pscustomobject]@{ ReviewedAtUtc=$reviewed; Domains=$entries.ToArray(); Json=$root.GetRawText() }
    } finally { $document.Dispose() }
}
