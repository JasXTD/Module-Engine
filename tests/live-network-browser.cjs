const { files: extensionFiles } = require('../scripts/extension-files.cjs');
/* Exercise live-mode browser routing using only local canaries and fake DNS. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { once } = require('node:events');
const { chromium } = require('./browser-smoke.cjs');
const { createLiveProxy } = require('./live-network.cjs');

(async () => {
  const browserName = process.argv[2] || 'chrome';
  if (!['chrome','edge'].includes(browserName)) throw new Error('Choose chrome or edge.');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(),`blockads-live-guard-${browserName}-`));
  const root = path.resolve(__dirname,'..'), extension = path.join(temporary,'extension');
  await fs.mkdir(extension);
  for (const file of extensionFiles) await fs.cp(path.join(root,file),path.join(extension,file),{recursive:true});
  const evidence = { browser:browserName, startedAt:new Date().toISOString(), checks:[], canaryHits:[], canaryConnections:0,
    denied:[], unexpectedAllowed:[], upstreamAttempts:[], dnsQueries:[],
    policy:'Offline test of live-public routing: local canaries only, fake DNS returns loopback, every upstream connection forbidden' };
  const canaryReply = (request,response) => {
    evidence.canaryHits.push(request.url); response.end('loopback canary reached');
  };
  const canary = http.createServer(canaryReply), canaryV6 = http.createServer(canaryReply);
  for (const server of [canary,canaryV6]) server.on('connection',()=>evidence.canaryConnections++);
  const guard = createLiveProxy({
    record:(kind,host)=>evidence[kind === 'denied' ? 'denied' : 'unexpectedAllowed'].push(host),
    lookup:async host=>{evidence.dnsQueries.push(host); return [{address:'127.0.0.1',family:4}];},
    connect:options=>{evidence.upstreamAttempts.push(options); throw new Error('No upstream connection is permitted in this offline test');}
  });
  const requests = [], tunnels = [];
  guard.proxy.on('request',request=>requests.push(request.url));
  guard.proxy.on('connect',request=>tunnels.push(request.url));
  let browser;
  try {
    canary.listen(0,'127.0.0.1'); await once(canary,'listening');
    canaryV6.listen(canary.address().port,'::1'); await once(canaryV6,'listening');
    guard.proxy.listen(0,'127.0.0.1'); await once(guard.proxy,'listening');
    browser = await chromium(extension,path.join(temporary,'profile'),guard.proxy.address().port,{networkMode:'live-public'});
    evidence.version = browser.version; evidence.launch = browser.launch;
    await browser.send('Browser.setDownloadBehavior',{behavior:'deny',eventsEnabled:true});
    const page = await browser.open('data:text/html,<title>Offline network guard canary</title>');
    const port = canary.address().port;
    for (const host of ['127.0.0.1','127.1','2130706433','0x7f000001','localhost','sub.localhost','[::1]']) {
      const before = requests.length, url = new URL(`http://${host}:${port}/certificate.cer`).href;
      await browser.navigate(page,url);
      assert.equal(evidence.canaryConnections,0,`Live launcher bypassed its proxy for ${host}`);
      assert.ok(requests.slice(before).includes(url),`Proxy must observe and deny ${host}`);
      evidence.checks.push(`HTTP ${host} routed through the guard without reaching the local canary`);
    }
    // Literal URLs target only this test's own port, even if a launcher regresses.
    // The reserved-name URL uses synthetic private DNS; no real lookup occurs.
    for (const host of ['127.0.0.1','[::1]','localhost','127.1','private-answer.test']) {
      const targetPort = host === 'private-answer.test' ? 443 : port;
      const before = tunnels.length, url = new URL(`https://${host}:${targetPort}/`);
      await browser.navigate(page,url.href);
      assert.equal(evidence.canaryConnections,0);
      assert.ok(tunnels.slice(before).includes(`${url.hostname}:${targetPort}`),`Proxy must observe and deny TLS ${host}`);
      evidence.checks.push(`HTTPS ${host} rejected before any upstream socket`);
    }
    assert.ok(evidence.dnsQueries.includes('private-answer.test.'));
    assert.equal(evidence.unexpectedAllowed.length,0);
    assert.equal(evidence.upstreamAttempts.length,0);
    evidence.success = true;
  } catch (error) { evidence.error = error.stack; process.exitCode = 1; }
  finally {
    if (browser) {
      try { evidence.cleanup = await browser.close(); assert.ok(evidence.cleanup.closed,'Isolated browser must close'); }
      catch (error) { evidence.cleanupError = error.stack; evidence.success = false; process.exitCode = 1; }
    }
    await guard.close();
    for (const server of [canary,canaryV6]) {
      server.closeAllConnections();
      if (server.listening) await new Promise(resolve=>server.close(resolve));
    }
    evidence.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(temporary,'evidence.json'),JSON.stringify(evidence,null,2));
    console.log(JSON.stringify({browser:browserName,success:!!evidence.success,checks:evidence.checks.length,
      canaryHits:evidence.canaryHits.length,evidence:path.join(temporary,'evidence.json'),error:evidence.error},null,2));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
