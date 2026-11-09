// v11 play-table helpers (used by play/worker.ts, tested in tools/unit.ts):
// whyNot = why a hand card can't be played now (tooltip on a greyed hand card); copyGame / restoreGame = Main Phase Undo.
import type { Card, Game, PID } from './types.ts';
import { magicSlotFree, cardText, opp, canWear, humanModTargets } from './engine.ts'; // simplify1; bugfix15: condWhy
import {
  P, fx, costOf, reqOf, gemOf, gemColorOf, gemFits, colorsEn, bestPayment, isAvatarDef, canPlaceAvatar, uniqueBlocked, ratSix, realAvatars, power, hasKw, exactLand, lands,
} from './engine.ts';

const GEM_TH: Record<string, string> = { red: 'แดง', green: 'เขียว', blue: 'ฟ้า', purple: 'ม่วง', yellow: 'เหลือง', colorless: 'ไร้สี' };
const gemIs = (gc: string, col: string) => gc === col || gc.split('/').includes(col);
function gemWhy(g: Game, p: PID, c: Card): string {
  const pl = P(g, p), cost = costOf(g, p, c), req = reqOf(g, c);
  const others = pl.hand.filter((x) => x !== c);
  const fit = others.filter((x) => gemFits(g, x, c));
  const tot = fit.reduce((a, x) => a + gemOf(g, x, c), 0), all = others.reduce((a, x) => a + gemOf(g, x, c), 0);
  if (tot < cost) {
    const cols = colorsEn(c);
    if (all >= cost && cols.length) return `Not enough ${cols.join('/')} or colorless GEM: need ${cost}, ${tot} fits · GEM สี${cols.map((x) => GEM_TH[x] || x).join('/')}ไม่พอ`;
    return `Not enough GEM: need ${cost}, your other hand cards give ${tot} · GEM ไม่พอ (ต้องการ ${cost} มี ${tot})`;
  }
  if (req) {
    const cs = fit.filter((x) => gemIs(gemColorOf(g, x, c), req.color)).reduce((a, x) => a + gemOf(g, x, c), 0);
    if (cs < req.n) return `Needs at least ${req.n} ${req.color} GEM, you have ${cs} · GEM สี${GEM_TH[req.color] || req.color}ไม่พอ`;
  }
  if (exactLand(g, c)) return 'หมู่บ้านพอดี: an Avatar must be paid with GEM exactly equal to its cost · Avatar ต้องจ่าย GEM พอดี ห้ามเกิน';
  return "Can't pay its cost right now · จ่าย GEM ไม่ได้";
}
/** bugfix15 (UI thread, user ask): the real reason instead of "condition not met". Order: the card's own FX.why, wear
 *  limits (Modification), the text's condition ("สามารถใช้ได้เมื่อ X :", "เมื่อ X :", "ถ้า X :"), its text cost ("X : ..."
 *  with เซ่นไหว้ / สภาพนอน / ทิ้ง / เนรเทศ / ลงนรก), missing targets, then the generic line. Format 'EN · TH'. */
const CLIP = (x: string, n = 64) => { x = x.replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n - 1) + '…' : x; };
export function condWhy(g: Game, p: PID, c: Card): string {
  const f = fx(c);
  if (f && f.why) { const r = f.why(g, p, c); if (r) return r; }
  const t = cardText(c).replace(/\s+/g, ' ').trim();
  const pl = P(g, p), op = P(g, opp(p));
  if (c.def.subtype === 'Modification') {
    const line = cardText(c).split('\n').find((l) => /สวมใส่(?:ได้)?เฉพาะ/.test(l)) || '';
    const om = line.match(/สวมใส่(?:ได้)?เฉพาะ\s*(.+?)(?:\s+เท่านั้น|\s+และ|\s*$)/);
    const only = om ? [om[0], om[1].replace(/""/g, '"').replace(/"\s*([^"]*?)\s*"/g, '"$1"')] : null;
    let anyWear = pl.avatars.some((a) => { try { return canWear(g, c, a); } catch { return true; } });
    if (anyWear && f && f.modTarget) { try { anyWear = !!f.modTarget(g, p, c); } catch { /* keep */ } }
    if (!anyWear && humanModTargets(g, p, c).length) anyWear = true; // bugfix19: either side's Avatar
    if (only && !anyWear) return `Only ${CLIP(only[1], 50)} can wear it, none on your field · สวมใส่ได้เฉพาะ ${CLIP(only[1], 50)} (ไม่มีบนสนามเรา)`;
    if (!pl.avatars.length && !humanModTargets(g, p, c).length) return 'Needs an Avatar on the field to wear it · ต้องมี Avatar บนสนามให้สวมใส่';
    if (!anyWear) return 'None of your Avatars can wear it now · ไม่มี Avatar ของเราที่สวมใส่ได้ตอนนี้';
  }
  const cond = t.match(/(?:สามารถ)?ใช้(?:การ์ดใบนี้)?ได้(?:เฉพาะ)?(?:เมื่อ|ถ้า|ก็ต่อเมื่อ)\s*([^:]+?)\s*:/) || t.match(/^(?:เมื่อ|ถ้า|หาก)\s*([^:]+?)\s*:/)
    || t.match(/(?:อัญเชิญ(?:การ์ดใบนี้)?ได้(?:เฉพาะ)?(?:เมื่อ|ถ้า|ก็ต่อเมื่อ))\s*([^:/]+)/);
  if (cond) return `Needs: ${CLIP(cond[1])} · เงื่อนไข: ${CLIP(cond[1])}`;
  const head = t.match(/^([^:]{4,160}?)\s*:\s/);
  if (head && /เซ่นไหว้|สภาพนอน|ทิ้ง|เนรเทศ|ลงนรก|ลง นรก|จ่าย|เปิด LIFE|คว่ำ/.test(head[1])) return `Can't pay its text cost: ${CLIP(head[1])} · จ่ายค่าใช้จ่ายของการ์ดไม่ได้: ${CLIP(head[1])}`;
  if (/ทุกคน|ทั้งสองฝ่าย/.test(t) && /Avatar/.test(t) && (!pl.avatars.length || !op.avatars.length)) return 'Both players need an Avatar · ผู้เล่นทั้งสองฝ่ายต้องมี Avatar';
  if (/Avatar\s*(?:บนสนาม|บน Avatar Zone|ใน Avatar Zone)?\s*(?:ของ)?(?:อีกฝ่าย|ฝ่ายตรงข้าม)/.test(t) && !op.avatars.length) return "Needs an opponent's Avatar · ฝ่ายตรงข้ามไม่มี Avatar";
  if (/Magic Zone/.test(t) && /ทำลาย|เลือก/.test(t) && !op.mz.length && !lands(g).length) return 'No card in the Magic Zone / Land to choose · ไม่มีการ์ดใน Magic Zone หรือ Land ให้เลือก';
  if (/Avatar\s*(?:บนสนาม|บน Avatar Zone|ใน Avatar Zone)?\s*(?:ของ)?(?:ฝ่าย)?เรา/.test(t) && !pl.avatars.length) return 'Needs an Avatar on your field · ต้องมี Avatar บนสนามเรา';
  if (/คว่ำ LIFE/.test(t) && !pl.life.some((l: any) => l.faceUp)) return 'No face-up LIFE card to turn down · ไม่มี LIFE ที่หงายอยู่';
  if (/เลือกปฏิบัติ/.test(t)) {
    const ifs = [...t.matchAll(/\d\)\s*ถ้า\s*(.+?)\s+(?:อัญเชิญ|จั่ว|ทำลาย|นำ|เลือก|ให้|:)/g)].map((m) => CLIP(m[1], 40));
    if (ifs.length) return `No option can be used now: ${ifs.join(' / ')} · ไม่มีตัวเลือกที่ใช้ได้ตอนนี้: ${ifs.join(' / ')}`;
    return 'No option of this card can be used now · ไม่มีตัวเลือกที่ใช้ได้ตอนนี้';
  }
  if (/1 เทิร์น|เทิร์นละ|ครั้งต่อเทิร์น/.test(t)) return 'Once per turn: already used · ใช้ไปแล้วเทิร์นนี้';
  return 'Its condition is not met · ยังไม่เข้าเงื่อนไข';
}
export function whyNot(g: Game, p: PID, c: Card): string {
  const pl = P(g, p), f = fx(c);
  if (g.active !== p || g.phase !== 'Main') return 'Only in your Main Phase · ใช้ได้ในเฟสหลักของเราเท่านั้น';
  if (c.def.type === 'Life') return 'A LIFE card · การ์ด LIFE';
  if (c.def.type === 'Construct') {
    if (pl.mz.filter((x) => x.def.type === 'Construct' && x.def.name === c.def.name).length >= (c.def.czMax || 1)) return 'A Construct with this name is already built · สร้างชื่อนี้ไปแล้ว';
    if (pl.mz.filter((x) => x.def.type === 'Construct').length >= 3) return 'Magic Zone is full (3 Constructs) · Magic Zone เต็ม';
    return bestPayment(g, p, costOf(g, p, c), [c], c) === null ? gemWhy(g, p, c) : condWhy(g, p, c);
  }
  if (isAvatarDef(c.def)) {
    if (!canPlaceAvatar(pl, false, c)) return (realAvatars(pl).length >= 4 && !ratSix(g, pl) ? 'Avatar Zone is full (4 Avatars) · Avatar Zone เต็ม' : 'Avatar Zone is full · Avatar Zone เต็ม');
    if (f && f.noHandSummon) return "Can't be summoned from the hand · อัญเชิญจากมือไม่ได้";
    if (uniqueBlocked(g, p, c)) return 'Only one with this name on the field · มีชื่อนี้บนสนามได้ใบเดียว';
    if (bestPayment(g, p, costOf(g, p, c), [c], c) === null) return gemWhy(g, p, c);
    return condWhy(g, p, c);
  }
  if (c.def.type === 'Magic') {
    const kind = c.def.subtype as 'Normal';
    if (!magicSlotFree(g, p, c)) return `${kind} Magic already cast this turn · ร่าย Magic ${kind} ไปแล้วเทิร์นนี้`;
    if (!f) return "This card's effect is not coded yet · การ์ดนี้ยังไม่รองรับ";
    if (kind === ('React' as any) && !f.mainUse) return 'React: used in reply to the opponent · ใช้ตอบโต้ฝ่ายตรงข้ามเท่านั้น';
    if (kind === ('Land' as any) && lands(g).some((l) => fx(l)?.lockLand)) return "The Land in play can't be replaced · เปลี่ยน Land ตอนนี้ไม่ได้";
    if (bestPayment(g, p, costOf(g, p, c), [c], c) === null) return gemWhy(g, p, c);
    return condWhy(g, p, c);
  }
  return '';
}


// A deep copy of the game for Undo (the log array is shared, not copied).
export function copyGame(g: Game): any {
  const lg = g.log; g.log = null;
  try { return structuredClone(g); } finally { g.log = lg; }
}
// Put a copy back IN PLACE: the engine's call stack holds the Game object and its two Player objects (playTurn's
// `pl`), so those stay the same objects and only their contents are replaced. Cards become the copy's cards.
export function restoreGame(g: Game, snap: any) {
  const c: any = structuredClone(snap), lg = g.log;
  for (const k of Object.keys(g)) if (k !== 'p' && k !== 'log' && !(k in c)) delete (g as any)[k];
  for (const k of Object.keys(c)) if (k !== 'p' && k !== 'log') (g as any)[k] = c[k];
  for (const i of [0, 1]) {
    const pl: any = g.p[i];
    for (const k of Object.keys(pl)) if (!(k in c.p[i])) delete pl[k];
    Object.assign(pl, c.p[i]);
  }
  g.log = lg;
}

// v12 battle preview (no side effects: only power() / hasKw() reads; no React windows, no random, no triggers).
// atk = attacker POWER with the helpers added (สามัคคี: helper POWER, แทงหลัง: helper POWER + 1), def = target POWER (null = LIFE).
// result: 'life' (a LIFE card flips) | 'win' (target destroyed) | 'lose' (attacker destroyed) | 'both' (tie, both destroyed).
// backstabKill = the attacker is destroyed after the fight by แทงหลัง's colour rule. "when attacks" triggers, Land bonuses and
// React cards can still change the real fight.
export type Preview = { atk: number; def: number | null; result: 'life' | 'win' | 'lose' | 'both'; backstabKill: boolean; text: string };
export function battlePreview(g: Game, p: PID, att: Card, target: Card | null, helpers: Card[] = []): Preview {
  let atk = power(g, att), backstabKill = false;
  for (const u of helpers) {
    if (hasKw(g, u, 'unite')) atk += power(g, u);
    else if (hasKw(g, u, 'backstab')) {
      atk += power(g, u) + 1;
      if (!colorsEn(att).some((x) => colorsEn(u).includes(x))) backstabKill = true;
    }
  }
  if (!target) return { atk, def: null, result: 'life', backstabKill, text: `${atk} → LIFE: a LIFE card flips · เปิด LIFE 1 ใบ` + (backstabKill ? '; attacker destroyed after (แทงหลัง)' : '') };
  const def = power(g, target);
  const tieA = hasKw(g, att, 'tieWin'), tieD = hasKw(g, target, 'tieWin');
  const result = atk > def || (atk === def && tieA && !tieD) ? 'win' : def > atk || (atk === def && tieD && !tieA) ? 'lose' : 'both';
  const what = result === 'win' ? `${target.def.name} destroyed · ทำลาย` : result === 'lose' ? `${att.def.name} destroyed · ฝ่ายเราถูกทำลาย` : 'both destroyed · ถูกทำลายทั้งคู่';
  return { atk, def, result, backstabKill: backstabKill && result !== 'lose' && result !== 'both', text: `${atk} vs ${def}: ${what}` + (backstabKill && result === 'win' ? '; attacker destroyed after (แทงหลัง)' : '') };
}

// v12 speed: a pacing wait of ms at speed factor k (1 = 1x, 0.5 = 2x, 0 = skip). Bad factors count as 1x.
export function scaledMs(ms: number, k: number): number {
  if (!Number.isFinite(k) || k < 0) k = 1;
  return Math.max(0, Math.round(ms * Math.min(k, 4)));
}
