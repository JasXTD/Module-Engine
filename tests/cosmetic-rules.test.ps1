#Requires -Version 7.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../scripts/community-list-tools.ps1')
$checks = 0
function Check($Condition, $Message) {
    if (!$Condition) { throw $Message }
    $script:checks++
}
$text = @'
##.generic-ad
##.generic-ad
#@#.global-allowed
example.test##.site-ad
example.test#@#.generic-ad
example.test,~shop.example.test##.scoped-ad
~private.test##.except-private
~private.test#@#.except-private
@@||quiet.test^$generichide
@@||reader.test^$elemhide
@@||Upper.test^$GenericHide
@@||quiet.test/path$generichide
*.example.test##.wildcard
example.test##div:has-text(Sponsored)
example.test,~shop.example.test#?#.card:-abp-has(> .label:-abp-contains("广告")):upward(.section)
news.example.test#@?#.label:has-text(Ad)
#@?#.label:has-text(Advertisement)
##.label:has-text(Sponsored)
example.test##.label:has-text(/Sponsored/i)
example.test##.label:matches-css(color: red)
example.test##.x { color: red }
example.test##+js(unsafe)
||ads.example.test^
keep.test,also.test,wild.*##.mixed-wild
wild.*##.only-wild
keep.test,~wild.*##.excluded-wild
wild.*,~shop.keep.test##.exclusion-left
keep.test,wild.*#@#.generic-ad
keep.test,wild.*##.label:has-text(Promoted)
'@
$list = @{ id='fixture'; title='Fixture'; text=$text; source='https://example.test/list'; license='fixture'; downloadedAtUtc='2026-10-29T00:00:00Z'; sha256=('0' * 64) }
$result = ConvertFrom-CommunityLists @($list)
Check ($result.Cosmetic.generic.Count -eq 1 -and $result.Cosmetic.generic[0] -ceq '.generic-ad') 'Generic selectors must be retained and deduplicated.'
Check ($result.Cosmetic.allow['*'] -contains '.global-allowed') 'Global cosmetic exceptions must be retained.'
Check ($result.Cosmetic.allow['example.test'] -contains '.generic-ad') 'Scoped exceptions must be retained.'
Check ($result.Cosmetic.scoped.Count -eq 3) 'Negated scopes must retain their exclusion rather than broaden the rule.'
Check ($result.Cosmetic.scoped[0].include -contains 'example.test') 'Positive scope is preserved.'
Check ($result.Cosmetic.scoped[0].exclude -contains 'shop.example.test') 'Negative scope is preserved.'
Check ($result.Cosmetic.disableGeneric -contains 'quiet.test') 'Host-wide generichide exceptions must be applied.'
Check ($result.Cosmetic.disableAll -contains 'reader.test') 'Host-wide elemhide exceptions must be applied.'
Check ($result.Cosmetic.disableGeneric -contains 'upper.test' -and $result.Cosmetic.disableAll -notcontains 'upper.test') 'Option case must never turn a generic exception into an all-cosmetic exception.'
Check ($result.Info.skipped['network: unsupported cosmetic exception'] -eq 1) 'Path-specific exceptions must not be broadened to an entire host.'
Check ($result.Info.genericCosmeticSelectors -eq 1) 'Generic selector count is reported.'
Check ($result.Rules.Count -eq 1) 'Cosmetic exceptions must not create network allows.'
Check ($result.Cosmetic.hide['example.test'].Count -eq 1 -and $result.Cosmetic.procedural.Count -eq 5) 'Procedures are kept separately from CSS; unsafe selectors are refused.'
# A name.* wildcard beside ordinary sites drops only that site; the rule stays for the others.
Check (($result.Cosmetic.hide['keep.test'] -contains '.mixed-wild') -and ($result.Cosmetic.hide['also.test'] -contains '.mixed-wild')) 'Sites listed beside a wildcard keep their hiding rule.'
# allow["*"] is the bundle's own key for global exceptions, not a site.
Check (!@($result.Cosmetic.hide.Keys | Where-Object { $_.Contains('*') }).Count -and !@($result.Cosmetic.allow.Keys | Where-Object { $_ -cne '*' -and $_.Contains('*') }).Count) 'Wildcard sites never become site keys.'
Check (!@($result.Cosmetic.hide.Values | Where-Object { $_ -contains '.only-wild' }).Count -and $result.Cosmetic.generic -notcontains '.only-wild') 'A rule for wildcard sites only is skipped, not made generic.'
Check (!@($result.Cosmetic.hide.Values | Where-Object { $_ -contains '.excluded-wild' }).Count -and !@($result.Cosmetic.scoped | Where-Object { $_.selector -ceq '.excluded-wild' }).Count) 'An unsupported excluded site skips the whole rule rather than widen it.'
Check (!@($result.Cosmetic.scoped | Where-Object { $_.selector -ceq '.exclusion-left' }).Count -and $result.Cosmetic.generic -notcontains '.exclusion-left') 'Dropping every included site never leaves an exclusion-only (generic) rule.'
Check ($result.Cosmetic.allow['keep.test'] -contains '.generic-ad') 'Exceptions keep their supported sites.'
Check (@($result.Cosmetic.procedural | Where-Object { $_.include -contains 'keep.test' -and !$_.exception }).Count -eq 1) 'Procedural rules keep their supported sites.'
Check ($result.Info.skipped['cosmetic: wildcard or invalid domain'] -eq 4) 'Whole-rule skips are still counted (*.example.test, wild.* only, ~wild.*, wild.* with only an exclusion left).'
Check ($result.Info.skipped['cosmetic: wildcard or invalid site dropped from a kept rule'] -eq 3) 'Each site dropped from a kept rule is counted.'
$json = ConvertTo-CosmeticJson $result.Cosmetic | ConvertFrom-Json -AsHashtable
Check ($json.schemaVersion -eq 3 -and $json.scoped.Count -eq 3 -and $json.generic.Count -eq 1) 'The new cosmetic contract survives JSON serialization.'
Check ($json.procedural[0].procedure.ops[0].type -ceq 'text' -and $json.procedural[0].procedure.ops[0].value -ceq 'Sponsored') 'Compiled procedures survive JSON serialization.'
Check ($json.procedural[1].procedure.ops[0].plan.ops[0].value -ceq '广告') 'Nested Unicode text survives the Node bridge and JSON serialization.'
Check ($json.procedural[1].procedure.ops[1].selector -ceq '.section' -and $json.procedural[1].exclude[0] -ceq 'shop.example.test') 'Ancestor selectors and excluded sites survive compilation.'
Check ($json.procedural[2].exception -and $json.procedural[3].exception -and !$json.procedural[3].include.Count) 'Both site and global procedural exceptions are preserved.'
Check ($result.Info.skipped['cosmetic: procedural rule needs positive site scope'] -eq 1) 'Unscoped procedural blocking is refused.'
Check ($result.Info.skipped['cosmetic: unsupported procedural syntax'] -eq 2) 'Regex and unsupported procedural operators are reported without broadening.'
Check ($result.Info.proceduralCosmeticRules -eq 5) 'Compiled procedural rule coverage is reported.'
Write-Host "PASS: $checks cosmetic compilation assertions (local strings only)."
