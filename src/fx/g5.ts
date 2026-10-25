// Card effects for BT07 (cards not coded in cards.ts / cards2.ts).
import { rollDie } from '../engine.ts';
import type { Card, Game, PID } from '../types.ts';
import type { Fx, HandAct } from '../cards.ts';
import { FX, value, best, worst, pickGemExact, pickN, worstN, mayDo, chooseMode, oppChoice, oppTargets, magicOk, search, inMain } from '../cards.ts';
import { costFirst } from '../cards.ts'; // other-team audit Q9
import { discard } from '../engine.ts'; // other-team audit Q21
import {
  P, opp, power, draw, destroy, toHell, toHand, detach, summon, shuffle, canPlaceAvatar, flippedLife, critical,
  onceUsed, markOnce, keepValue, log, findCard, fx, rand, silenced, hasKw, hitLife, gemOf, castMagic, withDecider, isVanara,
  symIs, symAny, colorIs, scoutDeck, putBottom, silenceFull, summonExact, colorsEn, arrangeTopBottom, decide, humanDeciding
} from '../engine.ts';
import { canChangeCtrl, takeControl, grantKw, landIs as landOn, isLandOn, placeLand, magicImmune, currentSource, lands, useShield } from '../engine.ts';
import { attach as attachCard, canWear, lifeDown } from '../engine.ts'; // v14d
// v14 (group C rulings)
import {
  lockInHell, hellLocked, addToHand, discard as discardE,
  nameHas, emit, abilityWindow, contOff, turnLog, addRule, RULES, legalTargets, askChoose, quiet, flipLifeCard, toExile, mill,
} from '../engine.ts';
import { addNote, grantGet } from '../view.ts';

// ---------- helpers ----------
const isA = (c: Card) => c.def.type === 'Avatar' || c.def.type === 'Token';
function named(c: Card, key: string) {
  if (c.def.aka && c.def.aka.some((a) => a.includes(key))) return true;
  if (c.def.name.includes(key)) return true;
  const f = FX[c.def.name];
  if (f && f.alias && f.alias.some((a) => a.includes(key))) return true;
  // เก้าอี้ เฟิร์สคลาส: the wearer gains the name "Super Air"
  return c.mods.some((m) => m.def.name === 'เก้าอี้ เฟิร์สคลาส') && 'Super Air'.includes(key);
}
const onZone = (g: Game, p: PID, key: string) => P(g, p).avatars.filter((a) => named(a, key));
const once = (g: Game, p: PID, key: string) => !onceUsed(g, P(g, p), key);
const act = (label: string, can: (g: Game) => boolean, run: (g: Game) => void): HandAct => ({ label, can, run });
function boost(c: Card, n: number) { c.temp.push({ power: n, until: 'turn' }); }
const distinctNames = (cs: Card[]) => new Set(cs.map((c) => c.def.name)).size;
const hellAvatars = (g: Game, p: PID, pred: (c: Card) => boolean = () => true) => P(g, p).hell.filter((c) => isA(c) && pred(c));
// สอดแนม / look at the top n: engine scoutDeck() reveals them, lets the human pick and order the rest
function peek(g: Game, p: PID, n: number, pick: (cs: Card[]) => void, rest: 'bottom' | 'shuffle' | 'hell' | 'top' | 'either' = 'shuffle') {
  scoutDeck(g, p, n, pick, rest);
}
function takeHand(g: Game, p: PID, list: Card[], pred: (c: Card) => boolean) {
  const c = best(list.filter(pred), (x) => keepValue(g, x) + x.def.power * 0.3);
  if (!c || !addToHand(g, c, p, { from: 'deck' })) return null; // v14b: onToHand / blockToHand
  const i = list.indexOf(c); if (i >= 0) list.splice(i, 1);
  return c;
}
function discardWorst(g: Game, p: PID, n: number, except: Card[] = [], pred: (c: Card) => boolean = () => true) {
  for (let i = 0; i < n; i++) {
    const d = worst(P(g, p).hand.filter((x) => !except.includes(x) && pred(x)), (x) => keepValue(g, x));
    if (!d) return false;
    discard(g, p, d); // other-team audit Q21: through discard() so FX.onDiscard sees it (as in g6 / g8)
  }
  return true;
}
function fromZoneSummon(g: Game, p: PID, zone: Card[], pred: (c: Card) => boolean, how: 'jutsu' | 'effect' = 'effect') {
  const c = best(zone.filter((x) => isA(x) && pred(x)), (x) => value(g, x));
  if (c && canPlaceAvatar(P(g, p)) && summon(g, p, c, how) && P(g, p).avatars.includes(c)) return c;
  return null;
}
function attach(g: Game, c: Card, w: Card) {
  if (!canChangeCtrl(g, c, w.ctrl)) { log(g, `${c.def.name}: its control can't be changed (รูปประจำบ้าน)`); return; }
  if (!canWear(g, c, w)) { log(g, `${c.def.name} can't be attached to ${w.def.name}`); if (!findCard(g, c.uid)) P(g, c.owner).hell.push(c); return; } // v14d: canWear
  detach(g, c);
  c.asleep = false; c.temp = []; c.wearer = w.uid; c.ctrl = w.ctrl;
  attachCard(g, c, w, false); // v14d: central attach (canWear checked above; onAttach stays with the callers)
}
// May `by` remove `a` from the field (Magic immunity, leave-prevention)?
function canRemove(g: Game, by: PID, a: Card, viaMagic: boolean) {
  if (viaMagic && !magicOk(g, by, a)) return false;
  const f = fx(a);
  if (a.ctrl !== by && f && f.preventLeave && !silenced(g, a) && f.preventLeave(g, a)) return false;
  return true;
}
function toDeck(g: Game, a: Card, top: boolean) {
  const pl = P(g, a.owner);
  toHell(g, a);
  const i = pl.hell.indexOf(a);
  if (i >= 0) { pl.hell.splice(i, 1); if (top) pl.deck.unshift(a); else pl.deck.push(a); }
}
// Move an Avatar from the field into a player's Magic Zone.
function toMagicZone(g: Game, a: Card, zoneOf: PID) {
  const pl = P(g, a.owner);
  toHell(g, a);
  const i = pl.hell.indexOf(a);
  if (i >= 0) { pl.hell.splice(i, 1); P(g, zoneOf).mz.push(a); log(g, `${a.def.name} goes to P${zoneOf}'s Magic Zone`); }
}
// Hell card -> bottom of the Deck
function hellToBottom(g: Game, p: PID, c: Card) { detach(g, c); P(g, p).deck.push(c); }
// The top face-down LIFE card (the next one to flip)
const topLife = (g: Game, p: PID) => P(g, p).life.find((l) => !l.faceUp);
// Guess the card type on top of the opponent's Deck: the most common type left in it.
function declareType(g: Game, p: PID): string {
  const cnt: Record<string, number> = {};
  for (const c of P(g, opp(p)).deck) cnt[c.def.type] = (cnt[c.def.type] || 0) + 1;
  let bt = 'Avatar', bv = -1;
  for (const [t, v] of Object.entries(cnt)) if (v > bv) { bv = v; bt = t; }
  return bt;
}
const d6 = (g: Game) => rollDie(g); // emits the 'roll' event

// ครุฑ
const garuda = (c: Card) => isA(c) && named(c, 'ครุฑ');
const garOrFlare = (c: Card) => garuda(c) || c.def.name === 'ขนมณี แฟลร์';
function callGaruda(g: Game, p: PID) {
  const pl = P(g, p);
  const t = fromZoneSummon(g, p, pl.deck, (x) => garuda(x) && x.def.cost <= 4);
  shuffle(g, pl.deck);
  return t;
}
const canCallGaruda = (g: Game, p: PID) => canPlaceAvatar(P(g, p)) && P(g, p).deck.some((x) => garuda(x) && x.def.cost <= 4);
// "เมื่อจบเทิร์น นำ Avatar ใบนี้ขึ้นมือ" granted by ครุฑสุบรรณ
function garudaEnd(g: Game, c: Card) { for (const a of [...P(g, c.ctrl).avatars]) if (a.f.endHand === g.turn) toHand(g, a); }

// จอมเวทย์ / คาถา
const wizard = (c: Card) => isA(c) && named(c, 'จอมเวท');
const kata = (c: Card) => c.def.type === 'Magic' && c.def.name.includes('คาถา');
// "เมื่อมีการใช้ คาถา": ไม้กายสิทธิ์ +1, จอมเวทย์ กาลู draws (once per turn). Deduplicated per Magic card.
// v14: กาลู and ไม้กายสิทธิ์ now watch every Magic named "คาถา" through FX.onAnyMagic (cast or React, any player),
// so this old per-file trigger does nothing any more (kept so the คาถา cards' calls stay harmless).
function kataUsed(g: Game, p: PID, magic: Card) { void g; void p; void magic; }
const wizardMagic: Fx['onOwnMagic'] = (g, s, m) => kataUsed(g, s.ctrl, m);

// ตั๊กแตน
const THRONE = 'บัลลังก์ตั๊กแตนศตวรรษ';
const grasshopper = (c: Card) => isA(c) && (named(c, 'ตั๊กแตน') || c.def.name === 'วาฬทมิฬ ก้า'); // "ตั๊กแตน" in name or text box
const throneAura: Fx['aura'] = (g, s, t) => (t !== s && t.ctrl === s.ctrl && grasshopper(t) && s.mods.some((m) => m.def.name === THRONE) ? 1 : 0);

// "can't attack" restrictions: power() runs at every state check, so this keeps noAttack current.
function noAttackIf(c: Card, g: Game, blocked: boolean) { c.f.noAttack = blocked ? g.turn : 0; }

// พี่หน่วง / ยานรายการ
const SHIP = 'ยานรายการ เถียงทันหน่วง';
const shipOn = (g: Game, p: PID) => P(g, p).mz.some((x) => x.def.name === SHIP);
const oppInMz = (g: Game, p: PID) => P(g, p).mz.filter((x) => isA(x) && x.owner !== p);

// Avatars with โดนใจ (from the card database)
const DONJAI = new Set(['40ดีกรีแมน', 'YaiMakMak', 'คุณคำดี', 'น้าแมน', 'ปอนด์ สมาชิกลัทธิแห่หัว', 'พรีวิวบอย', 'พอง พอง',
  'พี่ซี๊ด แก๊งขยะ', 'พี่บูม แก๊งขยะ', 'พี่วัฒน์ BGN', 'พี่เจมส์ แก๊งขยะ', 'พี่โปจิ เจ้าลัทธิแห่หัว', 'พี่่ NUT', 'รีวิวแมน', 'ลาพิเน่ โพลีกอน',
  'ลุงไนท์ ราชาวานร', 'ลูเซีย โพลีกอน', 'ลูเซเน่ โพลีกอน', 'วานรช่องแชท', 'เจนนี่ อย่าบู้บี้เลขา', 'เต่า', 'เนอร์เกิ้ล เนียร์ สมาชิกลัทธิแห่หัว',
  'เบรกเกต แก๊งขยะ', 'เพนกวิ้น ฮัท', 'แมวดำ สมาชิกลัทธิแห่หัว', 'แอชลีย์', 'โซน่า โพลีกอน', 'โฮคุ โพลีกอน']);

// Power without the Land (for หมู่บ้านเห็ด), same order as engine power()
function powerNoLand(g: Game, c: Card): number {
  let v = c.def.power + c.bonus;
  for (const t of c.temp) v += t.power;
  for (const m of c.mods) { const f = fx(m); if (f && f.modPower) v += f.modPower(g, m, c); }
  const f = fx(c);
  if (f && f.staticPower && !silenced(g, c)) v += f.staticPower(g, c);
  for (const q of g.p) for (const s of q.avatars.concat(q.mz)) { const sf = fx(s); if (sf && sf.aura && !silenced(g, s)) v += sf.aura(g, s, c); }
  return Math.max(0, v);
}
// เพ้อเจ้อ: set an Avatar's power back to its printed power
function resetPower(g: Game, t: Card) {
  t.temp = []; t.bonus = 0;
  const d = t.def.power - power(g, t);
  if (d !== 0) boost(t, d); // approx: continuous effects are cancelled by a modifier until end of turn
}
const resetGain = (g: Game, p: PID, a: Card) => (a.ctrl === p ? a.def.power - power(g, a) : power(g, a) - a.def.power);

// อัศวินแบงค์: discard cards whose GEM adds up to exactly 3 (no 0-GEM cards)
function exact3(g: Game, p: PID, self: Card): Card[] | null {
  const hand = P(g, p).hand.filter((x) => x !== self && gemOf(g, x, self) > 0 && gemOf(g, x, self) <= 3).slice(0, 12);
  let bestSet: Card[] | null = null, bv = Infinity;
  for (let mask = 1; mask < 1 << hand.length; mask++) {
    let s = 0, v = 0; const set: Card[] = [];
    for (let i = 0; i < hand.length; i++) if (mask & (1 << i)) { s += gemOf(g, hand[i], self); v += keepValue(g, hand[i]); set.push(hand[i]); }
    if (s === 3 && v < bv) { bv = v; bestSet = set; }
  }
  return bestSet;
}

const NEW: Record<string, Fx> = {
  // ===== เทพ =====
  'พระแม่อุมาเทวี': {
    keep: 4,
    jutsu: (g, c) => {
      const p = c.ctrl, pl = P(g, p);
      const ok = (x: Card) => symIs(x, 'เทพ') && !x.def.only;
      if (!pl.hell.some(ok) || pl.hand.length === 0) return;
      discardWorst(g, p, 1);
      search(g, p, ok, 'hell');
    },
    // approx: only used in our own Main Phase ("ในเทิร์นใครก็ได้")
    fieldActs: (g, p, c) => [act('อุมาเทวี: call เจ้าแม่กาลี', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c)
      && P(g2, opp(p)).avatars.some((a) => named(a, 'พระอิศวร') && a.owner !== a.ctrl)
      && [...P(g2, p).deck, ...P(g2, p).hand].some((x) => x.def.name === 'เจ้าแม่กาลี'),
    (g2) => {
      const pl = P(g2, p);
      toHell(g2, c);
      const fromHand = pl.hand.find((x) => x.def.name === 'เจ้าแม่กาลี');
      const k = fromHand || pl.deck.find((x) => x.def.name === 'เจ้าแม่กาลี');
      if (k && canPlaceAvatar(pl)) summon(g2, p, k, 'jutsu');
      if (!fromHand) shuffle(g2, pl.deck);
    })],
  },
  'เจ้าแม่กาลี': {
    keep: 5,
    jutsu: (g, c) => {
      const t = best(P(g, opp(c.ctrl)).avatars.filter((a) => symIs(a, 'เทพ')), (a) => value(g, a));
      if (!(t && destroy(g, t, c.ctrl))) draw(g, c.ctrl, 1);
    },
  },

  // ===== misc =====
  'พรีวิวบอย': {
    keep: 3,
    fieldActs: (g, p, c) => [act('พรีวิวบอย: copy power', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'preview:' + c.uid)
      && P(g2, p).avatars.some((a) => power(g2, a) > 0),
    (g2) => {
      markOnce(g2, P(g2, p), 'preview:' + c.uid);
      const t = best(P(g2, p).avatars, (a) => power(g2, a)); // other-team audit: "Avatar ฝ่ายเรา 1 ใบ" may be itself
      if (t) boost(c, power(g2, t));
    })],
  },
  'ฤๅษีพระเจ้าตา': {
    keep: 3,
    // approx: "พอดี" (exact payment) is not checked
    jutsu: (g, c) => { search(g, c.ctrl, (x) => x.def.type === 'Magic' && (symIs(x, 'ฤษี') || symIs(x, 'ฤๅษี')), 'deck'); },
  },
  'อนันตวดี ราชินีแห่งนาค': {
    keep: 1.5,
    costOnlyFor: (s) => isA(s) && symIs(s, 'สัตว์มหัศจรรย์'),
    gemAs: (g, c, s) => (s && s.def.name === 'อนันต์ ราชาแห่งนาค' ? 6 : c.def.gem),
    usedAsCost: (g, p, c, s) => { if (named(s, 'นาค') && symIs(s, 'สัตว์มหัศจรรย์') && P(g, p).avatars.includes(s)) boost(s, 3); },
  },
  'สัตว์ทดลอง #1': {
    keep: 1,
    gemAs: (g, c) => (distinctNames(hellAvatars(g, c.owner)) >= 10 ? 8 : 0),
  },
  'ตำรวจไซบอร์ค จ่านิ่ง': {
    keep: 2.5,
    fieldActs: (g, p, c) => [act('จ่านิ่ง: opponent draws 1 and puts 1 on top', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'ning:' + c.uid)
      && P(g2, opp(p)).deck.length > 0,
    (g2) => {
      markOnce(g2, P(g2, p), 'ning:' + c.uid);
      const o = opp(p);
      draw(g2, o, 1);
      const x = decide(g2, o, () => worst(P(g2, o).hand, (y) => keepValue(g2, y))); // the opponent picks
      if (x) { detach(g2, x); P(g2, o).deck.unshift(x); }
    })],
  },
  'เจมี่ ขยะสังคม': {
    keep: 3,
    jutsu: (g, c) => peek(g, c.ctrl, 7, (top) => { takeHand(g, c.ctrl, top, (x) => x.def.name === 'อาวุธชีวภาพ เอ็มตัวเต็ง'); }, 'bottom'),
    deathCry: (g, c, owner) => peek(g, owner, 3, (top) => { takeHand(g, owner, top, (x) => x.def.name === 'อาวุธชีวภาพ เอ็มตัวเต็ง'); }, 'bottom'),
  },
  'น้องไอซ์ จี่สมอง': {
    keep: 3.5,
    // checked after React responses (onAttack); confirmed by the user (v14)
    onAttack: (g, c, t) => { if (t && P(g, t.ctrl).avatars.includes(t) && power(g, t) <= 3) destroy(g, t, c.ctrl); },
  },
  'ไอ้แม๊ก ขยะสังคม': {
    keep: 2.5,
    deathCry: (g, c, owner) => {
      const zone = P(g, opp(owner)).mz;
      const x = best(zone, (y) => (y.owner === owner ? value(g, y) + 2 : keepValue(g, y)));
      if (x) toHand(g, x);
    },
  },

  // ===== ครุฑ =====
  'ครุฑสุบรรณ เจ้าเวหา': {
    keep: 6,
    // the returned ครุฑ / ขนมณี แฟลร์ go from our hell into the Deck (confirmed by the user, v14)
    fieldActs: (g, p, c) => [1, 2, 3].map((n) => act(`ครุฑสุบรรณ: return ${n} to Deck, call ครุฑ`, (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c)
      && once(g2, p, 'subun:' + c.uid) && P(g2, p).hell.filter(garOrFlare).length >= n && canCallGaruda(g2, p),
    (g2) => {
      const pl = P(g2, p); markOnce(g2, pl, 'subun:' + c.uid);
      for (const x of worstN(pl.hell.filter(garOrFlare), n, (y) => keepValue(g2, y), { title: `ครุฑสุบรรณ: return ${n} ครุฑ / ขนมณี แฟลร์ to the Deck` })) hellToBottom(g2, p, x);
      const t = callGaruda(g2, p);
      if (!t) return;
      if (n === 1) t.f.endHand = g2.turn;
      if (n === 3) boost(t, 2);
    })),
    endPhase: garudaEnd,
  },
  'ครุฑเวนไตย เจ้ากำลัง': {
    keep: 3.5,
    fieldActs: (g, p, c) => [act('ครุฑเวนไตย: recycle ครุฑ, +3', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'venai:' + c.uid)
      && P(g2, p).hell.some((x) => (garuda(x) && x.def.name !== c.def.name) || x.def.name === 'ขนมณี แฟลร์'),
    (g2) => {
      markOnce(g2, P(g2, p), 'venai:' + c.uid);
      const x = worst(P(g2, p).hell.filter((y) => (garuda(y) && y.def.name !== c.def.name) || y.def.name === 'ขนมณี แฟลร์'), (y) => keepValue(g2, y));
      if (x) { hellToBottom(g2, p, x); boost(c, 3); }
    })],
    endPhase: garudaEnd,
  },
  'ครุฑวัสสวัส เจ้าโลก': {
    keep: 4.5,
    jutsu: (g, c) => {
      const p = c.ctrl;
      const x = worst(P(g, p).hell.filter(garOrFlare), (y) => keepValue(g, y));
      if (!x || !canCallGaruda(g, p)) return;
      hellToBottom(g, p, x);
      callGaruda(g, p);
    },
    endPhase: garudaEnd,
  },
  'ครุฑสัจจะ เจ้าแห่งแสง': {
    keep: 4,
    jutsu: (g, c) => {
      const p = c.ctrl;
      if (!P(g, p).hand.some(garOrFlare) || !canCallGaruda(g, p)) return;
      discardWorst(g, p, 1, [], garOrFlare);
      callGaruda(g, p);
    },
    endPhase: garudaEnd,
  },

  // ===== บึงทมิฬ =====
  'บึงทมิฬ  People - คุณตะพาบ': {
    keep: 3,
    deathCry: (g, c, owner) => {
      const pl = P(g, owner);
      const w = pl.hell.find((x) => x.def.name === 'วอเตอร์แมน');
      if (w) { detach(g, w); pl.deck.push(w); shuffle(g, pl.deck); }
      draw(g, owner, 1);
    },
  },

  // ===== หิมะ =====
  'ราชาหิมะ บิง': {
    keep: 5,
    costOf: (g, p, c) => Math.max(0, c.def.cost - hellAvatars(g, p, (x) => named(x, 'ทหารหิมะ')).length),
  },
  'ราชินีหิมะ ชีหลิน': {
    keep: 4,
    staticPower: (g, c) => 2 * onZone(g, c.ctrl, 'ทหารหิมะ').length + 3 * onZone(g, c.ctrl, 'ราชาหิมะ').length,
  },
  'พลทหารหิมะ': { keep: 2 }, // deck-building rule only (up to 12 copies)
  'อัศวินแบงค์': {
    keep: 4,
    handActs: (g, p, c) => [act('อัศวินแบงค์: discard exactly 3 GEM, summon as POWER 3', (g2) => inMain(g2, p) && P(g2, p).hand.includes(c) && canPlaceAvatar(P(g2, p))
      && exact3(g2, p, c) !== null,
    (g2) => {
      const plan = exact3(g2, p, c);
      if (!plan) return;
      const pay = pickGemExact(g2, p, 3, c, plan, 'อัศวินแบงค์: discard cards with exactly 3 GEM');
      if (!pay) return;
      for (const x of pay) { detach(g2, x); P(g2, p).hell.push(x); }
      if (summon(g2, p, c, 'own') && P(g2, p).avatars.includes(c)) c.bonus = 3 - c.def.power;
    })],
  },

  // ===== ไอดอล / พี่หน่วง =====
  'ชาช่าจัง ไอดอลคนเก่ง': {
    keep: 3,
    // v14: "can only wear โอตะ" is enforced for Modification casts by the wear wrapper (wearOk, end of this file)
    staticPower: (g, c) => { ensureWear(); noAttackIf(c, g, c.f.canAtk !== g.turn); return 0; },
    fieldActs: (g, p, c) => [act('ชาช่าจัง: break a โอตะ to attack', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'chacha:' + c.uid)
      && g2.turn > 1 && !c.asleep && onZone(g2, p, 'ไอดอล').some((a) => a.mods.some((m) => named(m, 'โอตะ'))),
    (g2) => {
      markOnce(g2, P(g2, p), 'chacha:' + c.uid);
      const m = worst(onZone(g2, p, 'ไอดอล').flatMap((a) => a.mods.filter((x) => named(x, 'โอตะ'))), (x) => keepValue(g2, x));
      if (!m) return;
      detach(g2, m); P(g2, m.owner).hell.push(m);
      c.f.canAtk = g2.turn; c.f.noAttack = 0;
    })],
  },
  'พี่หน่วง พิธีกรผมสวย': {
    keep: 4.5,
    jutsu: (g, c) => { if (!search(g, c.ctrl, (x) => x.def.name === SHIP, 'deck')) search(g, c.ctrl, (x) => x.def.name === SHIP, 'hell'); },
    fieldActs: (g, p, c) => {
      const ok = (g2: Game, a: Card) => hasKw(g2, a, 'unite') || hasKw(g2, a, 'shield') || a.kick || !!fx(a)?.kickIf?.(g2, a) || !!fx(a)?.deathCry;
      return [act('พี่หน่วง: take an Avatar into our Magic Zone', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'nuang2:' + c.uid)
        && shipOn(g2, p) && P(g2, p).hand.length >= 1 && P(g2, opp(p)).avatars.some((a) => ok(g2, a)),
      (g2) => {
        markOnce(g2, P(g2, p), 'nuang2:' + c.uid);
        discardWorst(g2, p, 1);
        const t = best(P(g2, opp(p)).avatars.filter((a) => ok(g2, a)), (a) => value(g2, a));
        if (t && canRemove(g2, p, t, false)) toMagicZone(g2, t, p);
      })];
    },
    deathCry: (g, c, owner) => {
      const cands = P(g, owner).mz.filter(isA);
      const x = decide(g, opp(owner), () => best(cands, (a) => (a.owner === opp(owner) ? value(g, a) : -value(g, a)))); // the opponent picks
      if (x) toHand(g, x);
    },
  },
  'คุณเก่งพลังช้าง': {
    keep: 3.5,
    jutsu: (g, c) => {
      const x = worst(oppInMz(g, c.ctrl), (a) => value(g, a));
      if (!x || !mayDo(g, c, `จุติ: destroy ${x.def.name} in our Magic Zone for POWER +3`, true)) return; // other-team audit: the cost is optional
      detach(g, x); P(g, x.owner).hell.push(x); log(g, `destroy ${x.def.name} in Magic Zone`);
      c.bonus += 3;
    },
    staticPower: (g, c) => (onZone(g, c.ctrl, 'พี่หน่วง').length ? 1 : 0),
  },
  'ทนายเตะปาก': { keep: 2.5, kickIf: (g, c) => onZone(g, c.ctrl, 'พี่หน่วง').length > 0 },
  'ทนายกิ๊บ': { keep: 2.5, staticPower: (g, c) => (onZone(g, c.ctrl, 'พี่หน่วง').length ? 2 : 0) },

  // ===== จอมเวทย์ =====
  'จอมเวทย์ กาลู': {
    keep: 4,
    // v14: "อัตโนมัติ เทิร์นละครั้ง เมื่อมีการใช้ คาถา": every Magic whose name has "คาถา", used by any player (cast or React)
    onAnyMagic: (g, s, m) => {
      const p = s.ctrl;
      if (!nameHas(m, 'คาถา') || !P(g, p).avatars.includes(s) || !once(g, p, 'kalu:draw')) return;
      markOnce(g, P(g, p), 'kalu:draw'); log(g, `กาลู: ${m.def.name} was used, draw 1`); draw(g, p, 1);
    },
    fieldActs: (g, p, c) => [act('กาลู: discard 1, take คาถา', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'kalu:act')
      && P(g2, p).hand.length >= 1 && [...P(g2, p).deck, ...P(g2, p).hell].some(kata),
    (g2) => {
      markOnce(g2, P(g2, p), 'kalu:act');
      discardWorst(g2, p, 1);
      if (!search(g2, p, kata, 'deck')) search(g2, p, kata, 'hell');
    })],
  },
  'จอมเวทย์ อะปัด': {
    keep: 3.5,
    onOwnMagic: wizardMagic,
    fieldActs: (g, p, c) => {
      const pick = (g2: Game) => {
        const pl = P(g2, p);
        const xs: [Card, number][] = [];
        for (const m of pl.hand) {
          const f = FX[m.def.name];
          if (!kata(m) || m.def.subtype !== 'Normal' || !f) continue;
          for (let o = 0; o < (f.options || 1); o++) if (!f.canCast || f.canCast(g2, p, m, o)) { xs.push([m, o]); break; }
        }
        return xs;
      };
      return [act('อะปัด: cast an extra คาถา', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'apad') && P(g2, p).used.Normal && pick(g2).length > 0,
        (g2) => {
          const pl = P(g2, p); markOnce(g2, pl, 'apad');
          const xs = pick(g2);
          const b = best(xs.map((x) => x[0]), (m) => keepValue(g2, m));
          const ch = xs.find((x) => x[0] === b);
          if (!ch) return;
          pl.used.Normal = false;
          castMagic(g2, p, ch[0], ch[1]);
          pl.used.Normal = true;
        })];
    },
  },
  'จอมเวทย์ เบล่า': {
    keep: 3.5,
    onOwnMagic: wizardMagic,
    jutsu: (g, c) => {
      const p = c.ctrl;
      if (!once(g, p, 'bela') || !P(g, p).avatars.some((a) => a !== c && named(a, 'จอมเวทย์') && a.def.name !== c.def.name)) return;
      const xs: [Card, number][] = [];
      for (const m of P(g, p).hell) {
        const f = FX[m.def.name];
        if (!kata(m) || m.def.subtype !== 'Normal' || !f || !f.resolve) continue;
        for (let o = 0; o < (f.options || 1); o++) if (!f.canCast || f.canCast(g, p, m, o)) { xs.push([m, o]); break; }
      }
      const b = best(xs.map((x) => x[0]), (m) => keepValue(g, m));
      const ch = xs.find((x) => x[0] === b);
      if (!ch) return;
      markOnce(g, P(g, p), 'bela');
      log(g, `เบล่า uses ${ch[0].def.name} from hell`);
      FX[ch[0].def.name].resolve!(g, p, ch[0], ch[1]);
    },
  },
  'อาวุธชีวภาพ เอ็มตัวเต็ง': {
    keep: 6,
    staticPower: (g, c) => { noAttackIf(c, g, true); return 0; },
    endPhase: (g, c) => {
      const p = c.ctrl;
      if (!once(g, p, 'emt:' + c.uid)) return;
      markOnce(g, P(g, p), 'emt:' + c.uid);
      const t = best(P(g, opp(p)).avatars, (a) => value(g, a));
      if (t) destroy(g, t, p);
      if (g.winner === null) hitLife(g, opp(p), null);
    },
  },
  'เดซี่ แห่งสายรุ้ง': {
    keep: 3.5,
    // only in our own End Phase (confirmed by the user, v14)
    endPhase: (g, c) => {
      const p = c.ctrl;
      if (!once(g, p, 'daisy:' + c.uid)) return;
      markOnce(g, P(g, p), 'daisy:' + c.uid);
      fromZoneSummon(g, p, P(g, p).deck, (x) => named(x, 'ผีเสื้อ') && symIs(x, 'สัตว์มหัศจรรย์'));
      shuffle(g, P(g, p).deck);
    },
    aura: (g, s, t) => (t.ctrl === s.ctrl && named(t, 'ผีเสื้อ') && symIs(t, 'สัตว์มหัศจรรย์') ? 1 : 0),
    grant: (g, s, t, kw) => kw === 'shield' && t.ctrl === s.ctrl && named(t, 'ผีเสื้อ') && symIs(t, 'สัตว์มหัศจรรย์'),
  },

  // ===== ตำรวจ =====
  'ตำรวจนอกเครื่องแบบ ไซเฮย์': {
    keep: 3,
    handActs: (g, p, c) => [act('ไซเฮย์: guess the top card', (g2) => inMain(g2, p) && P(g2, p).hand.includes(c) && once(g2, p, 'saihei') && canPlaceAvatar(P(g2, p))
      && P(g2, opp(p)).deck.length > 0,
    (g2) => {
      markOnce(g2, P(g2, p), 'saihei');
      const t = declareType(g2, p);
      const o = P(g2, opp(p)); const top = o.deck[0];
      if (!top) return;
      log(g2, `ไซเฮย์ declares ${t}, top is ${top.def.type}`);
      if (top.def.type === t) { o.deck.shift(); o.hell.push(top); summon(g2, p, c, 'own'); }
      else { detach(g2, c); P(g2, p).hell.push(c); }
    })],
  },
  'ตำรวจไฟแรง เอนโว่': {
    keep: 3.5,
    onAttack: (g, c, target) => {
      if (!target) return;
      const p = c.ctrl, o = P(g, opp(p)); const top = o.deck[0];
      if (!top) return;
      const t = declareType(g, p);
      log(g, `เอนโว่ declares ${t}, top is ${top.def.type}`);
      if (top.def.type !== t) return;
      o.deck.shift(); o.hell.push(top);
      if (o.avatars.includes(target)) destroy(g, target, p);
    },
  },

  // ===== ตั๊กแตน =====
  'ตั๊กแตนหยิน': {
    keep: 4,
    aura: throneAura,
    jutsu: (g, c) => {
      const p = c.ctrl;
      const l = topLife(g, p);
      if (l) l.faceUp = true;
      const up = P(g, p).life.filter((x) => x.faceUp);
      const pickL = best(up.map((x) => x.card), (x) => up.findIndex((y) => y.card === x)); // the player chooses which LIFE to turn face down
      const dn = up.find((x) => x.card === pickL);
      if (dn) lifeDown(g, p, dn); // v14d (logs, honours blockLifeDown)
    },
    // approx: the second ability (use a face-up LIFE card's effect) is not modeled: LIFE cards have no effect in the engine
  },
  'ตั๊กแตนหยาง': {
    keep: 4,
    aura: throneAura,
    // approx: "can only wear แมลง cards" is not enforced
    staticPower: (g, c) => (onZone(g, c.ctrl, 'ตั๊กแตนหยิน').length ? flippedLife(P(g, c.ctrl)) : 0),
    kwIf: (g, c, kw) => (kw === 'tieWin' || kw === 'shield') && critical(P(g, c.ctrl)) && onZone(g, c.ctrl, 'ตั๊กแตนหยิน').length > 0,
  },
  'วาฬทมิฬ ก้า': {
    keep: 3,
    aura: throneAura,
    jutsu: (g, c) => {
      const p = c.ctrl;
      if (P(g, p).avatars.some((a) => a !== c && named(a, 'ตั๊กแตน')) && flippedLife(P(g, p)) >= 2) search(g, p, (x) => named(x, 'ตั๊กแตน'), 'hell');
    },
  },
  'ตั๊กแตนหญิง': {
    keep: 3,
    aura: throneAura,
    jutsu: (g, c) => {
      const p = c.ctrl;
      const l = topLife(g, p);
      if (!l || flippedLife(P(g, p)) > 2 || !P(g, p).deck.some((x) => named(x, 'ตั๊กแตน'))) return;
      l.faceUp = true; log(g, `P${p} flips a LIFE (${flippedLife(P(g, p))}/5)`);
      search(g, p, (x) => named(x, 'ตั๊กแตน'), 'deck');
    },
  },
  'หมอเลิฟ ฟันเหยิน': {
    keep: 4,
    jutsu: (g, c) => {
      const p = c.ctrl, pl = P(g, p);
      const x = best(pl.deck, (y) => keepValue(g, y));
      if (!x) return;
      detach(g, x); pl.hell.push(x); shuffle(g, pl.deck);
      emit(g, { ev: 'reveal', who: p, cards: [{ uid: x.uid, print: x.def.print, name: x.def.name }], s: `หมอเลิฟ shows ${x.def.name} and sends it to Hell` });
      // v14b: locked in Hell (can't leave it in any way; detail-box note) and back to our hand at our 2nd Draw Phase from
      // now, even when หมอเลิฟ has left (engine lockInHell)
      lockInHell(g, x, p, 2, 'หมอเลิฟ ฟันเหยิน');
      log(g, `หมอเลิฟ sends ${x.def.name} to hell`);
    },
  },
  'บัวนิด วานรแห่งสวนสัตว์': {
    keep: 3,
    staticPower: (g, c) => { noAttackIf(c, g, !P(g, c.ctrl).avatars.some((a) => a !== c && isVanara(a))); return 0; },
  },
  'แมรี่ พนักงานต้อนรับ': {
    keep: 3,
    // v14: usable in the End Phase of both players (สั่งใช้: optional, opens the opponent's React window)
    eachEndPhase: (g, c) => {
      const p = c.ctrl;
      if (!P(g, p).avatars.includes(c) || !once(g, p, 'mary:' + c.uid) || !P(g, p).deck.length) return;
      if (!mayDo(g, c, 'roll a die and สอดแนม that many', true)) return;
      markOnce(g, P(g, p), 'mary:' + c.uid);
      abilityWindow(g, p, c, () => peek(g, p, d6(g), (top) => { takeHand(g, p, top, isA); }, 'bottom'));
    },
  },

  // ===== Normal Magic =====
  'หยุด!! นี่ตำรวจ': {
    keep: 4,
    canCast: (g, p, c) => onZone(g, p, 'ตำรวจ').length > 0 && P(g, p).hand.some((x) => x !== c && named(x, 'ตำรวจ')) && oppTargets(g, p, true).length > 0,
    resolve: (g, p) => {
      const t = best(oppTargets(g, p, true), (a) => value(g, a));
      if (t && canRemove(g, p, t, true)) toDeck(g, t, true);
    },
  },
  'เพ้อเจ้อ': {
    keep: 3,
    canCast: (g, p) => [...g.p[0].avatars, ...g.p[1].avatars].some((a) => (a.ctrl === p || magicOk(g, p, a)) && resetGain(g, p, a) >= 2),
    resolve: (g, p) => {
      const t = best([...g.p[0].avatars, ...g.p[1].avatars].filter((a) => a.ctrl === p || magicOk(g, p, a)), (a) => resetGain(g, p, a));
      if (t) resetPower(g, t);
    },
    // with a ตำรวจ on our zone it can be used in the opponent's turn as a React (here: during a fight)
    react: {
      on: ['fight'],
      can: (g, p, c, ev) => ev.actor !== p && onZone(g, p, 'ตำรวจ').length > 0 && !!ev.source && !!ev.target && P(g, ev.actor).avatars.includes(ev.source),
      want: (g, p, c, ev) => power(g, ev.source!) >= power(g, ev.target!) && ev.source!.def.power < power(g, ev.target!),
      resolve: (g, p, c, ev) => { if (ev.source && magicOk(g, p, ev.source) && P(g, ev.source.ctrl).avatars.includes(ev.source)) resetPower(g, ev.source); },
    },
  },
  'ราคาชาติที่คุณขาย': {
    keep: 2.5,
    canCast: (g, p) => P(g, p).deck.some((x) => named(x, 'ทหารหิมะ')),
    resolve: (g, p) => {
      const pl = P(g, p);
      for (const x of worstN(pl.deck.filter((y) => named(y, 'ทหารหิมะ')), 2, (y) => keepValue(g, y), { title: 'ราคาชาติที่คุณขาย: send 2 ทหารหิมะ from your Deck to Hell' })) { detach(g, x); pl.hell.push(x); }
      shuffle(g, pl.deck);
      if (hellAvatars(g, p, (x) => named(x, 'หิมะ')).length >= 10) draw(g, p, 1);
    },
  },
  'คาถา ปลดอาวุสสิวะ': {
    keep: 4,
    canCast: (g, p) => P(g, p).avatars.some(wizard) && oppTargets(g, p, true).length > 0,
    resolve: (g, p, c) => {
      kataUsed(g, p, c);
      const t = best(oppTargets(g, p, true), (a) => value(g, a) + (power(g, a) <= 3 ? 5 : 0));
      if (!t) return;
      boost(t, -3);
      if (power(g, t) === 0) destroy(g, t, p, true);
    },
  },
  'คาถา สัตตูหลีกปาย': {
    keep: 4,
    canCast: (g, p) => P(g, p).avatars.filter(wizard).length >= 2 && oppTargets(g, p, true).some((a) => power(g, a) >= 5),
    resolve: (g, p, c) => {
      kataUsed(g, p, c);
      const t = best(oppTargets(g, p, true).filter((a) => power(g, a) >= 5), (a) => value(g, a));
      if (t && canRemove(g, p, t, true)) toMagicZone(g, t, t.owner);
    },
  },
  'ชะตาไม่มีวันจบลง': {
    keep: 3,
    canCast: (g, p) => critical(P(g, p)) && canPlaceAvatar(P(g, p)) && hellAvatars(g, p, (x) => x.def.name === 'ตั๊กแตนหยิน' || x.def.name === 'ตั๊กแตนหยาง').length > 0,
    resolve: (g, p) => { fromZoneSummon(g, p, P(g, p).hell, (x) => x.def.name === 'ตั๊กแตนหยิน' || x.def.name === 'ตั๊กแตนหยาง'); },
  },
  'พลังแห่งควางสิริมงคง': {
    keep: 1,
    canCast: (g, p) => onZone(g, p, 'เสาซินแสมงคล').length > 0 && P(g, p).hand.length - 1 >= 7 && hellAvatars(g, p, (x) => named(x, 'เสามงคล')).length > 0,
    resolve: (g, p) => {
      if (!discardWorst(g, p, 7)) return;
      const x = best(hellAvatars(g, p, (y) => named(y, 'เสามงคล')), (y) => value(g, y));
      if (x) { detach(g, x); P(g, p).mz.push(x); log(g, `${x.def.name} goes to the Magic Zone`); }
    },
  },
  'เปลี่ยนเมน': {
    keep: 3,
    canCast: (g, p) => onZone(g, p, 'ไอดอล').some((a) => a.mods.some((m) => named(m, 'โอตะ')) && P(g, p).deck.some((x) => isA(x) && named(x, 'ไอดอล') && x.def.name !== a.def.name)),
    resolve: (g, p) => {
      const pl = P(g, p);
      const w = best(onZone(g, p, 'ไอดอล').filter((a) => a.mods.some((m) => named(m, 'โอตะ')) && pl.deck.some((x) => isA(x) && named(x, 'ไอดอล') && x.def.name !== a.def.name)), (a) => -value(g, a));
      if (!w) return;
      const otas = w.mods.filter((m) => named(m, 'โอตะ'));
      for (const m of otas) detach(g, m);
      const nm = w.def.name;
      toDeck(g, w, false);
      const n = fromZoneSummon(g, p, pl.deck, (x) => named(x, 'ไอดอล') && x.def.name !== nm);
      for (const m of otas) { if (n && pl.avatars.includes(n)) attach(g, m, n); else P(g, m.owner).hell.push(m); }
      shuffle(g, pl.deck);
    },
  },
  // กลับบ้านเก่า: skipped (the engine does not record which Avatars were summoned from hell)
  'ลิสต์แผนการ': {
    keep: 3,
    canCast: (g, p) => P(g, p).deck.some((x) => x.def.type === 'Magic' && x.def.name.includes('แผนการ') && x.def.name !== 'ลิสต์แผนการ'),
    resolve: (g, p) => { search(g, p, (x) => x.def.type === 'Magic' && x.def.name.includes('แผนการ') && x.def.name !== 'ลิสต์แผนการ', 'deck'); },
  },
  'แบงค์ Portal': {
    keep: 3,
    canCast: (g, p) => onZone(g, p, 'แบงค์').length > 0 && P(g, p).deck.length > 0,
    resolve: (g, p) => peek(g, p, 5, (top) => {
      const banks = (x: Card) => isA(x) && named(x, 'แบงค์');
      if (!top.some(banks)) return;
      const h = takeHand(g, p, top, banks); // approx: with only one แบงค์ in the 5, it still goes to hand
      const d = worst(top.filter(banks), (x) => keepValue(g, x));
      if (h && d) { top.splice(top.indexOf(d), 1); P(g, p).hell.push(d); }
    }),
  },

  // ===== React Magic =====
  'พันปักษา': {
    keep: 4.5,
    react: {
      on: ['attack'],
      can: (g, p, c, ev) => ev.actor !== p && P(g, p).avatars.some(garuda) && P(g, opp(p)).avatars.length > 0,
      want: (g, p) => {
        const k = worst(P(g, p).avatars.filter(garuda), (a) => value(g, a));
        if (!k) return false;
        const gain = P(g, opp(p)).avatars.map((a) => value(g, a)).sort((a, b) => b - a).slice(0, 2).reduce((s, v) => s + v, 0);
        return gain >= value(g, k) + 3;
      },
      resolve: (g, p) => {
        const k = worst(P(g, p).avatars.filter(garuda), (a) => value(g, a));
        if (!k || !destroy(g, k, p)) return;
        for (const t of pickN(P(g, opp(p)).avatars, 2, (a) => value(g, a), { title: 'destroy 2 opposing Avatars' })) destroy(g, t, p, true);
      },
    },
  },
  'คาถา สตอปปุ': {
    keep: 4,
    react: {
      on: ['attack'],
      can: (g, p, c, ev) => ev.actor !== p && P(g, p).avatars.some(wizard) && !!ev.target && named(ev.target, 'จอมเวท') && ev.target.ctrl === p
        && P(g, p).hell.some(kata),
      want: (g, p, c, ev) => !!ev.source && power(g, ev.source) >= power(g, ev.target!),
      resolve: (g, p, c, ev) => {
        const k = worst(P(g, p).hell.filter(kata), (x) => keepValue(g, x));
        if (!k) return;
        hellToBottom(g, p, k);
        kataUsed(g, p, c);
        ev.cancelled = true;
      },
    },
  },
  'ขอจบรายการแต่เพียงเท่านี้': {
    keep: 3.5,
    react: {
      on: ['destroy'],
      can: (g, p, c, ev) => !!ev.source && ev.source.ctrl === p && named(ev.source, 'พี่หน่วง') && shipOn(g, p),
      want: () => true,
      resolve: (g, p, c, ev) => {
        const s = P(g, p).mz.find((x) => x.def.name === SHIP);
        if (!s || !ev.source) return;
        detach(g, s); P(g, s.owner).hell.push(s);
        toHand(g, ev.source);
        ev.cancelled = true;
      },
    },
  },

  // ===== Modification =====
  'ขนมณี แฟลร์': {
    keep: 3,
    canCast: (g, p) => P(g, p).avatars.some((a) => garuda(a) && symIs(a, 'สัตว์มหัศจรรย์')),
    modTarget: (g, p) => best(P(g, p).avatars.filter((a) => garuda(a) && symIs(a, 'สัตว์มหัศจรรย์')), (a) => value(g, a)),
    // v14: whenever the wearer would leave the field in any way (destroyed in a fight or by an effect, to hand, Hell,
    // exile or Deck), by anyone's card (ours too), this may go to Hell instead (popup). Costs are never stopped.
    leaveGuard: (g, self, t, info) => (t.uid === self.wearer && !info.cost
      ? { label: `send ${self.def.name} to Hell instead of ${t.def.name} leaving`, want: true, run: () => toHell(g, self, { cost: true }) } : null),
  },
  'ไม้กายสิทธิ์': {
    keep: 3,
    canCast: (g, p) => P(g, p).avatars.some(wizard),
    modTarget: (g, p) => best(P(g, p).avatars.filter(wizard), (a) => value(g, a)),
    onAttach: (g, m) => { m.f.kata = 0; },
    // v14: +1 (permanent while worn) for every Magic named "คาถา" used by any player
    onAnyMagic: (g, m, magic) => { if (m.wearer >= 0 && nameHas(magic, 'คาถา')) { m.f.kata = (m.f.kata || 0) + 1; log(g, `ไม้กายสิทธิ์: +1 (${magic.def.name})`); } },
    modPower: (g, m) => m.f.kata || 0,
  },
  'เก้าอี้ เฟิร์สคลาส': {
    keep: 1.5,
    // v14: the wearer gets the name "Super Air" everywhere (view.ts namesFor: rules and the detail box)
    namesFor: (g: Game, self: Card, t: Card) => (t.mods.includes(self) ? ['Super Air'] : null),
    canCast: (g, p) => P(g, p).avatars.some((a) => !named(a, 'Super Air')) && [...P(g, p).hand, ...P(g, p).avatars].some((x) => x.def.name.includes('Super Air')),
    modTarget: (g, p) => best(P(g, p).avatars.filter((a) => !named(a, 'Super Air')), (a) => value(g, a)),
  },

  // ===== Land =====
  'อาคารผู้โดยสารชั้นต่ำ': {
    keep: 2,
    canCast: (g, p) => (!g.land || g.land.owner !== p) && onZone(g, p, 'เครื่องบิน Super Air').length > 0,
    fieldActs: (g, p, c) => [act('อาคารผู้โดยสาร: discard 1, call ผู้โดยสาร Super Air', (g2) => inMain(g2, p) && isLandOn(g2, c) && once(g2, p, 'terminal')
      && onZone(g2, p, 'เครื่องบิน Super Air').length > 0 && P(g2, p).hand.length >= 1 && canPlaceAvatar(P(g2, p))
      && [...P(g2, p).hell, ...P(g2, p).deck].some((x) => x.def.name === 'ผู้โดยสาร Super Air'),
    (g2) => {
      const pl = P(g2, p); markOnce(g2, pl, 'terminal');
      discardWorst(g2, p, 1);
      // other-team audit: "จากนรกหรือ Deck": the player chooses when both have one
      const pas = (x: Card) => x.def.name === 'ผู้โดยสาร Super Air';
      if (pl.hell.some(pas) && pl.deck.some(pas) && chooseMode(g2, c, ['from Hell', 'from Deck'], 0) === 1) { fromZoneSummon(g2, p, pl.deck, pas); shuffle(g2, pl.deck); return; }
      if (!fromZoneSummon(g2, p, pl.hell, (x) => x.def.name === 'ผู้โดยสาร Super Air')) {
        fromZoneSummon(g2, p, pl.deck, (x) => x.def.name === 'ผู้โดยสาร Super Air');
        shuffle(g2, pl.deck);
      }
    })],
  },
  'หมู่บ้านเห็ด': {
    keep: 2,
    canCast: (g, p) => (!g.land || g.land.owner !== p)
      && P(g, opp(p)).avatars.reduce((s, a) => s + power(g, a), 0) > P(g, p).avatars.reduce((s, a) => s + power(g, a), 0),
    landPower: (g, l, a) => { const r = powerNoLand(g, a); return Math.floor(r / 2) - r; },
  },
  'ดินแดนหิมะสีเทา': {
    keep: 2.5,
    canCast: (g, p) => (!g.land || g.land.owner !== p) && P(g, p).avatars.some((a) => named(a, 'หิมะ') && symIs(a, 'ต่างชาติ')),
    fieldActs: (g, p, c) => [act('ดินแดนหิมะ: +1 per 2 ทหารหิมะ in hell', (g2) => inMain(g2, p) && isLandOn(g2, c) && once(g2, p, 'greysnow')
      && P(g2, p).avatars.some((a) => named(a, 'หิมะ') && symIs(a, 'ต่างชาติ')) && hellAvatars(g2, p, (x) => named(x, 'ทหารหิมะ')).length >= 2,
    (g2) => {
      markOnce(g2, P(g2, p), 'greysnow');
      const t = best(P(g2, p).avatars.filter((a) => named(a, 'หิมะ') && symIs(a, 'ต่างชาติ')), (a) => power(g2, a) + (a.asleep ? 0 : 3));
      if (t) boost(t, Math.floor(hellAvatars(g2, p, (x) => named(x, 'ทหารหิมะ')).length / 2));
    })],
  },
  'สถานีตำรวจ': {
    keep: 2,
    // "Avatar ตำรวจ ได้รับความสามารถ ตาม Symbol": คน POWER +2, หุ่นยนต์ สามัคคี, ผี โล่มนุษย์ (v13: Lands grant keywords)
    canCast: (g, p) => (!g.land || g.land.owner !== p) && onZone(g, p, 'ตำรวจ').length > 0,
    landPower: (g, l, a) => (named(a, 'ตำรวจ') && symIs(a, 'คน') ? 2 : 0),
    grant: (g, s, t, kw) => named(t, 'ตำรวจ') && ((kw === 'unite' && symIs(t, 'หุ่นยนต์')) || (kw === 'shield' && symIs(t, 'ผี'))),
  },
  'งานเลี้ยงโดนใจ หัวใจโดนเธอ': {
    keep: 2,
    canCast: (g, p) => (!g.land || g.land.owner !== p)
      && P(g, p).avatars.filter((a) => DONJAI.has(a.def.name)).length > P(g, opp(p)).avatars.filter((a) => DONJAI.has(a.def.name)).length,
    landPower: (g, l, a) => (DONJAI.has(a.def.name) ? 1 : 0),
  },

  // ===== Construct =====
  'เสาธง': {
    keep: 2.5,
    grant: (g, s, t, kw) => kw === 'tieWin' && t.ctrl === s.ctrl && P(g, s.ctrl).mz.includes(s),
  },
  'ยานรายการ เถียงทันหน่วง': {
    keep: 3,
    costOf: (g, p, c) => (onZone(g, p, 'พี่หน่วง').length ? 0 : c.def.cost),
    endPhase: (g, c) => { const p = c.ctrl; if (P(g, p).mz.includes(c) && onZone(g, p, 'พี่หน่วง').length && oppInMz(g, p).length) draw(g, p, 1); },
    // the chosen Avatar gains โล่มนุษย์ until the end of the opponent's next turn (v13: temporary grant, stays if the Construct leaves)
    // v14 answer: "เลือก Avatar 1 ใบ บน Avatar Zone" = an Avatar on either player's Avatar Zone (the bot picks its own)
    fieldActs: (g, p, c) => [act('ยานรายการ: give โล่มนุษย์', (g2) => inMain(g2, p) && P(g2, p).mz.includes(c) && once(g2, p, 'ship:' + c.uid)
      && g2.p.some((q) => q.avatars.some((a) => !hasKw(g2, a, 'shield'))),
    (g2) => {
      markOnce(g2, P(g2, p), 'ship:' + c.uid);
      const t = best(g2.p.flatMap((q) => q.avatars).filter((a) => !hasKw(g2, a, 'shield')), (a) => (a.ctrl === p ? power(g2, a) : -10 - power(g2, a)));
      if (t) grantKw(g2, t, 'shield', g2.turn + 1);
    })],
  },
  [THRONE]: {
    keep: 3,
    fieldActs: (g, p, c) => [act('บัลลังก์: equip to a ตั๊กแตน', (g2) => inMain(g2, p) && P(g2, p).mz.includes(c) && once(g2, p, 'throne')
      && P(g2, p).avatars.some(grasshopper),
    (g2) => {
      markOnce(g2, P(g2, p), 'throne');
      const w = best(P(g2, p).avatars.filter(grasshopper), (a) => (a.asleep ? 3 : 0) + (a.def.name === 'ตั๊กแตนหยิน' ? 2 : 0) + value(g2, a) * 0.1);
      if (w) attach(g2, c, w);
    })],
    // approx: the +1 to other ตั๊กแตน is given by the wearer's own aura (only this file's ตั๊กแตน cards carry it)
    modPower: (g, m, w) => { noAttackIf(w, g, true); return 2; },
  },
};

Object.assign(FX, NEW);

// =====================================================================================================================
// v14 group C: the user's rulings (v14/rulings.json, owner C). Entries first coded in earlier files are extended here
// ({ ...FX[name], ...changes }: this file loads after cards.ts, cards2.ts and g1..g4).
// =====================================================================================================================
const onFieldAv = (g: Game, c: Card) => g.p.some((q) => q.avatars.includes(c));

// ---- Wearing rules (รีวิวแมน BT06-005, ชาช่าจัง BT07-022, รถถังเฟืองเหล็ก BT08-043) ----
// Every Modification entry (one with modTarget) is wrapped once: Avatars that can't wear that card are hidden from its
// canCast / modTarget, and รีวิวแมน may wear any Modification of its controller (ignoring the card's wear condition).
const REVIEW = 'รีวิวแมน';
/** May Avatar w wear card m? (w's own "can only wear ..." text) */
export function wearOk(g: Game, w: Card, m: Card): boolean {
  if (w.def.name === 'ชาช่าจัง ไอดอลคนเก่ง' && !contOff(g, w)) return nameHas(m, 'โอตะ');
  if (w.def.name === 'รถถังเฟืองเหล็ก' && !contOff(g, w)) return nameHas(m, 'Tank Ranger');
  return true;
}
const reviewOn = (g: Game, p: PID, m: Card) => P(g, p).avatars.find((a) => a.def.name === REVIEW && !silenced(g, a) && wearOk(g, a, m)) || null;
function hideFor<T>(g: Game, p: PID, m: Card, fn: () => T): T {
  const pl = P(g, p);
  const hid = pl.avatars.filter((a) => !wearOk(g, a, m));
  if (!hid.length) return fn();
  const keep = pl.avatars;
  pl.avatars = keep.filter((a) => !hid.includes(a));
  try { return fn(); } finally {
    const now = pl.avatars;
    pl.avatars = keep.filter((a) => hid.includes(a) || now.includes(a)).concat(now.filter((a) => !keep.includes(a)));
  }
}
const WEAR_WRAPPED = new WeakSet<object>();
let wearCount = -1;
function wrapWear(f: any) {
  if (!f || typeof f !== 'object' || typeof f.modTarget !== 'function' || WEAR_WRAPPED.has(f)) return;
  WEAR_WRAPPED.add(f);
  const oc = f.canCast, ot = f.modTarget;
  const base = (self: any, g: Game, p: PID, c: Card, o: number) => hideFor(g, p, c, () => (oc ? !!oc.call(self, g, p, c, o) : true));
  f.canCast = function (g: Game, p: PID, c: Card, o: number) { return base(this, g, p, c, o) || !!reviewOn(g, p, c); };
  f.modTarget = function (g: Game, p: PID, c: Card) {
    const rv = reviewOn(g, p, c);
    if (rv) {
      const can0 = quiet(() => base(this, g, p, c, 0));
      if (!can0) return rv;
      if (mayDo(g, rv, `wear ${c.def.name} on รีวิวแมน (it ignores wear conditions)`, false)) return rv;
    }
    const w = hideFor(g, p, c, () => ot.call(this, g, p, c));
    return w && wearOk(g, w, c) ? w : null;
  };
}
/** Wrap the Modification entries added since the last call (cheap when nothing changed). */
export function ensureWear() {
  const keys = Object.keys(FX);
  if (keys.length === wearCount) return;
  wearCount = keys.length;
  for (const k of keys) wrapWear(FX[k]);
}
FX[REVIEW] = { ...FX[REVIEW], keep: 2.5, staticPower: () => { ensureWear(); return 0; } };

// ---- 40ดีกรีแมน BT02-023: when it attacks, the opponent chooses the attack target (LIFE only when that is the only one) ----
// The choice is made just before the attack's React window (FX.blockReact sees the 'attack' event first).
FX['40ดีกรีแมน'] = {
  ...FX['40ดีกรีแมน'], keep: 4,
  blockReact: (g, self, ev) => {
    if (ev.kind !== 'attack' || ev.source !== self || (ev as any).t40 || ev.cancelled) return null;
    (ev as any).t40 = 1;
    const p = self.ctrl, o = opp(p);
    const ts = legalTargets(g, p, self);
    if (ts.length < 2) return null;
    const pa = power(g, self);
    const score = (x: Card | null) => (x === null ? -4 : power(g, x) > pa ? 10 + power(g, x) : power(g, x) === pa ? 1 - value(g, x) * 0.1 : -value(g, x));
    let bi = 0; ts.forEach((x, i) => { if (score(x) > score(ts[bi])) bi = i; });
    const labels = ts.map((x) => (x ? `${x.def.name} (POWER ${power(g, x)})` : 'LIFE'));
    const i = decide(g, o, () => askChoose(g, `40ดีกรีแมน attacks: you choose its target`, labels, bi));
    const t = ts[i] ?? ts[bi];
    if (t !== ev.target) { log(g, `40ดีกรีแมน: P${o} chooses the target: ${t ? t.def.name : 'LIFE'}`); ev.target = t; }
    return null;
  },
};

// ---- เจนนี่ อย่าบู้บี้เลขา BT05-012: while on the Avatar Zone nobody can summon Avatars from Hell (every summon path) ----
FX['เจนนี่ อย่าบู้บี้เลขา'] = {
  ...FX['เจนนี่ อย่าบู้บี้เลขา'], keep: 3,
  blockSummon: (g, self, p, c) => P(g, self.ctrl).avatars.includes(self) && P(g, c.owner).hell.includes(c) && !c.f.viaScout,
};

// ---- เครื่องบิน Super Air BT05-054: only if no Avatar but "Super Air" ones was summoned this turn; afterwards only
// "Super Air" Avatars can be summoned until the end of the turn ----
RULES['g5:SuperAir'] = { label: 'เครื่องบิน Super Air: only "Super Air" Avatars can be summoned this turn', summon: (g, r, c) => nameHas(c, 'Super Air') };
{
  const PLANE = 'เครื่องบิน Super Air', old = FX[PLANE];
  if (old) FX[PLANE] = {
    ...old,
    canCast: (g, p, c, o) => canPlaceAvatar(P(g, p)) && turnLog(g).summons[p].every((n) => n.includes('Super Air')),
    resolve: (g, p, c, o) => { old.resolve?.(g, p, c, o); addRule(g, { p, key: 'g5:SuperAir', until: g.turn }); },
  };
}

// ---- อนันต์ ราชาแห่งนาค BT06-004: the other นาค {สัตว์มหัศจรรย์} on our zone keep this card's POWER for the rest of the turn ----
const naga5 = (c: Card) => isA(c) && nameHas(c, 'นาค') && symIs(c, 'สัตว์มหัศจรรย์');
let ANAN_BUSY = 0;
FX['อนันต์ ราชาแห่งนาค'] = {
  ...FX['อนันต์ ราชาแห่งนาค'], keep: 6,
  fieldActs: (g, p, c) => [act('อนันต์: other นาค get this POWER until end of turn', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'anan')
    && P(g2, p).avatars.some((a) => a !== c && naga5(a) && power(g2, a) !== power(g2, c)),
  (g2) => { markOnce(g2, P(g2, p), 'anan'); c.f.anan = g2.turn; log(g2, `อนันต์: other นาค have POWER ${power(g2, c)} until end of turn`); })],
  // approx: the equal POWER lasts while อนันต์ stays on the field this turn (aura: its POWER minus the other's own)
  aura: (g, s, t) => {
    if (ANAN_BUSY || s.f.anan !== g.turn || t === s || t.ctrl !== s.ctrl || !P(g, s.ctrl).avatars.includes(s) || !P(g, s.ctrl).avatars.includes(t) || !naga5(t)) return 0;
    ANAN_BUSY++;
    try { return power(g, s) - power(g, t); } finally { ANAN_BUSY--; }
  },
  getActive: (g: Game, self: Card) => self.f.anan === g.turn && 'นาคอื่นมี POWER เท่าการ์ดนี้จนจบเทิร์น',
  // "ฝ่ายตรงข้าม หงาย LIFE Card 1 ใบ": a flip by an effect (never a LIFE hit that could end the game)
  onKill: (g, c) => { if (g.active === c.ctrl) flipLifeCard(g, opp(c.ctrl)); },
} as Fx;

// ---- แมวดำ สมาชิกลัทธิแห่หัว BT09-026: summoned by พี่โปจิ (g7 sets f.byPoji) -> its ability becomes "exile the bottom card
// of the opponent's Hell"; a GET badge shows it ----
FX['แมวดำ สมาชิกลัทธิแห่หัว'] = {
  ...FX['แมวดำ สมาชิกลัทธิแห่หัว'], keep: 1,
  fieldActs: (g, p, c) => [c.f.byPoji
    ? act('แมวดำ: exile the bottom card of the opponent Hell', (g2) => inMain(g2, p) && once(g2, p, 'cat:' + c.uid) && P(g2, opp(p)).hell.length > 0,
      (g2) => { markOnce(g2, P(g2, p), 'cat:' + c.uid); const x = P(g2, opp(p)).hell[0]; if (x) { detach(g2, x); P(g2, x.owner).exile.push(x); log(g2, `แมวดำ exiles ${x.def.name}`); } })
    : act('แมวดำ: opponent mills 1', (g2) => inMain(g2, p) && once(g2, p, 'cat:' + c.uid), (g2) => { markOnce(g2, P(g2, p), 'cat:' + c.uid); mill(g2, opp(p), 1); })],
  getActive: (g: Game, self: Card) => !!self.f.byPoji && 'เทิร์นละครั้ง สั่งใช้ : เนรเทศ การ์ดใบล่างสุดของนรกฝ่ายตรงข้าม (อัญเชิญโดย พี่โปจิ)',
} as Fx;

// ---- แอชลีย์ BT11-029: the Avatar it summons shows a GET badge with its new ability (End Phase: to Hell) ----
{
  const old = FX['แอชลีย์'];
  if (old && old.fieldActs) FX['แอชลีย์'] = {
    ...old,
    fieldActs: (g, p, c) => old.fieldActs!(g, p, c).map((a) => act(a.label, a.can, (g2) => {
      const before = new Set(P(g2, p).avatars);
      a.run(g2);
      for (const x of P(g2, p).avatars) if (!before.has(x) && x.f.endHell === g2.turn) grantGet(g2, x, 'อัตโนมัติ ในช่วง End Phase : ส่ง Avatar ใบนี้ลงนรก (แอชลีย์)', g2.turn);
    })),
  };
}

// ---- เสาซินแสมงคล BT06-033 ----
// "ต่อเนื่อง Avatar เสามงคล ฝ่ายเราสามารถใช้ความสามารถจาก Magic Zone ได้": every เสามงคล in our Magic Zone uses its abilities
// only while a เสาซินแสมงคล is on our Avatar Zone (the engine runs Draw / End Phase and สั่งใช้ hooks of Magic Zone cards).
const SINSAE = 'เสาซินแสมงคล';
const sinsaeOn = (g: Game, p: PID) => P(g, p).avatars.some((a) => a.def.name === SINSAE && !contOff(g, a));
const maoOk = (g: Game, c: Card) => !P(g, c.ctrl).mz.includes(c) || sinsaeOn(g, c.ctrl);
for (const nm of Object.keys(FX)) {
  if (!nm.startsWith('เสามงคล')) continue;
  const f: any = FX[nm], out: any = { ...f };
  for (const k of ['drawPhase', 'endPhase', 'startMain']) if (typeof f[k] === 'function') out[k] = (g: Game, c: Card) => { if (maoOk(g, c)) f[k](g, c); };
  if (typeof f.fieldActs === 'function') out.fieldActs = (g: Game, p: PID, c: Card) => (maoOk(g, c) ? f.fieldActs(g, p, c) : []);
  FX[nm] = out;
}
{
  const old = FX[SINSAE];
  FX[SINSAE] = {
    ...old, preventLeave: undefined,
    // "เมื่อ Avatar ใบนี้ จะออกจากสนาม: สามารถส่ง เสามงคล ใบอื่นในสนามเรา 1 ใบ แทน" (any way of leaving, anyone's card)
    leaveGuard: (g, self, t, info) => {
      if (t !== self || info.cost) return null;
      const pl = P(g, self.ctrl);
      const xs = [...pl.avatars, ...pl.mz].filter((x) => x !== self && isA(x) && nameHas(x, 'เสามงคล'));
      if (!xs.length) return null;
      return { label: 'send another เสามงคล to Hell instead', want: true, run: () => {
        const o = worst(xs.filter((x) => findCard(g, x.uid)), (x) => value(g, x));
        if (!o) return false;
        if (pl.mz.includes(o)) { detach(g, o); P(g, o.owner).hell.push(o); } else toHell(g, o, { cost: true });
        log(g, `${o.def.name} leaves instead of ${SINSAE}`);
        return true;
      } };
    },
  };
}

// ---- ลาพิเน่ โพลีกอน BT09-030 (cards2): สั่งใช้ from Hell, after a card was discarded from our hand by our card's ability
// (v14b FX.onDiscard, once that ability finished): popup; exile this + ธรณีสูบ 3 (cost): draw 1; a milled "โพลิกอน" card
// may go to hand, and if it is ลูเซเน่ โพลิกอน it may be summoned instead ----
const POLY = /โพล[ิี]กอน/;
FX['ลาพิเน่ โพลีกอน'] = {
  ...FX['ลาพิเน่ โพลีกอน'], keep: 2,
  onDiscard: (g, self, cards, by, src) => {
    const p = self.owner, pl = P(g, p);
    if (!pl.hell.includes(self) || hellLocked(self) || by !== p || !cards.length || cards[0].owner !== p || !pl.deck.length || g.winner !== null) return;
    if (!mayDo(g, self, 'exile it and ธรณีสูบ 3: draw 1 (+ a โพลิกอน from the milled cards)', pl.deck.length > 8)) return;
    detach(g, self); pl.exile.push(self);
    const milled = mill(g, p, 3);
    draw(g, p, 1);
    const polys = milled.filter((x) => pl.hell.includes(x) && POLY.test(x.def.name));
    const x = best(polys, (y) => keepValue(g, y) + (isA(y) ? 1 : 0));
    if (!x) return;
    if (x.def.name.startsWith('ลูเซเน่') && isA(x) && canPlaceAvatar(pl, false, x) && mayDo(g, self, `summon ${x.def.name} instead of taking it to hand`, true) && summon(g, p, x, 'effect')) return;
    addToHand(g, x, p, { from: 'hell' });
  },
} as Fx;

// other-team audit Q9 (user: a cancelled Magic keeps its text costs paid): the "cost :" part is paid before the React window
costFirst('พลังแห่งควางสิริมงคง', (g, p) => discardWorst(g, p, 7), (g, p) => {
  const x = best(hellAvatars(g, p, (y) => named(y, 'เสามงคล')), (y) => value(g, y));
  if (x) { detach(g, x); P(g, p).mz.push(x); log(g, `${x.def.name} goes to the Magic Zone`); }
});

// other-team audit Q21 (user: add the effect printed on BT07-016): "เมื่อ Avatar ใบนี้ถูกใช้เป็นค่า Cost ของความสามารถ การ์ด
// {symbol สัตว์มหัศจรรย์} : นำ "ขนมณี แฟลร์" จาก Deck เรา 1 ใบ ขึ้นมือ จากนั้นสับ Deck". Used as a cost = discarded from hand by
// an ability of our {สัตว์มหัศจรรย์} card (ครุฑสัจจะ's จุติ, คราเค่น ...) or sacrificed / sent from the field as its cost.
{
  const FLARE = 'ขนมณี แฟลร์';
  const wonder = (s: Card | null | undefined, self: Card) => !!s && s !== self && s.ctrl === self.owner && symIs(s, 'สัตว์มหัศจรรย์');
  const fetchFlare = (g: Game, p: PID) => { if (P(g, p).deck.some((x) => x.def.name === FLARE)) search(g, p, (x) => x.def.name === FLARE, 'deck'); };
  FX['ครุฑปรเมศวร เจ้าสมบัติ'] = {
    ...(FX['ครุฑปรเมศวร เจ้าสมบัติ'] || {}),
    keep: 2,
    onDiscard: (g, self, cards, by, src) => { if (cards.includes(self) && by === self.owner && wonder(src, self) && P(g, self.owner).hell.includes(self)) fetchFlare(g, self.owner); },
    afterLeave: (g, self, info) => { if (info.cost && wonder(info.src, self)) fetchFlare(g, self.owner); },
  } as Fx;
}
