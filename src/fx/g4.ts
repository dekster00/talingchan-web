// Card effects for BT06, KD00, KD01, KD04, PRE0, PRMO, ODY1 (cards not coded in cards.ts / cards2.ts).
// Approximations are marked "approx:". A power change with no duration printed lasts while the card stays on the field.
import { rollDie } from '../engine.ts';
import type { Card, Def, Game, PID } from '../types.ts';
import type { Ev } from '../engine.ts';
import { canChangeCtrl, takeControl, grantKw, landIs as landOn, isLandOn, placeLand, magicImmune, currentSource, lands, useShield } from '../engine.ts';
import type { Fx, HandAct } from '../cards.ts';
import { FX, value, best, worst, pickN, worstN, mayDo, chooseMode, oppChoice, removeOpp, search, inMain, magicOk } from '../cards.ts';
import { costFirst } from '../cards.ts'; // other-team audit Q9
import {
  P, opp, power, draw, destroy, toHell, toExile, discard, detach, summon, shuffle, mill,
  canPlaceAvatar, flippedLife, critical, onceUsed, markOnce, keepValue, log, findCard, rand,
  choosePayment, costOf, hitLife,
  symIs, symAny, colorIs, scoutDeck, putBottom, silenceFull, summonExact, colorsEn, arrangeTopBottom, decide, humanDeciding
} from '../engine.ts';
import { flipLifeCard, currentFight, nameHas, fieldZone, bestPayment, RULES, addRule, RULE_GAME, toHand, askChoose } from '../engine.ts';
import { grantGet } from '../view.ts';
import { canWear as canWearE, lifeDown } from '../engine.ts';

// ---------- helpers (copies of the cards2.ts helpers, which are not exported) ----------
const isA = (c: Card) => c.def.type === 'Avatar' || c.def.type === 'Token';
function named(c: Card, key: string) {
  if (c.def.aka && c.def.aka.some((a) => a.includes(key))) return true;
  if (c.def.name.includes(key)) return true;
  const f = FX[c.def.name];
  return !!(f && f.alias && f.alias.some((a) => a.includes(key)));
}
const onZone = (g: Game, p: PID, key: string) => P(g, p).avatars.filter((a) => named(a, key));
const hellAvatars = (g: Game, p: PID, pred: (c: Card) => boolean = () => true) => P(g, p).hell.filter((c) => isA(c) && pred(c));
const distinctNames = (cs: Card[]) => new Set(cs.map((c) => c.def.name)).size;
const once = (g: Game, p: PID, key: string) => !onceUsed(g, P(g, p), key);
// สอดแนม / look at the top n: engine scoutDeck() reveals them, lets the human pick and order the rest
function peek(g: Game, p: PID, n: number, pick: (cs: Card[]) => void, rest: 'bottom' | 'shuffle' | 'hell' | 'top' | 'either' = 'shuffle') {
  scoutDeck(g, p, n, pick, rest);
}
function takeHand(g: Game, p: PID, list: Card[], pred: (c: Card) => boolean) {
  const c = best(list.filter(pred), (x) => keepValue(g, x) + x.def.power * 0.3);
  if (c) { list.splice(list.indexOf(c), 1); P(g, p).hand.push(c); }
  return c;
}
function takeSummon(g: Game, p: PID, list: Card[], pred: (c: Card) => boolean, how: 'jutsu' | 'effect' = 'effect') {
  const c = best(list.filter((x) => isA(x) && pred(x)), (x) => value(g, x));
  if (!c || !canPlaceAvatar(P(g, p))) return null;
  list.splice(list.indexOf(c), 1);
  c.f.viaScout = 1; P(g, p).hell.push(c); // somewhere findable; summon() detaches it
  return summon(g, p, c, how) ? c : null;
}
function fromZoneSummon(g: Game, p: PID, zone: Card[], pred: (c: Card) => boolean, how: 'jutsu' | 'effect' = 'effect') {
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
  const f = FX[c.def.name]; if (f && f.onAttach) f.onAttach(g, c, w);
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
const act = (label: string, can: (g: Game) => boolean, run: (g: Game) => void): HandAct => ({ label, can, run });
const d6 = (g: Game) => rollDie(g); // emits the 'roll' event
function boost(c: Card, n: number) { c.temp.push({ power: n, until: 'turn' }); }
function resetCard(c: Card) {
  c.asleep = false; c.temp = []; c.kick = false; c.bonus = 0; c.noWakeUntil = 0; c.magicImmuneUntil = 0;
  c.silencedTurn = -1; c.fumaExile = false; c.goemonGain = false; c.f = {};
}
// Put a card into p's Magic Zone (optionally renamed, e.g. "ข้ารับใช้ของ มนุษย์ดาว R18").
function toMz(g: Game, p: PID, c: Card, rename?: { name: string; symbol: string }) {
  if (!canChangeCtrl(g, c, p)) { log(g, `${c.def.name}: its control can't be changed (รูปประจำบ้าน)`); return; }
  for (const m of c.mods.splice(0)) { m.wearer = -1; P(g, m.owner).hell.push(m); }
  detach(g, c); resetCard(c); c.ctrl = p;
  if (rename) c.def = { ...c.def, name: rename.name, symbol: rename.symbol, orig: (c.def as any).orig || c.def } as Def;
  P(g, p).mz.push(c);
}
function restoreDef(c: Card) { const o = (c.def as any).orig; if (o) c.def = o; }
// Send a field card to its owner's hell, restoring a renamed card first.
function sendHell(g: Game, c: Card) { restoreDef(c); toHell(g, c); }
// Avatar from the field (or hell) to the owner's Deck (bottom, or shuffled in).
function toDeck(g: Game, c: Card, shuffleIn: boolean) {
  restoreDef(c);
  const pl = P(g, c.owner);
  if (!pl.hell.includes(c)) toHell(g, c);
  const i = pl.hell.indexOf(c);
  if (i < 0) return;
  pl.hell.splice(i, 1); pl.deck.push(c);
  if (shuffleIn) shuffle(g, pl.deck);
}
function noSteal(t: Card) {
  return t.mods.some((m) => (FX[m.def.name] as any)?.noSteal) || !!(FX[t.def.name] as any)?.noSteal;
}
function steal(g: Game, p: PID, t: Card, sleep = false) {
  if (noSteal(t) || !canPlaceAvatar(P(g, p))) return false;
  if (!takeControl(g, t, p)) return false; if (sleep) t.asleep = true;
  log(g, `P${p} takes control of ${t.def.name}`);
  return true;
}
// วิรูฬ / ฉัพพยา: "if POWER 7+ at the start of the Battle Phase: gets ... until end of turn" (our Battle Phase)
function gainAt7(g: Game, c: Card) {
  if (g.active !== c.ctrl || !P(g, c.ctrl).avatars.includes(c) || power(g, c) < 7) return;
  c.f.got7 = g.turn; log(g, `${c.def.name}: POWER ${power(g, c)} at the start of the Battle Phase, gets its ability`);
}
// คำสั่งของพระอิศวร targets
const shivaAv = (g: Game, p: PID) => P(g, opp(p)).avatars.filter((a) => magicOk(g, p, a));
const shivaCon = (g: Game, p: PID) => P(g, opp(p)).mz.filter((x) => x.def.type === 'Construct' && magicOk(g, p, x));
// นรกในกรง: each player above 3 Avatars sends the extra ones to Hell (that player chooses)
function cageTrim(g: Game, c: Card) {
  if (!isLandOn(g, c) || c.f.trimming) return;
  c.f.trimming = 1;
  try {
    for (const q of g.p) while (q.avatars.length > 3) {
      const a = decide(g, q.id, () => worst(q.avatars, (x) => value(g, x)));
      if (!a || !toHell(g, a, { by: c.ctrl, src: c })) break;
    }
  } finally { delete c.f.trimming; }
}
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
// card-family tests
const naga = (c: Card) => isA(c) && named(c, 'นาค') && symIs(c, 'สัตว์มหัศจรรย์');
const valk = (c: Card) => isA(c) && named(c, 'เทพธิดาแห่งวัลฮัลลา');
const knight = (c: Card) => named(c, 'อัศวินโต๊ะกลม');
const tako = (c: Card) => isA(c) && named(c, 'ทาโกะ');
const migraine = (c: Card) => isA(c) && named(c, 'ไมเกรน');
const weapon = (c: Card) => c.def.type === 'Magic' && c.def.subtype === 'Modification' && c.def.name.includes('นักรบผู้กล้า')
  && (c.def.name.includes('อาวุธ') || c.def.name.includes('อาวุร'));
const dogcat = (c: Card) => isA(c) && (named(c, 'หมา') || named(c, 'แมว')) && symIs(c, 'สัตว์');
const SERVANT = 'ข้ารับใช้ของ มนุษย์ดาว R18';
const isServant = (c: Card) => c.def.name.includes('ข้ารับใช้') && c.def.name.includes('มนุษย์ดาว R18');
const servantsOn = (g: Game, p: PID) => [...P(g, p).avatars, ...P(g, p).mz].filter(isServant);
const makeServant = (g: Game, p: PID, c: Card) => toMz(g, p, c, { name: SERVANT, symbol: 'เอเลี่ยน' });
// Our own mods: รีวิวแมน ignores wear conditions; แมมมอธแช่แข็ง can't wear any.
const wearers = (g: Game, p: PID, pred: (a: Card) => boolean) =>
  P(g, p).avatars.filter((a) => a.def.name !== 'แมมมอธแช่แข็ง' && (pred(a) || a.def.name === 'รีวิวแมน'));
// "can't attack" flag (canAttack reads c.f.noAttack === g.turn)
const lockAttack = (g: Game, c: Card) => { if (P(g, c.ctrl).avatars.includes(c)) c.f.noAttack = g.turn; };
// Valhalla goddesses trigger when milled "by a purple เทพ Avatar or a Magic card".
// v14: MillInfo: a Magic is resolving (duringMagic), or the milling card is a purple เทพ Avatar (ซีกรุน, ซีเกิร์ด, เฮล่า, โอดิน ...).
let VAL_MILL = false;
const valMillOk = (g: Game, info?: any) => VAL_MILL || (!!info && (info.duringMagic || (!!info.src && isA(info.src) && symIs(info.src, 'เทพ') && colorIs(info.src, 'ม่วง'))))
  || (!info && g.p.some((q) => (q.resolving || []).length > 0));
function valMill(g: Game, p: PID, n: number) { VAL_MILL = true; try { return mill(g, p, n); } finally { VAL_MILL = false; } }
// ไมเกรน cards coded in this file (only they can use THE END's granted ability)
const MY_MIGRAINES = ['หุ่นนักรบผู้กล้า : โปรโตไมเกรน', 'หุ่นนักรบผู้กล้า ไมเกรน', 'ราชันย์หุ่นนักรบผู้กล้า : คริติคอล ไมเกรน'];
function theEndAttack(g: Game, c: Card, t: Card | null) {
  return; // v14: THE END's granted fight is resolved by the THE END card itself (afterFight), for every ไมเกรน
  if (c.f.theEnd !== g.turn) return;
  const p = c.ctrl;
  for (const d of [...P(g, opp(p)).avatars]) {
    if (d === t || !P(g, p).avatars.includes(c)) continue;
    const pa = power(g, c), pd = power(g, d);
    if (pa > pd) destroy(g, d, p);
    else if (pd > pa) { destroy(g, c, opp(p)); return; } else { destroy(g, d, p); destroy(g, c, opp(p)); return; }
  }
}
// THE END: att fights every other opposing Avatar at the same time (each pair compares POWER; ties destroy both)
function theEndAll(g: Game, att: Card, target: Card) {
  const p = att.ctrl, o = opp(p);
  if (!P(g, p).avatars.includes(att)) return;
  const pa = power(g, att), others = P(g, o).avatars.filter((d) => d !== target);
  if (!others.length) return;
  log(g, `THE END: ${att.def.name} fights ${others.map((d) => d.def.name).join(', ')} at once`);
  let dies = false;
  const lose = others.filter((d) => { const pd = power(g, d); if (pd >= pa) dies = true; return pd <= pa; });
  for (const d of lose) destroy(g, d, p, false, { battle: true });
  if (dies) destroy(g, att, o, false, { battle: true });
}
// พระนารายณ์ swap from hand "after a battle where a พระนารายณ์ destroyed an opposing Avatar".
// The attacker's side gets a 'fight' response window; this observer records that fight (it never responds).
function narayWatch(): Fx['react'] {
  return {
    on: ['fight'], noLimit: true, fromHand: true,
    can: (g, p, c, ev) => {
      if (ev.actor !== p && g.active === p && ev.target && ev.target.ctrl === p && named(ev.target, 'พระนารายณ์') && ev.source) {
        const pl = P(g, p); pl.once['narayFight'] = g.stats.attacks; pl.once['narayVictim'] = ev.source.uid;
      }
      return false;
    },
    want: () => false,
    resolve: () => {},
  };
}
function narayKilled(g: Game, p: PID) {
  const pl = P(g, p);
  if (pl.once['narayFight'] !== g.stats.attacks) return false;
  const v = findCard(g, pl.once['narayVictim']);
  return !v || !P(g, opp(p)).avatars.includes(v);
}
function narayAct(name: string, after: (g: Game, p: PID, c: Card) => void): Fx['handActs'] {
  return (g, p, c) => [act(`${name}: swap in after a พระนารายณ์ win`, (g2) => g2.phase === 'Battle' && g2.active === p && P(g2, p).hand.includes(c)
    && once(g2, p, 'naray:' + name) && narayKilled(g2, p) && onZone(g2, p, 'พระนารายณ์').length > 0,
  (g2) => {
    const pl = P(g2, p); markOnce(g2, pl, 'naray:' + name); pl.once['narayFight'] = -1;
    const s = worst(onZone(g2, p, 'พระนารายณ์'), (a) => (a.asleep ? 0 : 3) + value(g2, a));
    if (!s) return;
    toHell(g2, s);
    if (summon(g2, p, c, 'own') && pl.avatars.includes(c)) after(g2, p, c);
  })];
}
function narayEnd(g: Game, c: Card) {
  if (c.f.narayEnd !== g.turn) return;
  const p = c.ctrl, nm = c.def.name;
  toHell(g, c);
  fromZoneSummon(g, p, P(g, p).hell, (x) => named(x, 'พระนารายณ์') && x.def.name !== nm);
}
const BANK_LAND = 'สภาแบงค์';
function refreshOden(g: Game, p: PID) {
  const has = P(g, p).avatars.some(tako);
  for (const a of P(g, p).avatars) if (a.def.name === 'โอเดนย่ากาย') a.f.noAttack = has ? 0 : g.turn;
}
function tutorTako(name: string): Fx['jutsu'] {
  return (g, c) => { search(g, c.ctrl, (x) => x.def.name === name, 'deck'); refreshOden(g, c.ctrl); };
}
// other-team audit Q5 (user: the bag / dog cards are not "เครื่องบิน Super Air", but an equipped one counts): the card named
// เครื่องบิน Super Air, or an Avatar wearing เก้าอี้ เฟิร์สคลาส (it gets the name "Super Air")
const pigeonPlane = (a: Card) => a.def.name === 'เครื่องบิน Super Air' || a.mods.some((m) => m.def.name === 'เก้าอี้ เฟิร์สคลาส');
function fireDice(g: Game, p: PID) {
  // ธาตุไฟแตก ๆ: send one of ours to hell, roll: even destroys 2 opposing Avatars, odd destroys 1 of ours
  const sac = worst(P(g, p).avatars, (a) => value(g, a));
  if (!sac) return;
  toHell(g, sac);
  if (d6(g) % 2 === 0) {
    for (const t of pickN(P(g, opp(p)).avatars.filter((a) => magicOk(g, p, a)), 2, (x) => value(g, x), { title: 'ธาตุไฟแตก ๆ: destroy 2 opposing Avatars' })) destroy(g, t, p, true);
  } else {
    const t = worst(P(g, p).avatars, (a) => value(g, a)); if (t) destroy(g, t, p);
  }
}

Object.assign(FX, {
  // ===== BT06 นาค =====
  // v14: at the start of our Battle Phase, POWER 7+ -> it gets the ability until end of turn (c.f.got7 = g.turn; GET badge).
  // กัณหา BT09-005 sets got7 directly on the นาค it calls. วิรูฬ: LIFE flipped by its attack have no effect.
  'วิรูฬ นาคเกล็ดทอง': {
    keep: 2.5,
    startBattle: (g: Game, c: Card) => gainAt7(g, c),
    getActive: (g: Game, c: Card) => c.f.got7 === g.turn && 'POWER 7+: LIFE ที่ถูกหงายจากการโจมตีของใบนี้ ความสามารถไม่ทำงาน (จนจบเทิร์น)',
    onLifeFlipped: (g: Game, c: Card, p: PID, life: Card, byAttack: boolean) => {
      if (c.f.got7 !== g.turn || !byAttack || p === c.ctrl || currentFight()?.att !== c) return;
      const l = P(g, p).life.find((x) => x.card === life);
      if (l && l.trig) { l.trig = false; log(g, `วิรูฬ: ${life.def.name}'s ability does not work`); }
    },
  } as Fx,
  // ฉัพพยา: an attack on LIFE that hits deals 2 LIFE damage
  'ฉัพพยา นาคเกล็ดรุ้ง': {
    keep: 3,
    startBattle: (g: Game, c: Card) => gainAt7(g, c),
    getActive: (g: Game, c: Card) => c.f.got7 === g.turn && 'POWER 7+: โจมตี LIFE สำเร็จ ทำความเสียหาย LIFE 2 ใบ (จนจบเทิร์น)',
    onLifeFlipped: (g: Game, c: Card, p: PID, life: Card, byAttack: boolean) => {
      if (c.f.got7 !== g.turn || !byAttack || p === c.ctrl || currentFight()?.att !== c || c.f.dbl === g.stats.attacks) return;
      c.f.dbl = g.stats.attacks; // one extra damage per attack
      log(g, 'ฉัพพยา: 2 LIFE damage'); hitLife(g, p, c);
    },
  } as Fx,
  'เอรา นาคเกล็ดเขียว': {
    keep: 3,
    jutsu: (g: Game, c: Card) => { const t = best(P(g, c.ctrl).avatars.filter(naga), (a) => value(g, a) + (a.asleep ? 0 : 2)); if (t) t.bonus += 2; },
  },
  'อนันต์ ราชาแห่งนาค': {
    keep: 6,
    fieldActs: (g: Game, p: PID, c: Card) => [act('อนันต์: other นาค get this POWER', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'anan')
      && P(g2, p).avatars.some((a) => a !== c && naga(a) && power(g2, a) < power(g2, c)),
    (g2) => {
      markOnce(g2, P(g2, p), 'anan');
      const pc = power(g2, c);
      for (const a of P(g2, p).avatars.filter((x) => x !== c && naga(x))) { const d = pc - power(g2, a); if (d) boost(a, d); } // approx: set once, not kept equal
    })],
    onKill: (g: Game, c: Card) => { if (g.active === c.ctrl) hitLife(g, opp(c.ctrl), null); },
  },
  'รีวิวแมน': { keep: 2.5 }, // approx: ignores wear conditions only for the Modification cards coded in this file
  'เคย์ อัศวินโต๊ะกลมแห่งความหลักแหลม': {
    keep: 3.5,
    react: {
      on: ['attack'], noLimit: true, onceKey: 'kay',
      can: (g: Game, p: PID, c: Card, ev: Ev) => ev.actor !== p && !!ev.target && ev.target.ctrl === p && knight(ev.target)
        && P(g, p).avatars.some((a) => a.mods.some((m) => named(m, 'ดาบศักดิ์สิทธิ์'))),
      want: (g: Game, p: PID, c: Card, ev: Ev) => { const pa = power(g, ev.source!), pt = power(g, ev.target!); return pt <= pa && pt + 2 > pa; },
      resolve: (g: Game, p: PID, c: Card, ev: Ev) => {
        const sw = worst(P(g, p).avatars.flatMap((a) => a.mods).filter((m) => named(m, 'ดาบศักดิ์สิทธิ์')), (m) => keepValue(g, m));
        if (!sw) return;
        detach(g, sw); P(g, sw.owner).hell.push(sw);
        const t = ev.target && P(g, p).avatars.includes(ev.target) ? ev.target : best(P(g, p).avatars.filter(knight), (a) => power(g, a));
        if (t) boost(t, 2);
      },
    },
  },
  'ยอดนักบุญ': {
    keep: 2,
    jutsu: (g: Game, c: Card) => {
      for (const a of P(g, c.ctrl).avatars) if (a !== c) for (const m of [...a.mods]) if (m.def.name === 'น้ำใจ') attach(g, m, c);
    },
    staticPower: (g: Game, c: Card) => (c.mods.filter((m) => m.def.name === 'น้ำใจ').length >= 4 ? 10 - c.def.power : 0),
  },
  'หุ่นนักรบผู้กล้า : โปรโตไมเกรน': {
    keep: 3.5,
    onAttack: theEndAttack,
    onKill: (g: Game, c: Card) => {
      const p = c.ctrl, pl = P(g, p);
      if (g.active !== p) return;
      const t = best(pl.deck.filter((x) => x.def.name === 'หุ่นนักรบผู้กล้า : ไมเกรน' || x.def.name === 'หุ่นนักรบผู้กล้า ไมเกรน'), (x) => value(g, x));
      if (!t) return;
      const mods = c.mods.splice(0); for (const m of mods) m.wearer = -1;
      toHell(g, c);
      const ok = summon(g, p, t, 'jutsu') && pl.avatars.includes(t);
      for (const m of mods) { if (ok) attach(g, m, t); else P(g, m.owner).hell.push(m); }
      shuffle(g, pl.deck);
    },
  },
  'พระอิศวรปลอม': {
    keep: 3,
    jutsu: (g: Game, c: Card) => { const t = best(P(g, opp(c.ctrl)).avatars, (a) => value(g, a) + (power(g, a) <= 2 ? 2 : 0)); if (t) t.temp.push({ power: -2, until: 'turn' }); },
  },
  'กัปตัน 7 สี': {
    keep: 3.5,
    jutsu: (g: Game, c: Card) => {
      const p = c.ctrl;
      const cols = new Set(P(g, p).avatars.filter((a) => a !== c).map((a) => a.def.color));
      const modes = (['แดง', 'ฟ้า', 'เขียว', 'ม่วง'] as const).filter((x) => cols.has(x));
      if (!modes.length) return;
      const lab: Record<string, string> = { 'แดง': 'Red: POWER +2', 'ฟ้า': 'Blue: draw 1', 'เขียว': 'Green: not destroyed this turn', 'ม่วง': 'Purple: mill 1, Hell card to Deck bottom' };
      const m = modes[chooseMode(g, c, modes.map((x) => lab[x]), 0)];
      if (m === 'แดง') c.bonus += 2;
      else if (m === 'ฟ้า') draw(g, p, 1);
      else if (m === 'เขียว') c.f.noDie = g.turn;
      else if (m === 'ม่วง') {
        mill(g, p, 1);
        const x = best(P(g, p).hell, (y) => keepValue(g, y)); if (x) { detach(g, x); P(g, p).deck.push(x); }
      }
    },
    protectSelf: (g: Game, c: Card) => c.f.noDie === g.turn,
  },
  'บึงทมิฬ  People  - คุณบลูลอบสเตอร์': {
    keep: 2.5,
    // v14 ruling (confirmed): summonable from hand in our Main Phase while บึงทมิฬ is the Land
    handActs: (g: Game, p: PID, c: Card) => [act('บลูลอบสเตอร์: reveal and summon', (g2) => inMain(g2, p) && P(g2, p).hand.includes(c) && once(g2, p, 'lobster')
      && lands(g2).some((l) => l.def.name.includes('บึงทมิฬ')) && canPlaceAvatar(P(g2, p)),
    (g2) => { markOnce(g2, P(g2, p), 'lobster'); summon(g2, p, c, 'own'); })],
    onOwnSummon: (g: Game, c: Card) => { const t = best(P(g, opp(c.ctrl)).avatars, (a) => value(g, a)); if (t) destroy(g, t, c.ctrl); },
    // other-team audit: "ถูกนำขึ้นมือด้วยความสามารถของ บึงทมิฬ": reveal and summon at once
    onToHand: (g: Game, c: Card, from: string, by: PID | null, src: Card | null) => {
      const p = c.owner;
      if (!src || by !== p || !nameHas(src, 'บึงทมิฬ') || !P(g, p).hand.includes(c) || !canPlaceAvatar(P(g, p))) return;
      log(g, `${c.def.name} is revealed (brought to hand by ${src.def.name}) and summoned`); summon(g, p, c, 'own');
    },
  },
  'สวีนนีย์ มนุษย์ดาว R18': {
    keep: 4.5,
    onKill: (g: Game, c: Card, victim: Card) => {
      if (!P(g, victim.owner).hell.includes(victim)) return;
      makeServant(g, c.ctrl, victim);
      log(g, `${(victim.def as any).orig?.name} becomes a servant in P${c.ctrl}'s Magic Zone`);
    },
    deathCry: (g: Game, c: Card, owner: PID) => {
      const s = oppChoice(g, owner, () => best(P(g, owner).mz.filter(isServant), (x) => x.def.power)); // chosen by the opponent
      if (s) sendHell(g, s);
    },
  },
  [SERVANT]: { // helper entry: an Avatar turned into a servant (BT06-014 / BT06-066)
    keep: 1,
    deathCry: (g: Game, c: Card) => restoreDef(c),
    endPhase: (g: Game, c: Card) => { if (c.f.joy === g.turn && P(g, c.ctrl).avatars.includes(c)) toMz(g, c.ctrl, c); },
  },
  'อามัส มนุษย์ดาว R18': { keep: 3, staticPower: (g: Game, c: Card) => servantsOn(g, c.ctrl).length },
  'จอย มนุษย์ดาว R18': {
    keep: 3.5,
    fieldActs: (g: Game, p: PID, c: Card) => [act('จอย: call a servant from the Magic Zone', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'joy')
      && canPlaceAvatar(P(g2, p)) && P(g2, p).mz.some((x) => isServant(x) && isA(x)),
    (g2) => {
      markOnce(g2, P(g2, p), 'joy');
      const s = best(P(g2, p).mz.filter((x) => isServant(x) && isA(x)), (x) => x.def.power);
      if (s && summon(g2, p, s, 'effect') && P(g2, p).avatars.includes(s)) s.f.joy = g2.turn;
    })],
  },
  'วิลโล่ ปลาแกะ': { keep: 2 }, // v14: "#... Symbol สัตว์ ด้วย" = Def.syms (sim.ts hashStats): symIs / the detail box see สัตว์ too
  'จ่ามะนาวแขนเหล็ก': {
    keep: 4.5, shield: true, unite: true,
    // v14 ruling: after a "จ่ามะนาว" Cost 3 or less on our Avatar Zone was destroyed (by anyone), a popup offers to summon
    // this from hand by paying its Cost (free while we are in สาหัส): 'destroyed' window, fromHand.
    react: {
      on: ['destroyed'], fromHand: true, noLimit: true,
      can: (g: Game, p: PID, c: Card, ev: Ev) => !!ev.leave && ev.leave.ctrl === p && ev.leave.zone === 'avatars' && !!ev.source && ev.source !== c
        && nameHas(ev.source, 'จ่ามะนาว') && ev.source.def.cost <= 3 && canPlaceAvatar(P(g, p), false, c)
        && (critical(P(g, p)) || !!bestPayment(g, p, costOf(g, p, c), [c], c)),
      want: () => true,
      resolve: (g: Game, p: PID, c: Card) => {
        const pl = P(g, p);
        if (!pl.hand.includes(c) || !canPlaceAvatar(pl, false, c)) return;
        if (critical(pl)) { summon(g, p, c, 'own'); return; }
        const pay = choosePayment(g, p, costOf(g, p, c), [c], c);
        if (pay) summon(g, p, c, 'paid', pay);
      },
    },
  },
  'ผู้เจริญระดับสูงสุด': {
    keep: 3,
    fieldActs: (g: Game, p: PID, c: Card) => [act('ผู้เจริญระดับสูงสุด: move a เสามงคล to the Magic Zone', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c)
      && once(g2, p, 'sujarern') && onZone(g2, p, 'เสามงคล').length > 0,
    (g2) => { markOnce(g2, P(g2, p), 'sujarern'); const t = worst(onZone(g2, p, 'เสามงคล'), (a) => value(g2, a)); if (t) toMz(g2, p, t); })],
  },
  'บอล ผู้รักวิตามิน': {
    keep: 2.5,
    staticPower: (g: Game, c: Card) => P(g, c.ctrl).avatars.filter((a) => a !== c && (named(a, 'กุ่ย') || named(a, 'ฮอล') || named(a, 'นาย'))).length,
  },
  'ฮิฟีสตัส เทพโอลิมปัสแห่งการช่าง': {
    keep: 1,
    gemAs: (g: Game, c: Card, forCard: Card | null) => (forCard && forCard.def.type === 'Construct' ? 5 : c.def.gem),
  },
  'แบงค์ผู้พิชิต': {
    keep: 6,
    staticPower: (g: Game, c: Card) => (distinctNames(hellAvatars(g, c.ctrl, (x) => named(x, 'แบงค์'))) >= 5 ? 2 : 0),
    // v14: 10 names: from its target selection to the end of that fight the opponent can't use React Magic (blockReact)
    blockReact: (g: Game, c: Card, ev: Ev) => {
      const f = currentFight();
      return f && f.att === c && P(g, c.ctrl).avatars.includes(c) && (ev.responder ?? opp(ev.actor)) !== c.ctrl && distinctNames(hellAvatars(g, c.ctrl, (x) => named(x, 'แบงค์'))) >= 10 ? 'magic' : null;
    },
    onKill: (g: Game, c: Card) => { if (distinctNames(hellAvatars(g, c.ctrl, (x) => named(x, 'แบงค์'))) >= 7) hitLife(g, opp(c.ctrl), null); },
    hellActs: (g: Game, p: PID, c: Card) => [act('แบงค์ผู้พิชิต: send 4 แบงค์ to hell, revive', (g2) => inMain(g2, p) && P(g2, p).hell.includes(c)
      && onZone(g2, p, 'แบงค์').length >= 4,
    (g2) => {
      const pl = P(g2, p);
      for (const a of worstN(onZone(g2, p, 'แบงค์'), 4, (x) => value(g2, x), { title: 'แบงค์ผู้พิชิต: send 4 แบงค์ to Hell' })) toHell(g2, a);
      if (pl.hell.includes(c)) summon(g2, p, c, 'own');
    })],
  },
  'อู๊ด คุณแม่': {
    keep: 3,
    fieldActs: (g: Game, p: PID, c: Card) => [act('อู๊ด: sacrifice, mill 3, call แบงค์', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && P(g2, p).deck.length > 6
      && P(g2, p).deck.some((x) => isA(x) && named(x, 'แบงค์') && !x.def.only),
    (g2) => {
      const pl = P(g2, p);
      destroy(g2, c, p); mill(g2, p, 3);
      fromZoneSummon(g2, p, pl.deck, (x) => named(x, 'แบงค์') && !x.def.only);
      shuffle(g2, pl.deck);
    })],
  },
  'เลอติ๊ก เด็กไม่ชอบแดรคคูลา': {
    keep: 3,
    onKill: (g: Game, c: Card, victim: Card) => { if (P(g, victim.owner).hell.includes(victim)) toDeck(g, victim, true); },
  },
  'แอชวิคกับอโศกาบาร์พิศวง': {
    keep: 5, // approx: พอดี (exact GEM payment) is not enforced
    jutsu: (g: Game, c: Card) => { fromZoneSummon(g, c.ctrl, P(g, c.ctrl).hell, (x) => symAny(x, ['ผี', 'เปรต', 'เอเลี่ยน']) && x.def.cost <= 5, 'jutsu'); },
  },
  'สกัลด์ เทพธิดาแห่งวัลฮัลลา': {
    keep: 2.5,
    onMilled: (g: Game, c: Card, p: PID, v: boolean, info?: any) => {
      if (!valMillOk(g, info)) return;
      fromZoneSummon(g, p, P(g, p).hell, (x) => valk(x) && x.def.cost <= 4 && x.def.name !== 'สกัลด์ เทพธิดาแห่งวัลฮัลลา');
    },
  },
  'โอลรุน เทพธิดาแห่งวัลฮัลลา': {
    keep: 3,
    onMilled: (g: Game, c: Card, p: PID, v: boolean, info?: any) => { if (valMillOk(g, info) && P(g, p).hell.includes(c)) { detach(g, c); P(g, p).hand.push(c); } },
  },
  'ซีกรุน เทพธิดาแห่งวัลฮัลลา': {
    keep: 4,
    fieldActs: (g: Game, p: PID, c: Card) => [act('ซีกรุน: mill 3, +1', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'sigrun') && P(g2, p).deck.length > 8,
      (g2) => { markOnce(g2, P(g2, p), 'sigrun'); valMill(g2, p, 3); if (P(g2, p).avatars.includes(c)) c.bonus += 1; })],
  },
  'อาม่อน No.7': {
    keep: 4,
    onMilled: (g: Game, c: Card, p: PID) => { if (P(g, p).hell.includes(c) && canPlaceAvatar(P(g, p))) summon(g, p, c, 'effect'); },
    deathCry: (g: Game, c: Card, owner: PID) => { const pl = P(g, owner); const i = pl.hell.indexOf(c); if (i >= 0) { pl.hell.splice(i, 1); pl.deck.push(c); } },
  },
  'พีเจี้ยน 3000': {
    keep: 1.5,
    // the wearer gets POWER +1 and โล่มนุษย์ (v13: keyword grant from the attached card)
    grant: (g: Game, s: Card, t: Card, kw: string) => kw === 'shield' && s.wearer === t.uid,
    fieldActs: (g: Game, p: PID, c: Card) => [act('พีเจี้ยน: attach to a เครื่องบิน Super Air', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'pigeon:' + c.uid)
      && P(g2, p).avatars.some((a) => a !== c && pigeonPlane(a)),
    (g2) => {
      markOnce(g2, P(g2, p), 'pigeon:' + c.uid);
      const w = best(P(g2, p).avatars.filter((a) => a !== c && pigeonPlane(a)), (a) => value(g2, a));
      if (w) { for (const m of c.mods.splice(0)) { m.wearer = -1; P(g2, m.owner).hell.push(m); } resetCard(c); attach(g2, c, w); }
    })],
    modPower: () => 1,
  },
  'เสาซินแสมงคล': {
    keep: 6,
    handActs: (g: Game, p: PID, c: Card) => [act('เสาซินแสมงคล: send ซินแส + เสามงคล, summon', (g2) => inMain(g2, p) && P(g2, p).hand.includes(c)
      && onZone(g2, p, 'ซินแส').some((a) => onZone(g2, p, 'เสามงคล').some((b) => b !== a)),
    (g2) => {
      const a = worst(onZone(g2, p, 'ซินแส'), (x) => value(g2, x));
      const b = a && worst(onZone(g2, p, 'เสามงคล').filter((x) => x !== a), (x) => value(g2, x));
      if (!a || !b) return;
      toHell(g2, a); toHell(g2, b);
      summon(g2, p, c, 'jutsu');
    })],
    jutsu: (g: Game, c: Card) => {
      const p = c.ctrl;
      for (const x of pickN(hellAvatars(g, p, (y) => named(y, 'เสามงคล')), 3, (y) => value(g, y), { optional: true, title: 'เสาซินแสมงคล: up to 3 เสามงคล from Hell to the Magic Zone' })) toMz(g, p, x);
    },
    // approx: "can use abilities from the Magic Zone" is checked by เสามงคล ทรงญี่ปุ่น (coded here); other เสามงคล use their own code
    preventLeave: (g: Game, c: Card) => {
      const pl = P(g, c.ctrl);
      const xs = [...pl.avatars, ...pl.mz].filter((x) => x !== c && isA(x) && named(x, 'เสามงคล'));
      if (!xs.length || !mayDo(g, c, 'send another เสามงคล instead of leaving the field', true)) return false;
      const o = worst(xs, (x) => value(g, x));
      if (!o) return false;
      toHell(g, o); log(g, `${o.def.name} leaves instead of เสาซินแสมงคล`);
      return true;
    },
  },
  'เสามงคล ทรงญี่ปุ่น': {
    keep: 3,
    onSummon: (g: Game, c: Card) => lockAttack(g, c),
    startMain: (g: Game, c: Card) => lockAttack(g, c),
    staticPower: (g: Game, c: Card) => { lockAttack(g, c); return 0; },
    fieldActs: (g: Game, p: PID, c: Card) => [act('เสามงคล ทรงญี่ปุ่น: call a ผู้เจริญ from hand', (g2) => {
      const pl = P(g2, p);
      const where = pl.avatars.includes(c) || (pl.mz.includes(c) && pl.avatars.some((a) => a.def.name === 'เสาซินแสมงคล'));
      return inMain(g2, p) && where && once(g2, p, 'jpn:' + c.uid) && canPlaceAvatar(pl) && pl.hand.some((x) => isA(x) && named(x, 'ผู้เจริญ'));
    }, (g2) => {
      const pl = P(g2, p); markOnce(g2, pl, 'jpn:' + c.uid);
      const x = best(pl.hand.filter((y) => isA(y) && named(y, 'ผู้เจริญ')), (y) => y.def.power);
      if (x && summon(g2, p, x, 'effect') && pl.avatars.includes(x)) { boost(x, 1); x.f.endHell = g2.turn; }
    })],
  },
  'จ่านุ้ย ทหารช่าง': {
    keep: 3,
    jutsu: (g: Game, c: Card) => peek(g, c.ctrl, 5, (top) => { takeHand(g, c.ctrl, top, (x) => x.def.type === 'Construct'); }, 'bottom'),
  },
  'เสนาธิการ อาณาจักรของแพง': {
    keep: 3,
    jutsu: (g: Game, c: Card) => {
      const k = best(onZone(g, c.ctrl, 'พระเจ้านิโคไล'), (a) => a.def.cost);
      if (!k) return;
      const t = best(P(g, opp(c.ctrl)).avatars.filter((a) => a.def.cost < k.def.cost), (a) => value(g, a));
      if (t) destroy(g, t, c.ctrl);
    },
  },
  'สว นาโนแมชชีน': {
    keep: 7, noSteal: true, // can't change control: checked by the engine's canChangeCtrl / takeControl
    battle: (g: Game, c: Card, other: Card) => { c.f.fightAt = g.stats.attacks; c.f.foe = other.uid; },
    protectSelf: (g: Game, c: Card, by: PID | null, viaMagic: boolean) => {
      if (viaMagic) return true;
      if (g.phase === 'Battle' && c.f.fightAt === g.stats.attacks) { const o = findCard(g, c.f.foe); if (o && power(g, o) < 10) return true; }
      return false;
    },
  },
  'แมมมอธแช่แข็ง': {
    // v14 ruling: it can't wear any Modification (engine v14d canWear / attach: FX.refuseMod)
    keep: 2,
    refuseMod: (g: Game, self: Card, mod: Card) => mod.def.type === 'Magic' && mod.def.subtype === 'Modification',
    onSummon: (g: Game, c: Card) => lockAttack(g, c),
    startMain: (g: Game, c: Card) => lockAttack(g, c),
    staticPower: (g: Game, c: Card) => { lockAttack(g, c); return 0; },
  },
  'เรนะ นักล่าไดโนเสาร์': {
    keep: 3,
    onAttack: (g: Game, c: Card, t: Card | null) => { if (t && symIs(t, 'กะปอม')) destroy(g, t, c.ctrl); },
  },
  'แมวเก็นไมฉะ': {
    keep: 3.5,
    jutsu: (g: Game, c: Card) => {
      const p = c.ctrl, pl = P(g, p);
      const can1 = canPlaceAvatar(pl) && pl.hell.some((x) => x.def.name === 'แมวมัทฉะ');
      const can2 = pl.avatars.filter((a) => a !== c && (named(a, 'หมา') || named(a, 'แมว'))).length >= 2;
      const mode = can1 && can2 ? chooseMode(g, c, ['Summon แมวมัทฉะ from Hell', 'Search คาเฟ่หมาแมว from Deck'], 0) : can1 ? 0 : 1;
      if (mode === 0) { fromZoneSummon(g, p, pl.hell, (x) => x.def.name === 'แมวมัทฉะ'); return; }
      if (pl.avatars.filter((a) => a !== c && (named(a, 'หมา') || named(a, 'แมว'))).length >= 2) search(g, p, (x) => x.def.name === 'คาเฟ่หมาแมว', 'deck');
    },
  },

  // ===== BT06 Magic =====
  'งานวิจัยของพระพรหม': {
    keep: 3,
    canCast: (g: Game, p: PID) => P(g, p).avatars.some((a) => named(a, 'พระพรหม')) || (P(g, p).hand.length - 1 >= 3 && P(g, p).deck.length > 6),
    resolve: (g: Game, p: PID) => {
      const pl = P(g, p);
      const brahma = pl.avatars.some((a) => named(a, 'พระพรหม'));
      const n = pl.hand.length;
      for (const x of [...pl.hand]) discard(g, p, x);
      if (brahma) search(g, p, () => true, 'deck');
      else if (n >= 3) draw(g, p, 5);
    },
  },
  'คำสั่งของพระอิศวร': {
    keep: 3,
    // v14 ruling: option 2 works (Constructs have POWER: they can be attacked / fight). With our "พระอิศวร" Avatar: both.
    canCast: (g: Game, p: PID) => shivaAv(g, p).length > 0 || shivaCon(g, p).length > 0,
    resolve: (g: Game, p: PID, c: Card) => {
      const both = P(g, p).avatars.some((a) => nameHas(a, 'พระอิศวร'));
      const av = shivaAv(g, p), con = shivaCon(g, p);
      let mode = 0;
      if (!both) mode = chooseMode(g, c, ['1) Avatar ฝ่ายตรงข้าม POWER -2', '2) Construct ฝ่ายตรงข้าม POWER -2'], av.length ? 0 : 1);
      if (both || mode === 0) { const t = best(shivaAv(g, p), (a) => value(g, a) + (power(g, a) <= 2 ? 2 : 0)); if (t) t.bonus -= 2; }
      if (both || mode === 1) { const t = best(shivaCon(g, p), (a) => keepValue(g, a) + power(g, a)); if (t) { t.bonus -= 2; log(g, `${t.def.name} POWER -2`); } }
    },
  },
  'จิตมุ่งมั่นของพระนารายณ์': {
    keep: 2.5,
    canCast: (g: Game, p: PID) => P(g, p).avatars.length > 0,
    resolve: (g: Game, p: PID) => {
      const n = P(g, p).avatars.some((a) => named(a, 'พระนารายณ์')) ? 3 : 1;
      for (const a of pickN(P(g, p).avatars, n, (x) => (x.asleep ? 0 : 10) + power(g, x), { optional: n > 1, title: `จิตมุ่งมั่นของพระนารายณ์: POWER +1${n > 1 ? ' (up to 3)' : ''}` })) boost(a, 1);
    },
  },
  'เฮือกสุดท้าย': {
    keep: 4,
    canCast: (g: Game, p: PID) => critical(P(g, p)) && once(g, p, 'heuak') && P(g, p).deck.length > 4,
    resolve: (g: Game, p: PID) => { const pl = P(g, p); markOnce(g, pl, 'heuak'); draw(g, p, 4); pl.used.Normal = false; },
  },
  'แผนลับของเหล่าพลเอก': {
    keep: 6,
    canCast: (g: Game, p: PID) => distinctNames(onZone(g, p, 'พลเอก')) >= 3,
    resolve: (g: Game, p: PID) => {
      const pl = P(g, p), o = opp(p), op = P(g, o);
      const picked: Card[] = [];
      while (picked.length < 3) {
        const a = worst(onZone(g, p, 'พลเอก').filter((x) => !picked.some((y) => y.def.name === x.def.name)), (x) => value(g, x));
        if (!a) break; picked.push(a);
      }
      if (picked.length < 3) return;
      for (const a of picked) toHell(g, a);
      for (const a of [...op.avatars]) removeOpp(g, p, a, 'hell', true);
      for (const x of [...op.mz]) sendHell(g, x);
      if (g.land && g.land.owner === o) { op.hell.push(g.land); g.land = null; }
      for (const x of [...op.hand]) discard(g, o, x);
      const names = new Set<string>();
      for (let i = 0; i < 3; i++) {
        const s = fromZoneSummon(g, p, pl.deck, (x) => (named(x, 'ทหาร') || named(x, 'รด.')) && !names.has(x.def.name));
        if (!s) break; names.add(s.def.name);
      }
      shuffle(g, pl.deck);
    },
  },
  'ธาตุไฟแตก ๆ': {
    // v14 ruling: no timing is printed: usable as a React when the opponent attacks or summons an Avatar, or in our Main
    // Phase; condition: we have 2+ Avatars on our Avatar Zone before using it
    keep: 3, mainUse: true,
    canCast: (g: Game, p: PID) => P(g, p).avatars.length >= 2 && P(g, opp(p)).avatars.length >= 1,
    resolve: (g: Game, p: PID) => fireDice(g, p),
    react: {
      on: ['attack', 'summon'],
      can: (g: Game, p: PID, c: Card, ev: Ev) => ev.actor !== p && P(g, p).avatars.length >= 2 && P(g, opp(p)).avatars.length >= 1,
      want: (g: Game, p: PID) => P(g, opp(p)).avatars.length >= 2 && P(g, p).avatars.some((a) => value(g, a) < 4),
      resolve: (g: Game, p: PID) => fireDice(g, p),
    },
  },
  'เสียงเรียกแห่งวัลฮัลลา': {
    keep: 5,
    react: {
      on: ['attack'],
      can: (g: Game, p: PID, c: Card, ev: Ev) => ev.actor !== p && critical(P(g, p)) && P(g, p).deck.length >= 5,
      want: () => true,
      resolve: (g: Game, p: PID, c: Card, ev: Ev) => {
        mill(g, p, 5);
        ev.cancelled = true;
        for (let i = 0; i < 4 && canPlaceAvatar(P(g, p)); i++) {
          const x = pickN(P(g, p).hell.filter((y) => isA(y) && valk(y)), 1, (y) => value(g, y), { optional: true, title: `เสียงเรียกแห่งวัลฮัลลา: summon from Hell (up to 4, ${i} so far)` })[0];
          if (!x || !summon(g, p, x, 'effect')) break;
        }
      },
    },
    onMilled: (g: Game, c: Card, p: PID, v: boolean, info?: any) => { if (valMillOk(g, info) && P(g, p).hell.includes(c)) { detach(g, c); P(g, p).hand.push(c); } },
  },
  'ลูกแก้วนาคา': {
    keep: 2.5,
    canCast: (g: Game, p: PID) => wearers(g, p, naga).length > 0,
    modTarget: (g: Game, p: PID) => best(wearers(g, p, naga), (a) => value(g, a) + (a.asleep ? 0 : 2)),
    modPower: () => 2,
  },
  'ไสยเวท ย้อนกลับ': {
    keep: 3,
    canCast: (g: Game, p: PID) => wearers(g, p, () => true).length > 0,
    modTarget: (g: Game, p: PID) => best(wearers(g, p, () => true), (a) => power(g, a) + (a.asleep ? 0 : 3)),
    onWearerAttack: (g: Game, m: Card, w: Card) => {
      if (m.f.t !== g.turn) { m.f.t = g.turn; m.f.n = 0; }
      if (m.f.n >= 4 || P(g, w.ctrl).deck.length < 2) return;
      m.f.n++;
      const out = valMill(g, w.ctrl, 2);
      if (out.some((x) => x.def.type === 'Magic')) w.asleep = false;
    },
  },
  'เท่ระเบิด !!!!': {
    keep: 2.5,
    canCast: (g: Game, p: PID) => wearers(g, p, (a) => named(a, 'ทหาร') || named(a, 'รด.')).length > 0,
    modTarget: (g: Game, p: PID) => best(wearers(g, p, (a) => named(a, 'ทหาร') || named(a, 'รด.')), (a) => -value(g, a) + (a.asleep ? 0 : 3)),
    // v14 ruling: the wearer is destroyed right after that fight (afterFight)
    onWearerAttack: (g: Game, m: Card, w: Card) => { w.temp.push({ power: 5, until: 'battle' }); m.f.boom = g.stats.attacks; },
    afterFight: (g: Game, m: Card, att: Card) => {
      if (m.f.boom !== g.stats.attacks || att.uid !== m.wearer || !att.mods.includes(m)) return;
      delete m.f.boom; log(g, `เท่ระเบิด: ${att.def.name} is destroyed after the fight`); destroy(g, att, m.ctrl);
    },
  },
  'กองถ่ายฤาษี': {
    keep: 2.5,
    canCast: (g: Game, p: PID) => wearers(g, p, (a) => symIs(a, 'ฤษี')).length > 0,
    modTarget: (g: Game, p: PID) => best(wearers(g, p, (a) => symIs(a, 'ฤษี')), (a) => value(g, a)),
    wearerBattle: (g: Game, m: Card, w: Card, other: Card) => { other.temp.push({ power: -1, until: 'battle' }); },
  },
  'นรกในกรง': {
    keep: 2,
    // v14 ruling: every Avatar Zone has only 3 slots while it is in play (zoneCap: summons past 3 are refused); on cast each
    // player with more than 3 sends Avatars to Hell (their choice) down to 3 (FX.onEnterPlay, plus checks at phase changes)
    canCast: (g: Game, p: PID) => (!g.land || g.land.owner !== p) && P(g, opp(p)).avatars.length > 3,
    zoneCap: () => 3,
    onEnterPlay: (g: Game, c: Card) => cageTrim(g, c),
    startBattle: (g: Game, c: Card) => cageTrim(g, c),
    eachEndPhase: (g: Game, c: Card) => cageTrim(g, c),
    endPhase: (g: Game, c: Card) => cageTrim(g, c),
  },
  'คาเฟ่หมาแมว': {
    keep: 2.5,
    canCast: (g: Game, p: PID) => (!g.land || g.land.owner !== p) && P(g, p).avatars.some(dogcat),
    endPhase: (g: Game, l: Card) => {
      const p = l.owner, pl = P(g, p);
      if (g.active !== p || !once(g, p, 'cafe')) return;
      const back = worst(pl.avatars.filter(dogcat), (a) => value(g, a));
      if (!back || !pl.deck.some((x) => dogcat(x) && x.def.name !== back.def.name)) return;
      markOnce(g, pl, 'cafe');
      const nm = back.def.name;
      toDeck(g, back, false);
      fromZoneSummon(g, p, pl.deck, (x) => dogcat(x) && x.def.name !== nm);
      shuffle(g, pl.deck);
      const t = best(pl.avatars.filter(dogcat), (a) => power(g, a)); if (t) t.bonus += 1;
    },
  },
  [BANK_LAND]: {
    // v14: every "แบงค์" Avatar in a hand has Cost -1 (costMod: paying and the detail box); their GEM is colourless
    // (engine gemColorOf / bankColorless; v14 answer: both players' hands, like the Cost -1)
    keep: 2,
    canCast: (g: Game, p: PID) => (!g.land || g.land.owner !== p) && P(g, p).hand.some((x) => isA(x) && named(x, 'แบงค์')),
    costMod: (g: Game, self: Card, t: Card) => (isLandOn(g, self) && isA(t) && nameHas(t, 'แบงค์') && g.p.some((q) => q.hand.includes(t)) ? -1 : 0),
  },
  'ถ้ำนาคา': {
    keep: 2,
    canCast: (g: Game, p: PID) => (!g.land || g.land.owner !== p) && P(g, p).avatars.some(naga),
    landPower: (g: Game, l: Card, a: Card) => (naga(a) ? 1 : 0),
  },
  'ประตูวัลฮัลลา': {
    keep: 2.5,
    canCast: (g: Game, p: PID) => !g.land || g.land.owner !== p,
    fieldActs: (g: Game, p: PID, c: Card) => [act('ประตูวัลฮัลลา: mill 2, goddess back to hand', (g2) => inMain(g2, p) && isLandOn(g2, c) && once(g2, p, 'valgate')
      && P(g2, p).deck.length > 6 && hellAvatars(g2, p, valk).length > 0,
    (g2) => { markOnce(g2, P(g2, p), 'valgate'); valMill(g2, p, 2); search(g2, p, valk, 'hell'); })],
  },

  // ===== BT06 Construct =====
  'เวทีเพื่อชีวิต': { keep: 2.5, aura: (g: Game, s: Card, t: Card) => (t.ctrl === s.ctrl && g.phase === 'Battle' && g.active === s.ctrl && P(g, s.ctrl).mz.includes(s) ? 1 : 0) },
  'รูปปั้นพระอิศวร': {
    keep: 2.5,
    // v14 ruling: at the start of our Draw Phase, before the draw (asked): scout 2, a Symbol เทพ card to hand, the rest
    // under the Deck, and the normal draw is skipped (engine v14d drawInstead for cards in play)
    drawInstead: (g: Game, s: Card) => {
      const p = s.ctrl, pl = P(g, p);
      if (!pl.mz.includes(s) || pl.deck.length < 2) return false;
      const gods = pl.deck.filter((x) => symIs(x, 'เทพ')).length / pl.deck.length;
      if (!mayDo(g, s, 'scout 2 and take a เทพ card instead of the normal draw', gods >= 0.3)) return false;
      peek(g, p, 2, (top) => { takeHand(g, p, top, (x) => symIs(x, 'เทพ')); }, 'bottom');
      return true;
    },
  },
  'ยานสำรวจ R18': {
    keep: 2.5,
    fieldActs: (g: Game, p: PID, c: Card) => [act('ยานสำรวจ R18: take a servant from their hell', (g2) => inMain(g2, p) && P(g2, p).mz.includes(c) && once(g2, p, 'r18ship')
      && onZone(g2, p, 'มนุษย์ดาว R18').some((a) => !isServant(a)) && hellAvatars(g2, opp(p), (x) => x.def.cost >= 5).length > 0,
    (g2) => {
      markOnce(g2, P(g2, p), 'r18ship');
      const t = best(hellAvatars(g2, opp(p), (x) => x.def.cost >= 5), (x) => x.def.cost);
      if (t) makeServant(g2, p, t);
    })],
  },
  'กองไฟลูกเสือ': {
    keep: 2.5,
    grant: (g: Game, s: Card, t: Card, kw: string) => kw === 'unite' && t.ctrl === s.ctrl && t.def.cost <= 2 && P(g, s.ctrl).mz.includes(s) && P(g, s.ctrl).avatars.includes(t),
  },
  'หุบเขา 3 พลเอก': {
    keep: 2.5,
    // v14 ruling (confirmed): ใบดำใบแดง is cast from hand with the changed text through this Construct (no Normal limit)
    fieldActs: (g: Game, p: PID, c: Card) => [act('หุบเขา 3 พลเอก: ใบดำใบแดง (scout 3, call green คน)', (g2) => inMain(g2, p) && P(g2, p).mz.includes(c)
      && P(g2, p).hand.some((x) => x.def.name === 'ใบดำใบแดง') && P(g2, p).deck.length > 3 && canPlaceAvatar(P(g2, p)),
    (g2) => {
      const pl = P(g2, p);
      const m = pl.hand.find((x) => x.def.name === 'ใบดำใบแดง'); if (!m) return;
      detach(g2, m);
      peek(g2, p, 3, (top) => { takeSummon(g2, p, top, (x) => symIs(x, 'คน') && x.def.cost <= 4 && colorIs(x, 'เขียว')); }, 'bottom');
      pl.hell.push(m);
    })],
  },
  'ตู้วารีบำบัด': {
    keep: 2,
    drawPhase: (g: Game, s: Card) => {
      const pl = P(g, s.ctrl);
      if (flippedLife(pl) < 2 || !pl.mz.includes(s)) return;
      detach(g, s); P(g, s.owner).hell.push(s);
      const l = pl.life.filter((x) => x.faceUp).pop(); if (l) lifeDown(g, pl.id, l);
      log(g, 'ตู้วารีบำบัด: LIFE turned face down');
    },
  },

  // ===== ODY1 =====
  'ทาโกะซัง สูตรสวรรค์': { keep: 3.5, jutsu: tutorTako('ทาโกะซัง สูตรมนุษย์'), onSummon: (g: Game, c: Card) => refreshOden(g, c.ctrl) },
  'ทาโกะซัง สูตรมนุษย์': { keep: 3, jutsu: tutorTako('ทาโกะซัง สูตรนรก'), onSummon: (g: Game, c: Card) => refreshOden(g, c.ctrl) },
  'ทาโกะซัง สูตรนรก': { keep: 3, jutsu: tutorTako('ทาโกะซัง สูตรสวรรค์'), onSummon: (g: Game, c: Card) => refreshOden(g, c.ctrl) },
  'ทาโกะจัง พนักงานดีเด่น': {
    keep: 2.5,
    onSummon: (g: Game, c: Card) => refreshOden(g, c.ctrl),
    jutsu: (g: Game, c: Card) => {
      const pl = P(g, c.ctrl);
      const back: Card[] = [];
      for (const x of hellAvatars(g, c.ctrl, (y) => named(y, 'ทาโกะซัง'))) if (back.length < 3 && !back.some((b) => b.def.name === x.def.name)) back.push(x);
      if (back.length < 3) return;
      for (const x of back) { detach(g, x); pl.deck.push(x); }
      shuffle(g, pl.deck);
      draw(g, c.ctrl, 1);
    },
  },
  'โอเดนย่ากาย': {
    keep: 3,
    onSummon: (g: Game, c: Card) => refreshOden(g, c.ctrl),
    startMain: (g: Game, c: Card) => refreshOden(g, c.ctrl),
    staticPower: (g: Game, c: Card) => { if (P(g, c.ctrl).avatars.includes(c)) c.f.noAttack = P(g, c.ctrl).avatars.some(tako) ? 0 : g.turn; return 0; },
  },
  'ทศกัณฑ์ยักษ์ที่---เมียพระอิศวร': {
    keep: 8,
    jutsu: (g: Game, c: Card) => { const t = pickN(P(g, opp(c.ctrl)).avatars.filter((a) => !noSteal(a)), 1, (a) => value(g, a), { optional: true, title: `${c.def.name}: you may take control of 1 opposing Avatar` })[0]; if (t && (humanDeciding(g) || value(g, t) > 2)) steal(g, c.ctrl, t, true); }, // bugs7 item 7: "สามารถ" = optional
  },
  'เอาแค่การ์ด !!!': {
    keep: 4,
    canCast: (g: Game, p: PID, c: Card) => P(g, p).hand.some((x) => x !== c && (named(x, 'โอเดนย่า') || named(x, 'ทาโกะ'))) && P(g, opp(p)).avatars.some((a) => magicOk(g, p, a)),
    resolve: (g: Game, p: PID) => {
      const d = worst(P(g, p).hand.filter((x) => named(x, 'โอเดนย่า') || named(x, 'ทาโกะ')), (x) => keepValue(g, x));
      if (!d) return;
      discard(g, p, d);
      const t = best(P(g, opp(p)).avatars.filter((a) => magicOk(g, p, a)), (a) => value(g, a));
      if (t) removeOpp(g, p, t, 'hand', true);
    },
  },
  'โอเดนย่า อร่อยมัก': {
    keep: 2.5,
    // v14 ruling: a React Magic: when our "ทาโกะ" Avatar becomes an attack target, it gets POWER +2 until end of turn
    canCast: () => false,
    react: {
      on: ['attack'],
      can: (g: Game, p: PID, c: Card, ev: Ev) => ev.actor !== p && !!ev.target && ev.target.ctrl === p && tako(ev.target),
      want: (g: Game, p: PID, c: Card, ev: Ev) => { const pa = power(g, ev.source!), pt = power(g, ev.target!); return pt <= pa && pt + 2 > pa; },
      resolve: (g: Game, p: PID, c: Card, ev: Ev) => { if (ev.target && P(g, p).avatars.includes(ev.target)) boost(ev.target, 2); },
    },
  },
  'ถุงเกราะโอเดนย่า': {
    // v14 ruling: printed as Normal Magic: it is put on (worn by) our Avatar; "สั่งใช้ destroy this card": the Avatar that
    // wore it gets POWER +2 until the end of the opponent's next turn
    keep: 2.5,
    canCast: (g: Game, p: PID, c: Card) => P(g, p).avatars.some((a) => canWearE(g, c, a)),
    resolve: (g: Game, p: PID, c: Card) => {
      const t = best(P(g, p).avatars.filter((a) => canWearE(g, c, a)), (a) => value(g, a) + (a.asleep ? 0 : 1));
      if (t) attach(g, c, t);
    },
    fieldActs: (g: Game, p: PID, c: Card) => [act('ถุงเกราะโอเดนย่า: destroy it, the wearer POWER +2 until the end of the opponent\'s next turn',
      (g2) => (g2.phase === 'Main' || g2.phase === 'Battle') && g2.active === p && c.wearer >= 0 && P(g2, p).avatars.some((a) => a.mods.includes(c)),
      (g2) => {
        const w = findCard(g2, c.wearer); if (!w) return;
        if (!toHell(g2, c, { cost: true })) return;
        if (P(g2, w.ctrl).avatars.includes(w)) { w.temp.push({ power: 2, until: g2.turn + 1 } as any); log(g2, `${w.def.name} POWER +2 until the end of the next turn`); }
      })],
  },
  'ดาว O.D.Y 88': {
    keep: 2,
    canCast: (g: Game, p: PID) => P(g, p).avatars.some(tako),
    resolve: (g: Game) => { for (const q of g.p) for (const a of q.avatars) if (tako(a)) a.bonus += 1; },
  },
  'หอกแหลมแทงทุกวัน ทุกวัน': {
    keep: 2,
    canCast: (g: Game, p: PID) => wearers(g, p, () => true).length > 0,
    modTarget: (g: Game, p: PID) => best(wearers(g, p, () => true), (a) => (symIs(a, 'นรก') ? 5 : 0) + value(g, a)),
    modPower: (g: Game, m: Card, w: Card) => (symIs(w, 'นรก') ? 1 : 0),
    onMilled: (g: Game, c: Card) => { c.f.milled = 1; },
    hellActs: (g: Game, p: PID, c: Card) => [act('หอกแหลม: cast from hell', (g2) => inMain(g2, p) && P(g2, p).hell.includes(c) && !!c.f.milled
      && !P(g2, p).used.Modification && wearers(g2, p, (a) => symIs(a, 'นรก')).length > 0,
    (g2) => {
      P(g2, p).used.Modification = true; c.f.milled = 0;
      const w = best(wearers(g2, p, (a) => symIs(a, 'นรก')), (a) => value(g2, a));
      if (w) attach(g2, c, w);
    })],
  },

  // ===== PRE0 =====
  'ผู้เล่นยุคแรก': {
    keep: 3,
    jutsu: (g: Game, c: Card) => {
      const d = P(g, opp(c.ctrl)).deck;
      const x = worst(d.slice(-3), (y) => keepValue(g, y)); // the card the opponent least wants to draw
      if (!x) return;
      d.splice(d.indexOf(x), 1); d.unshift(x);
    },
  },
  'น้ำใจ': {
    keep: 1,
    canCast: (g: Game, p: PID) => wearers(g, p, () => true).length > 0,
    modTarget: (g: Game, p: PID) => best(wearers(g, p, () => true), (a) => (a.def.name === 'ยอดนักบุญ' ? 10 : 0) + value(g, a)),
    modPower: () => 0,
  },
  'ผู้เล่นภักดี': {
    keep: 3,
    jutsu: (g: Game, c: Card) => {
      const o = P(g, opp(c.ctrl));
      if (!o.hand.length) return;
      const x = o.hand[Math.floor(rand(g) * o.hand.length)];
      detach(g, x); o.deck.unshift(x);
    },
  },
  'ผู้เล่นเหลี่ยม': { keep: 3.5 }, // v14 ruling (confirmed): looking at the opponent's hand has no rules effect
  'ผู้เล่นจำไม': {
    keep: 4, noHandSummon: true,
    // v14 ruling: จุติ shows a popup with the opponent's remaining Deck: how many Avatars, how many Magic, and its Only #1
    jutsu: (g: Game, c: Card) => {
      const d = P(g, opp(c.ctrl)).deck;
      const av = d.filter((x) => isA(x)).length, mg = d.filter((x) => x.def.type === 'Magic').length;
      const only = d.filter((x) => x.def.only).map((x) => x.def.name);
      const s = `ผู้เล่นจำไม: Deck ฝ่ายตรงข้ามเหลือ ${d.length} ใบ · Avatar ${av} ใบ · Magic ${mg} ใบ · Only #1: ${only.length ? only.join(', ') : 'ไม่มีใน Deck'}`;
      log(g, s);
      if (humanDeciding(g)) askChoose(g, s, ['OK', 'ปิด'], 0);
    },
    handActs: (g: Game, p: PID, c: Card) => [act('ผู้เล่นจำไม: discard 5 GEM-1 cards to summon', (g2) => inMain(g2, p) && P(g2, p).hand.includes(c) && canPlaceAvatar(P(g2, p))
      && P(g2, p).hand.filter((x) => x !== c && x.def.gem === 1).length >= 5,
    (g2) => {
      const pay = worstN(P(g2, p).hand.filter((x) => x !== c && x.def.gem === 1), 5, (x) => keepValue(g2, x), { title: 'ผู้เล่นจำไม: discard 5 GEM-1 cards' });
      if (pay.length < 5) return;
      summon(g2, p, c, 'paid', pay);
    })],
  },
  'ผู้เล่นมั่ว': { keep: 2.5, staticPower: (g: Game, c: Card) => (distinctNames(hellAvatars(g, c.ctrl)) >= 10 ? 2 : 0) },
  'ผู้เล่นโซเชียล': {
    keep: 4,
    jutsu: (g: Game, c: Card) => {
      const p = c.ctrl;
      const t = best(P(g, opp(p)).avatars.filter((a) => power(g, a) < power(g, c)), (a) => value(g, a));
      if (!t) return;
      const f = FX[t.def.name];
      if (f && f.preventLeave && t.silencedTurn !== g.turn && f.preventLeave(g, t)) return;
      log(g, `${t.def.name} moved to P${p}'s Magic Zone`);
      // renamed so its own abilities don't run from our Magic Zone
      toMz(g, p, t, { name: t.def.name + ' (Magic Zone)', symbol: t.def.symbol });
    },
  },

  // ===== PRMO =====
  'บึงทมิฬ  People - คุณดีไมส์': {
    keep: 4,
    onKill: (g: Game, c: Card) => {
      const p = c.ctrl;
      if (g.active !== p || !lands(g).some((l) => l.def.name.includes('บึงทมิฬ')) || !P(g, p).hand.length) return;
      if (mayDo(g, c, 'discard 1 card to wake it up', c.asleep) && discardWorst(g, p, 1)) c.asleep = false; // bugs7 item 7: "สามารถ" = optional
    },
  },
  'นางลักษมี': {
    keep: 1.5,
    costOnlyFor: (s: Card) => isA(s) && symIs(s, 'เทพ'),
    usedAsCost: (g: Game, p: PID, c: Card, s: Card) => { if (named(s, 'พระนารายณ์') && P(g, p).avatars.includes(s)) boost(s, 3); },
  },
  'แมลงปอแจ๊ค': {
    keep: 3,
    jutsu: (g: Game, c: Card) => {
      const p = c.ctrl, pl = P(g, p);
      const l = best(pl.deck.filter((x) => x.def.type === 'Magic' && x.def.subtype === 'Land'), (x) => keepValue(g, x));
      if (g.land && (g.land.owner !== p || l)) { P(g, g.land.owner).hell.push(g.land); g.land = null; }
      if (l) { placeLand(g, p, l); log(g, `land ${l.def.name} from Deck`); }
      shuffle(g, pl.deck);
    },
  },
  'หุ่นนักรบผู้กล้า ไมเกรน': {
    keep: 4,
    onAttack: theEndAttack,
    jutsu: (g: Game, c: Card) => peek(g, c.ctrl, 5, (top) => {
      takeHand(g, c.ctrl, top, weapon);
      // THE END returns to hand when looked at by a ไมเกรน
      for (const x of top.filter((y) => y.def.name === 'สุดยอดท่าไม้ตายผู้กล้า THE END')) { top.splice(top.indexOf(x), 1); P(g, c.ctrl).hand.push(x); }
    }, 'bottom'),
    onOwnMagic: (g: Game, s: Card, m: Card) => { if (weapon(m) && once(g, s.ctrl, 'migdraw')) { markOnce(g, P(g, s.ctrl), 'migdraw'); draw(g, s.ctrl, 1); } },
  },

  // ===== KD00 =====
  'อะไรวะ !': {
    keep: 2.5,
    react: {
      on: ['destroy'],
      can: (g: Game, p: PID, c: Card, ev: Ev) => !!ev.source && ev.source.ctrl === p && isA(ev.source),
      want: (g: Game, p: PID) => P(g, p).hand.length - 1 <= 1 && P(g, opp(p)).hand.length >= 4,
      resolve: (g: Game) => {
        for (const q of g.p) { for (const x of [...q.hand]) { detach(g, x); q.deck.push(x); } shuffle(g, q.deck); }
        for (const q of g.p) draw(g, q.id, 4);
        const n = g.p.map((q) => q.hand.filter(isA).length);
        if (n[0] !== n[1]) { const lo = (n[0] < n[1] ? 0 : 1) as PID; hitLife(g, lo, null); hitLife(g, lo, null); }
      },
    },
  },
  'เบียดเบียนผู้อื่น': {
    keep: 2,
    // approx: two-player version; the taken cards never leave their owners' hands
    canCast: (g: Game, p: PID) => P(g, p).hand.length >= 2 && P(g, opp(p)).hand.length > 0,
    resolve: (g: Game, p: PID) => {
      const o = opp(p);
      const pick = (q: PID) => { const h = P(g, q).hand; return h.length ? h[Math.floor(rand(g) * h.length)] : null; };
      const a = pick(o), b = pick(p); // p shows a (taken from o), o shows b (taken from p)
      const costed = (x: Card | null) => !!x && x.def.type !== 'Magic';
      const shown = [a, b].filter((x): x is Card => !!x);
      if (!costed(a)) discardWorst(g, p, 2, shown);
      if (!costed(b)) decide(g, o, () => discardWorst(g, o, 2, shown));
      if (!a || !b || !costed(a) || !costed(b)) return;
      if (a.def.cost === b.def.cost) { discard(g, a.owner, a); discard(g, b.owner, b); return; }
      const lo: PID = a.def.cost < b.def.cost ? p : o, hi = opp(lo);
      const e = decide(g, lo, () => worst(P(g, lo).hand.filter((x) => !shown.includes(x)), (x) => keepValue(g, x))); if (e) toExile(g, e);
      const r = decide(g, hi, () => best(P(g, hi).exile, (x) => keepValue(g, x))); if (r) { detach(g, r); P(g, hi).deck.push(r); }
    },
  },
  'โอน้อยออกแห่งโชคชะตา': {
    keep: 1.5,
    resolve: (g: Game, p: PID) => { const loser: PID = rand(g) < 0.5 ? p : opp(p); log(g, `P${loser} loses rock-paper-scissors`); hitLife(g, loser, null); },
  },
  'ขอมือเธอหน่อย~': {
    keep: 2.5,
    canCast: (g: Game, p: PID) => P(g, p).deck.length > 6,
    resolve: (g: Game) => {
      const max = Math.max(g.p[0].hand.length, g.p[1].hand.length);
      for (const q of g.p) if (q.hand.length === max) decide(g, q.id, () => discardWorst(g, q.id, 2));
      const tgt = Math.max(g.p[0].hand.length, g.p[1].hand.length);
      for (const q of g.p) if (q.hand.length < tgt) draw(g, q.id, tgt - q.hand.length);
    },
  },

  // ===== KD01 พระนารายณ์ =====
  // approx: the "after a พระนารายณ์ won a fight" timing is seen through the fight response window, which the bot
  // only reaches when no other response card in hand was chosen first
  'พระนารายณ์ เทพผดุงธรรม': {
    keep: 6,
    react: narayWatch(),
    handActs: narayAct('พระนารายณ์ เทพผดุงธรรม', (g, p) => {
      let sum = 0;
      peek(g, p, 2, (top) => { for (const x of [...top]) { sum += x.def.type === 'Magic' ? 0 : x.def.cost; top.splice(top.indexOf(x), 1); P(g, p).hand.push(x); } });
      const t = best(P(g, opp(p)).avatars.filter((a) => a.def.cost <= sum), (a) => value(g, a));
      if (!t) return;
      const f = FX[t.def.name];
      if (!(f && f.preventLeave && t.silencedTurn !== g.turn && f.preventLeave(g, t))) toExile(g, t);
    }),
  },
  'ร่างอวตารพระนารายณ์ - นรสิง': {
    keep: 4,
    react: narayWatch(),
    handActs: narayAct('ร่างอวตารพระนารายณ์ - นรสิง', (g, p, c) => {
      const t = best(P(g, opp(p)).avatars.filter((a) => a.def.cost <= 4), (a) => value(g, a));
      if (t) destroy(g, t, p);
      if (P(g, p).avatars.includes(c)) c.f.narayEnd = g.turn;
    }),
    endPhase: narayEnd,
  },
  'ร่างอวตารพระนารายณ์ - เกษียรสมุทร': {
    keep: 3.5,
    react: narayWatch(),
    handActs: narayAct('ร่างอวตารพระนารายณ์ - เกษียรสมุทร', (g, p, c) => {
      const t = best(P(g, p).avatars.filter((a) => a.asleep && symIs(a, 'เทพ')), (a) => power(g, a));
      if (t) t.asleep = false;
      if (P(g, p).avatars.includes(c)) c.f.narayEnd = g.turn;
    }),
    endPhase: narayEnd,
  },

  // ===== KD04 ไมเกรน =====
  'ราชันย์หุ่นนักรบผู้กล้า : คริติคอล ไมเกรน': {
    keep: 5, noSteal: true, // can't change control: checked by the engine's canChangeCtrl / takeControl
    onAttack: theEndAttack,
    fieldActs: (g: Game, p: PID, c: Card) => {
      const can = (g2: Game) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'critmig') && distinctNames(hellAvatars(g2, p, migraine)) >= 3;
      const pay = (g2: Game) => {
        markOnce(g2, P(g2, p), 'critmig');
        const seen = new Set<string>();
        while (seen.size < 3) {
          const x = worst(hellAvatars(g2, p, migraine).filter((y) => !seen.has(y.def.name)), (y) => keepValue(g2, y));
          if (!x) break; seen.add(x.def.name); toExile(g2, x);
        }
      };
      return [
        act('คริติคอล ไมเกรน: exile 3 ไมเกรน, equip 2 weapons from hell', (g2) => can(g2) && P(g2, p).hell.some(weapon), (g2) => {
          pay(g2);
          for (const w of pickN(P(g2, p).hell.filter(weapon), 2, (x) => keepValue(g2, x), { optional: true, title: 'คริติคอล ไมเกรน: equip up to 2 weapons from Hell' })) if (P(g2, p).avatars.includes(c)) attach(g2, w, c);
        }),
        act('คริติคอล ไมเกรน: exile 3 ไมเกรน, LIFE damage on kills', can, (g2) => { pay(g2); c.f.crit = g2.turn; }),
      ];
    },
    onKill: (g: Game, c: Card) => { if (c.f.crit === g.turn) hitLife(g, opp(c.ctrl), null); },
  },
  'ด็อกเตอร์ เพน': {
    keep: 3.5,
    jutsu: (g: Game, c: Card) => peek(g, c.ctrl, 5, (top) => { takeHand(g, c.ctrl, top, migraine); }, 'shuffle'),
    fieldActs: (g: Game, p: PID, c: Card) => [act('ด็อกเตอร์ เพน: discard 1, weapon from hell', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'pain')
      && P(g2, p).hand.length >= 1 && P(g2, p).hell.some(weapon),
    (g2) => { markOnce(g2, P(g2, p), 'pain'); if (discardWorst(g2, p, 1)) search(g2, p, weapon, 'hell'); })],
  },
  'สุดยอดท่าไม้ตายผู้กล้า THE END': {
    keep: 4,
    // v14 ruling: works for every Avatar named "ไมเกรน" (ติดชื่อ). The card stays in our Magic Zone until the End Phase and
    // carries the granted ability: when that ไมเกรน attacks an Avatar, after its fight it also fights every other opposing
    // Avatar at once (approx: the main fight resolves first). Milled or scouted (FX.onScouted) by a
    // ไมเกรน Avatar's ability: back to hand.
    stayMz: true,
    canCast: (g: Game, p: PID) => g.turn > 1 && P(g, p).avatars.some((a) => migraine(a) && !a.asleep) && P(g, opp(p)).avatars.length >= 2,
    resolve: (g: Game, p: PID, c: Card) => {
      const t = best(P(g, p).avatars.filter((a) => migraine(a) && !a.asleep), (a) => power(g, a));
      if (t) { t.f.theEnd = g.turn; c.f.theEndOn = t.uid; c.f.theEndT = g.turn; grantGet(g, t, 'THE END: ต่อสู้กับ Avatar ฝ่ายตรงข้ามทุกใบพร้อมกัน (จนจบเทิร์น)', g.turn); }
    },
    afterFight: (g: Game, c: Card, att: Card, target: Card | null) => {
      if (c.f.theEndT !== g.turn || att.uid !== c.f.theEndOn || att.f.theEnd !== g.turn || !target) return;
      theEndAll(g, att, target);
    },
    endPhase: (g: Game, c: Card) => { const pl = P(g, c.ctrl); if (pl.mz.includes(c)) { detach(g, c); c.f = {}; P(g, c.owner).hell.push(c); } },
    onMilled: (g: Game, c: Card, p: PID, v: boolean, info?: any) => {
      if (info && info.src && isA(info.src) && migraine(info.src) && P(g, p).hell.includes(c)) { detach(g, c); P(g, p).hand.push(c); log(g, 'THE END returns to hand (milled by a ไมเกรน)'); }
    },
    onScouted: (g: Game, c: Card, owner: PID, by: PID | null, src: Card | null) => {
      if (src && isA(src) && migraine(src) && !findCard(g, c.uid)) { P(g, owner).hand.push(c); log(g, 'THE END goes to hand (scouted by a ไมเกรน)'); }
    },
    hellActs: (g: Game, p: PID, c: Card) => [act('THE END: exile from hell, equip weapons', (g2) => inMain(g2, p) && P(g2, p).hell.includes(c) && P(g2, p).hell.some(weapon) && onZone(g2, p, 'ไมเกรน').length > 0,
      (g2) => {
        const pl = P(g2, p);
        toExile(g2, c);
        const w = best(onZone(g2, p, 'ไมเกรน'), (a) => value(g2, a)); if (!w) return;
        const seen = new Set<string>();
        for (const m of pl.hell.filter(weapon)) if (!seen.has(m.def.name)) { seen.add(m.def.name); attach(g2, m, w); }
      })],
  },
  'อาวุธนักรบผู้กล้า " ไบโพล่า ชิลด์ "': {
    keep: 2.5,
    // v14 ruling: เครื่องจักร = หุ่นยนต์ too. Any way of leaving caused by an opponent's card (destroy, hand, hell, exile,
    // deck; not control changes) -> roll; several attached copies roll together; once a copy rolled it can't be used again.
    canCast: (g: Game, p: PID) => wearers(g, p, (a) => named(a, 'ผู้กล้า') && symAny(a, ['เครื่องจักร', 'หุ่นยนต์'])).length > 0,
    modTarget: (g: Game, p: PID) => best(wearers(g, p, (a) => named(a, 'ผู้กล้า') && symAny(a, ['เครื่องจักร', 'หุ่นยนต์'])), (a) => value(g, a)),
    leaveGuard: (g: Game, self: Card, t: Card, info: any) => bipolaGuard(g, self, t, info),
  },
});

// สภาแบงค์ also lowers the cost of vanilla "แบงค์" Avatars (no text of their own, so no other file codes them).
for (const [nm, pw] of [['เทวดาแบงค์', 4], ['นักเรียน แบงค์', 3], ['นายนิรยบาล แบงค์', 3], ['ปลาแบงค์', 2], ['วีรชน แบงค์', 3],
  ['รัททาทุย แบงค์', 2], ['แบงค์ เทคนิคประทุมทู', 4], ['ควายแบงค์', 5], ['ยักษ์แบงค์', 3]] as [string, number][]) {
  if (!FX[nm]) FX[nm] = { keep: 1.5 + pw * 0.6 }; // v14: the Cost -1 now comes from สภาแบงค์'s costMod (every แบงค์)
}

// ---------- v13 user rulings ----------
Object.assign(FX, {
  // PRMO-029: while this Land is in play, a player who places a Land puts it in their own Magic Zone (every Land stays and
  // works); when this card leaves play, the other Lands are destroyed too (engine placeLand / landCheck).
  'แบ่งแยกดินแดน': {
    keep: 2,
    canCast: (g: Game, p: PID) => !g.land || g.land.owner !== p,
  },
  // PRMO-039: an Avatar can only be summoned with GEM exactly equal to its Cost (no overpaying); other cards pay as usual
  // (engine exactLand, used by payOk / bestPayment).
  'หมู่บ้านพอดี': {
    keep: 1.5,
    canCast: (g: Game, p: PID) => (!g.land || g.land.owner !== p) && P(g, opp(p)).hand.length >= 4,
  },
});

// other-team audit Q9 (user: a cancelled Magic keeps its text costs paid): the "cost :" part is paid before the React window
costFirst('งานวิจัยของพระพรหม', (g, p, c) => {
  const pl = P(g, p);
  c.f.brahma = pl.avatars.some((a) => named(a, 'พระพรหม')) ? 1 : 0; c.f.handN = pl.hand.length;
  for (const x of [...pl.hand]) discard(g, p, x);
  return true;
}, (g, p, c) => { if (c.f.brahma) search(g, p, () => true, 'deck'); else if ((c.f.handN || 0) >= 3) draw(g, p, 5); });
costFirst('แผนลับของเหล่าพลเอก', (g, p) => {
  const picked: Card[] = [];
  while (picked.length < 3) {
    const a = worst(onZone(g, p, 'พลเอก').filter((x) => !picked.includes(x) && !picked.some((y) => y.def.name === x.def.name)), (x) => value(g, x));
    if (!a) break; picked.push(a);
  }
  if (picked.length < 3) return false;
  for (const a of picked) toHell(g, a);
  return true;
}, (g, p) => {
  const pl = P(g, p), o = opp(p), op = P(g, o);
  for (const a of [...op.avatars]) removeOpp(g, p, a, 'hell', true);
  for (const x of [...op.mz]) sendHell(g, x);
  if (g.land && g.land.owner === o) { op.hell.push(g.land); g.land = null; }
  for (const x of [...op.hand]) discard(g, o, x);
  const names = new Set<string>();
  for (let i = 0; i < 3; i++) {
    const s = fromZoneSummon(g, p, pl.deck, (x) => (named(x, 'ทหาร') || named(x, 'รด.')) && !names.has(x.def.name));
    if (!s) break; names.add(s.def.name);
  }
  shuffle(g, pl.deck);
});
{
  const firePay = (g: Game, p: PID) => { const sac = worst(P(g, p).avatars, (a) => value(g, a)); if (!sac) return false; toHell(g, sac); return true; };
  const fireRoll = (g: Game, p: PID) => {
    if (d6(g) % 2 === 0) {
      for (const t of pickN(P(g, opp(p)).avatars.filter((a) => magicOk(g, p, a)), 2, (x) => value(g, x), { title: 'ธาตุไฟแตก ๆ: destroy 2 opposing Avatars' })) destroy(g, t, p, true);
    } else { const t = worst(P(g, p).avatars, (a) => value(g, a)); if (t) destroy(g, t, p); }
  };
  costFirst('ธาตุไฟแตก ๆ', firePay, fireRoll, firePay, fireRoll);
}
costFirst('เอาแค่การ์ด !!!', (g, p, c) => {
  const d = worst(P(g, p).hand.filter((x) => x !== c && (named(x, 'โอเดนย่า') || named(x, 'ทาโกะ'))), (x) => keepValue(g, x));
  if (!d) return false;
  discard(g, p, d); return true;
}, (g, p) => { const t = best(P(g, opp(p)).avatars.filter((a) => magicOk(g, p, a)), (a) => value(g, a)); if (t) removeOpp(g, p, t, 'hand', true); });
