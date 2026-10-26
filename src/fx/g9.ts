// Card effects for BT12 (31 cards, worker "bt12", v14). Approximations are marked "approx:".
// Name groups match by name-contains (nameHas: printed names, "#" aka names, names given by effects) plus the
// text spellings of v14/name-aliases.json: "อิมไลน์" = ฮิมไลน์ (BT12-014), "ทุ่ย" = กุ่ย, "บาย" = นาย.
// Short names (กุ่ย / ฮอล / นาย) match as a whole word only (so นายนิรยบาล, ทนาย, คุณนาย don't count).
// v14 answers: the BT12 dragon icon is the symbol มังกร (cards.json symbol + "{symbol มังกร}" texts); checks use DRAGON.
import { rollDie } from '../engine.ts';
import type { Card, Game, PID, Def } from '../types.ts';
import type { Fx, HandAct } from '../cards.ts';
import { FX, value, best, worst, pickN, worstN, mayDo, chooseMode, oppChoice } from '../cards.ts';
import {
  P, opp, power, draw, destroy, toHell, toExile, toDeck, discard, detach, summon, shuffle, mill, placeToken,
  canPlaceAvatar, flippedLife, critical, onceUsed, markOnce, keepValue, log, findCard, rand, hitLife,
  uniqueBlocked, bestPayment, choosePayment, costOf, nameHas, symIs, colorIs, colorsEn, scoutDeck, isAvatarDef,
  canChangeCtrl, withSource, fieldZone, summonAllowed, flipLifeCard, RULES, addRule, RULE_GAME, handWatch, silenced,
  attach as attachE, canWear as canWearE, addPower, contOff, lands,
} from '../engine.ts';
import { symbolsOf, namesOf, addName, addNote } from '../view.ts';
import { loseText, noAttackUntil, fullSilenced, noAbilityNow } from '../engine.ts'; // simplify1

// ---------- helpers ----------
const isA = (c: Card) => c.def.type === 'Avatar' || c.def.type === 'Token';
const ALIAS: Record<string, string> = { 'อิมไลน์': 'ฮิมไลน์', 'ทุ่ย': 'กุ่ย', 'บาย': 'นาย' };
function named(c: Card, key: string): boolean {
  if (nameHas(c, key)) return true;
  const a = ALIAS[key];
  if (a && nameHas(c, a)) return true;
  const f = FX[c.def.name];
  return !!(f && f.alias && f.alias.some((x) => x.includes(key)));
}
/** whole-word name match (short names: กุ่ย, ฮอล, นาย) */
function word(c: Card, key: string): boolean {
  const k = ALIAS[key] || key;
  return namesOf(c).some((n) => n.split(/\s+/).includes(k));
}
const DRAGON = 'มังกร';
const beast = (c: Card) => symIs(c, DRAGON);
const him = (c: Card) => named(c, 'ฮิมไลน์');
const party = (c: Card) => named(c, 'ปาร์ตี้ผู้กล้า');
const treasure = (c: Card) => named(c, 'สมบัติศักดิ์สิทธิ์');
const once = (g: Game, p: PID, key: string) => !onceUsed(g, P(g, p), key);
const use = (g: Game, p: PID, key: string) => markOnce(g, P(g, p), key);
const act = (label: string, can: (g: Game) => boolean, run: (g: Game) => void): HandAct => ({ label, can, run });
const boost = (c: Card, n: number, until: 'turn' | 'battle' = 'turn') => { if (n) c.temp.push({ power: n, until }); };
const d6 = (g: Game) => rollDie(g); // emits the 'roll' event
const hellMagic = (g: Game, p: PID) => P(g, p).hell.filter((x) => x.def.type === 'Magic').length;
const inMain = (g: Game, p: PID) => g.phase === 'Main' && g.active === p;
/** Avatars "on our field": Avatar Zone + Avatars in our Magic Zone (มามิ, อาคัส targets). */
const fieldAvatars = (g: Game, p: PID) => [...P(g, p).avatars, ...P(g, p).mz.filter(isA)];
/** Number of different Symbols among the Avatars on p's field (effective symbols; approx: "every symbol" ('*') counts as 1). */
function distinctSyms(g: Game, p: PID): number {
  const s = new Set<string>();
  for (const a of fieldAvatars(g, p)) for (const x of symbolsOf(a, g)) if (x) s.add(x);
  return s.size;
}
const multiSym = (g: Game, c: Card) => { const xs = symbolsOf(c, g); return xs.length >= 2 || xs.includes('*'); };
function peek(g: Game, p: PID, n: number, pick: (cs: Card[]) => void, rest: 'bottom' | 'shuffle' | 'hell' | 'top' | 'either' = 'shuffle') {
  scoutDeck(g, p, n, pick, rest);
}
/** take one card matching pred from scouted cards into p's hand (the human picks); null if none. */
function takeHand(g: Game, p: PID, list: Card[], pred: (c: Card) => boolean, optional = false): Card | null {
  const pool = list.filter(pred);
  const c = optional ? pickN(pool, 1, (x) => keepValue(g, x) + x.def.power * 0.3, { optional: true })[0] || null
    : best(pool, (x) => keepValue(g, x) + x.def.power * 0.3);
  if (c) { list.splice(list.indexOf(c), 1); P(g, p).hand.push(c); handWatch(g, c, 'deck'); }
  return c;
}
function fromZoneSummon(g: Game, p: PID, zone: Card[], pred: (c: Card) => boolean, how: 'jutsu' | 'effect' = 'effect') {
  const c = best(zone.filter((x) => isA(x) && pred(x) && !uniqueBlocked(g, p, x) && summonAllowed(g, p, x, how)), (x) => value(g, x));
  if (c && canPlaceAvatar(P(g, p), false, c) && summon(g, p, c, how)) return c;
  return null;
}
/** engine attach() (canWear: noWear / wearIf / refuseMod; runs onAttach), then the attached card takes the wearer's side. */
function attach(g: Game, c: Card, w: Card) {
  if (!canChangeCtrl(g, c, w.ctrl)) { log(g, `${c.def.name}: its control can't be changed`); return false; }
  if (!attachE(g, c, w)) return false;
  c.asleep = false; c.temp = []; c.ctrl = w.ctrl;
  log(g, `${c.def.name} is attached to ${w.def.name}`);
  return true;
}
/** discard n cards (the human picks; bot: least useful). Run inside withSource(src) so onDiscard watchers (มามิ) see it. */
function discardN(g: Game, p: PID, n: number, except: Card[] = [], pred: (c: Card) => boolean = () => true, title = 'discard'): boolean {
  const pool = P(g, p).hand.filter((x) => !except.includes(x) && pred(x));
  if (pool.length < n) return false;
  const pick = worstN(pool, n, (x) => keepValue(g, x) - (x.def.name.startsWith('มามิ') ? 3 : 0), { title });
  if (pick.length < n) return false;
  for (const x of pick) discard(g, p, x);
  return true;
}
function toMz(g: Game, c: Card, p: PID) {
  detach(g, c);
  c.ctrl = p; c.asleep = false; c.temp = []; c.wearer = -1;
  P(g, p).mz.push(c);
  log(g, `${c.def.name} goes to P${p}'s Magic Zone`);
}
const fight = (sym: string): Fx['battle'] => (g, c, other) => { if (symIs(other, sym)) { boost(c, -2, 'battle'); log(g, `${c.def.name}: POWER -2 (fights a {${sym}} Avatar)`); } };
const byTraveler = (c: Card) => !!c.f.byTraveler;
const redGeneral = (c: Card) => isA(c) && named(c, 'ขุนพล') && colorIs(c, 'แดง') && symIs(c, 'ต่างชาติ');

// Token สัตว์ในตำนาน BT12-076 (cards.json type Token, picture bottcg-import/images/BT12-076.png), summoned by บันบัน BT12-045.
// Symbol: the unicorn icon = สัตว์มหัศจรรย์ (the user's "Mythical Beast"; v13 main.gd icon 24).
const TOKEN_GULOO: Def = { print: 'BT12-076', name: 'สัตว์ในตำนาน', type: 'Token', subtype: '', cost: 2, gem: 0, power: 2, symbol: 'สัตว์มหัศจรรย์', color: 'เขียว', only: false, vanilla: true };

// ชาร์อึก BT12-009: "ในเกมนี้ทั้งเกม เราจะสามารถอัญเชิญได้เพียง Avatar "ผู้ฝึกมังกร" หรือ Avatar {symbol มังกร}"
RULES['ชาร์อึก'] = { label: 'ชาร์อึก: only "ผู้ฝึกมังกร" or {มังกร} Avatars can be summoned', summon: (g, r, c) => named(c, 'ผู้ฝึกมังกร') || beast(c) };

function charCands(g: Game, p: PID, self: Card) {
  return P(g, p).hand.filter((x) => x !== self && x.def.type === 'Avatar' && beast(x) && canPlaceAvatar(P(g, p), false, x) && !uniqueBlocked(g, p, x)
    && summonAllowed(g, p, x, 'jutsu') && bestPayment(g, p, Math.max(0, costOf(g, p, x) - 6), [x, self], x) !== null);
}
// เมอลิน BT12-010
const knight = (c: Card) => isA(c) && named(c, 'อัศวินโต๊ะกลม');
const sword = (c: Card) => c.def.type === 'Magic' && c.def.subtype === 'Modification' && named(c, 'ดาบศักดิ์สิทธิ์') && !c.def.only;
function merlinModes(g: Game, p: PID): number[] {
  const pl = P(g, p), out: number[] = [];
  if (pl.hell.some(knight)) out.push(0);
  if (pl.hell.some((x) => knight(x) && x.def.cost <= 5)) out.push(1);
  if (pl.hell.some(sword) && pl.avatars.some((a) => knight(a) && !a.def.noWear)) out.push(2);
  return out;
}
// คาไม BT12-034: its จุติ (also re-used by its สั่งใช้)
function kamaiAdvent(g: Game, c: Card, ask: boolean) {
  const p = c.ctrl;
  const ts = P(g, opp(p)).avatars;
  if (!ts.length || !P(g, p).hand.some((x) => x !== c)) return;
  const n = distinctSyms(g, p);
  if (ask && !mayDo(g, c, `discard 1: an opposing Avatar POWER -${n} until end of turn`, n >= 2)) return;
  if (!discardN(g, p, 1, [c], () => true, `${c.def.name}: discard 1 (cost)`)) return;
  const t = best(P(g, opp(p)).avatars, (a) => value(g, a) + (power(g, a) <= distinctSyms(g, p) ? 5 : 0));
  if (t) { boost(t, -distinctSyms(g, p)); log(g, `${c.def.name}: ${t.def.name} POWER -${distinctSyms(g, p)} until end of turn`); }
}
// แอมเฟสต้า BT12-043: once per turn, wake a differently named "Overdose" of ours that became asleep
function amfWake(g: Game, self: Card, x: Card) {
  const p = self.ctrl;
  if (!P(g, p).avatars.includes(self) || !P(g, p).avatars.includes(x) || x === self || !x.asleep) return;
  if (!named(x, 'Overdose') || x.def.name === self.def.name || !once(g, p, 'amf:' + self.uid)) return;
  use(g, p, 'amf:' + self.uid); x.asleep = false;
  log(g, `${self.def.name}: ${x.def.name} wakes up`);
}
let LOW_BUSY = 0;
/** sum of POWER decreases on w (temps, other cards' auras, Lands), as a positive number */
function lowered(g: Game, w: Card): number {
  if (LOW_BUSY) return 0;
  LOW_BUSY++;
  try {
    let n = 0;
    for (const t of w.temp) if (t.power < 0) n -= t.power;
    for (const q of g.p) for (const s of q.avatars.concat(q.mz)) {
      const f = FX[s.def.name];
      if (s !== w && f && f.aura && !contOff(g, s)) { const v = f.aura(g, s, w); if (v < 0) n -= v; }
    }
    for (const l of lands(g)) { const f = FX[l.def.name]; if (f && f.landPower) { const v = f.landPower(g, l, w); if (v < 0) n -= v; } }
    return n;
  } finally { LOW_BUSY--; }
}
// bugfix2 item 5 (user): a Construct (it fights like an Avatar) in the Magic Zone counts as "Avatar บน Magic Zone"
const mzAvatar = (c: Card) => isA(c) || c.def.type === 'Construct';
const oppMzAvatars = (g: Game, p: PID) => P(g, opp(p)).mz.filter(mzAvatar);
// กุนซือลงสนาม BT12-055
function onlyGenerals(g: Game, p: PID) {
  const pl = P(g, p);
  return [...pl.hand, ...pl.avatars, ...pl.hell].filter((x) => isA(x) && x.def.only && named(x, 'ขุนพล'));
}
const sameColor = (a: Card, b: Card) => colorsEn(a).some((k) => colorsEn(b).includes(k));
const advisors = (g: Game, p: PID, shown: Card) => P(g, p).deck.filter((x) => isA(x) && named(x, 'กุนซือ') && sameColor(x, shown) && summonAllowed(g, p, x, 'jutsu') && !uniqueBlocked(g, p, x));
const sleepers = (g: Game, p: PID) => P(g, p).avatars.filter((a) => a.asleep && named(a, 'นักท่องเรื่องราว'));
function dacknova(g: Game, p: PID, c: Card) {
  const t = best(sleepers(g, p), (a) => power(g, a));
  if (!t) return;
  t.asleep = false;
  log(g, `${c.def.name}: ${t.def.name} wakes up`);
  if (hellMagic(g, p) >= 8) addPower(g, t, 2, g.active === p ? 'turn' : g.turn + 1, c); // until the end of our (next) turn
}
const treasuresOut = (g: Game, p: PID, except: Card | null = null) => P(g, p).avatars.flatMap((a) => a.mods).filter((m) => m !== except && m.ctrl === p && treasure(m)).length;

// ขวัญตา เรื่องราว BT12-048/049: keep the "summon by นักท่องเรื่องราว" hand actions other files put on these names
// (g8: มายา's Battle Phase swap; cards2: ขวัญตา's Battle Phase swap, reused from ราชาแห่งนาค's generic handActs).
const STORY12 = ['ขวัญตา เรื่องราว ตำนานอมตะ', 'ขวัญตา เรื่องราว ผู้กำหนดชีวิต'];
const PREV_HAND: Record<string, Fx['handActs']> = {};
for (const n of STORY12) PREV_HAND[n] = FX[n]?.handActs;
function storyHandActs(name: string): Fx['handActs'] {
  return (g, p, c) => {
    const xs: HandAct[] = [];
    const add = (f: Fx['handActs'] | undefined) => { if (f) for (const x of f(g, p, c)) if (!xs.some((y) => y.label === x.label)) xs.push(x); };
    add(PREV_HAND[name]);
    add(FX['ขวัญตา เรื่องราว ราชาแห่งนาค']?.handActs); // generic: acts on the card c it is given
    const ok = (x: HandAct) => { try { return x.can(g); } catch { return false; } };
    return [...xs.filter(ok), ...xs.filter((x) => !ok(x))]; // the bot's Battle Phase loop runs [0]
  };
}

Object.assign(FX, {
  // ===== BT12 red =====
  'นานาโอชิ นานะ เทพธิดากาชาและที่จอดรถ': {
    keep: 4.5,
    staticPower: (g, c) => distinctSyms(g, c.ctrl),
    onAttack: (g, c) => withSource(c, () => {
      const p = c.ctrl;
      const ts = () => P(g, opp(p)).avatars.filter((a) => power(g, a) <= power(g, c));
      if (P(g, p).hand.length < 2 || !ts().length) return;
      if (!mayDo(g, c, 'discard 2: destroy an opposing Avatar with POWER ≤ this card', ts().some((a) => value(g, a) >= 4))) return;
      if (!discardN(g, p, 2, [], () => true, `${c.def.name}: discard 2 (cost)`)) return;
      const t = best(ts(), (a) => value(g, a));
      if (t) destroy(g, t, p);
    }),
  },
  'ชาร์อึก ผู้ฝึกมังกร': {
    keep: 4,
    costMod: (g: Game, self: Card, t: Card) => (t !== self && P(g, self.ctrl).avatars.includes(self) && P(g, self.ctrl).hand.includes(t) && t.def.type === 'Avatar' && beast(t) ? -1 : 0),
    handActs: (g, p, c) => [act('ชาร์อึก: discard this, summon a {มังกร} from hand (Cost -6)', (g2) => inMain(g2, p) && P(g2, p).hand.includes(c) && charCands(g2, p, c).length > 0,
      (g2) => {
        const x = best(charCands(g2, p, c), (y) => value(g2, y) + y.def.cost);
        if (!x) return;
        discard(g2, p, c);
        const cost = Math.max(0, costOf(g2, p, x) - 6);
        const pay = choosePayment(g2, p, cost, [x], x);
        if (pay) summon(g2, p, x, 'jutsu', pay, cost);
        if (!(g2.rules || []).some((r) => r.key === 'ชาร์อึก' && r.p === p)) addRule(g2, { p, key: 'ชาร์อึก', until: RULE_GAME });
      })],
  },
  // image: the badge before ":" is เลือกปฏิบัติ (choose one), the data text says "เนรเทศ" (data report §2.3)
  'เมอลิน พ่อมดแห่งอวาลอน': {
    keep: 4,
    fieldActs: (g, p, c) => [act('เมอลิน: discard 1, choose one', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'เมอลิน')
      && P(g2, p).hand.length >= 1 && merlinModes(g2, p).length > 0,
    (g2) => {
      use(g2, p, 'เมอลิน');
      const modes = merlinModes(g2, p);
      const labels = ['Return a "อัศวินโต๊ะกลม" from Hell to the Deck (shuffle), draw 1', 'Put a "อัศวินโต๊ะกลม" (Cost 5 or less) from Hell on top of the Deck', 'Attach a non-Only "ดาบศักดิ์สิทธิ์" from Hell to our "อัศวินโต๊ะกลม"'];
      const dflt = modes.includes(2) ? modes.indexOf(2) : modes.includes(0) ? modes.indexOf(0) : 0;
      const m = modes[chooseMode(g2, c, modes.map((i) => labels[i]), dflt)] ?? modes[0];
      if (!discardN(g2, p, 1, [], () => true, 'เมอลิน: discard 1 (cost)')) return;
      const pl = P(g2, p);
      if (m === 0) { const k = best(pl.hell.filter(knight), (x) => keepValue(g2, x)); if (k) { detach(g2, k); pl.deck.push(k); shuffle(g2, pl.deck); draw(g2, p, 1); } }
      else if (m === 1) { const k = best(pl.hell.filter((x) => knight(x) && x.def.cost <= 5), (x) => keepValue(g2, x)); if (k) { detach(g2, k); pl.deck.unshift(k); log(g2, `${k.def.name} goes on top of P${p}'s Deck`); } }
      else {
        const s = best(pl.hell.filter(sword), (x) => keepValue(g2, x));
        const w = s ? best(pl.avatars.filter((a) => knight(a) && !a.def.noWear), (a) => value(g2, a)) : null;
        if (s && w) attach(g2, s, w);
      }
    })],
  },
  'กำเหลง ขุนพลโจรสลัดแห่งง่อก๊ก': {
    keep: 4, shield: true,
    costMod: (g: Game, self: Card, t: Card) => {
      if (t !== self || !P(g, self.owner).hand.includes(self)) return 0;
      const avs = P(g, self.owner).avatars;
      return avs.length > 0 && avs.every((a) => named(a, 'ขุนพล') && colorIs(a, 'แดง') && symIs(a, 'ต่างชาติ')) ? -1 : 0;
    },
    staticPower: (g, c) => (P(g, c.ctrl).mz.some((x) => x.def.type === 'Construct' && named(x, 'เรือรบโบราณ')) ? 2 : 0),
    aura: (g, s, t) => (P(g, s.ctrl).avatars.includes(s) && t.def.type === 'Construct' && P(g, s.ctrl).mz.includes(t) && named(t, 'เรือรบโบราณ') ? 1 : 0),
    getActive: (g: Game, self: Card) => P(g, self.ctrl).mz.some((x) => x.def.type === 'Construct' && named(x, 'เรือรบโบราณ')) && 'เรือรบโบราณ: POWER +2',
  },
  'อิกนิส มังกรไฟโซลฮอต': {
    keep: 4,
    aura: (g, s, t) => (t !== s && P(g, s.ctrl).avatars.includes(s) && P(g, s.ctrl).avatars.includes(t) && beast(t)
      && P(g, s.ctrl).hell.filter((x) => isA(x) && beast(x)).length >= 4 ? 1 : 0),
    battle: fight('นรก'),
  },
  'เรือรบโบราณฉวน': {
    keep: 4,
    fieldActs: (g, p, c) => [act('เรือรบโบราณฉวน: scout 5 for a red "ขุนพล"', (g2) => inMain(g2, p) && P(g2, p).mz.includes(c) && once(g2, p, 'chuan:' + c.uid) && P(g2, p).deck.length > 1,
      (g2) => {
        use(g2, p, 'chuan:' + c.uid);
        let got: Card | null = null;
        peek(g2, p, 5, (top) => { got = takeHand(g2, p, top, redGeneral); }, 'bottom');
        const x = got as Card | null;
        if (x && P(g2, p).hand.includes(x) && costOf(g2, p, x) <= 4 && canPlaceAvatar(P(g2, p), false, x) && !uniqueBlocked(g2, p, x) && summonAllowed(g2, p, x, 'effect')
          && mayDo(g2, c, `summon ${x.def.name}`, true)) summon(g2, p, x, 'effect');
      })],
  },

  // ===== BT12 blue =====
  'ฮิมไลน์ ผู้กล้าแห่งปาร์ตี้ผู้กล้า': {
    keep: 4.5, shield: true,
    staticPower: (g, c) => (c.mods.some(treasure) ? 7 - c.def.power : 0),
    getActive: (g: Game, self: Card) => self.mods.some(treasure) && 'สมบัติศักดิ์สิทธิ์: POWER ตั้งต้น 7',
    // "when destroyed while it wears no {mod}: attach a "สมบัติศักดิ์สิทธิ์" from Hell instead" (once per summon: c.f resets)
    leaveGuard: (g: Game, self: Card, t: Card, info: any) => {
      if (t !== self || info.how !== 'destroy' || self.mods.length || self.f.himUsed || !P(g, self.ctrl).avatars.includes(self)) return null;
      const ms = P(g, self.ctrl).hell.filter((x) => x.def.type === 'Magic' && x.def.subtype === 'Modification' && treasure(x));
      if (!ms.length || self.def.noWear) return null;
      return {
        optional: false, label: 'attach a "สมบัติศักดิ์สิทธิ์" from Hell instead of being destroyed',
        run: () => {
          const m = best(ms.filter((x) => P(g, self.ctrl).hell.includes(x)), (x) => keepValue(g, x));
          if (!m) return false;
          self.f.himUsed = 1;
          if (!attach(g, m, self)) return false;
          if (self.asleep && mayDo(g, self, 'wake ฮิมไลน์ up', true)) self.asleep = false;
          return true;
        },
      };
    },
  },
  'ฟรีแลนซ์ นักเวทย์แห่งปาร์ตี้ผู้กล้า': {
    keep: 4,
    jutsu: (g, c) => {
      const p = c.ctrl, pl = P(g, p);
      if (!pl.hand.some((x) => x.def.type === 'Magic') || !mayDo(g, c, 'discard a Magic: สอดแนม 3', true)) return;
      if (!discardN(g, p, 1, [], (x) => x.def.type === 'Magic', 'ฟรีแลนซ์: discard a Magic (cost)')) return;
      peek(g, p, 3, (top) => {
        const n = top.filter((x) => x.def.type === 'Magic' || party(x)).length;
        const ts = P(g, opp(p)).avatars;
        if (n > 0 && ts.length) {
          const t = best(ts, (a) => value(g, a) + (power(g, a) <= n ? 5 : 0));
          if (t) { boost(t, -n); log(g, `ฟรีแลนซ์: ${t.def.name} POWER -${n} until end of turn`); }
        }
        takeHand(g, p, top, (x) => party(x) || treasure(x), true);
      }, 'bottom');
    },
  },
  'ฮิตเตอร์ นักบวชแห่งปาร์ตี้ผู้กล้า': {
    keep: 3.5,
    fieldActs: (g, p, c) => [act('ฮิตเตอร์: exile this, summon "ฮิมไลน์" from Hell', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c)
      && !P(g2, p).avatars.some(him) && !P(g2, p).exile.some((x) => x.def.name === c.def.name) && P(g2, p).hell.some((x) => isA(x) && him(x)),
    (g2) => {
      const pl = P(g2, p);
      toExile(g2, c, { cost: true });
      const h = fromZoneSummon(g2, p, pl.hell, him, 'effect');
      if (h && pl.avatars.includes(h) && !h.def.noWear) {
        const ts = pl.deck.filter((x) => x.def.type === 'Magic' && x.def.subtype === 'Modification' && treasure(x));
        if (ts.length && mayDo(g2, c, `attach a "สมบัติศักดิ์สิทธิ์" from the Deck to ${h.def.name}`, true)) {
          const m = best(ts, (x) => keepValue(g2, x));
          if (m) attach(g2, m, h);
        }
      }
      shuffle(g2, pl.deck);
    })],
  },
  'โคลัส นักธนูแห่งปาร์ตี้ผู้กล้า': {
    keep: 3,
    jutsu: (g, c) => {
      const p = c.ctrl, q = opp(p);
      if (!P(g, p).avatars.some((a) => a !== c && party(a))) return;
      const r = d6(g);
      log(g, `โคลัส rolls ${r}`);
      if (r % 2 === 0) {
        if (P(g, q).hand.length) { const x = oppChoice(g, p, () => worst(P(g, q).hand, (y) => keepValue(g, y))); if (x) discard(g, q, x); }
        else draw(g, p, 1);
      } else if (P(g, q).avatars.length) {
        const t = best(P(g, q).avatars, (a) => value(g, a));
        if (t) { addPower(g, t, -1, 'perm', c); log(g, `โคลัส: ${t.def.name} POWER -1`); } // no duration in the text: lasts while it stays on the field
      } else {
        const t = best(P(g, p).avatars.filter(party), (a) => value(g, a));
        if (t) { addPower(g, t, 1, 'perm', c); log(g, `โคลัส: ${t.def.name} POWER +1`); }
      }
    },
  },
  'มามิ สิ่งมีชีวิตปริศนาระดับถั่วๆ': {
    keep: 3,
    // "when this card is discarded by an Avatar's ability: put it on our Magic Zone" (v14b FX.onDiscard; GEM payments don't count)
    onDiscard: (g: Game, self: Card, cards: Card[], by: PID, src: Card) => {
      if (!cards.includes(self) || !src || !isAvatarDef(src.def) || !P(g, self.owner).hell.includes(self)) return;
      toMz(g, self, self.owner);
    },
    aura: (g, s, t) => (P(g, s.ctrl).mz.includes(s) && P(g, s.ctrl).avatars.includes(t) && multiSym(g, t) ? 1 : 0),
  },
  'ชุนอก กุนซือพรสวรรค์แห่งวุยก๊ก': {
    keep: 3,
    usedAsCost: (g, p, c, summoned) => {
      if (!(named(summoned, 'ขุนพล') && colorIs(summoned, 'ฟ้า') && symIs(summoned, 'ต่างชาติ'))) return;
      withSource(c, () => peek(g, p, 2, (top) => { takeHand(g, p, top, (x) => named(x, 'ขุนพล') && colorIs(x, 'ฟ้า') && symIs(x, 'ต่างชาติ')); }, 'either'));
    },
  },
  'อาคัส มังกรแห่งห้วงเหวน้ำลึก': {
    keep: 4,
    fieldActs: (g, p, c) => [act('อาคัส: rest, destroy an Avatar in the opponent\'s Magic Zone', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && !c.asleep
      && once(g2, p, 'akas:' + c.uid) && P(g2, p).avatars.some((a) => a !== c && beast(a) && !a.asleep) && oppMzAvatars(g2, p).length > 0,
    (g2) => {
      use(g2, p, 'akas:' + c.uid);
      c.asleep = true;
      const t = best(oppMzAvatars(g2, p), (x) => keepValue(g2, x) + 2);
      if (t) destroy(g2, t, p); // v14d: destroy() handles Avatars in the Magic Zone
    })],
    onAnyLeave: (g: Game, self: Card, gone: Card, info: any) => {
      const p = self.ctrl;
      if (!P(g, p).avatars.includes(self) || !self.asleep || info.zone !== 'mz' || !mzAvatar(gone) || info.ctrl !== opp(p)) return;
      if (info.how !== 'destroy') return;
      if (!once(g, p, 'akasW:' + self.uid)) return;
      use(g, p, 'akasW:' + self.uid); self.asleep = false;
      log(g, `${self.def.name} wakes up`);
    },
    battle: fight('สัตว์'), // rm01: the text's monkey icon is {symbol สัตว์} (วานร symbol is gone)
  },
  'มังกรฟ้าตาขาว': { keep: 3 }, // BT12-053: no text (vanilla)
  'Skill : Dacknova': {
    keep: 2.5, mainUse: true,
    canCast: (g, p) => sleepers(g, p).length > 0,
    resolve: (g, p, c) => dacknova(g, p, c),
    battleUse: (g, p) => sleepers(g, p).length > 0,
    react: {
      on: ['attack', 'battleStart', 'endTurn'],
      can: (g, p) => sleepers(g, p).length > 0,
      want: (g, p, c, ev) => ev.kind === 'attack' && !!ev.target && ev.target.ctrl === p,
      resolve: (g, p, c) => dacknova(g, p, c),
    },
  },
  'ถ้าเป็นอิมไลน์ก็คงทำแบบนี้': {
    keep: 2.5,
    react: {
      on: ['attack'],
      can: (g, p, c, ev) => !!ev.target && ev.target.ctrl === p && P(g, p).avatars.includes(ev.target) && !him(ev.target)
        && P(g, p).avatars.some((h) => h !== ev.target && him(h) && h.mods.length > 0),
      want: (g, p, c, ev) => value(g, ev.target!) >= 4 && !!ev.source && P(g, p).avatars.some((h) => him(h) && h.mods.length > 1 || (him(h) && power(g, h) - (h.mods.some(treasure) ? 5 : 0) > power(g, ev.source!))),
      resolve: (g, p, c, ev) => {
        const h = best(P(g, p).avatars.filter((x) => x !== ev.target && him(x) && x.mods.length > 0), (x) => power(g, x));
        if (!h) return;
        const m = worst(h.mods, (x) => keepValue(g, x) + (treasure(x) ? 3 : 0));
        if (!m || !toDeck(g, m, 'bottom', { cost: true })) return;
        ev.target = h;
        log(g, `${c.def.name}: the attack now targets ${h.def.name}`);
      },
    },
  },
  'สมบัติศักดิ์สิทธิ์ แอสคาลอน': {
    keep: 4,
    // "*สามารถควบคุม สมบัติศักดิ์สิทธิ์ ได้สูงสุด 2 ใบ": wearIf (v14d canWear) counts the ones our Avatars already wear
    wearIf: (g: Game, self: Card, w: Card) => treasuresOut(g, w.ctrl, self) < 2,
    canCast: (g, p, c) => P(g, p).avatars.some((a) => canWearE(g, c, a)),
    modTarget: (g, p, c) => best(P(g, p).avatars.filter((a) => canWearE(g, c, a)), (a) => (him(a) && !a.mods.some(treasure) ? 100 : him(a) ? 20 : 0) + value(g, a)),
    wearerBattle: (g, m, w, other) => { if (him(w) && symIs(other, 'นรก')) { boost(w, 2, 'battle'); log(g, `แอสคาลอน: ${w.def.name} POWER +2 (fights a {นรก} Avatar)`); } },
    // "ไม่รับผลความสามารถจากการ์ด {symbol นรก}" (v14d shieldFrom: POWER changes, being chosen, being removed)
    shieldFrom: (g: Game, self: Card, t: Card, src: Card) => t.mods.includes(self) && him(t) && src !== t && symIs(src, 'นรก'),
    leaveGuard: (g: Game, self: Card, t: Card, info: any) => {
      // bugfix2 item 1 (user): "นำการ์ดใบนี้กลับเข้า Deck แทนการถูกทำลาย" = this card goes back into the Deck instead of to
      // Hell; the wearer is still destroyed (ฮิมไลน์ is saved only once per summon, by its own ability)
      if (t.uid !== self.wearer || !t.mods.includes(self)) return null;
      self.f.deckOnDrop = info.how === 'destroy' ? g.turn : 0;
      return null;
    },
    onWearerLeave: (g: Game, m: Card) => {
      if (m.f.deckOnDrop !== g.turn) return false;
      m.f.deckOnDrop = 0;
      const pl = P(g, m.owner); pl.deck.push(m); shuffle(g, pl.deck);
      log(g, `${m.def.name} goes back into the Deck (shuffled) instead of to Hell`);
      return true;
    },
    getFor: (g: Game, self: Card, t: Card) => t.mods.includes(self) && him(t) && 'แอสคาลอน: POWER +2 vs {นรก}, ไม่รับผลการ์ด {นรก}',
  },

  // ===== BT12 purple =====
  'เฟริส สาวจิไรเคย์': {
    keep: 3,
    jutsu: (g, c) => {
      const p = c.ctrl;
      if (critical(P(g, p)) || !mayDo(g, c, 'damage your own LIFE 1: draw 1', flippedLife(P(g, p)) <= 2)) return;
      if (flipLifeCard(g, p)) draw(g, p, 1);
    },
  },
  'คาไม แม่มดไอที': {
    keep: 4,
    onSummon: (g, c) => { c.f.sumT = g.turn; },
    jutsu: (g, c) => kamaiAdvent(g, c, true),
    // "สั่งใช้ จากมือ เมื่อฝ่ายตรงข้ามใช้การ์ด Magic ...: อัญเชิญ จุติ Avatar ใบนี้" (v14 answers: คาไม can be summoned by this
    // ability once per turn: onceKey is per player, shared by every copy). Its "#" symbol คน comes from the data (hashStats).
    react: {
      on: ['magic'], fromHand: true, noLimit: true, onceKey: 'คาไม:hand',
      can: (g, p, c, ev) => ev.actor !== p && P(g, p).hand.includes(c) && distinctSyms(g, p) >= 2 && canPlaceAvatar(P(g, p), false, c)
        && !uniqueBlocked(g, p, c) && summonAllowed(g, p, c, 'jutsu'),
      want: () => true,
      resolve: (g, p, c) => { if (P(g, p).hand.includes(c) && canPlaceAvatar(P(g, p), false, c)) summon(g, p, c, 'jutsu'); },
    },
    fieldActs: (g, p, c) => [act('คาไม: use its จุติ again', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && c.f.sumT !== g2.turn
      && once(g2, p, 'kamai:' + c.uid) && P(g2, p).hand.length > 0 && P(g2, opp(p)).avatars.length > 0,
    (g2) => { use(g2, p, 'kamai:' + c.uid); kamaiAdvent(g2, c, false); })],
  },
  'บัช อัศวินตลิ่งชันมือหนึ่ง': {
    keep: 4, shield: true,
    staticPower: (g, c) => (g.active === c.ctrl && P(g, c.ctrl).avatars.some((a) => a !== c && a.def.name !== c.def.name && named(a, 'อัศวินตลิ่งชัน')) ? 2 : 0),
    getActive: (g: Game, self: Card) => g.active === self.ctrl && P(g, self.ctrl).avatars.some((a) => a !== self && a.def.name !== self.def.name && named(a, 'อัศวินตลิ่งชัน')) && 'อัศวินตลิ่งชัน: POWER +2',
    deathCry: (g, c, owner) => {
      const pl = P(g, owner);
      if (!pl.hell.includes(c)) return;
      const w = best(pl.avatars.filter((a) => named(a, 'เซอร์นัท') && !a.def.noWear), (a) => value(g, a));
      if (w) attach(g, c, w);
    },
  },
  // image: the card's own keyword badge is สามัคคี (data text: ลูกฮึด); with "ฮอล" it gets โล่มนุษย์; with "นาย" (text "บาย") POWER +2
  'กุ่ย พาลาดิน': {
    keep: 3, unite: true,
    kwIf: (g, c, kw) => kw === 'shield' && P(g, c.ctrl).avatars.some((a) => a !== c && word(a, 'ฮอล')),
    staticPower: (g, c) => (P(g, c.ctrl).avatars.some((a) => a !== c && word(a, 'นาย')) ? 2 : 0),
    getActive: (g: Game, self: Card) => {
      const got = [P(g, self.ctrl).avatars.some((a) => a !== self && word(a, 'ฮอล')) ? 'โล่มนุษย์ (ฮอล)' : '', P(g, self.ctrl).avatars.some((a) => a !== self && word(a, 'นาย')) ? 'POWER +2 (นาย)' : ''].filter(Boolean);
      return got.length ? got.join(', ') : false;
    },
  },
  'เช็กเราว์ ยอดอาชาแห่งขุนพล': {
    keep: 3,
    costOnlyFor: (forCard) => named(forCard, 'ขุนพล') && symIs(forCard, 'ต่างชาติ'),
    // "เราสามารถควบคุม เช็กเราว์ ในสนาม ได้เพียง 1 ใบ"
    summonIf: (g, p, c) => !P(g, p).avatars.some((a) => a.def.name === c.def.name || a.mods.some((m) => m.def.name === c.def.name)),
    handActs: (g, p, c) => [act('เช็กเราว์: wear it on "กวนอู" / "ลิโป้"', (g2) => inMain(g2, p) && P(g2, p).hand.includes(c)
      && !P(g2, p).avatars.some((a) => a.def.name === c.def.name || a.mods.some((m) => m.def.name === c.def.name))
      && P(g2, p).avatars.some((a) => (named(a, 'กวนอู') || named(a, 'ลิโป้')) && !a.def.noWear),
    (g2) => { const w = best(P(g2, p).avatars.filter((a) => (named(a, 'กวนอู') || named(a, 'ลิโป้')) && !a.def.noWear), (a) => value(g2, a)); if (w) attach(g2, c, w); })],
    modPower: (g, m, w) => {
      if (named(w, 'กวนอู')) return P(g, w.ctrl).avatars.filter((a) => a !== w && named(a, 'จ๊กก๊ก')).length;
      // "ไม่รับผล ลด POWER": every POWER decrease from temps, other cards' auras and Lands is cancelled
      if (named(w, 'ลิโป้')) return 1 + lowered(g, w);
      return 0;
    },
    getFor: (g: Game, self: Card, t: Card) => t.mods.includes(self) && (named(t, 'กวนอู') ? 'เช็กเราว์: POWER +1 ต่อ "จ๊กก๊ก" ใบอื่น' : named(t, 'ลิโป้') ? 'เช็กเราว์: POWER +1, ไม่รับผลลด POWER' : false),
  },
  // BT12-024 (added 2026-10-20 from the user's picture): exile a {กะปอม} from Hell, summon another {กะปอม} Cost <= 5 from
  // Hell; discarding 1 more card makes it a จุติ summon. The summoned Avatar gets "คำสั่งเสีย : เนรเทศ การ์ดใบนี้" (c.f.dcExile).
  'ดอกเตอร์เต้ นักวิจัยไดโนเสาร์': {
    keep: 3,
    jutsu: (g, c) => {
      const p = c.ctrl, pl = P(g, p);
      const lizard = (x: Card) => isA(x) && symIs(x, 'กะปอม');
      const can = (x: Card) => lizard(x) && x.def.cost <= 5 && !uniqueBlocked(g, p, x) && summonAllowed(g, p, x, 'jutsu');
      const pool = pl.hell.filter(lizard);
      if (!canPlaceAvatar(pl) || !pool.some((x) => pool.some((y) => y !== x && can(y)))) return;
      if (!mayDo(g, c, 'exile a {กะปอม} Avatar from Hell to summon another {กะปอม} Cost 5 or less from Hell', true)) return;
      const top = best(pl.hell.filter(can), (x) => value(g, x));
      const cost = worst(pool.filter((x) => x !== top || pool.filter(can).length > 1), (x) => keepValue(g, x));
      if (!cost) return;
      detach(g, cost); pl.exile.push(cost); log(g, `${c.def.name}: ${cost.def.name} is exiled from Hell`);
      const opts = pl.hell.filter(can);
      if (!opts.length) return;
      const jut = pl.hand.length > 0 && opts.some((x) => !!FX[x.def.name]?.jutsu)
        && mayDo(g, c, 'discard 1 card from hand so the summon is a จุติ summon', pl.hand.length >= 3) && discardN(g, p, 1, [], () => true, 'discard 1 card (จุติ summon)');
      const t = best(opts, (x) => value(g, x) + (jut && FX[x.def.name]?.jutsu ? 2 : 0));
      if (!t || !summon(g, p, t, jut ? 'jutsu' : 'effect') || !pl.avatars.includes(t)) return;
      t.f.dcExile = 1;
      log(g, `${t.def.name} gains คำสั่งเสีย : เนรเทศ การ์ดใบนี้`);
    },
  },
  // v14 answers: the จุติ cost is a {มังกร} Avatar (image icon; cards.json text now says {symbol มังกร})
  'ดีรูโอ มังกรแห่งการพังทลาย': {
    keep: 4,
    jutsu: (g, c) => {
      const p = c.ctrl, pl = P(g, p);
      const pool = pl.hell.filter((x) => isA(x) && beast(x));
      if (!pool.length || !P(g, opp(p)).avatars.length || !mayDo(g, c, 'return a {มังกร} Avatar from Hell to hand: opposing Avatars POWER -1', true)) return;
      const x = best(pool, (y) => keepValue(g, y) + y.def.power * 0.3);
      if (!x) return;
      detach(g, x); pl.hand.push(x); handWatch(g, x, 'hell');
      for (const a of P(g, opp(p)).avatars) boost(a, -1);
      log(g, `${c.def.name}: opposing Avatars POWER -1 until end of turn`);
    },
    battle: fight('เทพ'),
  },

  // ===== BT12 green =====
  'Overdose แอมเฟสต้า': {
    keep: 4,
    aura: (g, s, t) => (t !== s && P(g, s.ctrl).avatars.includes(s) && P(g, s.ctrl).avatars.includes(t) && named(t, 'Overdose') && flippedLife(P(g, s.ctrl)) >= 3 ? 1 : 0),
    // v14d onRestChange: a differently named "Overdose" of ours became asleep -> wake it (once per turn)
    onRestChange: (g: Game, self: Card, a: Card, asleep: boolean) => { if (asleep) amfWake(g, self, a); },
    // "#Avatar ทุกใบในสนามฝ่ายเราจะไม่สามารถใช้ความสามารถได้ยกเว้น Avatar "Overdose"" (same rule as BT08-031..033)
    textOff: (g: Game, self: Card, t: Card) => t.ctrl === self.ctrl && isAvatarDef(t.def) && (P(g, t.ctrl).avatars.includes(t) || P(g, t.ctrl).mz.includes(t)) && !named(t, 'Overdose'),
    getActive: (g: Game, self: Card) => flippedLife(P(g, self.ctrl)) >= 3 && 'Overdose: "Overdose" ใบอื่น POWER +1',
  },
  'แบงค์ บาร์ด': {
    keep: 3.5,
    jutsu: (g, c) => peek(g, c.ctrl, 5, (top) => {
      takeHand(g, c.ctrl, top, (x) => isA(x) && (word(x, 'กุ่ย') || word(x, 'ฮอล') || word(x, 'นาย') || named(x, 'แบงค์')));
    }, 'shuffle'),
  },
  'บันบัน คุณนายกระต่ายนักดาบเฟอรี่': {
    keep: 4,
    jutsu: (g, c) => placeToken(g, c.ctrl, TOKEN_GULOO, 1),
    getActive: (g: Game, self: Card) => distinctSyms(g, self.ctrl) >= 5 && '5 Symbol: โจมตี LIFE สำเร็จ = ทำความเสียหาย LIFE 2 ใบ',
    onAttack: (g, c, target) => { if (target === null) c.f.lhB = g.stats.lifeHits[opp(c.ctrl)]; else delete c.f.lhB; },
    afterFight: (g: Game, self: Card, att: Card, target: Card | null) => {
      if (att !== self || target !== null || self.f.lhB === undefined) return;
      const q = opp(self.ctrl), before = self.f.lhB;
      delete self.f.lhB;
      if (g.stats.lifeHits[q] > before && P(g, self.ctrl).avatars.includes(self) && distinctSyms(g, self.ctrl) >= 5 && g.winner === null) {
        log(g, `${self.def.name}: the LIFE hit deals 2 damage`);
        hitLife(g, q, self);
      }
    },
  },
  // ธรณีสูบ 2 (mill 2) as on the image; cards.json text fixed to ธรณีสูบ on 2026-10-20
  'ขวัญตา เรื่องราว ตำนานอมตะ': {
    keep: 4,
    getActive: (g: Game, self: Card) => byTraveler(self) && 'ได้รับความสามารถ (อัญเชิญโดย นักท่องเรื่องราว)',
    leaveGuard: (g: Game, self: Card, t: Card, info: any) => {
      const p = self.ctrl;
      if (t !== self || info.how !== 'destroy' || !byTraveler(self) || !P(g, p).avatars.includes(self) || !once(g, p, 'k48a:' + self.uid) || P(g, p).deck.length < 2) return null;
      return {
        label: 'ธรณีสูบ 2: if both are Magic, it is not destroyed', want: P(g, p).deck.length > 8,
        // v14 2026-10-20: cost = mill (ธรณีสูบ) the top 2 of our Deck through mill() under this card (onMill / blockMill apply);
        // a cancelled mill pays nothing, so it is destroyed. Deck < 2: can't pay (null above).
        run: () => { use(g, p, 'k48a:' + self.uid); const m = withSource(self, () => mill(g, p, 2)); return m.length >= 2 && m.every((x) => x.def.type === 'Magic'); },
      };
    },
    afterFight: (g: Game, self: Card, att: Card, target: Card | null) => {
      const p = self.ctrl;
      if (target !== self || !byTraveler(self) || !P(g, p).avatars.includes(self) || !once(g, p, 'k48b:' + self.uid)) return;
      const t = best(g.p.flatMap((q) => q.avatars), (a) => (a.ctrl === p ? 10 : -10) + value(g, a));
      if (!t) return;
      use(g, p, 'k48b:' + self.uid);
      // simplify1: stored on the chosen Avatar (engine noAttackUntil), so it lasts even if ตำนานอมตะ leaves the field
      noAttackUntil(g, t, g.active === p ? g.turn : g.turn + 1);
      addNote(g, t, `ฝ่ายตรงข้ามเลือกเป็นเป้าหมายการโจมตีไม่ได้ (${self.def.name})`, g.active === p ? g.turn : g.turn + 1);
      log(g, `${self.def.name}: ${t.def.name} can't be chosen as an attack target by its opponent until the end of P${p}'s turn`);
    },
  },
  'ขวัญตา เรื่องราว ผู้กำหนดชีวิต': {
    keep: 4,
    getActive: (g: Game, self: Card) => byTraveler(self) && 'ได้รับความสามารถ (อัญเชิญโดย นักท่องเรื่องราว)',
    battle: (g, c, other) => withSource(c, () => {
      const p = c.ctrl;
      if (!byTraveler(c) || critical(P(g, p))) return;
      const ts = P(g, opp(p)).avatars;
      if (!ts.length) return;
      if (!mayDo(g, c, 'damage your LIFE 1: an opposing Avatar loses all abilities until the end of the opponent\'s turn',
        flippedLife(P(g, p)) <= 2 && (FX[other.def.name] !== undefined && other.ctrl !== p))) return;
      if (!flipLifeCard(g, p)) return;
      const t = best(P(g, opp(p)).avatars, (a) => (a === other ? 3 : 0) + value(g, a) + (FX[a.def.name] ? 2 : 0));
      // simplify1: stored on the chosen Avatar (engine loseText), so it lasts even if ผู้กำหนดชีวิต leaves the field
      if (t) { const until = g.active === p ? g.turn + 1 : g.turn; loseText(g, t, until); addNote(g, t, `สูญเสียความสามารถทั้งหมด (${c.def.name})`, until); log(g, `${c.def.name}: ${t.def.name} loses all abilities`); }
    }),
    // "Avatar with no ability in its Text Box, or no Text Box": engine noAbilityNow (tokens, no text, or abilities removed
    // now: this card's own ability, เชาว์ปัญญาลิง, Skill : Hypersense ...; user 2026-10-22)
    aura: (g, s, t) => (byTraveler(s) && P(g, s.ctrl).avatars.includes(s) && g.p.some((q) => q.avatars.includes(t)) && noAbilityNow(g, t)
      ? -Math.floor(hellMagic(g, s.ctrl) / 2) : 0),
  },
  'ฮองตง ขุนพลอาวุโสแห่งจ๊กก๊ก': {
    keep: 4,
    jutsu: (g, c) => { fromZoneSummon(g, c.ctrl, P(g, c.ctrl).hell, (x) => named(x, 'เล่าปี่') && symIs(x, 'ต่างชาติ'), 'effect'); },
    staticPower: (g, c) => (P(g, c.ctrl).avatars.filter((a) => named(a, 'ขุนพล') && colorIs(a, 'เขียว') && symIs(a, 'ต่างชาติ')).length >= 3 ? 5 - c.def.power : 0),
    getActive: (g: Game, self: Card) => P(g, self.ctrl).avatars.filter((a) => named(a, 'ขุนพล') && colorIs(a, 'เขียว') && symIs(a, 'ต่างชาติ')).length >= 3 && 'POWER ตั้งต้น 5',
  },
  'เนอมัส มังกรแห่งป่าไร้เงา': {
    keep: 4,
    untargetable: (g, c, attacker) => P(g, c.ctrl).avatars.some((a) => a !== c && beast(a)) && (!attacker || attacker.ctrl !== c.ctrl),
    noTarget: (g: Game, self: Card, t: Card, by: Card) => t === self && by.def.type === 'Magic' && by.ctrl !== self.ctrl && P(g, self.ctrl).avatars.some((a) => a !== self && beast(a)),
    getActive: (g: Game, self: Card) => P(g, self.ctrl).avatars.some((a) => a !== self && beast(a)) && 'ถูกโจมตีไม่ได้ / Magic ฝ่ายตรงข้ามเลือกไม่ได้',
    battle: fight('คน'),
  },
  'กุนซือลงสนาม': {
    keep: 3.5,
    canCast: (g, p) => canPlaceAvatar(P(g, p)) && onlyGenerals(g, p).some((s) => advisors(g, p, s).length > 0),
    resolve: (g, p, c) => {
      const shown = best(onlyGenerals(g, p).filter((s) => advisors(g, p, s).length > 0), (s) => Math.max(...advisors(g, p, s).map((x) => value(g, x))));
      if (!shown) return;
      log(g, `P${p} reveals ${shown.def.name}`);
      const x = best(advisors(g, p, shown), (y) => value(g, y));
      if (x && canPlaceAvatar(P(g, p), false, x) && summon(g, p, x, 'jutsu') && P(g, p).avatars.includes(x)) addName(g, x, 'ขุนพล');
      shuffle(g, P(g, p).deck);
    },
  },
} as Record<string, Fx>);
for (const n of STORY12) if (FX[n]) FX[n].handActs = storyHandActs(n);

// ===== BT12 second batch (worker "bt12b", 2026-10-20): BT12-005, 007, 020, 056, 072 =====
// Report: v14/reports/bt12b.md. In-text icons read from the pictures: 005 = หุ่นยนต์ / กะปอม / เอเลี่ยน / ต่างชาติ;
// 072 = มังกร / ต้นไม้ / สัตว์มหัศจรรย์ (unicorn). Text spellings "ทุ่ย" = กุ่ย, "บาย" = นาย (ALIAS above).
import { grantKw, humanDeciding, decide } from '../engine.ts';
import type { Kw } from '../engine.ts';
import { grantGet } from '../view.ts';
const KW_BY_SYM: [string, Kw, string][] = [['หุ่นยนต์', 'shield', 'โล่มนุษย์'], ['กะปอม', 'unite', 'สามัคคี'], ['เอเลี่ยน', 'backstab', 'แทงหลัง'], ['ต่างชาติ', 'tieWin', 'ลูกฮึด']];
const guiNai = (g: Game, p: PID, self: Card) => P(g, p).avatars.some((a) => a !== self && (word(a, 'กุ่ย') || word(a, 'นาย')));
const RUIN_SYMS = ['มังกร', 'ต้นไม้', 'สัตว์มหัศจรรย์', 'สัตว์วิเศษ'];
const ruinSym = (a: Card) => isA(a) && RUIN_SYMS.some((s) => symIs(a, s));
/** the human always may cast; the bot only when its simple rule says so (look-ahead copies count as the bot) */
const humanOr = (g: Game, p: PID, bot: () => boolean) => decide(g, p, () => humanDeciding(g)) || bot();
function noCareWants(g: Game, p: PID, self: Card): boolean {
  const mine = P(g, p).hand.filter((x) => x !== self), theirs = P(g, opp(p)).hand;
  if (P(g, p).deck.length <= mine.length + 3) return false; // never risk drawing out ourselves
  if (theirs.length > 0 && P(g, opp(p)).deck.length <= theirs.length) return true; // they draw their last card and lose
  if (!mine.length) return theirs.length >= 4; // free: only their hand is reshuffled
  const avg = mine.reduce((s, x) => s + keepValue(g, x), 0) / mine.length;
  return avg < 2.5 || (theirs.length >= 6 && mine.length <= 2);
}
Object.assign(FX, {
  'ภาคีสะพานเหล็ก': {
    keep: 2,
    // "เมื่อการ์ดใบนี้ถูกใช้เป็นค่า Cost เพื่ออัญเชิญ Avatar": the summoned Avatar gains a keyword by its Symbol while it stays
    // on the field (grantKw with no end; c.f is cleared when it leaves). Several Symbols = several keywords.
    usedAsCost: (g, p, c, s) => {
      if (!isA(s) || !P(g, p).avatars.includes(s)) return;
      const got: string[] = [];
      for (const [sym, kw, th] of KW_BY_SYM) if (symIs(s, sym)) { grantKw(g, s, kw, 1e9); got.push(th); }
      if (!got.length) return;
      grantGet(g, s, `ภาคีสะพานเหล็ก: ได้รับ ${got.join(', ')}`);
      log(g, `${c.def.name}: ${s.def.name} gains ${got.join(', ')}`);
    },
  },
  'นาย นักเวทย์': {
    keep: 3, unite: true,
    // two separate lines: -1 with "กุ่ย" (text: ทุ่ย) and -1 with "ฮอล" on our field; they stack
    costMod: (g: Game, self: Card, t: Card) => {
      if (t !== self || !P(g, self.owner).hand.includes(self)) return 0;
      const av = P(g, self.owner).avatars;
      return (av.some((a) => word(a, 'กุ่ย')) ? -1 : 0) + (av.some((a) => word(a, 'ฮอล')) ? -1 : 0);
    },
  },
  'ฮอล นักบวช': {
    keep: 3, unite: true,
    onAttack: (g, c) => {
      if (!P(g, c.ctrl).avatars.includes(c) || !guiNai(g, c.ctrl, c)) return;
      addPower(g, c, 2, 'turn', c);
      log(g, `${c.def.name}: POWER +2 until end of turn (attacks with "กุ่ย"/"นาย")`);
    },
    // "ใช้ความสามารถ สามัคคี" (user 2026-10-20: the +2 comes BEFORE it helps, so the helped Avatar gets ฮอล's boosted POWER)
    assistBonus: (g: Game, u: Card, _to: Card, kind: 'unity' | 'backstab') =>
      kind === 'unity' && P(g, u.ctrl).avatars.includes(u) && guiNai(g, u.ctrl, u) ? 2 : 0,
    getActive: (g: Game, self: Card) => guiNai(g, self.ctrl, self) && 'กุ่ย/นาย: โจมตี หรือ สามัคคี = POWER +2',
  },
  'ไม่สนจั่วอยู่ดี': {
    keep: 2,
    canCast: (g, p, c) => g.turn > 1 && humanOr(g, p, () => noCareWants(g, p, c)),
    resolve: (g, p) => {
      const order: PID[] = [p, opp(p)];
      const n = order.map((q) => { const xs = [...P(g, q).hand]; for (const x of xs) discard(g, q, x); return xs.length; });
      log(g, `ไม่สนจั่วอยู่ดี: P${order[0]} discards ${n[0]}, P${order[1]} discards ${n[1]}`);
      for (let i = 0; i < 2; i++) { if (g.winner !== null) return; if (n[i]) draw(g, order[i], n[i]); } // caster draws first
    },
  },
  'อารยธรรมที่พังทลาย': {
    keep: 2.5,
    canCast: (g, p) => humanOr(g, p, () => P(g, p).avatars.filter(ruinSym).length > P(g, opp(p)).avatars.filter(ruinSym).length),
    landPower: (g, l, a) => (ruinSym(a) ? 1 : 0), // both players' Avatars (no "ฝ่ายเรา" in the text)
  },
} as Record<string, Fx>);
