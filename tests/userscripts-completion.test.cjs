const { test } = require('node:test'), assert = require('node:assert/strict');
require('../src/userscripts/userscripts-core.js'); require('../src/ui/manager/userscripts-completion.js'); require('../src/ui/manager/userscripts-external.js');
const { suggest } = BlockAdsCompletion, { normalize, pairing } = ModuleEngineExternalEditor;
const start = '// ==UserScript==\n';
test('metadata completion replaces only the current key or enum token', () => {
  const source = start + '// @graNOT  GM.getValue\n// ==/UserScript==\nconst html="<img>";';
  const caret = source.indexOf('NOT'), result = suggest(source, caret);
  assert.deepEqual(result.items, ['grant']);
  assert.equal(source.slice(0,result.from)+'grant'+source.slice(result.to), source.replace('@graNOT', '@grant'));
  const value = start + '// @grant GM.setV';
  assert.deepEqual(suggest(value,value.length).items,['GM.setValue','GM.setValues']);
  const run = start + '// @run-at document-';
  assert.deepEqual(suggest(run,run.length).items,BlockAdsUserScriptCore.METADATA.values['run-at']);
  const mode = start + '// @inject-into p'; assert.deepEqual(suggest(mode,mode.length).items,['page']);
});
test('completion is bounded to actual metadata and collapsed selections', () => {
  for(const source of ['// @grant GM.', 'const x="// ==UserScript==";\n// @grant GM.',
    start+'// ==/UserScript==\n// @grant GM.', start.replaceAll('\n','\r\n')+'// ==/UserScript==\r\n// @grant GM.',
    start+'// @match https://', start+'// @grant GM. value', start+'// @madeup foo', start+' '.repeat(17000)+'\n// @grant GM.']) {
    assert.equal(suggest(source,source.length),null,source.slice(0,60));
  }
  const source=start+'// @gra'; assert.equal(suggest(source,source.length,source.length+1),null);
  assert.equal(suggest(source,-1),null); assert.equal(suggest('x'.repeat(131073),0),null);
  assert.deepEqual(suggest('\uFEFF'+start+'// @no',start.length+7).items,['noframes']);
});
test('every suggested grant is supported; informational and flag keys are available', () => {
  const grant=start+'// @grant ';assert.deepEqual(suggest(grant,grant.length).items,BlockAdsUserScriptCore.GRANTS);
  const all=start+'// @';const keys=suggest(all,all.length).items;
  for(const key of ['name','downloadURL','top-level-await','exclude-match','tag','resource'])assert.ok(keys.includes(key),key);
  assert.ok(!keys.includes('sandbox'));
});
test('external codes cannot select arbitrary hosts, paths, schemes or MCP ports via a URL', () => {
  const token='A'.repeat(43);assert.deepEqual(pairing('MEF1.1234.'+token),{origin:'http://127.0.0.1:1234',token});
  for(const code of ['ME1.1234.'+token,'MEF1.0.'+token,'MEF1.65536.'+token,'MEF1.01234.'+token,'MEF1.1234.'+token+'/read','http://example.test','MEF1.1234.short'])assert.throws(()=>pairing(code));
  assert.equal(normalize('a\r\nb\rc\n'),'a\nb\nc\n');
});
