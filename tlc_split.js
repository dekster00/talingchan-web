// Web build: index.pck and index.wasm are too big for one file on Cloudflare Pages (25 MiB a file), so qa/build_web.py
// cuts them into parts/<name>.<hash>.<n> (the wasm gzipped first: 39 MB -> 10 MB). This joins the parts back when the
// Godot loader asks for index.pck / index.wasm. The hash in the names changes every build, so the parts can be cached
// for good. build_web.py fills in PARTS and also writes parts.json (the same list).
// If a part is missing (this page's files are from an older deploy whose parts are gone, which showed players
// "Failed loading file 'index.pck'"), it asks parts.json for the current list and uses that; failing that, it loads the
// page again once.
(function () {
  const PARTS = {"index.pck": {"size": 59322304, "type": "application/octet-stream", "gzip": false, "parts": ["parts/index.d9854d4c43.pck.0", "parts/index.d9854d4c43.pck.1", "parts/index.d9854d4c43.pck.2"]}, "index.wasm": {"size": 39514754, "type": "application/wasm", "gzip": true, "parts": ["parts/index.487723ffd9.wasm.0"]}}; // "index.pck" -> {size, type, gzip, parts: [urls]}
  const orig = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const name = url.split('?')[0].split('/').pop();
    const e = PARTS[name];
    if (!e) return orig(input, init);
    // tlc_mobile.js holds the download after a crash on a phone until the player taps Try again
    return (window.tlcGate || Promise.resolve()).then(() => load(name, e));
  };
  async function load(name, e) {
    let r = await join(e);
    if (r.ok) return r;
    console.warn('tlc_split: ' + name + ' part missing (' + r.status + '), asking parts.json for the current list');
    try {
      const fresh = (await (await orig('parts.json?t=' + Date.now(), { cache: 'no-store' })).json())[name];
      if (fresh && fresh.parts.join() !== e.parts.join()) {
        r = await join(fresh);
        if (r.ok) return r;
      }
    } catch (err) { console.warn('tlc_split: parts.json', err); }
    // last try: the whole page again, fresh (once a minute at most, so it can't loop)
    let last = 0;
    try { last = Number(sessionStorage.getItem('tlcPartsReload') || 0); } catch (err) {}
    if (Date.now() - last > 60000) {
      try { sessionStorage.setItem('tlcPartsReload', String(Date.now())); } catch (err) {}
      try { for (const k of await caches.keys()) await caches.delete(k); } catch (err) {}
      window.location.reload();
      return new Promise(() => {}); // the page is going away
    }
    return r;
  }
  // every part's headers first (cheap: the bodies still stream), so a missing part is found before Godot reads any
  async function join(e) {
    let resps;
    try {
      resps = await Promise.all(e.parts.map((p) => orig(p, { credentials: 'same-origin' })));
    } catch (err) {
      return new Response(null, { status: 599, statusText: 'network error' });
    }
    const bad = resps.find((r) => !r.ok);
    if (bad) return bad;
    let i = 0;
    let reader = resps[0].body.getReader();
    let body = new ReadableStream({
      async pull(ctl) {
        for (;;) {
          const { done, value } = await reader.read();
          if (!done) { ctl.enqueue(value); return; }
          if (++i >= resps.length) { ctl.close(); return; }
          reader = resps[i].body.getReader();
        }
      },
    });
    if (e.gzip) body = body.pipeThrough(new DecompressionStream('gzip'));
    return new Response(body, { status: 200, headers: { 'Content-Type': e.type, 'Content-Length': String(e.size) } });
  }
})();
