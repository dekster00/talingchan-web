// Deck share codes (2026-11-06, Edit mode thread; same format as godot/scripts/deck_editor.gd share_code/decode_code).
// "TLC1-" + base64url (no padding) of zlib-compressed UTF-8 text, one field per line:
//   N:<name>   M:/L:/S: <print>*<qty>,...  (main / life / side)   A: <print>=<rarity>,...  (alt arts)
import zlib from 'node:zlib';

export const CODE_PREFIX = 'TLC1-';
type Entry = { print: string; qty: number };
export type SharedDeck = { name: string; main: Entry[]; life: Entry[]; side: Entry[]; art?: Record<string, string> };

export function encodeDeck(d: SharedDeck): string {
  const lines = ['N:' + String(d.name || '').replace(/\n/g, ' ')];
  for (const [k, t] of [['main', 'M'], ['life', 'L'], ['side', 'S']] as const) {
    const xs = (d[k] || []).filter((e) => e.qty > 0).map((e) => `${e.print}*${e.qty}`);
    if (xs.length) lines.push(t + ':' + xs.join(','));
  }
  const art = Object.entries(d.art || {}).filter(([, r]) => r).map(([p, r]) => `${p}=${r}`);
  if (art.length) lines.push('A:' + art.join(','));
  return CODE_PREFIX + zlib.deflateSync(Buffer.from(lines.join('\n'), 'utf8')).toString('base64url');
}

/** The first share code in the text, decoded; null when there is none or it is broken. */
export function decodeDeck(text: string): SharedDeck | null {
  const m = /TLC1-([A-Za-z0-9_-]+)/.exec(String(text || ''));
  if (!m) return null;
  let txt: string;
  try { txt = zlib.inflateSync(Buffer.from(m[1], 'base64url'), { maxOutputLength: 1 << 20 }).toString('utf8'); } catch { return null; }
  const d: SharedDeck = { name: '', main: [], life: [], side: [], art: {} };
  for (const ln of txt.split('\n')) {
    const tag = ln.slice(0, 2), body = ln.slice(2);
    if (tag === 'N:') d.name = body.slice(0, 40);
    else if (tag === 'M:' || tag === 'L:' || tag === 'S:') {
      const sec = ({ 'M:': 'main', 'L:': 'life', 'S:': 'side' } as const)[tag];
      for (const it of body.split(',').filter(Boolean)) {
        const [p, q] = it.split('*');
        d[sec].push({ print: p, qty: Math.max(1, Math.min(50, Math.floor(Number(q) || 1))) });
      }
    } else if (tag === 'A:') for (const it of body.split(',').filter(Boolean)) { const [p, r] = it.split('='); if (p && r) d.art![p] = r; }
  }
  return d;
}
