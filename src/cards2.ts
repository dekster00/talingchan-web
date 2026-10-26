// Card effects for the rest of the top-16 post-BT11 decks. Many complex cards are approximated:
// each keeps its main effect; rare branches are simplified (see comments marked "approx").
import { rollDie } from './engine.ts';
import type { Card, Game, PID } from './types.ts';
import type { Ev } from './engine.ts';
import { canChangeCtrl, takeControl, grantKw, landIs as landOn, isLandOn, placeLand, magicImmune, currentSource, lands, useShield } from './engine.ts';
import { attach as attachCard, canWear, lifeDown } from './engine.ts'; // v14d
import { addPower } from './engine.ts'; // v14 answers
import { textCost } from './engine.ts'; // other-team audit Q9
import { fieldAvatars } from './cards.ts'; // other-team audit Q12
import { addToHand, ctrlUntilOwnerDraw, loseText, noAbilityNow } from './engine.ts'; // simplify1
import { effectTargetable as effectTargetableE } from './engine.ts'; // other-team audit
import { gameOf as gameOfC } from './view.ts'; // other-team audit
import type { Fx, HandAct } from './cards.ts';
import {
  FX, value, best, worst, pickN, worstN, mayDo, chooseMode, oppChoice, oppTargets, removeOpp, sacrifice, search, inMain, cancel,
} from './cards.ts';
import {
  P, opp, power, draw, destroy, toHell, toHand, toExile, discard, detach, summon, shuffle, mill,
  nameHas, canPlaceAvatar, flippedLife, onceUsed, markOnce, keepValue, log, findCard, fx, rand,
  bestPayment, choosePayment, costOf, hitLife, silenced, critical,
  symIs, symAny, colorIs, scoutDeck, putBottom, silenceFull, summonExact, colorsEn, arrangeTopBottom, decide, humanDeciding, humanSeat
} from './engine.ts';

// ---------- helpers ----------
const isA = (c: Card) => c.def.type === 'Avatar' || c.def.type === 'Token';
function purpleNow(o: Card): boolean { // other-team audit (มีมมิ นักเรียนดีเด่น)
  const g = gameOfC(o); const f = fightE();
  return !!g && o.f.purple === g.turn && !!f && (f.att === o || f.target === o) && (f.att.uid === o.f.purpleW || (!!f.target && f.target.uid === o.f.purpleW));
}
function named(c: Card, key: string) {
  if (c.def.aka && c.def.aka.some((a) => a.includes(key))) return true;
  if (c.def.name.includes(key)) return true;
  const f = FX[c.def.name];
  return !!(f && f.alias && f.alias.some((a) => a.includes(key)));
}
const onZone = (g: Game, p: PID, key: string) => P(g, p).avatars.filter((a) => named(a, key));
function distinctNames(cs: Card[]) { return new Set(cs.map((c) => c.def.name)).size; }
function hellAvatars(g: Game, p: PID, pred: (c: Card) => boolean = () => true) { return P(g, p).hell.filter((c) => isA(c) && pred(c)); }
function once(g: Game, p: PID, key: string) { return !onceUsed(g, P(g, p), key); }
// Look at the top n cards. pick() chooses which to take; rest go to the bottom or get shuffled in.
// สอดแนม / look at the top n: engine scoutDeck() reveals them, lets the human pick and order the rest
function peek(g: Game, p: PID, n: number, pick: (cs: Card[]) => void, rest: 'bottom' | 'shuffle' | 'hell' | 'top' | 'either' = 'shuffle') {
  scoutDeck(g, p, n, pick, rest);
}
// take from a peeked list: summon or to hand (removes from list owner arrays via findCard check)
function takeSummon(g: Game, p: PID, list: Card[], pred: (c: Card) => boolean, how: 'jutsu' | 'effect' = 'effect', max = 1) {
  let n = 0;
  const pool = [...list].filter(pred);
  while (n < max && canPlaceAvatar(P(g, p))) {
    const c = max > 1 ? pickN(pool, 1, (x) => value(g, x), { optional: true })[0] || null : best(pool, (x) => value(g, x)); // human picks inside scouts
    if (!c) break;
    pool.splice(pool.indexOf(c), 1);
    list.splice(list.indexOf(c), 1);
    c.f.viaScout = 1; P(g, p).hell.push(c); // temporarily somewhere findable
    if (summon(g, p, c, how)) n++;
  }
  return n;
}
function takeHand(g: Game, p: PID, list: Card[], pred: (c: Card) => boolean) {
  const c = best(list.filter(pred), (x) => keepValue(g, x) + x.def.power * 0.3);
  if (c) { list.splice(list.indexOf(c), 1); P(g, p).hand.push(c); }
  return c;
}
function fromZoneSummon(g: Game, p: PID, zone: Card[], pred: (c: Card) => boolean, how: 'jutsu' | 'effect' = 'effect') {
  const c = best(zone.filter((x) => isA(x) && pred(x)), (x) => value(g, x));
  if (c && canPlaceAvatar(P(g, p))) { summon(g, p, c, how); return c; }
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
  if (t.mods.some((m) => FX[m.def.name]?.noSteal)) return false;
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
// Summon up to max Avatars with different names (not in used) from pool, one at a time; the human picks each (Skip stops once
// `min` were summoned).
function summonDistinct(g: Game, p: PID, pool: Card[], max: number, score: (c: Card) => number, used: Set<string>, title: string, min = 0) {
  let n = 0;
  while (n < max && canPlaceAvatar(P(g, p))) {
    const xs = pool.filter((x) => findCard(g, x.uid) && !P(g, p).avatars.includes(x) && !used.has(x.def.name));
    const c = n < min ? best(xs, score) : pickN(xs, 1, score, { optional: true, title })[0] || null;
    if (!c) break;
    used.add(c.def.name);
    if (summon(g, p, c, 'effect')) n++;
  }
  return n;
}
function act(label: string, can: (g: Game) => boolean, run: (g: Game) => void): HandAct { return { label, can, run }; }
const d6 = (g: Game) => rollDie(g); // emits the 'roll' event
// v14 features: the Link / คู่หู state starts with the Link action (engine linkPair); both cards then remember each other
const linked = (g: Game, c: Card, partner: string) => P(g, c.ctrl).avatars.some((a) => a !== c && named(a, partner) && a.f.linkWith === c.uid && c.f.linkWith === a.uid);
const turnOf = (g: Game, c: Card) => g.active === c.ctrl;
function boost(c: Card, n: number) { c.temp.push({ power: n, until: 'turn' }); }
// Flip the opponent's top face-down LIFE by an effect (no loss if all are already face up).
function flipLife(g: Game, p: PID) {
  const l = P(g, p).life.find((x) => !x.faceUp);
  if (l) { l.faceUp = true; log(g, `P${p} LIFE flipped by effect (${flippedLife(P(g, p))}/5)`); }
}
// Link pairs coded so far (both cards are "in Link state" while the other is on the same Avatar Zone)
const LINK_PAIRS: [string, string][] = [['เพมมุ', 'สไปรท์'], ['เมย์ แวมไพร์', 'เจ้าหญิงรวงข้าว'], ['โฮคุ', 'โซน่า']];
const LINKERS = ['เพมมุ ยอดมนุษย์', 'สไปรท์ ยอดสุนัข', 'เมย์ แวมไพร์โกธิค', 'โฮคุ โพลีกอน', 'โซน่า โพลีกอน', 'ธอร์ บุตรแห่งโอดิน', 'โลกิ เจ้าชายยักษ์น้ำแข็ง',
  'จอมเวทย์ เดสสึหวา', 'จอมเวทย์ โกลเด้น', 'ซัลลี่วอดก้า', 'ไมค์วิสกี้', 'ตันก๋ง กุนซือคู่กายเทพสงคราม', 'ออส่วนบอย', 'นายนิรยบาล นิมมา']; // Avatars with a [Link] ability
// linkbot: "an Avatar in [Link] state" = any pair formed by the Link action (engine inLink), not only LINK_PAIRS
function isLinked(g: Game, a: Card) {
  return inLinkE(g, a) || LINK_PAIRS.some(([x, y]) => (named(a, x) && linked(g, a, y)) || (named(a, y) && linked(g, a, x)));
}
// Summons done by an "อัศวินโต๊ะกลม" ability (ทริสทัน checks this while its onSummon runs).
let BY_KNIGHT = 0;
function knightSummon(g: Game, p: PID, k: Card, how: 'jutsu' | 'effect') {
  BY_KNIGHT++;
  try { return summon(g, p, k, how); } finally { BY_KNIGHT--; }
}

// Hell-recursion for the ดาบศักดิ์สิทธิ์ swords
function swordHell(): Fx['hellActs'] {
  return (g, p, c) => [act('ดาบศักดิ์สิทธิ์: mill 1 and equip from hell', (g2) =>
    inMain(g2, p) && !P(g2, p).used.Modification && P(g2, p).hell.includes(c) && onZone(g2, p, 'อัศวินโต๊ะกลม').length > 0,
  (g2) => {
    P(g2, p).used.Modification = true;
    mill(g2, p, 1);
    const w = best(onZone(g2, p, 'อัศวินโต๊ะกลม'), (a) => value(g2, a) + (a.def.name.includes('มอเดรด') ? 3 : 0));
    if (w && P(g2, p).hell.includes(c)) { attach(g2, c, w); FX[c.def.name].onAttach?.(g2, c, w); }
  })];
}
// Virus: exiled when milled by a virus; summon back from exile with 5+ viruses in exile
function virus(extra: Fx): Fx {
  return {
    ...extra,
    onMilled: (g, c, p, byVirus) => { if (byVirus) toExile(g, c); },
    exileActs: (g, p, c) => [act('ไวรัส: return from exile', (g2) => inMain(g2, p) && P(g2, p).exile.includes(c)
      && P(g2, p).exile.filter((x) => named(x, 'ไวรัส')).length >= 5 && P(g2, p).hand.length >= 2 && canPlaceAvatar(P(g2, p)),
    (g2) => { if (discardWorst(g2, p, 2)) summon(g2, p, c, 'effect'); })],
  };
}
function allMill(g: Game, p: PID, n: number, byVirus = true) {
  const a = mill(g, p, n, byVirus), b = mill(g, opp(p), n, byVirus);
  return [...a, ...b].filter(isA).length;
}
const otaOnZone = (g: Game, p: PID, self: Card) => [
  act('โอตะ: equip to ไอดอล', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(self) && once(g2, p, 'ota:' + self.uid) && onZone(g2, p, 'ไอดอล').length > 0,
    (g2) => { markOnce(g2, P(g2, p), 'ota:' + self.uid); const w = best(onZone(g2, p, 'ไอดอล'), (a) => value(g2, a)); if (w) attach(g2, self, w); }),
];
const XVI = 'หน่วยรบ XVI';
const SAIYU = ['พระถังซัมจั๋ง', 'ซุนหงอคง', 'ตือโป๊ยก่าย', 'ซัวเจ๋ง'];
const isSaiyu = (c: Card) => SAIYU.some((n) => c.def.name.includes(n));
const knight = (c: Card) => named(c, 'อัศวินโต๊ะกลม');
const gang = (c: Card) => named(c, 'แก๊งขยะ');
const story = (c: Card) => named(c, 'เรื่องราว');
const kapom = (c: Card) => symIs(c, 'กะปอม');
const hellMagic = (g: Game, p: PID) => P(g, p).hell.filter((x) => x.def.type === 'Magic').length;
const NAT = (c: Card) => named(c, 'ไอ้นัท') || named(c, 'เซอร์นัท') || named(c, 'อัศวินตลิ่งชัน');

const NEW: Record<string, Fx> = {
  // ===== นรก (นายนิรยบาล / ลิลิธ) & ไวรัส =====
  'ปีศาจแห่งพันรเลือด เมฟิสโตเฟเลส': {
    keep: 7, noHandSummon: true,
    handActs: (g, p, c) => [act('เมฟิสโต: summon from hand', (g2) => inMain(g2, p) && P(g2, p).hand.includes(c) && P(g2, p).hand.length >= 3
      && distinctNames(hellAvatars(g2, p, (x) => symIs(x, 'นรก'))) >= 7 && canPlaceAvatar(P(g2, p)),
    (g2) => { if (discardWorst(g2, p, 2, [c])) summon(g2, p, c, 'own'); })],
    fieldActs: (g, p, c) => [act('เมฟิสโต: mill 5, destroy all other Avatars', (g2) => inMain(g2, p) && once(g2, p, 'mephisto') && P(g2, p).deck.length > 8,
      (g2) => { markOnce(g2, P(g2, p), 'mephisto'); const was = g2.p.flatMap((q) => q.avatars.filter((a) => a !== c)); mill(g2, p, 5); for (const a of was) if (fzE(g2, a) === 'avatars') destroy(g2, a, p); })], // other-team audit: only the Avatars that were there before
  },
  'นางฟ้าลูกซอง': {
    keep: 1.5,
    hellActs: (g, p, c) => [act('นางฟ้าลูกซอง: exile from hell, +2', (g2) => inMain(g2, p) && P(g2, p).hell.includes(c) && P(g2, p).avatars.some((a) => !a.asleep),
      (g2) => { toExile(g2, c); const t = best(P(g2, p).avatars.filter((a) => !a.asleep), (a) => power(g2, a)); if (t) boost(t, 2); })],
  },
  'บัมเบิ้ลแบงค์': {
    keep: 1.5,
    hellActs: (g, p, c) => [act('บัมเบิ้ลแบงค์: revive', (g2) => inMain(g2, p) && P(g2, p).hell.includes(c) && once(g2, p, 'bumble')
      && !P(g2, p).avatars.some((a) => a.def.name === c.def.name) && P(g2, p).hand.length >= 1 && canPlaceAvatar(P(g2, p)),
    (g2) => { markOnce(g2, P(g2, p), 'bumble'); if (discardWorst(g2, p, 1)) summon(g2, p, c, 'effect'); })],
  },
  'เจค นักฆ่ามือเก๋า': {
    keep: 5, tieWin: true, unique: true,
    onAttack: (g, c) => {
      if (!P(g, c.ctrl).hell.some((x) => x.def.name.includes('ของขวัญที่เมียทิ้งไว้ให้'))) return;
      const oh = P(g, opp(c.ctrl)).hand; if (oh.length) discard(g, opp(c.ctrl), oh[Math.floor(rand(g) * oh.length)]);
    },
  },
  'ลาพิเน่ โพลีกอน': { keep: 2 }, // approx: its hell trigger is not modeled
  'ลิลิธ ปีศาจสาวตนแรก': {
    keep: 4, alias: ['นายนิรยบาล'],
    fieldActs: (g, p, c) => [act('ลิลิธ: exile 2 from hell, take นรก card', (g2) => inMain(g2, p) && once(g2, p, 'lilith')
      && distinctNames(hellAvatars(g2, p, (x) => symIs(x, 'นรก'))) >= 4 && P(g2, p).hell.length >= 3,
    (g2) => {
      const pl = P(g2, p); markOnce(g2, pl, 'lilith');
      const take = best(pl.hell.filter((x) => symIs(x, 'นรก')), (x) => keepValue(g2, x));
      for (const x of worstN(pl.hell.filter((x) => x !== take), 2, (x) => keepValue(g2, x), { title: 'ลิลิธ: exile 2 from your Hell (cost)' })) toExile(g2, x);
      if (take && pl.hell.includes(take)) { detach(g2, take); pl.hand.push(take); }
    })],
  },
  // 'มฤตยูเทวี': group E entry at the end of this file
  'งี่เง่ากับงอแง': { keep: 2.5 }, // filled below (shared with งี่เง่า และ งอแง)
  'ไอ้ดำ จากนรก': {
    keep: 3.5,
    onKill: (g, c) => {
      const p = c.ctrl; if (g.active !== p || !once(g, p, 'aidam')) return; // only after a battle it attacked in
      const f = worst(P(g, p).avatars.filter((a) => a !== c && a.asleep), (a) => value(g, a));
      if (f && value(g, f) < value(g, c)) { markOnce(g, P(g, p), 'aidam'); destroy(g, f, p); c.asleep = false; }
    },
  },
  'สุวรรณ': {
    keep: 3.5,
    jutsu: (g, c) => peek(g, c.ctrl, 5, (top) => takeHand(g, c.ctrl, top, (x) => named(x, 'พญายม') || named(x, 'นายนิรยบาล') || x.def.name.includes('เมฟิสโต')), 'bottom'),
  },
  'นายนิรยบาล พ่อจีจ้า': {
    keep: 3.5,
    onAttack: (g, c) => { mill(g, c.ctrl, 2); boost(c, 1); },
    onTargeted: (g, c) => { mill(g, c.ctrl, 2); boost(c, 1); },
  },
  'นายนิรยบาล แว่น': {
    keep: 1, noHandSummon: true,
    onMilled: (g, c, p) => { if (canPlaceAvatar(P(g, p)) && mayDo(g, c, 'summon it from Hell', true)) summon(g, p, c, 'effect'); }, // bugs7 item 7: "สามารถ" = optional
  },
  'พญายม': {
    keep: 4.5,
    jutsu: (g, c) => { fromZoneSummon(g, c.ctrl, P(g, c.ctrl).hell, (x) => named(x, 'นายนิรยบาล')); },
  },
  'สัญญาเลือด': {
    keep: 4,
    canCast: (g, p) => P(g, p).deck.length > 8,
    resolve: (g, p) => { mill(g, p, 3); draw(g, p, distinctNames(hellAvatars(g, p, (x) => symIs(x, 'นรก'))) >= 5 ? 2 : 1); },
    onMilled: (g, c, p) => { // optional: only exile it when there is a นายนิรยบาล to summon
      if (!canPlaceAvatar(P(g, p)) || !hellAvatars(g, p, (x) => named(x, 'นายนิรยบาล')).length) return;
      if (!mayDo(g, c, 'exile it to summon a นายนิรยบาล from Hell', true)) return; // bugfix2 item 3 (user): "สามารถ" = you choose
      toExile(g, c); fromZoneSummon(g, p, P(g, p).hell, (x) => named(x, 'นายนิรยบาล'));
    },
  },
  'จมน้ำ': {
    keep: 3,
    canCast: (g, p) => P(g, opp(p)).avatars.length > 0,
    resolve: (g, p) => {
      for (const q of [p, opp(p)] as PID[]) {
        const a = decide(g, q, () => worst(P(g, q).avatars, (x) => value(g, x))); // each player picks their own
        if (a) { if (q !== p && magicImmune(g, a, p)) continue; toHell(g, a); const pl = P(g, a.owner); const i = pl.hell.indexOf(a); if (i >= 0) { pl.hell.splice(i, 1); pl.deck.push(a); } }
      }
    },
  },
  'ประตูนรก': {
    keep: 3,
    canCast: (g, p) => !g.land || g.land.owner !== p,
    fieldActs: (g, p, c) => [act('ประตูนรก: discard นรก, revive นายนิรยบาล', (g2) => inMain(g2, p) && once(g2, p, 'hellgate')
      && P(g2, p).hand.some((x) => isA(x) && symIs(x, 'นรก')) && hellAvatars(g2, p, (x) => named(x, 'นายนิรยบาล') && x.def.cost <= 4).length > 0 && canPlaceAvatar(P(g2, p)),
    (g2) => {
      markOnce(g2, P(g2, p), 'hellgate');
      const d = worst(P(g2, p).hand.filter((x) => isA(x) && symIs(x, 'นรก')), (x) => keepValue(g2, x)); if (d) discard(g2, p, d);
      fromZoneSummon(g2, p, P(g2, p).hell, (x) => named(x, 'นายนิรยบาล') && x.def.cost <= 4);
    })],
  },
  'ไวรัสแห่งความเป็นไปได้ ครีปเปอร์': virus({
    keep: 5,
    onAttack: (g, c) => {
      // bugfix2 item 2 (user): once per turn per ครีปเปอร์ (three of them each trigger)
      if (!once(g, c.ctrl, 'creeper:' + c.uid)) return; markOnce(g, P(g, c.ctrl), 'creeper:' + c.uid);
      if (allMill(g, c.ctrl, 3) >= 4) { const t = pickN(P(g, opp(c.ctrl)).avatars, 1, (a) => value(g, a), { optional: true, title: 'ครีปเปอร์: you may make 1 opposing Avatar lose its abilities, POWER 0' })[0]; if (t) { t.silencedTurn = g.turn; boost(t, -t.def.power); } } // bugs7 item 7: "สามารถ" = optional
    },
  }),
  'ไวรัสแห่งการช่วงชิง โทรจัน': virus({
    keep: 4,
    onSummon: (g, c) => {
      if (allMill(g, c.ctrl, 3) >= 4) {
        if (!mayDo(g, c, 'an opposing Avatar POWER -2, then a ไวรัส POWER +2', true)) return; // bugs7 item 7: "สามารถ" = optional
        const t = best(P(g, opp(c.ctrl)).avatars, (a) => value(g, a)); if (t) boost(t, -2);
        const v = best(onZone(g, c.ctrl, 'ไวรัส'), (a) => power(g, a)); if (v) boost(v, 2);
      }
    },
  }),
  'ไวรัสแห่งการแพร่เชื้อ บลาสเตอร์': virus({
    keep: 3,
    deathCry: (g, c, owner) => {
      if (allMill(g, owner, 2) >= 3) {
        const ex = P(g, owner).exile.filter((x) => isA(x) && named(x, 'ไวรัส'));
        const names = new Set<string>();
        summonDistinct(g, owner, ex, 2, (x) => x.def.power, new Set(), 'บลาสเตอร์: summon a ไวรัส from the Dark Dimension (up to 2, different names)');
      }
    },
  }),
  'นีโม่': { keep: 1, onMilled: (g, c, p) => { detach(g, c); P(g, p).deck.push(c); shuffle(g, P(g, p).deck); } },
  'ลุกซุเรีย โปรดิวเซอร์ปีศาจ': {
    keep: 2.5,
    handActs: (g, p, c) => [act('ลุกซุเรีย: send โอตะ, summon', (g2) => inMain(g2, p) && P(g2, p).hand.includes(c)
      && (canPlaceAvatar(P(g2, p)) || P(g2, p).avatars.some((a) => !a.token && named(a, 'โอตะ')))
      && g2.p.some((q) => q.avatars.some((a) => named(a, 'โอตะ')) || q.avatars.some((a) => a.mods.some((m) => named(m, 'โอตะ')))),
    (g2) => {
      // send 1-3 โอตะ from anyone's field to Hell (the player chooses)
      const otas = () => g2.p.flatMap((q) => q.avatars.flatMap((a) => [...a.mods.filter((m) => named(m, 'โอตะ')), ...(named(a, 'โอตะ') ? [a] : [])]));
      let n = 0;
      while (n < 3) {
        const o = pickN(otas(), 1, (x) => (x.ctrl === p ? -1 : 1) * keepValue(g2, x) + 10, { optional: n > 0, title: `ลุกซุเรีย: send a โอตะ to Hell (${n}/3, at least 1)` })[0];
        if (!o) break; toHell(g2, o); n++;
      }
      if (!n) return;
      if (summon(g2, p, c, 'own')) c.bonus += n;
    })],
    fieldActs: (g, p, c) => [act('ลุกซุเรีย: send a โอตะ to hell, +2', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'luxu:' + c.uid)
      && g2.p.some((q) => q.avatars.some((a) => a !== c && (named(a, 'โอตะ') || a.mods.some((m) => named(m, 'โอตะ'))))),
    (g2) => {
      markOnce(g2, P(g2, p), 'luxu:' + c.uid);
      const all = g2.p.flatMap((q) => q.avatars.flatMap((a) => [...a.mods.filter((m) => named(m, 'โอตะ')), ...(a !== c && named(a, 'โอตะ') ? [a] : [])]));
      const o = worst(all, (x) => (x.ctrl === p ? 1 : -1) * keepValue(g2, x)); // prefer the opponent's, then our cheapest
      if (o) { toHell(g2, o); boost(c, 2); }
    })],
    onAttack: (g, c) => { // once per turn: equip a โอตะ from our hell
      if (!once(g, c.ctrl, 'luxuAtk:' + c.uid)) return;
      const o = best(hellAvatars(g, c.ctrl, (x) => named(x, 'โอตะ')), (x) => keepValue(g, x));
      if (o) { markOnce(g, P(g, c.ctrl), 'luxuAtk:' + c.uid); attach(g, o, c); }
    },
  },
  'นายนิรยบาล "เต๋า"': { keep: 3, onMilled: (g, c, p) => { mill(g, p, 2); mill(g, opp(p), 2); } },

  // ===== อีสานสลิงเกอร์ / น้าแมน / YaiMakMak =====
  'โคกอีสานนูน': {
    keep: 6,
    blockReact: (g: Game, self: Card) => (self.f.kokFight === g.turn ? 'magic' : null), // other-team audit
    canCast: (g, p) => !g.land || g.land.owner !== p,
    fieldActs: (g, p, c) => [
      act('โคก: recycle 6 from hell, draw 1', (g2) => inMain(g2, p) && once(g2, p, 'kok1') && onZone(g2, p, 'อีสานสลิงเกอร์').length > 0 && P(g2, p).hell.length >= 6,
        (g2) => {
          const pl = P(g2, p); markOnce(g2, pl, 'kok1');
          // choose 6 cards in our Hell, at most 2 of them Magic
          const pick: Card[] = [];
          while (pick.length < 6) {
            const mags = pick.filter((x) => x.def.type === 'Magic').length;
            const pool = pl.hell.filter((x) => !pick.includes(x) && (x.def.type !== 'Magic' || mags < 2));
            const x = pool.length <= 6 - pick.length ? pool[0] : worst(pool, (y) => keepValue(g2, y) + (y.def.type === 'Magic' ? 2 : 0));
            if (!x) break; pick.push(x);
          }
          if (pick.length < 6) return;
          for (const x of pick) { detach(g2, x); pl.deck.push(x); }
          shuffle(g2, pl.deck); draw(g2, p, 1); pl.once['kokRecycled'] = g2.turn;
        }),
      act('โคก: forced fight', (g2) => inMain(g2, p) && once(g2, p, 'kok2') && P(g2, p).once['kokRecycled'] === g2.turn
        && onZone(g2, p, 'อีสานสลิงเกอร์').length > 0 && P(g2, opp(p)).avatars.length > 0,
      (g2) => {
        markOnce(g2, P(g2, p), 'kok2');
        const s = best(onZone(g2, p, 'อีสานสลิงเกอร์'), (a) => power(g2, a));
        const t = best(P(g2, opp(p)).avatars.filter((a) => power(g2, a) < power(g2, s!) || (power(g2, a) === power(g2, s!) && FX[s!.def.name]?.tieWin)), (a) => value(g2, a));
        if (!s || !t) return;
        // other-team audit: a fight in which neither player may use React Magic
        c.f.kokFight = g2.turn;
        try { if (destroy(g2, t, p, false, { battle: true }) && s.def.name.includes('เปอร์')) flipLife(g2, opp(p)); } finally { delete c.f.kokFight; }
      }),
    ],
  },
  'คุณโดม ผู้จัดการทีมการ์ด': {
    keep: 3,
    fieldActs: (g, p, c) => [act('คุณโดม: roll for power', (g2) => inMain(g2, p) && once(g2, p, 'dome'), (g2) => { markOnce(g2, P(g2, p), 'dome'); boost(c, d6(g2)); })],
    deathCry: (g, c, owner) => { const pl = P(g, owner); if (pl.hell.includes(c)) { detach(g, c); pl.deck.push(c); shuffle(g, pl.deck); } },
  },
  'พี่วัฒน์ BGN': {
    keep: 4,
    jutsu: (g, c) => {
      const p = c.ctrl; if (!once(g, p, 'wat')) return; markOnce(g, P(g, p), 'wat');
      for (const q of [p, opp(p)] as PID[]) { const pl = P(g, q); if (pl.hand.length < 5) draw(g, q, 5 - pl.hand.length); else decide(g, q, () => discardWorst(g, q, pl.hand.length - 5)); }
      const gp = P(g, p).hand.reduce((s, x) => s + x.def.gem, 0), go = P(g, opp(p)).hand.reduce((s, x) => s + x.def.gem, 0);
      log(g, `พี่วัฒน์ BGN: hands shown, GEM P${p} ${gp} / P${opp(p)} ${go}`); // แสดงการ์ดบนมือทั้งหมด
      if (gp !== go) { // the player with less GEM chooses (that may be the opponent)
        const q: PID = gp < go ? p : opp(p);
        decide(g, q, () => {
          const foes = P(g, opp(q)).avatars, top = foes.reduce((m, a) => Math.max(m, value(g, a)), -Infinity);
          const bot = top > 5 ? 2 : P(g, q).avatars.length >= 2 || P(g, q).deck.length < 2 ? 1 : 0;
          const m = chooseMode(g, c, ['2 cards from the bottom of the Deck to hand', 'Our Avatars POWER +2', 'Take control of an opponent Avatar'], bot);
          const t = m === 2 ? best(foes, (a) => value(g, a)) : null;
          // simplify1: control lasts until the end of the owner's next Draw Phase (engine ctrlUntilOwnerDraw)
          if (t && steal(g, q, t)) ctrlUntilOwnerDraw(g, t);
          // simplify1: "ณ ขณะนั้น POWER +2" has no duration: permanent while each of those Avatars stays (addPower 'perm')
          else if (m === 1 || (m === 2 && !t)) for (const a of [...P(g, q).avatars]) addPower(g, a, 2, 'perm', c);
          else if (m === 0) { const pl = P(g, q); for (let i = 0; i < 2 && pl.deck.length; i++) addToHand(g, pl.deck[pl.deck.length - 1], q, { from: 'deck' }); } // 2 cards from the bottom
        });
      }
    },
  },
  'YaiMakMak': {
    keep: 5, unique: true, alias: ['สมาชม'],
    jutsu: (g, c) => { const pl = P(g, c.ctrl); fromZoneSummon(g, c.ctrl, pl.deck, (x) => named(x, 'สมาชม') && x.def.name !== 'YaiMakMak'); shuffle(g, pl.deck); },
    fieldActs: (g, p, c) => [act('YaiMakMak: destroy by สมาชม count', (g2) => inMain(g2, p) && once(g2, p, 'yai') && onZone(g2, p, 'สมาชม').length >= 2 && P(g2, opp(p)).avatars.some((a) => a.def.cost <= 4),
      (g2) => {
        markOnce(g2, P(g2, p), 'yai');
        const k = onZone(g2, p, 'สมาชม').filter((a) => a !== c).length;
        for (let i = 0; i < k; i++) { const t = best(P(g2, opp(p)).avatars.filter((a) => a.def.cost <= 4 - i), (a) => value(g2, a)); if (t) destroy(g2, t, p); }
      })],
  },
  'แอชลีย์': {
    keep: 4, unique: true, alias: ['สมาชม'],
    fieldActs: (g, p, c) => [act('แอชลีย์: borrow from opponent hell', (g2) => inMain(g2, p) && once(g2, p, 'ashley') && onZone(g2, p, 'สมาชม').length >= 2
      && P(g2, p).hand.length >= 1 && hellAvatars(g2, opp(p)).length > 0 && canPlaceAvatar(P(g2, p)),
    (g2) => {
      markOnce(g2, P(g2, p), 'ashley'); discardWorst(g2, p, 1);
      const t = oppChoice(g2, p, () => worst(hellAvatars(g2, opp(p)), (x) => x.def.power)); // the opponent picks
      if (t && summon(g2, p, t, 'effect')) { t.silencedTurn = g2.turn; t.f.endHell = g2.turn; }
    })],
  },
  'น้าแมน': {
    keep: 4, unique: true, alias: ['สมาชม'],
    fieldActs: (g, p, c) => [act('น้าแมน: flip states', (g2) => inMain(g2, p) && once(g2, p, 'naman') && onZone(g2, p, 'สมาชม').length >= 2
      && P(g2, p).avatars.some((a) => a.asleep) && P(g2, opp(p)).avatars.length > 0,
    (g2) => {
      markOnce(g2, P(g2, p), 'naman');
      const mine = best(P(g2, p).avatars.filter((a) => a.asleep), (a) => power(g2, a)); if (mine) mine.asleep = false;
      const theirs = best(P(g2, opp(p)).avatars.filter((a) => !a.asleep), (a) => value(g2, a)); if (theirs) theirs.asleep = true;
    })],
  },
  'อีสานสลิงเกอร์ ปิ๊ก': {
    keep: 4, tieWin: true,
    jutsu: (g, c) => {
      const p = c.ctrl;
      if (![...P(g, p).deck, ...P(g, p).hell].some((x) => x.def.name === 'โคกอีสานนูน')) { log(g, 'อีสานสลิงเกอร์ ปิ๊ก: no โคกอีสานนูน in Deck or Hell, จุติ does nothing'); return; } // other-team audit: no mill then
      mill(g, p, 3);
      if (!search(g, p, (x) => x.def.name === 'โคกอีสานนูน', 'hell')) search(g, p, (x) => x.def.name === 'โคกอีสานนูน', 'deck');
    },
  },
  'อีสานสลิงเกอร์ เปอร์': {
    keep: 3.5,
    fieldActs: (g, p, c) => [act('เปอร์: mill 3, +2', (g2) => inMain(g2, p) && once(g2, p, 'per:' + c.uid) && !!landOn(g2, 'โคกอีสานนูน') && P(g2, p).deck.length > 8,
      (g2) => { markOnce(g2, P(g2, p), 'per:' + c.uid); mill(g2, p, 3); boost(c, 2); })],
  },
  'อู๊ด ประธานผู้รู้ความจริง': {
    keep: 4,
    jutsu: (g, c) => {
      const p = c.ctrl; let sum = 0;
      peek(g, p, 2, (top) => { sum = top.reduce((s, x) => s + (x.def.type === 'Magic' ? 0 : x.def.cost), 0); }, 'either');
      const t = best(P(g, opp(p)).avatars.filter((a) => a.def.cost <= sum), (a) => value(g, a)); if (t) destroy(g, t, p);
    },
  },
  // 'หมีดำ': group E entry at the end of this file,
  'ศาลพระภูมิ': {
    keep: 4,
    jutsu: (g, c) => { const pl = P(g, c.ctrl); fromZoneSummon(g, c.ctrl, pl.deck, (x) => symIs(x, 'ผี')); shuffle(g, pl.deck); },
    untargetable: (g, c) => P(g, c.ctrl).avatars.some((a) => a !== c && symIs(a, 'ผี')),
  },
  // 'วูตาตู': group E entry at the end of this file,
  'แม่นาค พระปะแดง': {
    keep: 3,
    onSummon: (g, c) => {
      const o = P(g, opp(c.ctrl)); const x = best(o.hell, (y) => keepValue(g, y));
      if (!x) return; detach(g, x); o.deck.push(x);
      const t = best(o.avatars, (a) => value(g, a)); if (t) boost(t, -2);
    },
  },
  // 'สิงสู่เพื่อสู่สม': group E entry at the end of this file,
  'เยี่ยวรดศาล': {
    keep: 3.5,
    canCast: (g, p) => P(g, p).avatars.some((a) => symIs(a, 'คน') && a.def.cost >= 3) && P(g, p).deck.some((x) => symIs(x, 'ผี') && x.def.cost <= 4),
    resolve: (g, p) => { fromZoneSummon(g, p, P(g, p).deck, (x) => symIs(x, 'ผี') && x.def.cost <= 4, 'jutsu'); shuffle(g, P(g, p).deck); },
  },
  'ลุ้นเยี่ยวเหนียว': {
    keep: 3,
    react: {
      on: ['attack'], can: (g, p, c, ev) => ev.actor !== p && P(g, p).avatars.length > 0 && P(g, opp(p)).avatars.length > 0,
      want: (g, p) => P(g, opp(p)).avatars.reduce((s, a) => s + value(g, a), 0) > P(g, p).avatars.reduce((s, a) => s + value(g, a), 0) + 4,
      resolve: (g, p, c, ev) => {
        let a = 0, b = 0; while (a === b) { a = d6(g); b = d6(g); }
        const loser = a < b ? p : opp(p);
        for (const x of [...P(g, loser).avatars]) { toHell(g, x); const pl = P(g, x.owner); const i = pl.hell.indexOf(x); if (i >= 0) { pl.hell.splice(i, 1); pl.deck.push(x); } }
        if (loser !== p) ev.cancelled = true;
      },
    },
  },
  // 'ริกกี้ นักปลอมแปลง': group E entry at the end of this file

  // ===== ยักษ์ (ทศกัณฐ์) =====
  'นนทก นิ้วเพชร': {
    keep: 3.5,
    onAttack: (g, c, t) => { if (t && (symIs(t, 'เทพ') || !!landOn(g, 'แอสการ์ดคือสถานที่ไม่ใช่ผู้คน'))) destroy(g, t, c.ctrl); },
  },
  'พญายักษ์ ทศกัณฑ์': {
    keep: 5,
    fieldActs: (g, p, c) => [act('ทศกัณฑ์: discard 1, call ยักษ์ POWER 3', (g2) => inMain(g2, p) && once(g2, p, 'tos') && P(g2, p).hand.length >= 1 && canPlaceAvatar(P(g2, p))
      && P(g2, p).deck.some((x) => isA(x) && symIs(x, 'ยักษ์') && x.def.power === 3 && !x.def.name.includes('ทศกัณ')),
    (g2) => { markOnce(g2, P(g2, p), 'tos'); discardWorst(g2, p, 1); fromZoneSummon(g2, p, P(g2, p).deck, (x) => symIs(x, 'ยักษ์') && x.def.power === 3 && !x.def.name.includes('ทศกัณ')); shuffle(g2, P(g2, p).deck); })],
  },
  'กุมภกรรณ ทดน้ำ': { keep: 4, aura: (g, s, t) => (t.ctrl !== s.ctrl ? -1 : 0) },
  'ไมยราพ': {
    keep: 4.5,
    jutsu: (g, c) => {
      const pl = P(g, c.ctrl);
      for (let i = 0; i < 2; i++) fromZoneSummon(g, c.ctrl, pl.deck, (x) => symIs(x, 'ยักษ์') && x.def.cost <= 3 && noAbilityNow(g, x)); // no Text Box (engine noAbilityNow, shared)
      shuffle(g, pl.deck);
    },
  },
  'มณโฑ ราชินีเหล่ายักษ์': {
    keep: 4,
    fieldActs: (g, p, c) => [act('มณโฑ: swap ยักษ์ from hell', (g2) => inMain(g2, p) && once(g2, p, 'mondo')
      && P(g2, p).avatars.some((a) => symIs(a, 'ยักษ์') && hellAvatars(g2, p, (x) => symIs(x, 'ยักษ์') && x.def.power === a.def.power && x.def.name !== a.def.name).length > 0),
    (g2) => {
      markOnce(g2, P(g2, p), 'mondo');
      const s = worst(P(g2, p).avatars.filter((a) => symIs(a, 'ยักษ์') && hellAvatars(g2, p, (x) => symIs(x, 'ยักษ์') && x.def.power === a.def.power && x.def.name !== a.def.name).length > 0), (a) => value(g2, a));
      if (!s) return;
      const pw = s.def.power, nm = s.def.name; destroy(g2, s, p);
      const t = fromZoneSummon(g2, p, P(g2, p).hell, (x) => symIs(x, 'ยักษ์') && x.def.power === pw && x.def.name !== nm);
      if (t) boost(t, 2);
    })],
  },
  'นางมณโฑ': { keep: 3.5, jutsu: (g, c) => { fromZoneSummon(g, c.ctrl, P(g, c.ctrl).hell, (x) => symIs(x, 'ยักษ์') && x.def.power <= 3); } },
  'จ่ายุทธ ทหารรักชาติ': { keep: 3.5, onAttack: (g, c, t) => { if (t && symIs(t, 'ต่างชาติ')) destroy(g, t, c.ctrl); } },
  '1 - 2 - 2': {
    keep: 4,
    canCast: (g, p) => P(g, p).once['summoned'] !== g.turn && !P(g, p).used.Normal && P(g, p).deck.length > 6,
    resolve: (g, p) => { draw(g, p, 3); P(g, p).once['noDraw'] = g.turn + 2; },
  },
  'หมอมาแล้วววว': {
    keep: 5,
    react: {
      on: ['destroy'], can: (g, p, c, ev) => !!ev.source && ev.source.ctrl === p,
      want: (g, p, c, ev) => value(g, ev.source!) >= 5,
      resolve: cancel,
    },
  },
  'แอสการ์ดคือสถานที่ไม่ใช่ผู้คน': {
    keep: 3,
    // bugfix2 item 4 (user): it can always be placed (the bot still waits for a use: canCast is also its play check)
    canCast: (g, p) => (!g.land || g.land.owner !== p) && (humanSeat(g, p) || P(g, p).avatars.some((a) => a.def.name.includes('นนทก')) || P(g, opp(p)).avatars.some((a) => a.asleep && a.def.cost <= 3)),
    fieldActs: (g, p, c) => [act('แอสการ์ด: borrow a sleeping Avatar', (g2) => inMain(g2, p) && once(g2, p, 'asgard') && P(g2, p).hand.length >= 1 && canPlaceAvatar(P(g2, p))
      && P(g2, opp(p)).avatars.some((a) => a.asleep && a.def.cost <= 3),
    (g2) => {
      markOnce(g2, P(g2, p), 'asgard'); discardWorst(g2, p, 1);
      const t = best(P(g2, opp(p)).avatars.filter((a) => a.asleep && a.def.cost <= 3), (a) => value(g2, a));
      if (t && steal(g2, p, t, true)) t.f.returnCtrl = g2.turn;
    })],
  },

  // ===== ไอดอล / โอตะ =====
  'มีมมิจัง ไอดอล No.1': {
    keep: 8,
    jutsu: (g, c) => {
      const pl = P(g, c.ctrl);
      const idol = fromZoneSummon(g, c.ctrl, pl.deck, (x) => named(x, 'ไอดอล') && !x.def.only);
      const ota = best(pl.deck.filter((x) => named(x, 'โอตะ') && isA(x)), (x) => keepValue(g, x));
      if (idol && ota && pl.avatars.includes(idol)) attach(g, ota, idol);
      shuffle(g, pl.deck);
    },
    endPhase: (g, c) => { const pl = P(g, c.ctrl); toHell(g, c); detach(g, c); pl.deck.push(c); shuffle(g, pl.deck); draw(g, c.ctrl, 1); },
  },
  'มีมมิจัง ไอดอลหน้าใหม่': {
    keep: 4,
    jutsu: (g, c) => { const pl = P(g, c.ctrl); const ota = best(pl.deck.filter((x) => named(x, 'โอตะ') && isA(x)), (x) => keepValue(g, x)); if (ota) attach(g, ota, c); shuffle(g, pl.deck); },
  },
  // 'โอตะคูลา': group E entry at the end of this file,
  'แบมบูจัง ไอดอลสองขั้ว': {
    keep: 4.5,
    fieldActs: (g, p, c) => [act('แบมบู: pop โอตะ, destroy a card', (g2) => inMain(g2, p) && once(g2, p, 'bambu') && P(g2, opp(p)).avatars.length > 0
      && onZone(g2, p, 'ไอดอล').some((a) => a.mods.some((m) => named(m, 'โอตะ'))),
    (g2) => {
      markOnce(g2, P(g2, p), 'bambu');
      const m = worst(onZone(g2, p, 'ไอดอล').flatMap((a) => a.mods.filter((x) => named(x, 'โอตะ'))), (x) => keepValue(g2, x));
      if (!m) return;
      detach(g2, m); P(g2, m.owner).hell.push(m);
      const t = best(P(g2, opp(p)).avatars, (a) => value(g2, a)); if (t) destroy(g2, t, p);
    })],
  },
  'โทมาโทจัง ไอดอลเด็กน้อย': {
    keep: 3,
    aura: (g, s, t) => (t !== s && t.ctrl === s.ctrl && named(t, 'ไอดอล') && t.mods.some((m) => named(m, 'โอตะ')) ? 2 : 0),
    untargetable: (g, c) => c.mods.some((m) => named(m, 'โอตะ')) && P(g, c.ctrl).avatars.some((a) => a !== c && named(a, 'ไอดอล') && a.def.name !== c.def.name),
  },
  'มยุราซัง  ไอดอลยุค 80': {
    keep: 3,
    fieldActs: (g, p, c) => {
      // with ทัตดนัยซัง โปรดิวเซอร์มือทอง on our zone the โอตะ may come from the Deck instead
      const pool = (g2: Game) => [...hellAvatars(g2, p, (x) => named(x, 'โอตะ')),
        ...(onZone(g2, p, 'ทัตดนัยซัง').length ? P(g2, p).deck.filter((x) => isA(x) && named(x, 'โอตะ')) : [])];
      return [act('มยุรา: equip โอตะ from hell', (g2) => inMain(g2, p) && once(g2, p, 'mayura') && onZone(g2, p, 'ไอดอล').some((a) => a !== c)
        && pool(g2).length > 0,
      (g2) => {
        markOnce(g2, P(g2, p), 'mayura');
        const w = best(onZone(g2, p, 'ไอดอล').filter((a) => a !== c), (a) => value(g2, a));
        const o = best(pool(g2), (x) => keepValue(g2, x));
        const fromDeck = !!o && P(g2, p).deck.includes(o);
        if (w && o) attach(g2, o, w);
        if (fromDeck) shuffle(g2, P(g2, p).deck);
      })];
    },
  },
  'โอตะ รุ่นก่อตั้ง': {
    keep: 1.5,
    fieldActs: (g, p, c) => otaOnZone(g, p, c),
    // not when we destroy the ไอดอล ourselves (sacrifice as a cost)
    // other-team audit: "Avatar ชื่อ ไอดอล บนสนาม" = any of our ไอดอล (not only its wearer); "สามารถ" = optional
    leaveGuard: (g, m, t, info) => (info.how === 'destroy' && !info.cost && info.by !== t.ctrl && fzE(g, m) === 'mod' && m.ctrl === t.ctrl
      && info.zone === 'avatars' && named(t, 'ไอดอล') ? { label: `destroy โอตะ รุ่นก่อตั้ง instead of ${t.def.name}`, want: true,
        run: () => { if (fzE(g, m) !== 'mod') return false; toHell(g, m, { cost: true }); log(g, 'โอตะ รุ่นก่อตั้ง dies instead'); return true; } } : null),
  },
  'โอตะปุส': { keep: 2, fieldActs: (g, p, c) => otaOnZone(g, p, c), deathCry: (g, c, owner) => draw(g, owner, 1) },
  'โอตะตัวกะปอม': {
    keep: 1, costOnlyFor: (s) => named(s, 'ไอดอล'),
    usedAsCost: (g, p, c, s) => { if (named(s, 'ไอดอล') && P(g, p).avatars.includes(s) && mayDo(g, c, `attach it to ${s.def.name}`, true)) attach(g, c, s); }, // bugs7 item 7: "สามารถ" = optional
    modPower: () => 1,
  },
  'ของขวัญจากโอตะ': {
    keep: 2, costOnlyFor: (s) => named(s, 'ไอดอล') || named(s, 'โปรดิวเซอร์'),
    canCast: (g, p) => onZone(g, p, 'ไอดอล').length > 0,
    modTarget: (g, p) => best(onZone(g, p, 'ไอดอล'), (a) => value(g, a)),
    onAttach: (g, m, w) => draw(g, m.owner, 1),
  },
  'งานจับมือ': {
    keep: 4.5,
    react: {
      on: ['attack'], can: (g, p, c, ev) => ev.actor !== p && !!ev.target && named(ev.target, 'ไอดอล'),
      want: (g, p, c, ev) => power(g, ev.source!) >= power(g, ev.target!),
      resolve: (g, p, c, ev) => {
        ev.cancelled = true;
        const o = best(hellAvatars(g, p, (x) => named(x, 'โอตะ')), (x) => keepValue(g, x));
        const w = best(onZone(g, p, 'ไอดอล'), (a) => value(g, a));
        if (o && w) attach(g, o, w);
      },
    },
  },
  'เวทีแห่งความฝัน': {
    keep: 3,
    canCast: (g, p) => !g.land || g.land.owner !== p,
    fieldActs: (g, p, c) => [act('เวที: discard 1, find โอตะ/ไอดอล', (g2) => inMain(g2, p) && once(g2, p, 'stage') && P(g2, p).hand.length >= 1 && P(g2, p).deck.length > 7,
      (g2) => {
        markOnce(g2, P(g2, p), 'stage'); discardWorst(g2, p, 1);
        const idols = onZone(g2, p, 'ไอดอล');
        const md = chooseMode(g2, c, ['Scout 5: up to 2 โอตะ onto a ไอดอล', 'Scout 7: a ไอดอล to hand'], idols.length ? 0 : 1);
        const idol = md === 0 ? best(idols, (a) => value(g2, a)) : null;
        if (md === 0 && !idol) peek(g2, p, 5, () => {});
        else if (idol) peek(g2, p, 5, (top) => { for (let i = 0; i < 2; i++) { const o = best(top.filter((x) => named(x, 'โอตะ') && isA(x)), (x) => keepValue(g2, x)); if (o) { top.splice(top.indexOf(o), 1); P(g2, p).hell.push(o); attach(g2, o, idol); } } });
        else peek(g2, p, 7, (top) => takeHand(g2, p, top, (x) => named(x, 'ไอดอล')));
      })],
  },

  // ===== ยอดมนุษย์ (เพมมุ) =====
  'ทศกัณฐ์ยักษ์ที่---เมียพระอิศวร': {
    keep: 8,
    jutsu: (g, c) => { const t = pickN(P(g, opp(c.ctrl)).avatars, 1, (a) => value(g, a), { optional: true, title: `${c.def.name}: you may take control of 1 opposing Avatar` })[0]; if (t) steal(g, c.ctrl, t, true); }, // bugs7 item 7: "สามารถ" = optional
  },
  'เพมมุ ยอดมนุษย์': {
    keep: 5,
    staticPower: (g, c) => (c.mods.some((m) => named(m, 'อาวุธของเพมมุ')) ? 2 : 0), // base text: always
    refuseMod: (g, c, m) => !named(m, 'อาวุธของเพมมุ'), // base text: can only wear "อาวุธของเพมมุ"
    // linkbot: the IKUZO AIBOU ability is below [Link สไปรท์ ยอดสุนัข]: only while in Link with สไปรท์
    fieldActs: (g, p, c) => [act('เพมมุ: IKUZO AIBOU (equip weapon from Deck)', (g2) => inMain(g2, p) && linked(g2, c, 'สไปรท์') && once(g2, p, 'pemmu') && !P(g2, p).used.Modification
      && !c.mods.some((m) => named(m, 'อาวุธของเพมมุ')) && P(g2, p).deck.some((x) => named(x, 'อาวุธของเพมมุ')),
    (g2) => {
      const pl = P(g2, p); markOnce(g2, pl, 'pemmu'); pl.used.Modification = true;
      const w = best(pl.deck.filter((x) => named(x, 'อาวุธของเพมมุ')), (x) => keepValue(g2, x) + (x.def.name.includes('ดาบมาร') ? 1 : 0));
      if (w) attach(g2, w, c); shuffle(g2, pl.deck);
    })],
  },
  'สไปรท์ ยอดสุนัข': {
    keep: 5,
    // linkbot: all of its text is below [Link เพมมุ ยอดมนุษย์]: nothing works until the Link with เพมมุ
    kwIf: (g, c, kw) => (kw === 'shield' || kw === 'tieWin' || kw === 'unite') && linked(g, c, 'เพมมุ'),
    // other-team audit: "สภาพตื่น และ/หรือ POWER +2": the player chooses
    endPhase: (g, c) => { if (c.asleep && linked(g, c, 'เพมมุ')) { const m = decide(g, c.ctrl, () => chooseMode(g, c, ['Wake up + POWER +2', 'Wake up only', 'POWER +2 only'], 0)); if (m !== 2) c.asleep = false; if (m !== 1) c.f.spriteUntil = g.turn + 1; } },
    staticPower: (g, c) => (c.f.spriteUntil && c.f.spriteUntil >= g.turn && linked(g, c, 'เพมมุ') ? 2 : 0),
  },
  'เมย์ แวมไพร์โกธิค': {
    keep: 4,
    staticPower: (g, c) => (linked(g, c, 'เจ้าหญิงรวงข้าว') ? 3 : 0), // [Link] part: base POWER 5
    // linkbot: [Link] part: the opponent can't choose its Linked เจ้าหญิงรวงข้าว with card abilities either (attacks: รวงข้าว untargetable)
    noTarget: (g, self, t, by) => !!by && by.ctrl !== self.ctrl && t.ctrl === self.ctrl && named(t, 'เจ้าหญิงรวงข้าว') && t.f.linkWith === self.uid && linked(g, self, 'เจ้าหญิงรวงข้าว'),
    react: {
      on: ['fight'], noLimit: true, fromHand: true,
      can: (g, p, c, ev) => !!ev.target && ev.target.ctrl === p && (named(ev.target, 'เพมมุ') || named(ev.target, 'สไปรท์')) && !P(g, p).exile.some((x) => x.def.name === c.def.name),
      want: (g, p, c, ev) => power(g, ev.target!) <= power(g, ev.source!) && power(g, ev.target!) + 4 > power(g, ev.source!),
      resolve: (g, p, c, ev) => { toExile(g, c); boost(ev.target!, 4); },
    },
  },
  'เจ้าหญิงรวงข้าว': {
    keep: 3,
    jutsu: (g, c) => {
      const pl = P(g, c.ctrl);
      const x = best([...pl.exile.filter((y) => y.def.name.includes('เมย์ แวมไพร์')), ...pl.hell.filter((y) => named(y, 'อาวุธของเพมมุ'))], (y) => (pl.exile.includes(y) ? 1 : 0) + keepValue(g, y));
      if (x) { detach(g, x); pl.deck.push(x); shuffle(g, pl.deck); }
      draw(g, c.ctrl, 1);
    },
    // linkbot: เพมมุ / สไปรท์ / เมย์ แวมไพร์โกธิค "in [Link] state" (the Link action), each of them
    aura: (g, s, t) => (t.ctrl === s.ctrl && t !== s && turnOf(g, s) && P(g, s.ctrl).avatars.includes(s) && (named(t, 'เพมมุ') || named(t, 'สไปรท์') || named(t, 'เมย์ แวมไพร์')) && isLinked(g, t) ? 2 : 0),
    untargetable: (g, c) => linked(g, c, 'เมย์ แวมไพร์'),
  },
  'มิสทรอม่า': {
    keep: 4,
    jutsu: (g, c) => {
      const p = c.ctrl;
      if (g.land && g.land.owner !== p) { P(g, g.land.owner).hell.push(g.land); g.land = null; }
      const l = P(g, p).deck.find((x) => x.def.name === 'ดินแดนยุติธรรม');
      if (l) { placeLand(g, p, l); shuffle(g, P(g, p).deck); }
    },
    // linkbot: +2 when the Avatars in [Link] are เพมมุ and สไปรท์ (Linked with each other), else +1 for any Avatar in [Link]
    staticPower: (g, c) => (P(g, c.ctrl).avatars.some((a) => named(a, 'เพมมุ') && linked(g, a, 'สไปรท์')) ? 2 : P(g, c.ctrl).avatars.some((a) => isLinked(g, a)) ? 1 : 0),
  },
  // 'K-BO ยอดหุ่นยนต์': group E entry at the end of this file,
  'จอมหักกระดูก': {
    keep: 4.5, shield: true,
    battle: (g, c, other) => { const extra = power(g, other) - other.def.power; if (extra !== 0) other.temp.push({ power: -extra, until: 'battle' }); }, // set to base POWER (up or down)
  },
  'แมวดำ สมาชิกลัทธิแห่หัว': {
    keep: 1,
    fieldActs: (g, p, c) => [act('แมวดำ: opponent mills 1', (g2) => inMain(g2, p) && once(g2, p, 'cat:' + c.uid), (g2) => { markOnce(g2, P(g2, p), 'cat:' + c.uid); mill(g2, opp(p), 1); })],
  },
  'ผจญภัยด้วยกัน': {
    keep: 4, options: 2,
    canCast: (g, p, c, o) => o === 0 ? onZone(g, p, 'เพมมุ').length > 0 && P(g, p).deck.some((x) => named(x, 'สไปรท์')) : onZone(g, p, 'สไปรท์').length > 0 && P(g, p).deck.some((x) => named(x, 'เพมมุ')),
    resolve: (g, p, c, o) => { fromZoneSummon(g, p, P(g, p).deck, (x) => named(x, o === 0 ? 'สไปรท์' : 'เพมมุ')); shuffle(g, P(g, p).deck); },
  },
  'อาวุธของเพมมุ ปืนพกรุ่น 19': {
    keep: 3,
    canCast: (g, p) => onZone(g, p, 'เพมมุ').some((a) => !a.mods.some((m) => named(m, 'อาวุธของเพมมุ'))),
    modTarget: (g, p) => best(onZone(g, p, 'เพมมุ').filter((a) => !a.mods.some((m) => named(m, 'อาวุธของเพมมุ'))), (a) => value(g, a)),
    onWearerKill: (g, m, w, vp) => { if (g.active === w.ctrl && vp <= power(g, w) - 2) flipLife(g, opp(w.ctrl)); }, // only when it attacked
  },
  'อาวุธของเพมมุ ดาบมารไร้พ่าย': {
    keep: 3.5,
    canCast: (g, p) => onZone(g, p, 'เพมมุ').some((a) => !a.mods.some((m) => named(m, 'อาวุธของเพมมุ'))),
    modTarget: (g, p) => best(onZone(g, p, 'เพมมุ').filter((a) => !a.mods.some((m) => named(m, 'อาวุธของเพมมุ'))), (a) => value(g, a)),
    modPower: () => 1,
    onWearerKill: (g, m, w, vp) => {
      if (g.active !== w.ctrl) return;
      const t = best(P(g, opp(w.ctrl)).avatars.filter((a) => a.def.power <= vp), (a) => value(g, a)); if (t) destroy(g, t, w.ctrl);
      // then may destroy this card to change the state of a เพมมุ (wake the wearer to attack again)
      if (w.asleep && g.phase === 'Battle' && w.mods.includes(m) && P(g, w.ctrl).avatars.includes(w)
        && mayDo(g, m, `destroy this card to wake ${w.def.name} up`, P(g, opp(w.ctrl)).avatars.length === 0 || P(g, opp(w.ctrl)).avatars.some((a) => power(g, a) < power(g, w) - 1))) { // bugs7 item 7: "สามารถ" = optional
        detach(g, m); P(g, m.owner).hell.push(m); w.asleep = false;
      }
    },
  },
  'ทำไมถึงเอาแต่ดูละครับ ?!': {
    keep: 3, gemAs: (g, c, s) => (s && isA(s) && LINKERS.includes(s.def.name) ? 4 : c.def.gem),
    react: {
      on: ['attack'], can: (g, p, c, ev) => ev.actor !== p && P(g, p).avatars.some((a) => isLinked(g, a)),
      want: (g, p, c, ev) => { const t = best(P(g, p).avatars.filter((a) => isLinked(g, a)), (a) => power(g, a)); return !!t && power(g, t) + 3 > power(g, ev.source!) && (ev.target === null || power(g, ev.target!) <= power(g, ev.source!)); },
      resolve: (g, p, c, ev) => { const t = best(P(g, p).avatars.filter((a) => isLinked(g, a)), (a) => power(g, a)); if (t) { ev.target = t; boost(t, 3); } },
    },
  },
  // 'ดินแดนยุติธรรม': group E entry at the end of this file

  // ===== โพลีกอน =====
  'ลูเซีย โพลีกอน': {
    keep: 3,
    fieldActs: (g, p, c) => [act('ลูเซีย: set up top of Deck', (g2) => inMain(g2, p) && once(g2, p, 'lucia') && P(g2, p).deck.some((x) => isA(x) && x.def.cost <= 5 && !x.def.only && (named(x, 'โพลิกอน') || named(x, 'โพลีกอน') || symAny(x, ['เทพ', 'นรก']))),
      (g2) => {
        const pl = P(g2, p); markOnce(g2, pl, 'lucia');
        const x = best(pl.deck.filter((y) => isA(y) && y.def.cost <= 5 && !y.def.only && (named(y, 'โพลิกอน') || named(y, 'โพลีกอน') || symAny(y, ['เทพ', 'นรก']))), (y) => value(g2, y));
        shuffle(g2, pl.deck); if (x) { pl.deck.splice(pl.deck.indexOf(x), 1); pl.deck.unshift(x); }
      })],
  },
  'โฮคุ โพลีกอน': {
    keep: 5,
    // other-team audit Q14 (user: "ใบอื่น", it does not count itself): +1 only with another โพลิกอน on our Avatar Zone
    staticPower: (g, c) => (P(g, c.ctrl).avatars.includes(c) && P(g, c.ctrl).avatars.some((a) => a !== c && (nameHas(a, 'โพลิกอน') || nameHas(a, 'โพลีกอน'))) ? 1 : 0), // superair: effective names too
    onLink: (g, c) => hokuLink(g, c.ctrl), // v14 features: when the Link action forms the pair
    taunt: (g, c) => linked(g, c, 'โซน่า'),
  },
  'ลุงน้อย พ่อค้าไก่ย่าง': {
    keep: 3,
    jutsu: (g, c) => { const p = c.ctrl; draw(g, p, 3); for (let i = 0; i < 2; i++) { const d = worst(P(g, p).hand, (x) => keepValue(g, x)); if (d) { detach(g, d); P(g, p).deck.push(d); } } shuffle(g, P(g, p).deck); },
  },
  'ลูเซเน่ โพลีกอน': {
    keep: 4, alias: ['จอมเวทย์'],
    staticPower: (g, c) => (P(g, c.ctrl).avatars.some((a) => a !== c && (named(a, 'โพลิกอน') || named(a, 'โพลีกอน'))) ? 2 : P(g, c.ctrl).avatars.some((a) => a !== c && named(a, 'จอมเวทย์')) ? 1 : 0),
    fieldActs: (g, p, c) => [act('ลูเซเน่: replay a Magic from hell', (g2) => inMain(g2, p) && once(g2, p, 'lucene') && P(g2, p).hand.length >= 1
      && P(g2, p).hell.some((x) => x.def.type === 'Magic' && x.def.subtype === 'Normal' && !x.def.only && FX[x.def.name]?.resolve && !P(g2, p).used.Normal && (!FX[x.def.name].canCast || FX[x.def.name].canCast!(g2, p, x, 0))),
    (g2) => {
      const pl = P(g2, p); markOnce(g2, pl, 'lucene'); discardWorst(g2, p, 1);
      const m = best(pl.hell.filter((x) => x.def.type === 'Magic' && x.def.subtype === 'Normal' && !x.def.only && FX[x.def.name]?.resolve && (!FX[x.def.name].canCast || FX[x.def.name].canCast!(g2, p, x, 0))), (x) => keepValue(g2, x));
      if (!m) return; toExile(g2, m); pl.used.Normal = true; FX[m.def.name].resolve!(g2, p, m, 0);
    })],
  },
  'นักรบ ฮอล': {
    keep: 3.5,
    deathCry: (g, c, owner) => draw(g, owner, 1),
    react: {
      on: ['attack'], noLimit: true, fromHand: true,
      can: (g, p, c, ev) => ev.actor !== p && canPlaceAvatar(P(g, p)) && bestPayment(g, p, c.def.cost, [c], c) !== null,
      want: (g, p, c, ev) => ev.target === null || power(g, ev.target!) < power(g, ev.source!),
      resolve: (g, p, c, ev) => { const pay = choosePayment(g, p, c.def.cost, [c], c); if (pay && summon(g, p, c, 'paid', pay)) ev.target = c; },
    },
  },
  'โซน่า โพลีกอน': {
    keep: 4,
    jutsu: (g, c) => peek(g, c.ctrl, 3, (top) => {
      const hoku = top.filter((x) => x.def.name.includes('โฮคุ'));
      takeSummon(g, c.ctrl, top, (x) => isA(x) && symAny(x, ['ไซเบอร์', 'ปลา']) && x.def.cost <= 5);
      if (hoku.some((x) => P(g, c.ctrl).avatars.includes(x))) draw(g, c.ctrl, 1); // only if the summoned one is โฮคุ
    }),
    // linkbot: the destroy on entering คู่หู is โฮคุ's text (its onLink); the rest-to-draw is below [คู่หู - โฮคุ โพลีกอน]
    fieldActs: (g, p, c) => [act('โซน่า: rest to draw 1', (g2) => inMain(g2, p) && linked(g2, c, 'โฮคุ') && once(g2, p, 'sona') && !c.asleep && P(g2, p).deck.length > 5,
      (g2) => { markOnce(g2, P(g2, p), 'sona'); c.asleep = true; draw(g2, p, 1); })],
  },
  // 'มนุษย์ดัดแปลง': group E entry at the end of this file,
  // 'โรงบาล': group E entry at the end of this file,

  // ===== นัท (อัศวินตลิ่งชัน) =====
  'เซอร์นัท ผู้นำแห่งอัศวินตลิ่งชัน': {
    keep: 5,
    jutsu: (g, c) => { const n = best(hellAvatars(g, c.ctrl, (x) => named(x, 'ไอ้นัท')), (x) => x.def.power); if (n) attach(g, n, c); },
    staticPower: (g, c) => c.mods.length,
    onAttack: (g, c) => natDraw(g, c),
    react: {
      on: ['ability', 'magic'], noLimit: true, onceKey: 'sirnat',
      can: (g, p, c, ev) => ev.actor !== p && c.mods.length >= 2 && P(g, p).avatars.every(NAT),
      want: (g, p, c, ev) => !!ev.source && keepValue(g, ev.source) >= 5,
      resolve: (g, p, c, ev) => { for (const m of worstN(c.mods, 2, (x) => keepValue(g, x), { title: 'เซอร์นัท: exile 2 attached cards (cost)' })) toExile(g, m); ev.cancelled = true; },
    },
  },
  'เซอร์นัท ดาบแห่งแสงอรุณ': {
    keep: 4.5,
    jutsu: (g, c) => { const n = best(hellAvatars(g, c.ctrl, (x) => named(x, 'ไอ้นัท')), (x) => x.def.power); if (n) attach(g, n, c); },
    battle: (g, c, o) => { if (colorIs(o, 'ม่วง') || purpleNow(o)) c.temp.push({ power: 3, until: 'battle' }); },
    aura: (g, s, t) => (t.ctrl === s.ctrl && named(t, 'เลอติ๊ก') ? 2 : 0),
    onAttack: (g, c) => natDraw(g, c),
  },
  'ไอ้นัท - คนบ้าจั่ว': { keep: 3.5, onAttack: (g, c) => { if (once(g, c.ctrl, 'natdraw:' + c.uid)) { markOnce(g, P(g, c.ctrl), 'natdraw:' + c.uid); draw(g, c.ctrl, 1); } } },
  'ไอ้นัท คนข้ามเวลา': {
    keep: 3,
    // bugfix1 item 9 (user): worn by เซอร์นัท (who gets the worn ไอ้นัท's abilities) it can be used, and the ไอ้นัท goes on เซอร์นัท
    fieldActs: (g, p, c) => {
      const host = (g2: Game) => (c.wearer >= 0 ? findCard(g2, c.wearer) : P(g2, p).avatars.includes(c) ? c : null);
      const hostOk = (g2: Game) => { const h = host(g2); return !!h && (h === c || (P(g2, p).avatars.includes(h) && named(h, 'เซอร์นัท') && !silenced(g2, h))); };
      return [act('ไอ้นัท คนข้ามเวลา: attach a ไอ้นัท from your Hell', (g2) => inMain(g2, p) && hostOk(g2) && once(g2, p, 'nattime') && hellAvatars(g2, p, (x) => named(x, 'ไอ้นัท') && x.def.name !== c.def.name).length > 0,
        (g2) => { markOnce(g2, P(g2, p), 'nattime'); const h = host(g2); const n = best(hellAvatars(g2, p, (x) => named(x, 'ไอ้นัท') && x.def.name !== c.def.name), (x) => x.def.power); if (n && h) attach(g2, n, h); })];
    },
  },
  'มีมมิ นักเรียนดีเด่น': {
    keep: 1.5, costOnlyFor: NAT,
    hellActs: (g, p, c) => [act('มีมมิ: equip from hell', (g2) => inMain(g2, p) && !P(g2, p).used.Modification && P(g2, p).hell.includes(c) && P(g2, p).avatars.some((a) => named(a, 'ไอ้นัท') || named(a, 'เซอร์นัท')),
      (g2) => { P(g2, p).used.Modification = true; const w = best(P(g2, p).avatars.filter((a) => named(a, 'ไอ้นัท') || named(a, 'เซอร์นัท')), (a) => value(g2, a) + (a.def.name.includes('ดาบแห่ง') ? 3 : 0)); if (w) attach(g2, c, w); })],
    // other-team audit: purple only "จนจบการต่อสู้นั้น" (purpleNow: only while it fights this wearer)
    wearerBattle: (g, m, w, other) => { other.f.purple = g.turn; other.f.purpleW = w.uid; },
  },
  'ฮอล': { keep: 3, unite: true, jutsu: (g, c) => { search(g, c.ctrl, (x) => isA(x) && x.def.name.includes('นาย'), 'deck'); } },
  'ผู้เจริญ นาย': { keep: 2, grant: (g, s, t, kw) => kw === 'unite' && t.ctrl === s.ctrl && symAny(t, ['คน', 'ต้นไม้']) },
  'เลอร์ติ๊ก สหายอัศวินตลิ่งชัน': {
    keep: 3.5, alias: ['เลอติ๊ก เด็กไม่ชอบแดรคคูลา'],
    jutsu: (g, c) => peek(g, c.ctrl, 5, (top) => takeHand(g, c.ctrl, top, NAT)),
  },
  'งี่เง่า และ งอแง': { keep: 2.5 },
  'พี่หน่วง': {
    keep: 4,
    // simplify1 (exact): the chosen opposing Avatar and this card go to OUR Magic Zone. The taken Avatar stays there under
    // our control with its text off (an Avatar in the Magic Zone has no abilities); its attached cards go to their owners'
    // Hells. At the start of our next Main Phase this card is summoned back to our Avatar Zone (if there is room; else it
    // waits for the next one).
    fieldActs: (g, p, c) => [act('พี่หน่วง: take an Avatar away', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'nuang') && P(g2, p).hand.length >= 2 && P(g2, opp(p)).avatars.length > 0,
      (g2) => {
        const pl = P(g2, p); markOnce(g2, pl, 'nuang'); if (!discardWorst(g2, p, 2)) return;
        const t = best(P(g2, opp(p)).avatars, (a) => value(g2, a));
        if (t && P(g2, opp(p)).avatars.includes(t) && canChangeCtrl(g2, t, p)) {
          for (const m of t.mods.splice(0)) { m.wearer = -1; P(g2, m.owner).hell.push(m); }
          if (takeControl(g2, t, p, 'mz')) { t.asleep = false; t.temp = []; loseText(g2, t, 1e9); t.f.nuangTaken = 1; log(g2, `พี่หน่วง: ${t.def.name} goes to P${p}'s Magic Zone`); }
        }
        if (pl.avatars.includes(c)) { for (const m of c.mods.splice(0)) { m.wearer = -1; P(g2, m.owner).hell.push(m); } detach(g2, c); c.asleep = false; c.temp = []; pl.mz.push(c); c.f.nuangBack = g2.turn; }
      })],
    mainStart: (g, self) => {
      const pl = P(g, self.ctrl);
      if (g.active !== self.ctrl || self.f.nuangBack === undefined || self.f.nuangBack >= g.turn || !pl.mz.includes(self) || !canPlaceAvatar(pl)) return;
      delete self.f.nuangBack; log(g, 'พี่หน่วง returns to the Avatar Zone');
      summon(g, self.ctrl, self, 'effect');
    },
  },
  'ปลอกคอซื่อสัตย์': { keep: 1.5, canCast: (g, p) => P(g, p).avatars.length > 0, modTarget: (g, p) => best(P(g, p).avatars, (a) => value(g, a)) },
  'พลังแฝง': {
    keep: 4,
    react: {
      on: ['fight'], can: (g, p, c, ev) => !!ev.target && ev.target.ctrl === p,
      want: (g, p, c, ev) => power(g, ev.target!) <= power(g, ev.source!) && power(g, ev.target!) + 2 > power(g, ev.source!),
      resolve: (g, p, c, ev) => { boost(ev.target!, 2); },
    },
  },
  'สวนกล้วยหนีภาษี': {
    keep: 2, lockLand: true,
    canCast: (g, p) => !!g.land && g.land.owner !== p,
    endPhase: (g, l) => { l.f.ends = (l.f.ends || 0) + 1; if (l.f.ends >= 4) { P(g, l.owner).hell.push(l); g.land = null; } },
  },

  // ===== หน่วยรบ XVI =====
  'หนึ่งเดียวเพื่อทุกอย่าง': {
    keep: 4,
    canCast: (g, p) => P(g, p).avatars.length > 0,
    modTarget: (g, p) => best(P(g, p).avatars, (a) => value(g, a)),
    modPower: (g, m) => 1 + (m.f.moves || 0),
    onWearerLeave: (g, m, w) => { const n = best(P(g, w.ctrl).avatars.filter((a) => a !== w), (a) => value(g, a)); if (!n) return false; const mv = (m.f.moves || 0) + 1; attach(g, m, n); m.f.moves = mv; return true; },
  },
  'ฮินะ หน่วยรบ XVI': {
    keep: 3.5,
    jutsu: (g, c) => { search(g, c.ctrl, (x) => x.def.type === 'Magic', 'hell'); },
    aura: (g, s, t) => (t.ctrl === s.ctrl && named(t, XVI) ? 1 : 0),
  },
  'เอริ หน่วยรบ XVI': {
    keep: 4,
    onAttack: (g, c) => peek(g, c.ctrl, 3, (top) => { takeSummon(g, c.ctrl, top, (x) => isA(x) && named(x, XVI) && x.def.name !== c.def.name); }, 'hell'),
    aura: (g, s, t) => (t.ctrl === s.ctrl && named(t, XVI) ? 1 : 0),
  },
  'มิเรีย หน่วยรบ XVI': {
    keep: 3,
    jutsu: (g, c) => peek(g, c.ctrl, 3, (top) => takeHand(g, c.ctrl, top, (x) => (isA(x) && named(x, XVI) && x.def.name !== c.def.name) || x.def.type === 'Magic'), 'bottom'),
    aura: (g, s, t) => (t.ctrl === s.ctrl && named(t, XVI) ? 1 : 0),
  },
  'คาร์ร่า หน่วยรบ XVI': {
    keep: 4,
    fieldActs: (g, p, c) => [act('คาร์ร่า: call XVI from top 3', (g2) => inMain(g2, p) && once(g2, p, 'karra') && canPlaceAvatar(P(g2, p)) && P(g2, p).deck.length > 6,
      (g2) => { markOnce(g2, P(g2, p), 'karra'); peek(g2, p, 3, (top) => { takeSummon(g2, p, top, (x) => isA(x) && named(x, XVI) && x.def.name !== c.def.name, 'jutsu'); }, 'hell'); })],
    grant: (g, s, t, kw) => kw === 'shield' && t.ctrl === s.ctrl && g.active !== s.ctrl && named(t, XVI),
  },
  'บอสทุเรียน': {
    keep: 0.5,
    usedAsCost: (g, p, c, s) => {
      if (!colorIs(s, 'ฟ้า')) return;
      const pl = P(g, p); const top = pl.deck[0];
      if (top && isA(top) && top.def.symbol === s.def.symbol) { pl.deck.shift(); pl.hand.push(top); }
    },
  },
  'โอเปอเรชั่น : สเกาท์': {
    keep: 3.5,
    canCast: (g, p) => canPlaceAvatar(P(g, p)) && P(g, p).deck.length > 4,
    resolve: (g, p) => peek(g, p, 3, (top) => { takeSummon(g, p, top, (x) => isA(x) && named(x, XVI), 'jutsu'); }, 'bottom'),
  },
  'โอเปอเรชั่น : รอยัล': {
    keep: 4,
    canCast: (g, p) => onZone(g, p, XVI).filter((a) => !a.asleep).length >= 2 && P(g, opp(p)).avatars.length > 0,
    resolve: (g, p) => {
      for (const a of worstN(onZone(g, p, XVI).filter((x) => !x.asleep), 2, (x) => power(g, x), { title: 'โอเปอเรชั่น : รอยัล: rest 2 awake หน่วยรบ XVI' })) a.asleep = true;
      const t = best(oppTargets(g, p, true), (a) => value(g, a)); if (t) destroy(g, t, p, true);
    },
  },
  'เพื่อชาติ': {
    keep: 3,
    react: {
      on: ['attack'], can: (g, p, c, ev) => ev.actor !== p && P(g, p).avatars.some((a) => named(a, 'รถถัง')),
      want: (g, p) => P(g, opp(p)).avatars.length >= 2,
      resolve: (g, p, c, ev) => {
        const t = worst(P(g, p).avatars.filter((a) => named(a, 'รถถัง')), (a) => value(g, a)); if (t) destroy(g, t, p);
        for (const a of [...P(g, opp(p)).avatars]) destroy(g, a, p, true);
        ev.cancelled = true;
      },
    },
  },
  'คว้าปืนมายิงหมี': {
    keep: 3.5,
    react: {
      on: ['fight'], can: (g, p, c, ev) => !!ev.target && ev.target.ctrl === p,
      want: (g, p, c, ev) => power(g, ev.target!) <= power(g, ev.source!) && power(g, ev.target!) + 1 > power(g, ev.source!),
      resolve: (g, p, c, ev) => { search(g, p, (x) => x.def.subtype === 'Modification', 'hell'); boost(ev.source!, -1); },
    },
  },
  'โรงเรียนฝึกหน่วยรบ': {
    keep: 2.5,
    canCast: (g, p) => !g.land || g.land.owner !== p,
    landPower: (g, l, a) => (named(a, XVI) && a.ctrl === l.owner && g.phase === 'Battle' && g.active === a.ctrl ? 1 : 0),
    fieldActs: (g, p, c) => [act('โรงเรียน: discard 1, XVI from hell to Deck bottom', (g2) => inMain(g2, p) && once(g2, p, 'xviSchool') && P(g2, p).hand.length >= 2
      && hellAvatars(g2, p, (x) => named(x, XVI)).length > 0,
    (g2) => {
      markOnce(g2, P(g2, p), 'xviSchool'); if (!discardWorst(g2, p, 1)) return;
      const x = best(hellAvatars(g2, p, (y) => named(y, XVI)), (y) => keepValue(g2, y)); if (x) { detach(g2, x); P(g2, p).deck.push(x); }
    })],
  },

  // ===== แก๊งขยะ =====
  'ตุตันคาเมน ฟาโรห์ทองคำ': {
    keep: 8,
    jutsu: (g, c) => {
      const p = c.ctrl; let budget = 8;
      const isTut = (x: Card) => x.def.name === c.def.name; // "ไม่สามารถถูกอัญเชิญจากนรกได้"
      const all = [...P(g, p).hell, ...P(g, opp(p)).hell].filter((x) => isA(x) && !isTut(x));
      const pool = all.filter((x) => !x.def.only && x.def.cost <= 8).sort((a, b) => value(g, b) - value(g, a));
      // option 2: one Avatar of any cost (Only #1 allowed) when it beats the option-1 package
      let room = 4 - P(g, p).avatars.filter((a) => !a.token).length, b8 = 8, plan = 0;
      for (const x of pool) if (room > 0 && x.def.cost <= b8) { b8 -= x.def.cost; room--; plan += value(g, x); }
      const top1 = all.reduce((m, x) => Math.max(m, value(g, x)), -Infinity);
      const m = chooseMode(g, c, ['Summon any number from Hells, total Cost 8 or less', 'Summon 1 Avatar from any Hell'], top1 > plan ? 1 : 0);
      if (m === 1) { const one = best(all, (x) => value(g, x)); if (one) summon(g, p, one, 'jutsu'); return; }
      if (humanDeciding(g)) { // the human picks one at a time while the Cost total stays within 8
        for (;;) {
          const ok = pool.filter((x) => x.def.cost <= budget && [P(g, 0).hell, P(g, 1).hell].some((h) => h.includes(x)));
          if (!ok.length || !canPlaceAvatar(P(g, p))) break;
          const x = pickN(ok, 1, (y) => value(g, y), { optional: true, title: `ตุตันคาเมน: summon (Cost left ${budget})` })[0];
          if (!x) break;
          if (summon(g, p, x, 'jutsu')) budget -= x.def.cost; else pool.splice(pool.indexOf(x), 1);
        }
        return;
      }
      for (const x of pool) { if (x.def.cost > budget || !canPlaceAvatar(P(g, p))) continue; if (summon(g, p, x, 'jutsu')) budget -= x.def.cost; }
    },
  },
  'พี่บูม แก๊งขยะ': {
    keep: 4.5,
    costOf: (g, p, c) => c.def.cost - (P(g, p).once['jamesDiscount'] === g.turn ? 1 : 0),
    fieldActs: (g, p, c) => [act('พี่บูม: discard 1, search gang', (g2) => inMain(g2, p) && once(g2, p, 'boom') && P(g2, p).hand.length >= 1 && P(g2, p).deck.some((x) => x.def.name.includes('พี่ซี๊ด') || x.def.name.includes('เบรกเกต')),
      (g2) => { markOnce(g2, P(g2, p), 'boom'); discardWorst(g2, p, 1); search(g2, p, (x) => x.def.name.includes('พี่ซี๊ด') || x.def.name.includes('เบรกเกต'), 'deck'); })],
    onUnited: (g, c, h) => { if (h.def.name.includes('พี่ซี๊ด')) for (const a of P(g, c.ctrl).avatars.filter(gang)) boost(a, 1); },
  },
  'พี่เจมส์ แก๊งขยะ': {
    keep: 4.5,
    jutsu: (g, c) => { search(g, c.ctrl, (x) => x.def.name.includes('พี่บูม'), 'deck'); P(g, c.ctrl).once['jamesDiscount'] = g.turn; },
    onUnited: (g, c, h) => {
      if (!h.def.name.includes('พี่ซี๊ด')) return;
      const names = new Set<string>([c.def.name]);
      summonDistinct(g, c.ctrl, hellAvatars(g, c.ctrl, gang), 2, (x) => value(g, x), names, 'พี่เจมส์: summon แก๊งขยะ from Hell (up to 2, different names)', 1);
    },
  },
  'พี่ซี๊ด แก๊งขยะ': {
    keep: 2.5, unite: true,
    hellActs: (g, p, c) => [act('พี่ซี๊ด: revive', (g2) => inMain(g2, p) && once(g2, p, 'zeed') && P(g2, p).hell.includes(c) && P(g2, p).hand.length >= 1 && canPlaceAvatar(P(g2, p))
      && !P(g2, p).avatars.some((a) => a.def.name === c.def.name) && Object.entries(P(g2, p).once).some(([k, v]) => v === g2.turn && k.startsWith('summoned:') && k.includes('แก๊งขยะ')),
    (g2) => { markOnce(g2, P(g2, p), 'zeed'); if (discardWorst(g2, p, 1)) summon(g2, p, c, 'effect'); })],
  },
  'เบรกเกต แก๊งขยะ': { keep: 3.5, onUnited: (g, c, h) => { if (h.def.name.includes('พี่ซี๊ด')) c.asleep = false; } },
  'เมืองลกเอี๋ยง': {
    keep: 2.5,
    canCast: (g, p) => (!g.land || g.land.owner !== p) && colorsOn(g, p) >= 4,
    landPower: (g, l, a) => (a.ctrl === l.owner && colorsOn(g, l.owner) >= 4 ? 2 : 0),
  },
  'ZeedZad Server': {
    keep: 3,
    costOf: (g, p, c) => (distinctNames(P(g, p).avatars.filter(gang)) >= 2 ? 0 : c.def.cost),
    grant: (g, s, t, kw) => kw === 'tieWin' && t.ctrl === s.ctrl && gang(t),
  },

  // ===== ไซอิ๋ว =====
  'พระไตรปิฎก': {
    keep: 5, stayMz: true,
    canCast: (g, p) => P(g, p).avatars.some((a) => a.def.name.includes('พระถังซัมจั๋ง')),
    resolve: (g, p) => draw(g, p, 1),
    aura: (g, s, t) => (t.ctrl === s.ctrl && isSaiyu(t) && P(g, s.ctrl).mz.includes(s) ? 1 : 0),
    drawPhase: (g, s) => {
      const pl = P(g, s.ctrl);
      if (pl.mz.filter((x) => x.def.name === 'พระไตรปิฎก').length >= 3 && SAIYU.every((n) => pl.avatars.some((a) => a.def.name.includes(n)))) { g.winner = s.ctrl; log(g, 'พระไตรปิฎก alternate win'); }
    },
  },
  'ซุนหงอคง': { keep: 4.5, staticPower: (g, c) => (P(g, c.ctrl).avatars.some((a) => a.def.name.includes('พระถังซัมจั๋ง')) ? 2 : 0) },
  'ซัวเจ๋ง': {
    keep: 3,
    hellActs: (g, p, c) => [act('ซัวเจ๋ง: revive', (g2) => inMain(g2, p) && P(g2, p).hell.includes(c) && P(g2, p).hand.length >= 1 && canPlaceAvatar(P(g2, p))
      && P(g2, p).avatars.filter((a) => ['พระถังซัมจั๋ง', 'ซุนหงอคง', 'ตือโป๊ยก่าย'].some((n) => a.def.name.includes(n))).length >= 2,
    (g2) => { if (discardWorst(g2, p, 1)) summon(g2, p, c, 'effect'); })],
  },
  // 'ตือโป๊ยก่าย': group E entry at the end of this file,
  'พระถังซัมจั๋ง': {
    keep: 5,
    jutsu: (g, c) => {
      const p = c.ctrl; const pl = P(g, p);
      if (!pl.deck.some((x) => isA(x) && ['ซุนหงอคง', 'ตือโป๊ยก่าย', 'ซัวเจ๋ง'].some((n) => x.def.name.includes(n)) && !pl.avatars.some((a) => a.def.name === x.def.name))) { log(g, 'พระถังซัมจั๋ง: no disciple in the Deck, จุติ does nothing (no discard)'); return; } // other-team audit
      const d = worst(pl.hand.filter(isA), (x) => keepValue(g, x)); if (!d) return; discard(g, p, d);
      fromZoneSummon(g, p, pl.deck, (x) => ['ซุนหงอคง', 'ตือโป๊ยก่าย', 'ซัวเจ๋ง'].some((n) => x.def.name.includes(n)) && !pl.avatars.some((a) => a.def.name === x.def.name));
      shuffle(g, pl.deck);
    },
    untargetable: (g, c) => P(g, c.ctrl).avatars.some((a) => a.def.name.includes('ซุนหงอคง')),
    fieldActs: (g, p, c) => [act('พระถัง: find พระไตรปิฎก', (g2) => inMain(g2, p) && once(g2, p, 'tang') && ['ซุนหงอคง', 'ตือโป๊ยก่าย', 'ซัวเจ๋ง'].every((n) => P(g2, p).avatars.some((a) => a.def.name.includes(n))),
      (g2) => { markOnce(g2, P(g2, p), 'tang'); if (!search(g2, p, (x) => x.def.name === 'พระไตรปิฎก', 'deck')) search(g2, p, (x) => x.def.name === 'พระไตรปิฎก', 'hell'); })],
  },
  'ดินแดนแห่งความหลากหลาย': {
    keep: 2.5,
    canCast: (g, p) => !g.land || g.land.owner !== p,
    landPower: (g, l, a) => { const av = P(g, l.owner).avatars; return a.ctrl === l.owner && av.length >= 2 && new Set(av.map((x) => x.def.symbol)).size === av.length ? 1 : 0; },
  },

  // ===== อัศวินโต๊ะกลม =====
  'เมตตาระยะยาว': {
    keep: 9,
    // other-team audit Q12 (user): Avatars in the opponent's Magic Zone count as "บนสนาม" too
    // bugs7 item 1 (user): Tokens count as Avatars; the human may cast it whenever the opponent has any Avatar (Token too);
    // the bot still waits for 2+ Avatars or a big one
    canCast: (g, p) => fieldAvatars(g, opp(p)).length >= 1 && (decide(g, p, () => humanDeciding(g)) || fieldAvatars(g, opp(p)).length >= 2 || fieldAvatars(g, opp(p)).reduce((s, a) => s + value(g, a), 0) >= 8),
    resolve: (g, p) => { for (const a of fieldAvatars(g, opp(p))) destroy(g, a, p, true); },
  },
  'อาเธอร์ ราชาแห่งอัศวินโต๊ะกลม': {
    keep: 6, unique: true,
    jutsu: (g, c) => {
      const pl = P(g, c.ctrl);
      if (pl.deck.filter((x) => named(x, 'ดาบศักดิ์สิทธิ์')).length < 2) return;
      const sw = worstN(pl.deck.filter((x) => named(x, 'ดาบศักดิ์สิทธิ์')), 2, (x) => keepValue(g, x), { title: 'อาเธอร์: send 2 ดาบศักดิ์สิทธิ์ from your Deck to Hell' });
      if (sw.length < 2) return;
      for (const s of sw) { detach(g, s); pl.hell.push(s); }
      const k = best(pl.deck.filter((x) => isA(x) && knight(x) && !x.def.name.includes('อาเธอร์')), (x) => value(g, x));
      if (k) { detach(g, k); pl.hell.push(k); knightSummon(g, c.ctrl, k, 'effect'); for (const a of pl.avatars) if (a.def.name === k.def.name) a.f.noAttack = g.turn; }
      shuffle(g, pl.deck);
    },
  },
  'เบดิเวียร์ อัศวินโต๊ะกลมแห่งความภักดี': {
    keep: 4,
    jutsu: (g, c) => {
      const pl = P(g, c.ctrl);
      const s = worst(pl.deck.filter((x) => named(x, 'ดาบศักดิ์สิทธิ์')), (x) => keepValue(g, x)); if (s) { detach(g, s); pl.hell.push(s); }
      shuffle(g, pl.deck);
      const k = pickN(hellAvatars(g, c.ctrl, knight), 1, (x) => value(g, x), { optional: true, title: 'เบดิเวียร์: put an อัศวินโต๊ะกลม from Hell on top of your Deck (optional)' })[0]; if (k) { detach(g, k); pl.deck.unshift(k); }
      boost(c, 1);
    },
  },
  'ทริสทัน อัศวินโต๊ะกลมแห่งความแม่นยำ': {
    keep: 3,
    onSummon: (g, c) => { if (BY_KNIGHT > 0) { const t = best(P(g, opp(c.ctrl)).avatars, (a) => value(g, a)); if (t) destroy(g, t, c.ctrl); } },
    kwIf: (g, c, kw) => kw === 'unite' && P(g, c.ctrl).avatars.some((a) => a !== c && knight(a)),
  },
  'ลานเซลอต อัศวินโต๊ะกลมแห่งการปฏิวัติ': {
    keep: 4.5,
    jutsu: (g, c) => peek(g, c.ctrl, 2, (top) => {
      const k = best(top.filter((x) => isA(x) && knight(x)), (x) => value(g, x));
      if (!k || !canPlaceAvatar(P(g, c.ctrl))) return;
      top.splice(top.indexOf(k), 1); P(g, c.ctrl).hell.push(k); knightSummon(g, c.ctrl, k, 'effect');
      if (colorIs(k, 'แดง')) for (const a of onZone(g, c.ctrl, 'อัศวินโต๊ะกลม')) boost(a, 1);
      if (colorIs(k, 'ฟ้า')) draw(g, c.ctrl, 1);
    }),
  },
  'กาเวน อัศวินโต๊ะกลมแห่งแสงอาทิตย์': { keep: 4.5, shield: true, staticPower: (g, c) => (g.active !== c.ctrl ? 2 : 0) },
  'มอเดรด อัศวินโต๊ะกลมแห่งการทรยศ': { keep: 3.5 }, // its เตะไข่ comes from ดาบศักดิ์สิทธิ์ คาเรนต์ (a grant); its ability: mordred()
  'ความกล้าหาญ': {
    keep: 3,
    canCast: (g, p) => P(g, p).avatars.some((a) => !a.asleep) && g.turn > 1,
    resolve: (g, p, c) => { const t = best(P(g, p).avatars.filter((a) => !a.asleep), (a) => power(g, a)); if (t) { addPower(g, t, 4, 'perm', c); t.f.endDestroy = g.turn; t.f.endDestroyM = g.turn; } }, // other-team audit: the End Phase destroy is this Magic's effect (endDestroyM); v14 answer: +4 stays while it stays on the field
  },
  'เตรียมเสบียง': {
    keep: 1,
    canCast: (g, p) => hellAvatars(g, p, (x) => x.def.cost <= 4 && !symIs(x, 'เพชร')).length > 0,
    resolve: (g, p) => { // every player puts one Avatar (Cost 4 or less, not เพชร) from their hell on top of their Deck
      for (const q of [p, opp(p)] as PID[]) {
        const x = decide(g, q, () => best(hellAvatars(g, q, (y) => y.def.cost <= 4 && !symIs(y, 'เพชร')), (y) => value(g, y)));
        if (x) { detach(g, x); P(g, q).deck.unshift(x); }
      }
    },
  },
  'ดาบศักดิ์สิทธิ์ คาเรนต์': {
    keep: 3,
    canCast: (g, p) => onZone(g, p, 'อัศวินโต๊ะกลม').length > 0,
    modTarget: (g, p) => best(onZone(g, p, 'อัศวินโต๊ะกลม'), (a) => value(g, a) + (a.def.name.includes('มอเดรด') ? 4 : 0)),
    onAttach: (g, m, w) => mordred(g, w),
    grant: (g, s, t, kw) => kw === 'kick' && s.wearer === t.uid && t.def.name.includes('มอเดรด'), // "ถ้า Avatar ที่สวมใส่คือ มอเดรด จะได้รับ เตะไข่"
    onWearerKill: (g, m, w) => {
      const mods = [...P(g, opp(w.ctrl)).avatars, ...P(g, w.ctrl).avatars].flatMap((a) => a.mods).filter((x) => x.owner === opp(w.ctrl) && x.def.type === 'Magic');
      mods.push(...P(g, opp(w.ctrl)).mz.filter((x) => x.def.type === 'Magic'));
      const t = best(mods, (x) => keepValue(g, x));
      if (t) { detach(g, t); P(g, t.owner).hell.push(t); } else if (g.land && g.land.owner === opp(w.ctrl)) { P(g, g.land.owner).hell.push(g.land); g.land = null; }
    },
    hellActs: swordHell(),
  },
  'ดาบศักดิ์สิทธิ์ แกลลาติน': {
    keep: 3,
    canCast: (g, p) => onZone(g, p, 'อัศวินโต๊ะกลม').length > 0,
    modTarget: (g, p) => best(onZone(g, p, 'อัศวินโต๊ะกลม'), (a) => value(g, a)),
    onAttach: (g, m, w) => mordred(g, w),
    protectWearer: (g, m, w, by, viaMagic) => viaMagic && !w.asleep,
    hellActs: swordHell(),
  },
  'ดาบศักดิ์สิทธิ์ อาลอนไดร์ท': {
    keep: 3,
    canCast: (g, p) => onZone(g, p, 'อัศวินโต๊ะกลม').length > 0,
    modTarget: (g, p) => best(onZone(g, p, 'อัศวินโต๊ะกลม'), (a) => value(g, a)),
    onAttach: (g, m, w) => mordred(g, w),
    blockShield: true, // bugs7 item 4: while worn, the wearer's attacks can't be met with โล่มนุษย์ (shieldOptions)
    modPower: () => 1,
    hellActs: swordHell(),
  },

  // ===== ขวัญตา เรื่องราว =====
  'อินาริ โอคามิ แห่งการเก็บเกี่ยว': {
    keep: 8,
    jutsu: (g, c) => { const pl = P(g, c.ctrl); detach(g, c); pl.mz.push(c); },
    aura: (g, s, t) => (t.ctrl === s.ctrl && P(g, s.ctrl).mz.includes(s) ? 1 + Math.floor(P(g, s.ctrl).hell.length / 15) : 0),
    endPhase: (g, c) => { if (P(g, c.ctrl).mz.includes(c)) draw(g, c.ctrl, 1 + Math.floor(P(g, c.ctrl).hell.length / 15)); },
  },
  // 'นักท่องเรื่องราว ขวัญตา': group E entry at the end of this file,
  // 'ขวัญตา เรื่องราว ราชาแห่งนาค': group E entry at the end of this file,
  // 'ขวัญตา เรื่องราว ครุฑเจ้าเวหา': group E entry at the end of this file,
  'Skill : Full Drive': {
    keep: 3, options: 2, optLabels: ['เด็ค', 'นรก'], // bugs7 item 3 (user): option 1 = Deck, option 2 = Hell
    canCast: (g, p, c, o) => o === 0 ? P(g, p).deck.some((x) => isA(x) && story(x)) : P(g, p).hell.some((x) => isA(x) && story(x)),
    resolve: (g, p, c, o) => { search(g, p, (x) => isA(x) && story(x), o === 0 ? 'deck' : 'hell'); if (hellMagic(g, p) >= 8 && mayDo(g, c, 'draw 1', P(g, p).deck.length > 3)) draw(g, p, 1); }, // other-team audit: "สามารถจั่ว" = optional
  },
  'แหมกำบ่อ้าย': {
    keep: 2,
    canCast: (g, p) => P(g, p).deck.length <= 15 && P(g, p).hell.length > 0,
    resolve: (g, p) => { const pl = P(g, p); for (const x of pickN(pl.hell.filter((y) => y.def.name !== 'แหมกำบ่อ้าย'), 5, (y) => keepValue(g, y), { optional: true, title: 'แหมกำบ่อ้าย: return up to 5 cards from Hell to Deck' })) { detach(g, x); pl.deck.push(x); } shuffle(g, pl.deck); },
  },
  'Skill : Hypersense': {
    keep: 4,
    react: {
      // other-team audit: "ใช้ความสามารถของ Avatar" has no zone (hand / Hell / Magic Zone too); the destroy is "สามารถ" (optional);
      // not on an Avatar that can't be chosen (กวนอู) or that ignores opposing Magic (วีรชนชีวภาพ)
      on: ['ability'], can: (g, p, c, ev) => ev.actor !== p && !!ev.source && isA(ev.source) && P(g, p).avatars.length > 0 && P(g, p).avatars.every(story)
        && !magicImmune(g, ev.source, p) && effectTargetableE(ev.source, c),
      want: (g, p, c, ev) => keepValue(g, ev.source!) >= 4,
      resolve: (g, p, c, ev) => { ev.source!.silencedTurn = g.turn; ev.cancelled = true; if (hellMagic(g, p) >= 8 && fzE(g, ev.source!) && mayDo(g, c, `destroy ${ev.source!.def.name}`, true)) destroy(g, ev.source!, p, true); },
    },
  },
  'Skill : Second Energy': {
    keep: 4,
    react: {
      on: ['destroy'], can: (g, p, c, ev) => !!ev.source && ev.source.ctrl === p && story(ev.source), want: () => true,
      resolve: (g, p, c, ev) => {
        ev.cancelled = true;
        if (hellMagic(g, p) >= 8) { const x = oppChoice(g, p, () => worst(P(g, opp(p)).hell, (y) => keepValue(g, y))); if (x) toExile(g, x); } // the opponent picks
      },
    },
  },

  // ===== ไดโนกาฬสินธุ์ =====
  'ไดโนกาฬสินธุ์ - สยามโมไทรันนัส': {
    keep: 8,
    onAttack: (g, c) => peek(g, c.ctrl, 5, (top) => { takeSummon(g, c.ctrl, top, (x) => isA(x) && kapom(x), 'jutsu', 6); }),
  },
  'ไดโนกาฬสินธุ์ - อิสานโนซอรัส': {
    keep: 0.5, costOnlyFor: kapom,
    usedAsCost: (g, p, c, s) => { // สอดแนม 1: keep it on top or put it on the bottom
      if (!kapom(s)) return;
      scoutDeck(g, p, 1, () => {}, 'either', 'อิสานโนซอรัส');
    },
  },
  'ไดโนกาฬสินธุ์ - กินรีมิมัส': {
    keep: 4,
    jutsu: (g, c) => peek(g, c.ctrl, 5, (top) => { takeSummon(g, c.ctrl, top, (x) => isA(x) && kapom(x) && x.def.cost <= 3); }),
  },
  'ไดโนกาฬสินธุ์ - ภูเวียงสิรินเน': {
    keep: 3.5,
    jutsu: (g, c) => {
      const pl = P(g, c.ctrl); const back = pickN(hellAvatars(g, c.ctrl, (x) => kapom(x) && x.def.cost <= 3), 4, (x) => -keepValue(g, x), { optional: true, title: 'ภูเวียงสิรินเน: return up to 4 กะปอม from Hell to Deck' });
      for (const x of back) { detach(g, x); pl.deck.push(x); }
      shuffle(g, pl.deck); draw(g, c.ctrl, 1); boost(c, back.length);
    },
  },
  'ไดโนกาฬสินธุ์ - สัตยาซอรัส': { keep: 3, aura: (g, s, t) => (t.ctrl === s.ctrl && kapom(t) ? 1 : 0) },
  'ไดโนกาฬสินธุ์ - สุธีธรนีซอรัส': {
    keep: 3,
    deathCry: (g, c, owner) => peek(g, owner, 3, (top) => { takeSummon(g, owner, top, (x) => isA(x) && named(x, 'ไดโนกาฬสินธุ์') && x.def.cost <= 3 && x.def.name !== c.def.name); }),
  },
  'Podcast Untitled Case': {
    keep: 2.5,
    canCast: (g, p) => (!g.land || g.land.owner !== p) && P(g, p).avatars.some((a) => symAny(a, ['ผี', 'เปรต', 'เอเลี่ยน']) || named(a, 'ไดโน')),
    landPower: (g, l, a) => (symAny(a, ['ผี', 'เปรต', 'เอเลี่ยน']) || named(a, 'ไดโน') ? 1 : 0),
  },
};

// งี่เง่า twins: sac for 2 cards, or gain เตะไข่ and die at End Phase
for (const nm of ['งี่เง่ากับงอแง', 'งี่เง่า และ งอแง']) {
  NEW[nm] = {
    keep: 2.5,
    fieldActs: (g, p, c) => [
      act(`${nm}: sacrifice, draw 2`, (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'ngi:' + c.uid), (g2) => { markOnce(g2, P(g2, p), 'ngi:' + c.uid); destroy(g2, c, p); draw(g2, p, 2); }),
      act(`${nm}: เตะไข่ this turn`, (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'ngi:' + c.uid) && !c.asleep && g2.turn > 1,
        (g2) => { markOnce(g2, P(g2, p), 'ngi:' + c.uid); c.kick = true; c.f.endDestroy = g2.turn; }),
    ],
  };
}

function hokuLink(g: Game, p: PID) {
  if (!once(g, p, 'hokuLink')) return; markOnce(g, P(g, p), 'hokuLink');
  const t = best(P(g, opp(p)).avatars, (a) => power(g, a)); if (t) destroy(g, t, p);
}
function natDraw(g: Game, c: Card) {
  if (!c.mods.some((m) => m.def.name === 'ไอ้นัท - คนบ้าจั่ว')) return;
  if (once(g, c.ctrl, 'natdraw:' + c.uid)) { markOnce(g, P(g, c.ctrl), 'natdraw:' + c.uid); draw(g, c.ctrl, 1); }
}
function colorsOn(g: Game, p: PID) {
  const s = new Set<string>();
  for (const a of P(g, p).avatars) { if (a.def.name.includes('โคลัมบัส')) return 4; if (a.def.color) s.add(a.def.color); }
  return s.size;
}
function mordred(g: Game, w: Card) {
  if (!w.def.name.includes('มอเดรด')) return;
  const p = w.ctrl; if (!once(g, p, 'mordred')) return;
  const f = worst(P(g, p).avatars.filter((a) => a !== w), (a) => value(g, a));
  const k = best(hellAvatars(g, p, (x) => knight(x) && colorIs(x, 'ฟ้า')), (x) => value(g, x));
  if (!f || !k) return;
  markOnce(g, P(g, p), 'mordred'); destroy(g, f, p); knightSummon(g, p, k, 'jutsu');
}

Object.assign(FX, NEW);
FX['ปลอกคอซื่อสัตย์'] = { ...FX['ปลอกคอซื่อสัตย์'], noSteal: true } as Fx;
FX['โคลัมบัส นักท่องเรือ'] = {}; // all colours: handled in colorsOn

// =====================================================================================================================
// ===== group E: v14 rulings (v14/rulings.json owner E). Entries here replace any earlier entry of the same name. =====
// =====================================================================================================================
import { fieldZone as fzE, currentFight as fightE, addRule as addRuleE, RULES as RULES_E, flipLifeCard as flipLifeE, resolveLife as resolveLifeE,
  abilityWindow as abilityWindowE, inLink as inLinkE, cardText as cardTextE, abilityAllowed as abilityAllowedE,
  copyAbilities as copyAbilitiesE, copiedFrom as copiedFromE } from './engine.ts';
import { cameFrom as cameFromE, setCost as setCostE } from './view.ts';

// ริกกี้ นักปลอมแปลง: sleeping opposing Avatars we may take
const rickyPool = (g: Game, p: PID) => (canPlaceAvatar(P(g, p)) ? P(g, opp(p)).avatars.filter((a) => a.asleep && canChangeCtrl(g, a, p) && !magicImmune(g, a, p)) : []);
// นักท่องเรื่องราว ขวัญตา: exile it (cost), summon the shown เรื่องราว Cost 6 from hand; the exile draws 1 (its afterLeave)
const TRAVELER = 'นักท่องเรื่องราว ขวัญตา';
const story6 = (x: Card) => isA(x) && story(x) && x.def.cost === 6;
const travelers = (g: Game, p: PID) => P(g, p).avatars.filter((a) => a.def.name === TRAVELER && !silenced(g, a) && abilityAllowedE(g, p, a));
function travelerSwap(g: Game, p: PID, trav: Card, s: Card) {
  const pl = P(g, p);
  if (!pl.avatars.includes(trav) || !pl.hand.includes(s)) return;
  toExile(g, trav, { cost: true });
  if (pl.hand.includes(s) && canPlaceAvatar(pl) && summon(g, p, s, 'effect') && pl.avatars.includes(s)) s.f.byTraveler = 1;
}
// "สามารถใช้ความสามารถนี้ใน Battle Phase ฝ่ายเราได้": offered from the shown card in hand during our Battle Phase
// (the Battle Phase only offers hand abilities); it opens the opponent's React window as an ability of นักท่องเรื่องราว.
const storyBattle = (g: Game, p: PID, c: Card): HandAct[] => [act(`นักท่องเรื่องราว: exile it, summon ${c.def.name}`,
  (g2) => g2.phase === 'Battle' && g2.active === p && P(g2, p).hand.includes(c) && story6(c) && travelers(g2, p).length > 0,
  (g2) => { const t = best(travelers(g2, p), (a) => -value(g2, a)); if (t) abilityWindowE(g2, p, t, () => travelerSwap(g2, p, t, c)); })];
const travelerGet = (g: Game, self: Card) => !!self.f.byTraveler && P(g, self.ctrl).avatars.includes(self) && 'ได้รับความสามารถ (อัญเชิญโดย นักท่องเรื่องราว)';
// K-BO: this turn, in fights where our เพมมุ / สไปรท์ attacks an opposing Avatar, the opponent can't use React / abilities
function kboFight(g: Game, r: { p: PID }) {
  const f = fightE();
  return !!f && !!f.target && f.att.ctrl !== r.p && f.target.ctrl === r.p && isA(f.target) && (nameHas(f.att, 'เพมมุ') || nameHas(f.att, 'สไปรท์'));
}
RULES_E['K-BO ยอดหุ่นยนต์'] = { label: 'no React / abilities during fights of เพมมุ / สไปรท์ (K-BO)', cast: (g, r) => !kboFight(g, r), ability: (g, r) => !kboFight(g, r) };
// โรงบาล: cards with the taken card's name can't be summoned / use abilities this turn
RULES_E['โรงบาล'] = { label: 'cards with the name taken by โรงบาล: no summon / abilities', summon: (g, r, c) => c.def.name !== r.name, ability: (g, r, c) => c.def.name !== r.name };
const justiceOn = (g: Game, o: PID) => P(g, o).avatars.some((a) => (nameHas(a, 'เพมมุ') || nameHas(a, 'สไปรท์')) && (inLinkE(g, a) || isLinked(g, a)));
const onlyNinja = (g: Game, p: PID) => P(g, p).avatars.length > 0 && P(g, p).avatars.every((a) => nameHas(a, 'นินจา'));

const rishi = (m: Card) => symIs(m, 'ฤษี') || symIs(m, 'ฤๅษี');
const E: Record<string, any> = {
  'ฤๅษี ภฤคุ': {
    keep: 4,
    // our ฤษี Normal / Modification / Land Magic may be used in the opponent's turn (one of each type per turn as usual)
    offTurnMagic: (g: Game, s: Card, m: Card) => P(g, s.ctrl).avatars.includes(s) && rishi(m),
    // in the opponent's turn our ฤษี React Magic may also answer an attack, an Avatar ability or a Magic
    reactAlso: (g: Game, s: Card, m: Card, ev: Ev) => g.active !== s.ctrl && P(g, s.ctrl).avatars.includes(s) && rishi(m) && ev.actor !== s.ctrl
      && (ev.kind === 'attack' || ev.kind === 'magic' || (ev.kind === 'ability' && !!ev.source && isA(ev.source))),
  },
  'มฤตยูเทวี': {
    keep: 3.5,
    // จุติ: choose a {นรก} Cost 5 Avatar in our Hell: this card gets all its abilities (while on the field); its จุติ runs now
    jutsu: (g: Game, c: Card) => {
      const src = best(hellAvatars(g, c.ctrl, (x) => symIs(x, 'นรก') && x.def.cost === 5 && x.def.name !== c.def.name), (x) => (FX[x.def.name] ? 3 : 0) + (FX[x.def.name]?.jutsu ? 2 : 0) + x.def.power);
      if (!src) return;
      copyAbilitiesE(g, c, src);
      const n = copiedFromE(c);
      const j = n ? FX[n]?.jutsu : null;
      if (j) j(g, c);
    },
    getActive: (g: Game, self: Card) => { const n = copiedFromE(self); return !!n && `ได้รับความสามารถของ ${n}`; },
  },
  'ริกกี้ นักปลอมแปลง': {
    keep: 3,
    // React: after our Avatar was destroyed in battle: take a sleeping opposing Avatar for good, this card is attached to it
    react: {
      on: ['destroyed'],
      can: (g: Game, p: PID, c: Card, ev: Ev) => !!ev.leave && ev.leave.ctrl === p && ev.leave.zone === 'avatars' && ev.leave.battle && rickyPool(g, p).length > 0,
      want: (g: Game, p: PID) => rickyPool(g, p).some((a) => value(g, a) >= 3),
      resolve: (g: Game, p: PID, c: Card) => {
        const t = best(rickyPool(g, p), (a) => value(g, a));
        if (!t || !takeControl(g, t, p)) return;
        log(g, `P${p} takes control of ${t.def.name} (ริกกี้ นักปลอมแปลง)`);
        attach(g, c, t);
      },
    },
    // this card (as Modification) leaves: the Avatar goes back to its owner's hand
    afterLeave: (g: Game, self: Card, info: any) => { const w = info.wearer; if (info.zone === 'mod' && w && fzE(g, w) === 'avatars') toHand(g, w, w.owner); },
    // the Avatar wearing it is destroyed: it goes to its owner's hand instead of Hell
    onWearerLeave: (g: Game, m: Card, w: Card) => { m.f.rickyW = w.uid; return false; },
    onAnyLeave: (g: Game, self: Card, gone: Card, info: any) => {
      if (self.f.rickyW !== gone.uid) return;
      delete self.f.rickyW;
      const h = P(g, gone.owner).hell;
      if (info.how === 'destroy' && h.includes(gone)) { detach(g, gone); P(g, gone.owner).hand.push(gone); log(g, `${gone.def.name} returns to its owner's hand (ริกกี้ นักปลอมแปลง)`); }
    },
  },
  'โรงบาล': {
    keep: 2.5,
    canCast: (g: Game, p: PID) => !g.land || g.land.owner !== p,
    fieldActs: (g: Game, p: PID, c: Card) => [act('โรงบาล: discard 1, Avatar from hell', (g2) => inMain(g2, p) && once(g2, p, 'hospital') && P(g2, p).hand.length >= 1 && hellAvatars(g2, p, (x) => x.def.cost <= 3).length > 0,
      (g2) => {
        markOnce(g2, P(g2, p), 'hospital');
        if (!discardWorst(g2, p, 1)) return;
        const x = search(g2, p, (y) => isA(y) && y.def.cost <= 3, 'hell');
        if (x) addRuleE(g2, { p, key: 'โรงบาล', until: g2.turn, name: x.def.name });
      })],
  },
  'เทอราโนดอน จากต่างแดน': {
    keep: 3,
    // our กะปอม Avatars' สอดแนม +1 (src = the card whose ability scouts; an attack trigger runs without a source: use the fight)
    scoutBonus: (g: Game, self: Card, owner: PID, n: number, by: PID | null, src: Card | null) => {
      if (!P(g, self.ctrl).avatars.includes(self)) return 0;
      if (src) return by === self.ctrl && isA(src) && symIs(src, 'กะปอม') ? 1 : 0;
      const f = fightE();
      return f && f.att.ctrl === self.ctrl && owner === self.ctrl && symIs(f.att, 'กะปอม') ? 1 : 0;
    },
  },
  'มนุษย์ดัดแปลง': {
    keep: 3.5,
    canCast: (g: Game, p: PID) => hellAvatars(g, p, (x) => costOf(g, p, x) <= 3).length > 0 && P(g, p).hand.length >= 1 && canPlaceAvatar(P(g, p)),
    // other-team audit Q9: choosing the Hell Avatar and the discard are its cost, paid before the React window
    preCost: (g: Game, p: PID, c: Card) => {
      const pick = best(hellAvatars(g, p, (x) => costOf(g, p, x) <= 3), (x) => value(g, x));
      if (!pick || !discardWorst(g, p, 1)) return false;
      c.f.mdPick = pick.uid; return true;
    },
    modTarget: (g: Game, p: PID, c: Card) => {
      if (!textCost(g, c, () => FX['มนุษย์ดัดแปลง'].preCost!(g, p, c, 0))) return null;
      const pick = P(g, p).hell.find((x) => x.uid === c.f.mdPick); delete c.f.mdPick;
      if (!pick) return null;
      if (!canPlaceAvatar(P(g, p)) || !summon(g, p, pick, 'effect')) return null;
      return P(g, p).avatars.includes(pick) ? pick : null;
    },
    symbolsFor: (g: Game, self: Card, t: Card) => (t.mods.includes(self) ? { set: ['เครื่องจักร'] } : null),
    afterLeave: (g: Game, self: Card, info: any) => { const w = info.wearer; if (info.zone === 'mod' && w && fzE(g, w) === 'avatars') toHell(g, w); },
  },
  'ช่างมาแล้วววว': {
    keep: 3,
    react: { on: ['destroy'], can: (g: Game, p: PID, c: Card, ev: Ev) => !!ev.source && ev.source.def.type === 'Construct' && ev.source.ctrl === p, want: () => true, resolve: cancel },
  },
  'ป้อมยาม': {
    keep: 3,
    canBeAttacked: (g: Game, self: Card, con: Card) => con === self,
    noLifeAttack: (g: Game, self: Card, a: Card) => a.ctrl !== self.ctrl,
  },
  'วันชัยเปรตรุ่นพ่อ': {
    keep: 3,
    staticPower: (g: Game) => flippedLife(g.p[0]) + flippedLife(g.p[1]),
    fieldActs: (g: Game, p: PID, c: Card) => [act('วันชัย: flip our top LIFE, use its effect', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'wanchai:' + c.uid) && P(g2, p).life.some((l) => !l.faceUp),
      (g2) => {
        markOnce(g2, P(g2, p), 'wanchai:' + c.uid);
        const lc = flipLifeE(g2, p);
        if (!lc) return;
        const sp = lc.def.life, l = P(g2, p).life.find((x) => x.card === lc);
        if (!sp) { log(g2, `${lc.def.name}: no LIFE effect`); return; }
        // "ใน Main Phase ถัดไป" (and "when flipped by an attack") effects happen now; a Battle Phase one waits for this Battle Phase
        if (sp.when === 'main' || sp.atkOnly || g2.phase !== 'Main') { if (l) l.trig = false; resolveLifeE(g2, p, lc); }
        else if (l) l.trig = true;
      })],
  },
  'กลับบ้านเก่า': {
    keep: 3,
    canCast: (g: Game) => g.p.some((q) => q.avatars.some((a) => cameFromE(a, 'hell'))),
    resolve: (g: Game, p: PID) => { for (const q of g.p) for (const a of [...q.avatars]) if (cameFromE(a, 'hell')) destroy(g, a, p, true); },
  },
  [TRAVELER]: {
    keep: 3.5,
    fieldActs: (g: Game, p: PID, c: Card) => [act('นักท่อง: swap in a เรื่องราว', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && P(g2, p).hand.some(story6),
      (g2) => { const s = best(P(g2, p).hand.filter(story6), (x) => x.def.power); if (s) travelerSwap(g2, p, c, s); })],
    afterLeave: (g: Game, self: Card, info: any) => { if (info.zone === 'avatars' && info.to === 'exile') draw(g, info.ctrl, 1); },
  },
  'ขวัญตา เรื่องราว ราชาแห่งนาค': {
    keep: 4,
    getActive: travelerGet,
    handActs: storyBattle,
    staticPower: (g: Game, c: Card) => (c.f.byTraveler ? Math.floor(hellMagic(g, c.ctrl) / 2) : 0),
    fieldActs: (g: Game, p: PID, c: Card) => [act('ราชาแห่งนาค: Skill from hell', (g2) => !!c.f.byTraveler && inMain(g2, p) && once(g2, p, 'naga:' + c.uid) && P(g2, p).hand.length >= 1 && P(g2, p).hell.some((x) => x.def.type === 'Magic' && x.def.name.startsWith('Skill')),
      (g2) => { markOnce(g2, P(g2, p), 'naga:' + c.uid); if (discardWorst(g2, p, 1)) search(g2, p, (x) => x.def.type === 'Magic' && x.def.name.startsWith('Skill'), 'hell'); })],
  },
  'ขวัญตา เรื่องราว ครุฑเจ้าเวหา': {
    keep: 4,
    getActive: travelerGet,
    handActs: storyBattle,
    onAttack: (g: Game, c: Card) => {
      if (!c.f.byTraveler) return;
      const pl = P(g, c.ctrl);
      const s = pickN(pl.deck.filter((x) => x.def.type === 'Magic' && x.def.name.startsWith('Skill')), 1, (x) => keepValue(g, x), { optional: true, title: 'ขวัญตา: send a Skill from your Deck to Hell (optional)' })[0];
      if (s) { detach(g, s); pl.hell.push(s); shuffle(g, pl.deck); }
    },
    // one more React "Skill" per turn (a name not used this turn), besides the normal React
    onAnyMagic: (g: Game, self: Card, m: Card, caster: PID) => {
      if (!self.f.byTraveler || caster !== self.ctrl || m.def.subtype !== 'React') return;
      const pl = P(g, caster);
      pl.once['gx:n:' + m.def.name] = g.turn;
      if (FX[m.def.name]?.react?.ignoreLimit) return;
      if (pl.once['gx:mode'] === g.turn) { pl.once['gx:done'] = g.turn; delete pl.once['gx:mode']; return; } // the extra Skill
      if (pl.once['gx:done'] !== g.turn) { pl.once['gx:mode'] = g.turn; pl.used.React = false; log(g, `${self.def.name}: one more React "Skill" may be used this turn`); }
    },
    blockCast: (g: Game, self: Card, p: PID, c: Card) => !!self.f.byTraveler && p === self.ctrl && P(g, p).once['gx:mode'] === g.turn && c.def.subtype === 'React'
      && (!c.def.name.startsWith('Skill') || P(g, p).once['gx:n:' + c.def.name] === g.turn),
  },
  'K-BO ยอดหุ่นยนต์': {
    keep: 2.5,
    handActs: (g: Game, p: PID, c: Card) => [act('K-BO: trade a weapon to summon', (g2) => inMain(g2, p) && P(g2, p).hand.includes(c) && canPlaceAvatar(P(g2, p))
      && P(g2, p).avatars.some((a) => a.mods.some((m) => named(m, 'อาวุธของเพมมุ'))),
    (g2) => {
      const m = worst(P(g2, p).avatars.flatMap((x) => x.mods.filter((y) => named(y, 'อาวุธของเพมมุ'))), (y) => keepValue(g2, y));
      if (!m) return;
      toHell(g2, m, { cost: true });
      summon(g2, p, c, 'own');
    })],
    onOwnSummon: (g: Game, c: Card) => { c.f.kbo = 1; },
    getActive: (g: Game, self: Card) => !!self.f.kbo && 'สั่งใช้: เนรเทศ ใบนี้ → เพมมุ/สไปรท์ โจมตี: ฝ่ายตรงข้ามใช้ React/ความสามารถไม่ได้',
    fieldActs: (g: Game, p: PID, c: Card) => [act('K-BO: exile this, no React in เพมมุ / สไปรท์ fights this turn', (g2) => !!c.f.kbo && inMain(g2, p) && P(g2, p).avatars.includes(c)
      && P(g2, p).avatars.some((a) => nameHas(a, 'เพมมุ') || nameHas(a, 'สไปรท์')),
    (g2) => { if (toExile(g2, c, { cost: true })) addRuleE(g2, { p: opp(p), key: 'K-BO ยอดหุ่นยนต์', until: g2.turn }); })],
  },
  'ดินแดนยุติธรรม': {
    keep: 2.5,
    canCast: (g: Game, p: PID) => !g.land || g.land.owner !== p,
    // our Avatars with "เพมมุ" in the name or the text can't be removed by the opponent (except destroyed in a fight)
    leaveGuard: (g: Game, self: Card, t: Card, info: any) => {
      const o = self.owner;
      if (info.cost || info.battle || info.by !== opp(o) || info.zone !== 'avatars' || t.ctrl !== o || !justiceOn(g, o)) return null;
      if (!nameHas(t, 'เพมมุ') && !cardTextE(t).includes('เพมมุ')) return null;
      return { optional: false, run: () => true };
    },
  },
  'ตือโป๊ยก่าย': {
    keep: 3,
    // any Magic we use (Normal, Mod, Land, React): +1 until our next Draw Phase
    onOwnMagic: (g: Game, s: Card) => { if (once(g, s.ctrl, 'pig')) { markOnce(g, P(g, s.ctrl), 'pig'); s.f.pig = g.active === s.ctrl ? g.turn + 1 : g.turn; } },
    aura: (g: Game, s: Card, t: Card) => (t.ctrl === s.ctrl && isSaiyu(t) && (s.f.pig || 0) >= g.turn ? 1 : 0),
  },
  'วูตาตู': {
    keep: 3,
    fieldActs: (g: Game, p: PID, c: Card) => [act('วูตาตู: equip to an Avatar', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'wootatoo') && P(g2, p).avatars.some((a) => a !== c && !a.def.noWear),
      (g2) => { markOnce(g2, P(g2, p), 'wootatoo'); const w = best(P(g2, p).avatars.filter((a) => a !== c && !a.def.noWear), (a) => power(g2, a) + (a.asleep ? 0 : 2)); if (w) attach(g2, c, w); })],
    modPower: () => 3,
    symbolsFor: (g: Game, self: Card, t: Card) => (t.mods.includes(self) ? { set: ['ผี'] } : null),
    // only when the wearer is DESTROYED: attach to another of our Avatars (exile / back to hand: it stays in Hell)
    onWearerLeave: (g: Game, m: Card, w: Card) => { m.f.wtW = w.uid; return false; },
    onAnyLeave: (g: Game, self: Card, gone: Card, info: any) => {
      if (self.f.wtW !== gone.uid) return;
      delete self.f.wtW;
      const pl = P(g, self.owner);
      if (info.how !== 'destroy' || !pl.hell.includes(self)) return;
      const n = best(pl.avatars.filter((a) => a !== gone && !a.def.noWear), (a) => power(g, a));
      if (n) { attach(g, self, n); log(g, `วูตาตู attaches to ${n.def.name}`); }
    },
  },
  'หมีดำ': {
    keep: 3.5,
    jutsu: (g: Game, c: Card) => {
      const p = c.ctrl;
      if (!P(g, p).hand.some((x) => isA(x) && colorIs(x, 'ม่วง'))) return;
      const ok1 = (x: Card) => isA(x) && x.def.power <= 2 && !x.def.only && x !== c;
      mill(g, p, 2);
      const can1 = canPlaceAvatar(P(g, p)) && P(g, p).hell.some(ok1);
      const m = chooseMode(g, c, ['Summon an Avatar POWER 2 or less (not Only) from Hell', 'A Hell card (not Only) to Deck bottom'], can1 ? 0 : 1);
      if (m === 0) { fromZoneSummon(g, p, P(g, p).hell, ok1); return; }
      const x = best(P(g, p).hell.filter((y) => !y.def.only), (y) => keepValue(g, y));
      if (x) { detach(g, x); P(g, p).deck.push(x); }
    },
  },
  'สิงสู่เพื่อสู่สม': {
    keep: 4,
    canCast: (g: Game, p: PID) => P(g, p).avatars.some((a) => costOf(g, p, a) >= 3) && P(g, opp(p)).avatars.length > 0,
    resolve: (g: Game, p: PID, c: Card) => {
      if (!sacrifice(g, p, P(g, p).avatars.filter((a) => costOf(g, p, a) >= 3), 1)) return;
      const t = oppChoice(g, p, () => worst(P(g, opp(p)).avatars.filter((a) => !magicImmune(g, a, p)), (a) => value(g, a))); // the opponent picks
      if (t && steal(g, p, t)) attach(g, c, t);
    },
    // this card leaves the field (any way, e.g. ไต้ฝุ่น): control of its wearer goes back to the owner
    afterLeave: (g: Game, self: Card, info: any) => {
      const w = info.wearer;
      if (info.zone !== 'mod' || !w || fzE(g, w) !== 'avatars' || w.ctrl === w.owner) return;
      if (canPlaceAvatar(P(g, w.owner))) { if (takeControl(g, w, w.owner)) log(g, `${w.def.name} goes back to P${w.owner} (สิงสู่เพื่อสู่สม left)`); }
      else toHell(g, w);
    },
  },
  'โอตะคูลา': {
    keep: 2, costOnlyFor: (s: Card) => named(s, 'ไอดอล') || named(s, 'โปรดิวเซอร์'),
    fieldActs: (g: Game, p: PID, c: Card) => {
      const k = 'otakula:' + c.uid;
      const hosts = (g2: Game) => P(g2, p).avatars.filter((a) => a !== c && (named(a, 'ไอดอล') || named(a, 'มีมมิ')) && !a.def.noWear);
      return [
        act('โอตะคูลา: equip to ไอดอล / มีมมิ', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, k) && hosts(g2).length > 0,
          (g2) => { markOnce(g2, P(g2, p), k); const w = best(hosts(g2), (a) => value(g2, a) + (named(a, 'มีมมิ') ? 2 : 0)); if (w) attach(g2, c, w); }),
        act('โอตะคูลา: summon itself from equipped state', (g2) => inMain(g2, p) && fzE(g2, c) === 'mod' && c.ctrl === p && once(g2, p, k) && canPlaceAvatar(P(g2, p)),
          (g2) => { markOnce(g2, P(g2, p), k); summon(g2, p, c, 'own'); }),
        // other-team audit: the card (and the user's ruling) says "มีมมิ" (the code looked for "บีมมิ", so it could never be used)
        act('โอตะคูลา: exile this + discard 1, มีมมิ from Deck', (g2) => inMain(g2, p) && !!fzE(g2, c) && P(g2, p).hand.length >= 1 && P(g2, p).deck.some((x) => isA(x) && named(x, 'มีมมิ')),
          (g2) => { if (!toExile(g2, c, { cost: true }) || !discardWorst(g2, p, 1)) return; search(g2, p, (x) => isA(x) && named(x, 'มีมมิ'), 'deck'); }),
      ];
    },
    modPower: (g: Game, m: Card, w: Card) => (named(w, 'มีมมิ') ? 2 : named(w, 'ไอดอล') ? 1 : 0),
  },
  'สุครีพ วานรปากแซ่บ': {
    keep: 3,
    // start of our Main Phase: 2 opposing Avatars' Cost becomes the lower of the two until end of turn (shown in the detail box)
    startMain: (g: Game, c: Card) => {
      const o = P(g, opp(c.ctrl)).avatars;
      if (o.length < 2) return;
      const a1 = best(o, (a) => costOf(g, a.ctrl, a));
      const a2 = a1 ? worst(o.filter((a) => a !== a1), (a) => costOf(g, a.ctrl, a)) : null;
      if (!a1 || !a2) return;
      const low = Math.min(costOf(g, a1.ctrl, a1), costOf(g, a2.ctrl, a2));
      for (const a of [a1, a2]) setCostE(g, a, low, g.turn);
      log(g, `สุครีพ: ${a1.def.name} and ${a2.def.name} have Cost ${low} this turn`);
    },
  },
};
Object.assign(FX, E);
