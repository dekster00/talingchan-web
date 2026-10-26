// One online duel (player vs player) in a worker thread, started by online/server.ts.
// Same engine and the same screen data as play/worker.ts, but both seats are human: each question goes to the
// seat that decides, and every state is built twice, once per seat (each seat sees only its own hand and deck list).
// The server mirrors seat 1's data so the Godot screen always sees itself as player 0.
// Time: each seat has TURN_SEC per own turn for its questions (Main, Battle, picks, payments); questions in the
// other player's turn (React) get REACT_SEC each. When time runs out the question is answered with its safe default
// (pass / default pick), so a game can never hang on a player who left.
import { workerData, parentPort, receiveMessageOnPort, type MessagePort } from 'node:worker_threads';
import type { Card, Game, PID } from '../src/types.ts';
import type { Brain, Ev, Act } from '../src/engine.ts';
import {
  newGame, playGame, mulligan, rand, setPhaseHook, setPay, gemOf, setBrains, setAskSeats, askSeat, setLogHook, withDecider, quiet, mainActs, doAct, legalTargets, pileActs,
  canAttack, attack, canUseReact, castMagic, bestPayment, costOf, fx, hasKw, power, P, opp, findCard, isAvatarDef,
  setEvHook, gemColorOf, reqOf, type GameEv, setOrder, setChoose, COLOR_EN, colorsEn, fullSilenced,
  CHAIN, ratSix, kwList, shieldOptions, useShield, magicImmune, attackDuty, dutyReason, reactCands, battleActs,
  assignSlots, slotOf, inLink, buffActs, applyBuff, cancelBuff, buffTargetOf, pendingBuffs, isConstruct,
} from '../src/engine.ts';
import fs from 'node:fs';
import { loadDefs, loadDeck, CARDS } from '../src/sim.ts';
import { whyNot, battlePreview, scaledMs } from '../src/table.ts';
import { cardView, deckTopRevealed } from '../src/view.ts';
import { cardLabel, textLabel } from '../src/labels.ts';

// decks: [seat 0, seat 1], each a deck object {name, main, life, side} (checked by the server)
const { decks, seed, shared, port } = workerData as { decks: [any, any]; seed: number; shared: SharedArrayBuffer; port: MessagePort };
const ACES: string[] = Array.isArray(workerData.aces) ? workerData.aces : ['', ''];
const TURN_SEC = Number(workerData.turnSec) || 120, REACT_SEC = Number(workerData.reactSec) || 30;
const FAST = !!process.env.FAST || !!workerData.fast;
const flag = new Int32Array(shared, 0, 1);
const nap = new Int32Array(new SharedArrayBuffer(4));
let G: Game;
let askId = 0, skipBattle = 0;
const LAST: string[] = ['', ''];
type Marks = { hand: Set<number>; field: Set<number>; why?: Map<number, string> };
const NO_MARKS: Marks = { hand: new Set(), field: new Set() };
const CURS: Marks[] = [NO_MARKS, NO_MARKS];
let VIEW: PID = 0; // the seat the data being built is for ("your" / "opponent's", hand cards, act marks)
const REFRESH = -99;
const sleep = (ms: number) => { if (FAST) return; const t = scaledMs(ms, 1); if (t > 0) Atomics.wait(nap, 0, 0, t); };

// ---------- state snapshot for the screen ----------
function cv(g: Game, c: Card): any {
  const v: any = {
    uid: c.uid, print: c.def.print, name: c.def.name, type: c.def.type, subtype: c.def.subtype, token: c.token, asleep: c.asleep,
    power: isAvatarDef(c.def) || c.def.type === 'Token' || c.def.type === 'Construct' ? power(g, c) : null, base: c.def.power, // v14: Constructs can fight
    owner: c.owner, ctrl: c.ctrl, mods: c.mods.map((m) => cv(g, m)),
    gem: c.def.gem, gemColor: gemColorOf(g, c, null), reqColor: reqOf(g, c), wearer: c.wearer,
    color: COLOR_EN[c.def.color] || '', colors: colorsEn(c), // card colour in english ("#" extra colours in colors)
    rarity: RARITY.get(c.def.print) || '', // v11: printed rarity (first listed print of the code)
  };
  v.status = statusOf(g, c);
  // v13: keyword badges of an Avatar on a field: [{k: Thai keyword, granted}] (own keywords first; granted = from another card / effect)
  if (g.p.some((pl) => pl.avatars.includes(c))) {
    v.kw = kwList(g, c);
    v.slot = slotOf(c); // v14 features item 8: fixed Avatar Zone slot (0..3 = from the far side to the Deck side; 4, 5 hidden)
    if (inLink(g, c)) v.link = c.f.linkWith; // v14 features item 2: in คู่หู / [Link] with that uid
    const bt = buffTargetOf(g, c); if (bt) { v.buffTo = bt.uid; v.buffKind = c.f.buffK === 1 ? 'unity' : 'backstab'; } // v14 features item 9: this helper's pending buff goes to that uid
    const pb = c.temp.filter((t) => !!t.buff); if (pb.length) v.buffs = pb.map((t) => ({ from: t.buff, amount: t.power }));
  }
  if (c.owner === VIEW || c.ctrl === VIEW || CURS[VIEW].field.has(c.uid)) v.act = CURS[VIEW].field.has(c.uid); // bugfix2: the opponent's Land too
  // v14 view: what differs from the printed card (symbols, names, cost, GET texts, origin tag, notes); absent = nothing
  const vw = cardView(g, c);
  if (vw) v.vw = vw;
  return v;
}
// Status flags for the screen's status-effect animations (Avatars on the field only; [] elsewhere).
function statusOf(g: Game, c: Card): string[] {
  const st: string[] = [];
  if (!g.p.some((pl) => pl.avatars.includes(c))) return st;
  if (c.silencedTurn === g.turn) st.push('silenced');
  if (fullSilenced(g, c)) st.push('silencedFull');
  const pw = power(g, c), base = c.def.power || 0;
  if (pw > base) st.push('powerUp'); else if (pw < base) st.push('powerDown');
  if (magicImmune(g, c, opp(c.ctrl))) st.push('immune');
  if (c.f.noAttack === g.turn) st.push('cantAttack');
  if (c.noWakeUntil >= g.turn) st.push('noWake');
  if (!c.asleep && c.silencedTurn !== g.turn && hasKw(g, c, 'shield')) st.push('shield');
  if (c.f.noDie === g.turn || (c.f.bearSafe || 0) >= g.turn) st.push('protected');
  return st;
}
function snapshot(g: Game, viewer: PID) {
  assignSlots(g); // v14 features item 8
  const was = VIEW;
  VIEW = viewer;
  try { return snap0(g); } finally { VIEW = was; }
}
function snap0(g: Game): any {
  const H = VIEW, CUR = CURS[VIEW];
  return {
    turn: g.turn, active: g.active, phase: g.phase, first: g.first, winner: g.winner, you: H, dice: g.dice || [],
    land: g.land ? cv(g, g.land) : null,
    players: g.p.map((pl, i) => ({
      deckName: pl.deckName, deck: pl.deck.length,
      deckTop: pl.deck.length && deckTopRevealed(g, i as PID) ? cv(g, pl.deck[0]) : null, // v14: top of deck face up for both (ฮามดัล)
      hand: i === H ? pl.hand.map((c) => ({ ...cv(g, c), cost: costOf(g, i as PID, c), playable: CUR.hand.has(c.uid), why: CUR.hand.has(c.uid) ? '' : (CUR.why?.get(c.uid) || '') })) : pl.hand.length,
      deckList: i === H ? deckList(g, pl.deck) : undefined, // v12: your remaining deck, one entry per name with n, sorted by name (not deck order)
      slots: ratSix(g, pl) ? 6 : 4, // v11: Avatar slots for real Avatars (6 under พิภพรัททาทุย)
      avatars: pl.avatars.map((c) => cv(g, c)), mz: pl.mz.map((c) => cv(g, c)),
      resolving: (pl.resolving || []).map((c) => cv(g, c)),
      hell: pl.hell.map((c) => cv(g, c)), exile: pl.exile.map((c) => cv(g, c)),
      life: pl.life.map((l) => l.faceUp), lifeCards: pl.life.map((l) => (l.faceUp ? cv(g, l.card) : null)),
      used: { Normal: !!pl.used.Normal, Modification: !!pl.used.Modification, React: !!pl.used.React, Land: !!pl.used.Land }, // Magic types used this turn
    })),
    // v11: the response chain, oldest first: each entry is an action waiting while React windows open on top of it
    chain: CHAIN.map((e) => ({ who: e.actor, kind: e.kind, text: evText(g, e), uid: e.source ? e.source.uid : -1, print: e.source ? e.source.def.print : '', depth: e.depth })),
  };
}
function deckList(g: Game, deck: Card[]) {
  const m = new Map<string, any>();
  for (const c of deck) { const e = m.get(c.def.name); if (e) e.n++; else m.set(c.def.name, { ...cv(g, c), n: 1 }); }
  return [...m.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), 'th'));
}
const RARITY = new Map<string, string>();
try { for (const c of JSON.parse(fs.readFileSync(CARDS, 'utf8'))) if (c && c.code && !RARITY.has(c.code)) RARITY.set(c.code, String(c.rarity || '')); } catch {}


function zoneOf(g: Game, c: Card): string {
  for (const pl of g.p) {
    const who = pl.id === VIEW ? 'your' : "opponent's";
    if (pl.hand.includes(c)) return `${who} hand`;
    if (pl.avatars.includes(c)) return `${who} field`;
    if (pl.hell.includes(c)) return `${who} hell`;
    if (pl.deck.includes(c)) return `${who} deck`;
    if (pl.exile.includes(c)) return `${who} exile`;
    if (pl.mz.includes(c)) return `${who} magic zone`;
    if (pl.avatars.some((a) => a.mods.includes(c))) return `${who} field (attached)`;
  }
  return 'revealed';
}


// ---------- talking to the server ----------
function post(msg: any) { parentPort!.postMessage(msg); }
const states = (g: Game) => [snapshot(g, 0), snapshot(g, 1)];
// time left this turn for the active seat's own questions (seconds), reset when a new turn starts
const bank = [TURN_SEC, TURN_SEC];
let bankTurn = -1;
let MULL = false;
function limitFor(seat: PID): number {
  if (MULL) return 60;
  if (G.turn !== bankTurn) { bankTurn = G.turn; bank[0] = bank[1] = TURN_SEC; }
  return seat === G.active ? bank[seat] : REACT_SEC;
}
// The safe answer when time runs out: pass, else the default, else the first option (a forced attack).
function autoChoice(q: any): number {
  switch (q.type) {
    case 'main': return q.pass2 ? -2 : -1;
    case 'battle': return q.pass ? -1 : (q.options.findIndex((o: any) => o.kind === 'attack') >= 0 ? q.options.findIndex((o: any) => o.kind === 'attack') : 0);
    case 'react': return -1;
    case 'mulligan': return 0;
    case 'pay': return Number(q.def) || 0;
    case 'pick': return Number(q.def) >= 0 ? Number(q.def) : (q.pass ? -1 : 0);
    default: return q.def !== undefined ? Number(q.def) : -1;
  }
}
let QUIT = false;
function drain(onAnswer: (seat: number, id: number, choice: number) => boolean | void) {
  for (let m = receiveMessageOnPort(port); m; m = receiveMessageOnPort(port)) {
    const msg = m.message;
    if (msg.quit) { QUIT = true; process.exit(0); }
    if (typeof msg.id === 'number' && onAnswer(Number(msg.seat), msg.id, Number(msg.choice))) return;
  }
}
// Post questions to one or more seats and block until each is answered (or its time runs out).
function askAll(items: { seat: PID; q: any; marks: Marks }[]): number[] {
  const out: (number | undefined)[] = items.map(() => undefined);
  const ids = items.map(() => ++askId);
  const until = items.map((it) => Date.now() + limitFor(it.seat) * 1000);
  const t0 = Date.now();
  items.forEach((it, i) => { CURS[it.seat] = it.marks; });
  const st = states(G);
  items.forEach((it, i) => post({ t: 'ask', seat: it.seat, q: { ...it.q, id: ids[i], timeLeft: Math.round((until[i] - Date.now()) / 1000) }, states: st }));
  while (out.some((x) => x === undefined)) {
    Atomics.wait(flag, 0, 0, 500);
    Atomics.store(flag, 0, 0);
    drain((seat, id, choice) => {
      const i = ids.indexOf(id);
      if (i < 0 || out[i] !== undefined || items[i].seat !== seat) return;
      out[i] = choice;
    });
    const now = Date.now();
    items.forEach((it, i) => { if (out[i] === undefined && now >= until[i]) { out[i] = autoChoice(it.q); post({ t: 'timeout', seat: it.seat }); } });
  }
  items.forEach((it, i) => {
    CURS[it.seat] = NO_MARKS;
    if (it.seat === G.active && !MULL) bank[it.seat] = Math.max(0, bank[it.seat] - (Date.now() - t0) / 1000);
    post({ t: 'answered', seat: it.seat });
  });
  return out as number[];
}
function ask(seat: PID, q: any, marks: Marks = NO_MARKS, _refreshable = false): number {
  return askAll([{ seat, q, marks }])[0];
}

const SHIELDED = new WeakSet<object>(); // bugs7 item 4: attack windows where you already used โล่มนุษย์
// bugs7 item 6 (user): Hell / Dark dimension abilities are one ACTIVE entry per pile in the Main Phase menu (uid = a card in
// that pile, opt -1); choosing it opens a pick of the cards that can use an ability now (every copy), then the ability.
const PILE_TH = { hell: 'นรก', exile: 'มิติมืด' } as const;
function groupPiles(g: Game, me: PID, acts: Act[]): Act[] {
  const out = acts.filter((a) => a.k !== 'hell' && a.k !== 'exile');
  for (const k of ['hell', 'exile'] as const) {
    if (!acts.some((a) => a.k === k)) continue;
    const list = quiet(() => pileActs(g, me, k));
    if (list.length) out.push({ k, uid: list[0].uid, opt: -1, label: `Activate a card in ${PILE_TH[k]} · ใช้การ์ดใน${PILE_TH[k]}` });
  }
  return out;
}
function pickPileAct(g: Game, me: PID, k: 'hell' | 'exile', askQ: (q: any) => number): Act | null {
  const list = quiet(() => pileActs(g, me, k));
  const cards: Card[] = [];
  for (const a of list) { const c = findCard(g, a.uid); if (c && !cards.includes(c)) cards.push(c); }
  if (!cards.length) return null;
  const labs = (c: Card) => list.filter((a) => a.uid === c.uid).map((a) => actLabel(a, c));
  const i = askQ({ type: 'pick', title: `ACTIVE · ${PILE_TH[k]}: choose the card to use · เลือกการ์ดที่จะใช้`, pile: k,
    options: cards.map((c) => ({ ...brief(g, c), label: `${c.def.name} · ${labs(c).join(' / ')}` })), def: -1, pass: 'Cancel' });
  const c = i >= 0 ? cards[i] : undefined;
  if (!c) return null;
  const mine = list.filter((a) => a.uid === c.uid);
  if (mine.length === 1) return mine[0];
  const j = askQ({ type: 'choose', title: `${c.def.name}: choose the ability`, options: mine.map((a) => ({ label: actLabel(a, c) })), def: 0 });
  return mine[j] ?? null;
}
// ---------- labels ----------
function actLabel(a: Act, c: Card | null): string {
  if (!c) return a.label;
  if (a.k === 'summon') return (c.def.type === 'Construct' ? 'Build ' : 'Summon ') + c.def.name;
  if (a.k === 'cast') return cardLabel(c.def.print, c.def.name, 'cast:' + a.opt, `Cast ${c.def.name}` + ((fx(c)?.options || 1) > 1 ? ` (${fx(c)?.optLabels?.[a.opt] ?? 'option ' + (a.opt + 1)})` : ''));
  if (a.k === 'hand' || a.k === 'field' || a.k === 'hell' || a.k === 'exile') return cardLabel(c.def.print, c.def.name, a.k + ':' + a.opt, a.label);
  return a.label;
}
function evText(g: Game, ev: Ev): string {
  const who = ev.actor === VIEW ? 'You' : 'Opponent';
  const s = ev.source ? ev.source.def.name : '';
  switch (ev.kind) {
    case 'magic': return `${who} cast ${s}${ev.isReact ? ' (React)' : ''}`;
    case 'summon': return `${who} summoned ${s}`;
    case 'attack': return `${who} attack with ${s} → ${ev.target ? ev.target.def.name : 'LIFE'}`;
    case 'ability': return `${who} used the ability of ${s}`;
    case 'fight': return `Battle: ${s} vs ${ev.target ? ev.target.def.name : ''}`;
    case 'destroy': return `${s} is about to be destroyed`;
    case 'battleStart': return `${who === 'You' ? 'Your' : "Opponent's"} Battle Phase begins (before the first attack)`;
    case 'partner': return `${who === 'You' ? 'Your' : "Opponent's"} ${s} entered คู่หู / Link`;
    case 'endTurn': return `${who === 'You' ? 'You are' : 'Opponent is'} about to end the turn`;
    case 'lifeHit': return `${s} hit ${who === 'You' ? "the opponent's" : 'your'} LIFE`;
    case 'destroyed': return `${s} was destroyed${ev.leave?.battle ? ' in battle' : ''}`;
    case 'left': return `${s} left the field (${ev.leave?.how || ''})`;
    case 'targeted': return `${s} chose ${ev.target ? ev.target.def.name : ''}`;
  }
  return ev.kind;
}
const brief = (g: Game, c: Card) => ({ uid: c.uid, print: c.def.print, name: c.def.name, zone: zoneOf(g, c), power: isAvatarDef(c.def) ? power(g, c) : null });


// ---------- each seat's brain: every decision goes to that player's screen ----------
function makeHuman(seat: PID): Brain { return {
  main(g, me) {
    for (let guard = 0; guard < 120 && g.winner === null; guard++) {
      const acts = groupPiles(g, me, quiet(() => mainActs(g, me))); // bugs7 item 6
      const opts = acts.map((a) => { const c = findCard(g, a.uid); return a.k === 'link' ? { label: actLabel(a, c), uid: a.uid, kind: 'link', partner: a.opt, ak: a.k } : { label: actLabel(a, c), uid: a.uid, ak: a.k }; }); // ak: the action's kind, so the screen can write ACTIVE / CAST // v14 features: Link (kind 'link', partner uid)
      // The first player can't attack on turn 1, so there is no Battle Phase to go to.
      const q: any = { type: 'main', title: 'Main Phase: play a card or end the phase', options: opts };
      if (g.turn === 1) q.pass = 'Go to End Phase';
      else { q.pass = 'Go to Battle Phase'; q.pass2 = 'Go to End Phase'; }
      // v14 forced attacks: no End Phase button while an Avatar must attack (the reason is shown on a disabled button)
      const dutyM = g.turn > 1 ? quiet(() => attackDuty(g, me)) : [];
      if (dutyM.length) { delete q.pass2; q.pass2Blocked = `End Phase locked: ${quiet(() => dutyReason(g, me))} – an Avatar must attack · ต้องโจมตีก่อน`; }
      const marks: Marks = { hand: new Set(), field: new Set(), why: new Map() };
      for (const a of acts) (a.k === 'field' || a.k === 'link' ? marks.field : marks.hand).add(a.uid);
      quiet(() => { for (const c of P(g, me).hand) if (!marks.hand.has(c.uid)) marks.why!.set(c.uid, whyNot(g, me, c)); });
      const k = ask(me, q, marks, true);
      if (k === REFRESH) { guard--; continue; }
      if (k === -2 && q.pass2) skipBattle = g.turn; // v14: no skipping the Battle Phase while an Avatar must attack
      if (k < 0 || k >= acts.length) break;
      let act = acts[k];
      if (act.opt === -1 && (act.k === 'hell' || act.k === 'exile')) { // bugs7 item 6: which card of the pile
        const pa = pickPileAct(g, me, act.k, (q) => ask(me, q));
        if (!pa) { continue; }
        act = pa;
      }
      LAST[me] = opts[k].label;
      withDecider(me, () => doAct(g, me, act));
    }
  },
  battle(g, me) {
    if (skipBattle === g.turn) return;
    for (let guard = 0; guard < 40 && g.winner === null && !g.stopBattle; guard++) {
      type O = { label: string; uid: number; target?: number | null; kind?: string; ak?: string; helper?: number; helpers?: number[]; attacker?: number; preview?: any; run: () => void };
      const opts: O[] = [];
      const pl = P(g, me);
      quiet(() => {
        for (const c of pl.hand) {
          const f = fx(c);
          if (f && f.battleUse && c.def.type === 'Magic' && !pl.used[c.def.subtype as 'React'] &&
              (!f.canCast || f.canCast(g, me, c, 0)) && bestPayment(g, me, costOf(g, me, c), [c], c))
            opts.push({ label: `Use ${c.def.name}`, uid: c.uid, kind: 'use', ak: 'cast', run: () => castMagic(g, me, c, 0) });
          if (f && f.handActs) f.handActs(g, me, c).forEach((x, i) => { if (x.can(g)) opts.push({ label: cardLabel(c.def.print, c.def.name, 'hand:' + i, x.label), uid: c.uid, kind: 'use', ak: 'hand', run: () => x.run(g) }); });
        }
        // v14c: Activate abilities of field cards usable in the Battle Phase (FX.battleField)
        for (const a of battleActs(g, me)) opts.push({ label: actLabel(a, findCard(g, a.uid)), uid: a.uid, kind: 'act', ak: a.k, run: () => { doAct(g, me, a); } });
        // v14 features item 9: attacks are one plain option per attacker × target (kind 'attack', uid = attacker; its POWER already
        // includes the buffs given to it). สามัคคี / แทงหลัง are separate Battle-Phase actions given before the attack:
        // kind 'buff' (uid = helper = the card you click, attacker = the Avatar that gets the POWER, buff = 'unity' | 'backstab',
        // amount) and kind 'unbuff' (uid = helper with a pending buff: cancel it, the helper wakes).
        const attackers = pl.avatars.filter((a) => canAttack(g, me, a));
        for (const att of attackers) {
          const stabs = pendingBuffs(g, att).filter((u) => (u.f.buffK || 0) === 2);
          for (const t of legalTargets(g, me, att)) {
            const tn = t ? `${t.def.name} (${power(g, t)})` : 'LIFE', target = t ? t.uid : null;
            const pv: any = battlePreview(g, me, att, t);
            if (stabs.some((u) => !colorsEn(u).some((x) => colorsEn(att).includes(x))) && pv.result !== 'lose' && pv.result !== 'both') { pv.backstabKill = true; pv.text += '; attacker destroyed after (แทงหลัง)'; }
            opts.push({ label: `Attack: ${att.def.name} (${power(g, att)}) → ${tn}${isConstruct(t) ? ' [Construct]' : ''}`, uid: att.uid, kind: 'attack', attacker: att.uid, target, preview: pv, run: () => attack(g, me, att, t) });
          }
        }
        for (const b of buffActs(g, me)) {
          const u = b.helper, att = b.to;
          const kill = b.kind === 'backstab' && !colorsEn(u).some((x) => colorsEn(att).includes(x));
          opts.push({
            label: `${b.kind === 'backstab' ? 'แทงหลัง' : 'สามัคคี'}: ${u.def.name} → ${att.def.name} (+${b.amount})${kill ? ' (attacker destroyed after its fight: colour differs)' : ''}`,
            uid: u.uid, kind: 'buff', buff: b.kind, helper: u.uid, attacker: att.uid, amount: b.amount, kill, run: () => { applyBuff(g, me, u, att); },
          } as any);
        }
        for (const u of pl.avatars) {
          const bt = buffTargetOf(g, u);
          if (bt) opts.push({ label: `Cancel ${u.f.buffK === 1 ? 'สามัคคี' : 'แทงหลัง'}: ${u.def.name} → ${bt.def.name}`, uid: u.uid, kind: 'unbuff', helper: u.uid, attacker: bt.uid, run: () => { cancelBuff(g, me, u); } });
        }
      });
      // ui20: no auto end: with nothing left to do the Battle Phase still waits for your End turn click
      // (a card effect can still end it: g.stopBattle, e.g. เพนกวิ้น ฮัท)
      if (!opts.length && quiet(() => attackDuty(g, me)).length) break; // (a forced attack with no option left: enforceDuty)
      const marks: Marks = { hand: new Set(opts.filter((o) => o.target === undefined && o.kind === 'use').map((o) => o.uid)), field: new Set(opts.filter((o) => o.kind === 'act').map((o) => o.uid)) };
      // v14 forced attacks: no End turn button while an Avatar must attack
      const duty = quiet(() => attackDuty(g, me));
      const bq: any = { type: 'battle', title: 'Battle Phase: choose an attack (or give สามัคคี / แทงหลัง first)', options: opts.map(({ run, ...o }) => o), pass: 'End turn' };
      if (duty.length) { delete bq.pass; bq.passBlocked = `End turn locked: ${quiet(() => dutyReason(g, me))} – an Avatar must attack · ต้องสั่งโจมตี`; }
      const k = ask(me, bq, marks, true);
      if (k === REFRESH) { guard--; continue; }
      if ((k < 0 || k >= opts.length) && duty.length) continue;
      if (k < 0 || k >= opts.length) break;
      LAST[me] = opts[k].label;
      withDecider(me, opts[k].run);
    }
  },
  respond(g, me, ev) {
    const pl = P(g, me);
    const opts: { label: string; uid: number; card: Card | null; shield?: Card }[] = [];
    quiet(() => {
      // โล่มนุษย์ (v13): also against attacks on your LIFE (เตะไข่)
      if (!SHIELDED.has(ev)) for (const a of shieldOptions(g, me, ev)) // bugs7 item 4: one โล่มนุษย์ per attack, then React
        opts.push({ label: `โล่มนุษย์: ${a.def.name} takes the attack instead${ev.target ? '' : ' (protects your LIFE)'}`, uid: a.uid, card: null, shield: a });
      for (const c of reactCands(g, me)) if (canUseReact(g, me, c, ev)) // v14: also attached / Magic Zone / Land cards
        opts.push({ label: `${pl.hand.includes(c) ? 'React' : 'Use ability'}: ${c.def.name}`, uid: c.uid, card: c });
    });
    if (!opts.length) return null;
    const marks: Marks = { hand: new Set(), field: new Set() };
    for (const o of opts) if (o.card) (pl.hand.includes(o.card) ? marks.hand : marks.field).add(o.uid);
    // v11 "only important" React setting: attacks, fights, destroys, Magic and big summons (POWER >= 6 or Cost >= 8) ask
    const big = !!ev.source && ev.kind === 'summon' && ((ev.source.def.power || 0) >= 6 || (ev.source.def.cost || 0) >= 8);
    const important = ['attack', 'fight', 'destroy', 'magic', 'battleStart', 'destroyed', 'left', 'lifeHit', 'targeted', 'endTurn'].includes(ev.kind) || big || opts.some((o) => o.shield);
    VIEW = me;
    const k = ask(me, { type: 'react', title: evText(g, ev), important, kind: ev.kind, options: opts.map(({ label, uid }) => ({ label, uid })), pass: 'Pass' }, marks);
    if (k < 0 || k >= opts.length) return null;
    const o = opts[k];
    LAST[me] = o.label;
    if (o.shield) { useShield(g, ev, o.shield); SHIELDED.add(ev); return this.respond(g, me, ev); } // bugs7 item 4: React may still follow
    return o.card;
  },
  wantsBattle: (g) => skipBattle !== g.turn,
  oppMain(g, me) {
    const pl = P(g, me);
    const opts: { label: string; uid: number; run: () => void }[] = [];
    quiet(() => {
      for (const c of pl.hand) {
        const f = fx(c);
        if (!f || !f.oppMainAct || !f.handActs) continue;
        f.handActs(g, me, c).forEach((x, i) => { if (x.can(g)) opts.push({ label: cardLabel(c.def.print, c.def.name, 'hand:' + i, x.label), uid: c.uid, kind: 'use', ak: 'hand', run: () => x.run(g) }); });
      }
    });
    if (!opts.length) return;
    const k = ask(me, { type: 'react', title: "Opponent's Main Phase is ending: use a hand ability?", options: opts.map(({ label, uid }) => ({ label, uid })), pass: 'Pass' }, { hand: new Set(opts.map((o) => o.uid)), field: new Set() });
    if (k >= 0 && k < opts.length) withDecider(me, opts[k].run);
  },
  // v14b: cast a Magic in the opponent's turn (ฤๅษี ภฤคุ)
  offTurn(g, me, acts, when) {
    const opts = acts.map((a) => ({ label: `Cast in the opponent's turn: ${a.label.replace(/^cast /, '').replace(/ \(opponent's turn\)$/, '')}`, uid: a.uid }));
    const k = ask(me, { type: 'react', title: `Opponent's turn (${when}): cast a Magic? · ใช้ Magic ในเทิร์นฝ่ายตรงข้าม`, options: opts, pass: 'Pass' }, { hand: new Set(acts.map((a) => a.uid)), field: new Set() });
    if (k < 0 || k >= acts.length) return null;
    LAST[me] = opts[k].label;
    return acts[k];
  },
}; }
// Card choices. Optional ("may") choices get a Skip button: answer -1 = choose none.
setAskSeats([0, 1], (xs, dflt, o) => {
  const me = askSeat() as PID;
  VIEW = me;
  // Scout (สอดแนม): options are ALL revealed cards (o.context); cards the effect can't take have disabled:true.
  // o.none: nothing to choose (or the choice is already made) - the screen just shows the cards, answer with pass.
  if (o.context) {
    const ctx = o.context;
    const q: any = {
      type: 'pick', title: textLabel(o.title || 'สอดแนม'), scout: true,
      options: ctx.map((c) => ({ ...brief(G, c), label: `${c.def.name} · revealed`, disabled: o.none || !xs.includes(c) })),
      def: dflt && !o.none ? ctx.indexOf(dflt) : -1,
    };
    if (o.none) q.pass = 'OK'; else if (o.optional || !xs.length) q.pass = 'Skip';
    const k = ask(me, q);
    if (o.none) return null;
    const c = ctx[k];
    if (c && xs.includes(c)) return c;
    return o.optional ? null : dflt;
  }
  const q: any = {
    type: 'pick', title: o.title ? textLabel(o.title) : `Choose a card${LAST[me] ? ' for ' + LAST[me] : ''}`,
    options: xs.map((c) => ({ ...brief(G, c), label: `${c.def.name} · ${zoneOf(G, c)}` })), def: dflt ? xs.indexOf(dflt) : -1,
  };
  if (o.optional) q.pass = 'Skip';
  const k = ask(me, q);
  if (o.optional && (k < 0 || k >= xs.length)) return null;
  return xs[k] ?? dflt;
});
// Bottom order (scout leftovers): answer = sum(idx_k * 8^k), k = 0..n-1, idx_k = option index of the card at
// depth k from the bottom: k = 0 is the card that ends up at the VERY BOTTOM of the Deck, k = 1 the one just above
// it, ... k = n-1 is the highest of them. Not a permutation of 0..n-1 (or pass / -1) = default order.
// where: 'bottom' (under the Deck, k = 0 = very bottom) or 'top' (back on top: k = 0 is the deepest of the group,
// k = n-1 ends up as the TOP card of the Deck). Same encoding either way.
setOrder((cards, title, where = 'bottom') => {
  const me = askSeat() as PID;
  VIEW = me;
  const n = cards.length;
  let def = 0;
  for (let k = 0; k < n; k++) def += k * 8 ** k;
  const v = ask(me, { type: 'order', title, where, options: cards.map((c) => ({ ...brief(G, c), uid: c.uid, print: c.def.print, name: c.def.name })), def, pass: 'Keep this order' });
  if (!(v >= 0)) return null;
  const idx: number[] = [];
  let r = v;
  for (let k = 0; k < n; k++) { idx.push(r % 8); r = Math.floor(r / 8); }
  if (r !== 0 || new Set(idx).size !== n || idx.some((i) => i >= n)) return null;
  return idx.map((i) => cards[i]);
});
// เลือกปฏิบัติ (choose one mode) and other labelled choices: answer = option index; -1 / out of range = default.
setChoose((title, labels, dflt) => {
  const me = askSeat() as PID;
  const k = ask(me, { type: 'choose', title: textLabel(title), options: labels.map((label) => ({ label: textLabel(label) })), def: dflt });
  return k >= 0 && k < labels.length ? k : dflt;
});
// GEM payment: you click hand cards until their GEM covers the cost (answer = bitmask of options).
setPay((g, p, cost, cands, dflt, forCard) => {
  VIEW = p;
  let def = 0;
  cands.forEach((c, i) => { if (dflt.includes(c)) def |= 1 << i; });
  const mask = ask(p, {
    type: 'pay', title: `Pay ${cost} GEM${forCard ? ' for ' + forCard.def.name : ''}: click cards in your hand`,
    cost, for: forCard ? forCard.uid : null, def,
    forColor: forCard ? colorsEn(forCard).join('/') : '', // bugfix1 item 1: "#" extra colours (เตียวเลี้ยว is blue + purple)
    req: reqOf(g, forCard),
    options: cands.map((c) => ({ ...brief(g, c), gem: gemOf(g, c, forCard), gemColor: gemColorOf(g, c, forCard), label: `${c.def.name} · GEM ${gemOf(g, c, forCard)} ${gemColorOf(g, c, forCard)}` })),
    pass: 'Cancel',
  });
  if (mask <= 0) return null;
  return cands.filter((_, i) => mask & (1 << i));
});
setLogHook((g, s) => {
  if (g !== G) return;
  if (/^(cast|summon|build) /i.test(s)) LAST[g.active] = s;
  // Magic being resolved rides along with the line, so the screen can show it in the Magic Zone
  // even when the state in between is never fetched.
  const res = g.p.map((pl) => (pl.resolving || []).map((c) => cv(g, c)));
  post({ t: 'log', line: { turn: g.turn, who: g.active, active: g.active, phase: g.phase, s, res }, states: states(g) });
  if (/^cast /i.test(s) || /^P[01] reacts with/.test(s)) sleep(700); // the other player sees the Magic
});

// Event lines: same log array as the offline game, with `ev`; `who` = the side the event is about.
function postEv(g: Game, e: GameEv) {
  const res = g.p.map((pl) => (pl.resolving || []).map((c) => cv(g, c)));
  post({ t: 'log', line: { turn: g.turn, who: g.active, active: g.active, phase: g.phase, res, ...e, s: e.s || '' }, states: states(g) });
}
setEvHook((g, e) => {
  if (g !== G) return;
  postEv(g, e);
  // pacing: both screens play each event over this time
  if (e.ev === 'attack') sleep(1100);
  else if (e.ev === 'shield') sleep(500);
  else if (e.ev === 'summon') {
    sleep(2200);
    const ac = findCard(g, (e as any).uid);
    if (ac && ACES[(e as any).who] && ac.def.name === ACES[(e as any).who] && (e as any).how !== 'token') sleep(4200);
  }
  else if (e.ev === 'ability') sleep(1800);
  else if (e.ev === 'lifefx') sleep(2000);
  else if (e.ev === 'chainDone') sleep(1600);
  else if (e.ev === 'shuffle') sleep(700);
  else if (e.ev === 'mill') sleep(1000);
  else if (e.ev === 'reveal') sleep(1500);
});
setPhaseHook((g) => {
  if (g !== G) return;
  if (g.phase === 'Battle' && (g.turn === 1 || skipBattle === g.turn)) return;
  post({ t: 'phase', line: { turn: g.turn, who: g.active, active: g.active, phase: g.phase, s: `${g.phase} Phase`, ph: true }, states: states(g) });
  sleep(g.phase === 'Draw' && g.turn > 1 ? 2000 : 1100);
});

// ---------- run ----------
const defs = loadDefs();
const A = loadDeck(decks[0], defs), Bd = loadDeck(decks[1], defs);
G = newGame([A.list, Bd.list], [A.name, Bd.name], seed, true, true, [A.life, Bd.life]);
setBrains([makeHuman(0), makeHuman(1)]);
post({ t: 'start', states: states(G), uncoded: [...A.uncoded, ...Bd.uncoded] });

// Dice: seat 0 rolls the blue die, seat 1 the red one (each screen sees itself as blue). Higher goes first.
G.dice = [];
for (;;) {
  const r: [number, number] = [1 + Math.floor(rand(G) * 6), 1 + Math.floor(rand(G) * 6)];
  G.dice.push(r);
  if (r[0] !== r[1]) { G.first = r[0] > r[1] ? 0 : 1; break; }
}
G.active = G.first;
postEv(G, { ev: 'dice', rolls: G.dice, first: G.first });

// Mulligan: both players choose at the same time (answer = bitmask of hand positions).
{
  const last = G.dice[G.dice.length - 1];
  const items = ([0, 1] as PID[]).map((seat) => ({
    seat, marks: NO_MARKS,
    q: {
      type: 'mulligan', title: `${G.first === seat ? 'You go first' : 'Your opponent goes first'} (dice ${seat === 0 ? last.join(' : ') : [last[1], last[0]].join(' : ')}). Mulligan: click the cards you want to change`,
      options: G.p[seat].hand.map((c) => ({ label: c.def.name, uid: c.uid })), pass: 'Skip (keep this hand)',
    },
  }));
  MULL = true; // mulligan: 60 s each
  const masks = askAll(items);
  for (const seat of [G.first, opp(G.first)] as PID[]) {
    const hand = G.p[seat].hand, mask = masks[seat];
    mulligan(G, seat, mask > 0 ? hand.filter((_, i) => mask & (1 << i)) : []);
  }
  MULL = false;
  sleep(300 + 750 + 2000 + 2600);
}
const w = playGame(G);
postEv(G, { ev: 'gameover', winner: w });
post({ t: 'end', winner: w, states: states(G) });
