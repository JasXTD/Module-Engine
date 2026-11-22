const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
// Objects from the vm realm have other prototypes; compare their JSON values.
const plain = value => JSON.parse(JSON.stringify(value));
const source = fs.readFileSync(path.resolve(__dirname, '..', 'src/blocking/youtube.js'), 'utf8');

function page(before = '') {
  class Response {
    constructor(body, url = 'https://www.youtube.com/youtubei/v1/player') { this.body = body; this.url = url; }
    async json() { return JSON.parse(this.body); }
    async text() { return this.body; }
  }
  const context = vm.createContext(vm.constants?.DONT_CONTEXTIFY);
  Object.assign(context, { Response, URL, location: { origin: 'https://www.youtube.com' } });
  context.window = context;
  vm.runInContext(before, context);
  vm.runInContext(source, context, { filename: 'src/blocking/youtube.js' });
  return context;
}
const ads = () => ({ adPlacements: [{ ad: 1 }], adSlots: [{ slot: 1 }], playerAds: [{ player: 1 }],
  streamingData: { formats: [1] }, videoDetails: { videoId: 'x' } });

test('initial player response assignment loses only its ad schedule', () => {
  const context = page();
  vm.runInContext(`var ytInitialPlayerResponse = ${JSON.stringify(ads())};`, context);
  const response = vm.runInContext('ytInitialPlayerResponse', context);
  assert.deepEqual(Object.keys(response).sort(), ['streamingData', 'videoDetails']);
  assert.equal(response.videoDetails.videoId, 'x');
});

test('nested and longer batches retain video content while removing only player schedules', () => {
  const context = page();
  const input = { envelope: { parts: Array.from({ length: 20 }, () => ({ playerResponse: ads() })) }, ordinary: { playerAds: 'ordinary field' } };
  context.input = JSON.stringify(input);
  const output = plain(vm.runInContext('JSON.parse(input)', context));
  assert.ok(output.envelope.parts.every(item => !item.playerResponse.adSlots && item.playerResponse.videoDetails.videoId === 'x'));
  assert.deepEqual(output.ordinary, input.ordinary);
});

for (const configurable of [true, false]) test(`late initial response is preserved and filtered (configurable=${configurable})`, () => {
  const context = page(`Object.defineProperty(window, 'ytInitialPlayerResponse', { configurable: ${configurable}, writable: true, value: ${JSON.stringify(ads())} });`);
  assert.equal(context.ytInitialPlayerResponse.adPlacements, undefined);
  assert.equal(context.ytInitialPlayerResponse.videoDetails.videoId, 'x');
});

test('frozen branches and accessors do not prevent filtering a writable sibling or run page getters', () => {
  const context = page();
  vm.runInContext(`var reads = 0; var data = { frozen: Object.freeze(${JSON.stringify(ads())}), later: ${JSON.stringify(ads())} }; Object.defineProperty(data, 'trap', { enumerable: true, get() { reads++; throw Error('no'); } }); data.cycle = data; ytInitialPlayerResponse = data;`, context);
  assert.equal(context.reads, 0);
  assert.equal(context.ytInitialPlayerResponse.later.playerAds, undefined);
  assert.equal(context.ytInitialPlayerResponse.frozen.videoDetails.videoId, 'x');
});

test('JSON.parse removes ad schedules from bare, wrapped and batched player data', () => {
  const context = page();
  const parse = text => vm.runInContext(`JSON.parse(${JSON.stringify(text)})`, context);
  assert.equal(parse(JSON.stringify(ads())).adPlacements, undefined);
  const wrapped = parse(JSON.stringify({ playerResponse: ads(), other: 1 }));
  assert.equal(wrapped.playerResponse.playerAds, undefined);
  assert.deepEqual(plain(wrapped.playerResponse.streamingData), { formats: [1] });
  const batch = parse(JSON.stringify([{ page: 'watch' }, { playerResponse: ads() }]));
  assert.equal(batch[1].playerResponse.adSlots, undefined);
  assert.deepEqual(plain(parse('{"a":[1,2],"adPlacementsX":true}')), { a: [1, 2], adPlacementsX: true });
  assert.equal(parse('3'), 3);
  assert.equal(parse('null'), null);
  assert.throws(() => vm.runInContext('JSON.parse("{")', context), error => error.name === 'SyntaxError');
  assert.deepEqual(plain(vm.runInContext(`JSON.parse('{"a":1}', (k, v) => typeof v === 'number' ? v + 1 : v)`, context)), { a: 2 });
});

test('fetch Response.json removes ad schedules and keeps video data', async () => {
  const context = page();
  const data = await vm.runInContext(`new Response(${JSON.stringify(JSON.stringify(ads()))}).json()`, context);
  assert.equal(data.adPlacements, undefined);
  assert.equal(data.videoDetails.videoId, 'x');
});

test('player Response.text filters before a captured parser or reviver sees the schedule', async () => {
  const context = page('var capturedParse = JSON.parse;');
  context.input = JSON.stringify({ envelope: { playerResponse: ads() } });
  const output = await vm.runInContext(`new Response(input).text().then(text => capturedParse(text, function(key, value) { if (key === 'adSlots') throw Error('reviver saw an ad'); return value; }))`, context);
  assert.equal(output.envelope.playerResponse.adSlots, undefined);
  assert.equal(output.envelope.playerResponse.videoDetails.videoId, 'x');
});

test('text filter preserves non-player endpoints, other origins, invalid and oversized bodies byte-for-byte', async () => {
  const context = page();
  for (const [input, url] of [
    [JSON.stringify(ads()), 'https://www.youtube.com/ordinary'],
    [JSON.stringify(ads()), 'https://other.example/youtubei/v1/player'],
    ['{"adSlots": broken', 'https://www.youtube.com/youtubei/v1/player'],
    ['{"adSlots": [1], "note": "ordinary data"}', 'https://www.youtube.com/youtubei/v1/player'],
    [JSON.stringify(ads()) + ' '.repeat(4 * 1024 * 1024), 'https://www.youtube.com/youtubei/v1/player']
  ]) {
    context.input = input; context.url = url;
    assert.equal(await vm.runInContext('new Response(input, url).text()', context), input);
  }
});

test('read-only initial accessors are preserved without invoking them and independent parse hooks still work', () => {
  const context = page(`var reads = 0; Object.defineProperty(window, 'ytInitialPlayerResponse', { configurable: true, get() { reads++; throw Error('page getter'); } }); Object.defineProperty(JSON, 'parse', { writable: false, configurable: false });`);
  assert.equal(context.reads, 0);
  assert.throws(() => vm.runInContext('ytInitialPlayerResponse', context), /page getter/);
  return vm.runInContext(`new Response(${JSON.stringify(JSON.stringify(ads()))}).json()`, context).then(value => assert.equal(value.adSlots, undefined));
});

test('parse hooks preserve reviver this, exceptions and source context', () => {
  const context = page();
  assert.deepEqual(plain(vm.runInContext(`JSON.parse('{"big":12345678901234567890}', function(k, v, ctx) { return k === 'big' ? { source: ctx.source, owned: Object.hasOwn(this, k) } : v; })`, context)), { big: { source: '12345678901234567890', owned: true } });
  assert.throws(() => vm.runInContext(`JSON.parse('{"x":1}', () => { throw Error('reviver failure'); })`, context), /reviver failure/);
});

test('traversal is bounded in depth and breadth and leaves over-budget records intact', () => {
  const context = page();
  context.input = JSON.stringify(Array.from({ length: 600 }, ads));
  const output = vm.runInContext('JSON.parse(input)', context);
  assert.equal(output[0].adSlots, undefined);
  assert.ok(output[599].adSlots);
  let deep = ads(); for (let i = 0; i < 12; i++) deep = { child: deep };
  context.input = JSON.stringify(deep);
  let result = vm.runInContext('JSON.parse(input)', context); for (let i = 0; i < 12; i++) result = result.child;
  assert.ok(result.adSlots);
});
