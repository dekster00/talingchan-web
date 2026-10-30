// Card effects for BT04, BT05 (cards not coded in cards.ts / cards2.ts).
import { rollDie } from '../engine.ts';
import type { Card, Def, Game, PID } from '../types.ts';
import type { Ev } from '../engine.ts';
import { canChangeCtrl, takeControl, grantKw, landIs as landOn, isLandOn, placeLand, magicImmune, currentSource, lands, useShield } from '../engine.ts';
import type { Fx, HandAct } from '../cards.ts';
import { FX, value, best, worst, pickN, worstN, mayDo, chooseMode, oppChoice, oppTargets, sacrifice, search, inMain, cancel } from '../cards.ts';
import { costFirst } from '../cards.ts'; // other-team audit Q9
import { emit, askChoose, addPower } from '../engine.ts'; // bugfix1; bugfix4: addPower
import {
  P, opp, power, draw, destroy, toHell, toHand, discard, detach, summon, shuffle, mill,
  nameHas, canPlaceAvatar, critical, onceUsed, markOnce, keepValue, log, findCard, fx, rand,
  silenced, gemOf, hasKw, castMagic,
  symIs, symAny, colorIs, scoutDeck, putBottom, silenceFull, summonExact, colorsEn, arrangeTopBottom, decide, humanDeciding
} from '../engine.ts';
import { flipLifeCard, currentFight, RULES, addRule, costOf, critical as isCritical, flippedLife } from '../engine.ts';
import { setName, addNote, swapCostPower } from '../view.ts';
import { toExile, toDeck as toDeckE, canWear as canWearE, lifeDown } from '../engine.ts';
import { askPick, abilityAllowed } from '../engine.ts'; // superair
import { readFileSync } from 'node:fs'; // cards19: DECK_TO_HAND_NAMES

// ---------- helpers (copies of the cards2.ts ones, which are not exported) ----------
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
const d6 = (g: Game) => rollDie(g); // emits the 'roll' event
function boost(c: Card, n: number) { c.temp.push({ power: n, until: 'turn' }); }
// สอดแนม / look at the top n: engine scoutDeck() reveals them, lets the human pick and order the rest
function peek(g: Game, p: PID, n: number, pick: (cs: Card[]) => void, rest: 'bottom' | 'shuffle' | 'hell' | 'top' | 'either' = 'shuffle') {
  scoutDeck(g, p, n, pick, rest);
}
// summon from a peeked list (the cards are out of every zone while peeked)
function takeSummon(g: Game, p: PID, list: Card[], pred: (c: Card) => boolean, how: 'jutsu' | 'effect' = 'effect', max = 1) {
  let n = 0;
  const pool = [...list].filter((x) => isA(x) && pred(x));
  while (n < max && canPlaceAvatar(P(g, p))) {
    const c = max > 1 ? pickN(pool, 1, (x) => value(g, x), { optional: true })[0] || null : best(pool, (x) => value(g, x)); // human picks inside scouts
    if (!c) break;
    pool.splice(pool.indexOf(c), 1);
    list.splice(list.indexOf(c), 1);
    c.f.viaScout = 1; P(g, p).hell.push(c); // somewhere findable for summon()
    if (summon(g, p, c, how)) n++;
  }
  return n;
}
function takeHand(g: Game, p: PID, list: Card[], pred: (c: Card) => boolean) {
  const c = best(list.filter(pred), (x) => keepValue(g, x) + x.def.power * 0.3);
  if (c) { list.splice(list.indexOf(c), 1); P(g, p).hand.push(c); }
  return c;
}
// เจนนี่ อย่าบู้บี้เลขา: nobody can summon from hell (only enforced by this file's effects)
const JENNY = 'เจนนี่ อย่าบู้บี้เลขา';
const hellLocked = (g: Game) => g.p.some((q) => q.avatars.some((a) => a.def.name === JENNY && !silenced(g, a)));
function fromZoneSummon(g: Game, p: PID, zone: Card[], pred: (c: Card) => boolean, how: 'jutsu' | 'effect' = 'effect') {
  if (zone === P(g, p).hell && hellLocked(g)) return null;
  const c = best(zone.filter((x) => isA(x) && pred(x)), (x) => value(g, x));
  if (c && canPlaceAvatar(P(g, p)) && summon(g, p, c, how)) return c;
  return null;
}
function attach(g: Game, c: Card, w: Card): boolean {
  if (!canChangeCtrl(g, c, w.ctrl)) { log(g, `${c.def.name}: its control can't be changed (รูปประจำบ้าน)`); return false; }
  if (!canWearE(g, c, w)) { log(g, `${w.def.name} can't wear ${c.def.name}`); return false; } // v14d: central wear check
  detach(g, c);
  c.asleep = false; c.temp = []; c.wearer = w.uid; c.ctrl = w.ctrl;
  w.mods.push(c);
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
const modToHell = (g: Game, m: Card) => { detach(g, m); m.wearer = -1; P(g, m.owner).hell.push(m); };
// an opponent's card that refuses to leave (หนุมาน etc.)
function stays(g: Game, by: PID, a: Card) {
  const f = fx(a);
  return a.ctrl !== by && !!(f && f.preventLeave && !silenced(g, a) && f.preventLeave(g, a));
}
// put an Avatar on the field into its owner's Deck (bottom or shuffled)
function toDeck(g: Game, by: PID, a: Card, where: 'bottom' | 'shuffle') {
  if (stays(g, by, a)) return false;
  restorePlane(a);
  toHell(g, a);
  const pl = P(g, a.owner); const i = pl.hell.indexOf(a);
  if (i >= 0) { pl.hell.splice(i, 1); pl.deck.push(a); }
  if (where === 'shuffle') shuffle(g, pl.deck);
  return true;
}
const dogcat = (x: Card) => isA(x) && symIs(x, 'สัตว์') && (nameHas(x, 'หมา') || nameHas(x, 'แมว'));
const seer = (x: Card) => isA(x) && named(x, 'ผู้รู้ความจริง');
const tank = (x: Card) => isA(x) && named(x, 'รถถัง');
const purpleGod = (x: Card) => isA(x) && symIs(x, 'เทพ') && colorIs(x, 'ม่วง');
const PLANE = 'เครื่องบิน Super Air';
const hasPlane = (g: Game, p: PID) => P(g, p).avatars.some((a) => a.def.name === PLANE);
const PASSENGER = 'ผู้โดยสาร Super Air';
const OLDMAN = 'คนแก่สติเลอะเลือนผู้รู้ความจริง';
// คนแก่สติเลอะเลือน: summoned when scried by a ผู้รู้ความจริง Avatar
function oldManTrigger(g: Game, p: PID, list: Card[]) {
  for (const x of list.filter((y) => y.def.name === OLDMAN)) takeSummon(g, p, list, (y) => y === x);
}
// พอดี: paid with GEM exactly equal to the Cost. The payment is the newest cards in our hell.
function exactPaid(g: Game, c: Card) { return !!c.f.exact; } // engine sets f.exact when GEM paid == Cost
// scry and arrange: good cards back on top, the rest at the bottom
function arrange(g: Game, p: PID, cs: Card[], title = 'สอดแนม') {
  // the owner chooses top / bottom and the order (bot: keepValue >= 3.5 on top, best first)
  arrangeTopBottom(g, p, [...cs].sort((a, b) => keepValue(g, b) - keepValue(g, a)), title, (x) => keepValue(g, x) >= 3.5);
}
function frogUps(g: Game, a: Card) {
  // v14 ruling: count the POWER-ups still in effect (each temp / permanent bonus / Modification counts once), not +3 POWER at once
  return a.temp.filter((t) => t.power > 0).length + (a.bonus > 0 ? Math.max(1, a.f.ups || 0) : 0) + a.mods.filter((m) => (fx(m)?.modPower?.(g, m, a) || 0) > 0).length;
}
// เครื่องบิน Super Air turns into an Avatar; it is a Magic card again once it leaves the field.
function restorePlane(c: Card) { const o = (c.def as any).orig as Def | undefined; if (o) c.def = o; }
function subsetSums(costs: number[]) {
  let s = new Set<number>([0]);
  for (const k of costs) { const n = new Set(s); for (const v of s) n.add(v + k); s = n; }
  return s;
}
const isPrime = (n: number) => { if (n < 2) return false; for (let i = 2; i * i <= n; i++) if (n % i === 0) return false; return true; };
// fighters of a 'fight' event from p's point of view: [ours, theirs]
function fighters(p: PID, ev: Ev): [Card, Card] | null {
  const a = ev.source, b = ev.target;
  if (!a || !b) return null;
  if (a.ctrl === p && b.ctrl !== p) return [a, b];
  if (b.ctrl === p && a.ctrl !== p) return [b, a];
  return null;
}
function fightResult(g: Game, mine: Card, theirs: Card, dMine = 0, dTheirs = 0) {
  const a = Math.max(0, power(g, mine) + dMine), b = Math.max(0, power(g, theirs) + dTheirs);
  if (a > b) return 1;
  if (a < b) return -1;
  const ta = hasKw(g, mine, 'tieWin'), tb = hasKw(g, theirs, 'tieWin');
  return ta && !tb ? 1 : tb && !ta ? -1 : 0;
}
// Cards whose text takes cards from the Deck to the hand (generated from data/cards.json effect text), for เหน็บกินมือ.
const DECK_TO_HAND = new Set(('BT01-003 BT01-006 BT01-008 BT01-019 BT01-021 BT02-005 BT02-011 BT02-019 BT02-025 BT03-042 BT03-057 ' +
  'BT04-026 BT04-031 BT04-046 BT05-024 BT05-031 BT05-036 BT05-056 BT05-060 BT06-040 BT06-045 BT07-005 BT07-023 BT07-027 ' +
  'BT07-029 BT07-039 BT07-057 BT08-016 BT08-024 BT09-039 BT09-056 BT10-003 BT10-005 BT10-013 BT10-021 BT10-044 BT10-054 ' +
  'BT10-057 BT11-047 BT11-049 CC01-008 CC01-010 CC01-023 CC01-032 CC01-049 CC02-006 CC02-010 CC02-033 CC02-056 FPRO-003 ' +
  'KD01-015 KD02-016 KD03-002 KD03-014 KD04-017 ODY1-001 ODY1-002 ODY1-003 ODY1-011 ODY1-017 ODY1-033 PRMO-060 PRMO-064 ' +
  'PRMO-065 PRMO-066 PRMO-067 PRMO-101 PRMO-107 PRMO-108 SD02-001 SD02-002 SD02-003 SD03-017 SD06-012 SD07-013 SD08-013 SL01-007').split(' '));
const EXTRA_SEARCHERS = new Set(['ฮันโซ นินจาในตำนาน', 'เลือกมันสำหรับพวก จน !!!', 'มีมมิจัง ไอดอล No.1', 'สุวรรณ', 'เลอร์ติ๊ก สหายอัศวินตลิ่งชัน',
  'คุณเชิดชัย Super Air', 'แมว-น้ำมะลิ', 'พูดไทยได้ 5 คำ', 'จาบับวา', 'น้องสาม ผู้รู้ความจริง', 'ลูกเขยบิ๊ก', 'ทหารเวรคลังแสง', 'กระเป๋าเครื่องบิน Super Air']);
// cards19: same name = same card: every print of a listed card counts (the print list is turned into names)
const DECK_TO_HAND_NAMES = new Set<string>();
try {
  for (const c of JSON.parse(readFileSync(new URL('../../data/cards.json', import.meta.url), 'utf8'))) if (DECK_TO_HAND.has(c.code)) DECK_TO_HAND_NAMES.add(c.name);
} catch { /* prints only */ }
const searches = (c: Card) => DECK_TO_HAND.has(c.def.print) || DECK_TO_HAND_NAMES.has(c.def.name) || EXTRA_SEARCHERS.has(c.def.name);

// ---------- the cards ----------
const G3: Record<string, Fx> = {
  // ===== BT04 =====
  'ครูสงบ กล้ามโต': {
    keep: 3.5,
    onAttack: (g, c) => {
      const o = opp(c.ctrl);
      const mods = g.p.flatMap((q) => q.avatars).flatMap((a) => a.mods).filter((m) => m.owner === o);
      const m = pickN(mods, 1, (x) => keepValue(g, x), { optional: true, title: 'ครูสงบ: you may destroy 1 opposing Modification Magic' })[0]; // bugs7 item 7: "สามารถ" = optional
      if (m) { log(g, `ครูสงบ destroys ${m.def.name}`); modToHell(g, m); }
    },
  },
  'ไอ้นัท - คนใจเด็ด': { keep: 2.5, noSteal: true, noStealExcept: 'อีช่า - สาวน้อยคนเก่ง' } as Fx, // can't change control: checked by the engine's canChangeCtrl / takeControl
  'ยายกบ 1954': {
    keep: 2, noHandSummon: true,
    // v14: "received POWER-up 3+ times" = 3+ POWER-ups still in effect (temp / permanent bonus / Modifications)
    handActs: (g, p, c) => [act('ยายกบ: send a powered-up กบ to hell, summon', (g2) => inMain(g2, p) && P(g2, p).hand.includes(c)
      && P(g2, p).avatars.some((a) => isA(a) && nameHas(a, 'กบ') && frogUps(g2, a) >= 3),
    (g2) => {
      const fr = best(P(g2, p).avatars.filter((a) => isA(a) && nameHas(a, 'กบ') && frogUps(g2, a) >= 3), (a) => power(g2, a));
      if (!fr) return;
      const pw = power(g2, fr); toHell(g2, fr);
      if (summon(g2, p, c, 'own') && P(g2, p).avatars.includes(c)) c.bonus += pw;
    })],
  },
  'แบงค์ทีสต้า นักมวยปล้ำ': { keep: 2.5, unite: true },
  'ราม และ วิโรจน์': {
    keep: 4,
    // v14: "#... Symbol สัตว์ ด้วย" = Def.syms (sim.ts hashStats): symIs / the detail box see สัตว์ too
    staticPower: (g, c) => ((c.f.ramUntil || 0) >= g.turn ? 2 : 0),
    fieldActs: (g, p, c) => [
      act('ราม และ วิโรจน์: +2 until opponent End Phase', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'ram:' + c.uid),
        (g2) => { markOnce(g2, P(g2, p), 'ram:' + c.uid); c.f.ramUntil = g2.turn + 1; }),
      act('ราม และ วิโรจน์: equip a Modification from hell', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'ram:' + c.uid)
        && !P(g2, p).used.Modification && P(g2, p).hell.some((x) => x.def.type === 'Magic' && x.def.subtype === 'Modification' && !fx(x)?.zeroKills),
      (g2) => {
        const pl = P(g2, p); markOnce(g2, pl, 'ram:' + c.uid);
        const m = best(pl.hell.filter((x) => x.def.type === 'Magic' && x.def.subtype === 'Modification' && !fx(x)?.zeroKills),
          (x) => (fx(x)?.modPower?.(g2, x, c) || 0) * 2 + keepValue(g2, x));
        if (!m) return;
        pl.used.Modification = true;
        attach(g2, m, c); fx(m)?.onAttach?.(g2, m, c);
      }),
    ],
  },
  'ลูกคนรวย': { keep: 3, staticPower: (g, c) => P(g, opp(c.ctrl)).hand.length },
  'เอเลี่ยนทูตดาวอังคาร': {
    keep: 3.5,
    fieldActs: (g, p, c) => {
      const sums = (g2: Game) => subsetSums(P(g2, p).hand.filter((x) => x.def.type === 'Avatar').map((x) => x.def.cost));
      return [act('เอเลี่ยนทูต: reveal Avatars, destroy matching POWER', (g2) => {
        if (!inMain(g2, p) || !P(g2, p).avatars.includes(c) || !once(g2, p, 'alien:' + c.uid)) return false;
        const s = sums(g2);
        return P(g2, opp(p)).avatars.some((a) => s.has(power(g2, a)));
      }, (g2) => {
        markOnce(g2, P(g2, p), 'alien:' + c.uid);
        const s = sums(g2);
        const t = best(P(g2, opp(p)).avatars.filter((a) => s.has(power(g2, a))), (a) => value(g2, a));
        if (t) destroy(g2, t, p);
        const give = worst(P(g2, p).hand, (x) => keepValue(g2, x));
        if (give) { detach(g2, give); P(g2, opp(p)).hand.push(give); }
      })];
    },
  },
  'มาวิน เซียนเบ็ด': {
    keep: 3,
    jutsu: (g, c) => {
      const p = c.ctrl, pl = P(g, p);
      const fod = pl.hand.filter((x) => isA(x) && (symIs(x, 'แมลง') || named(x, 'เหยื่อ')));
      if (!fod.length || hellLocked(g) || !hellAvatars(g, p, (x) => symIs(x, 'ปลา')).length || !canPlaceAvatar(pl)) return;
      const d = worst(fod, (x) => keepValue(g, x)); if (d) discard(g, p, d);
      fromZoneSummon(g, p, pl.hell, (x) => symIs(x, 'ปลา'));
    },
  },
  'บึงทมิฬ  People - คุณดีไมส์ (ปลาดาบ)': {
    keep: 4,
    onKill: (g, c) => {
      if (!landOn(g, 'บึงทมิฬ') || g.active !== c.ctrl || !c.asleep || P(g, c.ctrl).hand.length < 2) return;
      if (mayDo(g, c, 'discard 1 card to wake it up', true) && discardWorst(g, c.ctrl, 1)) { c.asleep = false; log(g, 'คุณดีไมส์ wakes up'); } // bugs7 item 7: "สามารถ" = optional
    },
  },
  'ริกกี้ คุณตา': {
    keep: 4,
    onSummon: (g, c) => { c.magicImmuneUntil = 1e9; },
    drawPhase: (g, c) => { c.magicImmuneUntil = 1e9; },
    protectSelf: (g, c, by, viaMagic) => viaMagic && by !== null && by !== c.ctrl,
  },
  'หมานมเย็น': {
    keep: 3.5,
    jutsu: (g, c) => { const pl = P(g, c.ctrl); fromZoneSummon(g, c.ctrl, pl.deck, (x) => dogcat(x) && x.def.cost <= 2); shuffle(g, pl.deck); },
  },
  'รัททาทุย 2 หัว': {
    keep: 3, shield: true,
    // v14 ruling: "destroyed in battle" = destroyed by the opponent during the Battle Phase, not by Magic.
    // POWER 0 -> destroy itself whatever caused it: zeroKills (engine stateCheck after every action / effect / fight).
    zeroKills: true,
    protectSelf: (g, c, by, viaMagic) => {
      if (viaMagic || by === null || by === c.ctrl || g.phase !== 'Battle' || !once(g, c.ctrl, 'rat2:' + c.uid)) return false;
      if (!mayDo(g, c, 'POWER -1 so it is not destroyed', power(g, c) > 1)) return false;
      markOnce(g, P(g, c.ctrl), 'rat2:' + c.uid); c.bonus -= 1; log(g, 'รัททาทุย 2 หัว: POWER -1, not destroyed');
      if (power(g, c) <= 0) return false; // POWER 0: it is destroyed anyway
      return true;
    },
    afterFight: (g, c) => zeroSelf(g, c),
  },
  [OLDMAN]: {
    keep: 5,
    // v14 ruling: summoned when scouted by ANY "ผู้รู้ความจริง" Avatar's ability (FX.onScouted; mandatory)
    onScouted: (g: Game, c: Card, p: PID, by: PID | null, src: Card | null) => {
      if (!src || !seer(src) || findCard(g, c.uid)) return;
      const pl = P(g, p);
      if (!canPlaceAvatar(pl, false, c)) return;
      c.f.viaScout = 1; pl.hell.push(c); // findable for summon(), which takes it from there
      if (!summon(g, p, c, 'own')) { const i = pl.hell.indexOf(c); if (i >= 0) pl.hell.splice(i, 1); delete c.f.viaScout; }
      else log(g, `${c.def.name} is summoned (scouted by ${src.def.name})`);
    },
    fieldActs: (g, p, c) => [act('คนแก่สติเลอะเลือน: draw 1', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'oldman') && P(g2, p).deck.length > 3,
      (g2) => { markOnce(g2, P(g2, p), 'oldman'); draw(g2, p, 1); })],
  },
  'น้องสาม ผู้รู้ความจริง': {
    keep: 3.5,
    onAttack: (g, c) => {
      const p = c.ctrl, pl = P(g, p);
      scoutDeck(g, p, 2, (top) => {
        // other-team audit Q4 (user): the POWER stays (adds up on every attack) until ขวานเงิน is equipped on it
        const n = top.filter(seer).reduce((s, x) => s + x.def.power, 0);
        if (n) c.temp.push({ power: n, until: 1e9, src: c.uid, samP: 1 } as any);
        oldManTrigger(g, p, top);
        const t = pickN(top.filter(seer), 1, (x) => keepValue(g, x), { optional: true })[0];
        if (t && top.includes(t)) { top.splice(top.indexOf(t), 1); pl.hand.push(t); }
      }, 'either', 'น้องสาม');
    },
  },
  'รปภ ผู้รู้ความจริง': {
    keep: 3,
    jutsu: (g, c) => {
      const p = c.ctrl; draw(g, p, 1);
      const x = worst(P(g, p).hand, (y) => keepValue(g, y));
      if (x) { detach(g, x); P(g, p).deck.unshift(x); }
    },
  },
  'วิไลวรรณ แม่แบงค์': {
    keep: 0.5,
    usedAsCost: (g, p, c, s) => {
      if (!colorIs(s, 'ม่วง')) return;
      // bugfix1 item 12 (user): show the scouted card and let the owner choose top or Hell (was a silent bot pick)
      const pl = P(g, p); const top = pl.deck[0];
      if (!top) return;
      const msg = `P${p} วิไลวรรณ แม่แบงค์: สอดแนม 1 = ${top.def.name}`;
      log(g, msg);
      emit(g, { ev: 'reveal', who: p, cards: [{ uid: top.uid, print: top.def.print, name: top.def.name }], s: msg });
      const k = decide(g, p, () => askChoose(g, `วิไลวรรณ แม่แบงค์: สอดแนม 1 = ${top.def.name}`, ['Keep on top of Deck · ไว้บนสุดของ Deck', 'Send to Hell · ส่งลงนรก'], keepValue(g, top) < 3 ? 1 : 0));
      if (k === 1 && pl.deck[0] === top) { pl.deck.shift(); pl.hell.push(top); emit(g, { ev: 'mill', who: p, uid: top.uid, print: top.def.print, name: top.def.name, i: 1, n: 1 }); }
    },
  },
  'นายนิรยบาล หมอ': {
    keep: 4,
    jutsu: (g, c) => {
      const p = c.ctrl;
      if (P(g, p).hand.length < 1 || !discardWorst(g, p, 1)) return;
      mill(g, p, 3);
      fromZoneSummon(g, p, P(g, p).hell, (x) => symIs(x, 'นรก') && x.def.cost <= 4 && x !== c);
    },
  },
  'ครูแกง สอนเลข': {
    keep: 3.5,
    jutsu: (g, c) => {
      const hit = g.p.map((q) => isPrime(q.avatars.reduce((s, a) => s + power(g, a), 0)));
      for (const q of [0, 1] as PID[]) if (hit[q]) for (const a of [...P(g, q).avatars]) destroy(g, a, c.ctrl);
    },
  },
  'ลูกเขยบิ๊ก': {
    keep: 3,
    jutsu: (g, c) => {
      const pred = (x: Card) => x.def.type === 'Magic' && nameHas(x, 'แผนการ');
      if (P(g, c.ctrl).deck.some(pred)) search(g, c.ctrl, pred, 'deck'); else search(g, c.ctrl, pred, 'hell');
    },
  },
  'ผู้งมงาย': { keep: 2.5, jutsu: (g, c) => { draw(g, c.ctrl, 1); discardWorst(g, c.ctrl, 1); } },
  'เสามงคล ทรงโรมัน': {
    keep: 3,
    onSummon: (g, c) => { c.f.noAttack = g.turn; },
    drawPhase: (g, c) => { c.f.noAttack = g.turn; },
    endPhase: (g, c) => { fromZoneSummon(g, c.ctrl, P(g, c.ctrl).hell, (x) => named(x, 'ผู้เจริญ')); },
  },
  'มาติเนซ Tank Ranger': {
    keep: 3,
    fieldActs: (g, p, c) => [act('มาติเนซ: equip to รถถัง', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'martinez:' + c.uid) && P(g2, p).avatars.some(tank),
      (g2) => { markOnce(g2, P(g2, p), 'martinez:' + c.uid); const t = best(P(g2, p).avatars.filter(tank), (a) => value(g2, a)); if (t) attach(g2, c, t); })],
    // v14 ruling: a Magic of EITHER player that chooses the รถถัง wearing this card: we are asked (React-style popup)
    // whether to destroy this card to cancel it ('targeted' window: the Magic's pick is cancelled).
    react: {
      on: ['targeted'], noLimit: true,
      can: (g, p, c, ev) => !!ev.source && ev.source.def.type === 'Magic' && !!ev.target && ev.target.uid === c.wearer && tank(ev.target) && ev.target.mods.includes(c),
      want: (g, p, c, ev) => ev.actor !== p, // bot: only against the opponent's Magic
      resolve: (g, p, c, ev) => {
        const w = ev.target; if (!w || !w.mods.includes(c)) return;
        if (!destroyMod(g, c)) return;
        ev.cancelled = true; log(g, `มาติเนซ is destroyed: ${ev.source!.def.name}'s effect on ${w.def.name} is cancelled`);
      },
    },
  },
  'ทหารเวรคลังแสง': {
    keep: 3,
    fieldActs: (g, p, c) => [act('ทหารเวรคลังแสง: search ปืนเล็กยาว', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'armory') && P(g2, p).deck.some((x) => x.def.name === 'ปืนเล็กยาว'),
      (g2) => { markOnce(g2, P(g2, p), 'armory'); search(g2, p, (x) => x.def.name === 'ปืนเล็กยาว', 'deck'); })],
  },
  'พลปืนอาณาจักรของแพง': { keep: 2.5, kickIf: (g, c) => P(g, c.ctrl).avatars.some((a) => nameHas(a, 'พระเจ้านิโคไล')) },
  'เจ้าของร้านอาบน้ำสัตว์': {
    keep: 3.5, shield: true,
    fieldActs: (g, p, c) => {
      const fod = (x: Card) => (isA(x) && named(x, 'พนักงานอาบน้ำสัตว์')) || symIs(x, 'สัตว์');
      return [act('ร้านอาบน้ำสัตว์: discard, สัตว์ +1', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'petshop')
        && P(g2, p).hand.some(fod) && P(g2, p).avatars.some((a) => symIs(a, 'สัตว์')),
      (g2) => {
        markOnce(g2, P(g2, p), 'petshop');
        const d = worst(P(g2, p).hand.filter(fod), (x) => keepValue(g2, x)); if (!d) return; discard(g2, p, d);
        const t = best(P(g2, p).avatars.filter((a) => symIs(a, 'สัตว์')), (a) => power(g2, a) + (a.asleep ? 0 : 2)); if (t) t.bonus += 1;
      })];
    },
  },
  'อนงค์ พนักงานอาบน้ำสัตว์': {
    keep: 2.5,
    deathCry: (g, c, owner) => { fromZoneSummon(g, owner, P(g, owner).hell, (x) => dogcat(x) && x.def.cost <= 3); },
  },
  'แฟรงกี้ พนักงานอาบน้ำสัตว์': {
    keep: 1,
    usedAsCost: (g, p, c, s) => {
      if (!dogcat(s)) return;
      const t = best(P(g, p).avatars.filter((a) => symIs(a, 'สัตว์')), (a) => power(g, a) + (a.asleep ? 0 : 2)); if (t) boost(t, 2);
    },
  },
  'ล้มโต๊ะ': {
    keep: 3,
    resolve: (g) => {
      for (const q of g.p) { q.deck.push(...q.hand.splice(0)); shuffle(g, q.deck); }
      for (const q of [g.active, opp(g.active)] as PID[]) draw(g, q, 4);
    },
  },
  'Grand Rumble !!!!': {
    keep: 2,
    canCast: (g) => g.p[0].avatars.length + g.p[1].avatars.length === 6,
    resolve: (g, p) => {
      const all = [...g.p[0].avatars, ...g.p[1].avatars]; // the numbering is arbitrary: one random Avatar survives
      shuffle(g, all);
      const keep = all[d6(g) - 1];
      log(g, `Grand Rumble: ${keep ? keep.def.name : 'none'} survives`);
      for (const a of all) if (a !== keep) destroy(g, a, p, true);
    },
  },
  'แผนการ : ถอยรถชน': {
    keep: 3.5,
    // v14 ruling (confirmed): there is no เครื่องจักร symbol in the card data, so หุ่นยนต์ counts as a machine
    canCast: (g, p) => P(g, p).avatars.some(machine) && oppTargets(g, p, true).length > 0,
    resolve: (g, p) => {
      if (!sacrifice(g, p, P(g, p).avatars.filter(machine), 1)) return;
      const t = best(oppTargets(g, p, true), (a) => value(g, a)); if (t) destroy(g, t, p, true);
    },
  },
  'บีมมมมมมมมมม': {
    keep: 5,
    canCast: (g, p) => P(g, p).hand.length >= 2 && oppTargets(g, p, true).length > 0,
    resolve: (g, p) => {
      if (!discardWorst(g, p, 1)) return;
      const t = best(oppTargets(g, p, true), (a) => value(g, a)); if (t) destroy(g, t, p, true);
    },
  },
  'ใครเจ๋งกว่า !': {
    keep: 2,
    canCast: (g, p, c) => P(g, p).hand.some((x) => x !== c && (x.def.type === 'Avatar' || x.def.type === 'Construct')),
    resolve: (g, p) => {
      const pick = (q: PID) => {
        const cs = P(g, q).hand.filter((x) => x.def.type === 'Avatar' || x.def.type === 'Construct');
        return cs.length ? cs.reduce((a, b) => (b.def.cost > a.def.cost || (b.def.cost === a.def.cost && keepValue(g, b) < keepValue(g, a)) ? b : a)) : null;
      };
      const a = pick(p), b = pick(opp(p));
      if (!a || !b) return; // the side without one only reveals its hand
      if (a.def.cost < b.def.cost) discard(g, p, a);
      else if (b.def.cost < a.def.cost) discard(g, opp(p), b);
      else for (const [q, x] of [[p, a], [opp(p), b]] as [PID, Card][]) { detach(g, x); P(g, q).deck.push(x); shuffle(g, P(g, q).deck); }
    },
  },
  'ความจริงงงงงงง': {
    keep: 2.5,
    canCast: (g, p) => P(g, p).avatars.some(seer) && P(g, p).deck.length > 1,
    resolve: (g, p) => {
      const pl = P(g, p); const x = best(pl.deck, (y) => keepValue(g, y));
      shuffle(g, pl.deck);
      if (x) { pl.deck.splice(pl.deck.indexOf(x), 1); pl.deck.unshift(x); }
    },
  },
  'เอาไปอยู่ด้วย': {
    keep: 4,
    react: {
      on: ['destroy'],
      can: (g, p, c, ev) => !!ev.source && ev.source.ctrl === p && symIs(ev.source, 'ผี') && oppTargets(g, p, true).length > 0,
      want: () => true,
      resolve: (g, p) => { const t = best(oppTargets(g, p, true), (a) => value(g, a)); if (t) destroy(g, t, p, true); },
    },
  },
  'ลดราคาล้นตลาด': {
    keep: 2.5, mainUse: true,
    // v14 ruling (confirmed): as a React it answers the opponent's attack / Magic / ability while both sides have Modifications
    canCast: (g, p) => P(g, p).avatars.some((a) => a.mods.length > 0) && P(g, opp(p)).avatars.some((a) => a.mods.length > 0),
    resolve: (g, p) => saleBoth(g, p),
    react: {
      on: ['attack', 'magic', 'ability'],
      can: (g, p, c, ev) => ev.actor !== p && P(g, p).avatars.some((a) => a.mods.length > 0) && P(g, opp(p)).avatars.some((a) => a.mods.length > 0),
      want: (g, p) => P(g, opp(p)).avatars.flatMap((a) => a.mods).some((m) => keepValue(g, m) >= 3),
      resolve: (g, p) => saleBoth(g, p),
    },
  },
  'กลับหลังหัน !!!': {
    keep: 3.5,
    react: {
      on: ['fight'],
      can: (g, p, c, ev) => !!fighters(p, ev),
      want: (g, p, c, ev) => { const f = fighters(p, ev)!; return swapChoice(g, f[0], f[1]) !== null; },
      resolve: (g, p, c, ev) => {
        const f = fighters(p, ev); if (!f) return;
        const x = swapChoice(g, f[0], f[1]); if (!x) return;
        swapCostPower(g, x, 'battle'); // v14 ruling: Cost and POWER swap until the end of that fight (shown in the detail box)
      },
    },
  },
  'อาวุธหุ่นนักรบผู้กล้า " ไบโพล่า ชิลด์ "': {
    keep: 3,
    // v14 ruling: เครื่องจักร = หุ่นยนต์ too. Any way of leaving caused by an opponent's card (destroy, hand, hell, exile,
    // deck; not control changes) -> roll; several attached copies roll together; once a copy rolled it can't be used again.
    canCast: (g, p) => P(g, p).avatars.some(braveBot),
    modTarget: (g, p) => best(P(g, p).avatars.filter(braveBot), (a) => value(g, a)),
    leaveGuard: (g, self, t, info) => bipolaGuard(g, self, t, info),
  },
  'ดาบพิฆาตสวรรค์ ราคา 4000 เหรียญทอง': {
    keep: 2.5,
    // v14 ruling (correct): Cost +2 feeds the POWER +1 condition and is shown in the wearer's detail box only
    canCast: (g, p) => P(g, p).avatars.length > 0,
    modTarget: (g, p) => best(P(g, p).avatars, (a) => value(g, a) + (costOf(g, p, a) + 2 >= 6 ? 3 : 0)),
    modPower: (g, m, w) => (costOf(g, w.ctrl, w) + 2 >= 6 ? 1 : 0),
    viewNote: (g, self, t) => (t.mods.includes(self) ? `Cost +2 (ดาบพิฆาตสวรรค์): Cost ${costOf(g, t.ctrl, t) + 2}` : null),
  } as Fx,
  'ปืนเล็กยาว': {
    keep: 3.5,
    canCast: (g, p) => P(g, p).avatars.some(rifleOk),
    modTarget: (g, p) => best(P(g, p).avatars.filter(rifleOk), (a) => value(g, a) + (a.asleep ? 0 : 2)),
    modPower: () => 3,
  },
  'สมาคมผู้รู้ความจริง': {
    keep: 2.5,
    canCast: (g, p) => !g.land || g.land.owner !== p,
    // v14 ruling: สั่งใช้ in our Main Phase (once per turn, needs our ผู้รู้ความจริง Avatar): scout 3, then choose which go on
    // top / under the Deck and their order (arrangeTopBottom)
    fieldActs: (g, p, c) => [act('สมาคมผู้รู้ความจริง: scout 3, arrange top / bottom', (g2) => inMain(g2, p) && isLandOn(g2, c) && once(g2, p, 'seerland')
      && P(g2, p).avatars.some(seer) && P(g2, p).deck.length > 0,
    (g2) => { markOnce(g2, P(g2, p), 'seerland'); scoutDeck(g2, p, 3, () => {}, 'either', 'สมาคมผู้รู้ความจริง'); })],
  },
  // v14 ruling: face-up LIFE of both players can't be turned face down (engine v14d blockLifeDown / lifeDown)
  'โรงบาลรัฐ': { keep: 1.5, canCast: (g, p) => !g.land || g.land.owner !== p, blockLifeDown: (g: Game, land: Card) => isLandOn(g, land) } as Fx,

  // ===== BT05 =====
  'กุ่ย นักเอาตัวรอด': {
    keep: 3,
    onSummon: (g, c, how) => { if (how === 'paid' && exactPaid(g, c)) c.f.exact = 1; },
    protectSelf: (g, c, by) => {
      if (!c.f.exact || by === c.ctrl || P(g, c.ctrl).hand.length < 1) return false;
      discardWorst(g, c.ctrl, 1); log(g, 'กุ่ย discards to survive');
      return true;
    },
  },
  'แมลงปอนางพญา': {
    keep: 6,
    costOf: (g, p, c) => Math.max(0, c.def.cost - hellAvatars(g, p, (x) => named(x, 'แมลงปอ')).length),
    staticPower: (g, c) => g.p.reduce((s, q) => s + q.avatars.filter((a) => a !== c && named(a, 'แมลงปอ')).length, 0),
    fieldActs: (g, p, c) => {
      const pairs = (g2: Game) => P(g2, p).avatars.filter((a) => a !== c && named(a, 'แมลงปอ') && hellAvatars(g2, p, (x) => named(x, 'แมลงปอ') && x.def.name !== a.def.name).length > 0);
      return [act('แมลงปอนางพญา: sacrifice a แมลงปอ, summon another from hell', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'dfqueen') && !hellLocked(g2) && pairs(g2).length > 0,
        (g2) => {
          markOnce(g2, P(g2, p), 'dfqueen');
          const s = worst(pairs(g2), (a) => value(g2, a)); if (!s) return;
          const nm = s.def.name; destroy(g2, s, p);
          fromZoneSummon(g2, p, P(g2, p).hell, (x) => named(x, 'แมลงปอ') && x.def.name !== nm, 'jutsu');
        })];
    },
  },
  'เทพารักษ์งมขวาน': {
    keep: 3,
    fieldActs: (g, p, c) => [act('เทพารักษ์: ขวาน from hell', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'axe') && P(g2, p).hell.some(axe),
      (g2) => { markOnce(g2, P(g2, p), 'axe'); search(g2, p, axe, 'hell'); })],
  },
  'หมาแพนดี้': {
    keep: 3, shield: true, unite: true,
    staticPower: (g, c) => (c.asleep ? P(g, c.ctrl).avatars.filter((a) => a !== c && dogcat(a)).length : 0),
  },
  'สหายหุ่นผู้กล้า โฟเบีย': {
    keep: 3.5,
    jutsu: (g, c) => {
      const p = c.ctrl, pl = P(g, p);
      const need = ['เก๊าท์', 'ไดบาเรีย', 'แอร์ซิด'].map((k) => worst(pl.hell.filter((x) => isA(x) && x.def.name.includes(k)), (x) => keepValue(g, x)));
      if (need.some((x) => !x) || !pl.deck.some((x) => isA(x) && nameHas(x, 'ไมเกรน') && x.def.cost <= 5)) return;
      for (const x of need) { detach(g, x!); pl.deck.push(x!); }
      const m = fromZoneSummon(g, p, pl.deck, (x) => nameHas(x, 'ไมเกรน') && x.def.cost <= 5);
      shuffle(g, pl.deck);
      if (m && pl.avatars.includes(m) && pl.avatars.includes(c)) attach(g, c, m);
    },
    modPower: () => 1,
  },
  'โจอี้ นักบอลขาหัก': { keep: 0.5, usedAsCost: (g, p, c, s) => { if (colorIs(s, 'แดง')) boost(s, 1); } },
  'น้องส้ม ชู้วันชัย': { keep: 0.5, usedAsCost: (g, p, c, s) => { if (symIs(s, 'เปรต')) s.magicImmuneUntil = Math.max(s.magicImmuneUntil, g.turn + 1); } },
  'น้องนาว ชู้วันชัย': {
    keep: 2.5,
    costOf: (g, p, c) => (P(g, p).avatars.some((a) => symIs(a, 'เปรต')) ? 0 : c.def.cost),
    // never flips the last face-down LIFE (that would make us สาหัส)
    fieldActs: (g, p, c) => [act('น้องนาว: flip up to 2 LIFE face up', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'naw') && P(g2, p).life.filter((l) => !l.faceUp).length > 1,
      (g2) => {
        const pl = P(g2, p); markOnce(g2, pl, 'naw');
        const down = pl.life.filter((l) => !l.faceUp);
        // "up to 2": the human chooses how many (the bot never flips the last face-down one)
        const maxN = Math.min(2, down.length);
        const botN = Math.min(2, down.length - 1);
        const labels = Array.from({ length: maxN + 1 }, (_, i) => `Flip ${maxN - i} LIFE`);
        const n = maxN - chooseMode(g2, c, labels, maxN - botN);
        for (const l of down.slice(0, n)) { l.faceUp = true; (l as any).naw = g2.turn; }
        if (n > 0) { RULES['น้องนาว'] ||= nawRule(); addRule(g2, { p, key: 'น้องนาว', until: g2.turn }); }
      })],
    // v14 ruling: the LIFE flipped by this go back face down at the end of the turn even if น้องนาว left the field
    // (delayed trigger: RULES['น้องนาว'].endPhase; its own End Phase hook as a fallback). Q&A: not when we are in
    // สาหัส (all LIFE face up) then, and not while โรงบาลรัฐ is in play.
    endPhase: (g, c) => nawBack(g, c.ctrl),
  },
  [JENNY]: { keep: 3 }, // approx: the hell-summon lock is only respected by this file's effects
  'ของขวัญที่เมียทิ้งไว้ให้': {
    keep: 2,
    handActs: (g, p, c) => [act('ของขวัญ: free summon', (g2) => inMain(g2, p) && P(g2, p).hand.includes(c) && canPlaceAvatar(P(g2, p))
      && P(g2, p).avatars.some((a) => a.def.name === 'เจค นักฆ่ามือเก๋า') && !P(g2, p).avatars.some((a) => a.def.name === c.def.name),
    (g2) => { summon(g2, p, c, 'own'); })],
  },
  'บึงทมิฬ  People - คุณเงือกมาวิน': {
    keep: 4,
    jutsu: (g, c) => {
      const p = c.ctrl;
      const back = worst(P(g, p).avatars.filter((a) => a !== c && symIs(a, 'ปลา')), (a) => value(g, a));
      if (!back || !toDeck(g, p, back, 'bottom')) return;
      peek(g, p, 5, (top) => { takeSummon(g, p, top, (x) => symIs(x, 'ปลา'), 'effect', 2); }, 'bottom');
    },
  },
  'นีโม่ นรกสเลเยอร์': { keep: 3, onAttack: (g, c, t) => { if (t && symIs(t, 'นรก')) destroy(g, t, c.ctrl); } },
  'แมว-น้ำมะลิ': {
    keep: 3,
    jutsu: (g, c) => peek(g, c.ctrl, 3, (top) => {
      const p = c.ctrl;
      const x = best(top.filter(dogcat), (y) => (y.def.name === 'หมานมเย็น' ? 3 : 0) + keepValue(g, y));
      if (!x) return;
      if (x.def.name === 'หมานมเย็น' && canPlaceAvatar(P(g, p))) takeSummon(g, p, top, (y) => y === x, 'jutsu');
      else { top.splice(top.indexOf(x), 1); P(g, p).hand.push(x); }
    }),
  },
  'มีมมิ ผู้ร่วงหล่น': {
    keep: 3,
    jutsu: (g, c) => { if (P(g, c.ctrl).avatars.some((a) => a.def.name === 'แดรกคูลา')) search(g, c.ctrl, (x) => x.def.name === 'ปราสาทแดรก', 'deck'); },
  },
  'เฟรย่า แม่ทุกสถาบันแอสการ์ด': {
    keep: 3,
    // พอดี: only when paid with exactly its Cost (the engine sets f.exact when GEM paid == Cost)
    onSummon: (g, c, how) => {
      if (how !== 'paid' || !exactPaid(g, c)) return;
      const pl = P(g, c.ctrl);
      for (const x of worstN(hellAvatars(g, c.ctrl, purpleGod), 3, (y) => value(g, y), { title: 'เฟรย่า: return 3 purple เทพ from Hell to Deck' })) { detach(g, x); pl.deck.push(x); }
      shuffle(g, pl.deck); draw(g, c.ctrl, 1);
    },
  },
  'เฮล่า เทพแอสการ์ดแห่งความตาย': {
    keep: 4,
    fieldActs: (g, p, c) => [act('เฮล่า: mill, เทพ สีม่วง +X', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'hela') && P(g2, p).deck.length > 10,
      (g2) => {
        markOnce(g2, P(g2, p), 'hela');
        const maxN = Math.min(5, P(g2, p).deck.length - 1), botN = Math.max(0, Math.min(5, P(g2, p).deck.length - 10));
        const k = chooseMode(g2, c, Array.from({ length: maxN + 1 }, (_, i) => `ธรณีสูบ ${maxN - i}`), maxN - Math.min(botN, maxN)); // "up to 5"
        const n = mill(g2, p, maxN - k).length;
        const t = best(P(g2, p).avatars.filter(purpleGod), (a) => power(g2, a) + (a.asleep ? 0 : 3)); if (t) boost(t, n);
      })],
    // v14 ruling: only when a purple เทพ Avatar's ability milled it (MillInfo.src), with แอสการ์ด as the Land and our purple
    // เทพ on the Avatar Zone: we may summon it at once (free). Same when it is added to the hand by a purple เทพ (โอดิน).
    onMilled: (g, c, p, v, info) => {
      if (!info || !info.src || !purpleGod(info.src) || !helaOk(g, p) || !P(g, p).hell.includes(c) || hellLocked(g)) return;
      if (mayDo(g, c, 'summon it from Hell (milled by a purple เทพ)', true)) summon(g, p, c, 'own');
    },
    onToHand: (g: Game, c: Card, from: string, by: PID | null, src: Card | null) => {
      const p = c.owner;
      if (!src || !purpleGod(src) || !P(g, p).hand.includes(c) || !helaOk(g, p)) return;
      if (mayDo(g, c, 'summon it from hand (added to hand by a purple เทพ)', true)) summon(g, p, c, 'own');
    },
  },
  'บรุนฮิลด์  เทพธิดาแห่งวัลฮัลลา': {
    keep: 2.5,
    // v14 ruling: two cases: (1) milled while a Magic is resolving, (2) milled by a purple เทพ Avatar's ability (ซีกรุน,
    // ซีเกิร์ด, เฮล่า, โอดิน ...). "สามารถ": we may summon it from Hell.
    onMilled: (g, c, p, v, info) => {
      if (!valkMill(info) || !P(g, p).hell.includes(c) || hellLocked(g) || !canPlaceAvatar(P(g, p))) return;
      if (mayDo(g, c, 'summon it from Hell', true)) summon(g, p, c, 'own');
    },
  },
  'Ecycle': {
    keep: 3,
    fieldActs: (g, p, c) => [act('Ecycle: discard 1, recycle 1, draw 1', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'ecycle') && P(g2, p).hand.length >= 1,
      (g2) => {
        const pl = P(g2, p); markOnce(g2, pl, 'ecycle');
        if (!discardWorst(g2, p, 1)) return;
        const x = best(pl.hell, (y) => keepValue(g2, y)); if (x) { detach(g2, x); pl.deck.push(x); }
        draw(g2, p, 1);
      })],
  },
  'จาบับวา': {
    keep: 3,
    deathCry: (g, c, owner) => peek(g, owner, 5, (top) => { takeHand(g, owner, top, (x) => x.def.type === 'Avatar' && symIs(x, 'คน')); }, 'bottom'),
  },
  'หมาชาไทย': {
    keep: 2.5,
    fieldActs: (g, p, c) => [act('หมาชาไทย: return a สัตว์, +2', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'chathai:' + c.uid)
      && P(g2, p).avatars.some((a) => a !== c && !a.token && symIs(a, 'สัตว์')),
    (g2) => {
      markOnce(g2, P(g2, p), 'chathai:' + c.uid);
      const b = worst(P(g2, p).avatars.filter((a) => a !== c && !a.token && symIs(a, 'สัตว์')), (a) => value(g2, a) - (FX[a.def.name]?.jutsu ? 2 : 0));
      if (b) { toHand(g2, b); c.bonus += 2; }
    })],
  },
  'ทัตดนัยซัง โปรดิวเซอร์มือทอง': {
    keep: 5, shield: true,
    // v14 ruling: the taken Avatar is attached to our ไอดอล and renamed "โอตะ" (only that card; shown in its detail box)
    onSummon: (g, c, how) => {
      if (how !== 'paid' || !exactPaid(g, c)) return;
      const p = c.ctrl;
      const idol = best(onZone(g, p, 'ไอดอล'), (a) => value(g, a));
      const t = best(P(g, opp(p)).avatars.filter((a) => canChangeCtrl(g, a, p)), (a) => value(g, a));
      if (idol && t && !stays(g, p, t)) { log(g, `${t.def.name} becomes โอตะ on ${idol.def.name}`); attach(g, t, idol); if (idol.mods.includes(t)) setName(g, t, 'โอตะ'); }
      if (P(g, p).avatars.some((a) => a.def.name.includes('มยุราซัง'))) search(g, p, (x) => isA(x) && named(x, 'ไอดอล'), 'deck');
    },
  },
  'เจ๊หมวย เจ้าของร้านหม่าล่า': {
    keep: 2.5,
    onAttack: (g, c) => addPower(g, c, 3, 'perm', c), // bugfix4 (user): no duration in the text: it stays
    onTargeted: (g, c) => addPower(g, c, -3, 'perm', c),
  },
  'ลุงไนท์ ราชาวานร': {
    keep: 4.5,
    jutsu: (g, c) => peek(g, c.ctrl, 5, (top) => { takeSummon(g, c.ctrl, top, (x) => nameHas(x, 'วานร') && x.def.cost <= 4); }, 'bottom'),
    hellActs: (g, p, c) => [act('ลุงไนท์: revive from hell', (g2) => inMain(g2, p) && P(g2, p).hell.includes(c) && !hellLocked(g2) && canPlaceAvatar(P(g2, p))
      && P(g2, p).hand.length >= 1 && P(g2, p).avatars.filter((a) => nameHas(a, 'วานร')).length >= 3,
    (g2) => { if (discardWorst(g2, p, 1)) summon(g2, p, c, 'effect'); })],
  },
  'วานรช่องแชท': { keep: 3, aura: (g, s, t) => (t !== s && t.ctrl === s.ctrl && nameHas(t, 'วานร') && P(g, s.ctrl).avatars.includes(s) ? 1 : 0) },
  'คุณเชิดชัย Super Air': {
    keep: 3.5,
    jutsu: (g, c) => peek(g, c.ctrl, 5, (top) => {
      takeHand(g, c.ctrl, top, (x) => x.def.name === PLANE || x.def.name === 'รหัสดำ');
      takeHand(g, c.ctrl, top, (x) => x.def.type === 'Avatar' && named(x, 'Super Air') && symIs(x, 'คน'));
    }, 'bottom'),
  },
  'กระเป๋าเครื่องบิน Super Air': {
    keep: 2.5,
    fieldActs: (g, p, c) => [act('กระเป๋า: search ตั๋วยืน', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'bag') && P(g2, p).deck.some((x) => x.def.name === 'ตั๋วยืน'),
      (g2) => { markOnce(g2, P(g2, p), 'bag'); search(g2, p, (x) => x.def.name === 'ตั๋วยืน', 'deck'); })],
  },
  'หมาเครื่องบิน Super Air': { keep: 2.5, kickIf: (g, c) => hasPlane(g, c.ctrl) },
  'ผู้โดยสาร Super Air': {
    keep: 1.5,
    // ต่อเนื่อง: can't be chosen as an attack target while our เครื่องบิน Super Air is on our Avatar Zone
    untargetable: (g, c) => hasPlane(g, c.ctrl) && P(g, c.ctrl).avatars.includes(c),
    // superair (user 2026-10-25): สั่งใช้ when our เครื่องบิน Super Air would be destroyed by a fight or a card ability, destroy
    // a ผู้โดยสาร Super Air on the field instead. One popup (Skip = no); several passengers: choose which. Bot: always yes.
    leaveGuard: (g, self, t, info) => {
      if (t.def.name !== PLANE || t.ctrl !== self.ctrl || info.how !== 'destroy' || info.cost || !(info.battle || info.src)) return null;
      const pl = P(g, self.ctrl);
      if (!pl.avatars.includes(t) || !pl.avatars.includes(self) || !abilityAllowed(g, self.ctrl, self)) return null;
      const pas = pl.avatars.filter((a) => a.def.name === PASSENGER && !silenced(g, a) && abilityAllowed(g, self.ctrl, a));
      if (!pas.length || pas[0] !== self) return null; // the first passenger speaks for all of them
      return {
        optional: false,
        run: () => {
          const bot = pas.reduce((b, a) => (value(g, a) < value(g, b) ? a : b)); // bot: always yes, the least useful passenger (no ask)
          const x = humanDeciding(g)
            ? askPick(pas, bot, { optional: true, title: `${PASSENGER}: destroy it instead of ${PLANE}?` })
            : bot;
          if (!x || !pl.avatars.includes(x)) return false;
          log(g, `${PASSENGER} is destroyed instead of ${PLANE}`);
          destroy(g, x, self.ctrl, false, { cost: true });
          return !pl.avatars.includes(x);
        },
      };
    },
  },
  'วานรแบงค์': { keep: 2.5, tieWin: true },
  'จ่ายุทธ Tank Ranger': {
    keep: 3,
    jutsu: (g, c) => {
      if (!P(g, c.ctrl).avatars.some(tank)) return;
      const t = best(P(g, opp(c.ctrl)).avatars.filter((a) => symIs(a, 'ต่างชาติ')), (a) => value(g, a)); if (t) destroy(g, t, c.ctrl);
    },
    fieldActs: (g, p, c) => [act('จ่ายุทธ: equip to รถถัง', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'yut:' + c.uid) && P(g2, p).avatars.some(tank),
      (g2) => { markOnce(g2, P(g2, p), 'yut:' + c.uid); const t = best(P(g2, p).avatars.filter(tank), (a) => value(g2, a)); if (t) attach(g2, c, t); })],
    wearerBattle: (g, m, w, other) => { if (tank(w) && symIs(other, 'ต่างชาติ') && toDeck(g, w.ctrl, other, 'bottom')) log(g, `${other.def.name} goes under the Deck`); },
  },
  'อาจารย์หลี ปรมาจารย์มวยจีน': {
    keep: 3.5,
    onAttack: (g, c) => boost(c, 1),
    react: {
      on: ['attack'], noLimit: true, onceKey: 'อาจารย์หลี',
      can: (g, p, c, ev) => ev.actor !== p && !!ev.source && ev.target !== c && P(g, p).avatars.includes(c),
      want: (g, p, c, ev) => {
        const a = power(g, ev.source!), me = power(g, c);
        return me > a || (me === a && (ev.target === null || power(g, ev.target!) < a));
      },
      resolve: (g, p, c, ev) => { if (P(g, p).avatars.includes(c)) { ev.target = c; log(g, 'อาจารย์หลี takes the attack'); } },
    },
  },
  'รับซื้อของโจร': {
    keep: 3, stayMz: true,
    // v14 ruling: the taken card can only be paid as GEM for summoning an Avatar: it can't be summoned, cast or used
    // (timed rule 'รับซื้อของโจร' on its uid), and RuleDef.pay refuses it as GEM for anything but an Avatar (ability
    // discard costs are not checked: approx).
    canCast: (g, p) => P(g, opp(p)).hand.length > 0,
    resolve: (g, p, c) => {
      const oh = P(g, opp(p)).hand; if (!oh.length) return;
      const x = oh[Math.floor(rand(g) * oh.length)];
      detach(g, x); P(g, p).hand.push(x); c.f.loot = x.uid;
      RULES['รับซื้อของโจร'] ||= {
        label: 'รับซื้อของโจร: the stolen card can only be paid as GEM for an Avatar',
        summon: (g2: Game, r: any, y: Card) => y.uid !== r.n, cast: (g2: Game, r: any, y: Card) => y.uid !== r.n, ability: (g2: Game, r: any, y: Card) => y.uid !== r.n,
      };
      (RULES['รับซื้อของโจร'] as any).pay = (g2: Game, r: any, y: Card, forCard: Card) => y.uid !== r.n || isA(forCard);
      addRule(g, { p, key: 'รับซื้อของโจร', until: g.turn, n: x.uid, name: x.def.name });
      if (x.owner !== p) addRule(g, { p: x.owner, key: 'รับซื้อของโจร', until: g.turn, n: x.uid, name: x.def.name }); // RuleDef.pay reads the card owner's rules
      addNote(g, x, 'รับซื้อของโจร: ใช้ได้แค่เป็น Cost เพื่ออัญเชิญ Avatar', g.turn);
    },
    endPhase: (g, c) => {
      const pl = P(g, c.ctrl);
      const x = c.f.loot ? findCard(g, c.f.loot) : null;
      if (x && pl.hand.includes(x)) { detach(g, x); P(g, x.owner === c.ctrl ? opp(c.ctrl) : x.owner).hand.push(x); }
      delete c.f.loot;
      if (pl.mz.includes(c)) { detach(g, c); pl.hell.push(c); }
    },
  },
  'พูดไทยได้ 5 คำ': {
    keep: 3,
    canCast: (g, p) => P(g, p).deck.length > 5,
    resolve: (g, p) => peek(g, p, 5, (top) => {
      const x = best(top.filter((y) => y.def.type === 'Avatar' && symIs(y, 'ต่างชาติ')), (y) => value(g, y));
      if (!x) return;
      if (x.def.cost <= 2 && canPlaceAvatar(P(g, p)) && mayDo(g, x, 'summon it instead (Cost 2 or less)', true)) takeSummon(g, p, top, (y) => y === x);
      else { top.splice(top.indexOf(x), 1); P(g, p).hand.push(x); }
    }, 'bottom'),
  },
  'ง่วงมากก็ไปนอน !!!': {
    keep: 3.5,
    canCast: (g, p) => oppTargets(g, p, true).some((a) => a.asleep),
    resolve: (g, p) => {
      const t = best(oppTargets(g, p, true).filter((a) => a.asleep), (a) => value(g, a));
      if (!t) return;
      const owner = t.owner, tok = t.token;
      if (toDeck(g, p, t, 'shuffle') && !tok) draw(g, owner, 1);
    },
  },
  'Jump Scare': {
    keep: 3,
    canCast: (g, p) => P(g, p).hand.length >= 2 && P(g, p).deck.length > 3,
    resolve: (g, p) => {
      const pl = P(g, p);
      if (!discardWorst(g, p, 1) || !pl.deck.length) return;
      const x = pl.deck[Math.floor(rand(g) * pl.deck.length)];
      if (x.def.type === 'Avatar') { if (x.def.cost <= 5 && canPlaceAvatar(pl)) summon(g, p, x, 'effect'); }
      else { detach(g, x); pl.hell.push(x); }
      shuffle(g, pl.deck);
    },
  },
  'บ่อนแตก': {
    keep: 4,
    canCast: (g, p) => P(g, opp(p)).avatars.length >= 5,
    resolve: (g, p) => { for (const a of [...P(g, opp(p)).avatars]) destroy(g, a, p, true); },
  },
  [PLANE]: {
    keep: 4,
    // approx: the "only Super Air may be summoned for the rest of this turn" lock is not enforced
    canCast: (g, p) => canPlaceAvatar(P(g, p)) && Object.entries(P(g, p).once).every(([k, v]) => !(k.startsWith('summoned:') && v === g.turn) || k.includes('Super Air')),
    resolve: (g, p, c) => {
      const orig = c.def;
      c.def = { ...orig, type: 'Avatar', subtype: '', symbol: 'หุ่นยนต์', cost: 5, gem: 0, power: 5, orig } as Def;
      P(g, p).hell.push(c);
      if (!summon(g, p, c, 'effect')) restorePlane(c);
    },
    // ผู้โดยสาร Super Air dies instead: its leaveGuard (superair)
    deathCry: (g, c) => restorePlane(c),
  },
  'ตั๋วยืน': {
    keep: 3,
    canCast: (g, p) => hasPlane(g, p) && P(g, p).hand.length >= 2 && canPlaceAvatar(P(g, p)) && P(g, p).deck.some((x) => x.def.name === 'ผู้โดยสาร Super Air'),
    resolve: (g, p) => {
      if (!discardWorst(g, p, 1)) return;
      for (let i = 0; i < 2; i++) fromZoneSummon(g, p, P(g, p).deck, (x) => x.def.name === 'ผู้โดยสาร Super Air');
      shuffle(g, P(g, p).deck);
    },
  },
  'พลังแห่งการตีพ่อตีแม่': {
    keep: 3.5, options: 2,
    canCast: (g, p, c, o) => o === 0
      ? P(g, p).avatars.some((a) => symIs(a, 'เปรต')) && P(g, p).deck.some((x) => x.def.name === 'ตีพ่อ' || x.def.name === 'ตีแม่')
      : P(g, p).deck.some((x) => x.def.type === 'Avatar' && symIs(x, 'เปรต')),
    resolve: (g, p, c, o) => {
      const pl = P(g, p), both = critical(pl);
      if (o === 0 || both) {
        const w = best(pl.avatars.filter((a) => symIs(a, 'เปรต')), (a) => value(g, a));
        if (w) for (const nm of ['ตีพ่อ', 'ตีแม่']) {
          const m = pl.deck.find((x) => x.def.name === nm);
          if (m && pl.avatars.includes(w)) { attach(g, m, w); fx(m)?.onAttach?.(g, m, w); }
        }
      }
      if (o === 1 || both) search(g, p, (x) => x.def.type === 'Avatar' && symIs(x, 'เปรต'), 'deck');
      shuffle(g, pl.deck);
    },
  },
  'รหัสดำ': {
    keep: 6, mainUse: true,
    canCast: (g, p) => !!codeBlack(g, p),
    resolve: (g, p) => codeBlackRun(g, p),
    react: {
      on: ['attack', 'magic', 'ability'],
      can: (g, p, c, ev) => ev.actor !== p && !!codeBlack(g, p),
      want: (g, p) => P(g, opp(p)).life.filter((l) => !l.faceUp).length <= 2,
      resolve: (g, p) => codeBlackRun(g, p),
    },
  },
  'เหน็บกินมือ': {
    keep: 3.5,
    // v14 ruling (confirmed): answers any opponent Magic / Avatar-ability event from a card whose text takes cards from
    // the Deck to the hand (e.g. เลือกมันสำหรับพวก จน when it picks from the Deck)
    react: {
      on: ['magic', 'ability'],
      can: (g, p, c, ev) => ev.actor !== p && !!ev.source && searches(ev.source),
      want: (g, p, c, ev) => keepValue(g, ev.source!) >= 3,
      resolve: cancel,
    },
  },
  'แผนการ : เพดานถล่ม': {
    keep: 3.5,
    // v14 ruling: usable whenever the opponent has 2+ asleep Avatars on their Avatar Zone (checked in every response window
    // of the opponent's actions: attack, fight, LIFE hit, summon, ability, Magic, end of turn)
    react: {
      on: ['attack', 'fight', 'lifeHit', 'summon', 'ability', 'magic', 'endTurn', 'battleStart'],
      can: (g, p, c, ev) => ev.actor !== p && P(g, opp(p)).avatars.filter((a) => a.asleep).length >= 2 && oppTargets(g, p, true).some((a) => a.asleep),
      want: (g, p) => oppTargets(g, p, true).some((a) => a.asleep && value(g, a) >= 3.5),
      resolve: (g, p) => { const t = best(oppTargets(g, p, true).filter((a) => a.asleep), (a) => value(g, a)); if (t) destroy(g, t, p, true); },
    },
  },
  'ฮึบบบบบบบบบบบบ': {
    keep: 3,
    react: {
      on: ['fight'],
      can: (g, p, c, ev) => !!fighters(p, ev),
      want: (g, p, c, ev) => { const f = fighters(p, ev)!; return power(g, f[0]) === power(g, f[1]) && !hasKw(g, f[0], 'tieWin'); },
      resolve: (g, p, c, ev) => {
        const f = fighters(p, ev); if (!f) return;
        c.f.tw = f[0].uid; c.f.twTurn = g.turn; c.ctrl = p;
        P(g, p).mz.push(c); // stays in the Magic Zone to grant ลูกฮึด until end of turn, then goes to hell
      },
    },
    grant: (g, s, t, kw) => kw === 'tieWin' && s.f.twTurn === g.turn && s.f.tw === t.uid,
    endPhase: (g, c) => { const pl = P(g, c.ctrl); if (pl.mz.includes(c)) { detach(g, c); c.f = {}; pl.hell.push(c); } },
  },
  'อาวุธหุ่นนักรบผู้กล้า "GHD โคลค"': {
    keep: 1.5,
    symbolLock: (g: Game, m: Card, t: Card) => t.mods.includes(m), // other-team audit: "จะไม่ถูกเปลี่ยน Symbol" (view.ts symbolsOf)
    canCast: (g, p) => P(g, p).avatars.some((a) => symIs(a, 'หุ่นยนต์')),
    modTarget: (g, p) => best(P(g, p).avatars.filter((a) => symIs(a, 'หุ่นยนต์')), (a) => value(g, a)),
  },
  'กระบองแสง คทาวุธ': {
    keep: 3.5,
    canCast: (g, p) => P(g, p).avatars.length > 0,
    modTarget: (g, p) => best(P(g, p).avatars, (a) => power(g, a) + (a.asleep ? 0 : 3)),
    // v14: from the attack declaration to the end of that fight the opponent can't use React Magic (blockReact)
    blockReact: (g, self, ev) => {
      const f = currentFight();
      return f && f.att.uid === self.wearer && f.att.mods.includes(self) && (ev.responder ?? opp(ev.actor)) !== self.ctrl ? 'magic' : null;
    },
    onWearerKill: (g, m, w) => { if (g.active === w.ctrl && P(g, opp(w.ctrl)).avatars.length > 0) w.asleep = false; },
  },
  'Hot Zone': {
    keep: 2.5,
    canCast: (g, p) => !g.land || g.land.owner !== p,
    fieldActs: (g, p, c) => {
      const tr = (x: Card) => x.def.type === 'Avatar' && named(x, 'Tank Ranger') && symIs(x, 'คน');
      return [act('Hot Zone: equip a Tank Ranger from hand', (g2) => inMain(g2, p) && isLandOn(g2, c) && once(g2, p, 'hotzone') && P(g2, p).hand.some(tr) && P(g2, p).avatars.some(tank),
        (g2) => {
          markOnce(g2, P(g2, p), 'hotzone');
          const x = worst(P(g2, p).hand.filter(tr), (y) => keepValue(g2, y)); const t = best(P(g2, p).avatars.filter(tank), (a) => value(g2, a));
          if (x && t) attach(g2, x, t);
        })];
    },
  },
  // v14: when summoning a {ยักษ์} Avatar from hand, a {ยักษ์} Avatar in hand pays its POWER as GEM (FX.gemValue; the
  // higher of GEM / POWER is used, so the bot and the payment picker see it)
  'กรุงลงกา': {
    keep: 1.5, canCast: (g, p) => !g.land || g.land.owner !== p,
    gemValue: (g: Game, self: Card, c: Card, forCard: Card | null) => (forCard && isLandOn(g, self) && isA(forCard) && symIs(forCard, 'ยักษ์') && isA(c) && symIs(c, 'ยักษ์')
      && g.p.some((q) => q.hand.includes(c)) && c.def.power > c.def.gem ? c.def.power : null),
  } as Fx,
  'ฐานหุ่นนักรบผู้กล้า ซีทันยาน': {
    keep: 2.5,
    canCast: (g, p) => !g.land || g.land.owner !== p,
    // v14 ruling (confirmed): casts the first weapon right away and re-opens the Modification use
    fieldActs: (g, p, c) => [act('ซีทันยาน: two อาวุธหุ่นนักรบผู้กล้า this turn', (g2) => inMain(g2, p) && isLandOn(g2, c) && once(g2, p, 'sitan') && !P(g2, p).used.Modification
      && P(g2, p).hand.some((x) => weapon(x) && (!fx(x).canCast || fx(x).canCast!(g2, p, x, 0))),
    (g2) => {
      const pl = P(g2, p); markOnce(g2, pl, 'sitan');
      const w = best(pl.hand.filter((x) => weapon(x) && (!fx(x).canCast || fx(x).canCast!(g2, p, x, 0))), (x) => keepValue(g2, x));
      if (w && castMagic(g2, p, w, 0)) pl.used.Modification = false;
    })],
  },
};

// ---------- card-specific helpers ----------
// "milled by a purple เทพ Avatar or a Magic card" (v14: MillInfo says who / which card milled)
function valkMill(info: any): boolean {
  if (!info) return false;
  if (info.duringMagic) return true;
  const s = info.src as Card | null;
  return !!s && isA(s) && symIs(s, 'เทพ') && colorIs(s, 'ม่วง');
}
// เฮล่า: แอสการ์ด is the Land and we control a purple เทพ Avatar
const helaOk = (g: Game, p: PID) => !!landOn(g, 'แอสการ์ดคือสถานที่ไม่ใช่ผู้คน') && P(g, p).avatars.some(purpleGod) && canPlaceAvatar(P(g, p));
// น้องนาว: turn the LIFE it flipped this turn face down again (not in สาหัส, not under โรงบาลรัฐ)
function nawBack(g: Game, p: PID) {
  const pl = P(g, p), mine = pl.life.filter((l) => (l as any).naw === g.turn);
  if (!mine.length) return;
  for (const l of mine) delete (l as any).naw;
  if (isCritical(pl)) { log(g, 'น้องนาว: we are in สาหัส, the LIFE stay face up'); return; }
  for (const l of mine) if (l.faceUp) lifeDown(g, p, l);
  log(g, `น้องนาว: ${mine.length} LIFE turned face down again (${flippedLife(pl)}/5)`);
}
function nawRule(): any { return { label: 'น้องนาว: flipped LIFE go face down at the end of the turn', endPhase: (g: Game, r: any) => nawBack(g, r.p) }; }
// ไบโพล่า ชิลด์ (BT04-053 / KD04-014): the wearer would leave the field because of an opponent's card
function bipolaGuard(g: Game, self: Card, t: Card, info: any) {
  if (t.uid !== self.wearer || info.by === null || info.by === t.ctrl || info.cost) return null;
  const mine = t.mods.filter((m) => m.def.name.includes('ไบโพล่า') && !m.f.bipolaUsed);
  if (!mine.length || mine[0] !== self) return null; // the first unused copy rolls for all of them
  return { optional: false, run: () => {
    let even = false;
    const rolls = mine.map((m) => { m.f.bipolaUsed = 1; const r = d6(g); if (r % 2 === 0) even = true; return r; });
    log(g, `ไบโพล่า ชิลด์ rolls ${rolls.join(', ')}: ${even ? t.def.name + ' stays on the field' : 'no even number'}`);
    return even;
  } };
}
// รัททาทุย 2 หัว: "when its POWER is 0, destroy it at once" (whatever caused it)
function zeroSelf(g: Game, c: Card) {
  if (P(g, c.ctrl).avatars.includes(c) && !silenced(g, c) && power(g, c) <= 0) { log(g, `${c.def.name}: POWER 0, destroyed`); destroy(g, c, c.ctrl, false, { cost: true }); }
}
// destroy an attached card (Modification / Avatar worn as a card) through the engine's leave path
function destroyMod(g: Game, m: Card) {
  if (!g.p.some((q) => q.avatars.some((a) => a.mods.includes(m)))) return false;
  return toHell(g, m, { by: m.ctrl, cost: true });
}
function machine(a: Card) { return symAny(a, ['เครื่องจักร', 'หุ่นยนต์']); }
function saleBoth(g: Game, p: PID) {
  const mine = P(g, p).avatars.flatMap((a) => a.mods), theirs = P(g, opp(p)).avatars.flatMap((a) => a.mods);
  const a = worst(mine, (m) => keepValue(g, m)), b = best(theirs, (m) => keepValue(g, m));
  if (a && b) { modToHell(g, a); modToHell(g, b); }
}
// กลับหลังหัน: which fighter to turn (its POWER becomes its Cost) so that we win, or at least stop losing
function swapChoice(g: Game, mine: Card, theirs: Card): Card | null {
  let pick: Card | null = null, bestR = fightResult(g, mine, theirs);
  for (const x of [theirs, mine]) {
    const d = costOf(g, x.ctrl, x) - power(g, x);
    const r = x === mine ? fightResult(g, mine, theirs, d, 0) : fightResult(g, mine, theirs, 0, d);
    if (r > bestR) { bestR = r; pick = x; }
  }
  return pick;
}
function braveBot(a: Card) { return isA(a) && named(a, 'ผู้กล้า') && machine(a); }
function rifleOk(a: Card) { return isA(a) && symIs(a, 'คน') && (nameHas(a, 'ทหาร') || nameHas(a, 'รด.')); }
function axe(x: Card) { return x.def.type === 'Magic' && x.def.subtype === 'Modification' && nameHas(x, 'ขวาน'); }
function weapon(x: Card) { return x.def.type === 'Magic' && x.def.subtype === 'Modification' && nameHas(x, 'อาวุธหุ่นนักรบผู้กล้า') && !!fx(x); }
// รหัสดำ: คุณเชิดชัย + the plane + 2 more Super Air Avatars, 4 different names
function codeBlack(g: Game, p: PID): Card[] | null {
  const av = P(g, p).avatars;
  const ch = av.find((a) => a.def.name === 'คุณเชิดชัย Super Air'), pl = av.find((a) => a.def.name === PLANE);
  if (!ch || !pl) return null;
  const cand = av.filter((a) => named(a, 'Super Air') && a !== ch && a !== pl && a.def.name !== ch.def.name && a.def.name !== PLANE);
  if (new Set(cand.map((a) => a.def.name)).size < 2) return null;
  return [ch, pl, ...cand.slice(0, 2)];
}
// the 2 other Super Air (different names) are chosen by the player
function codeBlackPick(g: Game, p: PID): Card[] | null {
  const set = codeBlack(g, p); if (!set) return null;
  const av = P(g, p).avatars, others: Card[] = [];
  for (let i = 0; i < 2; i++) {
    const x = worst(av.filter((a) => named(a, 'Super Air') && a !== set[0] && a !== set[1] && a.def.name !== set[0].def.name && a.def.name !== PLANE && !others.some((o) => o.def.name === a.def.name)), (a) => value(g, a));
    if (!x) return null; others.push(x);
  }
  return [set[0], set[1], ...others];
}
function codeBlackRun(g: Game, p: PID) {
  const set = codeBlackPick(g, p); if (!set) return;
  const down = P(g, opp(p)).life.filter((l) => !l.faceUp);
  const win = down.length <= 2;
  for (const a of set) { restorePlane(a); toHell(g, a); }
  if (win) { g.winner = p; log(g, `รหัสดำ: P${p} wins`); return; }
  for (const l of down.slice(0, 3)) l.faceUp = true;
  log(g, 'รหัสดำ flips 3 LIFE');
}

Object.assign(FX, G3);

// ---------- v13 ----------
Object.assign(FX, {
  // BT05-057 "ใช้ได้ในช่วง เริ่มต้น Battle Phase ของฝ่ายตรงข้ามเท่านั้น ส่ง Avatar บน Avatar Zone ฝ่ายเรา 1 ใบ ลงนรก : Avatar ทุกใบ
  // บน Avatar Zone ฝ่ายเรา จะไม่ถูกทำลายจากการต่อสู้ในเทิร์นนี้". The window opens after the opponent enters the Battle Phase,
  // before their first attack (engine Ev kind 'battleStart'); destroy() then refuses battle destructions of our Avatars.
  'พระคุ้มครอง': {
    keep: 4,
    react: {
      on: ['battleStart'],
      can: (g: Game, p: PID, c: Card, ev: Ev) => ev.actor !== p && P(g, p).avatars.length > 0,
      want: (g: Game, p: PID, c: Card, ev: Ev) => {
        const mine = P(g, p).avatars, theirs = P(g, ev.actor).avatars.filter((a) => !a.asleep);
        return mine.length >= 2 && theirs.filter((a) => mine.some((m) => power(g, a) >= power(g, m))).length >= 2;
      },
      resolve: (g: Game, p: PID, c: Card) => {
        const pl = P(g, p);
        const x = worst(pl.avatars, (a) => value(g, a));
        if (!x) return;
        toHell(g, x);
        pl.once['noBattleDie'] = g.turn;
        log(g, `P${p}'s Avatars can't be destroyed in battle this turn (พระคุ้มครอง)`);
      },
    },
  },
});

// ---------- v14 (cards-B): มีมมิจัง ไอดอล No.1 KD03-001 (replaces the cards2.ts entry) ----------
{
  const MEEMMI = 'มีมมิจัง ไอดอล No.1';
  const otaOf = (a: Card) => a.mods.filter((m) => named(m, 'โอตะ'));
  // move the โอตะ cards worn by `from` (already taken off) onto `to`, or to their owners' Hell
  const moveOtas = (g: Game, otas: Card[], to: Card | null) => {
    for (const o of otas) {
      if (to && g.p.some((q) => q.avatars.includes(to))) { attach(g, o, to); fx(o)?.onAttach?.(g, o, to); log(g, `${o.def.name} now worn by ${to.def.name}`); }
      else P(g, o.owner).hell.push(o);
    }
  };
  const takeOtas = (g: Game, a: Card) => { const os = otaOf(a); for (const o of os) { detach(g, o); o.wearer = -1; } return os; };
  Object.assign(FX, {
    [MEEMMI]: {
      keep: 8,
      // v14 ruling: สั่งใช้ from hand: exile a "มีมมิ" on our Avatar Zone: อัญเชิญ จุติ this; the exiled one's โอตะ move to this
      handActs: (g: Game, p: PID, c: Card) => [act('มีมมิจัง: exile a มีมมิ, summon (จุติ)', (g2) => inMain(g2, p) && P(g2, p).hand.includes(c)
        && P(g2, p).avatars.some((a) => named(a, 'มีมมิ')),
      (g2) => {
        const pl = P(g2, p);
        const x = worst(pl.avatars.filter((a) => named(a, 'มีมมิ')), (a) => value(g2, a) - otaOf(a).length * 3);
        if (!x) return;
        const otas = takeOtas(g2, x);
        if (!toExile(g2, x, { cost: true })) { moveOtas(g2, otas, x); return; }
        const ok = canPlaceAvatar(pl, false, c) && summon(g2, p, c, 'jutsu');
        moveOtas(g2, otas, ok ? c : null);
      })],
      jutsu: (g: Game, c: Card) => {
        const pl = P(g, c.ctrl);
        const idol = fromZoneSummon(g, c.ctrl, pl.deck, (x) => named(x, 'ไอดอล') && !x.def.only);
        const ota = best(pl.deck.filter((x) => named(x, 'โอตะ')), (x) => keepValue(g, x));
        if (idol && ota && pl.avatars.includes(idol)) { attach(g, ota, idol); fx(ota)?.onAttach?.(g, ota, idol); }
        shuffle(g, pl.deck);
      },
      // อัตโนมัติ in our End Phase: this goes back into the Deck (shuffled), draw 1, may summon a "มีมมิ" from our exile
      // (the text says "บีมมิ": no such card exists; the user: read it as "มีมมิ"); the โอตะ this wore move to it
      endPhase: (g: Game, c: Card) => {
        const p = c.ctrl, pl = P(g, p);
        if (g.active !== p || !pl.avatars.includes(c)) return;
        const otas = takeOtas(g, c);
        if (!toDeckE(g, c, 'shuffle')) { moveOtas(g, otas, c); return; }
        draw(g, p, 1);
        if (g.winner !== null) { moveOtas(g, otas, null); return; }
        const b = canPlaceAvatar(pl) ? pickN(pl.exile.filter((x) => isA(x) && named(x, 'มีมมิ') && x !== c), 1, (x) => value(g, x), { optional: true, title: 'มีมมิจัง: summon a มีมมิ from exile?' })[0] : null;
        const ok = !!b && summon(g, p, b, 'effect');
        moveOtas(g, otas, ok ? b! : null);
      },
    },
  });
}

// other-team audit Q9 (user: a cancelled Magic keeps its text costs paid): the "cost :" part is paid before the React window
costFirst('บีมมมมมมมมมม', (g, p) => discardWorst(g, p, 1), (g, p) => { const t = best(oppTargets(g, p, true), (a) => value(g, a)); if (t) destroy(g, t, p, true); });
costFirst('Jump Scare', (g, p) => discardWorst(g, p, 1), (g, p) => {
  const pl = P(g, p);
  if (!pl.deck.length) return;
  const x = pl.deck[Math.floor(rand(g) * pl.deck.length)];
  if (x.def.type === 'Avatar') { if (x.def.cost <= 5 && canPlaceAvatar(pl)) summon(g, p, x, 'effect'); }
  else { detach(g, x); pl.hell.push(x); }
  shuffle(g, pl.deck);
});
costFirst('พระคุ้มครอง', null, null, (g, p) => { const x = worst(P(g, p).avatars, (a) => value(g, a)); if (!x) return false; toHell(g, x); return true; }, (g, p) => {
  P(g, p).once['noBattleDie'] = g.turn;
  log(g, `P${p}'s Avatars can't be destroyed in battle this turn (พระคุ้มครอง)`);
});
{
  const codePay = (g: Game, p: PID, c: Card) => {
    const set = codeBlackPick(g, p); if (!set) return false;
    for (const a of set) { restorePlane(a); toHell(g, a); }
    return true;
  };
  const codeHit = (g: Game, p: PID) => {
    const down = P(g, opp(p)).life.filter((l) => !l.faceUp);
    if (down.length <= 2) { g.winner = p; log(g, `รหัสดำ: P${p} wins`); return; }
    for (const l of down.slice(0, 3)) l.faceUp = true;
    log(g, 'รหัสดำ flips 3 LIFE');
  };
  costFirst('รหัสดำ', codePay, codeHit, codePay, codeHit);
}
// other-team audit Q4 (user): ขวานเงิน resets the POWER น้องสาม ผู้รู้ความจริง gained from its Scout
{
  const axe = FX['ขวานเงิน'], on0 = axe && axe.onAttach;
  if (axe) axe.onAttach = (g, m, w) => { if (on0) on0(g, m, w); if (w.def.name === 'น้องสาม ผู้รู้ความจริง') w.temp = w.temp.filter((t) => !(t as any).samP); };
}
