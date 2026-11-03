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
// 2026-11-02 game economy (online/economy.ts): accounts + prog jsonb (wallet, cards, missions, ...), rank_pts int,
//   mmr int, season text; matches + ranked boolean. Until those columns exist (README SQL step 2) the server keeps
//   working without them (legacy mode: no economy, /ping says economy:false).
import fs from 'node:fs';
import path from 'node:path';

export type Account = {
  id: string; name: string; avatar: string; showcase: string[]; xp: number; wins: number; losses: number; draws: number;
  banned?: string; created: string;
  prog: any; rank_pts: number; mmr: number; season: string; // economy (online/economy.ts)
};
export type DeckMap = Record<string, { d: any; t: number }>; // deck slug -> {deck (inline format), saved at (unix s)}
export type Match = {
  at: string; a: string; b: string; a_name: string; b_name: string; a_avatar: string; b_avatar: string;
  a_deck: string; b_deck: string; winner: number | null; reason: string; turns: number; secs: number; ranked?: boolean; replay?: string;
};

// XP (game design 2026-11-02): online duel win 100, loss 40, draw 50 (bot games: economy.ts).
// Level L starts at 50 * L * (L - 1) XP (Lv 2 = 100, Lv 3 = 300, Lv 4 = 600, ...).
export const XP_WIN = 100, XP_LOSS = 40, XP_DRAW = 50;
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
  legacy = false; // the Supabase tables have no economy columns yet

  constructor(dataDir: string) {
    this.dir = dataDir;
    if (usingSupabase) return;
    try { this.local = JSON.parse(fs.readFileSync(path.join(dataDir, 'accounts.json'), 'utf8')); } catch {}
    try { this.localMatches = fs.readFileSync(path.join(dataDir, 'matches.jsonl'), 'utf8').trim().split('\n').filter(Boolean).slice(-20000).map((l) => JSON.parse(l)); } catch {}
  }
  private saveLocal() {
    try { fs.writeFileSync(path.join(this.dir, 'accounts.json'), JSON.stringify(this.local)); } catch (e) { console.error(e); }
  }
  private row(a: Account) {
    const { id, name, avatar, showcase, xp, wins, losses, draws, banned, prog, rank_pts, mmr, season } = a;
    const r: any = { id, name, avatar, showcase, xp, wins, losses, draws, banned: banned || null, updated: new Date().toISOString() };
    if (!this.legacy) Object.assign(r, { prog, rank_pts, mmr, season });
    return r;
  }
  // a write that names a column the table lacks: switch to legacy mode once and write again without them
  private async sbTry(method: string, table: string, query: string, body: any, prefer: string, strip: (b: any) => any) {
    try { return await sb(method, table, query, body, prefer); } catch (e) {
      if (!this.legacy && /column|PGRST204|42703/.test(String(e)) && /prog|rank_pts|mmr|season|ranked/.test(String(e))) { this.legacy = true; console.error('Supabase has no economy columns yet (run README SQL step 2): ' + String(e).slice(0, 200)); return sb(method, table, query, strip(body), prefer); }
      throw e;
    }
  }
  private static clean(r: any): Account {
    return {
      id: String(r.id), name: String(r.name || 'Player'), avatar: String(r.avatar || ''), showcase: Array.isArray(r.showcase) ? r.showcase.map(String).slice(0, 3) : [],
      xp: Number(r.xp) || 0, wins: Number(r.wins) || 0, losses: Number(r.losses) || 0, draws: Number(r.draws) || 0,
      banned: r.banned ? String(r.banned) : undefined, created: String(r.created || new Date().toISOString()),
      prog: r.prog && typeof r.prog === 'object' ? r.prog : {}, rank_pts: Number(r.rank_pts) || 0, mmr: Number(r.mmr) || 1000, season: String(r.season || ''),
    };
  }

  cached(id: string): Account | undefined { return this.cache.get(id); }

  async get(id: string): Promise<Account | null> {
    if (this.cache.has(id)) return this.cache.get(id)!;
    let r: any = null;
    if (usingSupabase) {
      const q = `id=eq.${encodeURIComponent(id)}&select=id,name,avatar,showcase,xp,wins,losses,draws,banned,created`;
      if (!this.legacy) {
        try { r = (await sb('GET', 'accounts', q + ',prog,rank_pts,mmr,season'))?.[0] || null; } catch (e) {
          if (!/column|42703/.test(String(e))) throw e;
          this.legacy = true;
        }
      }
      if (this.legacy) r = (await sb('GET', 'accounts', q))?.[0] || null;
    }
    else r = this.local[id] || null;
    if (!r) return null;
    const a = Store.clean(r);
    this.cache.set(id, a);
    return a;
  }

  async create(id: string, name: string, avatar: string): Promise<Account> {
    const a: Account = { id, name, avatar, showcase: [], xp: 0, wins: 0, losses: 0, draws: 0, created: new Date().toISOString(), prog: {}, rank_pts: 0, mmr: 1000, season: '' };
    const strip = (b: any) => { const { prog, rank_pts, mmr, season, ...rest } = b; return rest; };
    if (usingSupabase) await this.sbTry('POST', 'accounts', 'on_conflict=id', { ...this.row(a), created: a.created, decks: {} }, 'resolution=ignore-duplicates,return=minimal', strip);
    else { this.local[id] = { ...a, decks: {} }; this.saveLocal(); }
    this.cache.set(id, a);
    return a;
  }

  // writes are queued one after another, so two quick saves of the same account land in order
  save(a: Account): Promise<void> {
    this.cache.set(a.id, a);
    this.saving = this.saving.then(async () => {
      const strip = (b: any) => { const { prog, rank_pts, mmr, season, ...rest } = b; return rest; };
      if (usingSupabase) await this.sbTry('PATCH', 'accounts', `id=eq.${encodeURIComponent(a.id)}`, this.row(a), 'return=minimal', strip);
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

  noReplayCol = false; // README SQL step 3 not run yet: matches has no replay column
  async addMatch(m: Match): Promise<void> {
    if (usingSupabase) {
      const { ranked, replay, ...rest } = m, noReplay = { ...rest, ranked };
      if (!this.legacy && !this.noReplayCol && replay) {
        try { await sb('POST', 'matches', '', m, 'return=minimal'); return; } catch (e) {
          if (!/replay/.test(String(e))) throw e;
          this.noReplayCol = true; console.error('matches has no replay column yet (README SQL step 3)');
        }
      }
      await this.sbTry('POST', 'matches', '', this.legacy ? rest : noReplay, 'return=minimal', () => rest);
      return;
    }
    this.localMatches.push(m);
    try { fs.appendFileSync(path.join(this.dir, 'matches.jsonl'), JSON.stringify(m) + '\n'); } catch (e) { console.error(e); }
  }
  // ranked leaderboard of a season: the top n by rank points (accounts in memory are fresher, so they win)
  async leaderboard(season: string, n = 100): Promise<{ id: string; name: string; avatar: string; rank_pts: number; xp: number }[]> {
    let rows: any[] = [];
    if (usingSupabase) {
      if (this.legacy) return [];
      rows = (await sb('GET', 'accounts', `season=eq.${encodeURIComponent(season)}&rank_pts=gt.0&banned=is.null&order=rank_pts.desc&limit=${n}&select=id,name,avatar,rank_pts,xp`)) || [];
    } else rows = Object.values(this.local).filter((a: any) => a.season === season && a.rank_pts > 0 && !a.banned);
    const by = new Map(rows.map((r) => [String(r.id), r]));
    for (const a of this.cache.values()) if (a.season === season && a.rank_pts > 0 && !a.banned) by.set(a.id, a);
    return [...by.values()].map((r: any) => ({ id: String(r.id), name: String(r.name), avatar: String(r.avatar || ''), rank_pts: Number(r.rank_pts) || 0, xp: Number(r.xp) || 0 }))
      .sort((a, b) => b.rank_pts - a.rank_pts).slice(0, n);
  }

  // PvP replays (the duel's log lines) and bug reports: Supabase tables from README SQL step 3, else local files
  private localExtra(name: string) { return path.join(this.dir, name); }
  async saveReplay(id: string, data: any): Promise<void> {
    if (usingSupabase) { try { await sb('POST', 'replays', '', { id, at: new Date().toISOString(), data }, 'return=minimal'); return; } catch (e) { console.error('replay kept locally (README SQL step 3?): ' + String((e as any)?.message || e).slice(0, 160)); } }
    try { fs.mkdirSync(this.localExtra('replays'), { recursive: true }); fs.writeFileSync(path.join(this.localExtra('replays'), id + '.json'), JSON.stringify(data)); } catch (e) { console.error(e); }
  }
  async replay(id: string): Promise<any> {
    if (!/^[a-f0-9]{16,32}$/.test(id)) return null;
    if (usingSupabase) { try { const r = (await sb('GET', 'replays', `id=eq.${id}&select=data`))?.[0]; if (r) return r.data; } catch {} }
    try { return JSON.parse(fs.readFileSync(path.join(this.localExtra('replays'), id + '.json'), 'utf8')); } catch { return null; }
  }
  async addReport(r: any): Promise<void> {
    if (usingSupabase) { try { await sb('POST', 'reports', '', r, 'return=minimal'); return; } catch (e) { console.error('report kept locally (README SQL step 3?): ' + String((e as any)?.message || e).slice(0, 160)); } }
    try { fs.appendFileSync(this.localExtra('reports.jsonl'), JSON.stringify(r) + '\n'); } catch (e) { console.error(e); }
  }
  async reports(n = 50): Promise<any[]> {
    if (usingSupabase) { try { return (await sb('GET', 'reports', `order=at.desc&limit=${n}&select=at,acct,name,text,version,log`)) || []; } catch {} }
    try { return fs.readFileSync(this.localExtra('reports.jsonl'), 'utf8').trim().split('\n').filter(Boolean).slice(-n).reverse().map((l) => { const { shot, ...x } = JSON.parse(l); return x; }); } catch { return []; }
  }

  async history(id: string, n = 20): Promise<Match[]> {
    if (usingSupabase) {
      const v = encodeURIComponent(`"${id}"`); // quoted: ids hold ':' which PostgREST reserves inside or=()
      const q = `or=(a.eq.${v},b.eq.${v})&order=at.desc&limit=${n}&select=at,a,b,a_name,b_name,a_avatar,b_avatar,a_deck,b_deck,winner,reason,turns,secs${this.legacy ? '' : ',ranked'}${this.noReplayCol || this.legacy ? '' : ',replay'}`;
      try { return (await sb('GET', 'matches', q)) || []; } catch (e) {
        if (!/replay/.test(String(e)) || this.noReplayCol) throw e;
        this.noReplayCol = true; return this.history(id, n);
      }
    }
    return this.localMatches.filter((m) => m.a === id || m.b === id).slice(-n).reverse();
  }
}
