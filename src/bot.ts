// Heuristic bot: greedy 1-ply search over Main Phase actions (each candidate is played out
// on a copy of the game, followed by a quick simulated Battle Phase, then scored),
// rule-based attacks, and rule-based responses.
import type { Card, Game, PID } from './types.ts';
import type { Brain, Ev } from './engine.ts';
import {
  P, opp, power, mainActs, doAct, cloneSim, legalTargets, canAttack, attack, fx, canUseReact,
  flippedLife, critical, castMagic, keepValue, findCard, toExile, hasKw, helpersFor, colorsEn, shieldOptions, useShield, reactCands, battleActs,
  linkActs, buffActs, applyBuff, isConstruct, rand, quiet, withDecider,
} from './engine.ts';
import { value } from './cards.ts';

// linkbot item 2: cards the bot keeps in hand instead of summoning them.
// เพนกวิ้น ฮัท (BT11-024): kept for its own สั่งใช้ from hand (LIFE attacked while critical: cancel, end the turn);
// Avatars with printed POWER 0, Cost 0 and GEM 4 (ช่างแอร์ดวงซวย, ครูภาษาไทย, แมลงปอนา, ...): GEM for payments.
export const PENGUIN_HUT = 'เพนกวิ้น ฮัท';
export function gemOnlyAvatar(c: Card): boolean {
  return c.def.type === 'Avatar' && !c.token && c.def.power === 0 && c.def.cost === 0 && c.def.gem === 4;
}
export function botNoSummon(c: Card | null): boolean { return !!c && (c.def.name === PENGUIN_HUT || gemOnlyAvatar(c)); }

// Bot levels (2026-10-21, user: "make the bot smarter ... choose the level"). Normal is the classic bot (the QA gate's
// bot games use it); Hard holds React cards for big moments, guards its LIFE and weighs threats more; Easy plays loosely.
export type Level = 'easy' | 'normal' | 'hard';
export const LEVELS: Level[] = ['easy', 'normal', 'hard'];
// pro (2026-10-26, user's Thai pro playbook + the "How to Counter" guides): LIFE pacing (take the opponent to 3 LIFE,
// then only push on for the kill), key-unit priorities for attacks and React cards, a small opening board (1-2 Avatars)
// against one-turn kills, hand building, and fair look-ahead (its own draws and the opponent's hidden cards are
// shuffled in every look-ahead copy, so it never plans with cards it could not know).
interface Tune { depth: number; beam: number; lifeW: number; exposeW: number; noise: number; stopChance: number; reactHold: number; reactSkip: number; lifeGuard: boolean; pro: boolean; handW: number; fair?: boolean; samples?: number; curve?: boolean; threatW?: number; landW?: number; opening?: boolean; reactPro?: boolean }
const TUNE: Record<string, Tune> = {
  easy: { depth: 1, beam: 0, lifeW: 7, exposeW: 0.5, noise: 3, stopChance: 0.2, reactHold: 0, reactSkip: 0.5, lifeGuard: false, pro: false, handW: 0.6 },
  normal: { depth: 1, beam: 0, lifeW: 7, exposeW: 1, noise: 0, stopChance: 0, reactHold: 0, reactSkip: 0, lifeGuard: false, pro: false, handW: 0.6 },
  hard: { depth: 2, beam: 3, lifeW: 8.5, exposeW: 1.4, noise: 0, stopChance: 0, reactHold: 6, reactSkip: 0, lifeGuard: true, pro: true, handW: 0.8, fair: true, curve: true, threatW: 1, landW: 1, opening: true, reactPro: true, samples: 3 },
  hard0: { depth: 2, beam: 3, lifeW: 8.5, exposeW: 1.4, noise: 0, stopChance: 0, reactHold: 6, reactSkip: 0, lifeGuard: true, pro: false, handW: 0.6 }, // the Hard of 2026-10-21 (tests)
};
TUNE.hard0f = { ...TUNE.hard0, fair: true }; // tests: the old Hard without peeking
// tests only: BOT_X='{"fair":true,...}' makes level hardx = hard0 plus those settings (node; never in the browser)
try { const x = (globalThis as any).process?.env?.BOT_X; if (x) TUNE.hardx = { ...TUNE.hard0, ...JSON.parse(x) }; } catch { /* no env */ }

// Key units of the meta decks (what pros remove first) and how much more they are worth than their stats say.
const THREAT: Record<string, number> = {
  'นินจาไร้นาม': 3, 'ฟูมะ นินจาแห่งสายลม': 4, 'ชิโยเมะ นินจาสาว': 3, 'โกเอมอน นินจาจอมโจร': 3,
  'ไวรัสแห่งความเป็นไปได้ ครีปเปอร์': 4, 'ไวรัสแห่งการช่วงชิง โทรจัน': 3, 'ไวรัสแห่งการแพร่เชื้อ บลาสเตอร์': 2,
  'วันชัยเปรตรุ่นพ่อ': 3, 'วันชัย พ่อบุญลือ': 3, 'น้องนาว ชู้วันชัย': 3, 'บุญลือ วีรบุรุษเปรต': 2,
  'เซอร์นัท ดาบแห่งแสงอรุณ': 4, 'เซอร์นัท ผู้นำแห่งอัศวินตลิ่งชัน': 4, 'เลอร์ติ๊ก สหายอัศวินตลิ่งชัน': 3, 'ไอ้นัท - คนบ้าจั่ว': 3, 'ไอ้นัท คนข้ามเวลา': 2,
  'พญายักษ์ ทศกัณฐ์': 4, 'กุมภกรรณ ทดน้ำ': 3, 'พิเภก': 3, 'มณโฑ ราชินีเหล่ายักษ์': 3, 'นางมณโฑ': 2, 'ท้าวเวสสุวรรณ': 3,
  'เจค นักฆ่ามือเก๋า': 3, 'พาลี วานรแห่งเมืองขีดขิน': 3, 'ศาสตราจารย์วานร': 3, 'ปีศาจแห่งพันรเลือด เมฟิสโตเฟเลส': 5,
  'อีสานสลิงเกอร์ เปอร์': 2,
  // big Magic worth a cancel
  'เมตตาระยะยาว': 6, 'เลือกมันสำหรับพวก จน !!!': 3, 'สัญญาเลือด': 3,
};
// Lands that run a deck's engine: worth removing (ไต้ฝุ่น) and worth keeping
const KEY_LAND = new Set(['ด่านตรวจเข้าเมือง', 'หมู่บ้านเห็ด', 'โคกอีสานนูน', 'พิภพรัททาทุย']);
export const threatOf = (c: Card | null | undefined): number => (c ? THREAT[c.def.name] || 0 : 0);
// The opponent's LIFE as the pros count it: 1-3 face up is the target; the 4th and 5th only matter on the way to the
// kill (each LIFE card hit gives its owner an effect and cards, and at 4 face up เลือกจน gets better).
const PRO_LIFE = [0, 7, 14, 21, 22.5, 24];
let T: Tune = TUNE.normal; // the tuning of the brain that is thinking right now (set by each Brain call)
// the bot's own dice for Easy's sloppiness: never the game's rng, so look-ahead and replays stay identical
let botSeed = 12345;
function botRand(): number { botSeed = (botSeed * 1103515245 + 12345) & 0x7fffffff; return botSeed / 0x7fffffff; }
// the face-down LIFE cards change places among themselves (face-up ones stay where they are)
function shuffleDown(life: Card[]) { const idx = life.map((l, i) => (l.faceUp ? -1 : i)).filter((i) => i >= 0); const cs = idx.map((i) => life[i]); shuffleBot(cs); idx.forEach((i, k) => { life[i] = cs[k]; }); }
function shuffleBot<X>(a: X[]) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(botRand() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; } }
// A look-ahead copy. Pro: no peeking: its own deck order and the opponent's hand and deck order are shuffled.
// Every copy made for one decision gets the same hidden-card order (common random numbers), so candidate moves are
// compared on equal luck rather than on who happened to draw well in its copy.
let lookSeed = 1;
function newDecision() { lookSeed = (lookSeed * 69069 + 1) & 0x7fffffff; }
function look(g: Game, me: PID): Game {
  const c = cloneSim(g);
  if (T.fair) { const keep = botSeed; botSeed = lookSeed + g.turn * 7 + c.p[0].deck.length * 131 + c.p[1].deck.length; shuffleBot(P(c, me).deck); shuffleBot(P(c, opp(me)).deck); shuffleBot(P(c, opp(me)).hand); shuffleDown(P(c, opp(me)).life); botSeed = keep; }
  return c;
}

export function evaluate(g: Game, me: PID): number {
  if (g.winner === me) return 1000;
  if (g.winner === opp(me)) return -1000;
  const my = P(g, me), o = P(g, opp(me));
  let s = 0;
  s += (T.curve ? PRO_LIFE[Math.min(5, flippedLife(o))] : 7 * flippedLife(o)) - T.lifeW * flippedLife(my);
  if (critical(o)) s += 6;
  if (critical(my)) s -= 6;
  for (const a of my.avatars) s += value(g, a);
  for (const a of o.avatars) s -= value(g, a) + (T.threatW || 0) * threatOf(a);
  for (const c of my.hand) s += T.handW + keepValue(g, c) * 0.15;
  if (T.landW && g.land) s += T.landW * (g.land.owner === me ? 1 : -1) * (KEY_LAND.has(g.land.def.name) ? 3 : 1);
  s -= 0.7 * o.hand.length;
  // LIFE exposure: each of their Avatars beyond our board count can hit LIFE next turn
  const exposed = Math.max(0, o.avatars.length - my.avatars.length);
  s -= exposed * (2 + flippedLife(my)) * T.exposeW;
  if (my.deck.length < 6) s -= (6 - my.deck.length) * 2;
  return s;
}

// Estimated battle powers including "when this fights" effects.
function estBattle(g: Game, a: Card, d: Card): [number, number] {
  const fa = fx(a), fd = fx(d);
  // bugfix4 (user, ผู้กำหนดชีวิต): "when this fights" hooks can have real effects (flip our LIFE, delete text): in a real game
  // they run on a look-ahead copy, never on the real cards
  if (!g.sim && ((fa && fa.battle) || (fd && fd.battle))) {
    try {
      const c = cloneSim(g), a3 = findCard(c, a.uid), d3 = findCard(c, d.uid);
      if (a3 && d3) return quiet(() => withDecider(-1, () => {
        if (fa && fa.battle && a.silencedTurn !== g.turn) fa.battle!(c, a3, d3);
        if (fd && fd.battle && d.silencedTurn !== g.turn) fd.battle!(c, d3, a3);
        return [power(c, a3), power(c, d3)] as [number, number];
      }));
    } catch { /* fall back to the plain estimate */ }
    return [power(g, a), power(g, d)];
  }
  const a2 = { ...a, temp: [...a.temp] }, d2 = { ...d, temp: [...d.temp] };
  if (fa && fa.battle && a.silencedTurn !== g.turn) fa.battle(g, a2, d2);
  if (fd && fd.battle && d.silencedTurn !== g.turn) fd.battle(g, d2, a2);
  return [power(g, a2), power(g, d2)];
}

// Quick rule-based battle used inside look-ahead (no cloning).
function quickBattle(g: Game, me: PID) {
  for (let guard = 0; guard < 8 && g.winner === null && !g.stopBattle; guard++) {
    const atts = P(g, me).avatars.filter((a) => canAttack(g, me, a)).sort((x, y) => power(g, y) - power(g, x));
    let done = false;
    for (const att of atts) {
      let ts = legalTargets(g, me, att);
      if (ts.includes(null)) { attack(g, me, att, null); done = true; break; }
      if (ts.some((t) => !isConstruct(t))) ts = ts.filter((t) => !isConstruct(t)); // v14 features: Constructs are low-value targets
      let bt: Card | null = null, bv = 0;
      for (const t of ts as Card[]) {
        const [pa, pt] = estBattle(g, att, t);
        const v = pa > pt ? value(g, t) : pa === pt ? value(g, t) - value(g, att) : -1;
        if (v > bv) { bv = v; bt = t; }
      }
      if (bt) { attack(g, me, att, bt); done = true; break; }
    }
    if (!done) break;
  }
}

// Rough opponent reply on a look-ahead copy: our End Phase, their wake-up, start-of-Main
// triggers (e.g. พาลี's wipe) and a quick Battle Phase with the board they already have.
function oppReply(c: Game, me: PID) {
  const o = opp(me);
  for (const a of [...P(c, me).avatars]) if (a.fumaExile) toExile(c, a);
  for (const q of c.p) for (const a of q.avatars) { a.temp = []; a.kick = false; }
  c.turn++; c.active = o; c.phase = 'Main';
  for (const a of P(c, o).avatars) if (a.noWakeUntil < c.turn) a.asleep = false;
  for (const a of [...P(c, o).avatars]) { const f = fx(a); if (f && f.startMain && P(c, o).avatars.includes(a)) f.startMain(c, a); }
  c.phase = 'Battle';
  quickBattle(c, o);
}
function scoreAfter(g: Game, me: PID): number {
  if (g.winner !== null) return evaluate(g, me);
  const c = look(g, me);
  c.phase = 'Battle';
  if (g.turn > 1) quickBattle(c, me);
  const now = evaluate(c, me);
  if (c.winner !== null) return now;
  oppReply(c, me);
  return 0.4 * now + 0.6 * evaluate(c, me);
}

const Classic: Brain = {
  main(g, me) {
    let summons = 0;
    const opening = !!T.opening && g.turn <= 2; // pro: the first turn puts down 1-2 Avatars, not the whole hand (one-turn kills)
    for (let it = 0; it < 30 && g.winner === null; it++) {
      // v14 features item 2: form every คู่หู / [Link] pair that is available (greedy)
      const la = linkActs(g, me);
      if (la.length) { doAct(g, me, la[0]); continue; }
      newDecision();
      // fair look-ahead: each move is judged over a few guesses of the hidden cards (the same guesses for every move)
      const dec = lookSeed, ns = T.fair ? Math.max(1, T.samples || 1) : 1;
      let base = 0;
      for (let k = 0; k < ns; k++) { lookSeed = dec + k * 977; base += scoreAfter(g, me) / ns; }
      let best = null as ReturnType<typeof mainActs>[number] | null, bestS = base + 0.05;
      const scored: [ReturnType<typeof mainActs>[number], number, Game][] = [];
      for (const a of mainActs(g, me)) {
        if (a.k === 'summon' && botNoSummon(findCard(g, a.uid))) continue; // linkbot item 2
        if (a.k === 'summon' && opening && summons >= 2) continue;
        let s = T.noise ? (botRand() - 0.5) * 2 * T.noise : 0, c: Game | null = null;
        for (let k = 0; k < ns; k++) {
          lookSeed = dec + k * 977;
          const ck = look(g, me);
          if (!doAct(ck, me, a)) { c = null; break; }
          s += scoreAfter(ck, me) / ns;
          if (k === 0) c = ck;
        }
        lookSeed = dec;
        if (!c) continue;
        if (T.depth > 1) scored.push([a, s, c]);
        if (s > bestS) { bestS = s; best = a; }
      }
      // Hard: look one action further for the most promising moves (a weak first step can set up a strong second one)
      if (T.depth > 1 && scored.length > 1) {
        scored.sort((x, y) => y[1] - x[1]);
        for (const [a, s0, c] of scored.slice(0, T.beam)) {
          let s2 = s0;
          for (const b of mainActs(c, me)) {
            if (b.k === 'summon' && botNoSummon(findCard(c, b.uid))) continue;
            const c2 = look(c, me);
            if (!doAct(c2, me, b)) continue;
            const v = scoreAfter(c2, me);
            if (v > s2) s2 = v;
          }
          if (s2 > bestS) { bestS = s2; best = a; }
        }
      }
      if (!best) break;
      if (best.k === 'summon') summons++;
      doAct(g, me, best);
      if (T.stopChance && botRand() < T.stopChance) break; // Easy: sometimes ends its Main Phase early
    }
  },

  battle(g, me) {
    // proactive React use (วิชานินจา) before attacks
    for (const c of [...P(g, me).hand]) {
      const f = fx(c);
      if (f && f.battleUse && f.battleUse(g, me, c)) castMagic(g, me, c, 0);
    }
    for (let guard = 0; guard < 10 && g.winner === null && !g.stopBattle; guard++) {
      // Battle-phase hand abilities (โกเอมอน when LIFE >= 3 face up)
      for (const c of [...P(g, me).hand]) {
        const f = fx(c);
        if (!f || !f.handActs) continue;
        f.handActs(g, me, c).forEach((x) => {
          if (g.phase === 'Battle' && x.can(g)) {
            const sim = look(g, me); const sc = sim.p[me].hand.find((h) => h.uid === c.uid);
            if (!sc) return;
            const before = evaluate(sim, me); fx(sc).handActs!(sim, me, sc)[0].run(sim);
            if (evaluate(sim, me) > before) x.run(g);
          }
        });
      }
      // v14c: Activate abilities of field cards usable in the Battle Phase (FX.battleField), by look-ahead
      for (let k = 0; k < 4 && g.winner === null; k++) {
        const bas = battleActs(g, me);
        if (!bas.length) break;
        let pick: (typeof bas)[number] | null = null, bestA = evaluate(g, me) + 0.3;
        for (const a of bas) { const sim = look(g, me); if (!doAct(sim, me, a)) continue; const s = evaluate(sim, me); if (s > bestA) { bestA = s; pick = a; } }
        if (!pick || !doAct(g, me, pick)) break;
      }
      const atts = P(g, me).avatars.filter((a) => canAttack(g, me, a));
      if (atts.length === 0) break;
      // pick the single best (attacker, target) by look-ahead, or stop
      newDecision();
      const bs = look(g, me); const bnow = evaluate(bs, me); oppReply(bs, me);
      const base = 0.4 * bnow + 0.6 * evaluate(bs, me);
      let pick: [number, number | null, number[]] | null = null, bestS = base + 0.05;
      // v14 features item 1: a Construct is chosen as a target only with 15% probability when an Avatar or LIFE is open
      const conOk = rand(g) < 0.15;
      for (const att of atts) {
        // helper sets: none, all, and all but the แทงหลัง helpers whose colour would destroy the attacker
        const all = helpersFor(g, me, att);
        const ca = colorsEn(att);
        const safe = all.filter((u) => hasKw(g, u, 'unite') || colorsEn(u).some((x) => ca.includes(x)));
        const sets: Card[][] = [[]];
        for (const xs of [all, safe]) if (xs.length && !sets.some((y) => y.length === xs.length)) sets.push(xs);
        let ts = legalTargets(g, me, att);
        if (!conOk && ts.some((t) => !isConstruct(t))) ts = ts.filter((t) => !isConstruct(t));
        for (const t of ts) {
          for (const hs of sets) {
            const sim = look(g, me);
            const sa = findCard(sim, att.uid)!, st = t ? findCard(sim, t.uid) : null;
            // v14 features item 9: helpers give their buff in the Battle Phase first (applyBuff), then the attack
            for (const u of hs) { const su = findCard(sim, u.uid); if (su) applyBuff(sim, me, su, sa); }
            attack(sim, me, sa, st);
            // attacks that remain this turn still matter: play the rest quickly
            quickBattle(sim, me);
            let s = evaluate(sim, me);
            if (sim.winner === null) { const now = s; oppReply(sim, me); s = 0.4 * now + 0.6 * evaluate(sim, me); }
            if (T.noise) s += (botRand() - 0.5) * 2 * T.noise;
            if (s > bestS) { bestS = s; pick = [att.uid, t ? t.uid : null, hs.map((u) => u.uid)]; }
          }
        }
      }
      if (!pick) break;
      const a = findCard(g, pick[0])!, t = pick[1] === null ? null : findCard(g, pick[1]);
      for (const uid of pick[2]) { const u = findCard(g, uid); if (u) applyBuff(g, me, u, a); } // v14 features item 9
      if (g.winner !== null || !P(g, me).avatars.includes(a) || !canAttack(g, me, a) || !legalTargets(g, me, a).includes(t)) continue;
      attack(g, me, a, t);
    }
  },

  respond(g, me, ev) {
    const pl = P(g, me);
    // linkbot item 2a: our LIFE attacked while critical: เพนกวิ้น ฮัท first (before โล่มนุษย์ or another React)
    for (const c of pl.hand) if (c.def.name === PENGUIN_HUT && canUseReact(g, me, c, ev) && fx(c).react!.want(g, me, c, ev)) return c;
    // โล่มนุษย์: redirect an attack (on an Avatar or on LIFE, เตะไข่ too) to an awake shield Avatar when it helps
    const shields = shieldOptions(g, me, ev);
    if (shields.length && ev.source) {
      const src = ev.source;
      const strong = shields.filter((a) => { const [pa, ps] = estBattle(g, src, a); return ps >= pa; });
      const tgtLoses = ev.target ? estBattle(g, src, ev.target)[0] > estBattle(g, src, ev.target)[1] : true;
      let sh: Card | null = strong.length && tgtLoses ? strong.reduce((m, x) => (value(g, x) < value(g, m) ? x : m)) : null;
      // a LIFE hit that would lose the game (or flip a 4th/5th LIFE): block it with the cheapest shield even if it dies
      if (!sh && !ev.target && (critical(pl) || flippedLife(pl) >= 3)) sh = shields.reduce((m, x) => (value(g, x) < value(g, m) ? x : m));
      // Hard: don't give LIFE away; a cheap shield is worth less than a LIFE card
      if (!sh && !ev.target && T.lifeGuard) {
        const cheap = shields.reduce((m, x) => (value(g, x) < value(g, m) ? x : m));
        if (value(g, cheap) < 6 + 2 * flippedLife(pl)) sh = cheap;
      }
      if (sh) useShield(g, ev, sh);
    }
    const cands: Card[] = reactCands(g, me); // v14: also attached cards, Magic Zone, Land
    const usable = cands.filter((c) => canUseReact(g, me, c, ev));
    // pro: a key unit of the opponent's deck (ไร้นาม, ฟูมะ, ครีปเปอร์, วันชัย, เซอร์นัท, ทศกัณฐ์, เมตตาระยะยาว...) gets the React
    if (T.reactPro && usable.length && ev.source && ev.actor !== me && threatOf(ev.source) >= 3 && ev.source.ctrl !== me) {
      const r = usable.find((c) => !fx(c).react!.on || (fx(c).react!.on as string[]).includes(ev.kind));
      if (r) return r;
    }
    // pro: removal is saved for key units; an ordinary summon has to be really big to be worth it
    const proSkip = (c: Card) => !!T.reactPro && ev.kind === 'summon' && !!ev.source && threatOf(ev.source) < 3 && value(g, ev.source) < 8 && !!fx(c).react!.on && (fx(c).react!.on as string[]).includes('summon');
    if (usable.length && T.reactHold && reactStakes(g, me, ev) < T.reactHold / Math.min(usable.length, 2)) return null; // Hard: hold it
    for (const c of usable) {
      if (T.reactSkip && botRand() < T.reactSkip) continue; // Easy: misses some chances
      if (proSkip(c)) continue;
      if (fx(c).react!.want(g, me, c, ev)) return c;
    }
    return null;
  },

  oppMain(g, me) {
    // ชิโยเมะ can swap in during the opponent's Main Phase
    if (P(g, opp(me)).avatars.length === 0) return;
    for (const c of [...P(g, me).hand]) {
      const f = fx(c);
      if (!f || !f.oppMainAct || !f.handActs) continue;
      const x = f.handActs(g, me, c)[0];
      if (x && x.can(g)) x.run(g);
    }
  },

  // v14b: a Magic in the opponent's turn (FX.offTurnMagic): cast the best one by look-ahead, if it helps
  offTurn(g, me, acts) {
    let pick: (typeof acts)[number] | null = null, bestS = evaluate(g, me) + 0.5;
    for (const a of acts) {
      const sim = look(g, me);
      if (!doAct(sim, me, a)) continue;
      const s = evaluate(sim, me);
      if (s > bestS) { bestS = s; pick = a; }
    }
    return pick;
  },
};

// How much is riding on this React window for me (Hard spends React cards only when this is high enough).
function reactStakes(g: Game, me: PID, ev: Ev): number {
  const pl = P(g, me);
  if (ev.kind === 'attack' && ev.source) {
    if (!ev.target) return critical(pl) || flippedLife(pl) >= 3 ? 99 : 3 + 2 * flippedLife(pl); // a LIFE hit: early ones can be taken
    if (ev.target.ctrl !== me) return 1;
    const [pa, pt] = estBattle(g, ev.source, ev.target);
    return pa >= pt ? value(g, ev.target) : 0.5; // our Avatar would die (or trade): its worth; it wins anyway: keep the card
  }
  if (ev.kind === 'battleStart') return 2;
  return 6; // Magic, summons, abilities, destroy windows: let the card's own judgement decide
}

/** A bot brain for a level. Each call sets the tuning used by evaluate() and the helpers above. */
export function makeBot(level: Level | 'hard0' | 'hard0f' | 'hardx' = 'normal'): Brain {
  const tune = TUNE[level] || TUNE.normal;
  const run = <R>(fn: () => R): R => { const prev = T; T = tune; try { return fn(); } finally { T = prev; } };
  return {
    main: (g, me) => run(() => Classic.main(g, me)),
    battle: (g, me) => run(() => Classic.battle(g, me)),
    respond: (g, me, ev) => run(() => Classic.respond(g, me, ev)),
    oppMain: (g, me) => run(() => Classic.oppMain!(g, me)),
    offTurn: (g, me, acts, when) => run(() => Classic.offTurn!(g, me, acts, when)),
  };
}
export const Greedy: Brain = makeBot('normal');
export const levelOf = (x: unknown): Level => (LEVELS.includes(x as Level) ? (x as Level) : 'normal');
