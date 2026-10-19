const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
// Objects from the vm realm have other prototypes; compare their JSON values.
const plain = value => JSON.parse(JSON.stringify(value));
const source = fs.readFileSync(path.resolve(__dirname, '..', 'youtube.js'), 'utf8');

function page() {
  class Response {
    constructor(body) { this.body = body; }
    async json() { return JSON.parse(this.body); }
  }
  const context = vm.createContext({ Response });
  context.window = context;
  vm.runInContext(source, context, { filename: 'youtube.js' });
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
