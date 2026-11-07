// The rules engine needs a cross-origin isolated page (SharedArrayBuffer). Hosts like GitHub Pages can't send the
// COOP/COEP headers, so Godot's service worker (index.service.worker.js, which adds them) is installed and the page
// reloads once. Godot's own shell only does this for threaded exports, so the web build does it here.
// The last 200 lines of the browser console (Godot's print / push_error / script errors land there), so the in-game
// BUG REPORT can attach them (scripts/bug_report.gd reads window.tlcLogLines; the web build has no log file)
(function () {
  const lines = (window.tlcLogLines = []);
  for (const k of ['log', 'info', 'warn', 'error']) {
    const orig = console[k].bind(console);
    console[k] = function (...a) {
      try {
        const t = a.map((x) => (typeof x === 'string' ? x : x instanceof Error ? x.stack || String(x) : (() => { try { return JSON.stringify(x); } catch (e) { return String(x); } })())).join(' ');
        lines.push((k === 'log' || k === 'info' ? '' : k.toUpperCase() + ': ') + t.slice(0, 500));
        if (lines.length > 200) lines.splice(0, lines.length - 200);
      } catch (e) {}
      return orig(...a);
    };
  }
  window.addEventListener('error', (e) => { lines.push('PAGE ERROR: ' + e.message + ' ' + (e.filename || '') + ':' + (e.lineno || '')); });
  window.addEventListener('unhandledrejection', (e) => { lines.push('PROMISE: ' + String(e.reason && (e.reason.stack || e.reason)).slice(0, 500)); });
})();
(function () {
  // a new deploy: the new service worker takes over at once (build_web.py) while this page still runs the old
  // game files, so load the page again once
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    let done = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (!done) { done = true; window.location.reload(); } });
    navigator.serviceWorker.getRegistration().then((r) => r && r.update()).catch(() => {}); // look for a new deploy now
  }
  if (window.crossOriginIsolated || !('serviceWorker' in navigator) || !window.isSecureContext) return;
  let tries = 0;
  try { tries = Number(sessionStorage.getItem('tlcCoiReload') || 0); } catch (e) {}
  if (tries >= 2) return; // the page says what's wrong (Backend) instead of reloading forever
  const reload = () => { try { sessionStorage.setItem('tlcCoiReload', String(tries + 1)); } catch (e) {} window.location.reload(); };
  if (navigator.serviceWorker.controller) { reload(); return; } // controlled but headers missing: the worker just updated
  navigator.serviceWorker.register('index.service.worker.js').then((reg) => {
    const w = reg.installing || reg.waiting || reg.active;
    if (w && w.state === 'activated') return reload();
    navigator.serviceWorker.addEventListener('controllerchange', reload);
    if (w) w.addEventListener('statechange', () => { if (w.state === 'activated') setTimeout(reload, 50); });
  }).catch((e) => console.error('service worker:', e));
})();
