// Game economy for player accounts (2026-11-02, user: "feel excited every time they log in ... daily login rewards,
// earn resources, open card packs, collect cards, build decks"; design: talingchan/consultant/game-experience-design.md).
// Everything here is decided on the server and saved in the account's `prog` (accounts.ts); the game only asks and shows.
//   wallet: coins, pack tickets, dust (card dust from duplicates)       levels: rewards for each new level
//   7-day login calendar (a missed day doesn't reset)                  3 daily missions (1 re-roll a day) + first win x2
//   bot games: small EXP/coins with a daily cap, via a start/finish ticket (the server can't watch an offline bot game)
//   owned cards + packs per set (5 cards, odds shown, SCR pity at 40) + crafting + starter decks
//   ranked: tiers Bronze..Master from rank points, monthly seasons, hidden MMR (Elo) for matchmaking
// Hybrid rule (user, 2026-11-02): Ranked and anything that pays coins needs a deck of owned cards; bot games, friend
// rooms and practice take any cards (EXP still counts, coins don't).
// No real money anywhere.
import crypto from 'node:crypto';
import { levelOf } from './accounts.ts';

// ---------------------------------------------------------------- days (Thailand time, UTC+7)
export const today = (now = Date.now()) => new Date(now + 7 * 3600e3).toISOString().slice(0, 10);
export const seasonOf = (now = Date.now()) => today(now).slice(0, 7); // "2026-11"

// ---------------------------------------------------------------- numbers (all in one place)
export const PRICE = { pack: 100 }; // coins per pack (or 1 ticket)
export const LOGIN_DAYS = [
  { coins: 100 }, { coins: 150 }, { tickets: 1 }, { coins: 200 }, { dust: 50 }, { coins: 250 }, { tickets: 2, icon: 'login7', packs: { PRMO: 1 } },
];
export const PVP = { win: { xp: 100, coins: 60 }, loss: { xp: 40, coins: 20 }, draw: { xp: 50, coins: 30 } };
export const BOT = {
  win: { hard: { xp: 60, coins: 40 }, normal: { xp: 40, coins: 25 }, easy: { xp: 20, coins: 10 } } as Record<string, { xp: number; coins: number }>,
  loss: { xp: 10, coins: 5 },
  capXp: 400, capCoins: 200, maxGames: 40, minSecs: Number(process.env.BOT_MIN_SECS ?? 60), // BOT_MIN_SECS: tests only
};
export const LEVEL_REWARD = (lv: number): Gain => ({ coins: 100, tickets: 1 + (lv % 5 === 0 ? 2 : 0), packs: { PRMO: 1 } });
// prices (user 2026-11-03): packs 100 coins, KD and BT11-BT12 200; the PROMO pack is not sold, it is a reward
// (every level up, day 7 of the login calendar, tournaments). Starter decks 600, SD09 1000.
export const packPrice = (set: string) => (/^KD/.test(set) || set === 'BT11' || set === 'BT12' ? 200 : PRICE.pack);
export const SHOP_CLOSED = new Set(['PRMO']);
export const starterPrice = (set: string) => (set === 'SD09' ? 1000 : 600);
// duplicates beyond the copy limit become dust; crafting a card costs dust by its lowest rarity
const DUST_GET: Record<string, number> = { C: 5, R: 15, SR: 40, UR: 80, SCR: 150 };
const DUST_COST: Record<string, number> = { C: 20, R: 60, SR: 200, UR: 400, SCR: 600 };
const RARITY_RANK: Record<string, number> = { C: 0, R: 1, SR: 2, UR: 3, SCR: 4 };

export const MISSIONS: Record<string, { text: string; n: number; coins: number }> = {
  win2: { text: 'Win 2 games · ชนะ 2 เกม', n: 2, coins: 100 },
  play3: { text: 'Play 3 games · เล่น 3 เกม', n: 3, coins: 80 },
  winpvp: { text: 'Win an online duel · ชนะดวลออนไลน์ 1 ครั้ง', n: 1, coins: 120 },
  ranked1: { text: 'Play a Ranked match · เล่นแรงก์ 1 เกม', n: 1, coins: 100 },
  hardbot: { text: 'Beat a Hard bot · ชนะบอทระดับยาก', n: 1, coins: 80 },
  red2: { text: 'Play 2 games with a red deck · เล่นเด็คแดง 2 เกม', n: 2, coins: 90 },
  blue2: { text: 'Play 2 games with a blue deck · เล่นเด็คฟ้า 2 เกม', n: 2, coins: 90 },
  green2: { text: 'Play 2 games with a green deck · เล่นเด็คเขียว 2 เกม', n: 2, coins: 90 },
  purple2: { text: 'Play 2 games with a purple deck · เล่นเด็คม่วง 2 เกม', n: 2, coins: 90 },
};
const COLOR_MISSION: Record<string, string> = { 'แดง': 'red2', 'ฟ้า': 'blue2', 'เขียว': 'green2', 'ม่วง': 'purple2' };

// ranked: 100 points a step, 3 steps a tier (Bronze III/II/I .. Diamond), Master from 1500
export const TIERS = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Master'];
export const RANK = { win: 20, loss: 15 };
export function tierOf(pts: number) {
  const t = Math.min(5, Math.floor(Math.max(0, pts) / 300));
  if (t === 5) return { tier: 'Master', step: 0, index: 5, name: 'Master', floor: 1500 };
  const step = 3 - Math.floor((pts - t * 300) / 100); // III, II, I
  return { tier: TIERS[t], step, index: t, name: `${TIERS[t]} ${['', 'I', 'II', 'III'][step]}`, floor: t * 300 };
}

// ---------------------------------------------------------------- the card list
export type CardRow = { code: string; name: string; type: string; rarity: string; series: string; limit: number };
export type Catalog = { byCode: Map<string, CardRow>; sets: Map<string, CardRow[]>; nameOf: Map<string, string>; lowest: Map<string, string> };
const normRarity = (r: string) => (r in RARITY_RANK ? r : r === '' ? 'C' : r === 'PR' || r === 'CBR' || r === 'USEC' ? 'SR' : 'C');
export function catalog(raw: any[]): Catalog {
  const byCode = new Map<string, CardRow>(), sets = new Map<string, CardRow[]>(), nameOf = new Map<string, string>(), lowest = new Map<string, string>();
  for (const c of raw) {
    const r = normRarity(String(c.rarity || ''));
    const row: CardRow = { code: String(c.code), name: String(c.name), type: String(c.type), rarity: r, series: String(c.series || ''), limit: Number(c.customLimit) || 4 };
    if (!byCode.has(row.code)) byCode.set(row.code, row);
    nameOf.set(row.code, row.name);
    const lo = lowest.get(row.code);
    if (!lo || RARITY_RANK[r] < RARITY_RANK[lo]) lowest.set(row.code, r);
    // packs: the BT sets, every printed rarity is a separate pull (the same code in SR and SCR = two slots)
    if (/^(BT\d\d|KD0[1-4]|PRMO)$/.test(row.series) && row.type !== 'Life' && row.type !== 'Token') {
      if (!sets.has(row.series)) sets.set(row.series, []);
      sets.get(row.series)!.push(row);
    }
  }
  return { byCode, sets, nameOf, lowest };
}

// ---------------------------------------------------------------- the account's progress
export type Prog = {
  coins: number; tickets: number; dust: number;
  login: { last: string; day: number }; // last claim date, next calendar index (0..6)
  daily: { date: string; missions: { id: string; got: number; claimed: boolean }[]; rerolled: boolean; firstWin: boolean; freePack: boolean };
  bot: { date: string; xp: number; coins: number; games: number };
  cards: Record<string, number>; pity: Record<string, number>; packs: number; starters: string[];
  rank: { season: string; best: number; games: number; wins: number; last?: { season: string; best: number; reward: any } };
  icons: string[]; levelPaid: number; gift?: boolean;
};
export function prog(a: { prog: any }): Prog {
  const p = (a.prog && typeof a.prog === 'object' ? a.prog : (a.prog = {})) as any;
  p.coins ??= 0; p.tickets ??= 0; p.dust ??= 0;
  p.login ??= { last: '', day: 0 };
  p.daily ??= { date: '', missions: [], rerolled: false, firstWin: false, freePack: false };
  p.bot ??= { date: '', xp: 0, coins: 0, games: 0 };
  p.cards ??= {}; p.pity ??= {}; p.packs ??= 0; p.starters ??= [];
  p.rank ??= { season: '', best: 0, games: 0, wins: 0 };
  p.icons ??= []; p.levelPaid ??= 0;
  return p as Prog;
}
const rnd = (n: number) => crypto.randomInt(n);
function newMissions(): Prog['daily']['missions'] {
  const ids = Object.keys(MISSIONS), out: string[] = [];
  while (out.length < 3) { const id = ids[rnd(ids.length)]; if (!out.includes(id)) out.push(id); }
  return out.map((id) => ({ id, got: 0, claimed: false }));
}
// a new Thai day: fresh missions, first-win bonus and free pack again, bot caps reset
export function rollDay(p: Prog, now = Date.now()) {
  const d = today(now);
  if (p.daily.date !== d) p.daily = { date: d, missions: newMissions(), rerolled: false, firstWin: false, freePack: false };
  if (p.bot.date !== d) p.bot = { date: d, xp: 0, coins: 0, games: 0 };
}

type Gain = { coins?: number; tickets?: number; dust?: number; icon?: string; packs?: Record<string, number> };
function give(p: Prog, g: Gain) {
  p.coins += g.coins || 0; p.tickets += g.tickets || 0; p.dust += g.dust || 0;
  if (g.icon && !p.icons.includes(g.icon)) p.icons.push(g.icon);
  if (g.packs) { const inv = ((p as any).inv ??= {}); for (const [k, n] of Object.entries(g.packs)) inv[k] = (inv[k] || 0) + n; }
}
// XP in: level-up rewards for every level passed (paid once each, levelPaid remembers)
export function addXp(a: { xp: number; prog: any }, xp: number) {
  const p = prog(a);
  const before = levelOf(a.xp).level;
  a.xp += Math.max(0, Math.floor(xp));
  const after = levelOf(a.xp).level;
  const ups: { level: number; reward: Gain }[] = [];
  if (p.levelPaid < before) p.levelPaid = before; // levels reached before the economy existed pay nothing
  for (let lv = p.levelPaid + 1; lv <= after; lv++) { const r = LEVEL_REWARD(lv); give(p, r); ups.push({ level: lv, reward: r }); }
  p.levelPaid = Math.max(p.levelPaid, after);
  return ups;
}

// ---------------------------------------------------------------- login calendar
export function loginState(p: Prog, now = Date.now()) {
  return { day: p.login.day, canClaim: p.login.last !== today(now), rewards: LOGIN_DAYS };
}
export function claimLogin(p: Prog, now = Date.now()) {
  if (p.login.last === today(now)) return { error: 'Already claimed today. Come back tomorrow! · รับแล้ววันนี้' };
  const r = LOGIN_DAYS[p.login.day % 7];
  give(p, r);
  const day = p.login.day;
  p.login = { last: today(now), day: (p.login.day + 1) % 7 };
  return { ok: true, day, reward: r };
}

// ---------------------------------------------------------------- missions
export type GameEvent = { pvp: boolean; ranked?: boolean; won: boolean | null; bot?: string; color?: string };
export function progress(p: Prog, e: GameEvent) {
  rollDay(p);
  const done: string[] = [];
  for (const m of p.daily.missions) {
    const def = MISSIONS[m.id];
    if (!def || m.got >= def.n) continue;
    const hit = m.id === 'play3' || (m.id === 'win2' && e.won) || (m.id === 'winpvp' && e.pvp && e.won) || (m.id === 'ranked1' && e.ranked)
      || (m.id === 'hardbot' && e.bot === 'hard' && e.won) || (e.color && COLOR_MISSION[e.color] === m.id);
    if (hit) { m.got++; if (m.got >= def.n) done.push(m.id); }
  }
  return done;
}
export function claimMission(p: Prog, i: number) {
  rollDay(p);
  const m = p.daily.missions[i];
  if (!m) return { error: 'No such mission.' };
  const def = MISSIONS[m.id];
  if (m.claimed) return { error: 'Already claimed. · รับแล้ว' };
  if (m.got < def.n) return { error: 'Not finished yet. · ยังทำไม่ครบ' };
  m.claimed = true; give(p, { coins: def.coins });
  return { ok: true, reward: { coins: def.coins } };
}
export function rerollMission(p: Prog, i: number) {
  rollDay(p);
  const m = p.daily.missions[i];
  if (!m) return { error: 'No such mission.' };
  if (p.daily.rerolled) return { error: 'One re-roll a day. · เปลี่ยนได้วันละครั้ง' };
  if (m.claimed || m.got > 0) return { error: 'Only an untouched mission can be changed.' };
  const ids = Object.keys(MISSIONS).filter((id) => !p.daily.missions.some((x) => x.id === id));
  p.daily.missions[i] = { id: ids[rnd(ids.length)], got: 0, claimed: false };
  p.daily.rerolled = true;
  return { ok: true };
}
export const missionsView = (p: Prog) => p.daily.missions.map((m) => ({ ...m, ...MISSIONS[m.id] }));

// ---------------------------------------------------------------- owned cards
// Owning a card = owning any print with that name (same-name cards are the same card in this game).
export function ownedByName(p: Prog, cat: Catalog) {
  const by = new Map<string, number>();
  for (const [code, n] of Object.entries(p.cards)) { const nm = cat.nameOf.get(code); if (nm) by.set(nm, (by.get(nm) || 0) + n); }
  return by;
}
// The cards of a deck the player doesn't own enough of ([] = fully owned). LIFE cards and tokens are free.
export function missingCards(p: Prog, cat: Catalog, deck: any): { name: string; need: number; have: number }[] {
  const need = new Map<string, number>();
  for (const c of [...(deck.main || []), ...(deck.side || [])]) {
    const row = cat.byCode.get(String(c.print));
    if (!row || row.type === 'Life' || row.type === 'Token') continue;
    need.set(row.name, (need.get(row.name) || 0) + Number(c.qty || 0));
  }
  const have = ownedByName(p, cat), out: { name: string; need: number; have: number }[] = [];
  for (const [name, n] of need) if ((have.get(name) || 0) < n) out.push({ name, need: n, have: have.get(name) || 0 });
  return out;
}
// add a card; beyond its copy limit it becomes dust
function addCard(p: Prog, cat: Catalog, code: string, rarity: string): { code: string; rarity: string; dust?: number; isNew?: boolean } {
  const row = cat.byCode.get(code)!;
  const have = p.cards[code] || 0;
  if (have >= row.limit) { const d = DUST_GET[rarity] || 5; p.dust += d; return { code, rarity, dust: d }; }
  p.cards[code] = have + 1;
  return { code, rarity, isNew: have === 0 };
}

// ---------------------------------------------------------------- packs
// 6 cards (user, 2026-11-03): 4 commons, 1 rare (R, or SR in sets without R), 1 top slot (SCR 2.5%, UR 7.5%, SR 20%,
// else R); the set's best rarity (SCR, or UR where a set has no SCR) is guaranteed by the 40th pack.
// Packs: BT01-BT12, KD01-KD04 and PROMO (series PRMO).
export const ODDS = { top: { SCR: 0.025, UR: 0.075, SR: 0.2 }, pity: 40, cards: 6 };
const bestOf = (rows: CardRow[]) => ['SCR', 'UR', 'SR', 'R', 'C'].find((r) => rows.some((x) => x.rarity === r)) || 'C';
export const packName = (set: string) => (set === 'PRMO' ? 'PROMO' : set);
export function packInfo(cat: Catalog, p?: Prog) {
  return [...cat.sets.keys()].sort().map((set) => ({
    set, name: packName(set), kind: set.startsWith('BT') ? 'booster' : set.startsWith('KD') ? 'kd' : 'promo',
    cards: cat.sets.get(set)!.length, perPack: ODDS.cards, price: packPrice(set), forSale: !SHOP_CLOSED.has(set), pity: ODDS.pity, sinceScr: p ? p.pity[set] || 0 : 0, best: bestOf(cat.sets.get(set)!),
    odds: { common: '4 cards', rare: '1 card R or better', top: 'SCR 2.5% · UR 7.5% · SR 20% · R 70% (a rarity the set lacks drops to the next one)', scrPity: `${bestOf(cat.sets.get(set)!)} guaranteed by pack ${ODDS.pity}` },
  }));
}
function pickOf(rows: CardRow[], rarities: string[]): CardRow | null {
  for (const r of rarities) { const xs = rows.filter((x) => x.rarity === r); if (xs.length) return xs[rnd(xs.length)]; }
  return rows.length ? rows[rnd(rows.length)] : null;
}
export function openPacks(p: Prog, cat: Catalog, set: string, count: number, pay: 'coins' | 'ticket' | 'free' | 'inv') {
  rollDay(p);
  const rows = cat.sets.get(set);
  if (!rows) return { error: 'No such pack. · ไม่มีซองนี้' };
  count = Math.max(1, Math.min(10, Math.floor(count) || 1));
  if (pay !== 'inv' && SHOP_CLOSED.has(set)) return { error: 'This pack is a reward only. · ซองนี้ได้จากรางวัลเท่านั้น' };
  if (pay === 'free') {
    if (p.daily.freePack) return { error: 'Today\'s free pack is opened. · รับซองฟรีวันนี้แล้ว' };
    count = 1; p.daily.freePack = true;
  } else if (pay === 'inv') {
    const inv = (p as any).inv ??= {};
    if ((inv[set] || 0) < count) return { error: 'You have no unopened packs of this set. · ไม่มีซองนี้ในคลัง' };
    inv[set] -= count; if (!inv[set]) delete inv[set];
  } else if (pay === 'ticket') {
    if (p.tickets < count) return { error: 'Not enough pack tickets. · ตั๋วไม่พอ' };
    p.tickets -= count;
  } else {
    if (p.coins < packPrice(set) * count) return { error: 'Not enough coins. · เหรียญไม่พอ' };
    p.coins -= packPrice(set) * count;
  }
  const packs: any[] = [];
  for (let k = 0; k < count; k++) {
    p.packs++;
    const pulls: CardRow[] = [];
    for (let i = 0; i < 4; i++) pulls.push(pickOf(rows, ['C'])!);
    pulls.push(pickOf(rows, ['R', 'SR', 'C'])!);
    const since = (p.pity[set] || 0) + 1;
    const x = Math.random();
    let top = x < ODDS.top.SCR ? 'SCR' : x < ODDS.top.SCR + ODDS.top.UR ? 'UR' : x < ODDS.top.SCR + ODDS.top.UR + ODDS.top.SR ? 'SR' : 'R';
    const best = bestOf(rows);
    if (since >= ODDS.pity) top = best;
    const order = ['SCR', 'UR', 'SR', 'R', 'C'];
    pulls.push(pickOf(rows, order.slice(order.indexOf(top)))!);
    p.pity[set] = pulls.some((c) => c.rarity === best) ? 0 : since;
    packs.push(pulls.map((c) => addCard(p, cat, c.code, c.rarity)));
  }
  return { ok: true, set, packs, pityLeft: ODDS.pity - (p.pity[set] || 0) };
}
export function craft(p: Prog, cat: Catalog, code: string) {
  const row = cat.byCode.get(code);
  if (!row || row.type === 'Life' || row.type === 'Token') return { error: 'That card can\'t be crafted.' };
  const cost = DUST_COST[cat.lowest.get(code) || 'C'] || 20;
  if ((p.cards[code] || 0) >= row.limit) return { error: 'You already have the most copies. · มีครบแล้ว' };
  if (p.dust < cost) return { error: `Needs ${cost} dust. · เศษการ์ดไม่พอ` };
  p.dust -= cost; p.cards[code] = (p.cards[code] || 0) + 1;
  return { ok: true, code, cost };
}
// starter decks (SD sets): 1 at the start, 2 more at level 5 and 10. Every card of the set, up to 4 copies.
export function claimStarter(a: { xp: number; prog: any }, cat: Catalog, raw: any[], set: string) {
  const p = prog(a);
  if (!SHOP.starterSets.includes(set)) return { error: 'Pick a starter deck (SD01-SD09).' };
  if (p.starters.includes(set)) return { error: 'You already have this starter deck.' };
  if (p.starters.length >= 1) return { error: 'Your free starter deck is taken. Buy more in the Shop. · ซื้อเพิ่มได้ที่ร้าน' };
  const codes = [...new Set(raw.filter((c) => c.series === set && c.type !== 'Life' && c.type !== 'Token').map((c) => String(c.code)))];
  for (const c of codes) p.cards[c] = Math.max(p.cards[c] || 0, Math.min(4, cat.byCode.get(c)?.limit || 4));
  p.starters.push(set);
  return { ok: true, set, cards: codes.length };
}

// ---------------------------------------------------------------- rewards for a finished game
// One account's result. coinsOk = the deck was all owned cards (hybrid rule); bot games are capped per day.
export function gameReward(a: { xp: number; prog: any }, e: GameEvent & { coinsOk: boolean }) {
  const p = prog(a);
  rollDay(p);
  let xp = 0, coins = 0;
  if (e.pvp) { const r = e.won === null ? PVP.draw : e.won ? PVP.win : PVP.loss; xp = r.xp; coins = r.coins; }
  else {
    const r = e.won ? BOT.win[e.bot || 'easy'] || BOT.win.easy : BOT.loss;
    xp = Math.max(0, Math.min(r.xp, BOT.capXp - p.bot.xp)); coins = Math.max(0, Math.min(r.coins, BOT.capCoins - p.bot.coins));
    p.bot.xp += xp; p.bot.coins += coins; p.bot.games++;
  }
  if (!e.coinsOk) coins = 0;
  let firstWin = false;
  if (e.won && coins > 0 && !p.daily.firstWin) { p.daily.firstWin = true; firstWin = true; coins *= 2; }
  give(p, { coins });
  const done = progress(p, e);
  const ups = addXp(a, xp);
  return { xp, coins, firstWin, levelUps: ups, missionsDone: done, level: levelOf(a.xp), coinsNote: e.coinsOk ? '' : 'No coins: this deck has cards you don\'t own yet. · เด็คมีการ์ดที่ยังไม่มี' };
}

// ranked: Elo for matchmaking (hidden), points for the badge; Bronze and Silver never drop below their floor
export function rankedResult(a: { rank_pts: number; mmr: number; season: string; prog: any }, oppMmr: number, won: boolean | null) {
  const p = prog(a);
  const exp = 1 / (1 + 10 ** ((oppMmr - a.mmr) / 400));
  const score = won === null ? 0.5 : won ? 1 : 0;
  const mmrDelta = Math.round(32 * (score - exp));
  a.mmr += mmrDelta;
  const before = a.rank_pts, t = tierOf(before);
  let pts = before + (won === null ? 0 : won ? RANK.win : -RANK.loss);
  if (t.index <= 1) pts = Math.max(pts, t.floor);
  a.rank_pts = Math.max(0, pts);
  p.rank.games++; if (won) p.rank.wins++;
  p.rank.best = Math.max(p.rank.best, a.rank_pts);
  const after = tierOf(a.rank_pts);
  return { pts: a.rank_pts - before, total: a.rank_pts, tier: after.name, promoted: after.index > t.index || (after.index === t.index && after.step < t.step), demoted: after.index < t.index };
}
// a new season: rewards for last season's best tier, then a soft reset (one tier down)
export function seasonCheck(a: { rank_pts: number; season: string; prog: any }, now = Date.now()) {
  const p = prog(a), s = seasonOf(now);
  if (a.season === s) return null;
  let reward: any = null;
  if (a.season && p.rank.games > 0) {
    const best = tierOf(p.rank.best);
    reward = { coins: 200 * (best.index + 1), tickets: best.index + 1, icon: `season-${a.season}-${best.tier.toLowerCase()}` };
    give(p, reward);
    p.rank.last = { season: a.season, best: p.rank.best, reward };
  }
  const t = tierOf(a.rank_pts);
  a.rank_pts = Math.max(0, (t.index - 1) * 300);
  a.season = s;
  p.rank = { season: s, best: a.rank_pts, games: 0, wins: 0, last: p.rank.last };
  return reward;
}

// one-time start gift for every account (the first time the economy sees it): coins + tickets
export function startGift(p: Prog) {
  if (p.gift) return null;
  p.gift = true;
  const g = { coins: 500, tickets: 10 };
  give(p, g);
  return g;
}

// ---------------------------------------------------------------- name banner (user pick P2, 2026-11-03)
// Slanted nameplate: icon, name, earned title, rank badge. Banner colour and frame unlock with level; titles are
// earned by level, best rank and online wins. Chosen ones live in prog.title / prog.banner / prog.frame.
export const BANNERS = [
  { id: 'plain', level: 1 }, { id: 'red', level: 3 }, { id: 'blue', level: 5 }, { id: 'green', level: 7 }, { id: 'purple', level: 10 },
  { id: 'gold', level: 15 }, { id: 'black', level: 20 }, { id: 'rainbow', level: 30 },
];
export const FRAMES = [{ id: 'none', level: 1 }, { id: 'bronze', level: 5 }, { id: 'silver', level: 10 }, { id: 'gold', level: 20 }, { id: 'diamond', level: 40 }];
export const TITLES: { id: string; name: string; level?: number; rank?: number; wins?: number }[] = [
  { id: 'rookie', name: 'Rookie · มือใหม่', level: 1 }, { id: 'duelist', name: 'Duelist · นักดวล', level: 5 },
  { id: 'veteran', name: 'Veteran · ทหารผ่านศึก', level: 10 }, { id: 'champion', name: 'Champion · แชมป์', level: 20 },
  { id: 'legend', name: 'Legend · ตำนาน', level: 40 },
  { id: 'gold', name: 'Gold Duelist · นักดวลทองคำ', rank: 2 }, { id: 'diamond', name: 'Diamond Mind · จิตเพชร', rank: 4 },
  { id: 'master', name: 'Master of Talingchan · เจ้าแห่งตลิ่งชัน', rank: 5 },
  { id: 'win10', name: 'Winner · ผู้ชนะ', wins: 10 }, { id: 'win100', name: 'Hundred Wins · ร้อยชัย', wins: 100 },
];
export function bannerView(a: { xp: number; wins: number; prog: any }) {
  const p = prog(a) as any, lv = levelOf(a.xp).level, best = tierOf(p.rank.best || 0).index;
  const titles = TITLES.filter((t) => (t.level ? lv >= t.level : true) && (t.rank !== undefined ? best >= t.rank : true) && (t.wins ? a.wins >= t.wins : true));
  const banners = BANNERS.filter((b) => lv >= b.level), frames = FRAMES.filter((f) => lv >= f.level);
  const pick = (id: string, list: { id: string }[]) => (list.some((x) => x.id === id) ? id : list[0].id);
  const title = titles.find((t) => t.id === pick(p.title, titles))!;
  return {
    title: title.id, titleName: title.name, banner: pick(p.banner, banners), frame: pick(p.frame, frames),
    unlocked: { titles: titles.map((t) => ({ id: t.id, name: t.name })), banners: banners.map((b) => b.id), frames: frames.map((f) => f.id) },
    locked: { banners: BANNERS.filter((b) => lv < b.level), frames: FRAMES.filter((f) => lv < f.level), titles: TITLES.filter((t) => !titles.includes(t)) },
  };
}
// set any of title/banner/frame; refuses ones not unlocked yet
export function setBanner(a: { xp: number; wins: number; prog: any }, b: { title?: any; banner?: any; frame?: any }) {
  const p = prog(a) as any, v = bannerView(a);
  for (const [k, list] of [['title', v.unlocked.titles.map((t) => t.id)], ['banner', v.unlocked.banners], ['frame', v.unlocked.frames]] as const) {
    if (b[k] === undefined) continue;
    if (!list.includes(String(b[k]))) return { error: `That ${k} is not unlocked yet. · ยังไม่ปลดล็อก` };
    p[k] = String(b[k]);
  }
  return { ok: true };
}

// ---------------------------------------------------------------- shop (user, 2026-11-03)
// Packs bought in the shop go to the pack inventory (prog.inv {set: n}) and are opened later in the Collection room
// (openPacks pay 'inv'). Starter decks SD01-SD09: each bought once (the first one is free in the welcome flow).
export const SHOP = { starterPrice: 600, starterSets: ['SD01', 'SD02', 'SD03', 'SD04', 'SD05', 'SD06', 'SD07', 'SD08', 'SD09'] };
export function buyPacks(p: Prog, cat: Catalog, set: string, count: number, pay: 'coins' | 'ticket') {
  if (!cat.sets.has(set)) return { error: 'No such pack. · ไม่มีซองนี้' };
  if (SHOP_CLOSED.has(set)) return { error: 'This pack is a reward only. · ซองนี้ได้จากรางวัลเท่านั้น' };
  count = Math.max(1, Math.min(10, Math.floor(count) || 1));
  if (pay === 'ticket') { if (p.tickets < count) return { error: 'Not enough pack tickets. · ตั๋วไม่พอ' }; p.tickets -= count; }
  else { if (p.coins < packPrice(set) * count) return { error: 'Not enough coins. · เหรียญไม่พอ' }; p.coins -= packPrice(set) * count; }
  const inv = (p as any).inv ??= {};
  inv[set] = (inv[set] || 0) + count;
  return { ok: true, set, count, inv };
}
export function buyStarter(a: { xp: number; prog: any }, cat: Catalog, raw: any[], set: string) {
  const p = prog(a);
  if (!SHOP.starterSets.includes(set)) return { error: 'This starter deck is not for sale yet. · ยังไม่เปิดขาย' };
  if (p.starters.includes(set)) return { error: 'You already have this starter deck. · มีแล้ว' };
  if (p.coins < starterPrice(set)) return { error: 'Not enough coins. · เหรียญไม่พอ' };
  p.coins -= starterPrice(set);
  const codes = [...new Set(raw.filter((c) => c.series === set && c.type !== 'Life' && c.type !== 'Token').map((c) => String(c.code)))];
  for (const c of codes) p.cards[c] = Math.max(p.cards[c] || 0, Math.min(4, cat.byCode.get(c)?.limit || 4));
  p.starters.push(set);
  return { ok: true, set, cards: codes.length };
}

// ---------------------------------------------------------------- weekly draw (once a week, Monday-based, Thai time)
export const WEEKLY = [
  { w: 40, g: { coins: 100 } }, { w: 25, g: { coins: 200 } }, { w: 15, g: { tickets: 1 } }, { w: 10, g: { dust: 100 } },
  { w: 6, g: { coins: 500 } }, { w: 3, g: { tickets: 3 } }, { w: 1, g: { tickets: 10 } },
];
export function weekOf(now = Date.now()) { const t = new Date(now + 7 * 3600e3); const day = (t.getUTCDay() + 6) % 7; const mon = new Date(t.getTime() - day * 864e5); return mon.toISOString().slice(0, 10); }
export function weeklyDraw(p: Prog) {
  const pp = p as any, wk = weekOf();
  if (pp.weekly === wk) return { error: 'Already drawn this week. · สัปดาห์นี้จับแล้ว' };
  const total = WEEKLY.reduce((x, y) => x + y.w, 0);
  let r = rnd(total), pick = WEEKLY[0];
  for (const x of WEEKLY) { if (r < x.w) { pick = x; break; } r -= x.w; }
  pp.weekly = wk; give(p, pick.g);
  return { ok: true, reward: pick.g, week: wk };
}

// ---------------------------------------------------------------- friends (prog.friends {list, in, out}: account ids)
export function friendsOf(p: Prog) { const f = ((p as any).friends ??= { list: [], in: [], out: [] }); return f as { list: string[]; in: string[]; out: string[] }; }
export const FRIEND_MAX = 100;

// ---------------------------------------------------------------- playable characters (user, 2026-11-03)
// Every account starts with only c51 แก๊ง SUPER CARD; the others are bought once in the shop. Price by deck strength
// (character number = strength, c01 strongest): c01-c10 3000, c11-c20 2500, c21-c30 2000, c31-c40 1500, c41-c50 1000,
// c52-c54 2000. Profile pictures stay free; the character you play as in online rooms and Ranked must be owned.
// (Same ids as godot/characters/characters.json.)
export const FREE_CHAR = 'c51';
export const CHARACTERS: { id: string; name: string; price: number }[] = [
  { id: 'c51', name: "แก๊งSUPER CARD", price: 0 },
  { id: 'c01', name: "สุครีพ", price: 3000 },
  { id: 'c02', name: "มณโฑ", price: 3000 },
  { id: 'c03', name: "ชิโยเมะ", price: 3000 },
  { id: 'c04', name: "นัท", price: 3000 },
  { id: 'c05', name: "เมฟิสโต้", price: 3000 },
  { id: 'c06', name: "รัททาทุย", price: 3000 },
  { id: 'c07', name: "เป้อ", price: 3000 },
  { id: 'c08', name: "วี", price: 3000 },
  { id: 'c09', name: "โฟเบีย", price: 3000 },
  { id: 'c10', name: "ขวัญตา", price: 3000 },
  { id: 'c11', name: "คลีปเปอร์", price: 2500 },
  { id: 'c12', name: "จอมเวทย์ กาลู", price: 2500 },
  { id: 'c13', name: "Watson", price: 2500 },
  { id: 'c14', name: "AI", price: 2500 },
  { id: 'c15', name: "มีมมิ", price: 2500 },
  { id: 'c16', name: "เพมมุ", price: 2500 },
  { id: 'c17', name: "เนฟิเรีย", price: 2500 },
  { id: 'c18', name: "สวีนนีย์", price: 2500 },
  { id: 'c19', name: "ซีเวีย", price: 2500 },
  { id: 'c20', name: "ซีเกิร์ด", price: 2500 },
  { id: 'c21', name: "ซันนี่", price: 2000 },
  { id: 'c22', name: "วาริช", price: 2000 },
  { id: 'c23', name: "เวหา", price: 2000 },
  { id: 'c53', name: "กัปตัน เชิดชัย", price: 2000 },
  { id: 'c25', name: "ปื้ด", price: 2000 },
  { id: 'c26', name: "กุ่ย นาย ฮอล", price: 2000 },
  { id: 'c27', name: "น้อง อานิมะ", price: 2000 },
  { id: 'c28', name: "อินาริ", price: 2000 },
  { id: 'c29', name: "บ่าวจุ้ย", price: 2000 },
  { id: 'c30', name: "ไท", price: 2000 },
  { id: 'c31', name: "อาเธอร์", price: 1500 },
  { id: 'c32', name: "ครีเอเทีย", price: 1500 },
  { id: 'c33', name: "ถัง จือหลิง", price: 1500 },
  { id: 'c34', name: "เจมส์", price: 1500 },
  { id: 'c35', name: "ภูติผลไม้ แตงกวา", price: 1500 },
  { id: 'c36', name: "วอเตอร์แมน", price: 1500 },
  { id: 'c37', name: "ฟรีแลนซ์", price: 1500 },
  { id: 'c38', name: "อาจารย์", price: 1500 },
  { id: 'c39', name: "หลิงฉี", price: 1500 },
  { id: 'c40', name: "จีน", price: 1500 },
  { id: 'c41', name: "โจโฉ", price: 1000 },
  { id: 'c42', name: "เล่าปี่", price: 1000 },
  { id: 'c43', name: "ซุนกวน", price: 1000 },
  { id: 'c44', name: "Linux", price: 1000 },
  { id: 'c45', name: "อลัน", price: 1000 },
  { id: 'c46', name: "มินามิ โคทาโร่", price: 1000 },
  { id: 'c47', name: "ลิโป้", price: 1000 },
  { id: 'c48', name: "ตำรวจ", price: 1000 },
  { id: 'c49', name: "แบงค์", price: 1000 },
  { id: 'c50', name: "ซินแส", price: 1000 },
  { id: 'c54', name: "HHKP", price: 2000 },
  { id: 'c52', name: "agent smooth", price: 2000 },
];
const CHAR_BY_ID = new Map(CHARACTERS.map((c) => [c.id, c]));
export function charsOf(p: Prog): string[] { const pp = p as any; pp.chars ??= [FREE_CHAR]; if (!pp.chars.includes(FREE_CHAR)) pp.chars.unshift(FREE_CHAR); return pp.chars; }
export function charShop(p: Prog) { const own = charsOf(p); return CHARACTERS.map((c) => ({ ...c, owned: own.includes(c.id) })); }
export function buyCharacter(p: Prog, id: string) {
  const c = CHAR_BY_ID.get(id);
  if (!c) return { error: 'No such character.' };
  const own = charsOf(p);
  if (own.includes(id)) return { error: 'You already have this character. · มีแล้ว' };
  if (p.coins < c.price) return { error: 'Not enough coins. · เหรียญไม่พอ' };
  p.coins -= c.price; own.push(id);
  return { ok: true, id, chars: own };
}
// the character a player may use: owned (or the free one); unknown/unowned -> c51
export function usableChar(p: Prog | null, want: string): string {
  if (!CHAR_BY_ID.has(want)) return FREE_CHAR;
  if (want === FREE_CHAR) return want;
  return p && charsOf(p).includes(want) ? want : FREE_CHAR;
}
