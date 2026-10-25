// Core data types for the Battle of Talingchan engine.

export type PID = 0 | 1;
export type MagicKind = 'Normal' | 'Modification' | 'React' | 'Land';

export interface Def {
  print: string;
  name: string;
  type: 'Avatar' | 'Magic' | 'Life' | 'Construct' | 'Token';
  subtype: string; // MagicKind for Magic
  cost: number; // Avatar / Construct cost; Magic is free (0), one of each Magic type per turn
  gem: number; // value when discarded to pay a cost
  power: number;
  symbol: string;
  color: string;
  only: boolean; // Only #1
  vanilla?: boolean; // no effect text
  gemColor?: GemColor; // colour its GEM pays as (default: card colour, colorless if none)
  req?: { color: GemColor; n: number } | null; // its cost needs at least n GEM of this colour
  limit?: number; // copies per name in a deck (default 4; customLimit in the card data)
  life?: LifeSpec | null; // LIFE card effect, parsed from its text
  // "#" lines of the text box: permanent card stats, valid in every zone and never removed by text deletion
  aka?: string[]; // also counts as these names
  syms?: string[]; // also has these symbols
  colors?: string[]; // also has these (Thai) colours
  allColors?: boolean; // counts as every colour (โคลัมบัส)
  noHellSummon?: boolean; // "#can't be summoned from Hell" (ตุตันคาเมน)
  noWear?: boolean; // "#can't wear cards" (เนฟิล)
  czMax?: number; // "#สามารถมีการ์ดชื่อนี้ใน Construct Zone ได้สูงสุด N ใบ" (เรือรบโบราณ): copies of this name built at once (default 1)
  // keyword flags read from the text
  cont?: boolean; // has ต่อเนื่อง (continuous) text: survives normal text deletion
  grit?: boolean; // has ลูกฮึด
  backstab?: boolean; // has the keyword แทงหลัง
  exactKw?: boolean; // พอดี: its following abilities need an exact GEM payment
}

// 'red' | 'green' | 'blue' | 'purple' | 'yellow' | 'colorless', or a dual like 'red/blue' (pays as either colour)
export type GemColor = string;
/** A LIFE card's effect. k = what it does; when = the phase start it waits for; atkOnly = only when flipped by an attack. */
export interface LifeSpec {
  k: 'draw' | 'powerAv' | 'powerCon' | 'hellToHand' | 'scout' | 'summonHand' | 'summonHell' | 'vanaraToken';
  when: 'main' | 'battle';
  atkOnly: boolean;
  sel?: 'construct' | 'avatar' | 'normal' | 'mod' | 'gem3'; // which cards it takes
  n?: number; // draw n / scout n / hell count needed
  color?: string; // Thai colour for summonHand
  maxCost?: number;
  may?: boolean; // optional ("สามารถ")
}

export interface Temp {
  power: number;
  until: 'turn' | 'battle' | number; // v14c: a turn number = until the End Phase of that turn is over
  src?: number; // v14d: uid of the card whose effect made it (withSource tags it; addPower)
  buff?: number; // v14 features item 9: pending สามัคคี / แทงหลัง buff from this helper uid (Battle Phase, before the attack)
}

export interface Card {
  uid: number;
  def: Def;
  owner: PID;
  ctrl: PID;
  token: boolean;
  asleep: boolean;
  mods: Card[]; // attached Modification magic
  wearer: number; // for a mod: uid of the Avatar it is attached to (-1 if none)
  temp: Temp[];
  kick: boolean; // เตะไข่ until end of turn
  bonus: number; // permanent power bonus while on field (e.g. ฟูมะ +3)
  noWakeUntil: number; // do not wake while g.turn <= this
  magicImmuneUntil: number; // unaffected by opponent Magic while g.turn <= this
  silencedTurn: number; // lost all abilities on this turn
  fumaExile: boolean; // ฟูมะ: exile at End Phase, return at next Main
  goemonGain: boolean;
  f: Record<string, number>; // generic per-card state used by card effects
}

export interface Life {
  card: Card;
  faceUp: boolean;
  seen?: boolean; // the engine has registered this flip (so its effect is queued once)
  trig?: boolean; // effect waiting for the owner's next Main / Battle Phase
  wasUp?: boolean; // v14d: seen face up by stateCheck (blockLifeDown)
}

export interface Player {
  id: PID;
  deck: Card[];
  hand: Card[];
  avatars: Card[];
  hell: Card[];
  exile: Card[];
  life: Life[];
  used: Record<MagicKind, boolean>;
  once: Record<string, number>; // name/key -> turn last used
  onceGame: Record<string, boolean>;
  returnAtMain: Card[]; // cards in exile that come back at start of next Main
  resolving?: Card[]; // Magic cards being resolved right now (shown in the Magic Zone by the game screen)
  mz: Card[]; // Magic Zone residents that matter: Avatars put there, Constructs, persistent Magic
  returnAtEnd: Card[]; // cards in exile that come back at this End Phase (วิชานินจา)
  partner: boolean; // คู่หู state active
  deckName: string;
}

export interface Game {
  p: [Player, Player];
  land: Card | null;
  turn: number; // global turn counter starting at 1
  active: PID;
  first: PID;
  /** Play-table setup: the first player draws 2 in their first Draw Phase instead of at setup. */
  firstDraw2?: boolean;
  /** Dice rolls that picked the first player: [you, bot] per round (ties roll again). */
  dice?: [number, number][];
  phase: 'Draw' | 'Main' | 'Battle' | 'End';
  rng: number;
  nextUid: number;
  winner: PID | -1 | null; // -1 = draw
  stopBattle: boolean; // เพนกวิ้น ฮัท ended the turn
  sim: boolean; // true inside bot look-ahead: no opponent responses
  log: string[] | null;
  stats: { attacks: number; lifeHits: [number, number] };
  /** v14: what happened this turn (engine turnLog(g) resets it when the turn changes). */
  tl?: TurnLog;
  /** v14: timed summon / cast / ability restrictions (addRule). Data only: the predicates live in RULES (engine.ts). */
  rules?: Rule[];
}

/** v14 per-turn log, index = player. */
export interface TurnLog {
  turn: number;
  summons: [string[], string[]]; // names of the Avatars each player summoned this turn, in order (tokens included)
  attacks: [number, number]; // attacks each player declared
  left: [number, number]; // Avatars that left each player's field (any way)
  destroyed: [number, number]; // Avatars of each player destroyed (battle + effect + rules)
  destroyedBattle: [number, number]; // ... destroyed as the result of a fight
  destroyedEffect: [number, number]; // ... destroyed by a card's ability / Magic (not by a fight)
  milled: [number, number]; // cards milled from each player's Deck
  millBy: [number, number]; // cards milled by each player's card abilities (either Deck)
}
/** v14 restriction: key names an entry of RULES (engine.ts); until = last turn it applies (RULE_GAME = the whole game). */
export interface Rule { p: PID; key: string; until: number; name?: string; n?: number; src?: string }
