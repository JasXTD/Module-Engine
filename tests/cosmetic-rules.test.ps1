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
# Generic selectors also become the registered stylesheets. example.test exempts
# .generic-ad, so it moves to the excepted sheet, which is not injected there.
$revocable = '.generic-ad:not(:where([data-me-generic-off] *))'
Check ($result.Cosmetic.genericStatic.excepted -contains '.generic-ad' -and $result.Cosmetic.genericStatic.exceptedSites -contains 'example.test') 'A generic selector with a site exception moves to the excepted stylesheet, which skips that site.'
Check ($result.Stylesheets.excepted.Contains($revocable) -and !$result.Stylesheets.base.Contains('.generic-ad')) 'Excepted selectors stay out of the main stylesheet and remain revocable.'
Check ($result.Stylesheets.base.StartsWith('@charset "UTF-8";') -and $result.Stylesheets.excepted.StartsWith('@charset "UTF-8";')) 'The stylesheets declare their encoding first.'
Check ($result.Info.genericStylesheetSelectors -eq $json.generic.Count -and $result.Info.genericExceptedSites -eq $result.Cosmetic.genericStatic.exceptedSites.Count -and $result.Info.genericPerFrameSelectors -eq 0) 'Stylesheet coverage is reported.'
Check ($json.genericStatic.excepted -contains '.generic-ad' -and $json.genericStatic.perFrame.Count -eq 0) 'Stylesheet metadata survives JSON serialization.'
Check ($json.procedural[1].procedure.ops[1].selector -ceq '.section' -and $json.procedural[1].exclude[0] -ceq 'shop.example.test') 'Ancestor selectors and excluded sites survive compilation.'
Check ($json.procedural[2].exception -and $json.procedural[3].exception -and !$json.procedural[3].include.Count) 'Both site and global procedural exceptions are preserved.'
Check ($result.Info.skipped['cosmetic: procedural rule needs positive site scope'] -eq 1) 'Unscoped procedural blocking is refused.'
Check ($result.Info.skipped['cosmetic: unsupported procedural syntax'] -eq 2) 'Regex and unsupported procedural operators are reported without broadening.'
Check ($result.Info.proceduralCosmeticRules -eq 5) 'Compiled procedural rule coverage is reported.'
Check ($result.Info.skipped['scriptlet: unsupported scriptlet or arguments'] -eq 1 -and $result.Info.scriptletRules -eq 0) 'An unknown scriptlet is counted, not kept.'

# The same lines as tests/community-convert.test.cjs, which expects the same JSON and counts from the extension's converter.
$scriptletText = @'
example.test##+js(set, adsBlocked, false)
example.test,~shop.example.test##+js(aopr, detector)
news.example.test#@#+js(set-constant, adsBlocked, false)
quiet.example.test#@#+js()
##+js(set, generic, true)
#@#+js()
wild.*##+js(nowoif)
keep.test,wild.*##+js(nowoif)
example.test##+js(trusted-set-constant, a, 1)
example.test##+js(unknown)
example.test##+js()
example.test#?#+js(set, a, true)
example.test#$#abort-on-property-read foo
'@
$scriptletList = @{ id='scriptlets'; title='Scriptlets'; text=$scriptletText; source='https://example.test/list'; license='fixture'; downloadedAtUtc='2026-10-29T00:00:00Z'; sha256=('0' * 64) }
$scriptletResult = ConvertFrom-CommunityLists @($scriptletList)
$expectedScriptlets = '[{"include":["example.test"],"exclude":[],"exception":false,"name":"set-constant","args":["adsBlocked","false"]},' +
    '{"include":["example.test"],"exclude":["shop.example.test"],"exception":false,"name":"abort-on-property-read","args":["detector"]},' +
    '{"include":["news.example.test"],"exclude":[],"exception":true,"name":"set-constant","args":["adsBlocked","false"]},' +
    '{"include":["quiet.example.test"],"exclude":[],"exception":true,"name":"","args":[]},' +
    '{"include":["keep.test"],"exclude":[],"exception":false,"name":"no-window-open-if","args":[]}]'
Check ((ConvertTo-Json -InputObject @($scriptletResult.Cosmetic.scriptlets) -Compress -Depth 5) -ceq $expectedScriptlets) 'List scriptlet filters become the same scriptlet rules as in the extension.'
Check ($scriptletResult.Info.scriptletRules -eq 5) 'Scriptlet rule coverage is reported.'
$expectedSkips = [ordered]@{ 'cosmetic: procedural or unsafe selector' = 1; 'cosmetic: snippet or HTML filter' = 1; 'cosmetic: wildcard or invalid domain' = 1
    'cosmetic: wildcard or invalid site dropped from a kept rule' = 1; 'scriptlet: filter without a site' = 2; 'scriptlet: no scriptlet named' = 1
    'scriptlet: unsupported scriptlet or arguments' = 2 }
Check ((ConvertTo-Json $scriptletResult.Info.skipped -Compress) -ceq (ConvertTo-Json $expectedSkips -Compress)) 'Generic, wildcard-only, unknown and unnamed scriptlet filters are counted, as in the extension.'
Check (!$scriptletResult.Rules.Count -and !$scriptletResult.Cosmetic.hide.Count -and !@($scriptletResult.Cosmetic.procedural).Count) 'No scriptlet becomes a network or hiding rule.'
$scriptletJson = ConvertTo-CosmeticJson $scriptletResult.Cosmetic | ConvertFrom-Json -AsHashtable
Check ($scriptletJson.scriptlets.Count -eq 5 -and $scriptletJson.scriptlets[3].name -ceq '' -and $scriptletJson.scriptlets[3].args.Count -eq 0) 'Scriptlet rules survive JSON serialization.'

# uBlock Origin's own syntax; tests/community-convert.test.cjs expects the same results.
$conditions = @(@('', $null), @('false', $false), @('!false', $true), @('cap_html_filtering', $false), @('!cap_html_filtering', $true),
    @('env_firefox', $null), @('!env_firefox', $null), @('env_firefox && false', $false), @('env_firefox || !false', $true), @('env_firefox || false', $null),
    @('(env_firefox)', $null), @('!(env_safari || env_mobile)', $true), @('!!env_safari', $false), @('(false || !env_safari) && !ext_ubol', $true),
    @('a && b || c', $null), @('(a', $null), @('a)', $null), @('&& a', $null), @('a &&', $null), @('Env_Safari', $null), @('env_safari env_mobile', $null),
    @((@('false') * 26) -join ' && ', $null))
foreach ($pair in $conditions) {
    $value = Get-CommunityCondition $pair[0]
    Check (($null -eq $value -and $null -eq $pair[1]) -or ($null -ne $value -and $null -ne $pair[1] -and $value -eq $pair[1])) "Condition '$($pair[0])' evaluates as in the extension."
}
$ublockText = @'
!#if !cap_html_filtering
kept-if.example##.kept-if
!#else
dropped-else.example##.dropped-else
!#endif
!#if env_firefox
firefox.example##.firefox-only
! a comment is not counted
!#else
chromium.example##.not-firefox
!#endif
!#if cap_html_filtering
html.example##^script:has-text(ad)
!#else
kept-else.example##.kept-else
!#endif
!#if env_mobile
!#if !env_safari
nested.example##.nested
!#endif
!#endif
!#if (false || !env_safari) && !ext_ubol
compound.example##.compound
!#endif
!#if env_chromium && false
false-and.example##.false-and
!#else
false-and-else.example##.false-and-else
!#endif
!#if env_chromium || env_firefox && false
mixed.example##.mixed
!#endif
!#if !
broken.example##.broken
!#endif
!#endif
!#else
example.test##^script:has-text(ads)
example.test#@#^script:has-text(ads)
@@||ghide.example^$ghide
@@||ehide.example^$ehide
@@||long.example^$generichide
!#if env_safari
unclosed.example##.unclosed
'@
$ublockList = @{ id='ublock'; title='uBlock syntax'; text=$ublockText; source='https://example.test/list'; updates='release'; license='fixture'; downloadedAtUtc='2026-10-29T00:00:00Z'; sha256=('0' * 64) }
$ublockResult = ConvertFrom-CommunityLists @($ublockList)
Check ((ConvertTo-Json $ublockResult.Cosmetic.hide -Compress) -ceq '{"compound.example":[".compound"],"false-and-else.example":[".false-and-else"],"kept-else.example":[".kept-else"],"kept-if.example":[".kept-if"]}') 'Only blocks whose condition holds in every supported browser are converted.'
Check ((@($ublockResult.Cosmetic.disableGeneric) -join ',') -ceq 'ghide.example,long.example' -and (@($ublockResult.Cosmetic.disableAll) -join ',') -ceq 'ehide.example') 'ghide and ehide are the generichide and elemhide exceptions.'
$expectedUblockSkips = [ordered]@{ 'conditional: block for some browsers only, or an unknown condition' = 4; 'conditional: block that does not apply to Module Engine' = 5; 'cosmetic: snippet or HTML filter' = 2 }
Check ((ConvertTo-Json $ublockResult.Info.skipped -Compress) -ceq (ConvertTo-Json $expectedUblockSkips -Compress)) 'Left-out blocks and HTML filters are counted as in the extension.'
Check (!$ublockResult.Rules.Count -and !$ublockResult.Cosmetic.allow.Count -and !@($ublockResult.Cosmetic.procedural).Count) 'No left-out line becomes a rule.'
Check ($ublockResult.Info.lists[0].updates -ceq 'release' -and $null -eq $ublockResult.Info.lists[0].version) 'The list record keeps how it updates, and a list without a version has none.'
Write-Host "PASS: $checks cosmetic compilation assertions (local strings only)."
