// Web build: index.pck and index.wasm are too big for one file on Cloudflare Pages (25 MiB a file), so qa/build_web.py
// cuts them into parts/<name>.<hash>.<n> (the wasm gzipped first: 39 MB -> 10 MB). This joins the parts back when the
// Godot loader asks for index.pck / index.wasm. The hash in the names changes every build, so the parts can be cached
// for good. build_web.py fills in PARTS.
(function () {
  const PARTS = {"index.pck": {"size": 55768576, "type": "application/octet-stream", "gzip": false, "parts": ["parts/index.0473656063.pck.0", "parts/index.0473656063.pck.1", "parts/index.0473656063.pck.2"]}, "index.wasm": {"size": 39514754, "type": "application/wasm", "gzip": true, "parts": ["parts/index.98dc0082aa.wasm.0"]}}; // "index.pck" -> {size, type, gzip, parts: [urls]}
  const orig = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const e = PARTS[url.split('?')[0].split('/').pop()];
    if (!e) return orig(input, init);
    // tlc_mobile.js holds the download after a crash on a phone until the player taps Try again
    return (window.tlcGate || Promise.resolve()).then(() => join(e));
  };
  function join(e) {
    const resps = e.parts.map((p) => orig(p, { credentials: 'same-origin' }));
    return resps[0].then((r0) => {
      if (!r0.ok) return r0;
      let i = 0;
      let reader = r0.body.getReader();
      let body = new ReadableStream({
        async pull(ctl) {
          for (;;) {
            const { done, value } = await reader.read();
            if (!done) { ctl.enqueue(value); return; }
            if (++i >= resps.length) { ctl.close(); return; }
            const r = await resps[i];
            if (!r.ok) { ctl.error(new Error(r.status + ' : ' + r.url)); return; }
            reader = r.body.getReader();
          }
        },
      });
      if (e.gzip) body = body.pipeThrough(new DecompressionStream('gzip'));
      return new Response(body, { status: 200, headers: { 'Content-Type': e.type, 'Content-Length': String(e.size) } });
    });
  }
})();
