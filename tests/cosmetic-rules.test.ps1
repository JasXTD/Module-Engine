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
Check ($result.Cosmetic.hide['example.test'].Count -eq 1 -and $result.Cosmetic.procedural.Count -eq 4) 'Procedures are kept separately from CSS; unsafe selectors are refused.'
$json = ConvertTo-CosmeticJson $result.Cosmetic | ConvertFrom-Json -AsHashtable
Check ($json.schemaVersion -eq 3 -and $json.scoped.Count -eq 3 -and $json.generic.Count -eq 1) 'The new cosmetic contract survives JSON serialization.'
Check ($json.procedural[0].procedure.ops[0].type -ceq 'text' -and $json.procedural[0].procedure.ops[0].value -ceq 'Sponsored') 'Compiled procedures survive JSON serialization.'
Check ($json.procedural[1].procedure.ops[0].plan.ops[0].value -ceq '广告') 'Nested Unicode text survives the Node bridge and JSON serialization.'
Check ($json.procedural[1].procedure.ops[1].selector -ceq '.section' -and $json.procedural[1].exclude[0] -ceq 'shop.example.test') 'Ancestor selectors and excluded sites survive compilation.'
Check ($json.procedural[2].exception -and $json.procedural[3].exception -and !$json.procedural[3].include.Count) 'Both site and global procedural exceptions are preserved.'
Check ($result.Info.skipped['cosmetic: procedural rule needs positive site scope'] -eq 1) 'Unscoped procedural blocking is refused.'
Check ($result.Info.skipped['cosmetic: unsupported procedural syntax'] -eq 2) 'Regex and unsupported procedural operators are reported without broadening.'
Check ($result.Info.proceduralCosmeticRules -eq 4) 'Compiled procedural rule coverage is reported.'
Write-Host "PASS: $checks cosmetic compilation assertions (local strings only)."
