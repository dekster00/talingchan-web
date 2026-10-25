// v11 play-table helpers (used by play/worker.ts, tested in tools/unit.ts):
// whyNot = why a hand card can't be played now (tooltip on a greyed hand card); copyGame / restoreGame = Main Phase Undo.
import type { Card, Game, PID } from './types.ts';
import { magicSlotFree } from './engine.ts'; // simplify1
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
export function whyNot(g: Game, p: PID, c: Card): string {
  const pl = P(g, p), f = fx(c);
  if (g.active !== p || g.phase !== 'Main') return 'Only in your Main Phase · ใช้ได้ในเฟสหลักของเราเท่านั้น';
  if (c.def.type === 'Life') return 'A LIFE card · การ์ด LIFE';
  if (c.def.type === 'Construct') {
    if (pl.mz.filter((x) => x.def.type === 'Construct' && x.def.name === c.def.name).length >= (c.def.czMax || 1)) return 'A Construct with this name is already built · สร้างชื่อนี้ไปแล้ว';
    if (pl.mz.filter((x) => x.def.type === 'Construct').length >= 3) return 'Magic Zone is full (3 Constructs) · Magic Zone เต็ม';
    return bestPayment(g, p, costOf(g, p, c), [c], c) === null ? gemWhy(g, p, c) : 'Its condition is not met · ยังไม่เข้าเงื่อนไข';
  }
  if (isAvatarDef(c.def)) {
    if (!canPlaceAvatar(pl, false, c)) return (realAvatars(pl).length >= 4 && !ratSix(g, pl) ? 'Avatar Zone is full (4 Avatars) · Avatar Zone เต็ม' : 'Avatar Zone is full · Avatar Zone เต็ม');
    if (f && f.noHandSummon) return "Can't be summoned from the hand · อัญเชิญจากมือไม่ได้";
    if (uniqueBlocked(g, p, c)) return 'Only one with this name on the field · มีชื่อนี้บนสนามได้ใบเดียว';
    if (bestPayment(g, p, costOf(g, p, c), [c], c) === null) return gemWhy(g, p, c);
    return 'Its condition is not met · ยังไม่เข้าเงื่อนไข';
  }
  if (c.def.type === 'Magic') {
    const kind = c.def.subtype as 'Normal';
    if (!magicSlotFree(g, p, c)) return `${kind} Magic already cast this turn · ร่าย Magic ${kind} ไปแล้วเทิร์นนี้`;
    if (!f) return "This card's effect is not coded yet · การ์ดนี้ยังไม่รองรับ";
    if (kind === ('React' as any) && !f.mainUse) return 'React: used in reply to the opponent · ใช้ตอบโต้ฝ่ายตรงข้ามเท่านั้น';
    if (kind === ('Land' as any) && lands(g).some((l) => fx(l)?.lockLand)) return "The Land in play can't be replaced · เปลี่ยน Land ตอนนี้ไม่ได้";
    if (bestPayment(g, p, costOf(g, p, c), [c], c) === null) return gemWhy(g, p, c);
    return 'Its condition is not met · ยังไม่เข้าเงื่อนไข';
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
