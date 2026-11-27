// Card effects for CC03 (Card Collection 03), added 2026-11-23 from bottcg's card data (user: "update the new cards").
// Reprints in CC03 share their effect with the older card of the same name (effects are keyed by name);
// "ผู้เจริญนาย" / "สว. นาโนแมชชีน" are stored under the game's older spelling (ผู้เจริญ นาย, สว นาโนแมชชีน).
// Approximations are marked "approx:".
import type { Card, Game, PID } from '../types.ts';
import type { Fx, HandAct } from '../cards.ts';
import { FX, RULES, value, best, worst, pickN, mayDo, chooseMode, inMain } from '../cards.ts';
import {
  P, opp, power, draw, destroy, toHell, toExile, toDeck, toHand, discard, detach, summon, shuffle, mill,
  canPlaceAvatar, onceUsed, markOnce, keepValue, log, findCard, uniqueBlocked, symIs, colorIs, scoutDeck, putBottom,
  addPower, addRule, RULE_GAME, landIs, attach, canWear, rest, assignSlots, bestPayment, choosePayment, costOf, gemOf,
  currentSource, lifeDown, flippedLife, grantKw, humanDeciding, addToHand, currentFight, takeControl,
} from '../engine.ts';

// ---------- helpers ----------
const isA = (c: Card) => c.def.type === 'Avatar' || c.def.type === 'Token';
function named(c: Card, key: string): boolean {
  if (c.def.aka && c.def.aka.some((a) => a.includes(key))) return true;
  if (c.def.name.includes(key)) return true;
  const f = FX[c.def.name];
  return !!(f && f.alias && f.alias.some((a) => a.includes(key)));
}
const once = (g: Game, p: PID, key: string) => !onceUsed(g, P(g, p), key);
const use = (g: Game, p: PID, key: string) => markOnce(g, P(g, p), key);
const act = (label: string, can: (g: Game) => boolean, run: (g: Game) => void): HandAct => ({ label, can, run });
const onField = (g: Game, c: Card) => P(g, c.ctrl).avatars.includes(c);
/** The player picks one card (bot: best score). Mandatory unless optional. */
const pick1 = (xs: Card[], score: (x: Card) => number, title: string, optional = false): Card | null =>
  pickN(xs, 1, score, { title, optional })[0] || null;
/** The player picks n hand cards to discard (bot: the least wanted). */
function discardPick(g: Game, p: PID, n: number, title: string, except: Card[] = []): boolean {
  const pool = P(g, p).hand.filter((x) => !except.includes(x));
  if (pool.length < n) return false;
  const ds = pickN(pool, n, (x) => -keepValue(g, x), { title });
  if (ds.length < n) return false;
  for (const d of ds) discard(g, p, d);
  return true;
}
/** Any card on the field (both players): Avatars, their attached cards, Magic Zones (incl. Constructs), the Land. */
function fieldCards(g: Game): Card[] {
  const out: Card[] = [];
  for (const q of g.p) { out.push(...q.avatars); for (const a of q.avatars) out.push(...a.mods); out.push(...q.mz); }
  if (g.land && !out.includes(g.land)) out.push(g.land);
  return out;
}
/** Bot score for destroying a field card as player p: the opponent's best cards first, never our own if avoidable. */
const killScore = (g: Game, p: PID, x: Card) => (x.ctrl !== p && x.owner !== p ? 20 + (isA(x) ? value(g, x) : 2) : -10 - (isA(x) ? value(g, x) : 1));
const notOnly = (x: Card) => !x.def.only;

// ===== 1. พระอิศวร ผู้เมตตา / พระนารายณ์ ผู้คุ้มครอง =====
import { inLink as inLinkG11 } from '../engine.ts'; // 2026-11-27
import { shivaDestroy as shivaDestroyG11 } from './g6.ts';
const ISHVARA = 'พระอิศวร ผู้เมตตา';
const NARAI = 'พระนารายณ์ ผู้คุ้มครอง';
const SAFE = 'lg:' + ISHVARA;
/** "ไม่ถูกทำลายจากความสามารถการ์ด": a destroy that is not the result of a fight (and not a cost) is stopped. */
const noAbilityDestroy = (pred: (g: Game, self: Card, t: Card) => boolean): Fx['leaveGuard'] => (g, self, t, info) =>
  (info.how === 'destroy' && !info.battle && !info.cost && pred(g, self, t) ? { optional: false, label: 'not destroyed by card abilities', run: () => true } : null);

// ===== 2. the 4 "สัตว์วิเศษ" jewels: scout 2, X = 2 x Avatars seen, return a Cost <= X Avatar of their colour from Hell =====
function jewelJutsu(color: string): Fx['jutsu'] {
  return (g, c) => {
    const p = c.ctrl, pl = P(g, p);
    scoutDeck(g, p, 2, (top) => {
      const x = top.filter(isA).length * 2;
      const pool = pl.hell.filter((y) => isA(y) && colorIs(y, color) && y.def.cost <= x && notOnly(y));
      log(g, `${c.def.name}: ${top.filter(isA).length} Avatar(s) seen, X = ${x}`);
      const t = pick1(pool, (y) => keepValue(g, y) + y.def.power * 0.3, `${c.def.name}: return an Avatar (Cost ${x} or less) from your Hell to hand`);
      if (t) addToHand(g, t, p, { from: 'hell' });
    }, 'bottom', c.def.name);
  };
}

// ===== 3. Super Air =====
const PLANE = 'เครื่องบิน Super Air';
const isPlane = (x: Card) => x.def.name === PLANE || (x.def as any).orig?.name === PLANE;
RULES['โทนี่'] = { label: 'one more "เครื่องบิน Super Air" this turn (คุณโทนี่)', extraMagic: (g, r, m) => m.def.name === PLANE && P(g, r.p).avatars.some((a) => a.def.name === 'คุณโทนี่ เด็กช่าง Super Air') };
function tonyRule(g: Game, p: PID) {
  if ((g.rules || []).some((r) => r.p === p && r.key === 'โทนี่' && r.until === g.turn)) return;
  (g.rules ||= []).push({ p, key: 'โทนี่', until: g.turn, n: 1 }); // quiet (no log line every turn)
}

// ===== 4. รองเท้ากินขา (End Phase: it and its wearer go to Hell) =====
RULES['รองเท้ากินขา'] = {
  label: 'รองเท้ากินขา: End Phase, to Hell with its wearer',
  endPhase: (g, r) => {
    const m = findCard(g, r.n ?? -1);
    if (!m || m.wearer < 0) return;
    const w = findCard(g, m.wearer);
    if (!w) return;
    log(g, `รองเท้ากินขา: End Phase, ${w.def.name} and รองเท้ากินขา go to Hell`);
    toHell(g, w, { src: m, by: m.owner });
    if (findCard(g, m.uid) && !P(g, m.owner).hell.includes(m)) toHell(g, m, { src: m, by: m.owner });
  },
};

// ===== 5. การ์ดร่วงก็เอาไปทิ้งงงง!!!! (this turn, cards milled go to the Dark Dimension instead) =====
RULES['การ์ดร่วง'] = { label: 'cards sent from a Deck to Hell are banished instead (การ์ดร่วงก็เอาไปทิ้งงงง!!!!)' };
const dropRuleOn = (g: Game) => (g.rules || []).some((r) => r.key === 'การ์ดร่วง' && r.until === g.turn);

const SNOWQ = 'ราชินีหิมะ';

Object.assign(FX, {
  // CC03-001: จุติ: summon พระนารายณ์ ผู้คุ้มครอง from hand or Deck (shuffle if from Deck); it can't be destroyed by card
  // abilities until end of turn. [Link พระนารายณ์ ผู้คุ้มครอง]. Once a turn: destroy a card on the field, then you may give
  // another of your Avatars POWER +2 until end of turn.
  [ISHVARA]: {
    keep: 6,
    jutsu: (g, c) => {
      const p = c.ctrl, pl = P(g, p);
      if (!canPlaceAvatar(pl)) return;
      const pool = [...pl.hand, ...pl.deck].filter((x) => x.def.name === NARAI && !uniqueBlocked(g, p, x));
      const t = pick1(pool, (x) => (pl.hand.includes(x) ? 0 : 1), `${ISHVARA}: summon ${NARAI} (hand or Deck)`);
      if (!t) return;
      const fromDeck = pl.deck.includes(t);
      if (summon(g, p, t, 'effect') && onField(g, t)) { t.f[SAFE] = g.turn; log(g, `${NARAI} can't be destroyed by card abilities this turn`); }
      if (fromDeck) shuffle(g, pl.deck);
    },
    leaveGuard: noAbilityDestroy((g, self, t) => (t.f[SAFE] || 0) >= g.turn && t.ctrl === self.ctrl),
    // user 2026-11-27: this ability sits under [Link พระนารายณ์ ผู้คุ้มครอง]: it can be used only while in Link
    fieldActs: (g, p, c) => [act(`${ISHVARA}: destroy a card on the field`, (g2) => inMain(g2, p) && onField(g2, c) && inLinkG11(g2, c) && once(g2, p, 'ishvara:' + c.uid)
      && (humanDeciding(g2) || fieldCards(g2).some((x) => x.ctrl !== p && x.owner !== p)),
    (g2) => {
      use(g2, p, 'ishvara:' + c.uid);
      shivaDestroyG11(g2, p, false, `${ISHVARA}: destroy a card on the field`); // 2026-11-27: Magic Zone cards / Land too
      const others = P(g2, p).avatars.filter((a) => a !== c);
      if (!others.length) return;
      const b = pick1(others, (a) => (a.asleep ? 0 : 3) + power(g2, a), `${ISHVARA}: another Avatar POWER +2 until end of turn (optional)`, true);
      if (b) addPower(g2, b, 2, 'turn', c);
    })],
  } as Fx,
  // CC03-002: โล่มนุษย์, [Link พระอิศวร ผู้เมตตา], can't be destroyed by card abilities.
  [NARAI]: {
    keep: 4, shield: true,
    leaveGuard: noAbilityDestroy((g, self, t) => t === self && onField(g, self)),
  } as Fx,

  // CC03-003: once a turn, banish a {เทพ} card from our Hell: scout 3, take a {เทพ} Avatar to hand, shuffle.
  // From Hell, in our End Phase, if one of our {เทพ} Avatars destroyed an opposing Avatar in a fight this turn, banish this:
  // return another {เทพ} Avatar from our Hell to hand (if it is an {only}, discard 1).
  'พระอินทร์ ผู้ช่วยเหลือ': {
    keep: 3,
    fieldActs: (g, p, c) => [act('พระอินทร์: banish a เทพ card from Hell, scout 3', (g2) => inMain(g2, p) && onField(g2, c) && once(g2, p, 'indra:' + c.uid)
      && P(g2, p).hell.some((x) => symIs(x, 'เทพ')) && P(g2, p).deck.length >= 3,
    (g2) => {
      use(g2, p, 'indra:' + c.uid);
      const x = pick1(P(g2, p).hell.filter((y) => symIs(y, 'เทพ')), (y) => -keepValue(g2, y), 'พระอินทร์: banish a {เทพ} card from your Hell');
      if (!x || !toExile(g2, x, { cost: true })) return;
      scoutDeck(g2, p, 3, (top) => {
        const t = pick1(top.filter((y) => isA(y) && symIs(y, 'เทพ')), (y) => keepValue(g2, y), 'พระอินทร์: take a {เทพ} Avatar');
        if (t) { top.splice(top.indexOf(t), 1); P(g2, p).hand.push(t); log(g2, `พระอินทร์: ${t.def.name} to hand`); }
      }, 'shuffle', 'พระอินทร์');
    })],
    hellEndPhase: (g, c) => {
      const p = c.owner, pl = P(g, p);
      if (g.active !== p || pl.once['godKill'] !== g.turn) return;
      const pool = pl.hell.filter((x) => isA(x) && symIs(x, 'เทพ') && x.def.name !== c.def.name);
      if (!pool.length || !mayDo(g, c, 'พระอินทร์ (Hell): banish it, return a {เทพ} Avatar from Hell to hand', true)) return;
      detach(g, c); pl.exile.push(c);
      const t = pick1(pool, (x) => keepValue(g, x) + x.def.power * 0.3, 'พระอินทร์: return a {เทพ} Avatar from Hell to hand');
      if (!t || !addToHand(g, t, p, { from: 'hell' })) return;
      if (t.def.only) discardPick(g, p, 1, 'พระอินทร์: discard 1 (an {only} came back)');
    },
  } as Fx,

  // CC03-004: from hand, when one of our other "ไมเกรน" Avatars is sent to Hell in the opponent's turn: summon this and attach
  // an "อาวุธหุ่นนักรบผู้กล้า" Modification from our Hell to it. Start of our Battle Phase, POWER 6+: send this to Hell:
  // summon a "ไมเกรน" (base POWER <= this one's POWER) from our Hell; this card's attached cards move to it. Unique.
  'หุ่นนักรบผู้กล้า : โพสโดรมไมเกรน': {
    keep: 4, unique: true,
    onAnyLeave: (g, self, gone, info) => {
      const p = self.owner, pl = P(g, p);
      if (!pl.hand.includes(self) || g.active === p || info.ctrl !== p || info.zone !== 'avatars' || info.to !== 'hell') return;
      if (!isA(gone) || !named(gone, 'ไมเกรน') || gone.def.name === self.def.name) return;
      if (!canPlaceAvatar(pl) || uniqueBlocked(g, p, self) || !mayDo(g, self, `${self.def.name}: summon it (a ไมเกรน went to Hell)`, true)) return;
      if (!summon(g, p, self, 'own') || !onField(g, self)) return;
      const w = pick1(pl.hell.filter((x) => x.def.subtype === 'Modification' && named(x, 'อาวุธหุ่นนักรบผู้กล้า') && canWear(g, x, self)), (x) => keepValue(g, x), `${self.def.name}: attach an อาวุธหุ่นนักรบผู้กล้า from Hell`);
      if (w) attach(g, w, self);
    },
    startBattle: (g, c) => {
      const p = c.ctrl, pl = P(g, p);
      if (g.active !== p || !onField(g, c)) return;
      const pw = power(g, c);
      if (pw < 6) return;
      const pool = pl.hell.filter((x) => isA(x) && named(x, 'ไมเกรน') && x.def.power <= pw && x.def.name !== c.def.name);
      if (!pool.length || !mayDo(g, c, `${c.def.name}: send it to Hell, summon a ไมเกรน (POWER ${pw} or less) from Hell`, pool.some((x) => x.def.power >= 6))) return;
      const mods = [...c.mods];
      for (const m of mods) detach(g, m);
      if (!toHell(g, c, { cost: true })) { for (const m of mods) attach(g, m, c, false); return; }
      const t = pick1(pool.filter((x) => pl.hell.includes(x)), (x) => x.def.power, `${c.def.name}: summon a ไมเกรน from Hell`);
      if (t && summon(g, p, t, 'effect') && onField(g, t)) { for (const m of mods) if (!attach(g, m, t)) pl.hell.push(m); }
      else for (const m of mods) pl.hell.push(m);
    },
  } as Fx,

  // CC03-005/012/018/023: jewel cards (see jewelJutsu)
  'รูบิน่า': {
    keep: 3, jutsu: jewelJutsu('แดง'),
    staticPower: (g, c) => (P(g, c.ctrl).avatars.length >= 4 ? 5 - c.def.power : 0), // base POWER becomes 5
  } as Fx,
  'ลอร์ดแซฟไฟร์': {
    keep: 3, jutsu: jewelJutsu('ฟ้า'),
    onAnyDestroyed: (g, self, gone, info) => {
      const p = self.ctrl;
      if (!onField(g, self) || info.ctrl === p || info.zone !== 'avatars' || !isA(gone) || !once(g, p, 'sapphire:' + self.uid)) return;
      use(g, p, 'sapphire:' + self.uid); log(g, 'ลอร์ดแซฟไฟร์: an opposing Avatar was destroyed, draw 1'); draw(g, p, 1);
    },
  } as Fx,
  'อเมทิสโต้': {
    keep: 3, jutsu: jewelJutsu('ม่วง'),
    fieldActs: (g, p, c) => [act('อเมทิสโต้: scout 3, order them on top', (g2) => inMain(g2, p) && onField(g2, c) && once(g2, p, 'amethyst:' + c.uid) && P(g2, p).deck.length >= 2
      && humanDeciding(g2),
    (g2) => { use(g2, p, 'amethyst:' + c.uid); scoutDeck(g2, p, 3, () => {}, 'top', 'อเมทิสโต้'); })],
  } as Fx,
  'บักเจด': {
    keep: 3, jutsu: jewelJutsu('เขียว'),
    fieldActs: (g, p, c) => [act('บักเจด: rest it, an Avatar can\'t be chosen by opposing Magic this turn', (g2) => inMain(g2, p) && onField(g2, c) && !c.asleep && once(g2, p, 'jade:' + c.uid)
      && humanDeciding(g2),
    (g2) => {
      use(g2, p, 'jade:' + c.uid); rest(g2, c);
      const t = pick1(P(g2, p).avatars, (a) => value(g2, a), 'บักเจด: this Avatar can\'t be chosen by opposing Magic this turn');
      if (t) { t.f.jadeSafe = g2.turn; log(g2, `${t.def.name} can't be chosen by opposing Magic this turn`); }
    })],
    // approx: the protection is read while a บักเจด is in play
    noTarget: (g, self, t, by) => t.f.jadeSafe === g.turn && by.def.type === 'Magic' && by.ctrl !== t.ctrl,
  } as Fx,

  // CC03-006: โล่มนุษย์. From hand, banish a "กุ่ย", a "ฮอล" and a "นาย" from our field or Hell: summon this. Our End Phase:
  // it wakes up. Only summoned by its own ability.
  'วีรบุรุษหน้าตาดี': {
    keep: 4, shield: true, noHandSummon: true,
    summonIf: (g, p, c, how) => how === 'own',
    handActs: (g, p, c) => [act('วีรบุรุษหน้าตาดี: banish กุ่ย, ฮอล and นาย: summon it', (g2) => inMain(g2, p) && P(g2, p).hand.includes(c) && canPlaceAvatar(P(g2, p))
      && heroTrio(g2, p) !== null,
    (g2) => {
      const pl = P(g2, p), chosen: Card[] = [];
      for (const k of ['กุ่ย', 'ฮอล', 'นาย']) {
        const pool = heroPool(g2, p).filter((x) => named(x, k) && !chosen.includes(x));
        const t = pick1(pool, (x) => (pl.hell.includes(x) ? 5 : 0) - value(g2, x), `วีรบุรุษหน้าตาดี: banish a "${k}" (field or Hell)`);
        if (!t) return;
        chosen.push(t);
      }
      for (const x of chosen) toExile(g2, x, { cost: true });
      summon(g2, p, c, 'own');
    })],
    endPhase: (g, c) => { if (c.asleep) { c.asleep = false; log(g, 'วีรบุรุษหน้าตาดี wakes up (End Phase)'); } },
  } as Fx,

  // CC03-007: once a turn (one อธีน่า per turn), choose: 1) one of our {เทพ} or Cost <= 2 Avatars gains สามัคคี;
  // 2) discard 1: summon a non-purple Cost <= 2 Avatar from our Hell.
  'อธีน่า เทพีปัญญาแห่งโอลิมปัส': {
    keep: 3,
    fieldActs: (g, p, c) => [
      act('อธีน่า: give สามัคคี', (g2) => inMain(g2, p) && onField(g2, c) && once(g2, p, 'athena') && P(g2, p).avatars.some((a) => symIs(a, 'เทพ') || a.def.cost <= 2),
        (g2) => {
          use(g2, p, 'athena');
          const t = pick1(P(g2, p).avatars.filter((a) => symIs(a, 'เทพ') || a.def.cost <= 2), (a) => power(g2, a), 'อธีน่า: this Avatar gains สามัคคี');
          if (t) { grantKw(g2, t, 'unite' as any, RULE_GAME); log(g2, `${t.def.name} gains สามัคคี`); } // no duration printed: while it stays
        }),
      act('อธีน่า: discard 1, summon a Cost 2 or less Avatar from Hell', (g2) => inMain(g2, p) && onField(g2, c) && once(g2, p, 'athena') && P(g2, p).hand.length >= 1
        && canPlaceAvatar(P(g2, p)) && athenaPool(g2, p).length > 0,
        (g2) => {
          use(g2, p, 'athena');
          if (!discardPick(g2, p, 1, 'อธีน่า: discard 1')) return;
          const t = pick1(athenaPool(g2, p), (x) => value(g2, x), 'อธีน่า: summon an Avatar from Hell');
          if (t) summon(g2, p, t, 'effect');
        }),
    ],
  } as Fx,

  // CC03-008: โล่มนุษย์; our End Phase: POWER -1 (stays). Unique.
  'เอาไมส์ ฮีโร่แห่งความหวั่นไหว': {
    keep: 3, shield: true, unique: true,
    endPhase: (g, c) => { addPower(g, c, -1, 'perm', c); },
  } as Fx,

  // CC03-009: from hand, reveal this and 3 differently named "หิมะ" Avatars (at least one "ราชินีหิมะ"): summon it; with 8+
  // "ทหารหิมะ" in our Hell, you may also summon a "ราชินีหิมะ" from hand. When summoned: destroy a card on the field.
  // Can't be destroyed by opposing card abilities; while we have a "ราชินีหิมะ", its control can't change.
  // Only summoned by a "หิมะ" card's ability.
  'มังกรราชาหิมะ เสวี่ย หลง': {
    keep: 5, noHandSummon: true,
    summonIf: (g, p, c, how) => how === 'own' || (() => { const s = currentSource(); return !!s && s !== c && named(s, 'หิมะ'); })(),
    handActs: (g, p, c) => [act('เสวี่ย หลง: reveal 3 หิมะ Avatars: summon it', (g2) => inMain(g2, p) && P(g2, p).hand.includes(c) && canPlaceAvatar(P(g2, p)) && snowReveal(g2, p, c) !== null,
      (g2) => {
        const pl = P(g2, p), shown: Card[] = [];
        const snow = () => pl.hand.filter((x) => x !== c && isA(x) && named(x, 'หิมะ') && !shown.some((y) => y.def.name === x.def.name));
        const q = pick1(snow().filter((x) => named(x, SNOWQ)), (x) => -value(g2, x), 'เสวี่ย หลง: reveal a ราชินีหิมะ');
        if (!q) return;
        shown.push(q);
        for (let i = 0; i < 2; i++) { const x = pick1(snow(), (y) => -value(g2, y), 'เสวี่ย หลง: reveal a หิมะ Avatar'); if (!x) return; shown.push(x); }
        log(g2, `P${p} reveals ${c.def.name}, ${shown.map((x) => x.def.name).join(', ')}`);
        if (!summon(g2, p, c, 'own')) return;
        if (pl.hell.filter((x) => named(x, 'ทหารหิมะ')).length >= 8 && canPlaceAvatar(pl)) {
          const qs = pl.hand.filter((x) => isA(x) && named(x, SNOWQ) && !uniqueBlocked(g2, p, x));
          const t = qs.length && mayDo(g2, c, 'เสวี่ย หลง: also summon a ราชินีหิมะ from hand', true) ? pick1(qs, (x) => value(g2, x), 'summon a ราชินีหิมะ') : null;
          if (t) summon(g2, p, t, 'effect');
        }
      })],
    onSummon: (g, c) => {
      const t = pick1(fieldCards(g).filter((x) => x !== c), (x) => killScore(g, c.ctrl, x), 'เสวี่ย หลง: destroy a card on the field');
      if (t) destroy(g, t, c.ctrl);
    },
    leaveGuard: noAbilityDestroy((g, self, t) => t === self && onField(g, self) && (() => { const s = currentSource(); return !!s && s.ctrl !== self.ctrl; })()),
    noSteal: true, // approx: the "while we have a ราชินีหิมะ" condition is checked in noStealIf
    noStealIf: (g: Game, c: Card) => P(g, c.ctrl).avatars.some((a) => named(a, SNOWQ)),
  } as Fx,

  // CC03-010: จุติ: scout 3, summon a "สิ่งปฏิกูล" Avatar from them, the rest to Hell. When it is summoned by a "สิ่งปฏิกูล"
  // card's ability: do the จุติ.
  'สิ่งปฏิกูลสีชมพู': {
    keep: 3,
    jutsu: (g, c) => pinkSewage(g, c),
    onSummon: (g, c, how) => {
      if (how === 'paid' || how === 'jutsu') return;
      const s = currentSource();
      if ((s && s !== c && named(s, 'สิ่งปฏิกูล')) || P(g, c.ctrl).once['sewage:' + c.uid] === g.turn) pinkSewage(g, c);
    },
  } as Fx,

  // CC03-011: จุติ, if a "บึงทมิฬ" Land is out: an Avatar falls asleep, then every asleep Avatar on both Avatar Zones is destroyed.
  'บึงทมิฬ People - คุณชาร์คว้าว': {
    keep: 3,
    jutsu: (g, c) => {
      if (!landIs(g, 'บึงทมิฬ')) { log(g, `${c.def.name}: no บึงทมิฬ Land, จุติ does nothing`); return; }
      const p = c.ctrl;
      const all = [...P(g, p).avatars, ...P(g, opp(p)).avatars];
      const t = pick1(all.filter((a) => !a.asleep), (a) => (a.ctrl !== p ? 10 + value(g, a) : -value(g, a)), `${c.def.name}: put an Avatar to sleep`);
      if (t) rest(g, t);
      for (const a of [...P(g, p).avatars, ...P(g, opp(p)).avatars]) if (a.asleep) destroy(g, a, p);
    },
  } as Fx,

  // CC03-013: may summon it from hand sending a "นายนิรยบาล" from our Deck to Hell, counting that Avatar's GEM as paid.
  // จุติ: summon a "นายนิรยบาล" with Cost 4 or less from our Hell.
  'หัวหน้านายนิรยบาล พญายม': {
    keep: 4,
    handActs: (g, p, c) => [act('พญายม: summon it, a นายนิรยบาล from your Deck pays GEM', (g2) => inMain(g2, p) && P(g2, p).hand.includes(c) && canPlaceAvatar(P(g2, p))
      && !uniqueBlocked(g2, p, c) && P(g2, p).deck.some((x) => yamaPay(g2, p, c, x) !== null),
    (g2) => {
      const pl = P(g2, p);
      const x = pick1(pl.deck.filter((y) => yamaPay(g2, p, c, y) !== null), (y) => gemOf(g2, y, c), 'พญายม: send a นายนิรยบาล from your Deck to Hell (its GEM pays)');
      if (!x) return;
      const due = Math.max(0, costOf(g2, p, c) - gemOf(g2, x, c));
      const pay = due > 0 ? choosePayment(g2, p, due, [c], c) : [];
      if (!pay) return;
      detach(g2, x); pl.hell.push(x); shuffle(g2, pl.deck);
      log(g2, `พญายม: ${x.def.name} from the Deck pays ${gemOf(g2, x, c)} GEM`);
      summon(g2, p, c, 'paid', pay, due);
    })],
    jutsu: (g, c) => {
      const pl = P(g, c.ctrl);
      if (!canPlaceAvatar(pl)) return;
      const t = pick1(pl.hell.filter((x) => isA(x) && named(x, 'นายนิรยบาล') && x.def.cost <= 4 && !uniqueBlocked(g, c.ctrl, x)), (x) => value(g, x), 'พญายม: summon a นายนิรยบาล (Cost 4 or less) from Hell');
      if (t) summon(g, c.ctrl, t, 'effect');
    },
  } as Fx,

  // CC03-014: ลูกฮึด. จุติ: a Magic with "ไอ้นัท" or "เซอร์นัท" in its text from our Deck to hand, shuffle.
  'พีแมน อัศวินตลิ่งชันแห่งแดนปลาดิบ': {
    keep: 3, tieWin: true,
    jutsu: (g, c) => {
      const pl = P(g, c.ctrl);
      const t = pick1(pl.deck.filter((x) => x.def.type === 'Magic' && /ไอ้นัท|เซอร์นัท/.test(x.def.effect || '')), (x) => keepValue(g, x), 'พีแมน: a ไอ้นัท / เซอร์นัท Magic from your Deck to hand');
      if (t) addToHand(g, t, c.ctrl, { from: 'deck' });
      shuffle(g, pl.deck);
    },
  } as Fx,

  // CC03-015: once a turn, with โคกอีสานนูน on the Land: ธรณีสูบ any number: an "อีสานสลิงเกอร์" of ours gets POWER +1 for
  // every 3 cards milled this way, until end of turn.
  'อีสานสลิงเกอร์ ดิว': {
    keep: 3,
    fieldActs: (g, p, c) => [act('ดิว: ธรณีสูบ, อีสานสลิงเกอร์ POWER +1 per 3', (g2) => inMain(g2, p) && onField(g2, c) && once(g2, p, 'dew:' + c.uid) && !!landIs(g2, 'โคกอีสานนูน')
      && P(g2, p).deck.length >= 4 && (humanDeciding(g2) || P(g2, p).deck.length >= 15),
    (g2) => {
      use(g2, p, 'dew:' + c.uid);
      const room = P(g2, p).deck.length - 1;
      const opts = [3, 6, 9, 12, 1, 2].filter((n) => n <= room);
      const n = opts[chooseMode(g2, c, opts.map((k) => `ธรณีสูบ ${k}`), 0)] ?? 3;
      const got = mill(g2, p, n).length;
      const t = pick1(P(g2, p).avatars.filter((a) => named(a, 'อีสานสลิงเกอร์')), (a) => (a.asleep ? 0 : 3) + power(g2, a), 'ดิว: this อีสานสลิงเกอร์ gets the POWER');
      if (t && got >= 3) addPower(g2, t, Math.floor(got / 3), 'turn', c);
    })],
  } as Fx,

  // CC03-016: จุติ: every player shuffles and reveals their top card; result = GEM x POWER + Cost (0 if not an Avatar). The
  // highest: all their Avatars POWER +2, then every other player's Avatars are destroyed. A tie: nothing happens.
  'ครูแกง Big Brain': {
    keep: 3,
    jutsu: (g, c) => {
      const res: number[] = [];
      for (const q of g.p) {
        shuffle(g, q.deck);
        const top = q.deck[0];
        res.push(top && isA(top) ? (top.def.gem || 0) * (top.def.power || 0) + (top.def.cost || 0) : 0);
        log(g, `ครูแกง: P${q.id} reveals ${top ? top.def.name : '(empty Deck)'}: ${res[res.length - 1]}`);
      }
      if (res[0] === res[1]) { log(g, 'ครูแกง: a tie, nothing happens'); return; }
      const w = (res[0] > res[1] ? 0 : 1) as PID;
      for (const a of P(g, w).avatars) addPower(g, a, 2, 'perm', c);
      for (const a of [...P(g, opp(w)).avatars]) destroy(g, a, c.ctrl);
    },
  } as Fx,

  // CC03-017: จุติ, with 8+ differently named "แบงค์" Avatars in our Hell: banish an opposing Avatar. When it attacks:
  // ธรณีสูบ 1; if that is a "แบงค์" Avatar, you may give an opposing Avatar POWER -1.
  'แบงค์รางดาว': {
    keep: 3,
    jutsu: (g, c) => {
      const p = c.ctrl;
      const n = new Set(P(g, p).hell.filter((x) => isA(x) && named(x, 'แบงค์')).map((x) => x.def.name)).size;
      if (n < 8) { log(g, `แบงค์รางดาว: ${n} แบงค์ names in Hell (needs 8)`); return; }
      const t = pick1(P(g, opp(p)).avatars, (a) => value(g, a), 'แบงค์รางดาว: banish an opposing Avatar');
      if (t) toExile(g, t, { by: p, src: c });
    },
    onAttack: (g, c) => {
      const p = c.ctrl, got = mill(g, p, 1)[0];
      if (!got || !isA(got) || !named(got, 'แบงค์')) return;
      const t = pick1(P(g, opp(p)).avatars, (a) => value(g, a), 'แบงค์รางดาว: an opposing Avatar POWER -1 (optional)', true);
      if (t) addPower(g, t, -1, 'perm', c); // no duration printed: while it stays
    },
  } as Fx,

  // CC03-019: จุติ, banish a เครื่องบิน Super Air from our Hell: one from our Deck to hand, shuffle.
  // คำสั่งเสีย: may put a เครื่องบิน Super Air from our Dark Dimension under our Deck.
  'คุณแมมมอธ นักบิน Super Air': {
    keep: 3,
    jutsu: (g, c) => {
      const pl = P(g, c.ctrl);
      const h = pl.hell.find(isPlane), d = pl.deck.find(isPlane);
      if (!h || !d || !mayDo(g, c, `banish ${PLANE} from Hell: take one from your Deck`, true)) return;
      detach(g, h); pl.exile.push(h);
      addToHand(g, d, c.ctrl, { from: 'deck' }); shuffle(g, pl.deck);
    },
    deathCry: (g, c, owner) => {
      const pl = P(g, owner), x = pl.exile.find(isPlane);
      if (x && mayDo(g, c, `put ${PLANE} from your Dark Dimension under your Deck`, true)) { detach(g, x); pl.deck.push(x); log(g, `${PLANE} goes under the Deck`); }
    },
  } as Fx,

  // CC03-020: สามัคคี. จุติ: a เครื่องบิน Super Air from our Dark Dimension to hand. We may use one more เครื่องบิน Super Air
  // Magic each turn (RULES['โทนี่']).
  'คุณโทนี่ เด็กช่าง Super Air': {
    keep: 3, unite: true,
    jutsu: (g, c) => { const x = P(g, c.ctrl).exile.find(isPlane); if (x) { detach(g, x); P(g, c.ctrl).hand.push(x); log(g, `คุณโทนี่: ${PLANE} from the Dark Dimension to hand`); } },
    afterAction: (g, s) => { if (onField(g, s) && g.active === s.ctrl) tonyRule(g, s.ctrl); },
    mainStart: (g, s) => { if (onField(g, s) && g.active === s.ctrl) tonyRule(g, s.ctrl); },
  } as Fx,

  // CC03-021: from hand, send 2 "มะม่วง" {ต้นไม้} Avatars from our Magic Zone to Hell: summon it. With no "มะม่วง" {ต้นไม้}
  // Avatar on our Magic Zone it goes to Hell. Also counts as {มังกร} (data: syms).
  'จักรพรรดิมังกรแห่งภาคีมะม่วง': {
    keep: 5,
    handActs: (g, p, c) => [act('จักรพรรดิมังกร: send 2 มะม่วง from the Magic Zone to Hell: summon it', (g2) => inMain(g2, p) && P(g2, p).hand.includes(c) && canPlaceAvatar(P(g2, p))
      && !uniqueBlocked(g2, p, c) && P(g2, p).mz.filter(mzMango).length >= 2,
    (g2) => {
      const ms = pickN(P(g2, p).mz.filter(mzMango), 2, (x) => -keepValue(g2, x), { title: 'จักรพรรดิมังกร: send 2 มะม่วง from your Magic Zone to Hell' });
      if (ms.length < 2) return;
      for (const m of ms) toHell(g2, m, { cost: true });
      summon(g2, p, c, 'own');
    })],
    afterAction: (g, s) => {
      if (onField(g, s) && !P(g, s.ctrl).mz.some(mzMango)) { log(g, 'จักรพรรดิมังกร: no มะม่วง on the Magic Zone, it goes to Hell'); toHell(g, s, { by: null, src: s }); }
    },
  } as Fx,

  // CC03-022: once a turn, move it to the Magic Zone or back to the Avatar Zone. On the Avatar Zone, start of our Main Phase:
  // if one of our Avatars woke up this turn, our Avatars POWER +1 (this turn). On the Magic Zone, our End Phase: if one of our
  // Avatars fell asleep this turn, draw 1.
  'อามาเทราสึและสึคุโยมิ': {
    keep: 4,
    fieldActs: (g, p, c) => [
      act('อามาเทราสึ: move to the Magic Zone', (g2) => inMain(g2, p) && onField(g2, c) && once(g2, p, 'amaterasu:' + c.uid),
        (g2) => { use(g2, p, 'amaterasu:' + c.uid); const mods = [...c.mods]; for (const m of mods) { detach(g2, m); P(g2, m.owner).hell.push(m); } detach(g2, c); P(g2, p).mz.push(c); assignSlots(g2); log(g2, `${c.def.name} moves to the Magic Zone`); }),
      act('อามาเทราสึ: move to the Avatar Zone', (g2) => inMain(g2, p) && P(g2, p).mz.includes(c) && once(g2, p, 'amaterasu:' + c.uid) && canPlaceAvatar(P(g2, p)),
        (g2) => { use(g2, p, 'amaterasu:' + c.uid); detach(g2, c); P(g2, p).avatars.push(c); assignSlots(g2); log(g2, `${c.def.name} moves to the Avatar Zone`); }),
    ],
    onRestChange: (g, s, a, asleep) => { if (a.ctrl === s.ctrl) P(g, s.ctrl).once[asleep ? 'amaSlept' : 'amaWoke'] = g.turn; },
    mainStart: (g, s) => {
      const p = s.ctrl;
      if (g.active !== p || !onField(g, s) || P(g, p).once['amaWoke'] !== g.turn) return;
      log(g, 'อามาเทราสึ: an Avatar woke up this turn, our Avatars POWER +1');
      for (const a of P(g, p).avatars) addPower(g, a, 1, 'turn', s);
    },
    endPhase: (g, c) => { if (P(g, c.ctrl).mz.includes(c) && P(g, c.ctrl).once['amaSlept'] === g.turn) { log(g, 'อามาเทราสึ (Magic Zone): an Avatar fell asleep this turn, draw 1'); draw(g, c.ctrl, 1); } },
  } as Fx,

  // ===== Magic =====
  // CC03-041 (Normal): choose: 1) a ไอ้นัท of ours: send a "มีมมิ" from our Deck to Hell and equip "ดาบแห่งแสงอรุณ & นัทคาลิเบอร์"
  // from our Deck to it (counts as using a Modification), shuffle; 2) with a "ชาช่า" on our Avatar Zone: a "ไอ้นัท" or
  // "เซอร์นัท" Avatar from our Hell to hand.
  '～รักสุดแสนแค้นสุดใจ～': {
    keep: 3, options: 2,
    optLabels: ['ไอ้นัท + มีมมิ: equip นัทคาลิเบอร์', 'ชาช่า: ไอ้นัท / เซอร์นัท from Hell'],
    canCast: (g, p, c, o) => {
      const pl = P(g, p);
      if (o === 0) return !pl.used.Modification && pl.avatars.some((a) => named(a, 'ไอ้นัท')) && pl.deck.some((x) => named(x, 'มีมมิ')) && pl.deck.some(isNatSword);
      return pl.avatars.some((a) => named(a, 'ชาช่า')) && pl.hell.some((x) => isA(x) && (named(x, 'ไอ้นัท') || named(x, 'เซอร์นัท')));
    },
    resolve: (g, p, c, o) => {
      const pl = P(g, p);
      if (o === 0) {
        const n = pick1(pl.avatars.filter((a) => named(a, 'ไอ้นัท')), (a) => value(g, a), 'choose a ไอ้นัท');
        const m = pl.deck.find((x) => named(x, 'มีมมิ'));
        if (m) { detach(g, m); pl.hell.push(m); }
        const s = pl.deck.find(isNatSword);
        if (n && s && canWear(g, s, n)) { pl.used.Modification = true; attach(g, s, n); log(g, `${s.def.name} is equipped to ${n.def.name}`); }
        shuffle(g, pl.deck);
      } else {
        const t = pick1(pl.hell.filter((x) => isA(x) && (named(x, 'ไอ้นัท') || named(x, 'เซอร์นัท'))), (x) => keepValue(g, x), 'a ไอ้นัท / เซอร์นัท from Hell to hand');
        if (t) addToHand(g, t, p, { from: 'hell' });
      }
    },
  } as Fx,
  // CC03-042 (Normal): reveal 2 Avatars from hand, shuffle them into the Deck, draw 3.
  'กฎการแลกเปลี่ยนที่เท่าเทียม': {
    keep: 2.5,
    canCast: (g, p, c) => P(g, p).hand.filter((x) => x !== c && isA(x)).length >= 2,
    resolve: (g, p, c) => {
      const pl = P(g, p);
      const xs = pickN(pl.hand.filter((x) => x !== c && isA(x)), 2, (x) => -keepValue(g, x), { title: 'กฎการแลกเปลี่ยน: reveal 2 Avatars (back into the Deck)' });
      if (xs.length < 2) return;
      log(g, `P${p} reveals ${xs.map((x) => x.def.name).join(', ')}`);
      for (const x of xs) { detach(g, x); pl.deck.push(x); }
      shuffle(g, pl.deck); draw(g, p, 3);
    },
  } as Fx,
  // CC03-043 (Normal): choose 5 non-{only} cards from our and/or the opponent's Hell: banish them.
  'ลบประวัติ': {
    keep: 2,
    canCast: (g, p) => [...P(g, p).hell, ...P(g, opp(p)).hell].filter(notOnly).length >= 1,
    resolve: (g, p) => {
      const pool = [...P(g, opp(p)).hell, ...P(g, p).hell].filter(notOnly);
      const xs = pickN(pool, Math.min(5, pool.length), (x) => (x.owner !== p ? 10 + keepValue(g, x) : -keepValue(g, x)), { title: 'ลบประวัติ: banish 5 cards from the Hells' });
      for (const x of xs) { detach(g, x); P(g, x.owner).exile.push(x); }
      log(g, `ลบประวัติ: banished ${xs.map((x) => x.def.name).join(', ')}`);
    },
  } as Fx,
  // CC03-044 (React): destroy a เครื่องบิน Super Air on our Avatar Zone: put an opposing Avatar on top of its owner's Deck, and
  // you may summon a "Super Air" Avatar from hand.
  'กรุงเทพ - ดวงจันทร์': {
    keep: 3.5, mainUse: true,
    canCast: (g, p) => P(g, p).avatars.some(isPlane) && P(g, opp(p)).avatars.length > 0,
    resolve: (g, p) => bkkMoon(g, p, null),
    react: {
      on: ['attack', 'summon'],
      can: (g, p, c, ev) => ev.actor !== p && P(g, p).avatars.some(isPlane) && P(g, opp(p)).avatars.length > 0,
      want: (g, p, c, ev) => !!ev.source && P(g, opp(p)).avatars.includes(ev.source) && value(g, ev.source) >= 4,
      resolve: (g, p, c, ev) => bkkMoon(g, p, ev.source && P(g, opp(p)).avatars.includes(ev.source) ? ev.source : null),
    },
  } as Fx,
  // CC03-045 (React): when the opponent ธรณีสูบ: banish a card from the opponent's Hell; for the rest of the turn every card
  // sent from a Deck to Hell is banished instead. approx: offered right after the opponent's mill (from hand, React slot);
  // "instead" covers ธรณีสูบ (cards milled are moved on to the Dark Dimension).
  'การ์ดร่วงก็เอาไปทิ้งงงง!!!!': {
    keep: 2.5,
    canCast: () => false,
    onMill: (g, self, owner, cards, by) => {
      // the replacement while the rule lives (self: any copy in a hand or Hell, or in play)
      if (dropRuleOn(g) && !(g as any)._dropDone?.has(cards[0]?.uid)) {
        const done: Set<number> = ((g as any)._dropDone ||= new Set());
        let first = true;
        for (const x of cards) {
          if (done.has(x.uid)) continue;
          done.add(x.uid);
          if (P(g, x.owner).hell.includes(x)) { detach(g, x); P(g, x.owner).exile.push(x); if (first) { log(g, 'การ์ดร่วงก็เอาไปทิ้งงงง!!!!: the milled cards are banished instead'); first = false; } }
        }
        return;
      }
      const p = self.owner, pl = P(g, p);
      if (!pl.hand.includes(self) || by === null || by === p || pl.used.React) return;
      const pool = P(g, by).hell.filter((x) => !cards.includes(x) || true);
      if (!pool.length || !mayDo(g, self, 'การ์ดร่วงก็เอาไปทิ้งงงง!!!!: the opponent milled, use it (React)', cards.length >= 3)) return;
      pl.used.React = true; detach(g, self); pl.hell.push(self);
      log(g, `P${p} uses การ์ดร่วงก็เอาไปทิ้งงงง!!!! (React)`);
      const t = pick1(pool, (x) => keepValue(g, x), 'การ์ดร่วง: banish a card from the opponent\'s Hell');
      if (t) { detach(g, t); P(g, t.owner).exile.push(t); }
      (g as any)._dropDone = new Set(cards.map((x) => x.uid));
      addRule(g, { p, key: 'การ์ดร่วง', until: g.turn });
    },
  } as Fx,
  // CC03-046 (Modification): only a {ฤษี} Avatar. When equipped: the wearer POWER +3 until the end of our turn. Activate: put
  // this under our Deck: one of our {ฤษี} Avatars POWER +1.
  'น้ำชูกำลังสูตรฤๅษี': {
    keep: 2.5,
    wearIf: (g, m, w) => symIs(w, 'ฤษี'),
    canCast: (g, p) => P(g, p).avatars.some((a) => symIs(a, 'ฤษี')),
    modTarget: (g, p) => best(P(g, p).avatars.filter((a) => symIs(a, 'ฤษี')), (a) => (a.asleep ? 0 : 3) + power(g, a)),
    onAttach: (g, m, w) => { addPower(g, w, 3, 'turn', m); },
    fieldActs: (g, p, c) => [act('น้ำชูกำลัง: put it under the Deck: a ฤษี POWER +1', (g2) => inMain(g2, p) && c.wearer >= 0 && humanDeciding(g2),
      (g2) => {
        if (!toDeck(g2, c, 'bottom', { cost: true })) return;
        const t = pick1(P(g2, p).avatars.filter((a) => symIs(a, 'ฤษี')), (a) => power(g2, a), 'น้ำชูกำลัง: a {ฤษี} Avatar POWER +1');
        if (t) addPower(g2, t, 1, 'perm', c);
      })],
  } as Fx,
  // CC03-047 (Modification): only our Avatars. Wearer POWER +2. End Phase: this and its wearer go to Hell.
  'รองเท้ากินขา': {
    keep: 2,
    canCast: (g, p) => P(g, p).avatars.length > 0,
    wearIf: (g, m, w) => w.ctrl === m.owner,
    modTarget: (g, p) => best(P(g, p).avatars.filter((a) => !a.asleep), (a) => -value(g, a)) || null,
    modPower: () => 2,
    onAttach: (g, m) => { addRule(g, { p: m.owner, key: 'รองเท้ากินขา', until: g.turn, n: m.uid }); },
  } as Fx,
  // CC03-048 (Modification): only on an Avatar wearing nothing else. When the wearer would be destroyed by a fight, destroy
  // this instead. When the wearer attacks, destroy this.
  'ประกันชั้นผู้น้อย': {
    keep: 2,
    wearIf: (g, m, w) => w.mods.every((x) => x === m),
    canCast: (g, p) => P(g, p).avatars.some((a) => a.mods.length === 0),
    modTarget: (g, p) => best(P(g, p).avatars.filter((a) => a.mods.length === 0), (a) => value(g, a)),
    protectWearer: (g, m, w, by, viaMagic) => {
      if (viaMagic || !currentFight() || currentSource()) return false;
      log(g, `ประกันชั้นผู้น้อย is destroyed instead of ${w.def.name}`);
      detach(g, m); P(g, m.owner).hell.push(m);
      return true;
    },
    onWearerAttack: (g, m, w) => { log(g, `${w.def.name} attacks: ประกันชั้นผู้น้อย is destroyed`); destroy(g, m, m.owner); },
  } as Fx,
  // CC03-049 (Modification): only a "ผู้กล้า" {หุ่นยนต์} Avatar. When equipped: may destroy a card on the opponent's Magic Zone.
  // Once a turn, when the wearer attacks, discard 2: the wearer wakes up.
  'อาวุธหุ่นนักรบผู้กล้า "แคนเซอร์บลาสเตอร์"': {
    keep: 3,
    wearIf: (g, m, w) => named(w, 'ผู้กล้า') && symIs(w, 'หุ่นยนต์'),
    canCast: (g, p) => P(g, p).avatars.some((a) => named(a, 'ผู้กล้า') && symIs(a, 'หุ่นยนต์')),
    modTarget: (g, p) => best(P(g, p).avatars.filter((a) => named(a, 'ผู้กล้า') && symIs(a, 'หุ่นยนต์')), (a) => value(g, a)),
    onAttach: (g, m, w) => {
      const q = opp(w.ctrl), pool = P(g, q).mz;
      if (!pool.length) return;
      const t = pick1(pool, (x) => keepValue(g, x) + 1, 'แคนเซอร์บลาสเตอร์: destroy a card on the opponent\'s Magic Zone (optional)', true);
      if (t) destroy(g, t, w.ctrl);
    },
    onWearerAttack: (g, m, w) => {
      const p = w.ctrl;
      if (!once(g, p, 'cancer:' + m.uid) || P(g, p).hand.length < 2 || !mayDo(g, m, 'แคนเซอร์บลาสเตอร์: discard 2, the wearer wakes up', P(g, p).hand.length >= 4)) return;
      use(g, p, 'cancer:' + m.uid);
      if (discardPick(g, p, 2, 'แคนเซอร์บลาสเตอร์: discard 2')) { w.asleep = false; log(g, `${w.def.name} wakes up`); }
    },
  } as Fx,
  // CC03-050 (Land): once a turn: every player scouts 1; the user chooses: every player takes it to hand, or sends it to Hell.
  'งานแฟนมีต': {
    keep: 2.5,
    canCast: (g, p) => !g.land || g.land.owner !== p,
    fieldActs: (g, p, c) => [act('งานแฟนมีต: everyone reveals the top card', (g2) => inMain(g2, p) && g2.land === c && once(g2, p, 'fanmeet') && g2.p.every((q) => q.deck.length >= 1),
      (g2) => {
        use(g2, p, 'fanmeet');
        const tops = g2.p.map((q) => q.deck[0]);
        log(g2, `งานแฟนมีต: ${tops.map((x, i) => `P${i} ${x.def.name}`).join(', ')}`);
        const mine = keepValue(g2, tops[p]), theirs = keepValue(g2, tops[opp(p)]);
        const k = chooseMode(g2, c, ['everyone takes it to hand · ขึ้นมือ', 'everyone sends it to Hell · ลงนรก'], mine >= theirs ? 0 : 1);
        for (const q of g2.p) { const x = q.deck.shift()!; if (k === 0) { q.hand.push(x); } else { q.hell.push(x); } }
      })],
  } as Fx,
  // CC03-060 (Construct): if last turn our LIFE was turned face up by a card's ability, destroy this: turn our bottom face-up
  // LIFE card face down.
  'ตู้เก็บอาหารฉุกเฉิน M.R.E': {
    keep: 2.5,
    onLifeFlipped: (g, self, p, life, byAttack) => { if (p === self.ctrl && !byAttack) P(g, p).once['mreFlip'] = g.turn; },
    fieldActs: (g, p, c) => [act('M.R.E: destroy it, turn a LIFE face down', (g2) => inMain(g2, p) && P(g2, p).mz.includes(c) && P(g2, p).once['mreFlip'] === g2.turn - 1
      && P(g2, p).life.some((l) => l.faceUp),
    (g2) => {
      if (!destroy(g2, c, p)) return;
      const pl = P(g2, p);
      const ups = pl.life.filter((l) => l.faceUp);
      if (ups.length) lifeDown(g2, p, ups[ups.length - 1]);
    })],
  } as Fx,
} as Record<string, Fx>);

// ---------- helpers that need FX names above ----------
function heroPool(g: Game, p: PID): Card[] { const pl = P(g, p); return [...pl.avatars, ...pl.hell.filter(isA)]; }
/** A legal กุ่ย / ฮอล / นาย trio (3 different cards) from our field or Hell, or null. */
function heroTrio(g: Game, p: PID): Card[] | null {
  const pool = heroPool(g, p), keys = ['กุ่ย', 'ฮอล', 'นาย'];
  const go = (i: number, used: Card[]): Card[] | null => {
    if (i === keys.length) return used;
    for (const x of pool) if (!used.includes(x) && named(x, keys[i])) { const r = go(i + 1, [...used, x]); if (r) return r; }
    return null;
  };
  return go(0, []);
}
function athenaPool(g: Game, p: PID): Card[] {
  return P(g, p).hell.filter((x) => isA(x) && !colorIs(x, 'ม่วง') && x.def.cost <= 2 && !uniqueBlocked(g, p, x));
}
/** 3 differently named "หิมะ" Avatars in hand besides c, one a "ราชินีหิมะ". */
function snowReveal(g: Game, p: PID, c: Card): Card[] | null {
  const hs = P(g, p).hand.filter((x) => x !== c && isA(x) && named(x, 'หิมะ'));
  const q = hs.find((x) => named(x, SNOWQ));
  if (!q) return null;
  const names = new Set(hs.filter((x) => x.def.name !== q.def.name).map((x) => x.def.name));
  return names.size >= 2 ? [q] : null;
}
function pinkSewage(g: Game, c: Card) {
  const p = c.ctrl;
  scoutDeck(g, p, 3, (top) => {
    const pool = top.filter((x) => isA(x) && named(x, 'สิ่งปฏิกูล') && !uniqueBlocked(g, p, x));
    if (!canPlaceAvatar(P(g, p))) return;
    const t = pick1(pool, (x) => value(g, x), `${c.def.name}: summon a สิ่งปฏิกูล`);
    if (!t) return;
    top.splice(top.indexOf(t), 1);
    P(g, p).hell.push(t); P(g, p).once['sewage:' + t.uid] = g.turn;
    if (!summon(g, p, t, 'effect') && P(g, p).hell.includes(t)) { /* stays in Hell with the rest */ }
  }, 'hell', c.def.name);
}
/** May x (in p's Deck) pay GEM for พญายม c? It must be a นายนิรยบาล Avatar whose GEM plus hand payment covers the Cost. */
function yamaPay(g: Game, p: PID, c: Card, x: Card): Card[] | null {
  if (!isA(x) || !named(x, 'นายนิรยบาล')) return null;
  const due = Math.max(0, costOf(g, p, c) - gemOf(g, x, c));
  return due === 0 ? [] : bestPayment(g, p, due, [c], c);
}
const mzMango = (x: Card) => isA(x) && named(x, 'มะม่วง') && symIs(x, 'ต้นไม้');
const isNatSword = (x: Card) => x.def.name.includes('นัทคาลิเบอร์');
function bkkMoon(g: Game, p: PID, prefer: Card | null) {
  const pl = P(g, p);
  const plane = pick1(pl.avatars.filter(isPlane), (a) => -value(g, a), `destroy a ${PLANE} on your Avatar Zone`);
  if (!plane || !destroy(g, plane, p, false)) return;
  const t = prefer && P(g, opp(p)).avatars.includes(prefer) ? prefer : pick1(P(g, opp(p)).avatars, (a) => value(g, a), 'กรุงเทพ - ดวงจันทร์: put an opposing Avatar on top of its Deck');
  if (t) toDeck(g, t, 'top', { by: p, viaMagic: true });
  if (!canPlaceAvatar(pl)) return;
  const s = pick1(pl.hand.filter((x) => isA(x) && named(x, 'Super Air') && !uniqueBlocked(g, p, x)), (x) => value(g, x), 'summon a "Super Air" Avatar from hand (optional)', true);
  if (s) summon(g, p, s, 'effect');
}
