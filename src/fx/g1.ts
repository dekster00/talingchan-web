// Card effects for SD01, SD02, SD03, SD04, SD05, SD06, SD07, SD08, SD09 (cards not coded in cards.ts / cards2.ts).
// Lines marked "approx" simplify part of the printed effect where the engine has no hook for it.
import { rollDie } from '../engine.ts';
import type { Card, Game, PID } from '../types.ts';
import type { Ev } from '../engine.ts';
import { canChangeCtrl, takeControl, grantKw, landIs as landOn, isLandOn, placeLand, magicImmune, currentSource, lands, useShield } from '../engine.ts';
import { attach as attachCard, canWear, lifeDown } from '../engine.ts'; // v14d
import { castAllowed, nameHas, RULES, addRule, RULE_GAME } from '../engine.ts';
import type { HandAct } from '../cards.ts';
import { FX, value, best, worst, pickN, worstN, mayDo, chooseMode, oppChoice, oppTargets, removeOpp, sacrifice, search, inMain, magicOk } from '../cards.ts';
import { costFirst } from '../cards.ts'; // other-team audit Q9
import {
  P, opp, power, draw, destroy, toHell, toHand, toExile, discard, detach, summon, shuffle, mill,
  canPlaceAvatar, flippedLife, critical, onceUsed, markOnce, keepValue, log, findCard, rand,
  hasKw, placeToken, TOKEN_VANARA, withDecider, isVanara,
  symIs, symAny, colorIs, scoutDeck, putBottom, silenceFull, summonExact, colorsEn, arrangeTopBottom, decide, humanDeciding
} from '../engine.ts';

// ---------- helpers ----------
const isA = (c: Card) => c.def.type === 'Avatar' || c.def.type === 'Token';
function named(c: Card, key: string) {
  if (c.def.aka && c.def.aka.some((a) => a.includes(key))) return true;
  if (c.def.name.includes(key)) return true;
  const f = FX[c.def.name];
  return !!(f && f.alias && f.alias.some((a) => a.includes(key)));
}
const once = (g: Game, p: PID, key: string) => !onceUsed(g, P(g, p), key);
const act = (label: string, can: (g: Game) => boolean, run: (g: Game) => void): HandAct => ({ label, can, run });
const boost = (c: Card, n: number) => { c.temp.push({ power: n, until: 'turn' }); };
const d6 = (g: Game) => rollDie(g); // emits the 'roll' event
const hellAv = (g: Game, p: PID, pred: (c: Card) => boolean = () => true) => P(g, p).hell.filter((c) => isA(c) && pred(c));
const distinct = (cs: Card[]) => new Set(cs.map((c) => c.def.name)).size;
function discardWorst(g: Game, p: PID, n: number, pool?: (c: Card) => boolean) {
  for (let i = 0; i < n; i++) {
    const d = worst(P(g, p).hand.filter((x) => !pool || pool(x)), (x) => keepValue(g, x));
    if (!d) return false;
    discard(g, p, d);
  }
  return true;
}
// Look at the top n; pick() takes what it wants out of the list; the rest go to bottom / shuffle / back on top.
// สอดแนม / look at the top n: engine scoutDeck() reveals them, lets the human pick and order the rest
function peek(g: Game, p: PID, n: number, pick: (cs: Card[]) => void, rest: 'bottom' | 'shuffle' | 'hell' | 'top' | 'either' = 'shuffle') {
  scoutDeck(g, p, n, pick, rest);
}
function takeHand(g: Game, p: PID, list: Card[], pred: (c: Card) => boolean) {
  const c = best(list.filter(pred), (x) => keepValue(g, x) + x.def.power * 0.3);
  if (c) { list.splice(list.indexOf(c), 1); P(g, p).hand.push(c); }
  return c;
}
// Summon a card from a peeked list (it is in no zone): park it in hell so summon() can detach it.
function summonFromList(g: Game, p: PID, list: Card[], c: Card, how: 'effect' | 'jutsu' = 'effect') {
  if (!canPlaceAvatar(P(g, p))) return false;
  list.splice(list.indexOf(c), 1);
  c.f.viaScout = 1; P(g, p).hell.push(c); // somewhere findable
  return summon(g, p, c, how);
}
function fromZoneSummon(g: Game, p: PID, zone: Card[], pred: (c: Card) => boolean, how: 'effect' | 'jutsu' = 'effect') {
  if (!canPlaceAvatar(P(g, p))) return null;
  const c = best(zone.filter((x) => isA(x) && pred(x)), (x) => value(g, x));
  if (c && summon(g, p, c, how)) return c;
  return null;
}
// Put card c under Avatar w as an attached card (Tank Ranger / บุญช่วย). Cards it wore go to hell.
function attach(g: Game, c: Card, w: Card) {
  if (!canChangeCtrl(g, c, w.ctrl)) { log(g, `${c.def.name}: its control can't be changed (รูปประจำบ้าน)`); return; }
  if (!canWear(g, c, w)) { log(g, `${c.def.name} can't be attached to ${w.def.name}`); if (!findCard(g, c.uid)) P(g, c.owner).hell.push(c); return; } // v14d: canWear
  for (const m of c.mods.splice(0)) { m.wearer = -1; P(g, m.owner).hell.push(m); }
  detach(g, c);
  c.asleep = false; c.temp = []; c.wearer = w.uid; c.ctrl = w.ctrl;
  attachCard(g, c, w, false); // v14d: central attach (canWear checked above; onAttach stays with the callers)
}
// Constructs: build one (Construct Zone holds 3, one of each name) and fire its "when built" effect.
function canBuild(g: Game, p: PID, c: Card) {
  const mz = P(g, p).mz;
  return mz.filter((x) => x.def.type === 'Construct').length < 3 && !mz.some((x) => x.def.name === c.def.name);
}
function build(g: Game, p: PID, c: Card) {
  if (!canBuild(g, p, c)) return false;
  if (!summon(g, p, c, 'effect')) return false;
  const f: any = FX[c.def.name];
  c.f.built = 1;
  if (f && f.onBuild) f.onBuild(g, p, c);
  return true;
}
// Mill from our own card abilities (v14: นายนิรยบาล อ้วน's +2 is the engine millBonus hook, so this is a plain mill).
function myMill(g: Game, p: PID, n: number) { return mill(g, p, n); }
// "Avatar that attacks" for Lands that boost attackers: our own asleep Avatars during our Battle Phase.


// group keys
const GHN = ['กุ่ย', 'ฮอล', 'นาย'];
const isGHN = (c: Card) => GHN.includes(c.def.name);
const isTheos = (c: Card) => isA(c) && symIs(c, 'เทพ');
const isHellSym = (c: Card) => isA(c) && symIs(c, 'นรก');
const isTank = (c: Card) => isA(c) && named(c, 'รถถัง');
const isRanger = (c: Card) => isA(c) && c.def.name.includes('Tank Ranger') && !c.def.name.includes('รถถัง');
const TANK_NOGEAR = 'รถถัง "Tank Ranger"';
const isBT = (c: Card) => isA(c) && named(c, 'บึงทมิฬ') && named(c, 'People');
const isFish = (c: Card) => isA(c) && (symIs(c, 'ปลา') || c.def.name === 'วอเตอร์แมน');
const BT_LAND = 'บึงทมิฬ';
const btLand = (x: Card) => x.def.type === 'Magic' && x.def.subtype === 'Land' && nameHas(x, BT_LAND); // other-team audit
const landIs = (g: Game, name: string) => !!landOn(g, name);
const BRJ_NAMES = ['จัน หนวดเขี้ยว', 'อิน สไนเปอร์', 'ทองเหม็น ขวานคลั่ง', 'เมือง ช่างใหญ่', 'พันเรือง ผู้พิทักษ์ไร้พ่าย',
  'พ่อแท่น ผู้นำอาวุโส', 'อาจารย์ธรรมโชติ', 'บุญช่วย ควายรักชาติ', 'ไอ้ชิด อโยธยา Express', 'เณรคู ศิษย์เอกพระอาจารย์', 'น้าเอี๊ยด นักบรรเลง'];
const isBRJ = (c: Card) => isA(c) && BRJ_NAMES.includes(c.def.name); // Avatars with "ค่ายบางระจัน" in their text box
const CAMP = 'ค่ายบางระจัน';
const camp = (g: Game, p: PID) => P(g, p).mz.some((x) => x.def.name === CAMP);
const isGen = (c: Card) => isA(c) && nameHas(c, 'ขุนพล') && symIs(c, 'ต่างชาติ'); // v14: "#ถือว่ามีชื่อ ขุนพล" counts (โจโฉ)
const isRat = (c: Card) => c.def.type !== 'Magic' && symIs(c, 'รัททาทุย');
const rat111 = (c: Card) => isA(c) && symIs(c, 'รัททาทุย') && c.def.cost === 1 && c.def.gem === 1 && c.def.power === 1;
const isVan = (c: Card) => isA(c) && isVanara(c);
let GEN_SUMMON = false; // set while a ขุนพล ต่างชาติ ability is summoning
const NURSE_KEY = 'lg:บึงทมิฬ  People - คุณพยาบาล';
const GEN_BY = new Map<number, boolean>(); // แฮหัวตุ้น: uid -> its summon was made by a ขุนพล ชาวต่างชาติ ability

function refreshTank(g: Game, t: Card) {
  if (t.def.name === TANK_NOGEAR) t.f.noAttack = t.mods.some(isA) ? 0 : g.turn; // can't attack with no Avatar worn
}
function tankFor(g: Game, p: PID, x: Card, prefer?: Card | null) {
  const ok = P(g, p).avatars.filter((t) => t !== x && isTank(t) && !t.mods.some((m) => m.def.name === x.def.name));
  if (prefer && ok.includes(prefer)) return prefer;
  return best(ok, (t) => value(g, t) + (t.mods.some(isA) ? 0 : 3));
}
const anyTank = (g: Game, p: PID, x: Card) => P(g, p).avatars.some((t) => t !== x && isTank(t) && !t.mods.some((m) => m.def.name === x.def.name));
function rangerAttachAct(name: string): (g: Game, p: PID, c: Card) => HandAct[] {
  return (g, p, c) => [act(`${name}: wear onto รถถัง`, (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'ranger:' + c.uid) && anyTank(g2, p, c),
    (g2) => {
      markOnce(g2, P(g2, p), 'ranger:' + c.uid);
      const t = tankFor(g2, p, c);
      if (!t || !P(g2, p).avatars.includes(c)) return;
      attach(g2, c, t); refreshTank(g2, t); log(g2, `${c.def.name} is worn by ${t.def.name}`);
    })];
}
function summonRat111(g: Game, p: PID, from: 'deck' | 'hell' | 'both') {
  const pl = P(g, p);
  if (!canPlaceAvatar(pl)) return null;
  let c: Card | null = null;
  if (from !== 'hell') c = best(pl.deck.filter(rat111), (x) => value(g, x));
  if (!c && from !== 'deck') c = best(pl.hell.filter(rat111), (x) => value(g, x));
  const inDeck = !!c && pl.deck.includes(c);
  if (c) summon(g, p, c, 'effect');
  if (inDeck || from === 'deck') shuffle(g, pl.deck);
  return c;
}
// Pay one กุ่ย/ฮอล/นาย (hand first, then field) to hell.
function payOneGHN(g: Game, p: PID) {
  const pl = P(g, p);
  const h = worst(pl.hand.filter(isGHN), (x) => keepValue(g, x));
  if (h) { discard(g, p, h); return true; }
  const a = worst(pl.avatars.filter(isGHN), (x) => value(g, x));
  if (a) { toHell(g, a); return true; }
  return false;
}
const hasTrio = (g: Game, p: PID) => GHN.every((nm) => P(g, p).hand.some((x) => x.def.name === nm) || P(g, p).avatars.some((x) => x.def.name === nm));
// Pay one each of กุ่ย, ฮอล and นาย (hand first, then field) to hell.
function payTrio(g: Game, p: PID) {
  if (!hasTrio(g, p)) return false;
  const pl = P(g, p);
  for (const nm of GHN) {
    const h = pl.hand.find((x) => x.def.name === nm);
    if (h) { discard(g, p, h); continue; }
    const a = worst(pl.avatars.filter((x) => x.def.name === nm), (x) => value(g, x));
    if (!a) return false;
    toHell(g, a);
  }
  return true;
}
function bounceAny(g: Game, p: PID, att: Card | null) {
  if (att && att.ctrl !== p && P(g, att.ctrl).avatars.includes(att)) { removeOpp(g, p, att, 'hand', true); return; }
  const t = best(oppTargets(g, p, true), (a) => value(g, a));
  if (t) removeOpp(g, p, t, 'hand', true);
}
// battle-power estimate (no fight effects)
const beats = (g: Game, a: Card, d: Card) => power(g, a) > power(g, d) || (power(g, a) === power(g, d) && hasKw(g, a, 'tieWin') && !hasKw(g, d, 'tieWin'));

const NEW: Record<string, any> = {
  // ===== SD01 เทพ =====
  'พระอิศวร': {
    keep: 4.5,
    jutsu: (g: Game, c: Card) => {
      const p = c.ctrl;
      const t = best(P(g, opp(p)).avatars, (a) => value(g, a) + (power(g, a) <= 4 ? 2 : 0))
        || worst(P(g, p).avatars.filter((a) => a !== c), (a) => (a.asleep ? 0 : 5) + power(g, a)) || c;
      boost(t, -4);
    },
  },
  'พระนารายณ์': { keep: 4, onAttack: (g: Game, c: Card) => boost(c, 2) },
  'พระอินทร์': {
    keep: 3.5,
    jutsu: (g: Game, c: Card) => { const t = best(P(g, c.ctrl).avatars, (a) => (a.asleep ? 0 : 5) + power(g, a)); if (t) boost(t, 3); },
  },
  'นนทก': { keep: 3, aura: (g: Game, s: Card, t: Card) => (t.ctrl === s.ctrl && isTheos(t) && P(g, s.ctrl).avatars.includes(s) ? 1 : 0) },
  'เมียพระอิศวร': { keep: 5, jutsu: (g: Game, c: Card) => draw(g, c.ctrl, 3) },
  'น้ำแดง': {
    keep: 2.5,
    canCast: (g: Game, p: PID) => P(g, p).avatars.length > 0,
    modTarget: (g: Game, p: PID) => best(P(g, p).avatars, (a) => (a.asleep ? 0 : 3) + power(g, a)),
    modPower: () => 1,
  },
  'ความยุติธรรมสำหรับนนทก': {
    keep: 3.5,
    canCast: (g: Game, p: PID, c: Card) => P(g, p).hand.some((x) => x !== c && isTheos(x)) && P(g, p).deck.length > 3,
    resolve: (g: Game, p: PID) => { if (discardWorst(g, p, 1, isTheos)) draw(g, p, 2); },
  },
  'ฮ่า ฮ่า ฮ่า ผมได้เลื่อนขั้น': {
    keep: 3,
    canCast: (g: Game, p: PID) => P(g, p).avatars.some(isTheos),
    resolve: (g: Game, p: PID) => { const t = best(P(g, p).avatars.filter(isTheos), (a) => (a.asleep ? 0 : 5) + power(g, a)); if (t) boost(t, 2); },
  },
  'เขาไกรลาส': {
    keep: 3,
    canCast: (g: Game, p: PID) => P(g, p).avatars.filter(isTheos).length > P(g, opp(p)).avatars.filter(isTheos).length && !landIs(g, 'เขาไกรลาส'),
    landPower: (g: Game, l: Card, a: Card) => (isTheos(a) ? 1 : 0),
  },

  // ===== SD02 กุ่ย ฮอล นาย =====
  'กุ่ย': { keep: 3, unite: true, jutsu: (g: Game, c: Card) => { search(g, c.ctrl, (x) => isA(x) && x.def.name === 'ฮอล', 'deck'); } },
  'นาย': { keep: 3, unite: true, jutsu: (g: Game, c: Card) => { search(g, c.ctrl, (x) => isA(x) && x.def.name === 'กุ่ย', 'deck'); } },
  'ริกกี้ เพื่อนรัก': {
    keep: 2.5,
    jutsu: (g: Game, c: Card) => {
      const pl = P(g, c.ctrl);
      for (const x of pickN(pl.hell.filter(isGHN), 3, (y) => -keepValue(g, y), { optional: true, title: 'ริกกี้: return up to 3 กุ่ย/ฮอล/นาย from Hell to Deck' })) { detach(g, x); pl.deck.push(x); }
      shuffle(g, pl.deck); draw(g, c.ctrl, 1);
    },
  },
  'วีรบุรุษปากซอย': {
    keep: 5,
    jutsu: (g: Game, c: Card) => {
      const pl = P(g, c.ctrl);
      for (const x of pickN(pl.hell.filter((y) => isA(y) && isGHN(y)), 3, (y) => keepValue(g, y), { optional: true, title: 'วีรบุรุษปากซอย: take up to 3 กุ่ย/ฮอล/นาย from Hell' })) { detach(g, x); pl.hand.push(x); }
    },
  },
  'ระเบิดVery Fat Man': {
    keep: 6, mainUse: true,
    canCast: (g: Game, p: PID) => hasTrio(g, p) && P(g, opp(p)).avatars.length >= 2,
    resolve: (g: Game, p: PID) => { if (payTrio(g, p)) for (const a of [...P(g, opp(p)).avatars]) destroy(g, a, p, true); },
    react: {
      on: ['attack'],
      can: (g: Game, p: PID, c: Card, ev: Ev) => ev.actor !== p && hasTrio(g, p) && P(g, opp(p)).avatars.length > 0,
      want: (g: Game, p: PID) => P(g, opp(p)).avatars.reduce((s, a) => s + value(g, a), 0) >= 10,
      resolve: (g: Game, p: PID) => { if (payTrio(g, p)) for (const a of [...P(g, opp(p)).avatars]) destroy(g, a, p, true); },
    },
  },
  'ไม้เกาหลัง': {
    keep: 3,
    canCast: (g: Game, p: PID) => P(g, p).avatars.length > 0 && P(g, opp(p)).avatars.length > 0,
    modTarget: (g: Game, p: PID) => best(P(g, p).avatars, (a) => (a.asleep ? 0 : 3) + power(g, a)),
    // v13: the wearer gains เตะไข่ (keyword grant from the attached card)
    grant: (g: Game, s: Card, t: Card, kw: string) => kw === 'kick' && s.wearer === t.uid,
  },
  'บำเพ็ญประโยชน์': {
    keep: 3.5,
    canCast: (g: Game, p: PID, c: Card) => P(g, p).hand.some((x) => x !== c && isGHN(x) && isA(x)) && P(g, p).deck.length > 3,
    resolve: (g: Game, p: PID) => { if (discardWorst(g, p, 1, (x) => isGHN(x) && isA(x))) draw(g, p, 2); },
  },
  'สละเพื่อนเพื่อช่วยเพื่อน': {
    keep: 4, mainUse: true,
    canCast: (g: Game, p: PID, c: Card) => (P(g, p).hand.some((x) => x !== c && isGHN(x)) || P(g, p).avatars.some(isGHN)) && oppTargets(g, p, true).length > 0,
    resolve: (g: Game, p: PID) => { if (payOneGHN(g, p)) bounceAny(g, p, null); },
    react: {
      on: ['attack'],
      can: (g: Game, p: PID, c: Card, ev: Ev) => ev.actor !== p && !!ev.source && (P(g, p).hand.some((x) => x !== c && isGHN(x)) || P(g, p).avatars.some(isGHN)),
      want: (g: Game, p: PID, c: Card, ev: Ev) => {
        const att = ev.source!;
        if (ev.target === null) return flippedLife(P(g, p)) >= 3 || value(g, att) >= 6;
        return beats(g, att, ev.target!) && value(g, ev.target!) >= 4 && !isGHN(ev.target!);
      },
      resolve: (g: Game, p: PID, c: Card, ev: Ev) => { if (payOneGHN(g, p)) bounceAny(g, p, ev.source); },
    },
  },
  'สมชาย ห้องเช่าถูกๆ': {
    keep: 2.5,
    canCast: (g: Game, p: PID) => P(g, p).avatars.some(isGHN) && !landIs(g, 'สมชาย ห้องเช่าถูกๆ'),
    // v14 ruling: only the Avatar that declared the attack gets +2 until the end of that fight (a สามัคคี helper does not)
    landAttack: (g: Game, l: Card, att: Card) => { if (isGHN(att)) { att.temp.push({ power: 2, until: 'battle' }); log(g, `สมชาย ห้องเช่าถูกๆ: ${att.def.name} POWER +2 for this fight`); } },
  },

  // ===== SD03 นรก =====
  // v14: every ธรณีสูบ done by an ability of our cards (except นายนิรยบาล อ้วน) mills 2 more while this is on the Avatar Zone
  'นายนิรยบาล อ้วน': {
    keep: 2.5,
    millBonus: (g: Game, self: Card, owner: PID, n: number, by: PID | null, src: Card | null) =>
      (by === self.ctrl && !!src && src.def.name !== 'นายนิรยบาล อ้วน' && P(g, self.ctrl).avatars.includes(self) ? 2 : 0),
  },
  'สุวาน': { keep: 4.5, staticPower: (g: Game, c: Card) => distinct(hellAv(g, c.ctrl, (x) => named(x, 'นายนิรยบาล'))) },
  'กระทะทองแดง': {
    keep: 3.5,
    canCast: (g: Game, p: PID, c: Card) => P(g, p).hand.some((x) => x !== c && isHellSym(x)) && P(g, p).deck.length > 6,
    resolve: (g: Game, p: PID) => { if (!discardWorst(g, p, 1, isHellSym)) return; myMill(g, p, 2); draw(g, p, 2); },
  },
  'บัญชีหนังหมา': {
    keep: 3.5,
    canCast: (g: Game, p: PID) => P(g, p).deck.some((x) => isA(x) && named(x, 'นายนิรยบาล') && x.def.cost <= 4),
    // v14: for the rest of the game, our cards with the fetched name can't be paid as GEM (Cost) for summoning an Avatar
    // (timed rule 'บัญชีหนังหมา' with RuleDef.pay; they can still be discarded for other things)
    resolve: (g: Game, p: PID) => {
      const got = search(g, p, (x) => isA(x) && named(x, 'นายนิรยบาล') && x.def.cost <= 4, 'deck');
      if (!got) return;
      RULES['บัญชีหนังหมา'] ||= { label: 'บัญชีหนังหมา: the fetched name can\'t be used as summon Cost', pay: (g2: Game, r: any, pc: Card, forCard: Card) => !(pc.def.name === r.name && isA(forCard)) };
      addRule(g, { p, key: 'บัญชีหนังหมา', until: RULE_GAME, name: got.def.name });
    },
  },
  'หอกแหลมแทงทุกวัน': {
    keep: 2.5,
    canCast: (g: Game, p: PID) => P(g, p).avatars.some(isHellSym),
    modTarget: (g: Game, p: PID) => best(P(g, p).avatars.filter(isHellSym), (a) => (a.asleep ? 0 : 3) + power(g, a)),
    modPower: (g: Game, m: Card, w: Card) => (symIs(w, 'นรก') ? 1 : 0),
    // v14 ruling: once it was sent to Hell by ธรณีสูบ it can be used from Hell like a Modification Magic from hand, at any
    // later Main Phase of ours (it uses this turn's Modification Magic), for as long as it stays in Hell
    onMilled: (g: Game, c: Card) => { c.f.milled = 1; },
    hellActs: (g: Game, p: PID, c: Card) => [act('หอกแหลม: use from Hell (milled)', (g2) => inMain(g2, p) && !P(g2, p).used.Modification && P(g2, p).hell.includes(c)
      && !!c.f.milled && castAllowed(g2, p, c) && P(g2, p).avatars.some(isHellSym),
    (g2) => {
      const w = best(P(g2, p).avatars.filter(isHellSym), (a) => (a.asleep ? 0 : 3) + power(g2, a));
      if (!w) return;
      P(g2, p).used.Modification = true; delete c.f.milled; attach(g2, c, w);
    })],
  },
  'สิมพลีนรก': {
    keep: 3,
    canCast: (g: Game, p: PID) => P(g, p).avatars.filter(isHellSym).length > P(g, opp(p)).avatars.filter(isHellSym).length && !landIs(g, 'สิมพลีนรก'),
    landPower: (g: Game, l: Card, a: Card) => (isHellSym(a) ? 1 : 0),
  },
  'จิ้มมันเลย จิ้ม!': {
    keep: 4.5,
    react: {
      on: ['summon'],
      can: (g: Game, p: PID, c: Card, ev: Ev) => ev.actor !== p && !!ev.source && P(g, opp(p)).avatars.includes(ev.source)
        && P(g, p).hand.some((x) => x !== c && isHellSym(x) && x.def.cost >= ev.source!.def.cost),
      want: (g: Game, p: PID, c: Card, ev: Ev) => value(g, ev.source!) >= 5 || ev.source!.def.only,
      resolve: (g: Game, p: PID, c: Card, ev: Ev) => {
        const s = ev.source!;
        const d = worst(P(g, p).hand.filter((x) => isHellSym(x) && x.def.cost >= s.def.cost), (x) => keepValue(g, x));
        if (!d) return;
        discard(g, p, d); myMill(g, p, 2);
        destroy(g, s, p, true);
      },
    },
  },

  // ===== SD04 Tank Ranger =====
  'กัปตันแบงค์ Tank Ranger': {
    keep: 4,
    jutsu: (g: Game, c: Card) => {
      const p = c.ctrl;
      peek(g, p, 5, (top) => {
        const x = best(top.filter((y) => isA(y) && (y.def.name.includes('จ่ามะนาว') || y.def.name.includes('จ่าแดงเดือด'))), (y) => (y.def.name.includes('จ่าแดงเดือด') ? 2 : 1));
        if (!x) return;
        const t = tankFor(g, p, x);
        if (!t) return;
        top.splice(top.indexOf(x), 1); attach(g, x, t); refreshTank(g, t);
      }, 'bottom');
    },
    fieldActs: rangerAttachAct('กัปตันแบงค์'),
  },
  'จ่ามะนาว Tank Ranger': {
    keep: 3.5,
    jutsu: (g: Game, c: Card) => {
      const pl = P(g, c.ctrl);
      if (!pl.avatars.some((a) => a !== c && isTank(a))) return;
      const up = pl.life.filter((l) => l.faceUp);
      if (up.length && lifeDown(g, c.ctrl, up[Math.floor(rand(g) * up.length)])) log(g, 'จ่ามะนาว turns a LIFE face down'); // v14d: lifeDown
    },
    fieldActs: rangerAttachAct('จ่ามะนาว'),
    protectWearer: (g: Game, m: Card, w: Card) => {
      if (!isTank(w)) return false;
      detach(g, m); P(g, m.owner).hell.push(m); refreshTank(g, w);
      log(g, 'จ่ามะนาว is destroyed instead of ' + w.def.name);
      return true;
    },
  },
  'จ่าแดงเดือด Tank Ranger': {
    keep: 3.5,
    fieldActs: rangerAttachAct('จ่าแดงเดือด'),
    modPower: (g: Game, m: Card, w: Card) => (isTank(w) ? 1 : 0),
    onWearerKill: (g: Game, m: Card, w: Card) => {
      if (g.active !== w.ctrl || !w.asleep) return;
      if (w.def.name === TANK_NOGEAR && !w.mods.some((x) => x !== m && isA(x))) return; // it would lose the ability to attack
      detach(g, m); P(g, m.owner).hell.push(m); w.asleep = false; refreshTank(g, w);
      log(g, 'จ่าแดงเดือด is destroyed: ' + w.def.name + ' wakes up');
    },
  },
  [TANK_NOGEAR]: {
    keep: 3.5,
    startMain: (g: Game, c: Card) => refreshTank(g, c),
    onSummon: (g: Game, c: Card) => refreshTank(g, c),
  },
  'MEGA ROR.DOR': {
    keep: 6, alias: ['รถถัง'],
    jutsu: (g: Game, c: Card) => {
      const pl = P(g, c.ctrl);
      const x = best(pl.deck.filter((y) => isRanger(y) && !c.mods.some((m) => m.def.name === y.def.name)), (y) => keepValue(g, y) + (FX[y.def.name]?.modPower ? 2 : 0));
      if (x) { attach(g, x, c); log(g, `MEGA ROR.DOR wears ${x.def.name}`); }
      shuffle(g, pl.deck);
    },
  },
  'รถถังลงถนน': {
    keep: 4,
    canCast: (g: Game, p: PID) => canPlaceAvatar(P(g, p)) && P(g, p).deck.some((x) => isTank(x) && x.def.cost <= 5),
    resolve: (g: Game, p: PID) => {
      const pl = P(g, p);
      fromZoneSummon(g, p, pl.deck, (x) => isTank(x) && x.def.cost <= 5);
      shuffle(g, pl.deck);
      const o = opp(p), ol = P(g, o);
      decide(g, o, () => fromZoneSummon(g, o, ol.deck, (x) => x.def.type === 'Avatar' && x.def.cost <= 5));
      shuffle(g, ol.deck);
    },
  },
  'ใบดำใบแดง': {
    keep: 2.5,
    canCast: (g: Game, p: PID) => P(g, p).deck.length > 3,
    resolve: (g: Game, p: PID) => {
      const pl = P(g, p); const top = pl.deck[0];
      if (!top) return;
      if (isA(top) && symIs(top, 'คน') && top.def.cost <= 3 && canPlaceAvatar(pl) && summon(g, p, top, 'effect')) return;
      if (pl.deck[0] === top) { pl.deck.shift(); pl.deck.push(top); }
    },
  },
  'ขึ้นมาเร็ว ไอ้ลูกลิง !!': {
    keep: 4,
    react: {
      on: ['attack'],
      can: (g: Game, p: PID, c: Card, ev: Ev) => ev.actor !== p && !!ev.target && ev.target.ctrl === p && isTank(ev.target) && P(g, p).deck.length > 0,
      want: (g: Game, p: PID, c: Card, ev: Ev) => value(g, ev.source!) >= 4 || beats(g, ev.source!, ev.target!),
      resolve: (g: Game, p: PID, c: Card, ev: Ev) => {
        let ok = false;
        peek(g, p, 5, (top) => {
          const x = best(top.filter((y) => isRanger(y) && symIs(y, 'คน')), (y) => (FX[y.def.name]?.modPower ? 2 : 1));
          if (!x) return;
          const t = tankFor(g, p, x, ev.target);
          if (!t) return;
          top.splice(top.indexOf(x), 1); attach(g, x, t); refreshTank(g, t); ok = true;
        }, 'shuffle'); // v14 ruling: the rest are shuffled back into the Deck
        if (ok && ev.source) destroy(g, ev.source, p, true);
      },
    },
  },
  'ถาดหลุม': {
    keep: 1.5,
    canCast: (g: Game, p: PID) => P(g, p).avatars.length > 0,
    modTarget: (g: Game, p: PID) => best(P(g, p).avatars, (a) => (a.asleep ? 0 : 3) + power(g, a)),
    // v14 ruling: the coin is flipped as our Main Phase starts (the first POWER check of the Main Phase, the stateCheck right
    // after the start-of-Main abilities; or at once when it is attached during our Main), result until end of turn
    modPower: (g: Game, m: Card) => {
      if (g.active === m.owner && g.phase === 'Main' && m.f.flip !== g.turn) { m.f.flip = g.turn; m.f.delta = rand(g) < 0.5 ? 2 : -2; log(g, `ถาดหลุม coin: ${m.f.delta > 0 ? 'heads +2' : 'tails -2'}`); }
      return m.f.flip === g.turn ? m.f.delta : 0;
    },
  },
  'เขาชนไก่': {
    keep: 2,
    canCast: (g: Game, p: PID) => P(g, p).avatars.some((a) => symIs(a, 'คน')) && !(g.land && g.land.owner === p),
    fieldActs: (g: Game, p: PID, l: Card) => [act('เขาชนไก่: sleep a คน, scry 1', (g2) => inMain(g2, p) && isLandOn(g2, l) && once(g2, p, 'khaochon')
      && P(g2, p).avatars.some((a) => symIs(a, 'คน') && !a.asleep) && P(g2, p).deck.length > 0,
    (g2) => {
      markOnce(g2, P(g2, p), 'khaochon');
      const a = worst(P(g2, p).avatars.filter((x) => symIs(x, 'คน') && !x.asleep), (x) => power(g2, x));
      if (!a) return;
      a.asleep = true;
      scoutDeck(g2, p, 1, () => {}, 'either', 'เขาชนไก่');
    })],
  },

  // ===== SD05 บึงทมิฬ =====
  'บึงทมิฬ  People - CEO คุณจิระ': {
    keep: 3.5,
    onAttack: (g: Game, c: Card) => boost(c, g.p[0].avatars.concat(g.p[1].avatars).filter((a) => a.asleep).length),
    onTargeted: (g: Game, c: Card) => boost(c, g.p[0].avatars.concat(g.p[1].avatars).filter((a) => a.asleep).length),
  },
  'บึงทมิฬ  People - คุณเค้นท์': {
    keep: 3,
    onAttack: (g: Game, c: Card, t: Card | null) => { if (t === null) kentRoll(g, c); else c.f.kent = g.turn; },
    onKill: (g: Game, c: Card) => { if (c.f.kent === g.turn && g.active === c.ctrl) kentRoll(g, c); },
  },
  'บึงทมิฬ  People - คุณฮาร์วี่': {
    keep: 2.5,
    jutsu: (g: Game, c: Card) => {
      const pl = P(g, c.ctrl);
      const n = g.p[0].avatars.concat(g.p[1].avatars).filter((a) => a.asleep).length;
      if (n <= 0 || !pl.deck.length) return;
      const shown = pl.deck.splice(Math.max(0, pl.deck.length - n));
      takeHand(g, c.ctrl, shown, isFish);
      pl.deck.push(...shown); shuffle(g, pl.deck);
    },
  },
  'บึงทมิฬ  People - คุณอังคณา': {
    keep: 2.5, shield: true,
    // "เมื่อการ์ดใบนี้ใช้ความสามารถ โล่มนุษย์: POWER +2 จนจบการต่อสู้นั้น"
    onShieldUsed: (g: Game, s: Card, sh: Card) => { if (s === sh) s.temp.push({ power: 2, until: 'battle' }); },
  },
  'บึงทมิฬ  People - คุณพยาบาล': {
    keep: 2.5,
    // v14 ruling: the chosen บึงทมิฬ People is not destroyed once until the end of the opponent's next turn, even after
    // คุณพยาบาล has left the field (a carried leave guard on the protected card: c.f['lg:<this name>'])
    fieldActs: (g: Game, p: PID, c: Card) => [act('คุณพยาบาล: protect a บึงทมิฬ People', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && !c.asleep && once(g2, p, 'nurse:' + c.uid)
      && P(g2, p).avatars.some((a) => a !== c && isBT(a) && !((a.f[NURSE_KEY] || 0) >= g2.turn)),
    (g2) => {
      markOnce(g2, P(g2, p), 'nurse:' + c.uid);
      c.asleep = true;
      const t = best(P(g2, p).avatars.filter((a) => a !== c && isBT(a)), (a) => value(g2, a));
      if (!t) return;
      t.f[NURSE_KEY] = g2.active === p ? g2.turn + 1 : g2.turn + 2;
      log(g2, `${t.def.name} won't be destroyed once (คุณพยาบาล)`);
    })],
    leaveGuard: (g: Game, self: Card, t: Card, info: any) => (self === t && info.how === 'destroy' && (t.f[NURSE_KEY] || 0) >= g.turn
      ? { optional: false, run: () => { delete t.f[NURSE_KEY]; log(g, `${t.def.name} is not destroyed (คุณพยาบาล)`); return true; } } : null),
  },
  'วอเตอร์แมน': {
    keep: 6, alias: ['บึงทมิฬ People'],
    jutsu: (g: Game, c: Card) => {
      const p = c.ctrl, pl = P(g, p);
      for (let i = 0; i < 2; i++) {
        const x = fromZoneSummon(g, p, pl.deck, (y) => isBT(y) && y.def.name !== 'วอเตอร์แมน');
        if (x && pl.avatars.includes(x) && !landIs(g, BT_LAND)) x.asleep = true;
      }
      shuffle(g, pl.deck);
    },
  },
  // SD05-014 is a Land (user ruling v14: the data printed Normal by mistake; sim.ts loadDefs fixes the subtype, so it uses
  // only this turn's Land and sits in the Land zone).
  'บึงทมิฬ': {
    keep: 3,
    // a Land (SD05-014 is fixed to subtype Land in sim.ts loadDefs; castMagic puts it in the Land Zone)
    canCast: (g: Game, p: PID) => !P(g, p).used.Land && !landIs(g, BT_LAND) && P(g, p).avatars.length > 0,
    fieldActs: (g: Game, p: PID, l: Card) => [act('บึงทมิฬ: sleep an Avatar, draw 1', (g2) => inMain(g2, p) && isLandOn(g2, l) && once(g2, p, 'bueng')
      && P(g2, p).avatars.some((a) => !a.asleep) && P(g2, p).deck.length > 2,
    (g2) => {
      markOnce(g2, P(g2, p), 'bueng');
      const a = worst(P(g2, p).avatars.filter((x) => !x.asleep), (x) => power(g2, x));
      if (a) { a.asleep = true; draw(g2, p, 1); }
    })],
  },
  'กำเนิดจากน้ำ': {
    keep: 3,
    canCast: (g: Game, p: PID) => canPlaceAvatar(P(g, p)) && hellAv(g, p, isFish).length > 0,
    resolve: (g: Game, p: PID) => {
      const x = fromZoneSummon(g, p, P(g, p).hell, isFish);
      if (x && P(g, p).avatars.includes(x) && !landIs(g, BT_LAND)) x.asleep = true;
    },
  },
  'น้ำวนชักโครก': {
    keep: 4,
    react: {
      on: ['attack'],
      can: (g: Game, p: PID, c: Card, ev: Ev) => ev.actor !== p && !!ev.target && ev.target.ctrl === p && isBT(ev.target),
      want: (g: Game, p: PID, c: Card, ev: Ev) => beats(g, ev.source!, ev.target!),
      resolve: (g: Game, p: PID, c: Card, ev: Ev) => {
        ev.cancelled = true;
        for (const q of g.p) for (const a of q.avatars) if (a !== ev.source) a.asleep = !a.asleep;
      },
    },
  },
  'ปืนฉมวก': {
    keep: 2.5,
    canCast: (g: Game, p: PID) => P(g, p).avatars.some(isBT),
    modTarget: (g: Game, p: PID) => best(P(g, p).avatars.filter(isBT), (a) => (a.asleep ? 0 : 3) + power(g, a)),
    wearerBattle: (g: Game, m: Card, w: Card, other: Card) => {
      if (g.active === w.ctrl && other.asleep) { w.temp.push({ power: 1, until: 'battle' }); other.temp.push({ power: -1, until: 'battle' }); }
    },
  },
  'ตรีศูล ไตรตัน': {
    keep: 2.5,
    canCast: (g: Game, p: PID) => P(g, p).avatars.some(isBT),
    modTarget: (g: Game, p: PID) => worst(P(g, p).avatars.filter(isBT), (a) => value(g, a)),
    fieldActs: (g: Game, p: PID, m: Card) => [act('ตรีศูล: to hell, put บึงทมิฬ on the Land Zone', (g2) => inMain(g2, p) && m.wearer >= 0 && !P(g2, p).used.Land
      && P(g2, p).deck.some(btLand) && !landIs(g2, BT_LAND),
    (g2) => {
      const pl = P(g2, p);
      detach(g2, m); pl.hell.push(m);
      const l = best(pl.deck.filter(btLand), (x) => keepValue(g2, x)); // other-team audit: any Land named บึงทมิฬ (วิหารเจ้าสมุทร counts), the player picks
      if (l) setLand(g2, p, l);
      shuffle(g2, pl.deck);
    })],
  },
  'ประมาทร่วม': {
    keep: 2,
    canCast: (g: Game, p: PID) => P(g, p).deck.length > 10,
    resolve: (g: Game, p: PID) => { myMill(g, p, 3); mill(g, opp(p), 3); },
  },

  // ===== SD06 ค่ายบางระจัน =====
  'จัน หนวดเขี้ยว': {
    keep: 6, tieWin: true, noSteal: true, // can't change control: engine canChangeCtrl
    staticPower: (g: Game, c: Card) => (critical(P(g, c.ctrl)) ? 1 : 0),
    deathCry: (g: Game, c: Card, owner: PID) => {
      if (!camp(g, owner)) return;
      const pl = P(g, owner);
      if (!pl.hell.includes(c)) return;
      detach(g, c); pl.deck.push(c); shuffle(g, pl.deck); draw(g, owner, 1);
    },
  },
  'อิน สไนเปอร์': {
    keep: 3.5,
    kickIf: () => true,
    staticPower: (g: Game, c: Card) => (camp(g, c.ctrl) ? 2 : 0),
    onAttack: (g: Game, c: Card, t: Card | null) => {
      if (t !== null || P(g, opp(c.ctrl)).avatars.length === 0) return;
      const v = worst(P(g, c.ctrl).avatars.filter((a) => a !== c), (a) => value(g, a)) || c;
      destroy(g, v, c.ctrl);
    },
  },
  'ทองเหม็น ขวานคลั่ง': {
    keep: 4,
    onAttack: (g: Game, c: Card) => boost(c, 2),
    // (superseded in g6/g8: checked at the start of the Battle Phase, as the user ruled: "เปลี่ยนเป็นเช็คตอนเริ่มแบทเทิ้ลเฟส")
    startMain: (g: Game, c: Card) => { thongCheck(g, c); },
    onSummon: (g: Game, c: Card) => { thongCheck(g, c); },
  },
  'เมือง ช่างใหญ่': {
    keep: 4,
    jutsu: (g: Game, c: Card) => {
      const p = c.ctrl, pl = P(g, p);
      const k = pl.deck.find((x) => x.def.name === CAMP);
      if (!k || !canBuild(g, p, k) || pl.hand.length < 2) return;
      if (!discardWorst(g, p, 2)) return;
      build(g, p, k); shuffle(g, pl.deck);
    },
  },
  'พันเรือง ผู้พิทักษ์ไร้พ่าย': {
    keep: 4, shield: true,
    staticPower: (g: Game, c: Card) => (g.active !== c.ctrl ? 2 : 0),
    react: {
      on: ['destroy'], noLimit: true,
      can: (g: Game, p: PID, c: Card, ev: Ev) => !!ev.source && ev.source !== c && ev.source.ctrl === p && isBRJ(ev.source) && camp(g, p),
      want: (g: Game, p: PID, c: Card, ev: Ev) => value(g, ev.source!) > value(g, c) + 1,
      resolve: (g: Game, p: PID, c: Card, ev: Ev) => { if (destroy(g, c, p)) ev.cancelled = true; },
    },
  },
  'พ่อแท่น ผู้นำอาวุโส': {
    keep: 3,
    deathCry: (g: Game, c: Card, owner: PID) => peek(g, owner, 5, (top) => { takeHand(g, owner, top, (x) => isBRJ(x) && x.def.name !== 'พ่อแท่น ผู้นำอาวุโส'); }, 'shuffle'),
  },
  'อาจารย์ธรรมโชติ': { keep: 2 }, // approx: Constructs are never destroyed by effects in this engine, so its protection never triggers
  'บุญช่วย ควายรักชาติ': {
    keep: 3,
    fieldActs: (g: Game, p: PID, c: Card) => [act('บุญช่วย: be worn by an Avatar', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'boon:' + c.uid)
      && P(g2, p).avatars.some((a) => a !== c),
    (g2) => {
      markOnce(g2, P(g2, p), 'boon:' + c.uid);
      const w = best(P(g2, p).avatars.filter((a) => a !== c), (a) => (a.asleep ? 0 : 3) + power(g2, a));
      if (w && P(g2, p).avatars.includes(c)) { attach(g2, c, w); refreshTank(g2, w); }
    })],
    modPower: (g: Game, m: Card, w: Card) => (camp(g, w.ctrl) ? 2 : 1),
  },
  'ผู้นำของเหล่าวีรชน': {
    keep: 4,
    canCast: (g: Game, p: PID, c: Card) => P(g, p).hand.filter((x) => x !== c).length >= 2 && P(g, p).deck.some(isBRJ),
    resolve: (g: Game, p: PID) => { if (discardWorst(g, p, 2)) search(g, p, isBRJ, 'deck'); },
  },
  'วิญญาณวีรชน': {
    keep: 3.5,
    canCast: (g: Game, p: PID, c: Card) => P(g, p).hand.some((x) => x !== c) && hellAv(g, p, isBRJ).length > 0 && canPlaceAvatar(P(g, p)),
    resolve: (g: Game, p: PID) => {
      if (!discardWorst(g, p, 1)) return;
      const x = fromZoneSummon(g, p, P(g, p).hell, isBRJ, 'jutsu');
      if (x && P(g, p).avatars.includes(x)) x.f.endHell = g.turn + 1;
    },
  },
  'ปืนใหญ่ไทยประดิษฐ์': {
    keep: 4,
    react: {
      on: ['summon'],
      can: (g: Game, p: PID, c: Card, ev: Ev) => ev.actor !== p && P(g, p).avatars.some(isBRJ) && oppTargets(g, p, true).length > 0,
      want: (g: Game, p: PID) => {
        const mine = worst(P(g, p).avatars.filter(isBRJ), (a) => value(g, a));
        const t = oppTargets(g, p, true).reduce((m, a) => Math.max(m, value(g, a)), 0);
        return !!mine && t >= value(g, mine) + 2;
      },
      resolve: (g: Game, p: PID) => {
        const mine = worst(P(g, p).avatars.filter(isBRJ), (a) => value(g, a));
        const t = best(oppTargets(g, p, true), (a) => value(g, a));
        if (!mine) return;
        destroy(g, mine, p);
        if (t) destroy(g, t, p, true);
      },
    },
  },
  'ยันต์ผ้าประเจียด': {
    keep: 2.5,
    canCast: (g: Game, p: PID) => P(g, p).avatars.some(isBRJ),
    modTarget: (g: Game, p: PID) => best(P(g, p).avatars.filter(isBRJ), (a) => (hasKw(g, a, 'tieWin') ? 0 : 3) + power(g, a)),
    // v13: the wearer gains ลูกฮึด (keyword grant from the attached card)
    grant: (g: Game, s: Card, t: Card, kw: string) => kw === 'tieWin' && s.wearer === t.uid,
  },
  'ดาบใบข้าว X': {
    keep: 2.5,
    canCast: (g: Game, p: PID) => P(g, p).avatars.some(isBRJ),
    modTarget: (g: Game, p: PID) => best(P(g, p).avatars.filter(isBRJ), (a) => (a.asleep ? 0 : 3) + power(g, a)),
    onWearerKill: (g: Game, m: Card) => draw(g, m.owner, 1),
  },
  [CAMP]: {
    keep: 5,
    // approx: "when destroyed, send our Avatars to hell" is not modeled (Constructs are never destroyed)
    aura: (g: Game, s: Card, t: Card) => (t.ctrl === s.ctrl && P(g, s.ctrl).mz.includes(s) && isBRJ(t) ? 1 : 0),
    grant: (g: Game, s: Card, t: Card, kw: string) => (kw === 'shield' || kw === 'unite') && t.ctrl === s.ctrl && P(g, s.ctrl).mz.includes(s) && isBRJ(t),
  },
  // v14 ruling: every สอดแนม done by an ability of one of our Constructs (กำแพงด่านสุดท้าย, เรือรบโบราณ, ...) looks at 2 more
  // cards while this is in our Construct Zone (engine scoutBonus). กำแพงด่านสุดท้าย (g1, not via scoutDeck) still counts it itself.
  'วัดคู่บ้านคู่เมือง': {
    keep: 1.5,
    scoutBonus: (g: Game, self: Card, owner: PID, n: number, by: PID | null, src: Card | null) =>
      (by === self.ctrl && !!src && src !== self && src.def.type === 'Construct' && P(g, self.ctrl).mz.includes(src) && P(g, self.ctrl).mz.includes(self) ? 2 : 0),
  },
  'กำแพงด่านสุดท้าย': {
    keep: 2.5,
    // approx: checked at the start of our Main Phase (LIFE flipped since our last turn and our Avatar Zone is empty now)
    endPhase: (g: Game, c: Card) => { c.f.lifeSeen = flippedLife(P(g, c.ctrl)); },
    startMain: (g: Game, c: Card) => {
      const p = c.ctrl, pl = P(g, p);
      const seen = c.f.lifeSeen;
      c.f.lifeSeen = flippedLife(pl);
      if (seen === undefined || flippedLife(pl) <= seen || pl.avatars.length > 0 || pl.hand.length < 1 || !once(g, p, 'wall')) return;
      markOnce(g, pl, 'wall');
      if (!discardWorst(g, p, 1)) return;
      const n = 1 + 2 * pl.mz.filter((x) => x.def.name === 'วัดคู่บ้านคู่เมือง').length;
      const top = pl.deck.splice(0, n);
      for (const x of top) {
        if (isBRJ(x) && x.def.cost <= 4 && canPlaceAvatar(pl)) { pl.hell.push(x); if (summon(g, p, x, 'effect')) continue; detach(g, x); }
        if (!findCard(g, x.uid)) pl.hand.push(x);
      }
    },
  },

  // ===== SD07 ขุนพล =====
  'กวนอู ขุนพลภักดีแห่งจ๊กก๊ก': {
    keep: 5, tieWin: true, noSteal: true, // can't change control: engine canChangeCtrl
    // v14 ruling: at all times, the opponent's card abilities (Magic too) can't choose our other "ขุนพล" {ชาวต่างชาติ}
    // Avatars (FX.noTarget); effects that hit every Avatar without choosing still affect them
    noTarget: (g: Game, self: Card, t: Card, by: Card) => P(g, self.ctrl).avatars.includes(self) && t !== self && t.ctrl === self.ctrl
      && P(g, t.ctrl).avatars.includes(t) && isGen(t) && !t.def.name.includes('กวนอู') && by.ctrl !== self.ctrl,
  },
  'เตียวหุย ขุนพลจอมบุกแห่งจ๊กก๊ก': { keep: 4, onAttack: (g: Game, c: Card) => boost(c, 1) },
  'แฮหัวตุ้น ขุนพลตาเดียวแห่งวุยก๊ก': {
    keep: 4,
    // v14 ruling: works when summoned by the ability of any "ขุนพล" {ชาวต่างชาติ} Avatar (อ้วนเสี้ยว's จุติ, โจโฉ's จุติ /
    // อัตโนมัติ, ...): summonIf records the card whose ability is summoning it; then destroy 1 card on the field (mandatory)
    summonIf: (g: Game, p: PID, c: Card) => { const s0 = currentSource(); GEN_BY.set(c.uid, !!s0 && s0 !== c && isGen(s0)); return true; },
    onSummon: (g: Game, c: Card) => {
      if (!GEN_SUMMON && !GEN_BY.get(c.uid)) return;
      GEN_BY.delete(c.uid);
      const pool = [...g.p[0].avatars, ...g.p[1].avatars, ...g.p[0].mz, ...g.p[1].mz].filter((x) => x !== c && (isA(x) || x.def.type === 'Construct'));
      const t = best(pool, (a) => (a.ctrl === c.ctrl ? -10 - value(g, a) : value(g, a)));
      if (t) destroy(g, t, c.ctrl);
    },
  },
  'แฮหัวเอี๋ยน ขุนพลธนูแห่งวุยก๊ก': {
    keep: 3, // แทงหลัง: engine keyword (def.backstab)
    onSummon: (g: Game, c: Card) => { if (GEN_SUMMON) draw(g, c.ctrl, 1); },
  },
  'ซุนเกี๋ยน ขุนพลพยัคฆ์แห่งง่อก๊ก': {
    keep: 4, shield: true,
    deathCry: (g: Game, c: Card, owner: PID) => {
      const t = best(P(g, owner).avatars.filter(isGen), (a) => value(g, a));
      if (!t) return;
      // v14: +2 until the end of the opponent's next turn, for any set's ขุนพล (engine temp with a turn number)
      t.temp.push({ power: 2, until: g.active === owner ? g.turn + 1 : g.turn + 2 });
    },
  },
  // แทงหลัง is the engine keyword. "อัตโนมัติ เทิร์นละครั้ง เมื่อการ์ดใบนี้ใช้ แทงหลัง ให้ Avatar สีแดง: เปลี่ยนจากสภาพนอนเป็นสภาพตื่น"
  'ซุนเซ็ก ขุนพลไฟแรงแห่งง่อก๊ก': {
    keep: 3,
    onBackstab: (g: Game, c: Card, att: Card) => {
      if (!colorIs(att, 'แดง') || !once(g, c.ctrl, 'sunsek:' + c.uid)) return;
      markOnce(g, P(g, c.ctrl), 'sunsek:' + c.uid);
      c.asleep = false;
      log(g, `${c.def.name} stands back up (แทงหลัง for a red Avatar)`);
    },
  },
  'ลิโป้ ขุนพลเทพสงคราม': {
    keep: 8,
    grant: (g: Game, s: Card, t: Card, kw: string) => kw === 'shield' && t.ctrl !== s.ctrl && g.phase === 'Battle' && P(g, s.ctrl).avatars.includes(s),
    forceShield: true, // "เมื่อ Avatar ใบนี้โจมตี: ฝ่ายตรงข้ามจะต้องใช้ความสามารถ โล่มนุษย์ เสมอ"
    // "ในเทิร์นฝ่ายเรา เมื่อมีการเปลี่ยนเป้าหมายการโจมตี: สามารถทำลาย Avatar ฝ่ายตรงข้าม 1 ใบ" (a โล่มนุษย์ redirect)
    onShieldUsed: (g: Game, s: Card, sh: Card) => {
      if (g.active !== s.ctrl || !P(g, s.ctrl).avatars.includes(s)) return;
      const v = pickN(P(g, opp(s.ctrl)).avatars.filter((a) => a !== sh), 1, (a) => value(g, a), { optional: true, title: `${s.def.name}: you may destroy 1 opposing Avatar` })[0];
      if (v) destroy(g, v, s.ctrl);
    },
  },
  'อ้วนเสี้ยว ผู้นำขุนพล 18 หัวเมือง': {
    keep: 4, // แทงหลัง: engine keyword (def.backstab)
    jutsu: (g: Game, c: Card) => {
      const p = c.ctrl;
      peek(g, p, 3, (top) => {
        const x = best(top.filter(isGen), (y) => value(g, y));
        if (!x) return;
        if (colorIs(x, 'ฟ้า') && canPlaceAvatar(P(g, p)) && mayDo(g, x, 'summon it instead of taking it to hand', true)) {
          GEN_SUMMON = true;
          try { if (summonFromList(g, p, top, x)) return; } finally { GEN_SUMMON = false; }
        }
        if (top.includes(x)) { top.splice(top.indexOf(x), 1); P(g, p).hand.push(x); }
      }, 'shuffle');
    },
  },
  'ขุนศึกแบงค์ แซ่อู๋': { keep: 2.5 },
  'คำสาบานสวนท้อ': {
    keep: 4, options: 2,
    canCast: (g: Game, p: PID, c: Card, o: number) => {
      const mine = P(g, p).avatars.filter(isGen), deck = P(g, p).deck.filter(isGen);
      if (o === 0) return mine.some((a) => deck.some((x) => !x.def.only && x.def.color === a.def.color && x.def.name !== a.def.name));
      return oathPairColors(g, p).some((col) => deck.some((x) => x.def.only && colorIs(x, col)));
    },
    resolve: (g: Game, p: PID, c: Card, o: number) => {
      const pl = P(g, p);
      if (o === 0) {
        const a = best(pl.avatars.filter(isGen).filter((y) => pl.deck.some((x) => isGen(x) && !x.def.only && x.def.color === y.def.color && x.def.name !== y.def.name)), (y) => value(g, y));
        if (a) search(g, p, (x) => isGen(x) && !x.def.only && x.def.color === a.def.color && x.def.name !== a.def.name, 'deck');
      } else {
        const cols = oathPairColors(g, p).filter((cl) => pl.deck.some((x) => isGen(x) && x.def.only && colorIs(x, cl)));
        if (cols.length) search(g, p, (x) => isGen(x) && x.def.only && cols.some((cl) => colorIs(x, cl)), 'deck');
      }
    },
  },
  'ยืมมือสังหาร': {
    keep: 4,
    canCast: (g: Game, p: PID, c: Card) => P(g, p).avatars.some(isGen) && P(g, p).hand.some((x) => x !== c) && canPlaceAvatar(P(g, p))
      && P(g, opp(p)).avatars.some((a) => magicOk(g, p, a) && a.mods.some((m) => m.owner === opp(p))),
    resolve: (g: Game, p: PID) => {
      const t = best(P(g, opp(p)).avatars.filter((a) => magicOk(g, p, a) && a.mods.some((m) => m.owner === opp(p))), (a) => value(g, a));
      if (!t || !discardWorst(g, p, 1) || !canPlaceAvatar(P(g, p)) || !P(g, opp(p)).avatars.includes(t)) return;
      if (!takeControl(g, t, p)) return;
      t.asleep = false; t.kick = false; t.f.returnCtrl = g.turn;
      if (P(g, opp(p)).avatars.length === 0) t.f.noAttack = g.turn; // it can't attack LIFE
      log(g, `P${p} takes control of ${t.def.name} until end of turn`);
    },
  },
  'เสบียงหลวง': {
    keep: 3.5,
    canCast: (g: Game, p: PID) => P(g, p).deck.length > 3,
    resolve: (g: Game, p: PID) => {
      if (P(g, p).avatars.filter(isGen).length >= 2) draw(g, p, 2);
      else { draw(g, p, 1); draw(g, opp(p), 1); }
    },
  },
  'หนีคือยอดกลยุทธ์': {
    keep: 3.5,
    react: {
      on: ['attack'],
      can: (g: Game, p: PID, c: Card, ev: Ev) => ev.actor !== p && !!ev.target && ev.target.ctrl === p && P(g, p).avatars.includes(ev.target),
      want: (g: Game, p: PID, c: Card, ev: Ev) => beats(g, ev.source!, ev.target!) && value(g, ev.target!) >= 4,
      resolve: (g: Game, p: PID, c: Card, ev: Ev) => { const t = ev.target; if (t && P(g, p).avatars.includes(t)) toHand(g, t); },
    },
  },
  'ง้าวมังกรเขียว': {
    keep: 3,
    canCast: (g: Game, p: PID) => P(g, p).avatars.some(isGen),
    modTarget: (g: Game, p: PID) => best(P(g, p).avatars.filter(isGen), (a) => (a.def.name.includes('กวนอู') ? 2 : 0) + (a.asleep ? 0 : 3) + power(g, a)),
    modPower: (g: Game, m: Card, w: Card) => (w.def.name.includes('กวนอู') ? 2 : 1),
  },
  'ด่านเฮาโลก๋วน': {
    keep: 3,
    denyKw: (g: Game, s: Card, t: Card, kw: string) => kw === 'unite' && t.ctrl !== s.ctrl && P(g, s.ctrl).mz.includes(s), // "ฝ่ายตรงข้ามไม่สามารถใช้ สามัคคี"
    aura: (g: Game, s: Card, t: Card) => (t.ctrl === s.ctrl && P(g, s.ctrl).mz.includes(s) && isGen(t) && colorIs(t, 'ม่วง') ? 1 : 0),
  },

  // ===== SD08 รัททาทุย =====
  'ไพรมอล รัททาทุย': {
    keep: 7,
    fieldActs: (g: Game, p: PID, c: Card) => [act('ไพรมอล: summon a 1/1/1 รัททาทุย', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'primal')
      && canPlaceAvatar(P(g2, p)) && (P(g2, p).deck.some(rat111) || P(g2, p).hell.some(rat111)),
    (g2) => { markOnce(g2, P(g2, p), 'primal'); summonRat111(g2, p, 'both'); })],
    preventLeave: (g: Game, c: Card) => {
      const pl = P(g, c.ctrl);
      const rats = pl.hell.filter(isRat);
      if (!once(g, c.ctrl, 'primalStay') || rats.length < 5) return false;
      if (!mayDo(g, c, 'exile 5 รัททาทุย from Hell so it stays on the field', true)) return false;
      markOnce(g, pl, 'primalStay');
      for (const x of worstN(rats, 5, (y) => keepValue(g, y), { title: 'ไพรมอล: exile 5 รัททาทุย from Hell' })) toExile(g, x);
      log(g, 'ไพรมอล stays (exiled 5 รัททาทุย)');
      return true;
    },
    onAttack: (g: Game, c: Card) => {
      const f = worst(P(g, c.ctrl).avatars.filter((a) => a !== c && isRat(a) && (rat111(a) || a.token || value(g, a) < 4)), (a) => value(g, a));
      if (f && destroy(g, f, c.ctrl)) c.asleep = false;
    },
  },
  'รัททาทุย พาหะ': { keep: 1.5, battle: (g: Game, c: Card, other: Card) => { other.temp.push({ power: -1, until: RULE_GAME, src: c.uid }); } }, // v31 user ruling: POWER -1 permanently
  'รัททาทุย 2 แสนโวลต์': { keep: 2.5, unite: true },
  'โดมรัททาทุย': {
    keep: 2.5,
    fieldActs: (g: Game, p: PID, c: Card) => [act('โดม: sacrifice, build a รัททาทุย Construct from hand', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c)
      && P(g2, p).hand.some((x) => x.def.type === 'Construct' && symIs(x, 'รัททาทุย') && canBuild(g2, p, x)),
    (g2) => {
      const k = best(P(g2, p).hand.filter((x) => x.def.type === 'Construct' && symIs(x, 'รัททาทุย') && canBuild(g2, p, x)), (x) => x.def.cost);
      if (!k || !destroy(g2, c, p)) return;
      build(g2, p, k);
    })],
  },
  'รัททาทุยกินซาก': {
    keep: 2.5,
    fieldActs: (g: Game, p: PID, c: Card) => [act('กินซาก: exile รัททาทุย from hell, +1 each', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && !c.asleep && once(g2, p, 'scav:' + c.uid)
      && hellAv(g2, p, isRat).length > 0,
    (g2) => {
      markOnce(g2, P(g2, p), 'scav:' + c.uid);
      const seen = new Set<string>(); let n = 0;
      for (;;) {
        const x = pickN(hellAv(g2, p, (y) => isRat(y) && !seen.has(y.def.name)), 1, (y) => -keepValue(g2, y), { optional: true, title: `กินซาก: exile a รัททาทุย (different names, ${n} so far)` })[0];
        if (!x) break; seen.add(x.def.name); toExile(g2, x); n++;
      }
      boost(c, n);
    })],
  },
  'รัททาทุย พาราไซท์': { keep: 2.5, deathCry: (g: Game, c: Card, owner: PID) => { summonRat111(g, owner, 'deck'); } },
  'รัทาทุย หัวค้อน': {
    keep: 2.5,
    jutsu: (g: Game, c: Card) => { search(g, c.ctrl, (x) => x.def.type === 'Construct' && symIs(x, 'รัททาทุย'), 'hell'); },
  },
  'รัททาทุยโป๊': { keep: 2, shield: true },
  'ตุ๊กตารัททาทุย': {
    keep: 1,
    costOnlyFor: (s: Card) => isA(s) && symIs(s, 'รัททาทุย'),
    usedAsCost: (g: Game, p: PID, c: Card, s: Card) => { if (isA(s) && isRat(s)) summonRat111(g, p, 'deck'); },
  },
  'กรุงโรมใน 1 วัน': {
    keep: 3,
    canCast: (g: Game, p: PID) => P(g, p).hell.some((x) => x.def.type === 'Construct' && !x.def.only && x.def.cost <= 5 && canBuild(g, p, x)),
    resolve: (g: Game, p: PID) => {
      const pool = P(g, p).hell.filter((x) => x.def.type === 'Construct' && !x.def.only && x.def.cost <= 5 && canBuild(g, p, x));
      let pick: Card[] = [], bv = -1;
      for (let i = 0; i < pool.length; i++) {
        if (pool[i].def.cost > bv) { bv = pool[i].def.cost; pick = [pool[i]]; }
        for (let j = i + 1; j < pool.length; j++) {
          const s = pool[i].def.cost + pool[j].def.cost;
          if (s <= 5 && pool[i].def.name !== pool[j].def.name && s + 0.5 > bv) { bv = s + 0.5; pick = [pool[i], pool[j]]; }
        }
      }
      for (const k of pick) build(g, p, k);
    },
  },
  'แพร่พันธ์ุทันใจ': {
    keep: 3,
    canCast: (g: Game, p: PID, c: Card) => {
      const sum = P(g, p).hand.filter((x) => x !== c && isA(x) && isRat(x)).reduce((s, x) => s + x.def.cost, 0);
      return canPlaceAvatar(P(g, p)) && sum > 0 && P(g, p).deck.some((x) => isA(x) && isRat(x) && x.def.cost <= sum);
    },
    resolve: (g: Game, p: PID) => {
      const pl = P(g, p);
      const rats = pl.hand.filter((x) => isA(x) && isRat(x)).sort((a, b) => keepValue(g, a) - keepValue(g, b));
      const sum = rats.reduce((s, x) => s + x.def.cost, 0);
      const t = best(pl.deck.filter((x) => isA(x) && isRat(x) && x.def.cost <= sum), (x) => value(g, x));
      if (!t) return;
      let paid = 0;
      while (paid < t.def.cost) { const r = worst(pl.hand.filter((x) => isA(x) && isRat(x)), (x) => keepValue(g, x)); if (!r) break; discard(g, p, r); paid += r.def.cost; }
      if (canPlaceAvatar(pl)) summon(g, p, t, 'effect');
      shuffle(g, pl.deck);
    },
  },
  'รัททาท่วม': {
    keep: 3.5,
    // v14 ruling: answers after our {รัททาทุย} Avatar was destroyed (the 'destroyed' window, the Avatar is already in Hell):
    // summon 1 or 2 Cost 1 / GEM 1 / POWER 1 รัททาทุย from our Deck (the second is optional), then shuffle
    react: {
      on: ['destroyed'],
      can: (g: Game, p: PID, c: Card, ev: Ev) => !!ev.source && !!ev.leave && ev.leave.ctrl === p && ev.leave.zone === 'avatars' && isRat(ev.source)
        && canPlaceAvatar(P(g, p)) && P(g, p).deck.some(rat111),
      want: () => true,
      resolve: (g: Game, p: PID, c: Card) => {
        const first = summonRat111(g, p, 'deck');
        if (first && canPlaceAvatar(P(g, p)) && P(g, p).deck.some(rat111) && mayDo(g, c, 'summon a second 1/1/1 รัททาทุย', true)) summonRat111(g, p, 'deck');
      },
    },
  },
  'นวมรัททาทุย': {
    keep: 3,
    canCast: (g: Game, p: PID) => P(g, p).avatars.some(isRat),
    modTarget: (g: Game, p: PID) => best(P(g, p).avatars.filter(isRat), (a) => (a.asleep ? 0 : 3) + power(g, a)),
    modPower: (g: Game, m: Card, w: Card) => P(g, w.ctrl).avatars.filter(isRat).length,
  },
  'พิภพรัททาทุย': {
    keep: 2.5,
    // v14: while every Avatar on our zone is รัททาทุย, the 2 token slots can hold real รัททาทุย (engine canPlaceAvatar / ratSix);
    // when this Land leaves, the owner chooses Avatars to send to Hell down to 4 (engine zoneTrim in stateCheck).
    // +2 to our attacking รัททาทุย until the end of that fight (landAttack: the declared attacker only)
    canCast: (g: Game, p: PID) => P(g, p).avatars.some(isRat) && !landIs(g, 'พิภพรัททาทุย'),
    landAttack: (g: Game, l: Card, att: Card) => { if (att.ctrl === l.ctrl && isRat(att)) { att.temp.push({ power: 2, until: 'battle' }); log(g, `พิภพรัททาทุย: ${att.def.name} POWER +2 for this fight`); } },
  },
  'รังรักรัททาทุย': {
    keep: 3,
    // v14 ruling: "เมื่อการ์ดใบนี้ก่อสร้าง" works like จุติ: when built by paying its Cost from hand (engine runs a
    // Construct's jutsu for paid / จุติ builds). The once-per-turn สั่งใช้ works however it was built.
    jutsu: (g: Game, c: Card) => { summonRat111(g, c.ctrl, 'deck'); },
    fieldActs: (g: Game, p: PID, c: Card) => [
      act('รังรัก: summon a 1/1/1 รัททาทุย', (g2) => inMain(g2, p) && P(g2, p).mz.includes(c) && once(g2, p, 'nest') && canPlaceAvatar(P(g2, p)) && P(g2, p).deck.some(rat111),
        (g2) => { markOnce(g2, P(g2, p), 'nest'); summonRat111(g2, p, 'deck'); }),
    ],
  },
  'วงล้อรัททาทุย': { keep: 2, aura: (g: Game, s: Card, t: Card) => (t.ctrl === s.ctrl && P(g, s.ctrl).mz.includes(s) && rat111(t) ? 1 : 0) },
  'บ่อหมัก รัททาทุย': {
    keep: 1.5,
    usedAsCost: (g: Game, p: PID, c: Card, s: Card) => { if (isA(s) && isRat(s) && P(g, p).hell.includes(c)) build(g, p, c); },
    // v14 ruling: once per turn, right after our first {รัททาทุย} Avatar of the turn is destroyed: draw 1
    onAnyDestroyed: (g: Game, self: Card, gone: Card, info: any) => {
      const p = self.ctrl;
      if (!P(g, p).mz.includes(self) || info.ctrl !== p || info.zone !== 'avatars' || !isRat(gone) || !once(g, p, 'compost')) return;
      markOnce(g, P(g, p), 'compost'); log(g, `บ่อหมัก รัททาทุย: ${gone.def.name} was destroyed, draw 1`); draw(g, p, 1);
    },
  },
  'วานรกินซากลากอเวจี': {
    keep: 2,
    deathCry: (g: Game, c: Card, owner: PID) => { if (hellAv(g, owner, isVan).length >= 4) placeToken(g, owner, TOKEN_VANARA, 1); },
  },
  'วานรหมวกเหล็ก': {
    keep: 3,
    grant: (g: Game, s: Card, t: Card, kw: string) => kw === 'tieWin' && t.ctrl === s.ctrl && P(g, s.ctrl).avatars.includes(s) && isVan(t),
  },
  'วานร ซีซ่าสลัด': {
    keep: 3,
    deathCry: (g: Game, c: Card, owner: PID) => peek(g, owner, 3, (top) => {
      const x = best(top.filter((y) => isVan(y) && y.def.cost <= 4), (y) => value(g, y));
      if (x) summonFromList(g, owner, top, x);
    }, 'bottom'),
  },
  'หนุมานถวายแหวน': {
    keep: 4.5,
    canCast: (g: Game, p: PID, c: Card) => P(g, p).hand.some((x) => x !== c && isVanara(x)) && oppTargets(g, p, true).length > 0,
    resolve: (g: Game, p: PID) => {
      if (!discardWorst(g, p, 1, isVanara)) return;
      const t = best(oppTargets(g, p, true), (a) => value(g, a));
      if (t) destroy(g, t, p, true);
    },
  },
  'เลือกตั้งเจ้าป่า': {
    keep: 3.5,
    canCast: (g: Game, p: PID) => P(g, p).avatars.some(isVan) && P(g, p).deck.length > 3,
    resolve: (g: Game, p: PID) => {
      if (!sacrifice(g, p, P(g, p).avatars.filter(isVan), 1)) return;
      peek(g, p, 7, (top) => {
        const x = best(top.filter((y) => isVan(y) && y.def.cost <= 5), (y) => value(g, y));
        if (!x) return;
        if (x.def.name.includes('วานรเจ้าป่า') && canPlaceAvatar(P(g, p)) && mayDo(g, x, 'summon it instead', true) && summonFromList(g, p, top, x)) return;
        if (top.includes(x)) { top.splice(top.indexOf(x), 1); P(g, p).hand.push(x); }
      }, 'shuffle'); // v14 confirmed: the rest are shuffled back
    },
  },
  'ชีวิตเหนือหน้าที่': {
    keep: 4,
    react: {
      on: ['attack'],
      can: (g: Game, p: PID, c: Card, ev: Ev) => ev.actor !== p && !!ev.source && P(g, p).avatars.some(isVan),
      want: (g: Game, p: PID, c: Card, ev: Ev) => {
        const f = worst(P(g, p).avatars.filter(isVan), (a) => value(g, a));
        if (!f) return false;
        if (ev.target === null) return flippedLife(P(g, p)) >= 3;
        return beats(g, ev.source!, ev.target!) && (f === ev.target || value(g, ev.target!) >= value(g, f) + 2);
      },
      resolve: (g: Game, p: PID, c: Card, ev: Ev) => {
        const pref = ev.target && isVan(ev.target) && ev.target.ctrl === p && P(g, p).avatars.includes(ev.target) ? ev.target : null;
        const f = pref && beats(g, ev.source!, pref) ? pref : worst(P(g, p).avatars.filter(isVan), (a) => value(g, a));
        if (!f) return;
        const tok = f.token;
        toHand(g, f);
        if (!tok) { const pl = P(g, f.owner); const i = pl.hand.indexOf(f); if (i >= 0) { pl.hand.splice(i, 1); pl.deck.unshift(f); } }
        ev.cancelled = true;
      },
    },
  },
  'วานรร้อนรัก': {
    keep: 3,
    // v14 ruling: a React Magic (uses this turn's React), answered in the fight window of our fighting "วานร":
    // เซ่นไหว้ another of our วานร that is not fighting, then the fighting วานร gets POWER +2 until end of turn
    react: {
      on: ['fight'],
      can: (g: Game, p: PID, c: Card, ev: Ev) => {
        const mine = ev.target;
        return !!mine && !!ev.source && mine.ctrl === p && isVan(mine) && P(g, p).avatars.includes(mine) && P(g, p).avatars.some((a) => a !== mine && isVan(a));
      },
      want: (g: Game, p: PID, c: Card, ev: Ev) => {
        const mine = ev.target!, other = ev.source!;
        return !beats(g, mine, other) && power(g, mine) + 2 > power(g, other);
      },
      resolve: (g: Game, p: PID, c: Card, ev: Ev) => {
        const mine = ev.target!;
        if (!sacrifice(g, p, P(g, p).avatars.filter((a) => a !== mine && isVan(a)), 1)) return;
        if (P(g, p).avatars.includes(mine)) boost(mine, 2);
      },
    },
  },
};

// ---------- helpers used by the entries above ----------
function setLand(g: Game, p: PID, c: Card) {
  if (g.land !== c) placeLand(g, p, c);
  P(g, p).used.Land = true;
  log(g, `${c.def.name} is put on the Land Magic Zone`);
}
function kentRoll(g: Game, c: Card) {
  const p = c.ctrl;
  if (!P(g, p).avatars.includes(c) || !once(g, p, 'kent:' + c.uid)) return;
  if (!P(g, p).avatars.some((a) => a !== c && isBT(a))) return;
  markOnce(g, P(g, p), 'kent:' + c.uid);
  const r = d6(g);
  log(g, `คุณเค้นท์ rolls ${r}`);
  if (r % 2 === 1) c.asleep = false;
}
function thongCheck(g: Game, c: Card) {
  if (g.active === c.ctrl && P(g, opp(c.ctrl)).avatars.length === 0 && !camp(g, c.ctrl)) c.f.noAttack = g.turn;
}
function guanyu(g: Game, c: Card) {
  for (const a of P(g, c.ctrl).avatars) if (isGen(a) && !a.def.name.includes('กวนอู')) a.magicImmuneUntil = Math.max(a.magicImmuneUntil, g.turn + 1);
}
function oathPairColors(g: Game, p: PID) {
  const mine = P(g, p).avatars.filter(isGen);
  const cols: string[] = [];
  for (const col of new Set(mine.map((a) => a.def.color))) if (distinct(mine.filter((a) => colorIs(a, col))) >= 2) cols.push(col);
  return cols;
}

// Timed POWER bonus for this group's Avatars ("until end of the opponent's next turn"): c.f.g1p while g.turn <= c.f.g1pUntil.
for (const f of Object.values(NEW)) {
  const sp = f.staticPower;
  f.g1t = true;
  f.staticPower = (g: Game, c: Card) => (sp ? sp(g, c) : 0) + ((c.f.g1pUntil || 0) >= g.turn ? (c.f.g1p || 0) : 0);
}

Object.assign(FX, NEW);

// other-team audit Q9 (user: a cancelled Magic keeps its text costs paid): the "cost :" part is paid before the React window
costFirst('ความยุติธรรมสำหรับนนทก', (g, p) => discardWorst(g, p, 1, isTheos), (g, p) => { draw(g, p, 2); });
costFirst('ระเบิดVery Fat Man', (g, p) => payTrio(g, p), (g, p) => { for (const a of [...P(g, opp(p)).avatars]) destroy(g, a, p, true); },
  (g, p) => payTrio(g, p), (g, p) => { for (const a of [...P(g, opp(p)).avatars]) destroy(g, a, p, true); });
costFirst('บำเพ็ญประโยชน์', (g, p) => discardWorst(g, p, 1, (x) => isGHN(x) && isA(x)), (g, p) => { draw(g, p, 2); });
costFirst('สละเพื่อนเพื่อช่วยเพื่อน', (g, p) => payOneGHN(g, p), (g, p) => bounceAny(g, p, null),
  (g, p) => payOneGHN(g, p), (g, p, c, ev) => bounceAny(g, p, ev.source));
costFirst('กระทะทองแดง', (g, p) => discardWorst(g, p, 1, isHellSym), (g, p) => { myMill(g, p, 2); draw(g, p, 2); });
costFirst('ยืมมือสังหาร', (g, p) => discardWorst(g, p, 1), (g, p) => {
  const t = best(P(g, opp(p)).avatars.filter((a) => magicOk(g, p, a) && a.mods.some((m) => m.owner === opp(p))), (a) => value(g, a));
  if (!t || !canPlaceAvatar(P(g, p)) || !P(g, opp(p)).avatars.includes(t)) return;
  if (!takeControl(g, t, p)) return;
  t.asleep = false; t.kick = false; t.f.returnCtrl = g.turn;
  if (P(g, opp(p)).avatars.length === 0) t.f.noAttack = g.turn; // it can't attack LIFE
  log(g, `P${p} takes control of ${t.def.name} until end of turn`);
});
costFirst('หนุมานถวายแหวน', (g, p) => discardWorst(g, p, 1, isVanara), (g, p) => {
  const t = best(oppTargets(g, p, true), (a) => value(g, a));
  if (t) destroy(g, t, p, true);
});
