// Player accounts for online play (2026-11-02, user: "add their Google account to save their deck list ... win rate,
// stats, 3 main cards, history, icon and name that can change, and level").
// A Google login makes an account: display name, profile picture, 3 showcase cards, level/XP, wins/losses/draws,
// match history and the player's saved decks. Guests (nickname login) have none of this.
// Storage: Supabase (Postgres over its REST API) when SUPABASE_URL + SUPABASE_SERVICE_KEY are set, because the free
// Render server has no lasting disk; otherwise local files in DATA_DIR (accounts.json, matches.jsonl) for testing.
// Only this server writes (service key): results come from the server's own duels, so nobody can fake wins or levels.
//
// Supabase tables (SQL in online/README.md):
//   accounts(id text pk, name, avatar, showcase jsonb, xp int, wins int, losses int, draws int, decks jsonb,
//            banned text, created timestamptz, updated timestamptz)
//   matches(id bigint identity pk, at timestamptz, a text, b text, a_name, b_name, a_avatar, b_avatar, a_deck, b_deck,
//           winner int (0 = a, 1 = b, null = draw), reason text, turns int, secs int)
import fs from 'node:fs';
import path from 'node:path';

export type Account = {
  id: string; name: string; avatar: string; showcase: string[]; xp: number; wins: number; losses: number; draws: number;
  banned?: string; created: string;
};
export type DeckMap = Record<string, { d: any; t: number }>; // deck slug -> {deck (inline format), saved at (unix s)}
export type Match = {
  at: string; a: string; b: string; a_name: string; b_name: string; a_avatar: string; b_avatar: string;
  a_deck: string; b_deck: string; winner: number | null; reason: string; turns: number; secs: number;
};

// XP: win 30, loss 10, draw 15. Level L starts at 50 * L * (L - 1) XP (Lv 2 = 100, Lv 3 = 300, Lv 4 = 600, ...).
export const XP_WIN = 30, XP_LOSS = 10, XP_DRAW = 15;
export function levelOf(xp: number) {
  let lv = 1;
  while (50 * (lv + 1) * lv <= xp) lv++;
  const at = 50 * lv * (lv - 1), next = 50 * (lv + 1) * lv;
  return { level: lv, xp, xpIn: xp - at, xpNext: next - at };
}

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
export const usingSupabase = !!(SB_URL && SB_KEY);

async function sb(method: string, table: string, query = '', body?: any, prefer = ''): Promise<any> {
  const headers: Record<string, string> = { apikey: SB_KEY, 'content-type': 'application/json' };
  if (SB_KEY.startsWith('eyJ')) headers.authorization = `Bearer ${SB_KEY}`; // legacy service_role JWT; new sb_secret_ keys go in apikey only
  if (prefer) headers.prefer = prefer;
  const r = await fetch(`${SB_URL}/rest/v1/${table}${query ? '?' + query : ''}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Supabase ${method} ${table}: ${r.status} ${txt.slice(0, 300)}`);
  return txt ? JSON.parse(txt) : null;
}

export class Store {
  private dir: string;
  private local: Record<string, Account & { decks?: DeckMap }> = {};
  private localMatches: Match[] = [];
  private cache = new Map<string, Account>(); // accounts in use: the server is the only writer, so this stays right
  private saving = Promise.resolve();

  constructor(dataDir: string) {
    this.dir = dataDir;
    if (usingSupabase) return;
    try { this.local = JSON.parse(fs.readFileSync(path.join(dataDir, 'accounts.json'), 'utf8')); } catch {}
    try { this.localMatches = fs.readFileSync(path.join(dataDir, 'matches.jsonl'), 'utf8').trim().split('\n').filter(Boolean).slice(-20000).map((l) => JSON.parse(l)); } catch {}
  }
  private saveLocal() {
    try { fs.writeFileSync(path.join(this.dir, 'accounts.json'), JSON.stringify(this.local)); } catch (e) { console.error(e); }
  }
  private static row(a: Account) {
    const { id, name, avatar, showcase, xp, wins, losses, draws, banned } = a;
    return { id, name, avatar, showcase, xp, wins, losses, draws, banned: banned || null, updated: new Date().toISOString() };
  }
  private static clean(r: any): Account {
    return {
      id: String(r.id), name: String(r.name || 'Player'), avatar: String(r.avatar || ''), showcase: Array.isArray(r.showcase) ? r.showcase.map(String).slice(0, 3) : [],
      xp: Number(r.xp) || 0, wins: Number(r.wins) || 0, losses: Number(r.losses) || 0, draws: Number(r.draws) || 0,
      banned: r.banned ? String(r.banned) : undefined, created: String(r.created || new Date().toISOString()),
    };
  }

  cached(id: string): Account | undefined { return this.cache.get(id); }

  async get(id: string): Promise<Account | null> {
    if (this.cache.has(id)) return this.cache.get(id)!;
    let r: any = null;
    if (usingSupabase) r = (await sb('GET', 'accounts', `id=eq.${encodeURIComponent(id)}&select=id,name,avatar,showcase,xp,wins,losses,draws,banned,created`))?.[0] || null;
    else r = this.local[id] || null;
    if (!r) return null;
    const a = Store.clean(r);
    this.cache.set(id, a);
    return a;
  }

  async create(id: string, name: string, avatar: string): Promise<Account> {
    const a: Account = { id, name, avatar, showcase: [], xp: 0, wins: 0, losses: 0, draws: 0, created: new Date().toISOString() };
    if (usingSupabase) await sb('POST', 'accounts', 'on_conflict=id', { ...Store.row(a), created: a.created, decks: {} }, 'resolution=ignore-duplicates,return=minimal');
    else { this.local[id] = { ...a, decks: {} }; this.saveLocal(); }
    this.cache.set(id, a);
    return a;
  }

  // writes are queued one after another, so two quick saves of the same account land in order
  save(a: Account): Promise<void> {
    this.cache.set(a.id, a);
    this.saving = this.saving.then(async () => {
      if (usingSupabase) await sb('PATCH', 'accounts', `id=eq.${encodeURIComponent(a.id)}`, Store.row(a), 'return=minimal');
      else { this.local[a.id] = { ...(this.local[a.id] || {}), ...a }; this.saveLocal(); }
    }).catch((e) => console.error(e));
    return this.saving;
  }

  async decks(id: string): Promise<DeckMap> {
    if (usingSupabase) return (await sb('GET', 'accounts', `id=eq.${encodeURIComponent(id)}&select=decks`))?.[0]?.decks || {};
    return this.local[id]?.decks || {};
  }
  async saveDecks(id: string, decks: DeckMap): Promise<void> {
    if (usingSupabase) { await sb('PATCH', 'accounts', `id=eq.${encodeURIComponent(id)}`, { decks, updated: new Date().toISOString() }, 'return=minimal'); return; }
    if (this.local[id]) { this.local[id].decks = decks; this.saveLocal(); }
  }

  async addMatch(m: Match): Promise<void> {
    if (usingSupabase) { await sb('POST', 'matches', '', m, 'return=minimal'); return; }
    this.localMatches.push(m);
    try { fs.appendFileSync(path.join(this.dir, 'matches.jsonl'), JSON.stringify(m) + '\n'); } catch (e) { console.error(e); }
  }
  async history(id: string, n = 20): Promise<Match[]> {
    if (usingSupabase) {
      const v = encodeURIComponent(`"${id}"`); // quoted: ids hold ':' which PostgREST reserves inside or=()
      const q = `or=(a.eq.${v},b.eq.${v})&order=at.desc&limit=${n}&select=at,a,b,a_name,b_name,a_avatar,b_avatar,a_deck,b_deck,winner,reason,turns,secs`;
      return (await sb('GET', 'matches', q)) || [];
    }
    return this.localMatches.filter((m) => m.a === id || m.b === id).slice(-n).reverse();
  }
}
