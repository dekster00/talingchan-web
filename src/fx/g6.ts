// Card effects for BT08, CC01 (cards not coded in cards.ts / cards2.ts).
// Approximations are marked "approx:". Overdose locks, แผนการ : ตอกฝาโลง and โรงเรียนเวทย์มนต์'s
// "คาถา" trigger need to see other cards' abilities, so this file wraps those hooks on every FX entry
// (see the end of the file). The wrappers do nothing unless one of those cards is in the game.
import { rollDie } from '../engine.ts';
import fs from 'node:fs';
import type { Card, Game, PID } from '../types.ts';
import type { Ev } from '../engine.ts';
import { canChangeCtrl, takeControl, grantKw, landIs as landOn, isLandOn, placeLand, magicImmune, currentSource, lands, useShield } from '../engine.ts';
import { attach as attachCard, canWear, lifeDown } from '../engine.ts'; // v14d
import type { Fx, HandAct } from '../cards.ts';
import { FX, value, best, worst, pickN, worstN, mayDo, chooseMode, oppChoice, oppTargets, removeOpp, search, inMain, cancel, magicOk } from '../cards.ts';
import { costFirst } from '../cards.ts'; // other-team audit Q9
import {
  P, opp, power, draw, destroy, toHell, toHand, discard, detach, summon, shuffle, mill,
  canPlaceAvatar, flippedLife, onceUsed, markOnce, keepValue, log, findCard, fx, rand,
  bestPayment, choosePayment, costOf, silenced, respond, hasKw, uniqueBlocked,
  symIs, symAny, colorIs, scoutDeck, putBottom, silenceFull, summonExact, colorsEn, arrangeTopBottom, decide, humanDeciding
} from '../engine.ts';
// v14 (group C rulings)
import {
  nameHas, flipLifeCard, turnLog, fieldZone, contOff, isAvatarDef, toDeck, toExile, refreshHooks, currentFight, abilityWindow,
} from '../engine.ts';
import { withSource, type AbilityPart, drawPhaseNo, addToHand } from '../engine.ts';
import { gameOf as gameOfCard } from '../view.ts';
import { ensureWear } from './g5.ts';

// ---------- card text (for "has X in its Text Box" checks) ----------
const META = new Map<string, { e: string; ex: string }>();
try {
  const raw = JSON.parse(fs.readFileSync(new URL('../../data/cards.json', import.meta.url), 'utf8'));
  for (const c of raw) if (!META.has(c.name)) META.set(c.name, { e: String(c.effect || ''), ex: String(c.ex || '') });
} catch { /* text checks fall back to the list below */ }
const text = (c: Card) => META.get(c.def.name)?.e ?? '';
const exOf = (c: Card) => META.get(c.def.name)?.ex ?? '';
const BANG_FALLBACK = ['จัน หนวดเขี้ยว', 'อิน สไนเปอร์', 'ทองเหม็น ขวานคลั่ง', 'เมือง ช่างใหญ่', 'พันเรือง ผู้พิทักษ์ไร้พ่าย', 'พ่อแท่น ผู้นำอาวุโส',
  'อาจารย์ธรรมโชติ', 'บุญช่วย ควายรักชาติ', 'ผู้นำของเหล่าวีรชน', 'วิญญาณวีรชน', 'ปืนใหญ่ไทยประดิษฐ์', 'ยันต์ผ้าประเจียด', 'ดาบใบข้าว X',
  'กำแพงด่านสุดท้าย', 'ไอ้ชิด อโยธยา Express', 'เณรคู ศิษย์เอกพระอาจารย์', 'น้าเอี๊ยด นักบรรเลง', 'ดวงจันทร์วันเพ็ญ'];
const bangText = (c: Card) => (META.size ? text(c).includes('ค่ายบางระจัน') : BANG_FALLBACK.includes(c.def.name));

// ---------- helpers (local copies of the cards2.ts ones, which are not exported) ----------
const isA = (c: Card) => c.def.type === 'Avatar' || c.def.type === 'Token';
function named(c: Card, key: string) {
  if (c.def.aka && c.def.aka.some((a) => a.includes(key))) return true;
  if (c.def.name.includes(key)) return true;
  const f = FX[c.def.name];
  return !!(f && f.alias && f.alias.some((a) => a.includes(key)));
}
const onZone = (g: Game, p: PID, key: string) => P(g, p).avatars.filter((a) => named(a, key));
const distinctNames = (cs: Card[]) => new Set(cs.map((c) => c.def.name)).size;
const hellAvatars = (g: Game, p: PID, pred: (c: Card) => boolean = () => true) => P(g, p).hell.filter((c) => isA(c) && pred(c));
const once = (g: Game, p: PID, key: string) => !onceUsed(g, P(g, p), key);
// Look at the top n cards; pick() takes some; the rest go to the bottom or are shuffled in.
// สอดแนม / look at the top n: engine scoutDeck() reveals them, lets the human pick and order the rest
function peek(g: Game, p: PID, n: number, pick: (cs: Card[]) => void, rest: 'bottom' | 'shuffle' | 'hell' | 'top' | 'either' = 'shuffle') {
  scoutDeck(g, p, n, pick, rest);
}
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
  if (!deckToHandOK(g, p)) return null;
  const c = best(list.filter(pred), (x) => keepValue(g, x) + x.def.power * 0.3);
  if (!c || !addToHand(g, c, p, { from: 'deck' })) return null; // v14b: onToHand / blockToHand
  const i = list.indexOf(c); if (i >= 0) list.splice(i, 1);
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
function moveCtrl(g: Game, c: Card, to: PID) {
  if (!canPlaceAvatar(P(g, to))) return false;
  if (!takeControl(g, c, to)) return false;
  log(g, `${c.def.name} moves to P${to}`);
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
const boost = (c: Card, n: number) => { c.temp.push({ power: n, until: 'turn' }); };
const searchDeck = (g: Game, p: PID, pred: (c: Card) => boolean) => (deckToHandOK(g, p) ? search(g, p, pred, 'deck') : null);
const toBottom = (g: Game, c: Card) => { const pl = P(g, c.owner); detach(g, c); pl.deck.push(c); };
const constructs = (g: Game, p: PID) => P(g, p).mz.filter((x) => x.def.type === 'Construct');
const mzToHell = (g: Game, c: Card) => { detach(g, c); c.f = {}; P(g, c.owner).hell.push(c); };

// Symbols / colours / names granted by this group's cards (approx: only this file's checks see them)
function hasSym(g: Game, c: Card, s: string) {
  if (symIs(c, s)) return true; // includes "#" extra symbols
  return c.def.name === 'ผู้กองอึ่งอ่าง' && g.p.some((q) => q.avatars.includes(c));
}
const hasColor = (c: Card, col: string) => colorIs(c, col); // "#" extra colours (e.g. เตียวเลี้ยว is also purple) are in Def.colors
const isKhun = (g: Game, c: Card, col: string) => isA(c) && (named(c, 'ขุนพล') || nameHas(c, 'ขุนพล')) && hasSym(g, c, 'ต่างชาติ') && hasColor(c, col);
// v14: names granted in play (ชู้รักรัททาทุย, จ่าอเวจี: view.ts namesFor) are seen by nameHas everywhere
const isQueen = (g: Game, c: Card) => nameHas(c, 'รัททาทุย นางพญา');
const isSoldier = (g: Game, c: Card) => named(c, 'ทหาร') || named(c, 'รด.') || nameHas(c, 'ทหาร') || nameHas(c, 'รด.');
// แมวนิค: its controller can't take cards from Deck to hand by abilities (v14c FX.blockToHand; this check also stops the bot trying)
function deckToHandOK(g: Game, p: PID) { return !P(g, p).avatars.some((a) => a.def.name === 'แมวนิค' && !silenced(g, a)); }
const hasBangCamp = (g: Game, p: PID) => P(g, p).mz.some((x) => x.def.type === 'Construct' && x.def.name === 'ค่ายบางระจัน');

// Flip n face-down LIFE of p face up (never loses the game; stops when none is face down).
const CAO = 'โจโฉ ผู้นำเบ็ดเสร็จแห่งวุยก๊ก';
// v14: engine flipLifeCard registers each flip at once (its LIFE effect is queued, FX.onLifeFlipped watchers such as
// โจโฉ and กำแพงด่านสุดท้าย run immediately).
function flipLife(g: Game, p: PID, n: number) {
  let k = 0;
  for (let i = 0; i < n; i++) { if (!flipLifeCard(g, p)) break; k++; }
  return k;
}
function caoFlip(g: Game, c: Card) {
  const p = c.ctrl;
  if (!once(g, p, 'cao:' + c.uid)) return;
  markOnce(g, P(g, p), 'cao:' + c.uid);
  peek(g, p, flippedLife(P(g, p)), (top) => { takeSummon(g, p, top, (x) => named(x, 'วุยก๊ก')); }, 'shuffle');
}
// "Destroy a card on the field": the opponent's best Avatar, else a Construct, the Land or an attached Magic.
function anyOppCard(g: Game, p: PID) {
  const o = opp(p);
  return P(g, o).avatars.length > 0 || constructs(g, o).length > 0 || (!!g.land && g.land.owner === o)
    || g.p.some((q) => q.avatars.some((a) => a.mods.some((m) => m.owner === o)));
}
// "destroy 1 card on the field": the player picks any opposing card on the field (Avatar, Construct, Land, attached card)
// (approx: our own cards are not offered)
function destroyAnyCard(g: Game, p: PID) {
  const o = opp(p);
  const avs = P(g, o).avatars, cons = constructs(g, o), land = g.land && g.land.owner === o ? [g.land] : [];
  const mods = g.p.flatMap((q) => q.avatars.flatMap((a) => a.mods)).filter((x) => x.owner === o);
  const x = best([...avs, ...cons, ...land, ...mods], (y) => (avs.includes(y) ? 100 + value(g, y) : cons.includes(y) ? 50 + keepValue(g, y) : land.includes(y) ? 40 : keepValue(g, y)));
  if (!x) return false;
  if (avs.includes(x)) { destroy(g, x, p); return true; }
  if (cons.includes(x)) { mzToHell(g, x); log(g, `destroy ${x.def.name}`); return true; }
  if (g.land === x) { g.land = null; P(g, o).hell.push(x); log(g, `destroy ${x.def.name}`); return true; }
  detach(g, x); P(g, x.owner).hell.push(x); log(g, `destroy ${x.def.name}`); return true;
}
// other-team audit Q19: พระอิศวร เทพผู้ทำลาย destroys any card on the field (Avatars, cards in either Magic Zone, Lands,
// worn cards), its own side included; optional = the สั่งใช้ ("สามารถ")
function shivaDestroy(g: Game, p: PID, optional: boolean) {
  const pool: Card[] = [];
  for (const q of g.p) {
    pool.push(...q.avatars);
    for (const a of q.avatars) pool.push(...a.mods);
    pool.push(...q.mz.filter((x) => !x.f.faceDown || x.def.type !== 'Magic'));
  }
  if (g.land) pool.push(g.land);
  const score = (y: Card) => (y.ctrl === p ? -1 : 1) * (isA(y) ? 100 + value(g, y) : 40 + keepValue(g, y));
  const x = pickN(pool, 1, score, { optional, title: 'พระอิศวร เทพผู้ทำลาย: destroy a card on the field' })[0];
  if (!x) return false;
  if (isA(x) && (P(g, x.ctrl).avatars.includes(x) || P(g, x.ctrl).mz.includes(x))) { destroy(g, x, p); return true; }
  if (g.land === x) { g.land = null; P(g, x.owner).hell.push(x); log(g, `destroy ${x.def.name}`); return true; }
  if (g.p.some((q) => q.mz.includes(x))) { mzToHell(g, x); log(g, `destroy ${x.def.name}`); return true; }
  detach(g, x); P(g, x.owner).hell.push(x); log(g, `destroy ${x.def.name}`); return true;
}
const overdose = (g: Game, c: Card) => flippedLife(P(g, c.ctrl)) >= 3 && !silenced(g, c);
const MY_OD = ['พูรินอล Overdose', 'ชาโค่ล Overdose', 'เซตาม่อน Overdose'];
const hasJutsuOrDC = (c: Card) => { const f = fx(c); return !!(f && (f.jutsu || f.deathCry)) || /จุติ|คำสั่งเสีย/.test(text(c)); };
const hasMillPeek = (c: Card) => /ธรณีสูบ|สอดแนม/.test(text(c));
const hasShieldTie = (c: Card) => { const f = fx(c); return !!(f && (f.shield || f.tieWin)) || /โล่มนุษย์|ลูกฮึด/.test(text(c)); };
function tankLock(g: Game, c: Card) {
  if (c.mods.filter(isA).length < 2) c.f.noAttack = g.turn; else if (c.f.noAttack === g.turn) c.f.noAttack = 0;
}
const SWORD = 'ดาบศักดิ์สิทธิ์';
const swords = (g: Game, p: PID) => P(g, p).avatars.flatMap((a) => a.mods).filter((m) => m.owner === p && m.def.subtype === 'Modification' && named(m, SWORD));
const firstTurnOf = (g: Game, p: PID) => g.turn === (p === g.first ? 1 : 2);
const faceDown = (g: Game, p: PID) => P(g, p).mz.filter((x) => x.def.type === 'Magic' && x.f.faceDown);
const landFree = (g: Game, p: PID) => !g.land || g.land.owner !== p;
function rangerOk(c: Card) { return named(c, 'Tank Ranger') && !named(c, 'รถถัง') && c.def.cost === 3; }
// หนังมนุษย์: send a ริกกี้ from our zone to hell, summon (จุติ) a ริกกี้ with another name from the deck
function rickySwapOk(g: Game, p: PID, s: Card | null) {
  const zone = s ? [s] : onZone(g, p, 'ริกกี้').filter(isA);
  return zone.some((a) => P(g, p).deck.some((x) => isA(x) && named(x, 'ริกกี้') && x.def.name !== a.def.name));
}
function rickySwap(g: Game, p: PID, s: Card) {
  const nm = s.def.name;
  toHell(g, s);
  fromZoneSummon(g, p, P(g, p).deck, (x) => named(x, 'ริกกี้') && x.def.name !== nm, 'jutsu');
  shuffle(g, P(g, p).deck);
}
// กฎร้าน: compare the bottom cards' Avatar cost; the higher side sends one of the other side's Avatars to hell
function shopRule(g: Game, p: PID) {
  const o = opp(p);
  if (!P(g, p).avatars.length || !P(g, o).avatars.length) return;
  const costB = (q: PID) => { const d = P(g, q).deck; const c = d[d.length - 1]; return c && isA(c) ? c.def.cost : 0; };
  const a = costB(p), b = costB(o);
  log(g, `กฎร้าน: bottom costs ${a} vs ${b}`);
  if (a === b) return;
  const win: PID = a > b ? p : o;
  // the higher-Cost side chooses the mode and the target (decide: the human when it is theirs)
  decide(g, win, () => {
    const foes = P(g, opp(win)).avatars, all = [...P(g, win).avatars, ...foes];
    const mode = chooseMode(g, { def: { name: 'กฎร้าน' } } as Card, ['Send an opponent Avatar to Hell', 'Return an Avatar on the field to its owner\'s Deck'], 0);
    if (mode === 0) { const t = best(foes, (x) => value(g, x)); if (t) removeOpp(g, win, t, 'hell', win === p); return; }
    const t = best(all, (x) => (x.ctrl === win ? -1 : 1) * value(g, x));
    if (!t) return;
    if (t.ctrl !== win && win === p && !magicOk(g, p, t)) return;
    toDeck(g, t, 'shuffle', { by: win, viaMagic: win === p }); // v14: leave guards and after-leave triggers
  });
}

Object.assign(FX, {
  // ===== BT08 red =====
  'หุ่นนักรบผู้กล้าปีศาจ : อีวิลไมเกรน': {
    keep: 4,
    jutsu: (g, c) => {
      const p = c.ctrl, pl = P(g, p);
      // the mill 5 is the cost; other-team audit: the human may pay it with 5+ cards left (the bot keeps 12)
      if (pl.deck.length < 5 || !mayDo(g, c, 'จุติ: ธรณีสูบ 5, a weapon from Hell to hand', pl.deck.length >= 12)) return;
      mill(g, p, 5);
      search(g, p, (x) => named(x, 'อาวุธหุ่นนักรบผู้กล้า'), 'hell');
    },
    onOwnMagic: (g, s, m) => {
      const p = s.ctrl;
      if (m.def.subtype !== 'Modification' || !named(m, 'อาวุธหุ่นนักรบผู้กล้า') || !once(g, p, 'evil:' + s.uid)) return;
      markOnce(g, P(g, p), 'evil:' + s.uid);
      const od = P(g, opp(p)); const top = od.deck[0]; if (!top) return;
      od.deck.shift();
      if (top.def.type === 'Magic') { od.hell.push(top); log(g, `${top.def.name} to hell`); } else od.deck.push(top);
    },
  },
  // approx: only this file's ค่ายบางระจัน discard costs (เณรคู) are waived
  'ไอ้ชิด อโยธยา Express': { keep: 2.5 },
  'เณรคู ศิษย์เอกพระอาจารย์': {
    keep: 2.5,
    fieldActs: (g, p, c) => [act('เณรคู: ค่ายบางระจัน Avatars ignore opponent Magic', (g2) => inMain(g2, p) && once(g2, p, 'nenku') && hasBangCamp(g2, p)
      && (P(g2, p).hand.length >= 1 || P(g2, p).avatars.some((a) => a.def.name === 'ไอ้ชิด อโยธยา Express')),
    (g2) => {
      const pl = P(g2, p); markOnce(g2, pl, 'nenku');
      if (!pl.avatars.some((a) => a.def.name === 'ไอ้ชิด อโยธยา Express' && !silenced(g2, a)) && !discardWorst(g2, p, 1)) return;
      // approx: immune to all opponent Magic (the engine has no React-only immunity)
      for (const a of pl.avatars) if (bangText(a)) a.magicImmuneUntil = Math.max(a.magicImmuneUntil, g2.turn);
    })],
  },
  // approx: the Construct's POWER+2 is not modeled (Constructs don't fight in the engine)
  'น้าเอี๊ยด นักบรรเลง': {
    keep: 3,
    aura: (g, s, t) => {
      if (t.ctrl !== s.ctrl || !P(g, s.ctrl).avatars.includes(t) || !P(g, s.ctrl).avatars.includes(s)) return 0;
      return (t !== s && bangText(t) ? 1 : 0) + t.mods.filter((m) => m.owner === s.ctrl && m.def.subtype === 'Modification' && bangText(m)).length;
    },
  },
  'ซุนกวน ผู้นำพยัคฆ์แห่งง่อก๊ก': {
    keep: 6, alias: ['ขุนพล'],
    fieldActs: (g, p, c) => [act('ซุนกวน: 2 ง่อก๊ก/พลเดินทัพ from hell to deck bottom, destroy a card', (g2) => inMain(g2, p) && once(g2, p, 'sunkuan')
      && hellAvatars(g2, p, (x) => named(x, 'ง่อก๊ก') || named(x, 'พลเดินทัพ')).length >= 2 && anyOppCard(g2, p),
    (g2) => {
      markOnce(g2, P(g2, p), 'sunkuan');
      const back = worstN(hellAvatars(g2, p, (x) => named(x, 'ง่อก๊ก') || named(x, 'พลเดินทัพ')), 2, (x) => value(g2, x), { title: 'ซุนกวน: put 2 ง่อก๊ก / พลเดินทัพ from Hell under your Deck' });
      if (back.length < 2) return;
      for (const x of back) detach(g2, x);
      putBottom(g2, p, back, 'ซุนกวน: order the cards under your Deck');
      destroyAnyCard(g2, p);
    })],
  },
  'จิวยี่ กุนซือสำอางแห่งง่อก๊ก': {
    keep: 3.5, alias: ['ขุนพล'],
    jutsu: (g, c) => {
      const p = c.ctrl;
      // cards19 (user 2026-10-19): Construct "เรือรบโบราณ" = name contains, so เรือรบโบราณฉวน (BT12-074) can be built too.
      // "สามารถ": the human picks one or skips; the bot takes the best one.
      peek(g, p, 5, (top) => {
        if (constructs(g, p).length >= 3) return;
        const ok = (x: Card) => x.def.type === 'Construct' && named(x, 'เรือรบโบราณ')
          && constructs(g, p).filter((y) => y.def.name === x.def.name).length < (x.def.czMax || 1);
        const s = pickN(top.filter(ok), 1, (x) => value(g, x) + (x.def.name === 'เรือรบโบราณฉวน' ? 0.5 : 0),
          { optional: true, title: 'จิวยี่: build a Construct "เรือรบโบราณ" from the scouted cards' })[0];
        if (!s || !top.includes(s)) return;
        top.splice(top.indexOf(s), 1); P(g, p).hell.push(s);
        summon(g, p, s, 'effect');
      }, 'bottom');
    },
  },
  // v14: from hand, when our red ขุนพล ชาวต่างชาติ would leave the field in any way (destroyed, to hand / Hell / exile / Deck),
  // by anyone's card, except destruction in a fight: popup "discard จิวท่าย to keep it"
  'จิวท่าย ขุนพลคนเหล็กแห่งง่อก๊ก': {
    keep: 3.5,
    leaveGuard: (g, self, t, info) => {
      const p = self.owner;
      if (!P(g, p).hand.includes(self) || info.battle || info.cost || info.zone !== 'avatars' || t.ctrl !== p || !isKhun(g, t, 'แดง')) return null;
      return { label: `discard จิวท่าย to keep ${t.def.name} on the field`, want: value(g, t) >= 4, run: () => {
        if (!P(g, p).hand.includes(self)) return false;
        discard(g, p, self);
        if (t.def.name === 'ซุนกวน ผู้นำพยัคฆ์แห่งง่อก๊ก') draw(g, p, 1);
        return true;
      } };
    },
  },
  'กาลาฮัด อัศวินโต๊ะกลมแห่งความกล้าหาญ': {
    keep: 4,
    costOf: (g, p, c) => (swords(g, p).length >= 2 ? 4 : c.def.cost),
    staticPower: (g, c) => distinctNames(swords(g, c.ctrl)),
  },
  'เอเจ้นท์สมูท': {
    keep: 2,
    deathCry: (g, c, owner) => peek(g, owner, 3, (top) => { takeHand(g, owner, top, (x) => x.def.name === 'เอเจ้นท์สมูท'); }, 'bottom'),
    staticPower: (g, c) => (g.phase === 'Battle' && g.active === c.ctrl ? Math.floor(P(g, c.ctrl).hell.filter((x) => x.def.name === 'เอเจ้นท์สมูท').length / 2) : 0),
  },
  'ซาบะริว นักกวาดล้างมือเก๋า': {
    keep: 5, tieWin: true, unique: true,
    costOf: (g, p, c) => (P(g, opp(p)).avatars.some((a) => a.def.name === 'เจค นักฆ่ามือเก๋า') ? 0 : c.def.cost),
  },
  'หมอเสริมศักดิ์': {
    keep: 3.5,
    jutsu: (g, c) => peek(g, c.ctrl, 5, (top) => { takeHand(g, c.ctrl, top, (x) => x.def.name === 'หมอมาแล้วววว'); }, 'shuffle'),
    deathCry: (g, c, owner) => { fromZoneSummon(g, owner, P(g, owner).hell, (x) => x !== c && (x.def.cost <= 2 || x.def.name === 'พยาบาล เอ๋')); },
  },

  // ===== BT08 blue =====
  'เปรตรัททาทุย': {
    keep: 3,
    onSummon: (g, c) => {
      const p = c.ctrl, pl = P(g, p);
      const sac = worst(pl.avatars.filter((a) => a !== c && (isQueen(g, a) || named(a, 'รัททาทุย พ่อพันธุ์'))), (a) => value(g, a));
      const pool = hellAvatars(g, p, (x) => hasSym(g, x, 'รัททาทุย') && !named(x, 'รัททาทุย นางพญา') && !named(x, 'รัททาทุย พ่อพันธุ์'));
      if (!sac || !pool.length || Math.max(...pool.map((x) => value(g, x))) < value(g, sac) - 1) return;
      if (!destroy(g, sac, p)) return;
      fromZoneSummon(g, p, P(g, p).hell, (x) => pool.includes(x));
    },
    staticPower: (g, c) => flippedLife(P(g, c.ctrl)),
  },
  'ริกกี้ ฆาตกรถลกหนัง': {
    keep: 3.5,
    onKill: (g, c) => {
      const p = c.ctrl, pl = P(g, p);
      const ok = (x: Card) => isA(x) && named(x, 'ริกกี้') && hasSym(g, x, 'แมลง') && x.def.name !== c.def.name;
      if (!pl.deck.some(ok)) return;
      toHell(g, c);
      fromZoneSummon(g, p, pl.deck, ok, 'jutsu');
      shuffle(g, pl.deck);
    },
  },
  'ริกกี้ เชฟมัมมามิย่า': {
    keep: 3.5,
    jutsu: (g, c) => { const t = best(P(g, opp(c.ctrl)).avatars, (a) => value(g, a) + (power(g, a) <= 2 ? 3 : 0)); if (t) t.bonus -= 2; },
  },
  'ริกกี้ คุณหมอ': {
    keep: 4,
    onKill: (g, c) => { searchDeck(g, c.ctrl, (x) => x.def.name === 'หนังมนุษย์ ชุดแก้แค้น'); },
  },
  // v14: "when our LIFE is flipped" (once per turn) reacts to every flip at once (FX.onLifeFlipped)
  [CAO]: {
    keep: 7, alias: ['ขุนพล'],
    jutsu: (g, c) => { fromZoneSummon(g, c.ctrl, P(g, c.ctrl).hand, (x) => x !== c && isKhun(g, x, 'ฟ้า'), 'jutsu'); },
    onLifeFlipped: (g, c, p) => { if (p === c.ctrl && P(g, p).avatars.includes(c)) caoFlip(g, c); },
    react: {
      on: ['attack'], noLimit: true,
      can: (g, p, c, ev) => ev.actor !== p && !!ev.target && ev.target.ctrl === p && isKhun(g, ev.target, 'ฟ้า') && P(g, p).life.some((l) => !l.faceUp),
      want: (g, p, c, ev) => !!ev.source && power(g, ev.source) >= power(g, ev.target!) && value(g, ev.target!) >= 4 && flippedLife(P(g, p)) <= 2,
      // v14 ruling: the LIFE flipped by this ability does not use its LIFE effect; the attack is cancelled
      resolve: (g, p, c, ev) => {
        const lc = flipLifeCard(g, p);
        const l = lc && P(g, p).life.find((x) => x.card === lc);
        if (l) { l.trig = false; log(g, `${lc!.def.name}: flipped by โจโฉ, its LIFE effect does not happen`); }
        ev.cancelled = true;
      },
    },
  },
  // แทงหลัง is the engine keyword. v14: while our zone has โจโฉ and every other Avatar is a blue ขุนพล ชาวต่างชาติ, the opponent
  // must declare at least one attack per turn when able (engine attackDuty: no End button until then)
  'สุมาอี้ กุนซือเจ้าเล่ห์แห่งวุยก๊ก': {
    keep: 3,
    mustAttackOnce: (g, self, p) => p !== self.ctrl && P(g, self.ctrl).avatars.includes(self) && P(g, self.ctrl).avatars.some((a) => a.def.name === CAO)
      && P(g, self.ctrl).avatars.every((a) => a === self || isKhun(g, a, 'ฟ้า')),
  },
  'เตียวเลี้ยว ขุนพลมือปราบแห่งวุยก๊ก': {
    keep: 4,
    jutsu: (g, c) => peek(g, c.ctrl, 5, (top) => {
      takeHand(g, c.ctrl, top, (x) => isA(x) && named(x, 'ขุนพล') && hasSym(g, x, 'ต่างชาติ') && (hasColor(x, 'ฟ้า') || hasColor(x, 'ม่วง')));
    }, 'shuffle'),
  },
  'โอตะท๊อปโดเนท': {
    keep: 2,
    fieldActs: (g, p, c) => [
      act('โอตะท๊อปโดเนท: equip to ไอดอล', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && once(g2, p, 'otd:' + c.uid) && onZone(g2, p, 'ไอดอล').some((a) => a !== c),
        (g2) => { markOnce(g2, P(g2, p), 'otd:' + c.uid); const w = best(onZone(g2, p, 'ไอดอล').filter((a) => a !== c), (a) => value(g2, a)); if (w) attach(g2, c, w); }),
      act('โอตะท๊อปโดเนท: summon from equipped', (g2) => inMain(g2, p) && c.wearer >= 0 && once(g2, p, 'otd:' + c.uid) && canPlaceAvatar(P(g2, p)),
        (g2) => { markOnce(g2, P(g2, p), 'otd:' + c.uid); summon(g2, p, c, 'effect'); }),
    ],
  },
  // v14: POWER decreases from the opponent's Avatar abilities on our "หิมะ" Avatars become increases (snowTemps below)
  'นายพลทหารหิมะ หลินอัน': {
    keep: 4,
    costOf: (g, p, c) => (P(g, p).hell.filter((x) => named(x, 'ทหารหิมะ')).length >= 10 ? c.def.cost - 2 : c.def.cost),
    aura: (g, s, t) => { if (t.ctrl === s.ctrl && P(g, s.ctrl).avatars.includes(s) && P(g, t.ctrl).avatars.includes(t) && nameHas(t, 'หิมะ')) snowTemps(t); return 0; },
  },

  // ===== BT08 purple =====
  // the LIFE redirect is offered when the attack is declared (as if it had เตะไข่): user confirmed 2026-10-13
  'อีสานสลิงเกอร์ ปิ่น': {
    keep: 3.5,
    kickIf: (g) => !!landOn(g, 'โคกอีสานนูน'),
    onAttack: (g, c) => { if (!!landOn(g, 'โคกอีสานนูน')) mill(g, c.ctrl, 3); },
  },
  // v14: while โรงเรียนเวทย์มนต์ is the Land, the opponent can't use Land Magic at all (FX.blockCast)
  'กัฟแดน ผู้อำนวยการจอมเวทย์': {
    keep: 3.5,
    blockCast: (g, self, p, c) => p !== self.ctrl && P(g, self.ctrl).avatars.includes(self) && c.def.subtype === 'Land' && !!landOn(g, 'โรงเรียนเวทย์มนต์'),
  },
  'พี่ไท่ น้องเฟิง นักดาบวายุ': {
    keep: 4,
    jutsu: (g, c) => {
      const p = c.ctrl, pl = P(g, p);
      if (pl.onceGame['ptnf'] || !firstTurnOf(g, p) || pl.hand.length < 2) return;
      const pool = pl.deck.filter((x) => isA(x) && x.def.cost <= 1);
      if (new Set(pool.map((x) => x.def.symbol)).size < 2) return;
      pl.onceGame['ptnf'] = true;
      discardWorst(g, p, 2);
      const syms = new Set<string>();
      while (syms.size < 3 && canPlaceAvatar(pl)) {
        const x = best(pool.filter((y) => pl.deck.includes(y) && !syms.has(y.def.symbol)), (y) => value(g, y));
        if (!x) break;
        syms.add(x.def.symbol); summon(g, p, x, 'effect');
      }
      shuffle(g, pl.deck);
    },
  },
  // approx: the taken Avatar is equipped without being renamed "โอตะ"
  'เนียจัง ไอดอลอินฟลูเอนเซอร์': {
    keep: 4.5,
    jutsu: (g, c) => {
      const p = c.ctrl, pl = P(g, p);
      if (flippedLife(pl) < 3 && !onZone(g, p, 'มยุราซัง').length) return;
      const ok = (x: Card) => isA(x) && named(x, 'ทัตดนัยซัง');
      summonExact(() => { if (!fromZoneSummon(g, p, pl.hand, ok, 'jutsu')) { fromZoneSummon(g, p, pl.deck, ok, 'jutsu'); shuffle(g, pl.deck); } }); // อัญเชิญ พอดี
    },
    fieldActs: (g, p, c) => {
      const otas = (g2: Game) => onZone(g2, p, 'ไอดอล').flatMap((a) => a.mods).filter((m) => named(m, 'โอตะ'));
      const worth = (g2: Game) => otas(g2).reduce((s, m) => s + (m.def.name === 'โอตะท๊อปโดเนท' ? 2 : 1), 0);
      const key = (g2: Game) => (once(g2, p, 'nia1') ? 'nia1' : onZone(g2, p, 'ทัตดนัยซัง').length && once(g2, p, 'nia2') ? 'nia2' : '');
      return [act('เนียจัง: pop 2 โอตะ, take an opponent Avatar as โอตะ', (g2) => inMain(g2, p) && P(g2, p).avatars.includes(c) && !!key(g2) && worth(g2) >= 2 && P(g2, opp(p)).avatars.length > 0,
        (g2) => {
          markOnce(g2, P(g2, p), key(g2));
          const all = otas(g2); const top = all.find((m) => m.def.name === 'โอตะท๊อปโดเนท');
          const t1 = worst(all, (m) => (m.def.name === 'โอตะท๊อปโดเนท' ? -100 : 0) + keepValue(g2, m));
          const pay = !t1 ? [] : t1.def.name === 'โอตะท๊อปโดเนท' ? [t1] : [t1, ...worstN(all.filter((m) => m !== t1), 1, (m) => keepValue(g2, m))];
          if (top === undefined && pay.length < 2) return;
          for (const m of pay) { detach(g2, m); P(g2, m.owner).hell.push(m); }
          const t = best(P(g2, opp(p)).avatars, (a) => value(g2, a));
          if (!t || !P(g2, p).avatars.includes(c)) return;
          const tf = fx(t);
          if (tf && tf.preventLeave && !silenced(g2, t) && tf.preventLeave(g2, t)) return;
          for (const m of t.mods.splice(0)) { m.wearer = -1; P(g2, m.owner).hell.push(m); }
          attach(g2, t, c); t.bonus = 0;
          log(g2, `${t.def.name} becomes โอตะ on เนียจัง`);
        })];
    },
  },

  // ===== BT08 green =====
  // LIFE cards have no effect in the engine, so อ่อ กระต่ายตาย is never in LIFE and this never triggers
  'เต่า': {
    keep: 3.5,
    jutsu: (g, c) => {
      const p = c.ctrl, pl = P(g, p);
      const RAB = 'อ่อ กระต่ายตาย';
      if (!pl.life.some((l) => l.faceUp && l.card.def.name === RAB)) {
        const l = pl.life.find((x) => !x.faceUp && x.card.def.name === RAB);
        if (!l) return;
        l.faceUp = true;
      }
      const weak = P(g, opp(p)).avatars.filter((a) => power(g, a) < power(g, c));
      const nbs = pl.deck.filter((x) => x.def.name === 'เนยถั่ว');
      const mode = weak.length && nbs.length ? chooseMode(g, c, ['Destroy an opponent Avatar with less POWER', 'Wear เนยถั่ว from Deck'], 0) : weak.length ? 0 : 1;
      if (mode === 0) { const t = best(weak, (a) => value(g, a)); if (t) destroy(g, t, p); return; }
      const nb = nbs[0];
      if (nb) { attach(g, nb, c); shuffle(g, pl.deck); }
    },
  },
  // v14: Overdose texts are FX.textOff hooks (odText): the "#" line switches off all text of our other Avatars (not
  // "Overdose" ones); in Overdose the opponent's จุติ and คำสั่งเสีย are off
  'พูรินอล Overdose': {
    keep: 4,
    textOff: (g, self, t) => odText(g, self, t, () => ['jutsu', 'deathCry']),
    onKill: (g, c, victim) => {
      if (!hasJutsuOrDC(victim)) return;
      const up = P(g, c.ctrl).life.filter((l) => l.faceUp);
      if (up.length && lifeDown(g, c.ctrl, up[Math.floor(rand(g) * up.length)])) log(g, 'พูรินอล turns a LIFE face down'); // v14d: lifeDown
    },
  },
  // in Overdose: opponent Avatars whose text has ธรณีสูบ / สอดแนม have no abilities while this stays; their mills / scouts are cancelled
  'ชาโค่ล Overdose': {
    keep: 4,
    textOff: (g, self, t) => odText(g, self, t, () => (hasMillPeek(t) ? true : null)),
    blockMill: (g, self, kind, owner, by, src) => overdose(g, self) && by === opp(self.ctrl) && !!src && P(g, by).avatars.includes(src),
    onKill: (g, c, victim) => { if (hasMillPeek(victim)) for (const a of onZone(g, c.ctrl, 'Overdose')) a.bonus += 1; },
  },
  // in Overdose: the opponent's Avatars lose โล่มนุษย์ and ลูกฮึด (FX.denyKw) until this leaves
  'เซตาม่อน Overdose': {
    keep: 4.5,
    textOff: (g, self, t) => odText(g, self, t, () => null),
    denyKw: (g, s, t, kw) => (kw === 'shield' || kw === 'tieWin') && t.ctrl !== s.ctrl && P(g, s.ctrl).avatars.includes(s) && overdose(g, s),
    onKill: (g, c, victim) => { if (hasShieldTie(victim)) flipLife(g, opp(c.ctrl), 1); },
  },
  'ฮากลิ้ง วานรกับหมา': {
    keep: 3,
    jutsu: (g, c) => peek(g, c.ctrl, 7, (top) => { takeHand(g, c.ctrl, top, (x) => exOf(x).includes('โดนใจ')); }, 'shuffle'),
  },
  // แทงหลัง is the engine keyword (Def.backstab). v13 ruling: while another green ขุนพล ต่างชาติ is on our zone it can't be
  // attacked and is unaffected by every opponent Magic effect (not only destruction)
  'เล่าปี่ ผู้นำคุณธรรมแห่งจ๊กก๊ก': {
    keep: 5, alias: ['ขุนพล'],
    aura: (g, s, t) => (t.ctrl === s.ctrl && P(g, s.ctrl).avatars.includes(s) && P(g, s.ctrl).avatars.includes(t) && named(t, 'จ๊กก๊ก') ? 1 : 0),
    untargetable: (g, c) => P(g, c.ctrl).avatars.some((a) => a !== c && isKhun(g, a, 'เขียว')),
    // other-team audit Q10 (user): it only can't be chosen as a target by the opponent's Magic (not full Magic immunity)
    noTarget: (g, s, t, by) => t === s && !!by && by.def.type === 'Magic' && by.ctrl !== s.ctrl && P(g, s.ctrl).avatars.includes(s)
      && P(g, s.ctrl).avatars.some((a) => a !== s && isKhun(g, a, 'เขียว')),
  },
  'ขงเบ้ง กุนซือซ่อนกายแห่งจ๊กก๊ก': {
    keep: 4,
    react: {
      on: ['magic'], noLimit: true, onceKey: 'ขงเบ้ง',
      can: (g, p, c, ev) => ev.actor !== p && P(g, p).hand.length >= 1 && P(g, p).avatars.some((a) => a.def.name === 'เล่าปี่ ผู้นำคุณธรรมแห่งจ๊กก๊ก')
        && P(g, p).avatars.every((a) => a === c || isKhun(g, a, 'เขียว')),
      want: (g, p, c, ev) => !!ev.source && keepValue(g, ev.source) >= 4,
      resolve: (g, p, c, ev) => { if (discardWorst(g, p, 1)) ev.cancelled = true; },
    },
  },
  // v14: from hand, after a จ๊กก๊ก Avatar of ours was destroyed (by anyone): summon this (จุติ) by paying its Cost
  'จูล่ง ขุนพลสุภาพบุรุษแห่งจ๊กก๊ก': {
    keep: 4.5,
    jutsu: (g, c) => {
      if (P(g, c.ctrl).avatars.some((a) => a !== c)) return;
      fromZoneSummon(g, c.ctrl, P(g, c.ctrl).hell, (x) => isKhun(g, x, 'เขียว') && x.def.name !== c.def.name);
    },
    react: {
      on: ['destroyed'], noLimit: true, fromHand: true,
      can: (g, p, c, ev) => !!ev.source && !!ev.leave && ev.leave.ctrl === p && ev.leave.zone === 'avatars' && nameHas(ev.source, 'จ๊กก๊ก')
        && canPlaceAvatar(P(g, p), false, c) && !uniqueBlocked(g, p, c) && bestPayment(g, p, costOf(g, p, c), [c], c) !== null,
      want: () => true,
      resolve: (g, p, c) => { const pay = choosePayment(g, p, costOf(g, p, c), [c], c); if (pay && P(g, p).hand.includes(c)) summon(g, p, c, 'jutsu', pay); },
    },
  },
  // v14: +1 POWER (lasting, while it stays) every time a "ทหาร" / "รด." Avatar enters our Avatar Zone. Each arrival is
  // stamped on the arriving card (its f is cleared when it leaves, so a returning card counts again).
  'ราชา รด.': {
    keep: 3,
    staticPower: (g, c) => {
      const pl = P(g, c.ctrl);
      if (!pl.avatars.includes(c)) return 0;
      const k = 'rd:' + c.uid, all = pl.avatars.filter((a) => a !== c && isSoldier(g, a));
      if (!c.f.rdInit) { c.f.rdInit = 1; for (const a of all) a.f[k] = 1; return 0; }
      for (const a of all) if (!a.f[k]) { a.f[k] = 1; c.bonus += 1; log(g, `ราชา รด.: ${a.def.name} entered, POWER +1`); }
      return 0;
    },
    fieldActs: (g, p, c) => [act('ราชา รด.: call ทหาร/รด. from top 2', (g2) => inMain(g2, p) && once(g2, p, 'raja:' + c.uid) && canPlaceAvatar(P(g2, p)) && P(g2, p).deck.length > 4,
      (g2) => { markOnce(g2, P(g2, p), 'raja:' + c.uid); peek(g2, p, 2, (top) => { takeSummon(g2, p, top, (x) => isSoldier(g2, x) && hasSym(g2, x, 'คน') && x.def.name !== 'ราชา รด.'); }, 'shuffle'); })],
  },
  // v14: our green {คน} Avatars get the name "ทหาร" (view.ts namesFor: rules and the detail box)
  'จ่าอเวจี ทหารครูฝึก': {
    keep: 3,
    namesFor: (g: Game, self: Card, t: Card) => (P(g, self.ctrl).avatars.includes(self) && t.ctrl === self.ctrl && P(g, t.ctrl).avatars.includes(t)
      && symIs(t, 'คน') && colorIs(t, 'เขียว') ? ['ทหาร'] : null),
  } as Fx,
  'ปีศาจวานร': {
    keep: 3.5,
    onKill: (g, c) => {
      const p = c.ctrl;
      if (g.active !== p || !once(g, p, 'pvan:' + c.uid) || P(g, p).hand.length < 2 || !P(g, p).avatars.some((a) => a !== c && named(a, 'วานร'))) return;
      markOnce(g, P(g, p), 'pvan:' + c.uid);
      if (discardWorst(g, p, 1)) c.asleep = false;
    },
  },
  // v14: the attack lock is checked when our Battle Phase starts; it can wear only "Tank Ranger" cards (g5 wearOk)
  'รถถังเฟืองเหล็ก': {
    keep: 3,
    staticPower: () => { ensureWear(); return 0; },
    startBattle: (g, c) => { if (g.active === c.ctrl && P(g, c.ctrl).avatars.includes(c)) tankLock(g, c); },
  },

  // ===== BT08 Magic =====
  'ขายแดก !!!': {
    keep: 3,
    canCast: (g, p, c) => P(g, p).hand.some((x) => x !== c && x.def.subtype === 'Modification') && P(g, p).deck.length > 4,
    resolve: (g, p, c) => {
      const d = worst(P(g, p).hand.filter((x) => x !== c && x.def.subtype === 'Modification'), (x) => keepValue(g, x));
      if (!d) return;
      discard(g, p, d); draw(g, p, 2);
    },
  },
  'ขอดูดดดดดด': {
    keep: 3,
    canCast: (g, p) => oppTargets(g, p, true).length > 0 || P(g, p).avatars.length > 0,
    resolve: (g, p) => {
      const t = best(oppTargets(g, p, true), (a) => value(g, a) + (power(g, a) <= 1 ? 3 : 0)); if (t) boost(t, -1);
      const m = best(P(g, p).avatars, (a) => power(g, a) + (a.asleep ? 0 : 2)); if (m) boost(m, 1);
    },
  },
  'หนังมนุษย์ ชุดแก้แค้น': {
    keep: 4,
    canCast: (g, p) => rickySwapOk(g, p, null),
    resolve: (g, p) => {
      const s = worst(onZone(g, p, 'ริกกี้').filter((a) => rickySwapOk(g, p, a)), (a) => value(g, a));
      if (s) rickySwap(g, p, s);
    },
    react: {
      on: ['attack'],
      can: (g, p, c, ev) => ev.actor !== p && !!ev.target && ev.target.ctrl === p && named(ev.target, 'ริกกี้') && rickySwapOk(g, p, ev.target),
      want: (g, p, c, ev) => !!ev.source && power(g, ev.source) >= power(g, ev.target!),
      resolve: (g, p, c, ev) => { if (ev.target && P(g, p).avatars.includes(ev.target)) rickySwap(g, p, ev.target); },
    },
  },
  'Overdose': {
    keep: 3.5,
    canCast: (g, p) => P(g, p).life.filter((l) => !l.faceUp).length >= 3 && flippedLife(P(g, p)) <= 2 && canPlaceAvatar(P(g, p))
      && P(g, p).deck.some((x) => isA(x) && named(x, 'Overdose') && x.def.cost <= 5),
    resolve: (g, p) => {
      flipLife(g, p, 2);
      fromZoneSummon(g, p, P(g, p).deck, (x) => named(x, 'Overdose') && x.def.cost <= 5);
      shuffle(g, P(g, p).deck);
    },
  },
  // v14: the "milled" trigger needs a purple เทพ Avatar's ability or a Magic card (MillInfo, like สกัลด์)
  'การสละชีพของเทพธิดา': {
    keep: 3.5,
    canCast: (g, p) => onZone(g, p, 'เทพธิดาแห่งวัลฮัลลา').length > 0 && oppTargets(g, p, true).length > 0,
    resolve: (g, p) => {
      const s = worst(onZone(g, p, 'เทพธิดาแห่งวัลฮัลลา'), (a) => value(g, a));
      if (!s || !destroy(g, s, p)) return;
      const t = best(oppTargets(g, p, true), (a) => value(g, a)); if (t) destroy(g, t, p, true);
    },
    onMilled: (g, c, p, v, info) => {
      const ok = !!info && (info.duringMagic || (!!info.src && isA(info.src) && symIs(info.src, 'เทพ') && colorIs(info.src, 'ม่วง')));
      if (ok) fromZoneSummon(g, p, P(g, p).hell, (x) => nameHas(x, 'เทพธิดาแห่งวัลฮัลลา'));
    },
  },
  'โจมตีตัวฉันให้โดนถ้าหากเธอทำได้': {
    keep: 4,
    react: {
      on: ['attack'],
      can: (g, p, c, ev) => ev.actor !== p && P(g, p).avatars.some((a) => a !== ev.target),
      want: (g, p, c, ev) => {
        const att = ev.source; if (!att) return false;
        const t = best(P(g, p).avatars.filter((a) => a !== ev.target), (a) => power(g, a));
        return !!t && power(g, t) >= power(g, att) && (!ev.target || power(g, ev.target) < power(g, att));
      },
      resolve: (g, p, c, ev) => { const t = best(P(g, p).avatars.filter((a) => a !== ev.target), (a) => power(g, a)); if (t) ev.target = t; },
    },
  },
  // The death-cry window this answers is opened by the wrapper at the end of this file.
  'แผนการ : ตอกฝาโลง': {
    keep: 3.5,
    react: {
      on: ['ability'],
      can: (g, p, c, ev) => ev.actor !== p && !!(ev as any).deathCry,
      want: (g, p, c, ev) => !!ev.source && keepValue(g, ev.source) >= 3,
      resolve: cancel,
    },
  },
  'แหม่อ้ายก็~~~': {
    keep: 4.5,
    react: {
      on: ['attack'], can: (g, p, c, ev) => ev.actor !== p,
      want: (g, p, c, ev) => {
        if (!ev.source) return false;
        if (ev.target) return power(g, ev.source) >= power(g, ev.target) && value(g, ev.target) >= 4;
        return flippedLife(P(g, p)) >= 3;
      },
      resolve: cancel,
    },
  },
  // v14: React after our {รัททาทุย} Avatar was destroyed (by anyone) and is already in Hell
  'รัททาทุยเกาะหน้า': {
    keep: 4,
    react: {
      on: ['destroyed'],
      can: (g, p, c, ev) => !!ev.source && !!ev.leave && ev.leave.ctrl === p && ev.leave.zone === 'avatars' && symIs(ev.source, 'รัททาทุย'),
      want: (g, p) => oppTargets(g, p, true).some((a) => costOf(g, a.ctrl, a) <= 5),
      resolve: (g, p) => {
        const t = best(oppTargets(g, p, true).filter((a) => costOf(g, a.ctrl, a) <= 5), (a) => value(g, a)); if (t) destroy(g, t, p, true);
        fromZoneSummon(g, p, P(g, p).deck, (x) => hasSym(g, x, 'รัททาทุย') && x.def.cost === 1 && x.def.gem === 1 && x.def.power === 1);
        shuffle(g, P(g, p).deck);
      },
    },
  },
  // v14: "destroy this instead" covers every way the wearer leaves (fight, destroy, hand, exile, Deck); not control changes
  'ดาบศักดิ์สิทธิ์ เอกซ์คาลิเบอร์': {
    keep: 4,
    canCast: (g, p) => onZone(g, p, 'อาเธอร์ ราชาแห่งอัศวินโต๊ะกลม').length > 0,
    modTarget: (g, p) => best(onZone(g, p, 'อาเธอร์ ราชาแห่งอัศวินโต๊ะกลม'), (a) => value(g, a)),
    modPower: () => 2,
    leaveGuard: (g, self, t, info) => (t.uid === self.wearer && !info.cost
      ? { label: `destroy ${self.def.name} instead of ${t.def.name} leaving`, want: true, run: () => toHell(g, self, { cost: true }) } : null),
    hellActs: (g, p, c) => [act('เอกซ์คาลิเบอร์: equip from hell', (g2) => inMain(g2, p) && !P(g2, p).used.Modification && P(g2, p).hell.includes(c)
      && onZone(g2, p, 'อาเธอร์ ราชาแห่งอัศวินโต๊ะกลม').length > 0,
    (g2) => {
      P(g2, p).used.Modification = true;
      const w = best(onZone(g2, p, 'อาเธอร์ ราชาแห่งอัศวินโต๊ะกลม'), (a) => value(g2, a));
      if (w && P(g2, p).hell.includes(c)) attach(g2, c, w);
    })],
  },
  // approx: the green ลูกฮึด is played as "wins a tie" inside the fight (unless the other side has ลูกฮึด)
  'ขวาน 7 สี': {
    keep: 3,
    canCast: (g, p) => P(g, p).avatars.length > 0,
    modTarget: (g, p) => best(P(g, p).avatars, (a) => value(g, a) + (a.asleep ? 0 : 2)),
    onWearerAttack: (g, m, w) => {
      if (hasColor(w, 'แดง')) w.temp.push({ power: 2, until: 'battle' });
      if (hasColor(w, 'ฟ้า')) draw(g, w.ctrl, 1);
      if (hasColor(w, 'ม่วง')) { mill(g, w.ctrl, 1); boost(w, 1); }
    },
    grant: (g, s, t, kw) => kw === 'tieWin' && s.wearer === t.uid && hasColor(t, 'เขียว'), // "สีเขียว Avatar ใบนี้ได้รับ ลูกฮึด" (v13 keyword grant)
  },
  'เนยถั่ว': {
    keep: 2,
    canCast: (g, p) => P(g, p).avatars.some((a) => a.def.name === 'เต่า'),
    modTarget: (g, p) => best(P(g, p).avatars.filter((a) => a.def.name === 'เต่า'), (a) => value(g, a)),
    wearerBattle: (g, m, w, other) => { other.temp.push({ power: -1, until: 'battle' }); },
  },
  // "อัตโนมัติ เมื่อมีการ ธรณีสูบ: เลือก Avatar 1 ใบ บน Avatar Zone ฝ่ายเรา ได้รับ สามัคคี จนจบเทิร์น"; milled by a purple เทพ
  // Avatar or by a Magic Card: back to hand
  'บิฟร็อสต์ สะพานสายรุ้ง': {
    keep: 2, alias: ['แอสการ์ดคือสถานที่ไม่ใช่ผู้คน'],
    canCast: (g, p) => landFree(g, p),
    onAnyMill: (g, s) => {
      if (!isLandOn(g, s)) return;
      const t = best(P(g, s.ctrl).avatars.filter((a) => !hasKw(g, a, 'unite')), (a) => (a.asleep ? 0 : 3) + power(g, a));
      if (t) { grantKw(g, t, 'unite'); log(g, `บิฟร็อสต์: ${t.def.name} gains สามัคคี until end of turn`); }
    },
    // bugfix1 item 8 (user): onMilled runs after the milling ability ends, so the miller comes from info.src (was currentSource)
    onMilled: (g, c, p, v, info) => {
      const src = info ? info.src : currentSource();
      const ok = (!!info && info.duringMagic) || (!!src && (src.def.type === 'Magic' || (isA(src) && hasSym(g, src, 'เทพ') && hasColor(src, 'ม่วง'))));
      if (ok && P(g, p).hell.includes(c)) { if (addToHand(g, c, p, { from: 'hell' })) log(g, 'บิฟร็อสต์ returns to hand'); }
    },
  },
  // v14: "every time a คาถา is used" = FX.onAnyMagic (any player, cast or React, any Magic whose name has "คาถา")
  'โรงเรียนเวทย์มนต์': {
    keep: 3,
    canCast: (g, p) => landFree(g, p),
    onAnyMagic: (g, s, m) => { if (isLandOn(g, s) && nameHas(m, 'คาถา')) schoolTrigger(g, s); },
    fieldActs: (g, p, c) => {
      const pool = (g2: Game) => P(g2, p).hand.filter((x) => isA(x) && named(x, 'จอมเวทย์') && !(fx(x) && fx(x).noHandSummon) && !uniqueBlocked(g2, p, x));
      const payFor = (g2: Game, x: Card) => { const cost = costOf(g2, p, x); const n = Math.min(faceDown(g2, p).length, cost); return { n, pay: bestPayment(g2, p, cost - n, [x], x) }; };
      return [act('โรงเรียนเวทย์มนต์: summon จอมเวทย์ with face-down Magic as GEM', (g2) => inMain(g2, p) && once(g2, p, 'school') && canPlaceAvatar(P(g2, p))
        && pool(g2).some((x) => payFor(g2, x).pay !== null),
      (g2) => {
        markOnce(g2, P(g2, p), 'school');
        const x = best(pool(g2).filter((y) => payFor(g2, y).pay !== null), (y) => value(g2, y));
        if (!x) return;
        let { n } = payFor(g2, x);
        // other-team audit: "กี่ใบก็ได้": the human chooses how many face-down Magic to use as GEM
        if (humanDeciding(g2)) { const cost = costOf(g2, p, x); const ks: number[] = []; for (let k = n; k >= 0; k--) if (bestPayment(g2, p, cost - k, [x], x) !== null) ks.push(k); if (ks.length > 1) n = ks[chooseMode(g2, c, ks.map((k) => `use ${k} face-down Magic as GEM`), 0)]; }
        const pay = choosePayment(g2, p, costOf(g2, p, x) - n, [x], x);
        if (!pay) return;
        for (const m of worstN(faceDown(g2, p), n, (y) => keepValue(g2, y), { title: `โรงเรียนเวทย์มนต์: send ${n} face-down Magic to Hell` })) mzToHell(g2, m);
        summon(g2, p, x, 'paid', pay);
      })];
    },
  },
  // "#up to 3 with this name in the Construct Zone" (Def.czMax: built from hand or by effect); option 1 takes the card to hand
  // or summons it (the controller chooses)
  'เรือรบโบราณ': {
    keep: 3,
    fieldActs: (g, p, c) => [
      act('เรือรบโบราณ: find พลเดินทัพ/ขุนพล from top 5', (g2) => inMain(g2, p) && once(g2, p, 'ship:' + c.uid) && P(g2, p).deck.length > 6,
        (g2) => {
          markOnce(g2, P(g2, p), 'ship:' + c.uid);
          const ok = (x: Card) => isA(x) && x.def.power <= 2 && (named(x, 'พลเดินทัพ') || (named(x, 'ขุนพล') && hasSym(g2, x, 'ต่างชาติ')));
          peek(g2, p, 5, (top) => {
            const x = best(top.filter(ok), (y) => value(g2, y));
            if (!x) return;
            const can = canPlaceAvatar(P(g2, p), false, x) && !uniqueBlocked(g2, p, x);
            const m = can ? chooseMode(g2, c, [`Add ${x.def.name} to your hand`, `Summon ${x.def.name} to your Avatar Zone`], 1) : 0;
            if (m === 1 && takeSummon(g2, p, top, (y) => y === x)) return;
            takeHand(g2, p, top, (y) => y === x);
          }, 'bottom');
        }),
      act('เรือรบโบราณ: พลเดินทัพ from hell to deck', (g2) => inMain(g2, p) && once(g2, p, 'ship:' + c.uid) && hellAvatars(g2, p, (x) => named(x, 'พลเดินทัพ')).length > 0,
        (g2) => {
          markOnce(g2, P(g2, p), 'ship:' + c.uid);
          const x = hellAvatars(g2, p, (y) => named(y, 'พลเดินทัพ'))[0];
          if (x) { detach(g2, x); P(g2, p).deck.push(x); shuffle(g2, P(g2, p).deck); }
        }),
    ],
  },
  'สนามของนักวิ่งตัวจริง': {
    keep: 1.5,
    aura: (g, s, t) => (P(g, s.ctrl).mz.includes(s) && t.ctrl === s.ctrl && isA(t) && t.def.cost === 0 && P(g, s.ctrl).avatars.includes(t) ? 1 : 0),
  },
  // v14 (reading of "ปรับ เลย"): it can be chosen as an attack target, except while วอเตอร์แมน is on our Avatar Zone
  'ยิมทมิฬ': {
    keep: 2.5,
    canBeAttacked: (g, s, con) => con === s && P(g, s.ctrl).mz.includes(s) && !P(g, s.ctrl).avatars.some((a) => nameHas(a, 'วอเตอร์แมน')),
    aura: (g, s, t) => (P(g, s.ctrl).mz.includes(s) && named(t, 'บึงทมิฬ') && named(t, 'People') && g.p.some((q) => q.avatars.includes(t)) ? 1 : 0),
    grant: (g, s, t, kw) => kw === 'unite' && P(g, s.ctrl).mz.includes(s) && named(t, 'บึงทมิฬ') && named(t, 'People'),
  },
  'บัลลังก์โอดิน': {
    keep: 3,
    aura: (g, s, t) => {
      const pl = P(g, s.ctrl);
      if (!pl.mz.includes(s) || t.ctrl !== s.ctrl || g.phase !== 'Battle' || g.active !== s.ctrl || !pl.avatars.includes(t)) return 0;
      if (!hasSym(g, t, 'เทพ') || !hasColor(t, 'ม่วง')) return 0;
      return named(t, 'โอดิน') ? 3 : 1;
    },
    fieldActs: (g, p, c) => [act('บัลลังก์โอดิน: destroy this, โอดิน from hell to hand', (g2) => inMain(g2, p) && once(g2, p, 'throne') && P(g2, p).mz.includes(c)
      && hellAvatars(g2, p, (x) => named(x, 'โอดิน')).length > 0,
    (g2) => { markOnce(g2, P(g2, p), 'throne'); mzToHell(g2, c); search(g2, p, (x) => isA(x) && named(x, 'โอดิน'), 'hell'); })],
    onMilled: (g, c, p) => { if (constructs(g, p).length < 3) summon(g, p, c, 'effect'); },
  },

  // ===== CC01 Avatars =====
  'พระอิศวร เทพผู้ทำลาย': {
    keep: 8,
    // other-team audit Q19 (user): "การ์ด บนสนาม" = any card on the field, either side (the bot aims at the opponent's)
    jutsu: (g, c) => { shivaDestroy(g, c.ctrl, false); },
    fieldActs: (g, p, c) => [act('พระอิศวร: destroy a card', (g2) => inMain(g2, p) && once(g2, p, 'shiva') && (anyOppCard(g2, p) || humanDeciding(g2)),
      (g2) => { markOnce(g2, P(g2, p), 'shiva'); shivaDestroy(g2, p, true); })],
  },
  'พระนารายณ์ เทพผู้พิทักษ์': {
    keep: 6, shield: true,
    kickIf: () => true,
    protectSelf: (g, c, by) => {
      if (by === c.ctrl || c.f.halved || !mayDo(g, c, 'halve its base POWER instead of being destroyed', true)) return false;
      c.f.halved = 1; c.bonus -= Math.ceil(c.def.power / 2);
      log(g, 'พระนารายณ์ halves its POWER instead of being destroyed');
      return true;
    },
  },
  'พระพรหม เทพผู้สร้าง': {
    keep: 6,
    jutsu: (g, c) => {
      const p = c.ctrl, pl = P(g, p);
      if (distinctNames(hellAvatars(g, p)) < 5) return;
      peek(g, p, 7, (top) => {
        const names = new Set(pl.avatars.map((a) => a.def.name));
        while (canPlaceAvatar(pl)) {
          const x = pickN(top.filter((y) => isA(y) && !names.has(y.def.name)), 1, (y) => value(g, y), { optional: true })[0];
          if (!x) break;
          names.add(x.def.name);
          top.splice(top.indexOf(x), 1); x.f.viaScout = 1; pl.hell.push(x);
          summon(g, p, x, 'effect');
        }
      }, 'shuffle');
    },
  },
  'พระอินทร์ เทพขยัน': {
    keep: 3,
    jutsu: (g, c) => peek(g, c.ctrl, 3, (top) => { takeHand(g, c.ctrl, top, (x) => hasSym(g, x, 'เทพ')); }, 'bottom'),
  },
  // v14: flips our top LIFE whenever it leaves the field (destroyed, to hand, Hell, exile, Deck): FX.afterLeave
  'ปื๊ดเปรตกังฟู': {
    keep: 3.5,
    staticPower: (g, c) => P(g, c.ctrl).life.filter((l) => !l.faceUp).length,
    afterLeave: (g, c, info) => { flipLife(g, info.ctrl, 1); },
  },
  'ไตรตัน เจ้าสมุทร': {
    keep: 7,
    jutsu: (g, c) => {
      const p = c.ctrl; let budget = 7;
      while (canPlaceAvatar(P(g, p))) {
        const x = pickN(hellAvatars(g, p, (y) => hasSym(g, y, 'ปลา') && y.def.cost <= budget), 1, (y) => value(g, y), { optional: true, title: `ไตรตัน: summon a ปลา from Hell (Cost left ${budget})` })[0];
        if (!x) break;
        budget -= x.def.cost;
        summon(g, p, x, 'effect');
      }
    },
    aura: (g, s, t) => (P(g, s.ctrl).avatars.includes(s) && t.ctrl === s.ctrl && P(g, s.ctrl).avatars.includes(t) && hasSym(g, t, 'ปลา') ? 1 : 0),
    grant: (g, s, t, kw) => kw === 'unite' && P(g, s.ctrl).avatars.includes(s) && t.ctrl === s.ctrl && hasSym(g, t, 'ปลา'),
  },
  // approx: the swap after the fight is used only after it wins a fight
  'วีรบุรุษสุดซอย': {
    keep: 4.5,
    jutsu: (g, c) => {
      for (const k of ['กุ่ย', 'ฮอล', 'นาย']) {
        const x = best(hellAvatars(g, c.ctrl, (y) => named(y, k)), (y) => y.def.power);
        if (x) attach(g, x, c);
      }
    },
    onKill: (g, c) => { // the swap after a fight it won (confirmed by the user, v14)
      const p = c.ctrl, pl = P(g, p);
      if (!['กุ่ย', 'ฮอล', 'นาย'].every((k) => c.mods.some((m) => isA(m) && named(m, k)))) return;
      const ok = (x: Card) => x.def.name === 'วีรบุรุษปากซอย';
      const x = pl.hand.find(ok) || pl.deck.find(ok);
      if (!x) return;
      const fromDeck = pl.deck.includes(x);
      toHell(g, c);
      summon(g, p, x, 'jutsu');
      if (fromDeck) shuffle(g, pl.deck);
    },
  },
  'คนอีสาน ยุคครีเตเชียส': { keep: 3, jutsu: (g, c) => { searchDeck(g, c.ctrl, (x) => x.def.name === 'แมลงปอทอด'); } },
  // v14: once we summoned "รัททาทุย นางพญา" this game, it is also named so while on the Avatar Zone (namesFor)
  'ชู้รักรัททาทุย': {
    keep: 2.5,
    namesFor: (g: Game, self: Card, t: Card) => (t === self && P(g, self.ctrl).avatars.includes(self) && P(g, self.ctrl).once['summoned:รัททาทุย นางพญา'] !== undefined ? ['รัททาทุย นางพญา'] : null),
  } as Fx,
  'ลุงบุญโชค': { keep: 2.5, jutsu: (g, c) => { searchDeck(g, c.ctrl, (x) => x.def.name.includes('สมชายห้องเช่า')); } },
  // v14: while it is on the Avatar Zone our Hell {นรก} Avatars are also named "นายนิรยบาล" (namesFor: every check, detail box).
  // "#" deck rule: it can enter the field only when its owner has a สุวาน in the game (deck check also in sim.ts validate).
  'พญายม With The Shotgun': {
    keep: 5,
    namesFor: (g: Game, self: Card, t: Card) => (P(g, self.ctrl).avatars.includes(self) && P(g, self.ctrl).hell.includes(t) && symIs(t, 'นรก') ? ['นายนิรยบาล'] : null),
    summonIf: (g, p, c) => { const q = P(g, c.owner); return [q.deck, q.hand, q.hell, q.avatars, q.mz, q.exile, q.life.map((l) => l.card)].some((z) => z.some((x) => x.def.name === 'สุวาน')); },
    fieldActs: (g, p, c) => [act('พญายม With The Shotgun: revive นายนิรยบาล', (g2) => inMain(g2, p) && once(g2, p, 'yomshot') && canPlaceAvatar(P(g2, p))
      && hellAvatars(g2, p, (x) => nameHas(x, 'นายนิรยบาล')).length > 0,
    (g2) => { markOnce(g2, P(g2, p), 'yomshot'); fromZoneSummon(g2, p, P(g2, p).hell, (x) => nameHas(x, 'นายนิรยบาล')); })],
  } as Fx,
  'เฟรนชี่': {
    keep: 2,
    deathCry: (g, c, owner) => {
      draw(g, owner, 2);
      const d = worst(P(g, owner).hand, (x) => keepValue(g, x));
      if (d) { detach(g, d); P(g, owner).deck.push(d); }
    },
  },
  'เจนนี่': {
    keep: 1,
    onSummon: (g, c) => { c.f.noAttack = g.turn; },
    startMain: (g, c) => { c.f.noAttack = g.turn; },
    // rolls in its controller's End Phase (it changes sides each time, so it rolls almost every End Phase): confirmed (v14)
    endPhase: (g, c) => {
      const ctrl = c.ctrl;
      if (d6(g) === 4) { log(g, 'เจนนี่ rolls 4'); if (destroy(g, c, null)) flipLife(g, ctrl, 1); }
      else moveCtrl(g, c, opp(ctrl));
    },
  },
  'HR ผู้รู้ความจริง': {
    keep: 3,
    jutsu: (g, c) => peek(g, c.ctrl, 2, (top) => { takeHand(g, c.ctrl, top, () => true); }, 'either'),
  },
  // v14: once per turn, when another Avatar is summoned (by either player; not its own summon) it moves to the other side.
  // The summon event is seen through FX.blockReact (it sees every summon before its React window).
  'แมวนิค': {
    keep: 2.5,
    blockReact: (g, self, ev) => {
      if (ev.kind !== 'summon' || ev.source === self || !P(g, self.ctrl).avatars.includes(self) || self.f.catTurn === g.turn) return null;
      self.f.catTurn = g.turn;
      decide(g, self.ctrl, () => withSrc(self, () => moveCtrl(g, self, opp(self.ctrl))));
      return null;
    },
    // v14c: its controller can't put cards from Deck into the hand by abilities (rules draws are not abilities)
    blockToHand: (g, self, c, p, from, by, src) => from === 'deck' && p === self.ctrl && !!src && !silenced(g, self) && P(g, self.ctrl).avatars.includes(self),
  },
  // v14: when our {ยักษ์} Avatar is chosen by a Magic, this may rest to become the target instead ('targeted' window)
  'ยักษ์หินแผ่นดินใหญ่': {
    keep: 3, shield: true,
    react: {
      on: ['targeted'], noLimit: true,
      can: (g, p, c, ev) => !!ev.source && ev.source.def.type === 'Magic' && ev.actor !== p && !!ev.target && ev.target !== c && ev.target.ctrl === p
        && P(g, p).avatars.includes(ev.target) && symIs(ev.target, 'ยักษ์') && !c.asleep && P(g, p).avatars.includes(c),
      want: (g, p, c, ev) => value(g, ev.target!) >= value(g, c),
      resolve: (g, p, c, ev) => { c.asleep = true; ev.target = c; log(g, `ยักษ์หินแผ่นดินใหญ่ rests and becomes the target of ${ev.source!.def.name}`); },
    },
  },
  'เสามงคล ทรงจีน': {
    keep: 3,
    onSummon: (g, c) => { c.f.noAttack = g.turn; },
    startMain: (g, c) => { c.f.noAttack = g.turn; },
    jutsu: (g, c) => {
      const pl = P(g, c.ctrl);
      const x = fromZoneSummon(g, c.ctrl, pl.deck, (y) => named(y, 'ผู้เจริญ'));
      shuffle(g, pl.deck);
      if (x && pl.avatars.includes(x)) endToHand(g, x);
    },
    // v14: the summoned ผู้เจริญ returns to hand at the end of the turn even when this card has left (endToHand)
  },
  'หมวดเงียบ ทหารรับจ้าง': {
    keep: 4,
    fieldActs: (g, p, c) => [act('หมวดเงียบ: put an Avatar to sleep', (g2) => inMain(g2, p) && once(g2, p, 'muad:' + c.uid) && P(g2, opp(p)).avatars.some((a) => !a.asleep),
      (g2) => {
        markOnce(g2, P(g2, p), 'muad:' + c.uid);
        const t = best(P(g2, opp(p)).avatars.filter((a) => !a.asleep), (a) => value(g2, a));
        if (t) { t.asleep = true; t.noWakeUntil = Math.max(t.noWakeUntil, g2.turn + 1); t.f.lockBy = c.uid; }
      })],
    // v14: the lock is renewed at every End Phase while this stays; when this leaves the field, the locked Avatars stand up at once
    eachEndPhase: (g, c) => { if (!fieldZone(g, c)) return; for (const q of g.p) for (const a of q.avatars) if (a.f.lockBy === c.uid) a.noWakeUntil = Math.max(a.noWakeUntil, g.turn + 1); },
    afterLeave: (g, c) => {
      for (const q of g.p) for (const a of q.avatars) if (a.f.lockBy === c.uid) { delete a.f.lockBy; a.noWakeUntil = 0; a.asleep = false; log(g, `${a.def.name} stands up (หมวดเงียบ left)`); }
    },
  },
  // v14: every Symbol while on the Avatar Zone (view.ts symbolsFor '*': rules everywhere, "All in one" in the detail box)
  'ผู้กองอึ่งอ่าง': {
    keep: 2.5,
    symbolsFor: (g: Game, self: Card, t: Card) => (t === self && P(g, self.ctrl).avatars.includes(self) ? ['*'] : null),
  } as Fx,

  // ===== CC01 Magic =====
  'รู้สึกเหมือนโดนแย่งเมีย': {
    keep: 2,
    canCast: (g, p) => P(g, opp(p)).avatars.some((a) => a.owner === p),
    resolve: (g) => { for (const q of g.p) for (const a of [...q.avatars]) if (a.ctrl !== a.owner) moveCtrl(g, a, a.owner); },
  },
  'ซ่อมบำรุงประจำปี': {
    keep: 3,
    canCast: (g, p) => P(g, opp(p)).avatars.length > 0 && P(g, p).avatars.length === 0
      && hellAvatars(g, p, (x) => named(x, 'รถถัง')).length > 0 && hellAvatars(g, p, rangerOk).length > 0,
    resolve: (g, p) => {
      const tank = fromZoneSummon(g, p, P(g, p).hell, (x) => named(x, 'รถถัง'));
      const r = best(hellAvatars(g, p, rangerOk), (x) => value(g, x));
      if (tank && r && P(g, p).avatars.includes(tank)) { attach(g, r, tank); if (tank.def.name === 'รถถังเฟืองเหล็ก') tankLock(g, tank); }
    },
  },
  // v14: React when the opponent summons, uses an ability, declares an attack, uses a Magic, or is about to end the turn
  // (the bot may look at the bottom cards: the user said that is fine)
  'กฎร้าน': {
    keep: 3,
    canCast: (g, p) => P(g, p).avatars.length > 0 && P(g, opp(p)).avatars.length > 0,
    resolve: (g, p) => shopRule(g, p),
    react: {
      on: ['summon', 'ability', 'attack', 'magic', 'endTurn'],
      can: (g, p, c, ev) => ev.actor !== p && P(g, p).avatars.length > 0 && P(g, opp(p)).avatars.length > 0,
      want: (g, p) => {
        const b = (q: PID) => { const d = P(g, q).deck; const x = d[d.length - 1]; return x && isA(x) ? x.def.cost : 0; };
        return b(p) > b(opp(p)) && P(g, opp(p)).avatars.some((a) => value(g, a) >= 5);
      },
      resolve: (g, p) => shopRule(g, p),
    },
  },
  'ขอให้ทั้งตัวมีแต่---': {
    keep: 4,
    react: {
      on: ['fight'],
      can: (g, p, c, ev) => !!ev.source && !!ev.target && ev.target.ctrl === p && ev.source.ctrl !== p && magicOk(g, p, ev.source),
      want: (g, p, c, ev) => power(g, ev.target!) <= power(g, ev.source!) && power(g, ev.source!) - ev.source!.def.power < power(g, ev.target!),
      resolve: (g, p, c, ev) => { if (ev.source) ev.source.temp.push({ power: -ev.source.def.power, until: 'turn' }); },
    },
  },
  // v14: its wearer must attack when it can (engine attackDuty: the End button is disabled until it did)
  'ตุ๊กตางูพันคอ': {
    keep: 3,
    canCast: (g, p) => P(g, p).avatars.length > 0,
    modTarget: (g, p) => best(P(g, p).avatars, (a) => value(g, a) + (a.asleep ? 0 : 2)),
    modPower: () => 2,
    mustAttack: (g, m, a) => a.uid === m.wearer,
  },
  'Micro Plaza สะพานพลาสติก': {
    keep: 2.5,
    canCast: (g, p) => landFree(g, p),
    fieldActs: (g, p, c) => [act('Micro Plaza: discard 1, Modification from deck', (g2) => inMain(g2, p) && once(g2, p, 'microplaza') && P(g2, p).hand.length >= 1
      && deckToHandOK(g2, p) && P(g2, p).deck.some((x) => x.def.subtype === 'Modification'),
    (g2) => { markOnce(g2, P(g2, p), 'microplaza'); if (discardWorst(g2, p, 1)) searchDeck(g2, p, (x) => x.def.subtype === 'Modification'); })],
  },
  'SD Plaza สายเหนือเก่า': {
    keep: 2.5,
    canCast: (g, p) => landFree(g, p),
    fieldActs: (g, p, c) => [
      act('SD Plaza: discard 1, Avatar from top 3 to Magic Zone', (g2) => inMain(g2, p) && once(g2, p, 'sdplaza') && P(g2, p).hand.length >= 1 && P(g2, p).deck.length > 5,
        (g2) => {
          const pl = P(g2, p); markOnce(g2, pl, 'sdplaza');
          if (!discardWorst(g2, p, 1)) return;
          peek(g2, p, 3, (top) => {
            const x = best(top.filter(isA), (y) => value(g2, y));
            if (x) { top.splice(top.indexOf(x), 1); x.asleep = false; x.ctrl = p; pl.mz.push(x); log(g2, `${x.def.name} to Magic Zone`); }
          }, 'bottom');
        }),
      act('SD Plaza: summon an Avatar from Magic Zone', (g2) => inMain(g2, p) && once(g2, p, 'sdplaza') && canPlaceAvatar(P(g2, p)) && P(g2, p).mz.some(isA),
        (g2) => {
          markOnce(g2, P(g2, p), 'sdplaza');
          const x = best(P(g2, p).mz.filter(isA), (y) => value(g2, y));
          if (x && summon(g2, p, x, 'effect')) x.asleep = false;
        }),
    ],
  },
  // v14c: at the start of each player's Main Phase, that player draws 1 per เสามงคล on their Avatar Zone (FX.mainStart)
  'สมชายห้องเช่าพันล้าน': {
    keep: 3,
    canCast: (g, p) => landFree(g, p),
    fieldActs: (g, p, c) => [act('สมชาย: discard 1, เสามงคล from deck', (g2) => inMain(g2, p) && once(g2, p, 'somchai') && P(g2, p).hand.length >= 1 && canPlaceAvatar(P(g2, p))
      && P(g2, p).deck.some((x) => isA(x) && named(x, 'เสามงคล')),
    (g2) => {
      markOnce(g2, P(g2, p), 'somchai');
      if (!discardWorst(g2, p, 1)) return;
      fromZoneSummon(g2, p, P(g2, p).deck, (x) => named(x, 'เสามงคล')); shuffle(g2, P(g2, p).deck);
    })],
    mainStart: (g) => {
      const nx = g.active;
      const n = P(g, nx).avatars.filter((a) => named(a, 'เสามงคล')).length;
      if (n > 0) { draw(g, nx, n); log(g, `สมชาย: P${nx} draws ${n}`); }
    },
  },
} as Record<string, Fx>);

// ---------- hook wrappers ----------
// แผนการ : ตอกฝาโลง (a response window for คำสั่งเสีย) needs to see other cards' คำสั่งเสีย: each FX entry's deathCry is
// wrapped once; the wrapper does nothing unless that card is in the game. (v14: the Overdose locks are FX.textOff hooks and
// โรงเรียนเวทย์มนต์ uses FX.onAnyMagic, so they no longer wrap other cards.)
type Watch = { coffin: boolean };
function watch(g: Game): Watch {
  const gg = g as any;
  if (!gg.__g6) {
    ensureWrapped();
    const names = new Set<string>();
    for (const q of g.p) for (const z of [q.deck, q.hand, q.avatars, q.hell, q.exile, q.mz, q.resolving || []]) for (const c of z) { names.add(c.def.name); for (const m of c.mods) names.add(m.def.name); }
    gg.__g6 = { coffin: names.has('แผนการ : ตอกฝาโลง') };
  }
  return gg.__g6;
}
const WRAPPED = new WeakSet<object>();
let wrappedCount = -1;
function wrapFx(name: string, f: any) {
  if (!f || typeof f !== 'object' || WRAPPED.has(f)) return;
  WRAPPED.add(f);
  if (typeof f.deathCry === 'function') {
    const o = f.deathCry;
    f.deathCry = function (g: Game, c: Card, owner: PID) {
      if (watch(g).coffin && !g.sim) {
        const ev: Ev = { kind: 'ability', actor: owner, source: c, cancelled: false, depth: 0 };
        (ev as any).deathCry = true;
        respond(g, ev);
        if (ev.cancelled) { log(g, `${c.def.name}: คำสั่งเสีย cancelled`); return; }
      }
      return o.call(this, g, c, owner);
    };
  }
}
function ensureWrapped() {
  const keys = Object.keys(FX);
  if (keys.length === wrappedCount) return;
  wrappedCount = keys.length;
  for (const k of keys) wrapFx(k, FX[k]);
}

// =====================================================================================================================
// v14 group C helpers and extensions of entries first coded in earlier files (cards2.ts, g1, g2 ...)
// =====================================================================================================================
const withSrc = <T>(c: Card, fn: () => T): T => withSource(c, fn);
// Overdose (BT08-031/032/033). "#Avatar ทุกใบในสนามฝ่ายเราจะไม่สามารถใช้ความสามารถได้ยกเว้น Avatar Overdose": our other
// Avatars on the field lose all their text (ลูกฮึด / ต่อเนื่อง / คำสั่งเสีย too) but can still be summoned and attack. The "#"
// line is a card stat, so it works while this card's own text is off. inOd: what the card's Overdose state switches off.
function odText(g: Game, self: Card, t: Card, inOd: () => boolean | AbilityPart[] | null): boolean | AbilityPart[] | null {
  const pl = P(g, self.ctrl);
  if (!pl.avatars.includes(self) || t === self || !isAvatarDef(t.def)) return null;
  if (t.ctrl === self.ctrl) return pl.avatars.includes(t) && !nameHas(t, 'Overdose') ? true : null;
  return P(g, t.ctrl).avatars.includes(t) && overdose(g, self) ? inOd() : null;
}
// นายพลทหารหิมะ หลินอัน: the temp POWER list of our หิมะ Avatars is swapped for one whose push turns a decrease made by an
// opposing Avatar's ability (the current source) into an increase. (approx: permanent changes to c.bonus are not covered)
const SNOW = new WeakMap<object, Card>();
class SnowTemps extends Array<any> {
  push(...xs: any[]): number {
    const t = SNOW.get(this);
    if (t) {
      const src = currentSource(), g = src ? gameOfCard(t) : null;
      if (g && src && isA(src) && src.ctrl !== t.ctrl && P(g, t.ctrl).avatars.includes(t) && nameHas(t, 'หิมะ')
        && P(g, t.ctrl).avatars.some((a) => a.def.name === 'นายพลทหารหิมะ หลินอัน' && !contOff(g, a))) {
        for (const x of xs) if (x && typeof x.power === 'number' && x.power < 0) { x.power = -x.power; log(g, `หลินอัน: ${t.def.name} gets POWER +${x.power} instead of -${x.power}`); }
      }
    }
    return super.push(...xs);
  }
}
function snowTemps(t: Card) {
  if (SNOW.has(t.temp)) return;
  const arr = new SnowTemps();
  for (const x of t.temp) Array.prototype.push.call(arr, x);
  SNOW.set(arr, t); t.temp = arr as any;
}
// โรงเรียนเวทย์มนต์: a Magic from its controller's Hell goes face down to their Magic Zone
function schoolTrigger(g: Game, school: Card) {
  const p = school.ctrl, pl = P(g, p);
  const m = best(pl.hell.filter((x) => x.def.type === 'Magic'), (x) => -keepValue(g, x));
  if (!m) return;
  detach(g, m); m.f = { faceDown: 1 }; pl.mz.push(m);
  log(g, `โรงเรียนเวทย์มนต์: ${m.def.name} goes face down to the Magic Zone`);
}
// "เมื่อจบเทิร์น นำ Avatar ที่อัญเชิญ ... กลับขึ้นมือ" without the summoner on the field: the summoned card's own entry gets an
// eachEndPhase hook (added once per card name; refreshHooks makes the engine see it).
function endToHand(g: Game, x: Card) {
  x.f.endHandT = g.turn;
  const nm = x.def.name;
  const f: any = FX[nm] || (FX[nm] = { keep: keepValue(g, x) } as Fx);
  if (f.__endHand) return;
  const o = f.eachEndPhase;
  f.eachEndPhase = (g2: Game, s: Card) => {
    if (o) o(g2, s);
    if (s.f.endHandT === g2.turn && P(g2, s.ctrl).avatars.includes(s)) { log(g2, `${s.def.name} returns to hand (end of turn)`); toHand(g2, s); }
  };
  f.__endHand = 1;
  refreshHooks();
}

// พยาบาล เอ๋ BT02-027 (g2): "when this is not destroyed by being attacked": after it was the target of an attack and is still
// on the field when that attack is over (won / tied with ลูกฮึด, React cancel, redirected), its controller may turn a random
// face-up LIFE face down. The 'attack' event is seen through FX.blockReact; the end through afterFight, or (cancelled attacks)
// the next React window outside a fight (at the latest the End Phase window).
function nurseFlip(g: Game, c: Card) {
  delete c.f.nurse;
  const pl = P(g, c.ctrl);
  if (!pl.avatars.includes(c)) return;
  const up = pl.life.filter((l) => l.faceUp);
  if (!up.length || !mayDo(g, c, 'turn a random face-up LIFE face down', true)) return;
  const l = up[Math.floor(rand(g) * up.length)];
  if (lifeDown(g, c.ctrl, l)) log(g, `พยาบาล เอ๋: P${c.ctrl} turns a LIFE face down (${flippedLife(pl)}/5)`); // v14d: lifeDown
}
FX['พยาบาล เอ๋'] = {
  ...FX['พยาบาล เอ๋'], keep: 3.5, onKill: undefined,
  blockReact: (g, self, ev) => {
    if (ev.kind === 'attack' && ev.target === self && ev.actor !== self.ctrl) self.f.nurse = 1;
    else if (self.f.nurse && !currentFight()) decide(g, self.ctrl, () => withSrc(self, () => nurseFlip(g, self)));
    return null;
  },
  afterFight: (g, self) => { if (self.f.nurse) nurseFlip(g, self); },
};

// แอสการ์ดคือสถานที่ไม่ใช่ผู้คน BT02-060 (cards2): every Avatar on an Avatar Zone has the Symbol เทพ (view.ts symbolsFor)
FX['แอสการ์ดคือสถานที่ไม่ใช่ผู้คน'] = {
  ...FX['แอสการ์ดคือสถานที่ไม่ใช่ผู้คน'],
  symbolsFor: (g: Game, self: Card, t: Card) => (isLandOn(g, self) && g.p.some((q) => q.avatars.includes(t)) ? { set: ['เทพ'] } : null),
} as Fx;

// กำแพงด่านสุดท้าย SD06-020 (g1): checked the moment our LIFE is flipped (FX.onLifeFlipped), while our Avatar Zone is empty
{
  const WALL = 'กำแพงด่านสุดท้าย';
  FX[WALL] = {
    ...FX[WALL], endPhase: undefined, startMain: undefined,
    onLifeFlipped: (g, c, p) => {
      const pl = P(g, c.ctrl);
      if (p !== c.ctrl || !pl.mz.includes(c) || pl.avatars.length > 0 || pl.hand.length < 1 || !once(g, p, 'wall') || !pl.deck.length) return;
      if (!mayDo(g, c, 'discard 1 card: สอดแนม 1 (ค่ายบางระจัน Avatar Cost 4 or less is summoned, else to hand)', true)) return;
      markOnce(g, pl, 'wall');
      if (!discardWorst(g, p, 1)) return;
      // วัดคู่บ้านคู่เมือง's +2 comes only from the engine's scoutBonus (scoutDeck with this wall as the source); no own +2
      withSource(c, () => peek(g, p, 1, (top) => {
        for (const x of [...top]) {
          top.splice(top.indexOf(x), 1);
          if (isA(x) && bangText(x) && costOf(g, p, x) <= 4 && canPlaceAvatar(pl, false, x)) { x.f.viaScout = 1; pl.hell.push(x); if (summon(g, p, x, 'effect')) continue; detach(g, x); }
          if (!addToHand(g, x, p, { from: 'deck' })) pl.deck.push(x); // blocked: stays under the Deck
        }
      }, 'bottom'));
    },
  };
}

// รัททาทุย นางพญา BT01-008 (g2): in our first Draw Phase that has a normal draw (the first player's turn 1 has none),
// while it is in our Deck: popup "take this card instead of the draw?" (v14b FX.drawInstead)
FX['รัททาทุย นางพญา'] = {
  ...FX['รัททาทุย นางพญา'], keep: 4,
  drawInstead: (g, s) => drawPhaseNo(g, s.owner) === (s.owner === g.first ? 2 : 1) && P(g, s.owner).deck.includes(s)
    && mayDo(g, s, 'take this card from the Deck instead of the draw', true) && addToHand(g, s, s.owner, { from: 'deck' }),
} as Fx;

ensureWrapped();

// other-team audit Q9 (user: a cancelled Magic keeps its text costs paid): the "cost :" part is paid before the React window
costFirst('ขายแดก !!!', (g, p, c) => {
  const d = worst(P(g, p).hand.filter((x) => x !== c && x.def.subtype === 'Modification'), (x) => keepValue(g, x));
  if (!d) return false;
  discard(g, p, d); return true;
}, (g, p) => { draw(g, p, 2); });
