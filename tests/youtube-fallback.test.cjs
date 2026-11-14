const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/blocking/youtube-fallback.js'), 'utf8');

// Fault injection for media setters and finite resource limits. Native DOM
// observers, video decoding, controls and navigation are covered by the browser suite.
function fixture(count = 1) {
  let marked = true, skipped = 0, observer, disconnected = 0;
  const listeners = new Map(), faults = {}, attempts = { seek: 0 };
  const player = { classList: { contains: name => marked && name === 'ad-showing' }, querySelectorAll: () => [] };
  class Video {
    constructor() { this.isConnected = true; this.rate = 1.25; this.mute = false; this.time = 0; this.duration = 30; this.end = 30; this.seekable = { length: 1, end: () => this.end }; }
    closest() { return player; }
    get muted() { return this.mute; }
    set muted(value) { if (faults.mute) throw Error('rejected mute'); this.mute = value; }
    get playbackRate() { return this.rate; }
    set playbackRate(value) { if (faults.rate) throw Error('rejected rate'); this.rate = value; }
    get currentTime() { return this.time; }
    set currentTime(value) { attempts.seek++; if (faults.seek) throw Error('rejected seek'); this.time = value; }
  }
  const videos = Array.from({ length: count }, () => new Video());
  const doc = { querySelectorAll: () => videos, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name),
    defaultView: { HTMLVideoElement: Video, getComputedStyle: button => button.style,
      MutationObserver: class { constructor(callback) { observer = callback; } observe() {} disconnect() { disconnected++; } } } };
  const context = vm.createContext({}); vm.runInContext(source, context);
  const guard = context.BlockAdsYouTube.create({ document: doc, onSkipped: () => skipped++ });
  return { guard, videos, faults, attempts, listeners, Video,
    endAd() { marked = false; observer([{ type: 'childList', target: { nodeType: 1, closest: () => player } }]); },
    media(video = videos[0]) { listeners.get('progress')?.({ target: video }); },
    get skipped() { return skipped; }, get disconnected() { return disconnected; } };
}

test('live, unknown and partially seekable ads are never sought or logged as skipped', () => {
  for (const [duration, end] of [[Infinity, 30], [NaN, 30], [30, 5], [0, 0]]) {
    const h = fixture(), video = h.videos[0]; video.duration = duration; video.end = end;
    h.guard.setEnabled(true);
    assert.equal(video.muted, true); assert.equal(h.attempts.seek, 0);
    h.endAd(); assert.equal(h.skipped, 0); assert.equal(video.muted, false); assert.equal(video.playbackRate, 1.25);
    h.guard.setEnabled(false); assert.equal(h.listeners.size, 0); assert.equal(h.disconnected, 1);
  }
});

test('rejected media setters are independent, retry seeking on progress and do not strand cleanup', () => {
  const h = fixture(), video = h.videos[0]; h.faults.mute = h.faults.rate = h.faults.seek = true;
  assert.doesNotThrow(() => h.guard.setEnabled(true));
  assert.equal(video.muted, false); assert.equal(video.playbackRate, 1.25); assert.equal(h.skipped, 0);
  h.faults.seek = false; h.media(); assert.equal(video.currentTime, 30);
  h.endAd(); assert.equal(h.skipped, 1);
  h.guard.setEnabled(false); assert.equal(h.listeners.size, 0);
});

test('disable restores owned state without claiming a skip and keeps later media edits', () => {
  const h = fixture(2); h.guard.setEnabled(true);
  h.videos[1].muted = false; h.videos[1].playbackRate = 1.5;
  h.guard.setEnabled(false);
  assert.equal(h.skipped, 0); assert.equal(h.videos[0].muted, false); assert.equal(h.videos[0].playbackRate, 1.25);
  assert.equal(h.videos[1].muted, false); assert.equal(h.videos[1].playbackRate, 1.5);
  h.guard.setEnabled(false); assert.equal(h.disconnected, 1, 'idempotent stop');
});

test('finite video budget still restores owned media displaced from the discovery window', () => {
  const h = fixture(40), original = h.videos.slice(); h.guard.setEnabled(true);
  assert.equal(h.videos.filter(video => video.muted).length, 32);
  h.videos.unshift(...Array.from({ length: 32 }, () => new h.Video()));
  h.endAd();
  assert.ok(original.every(video => !video.muted && video.playbackRate === 1.25));
  h.guard.setEnabled(false); assert.equal(h.listeners.size, 0);
});
