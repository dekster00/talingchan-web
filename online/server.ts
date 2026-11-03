// Online server for Battle of Talingchan: player-vs-player duels, rooms, a room list and world chat.
//   node --experimental-strip-types --no-warnings online/server.ts          (PORT env or --port, default 8787)
// No dependencies. Every path lives under /online, so it can share one origin with the web build:
//   lobby:  /online/login, /online/poll (long-poll), /online/chat, /online/report, /online/room/*, /online/admin
//   duel:   /online/api/new | state | answer | cards | speed | undo | admin  (same shapes as play/server.ts, so the
//           Godot duel screen works unchanged), /online/emote, /online/surrender
// Auth: every call after login sends the header "X-Session: <token>" (or ?s=<token>).
// The rules run here (online/duel_worker.ts, one worker thread per duel), so nobody can cheat or read the other hand:
// each seat gets only its own hand and deck list, and seat 1 gets a mirrored view (it always sees itself as player 0).
// Settings (env): PORT, DATA_DIR (default online/data), ADMIN_KEY (enables /online/admin), TURN_SEC (120),
// REACT_SEC (30), ORIGIN (CORS allow-origin, default *), DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET / PUBLIC_URL
// (optional Discord login; without them players log in with a nickname), GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET /
// PUBLIC_URL (Google login = a player account: profile, level, stats, history, cloud decks; online/accounts.ts),
// SUPABASE_URL / SUPABASE_SERVICE_KEY (where accounts are kept; without them: DATA_DIR files), SESSION_SECRET.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Worker, MessageChannel } from 'node:worker_threads';
import { CARDS, loadDefs, loadDeck, validateDeck, banlistErrors } from '../src/sim.ts';
import { Store, levelOf, usingSupabase, type Account, type DeckMap } from './accounts.ts';
import * as Eco from './economy.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DECKS = path.join(ROOT, 'decks');
const argPort = process.argv.indexOf('--port');
const PORT = Number(argPort > 0 ? process.argv[argPort + 1] : process.env.PORT || 8787);
const DATA = path.resolve(process.env.DATA_DIR || path.join(HERE, 'data'));
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const TURN_SEC = Number(process.env.TURN_SEC) || 120, REACT_SEC = Number(process.env.REACT_SEC) || 30;
// user 2026-11-02: online duels have no turn timer for now (TIMER=1 turns it on) and run at 2x speed (ONLINE_SPEED, 0.5 = 2x)
const TIMER = process.env.TIMER === '1', ONLINE_SPEED = process.env.ONLINE_SPEED === undefined ? 0.5 : Number(process.env.ONLINE_SPEED);
const ORIGIN = process.env.ORIGIN || '*';
const VERSION = '1.0-online1';
fs.mkdirSync(DATA, { recursive: true });
const STORE = new Store(DATA);

// ---------------------------------------------------------------- cards
const RAW: any[] = JSON.parse(fs.readFileSync(CARDS, 'utf8'));
const INFO = new Map<string, any>();
for (const c of RAW) if (!INFO.has(c.code)) INFO.set(c.code, {
  print: c.code, name: c.name, type: c.type, subtype: c.subtype, cost: c.cost, gem: c.gem, power: c.power,
  color: c.color, symbol: c.symbol, ex: c.ex, effect: c.effect, image: c.imageUrl, rarity: c.rarity || '', rarities: [] as string[],
});
for (const c of RAW) { const i = INFO.get(c.code); if (i && c.rarity && !i.rarities.includes(c.rarity)) i.rarities.push(c.rarity); }
const DEFS = loadDefs();
const CAT = Eco.catalog(RAW); // owned cards, packs (online/economy.ts)
const DEFAULT_LIFE = ['SD01-021', 'SD01-022', 'SD01-023', 'SD01-024', 'SD01-025'];
function metaDecks() {
  return fs.readdirSync(DECKS).filter((f) => f.endsWith('.json') && !['ninja.json', 'vanara.json'].includes(f)).sort().map((f) => {
    const d = JSON.parse(fs.readFileSync(path.join(DECKS, f), 'utf8'));
    return { file: f, name: d.archetype || f, list: d.source?.deck_name || '', cards: d.cards.reduce((n: number, c: any) => n + c.qty, 0) };
  }).filter((d) => d.cards === 50);
}
// A deck from a client: a meta deck file name, or an inline deck {name, main, life, side, art?}. Returns a clean copy.
function cleanDeck(d: any): { deck?: any; error?: string; warnings?: string[] } {
  if (typeof d === 'string') {
    if (!metaDecks().some((m) => m.file === d)) return { error: 'Unknown deck file.' };
    const o = JSON.parse(fs.readFileSync(path.join(DECKS, d), 'utf8'));
    d = { name: o.archetype || d, main: o.cards, life: o.life || [] };
  }
  if (!d || typeof d !== 'object') return { error: 'Pick a deck.' };
  const part = (xs: any) => (Array.isArray(xs) ? xs.slice(0, 80).map((c: any) => ({ print: String(c && c.print || ''), qty: Math.max(0, Math.min(50, Math.floor(Number(c && c.qty) || 0))) })).filter((c: any) => c.qty > 0) : []);
  const deck: any = { name: String(d.name || 'deck').slice(0, 40), main: part(d.main || d.cards), life: part(d.life), side: part(d.side) };
  if (d.art && typeof d.art === 'object') { deck.art = {}; for (const k of Object.keys(d.art).slice(0, 80)) deck.art[String(k)] = String(d.art[k]).slice(0, 8); }
  try { loadDeck(deck, DEFS); } catch (e) {
    const m = (e as Error).message;
    // a card the game has but this server doesn't: the server runs an older card list (qa/sync_online.py updates it)
    return { error: /^unknown card /.test(m) ? `${m} (this server's card list is older than your game, ask the host to update it · เซิร์ฟเวอร์ยังไม่มีการ์ดใบนี้)` : m };
  }
  // 2026-10-25 (user): PvP follows the official ban list; a deck that breaks it can't be used
  const ban = banlistErrors([...deck.main, ...deck.side].flatMap((c: any) => Array(c.qty).fill(DEFS.get(c.print)).filter(Boolean)));
  if (ban.length) return { error: 'Ban list: ' + ban.join(' ') };
  // no LIFE deck = the default LIFE deck is used, so that note is left out
  return { deck, warnings: validateDeck(deck, DEFS).filter((w) => !/^LIFE deck has 0 cards/.test(w)) };
}
const deckPrints = (d: any) => [...(d.main || []), ...(d.life || [])].map((c: any) => c.print);

// ---------------------------------------------------------------- moderation
// Word filter: online/badwords.txt (one word per line, # comments; "!word" = allowed word that contains a bad one).
function loadWords() {
  const bad: string[] = [], ok: string[] = [];
  for (const f of [path.join(HERE, 'badwords.txt'), path.join(DATA, 'badwords.txt')]) {
    try {
      for (let l of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
        l = l.trim().toLowerCase();
        if (!l || l.startsWith('#')) continue;
        if (l.startsWith('!')) ok.push(l.slice(1)); else bad.push(l);
      }
    } catch {}
  }
  return { bad: [...new Set(bad)].sort((a, b) => b.length - a.length), ok };
}
let WORDS = loadWords();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function filterText(s: string): string {
  let t = s;
  const keep: string[] = [];
  // allowed words that contain a bad word are hidden first, then put back
  for (const w of WORDS.ok) t = t.replace(new RegExp(esc(w), 'gi'), (m) => { keep.push(m); return `\u0001${keep.length - 1}\u0001`; });
  for (const w of WORDS.bad) {
    // Latin words: whole words (and simple l33t spacing); Thai has no spaces, so anywhere
    const re = /^[a-z0-9]+$/.test(w) ? new RegExp(`\\b${w.split('').map(esc).join('[\\s._*-]?')}\\w*`, 'gi') : new RegExp(esc(w), 'g');
    t = t.replace(re, (m) => '*'.repeat(Math.min(8, [...m].length)));
  }
  return t.replace(/\u0001(\d+)\u0001/g, (_, i) => keep[Number(i)]);
}
function cleanLine(s: any, max: number): string {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f​-‏‪-‮]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
const LINK = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|gg|io|me|ly|xyz|th|co)\b\S*/gi;
// bans and mutes survive a restart: data/mod.json {muted: {id: until}, banned: {id: reason}}
type Mod = { muted: Record<string, number>; banned: Record<string, string> };
let MOD: Mod = { muted: {}, banned: {} };
try { MOD = { muted: {}, banned: {}, ...JSON.parse(fs.readFileSync(path.join(DATA, 'mod.json'), 'utf8')) }; } catch {}
const saveMod = () => { try { fs.writeFileSync(path.join(DATA, 'mod.json'), JSON.stringify(MOD, null, 1)); } catch (e) { console.error(e); } };
function appendJsonl(file: string, o: any) { try { fs.appendFileSync(path.join(DATA, file), JSON.stringify(o) + '\n'); } catch (e) { console.error(e); } }

// ---------------------------------------------------------------- users
type User = {
  id: string; token: string; name: string; avatar?: string; discord?: string; acct?: string; ip: string; seen: number; room: string | null;
  sent: number[]; strikes: number; muteMsg: number;
};
const USERS = new Map<string, User>(); // token -> user
const BY_ID = new Map<string, User>();
// tokens survive a restart (reconnect): data/users.json [{id, token, name, discord}]
try { for (const u of JSON.parse(fs.readFileSync(path.join(DATA, 'users.json'), 'utf8'))) addUser({ ...u, ip: '', seen: 0, room: null, sent: [], strikes: 0, muteMsg: 0 }); } catch {}
function addUser(u: User) { USERS.set(u.token, u); BY_ID.set(u.id, u); }
let usersDirty = false;
setInterval(() => {
  if (!usersDirty) return;
  usersDirty = false;
  const keep = [...USERS.values()].filter((u) => u.seen === 0 || Date.now() - u.seen < 30 * 864e5).slice(-5000);
  try { fs.writeFileSync(path.join(DATA, 'users.json'), JSON.stringify(keep.map(({ id, token, name, avatar, discord, acct }) => ({ id, token, name, avatar, discord, acct })))); } catch (e) { console.error(e); }
}, 5000).unref();
const online = () => [...USERS.values()].filter((u) => Date.now() - u.seen < 60000);
const mutedUntil = (u: User) => Number(MOD.muted[u.id] || 0);
const acctOf = (u: User | undefined | null): Account | undefined => (u && u.acct ? STORE.cached(u.acct) : undefined);
const levelFor = (u: User | undefined | null) => { const a = acctOf(u); return a ? levelOf(a.xp).level : 0; };
// lv: the player's level (0 = guest, no account)
const pub = (u: User | undefined | null) => (u ? { id: u.id, name: u.name, avatar: u.avatar || '', lv: levelFor(u) } : null);
// profile picture: a character id like "c07" (the game shows that character's face)
const cleanAvatar = (a: any) => { const s = String(a ?? '').toLowerCase(); return /^[a-z0-9_]{1,12}$/.test(s) ? s : ''; };
function uniqueName(want: string, self?: User): string {
  const taken = (n: string) => online().some((u) => u !== self && u.name.toLowerCase() === n.toLowerCase());
  if (!taken(want)) return want;
  for (let i = 2; i < 100; i++) if (!taken(`${want}#${i}`)) return `${want}#${i}`;
  return `${want}#${crypto.randomInt(100, 9999)}`;
}
function login(name: string, ip: string, discord?: string): User {
  const id = crypto.randomBytes(6).toString('hex');
  const u: User = { id, token: crypto.randomBytes(24).toString('hex'), name: uniqueName(name), discord, ip, seen: Date.now(), room: null, sent: [], strikes: 0, muteMsg: 0 };
  addUser(u); usersDirty = true;
  return u;
}

// ---------------------------------------------------------------- lobby state + long-poll
let LV = 0; // lobby version: any change to rooms, chat or a player's room
let waiters: (() => void)[] = [];
function bump() { LV++; const w = waiters; waiters = []; w.forEach((f) => f()); }
type Msg = { id: number; at: number; from: { id: string; name: string } | null; text: string; sys?: boolean };
let MSG_ID = 0;
const WORLD: Msg[] = [];
function pushMsg(list: Msg[], from: User | null, text: string, sys = false, cap = 100) {
  const m: Msg = { id: ++MSG_ID, at: Date.now(), from: from ? pub(from) : null, text, sys: sys || undefined };
  list.push(m);
  if (list.length > cap) list.splice(0, list.length - cap);
  appendJsonl('chat.jsonl', { ...m, ch: list === WORLD ? 'world' : 'room', ip: from?.ip });
  bump();
  return m;
}

// ---------------------------------------------------------------- rooms
type Seat = { user: string; deck: any | null; deckName: string; ready: boolean; char: string; warnings: string[] };
type Room = {
  code: string; name: string; host: string; password: string; priv: boolean; bo3: boolean;
  seats: (Seat | null)[]; chat: Msg[]; score: [number, number]; duel: Duel | null; last: any; created: number; games: number;
  ranked?: boolean; // made by the Ranked queue: one duel, owned cards only, rank points
  invited?: Set<string>; // user ids a friend invited: they skip the password
};
const ROOMS = new Map<string, Room>();
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
function newCode(): string {
  for (;;) { let s = ''; for (let i = 0; i < 6; i++) s += CODE_ABC[crypto.randomInt(CODE_ABC.length)]; if (!ROOMS.has(s)) return s; }
}
const seatOf = (r: Room, u: User) => r.seats.findIndex((s) => s && s.user === u.id);
function roomBrief(r: Room) {
  return {
    code: r.priv ? '' : r.code, name: r.name, host: BY_ID.get(r.host)?.name || '', hostAvatar: BY_ID.get(r.host)?.avatar || '', hostLv: levelFor(BY_ID.get(r.host)), locked: !!r.password, bo3: r.bo3,
    players: r.seats.filter(Boolean).map((s) => BY_ID.get(s!.user)?.name || '?'), status: r.duel && !r.duel.ended ? 'playing' : 'waiting',
    full: r.seats.every(Boolean),
  };
}
function roomDetail(r: Room, me: User) {
  const mine = seatOf(r, me);
  const d = r.duel;
  return {
    code: r.code, name: r.name, host: r.host, hostName: BY_ID.get(r.host)?.name || '', locked: !!r.password, priv: r.priv, bo3: r.bo3,
    seats: r.seats.map((s) => s && { id: s.user, name: BY_ID.get(s.user)?.name || '?', avatar: BY_ID.get(s.user)?.avatar || s.char, lv: levelFor(BY_ID.get(s.user)), showcase: (acctOf(BY_ID.get(s.user))?.showcase || []).slice(0, 3), profile: profileCard(BY_ID.get(s.user)), ready: s.ready, hasDeck: !!s.deck, deckName: s.deckName, char: s.char, warnings: s.user === me.id ? s.warnings : undefined }),
    score: mine === 1 ? [r.score[1], r.score[0]] : r.score, games: r.games,
    chat: r.chat.slice(-50), last: r.last ? { ...r.last, rewards: undefined, myRewards: r.last.rewards?.[mine] || null, youWon: r.last.winnerId === me.id } : null, ranked: !!r.ranked,
    duel: d && !d.ended && mine >= 0 ? { id: d.id, seat: mine, opponent: d.names[1 - mine], oppChar: d.chars[1 - mine], char: d.chars[mine], oppProfile: profileCard(BY_ID.get(d.users[1 - mine])), myProfile: profileCard(BY_ID.get(d.users[mine])) } : null,
  };
}
function leaveRoom(u: User, why = 'left') {
  const r = u.room ? ROOMS.get(u.room) : null;
  u.room = null;
  if (!r) return;
  const i = seatOf(r, u);
  if (i >= 0) {
    if (r.duel && !r.duel.ended) endDuel(r.duel, 1 - i, why === 'left' ? 'left the room' : 'disconnected');
    r.seats[i] = null;
    pushMsg(r.chat, null, `${u.name} ${why === 'left' ? 'left the room' : 'disconnected'} · ออกจากห้อง`, true, 50);
  }
  for (const s of r.seats) if (s) s.ready = false;
  r.score = [0, 0];
  if (!r.seats.some(Boolean)) ROOMS.delete(r.code);
  else if (r.host === u.id) r.host = r.seats.find(Boolean)!.user;
  bump();
}
function maybeStart(r: Room) {
  if (r.duel && !r.duel.ended) return;
  if (!r.seats.every((s) => s && s.ready && s.deck)) return;
  if (r.bo3 && (r.score[0] >= 2 || r.score[1] >= 2)) r.score = [0, 0]; // a new Best of 3
  startDuel(r);
}

// ---------------------------------------------------------------- duels
type Duel = {
  id: string; room: Room; users: [string, string]; names: [string, string]; chars: [string, string];
  worker: Worker; port: any; flag: Int32Array; version: number; states: [any, any]; asks: [any, any];
  log: any[]; logM: any[]; ended: boolean; winner: number | null; reason: string; error?: string;
  cards: [Record<string, any>, Record<string, any>]; emotes: any[]; seen: [number, number]; started: number; timeouts: [number, number];
  waiters: (() => void)[]; deckNames?: [string, string];
  coinsOk?: [boolean, boolean]; colors?: [string, string]; rewards?: [any, any]; // economy: deck all owned cards, main colour, rewards given
};
const DUELS = new Map<string, Duel>();
// seat 1's view: players swapped and every side number flipped, so its screen always sees itself as player 0
const SIDE_KEYS = new Set(['who', 'active', 'first', 'winner', 'owner', 'ctrl', 'actor', 'you', 'side']);
const PAIR_KEYS = new Set(['players', 'res']);
function mirror(v: any, key = ''): any {
  if (Array.isArray(v)) {
    if (PAIR_KEYS.has(key) && v.length === 2) return [mirror(v[1]), mirror(v[0])];
    if ((key === 'dice' || key === 'rolls')) return v.map((r: any) => (Array.isArray(r) && r.length === 2 ? [r[1], r[0]] : r));
    return v.map((x) => mirror(x));
  }
  if (v && typeof v === 'object') {
    const o: any = {};
    for (const k of Object.keys(v)) {
      const x = v[k];
      o[k] = SIDE_KEYS.has(k) && (x === 0 || x === 1) ? 1 - x : mirror(x, k);
    }
    return o;
  }
  if (typeof v === 'string') return v.replace(/\bP([01])(?=\b|'s)/g, (_, d) => `P${1 - Number(d)}`);
  return v;
}
const view = (d: Duel, seat: number, x: any) => (seat === 1 ? mirror(x) : x);
function duelBump(d: Duel) { d.version++; const w = d.waiters; d.waiters = []; w.forEach((f) => f()); }
function startDuel(r: Room) {
  const s0 = r.seats[0]!, s1 = r.seats[1]!;
  const u0 = BY_ID.get(s0.user)!, u1 = BY_ID.get(s1.user)!;
  const shared = new SharedArrayBuffer(8);
  const ch = new MessageChannel();
  const worker = new Worker(new URL('./duel_worker.ts', import.meta.url), {
    workerData: { decks: [s0.deck, s1.deck], seed: crypto.randomInt(1, 0x7fffffff), shared, port: ch.port2, aces: ['', ''], turnSec: TURN_SEC, reactSec: REACT_SEC, timer: TIMER, speed: ONLINE_SPEED, fast: !!process.env.FAST },
    transferList: [ch.port2],
  });
  const cardsFor = (deck: any) => { const m: Record<string, any> = {}; for (const p of [...deckPrints(deck), ...DEFAULT_LIFE]) if (INFO.has(p)) m[p] = INFO.get(p); return m; };
  const d: Duel = {
    id: crypto.randomBytes(6).toString('hex'), room: r, users: [u0.id, u1.id], names: [u0.name, u1.name], chars: [s0.char, s1.char],
    worker, port: ch.port1, flag: new Int32Array(shared, 0, 1), version: 0, states: [null, null], asks: [null, null], log: [], logM: [],
    ended: false, winner: null, reason: '', cards: [cardsFor(s0.deck), cardsFor(s1.deck)], emotes: [], seen: [Date.now(), Date.now()], started: Date.now(),
    timeouts: [0, 0], waiters: [], deckNames: [s0.deckName, s1.deckName],
    coinsOk: [ownedDeck(u0, s0.deck), ownedDeck(u1, s1.deck)], colors: [deckColor(s0.deck), deckColor(s1.deck)], rewards: [null, null],
  };
  DUELS.set(d.id, d);
  r.duel = d;
  r.games++;
  for (const s of r.seats) if (s) s.ready = false;
  pushMsg(r.chat, null, `Duel ${r.games} starts: ${u0.name} vs ${u1.name} · เริ่มดวล`, true, 50);
  worker.on('message', (m: any) => {
    if (d.ended && m.t !== 'end') return;
    if (m.states) { d.states = [m.states[0], mirror(m.states[1])]; }
    if (m.t === 'log' || m.t === 'phase') {
      d.log.push(m.line); d.logM.push(mirror(m.line));
      // a card shown in the log (played, revealed, LIFE) is public now: both screens get its info
      for (const p of [m.line.print, m.line.forPrint, ...((m.line.cards || []).map((c: any) => c && c.print))]) if (p && INFO.has(p)) for (const c of d.cards) c[p] = INFO.get(p);
    }
    if (m.t === 'ask') { d.asks[m.seat] = view(d, m.seat, m.q); d.timeouts[m.seat] = d.timeouts[m.seat]; }
    if (m.t === 'answered') d.asks[m.seat] = null;
    if (m.t === 'timeout') { d.timeouts[m.seat]++; }
    if (m.t === 'end') { finish(d, m.winner === -1 ? null : m.winner, m.winner === -1 ? 'draw (turn limit)' : 'game'); return; }
    duelBump(d);
  });
  worker.on('error', (e) => { console.error(e); d.error = String((e as any)?.stack || e); finish(d, null, 'engine error'); });
  worker.on('exit', () => { if (!d.ended) finish(d, null, 'engine stopped'); });
  bump();
}
function endDuel(d: Duel, winner: number | null, reason: string) {
  if (d.ended) return;
  try { d.port.postMessage({ quit: true }); Atomics.store(d.flag, 0, 1); Atomics.notify(d.flag, 0); } catch {}
  setTimeout(() => d.worker.terminate(), 200);
  finish(d, winner, reason);
}
function finish(d: Duel, winner: number | null, reason: string) {
  if (d.ended) return;
  d.ended = true; d.winner = winner; d.reason = reason; d.asks = [null, null];
  const r = d.room;
  if (winner === 0 || winner === 1) r.score[winner]++;
  const wName = winner === 0 || winner === 1 ? d.names[winner] : '';
  r.last = { winnerId: winner === 0 || winner === 1 ? d.users[winner] : '', winner: wName, reason, at: Date.now(), matchOver: !r.bo3 || r.score.some((x) => x >= 2) };
  pushMsg(r.chat, null, wName ? `${wName} wins duel ${r.games} (${reason}) · ชนะ` : `Duel ${r.games} ended: ${reason}`, true, 50);
  appendJsonl('results.jsonl', { at: Date.now(), room: r.code, players: d.names, ids: d.users, winner, reason, turns: d.states[0]?.turn, secs: Math.round((Date.now() - d.started) / 1000) });
  recordResult(d, winner, reason).catch((e) => console.error(e));
  duelBump(d);
  setTimeout(() => DUELS.delete(d.id), 10 * 60000).unref(); // a late screen can still read the final state for a while
  bump();
}
// ---------------------------------------------------------------- economy (online/economy.ts)
// Off until the Supabase tables have the economy columns (README SQL step 2); local file storage always has it.
const economyOn = () => !STORE.legacy;
// every time an account is used: a new Thai day (missions, caps), a new season (rewards + soft reset), the start gift
function ecoTouch(a: Account) { const p = Eco.prog(a); Eco.rollDay(p); const season = Eco.seasonCheck(a); const gift = Eco.startGift(p); return { season, gift }; }
function ownedDeck(u: User | undefined, deck: any): boolean { const a = acctOf(u); return !!a && economyOn() && Eco.missingCards(Eco.prog(a), CAT, deck).length === 0; }
function deckColor(deck: any): string {
  const n = new Map<string, number>();
  for (const c of deck?.main || []) { const col = INFO.get(c.print)?.color; if (col) n.set(col, (n.get(col) || 0) + Number(c.qty || 0)); }
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}
function homeView(a: Account, extra: any = {}) {
  const p = Eco.prog(a), lv = levelOf(a.xp), t = Eco.tierOf(a.rank_pts);
  const missions = Eco.missionsView(p), login = Eco.loginState(p);
  const starterSlots = 1;
  return {
    id: a.id.replace(/^g:/, '').slice(-6), name: a.name, avatar: a.avatar, showcase: a.showcase.slice(0, 3), ...lv,
    wallet: { coins: p.coins, tickets: p.tickets, dust: p.dust },
    login, missions, rerollLeft: !p.daily.rerolled, firstWinAvailable: !p.daily.firstWin, freePack: !p.daily.freePack,
    bot: { xpLeft: Math.max(0, Eco.BOT.capXp - p.bot.xp), coinsLeft: Math.max(0, Eco.BOT.capCoins - p.bot.coins) },
    rank: { ...t, div: t.step, pts: a.rank_pts, season: a.season, games: p.rank.games, wins: p.rank.wins, best: Eco.tierOf(p.rank.best).name, last: p.rank.last || null },
    stats: { wins: a.wins, losses: a.losses, draws: a.draws },
    cards: { kinds: Object.keys(p.cards).length, total: Object.values(p.cards).reduce((x, y) => x + y, 0) }, packsOpened: p.packs,
    starters: p.starters, starterSlots, icons: p.icons, nameplate: Eco.bannerView(a), inv: (p as any).inv || {}, chars: Eco.charsOf(p), profile: profileCard(undefined, a),
    weekly: { canDraw: (p as any).weekly !== Eco.weekOf() }, friendRequests: Eco.friendsOf(p).in.length,
    badges: { login: login.canClaim, missions: missions.filter((m) => m.got >= m.n && !m.claimed).length, freePack: !p.daily.freePack, shop: !p.daily.freePack, starter: p.starters.length < starterSlots, newCards: 0 },
    // flat fields for the Godot hub (Game modes thread): same values as above
    coins: p.coins, tickets: p.tickets, dust: p.dust, giftPacks: p.tickets, firstTime: p.starters.length === 0,
    rankBadge: a.rank_pts > 0 || p.rank.games > 0 ? { tier: t.tier, div: t.step, pts: a.rank_pts } : null,
    ...extra,
  };
}
// bot games: the game asks for a ticket when the duel starts and turns it in at the end (one use, 60 s minimum)
const BOT_LAST = new Map<string, number>(); // account -> time of the last /me/botgame
const BOT_TICKETS = new Map<string, { acct: string; level: string; at: number; coinsOk: boolean; color: string }>();
setInterval(() => { const now = Date.now(); for (const [k, v] of BOT_TICKETS) if (now - v.at > 3 * 3600e3) BOT_TICKETS.delete(k); }, 600000).unref();

// ---------------------------------------------------------------- ranked queue
// Players wait with a deck of owned cards; every 2 s the two closest by hidden MMR are paired (the allowed gap grows
// with the wait: 100 + 20 per second, anyone after 60 s) into a private one-duel room that starts at once.
const QUEUE = new Map<string, { deck: any; deckName: string; mmr: number; since: number; char: string }>();
setInterval(() => {
  const now = Date.now();
  const xs = [...QUEUE.entries()].filter(([id]) => { const u = BY_ID.get(id); if (!u || now - u.seen > 45000 || u.room) { QUEUE.delete(id); return false; } return true; })
    .sort((a, b) => a[1].since - b[1].since);
  const used = new Set<string>();
  for (const [ida, qa] of xs) {
    if (used.has(ida)) continue;
    const gapA = (now - qa.since) / 1000 >= 60 ? Infinity : 100 + 20 * (now - qa.since) / 1000;
    let best: [string, any] | null = null;
    for (const [idb, qb] of xs) {
      if (idb === ida || used.has(idb)) continue;
      const gap = Math.abs(qa.mmr - qb.mmr), gapB = (now - qb.since) / 1000 >= 60 ? Infinity : 100 + 20 * (now - qb.since) / 1000;
      if (gap <= Math.max(gapA, gapB) && (!best || gap < Math.abs(qa.mmr - best[1].mmr))) best = [idb, qb];
    }
    if (!best) continue;
    used.add(ida); used.add(best[0]);
    QUEUE.delete(ida); QUEUE.delete(best[0]);
    const ua = BY_ID.get(ida)!, ub = BY_ID.get(best[0])!, qb = best[1];
    const r: Room = {
      code: newCode(), name: 'Ranked', host: ua.id, password: '', priv: true, bo3: false, ranked: true,
      seats: [{ user: ua.id, deck: qa.deck, deckName: qa.deckName, ready: true, char: qa.char, warnings: [] }, { user: ub.id, deck: qb.deck, deckName: qb.deckName, ready: true, char: qb.char, warnings: [] }],
      chat: [], score: [0, 0], duel: null, last: null, created: now, games: 0,
    };
    ROOMS.set(r.code, r); ua.room = r.code; ub.room = r.code;
    pushMsg(r.chat, null, `Ranked match: ${ua.name} vs ${ub.name} · แรงก์`, true, 50);
    startDuel(r);
  }
}, 2000).unref();
let LB: { at: number; season: string; top: any[] } = { at: 0, season: '', top: [] };
async function leaderboard() {
  const s = Eco.seasonOf();
  if (Date.now() - LB.at > 30000 || LB.season !== s) {
    const rows = await STORE.leaderboard(s, 100);
    LB = { at: Date.now(), season: s, top: rows.map((r, i) => ({ place: i + 1, name: r.name, avatar: r.avatar, pts: r.rank_pts, tier: Eco.tierOf(r.rank_pts).name, level: levelOf(r.xp).level, key: keyOf(r.id) })) };
  }
  return LB;
}

// Accounts: wins/losses/draws, XP and the match history. A duel that ends before turn 3 (an instant surrender or
// leave) and an engine error count for nothing, so two accounts can't farm levels.
async function recordResult(d: Duel, winner: number | null, reason: string) {
  const turns = Number(d.states[0]?.turn) || 0;
  if (turns < 3 || reason === 'engine error' || reason === 'engine stopped') return;
  const us = d.users.map((id) => BY_ID.get(id));
  const accts = us.map((u) => (u?.acct ? STORE.cached(u.acct) : undefined));
  if (!accts[0] && !accts[1]) return;
  const ranked = !!d.room.ranked && !!accts[0] && !!accts[1];
  const mmr = accts.map((a) => a?.mmr || 1000);
  for (const i of [0, 1]) {
    const a = accts[i];
    if (!a) continue;
    if (winner === null) a.draws++; else if (winner === i) a.wins++; else a.losses++;
    const won = winner === null ? null : winner === i;
    if (economyOn()) {
      ecoTouch(a);
      const r: any = Eco.gameReward(a, { pvp: true, ranked, won, color: d.colors?.[i], coinsOk: ranked || !!d.coinsOk?.[i] });
      if (ranked) r.rank = Eco.rankedResult(a, mmr[1 - i], won);
      d.rewards![i] = r;
    } else a.xp += won === null ? 50 : won ? 100 : 40;
    await STORE.save(a);
  }
  if (d.room.last) { d.room.last.rewards = d.rewards; bump(); duelBump(d); }
  const side = (i: number) => accts[i]?.id || 'guest:' + d.users[i];
  const replay = crypto.randomBytes(8).toString('hex');
  STORE.saveReplay(replay, { v: 1, at: new Date().toISOString(), names: d.names, decks: d.deckNames || ['', ''], chars: d.chars, winner, reason, turns, ranked, log: d.log.slice(-5000) }).catch((e) => console.error(e));
  await STORE.addMatch({
    at: new Date().toISOString(), a: side(0), b: side(1), a_name: d.names[0], b_name: d.names[1], a_avatar: d.chars[0] || us[0]?.avatar || '', b_avatar: d.chars[1] || us[1]?.avatar || '',
    a_deck: d.deckNames?.[0] || '', b_deck: d.deckNames?.[1] || '',
    winner, reason, turns, secs: Math.round((Date.now() - d.started) / 1000), ranked, replay,
  });
}
function duelOf(u: User): { d: Duel; seat: number } | null {
  const r = u.room ? ROOMS.get(u.room) : null;
  const d = r?.duel;
  if (!d) return null;
  const seat = d.users.indexOf(u.id);
  return seat < 0 ? null : { d, seat };
}
function duelView(d: Duel, seat: number, from: number) {
  const log = seat === 1 ? d.logM : d.log;
  const opp = 1 - seat;
  return {
    version: d.version, state: d.states[seat], ask: d.asks[seat], log: log.slice(from), logFrom: from, logLen: log.length,
    ended: d.ended, winner: d.winner === null ? null : seat === 1 ? 1 - d.winner : d.winner, error: d.error, uncoded: [],
    online: {
      seat, names: [d.names[seat], d.names[opp]], reason: d.reason, rewards: d.rewards?.[seat] || null, ranked: !!d.room.ranked, emotes: d.emotes.slice(-10).map((e) => ({ ...e, side: e.seat === seat ? 0 : 1 })),
      oppAway: Date.now() - d.seen[opp] > 15000 ? Math.round((Date.now() - d.seen[opp]) / 1000) : 0, forfeitAfter: AWAY_FORFEIT / 1000,
      waitingFor: d.asks[opp] && !d.asks[seat] ? 'opponent' : '',
    },
  };
}

// ---------------------------------------------------------------- sweeps: leave rooms / forfeit after a disconnect
const AWAY_LOBBY = 45000, AWAY_FORFEIT = 120000;
setInterval(() => {
  const now = Date.now();
  for (const d of DUELS.values()) {
    if (d.ended) continue;
    for (const seat of [0, 1]) if (now - d.seen[seat] > AWAY_FORFEIT) { endDuel(d, 1 - seat, `${d.names[seat]} disconnected`); break; }
  }
  for (const u of USERS.values()) {
    if (!u.room || now - u.seen < AWAY_LOBBY) continue;
    const dd = duelOf(u);
    if (dd && !dd.d.ended) continue; // in a duel: the forfeit timer above decides
    leaveRoom(u, 'disconnected');
  }
}, 5000).unref();

// ---------------------------------------------------------------- Discord login (optional)
const DC_ID = process.env.DISCORD_CLIENT_ID || '', DC_SECRET = process.env.DISCORD_CLIENT_SECRET || '', PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const DC_PENDING = new Map<string, { at: number; token?: string; error?: string; avatar?: string }>(); // Discord and Google logins in progress
setInterval(() => { for (const [k, v] of DC_PENDING) if (Date.now() - v.at > 15 * 60000) DC_PENDING.delete(k); }, 60000).unref();
async function discordCallback(code: string, state: string, ip: string): Promise<string> {
  const p = DC_PENDING.get(state);
  if (!p) return 'This login link has expired. Try again from the game.';
  try {
    const tok: any = await (await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: DC_ID, client_secret: DC_SECRET, grant_type: 'authorization_code', code, redirect_uri: PUBLIC_URL + '/online/discord/callback' }),
    })).json();
    if (!tok.access_token) throw new Error('no token');
    const me: any = await (await fetch('https://discord.com/api/users/@me', { headers: { authorization: `Bearer ${tok.access_token}` } })).json();
    if (!me.id) throw new Error('no user');
    if (MOD.banned['dc:' + me.id]) { p.error = 'banned'; return 'This Discord account is banned from online play.'; }
    let u = [...USERS.values()].find((x) => x.discord === me.id);
    const nm = filterText(cleanLine(me.global_name || me.username, 16)) || 'Player';
    if (!u) u = login(nm, ip, me.id); else { u.name = uniqueName(nm, u); usersDirty = true; }
    p.token = u.token;
    return 'Logged in. You can go back to the game now. · เข้าสู่ระบบแล้ว กลับไปที่เกมได้เลย';
  } catch (e) { p.error = 'failed'; return 'Discord login failed. Try again.'; }
}

// ---------------------------------------------------------------- Google login = a player account (online/accounts.ts)
const G_ID = process.env.GOOGLE_CLIENT_ID || '', G_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE = !!(G_ID && G_SECRET && PUBLIC_URL);
// account sessions are signed, so they survive a server restart (the free server forgets its files when it sleeps)
const SECRET = process.env.SESSION_SECRET || G_SECRET || process.env.SUPABASE_SERVICE_KEY || crypto.randomBytes(32).toString('hex');
const sign = (s: string) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url').slice(0, 32);
function acctToken(acct: string): string {
  const body = Buffer.from(acct).toString('base64url') + '.' + crypto.randomBytes(9).toString('base64url');
  return 'a1.' + body + '.' + sign(body);
}
function acctFromToken(t: string): string | null {
  const m = /^a1\.([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{32})$/.exec(t);
  if (!m || !crypto.timingSafeEqual(Buffer.from(sign(m[1])), Buffer.from(m[2]))) return null;
  return Buffer.from(m[1].split('.')[0], 'base64url').toString();
}
// the session of an account: the one already online (another tab, a reconnect), else a new one
function loginAccount(a: Account, ip: string, token?: string): User {
  let u = (token && USERS.get(token)) || [...USERS.values()].find((x) => x.acct === a.id);
  if (!u) {
    u = { id: crypto.randomBytes(6).toString('hex'), token: token || acctToken(a.id), name: uniqueName(a.name), acct: a.id, ip, seen: Date.now(), room: null, sent: [], strikes: 0, muteMsg: 0 };
    addUser(u);
  }
  u.name = uniqueName(a.name, u); u.avatar = a.avatar || u.avatar; u.ip = ip; u.seen = Date.now(); usersDirty = true;
  return u;
}
async function googleCallback(code: string, state: string, ip: string): Promise<string> {
  const p = DC_PENDING.get(state);
  if (!p) return 'This login link has expired. Try again from the game.';
  try {
    const tok: any = await (await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: G_ID, client_secret: G_SECRET, grant_type: 'authorization_code', code, redirect_uri: PUBLIC_URL + '/online/google/callback' }),
    })).json();
    if (!tok.access_token) throw new Error('no token: ' + JSON.stringify(tok).slice(0, 200));
    const me: any = await (await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${tok.access_token}` } })).json();
    if (!me.sub) throw new Error('no user');
    const id = 'g:' + me.sub;
    let a = await STORE.get(id);
    if (a?.banned) { p.error = 'banned'; return 'This account is banned from online play.'; }
    if (!a) {
      let nm = filterText(cleanLine(me.given_name || me.name, 16));
      if ([...nm].length < 2 || nm.includes('*')) nm = 'Player' + crypto.randomInt(1000, 9999);
      a = await STORE.create(id, nm, p.avatar || '');
    }
    p.token = loginAccount(a, ip).token;
    return 'Logged in. You can close this tab and go back to the game. · เข้าสู่ระบบแล้ว ปิดแท็บนี้แล้วกลับไปที่เกมได้เลย';
  } catch (e) { console.error(e); p.error = 'failed'; return 'Google login failed. Try again.'; }
}
// a player's profile; full (own) adds nothing private today, but keeps the door open for settings
// the character a player plays as online: accounts use owned characters, guests the free one (c51); economy off = any
function charFor(u: User, want: string): string {
  if (!economyOn()) return want;
  const a = acctOf(u);
  return Eco.usableChar(a ? Eco.prog(a) : null, want);
}
// ONE profile object everywhere (home, rooms, community, duels, tournament): name, icon, Lv, rank, title/banner, stats, 3 cards
function profileCard(u: User | undefined, a?: Account) {
  a ??= acctOf(u);
  if (!a) return { id: u?.id || '', key: '', name: u?.name || '?', avatar: u?.avatar || '', level: 0, guest: true, rank: null, title: '', titleName: '', banner: 'plain', frame: 'none', pvp: null, showcase: [] };
  const eco = economyOn(), t = Eco.tierOf(a.rank_pts), bn = eco ? Eco.bannerView(a) : null, games = a.wins + a.losses + a.draws;
  return {
    id: u?.id || '', key: keyOf(a.id), name: a.name, avatar: a.avatar || '', level: levelOf(a.xp).level, guest: false,
    rank: eco ? { tier: t.tier, div: t.step, name: t.name, pts: a.rank_pts } : null,
    title: bn?.title || '', titleName: bn?.titleName || '', banner: bn?.banner || 'plain', frame: bn?.frame || 'none',
    pvp: { games, wins: a.wins, losses: a.losses, draws: a.draws, winRate: games ? Math.round((a.wins / games) * 100) : 0 },
    showcase: a.showcase.slice(0, 3),
  };
}
// public key of an account (friends, leaderboard, profile links): never the Google id itself
const KEY_TO_ID = new Map<string, string>();
function keyOf(id: string) { const k = crypto.createHash('sha256').update('tlc|' + id).digest('hex').slice(0, 12); KEY_TO_ID.set(k, id); return k; }
const userOfAcct = (id: string) => online().find((x) => x.acct === id);
function statusOf(u: User | undefined): string {
  if (!u) return 'offline';
  if (QUEUE.has(u.id)) return 'queue';
  const r = u.room ? ROOMS.get(u.room) : null;
  return r?.duel && !r.duel.ended ? 'duel' : r ? 'room' : 'idle';
}
async function profileOf(u: User) {
  const a = acctOf(u);
  if (!a) return { id: u.id, name: u.name, avatar: u.avatar || '', guest: true, online: true, status: statusOf(u) };
  return profileAcct(a, u);
}
async function profileAcct(a: Account, u?: User) {
  const games = a.wins + a.losses + a.draws;
  const hist = (await STORE.history(a.id, 20)).map((m) => {
    const me = m.a === a.id ? 0 : 1;
    return {
      at: m.at, opp: me ? m.a_name : m.b_name, oppAvatar: me ? m.a_avatar : m.b_avatar, deck: me ? m.b_deck : m.a_deck, oppDeck: me ? m.a_deck : m.b_deck,
      result: m.winner === null || m.winner === undefined ? 'draw' : m.winner === me ? 'win' : 'loss', reason: m.reason, turns: m.turns, secs: m.secs,
      ranked: !!m.ranked, replay: m.replay || '',
    };
  });
  const eco = economyOn(), pr = eco ? Eco.prog(a) : null;
  const rank = eco ? { ...Eco.tierOf(a.rank_pts), div: Eco.tierOf(a.rank_pts).step, pts: a.rank_pts, games: pr!.rank.games, wins: pr!.rank.wins } : null;
  const bn = eco ? Eco.bannerView(a) : null;
  return {
    id: u?.id || '', key: keyOf(a.id), name: a.name, avatar: a.avatar || '', guest: false, online: !!u, status: statusOf(u), ...levelOf(a.xp), rank,
    title: bn?.title || '', titleName: bn?.titleName || '', banner: bn?.banner || 'plain', frame: bn?.frame || 'none',
    wins: a.wins, losses: a.losses, draws: a.draws, games, winRate: games ? Math.round((a.wins / games) * 100) : 0,
    pvp: { games, wins: a.wins, losses: a.losses, draws: a.draws, winRate: games ? Math.round((a.wins / games) * 100) : 0 },
    collection: pr ? { kinds: Object.keys(pr.cards).length, total: Object.values(pr.cards).reduce((x: number, y: any) => x + Number(y), 0), sets: setProgress(pr) } : null, packsOpened: pr?.packs || 0,
    showcase: a.showcase.slice(0, 3), card: profileCard(u, a), chars: pr ? Eco.charsOf(pr) : [Eco.FREE_CHAR], since: a.created, history: hist,
  };
}
// collection progress per pack set: distinct codes owned / codes in the set
function setProgress(pr: any) {
  const out: Record<string, { have: number; total: number }> = {};
  for (const [set, rows] of CAT.sets) { const codes = new Set(rows.map((r) => r.code)); let have = 0; for (const c of codes) if (pr.cards[c]) have++; out[set] = { have, total: codes.size }; }
  return out;
}
// online players for the COMMUNITY panel (accounts show level, title and banner)
function communityList(me: User) {
  return online().filter((x) => x !== me).slice(0, 200).map((x) => {
    const a = acctOf(x), bn = a && economyOn() ? Eco.bannerView(a) : null;
    return { id: x.id, key: a ? keyOf(a.id) : '', name: x.name, avatar: x.avatar || '', level: a ? levelOf(a.xp).level : 0, status: statusOf(x), guest: !a, title: bn?.titleName || '', banner: bn?.banner || '', profile: profileCard(x) };
  });
}
async function friendRow(id: string) {
  const a = (await STORE.get(id).catch(() => null)); const u = userOfAcct(id);
  return a ? { key: keyOf(id), id: u?.id || '', name: a.name, avatar: a.avatar || '', level: levelOf(a.xp).level, online: !!u, status: statusOf(u) } : null;
}
const INVITES = new Map<string, { from: string; key: string; avatar: string; code: string; room: string; at: number }[]>(); // user id -> invites
// NEWS (user 2026-11-03: "news should repost every bug fix"): online/news.json {updates:[{date, title, lines}], events}
// read from GitHub (NEWS_URL, the online-server branch) every 5 minutes, so a pushed entry shows without a redeploy;
// the copy in this folder is the fallback. Old online/news.txt lines still work.
const NEWS_URL = process.env.NEWS_URL ?? 'https://raw.githubusercontent.com/dekster00/talingchan-web/online-server/online/news.json';
let NEWS_JSON: any = null, NEWS_AT = 0;
function loadNewsLocal() { try { return JSON.parse(fs.readFileSync(path.join(HERE, 'news.json'), 'utf8')); } catch { return null; } }
async function refreshNews() {
  NEWS_AT = Date.now();
  if (!NEWS_URL || process.env.FAST) { NEWS_JSON = loadNewsLocal(); return; }
  try { const r = await fetch(NEWS_URL + '?t=' + Date.now(), { signal: AbortSignal.timeout(8000) }); if (r.ok) { NEWS_JSON = await r.json(); return; } } catch {}
  NEWS_JSON ??= loadNewsLocal();
}
NEWS_JSON = loadNewsLocal();
setInterval(() => { refreshNews().catch(() => {}); }, 300000).unref();
refreshNews().catch(() => {});
function newsFeed() {
  let lines: string[] = [];
  try { lines = fs.readFileSync(path.join(HERE, 'news.txt'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')); } catch {}
  const news: any[] = [], events: any[] = [];
  for (const l of lines) {
    const m = /^(event:)?\s*(\d{4}-\d{2}-\d{2})?\s*(?:to\s*(\d{4}-\d{2}-\d{2}))?\s*\|?\s*(.+)$/i.exec(l);
    if (!m) continue;
    if (m[1]) { if (!m[3] || m[3] >= Eco.today()) events.push({ from: m[2] || '', to: m[3] || '', text: m[4] }); }
    else news.push({ at: m[2] || '', text: m[4] });
  }
  const j = NEWS_JSON || {};
  const updates = (Array.isArray(j.updates) ? j.updates : []).slice(0, 50).map((u: any) => ({ date: String(u.date || ''), title: String(u.title || ''), lines: Array.isArray(u.lines) ? u.lines.map(String) : [] }));
  for (const e of Array.isArray(j.events) ? j.events : []) if (!e.to || String(e.to) >= Eco.today()) events.push({ from: String(e.from || ''), to: String(e.to || ''), text: String(e.text || '') });
  const items = [
    ...updates.slice(0, 5).map((u: any) => ({ text: u.title, kind: 'update', at: u.date })),
    ...events.map((e) => ({ text: e.text, kind: 'event' })),
    ...news.slice(0, 30).map((n) => ({ text: n.text, kind: 'news', at: n.at })),
  ];
  return { latest: updates[0] || null, updates, items, news: news.slice(0, 30), events, weekly: { odds: Eco.WEEKLY.map((x) => ({ chance: x.w + '%', reward: x.g })) } };
}
const PRIVACY = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Battle of Talingchan: privacy</title>
<body style="font:17px/1.5 sans-serif;background:#111;color:#eee;max-width:720px;margin:40px auto;padding:0 16px">
<h1>Battle of Talingchan online: privacy</h1>
<p>When you log in with Google we receive your Google account id and your first name. We do not receive your email, contacts or anything else.</p>
<p>We keep: your display name, profile picture choice, the 3 cards you show on your profile, your level, wins and losses, your match history (opponent name, decks, result, date) and the decks you save. They are used only to run the game.</p>
<p>Chat messages are kept for moderation. We never sell or share your data.</p>
<p>To delete your account and data, ask the game's admin in the world chat or on the game's page, and it will be removed.</p></body>`;

// ---------------------------------------------------------------- http
function send(res: http.ServerResponse, code: number, body: any, type = 'application/json; charset=utf-8') {
  res.writeHead(code, {
    'content-type': type, 'cache-control': 'no-store', 'access-control-allow-origin': ORIGIN,
    'access-control-allow-headers': 'content-type, x-session', 'access-control-allow-methods': 'GET, POST, OPTIONS',
    'cross-origin-resource-policy': 'cross-origin', // the web build is cross-origin isolated (COOP/COEP)
  });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req: http.IncomingMessage, max = 200000): Promise<any> {
  return new Promise((ok) => {
    let s = '', big = false;
    req.on('data', (d) => { if (s.length > max) { big = true; return; } s += d; });
    req.on('end', () => { if (big) return ok({}); try { ok(JSON.parse(s || '{}')); } catch { ok({}); } });
  });
}
const ipOf = (req: http.IncomingMessage) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
// simple per-IP limit for logins / room creation: n calls per minute
const HITS = new Map<string, number[]>();
function limited(key: string, n: number, ms = 60000): boolean {
  const now = Date.now(), xs = (HITS.get(key) || []).filter((t) => now - t < ms);
  xs.push(now); HITS.set(key, xs);
  return xs.length > n;
}
setInterval(() => { const now = Date.now(); for (const [k, xs] of HITS) if (!xs.some((t) => now - t < 600000)) HITS.delete(k); }, 60000).unref();

// chat rules: 200 characters, 1 message per 1.2 s and 5 per 10 s; links are removed; bad words become ***;
// 3 rate-limit strikes = muted 2 minutes; 3 reports from different players in 10 minutes = muted 30 minutes.
function chat(u: User, text: string, list: Msg[], cap: number): { ok?: boolean; error?: string } {
  const now = Date.now();
  if (mutedUntil(u) > now) return { error: `You are muted for ${Math.ceil((mutedUntil(u) - now) / 60000)} more minute(s). · ถูกปิดแชทชั่วคราว` };
  let t = cleanLine(text, 200);
  if (!t) return { error: 'Empty message.' };
  u.sent = u.sent.filter((x) => now - x < 10000);
  if (u.sent.length >= 5 || (u.sent.length && now - u.sent[u.sent.length - 1] < 1200)) {
    if (++u.strikes >= 3) { MOD.muted[u.id] = now + 120000; u.strikes = 0; saveMod(); return { error: 'Too many messages: muted for 2 minutes. · ส่งถี่เกินไป' }; }
    return { error: 'Slow down. · ส่งช้าลงหน่อย' };
  }
  const last = list.filter((m) => m.from && m.from.id === u.id).slice(-1)[0];
  if (last && last.text === filterText(t.replace(LINK, '[link]')) && now - last.at < 30000) return { error: 'You just sent that. · ข้อความซ้ำ' };
  u.sent.push(now);
  t = filterText(t.replace(LINK, '[link]'));
  pushMsg(list, u, t, false, cap);
  return { ok: true };
}
const REPORTS: { at: number; by: string; target: string; msg: number }[] = [];
function report(u: User, msgId: number, reason: string) {
  const all = [...WORLD, ...[...ROOMS.values()].flatMap((r) => r.chat)];
  const m = all.find((x) => x.id === msgId);
  if (!m || !m.from) return { error: 'That message is gone.' };
  if (m.from.id === u.id) return { error: "You can't report yourself." };
  const now = Date.now();
  if (REPORTS.some((r) => r.by === u.id && r.msg === msgId)) return { ok: true };
  REPORTS.push({ at: now, by: u.id, target: m.from.id, msg: msgId });
  appendJsonl('reports.jsonl', { at: now, by: pub(u), target: m.from, msg: m.text, msgId, reason: cleanLine(reason, 200) });
  const by = new Set(REPORTS.filter((r) => r.target === m.from!.id && now - r.at < 600000).map((r) => r.by));
  if (by.size >= 3 && mutedUntil(BY_ID.get(m.from.id)!) < now) { MOD.muted[m.from.id] = now + 30 * 60000; saveMod(); }
  return { ok: true };
}

function lobbyView(u: User, chatFrom: number) {
  const r = u.room ? ROOMS.get(u.room) : null;
  return {
    v: LV, version: VERSION, me: { id: u.id, name: u.name, avatar: u.avatar || '', muted: Math.max(0, mutedUntil(u) - Date.now()), discord: !!u.discord, acct: !!u.acct, lv: levelFor(u) },
    online: online().length, rooms: [...ROOMS.values()].filter((x) => !x.priv || x === r).map(roomBrief).slice(0, 200),
    chat: WORLD.filter((m) => m.id > chatFrom).slice(-100), room: r ? roomDetail(r, u) : null,
    turnSec: TIMER ? TURN_SEC : 0, reactSec: TIMER ? REACT_SEC : 0, timer: TIMER, discordLogin: !!(DC_ID && DC_SECRET && PUBLIC_URL), googleLogin: GOOGLE,
    queue: QUEUE.has(u.id) ? { waited: Math.round((Date.now() - QUEUE.get(u.id)!.since) / 1000), size: QUEUE.size } : null,
    invites: (INVITES.get(u.id) || []).filter((x) => Date.now() - x.at < 600000 && ROOMS.has(x.code)),
  };
}

http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  let p = url.pathname;
  if (req.method === 'OPTIONS') return send(res, 204, '');
  if (!p.startsWith('/online')) return send(res, 404, { error: 'Not found' });
  p = p.slice('/online'.length) || '/';
  const ip = ipOf(req);
  try {
    if (p === '/ping' || p === '/') return send(res, 200, { ok: true, game: 'Battle of Talingchan', version: VERSION, online: online().length, rooms: ROOMS.size, googleLogin: GOOGLE, discordLogin: !!(DC_ID && DC_SECRET && PUBLIC_URL), accounts: usingSupabase ? 'cloud' : 'local', economy: economyOn() });
    if (p === '/shop/packs') return send(res, 200, { packs: Eco.packInfo(CAT), price: Eco.PRICE });
    if (p === '/ranked/leaderboard') { const lb = await leaderboard(); return send(res, 200, { season: lb.season, top: lb.top, tiers: Eco.TIERS }); }
    if (p === '/privacy') return send(res, 200, PRIVACY, 'text/html; charset=utf-8');
    if (p === '/news') return send(res, 200, newsFeed());
    if (p === '/replay') { const r = await STORE.replay(String(url.searchParams.get('id') || '')); return r ? send(res, 200, r) : send(res, 404, { error: 'No such replay. · ไม่พบรีเพลย์' }); }
    if (p === '/bugreport' && req.method === 'POST') {
      if (limited('bug:' + ip, 5, 600000)) return send(res, 429, { error: 'Thanks! Please wait a few minutes before the next report.' });
      const b = await readBody(req, 3000000);
      const text = String(b.text || '').slice(0, 4000).trim();
      if (!text) return send(res, 400, { error: 'Write what happened. · กรุณาเล่าว่าเกิดอะไรขึ้น' });
      let shot = String(b.screenshot || b.shot || '').replace(/^data:image\/\w+;base64,/, '');
      if (shot.length > 2800000 || !/^[A-Za-z0-9+/=]*$/.test(shot)) shot = '';
      const who = USERS.get(String(req.headers['x-session'] || ''));
      await STORE.addReport({ at: new Date().toISOString(), acct: who?.acct ? keyOf(who.acct) : '', name: who?.name || cleanLine(b.name, 16) || '', text, log: String(b.log || '').slice(-60000), shot, version: (cleanLine(b.version, 40) + (b.platform ? ' ' + cleanLine(b.platform, 20) : '')).trim() });
      return send(res, 200, { ok: true });
    }
    if (p === '/reports' && ADMIN_KEY && url.searchParams.get('key') === ADMIN_KEY) return send(res, 200, { reports: await STORE.reports(100) });
    if (p === '/test/account' && req.method === 'POST' && process.env.TEST_ACCOUNTS === '1') { // tests only: an account without Google
      const b = await readBody(req);
      const id = 'test:' + cleanLine(b.name, 16);
      const a = (await STORE.get(id)) || (await STORE.create(id, cleanLine(b.name, 16), cleanAvatar(b.avatar)));
      const u = loginAccount(a, ip);
      return send(res, 200, { ok: true, token: u.token, id: u.id, name: u.name, avatar: u.avatar || '', acct: true });
    }
    if (p === '/google/start') {
      if (!GOOGLE) return send(res, 400, 'Google login is not set up on this server.', 'text/plain; charset=utf-8');
      const state = String(url.searchParams.get('state') || '').slice(0, 64);
      if (!/^[a-f0-9]{16,64}$/.test(state)) return send(res, 400, 'bad state', 'text/plain');
      if (limited('gstart:' + ip, 20)) return send(res, 429, 'Too many tries, wait a minute.', 'text/plain');
      DC_PENDING.set(state, { at: Date.now(), avatar: cleanAvatar(url.searchParams.get('avatar')) });
      const q = new URLSearchParams({ client_id: G_ID, response_type: 'code', scope: 'openid profile', redirect_uri: PUBLIC_URL + '/online/google/callback', state, prompt: 'select_account' });
      res.writeHead(302, { location: 'https://accounts.google.com/o/oauth2/v2/auth?' + q }); return res.end();
    }
    if (p === '/google/callback') {
      const msg = await googleCallback(String(url.searchParams.get('code') || ''), String(url.searchParams.get('state') || ''), ip);
      return send(res, 200, `<!doctype html><meta charset="utf-8"><title>Battle of Talingchan</title><body style="font:20px sans-serif;background:#111;color:#eee;text-align:center;padding:60px">${msg}<script>setTimeout(()=>{try{window.close()}catch(e){}},1500)</script></body>`, 'text/html; charset=utf-8');
    }
    if (p === '/decks') return send(res, 200, metaDecks());
    if (p === '/allcards') return send(res, 200, [...INFO.values()]);
    if (p === '/discord/start') {
      if (!DC_ID || !DC_SECRET || !PUBLIC_URL) return send(res, 400, 'Discord login is not set up on this server.', 'text/plain; charset=utf-8');
      const state = String(url.searchParams.get('state') || '').slice(0, 64);
      if (!/^[a-f0-9]{16,64}$/.test(state)) return send(res, 400, 'bad state', 'text/plain');
      DC_PENDING.set(state, { at: Date.now() });
      const q = new URLSearchParams({ client_id: DC_ID, response_type: 'code', scope: 'identify', redirect_uri: PUBLIC_URL + '/online/discord/callback', state });
      res.writeHead(302, { location: 'https://discord.com/oauth2/authorize?' + q }); return res.end();
    }
    if (p === '/discord/callback') {
      const msg = await discordCallback(String(url.searchParams.get('code') || ''), String(url.searchParams.get('state') || ''), ip);
      return send(res, 200, `<!doctype html><meta charset="utf-8"><title>Battle of Talingchan</title><body style="font:20px sans-serif;background:#111;color:#eee;text-align:center;padding:60px">${msg}</body>`, 'text/html; charset=utf-8');
    }
    if (p === '/discord/poll' || p === '/oauth/poll') {
      const st = DC_PENDING.get(String(url.searchParams.get('state') || ''));
      if (!st) return send(res, 404, { error: 'expired' });
      if (st.token) { DC_PENDING.delete(String(url.searchParams.get('state'))); const u = USERS.get(st.token)!; return send(res, 200, { ok: true, token: u.token, id: u.id, name: u.name, avatar: u.avatar || '', acct: !!u.acct }); }
      return send(res, 200, { ok: false, error: st.error || '' });
    }
    if (p === '/login' && req.method === 'POST') {
      const b = await readBody(req);
      let old = b.token ? USERS.get(String(b.token)) : undefined;
      if (!old && b.token) { // an account session from before a server restart
        const acc = acctFromToken(String(b.token));
        const a = acc ? await STORE.get(acc) : null;
        if (a?.banned) return send(res, 403, { error: 'This account is banned from online play.' });
        if (a) old = loginAccount(a, ip, String(b.token));
      } else if (old?.acct) { // a saved session (users.json): reload its account (name, level) into the cache
        const a = await STORE.get(old.acct);
        if (a?.banned) return send(res, 403, { error: 'This account is banned from online play.' });
        if (a) loginAccount(a, ip, old.token);
      }
      if (old) {
        if (MOD.banned[old.id]) return send(res, 403, { error: 'This account is banned from online play.' });
        old.seen = Date.now(); old.ip = ip;
        if (cleanAvatar(b.avatar) && !old.acct) { old.avatar = cleanAvatar(b.avatar); usersDirty = true; }
        if (b.name && !old.discord && !old.acct) { const nm = filterText(cleanLine(b.name, 16)); if (nm.length >= 2 && !nm.includes('*')) old.name = uniqueName(nm, old); usersDirty = true; }
        return send(res, 200, { ok: true, token: old.token, id: old.id, name: old.name, avatar: old.avatar || '', acct: !!old.acct, aid: old.acct ? sign('aid:' + old.acct).slice(0, 12) : '', lv: levelFor(old) });
      }
      if (limited('login:' + ip, 10)) return send(res, 429, { error: 'Too many logins, wait a minute.' });
      const nm = cleanLine(b.name, 16);
      if ([...nm].length < 2) return send(res, 400, { error: 'Pick a name of 2 to 16 characters. · ตั้งชื่อ 2-16 ตัวอักษร' });
      if (filterText(nm) !== nm) return send(res, 400, { error: 'Pick another name. · กรุณาเปลี่ยนชื่อ' });
      const u = login(nm, ip);
      u.avatar = cleanAvatar(b.avatar);
      bump();
      return send(res, 200, { ok: true, token: u.token, id: u.id, name: u.name });
    }
    if (p === '/admin' && req.method === 'POST') {
      const b = await readBody(req);
      if (!ADMIN_KEY || b.key !== ADMIN_KEY) return send(res, 403, { error: 'no' });
      const t = BY_ID.get(String(b.id || '')) || [...USERS.values()].find((u) => u.name === b.name);
      if (b.op === 'reports') return send(res, 200, { reports: fs.existsSync(path.join(DATA, 'reports.jsonl')) ? fs.readFileSync(path.join(DATA, 'reports.jsonl'), 'utf8').trim().split('\n').slice(-200).map((l) => JSON.parse(l)) : [] });
      if (b.op === 'reloadwords') { WORDS = loadWords(); return send(res, 200, { ok: true, words: WORDS.bad.length }); }
      if (b.op === 'announce') { pushMsg(WORLD, null, cleanLine(b.text, 300), true); return send(res, 200, { ok: true }); }
      if (!t) return send(res, 404, { error: 'no such player' });
      if (b.op === 'mute') MOD.muted[t.id] = Date.now() + (Number(b.minutes) || 60) * 60000;
      else if (b.op === 'unmute') delete MOD.muted[t.id];
      else if (b.op === 'ban') { MOD.banned[t.id] = cleanLine(b.reason || 'ban', 100); if (t.discord) MOD.banned['dc:' + t.discord] = MOD.banned[t.id]; const a = acctOf(t); if (a) { a.banned = MOD.banned[t.id]; await STORE.save(a); } leaveRoom(t); USERS.delete(t.token); }
      else if (b.op === 'unban') { delete MOD.banned[t.id]; const a = acctOf(t); if (a) { a.banned = undefined; await STORE.save(a); } }
      else if (b.op === 'clear') { for (const l of [WORLD, ...[...ROOMS.values()].map((r) => r.chat)]) for (let i = l.length - 1; i >= 0; i--) if (l[i].from?.id === t.id) l.splice(i, 1); bump(); }
      else return send(res, 400, { error: 'op: mute | unmute | ban | unban | clear | reports | reloadwords | announce' });
      saveMod();
      return send(res, 200, { ok: true });
    }

    // ---- everything below needs a session
    const u = USERS.get(String(req.headers['x-session'] || url.searchParams.get('s') || ''));
    if (!u) return send(res, 401, { error: 'Please log in again. · กรุณาเข้าสู่ระบบใหม่' });
    if (MOD.banned[u.id]) return send(res, 403, { error: 'This account is banned from online play.' });
    u.seen = Date.now();
    const dd = duelOf(u);
    if (dd) dd.d.seen[dd.seat] = Date.now();

    if (p === '/poll') {
      const since = Number(url.searchParams.get('v') ?? -1), chatFrom = Number(url.searchParams.get('chat') || 0);
      if (since >= LV) await new Promise<void>((ok) => { const t = setTimeout(ok, 20000); waiters.push(() => { clearTimeout(t); ok(); }); });
      u.seen = Date.now();
      return send(res, 200, lobbyView(u, chatFrom));
    }
    if (p === '/logout' && req.method === 'POST') { leaveRoom(u); return send(res, 200, { ok: true }); }
    // ---- game economy (online/economy.ts): accounts only; every change is saved before answering
    if (p.startsWith('/me/') && !['/me/profile', '/me/decks'].includes(p) || p === '/ranked/queue' || p === '/ranked/leave') {
      const a = acctOf(u);
      if (!a) return send(res, 403, { error: 'Log in with Google to collect rewards, cards and rank. · เข้าสู่ระบบด้วย Google ก่อน', guest: true });
      if (!economyOn()) return send(res, 503, { error: 'The server needs a database update first (README SQL step 2).' });
      const { season, gift } = ecoTouch(a);
      const pr = Eco.prog(a);
      const b = req.method === 'POST' ? await readBody(req) : {};
      const done = async (out: any, code = 200) => { if (!out.error) await STORE.save(a); return send(res, out.error ? 400 : code, out); };
      if (p === '/me/home') { await STORE.save(a); return send(res, 200, homeView(a, { seasonReward: season, gift })); }
      if (p === '/me/login-reward' && req.method === 'POST') return done({ ...Eco.claimLogin(pr), wallet: { coins: pr.coins, tickets: pr.tickets, dust: pr.dust } });
      if (p === '/me/missions/claim' && req.method === 'POST') return done({ ...Eco.claimMission(pr, Number(b.i)), wallet: { coins: pr.coins, tickets: pr.tickets, dust: pr.dust } });
      if (p === '/me/missions/reroll' && req.method === 'POST') return done({ ...Eco.rerollMission(pr, Number(b.i)), missions: Eco.missionsView(pr) });
      if (p === '/me/bot/start' && req.method === 'POST') {
        const level = ['easy', 'normal', 'hard'].includes(String(b.level)) ? String(b.level) : 'normal';
        if (pr.bot.games >= Eco.BOT.maxGames) return send(res, 200, { ticket: '', note: 'Daily bot rewards are used up. · รางวัลบอทวันนี้หมดแล้ว' });
        const c = b.deck ? cleanDeck(b.deck) : { deck: null };
        const t = crypto.randomBytes(12).toString('hex');
        BOT_TICKETS.set(t, { acct: a.id, level, at: Date.now(), coinsOk: !!c.deck && Eco.missingCards(pr, CAT, c.deck).length === 0, color: c.deck ? deckColor(c.deck) : '' });
        return send(res, 200, { ticket: t, coinsOk: BOT_TICKETS.get(t)!.coinsOk, xpLeft: Math.max(0, Eco.BOT.capXp - pr.bot.xp), coinsLeft: Math.max(0, Eco.BOT.capCoins - pr.bot.coins) });
      }
      if (p === '/me/bot/finish' && req.method === 'POST') {
        const t = BOT_TICKETS.get(String(b.ticket || ''));
        if (!t || t.acct !== a.id) return send(res, 400, { error: 'This game was not started for rewards.' });
        BOT_TICKETS.delete(String(b.ticket));
        if (Date.now() - t.at < Eco.BOT.minSecs * 1000 || Number(b.turns) < 3) return send(res, 200, { xp: 0, coins: 0, note: 'Too short for rewards. · เกมสั้นเกินไป' });
        return done(Eco.gameReward(a, { pvp: false, won: !!b.won, bot: t.level, color: t.color, coinsOk: t.coinsOk }));
      }
      if ((p === '/me/packs/open' || p === '/me/packs/open_owned') && req.method === 'POST') return done({ ...Eco.openPacks(pr, CAT, String(b.set || ''), Number(b.count) || 1, p === '/me/packs/open_owned' || b.pay === 'inv' || b.pay === 'inventory' ? 'inv' : b.pay === 'ticket' ? 'ticket' : b.pay === 'free' ? 'free' : 'coins'), inventory: (pr as any).inv || {}, inv: (pr as any).inv || {}, wallet: { coins: pr.coins, tickets: pr.tickets, dust: pr.dust } });
      if (p === '/me/packs' ) return send(res, 200, { packs: Eco.packInfo(CAT, pr), wallet: { coins: pr.coins, tickets: pr.tickets, dust: pr.dust }, freePack: !pr.daily.freePack });
      if (p === '/me/cards' || p === '/me/collection') return send(res, 200, { ok: true, cards: pr.cards, dust: pr.dust, inv: (pr as any).inv || {}, starters: pr.starters });
      // first-time flow (Game modes hub): name + picture + first starter deck in one call -> same as /me/home
      if (p === '/me/setup' && req.method === 'POST') {
        if (b.name !== undefined) {
          const nm = cleanLine(b.name, 16);
          if ([...nm].length < 2) return send(res, 400, { error: 'Pick a name of 2 to 16 characters. · ตั้งชื่อ 2-16 ตัวอักษร' });
          if (filterText(nm) !== nm) return send(res, 400, { error: 'Pick another name. · กรุณาเปลี่ยนชื่อ' });
          a.name = nm; u.name = uniqueName(nm, u);
        }
        if (b.avatar !== undefined && cleanAvatar(b.avatar)) { a.avatar = cleanAvatar(b.avatar); u.avatar = a.avatar; }
        if (b.starter && !pr.starters.includes(String(b.starter))) { const r = Eco.claimStarter(a, CAT, RAW, String(b.starter)); if (r.error) return send(res, 400, r); }
        await STORE.save(a); usersDirty = true; bump();
        return send(res, 200, homeView(a, { gift }));
      }
      // one-call bot result (no ticket): EXP + coins (owned deck only) within the daily caps; one per BOT_MIN_SECS
      if (p === '/me/botgame' && req.method === 'POST') {
        const level = ['easy', 'normal', 'hard'].includes(String(b.level)) ? String(b.level) : 'normal';
        const last = BOT_LAST.get(a.id) || 0, lvBefore = levelOf(a.xp).level;
        if (Date.now() - last < Eco.BOT.minSecs * 1000 || Number(b.turns) < 3 || pr.bot.games >= Eco.BOT.maxGames) return send(res, 200, { xpGain: 0, coins: 0, ...levelOf(a.xp), leveledUp: false, note: 'No rewards for this game. · ไม่ได้รางวัลเกมนี้' });
        BOT_LAST.set(a.id, Date.now());
        const c = b.deck ? cleanDeck(b.deck) : { deck: null as any };
        // a Bo3 match sends its games together: {games:[true,false,true]} (up to 3), each paid like one game
        const games: boolean[] = Array.isArray(b.games) && b.games.length ? b.games.slice(0, 3).map((g: any) => !!g) : [!!(b.win ?? b.won)];
        const color = c.deck ? deckColor(c.deck) : '', coinsOk = !!c.deck && Eco.missingCards(pr, CAT, c.deck).length === 0;
        let r: any = null; const sum = { xp: 0, coins: 0, firstWin: false, levelUps: [] as any[], missionsDone: [] as any[] };
        for (const won of games) {
          if (pr.bot.games >= Eco.BOT.maxGames) break;
          r = Eco.gameReward(a, { pvp: false, won, bot: level, color, coinsOk });
          sum.xp += r.xp; sum.coins += r.coins; sum.firstWin ||= r.firstWin; sum.levelUps.push(...(r.levelUps || [])); sum.missionsDone.push(...(r.missionsDone || []));
        }
        await STORE.save(a);
        return send(res, 200, { ...r, ...sum, xpGain: sum.xp, games: games.length, ...levelOf(a.xp), leveledUp: levelOf(a.xp).level > lvBefore });
      }
      if (p === '/me/craft' && req.method === 'POST') return done({ ...Eco.craft(pr, CAT, String(b.code || '')), dust: pr.dust });
      if (p === '/me/starter' && req.method === 'POST') return done(Eco.claimStarter(a, CAT, RAW, String(b.set || '')));
      if (p === '/me/deck/check' && req.method === 'POST') {
        const c = cleanDeck(b.deck);
        if (c.error) return send(res, 200, { legal: false, error: c.error, missing: b.deck && typeof b.deck === 'object' ? Eco.missingCards(pr, CAT, b.deck) : [] });
        const miss = Eco.missingCards(pr, CAT, c.deck);
        return send(res, 200, { legal: miss.length === 0, missing: miss });
      }
      if (p === '/ranked/queue' && req.method === 'POST') {
        const c = cleanDeck(b.deck);
        if (c.error) return send(res, 400, { error: c.error });
        const miss = Eco.missingCards(pr, CAT, c.deck);
        if (miss.length) return send(res, 400, { error: `Ranked needs cards you own. Missing: ${miss.slice(0, 5).map((m) => `${m.name} ${m.have}/${m.need}`).join(', ')}${miss.length > 5 ? '…' : ''} · แรงก์ใช้ได้เฉพาะการ์ดที่มี`, missing: miss });
        if (u.room) leaveRoom(u);
        QUEUE.set(u.id, { deck: c.deck, deckName: c.deck.name, mmr: a.mmr, since: Date.now(), char: charFor(u, cleanAvatar(b.char) || u.avatar || '') });
        bump();
        return send(res, 200, { ok: true, queued: QUEUE.size });
      }
      if (p === '/ranked/leave' && req.method === 'POST') { QUEUE.delete(u.id); bump(); return send(res, 200, { ok: true }); }
      if (p === '/me/ranked') {
        const lb = await leaderboard();
        const place = lb.top.find((x) => x.key === keyOf(a.id))?.place || null;
        return send(res, 200, { ...Eco.tierOf(a.rank_pts), pts: a.rank_pts, season: a.season, games: pr.rank.games, wins: pr.rank.wins, place });
      }
      // ---- shop: packs to the inventory (BT01-BT12, KD01-KD04, PROMO), starter decks SD01-SD09 (once each)
      const wallet = () => ({ coins: pr.coins, tickets: pr.tickets, dust: pr.dust });
      if (p === '/me/shop') return send(res, 200, {
        packs: Eco.packInfo(CAT, pr), price: Eco.PRICE, inv: (pr as any).inv || {}, inventory: (pr as any).inv || {}, freePack: !pr.daily.freePack,
        starters: Eco.SHOP.starterSets.map((set) => ({ set, price: Eco.SHOP.starterPrice, owned: pr.starters.includes(set) })), characters: Eco.charShop(pr), wallet: wallet(),
      });
      if (p === '/me/shop/packs' && req.method === 'POST') return done({ ...Eco.buyPacks(pr, CAT, String(b.set || ''), Number(b.count) || 1, b.pay === 'ticket' ? 'ticket' : 'coins'), wallet: wallet() });
      if (p === '/me/shop/buy' && req.method === 'POST') { // one-call form (Game modes client)
        const out: any = b.kind === 'character' ? Eco.buyCharacter(pr, String(b.id || '')) : b.kind === 'starter' ? Eco.buyStarter(a, CAT, RAW, String(b.set || '')) : b.kind === 'pack' ? Eco.buyPacks(pr, CAT, String(b.set || ''), Number(b.count) || 1, b.pay === 'ticket' ? 'ticket' : 'coins') : { error: 'kind: pack, starter or character' };
        return done({ ...out, wallet: wallet(), inventory: (pr as any).inv || {} });
      }
      if (p === '/me/shop/character' && req.method === 'POST') return done({ ...Eco.buyCharacter(pr, String(b.id || '')), wallet: wallet() });
      if (p === '/me/chars') return send(res, 200, { ok: true, chars: Eco.charsOf(pr), all: Eco.charShop(pr) });
      if (p === '/me/packs/owned') return send(res, 200, { ok: true, packs: (pr as any).inv || {} });
      if (p === '/me/shop/starter' && req.method === 'POST') return done({ ...Eco.buyStarter(a, CAT, RAW, String(b.set || '')), wallet: wallet() });
      if (p === '/me/weekly-draw' && req.method === 'POST') return done({ ...Eco.weeklyDraw(pr), wallet: wallet() });
      // ---- friends: add an online player (or a key from a profile), accept, remove/decline, invite to my room
      if (p.startsWith('/me/friends')) {
        const f = Eco.friendsOf(pr);
        if (p === '/me/friends' && req.method === 'GET') {
          const rows = async (ids: string[]) => (await Promise.all(ids.slice(0, Eco.FRIEND_MAX).map(friendRow))).filter(Boolean);
          return send(res, 200, { friends: await rows(f.list), in: await rows(f.in), out: await rows(f.out) });
        }
        if (req.method !== 'POST') return send(res, 404, { error: 'Not found' });
        if (limited('fr:' + a.id, 30)) return send(res, 429, { error: 'Wait a minute.' });
        let otherId = '';
        if (b.id) otherId = BY_ID.get(String(b.id))?.acct || '';
        if (!otherId && b.key) otherId = KEY_TO_ID.get(String(b.key)) || '';
        if (!otherId) return send(res, 400, { error: 'That player has no Google account (guests can\'t be friends). · ผู้เล่นนี้ไม่มีบัญชี' });
        if (otherId === a.id) return send(res, 400, { error: 'That\'s you!' });
        const o = await STORE.get(otherId);
        if (!o) return send(res, 400, { error: 'No such player.' });
        const of = Eco.friendsOf(Eco.prog(o));
        const drop = (l: string[], x: string) => { const i = l.indexOf(x); if (i >= 0) l.splice(i, 1); };
        if (p === '/me/friends/add') {
          if (f.list.includes(otherId)) return send(res, 200, { ok: true, state: 'friends' });
          if (f.list.length >= Eco.FRIEND_MAX) return send(res, 400, { error: `Up to ${Eco.FRIEND_MAX} friends.` });
          if (f.in.includes(otherId)) { drop(f.in, otherId); drop(of.out, a.id); f.list.push(otherId); of.list.push(a.id); }
          else if (!f.out.includes(otherId)) { f.out.push(otherId); if (!of.in.includes(a.id)) of.in.push(a.id); if (of.in.length > 100) of.in.shift(); }
          await STORE.save(o); await STORE.save(a);
          return send(res, 200, { ok: true, state: f.list.includes(otherId) ? 'friends' : 'sent' });
        }
        if (p === '/me/friends/accept') {
          if (!f.in.includes(otherId)) return send(res, 400, { error: 'No request from that player.' });
          drop(f.in, otherId); drop(of.out, a.id); if (!f.list.includes(otherId)) f.list.push(otherId); if (!of.list.includes(a.id)) of.list.push(a.id);
          await STORE.save(o); await STORE.save(a);
          return send(res, 200, { ok: true, state: 'friends' });
        }
        if (p === '/me/friends/remove') {
          for (const l of [f.list, f.in, f.out]) drop(l, otherId);
          for (const l of [of.list, of.in, of.out]) drop(l, a.id);
          await STORE.save(o); await STORE.save(a);
          return send(res, 200, { ok: true, state: 'none' });
        }
        if (p === '/me/friends/invite') {
          if (!f.list.includes(otherId)) return send(res, 400, { error: 'Only friends can be invited. · เชิญได้เฉพาะเพื่อน' });
          const r = u.room ? ROOMS.get(u.room) : null;
          if (!r || r.ranked) return send(res, 400, { error: 'Make a room first. · สร้างห้องก่อน' });
          const t = userOfAcct(otherId);
          if (!t) return send(res, 400, { error: 'Your friend is offline. · เพื่อนออฟไลน์' });
          (r.invited ??= new Set()).add(t.id);
          const list = (INVITES.get(t.id) || []).filter((x) => x.code !== r.code && Date.now() - x.at < 600000).slice(-9);
          list.push({ from: u.name, key: keyOf(a.id), avatar: u.avatar || '', code: r.code, room: r.name, at: Date.now() });
          INVITES.set(t.id, list); bump();
          return send(res, 200, { ok: true });
        }
        return send(res, 404, { error: 'Not found' });
      }
      return send(res, 404, { error: 'Not found' });
    }
    // ---- profiles and cloud decks (accounts)
    if (p === '/me/profile' && req.method === 'GET') return send(res, 200, await profileOf(u));
    if (p === '/community') return send(res, 200, { players: communityList(u), online: online().length, chat: WORLD.slice(-50) });
    if (p === '/invite/dismiss' && req.method === 'POST') { const b = await readBody(req); INVITES.set(u.id, (INVITES.get(u.id) || []).filter((x) => x.code !== String(b.code || ''))); return send(res, 200, { ok: true }); }
    if (p === '/profile' && req.method === 'GET') {
      const t = BY_ID.get(String(url.searchParams.get('id') || ''));
      if (t) return send(res, 200, await profileOf(t));
      const kid = KEY_TO_ID.get(String(url.searchParams.get('key') || ''));
      const ka = kid ? await STORE.get(kid).catch(() => null) : null;
      return ka ? send(res, 200, await profileAcct(ka, userOfAcct(ka.id))) : send(res, 404, { error: 'That player is offline. · ผู้เล่นออฟไลน์' });
    }
    if (p === '/me/profile' && req.method === 'POST') {
      const a = acctOf(u);
      if (!a) return send(res, 403, { error: 'Log in with Google to keep a profile. · เข้าสู่ระบบด้วย Google ก่อน' });
      if (limited('prof:' + a.id, 30)) return send(res, 429, { error: 'Wait a minute.' });
      const b = await readBody(req);
      if (b.name !== undefined) {
        const nm = cleanLine(b.name, 16);
        if ([...nm].length < 2) return send(res, 400, { error: 'Pick a name of 2 to 16 characters. · ตั้งชื่อ 2-16 ตัวอักษร' });
        if (filterText(nm) !== nm) return send(res, 400, { error: 'Pick another name. · กรุณาเปลี่ยนชื่อ' });
        a.name = nm; u.name = uniqueName(nm, u);
      }
      if (b.avatar !== undefined && cleanAvatar(b.avatar)) { a.avatar = cleanAvatar(b.avatar); u.avatar = a.avatar; }
      if ((b.title !== undefined || b.banner !== undefined || b.frame !== undefined) && economyOn()) { const r = Eco.setBanner(a, b); if (r.error) return send(res, 400, r); }
      if (Array.isArray(b.showcase)) {
        const own = economyOn() ? Eco.ownedByName(Eco.prog(a), CAT) : null;
        a.showcase = b.showcase.map((c: any) => String(c)).filter((c: string) => INFO.has(c) && (!own || (own.get(CAT.nameOf.get(c) || '') || 0) > 0)).slice(0, 3);
      }
      await STORE.save(a);
      usersDirty = true; bump();
      return send(res, 200, await profileOf(u));
    }
    if (p === '/me/decks') {
      const a = acctOf(u);
      if (!a) return send(res, 403, { error: 'Log in with Google to save decks online. · เข้าสู่ระบบด้วย Google ก่อน' });
      if (req.method === 'GET') return send(res, 200, { decks: await STORE.decks(a.id) });
      if (limited('decks:' + a.id, 30)) return send(res, 429, { error: 'Wait a minute.' });
      const b = await readBody(req, 1500000);
      if (!b.decks || typeof b.decks !== 'object' || Array.isArray(b.decks)) return send(res, 400, { error: 'decks: {slug: {d, t}}' });
      const out: DeckMap = {};
      for (const [k, v] of Object.entries(b.decks).slice(0, 200)) {
        const slug = String(k).slice(0, 80);
        if (!slug || /[\\/\u0000-\u001f]/.test(slug) || slug.startsWith('.')) continue;
        const dv: any = (v as any)?.d;
        if (!dv || typeof dv !== 'object') continue;
        out[slug] = { d: dv, t: Math.floor(Number((v as any).t) || 0) };
      }
      if (JSON.stringify(out).length > 1200000) return send(res, 413, { error: 'Too many decks to save online.' });
      await STORE.saveDecks(a.id, out);
      return send(res, 200, { ok: true, count: Object.keys(out).length });
    }
    if (p === '/chat' && req.method === 'POST') {
      const b = await readBody(req);
      const r = u.room ? ROOMS.get(u.room) : null;
      if (b.ch === 'room') { if (!r) return send(res, 400, { error: 'You are not in a room.' }); return send(res, 200, chat(u, b.text, r.chat, 50)); }
      return send(res, 200, chat(u, b.text, WORLD, 100));
    }
    if (p === '/report' && req.method === 'POST') { const b = await readBody(req); return send(res, 200, report(u, Number(b.msg), String(b.reason || ''))); }
    if (p === '/room/create' && req.method === 'POST') {
      const b = await readBody(req);
      if (limited('room:' + u.id, 10)) return send(res, 429, { error: 'Wait a minute before making another room.' });
      if (u.room) leaveRoom(u);
      const nm = filterText(cleanLine(b.name, 30)) || `${u.name}'s room`;
      const r: Room = {
        code: newCode(), name: nm, host: u.id, password: cleanLine(b.password, 20), priv: !!b.private, bo3: !!b.bo3,
        seats: [{ user: u.id, deck: null, deckName: '', ready: false, char: '', warnings: [] }, null], chat: [], score: [0, 0], duel: null, last: null, created: Date.now(), games: 0,
      };
      ROOMS.set(r.code, r); u.room = r.code;
      pushMsg(r.chat, null, `${u.name} opened the room. Code: ${r.code} · เปิดห้องแล้ว`, true, 50);
      return send(res, 200, { ok: true, code: r.code });
    }
    if (p === '/room/join' && req.method === 'POST') {
      const b = await readBody(req);
      const r = ROOMS.get(cleanLine(b.code, 8).toUpperCase());
      if (!r) return send(res, 404, { error: 'No room with that code. · ไม่พบห้อง' });
      if (r.ranked && seatOf(r, u) < 0) return send(res, 403, { error: 'That is a Ranked match. · ห้องแรงก์' });
      if (seatOf(r, u) >= 0) { u.room = r.code; return send(res, 200, { ok: true, code: r.code }); }
      if (r.password && !r.invited?.has(u.id) && cleanLine(b.password, 20) !== r.password) {
        if (limited('pw:' + u.id, 8)) return send(res, 429, { error: 'Too many tries.' });
        return send(res, 403, { error: 'Wrong password. · รหัสผิด', needPassword: true });
      }
      const free = r.seats.findIndex((s) => !s);
      if (free < 0) return send(res, 409, { error: 'The room is full. · ห้องเต็ม' });
      if (u.room) leaveRoom(u);
      r.seats[free] = { user: u.id, deck: null, deckName: '', ready: false, char: '', warnings: [] };
      u.room = r.code;
      pushMsg(r.chat, null, `${u.name} joined · เข้าห้อง`, true, 50);
      return send(res, 200, { ok: true, code: r.code });
    }
    if (p === '/room/leave' && req.method === 'POST') { leaveRoom(u); return send(res, 200, { ok: true }); }
    const room = u.room ? ROOMS.get(u.room) : null;
    const mySeat = room ? seatOf(room, u) : -1;
    if (p === '/room/deck' && req.method === 'POST') {
      if (!room || mySeat < 0) return send(res, 400, { error: 'You are not in a room.' });
      if (room.duel && !room.duel.ended) return send(res, 409, { error: 'The duel is running.' });
      if (room.ranked) return send(res, 409, { error: 'Ranked: queue again for the next match. · เข้าคิวใหม่' });
      const b = await readBody(req);
      const c = cleanDeck(b.deck);
      if (c.error) return send(res, 400, { error: c.error });
      const s = room.seats[mySeat]!;
      s.deck = c.deck; s.deckName = c.deck.name; s.warnings = c.warnings || []; s.ready = false; s.char = charFor(u, cleanAvatar(b.char) || u.avatar || '');
      bump();
      return send(res, 200, { ok: true, warnings: s.warnings });
    }
    if (p === '/room/ready' && req.method === 'POST') {
      if (!room || mySeat < 0) return send(res, 400, { error: 'You are not in a room.' });
      const b = await readBody(req);
      const s = room.seats[mySeat]!;
      if (b.ready && !s.deck) return send(res, 400, { error: 'Pick a deck first. · เลือกเด็คก่อน' });
      if (room.ranked) return send(res, 409, { error: 'Ranked: queue again for the next match. · เข้าคิวใหม่' });
      s.ready = !!b.ready;
      bump();
      maybeStart(room);
      return send(res, 200, { ok: true });
    }
    if (p === '/room/kick' && req.method === 'POST') {
      if (!room || room.host !== u.id) return send(res, 403, { error: 'Only the host can do that.' });
      const other = room.seats.find((s) => s && s.user !== u.id);
      if (other) { const ou = BY_ID.get(other.user); if (ou) { leaveRoom(ou, 'left'); } }
      return send(res, 200, { ok: true });
    }

    // ---- duel (the Godot duel screen's /api calls)
    if (p.startsWith('/api/') || p === '/emote' || p === '/surrender') {
      if (!dd) return send(res, p === '/api/state' ? 200 : 409, p === '/api/state' ? { none: true } : { error: 'You are not in a duel.' });
      const { d, seat } = dd;
      if (p === '/api/new') return send(res, 200, { ok: true, cards: d.cards[seat], errors: { you: [], bot: [] }, online: { seat, names: [d.names[seat], d.names[1 - seat]] } });
      if (p === '/api/cards') return send(res, 200, d.cards[seat]);
      if (p === '/api/speed') return send(res, 200, { ok: true, factor: 1 });
      if (p === '/api/undo' || p === '/api/admin') return send(res, 409, { error: 'Not in online duels.' });
      if (p === '/api/state') {
        const since = Number(url.searchParams.get('since') ?? -1), from = Math.max(0, Number(url.searchParams.get('log') || 0));
        if (d.version <= since && !d.ended) await new Promise<void>((ok) => { const t = setTimeout(ok, 15000); d.waiters.push(() => { clearTimeout(t); ok(); }); });
        d.seen[seat] = Date.now();
        return send(res, 200, duelView(d, seat, from));
      }
      if (p === '/api/answer' && req.method === 'POST') {
        const b = await readBody(req);
        const q = d.asks[seat];
        if (d.ended || !q || q.id !== b.id) return send(res, 409, { error: 'That question is no longer open.' });
        d.port.postMessage({ seat, id: b.id, choice: Number(b.choice) });
        Atomics.store(d.flag, 0, 1); Atomics.notify(d.flag, 0);
        return send(res, 200, { ok: true });
      }
      if (p === '/emote' && req.method === 'POST') {
        const b = await readBody(req);
        const n = Math.floor(Number(b.n));
        if (!(n >= 0 && n < 8)) return send(res, 400, { error: 'emote 0..7' });
        const now = Date.now();
        if (d.emotes.filter((e) => e.seat === seat && now - e.at < 8000).length >= 2) return send(res, 429, { error: 'Wait a moment.' });
        d.emotes.push({ seat, n, at: now, id: d.emotes.length + 1 });
        duelBump(d);
        return send(res, 200, { ok: true });
      }
      if (p === '/surrender' && req.method === 'POST') { endDuel(d, 1 - seat, `${d.names[seat]} surrendered`); return send(res, 200, { ok: true }); }
    }
    return send(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: String(e) });
  }
}).listen(PORT, () => console.log(`Battle of Talingchan online server ${VERSION} on http://localhost:${PORT}/online (data: ${DATA})`));
