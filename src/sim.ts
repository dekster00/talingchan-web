// Run bot-vs-bot matches between decklists.
// usage: node --experimental-strip-types src/sim.ts <deckA.json> <deckB.json> [games=1000] [--log]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Def, GemColor } from './types.ts';
import { newGame, playGame, setBrains, lifeSpec, registerText } from './engine.ts';
import { Greedy } from './bot.ts';
import { FX } from './cards.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Card database from bot.premiumhubth.com (copied into data/ so the engine folder is self-contained).
export const CARDS = path.resolve(ROOT, 'data/cards.json');

// GEM colour data the user fills in (optional): engine/data/gem_colors.json = { "<print>": { gemColor, req: {color, n} | null } }.
export const GEM_COLORS = path.resolve(ROOT, 'data/gem_colors.json');
const COLOR_TH: Record<string, GemColor> = { 'แดง': 'red', 'เขียว': 'green', 'ฟ้า': 'blue', 'น้ำเงิน': 'blue', 'ม่วง': 'purple', 'เหลือง': 'yellow', 'ไม่มีสี': 'colorless', 'ไร้สี': 'colorless' };
export function toGemColor(x: any): GemColor {
  const s = String(x ?? '').trim();
  if (!s) return 'colorless';
  if (s.includes('/')) { // dual gem, e.g. "red/blue"
    const parts = [...new Set(s.split('/').map((y) => toGemColor(y)).filter((y) => y !== 'colorless'))];
    return parts.length ? parts.join('/') : 'colorless';
  }
  if (COLOR_TH[s]) return COLOR_TH[s];
  const e = s.toLowerCase();
  return (['red', 'green', 'blue', 'purple', 'yellow', 'colorless'] as GemColor[]).includes(e as GemColor) ? (e as GemColor) : e === 'colourless' || e === 'none' ? 'colorless' : 'colorless';
}
function loadGemColors(): Record<string, any> {
  try { return fs.existsSync(GEM_COLORS) ? JSON.parse(fs.readFileSync(GEM_COLORS, 'utf8')) : {}; } catch (e) { console.error('gem_colors.json:', e); return {}; }
}

// "#" lines: permanent stats (extra names / symbols / colours, deck limits). Returned as Def fields.
const TH_COLORS = ['แดง', 'เขียว', 'ฟ้า', 'ม่วง', 'เหลือง'];
export function hashStats(effect: string): Partial<Def> {
  const out: Partial<Def> = {};
  for (const raw of String(effect || '').split('\n')) {
    const i = raw.indexOf('#');
    if (i < 0) continue;
    const t = raw.slice(i + 1).trim();
    if (/ไม่สามารถถูกอัญเชิญจากนรก/.test(t)) { out.noHellSummon = true; continue; }
    if (/ไม่สามารถ\s*สวมใส่การ์ด/.test(t)) { out.noWear = true; continue; }
    { const m = t.match(/Construct Zone\s*ได้สูงสุด\s*(\d+)\s*ใบ/); if (m) { out.czMax = Number(m[1]); continue; } }
    if (/Cost|ใส่.*Deck|ใส่ใน|Deck|ควบคุม|ความสามารถ/.test(t) && !/(ถือว่ามีชื่อ|นับเป็นชื่อ)/.test(t)) {
      const m = t.match(/(?:สูงสุด|มากสุด)\s*(\d+)\s*ใบ/);
      if (m && /Deck|เด็ค/.test(t)) out.limit = Number(m[1]);
      // v14 fix (BT12-040): "#... ถือว่าเป็น {symbol X} ด้วย และ ... Cost ..." still grants the symbol of its first clause
      const head = t.split(/\s+และ\s+/)[0];
      if (/(ถือว่า|นับ)เป็น\s*\{?\s*[Ss]ymbol/.test(head)) for (const m2 of head.matchAll(/\{?\s*[Ss]ymbol\s+([^}\s]+)\s*\}?/g)) (out.syms ||= []).push(m2[1].replace(/ด้วย$/, ''));
      continue;
    }
    for (const m of t.matchAll(/(?:ถือว่ามีชื่อ|นับเป็นชื่อ)\s*(?:"([^"]+)"?|(\S+))/g)) (out.aka ||= []).push((m[1] || m[2]).trim());
    if (/[Ss]ymbol/.test(t)) for (const m of t.matchAll(/\{?\s*[Ss]ymbol\s+([^}\s]+)\s*\}?/g)) (out.syms ||= []).push(m[1].replace(/ด้วย$/, ''));
    if (t.includes('ทุกสี')) out.allColors = true;
    else if (/สี(แดง|เขียว|ฟ้า|ม่วง|เหลือง)/.test(t)) for (const col of TH_COLORS) if (t.includes('สี' + col)) (out.colors ||= []).push(col);
  }
  return out;
}
// พอดี as this card's own keyword: before the first ":" of the text (not "อัญเชิญ พอดี จุติ" of another card)
function exactOwn(t: string) {
  const m = t.match(/(^|\s|\))พอดี(\s|\(|$)/);
  if (!m || m.index === undefined) return false;
  const colon = t.indexOf(':');
  return (colon < 0 || m.index < colon) && !/อัญเชิญ\s*$/.test(t.slice(0, m.index + 1)) && !t.startsWith('ทิ้งการ์ด') && !t.startsWith('การ์ดทุกใบ');
}
// Keyword flags from the whole text (own keywords only, not ones granted to other cards).
function kwFlags(effect: string): Partial<Def> {
  const t = String(effect || '').replace(/\s+/g, ' ');
  const own = (k: string) => { const i = t.indexOf(k); return i >= 0 && !/ได้รับ|"|มอบ|ใช้ความสามารถ/.test(t.slice(Math.max(0, i - 20), i)); };
  return { cont: t.includes('ต่อเนื่อง'), grit: own('ลูกฮึด'), backstab: /^(\{?\s*\[[^\]]*\]\s*)?แทงหลัง/.test(t.trim()), exactKw: exactOwn(t) };
}
// Known data errors fixed at load time (see v5/audit/rule_errors.json).
const DATA_FIX: Record<string, Partial<Def>> = {
  'SD05-014': { subtype: 'Land' }, // บึงทมิฬ is a Land (its ability stays on the field); the data lists it as Normal
  'KD04-014': { aka: ['อาวุธหุ่นนักรบผู้กล้า " ไบโพล่า ชิลด์ "'] }, // other-team audit Q17 (user): counts as "อาวุธหุ่นนักรบผู้กล้า"
};
export function loadDefs(): Map<string, Def> {
  const raw = JSON.parse(fs.readFileSync(CARDS, 'utf8'));
  const gc = loadGemColors();
  const m = new Map<string, Def>();
  for (const c of raw) {
    if (m.has(c.code)) continue;
    registerText(c.name, String(c.effect || ''));
    const num = (x: any) => (x === '' || x === null || x === undefined ? 0 : Number(x));
    const isMagic = c.type === 'Magic';
    const o = gc[c.code];
    const req = o && o.req && Number(o.req.n) > 0 ? { color: toGemColor(o.req.color), n: Number(o.req.n) } : null;
    m.set(c.code, {
      print: c.code, name: c.name, type: c.type, subtype: c.subtype || '',
      // Magic has no cost: it's free to cast, once per Magic type each turn. Its GEM still pays for other cards.
      cost: isMagic ? 0 : num(c.cost), gem: num(c.gem), power: num(c.power),
      symbol: c.symbol || '', color: c.color || '', only: String(c.ex || '').includes('Only'),
      vanilla: !String(c.effect || '').trim(),
      gemColor: o && o.gemColor ? toGemColor(o.gemColor) : toGemColor(c.gemColor || c.color),
      req, limit: Number(c.customLimit) > 0 ? Number(c.customLimit) : 4, // a "#... สูงสุด N ใบ" line overrides below
      life: c.type === 'Life' ? lifeSpec(c.effect) : null,
      ...kwFlags(c.effect), ...hashStats(c.effect),
      ...(DATA_FIX[c.code] || {}),
    });
  }
  return m;
}

// Deck formats: a file in decks/ ({archetype, cards:[{print,qty}], life?:[{print,qty}]}) or an inline deck object
// ({name, main:[{print,qty}], life:[{print,qty}], side:[{print,qty}]}). side is not used in play.
// life is null when the deck has none (newGame then uses the default LIFE deck).
export function loadDeck(src: string | any, defs: Map<string, Def>) {
  const d = typeof src === 'string' ? JSON.parse(fs.readFileSync(src, 'utf8')) : src;
  const label = typeof src === 'string' ? src : d.name || 'deck';
  const list: Def[] = [];
  const uncoded = new Set<string>();
  const expand = (xs: any[]) => {
    const out: Def[] = [];
    for (const c of xs || []) {
      const def = defs.get(c.print);
      if (!def) throw new Error('unknown card ' + c.print);
      for (let i = 0; i < Number(c.qty || 0); i++) out.push(def);
    }
    return out;
  };
  for (const def of expand(d.main || d.cards)) {
    list.push(def);
    if (!FX[def.name] && !(def as any).vanilla && !(def.type === 'Avatar' && def.name === 'นินจาไร้นาม')) uncoded.add(def.name);
  }
  if (list.length !== 50) throw new Error(`${label}: ${list.length} cards, expected 50`);
  const lifeL = expand(d.life);
  if (lifeL.length && (lifeL.length !== 5 || lifeL.some((x) => x.type !== 'Life'))) throw new Error(`${label}: LIFE must be exactly 5 Life cards`);
  return { name: String(d.archetype || d.name || 'deck'), list, life: lifeL.length ? lifeL : null, uncoded: [...uncoded] };
}

// Deck-building rules (the editor and POST /api/validate): main exactly 50 = 49 regular + exactly 1 "Only #1" card,
// LIFE exactly 5 Life cards, side 0..10, at most 4 copies of a card name (customLimit overrides, e.g. รัททาทุย 50).
export function validateDeck(d: any, defs: Map<string, Def>): string[] {
  const errs: string[] = [];
  if (!d || typeof d !== 'object') return ['The deck must be an object {name, main, life, side}.'];
  const part = (k: string) => {
    const xs = d[k] ?? [];
    if (!Array.isArray(xs)) { errs.push(`${k} must be a list of {print, qty}.`); return [] as Def[]; }
    const out: Def[] = [];
    for (const c of xs) {
      const def = c && defs.get(c.print);
      const q = Number(c && c.qty);
      if (!def) { errs.push(`${k}: unknown card ${c && c.print}`); continue; }
      if (!Number.isInteger(q) || q < 0) { errs.push(`${k}: bad qty for ${c.print}`); continue; }
      for (let i = 0; i < q; i++) out.push(def);
    }
    return out;
  };
  const main = part('main'), life = part('life'), side = part('side');
  const only = main.filter((x) => x.only);
  if (main.length !== 50) errs.push(`Main deck has ${main.length} cards; it must have exactly 50 (49 + 1 Only #1).`);
  // 2026-10-25 (user): พระไตรปิฎก is the one Only #1 card that may take up to 3 slots (its own "#" line allows 3 copies)
  const onlyMax = only.length > 0 && only.every((x) => x.name === 'พระไตรปิฎก') ? 3 : 1;
  if (only.length < 1 || only.length > onlyMax) errs.push(onlyMax === 3 ? `Main deck has ${only.length} พระไตรปิฎก; it may have 1 to 3.` : `Main deck has ${only.length} "Only #1" cards; it must have exactly 1.`);
  const bad = main.filter((x) => x.type === 'Life');
  const tok = [...main, ...life, ...side].filter((x) => x.type === 'Token'); // v14: Token cards (BT12-076) are summoned by effects only
  if (tok.length) errs.push(`Token cards can't be put in a deck (${[...new Set(tok.map((x) => x.print))].join(', ')}).`);
  if (bad.length) errs.push(`Life cards can't be in the Main deck (${[...new Set(bad.map((x) => x.print))].join(', ')}).`);
  if (life.length !== 5) errs.push(`LIFE deck has ${life.length} cards; it must have exactly 5.`);
  const nl = life.filter((x) => x.type !== 'Life');
  if (nl.length) errs.push(`LIFE deck may only hold Life cards (${[...new Set(nl.map((x) => x.print))].join(', ')}).`);
  if (side.length > 10) errs.push(`Side deck has ${side.length} cards; it may have at most 10.`);
  // copy limit per card name across main + side (LIFE is checked on its own)
  for (const [nm, xs] of [['Main + Side', [...main, ...side]], ['LIFE', life]] as [string, Def[]][]) {
    const cnt = new Map<string, { n: number; lim: number }>();
    for (const x of xs) { const e = cnt.get(x.name) || { n: 0, lim: x.limit ?? 4 }; e.n++; e.lim = Math.max(e.lim, x.limit ?? 4); cnt.set(x.name, e); }
    for (const [name, e] of cnt) if (e.n > e.lim) errs.push(`${nm}: ${e.n} copies of ${name}; the limit is ${e.lim} per card name.`);
  }
  // "#" deck-building rules
  const all = [...main, ...side];
  const avatarsNamed = (k: string) => all.some((x) => x.type === 'Avatar' && x.name.includes(k));
  if (all.some((x) => x.name === 'สไปรท์ ยอดสุนัข') && !avatarsNamed('เพมมุ')) errs.push('สไปรท์ ยอดสุนัข: the deck must also hold an Avatar "เพมมุ".');
  if (all.some((x) => x.name === 'เพมมุ ยอดมนุษย์')) {
    const bad2 = [...new Set(all.filter((x) => x.type === 'Avatar' && !x.name.includes('เพมมุ') && (['คน', 'ต่างชาติ'].includes(x.symbol) || (x.syms || []).some((y) => ['คน', 'ต่างชาติ'].includes(y)))).map((x) => x.name))];
    if (bad2.length) errs.push(`เพมมุ ยอดมนุษย์: no other คน / ต่างชาติ Avatars allowed (${bad2.slice(0, 5).join(', ')}${bad2.length > 5 ? '…' : ''}).`);
  }
  if (main.some((x) => x.name === 'พญายม With The Shotgun') && !main.some((x) => x.name === 'สุวาน')) errs.push('พญายม With The Shotgun: the deck must also hold 1 สุวาน.');
  for (const e of banlistErrors(all)) errs.push(e);
  return errs;
}

// ---------- official ban list (data/banlist.json, from the user's picture; 2026-10-25 = August 69) ----------
// banned: 0 copies; limit1 / limit2: max copies per card name (Main + Side); pickOne: only one of the two names in a deck;
// onlyRules: when the deck holds that Only #1 card, every Avatar (or the deck's Only #1) must pass the check.
export const BANLIST_FILE = path.resolve(ROOT, 'data/banlist.json');
let BAN: any = null, TEXTS: Map<string, string> | null = null;
export function banlist(): any {
  if (BAN) return BAN;
  try { BAN = JSON.parse(fs.readFileSync(BANLIST_FILE, 'utf8')); } catch { BAN = { banned: [], limit1: [], limit2: [], pickOne: [], onlyRules: [] }; }
  return BAN;
}
const textOf = (x: Def) => {
  if (!TEXTS) { TEXTS = new Map(); for (const c of JSON.parse(fs.readFileSync(CARDS, 'utf8'))) if (!TEXTS.has(c.code)) TEXTS.set(c.code, String(c.effect || '')); }
  return TEXTS.get(x.print) || '';
};
const hasSym = (x: Def, s: string) => x.symbol === s || (x.syms || []).includes(s);
export function banlistErrors(cards: Def[]): string[] {
  const b = banlist(), errs: string[] = [], tag = b.name ? ` (${b.name})` : '';
  const cnt = new Map<string, number>();
  for (const x of cards) cnt.set(x.name, (cnt.get(x.name) || 0) + 1);
  // an entry is a name or a list of names of one card (spelling variants share the limit)
  const sum = (e: string | string[]) => ([] as string[]).concat(e).reduce((n, x) => n + (cnt.get(x) || 0), 0);
  const nm = (e: string | string[]) => ([] as string[]).concat(e)[0];
  for (const e of b.banned || []) if (sum(e)) errs.push(`${nm(e)} is banned${tag}.`);
  for (const [k, lim] of [['limit1', 1], ['limit2', 2]] as [string, number][]) for (const e of b[k] || []) if (sum(e) > lim) errs.push(`${nm(e)}: ${sum(e)} copies; the ban list allows ${lim}${tag}.`);
  for (const pr of b.pickOne || []) if (pr.every((n: string) => cnt.get(n))) errs.push(`Pick one: ${pr.join(' or ')}, not both${tag}.`);
  for (const r of b.onlyRules || []) {
    if (!cnt.get(r.only)) continue;
    const avs = cards.filter((x) => x.type === 'Avatar');
    let bad: string[] = [];
    if (r.check === 'avatarNameOrText') bad = avs.filter((x) => !x.name.includes(r.value) && !(x.aka || []).some((a) => a.includes(r.value)) && !textOf(x).includes(r.value)).map((x) => x.name);
    else if (r.check === 'avatarSymbolOrText') bad = avs.filter((x) => !hasSym(x, r.value) && !new RegExp(`\\{\\s*[Ss]ymbol\\s+${r.value}\\s*\\}`).test(textOf(x))).map((x) => x.name);
    else if (r.check === 'onlySymbol') bad = cards.filter((x) => x.only && !hasSym(x, r.value)).map((x) => x.name);
    bad = [...new Set(bad)];
    if (bad.length) errs.push(`${r.only}: ${r.text} Not allowed: ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? '…' : ''}${tag}.`);
  }
  return errs;
}

export function match(a: ReturnType<typeof loadDeck>, b: ReturnType<typeof loadDeck>, games: number, seed0 = 1, logFirst = false) {
  setBrains([Greedy, Greedy]);
  let wa = 0, wb = 0, dr = 0, turns = 0, firstWins = 0;
  const firstLog: string[] = [];
  for (let i = 0; i < games; i++) {
    const g = newGame([a.list, b.list], [a.name, b.name], seed0 + i * 7919, logFirst && i === 0, false, [a.life, b.life]);
    const w = playGame(g);
    if (w === 0) wa++; else if (w === 1) wb++; else dr++;
    if (w === g.first) firstWins++;
    turns += g.turn;
    if (logFirst && i === 0) firstLog.push(...g.log!);
  }
  return { a: a.name, b: b.name, games, winsA: wa, winsB: wb, draws: dr, wrA: wa / Math.max(1, wa + wb), avgTurns: turns / games, firstPlayerWR: firstWins / Math.max(1, wa + wb), log: firstLog };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [fa, fb, n] = process.argv.slice(2);
  const defs = loadDefs();
  const A = loadDeck(fa, defs), B = loadDeck(fb, defs);
  for (const D of [A, B]) if (D.uncoded.length) console.log(`${D.name}: no effect coded for`, D.uncoded.join(', '));
  const t0 = Date.now();
  const r = match(A, B, Number(n || 1000), 1, process.argv.includes('--log'));
  const z = 1.96 * Math.sqrt((r.wrA * (1 - r.wrA)) / Math.max(1, r.winsA + r.winsB));
  console.log(`${r.a} vs ${r.b}: ${r.winsA}-${r.winsB} (draws ${r.draws}) → ${r.a} WR ${(r.wrA * 100).toFixed(1)}% ±${(z * 100).toFixed(1)} | avg turns ${r.avgTurns.toFixed(1)} | first player WR ${(r.firstPlayerWR * 100).toFixed(1)}% | ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (r.log.length) console.log(r.log.join('\n'));
}

// ---------- deck import from text (v9) ----------
// "# name" (first # line that is not a section), sections "# Main Deck" / "# Life Cards" / "# Side Deck" ("# Main", "# Life",
// "# Side" too), card lines "4x BT04-020-UR", "4 BT04-020", "BT04-020" (qty 1). The rarity suffix is stripped when the full code
// is not a card. Unknown codes go to `unknown`; validateDeck errors are appended.
export function importDeckText(text: string, defs: Map<string, Def>): { deck: { name: string; main: { print: string; qty: number }[]; life: { print: string; qty: number }[]; side: { print: string; qty: number }[] }; errors: string[]; unknown: string[] } {
  const deck = { name: '', main: [] as { print: string; qty: number }[], life: [] as { print: string; qty: number }[], side: [] as { print: string; qty: number }[] };
  const errors: string[] = [], unknown: string[] = [];
  let sec: 'main' | 'life' | 'side' = 'main';
  const lines = String(text ?? '').replace(/\r/g, '').split('\n');
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || /^(\.\.\.|…)$/.test(line)) return;
    if (line.startsWith('#')) {
      const h = line.replace(/^#+\s*/, '').trim(), hl = h.toLowerCase();
      if (/^main(\s*deck)?$/.test(hl)) sec = 'main';
      else if (/^life(\s*cards?)?$|^life\s*deck$/.test(hl)) sec = 'life';
      else if (/^side(\s*deck)?$/.test(hl)) sec = 'side';
      else if (!deck.name) deck.name = h;
      return;
    }
    const m = line.match(/^(?:(\d+)\s*[xX×]?\s+)?([A-Za-z0-9]+-[A-Za-z0-9]+(?:-[A-Za-z0-9+]+)?)\s*$/);
    if (!m) { errors.push(`Line ${i + 1}: can't read "${line}" (expected "4x BT04-020-UR").`); return; }
    const qty = m[1] === undefined ? 1 : Number(m[1]);
    let code = m[2].toUpperCase();
    if (!defs.has(code)) { const short = code.replace(/-[A-Z+]+$/, ''); if (short !== code && defs.has(short)) code = short; else if (/^[A-Z0-9]+-[A-Z0-9]+-[A-Z+]+$/.test(code)) code = short; }
    if (!defs.has(code)) {
      if (!unknown.includes(code)) unknown.push(code);
      errors.push(`Line ${i + 1}: card ${code} is not in the card data (${qty}x skipped).`);
      return;
    }
    if (qty < 1) { errors.push(`Line ${i + 1}: bad quantity for ${code}.`); return; }
    const part = deck[sec], e = part.find((x) => x.print === code);
    if (e) e.qty += qty; else part.push({ print: code, qty });
  });
  if (!deck.name) deck.name = 'Imported deck';
  for (const e of validateDeck(deck, defs)) if (!errors.includes(e)) errors.push(e);
  return { deck, errors, unknown };
}
