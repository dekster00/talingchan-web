// Card effects for BT01, BT02, BT03 (cards not coded in cards.ts / cards2.ts).
// Lines marked "approx" simplify part of the printed text (see fx/reports/g2.md).
import type { Card, Game, PID } from '../types.ts';
import type { Fx, HandAct } from '../cards.ts';
import { FX, value, best, worst, pickN, worstN, mayDo, chooseMode, oppChoice, oppTargets, removeOpp, sacrifice, search, inMain, magicOk } from '../cards.ts';
import { costFirst } from '../cards.ts'; // other-team audit Q9
import {
  P, opp, power, draw, destroy, toHell, discard, detach, summon, shuffle, mill,
  canPlaceAvatar, flippedLife, onceUsed, markOnce, keepValue, log, findCard, fx, rand, silenced, choosePayment,
  symIs, symAny, colorIs, scoutDeck, putBottom, silenceFull, summonExact, colorsEn, arrangeTopBottom, decide, humanDeciding
} from '../engine.ts';
import { canChangeCtrl, takeControl, grantKw, landIs as landOn, isLandOn, placeLand, magicImmune, currentSource, lands, useShield, hasKw } from '../engine.ts';
import { attach as attachCard, canWear, lifeDown } from '../engine.ts'; // v14d
import { RULES, addRule, withSource, currentFight, toHand, toDeck, fieldZone, castAllowed, isAvatarDef, nameHas, costOf } from '../engine.ts';
import { setSymbols, addNote } from '../view.ts';
import { grantGet as grantGetB } from '../view.ts'; // cards-B (แดรกคูลา)

// ---------- helpers (local copies of the cards2.ts ones, which are not exported) ----------
const isA = (c: Card) => c.def.type === 'Avatar' || c.def.type === 'Token';
function named(c: Card, key: string) {
  if (c.def.aka && c.def.aka.some((a) => a.includes(key))) return true;
  if (c.def.name.includes(key)) return true;
  const f = FX[c.def.name];
  return !!(f && f.alias && f.alias.some((a) => a.includes(key)));
}
const onZone = (g: Game, p: PID, key: string) => P(g, p).avatars.filter((a) => named(a, key));
const hellAvatars = (g: Game, p: PID, pred: (c: Card) => boolean = () => true) => P(g, p).hell.filter((c) => isA(c) && pred(c));
const once = (g: Game, p: PID, key: string) => !onceUsed(g, P(g, p), key);
function act(label: string, can: (g: Game) => boolean, run: (g: Game) => void): HandAct { return { label, can, run }; }
function boost(c: Card, n: number) { c.temp.push({ power: n, until: 'turn' }); }
// Look at the top n cards; pick() takes from the list; the rest go to the bottom or are shuffled back.
// สอดแนม / look at the top n: engine scoutDeck() reveals them, lets the human pick and order the rest
function peek(g: Game, p: PID, n: number, pick: (cs: Card[]) => void, rest: 'bottom' | 'shuffle' | 'hell' | 'top' | 'either' = 'bottom') {
  scoutDeck(g, p, n, pick, rest);
}
function takeHand(g: Game, p: PID, list: Card[], pred: (c: Card) => boolean) {
  const c = best(list.filter(pred), (x) => keepValue(g, x) + x.def.power * 0.3);
  if (c) { list.splice(list.indexOf(c), 1); P(g, p).hand.push(c); }
  return c;
}
function fromZoneSummon(g: Game, p: PID, zone: Card[], pred: (c: Card) => boolean, how: 'jutsu' | 'effect' = 'effect') {
  const c = best(zone.filter((x) => isA(x) && pred(x)), (x) => value(g, x));
  if (c && canPlaceAvatar(P(g, p)) && summon(g, p, c, how)) return c;
  return null;
}
function attach(g: Game, c: Card, w: Card) {
  if (!canChangeCtrl(g, c, w.ctrl)) { log(g, `${c.def.name}: its control can't be changed (รูปประจำบ้าน)`); return; }
  if (!canWear(g, c, w)) { log(g, `${c.def.name} can't be attached to ${w.def.name}`); if (!findCard(g, c.uid)) P(g, c.owner).hell.push(c); return; } // v14d: canWear
  detach(g, c);
  c.asleep = false; c.temp = []; c.wearer = w.uid; c.ctrl = w.ctrl;
  attachCard(g, c, w, false); // v14d: central attach (canWear checked above; onAttach stays with the callers)
}
function steal(g: Game, p: PID, t: Card, sleep = false) {
  if (t.mods.some((m) => (FX[m.def.name] as any)?.noSteal)) return false;
  if (!canPlaceAvatar(P(g, p))) return false;
  if (!takeControl(g, t, p)) return false; if (sleep) t.asleep = true;
  log(g, `P${p} takes control of ${t.def.name}`);
  return true;
}
function discardWorst(g: Game, p: PID, n: number, except: Card[] = []) {
  for (let i = 0; i < n; i++) {
    const d = worst(P(g, p).hand.filter((x) => !except.includes(x)), (x) => keepValue(g, x));
    if (!d) return false;
    discard(g, p, d);
  }
  return true;
}
// Put a card from the field at the bottom of its owner's Deck (not "destroy").
function toDeckBottom(g: Game, c: Card) {
  toHell(g, c);
  const pl = P(g, c.owner); const i = pl.hell.indexOf(c);
  if (i >= 0) { pl.hell.splice(i, 1); pl.deck.push(c); }
}
// Flip p's top face-down LIFE face up (an effect, not an attack: never loses the game by itself).
function flipUp(g: Game, p: PID) {
  const l = P(g, p).life.find((x) => !x.faceUp);
  if (l) { l.faceUp = true; log(g, `P${p} LIFE flipped by effect (${flippedLife(P(g, p))}/5)`); }
}
// Turn one of p's face-up LIFE face down (the top one, or a random one).
function flipDown(g: Game, p: PID, random = false) {
  const up = P(g, p).life.filter((x) => x.faceUp);
  if (!up.length) return;
  const l = random ? up[Math.floor(rand(g) * up.length)] : up[up.length - 1];
  lifeDown(g, p, l); // v14d (logs, honours blockLifeDown)
}
const coin = (g: Game) => rand(g) < 0.5;
// Magic cards on the field: attached Modification Magic, the Land, persistent Magic in a Magic Zone.
function fieldMagic(g: Game): Card[] {
  const out: Card[] = [];
  for (const q of g.p) for (const a of q.avatars) out.push(...a.mods.filter((m) => m.def.type === 'Magic'));
  if (g.land) out.push(g.land);
  for (const q of g.p) out.push(...q.mz.filter((m) => m.def.type === 'Magic'));
  return out;
}
// How good removing Magic m is for player p (positive = good for p).
function magicHarm(g: Game, p: PID, m: Card): number {
  const v = keepValue(g, m);
  if (m.wearer >= 0) {
    const w = findCard(g, m.wearer);
    const f = fx(m);
    const pw = w && f && f.modPower ? f.modPower(g, m, w) : 0;
    const helpsWearer = pw > 0 || (pw === 0 && !(f && f.zeroKills) && m.owner === (w ? w.ctrl : m.owner));
    const wearerMine = !!w && w.ctrl === p;
    return (wearerMine === helpsWearer ? -1 : 1) * (v + Math.abs(pw));
  }
  return (m.owner === p ? -1 : 1) * v;
}
function magicToHell(g: Game, m: Card) {
  const w = m.wearer >= 0 ? findCard(g, m.wearer) : null;
  detach(g, m); m.wearer = -1;
  P(g, m.owner).hell.push(m);
  log(g, `destroy Magic ${m.def.name}`);
  const f = FX[m.def.name] as any;
  if (f && f.g2FallHell) f.g2FallHell(g, m, w);
}
// Destroy one Magic on the field, chosen by p. Mandatory unless `optional`.
function destroyMagic(g: Game, p: PID, pred: (m: Card) => boolean = () => true, optional = false) {
  const list = fieldMagic(g).filter(pred);
  const m = best(list, (x) => magicHarm(g, p, x));
  if (!m || (optional && magicHarm(g, p, m) <= 0)) return false;
  magicToHell(g, m);
  return true;
}
// Cost of an Avatar on the field, including the cost changes from this group's cards.
function fieldCost(g: Game, a: Card) {
  // v14: costOf includes every costMod (ขวานไม้เน่าๆเหม็นๆ, ทหารอาณาจักรของแพง, other sets' cards)
  const v = costOf(g, a.ctrl, a) + (a.f.costUp || 0);
  return Math.max(0, v);
}
const isBug = (c: Card) => symIs(c, 'แมลง') || c.def.name === 'ตั๊กแตนพันธ์ุ X';
// "Can't attack" restriction, refreshed whenever power is computed (stateCheck runs at the start of every Main
// Phase and after every action and attack).
function noAttackIf(g: Game, c: Card, cond: boolean, key: string) {
  if (cond) { c.f.noAttack = g.turn; c.f[key] = g.turn; } else if (c.f[key] === g.turn) { c.f.noAttack = 0; c.f[key] = 0; }
}
const protectPret = (g: Game, c: Card, by: PID | null) => by !== c.ctrl && (c.f.wanchai === g.turn || (c.f.saveWorld === g.turn && g.phase !== 'Battle'));
const lifeFlipOnHell = { g2FallHell: (g: Game, m: Card) => flipUp(g, m.owner), onWearerLeave: (g: Game, m: Card) => { flipUp(g, m.owner); return false; } };
// Magic that stays in the Magic Zone for the turn it is cast (its aura runs), then goes to hell at that End Phase.
const saveWorldOn = (g: Game, s: Card, t: Card) => liveTurnMagic(g, s) && t.ctrl === s.ctrl && P(g, t.ctrl).avatars.includes(t) && symIs(t, 'เปรต');
function turnMagic(extra: Fx): Fx {
  return {
    stayMz: true,
    ...extra,
    endPhase: (g, c) => {
      const pl = P(g, c.ctrl);
      if (!pl.mz.includes(c)) return;
      for (const a of pl.avatars) if (a.f.g2Shield === c.uid) { a.f.noShield = 0; a.f.g2Shield = 0; }
      detach(g, c); pl.hell.push(c);
    },
  };
}
const liveTurnMagic = (g: Game, s: Card) => P(g, s.ctrl).mz.includes(s) && s.f.turn === g.turn;
// attacker att currently wins or ties against def, and would lose after def gets `delta` relative to it
function wantWin(g: Game, att: Card, def: Card, delta: number) {
  const pa = power(g, att), pd = power(g, def);
  return pa >= pd && pa + delta < pd;
}
let yaaGuard = false;
// เขาไกรลาสเอียง: once per attack declaration (g.stats.attacks counts declarations), the attacker's controller mills 2
function kailashMill(g: Game, l: Card, att: Card) {
  if (l.f.kAt === g.stats.attacks) return;
  l.f.kAt = g.stats.attacks;
  log(g, `เขาไกรลาสเอียง: P${att.ctrl} declared an attack and mills 2`);
  withSource(l, () => mill(g, att.ctrl, 2));
}
// อู๊ดลูกเสือ: our other Avatars on the Avatar Zone and the Avatars in our Magic Zone (v14 ruling)
const oodFodder = (g: Game, p: PID, c: Card) => [...P(g, p).avatars.filter((a) => a !== c), ...P(g, p).mz.filter((x) => isA(x) && x !== c)];

Object.assign(FX, {
  // ===================== BT01 =====================
  'ปื้ด เด็กเปรต': { keep: 3.5, staticPower: (g, c) => 2 * flippedLife(P(g, c.ctrl)), protectSelf: (g, c, by) => protectPret(g, c, by) },
  'พระเวสสุกรรม': {
    keep: 3.5,
    jutsu: (g, c) => peek(g, c.ctrl, 5, (top) => { takeHand(g, c.ctrl, top, (x) => x.def.type === 'Magic' && x.def.subtype === 'Land'); }, 'bottom'),
  },
  'หนุมาน': { keep: 3, staticPower: (g, c) => P(g, c.ctrl).avatars.filter((a) => symIs(a, 'เทพ')).length },
  'อู๊ดลูกเสือ': {
    // v14 ruling: the cost "Avatar ใบอื่น บนสนามเรา 1 ใบ" = เซ่นไหว้ one of our other Avatars, from the Avatar Zone or the
    // Magic Zone; the player is asked (Skip = don't use it). Cancels the attack.
    keep: 3,
    react: {
      on: ['attack'], noLimit: true,
      can: (g, p, c, ev) => ev.actor !== p && ev.target === c && oodFodder(g, p, c).length > 0,
      want: (g, p, c, ev) => {
        const fod = oodFodder(g, p, c).reduce<Card | null>((m, a) => (!m || value(g, a) < value(g, m) ? a : m), null);
        return !!fod && !!ev.source && power(g, ev.source) >= power(g, c) && value(g, fod) < value(g, c);
      },
      resolve: (g, p, c, ev) => {
        const pick = worstN(oodFodder(g, p, c), 1, (a) => value(g, a), { optional: true, title: 'อู๊ดลูกเสือ: เซ่นไหว้ an Avatar to cancel the attack?' })[0];
        if (!pick) return;
        const pl = P(g, p);
        const gone = pl.avatars.includes(pick) ? destroy(g, pick, p, false, { cost: true }) : toHell(g, pick, { cost: true });
        if (gone !== false) { ev.cancelled = true; log(g, `อู๊ดลูกเสือ: the attack is cancelled`); }
      },
    },
  },
  'ชาวบ้านขายน้ำ': {
    keep: 3,
    jutsu: (g, c) => { search(g, c.ctrl, (x) => x.def.type === 'Magic' && x.def.subtype === 'Modification' && x.def.name.includes('น้ำ'), 'deck'); },
  },
  'แม่กบ': { keep: 2.5, endPhase: (g, c) => { c.bonus += 1; } },
  'รัททาทุย นางพญา': { keep: 4 }, // approx: "take this from the Deck instead of the first draw" is not modeled
  'รัททาทุย พ่อพันธุ์': {
    keep: 3.5,
    jutsu: (g, c) => {
      const p = c.ctrl, pl = P(g, p);
      if (!onZone(g, p, 'รัททาทุย นางพญา').length) return;
      let left = 5;
      for (let i = 0; i < 6; i++) {
        const t = pickN(pl.deck.filter((x) => isA(x) && named(x, 'รัททาทุย') && x.def.cost <= left), 1, (x) => value(g, x), { optional: true, title: `รัททาทุย พ่อพันธุ์: you may summon a รัททาทุย from your Deck (Cost left ${left})` })[0]; // bugs7 item 7: "สามารถ" = optional
        if (!t || !canPlaceAvatar(pl)) break;
        left -= t.def.cost;
        if (!summon(g, p, t, 'effect')) break;
      }
      shuffle(g, pl.deck);
    },
  },
  'รัททาทุย': { keep: 1.5, unite: true },
  'แมลงปอเลื่อยยนต์': { keep: 3.5, jutsu: (g, c) => { destroyMagic(g, c.ctrl); } },
  'ลูกแม่ศรีนวล': { keep: 2.5, deathCry: (g, c, owner) => flipDown(g, owner) },
  'พ่อบุญใหญ่': {
    keep: 2.5,
    deathCry: (g, c, owner) => { search(g, owner, (x) => isA(x) && symIs(x, 'สัตว์') && x.def.cost <= 4, 'hell'); },
  },
  'จ่ามะนาว': { keep: 3.5, shield: true },
  'ทศกัณฐ์ที่---เมียพระอิศวร': {
    keep: 8,
    jutsu: (g, c) => { const t = pickN(P(g, opp(c.ctrl)).avatars, 1, (a) => value(g, a), { optional: true, title: `${c.def.name}: you may take control of 1 opposing Avatar` })[0]; if (t) steal(g, c.ctrl, t, true); }, // bugs7 item 7: "สามารถ" = optional
  },
  'ยมทูต': {
    keep: 3,
    jutsu: (g, c) => peek(g, c.ctrl, 5, (top) => { takeHand(g, c.ctrl, top, (x) => x.def.name === 'สิมพลีนรก'); }, 'bottom'),
  },
  'สารวัตร ตำรวจสัมภเวสี': { keep: 3.5, jutsu: (g, c) => { search(g, c.ctrl, (x) => isA(x) && x.def.name.includes('ตำรวจสัมภเวสี'), 'deck'); } },
  'เพื่อลูกค้า': {
    // v14: after drawing 3, this turn only {สัตว์} Avatars can be summoned (other Avatars can still be paid as GEM;
    // Magic is used normally): the timed rule 'เพื่อลูกค้า' (engine RULES)
    keep: 3.5,
    canCast: (g, p) => P(g, p).avatars.some((a) => symIs(a, 'สัตว์')) && P(g, p).deck.length > 5,
    resolve: (g, p) => {
      if (!sacrifice(g, p, P(g, p).avatars.filter((a) => symIs(a, 'สัตว์')), 1)) return;
      draw(g, p, 3);
      RULES['เพื่อลูกค้า'] ||= { label: 'เพื่อลูกค้า: only {สัตว์} Avatars can be summoned this turn', summon: (g2, r, c) => symIs(c, 'สัตว์') };
      addRule(g, { p, key: 'เพื่อลูกค้า', until: g.turn });
    },
  },
  'น้ำชูกำลัง': {
    // v14 confirmed: the wearer wakes during our End Phase (the power check stateCheck runs there)
    keep: 2.5,
    canCast: (g, p) => P(g, p).avatars.length > 0,
    modTarget: (g, p) => best(P(g, p).avatars, (a) => value(g, a) + (a.asleep ? 2 : 0)),
    modPower: (g, m, w) => { if (g.phase === 'End' && g.active === w.ctrl && P(g, w.ctrl).avatars.includes(w)) w.asleep = false; return 0; },
  },
  'ตีแม่': {
    // v14 ruling (cards-B): "when this falls to Hell" in every case: with its wearer, removed from the field, discarded
    // from hand by an ability (onDiscard), paid as GEM for an Avatar (usedAsCost), milled from the Deck (onMilled).
    // GEM for a Construct goes through usedAsCost too; simplify1: a cancelled cast / no wearer left -> onCastToHell.
    keep: 3,
    canCast: (g, p) => P(g, p).avatars.length > 0 && flippedLife(P(g, p)) < 4,
    modTarget: (g, p) => best(P(g, p).avatars, (a) => value(g, a) + (a.asleep ? 0 : 2)),
    modPower: () => 2,
    ...lifeFlipOnHell,
    afterLeave: (g: Game, m: Card, info: any) => { if (info.to === 'hell') flipUp(g, m.owner); },
    onDiscard: (g: Game, m: Card, cards: Card[]) => { if (cards.includes(m) && P(g, m.owner).hell.includes(m)) flipUp(g, m.owner); },
    usedAsCost: (g: Game, p: PID, m: Card) => { if (P(g, m.owner).hell.includes(m)) flipUp(g, m.owner); },
    onMilled: (g: Game, m: Card, p: PID) => { if (P(g, p).hell.includes(m)) flipUp(g, p); },
    onCastToHell: (g: Game, m: Card) => { if (P(g, m.owner).hell.includes(m)) flipUp(g, m.owner); },
  } as Fx,
  'ตีพ่อ': {
    keep: 3,
    canCast: (g, p) => P(g, p).avatars.length > 0 && flippedLife(P(g, p)) < 4,
    modTarget: (g, p) => best(P(g, p).avatars, (a) => power(g, a) + (a.asleep ? 0 : 3)),
    onWearerKill: (g, m, w) => {
      if (g.phase !== 'Battle' || g.active !== w.ctrl || m.f.woke === g.turn) return;
      if (!mayDo(g, m, `wake ${w.def.name} up`, true)) return; // bugs7 item 7: "สามารถ" = optional
      m.f.woke = g.turn; w.asleep = false; log(g, `${w.def.name} wakes up (ตีพ่อ)`);
    },
    ...lifeFlipOnHell,
    // other-team audit: same "เมื่อการ์ดใบนี้ตกลงสู่นรก" line as ตีแม่, so the same cases flip the LIFE
    afterLeave: (g: Game, m: Card, info: any) => { if (info.to === 'hell') flipUp(g, m.owner); },
    onDiscard: (g: Game, m: Card, cards: Card[]) => { if (cards.includes(m) && P(g, m.owner).hell.includes(m)) flipUp(g, m.owner); },
    usedAsCost: (g: Game, p: PID, m: Card) => { if (P(g, m.owner).hell.includes(m)) flipUp(g, m.owner); },
    onMilled: (g: Game, m: Card, p: PID) => { if (P(g, p).hell.includes(m)) flipUp(g, p); },
    onCastToHell: (g: Game, m: Card) => { if (P(g, m.owner).hell.includes(m)) flipUp(g, m.owner); },
  } as Fx,
  'เขาไกรลาสเอียง': {
    // v14 ruling: the declaring player mills 2 as soon as the attack target is chosen, before the React window and the
    // power check. blockReact runs at the start of the attack-declaration window; landAttack is the fallback when no
    // window opens (bot look-ahead) and is skipped when the mill was already done for this attack.
    keep: 2.5,
    canCast: (g, p) => !g.land || g.land.owner !== p,
    blockReact: (g, l, ev) => {
      if (ev.kind === 'attack' && ev.depth === 0 && ev.source && isLandOn(g, l)) kailashMill(g, l, ev.source);
      return null;
    },
    landAttack: (g, l, att) => kailashMill(g, l, att),
  } as Fx,
  'มวยทะเลลลลลล': {
    // v14 confirmed: after the first attack of a turn is over, no more attacks that turn; leaves after 4 End Phases
    keep: 2.5,
    canCast: (g, p) => !g.land || g.land.owner !== p,
    landPower: (g, l) => {
      if (l.f.turn !== g.turn) { l.f.turn = g.turn; l.f.base = g.stats.attacks; }
      if (g.phase === 'Battle' && g.stats.attacks > l.f.base) for (const a of P(g, g.active).avatars) a.f.noAttack = g.turn;
      return 0;
    },
    endPhase: (g, l) => {
      l.f.age = (l.f.age || 0) + 1;
      if (l.f.age >= 4 && g.land === l) { g.land = null; P(g, l.owner).hell.push(l); log(g, 'มวยทะเลลลลลล leaves after 4 turns'); }
    },
  },

  // ===================== BT02 =====================
  'บุญลือ วีรบุรุษเปรต': {
    keep: 3.5,
    jutsu: (g, c) => flipUp(g, c.ctrl),
    staticPower: (g) => flippedLife(g.p[0]) + flippedLife(g.p[1]),
    protectSelf: (g, c, by) => protectPret(g, c, by),
  },
  'วันชัย พ่อบุญลือ': {
    // v14 ruling: the เปรต it paid for is affected by everything as usual (POWER down, back to hand ...) but can't be
    // destroyed by a card's effect this turn (Magic or an Avatar's ability; fights still destroy it). A carried leave guard
    // on that เปรต (c.f['lg:วันชัย พ่อบุญลือ']) works while this card is in Hell.
    keep: 2.5,
    usedAsCost: (g, p, c, s) => { if (isA(s) && symIs(s, 'เปรต')) { s.f['lg:วันชัย พ่อบุญลือ'] = g.turn; log(g, `${s.def.name} can't be destroyed by effects this turn (วันชัย พ่อบุญลือ)`); } },
    leaveGuard: (g, self, t, info) => (self === t && info.how === 'destroy' && !info.battle && (t.f['lg:วันชัย พ่อบุญลือ'] || 0) >= g.turn
      ? { optional: false, run: () => true } : null),
  },
  'กัญญา แม่บุญลือ': {
    keep: 2,
    usedAsCost: (g, p, c, s) => { if (symIs(s, 'เปรต')) { draw(g, p, 1); discardWorst(g, p, 1); } },
  },
  'พี่เช 10 ล้อท่าอิฐ': {
    keep: 3,
    onAttack: (g, c, t) => {
      const p = c.ctrl;
      if (!once(g, p, 'peche:' + c.uid) || !P(g, p).hand.length) return;
      const d = worst(P(g, p).hand, (x) => keepValue(g, x));
      const helps = t ? power(g, c) <= power(g, t) && power(g, c) + 2 > power(g, t) : false;
      if (!d || !(helps || keepValue(g, d) < 1.5)) return;
      markOnce(g, P(g, p), 'peche:' + c.uid); discard(g, p, d); boost(c, 2);
    },
  },
  'ตำรวจไซบอร์ค จ่าคอป': {
    keep: 3,
    onAttack: (g, c) => {
      const p = c.ctrl;
      if (!once(g, p, 'kop:' + c.uid) || !P(g, p).hand.length || P(g, p).deck.length < 4) return;
      const d = worst(P(g, p).hand, (x) => keepValue(g, x));
      if (!d || keepValue(g, d) > 3) return;
      markOnce(g, P(g, p), 'kop:' + c.uid); discard(g, p, d);
      peek(g, p, 3, (top) => { takeHand(g, p, top, (x) => symIs(x, 'เครื่องจักร')); }, 'bottom');
    },
  },
  'อ๊บ': { keep: 1, jutsu: (g, c) => { sacrifice(g, c.ctrl, P(g, c.ctrl).avatars.filter((a) => a !== c), 1); } },
  'พระพรหม': {
    keep: 5,
    jutsu: (g, c) => {
      const p = c.ctrl, pl = P(g, p);
      const pool = (a: Card) => hellAvatars(g, p, (h) => h.def.symbol === a.def.symbol && h.def.name !== a.def.name && h.def.cost <= 8);
      const gain = (a: Card) => Math.max(-99, ...pool(a).map((h) => h.def.power + 1.5 + h.def.cost * 0.4 + (FX[h.def.name] ? 1 : 0))) - value(g, a);
      const s = best(pl.avatars.filter((a) => pool(a).length > 0), gain); // other-team audit: "Avatar ฝ่ายเรา 1 ใบ" may be itself
      if (!s || gain(s) <= 0) return;
      const sym = s.def.symbol, nm = s.def.name;
      if (!destroy(g, s, p)) return;
      fromZoneSummon(g, p, pl.hell, (h) => h.def.symbol === sym && h.def.name !== nm && h.def.cost <= 8, 'jutsu');
    },
  },
  'แม่ศรีนวล': { keep: 3, jutsu: (g, c) => { search(g, c.ctrl, (x) => x.def.name === 'ลูกแม่ศรีนวล' || x.def.name === 'พ่อบุญใหญ่', 'deck'); } },
  'แมลงปอแจ็ค': {
    keep: 3,
    jutsu: (g, c) => {
      const p = c.ctrl, pl = P(g, p);
      if (g.land) magicToHell(g, g.land);
      const l = best(pl.deck.filter((x) => x.def.type === 'Magic' && x.def.subtype === 'Land'), (x) => keepValue(g, x));
      if (l) { l.f = {}; if (g.land) magicToHell(g, g.land); placeLand(g, p, l); log(g, `play Land ${l.def.name} from Deck`); }
      shuffle(g, pl.deck);
    },
  },
  'แมลงปอ เปื้อนรังสี': { keep: 2, deathCry: (g, c, owner) => { destroyMagic(g, owner); } },
  'ซันนี่': { keep: 2.5, aura: (g, s, t) => (t !== s && t.ctrl === s.ctrl && ['กุ่ย', 'ฮอล', 'นาย'].some((k) => named(t, k)) ? 1 : 0) },
  'เอเลี่ยนแสงสีฟ้า': {
    keep: 3,
    jutsu: (g, c) => {
      const p = c.ctrl;
      const t = best(P(g, opp(p)).avatars, (a) => value(g, a));
      if (!t || value(g, t) <= value(g, c) || P(g, p).hand.length === 0) return;
      discardWorst(g, p, 1);
      if (coin(g)) { log(g, 'coin: heads'); destroy(g, t, p); } else { log(g, 'coin: tails'); destroy(g, c, p); }
    },
  },
  'ฤษี โคบุตร': {
    // v14 ruling: whenever either player uses a {ฤษี} Magic, this card gets POWER +1 for as long as it stays on the field
    keep: 3,
    onAnyMagic: (g, s, m) => {
      if (!symIs(m, 'ฤษี') || !P(g, s.ctrl).avatars.includes(s)) return;
      s.bonus += 1; log(g, `ฤษี โคบุตร: POWER +1 (${m.def.name})`);
    },
  },
  'แรงงานทาสออฟฟิศ': { keep: 2, endPhase: (g, c) => { if (P(g, c.ctrl).avatars.includes(c)) toDeckBottom(g, c); } },
  'ธอร์ เทพเจ้าสายฟ้า แห่ง แอสการ์ด': {
    keep: 4,
    onKill: (g, c, victim, vp) => {
      const x = power(g, c) - vp;
      const t = best(P(g, opp(c.ctrl)).avatars.filter((a) => power(g, a) === x), (a) => value(g, a));
      if (t) destroy(g, t, c.ctrl);
    },
  },
  'โอดิน พ่อทุกสถาบัน แห่ง แอสการ์ด': {
    keep: 5,
    jutsu: (g, c) => {
      const pl = P(g, c.ctrl);
      if (pl.deck.length < 16 || !pl.deck.some((x) => isA(x) && symIs(x, 'เทพ'))) return;
      mill(g, c.ctrl, 9);
      search(g, c.ctrl, (x) => isA(x) && symIs(x, 'เทพ'), 'deck');
    },
  },
  'นินจินแมน': { keep: 3.5, startMain: (g, c) => { const n = c.mods.length; if (n) draw(g, c.ctrl, n); } },
  'กัปตัน ไกร': {
    keep: 3,
    jutsu: (g, c) => {
      const p = c.ctrl;
      const t = best(P(g, opp(p)).avatars, (a) => value(g, a) + a.mods.length * 2);
      if (!t) return;
      const handV = P(g, p).hand.reduce((s, x) => s + keepValue(g, x), 0);
      if (value(g, t) + t.mods.length * 2 <= handV * 0.6) return;
      for (const x of [...P(g, p).hand]) discard(g, p, x);
      removeOpp(g, p, t, 'hand', false);
    },
  },
  'แบงค์ ผู้รู้ความจริง': {
    // the owner orders the top 3 (order ask, 'top'); the bot puts the best on top
    keep: 2,
    jutsu: (g, c) => scoutDeck(g, c.ctrl, 3, (top) => { top.sort((x, y) => keepValue(g, y) - keepValue(g, x)); }, 'top', 'แบงค์ ผู้รู้ความจริง'),
  },
  '40ดีกรีแมน': { keep: 4 }, // approx: the opponent choosing this Avatar's attack target is not modeled
  'เสามงคล': {
    keep: 3.5,
    staticPower: (g, c) => { noAttackIf(g, c, true, 'sao'); return 0; },
    onSummon: (g, c) => { c.f.noAttack = g.turn; },
    drawPhase: (g, c) => { c.f.noAttack = g.turn; draw(g, c.ctrl, 1); },
  },
  'ซินแส': { keep: 3, jutsu: (g, c) => { search(g, c.ctrl, (x) => x.def.name === 'เสามงคล', 'deck'); } },
  'ชุ่ย โจรสุสาน': {
    // each player sends back the 5 cards of the other's hell that the other most wants to keep there
    keep: 3,
    jutsu: (g, c) => {
      const p = c.ctrl;
      for (const victim of [opp(p), p] as PID[]) {
        const vh = P(g, victim);
        for (let i = 0; i < 5; i++) {
          const x = best(vh.hell, (y) => keepValue(g, y) + (y.def.only ? 3 : 0));
          if (!x) break;
          detach(g, x); vh.deck.push(x);
        }
        shuffle(g, vh.deck);
      }
    },
  },
  'พยาบาล เอ๋': {
    // approx: only fires when it wins the fight while being attacked
    keep: 3.5,
    onKill: (g, c) => { if (g.active !== c.ctrl) flipDown(g, c.ctrl, true); },
  },
  'สตีฟ Tank Ranger': {
    // v14: once per turn (สั่งใช้) it is worn by our "รถถัง"; the wearing รถถัง gets POWER +2 and must attack in the Battle
    // Phase when it can (FX.mustAttack: the End Phase / End turn buttons are blocked until it attacked)
    keep: 3,
    fieldActs: (g, p, c) => [act('สตีฟ: equip to รถถัง', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'steve:' + c.uid)
      && onZone(g2, p, 'รถถัง').some((a) => a !== c && !a.mods.some((m) => m.def.name === c.def.name)),
    (g2) => {
      markOnce(g2, P(g2, p), 'steve:' + c.uid);
      const w = best(onZone(g2, p, 'รถถัง').filter((a) => a !== c && !a.mods.some((m) => m.def.name === c.def.name)), (a) => value(g2, a));
      if (w && P(g2, p).avatars.includes(c)) attach(g2, c, w);
    })],
    modPower: (g, m, w) => (nameHas(w, 'รถถัง') ? 2 : 0),
    mustAttack: (g, self, a) => a.uid === self.wearer && a.mods.includes(self) && nameHas(a, 'รถถัง'), // other-team audit Q2 (user: force to go to Battle Phase)
  },
  'รถถัง B66 - เอ็กซ์เซลเซอร์': {
    keep: 3,
    staticPower: (g, c) => { noAttackIf(g, c, !c.mods.some(isA), 'tank'); return 0; },
  },
  'ช่วยโลกใบนี้ไว้': turnMagic({
    // v14 ruling: it stays in the Magic Zone until the End Phase of this turn. While it does, every {เปรต} Avatar on our
    // Avatar Zone (summoned before or after it) has เตะไข่; the opponent's Avatars lose โล่มนุษย์; our เปรต are not
    // affected by any card except this one: opponent Magic can't touch them, effects can't remove them (fights still
    // can), opposing effects can't choose them and temporary POWER losses don't count. GET badge "immune".
    // approx: "unaffected" does not block our own cards' effects, positive buffs or an opponent's "all Avatars" text
    // deletion (only negative temporary POWER, removal, targeting and opponent Magic are blocked).
    keep: 2,
    canCast: (g, p) => (P(g, p).hand.some((x) => isA(x) && symIs(x, 'เปรต')) || P(g, p).avatars.some((a) => symIs(a, 'เปรต'))) && flippedLife(P(g, p)) < 3,
    resolve: (g, p, c) => { for (const l of P(g, p).life) l.faceUp = true; c.f.turn = g.turn; log(g, `P${p} flips all LIFE face up`); },
    aura: (g, s, t) => {
      if (!saveWorldOn(g, s, t)) return 0;
      t.magicImmuneUntil = Math.max(t.magicImmuneUntil, g.turn);
      return -t.temp.reduce((n, x) => n + Math.min(0, x.power), 0); // temporary POWER losses don't count
    },
    grant: (g, s, t, kw) => kw === 'kick' && saveWorldOn(g, s, t), // "ได้รับ เตะไข่"
    denyKw: (g, s, t, kw) => kw === 'shield' && liveTurnMagic(g, s) && t.ctrl !== s.ctrl,
    leaveGuard: (g, s, t, info) => (saveWorldOn(g, s, t) && !info.battle && info.src !== s
      ? { optional: false, run: () => { log(g, `${t.def.name} is not affected (ช่วยโลกใบนี้ไว้)`); return true; } } : null),
    noTarget: (g, s, t, by) => saveWorldOn(g, s, t) && by !== s && by.ctrl !== s.ctrl,
    getFor: (g, s, t) => saveWorldOn(g, s, t) && 'ไม่รับผลการ์ดใดๆ + เตะไข่ (ช่วยโลกใบนี้ไว้)',
  } as any),
  'ประชามติ': {
    keep: 3,
    canCast: (g, p) => { const sum = P(g, p).avatars.reduce((s, a) => s + power(g, a), 0); return oppTargets(g, p, true).some((a) => power(g, a) < sum); },
    resolve: (g, p) => {
      for (const a of P(g, p).avatars) a.asleep = true;
      const sum = P(g, p).avatars.filter((a) => a.asleep).reduce((s, a) => s + power(g, a), 0);
      const t = best(oppTargets(g, p, true).filter((a) => power(g, a) < sum), (a) => value(g, a));
      if (t) destroy(g, t, p, true);
    },
  },
  'ฉุบสั่งตาย': {
    // rock-paper-scissors = 50/50
    keep: 3,
    canCast: (g, p) => oppTargets(g, p, true).length > 0,
    resolve: (g, p) => {
      const w: PID = coin(g) ? p : opp(p);
      log(g, `P${w} wins เป่ายิ้งฉุบ`);
      const pool = w === p ? oppTargets(g, p, true) : P(g, p).avatars;
      const t = best(pool, (a) => value(g, a));
      if (t) destroy(g, t, w, w === p);
    },
  },
  'ด่านลอย': {
    keep: 2,
    canCast: (g, p) => P(g, opp(p)).hand.length > 0,
    resolve: (g, p) => {
      const o = P(g, opp(p));
      // call the most common Avatar cost among the opponent's unseen cards (hand + Deck)
      const cnt = new Map<number, number>();
      for (const x of [...o.hand, ...o.deck]) if (isA(x)) cnt.set(x.def.cost, (cnt.get(x.def.cost) || 0) + 1);
      let k = 0, kn = -1; for (const [cost, n] of cnt) if (n > kn) { kn = n; k = cost; }
      if (!o.hand.length) return;
      const x = o.hand[Math.floor(rand(g) * o.hand.length)];
      log(g, `ด่านลอย calls cost ${k}, reveals ${x.def.name}`);
      if (isA(x) && x.def.cost === k) discard(g, opp(p), x);
    },
  },
  'แมลงปอทอด': turnMagic({
    keep: 3,
    canCast: (g, p) => P(g, p).avatars.some(isBug) && P(g, p).deck.length > 5,
    resolve: (g, p, c) => { c.f.turn = g.turn; if (sacrifice(g, p, P(g, p).avatars.filter(isBug), 1)) draw(g, p, 3); },
    aura: (g, s, t) => { if (liveTurnMagic(g, s) && t.ctrl === s.ctrl && !isBug(t)) t.f.noAttack = g.turn; return 0; },
  }),
  'กระแสอัปมงคล': {
    keep: 3,
    canCast: (g, p) => P(g, opp(p)).avatars.some((a) => FX[a.def.name] && magicOk(g, p, a) && !silenced(g, a)),
    resolve: (g, p) => { for (const a of P(g, opp(p)).avatars) if (magicOk(g, p, a)) silenceFull(g, a); },
  },
  // v13 user ruling: used when the opponent declares an attack: draw 1 now, and for the rest of this turn draw 1 more for each
  // further attack the opponent declares (engine attack(): once['drawOnAttack'])
  'กระแสสิริมงคล': {
    keep: 3,
    react: {
      on: ['attack'], can: (g, p, c, ev) => ev.actor !== p && P(g, p).once['drawOnAttack'] !== g.turn,
      want: (g, p, c, ev) => P(g, p).deck.length > 6,
      resolve: (g, p) => { draw(g, p, 1); P(g, p).once['drawOnAttack'] = g.turn; log(g, `P${p} draws 1 for each further attack this turn (กระแสสิริมงคล)`); },
    },
  },
  'เคี้ยวเพื่อนเธอซะ': {
    // v14 confirmed: summons one Avatar from hand, paid with the GEM of the sacrificed Avatars
    keep: 3,
    react: {
      on: ['summon'], can: (g, p, c, ev) => ev.actor !== p && P(g, p).hand.some((x) => isA(x) && x !== c) && P(g, p).avatars.length > 0,
      want: (g, p, c) => !!chewPlan(g, p, c),
      resolve: (g, p, c) => {
        const plan = chewPlan(g, p, c);
        const pl = P(g, p), total = pl.avatars.reduce((t, a) => t + a.def.gem, 0);
        // the human picks the Avatar to summon, then the Avatars to sacrifice until their GEM covers its Cost
        const h = best(pl.hand.filter((x) => isA(x) && x !== c && x.def.cost <= total), (x) => (plan && x === plan.h ? 100 : 0) + x.def.power);
        if (!h) return;
        let gem = 0;
        while (gem < h.def.cost) {
          const a = worst(pl.avatars.filter((y) => y.def.gem > 0), (y) => (plan && plan.fod.includes(y) ? -100 : 0) + value(g, y) / y.def.gem);
          if (!a) break; gem += a.def.gem; destroy(g, a, p);
        }
        if (gem < h.def.cost) return;
        
        if (P(g, p).hand.includes(h) && canPlaceAvatar(P(g, p))) summon(g, p, h, 'effect');
      },
    },
  },
  'ถวาย': {
    keep: 3,
    react: {
      on: ['destroy'], can: (g, p, c, ev) => !!ev.source && ev.source.ctrl === p,
      want: (g, p, c, ev) => value(g, ev.source!) >= 6 && P(g, p).hand.filter((x) => x !== c).reduce((s, x) => s + keepValue(g, x), 0) < value(g, ev.source!),
      resolve: (g, p, c, ev) => { for (const x of [...P(g, p).hand]) discard(g, p, x); ev.cancelled = true; },
    },
  },
  'เอากล้วยมานี่ย์ !!!!!!': {
    keep: 3.5,
    react: {
      on: ['attack'], can: (g, p, c, ev) => ev.actor !== p && !!ev.target && ev.target.ctrl === p && !!ev.source,
      want: (g, p, c, ev) => magicOk(g, p, ev.source!) && wantWin(g, ev.source!, ev.target!, -2),
      resolve: (g, p, c, ev) => {
        const t = ev.source && P(g, opp(p)).avatars.includes(ev.source) && magicOk(g, p, ev.source) ? ev.source : best(oppTargets(g, p, true), (a) => power(g, a));
        if (t) t.temp.push({ power: -2, until: 'turn' });
      },
    },
  },
  'ฟ้องครู': {
    keep: 3.5,
    react: {
      on: ['attack'], can: (g, p, c, ev) => ev.actor !== p && !!ev.target && ev.target.ctrl === p && P(g, p).avatars.some((a) => a !== ev.target),
      want: (g, p, c, ev) => {
        const h = best(P(g, p).avatars.filter((a) => a !== ev.target), (a) => power(g, a));
        return !!h && !!ev.source && power(g, ev.source) >= power(g, ev.target!) && power(g, ev.target!) + power(g, h) > power(g, ev.source);
      },
      resolve: (g, p, c, ev) => {
        const tg = ev.target; if (!tg || !P(g, p).avatars.includes(tg)) return;
        const h = best(P(g, p).avatars.filter((a) => a !== tg), (a) => power(g, a));
        if (h) tg.temp.push({ power: power(g, h), until: 'battle' });
      },
    },
  },
  'ประกันชั้นต่ำ': {
    // v14 confirmed: saves the wearer from any destruction in the Battle Phase (not by Magic); it is not
    // discarded after an attack the wearer survives on its own
    keep: 3,
    canCast: (g, p) => P(g, p).avatars.length > 0,
    modTarget: (g, p) => best(P(g, p).avatars, (a) => value(g, a)),
    protectWearer: (g, m, w, by, viaMagic) => {
      if (viaMagic || g.phase !== 'Battle' || by === w.ctrl) return false;
      detach(g, m); P(g, m.owner).hell.push(m); log(g, 'ประกันชั้นต่ำ saves ' + w.def.name);
      return true;
    },
  },
  'ขวานเงิน': {
    keep: 2.5,
    canCast: (g, p) => P(g, p).avatars.length > 0 || oppTargets(g, p, true).length > 0,
    modTarget: (g, p) => {
      const o = best(oppTargets(g, p, true).filter((a) => FX[a.def.name]), (a) => keepValue(g, a) - power(g, a) * 0.3);
      if (o && keepValue(g, o) >= 5) return o;
      return best(P(g, p).avatars.filter((a) => !FX[a.def.name]), (a) => value(g, a)) || o;
    },
    onAttach: (g, m, w) => { w.silencedTurn = g.turn; },
    modPower: (g, m, w) => { w.silencedTurn = g.turn; return 2; },
  },
  'ช็อตกัน นัยนาวุธ': {
    keep: 3.5,
    canCast: (g, p) => P(g, p).avatars.length > 0,
    modTarget: (g, p) => best(P(g, p).avatars, (a) => power(g, a) + (a.asleep ? 0 : 2)),
    onWearerKill: (g, m, w) => flipUp(g, opp(w.ctrl)),
  },

  // ===================== BT03 =====================
  'พระลักษมี': {
    keep: 2,
    costOnlyFor: (s) => isA(s) && symIs(s, 'เทพ'),
    usedAsCost: (g, p, c, s) => { if (named(s, 'พระนารายณ์')) boost(s, 3); },
  },
  'นางอัปสร': {
    // v14 ruling: from the moment its attack target is chosen to the end of that fight, the opponent gets no React Magic
    // window at all (FX.blockReact 'magic' while currentFight() is this card's attack)
    keep: 3, alias: ['พระนารายณ์'],
    blockReact: (g, self, ev) => (currentFight()?.att === self && (ev.responder ?? opp(ev.actor)) !== self.ctrl ? 'magic' : null),
  } as Fx,
  'อินทรีย์แมน': {
    keep: 4,
    jutsu: (g, c) => {
      const pl = P(g, c.ctrl);
      const m = best(pl.deck.filter((x) => x.def.type === 'Magic' && x.def.subtype === 'Modification' && !(FX[x.def.name]?.zeroKills)),
        (x) => { const f = FX[x.def.name]; return keepValue(g, x) + (f && f.modPower ? f.modPower(g, x, c) : 0); });
      if (m && pl.avatars.includes(c)) { attach(g, m, c); FX[m.def.name]?.onAttach?.(g, m, c); }
      shuffle(g, pl.deck);
    },
    staticPower: (g) => fieldMagic(g).filter((m) => m.def.subtype === 'Modification').length,
  },
  'หุ่นนักรบผู้กล้า : ไมเกรน': {
    keep: 4,
    jutsu: (g, c) => peek(g, c.ctrl, 5, (top) => { takeHand(g, c.ctrl, top, (x) => named(x, 'อาวุธหุ่นนักรบผู้กล้า')); } /* other-team audit Q17: aka too */, 'bottom'),
    onOwnMagic: (g, s, m) => {
      if (!named(m, 'อาวุธหุ่นนักรบผู้กล้า') || !once(g, s.ctrl, 'migraine:' + s.uid)) return;
      markOnce(g, P(g, s.ctrl), 'migraine:' + s.uid); draw(g, s.ctrl, 1);
    },
    // อากาศยานผู้กล้า : แอร์ซิด รีฟลักซ์ may be destroyed instead
    protectSelf: (g, c, by) => {
      if (by === c.ctrl) return false;
      const air = P(g, c.ctrl).avatars.find((a) => a.def.name === 'อากาศยานผู้กล้า : แอร์ซิด รีฟลักซ์' && !silenced(g, a));
      if (!air || value(g, air) >= value(g, c)) return false;
      log(g, 'แอร์ซิด รีฟลักซ์ is destroyed instead');
      destroy(g, air, c.ctrl);
      return true;
    },
  },
  'โดรนสอดแนมผู้กล้า : เก๊าท์': {
    keep: 3,
    jutsu: (g, c) => {
      const p = c.ctrl;
      if (!P(g, p).avatars.some((a) => a !== c && symIs(a, 'หุ่นยนต์') && named(a, 'ผู้กล้า'))) return;
      const od = P(g, opp(p)).deck; const top = od[0];
      if (!top) return;
      od.shift();
      if (isA(top)) { P(g, opp(p)).hell.push(top); log(g, `เก๊าท์ sends ${top.def.name} to hell`); } else od.push(top);
    },
  },
  'ยานเกราะผู้กล้า : ไดบาเรีย': {
    keep: 1,
    costOnlyFor: (s) => isA(s) && symIs(s, 'หุ่นยนต์') && colorIs(s, 'แดง'),
    usedAsCost: (g, p) => draw(g, p, 1),
  },
  'อากาศยานผู้กล้า : แอร์ซิด รีฟลักซ์': { keep: 2 }, // its effect is in หุ่นนักรบผู้กล้า : ไมเกรน (protectSelf)
  'กาฬสินธุ์แมน': { keep: 3, onKill: (g, c) => { c.bonus += 1; } },
  'จีสัส': { keep: 3.5, staticPower: (g, c) => { noAttackIf(g, c, P(g, c.ctrl).hand.length > 0, 'jesus'); return 0; } },
  'รัททาทุยแม่วัว': { keep: 2, aura: (g, s, t) => (t !== s && t.ctrl === s.ctrl && symIs(t, 'รัททาทุย') ? 1 : 0) },
  'มนุษย์รัททาทุย': { keep: 3, staticPower: (g, c) => P(g, c.ctrl).avatars.filter((a) => symIs(a, 'รัททาทุย')).length },
  'จ่างู อสรพิษพิฆาตจักรกล': { keep: 3, onAttack: (g, c, t) => { if (t && symIs(t, 'หุ่นยนต์')) destroy(g, t, c.ctrl); } },
  'ด็อคเตอร์แบงค์': {
    keep: 3,
    jutsu: (g, c) => {
      const p = c.ctrl;
      const s = worst(onZone(g, p, 'ศาลพระภูมิ'), (a) => value(g, a));
      if (!s) return;
      const bestH = best(hellAvatars(g, p, (x) => symIs(x, 'ผี')), (x) => x.def.power + x.def.cost * 0.4);
      if (!bestH || bestH.def.power + bestH.def.cost * 0.4 + 1.5 <= value(g, s) - 1) return;
      if (!destroy(g, s, p)) return;
      fromZoneSummon(g, p, P(g, p).hell, (x) => symIs(x, 'ผี') && x !== s);
    },
  },
  'แดรกคูลา': {
    // v14 ruling (cards-B): จุติ grants the ability (GET badge while it stays). When it is then destroyed, it stays in Hell
    // and at the start of the Battle Phase of our next turn it is summoned from Hell (delayed trigger: RuleDef.startBattle).
    keep: 5,
    jutsu: (g, c) => { P(g, c.ctrl).once['drac:' + c.uid] = 1; grantGetB(g, c, 'ถูกทำลาย: เทิร์นถัดมาของเรา อัญเชิญจากนรกในช่วง Battle Phase'); },
    afterLeave: (g: Game, c: Card, info: any) => {
      const pl = P(g, c.owner);
      if (!pl.once['drac:' + c.uid]) return;
      delete pl.once['drac:' + c.uid];
      if (info.how !== 'destroy' || !pl.hell.includes(c)) return;
      RULES['แดรกคูลา'] ||= {
        label: 'แดรกคูลา returns from Hell in the Battle Phase of its owner\'s next turn',
        startBattle: (g2: Game, r: any) => {
          if (g2.turn !== r.until || g2.active !== r.p) return;
          const pl2 = P(g2, r.p), d = pl2.hell.find((x) => x.uid === r.n);
          if (!d || !canPlaceAvatar(pl2, false, d)) return;
          log(g2, 'แดรกคูลา rises from Hell'); summon(g2, r.p, d, 'own');
        },
      };
      addRule(g, { p: c.owner, key: 'แดรกคูลา', until: g.active === c.owner ? g.turn + 2 : g.turn + 1, n: c.uid });
      log(g, 'แดรกคูลา will rise in our next Battle Phase');
    },
  },
  'อีแป๋ม ผีกระสือ RGB': {
    // v14: its wearer's Symbol becomes {ผี} (view symbolsFor: rules and the detail box) and POWER -2
    keep: 2,
    deathCry: (g, c, owner) => {
      if (!P(g, owner).hell.includes(c)) return;
      const t = best(P(g, opp(owner)).avatars, (a) => value(g, a) + (power(g, a) <= 2 ? 3 : 0));
      if (t) attach(g, c, t);
    },
    modPower: () => -2,
    symbolsFor: (g, self, t) => (t.mods.includes(self) ? { set: ['ผี'] } : null),
  } as any,
  'แม่นาค พระประแดง': {
    keep: 3,
    onSummon: (g, c) => {
      const o = P(g, opp(c.ctrl)); const x = best(o.hell, (y) => keepValue(g, y));
      if (!x) return; detach(g, x); o.deck.push(x);
      const t = best(o.avatars, (a) => value(g, a)); if (t) boost(t, -2);
    },
  },
  'โลกิ เทพแอสการ์ดแห่งการหลอกลวง': {
    keep: 2.5,
    endPhase: (g, c) => {
      const to = opp(c.ctrl);
      if (!P(g, c.ctrl).avatars.includes(c) || !canPlaceAvatar(P(g, to))) return;
      if (!takeControl(g, c, to)) return;
      c.f.loki = 1;
      log(g, `โลกิ moves to P${to}`);
    },
    staticPower: (g, c) => { noAttackIf(g, c, !!c.f.loki, 'lokiNo'); return 0; },
  },
  'บัลเดอร์ เทพแสง แห่งแอสการ์ด': {
    keep: 4,
    protectSelf: (g, c, by) => {
      const pl = P(g, c.ctrl);
      if (by === c.ctrl || !once(g, c.ctrl, 'balder:' + c.uid) || pl.deck.length < 14) return false;
      markOnce(g, pl, 'balder:' + c.uid); mill(g, c.ctrl, 9); log(g, 'บัลเดอร์ mills 9 instead of being destroyed');
      return true;
    },
  },
  // v14 ruling: both players' Deck top cards are shown face up while it is on the Avatar Zone (display only; the bots ignore it)
  'ฮามดัล เทพผู้รู้เห็น แห่งแอสการ์ด': { keep: 2.5, revealTop: (g: Game, self: Card) => P(g, self.ctrl).avatars.includes(self) } as any,
  'ราชาอาณาจักรของแพง  พระเจ้านิโคไล': {
    keep: 4,
    battle: (g, c, other) => { c.f.foeAt = g.stats.attacks; c.f.foeCost = fieldCost(g, other); },
    protectSelf: (g, c, by, viaMagic) => !viaMagic && g.phase === 'Battle' && c.f.foeAt === g.stats.attacks && c.f.foeCost < fieldCost(g, c),
  },
  'ทหารอาณาจักรของแพง': {
    // v14: Cost -1 for every opposing Avatar on the field is a view costMod (all cost checks + the detail box "N (printed)")
    keep: 2,
    staticPower: (g, c) => (onZone(g, c.ctrl, 'พระเจ้านิโคไล').length ? 2 : 0),
    costMod: (g, self, t) => (P(g, self.ctrl).avatars.includes(self) && t.ctrl !== self.ctrl && P(g, t.ctrl).avatars.includes(t) ? -1 : 0),
  } as any,
  'ช่างตัดเสื้อ อาณาจักรของแพง': {
    keep: 2,
    jutsu: (g, c) => { const k = best(onZone(g, c.ctrl, 'พระเจ้านิโคไล'), (a) => value(g, a)); if (k) { k.f.costUp = (k.f.costUp || 0) + 1; k.bonus += 1; } },
  },
  'จอมเวทย์ดอคู่': {
    keep: 3,
    fieldActs: (g, p, c) => [act('ดอคู่: destroy a Modification Magic', (g2) => inMain(g2, p) && once(g2, p, 'doku:' + c.uid)
      && fieldMagic(g2).some((m) => m.def.subtype === 'Modification' && magicHarm(g2, p, m) > 0),
    (g2) => { markOnce(g2, P(g2, p), 'doku:' + c.uid); destroyMagic(g2, p, (m) => m.def.subtype === 'Modification', true); })],
  },
  'ตั๊กแตนพันธ์ุ X': {
    // v14: also {แมลง} while on the Avatar Zone (view symbolsFor: every rule check + the แมลง icon in the detail box)
    keep: 3.5,
    staticPower: (g) => g.p[0].avatars.filter(isBug).length + g.p[1].avatars.filter(isBug).length,
    symbolsFor: (g, self, t) => (t === self && P(g, self.ctrl).avatars.includes(self) ? ['แมลง'] : null),
  } as any,
  'แมลงปอ บรรพบุรุษ': {
    keep: 3,
    deathCry: (g, c, owner) => { fromZoneSummon(g, owner, P(g, owner).hell, (x) => isBug(x) && x.def.cost <= 4 && x.def.name !== 'แมลงปอ บรรพบุรุษ', 'jutsu'); },
  },
  'เก็บค่าคุ้มครอง': {
    keep: 3,
    canCast: (g, p) => !!g.land && P(g, p).hand.length >= 2 && P(g, p).deck.length > 3,
    resolve: (g, p) => { if (g.land && discardWorst(g, p, 1)) draw(g, p, 2); },
  },
  'ตู้โชว์ไอดอล': {
    keep: 2.5,
    canCast: (g, p) => onZone(g, p, 'ไอดอล').length > 0 && P(g, p).deck.some((x) => isA(x) && named(x, 'โอตะ')),
    resolve: (g, p) => { search(g, p, (x) => isA(x) && named(x, 'โอตะ'), 'deck'); },
  },
  'ผมขอค้าน !!': {
    keep: 2,
    canCast: (g, p) => P(g, opp(p)).hand.length > 0,
    resolve: (g, p) => {
      const o = P(g, opp(p));
      // call the most common Avatar Symbol among the opponent's unseen cards (hand + Deck)
      const cnt = new Map<string, number>();
      for (const x of [...o.hand, ...o.deck]) if (isA(x)) cnt.set(x.def.symbol, (cnt.get(x.def.symbol) || 0) + 1);
      let k = '', kn = -1; for (const [s, n] of cnt) if (n > kn) { kn = n; k = s; }
      if (!o.hand.length) return;
      const x = o.hand[Math.floor(rand(g) * o.hand.length)];
      log(g, `ผมขอค้าน calls ${k}, reveals ${x.def.name}`);
      if (isA(x) && x.def.symbol === k) discard(g, opp(p), x);
    },
  },
  'ซุปเปอร์สแน็ค !!': {
    keep: 2.5, options: 2,
    canCast: (g, p, c, o) => o === 0 ? P(g, p).avatars.some((a) => symIs(a, 'สัตว์') && !a.asleep) : oppTargets(g, p, true).some((a) => symIs(a, 'สัตว์')),
    resolve: (g, p, c, o) => {
      const t = o === 0
        ? best(P(g, p).avatars.filter((a) => symIs(a, 'สัตว์')), (a) => (a.asleep ? 0 : 5) - value(g, a) * 0.2)
        : best(oppTargets(g, p, true).filter((a) => symIs(a, 'สัตว์')), (a) => value(g, a));
      if (t) { boost(t, 6); t.f.endDestroy = g.turn; }
    },
  },
  'ไม่เจ้ายังไม่พร้อม': {
    keep: 3,
    react: {
      on: ['summon'], can: (g, p, c, ev) => ev.actor !== p && !!ev.source && P(g, ev.actor).avatars.includes(ev.source) && !ev.source.asleep,
      want: (g, p, c, ev) => magicOk(g, p, ev.source!) && value(g, ev.source!) >= 5 && g.active === ev.actor,
      resolve: (g, p, c, ev) => { if (ev.source && magicOk(g, p, ev.source)) ev.source.asleep = true; },
    },
  },
  'เอาเสื้อมาหมุนๆแล้วตบ': {
    keep: 3, mainUse: true,
    canCast: (g, p, c) => P(g, p).hand.some((x) => x !== c) && oppTargets(g, p, true).some(isBug),
    resolve: (g, p, c) => shirtSlap(g, p, c),
    react: {
      on: ['attack', 'summon', 'magic', 'ability'],
      can: (g, p, c, ev) => ev.actor !== p && P(g, p).hand.some((x) => x !== c) && oppTargets(g, p, true).some(isBug),
      want: (g, p) => oppTargets(g, p, true).some((a) => isBug(a) && value(g, a) >= 4),
      resolve: (g, p, c) => shirtSlap(g, p, c),
    },
  },
  'งับ': {
    keep: 3.5,
    react: {
      on: ['attack'], can: (g, p, c, ev) => ev.actor !== p && !!ev.source && P(g, p).deck.length >= 2,
      // the bot doesn't peek: it plays this while its Deck still holds a fair share of กะปอม Avatars
      want: (g, p, c, ev) => { const d = P(g, p).deck; return d.filter((x) => isA(x) && symIs(x, 'กะปอม')).length / d.length >= 0.25 && value(g, ev.source!) >= 4; },
      resolve: (g, p, c, ev) => {
        let got: Card | null = null;
        peek(g, p, 2, (top) => { got = takeHand(g, p, top, (x) => isA(x) && symIs(x, 'กะปอม')); }, 'shuffle');
        if (got && ev.source && P(g, ev.actor).avatars.includes(ev.source)) destroy(g, ev.source, p, true);
      },
    },
  },
  'อาวุธหุ่นนักรบผู้กล้า "อีโบล่า ซอร์ด"': {
    keep: 3,
    canCast: (g, p) => P(g, p).avatars.some((a) => symIs(a, 'หุ่นยนต์')),
    modTarget: (g, p) => best(P(g, p).avatars.filter((a) => symIs(a, 'หุ่นยนต์')), (a) => value(g, a) + (named(a, 'หุ่นนักรบผู้กล้า') ? 3 : 0)),
    modPower: (g, m, w) => (named(w, 'หุ่นนักรบผู้กล้า') ? 3 : 1),
  },
  'ยาแก้ไอน้ำดำ': {
    keep: 2.5,
    canCast: (g, p) => P(g, p).avatars.length > 0,
    modTarget: (g, p) => best(P(g, p).avatars, (a) => value(g, a) + 2 * a.temp.filter((t) => t.power < 0).length),
    // cancels every POWER reduction on the wearer (temp, other Modification, Land, auras)
    modPower: (g, m, w) => {
      if (yaaGuard) return 0;
      yaaGuard = true;
      try {
        let neg = 0;
        for (const t of w.temp) if (t.power < 0) neg += t.power;
        for (const o of w.mods) { if (o === m) continue; const f = fx(o); const v = f && f.modPower ? f.modPower(g, o, w) : 0; if (v < 0) neg += v; }
        if (g.land) { const lf = fx(g.land); const v = lf && lf.landPower ? lf.landPower(g, g.land, w) : 0; if (v < 0) neg += v; }
        for (const q of g.p) for (const s of q.avatars.concat(q.mz)) { const sf = fx(s); if (sf && sf.aura && !silenced(g, s)) { const v = sf.aura(g, s, w); if (v < 0) neg += v; } }
        return -neg;
      } finally { yaaGuard = false; }
    },
  },
  'ขวานไม้เน่าๆเหม็นๆ': {
    // v14: its wearer's Cost -1 is a view costMod (all cost checks + the detail box)
    keep: 1.5,
    costMod: (g: Game, self: Card, t: Card) => (t.mods.includes(self) ? -1 : 0),
    canCast: (g, p) => oppTargets(g, p, true).length > 0 && P(g, p).avatars.some((a) => a.def.name.includes('พระเจ้านิโคไล')),
    modTarget: (g, p) => best(oppTargets(g, p, true), (a) => value(g, a)),
  },
  'ขวานทอง': {
    keep: 3,
    canCast: (g, p) => P(g, p).avatars.length > 0,
    modTarget: (g, p) => best(P(g, p).avatars, (a) => (a.asleep ? 0 : 3) + value(g, a) * 0.3),
    onWearerAttack: (g, m, w) => draw(g, w.ctrl, 1),
  },
  'สายฟ้า วัชระ': {
    keep: 5,
    canCast: (g, p) => P(g, p).avatars.length > 0,
    modTarget: (g, p) => best(P(g, p).avatars, (a) => (a.asleep ? 0 : 3) + value(g, a) * 0.3),
    wearerBattle: (g, m, w, other) => { if (g.active === w.ctrl && P(g, other.ctrl).avatars.includes(other)) destroy(g, other, w.ctrl); },
  },
  'อาณาจักรของแพง': {
    keep: 2.5,
    canCast: (g, p) => !g.land || g.land.owner !== p,
    fieldActs: (g, p, c) => [act('อาณาจักรของแพง: discard 1, find นิโคไล', (g2) => inMain(g2, p) && P(g2, p).hand.length >= 1
      && P(g2, opp(p)).avatars.reduce((s, a) => s + fieldCost(g2, a), 0) <= 4 && P(g2, p).deck.some((x) => x.def.name.includes('พระเจ้านิโคไล')),
    (g2) => { if (discardWorst(g2, p, 1)) search(g2, p, (x) => x.def.name.includes('พระเจ้านิโคไล'), 'deck'); })],
  },
  'ยุคกาฬสินธุ์โซอิค': {
    // v14: when a {กะปอม} Avatar's สอดแนม reveals it (and does not take it), its owner may put it on the Land Magic Zone
    // (uses this turn's Land Magic; FX.onScouted)
    keep: 3,
    canCast: (g, p) => !g.land || g.land.owner !== p,
    fieldActs: (g, p, c) => [act('ยุคกาฬสินธุ์โซอิค: pay 3 GEM, find กะปอม', (g2) => inMain(g2, p) && once(g2, p, 'zoic') && P(g2, p).deck.length > 5
      && P(g2, p).deck.some((x) => isA(x) && symIs(x, 'กะปอม')) && choosePayment(g2, p, 3, [], null) !== null,
    (g2) => {
      const pl = P(g2, p); markOnce(g2, pl, 'zoic');
      const pay = choosePayment(g2, p, 3, [], null); if (!pay) return;
      for (const x of pay) discard(g2, p, x);
      peek(g2, p, 5, (top) => {
        const x = best(top.filter((y) => isA(y) && symIs(y, 'กะปอม')), (y) => value(g2, y));
        if (!x) return;
        top.splice(top.indexOf(x), 1);
        pl.hand.push(x);
        if (x.def.cost <= 3 && canPlaceAvatar(pl) && mayDo(g2, x, 'summon it instead (Cost 3 or less)', true)) summon(g2, p, x, 'effect'); // stays in hand if it can't be placed
      }, 'shuffle');
    })],
    onScouted: (g: Game, c: Card, p: PID, by: PID | null, src: Card | null) => {
      const pl = P(g, p);
      if (!src || !isA(src) || !symIs(src, 'กะปอม') || by !== p || pl.used.Land || !castAllowed(g, p, c) || lands(g).some((l) => fx(l)?.lockLand)) return;
      if (!mayDo(g, c, 'put it on the Land Magic Zone (revealed by a กะปอม)', !g.land || g.land.owner !== p)) return;
      pl.used.Land = true; placeLand(g, p, c); log(g, `${c.def.name} is put on the Land Magic Zone (สอดแนม by ${src.def.name})`);
    },
  } as any,
  'ปราสาทแดรก': {
    keep: 3,
    canCast: (g, p) => !g.land || g.land.owner !== p,
    landPower: (g, l, a) => (a.def.name === 'แดรกคูลา' ? 1 : 0),
    fieldActs: (g, p, c) => [act('ปราสาทแดรก: discard 1, revive แดรกคูลา', (g2) => inMain(g2, p) && once(g2, p, 'dracCastle') && P(g2, p).hand.length >= 1
      && canPlaceAvatar(P(g2, p)) && P(g2, p).hell.some((x) => x.def.name === 'แดรกคูลา'),
    (g2) => { markOnce(g2, P(g2, p), 'dracCastle'); if (discardWorst(g2, p, 1)) fromZoneSummon(g2, p, P(g2, p).hell, (x) => x.def.name === 'แดรกคูลา'); })],
  },
} as Record<string, Fx>);

// เคี้ยวเพื่อนเธอซะ: the cheapest set of our Avatars whose GEM pays for the best Avatar in hand.
function chewPlan(g: Game, p: PID, self: Card): { fod: Card[]; h: Card } | null {
  const pl = P(g, p);
  const hs = pl.hand.filter((x) => isA(x) && x !== self).sort((x, y) => (y.def.power + y.def.cost * 0.4) - (x.def.power + x.def.cost * 0.4));
  const own = pl.avatars.filter((a) => a.def.gem > 0).sort((x, y) => value(g, x) / x.def.gem - value(g, y) / y.def.gem);
  for (const h of hs) {
    const fod: Card[] = []; let gem = 0;
    for (const a of own) { if (gem >= h.def.cost) break; fod.push(a); gem += a.def.gem; }
    if (gem < h.def.cost) continue;
    const lost = fod.reduce((s, a) => s + value(g, a), 0);
    const gain = h.def.power + 1.5 + h.def.cost * 0.4 + (FX[h.def.name] ? 1 : 0);
    if (gain > lost + 1) return { fod, h };
  }
  return null;
}
// เอาเสื้อมาหมุนๆแล้วตบ: shuffle 1 hand card into the Deck, destroy an opposing แมลง.
function shirtSlap(g: Game, p: PID, c: Card) {
  const pl = P(g, p);
  const back = worst(pl.hand.filter((x) => x !== c), (x) => keepValue(g, x));
  if (!back) return;
  detach(g, back); pl.deck.push(back); shuffle(g, pl.deck);
  const t = best(oppTargets(g, p, true).filter(isBug), (a) => value(g, a));
  if (t) destroy(g, t, p, true);
}

// ---------- v13: keyword grants from attached cards and Lands (previously skipped) ----------
Object.assign(FX, {
  // BT01-044 "Avatar ที่สวมใส่การ์ดใบนี้ได้รับความสามารถ โล่มนุษย์"
  'รั้วของชาติ': {
    keep: 2.5,
    canCast: (g: Game, p: PID) => P(g, p).avatars.some((a) => !hasKw(g, a, 'shield')),
    modTarget: (g: Game, p: PID) => best(P(g, p).avatars.filter((a) => !hasKw(g, a, 'shield')), (a) => power(g, a) + (a.asleep ? 0 : 2)),
    grant: (g: Game, s: Card, t: Card, kw: string) => kw === 'shield' && s.wearer === t.uid,
  },
  // BT02-059 "Avatar {symbol แมลง} ทุกใบ ได้รับ สามัคคี"
  'เทศกาลแมลงปอบุก': {
    keep: 2.5,
    canCast: (g: Game, p: PID) => (!g.land || g.land.owner !== p) && P(g, p).avatars.filter((a) => symIs(a, 'แมลง')).length >= 2,
    grant: (g: Game, s: Card, t: Card, kw: string) => kw === 'unite' && symIs(t, 'แมลง'),
  },
  // BT03-059 "เทิร์นละครั้ง สั่งใช้ เลือก Avatar 1 ใบบน Avatar Zone : ได้รับความสามารถ สามัคคี จนจบเทิร์น"
  'ราชธานีสามัคคี': {
    keep: 2.5,
    canCast: (g: Game, p: PID) => (!g.land || g.land.owner !== p) && P(g, p).avatars.length >= 2,
    fieldActs: (g: Game, p: PID, c: Card) => [act('ราชธานีสามัคคี: an Avatar gains สามัคคี until end of turn', (g2) => inMain(g2, p) && isLandOn(g2, c) && once(g2, p, 'rajthani')
      && P(g2, p).avatars.some((a) => !hasKw(g2, a, 'unite')),
    (g2) => {
      markOnce(g2, P(g2, p), 'rajthani');
      const t = best([...P(g2, p).avatars, ...P(g2, opp(p)).avatars].filter((a) => !hasKw(g2, a, 'unite')), (a) => (a.ctrl === p ? 10 : -10) + power(g2, a));
      if (t) { grantKw(g2, t, 'unite'); log(g2, `${t.def.name} gains สามัคคี until end of turn`); }
    })],
  },
});

// other-team audit Q9 (user: a cancelled Magic keeps its text costs paid): the "cost :" part is paid before the React window
costFirst('เพื่อลูกค้า', (g, p) => sacrifice(g, p, P(g, p).avatars.filter((a) => symIs(a, 'สัตว์')), 1), (g, p) => {
  draw(g, p, 3);
  RULES['เพื่อลูกค้า'] ||= { label: 'เพื่อลูกค้า: only {สัตว์} Avatars can be summoned this turn', summon: (g2, r, c) => symIs(c, 'สัตว์') };
  addRule(g, { p, key: 'เพื่อลูกค้า', until: g.turn });
});
costFirst('ช่วยโลกใบนี้ไว้', (g, p) => { for (const l of P(g, p).life) l.faceUp = true; log(g, `P${p} flips all LIFE face up`); return true; },
  (g, p, c) => { c.f.turn = g.turn; });
costFirst('ประชามติ', (g, p) => { for (const a of P(g, p).avatars) a.asleep = true; return true; }, (g, p) => {
  const sum = P(g, p).avatars.filter((a) => a.asleep).reduce((s, a) => s + power(g, a), 0);
  const t = best(oppTargets(g, p, true).filter((a) => power(g, a) < sum), (a) => value(g, a));
  if (t) destroy(g, t, p, true);
});
costFirst('แมลงปอทอด', (g, p, c) => { c.f.turn = g.turn; return sacrifice(g, p, P(g, p).avatars.filter(isBug), 1); }, (g, p, c) => { c.f.turn = g.turn; draw(g, p, 3); });
{
  const shirtPay = (g: Game, p: PID, c: Card) => {
    const pl = P(g, p), back = worst(pl.hand.filter((x) => x !== c), (x) => keepValue(g, x));
    if (!back) return false;
    detach(g, back); pl.deck.push(back); shuffle(g, pl.deck); return true;
  };
  const shirtHit = (g: Game, p: PID) => { const t = best(oppTargets(g, p, true).filter(isBug), (a) => value(g, a)); if (t) destroy(g, t, p, true); };
  costFirst('เอาเสื้อมาหมุนๆแล้วตบ', shirtPay, shirtHit, shirtPay, shirtHit);
}
