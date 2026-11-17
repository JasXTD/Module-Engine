/* Offline timing probe for generic cosmetic hiding in Chrome or Edge.
   Loads a loopback page with eight same-origin frames in a disposable profile and
   reports, per load: whether each frame's generic probe element was visible
   before it was hidden, when it was first seen hidden, whether a probe for the
   last plain generic selector was hidden, and renderer main-thread time and
   tasks of 50 ms or longer from a trace. `summary` gives medians over the loads.

   node tests/generic-timing-browser.cjs [chrome|edge] [--source <extension folder>] [--loads 4] [--generic-off] [--out file.json]

   --source measures another unpacked copy, such as a `git archive` export of an
   earlier commit, so before/after runs use the same fixture. Node 22+; no packages. */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { once } = require('node:events');
const argument = (name, fallback) => { const index = process.argv.indexOf(name); return index > 0 ? process.argv[index + 1] : fallback; };
const browserName = (process.argv[2] || 'chrome').toLowerCase();
if (!['chrome', 'edge'].includes(browserName)) throw new Error('The trace-based timing probe supports chrome or edge.');
const source = path.resolve(argument('--source', path.join(__dirname, '..')));
const loads = Number(argument('--loads', 4));
const { chromium } = require('./browser-smoke.cjs');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

(async () => {
  // Package the measured copy with that copy's own file inventory.
  const { files } = require(path.join(source, 'scripts/extension-files.cjs'));
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), `blockads-generic-timing-${browserName}-`));
  const extension = path.join(temporary, 'extension');
  for (const file of files) await fs.cp(path.join(source, file), path.join(extension, file), { recursive: true });
  const data = JSON.parse(await fs.readFile(path.join(extension, 'rules/community-cosmetic.json'), 'utf8'));
  // Inert loopback elements only. The first probe sits early in the sorted list;
  // the second is the last plain class selector. Site-exempted selectors are skipped.
  const exempted = new Set(Object.values(data.allow).flat());
  const classes = data.generic.filter(selector => /^\.[a-zA-Z][\w-]*$/.test(selector) && !exempted.has(selector));
  const early = classes[0].slice(1), late = classes.at(-1).slice(1);
  const filler = classes.filter((_, index) => index % Math.floor(classes.length / 40) === 0).map(selector => selector.slice(1));
  // The probe is read once while the parser reaches it (a stylesheet present from
  // document start already hides it), then whenever a style element changes.
  // Event-driven, so the probe adds no polling work to the measured main thread.
  const frameHtml = index => `<!doctype html><html><head><title>frame ${index}</title></head><body>
    <div id="early" class="${early}">Generic probe</div><div id="late" class="${late}">Late generic probe</div>
    <script>
      const timing = top.timing ||= {}, now = () => performance.timeOrigin + performance.now();
      const shown = id => getComputedStyle(document.getElementById(id)).display !== 'none';
      const check = () => {
        if (timing['earlyHidden' + ${index}] !== undefined || shown('early')) return false;
        timing['earlyHidden' + ${index}] = now(); timing['lateShown' + ${index}] = shown('late');
        return true;
      };
      timing['firstCheck' + ${index}] = { at: now(), earlyShown: shown('early') };
      if (!check()) {
        // Hiding styles are added to the head, or to the root before a head exists.
        const observer = new MutationObserver(() => { if (check()) observer.disconnect(); });
        observer.observe(document.head, { subtree: true, childList: true, characterData: true });
        observer.observe(document.documentElement, { childList: true });
        setTimeout(() => observer.disconnect(), 5000);
      }
    </script>
    ${Array.from({ length: 300 }, (_, item) => `<div class="row-${item % 40} ${item % 30 === 0 ? filler[item % filler.length] : ''}"><span>Item ${item}</span> <a href="#${item}">link</a></div>`).join('')}
    </body></html>`;
  // As in the blocker suite, the browser may reset a refused connection; that
  // must not crash Node and strand the browser. Other proxy errors are reported.
  const proxy = { denied: 0, peerResets: 0, errors: [] };
  const proxyError = error => { if (error.code === 'ECONNRESET') proxy.peerResets++; else proxy.errors.push(error.code || error.message); };
  const deny = http.createServer((req, res) => { proxy.denied++; res.writeHead(403, { Connection: 'close' }); res.end(); });
  deny.on('connect', (req, socket) => { proxy.denied++; socket.on('error', proxyError); socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); });
  deny.on('clientError', (error, socket) => { proxyError(error); socket.destroy(); });
  deny.listen(0, '127.0.0.1'); await once(deny, 'listening');
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Cache-Control', 'no-store');
    const frame = /^\/frame(\d)$/.exec(req.url);
    if (frame) return res.end(frameHtml(Number(frame[1])));
    res.end(`<!doctype html><html><head><title>Generic timing</title></head><body>
      ${Array.from({ length: 8 }, (_, index) => `<iframe src="/frame${index}" width="300" height="200"></iframe>`).join('')}</body></html>`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const pageUrl = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium(extension, path.join(temporary, 'profile'), deny.address().port, {});
  const report = { browser: browserName, version: browser.version.product, source, generic: !process.argv.includes('--generic-off'),
    probe: { early: '.' + early, late: '.' + late }, loads: [] };
  try {
    const start = Date.now();
    while (!(await browser.evaluate('typeof api !== "undefined" && api.runtime.sendMessage({ type: "GET_STATE" }).then(r => r.ok)').catch(() => false))) {
      if (Date.now() - start > 20000) throw new Error('Extension state did not load.');
      await pause(100);
    }
    if (!report.generic) await browser.evaluate('api.runtime.sendMessage({ type: "UPDATE_SETTINGS", patch: { genericCosmeticFiltering: false } })');
    report.scripts = await browser.evaluate('api.scripting.getRegisteredContentScripts().then(list => list.map(script => ({ id: script.id, css: script.css, excludeMatches: (script.excludeMatches || []).length })))');
    // This first load warms the service worker and caches; it is not reported.
    const page = await browser.open(pageUrl);
    for (let load = 0; load < loads + 1; load++) {
      const first = browser.events.length;
      await browser.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'toplevel'] } });
      await browser.navigate(page, pageUrl);
      const loaded = Date.now();
      const settled = report.generic ? 'Object.keys(window.timing || {}).filter(key => key.startsWith("earlyHidden")).length === 8' : 'true';
      while (Date.now() - loaded < 15000 && !(await browser.evaluate(`document.readyState === "complete" && ${settled}`, page).catch(() => false))) await pause(100);
      await pause(1000);
      const timing = await browser.evaluate('({ origin: performance.timeOrigin, timing: window.timing || {} })', page);
      await browser.send('Tracing.end');
      while (!browser.events.slice(first).some(event => event.method === 'Tracing.tracingComplete')) await pause(50);
      const events = browser.events.slice(first).filter(event => event.method === 'Tracing.dataCollected').flatMap(event => event.params.value);
      const mains = new Set(events.filter(event => event.name === 'thread_name' && event.args?.name === 'CrRendererMain').map(event => `${event.pid}:${event.tid}`));
      const tasks = events.filter(event => event.ph === 'X' && event.name === 'RunTask' && mains.has(`${event.pid}:${event.tid}`));
      // earlyHiddenMs is relative to the top page's navigation start. With a
      // stylesheet present from document start it is simply when the frame's
      // parser reached the probe.
      const frames = Array.from({ length: 8 }, (_, index) => ({
        earlyHiddenMs: timing.timing['earlyHidden' + index] === undefined ? null : Math.round(timing.timing['earlyHidden' + index] - timing.origin),
        shownBeforeHidden: timing.timing['firstCheck' + index]?.earlyShown ?? null,
        lateHidden: timing.timing['lateShown' + index] === undefined ? null : !timing.timing['lateShown' + index] }));
      // Main-thread time by trace event name; nested events count in each name.
      const byName = new Map();
      for (const event of events) {
        if (event.ph === 'X' && event.name !== 'RunTask' && mains.has(`${event.pid}:${event.tid}`)) byName.set(event.name, (byName.get(event.name) || 0) + event.dur);
      }
      // The first traced load follows the extension's own startup work; it is
      // reported separately from the measured loads.
      (load ? report.loads : (report.warmup = [])).push({
        hiddenMs: { max: Math.max(...frames.map(frame => frame.earlyHiddenMs ?? Infinity)), min: Math.min(...frames.map(frame => frame.earlyHiddenMs ?? Infinity)) },
        framesShownBeforeHidden: frames.filter(frame => frame.shownBeforeHidden).length,
        framesHidingLateProbe: frames.filter(frame => frame.lateHidden).length,
        longTasksMs: tasks.filter(task => task.dur >= 50000).map(task => Math.round(task.dur / 1000)).sort((a, b) => b - a),
        mainThreadBusyMs: Math.round(tasks.reduce((sum, task) => sum + task.dur, 0) / 1000),
        breakdownMs: Object.fromEntries([...byName].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, dur]) => [name, Math.round(dur / 1000)])),
        frames });
      browser.events.splice(first);
    }
  } finally {
    await browser.close(); server.close(); deny.close();
  }
  report.proxy = proxy;
  const median = values => values.toSorted((a, b) => a - b)[values.length >> 1];
  report.summary = { loads: report.loads.length,
    medianMainThreadBusyMs: median(report.loads.map(load => load.mainThreadBusyMs)),
    longTasksPerLoad: report.loads.map(load => load.longTasksMs.length),
    longestTaskMs: Math.max(0, ...report.loads.flatMap(load => load.longTasksMs)),
    framesShownBeforeHidden: report.loads.map(load => load.framesShownBeforeHidden),
    medianLastFrameHiddenMs: report.generic ? median(report.loads.map(load => load.hiddenMs.max)) : null,
    framesHidingLateProbe: report.loads.map(load => load.framesHidingLateProbe) };
  const output = JSON.stringify(report, null, 1);
  if (argument('--out')) await fs.writeFile(argument('--out'), output + '\n');
  console.log(output);
})().catch(error => { console.error(error); process.exitCode = 1; });
