#Requires -Version 7.0
# Manual, passive evidence only. This code never resolves hosts or fetches reports.
function Get-ThreatDate([string]$Value, [switch]$AllowMonth) {
    if ($AllowMonth -and $Value -cmatch '^\d{4}-\d{2}$') { $Value += '-01' }
    $parsed = [DateTimeOffset]::MinValue
    if ($Value -cnotmatch '^\d{4}-\d{2}-\d{2}$' -or
        ![DateTimeOffset]::TryParseExact($Value, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$parsed)) { throw 'A valid dated observation is required.' }
    return $parsed
}

function Read-ThreatReportCatalog([string]$Path, [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow) {
    $document = Read-BoundedJson $Path 128KB
    try {
        $root = $document.RootElement
        Assert-JsonKeys $root @('schemaVersion','reviewKind','reviewedOn','maxAgeDays','sources','domains')
        if ($root.GetProperty('schemaVersion').GetInt32() -ne 1 -or
            (Get-JsonString $root.GetProperty('reviewKind')) -cne 'passive-dated-threat-reports' -or
            $root.GetProperty('maxAgeDays').GetInt32() -ne 90) { throw 'Unsupported threat evidence policy.' }
        $reviewed = Get-ThreatDate (Get-JsonString $root.GetProperty('reviewedOn'))
        if ($reviewed -gt $Now) { throw 'Future review date.' }
        $sources = $root.GetProperty('sources')
        $domains = $root.GetProperty('domains')
        if ($sources.ValueKind -ne 'Array' -or $sources.GetArrayLength() -notin 1..10 -or
            $domains.ValueKind -ne 'Array' -or $domains.GetArrayLength() -notin 1..100) { throw 'Invalid threat catalog bounds.' }
        $publishers = @{ 'Proofpoint'='www.proofpoint.com'; 'Volexity'='www.volexity.com' }
        $sourceDates = @{}
        foreach ($source in $sources.EnumerateArray()) {
            Assert-JsonKeys $source @('id','publisher','url','publishedOn')
            $id = Get-JsonString $source.GetProperty('id') 64
            $publisher = Get-JsonString $source.GetProperty('publisher') 64
            $url = Get-JsonString $source.GetProperty('url') 1024
            $uri = $null
            if ($id -cnotmatch '^[a-z][a-z0-9-]+$' -or $sourceDates.ContainsKey($id) -or
                !$publishers.ContainsKey($publisher) -or ![Uri]::TryCreate($url, [UriKind]::Absolute, [ref]$uri) -or
                $uri.Scheme -cne 'https' -or $uri.Host -cne $publishers[$publisher] -or !$uri.IsDefaultPort -or
                $uri.UserInfo -or $uri.Query -or $uri.Fragment -or
                [Uri]::UnescapeDataString($uri.AbsolutePath) -match '\.(txt|zip|exe|dll|pdf)/?$' -or
                $uri.AbsolutePath -notmatch '/blog/') { throw 'Expected an approved publisher HTML report URL.' }
            $published = Get-ThreatDate (Get-JsonString $source.GetProperty('publishedOn'))
            if ($published -gt $reviewed) { throw 'Report must predate review.' }
            $sourceDates[$id] = $published
        }
        $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        $earliest = $reviewed
        $rules = @()
        foreach ($entry in $domains.EnumerateArray()) {
            Assert-JsonKeys $entry @('host','match','sourceId','observedOn','role','section')
            $hostName = Get-JsonString $entry.GetProperty('host')
            $sourceId = Get-JsonString $entry.GetProperty('sourceId') 64
            $role = Get-JsonString $entry.GetProperty('role') 32
            $null = Get-JsonString $entry.GetProperty('section') 120
            if ((ConvertTo-ReviewedHostname $hostName) -cne $hostName -or !$seen.Add($hostName) -or
                (Get-JsonString $entry.GetProperty('match')) -cne 'exact' -or !$sourceDates.ContainsKey($sourceId) -or
                $role -cnotin @('exploit-delivery','malware-delivery','malware-c2') -or
                $hostName -in @('workers.dev','cloudflarestorage.com','github.com','github.io','gmail.com','outlook.com')) {
                throw 'Invalid threat hostname, evidence, or scope.'
            }
            # Month-only reports retain that precision in the source. Expiry uses
            # the FIRST day, never a made-up last-seen date or today's review date.
            $observed = Get-ThreatDate (Get-JsonString $entry.GetProperty('observedOn')) -AllowMonth
            if ($observed -gt $sourceDates[$sourceId] -or $observed.AddDays(90) -le $reviewed) {
                throw 'Evidence was future-dated or already stale at review.'
            }
            if ($observed -lt $earliest) { $earliest = $observed }
            $rules += [ordered]@{
                id=$rules.Count + 1; priority=3; action=@{type='block'}
                condition=[ordered]@{
                    regexFilter='^(http|https|ws|wss)://([^/@]*@)?' + [regex]::Escape($hostName) + '\.?(:[0-9]+)?/'
                    resourceTypes=@('main_frame','sub_frame','stylesheet','script','image','font','object','xmlhttprequest','ping','media','websocket','other')
                }
            }
        }
        return [pscustomobject]@{
            Rules=$rules
            Policy=[ordered]@{
                schemaVersion=1; ruleCount=$rules.Count
                evidenceFrom=$earliest.ToString('yyyy-MM-ddTHH:mm:ssZ')
                reviewedAt=$reviewed.ToString('yyyy-MM-ddTHH:mm:ssZ')
                expiresAt=$earliest.AddDays(90).ToString('yyyy-MM-ddTHH:mm:ssZ')
            }
        }
    } finally { $document.Dispose() }
}
