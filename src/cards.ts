// Card effects, keyed by Thai card name. Only cards in the decks we simulate are coded.
// Effect targets are chosen with simple heuristics on behalf of the card's controller.
import type { Card, Game, PID } from './types.ts';
import type { Ev, LeaveInfo, LeaveGuard, MillInfo, AbilityPart, SummonHow, HandFrom, RuleDef } from './engine.ts';
import {
  P, opp, power, draw, destroy, toHell, toHand, toExile, discard, detach, summon, placeToken, shuffle,
  isNinja, isVanara, nameHas, canPlaceAvatar, flippedLife, critical, onceUsed, markOnce, keepValue,
  realAvatars, TOKEN_VANARA, log, findCard, askPick, humanDeciding, askChoose, gemOf, sourceSays, type AskOpts,
  symIs, symAny, colorIs, scoutDeck, putBottom, silenceFull, summonExact, colorsEn, arrangeTopBottom, decide, magicImmune, takeControl, canChangeCtrl, lands,
  targetFilter, addToHand, hellLocked, lifeDown,
} from './engine.ts';
import { addPower } from './engine.ts'; // v14 answers
import { rand, effectTargetable, textCost, turnLog, isAvatarDef } from './engine.ts'; // other-team audit
import { humanPilePick } from './engine.ts'; // bugs7 item 2
// linkbot: c is in คู่หู with its partner (Link command); by uid so the bot's battle-estimate copies work too
function vanaraPair(g: Game, c: Card, partner: string): boolean {
  return P(g, c.ctrl).avatars.some((a) => a.uid !== c.uid && a.def.name === partner && a.f.linkWith === c.uid && c.f && c.f.linkWith === a.uid);
}

export interface HandAct { label: string; can(g: Game): boolean; run(g: Game): void }
export interface Fx {
  keep?: number; // how much the bot wants to keep this card in hand (vs pitching it as GEM)
  // Avatar hooks
  jutsu?(g: Game, c: Card): void; // จุติ (summoned by paying cost)
  onOwnSummon?(g: Game, c: Card): void; // summoned by its own ability
  deathCry?(g: Game, c: Card, owner: PID): void; // คำสั่งเสีย
  battle?(g: Game, c: Card, other: Card): void; // when this fights
  staticPower?(g: Game, c: Card): number; // ต่อเนื่อง power
  startMain?(g: Game, c: Card): void;
  endPhase?(g: Game, c: Card): void;
  usedAsCost?(g: Game, p: PID, c: Card, summoned: Card): void;
  preventLeave?(g: Game, c: Card): boolean; // return true to stay on field
  saveFromHand?(g: Game, p: PID, self: Card, dying: Card): boolean;
  onPartner?(g: Game, c: Card): void;
  onLifeFlip?(g: Game, c: Card): void;
  onSummon?(g: Game, c: Card, how: string): void; // any summon ("เมื่อการ์ดใบนี้ถูกอัญเชิญ")
  onAttack?(g: Game, c: Card, target: Card | null): void; // when this attacks (after reacts)
  landAttack?(g: Game, land: Card, att: Card): void; // Land: any Avatar attacks (after its onAttack)
  onTargeted?(g: Game, c: Card, attacker: Card): void;
  onKill?(g: Game, c: Card, victim: Card, victimPower: number, victimBase: number): void; // won a fight
  onUnited?(g: Game, c: Card, helper: Card): void;
  onBackstab?(g: Game, c: Card, attacker: Card): void; // this card just used แทงหลัง for attacker
  onMilled?(g: Game, c: Card, p: PID, byVirus: boolean, info?: MillInfo): void; // this card was milled (v14: info = who / which card milled)
  onOwnMagic?(g: Game, src: Card, magic: Card): void; // controller cast a Magic
  drawPhase?(g: Game, c: Card): void;
  aura?(g: Game, src: Card, target: Card): number; // power given to any Avatar
  grant?(g: Game, src: Card, target: Card, kw: string): boolean; // keyword given to any Avatar (read from every card in play: Avatars, Magic Zone, attached cards, Lands, face-up LIFE)
  denyKw?(g: Game, src: Card, target: Card, kw: string): boolean; // keyword taken away ("ฝ่ายตรงข้ามไม่สามารถใช้ สามัคคี")
  canHelp?(g: Game, c: Card, attacker: Card): boolean; // this สามัคคี / แทงหลัง helper may help only these attackers (โลกิ: ธอร์)
  forceShield?: boolean; // when this attacks, the defender must use โล่มนุษย์ if it can (ลิโป้)
  onShieldUsed?(g: Game, src: Card, shield: Card, attacker: Card): void; // any Avatar used โล่มนุษย์ (src = a card in play)
  assistBonus?(g: Game, helper: Card, to: Card, kind: 'unity' | 'backstab'): number; // POWER the helper gains just before it helps (counts in the buff)
  onAssistUsed?(g: Game, src: Card, helper: Card, attacker: Card, kind: 'unity' | 'backstab'): void; // any helper used สามัคคี / แทงหลัง
  onAnyMill?(g: Game, src: Card, p: PID, cards: Card[]): void; // any ธรณีสูบ happened (src = a card in play)
  lockCtrl?: boolean; // Magic Zone card: our Avatars' control can't change (รูปประจำบ้าน)
  magicImmune?(g: Game, c: Card): boolean; // continuous "unaffected by opponent Magic" (เล่าปี่)
  kwIf?(g: Game, c: Card, kw: string): boolean; // conditional own keyword
  kickIf?(g: Game, c: Card): boolean; // conditional เตะไข่
  untargetable?(g: Game, c: Card, attacker?: Card): boolean; // can't be chosen as an attack target (v14: attacker passed)
  taunt?(g: Game, c: Card): boolean; // opponent must attack this
  protectSelf?(g: Game, c: Card, by: PID | null, viaMagic: boolean): boolean;
  unique?: boolean; // only one with this name on our Avatar Zone
  noHandSummon?: boolean; // can't be summoned from hand by paying cost
  costOf?(g: Game, p: PID, c: Card): number;
  costOnlyFor?(forCard: Card): boolean; // may only be discarded as GEM for these cards
  gemAs?(g: Game, c: Card, forCard: Card | null): number;
  hellActs?(g: Game, p: PID, c: Card): HandAct[];
  exileActs?(g: Game, p: PID, c: Card): HandAct[];
  deckActs?(g: Game, p: PID, c: Card): HandAct[]; // bugfix3: "สั่งใช้ จาก Deck" (จอมมาร BT12-001)
  stayMz?: boolean; // Normal Magic that stays in the Magic Zone
  // attached-card hooks
  protectWearer?(g: Game, m: Card, wearer: Card, by: PID | null, viaMagic: boolean): boolean;
  onWearerLeave?(g: Game, m: Card, wearer: Card): boolean;
  wearerBattle?(g: Game, m: Card, wearer: Card, other: Card): void;
  onWearerKill?(g: Game, m: Card, wearer: Card, victimPower: number, victimBase: number): void;
  onAttach?(g: Game, m: Card, wearer: Card): void;
  lockLand?: boolean;
  alias?: string[];
  shield?: boolean; // โล่มนุษย์
  blockShield?: boolean; // bugs7: attached card: the wearer's attacks can't be met with โล่มนุษย์ (อาลอนไดร์ท)
  unite?: boolean; // สามัคคี
  tieWin?: boolean; // ลูกฮึด
  handActs?(g: Game, p: PID, c: Card): HandAct[];
  fieldActs?(g: Game, p: PID, c: Card): HandAct[];
  oppMainAct?: boolean; // its hand ability can be used in the opponent's Main Phase
  // Magic hooks
  options?: number;
  optLabels?: string[]; // human-facing label of each option (Main Phase cast menu)
  canCast?(g: Game, p: PID, c: Card, opt: number): boolean;
  resolve?(g: Game, p: PID, c: Card, opt: number): void;
  modTarget?(g: Game, p: PID, c: Card): Card | null;
  modPower?(g: Game, m: Card, wearer: Card): number;
  onWearerAttack?(g: Game, m: Card, wearer: Card): void;
  landPower?(g: Game, land: Card, a: Card): number;
  zeroKills?: boolean;
  mainUse?: boolean; // a React that can also be played proactively in our Main Phase
  battleUse?(g: Game, p: PID, c: Card): boolean; // proactive use in our Battle Phase (bot calls it)
  // ===== v14 hooks (core-rules). Full list with examples: engine/v14-hooks.md =====
  /** 1. Leave protection: self = a card in play (c itself, its attached cards, any other card) or in a hand; target = the
   *  card about to leave. Return a LeaveGuard when self can keep target on the field, else null. */
  leaveGuard?(g: Game, self: Card, target: Card, info: LeaveInfo): LeaveGuard | null;
  /** 2. This card left the field and is already in its new zone (info.to). Not run when its text was off. */
  afterLeave?(g: Game, self: Card, info: LeaveInfo): void;
  onCastToHell?(g: Game, self: Card): void; // simplify1: this Magic went to Hell straight from its cast (cancelled / no wearer / resolved Normal)
  /** 2. Any card left the field (self in play, in a hand or in a Hell). */
  onAnyLeave?(g: Game, self: Card, gone: Card, info: LeaveInfo): void;
  /** 2. Any card was destroyed (self in play, in a hand or in a Hell); gone is in Hell already. */
  onAnyDestroyed?(g: Game, self: Card, gone: Card, info: LeaveInfo): void;
  /** 2. self (in play) stops the คำสั่งเสีย of dying (checked just before it leaves). */
  blockDeathCry?(g: Game, self: Card, dying: Card, info: LeaveInfo): boolean;
  /** 3. self (in play) suppresses this React window: 'all' = no window, 'magic' / true = no React Magic in it. */
  blockReact?(g: Game, self: Card, ev: Ev): 'all' | 'magic' | boolean | null;
  /** 4. Avatar a must attack when it can (self = a card in play: a itself, its attached card, any card). */
  mustAttack?(g: Game, self: Card, a: Card): boolean;
  /** 4. Player p must declare at least one attack this turn when any Avatar can (สุมาอี้). */
  mustAttackOnce?(g: Game, self: Card, p: PID): boolean;
  /** 5. The opponent's Construct con may be chosen as an attack target by attacker. */
  canBeAttacked?(g: Game, self: Card, con: Card, attacker: Card): boolean;
  /** 5. attacker can't attack LIFE (ป้อมยาม). */
  noLifeAttack?(g: Game, self: Card, attacker: Card): boolean;
  /** 6. Any ธรณีสูบ happened (self in play, in a hand or in a Hell; the milled cards themselves get onMilled instead). */
  onMill?(g: Game, self: Card, owner: PID, cards: Card[], by: PID | null, src: Card | null, info: MillInfo): void;
  /** 6. Cancel a mill / scout before it happens (ชาโค่ล Overdose). owner = whose Deck; by / src = who / which card does it. */
  blockMill?(g: Game, self: Card, kind: 'mill' | 'scout', owner: PID, by: PID | null, src: Card | null): boolean;
  /** 6. Extra cards milled (นายนิรยบาล อ้วน: +2). */
  millBonus?(g: Game, self: Card, owner: PID, n: number, by: PID | null, src: Card | null): number;
  /** 8. Extra cards scouted (เทอราโนดอน: +1 for our กะปอม Avatars). */
  scoutBonus?(g: Game, self: Card, owner: PID, n: number, by: PID | null, src: Card | null): number;
  /** 7. This card may be summoned only when this returns true ("#only by its own ability": how === 'own'). Any zone. */
  summonIf?(g: Game, p: PID, c: Card, how: SummonHow): boolean;
  /** 7. self (in play) forbids p summoning c (true = blocked). */
  blockSummon?(g: Game, self: Card, p: PID, c: Card, how: SummonHow): boolean;
  /** 7. self (in play) forbids p using Magic c. */
  blockCast?(g: Game, self: Card, p: PID, c: Card): boolean;
  /** 7. self (in play) forbids p using the activated abilities of c. */
  blockAbility?(g: Game, self: Card, p: PID, c: Card): boolean;
  /** 7. Max Avatars (tokens included) p may have in the Avatar Zone (นรกในกรง: 3). */
  zoneCap?(g: Game, self: Card, p: PID): number;
  /** 9. self (in play) switches off target's text: true = all of it (incl. ลูกฮึด / ต่อเนื่อง / คำสั่งเสีย), or a list of parts. */
  textOff?(g: Game, self: Card, target: Card): boolean | AbilityPart[] | null;
  /** 9. This card is unaffected by every effect (แบงค์ Miner). Read for the card in play. */
  unaffected?(g: Game, self: Card, src?: Card): boolean; // v14d: src = the effect's card when known: return false to let it affect this card
  /** 9. self (in play) says target can't be chosen by the effect of card `by` (มะม่วงดราชิลด์). */
  noTarget?(g: Game, self: Card, target: Card, by: Card): boolean;
  /** 10. A fight (or an attack on LIFE: target null) just ended (self = any card in play). */
  afterFight?(g: Game, self: Card, att: Card, target: Card | null): void;
  /** 10. Start of every Battle Phase (self = any card in play, both players; check g.active). */
  startBattle?(g: Game, self: Card): void;
  /** 10. Every End Phase, both players' cards in play (check g.active for "our"). */
  eachEndPhase?(g: Game, self: Card): void;
  /** 10. Any player used a Magic (cast or React). */
  onAnyMagic?(g: Game, self: Card, magic: Card, caster: PID): void;
  /** 10. A LIFE card of p was turned face up (hitLife, flipLifeCard, or at End Phase for other effect flips). */
  onLifeFlipped?(g: Game, self: Card, p: PID, life: Card, byAttack: boolean): void;
  /** 10. This Avatar entered [Link] state ("[Link X]" text; generic). */
  onLink?(g: Game, self: Card): void;
  // ---- v14b (engine/v14-hooks.md "v14b") ----
  /** card in play: its controller may cast Magic m (Normal / Modification / Land) in the opponent's turn */
  offTurnMagic?(g: Game, self: Card, m: Card): boolean;
  /** card in play: React Magic m in its controller's hand may also be used in this window (ev), on top of its own conditions */
  reactAlso?(g: Game, self: Card, m: Card, ev: Ev): boolean;
  /** this card was put into a hand ("นำขึ้นมือ"; not drawn): from where, by which player / card (src null = rules / LIFE) */
  onToHand?(g: Game, self: Card, from: HandFrom, by: PID | null, src: Card | null): void;
  /** card in its owner's deck, at the start of that player's Draw Phase: return true = it replaced the normal draw of 1
   *  (the hook moves it to hand itself, e.g. addToHand). Asked once per name. drawPhaseNo(g, p) = which Draw Phase. */
  drawInstead?(g: Game, self: Card): boolean;
  /** card in play / in a hand / in a Hell: cards were discarded from a hand by an ability of src (by = src's controller);
   *  called after that ability has finished resolving. GEM payments are not reported. */
  onDiscard?(g: Game, self: Card, cards: Card[], by: PID, src: Card): void;
  // ---- v14c ----
  /** this card was revealed by a scout (สอดแนม) and not taken by the pick; by / src = who scouted (src null = LIFE) */
  onScouted?(g: Game, self: Card, p: PID, by: PID | null, src: Card | null): void;
  /** this Land was placed (cast or effect), this Normal Magic stayed in the Magic Zone, or this Construct was built */
  onEnterPlay?(g: Game, self: Card): void;
  /** card in play: GEM value of hand card c when paid for forCard (null = no change) */
  gemValue?(g: Game, self: Card, c: Card, forCard: Card | null): number | null;
  /** card in play: runs at the end of every stateCheck (after each action, effect, fight); keep it cheap and idempotent */
  afterAction?(g: Game, self: Card): void;
  /** card in play (Lands too, both players): start of every Main Phase, after LIFE triggers (check g.active) */
  mainStart?(g: Game, self: Card): void;
  /** card in play: true = card c may not be put into p's hand (addToHand / search; not draws). from / by / src as onToHand */
  blockToHand?(g: Game, self: Card, c: Card, p: PID, from: HandFrom, by: PID | null, src: Card | null): boolean;
  /** card in play or the current attacker: true = target's built-in protections don't stop its destruction now (K-BO; use currentFight()) */
  noProtect?(g: Game, self: Card, target: Card): boolean;
  /** this card's fieldActs can also be used in the Battle Phase (their can() must allow it) */
  battleField?: boolean;
  // ---- v14d ----
  /** card in play: target ignores effects of src (POWER changes from src, being chosen by src, leaving by src) */
  shieldFrom?(g: Game, self: Card, target: Card, src: Card): boolean;
  /** this Modification may only be attached to wearer when true (canWear / attach) */
  wearIf?(g: Game, self: Card, wearer: Card): boolean;
  /** this Avatar refuses Modification mod (true = can't wear it) */
  refuseMod?(g: Game, self: Card, mod: Card): boolean;
  /** this Avatar became asleep (checked at every stateCheck; rest(g, a) fires at once) */
  onRest?(g: Game, self: Card): void;
  /** card in play: any Avatar a became asleep (asleep true) or awake (false) */
  onRestChange?(g: Game, self: Card, a: Card, asleep: boolean): void;
  /** card in play: true = target can't be attacked by attacker */
  noAttackOn?(g: Game, self: Card, target: Card, attacker: Card): boolean;
  /** card in play: p's LIFE can't be turned face down */
  blockLifeDown?(g: Game, self: Card, p: PID): boolean;
  react?: {
    on: Ev['kind'][];
    reactOnly?: boolean;
    ignoreLimit?: boolean; // usable even after another React this turn
    noLimit?: boolean; // not a React use at all
    fromHand?: boolean; // non-magic response from hand
    onceKey?: string;
    onceGameKey?: string;
    can?(g: Game, p: PID, c: Card, ev: Ev): boolean;
    want(g: Game, p: PID, c: Card, ev: Ev): boolean;
    resolve(g: Game, p: PID, c: Card, ev: Ev): void;
    preCost?(g: Game, p: PID, c: Card, ev: Ev): boolean; // other-team audit Q9: text cost, paid before the React window
  };
  preCost?(g: Game, p: PID, c: Card, opt: number): boolean; // other-team audit Q9: text cost, paid before the React window
}

// ---------- helpers ----------
export function value(g: Game, a: Card): number {
  // rough worth of an Avatar on the field
  return power(g, a) + (a.token ? 0 : 1.5 + a.def.cost * 0.4) + (FX[a.def.name] ? 1 : 0);
}
export const magicOk = (g: Game, p: PID, a: Card) => !magicImmune(g, a, p);
export function best<T>(xs: T[], score: (x: T) => number): T | null {
  xs = targetFilter(xs); // v14: cards the current effect can't choose (unaffected, FX.noTarget)
  let b: T | null = null, bv = -Infinity;
  for (const x of xs) { const v = score(x); if (v > bv) { bv = v; b = x; } }
  return askPick(xs, b); // play mode: the human may choose instead
}
export function worst<T>(xs: T[], score: (x: T) => number): T | null { return best(xs, (x) => -score(x)); }
// ---------- v8 choice helpers: the human (when deciding) chooses, the bot uses the score ----------
/** Choose n of xs one at a time, best score first for the bot. optional: "up to n" (the human may stop with Skip).
 *  When the rest must all be taken (no real choice), they are taken without asking. */
export function pickN<T>(xs: T[], n: number, score: (x: T) => number, o: AskOpts = {}): T[] {
  const pool = targetFilter([...xs]), out: T[] = [];
  while (out.length < n && pool.length) {
    if (!o.optional && pool.length <= n - out.length && !humanPilePick(pool)) { out.push(...pool); break; } // bugs7 item 2
    let b: T | null = null, bv = -Infinity;
    for (const x of pool) { const v = score(x); if (v > bv) { bv = v; b = x; } }
    const title = o.title ? `${o.title} (${out.length + 1}/${n})` : undefined;
    const c = askPick(pool, b, { ...o, title });
    if (c === null) break;
    out.push(c); pool.splice(pool.indexOf(c), 1);
  }
  return out;
}
export function worstN<T>(xs: T[], n: number, score: (x: T) => number, o: AskOpts = {}): T[] { return pickN(xs, n, (x) => -score(x), o); }
/** Discard cards from hand whose GEM adds up to exactly n (no 0-GEM cards): the human picks them one by one (only cards
 *  that still allow an exact total are offered); the bot's choice is botPlan. Returns the chosen cards (not yet discarded). */
export function pickGemExact(g: Game, p: PID, n: number, forCard: Card, botPlan: Card[], title: string): Card[] | null {
  const pay: Card[] = []; let left = n;
  const gem = (x: Card) => gemOf(g, x, forCard);
  const reach = (xs: Card[], t: number): boolean => t === 0 || xs.some((x, i) => gem(x) <= t && reach(xs.slice(i + 1), t - gem(x)));
  while (left > 0) {
    const pool = P(g, p).hand.filter((x) => x !== forCard && !pay.includes(x) && gem(x) > 0 && gem(x) <= left).slice(0, 14);
    const ok = pool.filter((x) => reach(pool.filter((y) => y !== x), left - gem(x)));
    const x = best(ok, (y) => (botPlan.includes(y) ? 100 : 0) - keepValue(g, y));
    if (!x) return null;
    pay.push(x); left -= gem(x);
  }
  return pay;
}
/** An optional ("... ได้") effect: the human is asked (pick the card = yes, Skip = no); the bot uses want. */
export function mayDo(g: Game, c: Card, title: string, want: boolean): boolean {
  if (!humanDeciding(g)) return want;
  return askPick([c], want ? c : null, { optional: true, title: `${c.def.name}: ${title}?` }) !== null;
}
/** เลือกปฏิบัติ: the human picks a mode by label; the bot's choice is dflt. */
export function chooseMode(g: Game, c: Card, labels: string[], dflt: number): number {
  return askChoose(g, `${c.def.name}: choose one (เลือกปฏิบัติ)`, labels, dflt);
}
/** "ฝ่ายตรงข้ามเลือก": the opponent of p makes the choice inside fn. */
export function oppChoice<T>(g: Game, p: PID, fn: () => T): T { return decide(g, opp(p), fn); }
export function oppTargets(g: Game, p: PID, viaMagic: boolean) {
  return targetFilter(P(g, opp(p)).avatars.filter((a) => !viaMagic || magicOk(g, p, a)));
}
// Remove an opponent's Avatar to hell/hand (not "destroy"), respecting leave-prevention (v14: toHell / toHand run
// preventLeave and every leaveGuard centrally).
export function removeOpp(g: Game, by: PID, a: Card, to: 'hell' | 'hand', viaMagic: boolean) {
  if (viaMagic && !magicOk(g, by, a)) return;
  if (to === 'hell') toHell(g, a, { by, viaMagic }); else toHand(g, a, a.owner, { by, viaMagic });
}
export function sacrifice(g: Game, p: PID, pool: Card[], n: number): boolean {
  if (pool.length < n) return false;
  const pick = worstN(pool, n, (x) => value(g, x), { title: `เซ่นไหว้: choose ${n}` });
  if (pick.length < n) return false;
  for (const a of pick) destroy(g, a, p, false, { cost: true }); // v14: a cost: leave guards don't stop it
  return true;
}
export function search(g: Game, p: PID, pred: (c: Card) => boolean, from: 'deck' | 'hell'): Card | null {
  const pl = P(g, p);
  const zone = from === 'deck' ? pl.deck : pl.hell;
  // "สามารถนำ ... จาก Deck/นรก ขึ้นมือ" = optional: the human may Skip
  const may = sourceSays(/(?<!ความ)(?<!ไม่)สามารถ\s*(นำ|เลือก)[^:]{0,90}(Deck|เด็ค|นรก)[^:]{0,40}ขึ้นมือ/);
  const c = may ? pickN(zone.filter(pred), 1, (x) => keepValue(g, x) + x.def.power * 0.3, { optional: true })[0] || null : best(zone.filter(pred), (x) => keepValue(g, x) + x.def.power * 0.3);
  const got = !!c && addToHand(g, c, p, { from }); // v14b: FX.onToHand; locked Hell cards are never offered (targetFilter); v14c blockToHand
  if (from === 'deck') shuffle(g, pl.deck);
  return got ? c : null;
}
export function inMain(g: Game, p: PID) { return g.phase === 'Main' && g.active === p; }

// other-team audit Q11 (user: ไปเลยมอนตี้ counts itself, and "สนาม" includes the Magic Zone): our hand + this card + our
// Avatars, the cards worn by them, our Magic Zone (Constructs, Magic, Avatars there) and our Land
function montyCount(g: Game, p: PID, self: Card): number {
  const pl = P(g, p);
  let n = pl.hand.filter((x) => x !== self).length + 1 + pl.avatars.length + pl.mz.length;
  for (const a of pl.avatars) n += a.mods.length;
  if (g.land && g.land.ctrl === p) n += 1;
  return n;
}
// Ninja "swap" ability: from hand, return N other ninja on our zone to hand and summon this one.
function ninjaSwap(name: string, n: number, extraCan?: (g: Game, p: PID) => boolean, anyMain = false): Fx['handActs'] {
  return (g, p, c) => [{
    label: `${name}: swap in`,
    can: (g2) => {
      const pl = P(g2, p);
      if (!pl.hand.includes(c) || onceUsed(g2, pl, 'swap:' + name)) return false;
      const timing = inMain(g2, p) || (anyMain && g2.phase === 'Main') || (extraCan ? extraCan(g2, p) : false);
      if (!timing) return false;
      return pl.avatars.filter((a) => isNinja(a) && a.def.name !== name).length >= n;
    },
    run: (g2) => {
      const pl = P(g2, p);
      markOnce(g2, pl, 'swap:' + name);
      const back = worstN(pl.avatars.filter((a) => isNinja(a) && a.def.name !== name), n, (x) => value(g2, x) - (x.asleep ? 5 : 0), { title: `${name}: return a นินจา to hand` });
      for (const b of back) toHand(g2, b);
      // other-team audit Q8 (user: a ninja swap is not counted as a summon by ด่านตรวจเข้าเมือง)
      c.f.swapT = g2.turn;
      if (summon(g2, p, c, 'own')) { const L = turnLog(g2).summons[p]; const i = L.lastIndexOf(c.def.name); if (i >= 0) L.splice(i, 1); }
    },
  }];
}
function vanaraAlt(name: string): Fx['handActs'] {
  return (g, p, c) => [{
    label: `${name}: destroy 2 วานร to summon`,
    can: (g2) => P(g2, p).hand.includes(c) && inMain(g2, p) && P(g2, p).avatars.filter(isVanara).length >= 2,
    run: (g2) => { if (sacrifice(g2, p, P(g2, p).avatars.filter(isVanara), 2)) summon(g2, p, c, 'own'); },
  }];
}
export const cancel = (g: Game, p: PID, c: Card, ev: Ev) => { ev.cancelled = true; };

// ---------- the cards ----------
/** Timed-rule predicates (engine RuleDef), keyed by rule key; re-exported by engine.ts. Defined here so card files can
 *  register rules at load time. */
export const RULES: Record<string, RuleDef> = {};
export const FX: Record<string, Fx> = {
  // ===== นินจา deck =====
  'พรของอิศวร': {
    keep: 9, options: 3,
    canCast: (g, p, c, o) => o === 0 ? P(g, p).hand.length - 1 < 4 : o === 1 ? oppTargets(g, p, true).length > 0 : P(g, p).hell.length > 0,
    resolve: (g, p, c, o) => {
      const pl = P(g, p);
      if (o === 0) draw(g, p, Math.max(0, 5 - pl.hand.length));
      else if (o === 1) { for (const a of pickN(oppTargets(g, p, true), 2, (x) => value(g, x), { optional: true, title: 'พรของอิศวร: destroy up to 2' })) destroy(g, a, p, true); }
      else { for (let i = 0; i < 2; i++) search(g, p, () => true, 'hell'); }
    },
  },
  'นินจาไร้นาม': { keep: 2.5 },
  'ฟูมะ นินจาแห่งสายลม': {
    keep: 5,
    handActs: ninjaSwap('ฟูมะ นินจาแห่งสายลม', 1),
    onOwnSummon: (g, c) => { c.bonus += 3; c.fumaExile = true; },
  },
  'ฮันโซ นินจาในตำนาน': {
    keep: 5.5,
    jutsu: (g, c) => { search(g, c.ctrl, (x) => nameHas(x, 'วิชานินจา'), 'deck'); },
    handActs: ninjaSwap('ฮันโซ นินจาในตำนาน', 1),
    onOwnSummon: (g, c) => {
      const t = best(P(g, c.ctrl).avatars.filter((a) => isNinja(a) && !a.asleep), (a) => power(g, a));
      if (t) t.kick = true;
    },
  },
  'ชิโยเมะ นินจาสาว': {
    keep: 5,
    handActs: ninjaSwap('ชิโยเมะ นินจาสาว', 1, undefined, true),
    oppMainAct: true,
    onOwnSummon: (g, c) => {
      const t = best(oppTargets(g, c.ctrl, false), (a) => value(g, a) + (power(g, a) <= 3 ? 3 : 0));
      if (t) t.temp.push({ power: -3, until: 'turn' });
    },
  },
  'โกเอมอน นินจาจอมโจร': {
    keep: 5,
    handActs: ninjaSwap('โกเอมอน นินจาจอมโจร', 2, (g, p) => g.phase === 'Battle' && g.active === p && flippedLife(P(g, p)) >= 3),
    onOwnSummon: (g, c) => { c.goemonGain = true; },
    getActive: (g: Game, c: Card) => c.goemonGain && 'LIFE หงายจากการโจมตี: เอา Normal/Mod Magic จากนรกฝ่ายตรงข้าม',
    onLifeFlip: (g, c) => {
      const p = c.ctrl, o = P(g, opp(p));
      // v14 ruling: only Normal Magic / Modification Magic from the opponent's Hell
      const m = best(o.hell.filter((x) => x.def.type === 'Magic' && (x.def.subtype === 'Normal' || x.def.subtype === 'Modification')), (x) => keepValue(g, x));
      if (!m) return;
      detach(g, m); m.owner = p; P(g, p).hand.push(m);
      const d = worst(P(g, p).hand.filter((x) => x !== m), (x) => keepValue(g, x));
      if (d) discard(g, p, d);
    },
  },
  'อีช่า - สาวน้อยคนเก่ง': {
    keep: 4,
    jutsu: (g, c) => {
      const p = c.ctrl;
      const t = best(oppTargets(g, p, false).filter((a) => symAny(a, ['คน', 'เทพ', 'นรก']) && canChangeCtrl(g, a, p, c)), (a) => value(g, a));
      // with 4 real Avatars, sacrificing a token would not free a slot for the stolen one
      // bugfix4 (user 2026-10-30, replaces audit Q15): "Avatar ใบอื่น" = never itself
      const fodder = P(g, p).avatars.filter((a) => a !== c && (realAvatars(P(g, p)).length < 4 || !a.token));
      if (!t || fodder.length === 0 || value(g, t) < 3) return;
      if (!sacrifice(g, p, fodder, 1)) return;
      if (!canPlaceAvatar(P(g, p)) || !P(g, opp(p)).avatars.includes(t)) return;
      if (!takeControl(g, t, p, 'avatars', c)) return;
      t.asleep = false;
      log(g, `steal ${t.def.name}`);
    },
  },
  // 'วันชัยเปรตรุ่นพ่อ': group E entry at the end of cards2.ts
  'คนรวย': {
    keep: 3,
    react: {
      on: ['magic', 'ability'], onceKey: 'คนรวย',
      can: (g, p, c, ev) => ev.actor !== p && P(g, p).hand.length > 0,
      want: (g, p, c, ev) => !!ev.source && (keepValue(g, ev.source) >= 5 || ev.source.def.cost >= 6),
      resolve: (g, p, c, ev) => {
        const give = worst(P(g, p).hand, (x) => keepValue(g, x));
        if (give) { detach(g, give); P(g, opp(p)).hand.push(give); }
        ev.cancelled = true;
      },
    },
  },
  'เพนกวิ้น ฮัท': {
    keep: 4,
    react: {
      on: ['attack'], noLimit: true, fromHand: true, onceGameKey: 'เพนกวิ้น',
      can: (g, p, c, ev) => ev.actor !== p && ev.target === null && critical(P(g, p)),
      want: () => true,
      resolve: (g, p, c, ev) => { P(g, p).onceGame['เพนกวิ้น'] = true; toExile(g, c); ev.cancelled = true; g.stopBattle = true; },
    },
  },
  'แมลงปอมีพิษ': {
    keep: 3,
    deathCry: (g, c, owner) => {
      const t = best(P(g, opp(owner)).avatars.filter((a) => a.def.cost <= 4), (a) => value(g, a));
      if (t) destroy(g, t, owner);
    },
  },
  'ความเจริญ': { keep: 4, canCast: (g, p) => P(g, p).deck.length > 3, resolve: (g, p) => draw(g, p, 2) },
  'ร้อนมากก็เปิดหน้าต่างสิว๊ากกกก': {
    keep: 5,
    // other-team audit Q12 (user): Avatars in the opponent's Magic Zone count as "บนสนาม" too
    canCast: (g, p) => oppFieldTargets(g, p).length > 0,
    resolve: (g, p) => { const t = best(oppFieldTargets(g, p), (a) => value(g, a)); if (t) removeOpp(g, p, t, 'hand', true); },
  },
  'ไต้ฝุ่น': {
    keep: 3.5, options: 2,
    canCast: (g, p, c, o) => o === 0
      ? P(g, opp(p)).avatars.some((a) => a.mods.some((m) => m.owner === opp(p))) || P(g, p).avatars.some((a) => a.mods.some((m) => m.owner === opp(p)))
        || P(g, opp(p)).mz.some((x) => x.def.type === 'Magic' || x.def.type === 'Construct')
      : !!g.land && g.land.owner === opp(p),
    resolve: (g, p, c, o) => {
      if (o === 1) { if (g.land) { P(g, g.land.owner).hell.push(g.land); g.land = null; } return; }
      const mods = [...g.p[0].avatars, ...g.p[1].avatars].flatMap((a) => a.mods).filter((m) => m.owner === opp(p));
      // also persistent Magic / Constructs in the opponent's Magic Zone
      mods.push(...P(g, opp(p)).mz.filter((x) => x.def.type === 'Magic' || x.def.type === 'Construct'));
      const m = best(mods, (x) => keepValue(g, x));
      if (m) toHell(g, m, { by: p, viaMagic: true }); // v14: through the leave path (สิงสู่เพื่อสู่สม / ริกกี้ react to it)
    },
  },
  'ไอ นีด เมดิก': {
    keep: 3,
    canCast: (g, p) => flippedLife(P(g, p)) >= 2,
    resolve: (g, p) => { const up = P(g, p).life.filter((l) => l.faceUp); if (up.length) lifeDown(g, p, up[Math.floor(rand(g) * up.length)]); }, // other-team audit: "สุ่มคว่ำ" = a random face-up LIFE
  },
  'เลือกมันสำหรับพวก จน !!!': {
    keep: 4, options: 2, optLabels: ['เลือกจน(นรก)', 'เลือกจน(เด็ค)'],
    canCast: (g, p, c, o) => o === 0 ? P(g, p).hell.some((x) => x.def.type === 'Avatar' && x.def.cost <= 5 && !x.def.only) : P(g, p).deck.length > 0,
    resolve: (g, p, c, o) => {
      const ok = (x: Card) => x.def.type === 'Avatar' && x.def.cost <= 5 && !x.def.only;
      const both = flippedLife(P(g, p)) >= 4 && flippedLife(P(g, p)) > flippedLife(P(g, opp(p)));
      if (o === 0 || both) search(g, p, ok, 'hell');
      if (o === 1 || both) search(g, p, ok, 'deck');
    },
  },
  'แผนการ : แกงส้มตะปูเสียบ': {
    keep: 4, zeroKills: true,
    canCast: (g, p) => oppTargets(g, p, true).length > 0,
    modTarget: (g, p) => best(oppTargets(g, p, true), (a) => (power(g, a) <= 2 ? 10 : 0) + value(g, a)),
    modPower: () => -2,
  },
  'วิชานินจา รุกรับพลิกผัน': {
    keep: 4.5,
    canCast: (g, p) => P(g, p).avatars.length > 0 && P(g, p).avatars.every(isNinja),
    battleUse: (g, p, c) => {
      const pl = P(g, p);
      if (pl.used.React || pl.avatars.length === 0 || !pl.avatars.every(isNinja)) return false;
      if (P(g, opp(p)).avatars.length === 0) return false;
      const t = best(pl.avatars.filter((a) => !a.asleep && !a.kick), (a) => power(g, a));
      if (!t) return false;
      // only worth it if this ninja can't win a fight anyway
      const beat = P(g, opp(p)).avatars.some((d) => power(g, t) > power(g, d));
      if (beat && !critical(P(g, opp(p))) && flippedLife(P(g, opp(p))) < 4) return false;
      return true;
    },
    resolve: (g, p, c) => ninjaFlip(g, p, c, null),
    // v14 ruling: also a React when the opponent summons, Links, uses a Magic, declares an attack or uses an ability
    react: {
      on: ['summon', 'partner', 'magic', 'attack', 'ability'],
      can: (g, p, c, ev) => ev.actor !== p && P(g, p).avatars.length > 0 && P(g, p).avatars.every(isNinja),
      want: (g, p, c, ev) => ev.kind === 'attack' && !!ev.target && !!ev.source && P(g, p).avatars.includes(ev.target) && power(g, ev.source) >= power(g, ev.target) && value(g, ev.target) >= 3,
      resolve: (g, p, c, ev) => ninjaFlip(g, p, c, ev.kind === 'attack' && ev.target && P(g, p).avatars.includes(ev.target) ? ev.target : null),
    },
  },
  'ชายจากอนาคต': {
    keep: 6,
    react: { on: ['magic'], can: (g, p, c, ev) => ev.actor !== p, want: (g, p, c, ev) => !!ev.source && keepValue(g, ev.source) >= 3.5, resolve: cancel },
  },
  'ไปเลยมอนตี้': {
    keep: 5,
    react: {
      on: ['attack'], can: (g, p, c, ev) => ev.actor !== p,
      want: (g, p, c, ev) => {
        const att = ev.source!; const minus = 2 * montyCount(g, p, c); // other-team audit Q11
        const after = power(g, att) - minus;
        if (ev.target) return power(g, att) >= power(g, ev.target) && after < power(g, ev.target);
        return after <= 0; // linkbot item 4: POWER 0 at damage time = no LIFE damage
      },
      resolve: (g, p, c, ev) => {
        const minus = 2 * montyCount(g, p, c); // other-team audit Q11
        addPower(g, ev.source!, -minus, 'perm', c); // v14 answer: permanent (while the attacker stays on the field)
      },
    },
  },
  'อย่าให้มีครั้งที่ 2': {
    keep: 5,
    react: { on: ['magic'], reactOnly: true, ignoreLimit: true, onceKey: 'อย่าให้มีครั้งที่ 2', can: (g, p, c, ev) => ev.actor !== p, want: () => true, resolve: cancel },
  },
  'อุบัติเหตุ!!!': {
    keep: 5,
    react: {
      on: ['summon'], can: (g, p, c, ev) => ev.actor !== p && (!ev.source || effectTargetable(ev.source, c)), // other-team audit: กวนอู's "can't be chosen"
      want: (g, p, c, ev) => !!ev.source && (value(g, ev.source) >= 6 || ev.source.def.cost >= 6 || ev.source.def.only),
      resolve: (g, p, c, ev) => { if (ev.source) destroy(g, ev.source, p, true); },
    },
  },
  'เจ้ากล้าดียังไง': {
    keep: 6,
    react: {
      on: ['attack'], can: (g, p, c, ev) => ev.actor !== p,
      want: (g, p, c, ev) => {
        const att = ev.source!;
        if (ev.target === null) return flippedLife(P(g, p)) >= 3 || value(g, att) >= 5;
        return power(g, att) >= power(g, ev.target!) && value(g, ev.target!) >= 4;
      },
      resolve: (g, p, c, ev) => { if (ev.source) removeOpp(g, p, ev.source, 'hell', true); ev.cancelled = true; },
    },
  },
  'ทรายดูด': { keep: 3, zeroKills: true },

  // ===== วานร deck =====
  'พาลี วานรแห่งเมืองขีดขิน': {
    keep: 8,
    jutsu: (g, c) => paliWipe(g, c),
    startMain: (g, c) => paliWipe(g, c),
  },
  'หนุมาน วานรวายุ': {
    keep: 6, shield: true,
    handActs: vanaraAlt('หนุมาน วานรวายุ'),
    // linkbot: the abilities below {คู่หู} need the คู่หู formed by the Link command (user)
    preventLeave: (g, c) => {
      if (!vanaraPair(g, c, 'นิลพัท วานรสีกาฬ')) return false;
      const pl = P(g, c.ctrl);
      const top = pl.deck[0];
      if (!top) return false;
      detach(g, top); pl.hell.push(top);
      const saved = top.def.type === 'Avatar' && isVanara(top);
      if (saved) log(g, 'หนุมาน stays (สอดแนม hit วานร)');
      return saved;
    },
    battle: (g, c) => { if (vanaraPair(g, c, 'นิลพัท วานรสีกาฬ')) c.temp.push({ power: 1, until: 'turn' }); }, // จนจบเทิร์น
  },
  'นิลพัท วานรสีกาฬ': {
    keep: 6, unite: true,
    handActs: vanaraAlt('นิลพัท วานรสีกาฬ'),
    onPartner: (g, c) => placeToken(g, c.ctrl, TOKEN_VANARA, 2),
    staticPower: (g, c) => (vanaraPair(g, c, 'หนุมาน วานรวายุ') ? P(g, c.ctrl).avatars.filter((a) => a.token && a.def.print === TOKEN_VANARA.print).length : 0), // linkbot: below {คู่หู}
  },
  'คิงคา วานรเจ้าป่า': {
    keep: 4,
    jutsu: (g, c) => {
      const pl = P(g, c.ctrl);
      if (pl.hell.some((x) => x.def.type === 'Avatar' && isVanara(x)) || pl.hand.some((x) => x.def.type === 'Avatar' && isVanara(x))) placeToken(g, c.ctrl, TOKEN_VANARA, 1);
    },
  },
  'วานรถลกหนังฝังกระดูก': {
    keep: 1,
    usedAsCost: (g, p, c, s) => { if (isVanara(s)) placeToken(g, p, TOKEN_VANARA, 1); },
  },
  'วีรชนชีวภาพ': {
    keep: 0.5,
    usedAsCost: (g, p, c, s) => { if (colorIs(s, 'เขียว')) s.magicImmuneUntil = g.turn + 1; },
  },
  'ดารา นางชั่ว': {
    keep: 4,
    fieldActs: (g, p, c) => [{
      label: 'ดารา: sacrifice 2 วานร, revive พาลี',
      can: (g2) => inMain(g2, p) && !onceUsed(g2, P(g2, p), 'ดารา') && P(g2, p).hell.some((x) => nameHas(x, 'พาลี'))
        && P(g2, p).avatars.filter((a) => symIs(a, 'สัตว์')).length >= 2, // rm01: the text's monkey icon is {symbol สัตว์} (วานร symbol is gone)
      run: (g2) => {
        const pl = P(g2, p); markOnce(g2, pl, 'ดารา');
        if (!sacrifice(g2, p, pl.avatars.filter((a) => symIs(a, 'สัตว์')), 2)) return;
        const pali = best(pl.hell.filter((x) => nameHas(x, 'พาลี')), (x) => (x.def.only ? 10 : 0) + x.def.power);
        if (pali) summon(g2, p, pali, 'effect');
      },
    }],
  },
  'พาลี': {
    keep: 4,
    battle: (g, c, other) => { other.temp.push({ power: -2, until: 'battle' }); c.temp.push({ power: 2, until: 'battle' }); },
  },
  'คาบู ช่วยด้วย': {
    keep: 3,
    saveFromHand: (g, p, self, dying) => {
      const pl = P(g, p);
      if (!symIs(dying, 'สัตว์') || !canPlaceAvatar(pl) || pl.hand.length < 2) return false;
      const d = worst(pl.hand.filter((x) => x !== self), (x) => keepValue(g, x));
      if (!d) return false;
      discard(g, p, d);
      summon(g, p, self, 'effect');
      log(g, 'คาบู saves ' + dying.def.name);
      return true;
    },
  },
  'ศาสตราจารย์วานร': {
    keep: 3,
    eachEndPhase: (g: Game, c: Card) => { // v14 ruling: every End Phase (both players' turns)
      const pl = P(g, c.ctrl);
      if (!pl.avatars.includes(c) || onceUsed(g, pl, 'ศาสตราจารย์วานร')) return;
      if (pl.avatars.filter((a) => nameHas(a, 'วานร')).length >= 3) { markOnce(g, pl, 'ศาสตราจารย์วานร'); draw(g, c.ctrl, 2); }
    },
  },
  'ตรีเพชร': {
    keep: 4,
    canCast: (g, p) => P(g, p).avatars.some(isVanara),
    modTarget: (g, p) => best(P(g, p).avatars.filter(isVanara), (a) => (a.token ? 5 : 0) - value(g, a)),
    fieldActs: (g, p, m) => [{
      label: 'ตรีเพชร: destroy wearer, revive หนุมาน/นิลพัท',
      can: (g2) => {
        if (!inMain(g2, p) || m.wearer < 0) return false;
        const hell = P(g2, p).hell;
        return hell.some((x) => x.def.name === 'หนุมาน วานรวายุ' || x.def.name === 'นิลพัท วานรสีกาฬ');
      },
      run: (g2) => {
        const w = findCard(g2, m.wearer); const pl = P(g2, p);
        if (!w || !pl.avatars.includes(w)) return;
        destroy(g2, w, p);
        const t = best(pl.hell.filter((x) => x.def.name === 'หนุมาน วานรวายุ' || x.def.name === 'นิลพัท วานรสีกาฬ'),
          (x) => (pl.avatars.some((a) => a.def.name !== x.def.name && (a.def.name === 'หนุมาน วานรวายุ' || a.def.name === 'นิลพัท วานรสีกาฬ')) ? 5 : 0));
        if (t) summon(g2, p, t, 'effect');
      },
    }],
  },
  'ดาบพระขรรค์': {
    keep: 3,
    canCast: (g, p) => P(g, p).avatars.some(isVanara),
    modTarget: (g, p) => best(P(g, p).avatars.filter(isVanara), (a) => value(g, a) + (a.asleep ? 0 : 2)),
    modPower: () => 2,
  },
  'น้ำซุปชาบู': {
    keep: 3,
    canCast: (g, p) => P(g, p).avatars.length > 0,
    modTarget: (g, p) => best(P(g, p).avatars, (a) => (a.asleep ? 0 : 3) + power(g, a)),
    modPower: () => 3,
    onWearerAttack: (g, m, w) => { w.noWakeUntil = g.turn + 2; },
  },
  'เชาว์ปัญญาลิง - ชิงปัญญาเรา': {
    keep: 5,
    react: {
      // other-team audit: not on an Avatar that can't be chosen (กวนอู) or that ignores opposing Magic (วีรชนชีวภาพ)
      on: ['ability'], can: (g, p, c, ev) => ev.actor !== p && !!ev.source && P(g, ev.actor).avatars.includes(ev.source) && magicOk(g, p, ev.source) && effectTargetable(ev.source, c),
      want: (g, p, c, ev) => !!ev.source && (keepValue(g, ev.source) >= 5 || ev.source.def.only),
      resolve: (g, p, c, ev) => { if (ev.source) ev.source.silencedTurn = g.turn; ev.cancelled = true; },
    },
  },
  'ทุ่งนาแดนนี้(ไม่มีความหมาย)': {
    keep: 2.5,
    canCast: (g, p) => {
      const mine = P(g, p).avatars.filter((a) => symAny(a, ['แมลง', 'สัตว์', 'รัททาทุย', 'คน'])).length;
      const theirs = P(g, opp(p)).avatars.filter((a) => symAny(a, ['แมลง', 'สัตว์', 'รัททาทุย', 'คน'])).length;
      return mine > theirs;
    },
    landPower: (g, l, a) => (symAny(a, ['แมลง', 'สัตว์', 'รัททาทุย', 'คน']) ? 1 : 0),
  },
  'ป่าแห่งเมืองขีดขิน': {
    keep: 2.5,
    canCast: (g, p) => !g.land || g.land.owner !== p,
    fieldActs: (g, p, c) => [{
      label: 'ป่า: sacrifice 1 วานร, draw 1',
      can: (g2) => inMain(g2, p) && !onceUsed(g2, P(g2, p), 'ป่า') && P(g2, p).avatars.some((a) => a.token && isVanara(a)),
      run: (g2) => {
        markOnce(g2, P(g2, p), 'ป่า');
        if (sacrifice(g2, p, P(g2, p).avatars.filter((a) => a.token && isVanara(a)), 1)) draw(g2, p, 1);
      },
    }],
  },
};

// วิชานินจา รุกรับพลิกผัน: 1) a นินจา gets เตะไข่ until end of turn, 2) exile it, it comes back at this End Phase
function ninjaFlip(g: Game, p: PID, c: Card, dodge: Card | null) {
  const pl = P(g, p);
  const m = chooseMode(g, c, ['เตะไข่ until end of turn', 'Exile it; it comes back to the Avatar Zone at End Phase'], dodge ? 1 : 0);
  const pool = pl.avatars.filter((a) => isNinja(a) && (m === 1 || !a.asleep));
  const t = best(pool.length ? pool : pl.avatars.filter(isNinja), (a) => (m === 1 ? (a === dodge ? 100 : 0) + value(g, a) : power(g, a)));
  if (!t) return;
  if (m === 0) { t.kick = true; return; }
  if (toExile(g, t)) { pl.returnAtEnd.push(t); log(g, `${t.def.name} is exiled until End Phase (วิชานินจา รุกรับพลิกผัน)`); }
}
function paliWipe(g: Game, c: Card) {
  const all = fieldAvatars(g, opp(c.ctrl)); // other-team audit Q12: Avatars in the Magic Zone count as "บนสนาม"
  if (all.length === 0) return;
  const min = Math.min(...all.map((a) => a.def.cost));
  for (const a of all.filter((x) => x.def.cost === min)) destroy(g, a, c.ctrl);
}
/** other-team audit Q12 (user: Avatars in the Magic Zone count as "บนสนาม"): q's Avatars on the Avatar Zone and the
 *  face-up Avatars in q's Magic Zone (อินาริ etc.). */
export function fieldAvatars(g: Game, q: PID): Card[] {
  return [...P(g, q).avatars, ...P(g, q).mz.filter((x) => isAvatarDef(x.def) && !x.f.faceDown)];
}
/** Opposing Avatars on the field (Magic Zone too) that p's Magic can choose. */
export function oppFieldTargets(g: Game, p: PID): Card[] {
  return targetFilter(fieldAvatars(g, opp(p)).filter((a) => magicOk(g, p, a)));
}

// other-team audit Q9 (user: a cancelled Magic keeps its text costs paid): split a Magic into its "cost :" part (pay,
// false = could not pay, no effect) and its effect. The engine runs pay before the React window (FX.preCost); the new
// resolve runs the effect when the cost was paid. rpay / reff do the same for its React use.
type PayFn = (g: Game, p: PID, c: Card, o: any) => boolean;
type EffFn = (g: Game, p: PID, c: Card, o: any) => void;
export function costFirst(name: string, pay: PayFn | null, eff: EffFn | null, rpay?: PayFn, reff?: EffFn) {
  const f = FX[name];
  if (!f) throw new Error('costFirst: no FX for ' + name);
  const n: Fx = { ...f };
  if (pay && eff) { n.preCost = pay; n.resolve = (g, p, c, o) => { if (textCost(g, c, () => pay(g, p, c, o))) eff(g, p, c, o); }; }
  if (rpay && reff && f.react) n.react = { ...f.react, preCost: rpay, resolve: (g, p, c, ev) => { if (textCost(g, c, () => rpay(g, p, c, ev))) reff(g, p, c, ev); } };
  FX[name] = n;
}
