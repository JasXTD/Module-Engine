/* Clipboard event sink only: never touches the operating system clipboard. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../clipboard.js'), 'utf8');
function fixture() {
  const state = { copies: [], listeners: new Set(), fields: new Set(), refused: false }, url = 'chrome-extension://test/';
  const context = vm.createContext({ TextEncoder, location: { href: url + 'clipboard.html' },
    chrome: { runtime: { id: 'test', getURL: path => url + path, onMessage: { addListener: callback => { state.message = callback; } } } },
    document: { addEventListener: (_name, callback) => state.listeners.add(callback), removeEventListener: (_name, callback) => state.listeners.delete(callback),
      body: { append: field => state.fields.add(field) },
      createElement(tag) { assert.equal(tag,'textarea');return {style:{},select(){state.selected=this;},remove(){state.fields.delete(this);state.selected=undefined;}}; },
      execCommand(command) { assert.equal(command, 'copy'); assert.ok(state.fields.has(state.selected)&&state.selected.value.length,'Copy has a selectable private value');if (state.refused) return false;
        const copy = {}; for (const callback of state.listeners) callback({ clipboardData: { setData: (type, data) => { copy[type] = data; } }, preventDefault() {} });
        state.copies.push(copy); return true; } } });
  vm.runInContext(source, context); return { state, write: context.BlockAdsClipboard.write };
}
test('privileged clipboard helper copies literal HTML and always removes its event listener', () => {
  const { state, write } = fixture(); write({ data: '<script>never executed</script>', type: 'text/html' });
  assert.deepEqual(state.copies, [{ 'text/html': '<script>never executed</script>' }]); assert.equal(state.listeners.size, 0);assert.equal(state.fields.size,0);
  write({data:'',type:'text/plain'});assert.deepEqual(state.copies[1],{'text/plain':''});assert.equal(state.fields.size,0);
  state.refused = true; assert.throws(() => write({ data: 'refused', type: 'text/plain' }), /refused/); assert.equal(state.listeners.size, 0);assert.equal(state.fields.size,0);
  assert.throws(() => write({ data: 'x', type: 'image/png' }), /Unsupported/);
});
test('offscreen clipboard responds only to its extension service worker', () => {
  const { state } = fixture(), message = { type: 'ME_CLIPBOARD_WRITE', details: { data: 'fixture', type: 'text/plain' } };
  for (const sender of [{ id: 'other' }, { id: 'test', tab: { id: 1 } }, { id: 'test', documentId: 'page' }, { id: 'test', url: 'chrome-extension://test/manager.html' }]) {
    state.message(message, sender, () => assert.fail('Untrusted sender received a response'));
  }
  assert.equal(state.copies.length, 0);
  let response; state.message(message, { id: 'test', url: 'chrome-extension://test/background.js' }, value => { response = value; });
  assert.equal(response.ok, true); assert.equal(state.copies.length, 1);
});
