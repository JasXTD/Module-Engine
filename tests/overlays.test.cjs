const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Document, h } = require('./mini-dom.cjs');

// The packaged overlay engine and prompt policies over the offline DOM stub.
function setup() {
  const timers = [];
  let mutated = () => {};
  const context = vm.createContext({ crypto: globalThis.crypto, setTimeout: callback => timers.push(callback), clearTimeout() {},
    MutationObserver: class { constructor(callback) { mutated = callback; } observe() {} disconnect() {} } });
  for (const file of ['src/blocking/overlays.js', 'src/blocking/prompts.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context, { filename: file });
  }
  const doc = new Document(), problems = [];
  const engine = context.BlockAdsOverlays.create({ document: doc, onProblem: error => problems.push(error.message) });
  const rescan = () => { mutated([]); while (timers.length) timers.shift()(); };
  const isHidden = element => [...element.attributes.keys()].some(name => name.startsWith('data-module-engine-overlay-'));
  return { context, doc, engine, problems, rescan, isHidden, prompts: context.BlockAdsPrompts };
}
const inline = (element, property) => [element.style.getPropertyValue(property), element.style.getPropertyPriority(property)];
const notification = doc => h(doc, 'div', { role: 'dialog', rect: { x: 400, y: 100, width: 420, height: 180 }, stylesheet: { position: 'fixed' } },
  h(doc, 'p', {}, 'Turn on notifications to receive breaking news'), h(doc, 'button', {}, 'Allow'), h(doc, 'button', {}, 'No thanks'));

test('ordinary action buttons outside overlays do not exhaust the prompt candidate budget', () => {
  for (const count of [63, 64, 200]) {
    const { doc, engine, problems, isHidden, prompts } = setup();
    const grid = h(doc, 'div', { class: 'products' });
    for (let i = 0; i < count; i++) grid.append(h(doc, 'div', { class: 'card' }, h(doc, 'span', {}, 'Product ' + i), h(doc, 'button', {}, 'Add to cart')));
    const scam = h(doc, 'div', { id: 'scam', stylesheet: { position: 'fixed' }, rect: { x: 300, y: 200, width: 600, height: 300 } },
      h(doc, 'p', {}, 'Your video player is out of date. Update to continue.'), h(doc, 'button', {}, 'Update player'));
    doc.body.append(grid, scam);
    engine.setRules([prompts.notification, prompts.install]);
    assert.deepEqual(problems, [], count + ' buttons');
    assert.equal(isHidden(scam), true, count + ' buttons: the install prompt is still hidden');
  }
});

test('a site\'s permanent horizontal clipping and touch setting survive a prompt', () => {
  const { doc, engine, rescan, isHidden, prompts } = setup();
  // The site's ordinary stylesheet, present before any prompt.
  doc.body.stylesheet = { overflowX: 'hidden', touchAction: 'none' };
  doc.body.append(h(doc, 'p', {}, 'Article text'));
  engine.setRules([prompts.notification]);
  const prompt = notification(doc);
  doc.body.append(prompt);
  // The prompt script also locks vertical scrolling inline.
  doc.body.style.setProperty('overflow-y', 'hidden');
  rescan();
  assert.equal(isHidden(prompt), true);
  assert.deepEqual(inline(doc.body, 'overflow-y'), ['auto', 'important'], 'the prompt lock is released');
  assert.deepEqual(inline(doc.body, 'overflow-x'), ['', ''], 'the layout value is not overridden');
  assert.deepEqual(inline(doc.body, 'touch-action'), ['', '']);
  prompt.remove(); doc.body.style.removeProperty('overflow-y');
  for (let i = 0; i < 3; i++) rescan();
  for (const property of ['overflow-x', 'overflow-y', 'touch-action']) assert.deepEqual(inline(doc.body, property), ['', ''], property + ' after the prompt leaves');
});

test('without a resting snapshot, a leftover horizontal or touch value is released once vertical scrolling is free', () => {
  const { doc, engine, rescan, isHidden, prompts } = setup();
  doc.body.stylesheet = { overflowX: 'hidden', touchAction: 'none' };
  const prompt = notification(doc);
  doc.body.append(prompt);
  doc.body.style.setProperty('overflow-y', 'hidden');
  engine.setRules([prompts.notification]);
  assert.equal(isHidden(prompt), true);
  assert.deepEqual(inline(doc.body, 'overflow-x'), ['auto', 'important'], 'a full lock is released when nothing is known about the layout');
  prompt.remove(); doc.body.style.removeProperty('overflow-y');
  for (let i = 0; i < 3; i++) rescan();
  for (const property of ['overflow-x', 'overflow-y', 'touch-action']) assert.deepEqual(inline(doc.body, property), ['', ''], property + ' is not kept for the page\'s life');
});

test('prompt locks applied before the prompt appears are still released, and leftover lock classes keep the override', () => {
  const { doc, engine, rescan, isHidden, prompts } = setup();
  engine.setRules([prompts.notification]);
  // A deceptive page locks first, then inserts its prompt.
  doc.body.stylesheet = { overflowY: 'hidden', overflowX: 'hidden', pointerEvents: 'none' };
  rescan();
  const prompt = notification(doc);
  doc.body.append(prompt);
  rescan();
  assert.equal(isHidden(prompt), true);
  assert.deepEqual(inline(doc.body, 'overflow-y'), ['auto', 'important']);
  assert.deepEqual(inline(doc.body, 'pointer-events'), ['auto', 'important']);
  prompt.remove(); rescan();
  // The lock class is still on the page after its prompt left.
  assert.deepEqual(inline(doc.body, 'overflow-y'), ['auto', 'important']);
  doc.body.stylesheet = {}; rescan();
  for (const property of ['overflow-x', 'overflow-y', 'pointer-events']) assert.deepEqual(inline(doc.body, property), ['', ''], property);
});
