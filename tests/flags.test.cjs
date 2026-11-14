const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

const context = vm.createContext({ URL });
for (const file of ['src/shared/shared.js', 'src/blocking/flags.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
const { requestSignals, REASONS } = context.BlockAdsFlags;
const signals = (url, type, pageHost = 'uukanshu.cc') => [...requestSignals({ url, type, pageHost })].sort();

test('ad servers seen on uukanshu.cc are flagged with readable reasons', () => {
  assert.deepEqual(signals('https://political-effort.com/bjXWV.s/dRGOlb0/YtWndQi/YlWI5xubZoXDIJ/PeWm/9LuSZ/U_lykUPzT/Ul3CMQDhYHyMMoT/AZtpNHTvcrwkNPjVIXxKMnQN', 'script'),
    ['obfuscated', 'throwaway-domain']);
  assert.deepEqual(signals('https://www.insecure-brief.com/ecc874/5aaddb8b3be5.js', 'script'), ['throwaway-domain']);
  assert.deepEqual(signals('https://imp9.pubadx.one/ad', 'image'), ['ad-path']);
  assert.deepEqual(signals('https://cdn.example.net/0123456789abcdef0123456789abcdef/invoke.js', 'script'), ['network-script']);
  assert.deepEqual(signals('https://ads.example.net/promo/ads/creative.gif?zoneid=7', 'image'), ['ad-path', 'ad-query']);
  assert.deepEqual(signals('https://t.example.net/imp?id=1', 'ping'), ['tracker']);
  assert.deepEqual(signals('https://t.example.net/imp?id=1', 'beacon'), ['tracker'], 'Firefox beacon type counts as ping');
  for (const code of ['obfuscated', 'throwaway-domain', 'ad-path', 'ad-query', 'tracker', 'network-script']) assert.ok(REASONS[code]);
});

test('ordinary third-party files and first-party requests are not flagged', () => {
  for (const [url, type] of [
    ['https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js', 'script'],
    ['https://fonts.googleapis.com/css2?family=Roboto', 'stylesheet'],
    ['https://fonts.gstatic.com/s/roboto/v30/KFOmCnqEu92Fr1Mu4mxK.woff2', 'font'],
    ['https://www.youtube.com/embed/aqz-KE-bpKQ', 'sub_frame'],
    ['https://translate.googleapis.com/translate_a/element.js?cb=init', 'script'],
    ['https://img.example.net/uploads/admin/photo.jpg', 'image'],
    ['https://www.example.net/ads/banner.png', 'main_frame']
  ]) assert.deepEqual(signals(url, type), [], url);
  assert.deepEqual(signals('https://img.uukanshu.cc/ads/banner.png', 'image'), [], 'same site is first-party');
  assert.deepEqual(signals('https://img.example.com.tw/ads/x.png', 'image', 'example.com.tw'), [], 'a parent and child host share scope');
  assert.deepEqual(signals('https://ads.other.com.tw/ads/x.png', 'image', 'm.example.com.tw'), ['ad-path'], 'another .com.tw site is third-party');
  assert.deepEqual(signals('not a url', 'script'), []);
  assert.deepEqual(signals('https://ads.example.net/ads/x.js', 'script', ''), [], 'unknown page is not scored');
});

test('security scope does not collapse sibling tenants or unrelated IP addresses', () => {
  const { sameSite } = context.BlockAds;
  assert.equal(sameSite('cdn.example.com', 'example.com'), true);
  assert.equal(sameSite('img.example.com', 'www.example.com'), false);
  assert.equal(sameSite('attacker.github.io', 'victim.github.io'), false);
  assert.equal(sameSite('tenant.pages.dev', 'other.pages.dev'), false);
  assert.equal(sameSite('10.0.0.1', '192.168.0.1'), false);
});

test('siteOf remains a non-authoritative pattern-scoring approximation', () => {
  const { siteOf } = context.BlockAds;
  assert.equal(siteOf('www.uukanshu.cc'), 'uukanshu.cc');
  assert.equal(siteOf('m.xsw.tw'), 'xsw.tw');
  assert.equal(siteOf('news.example.com.tw'), 'example.com.tw');
  assert.equal(siteOf('a.b.example.co.uk'), 'example.co.uk');
  assert.equal(siteOf('127.0.0.1'), '127.0.0.1');
  assert.equal(siteOf('localhost'), 'localhost');
});
