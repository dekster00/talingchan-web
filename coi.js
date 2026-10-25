// The rules engine needs a cross-origin isolated page (SharedArrayBuffer). Hosts like GitHub Pages can't send the
// COOP/COEP headers, so Godot's service worker (index.service.worker.js, which adds them) is installed and the page
// reloads once. Godot's own shell only does this for threaded exports, so the web build does it here.
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
