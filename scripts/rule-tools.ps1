# Local rule validation and transactional publication; no network operations.
function Test-GeneratedRules([hashtable]$RuleSets) {
    $validTypes = @('main_frame','sub_frame','stylesheet','script','image','font','object','xmlhttprequest','ping','media','websocket','other')
    foreach ($name in $RuleSets.Keys) {
        $ids = [Collections.Generic.HashSet[int]]::new()
        foreach ($rule in $RuleSets[$name]) {
            if ($rule.id -lt 1 -or !$ids.Add($rule.id) -or $rule.priority -lt 1 -or $rule.action.type -ne 'block') { throw "Invalid rule in $name." }
            $filter = $rule.condition.urlFilter
            $exactHostRegex = $rule.condition.regexFilter
            if (!$filter -and !$exactHostRegex -or ($filter -and $exactHostRegex) -or
                ($filter -and ($filter.StartsWith('||*') -or $filter -match '[^\u0020-\u007e]'))) { throw "Invalid filter in $name (rule $($rule.id))." }
            if (!$rule.condition.resourceTypes.Count) { throw "Missing resource types in $name." }
            foreach ($type in $rule.condition.resourceTypes) {
                if ($type -notin $validTypes) { throw "Invalid resource type in $name." }
            }
        }
    }
}

function Write-RuleOutputs([string]$Directory, [hashtable]$Outputs) {
    $staged = @{}
    $originals = @{}
    $published = [Collections.Generic.List[string]]::new()
    try {
        foreach ($name in $Outputs.Keys) {
            if ([IO.Path]::GetFileName($name) -cne $name) { throw 'Output must be a file in the rules directory.' }
            $target = Join-Path $Directory $name
            $originals[$name] = if (Test-Path -LiteralPath $target) { [IO.File]::ReadAllBytes($target) } else { $null }
            $staged[$name] = Join-Path $Directory ('.' + [Guid]::NewGuid().ToString('N') + '.tmp')
            [IO.File]::WriteAllText($staged[$name], $Outputs[$name] + "`n", [Text.UTF8Encoding]::new($false))
        }
        foreach ($name in ($Outputs.Keys | Sort-Object)) {
            [IO.File]::Move($staged[$name], (Join-Path $Directory $name), $true)
            $published.Add($name)
        }
    } catch {
        $failure = $_
        $restoreFailures = [Collections.Generic.List[string]]::new()
        foreach ($name in $published) {
            try {
                $target = Join-Path $Directory $name
                if ($null -eq $originals[$name]) { [IO.File]::Delete($target) }
                else {
                    [IO.File]::WriteAllBytes($staged[$name], $originals[$name])
                    [IO.File]::Move($staged[$name], $target, $true)
                }
            } catch { $restoreFailures.Add($name) }
        }
        if ($restoreFailures.Count) { throw "Rule publication failed and these files could not be restored: $($restoreFailures -join ', '). Restore from backup before reloading the extension." }
        throw $failure
    } finally {
        foreach ($temporary in $staged.Values) {
            if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
        }
    }
}
