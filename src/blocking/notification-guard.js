/* Page-world guard for new notification requests. Saved browser permissions and
 * extension notifications are unchanged. Changes to this hook require a reload. */
(() => {
  'use strict';
  const installed = new WeakSet();
  const apply = Reflect.apply;
  const define = Object.defineProperty;
  const descriptor = Object.getOwnPropertyDescriptor;

  function install(win) {
    // Access is enforced by the browser, including inherited about:blank realms.
    // Cross-origin frames are left to the browser's own permission restrictions.
    let doc;
    try { doc = win.document; } catch { return; }
    if (!doc || installed.has(doc)) return;
    installed.add(doc);
    const resolve = win.Promise.resolve.bind(win.Promise);
    const reject = win.Promise.reject.bind(win.Promise);
    const enqueue = win.queueMicrotask.bind(win);
    const Exception = win.DOMException;
    const NotificationAPI = win.Notification;
    const permission = NotificationAPI && descriptor(NotificationAPI, 'permission')?.get;
    const granted = () => NotificationAPI && (permission ? apply(permission, NotificationAPI, []) : NotificationAPI.permission) === 'granted';
    const wrap = (object, key, replacement) => {
      const property = object && descriptor(object, key);
      if (!property || typeof property.value !== 'function') return;
      try { define(object, key, { ...property, value: replacement(property.value) }); }
      catch (error) { console.warn('[Module Engine] Notification request guard unavailable:', error.message); }
    };
    wrap(NotificationAPI, 'requestPermission', () => function requestPermission(callback) {
      if (callback != null && typeof callback !== 'function') throw new TypeError('Notification callback must be a function.');
      const result = granted() ? 'granted' : 'denied';
      if (callback) enqueue(() => callback(result));
      return resolve(result);
    });
    wrap(win.PushManager?.prototype, 'subscribe', original => function subscribe(...args) {
      return granted() ? apply(original, this, args)
        : reject(new Exception('New notification requests are blocked by Module Engine.', 'NotAllowedError'));
    });

    // A same-origin iframe exposes its own native APIs. Guard synchronously when
    // the page obtains that realm; also cover frames reached through user input
    // or load events. Do not hook cross-origin windows or create page bridges.
    const frameProto = win.HTMLIFrameElement?.prototype;
    for (const key of ['contentWindow', 'contentDocument']) {
      const property = frameProto && descriptor(frameProto, key);
      if (!property?.get || !property.configurable) continue;
      define(frameProto, key, { ...property, get() {
        const value = apply(property.get, this, []);
        if (value) install(key === 'contentWindow' ? value : value.defaultView);
        return value;
      } });
    }
    const visit = node => {
      if (node?.localName === 'iframe') void node.contentWindow;
      // Bound work for large documents. The getter/load hooks remain active.
      if (node?.querySelectorAll) {
        const frames = node.querySelectorAll('iframe');
        for (let index = 0; index < Math.min(frames.length, 128); index++) void frames[index].contentWindow;
      }
    };
    win.addEventListener('load', event => { if (event.isTrusted) visit(event.target); }, true);
    win.addEventListener('pointerdown', event => { if (event.isTrusted) visit(doc); }, true);
    win.addEventListener('keydown', event => { if (event.isTrusted) visit(doc); }, true);
    visit(doc);
  }
  install(window);
})();
