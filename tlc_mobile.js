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
})();
