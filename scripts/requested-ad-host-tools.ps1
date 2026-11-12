#Requires -Version 7.0
# Explicit user preferences, compiled offline. This is not a reputation feed.
function Read-RequestedAdHosts([string]$Path) {
    $document = Read-BoundedJson $Path 128KB
    try {
        $root = $document.RootElement
        Assert-JsonKeys $root @('schemaVersion','reviewKind','hosts')
        if ($root.GetProperty('schemaVersion').GetInt32() -ne 1 -or
            (Get-JsonString $root.GetProperty('reviewKind')) -cne 'user-requested-ad-hosts' -or
            $root.GetProperty('hosts').ValueKind -ne 'Array' -or $root.GetProperty('hosts').GetArrayLength() -gt 500) {
            throw 'Invalid user-requested ad host list.'
        }
        $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        $rules = [Collections.Generic.List[object]]::new()
        foreach ($entry in $root.GetProperty('hosts').EnumerateArray()) {
            Assert-JsonKeys $entry @('domain','match','requestedOn','reason')
            $domain = Get-JsonString $entry.GetProperty('domain')
            $requested = Get-JsonString $entry.GetProperty('requestedOn') 10
            $reason = Get-JsonString $entry.GetProperty('reason') 200
            $date = [DateTime]::MinValue
            if ((ConvertTo-ReviewedHostname $domain) -cne $domain -or !$seen.Add($domain) -or
                (Get-JsonString $entry.GetProperty('match')) -cne 'exact' -or
                ![DateTime]::TryParseExact($requested, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture, 'None', [ref]$date)) {
                throw 'Invalid or duplicate user-requested ad host.'
            }
            # Keep IDs outside the inherited catalog and site-check ranges.
            # Priority matches custom request filters: explicit allow exceptions
            # still win, while community exceptions cannot undo a user request.
            $rules.Add([ordered]@{
                id=200001+$rules.Count; priority=4; action=@{type='block'}
                condition=[ordered]@{
                    regexFilter='^(http|https|ws|wss)://([^/@]*@)?' + [regex]::Escape($domain) + '\.?(:[0-9]+)?/'
                    resourceTypes=@('main_frame','sub_frame','stylesheet','script','image','font','object','xmlhttprequest','ping','media','websocket','other')
                }
            })
        }
        return [pscustomobject]@{Rules=$rules.ToArray()}
    } finally { $document.Dispose() }
}
