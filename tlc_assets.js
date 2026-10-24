// Web build: pictures left out of the .pck (cardimages/, images/characters/) are fetched from assets/ next to the
// page and copied into Godot's in-memory file system under /tlcweb/ (scripts/web_assets.gd). Each one is stored
// as WebP: "cardimages/BT01-001.png" -> assets/cardimages/BT01-001.webp -> /tlcweb/cardimages/BT01-001.webp.
(function () {
  const done = {};
  let manText = null;
  const webp = (rel) => rel.replace(/\.(png|jpe?g|webp)$/i, '.webp');
  const fsPath = (rel) => '/tlcweb/' + webp(rel);
  const url = (rel) => 'assets/' + webp(rel).split('/').map(encodeURIComponent).join('/');
  function put(rel, bytes) {
    const p = fsPath(rel);
    // the page's Godot instance (the export shell's `const engine`)
    engine.copyToFS(p, bytes);
    done[rel] = p;
    return p;
  }
  window.tlcAssets = {
    manifestText() {
      if (manText === null) {
        const x = new XMLHttpRequest();
        x.open('GET', 'assets/manifest.json', false);
        try { x.send(); manText = x.status === 200 ? x.responseText : '[]'; } catch (e) { manText = '[]'; }
      }
      return manText;
    },
    // blocking download (used when the game needs the picture right now); "" when it can't be had
    getSync(rel) {
      if (done[rel]) return done[rel];
      const x = new XMLHttpRequest();
      x.open('GET', url(rel), false);
      x.overrideMimeType('text/plain; charset=x-user-defined');
      try { x.send(); } catch (e) { return ''; }
      if (x.status !== 200) return '';
      const s = x.responseText, b = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255;
      return put(rel, b);
    },
    isDone(rel) { return !!done[rel]; },
    // background downloads, a few at a time
    prefetch(rels) {
      const q = rels.filter((r) => !done[r]);
      let busy = 0;
      const next = () => {
        while (busy < 6 && q.length) {
          const rel = q.shift();
          busy++;
          fetch(url(rel)).then((r) => (r.ok ? r.arrayBuffer() : null)).then((buf) => { if (buf && !done[rel]) put(rel, new Uint8Array(buf)); })
            .catch(() => {}).finally(() => { busy--; next(); });
        }
      };
      next();
    },
  };
})();
