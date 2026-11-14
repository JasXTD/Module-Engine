const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({URL});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/blocking/network.js'),'utf8'),context);
const parse = text => JSON.parse(JSON.stringify(context.BlockAdsNetwork.parse(text)));

test('network rules retain destination, resource, party and initiating-frame scope', () => {
  const [rule] = parse('||WWW.Cdn.Example.test/sponsor/*$script,xhr,third-party,domain=news.example.test|~shop.news.example.test,match-case');
  assert.deepEqual(rule, {priority:4,action:{type:'block'},condition:{
    requestDomains:['www.cdn.example.test'],urlFilter:'||www.cdn.example.test/sponsor/*',
    resourceTypes:['script','xmlhttprequest'],domainType:'thirdParty',
    initiatorDomains:['news.example.test'],excludedInitiatorDomains:['shop.news.example.test'],isUrlFilterCaseSensitive:true
  }});
});
test('absolute URL anchors retain scheme, port, path and ending boundary', () => {
  assert.equal(parse('|https://WWW.example.test:8443/App.js|$script')[0].condition.urlFilter,'|https://www.example.test:8443/App.js|');
  assert.equal(parse('|https://bücher.example:443/a%20b*')[0].condition.urlFilter,'|https://xn--bcher-kva.example/a%20b*');
  assert.equal(parse('|wss://stream.example.test/socket$websocket')[0].condition.resourceTypes[0],'websocket');
});
test('request exceptions never become whole-page allowAllRequests rules', () => {
  const [rule] = parse('@@||cdn.example.test/player.js$document');
  assert.equal(rule.action.type,'allow');
  assert.deepEqual(rule.condition.resourceTypes,['main_frame']);
  assert.equal(rule.priority,4);
});
test('type complements and party aliases preserve their intended conditions', () => {
  assert(!parse('||example.test^$~script')[0].condition.resourceTypes.includes('script'));
  assert(parse('||example.test^')[0].condition.resourceTypes.includes('main_frame'));
  for(const option of ['third-party','3p','~first-party','~1p']) assert.equal(parse('||example.test^$'+option)[0].condition.domainType,'thirdParty');
  for(const option of ['first-party','1p','~third-party','~3p']) assert.equal(parse('||example.test^$'+option)[0].condition.domainType,'firstParty');
  assert.deepEqual(parse('||example.test^$domain=~www.site.test')[0].condition.excludedInitiatorDomains,['www.site.test']);
});
test('normalization preserves www and international host scope', () => {
  assert.deepEqual(parse('||www.bücher.example^$domain=WWW.BÜCHER.EXAMPLE')[0].condition.initiatorDomains,['www.xn--bcher-kva.example']);
  assert.deepEqual(parse('||127.0.0.1^')[0].condition.requestDomains,['127.0.0.1']);
  assert.deepEqual(parse('||localhost^')[0].condition.requestDomains,['localhost']);
});
test('blank lines, comments and duplicate equivalent rules do not consume extra rules', () => {
  assert.deepEqual(parse('! private local comment\r\n\n'),[]);
  assert.equal(parse('||example.test^$script,image\n||EXAMPLE.test^$image,script').length,1);
});
for(const [name,lines] of Object.entries({
  'unsupported syntax':['/tracker[0-9]+/','*$script','example.test##.ad','||example.test^$redirect=noopjs','||example.test^$removeparam=token','||example.test^$important','||example.test^$badfilter','!#include https://example.test/list','[Adblock Plus 2.0]'],
  'ambiguous or injected patterns':['||example.test','||*example.test^','||example.test*^','||com^','||127.1^','||[::1]^','||example.test:443^','|file://host/path','|https://user:secret@example.test/a','|https://%65xample.test/a','|https://example.test:99999/a','||example.test/a|b','||example.test/a||','||example.test/a#fragment','||example.test/a\\b','||example.test/café','||example.test/a%xx','||example.test/a\u0000b','||example.test^$script$domain=site.test'],
  'contradictory or empty options':['||example.test^$','||example.test^$script,','||example.test^$xhr,xmlhttprequest','||example.test^$script,~script','||example.test^$1p,3p','||example.test^$match-case,match-case','||example.test^$domain=','||example.test^$domain=site.test|','||example.test^$domain=site.test|~site.test','||example.test^$domain=site.test,domain=other.test','||example.test^$domain=https://site.test','||example.test^$~match-case','||example.test^$to=site.test']
})) test('network parser rejects '+name+' before returning any rule', () => {
  for(const line of lines) assert.throws(()=>parse('! header\n||valid.example.test^\n'+line),/Line 3:/,line);
});
test('network parser enforces bounded input, rules, lines and domain scopes', () => {
  assert.throws(()=>parse(null),/text/);
  assert.throws(()=>parse('!'.repeat(100001)),/100,000/);
  assert.throws(()=>parse('||example.test/'+'a'.repeat(2000)),/2,000/);
  const lines=Array.from({length:500},(_,i)=>`||host${i}.example.test^`);
  assert.equal(parse(lines.join('\n')).length,500);
  assert.throws(()=>parse([...lines,'||extra.example.test^'].join('\n')),/500/);
  assert.throws(()=>parse('||example.test^$domain='+Array.from({length:101},(_,i)=>`s${i}.test`).join('|')),/100 initiating/);
});
