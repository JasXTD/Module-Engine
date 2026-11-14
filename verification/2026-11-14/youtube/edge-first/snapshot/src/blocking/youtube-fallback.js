/* Isolated-world fallback for positively marked YouTube video ads. */
(() => {
  'use strict';
  const PLAYER = '.html5-video-player';
  const SKIP = '.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern';
  const EVENTS = ['loadedmetadata', 'durationchange', 'loadeddata', 'playing', 'timeupdate', 'progress', 'emptied'];

  function create({ document: doc = document, onSkipped = () => {} } = {}) {
    const win = doc.defaultView, saved = new Map();
    let enabled = false, observer;
    const marked = player => player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting'));

    function restore(video, confirmed = false) {
      const state = saved.get(video);
      if (!state) return;
      saved.delete(video);
      // Media setters can throw during teardown. Restore each owned change
      // independently and leave newer player/user values intact.
      try { if (state.rateChanged && video.playbackRate === 16) video.playbackRate = state.rate; } catch {}
      try { if (state.muteChanged && video.muted) video.muted = state.muted; } catch {}
      if (confirmed && state.acted) onSkipped();
    }

    function inspect(video) {
      const player = video.closest(PLAYER);
      if (!enabled || !video.isConnected || !marked(player)) {
        restore(video, enabled && video.isConnected && Boolean(player) && !marked(player));
        return;
      }
      let state = saved.get(video);
      if (!state) {
        if (saved.size >= 32) return;
        state = { muted: video.muted, rate: video.playbackRate, buttons: new WeakSet(), acted: false };
        saved.set(video, state);
        try { if (!video.muted) { video.muted = true; state.muteChanged = video.muted; } } catch {}
        try { if (video.playbackRate !== 16) { video.playbackRate = 16; state.rateChanged = video.playbackRate === 16; } } catch {}
      }
      // Prefer an actual usable skip control. Hidden or disabled controls cannot
      // establish a skip, and clicking must not also seek a newly resumed video.
      for (const button of player.querySelectorAll(SKIP)) {
        const style = win.getComputedStyle(button);
        if (button.disabled || button.getAttribute('aria-disabled') === 'true' || !button.getClientRects().length ||
            style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none') continue;
        if (!state.buttons.has(button)) {
          state.buttons.add(button);
          try { button.click(); state.acted = true; } catch { state.buttons.delete(button); }
        }
        return;
      }
      // Never seek a live/unknown-length stream or outside an available range.
      // A later progress/duration event retries once the media is seekable.
      try {
        const duration = video.duration, ranges = video.seekable;
        if (Number.isFinite(duration) && duration > 0 && ranges.length &&
            ranges.end(ranges.length - 1) >= duration - 0.1 && video.currentTime < duration - 0.1) {
          video.currentTime = duration;
          state.acted = video.currentTime >= duration - 0.1;
        }
      } catch { /* A rejected seek must not strand the restore state or observer. */ }
    }

    function scan() {
      for (const video of saved.keys()) if (!video.isConnected || !video.closest(PLAYER)) restore(video);
      for (const video of Array.from(doc.querySelectorAll(PLAYER + ' video')).slice(0, 32)) inspect(video);
    }
    function media(event) {
      if (event.target instanceof win.HTMLVideoElement) inspect(event.target);
    }
    function relevant(record) {
      if (record.target.nodeType === 1 && record.target.closest(PLAYER)) return true;
      if (record.type === 'attributes' && record.attributeName === 'class' &&
          Array.from(saved.keys()).some(video => record.target.contains(video))) return true;
      // Class changes on a player itself, newly mounted players/videos and
      // removals matter. Unrelated comment/feed mutations need no full scan.
      if (record.type === 'childList') {
        if (saved.size && record.removedNodes.length) return true;
        for (const node of record.addedNodes) if (node.nodeType === 1 &&
          (node.matches(PLAYER + ',video') || node.querySelector(PLAYER + ',video'))) return true;
      }
      return false;
    }
    function setEnabled(value) {
      const next = value === true;
      if (next === enabled) return;
      enabled = next;
      if (enabled) {
        observer = new win.MutationObserver(records => { if (records.some(relevant)) scan(); });
        observer.observe(doc, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'hidden', 'disabled', 'aria-disabled', 'style'] });
        for (const type of EVENTS) doc.addEventListener(type, media, true);
        scan();
      } else {
        observer?.disconnect(); observer = null;
        for (const type of EVENTS) doc.removeEventListener(type, media, true);
        for (const video of saved.keys()) restore(video);
      }
    }
    return Object.freeze({ setEnabled });
  }
  globalThis.BlockAdsYouTube = Object.freeze({ create });
})();
