/* Page compatibility transport. The page is not a security isolation boundary:
 * only the isolated host owns a native capability; the broker rechecks grants. */
(() => {
  'use strict';
  // Runs natively in MAIN before the isolated runner. Creating the script here
  // makes the browser apply the page's CSP (Chromium USER_SCRIPT cannot do this).
  function bootstrap(name) {
    const apply = Reflect.apply, create = Document.prototype.createElement, find = Document.prototype.getElementById;
    const append = Node.prototype.appendChild, remove = Element.prototype.remove, clear = Element.prototype.replaceChildren;
    const text = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
    const add = EventTarget.prototype.addEventListener, off = EventTarget.prototype.removeEventListener;
    const listen = event => {
      if (typeof event.detail !== 'string' || !/^me-page-[a-f0-9-]{36}$/.test(event.detail)) return;
      const node = apply(find, document, [event.detail]);
      if (!node || node.localName !== 'script' || node.type !== 'application/x-module-engine') return;
      const source = apply(text.get, node, []);
      if (!source || source.length > 4 * 1024 * 1024) return;
      apply(off, document, [name, listen]);
      const script = apply(create, document, ['script']);
      try {
        apply(text.set, script, [source]);
        apply(append, document.head || document.documentElement, [script]);
      } finally { apply(clear, script, []); apply(remove, script, []); }
    };
    apply(add, document, [name, listen]);
  }
  // Serialized into MAIN. This adapter exposes only the existing GM message
  // shapes, not extension APIs. It never receives a native capability token
  // or the install ID.
  function client(nodeId, outgoing, incoming, run) {
    'use strict';
    const node = document.getElementById(nodeId), apply = Reflect.apply;
    const dispatch = EventTarget.prototype.dispatchEvent, add = EventTarget.prototype.addEventListener, off = EventTarget.prototype.removeEventListener;
    const Event = CustomEvent, parse = JSON.parse, stringify = JSON.stringify;
    const schedule = setTimeout, cancel = clearTimeout, Async = Promise, MAX = 24 * 1024 * 1024;
    const calls = new Map(), ports = new Map(); let next = 0, closed = false, suspended = false;
    const emit = packet => {
      if (closed) throw new Error('Page bridge is closed. Reload the page.');
      const detail = stringify(packet);
      if (detail.length > MAX) throw new Error('Page bridge packet exceeds 24 MiB. Use content mode for this transfer.');
      apply(dispatch, node, [new Event(outgoing, { detail })]);
    };
    const listeners = () => {
      const list = new Set();
      return { addListener: fn => list.add(fn), fire: value => { for (const fn of list) fn(value); } };
    };
    function rejectCalls(reason, keepCompletions = false) {
      for (const [n, job] of calls) {
        if (keepCompletions && job.completionOnly) continue;
        cancel(job.timer); calls.delete(n);
        job.reject(new Error(reason + '; a submitted operation may still complete and will not be retried.'));
      }
    }
    function close() {
      if (closed) return; closed = true; apply(off, node, [incoming, receive]);
      rejectCalls('Page bridge closed');
      for (const port of [...ports.values()]) port.lost();
    }
    function receive(event) {
      if (closed || event.target !== node || typeof event.detail !== 'string' || event.detail.length > MAX) return;
      let packet; try { packet = parse(event.detail); } catch { return; }
      if (packet?.kind === 'closed') { close(); return; }
      if (packet?.kind === 'suspend') {
        suspended = true; rejectCalls('Page bridge suspended for navigation', true);
        for (const port of [...ports.values()]) port.lost();
        return;
      }
      if (packet?.kind === 'resume') { suspended = false; return; }
      if (packet?.kind === 'reply') {
        const job = calls.get(packet.n); if (!job) return;
        calls.delete(packet.n); cancel(job.timer); job.resolve(packet.value);
      } else if (packet?.kind === 'event') ports.get(packet.n)?.onMessage.fire(packet.value);
      else if (packet?.kind === 'disconnect') ports.get(packet.n)?.lost();
    }
    apply(add, node, [incoming, receive]);
    const runtime = {
      sendMessage(message) {
        if (closed || suspended) return Async.reject(new Error('Page bridge is ' + (closed ? 'closed' : 'suspended') + '. Reload or return to the page.'));
        if (calls.size >= 8) return Async.reject(new Error('Too many pending page GM requests.'));
        return new Async((resolve, reject) => {
          const n = ++next, timer = schedule(() => { calls.delete(n); reject(new Error('Page bridge request timed out; it may still complete and was not retried.')); }, 130000);
          const completionOnly = /^(set|delete)(Many)?$/.test(message?.operation) || message?.operation === 'cookie' && ['set', 'delete'].includes(message.method);
          calls.set(n, { resolve, reject, timer, completionOnly });
          try { emit({ kind: 'call', n, message }); } catch (error) { calls.delete(n); cancel(timer); reject(error); }
        });
      },
      connect() {
        if (closed || suspended) throw new Error('Page bridge is inactive. Reload or return to the page.');
        if (ports.size >= 1) throw new Error('A page GM connection is already open.');
        const n = ++next, onMessage = listeners(), onDisconnect = listeners(); let ended = false;
        const port = { onMessage, onDisconnect,
          lost() { if (ended) return; ended = true; ports.delete(n); onDisconnect.fire(); },
          disconnect() { if (ended) return; ended = true; ports.delete(n); emit({ kind: 'disconnect', n }); }
        };
        ports.set(n, port);
        // Native connect events are asynchronous. Defer only this handshake so
        // runUserScript can install its listeners before a synchronous rejection.
        Async.resolve().then(() => { if (!ended) emit({ kind: 'connect', n }); }).catch(() => port.lost());
        return port;
      }
    };
    emit({ kind: 'claim' });
    run(runtime);
  }
  // Runs in the per-script USER_SCRIPT world. Never stringify options/fallback:
  // they contain the native capability and must not cross the page boundary.
  function host(options, pageRun, clientSource, fallback) {
    const native = (globalThis.browser || globalThis.chrome)?.runtime, MAX = 24 * 1024 * 1024;
    const node = document.createElement('script'), uuid = crypto.randomUUID();
    const outgoing = 'me-out-' + uuid, incoming = 'me-in-' + uuid;
    const calls = new Set(), ports = new Map(); let claimed = false, started = false, closed = false, suspended = false, generation = 0, rate = 0, rateStart = Date.now(), observer;
    node.id = 'me-page-' + uuid; node.type = 'application/x-module-engine';
    function emit(packet) {
      if (closed) return;
      const detail = JSON.stringify(packet);
      if (detail.length > MAX) { close(); return; }
      node.dispatchEvent(new CustomEvent(incoming, { detail }));
    }
    function disconnect(n) {
      const port = ports.get(n); if (!port) return; ports.delete(n);
      port.disconnect(); emit({ kind: 'disconnect', n });
    }
    function close() {
      if (closed) return;
      closed = true; observer?.disconnect();
      node.dispatchEvent(new CustomEvent(incoming, { detail: JSON.stringify({ kind: 'closed' }) }));
      for (const n of [...ports.keys()]) disconnect(n);
      node.removeEventListener(outgoing, receive);
      removeEventListener('pagehide', hide); removeEventListener('pageshow', show);
    }
    const hide = event => {
      if (!event.isTrusted || suspended || closed) return;
      suspended = true; generation++; observer?.disconnect(); observer = undefined;
      emit({ kind: 'suspend' });
      for (const n of [...ports.keys()]) disconnect(n);
      if (!event.persisted) close();
    };
    const show = event => {
      if (!event.isTrusted || !event.persisted || !suspended || closed) return;
      suspended = false; emit({ kind: 'resume' }); start();
    };
    function receive(event) {
      if (closed || event.target !== node || typeof event.detail !== 'string' || event.detail.length > MAX) return;
      const now = Date.now(); if (now - rateStart >= 1000) { rate = 0; rateStart = now; }
      if (++rate > 128) return;
      let packet; try { packet = JSON.parse(event.detail); } catch { return; }
      if (packet?.kind === 'claim') { claimed = true; return; }
      if (!claimed || !Number.isSafeInteger(packet?.n) || packet.n < 1) return;
      const n = packet.n;
      if (packet.kind === 'disconnect') { disconnect(n); return; }
      if (packet.kind === 'connect') {
        if (suspended || ports.size >= 1 || typeof native?.connect !== 'function') { emit({ kind: 'disconnect', n }); return; }
        try {
          const port = native.connect({ name: 'US_CHANNEL:' + options.id + ':' + options.token }); ports.set(n, port);
          port.onMessage.addListener(value => { if (ports.get(n) === port) emit({ kind: 'event', n, value }); });
          port.onDisconnect.addListener(() => { void native.lastError; if (ports.get(n) === port) { ports.delete(n); emit({ kind: 'disconnect', n }); } });
        } catch { emit({ kind: 'disconnect', n }); }
        return;
      }
      if (packet.kind !== 'call') return;
      const reply = value => emit({ kind: 'reply', n, value });
      const message = packet.message;
      // Page packets never name the script: site code can read them, and the
      // install ID would identify the user across sites. This host adds it.
      if (suspended || calls.size >= 8 || calls.has(n) || !message || message.type !== 'US_VALUE' || message.id !== undefined ||
          message.token !== undefined || message.operation === 'connect' || typeof native?.sendMessage !== 'function') {
        reply({ ok: false, error: 'Invalid, suspended or busy page GM request.' }); return;
      }
      calls.add(n);
      const epoch = generation;
      const completionOnly = /^(set|delete)(Many)?$/.test(message.operation) || message.operation === 'cookie' && ['set', 'delete'].includes(message.method);
      const replyIfCurrent = value => {
        if (closed) return;
        if (!suspended && epoch === generation) reply(value);
        // Preserve the actual outcome of submitted writes across suspension,
        // without returning a stale value snapshot or other response data.
        else if (completionOnly) reply({ ok: value?.ok === true, ...(typeof value?.error === 'string' ? { error: value.error } : {}) });
      };
      // The page cannot select a different identity, capability, router or port.
      // The native broker independently validates operation, grants and live URL.
      void Promise.resolve().then(() => {
        if (closed || suspended || epoch !== generation) throw new Error('Page changed before this GM request was submitted.');
        return native.sendMessage({ ...message, type: 'US_VALUE', id: options.id, token: options.token });
      }).then(replyIfCurrent, error => replyIfCurrent({ ok: false, error: error?.message || 'Native GM request failed.' })).finally(() => calls.delete(n));
    }
    node.addEventListener(outgoing, receive);
    addEventListener('pagehide', hide); addEventListener('pageshow', show);
    function start() {
      if (closed || suspended || started) return;
      const parent = document.head || document.documentElement;
      if (!parent) { if (!observer) { observer = new MutationObserver(start); observer.observe(document, { childList: true, subtree: true }); } return; }
      observer?.disconnect(); observer = undefined; started = true;
      try {
        node.textContent = '(' + clientSource + ')(' + JSON.stringify(node.id) + ',' + JSON.stringify(outgoing) + ',' + JSON.stringify(incoming) + ',' + pageRun.toString() + ');\n//# sourceURL=' + options.sourceName;
        parent.appendChild(node);
        document.dispatchEvent(new CustomEvent(options.event, { detail: node.id }));
      } catch (error) {
        // A DOM/Trusted Types refusal before claim permits auto fallback. Once
        // claimed, user code may have had side effects and must never run twice.
        console.error('[Module Engine userscript] Page startup failed.', error);
      } finally { node.replaceChildren(); node.remove(); node.removeAttribute('id'); }
      // Inline scripts execute synchronously. Claim precedes user code, so an
      // exception after side effects cannot cause a second content-world run.
      if (!claimed) {
        close();
        if (options.mode === 'auto') fallback();
        else console.error('[Module Engine userscript] Page execution was blocked or unavailable. Choose @inject-into auto for isolated fallback.');
      }
    }
    start();
  }
  globalThis.BlockAdsUserScriptPage = Object.freeze({ bootstrap, host, client });
})();
