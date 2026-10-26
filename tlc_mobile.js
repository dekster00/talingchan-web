// Web build on phones and tablets: the game is landscape only. The first tap goes full screen and locks the screen
// to landscape (browsers allow the lock only in full screen, after a tap); while the phone is held upright a
// "rotate your phone" screen covers the game.
(function () {
  if (!window.matchMedia || !window.matchMedia('(pointer: coarse)').matches) return; // PC: nothing to do
  const css = document.createElement('style');
  css.textContent = '#tlc-rotate{display:none;position:fixed;inset:0;z-index:99999;background:#000;color:#fff;' +
    'font:600 20px/1.5 sans-serif;text-align:center;align-items:center;justify-content:center;flex-direction:column}' +
    '#tlc-rotate .ph{width:46px;height:78px;border:4px solid #fff;border-radius:9px;margin-bottom:22px;' +
    'animation:tlcrot 1.6s ease-in-out infinite}' +
    '@keyframes tlcrot{0%,20%{transform:rotate(0)}60%,100%{transform:rotate(-90deg)}}' +
    '@media (orientation: portrait){#tlc-rotate{display:flex}}';
  document.head.appendChild(css);
  const lock = () => {
    const el = document.documentElement;
    const full = document.fullscreenElement ? Promise.resolve()
      : (el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : Promise.reject());
    full.catch(() => {}).then(() => {
      if (screen.orientation && screen.orientation.lock) return screen.orientation.lock('landscape');
    }).catch(() => {}); // iPhone Safari can't lock: the rotate screen asks instead
  };
  window.addEventListener('pointerup', lock, { once: true, capture: true });
  document.addEventListener('fullscreenchange', () => { if (document.fullscreenElement) lock(); });
  const add = () => {
    const d = document.createElement('div');
    d.id = 'tlc-rotate';
    d.innerHTML = '<div class="ph"></div>Please turn your phone sideways<br><small>กรุณาหมุนโทรศัพท์เป็นแนวนอน</small>';
    document.body.appendChild(d);
  };
  if (document.body) add(); else document.addEventListener('DOMContentLoaded', add);

  // A phone browser that runs out of memory kills the tab and reloads it, again and again ("A problem repeatedly
  // occurred"). tlcLoading is set while the game starts and cleared once it has run for a while; when it is still
  // there at the next load, the last start crashed: the game waits (window.tlcGate, used by tlc_split.js) and asks.
  let crashed = false;
  try { crashed = !!localStorage.getItem('tlcLoading'); localStorage.setItem('tlcLoading', '1'); } catch (e) {}
  const fine = () => { try { localStorage.removeItem('tlcLoading'); } catch (e) {} };
  setTimeout(fine, 90000);
  window.addEventListener('pagehide', fine); // a normal reload or leaving the page (a crash never gets here)
  if (!crashed) return;
  window.tlcGate = new Promise((go) => {
    const show = () => {
      const d = document.createElement('div');
      d.style.cssText = 'position:fixed;inset:0;z-index:99998;background:#111;color:#fff;display:flex;flex-direction:column;' +
        'align-items:center;justify-content:center;text-align:center;padding:24px;font:16px/1.5 sans-serif';
      d.innerHTML = '<b style="font-size:20px">The game closed while loading last time</b>' +
        '<div style="margin:8px 0 4px">This phone may not have enough memory for it yet. It plays best on a PC browser.</div>' +
        '<div style="opacity:.8">เกมปิดไปตอนโหลดครั้งที่แล้ว มือถือเครื่องนี้อาจมีหน่วยความจำไม่พอ แนะนำให้เล่นบนคอมพิวเตอร์</div>' +
        '<button style="margin-top:18px;padding:12px 28px;font:600 18px sans-serif;border:0;border-radius:8px;background:#e8b830;color:#111">' +
        'Try again · ลองอีกครั้ง</button>' +
        '<div style="margin-top:10px;opacity:.7;font-size:14px">Tip: close other apps and browser tabs first.</div>';
      d.querySelector('button').onclick = () => { d.remove(); go(); };
      document.body.appendChild(d);
    };
    if (document.body) show(); else document.addEventListener('DOMContentLoaded', show);
  });
})();
