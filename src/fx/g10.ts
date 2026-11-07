// Card effects for the Back to School sets B2SA / B2SB (added 2026-11-07 from bottcg's card data, user-approved).
// Reprints in these sets share their effect with the older card of the same name (effects are keyed by name).
// New names: น้อง Passion, เจ้าของร้านหนังสือที่มีการ์ดขาย, ระเบิดความรู้, ปิ๊งไอเดีย, คทารูปไฟฟ้า, อิศวร ประทานพร.
// ทศกัณฐ์ (B2SB-004) has no ability text.
import type { Card, Game, PID } from '../types.ts';
import type { Fx } from '../cards.ts';
import { FX, value, best, pickN, mayDo, chooseMode, search } from '../cards.ts';
import { P, opp, power, draw, destroy, discard, toExile, toDeck, onceUsed, markOnce, log, withSource, addPower } from '../engine.ts';

const PASSION = 'น้อง Passion';
const BOMB = 'ระเบิดความรู้';
const IDEA = 'ปิ๊งไอเดีย';
const WAND = 'คทารูปไฟฟ้า';
const is = (c: Card, n: string) => c.def.name === n;

/** Cost limit of น้อง Passion's destroy: 3, +1 for each คทารูปไฟฟ้า it wears. */
const passionLimit = (c: Card) => 3 + c.mods.filter((m) => is(m, WAND)).length;

Object.assign(FX, {
  // B2SA-001: once per turn, when it attacks, discard any number (>= 1) of ระเบิดความรู้: destroy an opposing Avatar Cost <= 3.
  // Each ระเบิดความรู้ discarded this way gives a น้อง Passion POWER +1 until end of turn (its own auto ability; approx: the attacker).
  // End Phase: exile a ปิ๊งไอเดีย from our Hell: return a ระเบิดความรู้ from our Hell to hand.
  [PASSION]: {
    keep: 4,
    onAttack: (g: Game, c: Card) => withSource(c, () => {
      const p = c.ctrl, pl = P(g, p), key = 'passion' + c.uid;
      if (onceUsed(g, pl, key)) return;
      const bombs = () => pl.hand.filter((x) => is(x, BOMB));
      const ts = () => P(g, opp(p)).avatars.filter((a) => a.def.cost <= passionLimit(c));
      if (!bombs().length || !ts().length) return;
      if (!mayDo(g, c, `discard ${BOMB}: destroy an opposing Avatar with Cost ${passionLimit(c)} or less`, ts().some((a) => value(g, a) >= 2.5))) return;
      const first = pickN(bombs(), 1, () => 0, { title: `${c.def.name}: discard ${BOMB}` });
      if (!first.length) return;
      const rest = bombs().filter((x) => !first.includes(x));
      const extra = rest.length && mayDo(g, c, `discard more ${BOMB} (POWER +1 each)`, false)
        ? pickN(rest, rest.length, () => 0, { optional: true, title: `${c.def.name}: discard more ${BOMB}` }) : [];
      markOnce(g, pl, key);
      const all = [...first, ...extra];
      for (const x of all) discard(g, p, x);
      if (pl.avatars.includes(c)) addPower(g, c, all.length, 'turn');
      log(g, `${c.def.name}: discarded ${all.length} ${BOMB}`);
      const t = best(ts(), (a) => value(g, a));
      if (t) destroy(g, t, p);
    }),
    endPhase: (g: Game, c: Card) => withSource(c, () => {
      const pl = P(g, c.ctrl);
      const idea = pl.hell.find((x) => is(x, IDEA));
      const bomb = pl.hell.find((x) => is(x, BOMB));
      if (!idea || !bomb) return;
      if (!mayDo(g, c, `exile ${IDEA} from Hell: return ${BOMB} to hand`, true)) return;
      if (!toExile(g, idea)) return;
      search(g, c.ctrl, (x) => is(x, BOMB), 'hell');
    }),
  } as Fx,
  // B2SA-002: จุติ, return a ปิ๊งไอเดีย from our มิติมืด (exile) to the Deck and shuffle: draw 1.
  'เจ้าของร้านหนังสือที่มีการ์ดขาย': {
    keep: 3,
    jutsu: (g: Game, c: Card) => withSource(c, () => {
      const pl = P(g, c.ctrl);
      const idea = pl.exile.find((x) => is(x, IDEA));
      if (!idea || !mayDo(g, c, `return ${IDEA} from มิติมืด to Deck: draw 1`, true)) return;
      if (toDeck(g, idea, 'shuffle')) draw(g, c.ctrl, 1);
    }),
  } as Fx,
  // B2SA-003 (Normal Magic): only while we have น้อง Passion on our Avatar Zone: draw 1.
  [BOMB]: {
    keep: 3.5,
    canCast: (g: Game, p: PID) => P(g, p).avatars.some((a) => is(a, PASSION)),
    resolve: (g: Game, p: PID) => draw(g, p, 1),
  } as Fx,
  // B2SA-004 (Normal Magic): choose one: put a ระเบิดความรู้ / a น้อง Passion from our Deck or Hell into hand (shuffle if from Deck).
  [IDEA]: {
    keep: 3,
    options: 2,
    optLabels: [`${BOMB} from Deck/Hell to hand`, `${PASSION} from Deck/Hell to hand`],
    canCast: (g: Game, p: PID, _c: Card, opt: number) => {
      const n = opt === 0 ? BOMB : PASSION, pl = P(g, p);
      return pl.deck.some((x) => is(x, n)) || pl.hell.some((x) => is(x, n));
    },
    resolve: (g: Game, p: PID, c: Card, opt: number) => {
      const n = opt === 0 ? BOMB : PASSION, pl = P(g, p);
      const inDeck = pl.deck.some((x) => is(x, n)), inHell = pl.hell.some((x) => is(x, n));
      let from: 'deck' | 'hell' = inDeck ? 'deck' : 'hell';
      if (inDeck && inHell) from = chooseMode(g, c, ['Deck', 'นรก · Hell'], 0) === 0 ? 'deck' : 'hell';
      search(g, p, (x) => is(x, n), from); // search() shuffles the Deck after taking from it
    },
  } as Fx,
  // B2SA-005 (Modification): wearer POWER +1; on น้อง Passion its destroy limit is Cost +1 (passionLimit).
  [WAND]: {
    keep: 2.5,
    canCast: (g: Game, p: PID) => P(g, p).avatars.length > 0,
    modTarget: (g: Game, p: PID) => best(P(g, p).avatars, (a) => (is(a, PASSION) ? 5 : 0) + (a.asleep ? 0 : 3) + power(g, a)),
    modPower: () => 1,
  } as Fx,
  // B2SB-001: จุติ, choose an Avatar on our Avatar Zone: POWER +1 until end of turn.
  'อิศวร ประทานพร': {
    keep: 2.5,
    jutsu: (g: Game, c: Card) => withSource(c, () => {
      const t = best(P(g, c.ctrl).avatars, (a) => (a.asleep ? 0 : 3) + power(g, a));
      if (t) addPower(g, t, 1, 'turn');
    }),
  } as Fx,
} as Record<string, Fx>);
