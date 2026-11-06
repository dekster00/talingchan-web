// Daily database backup (2026-11-06, user-approved upgrade list; design by the Lead Programmer).
// Once every 24 h (and once at start when the newest backup is older than 24 h) the server reads the Supabase tables
// that hold player progress (accounts = profile, coins, cards, decks; matches = history; reports without screenshots)
// in pages of 1000 rows and writes one gzipped JSON file to the private Storage bucket "backups"
// (backups/YYYY-MM-DD.json.gz). The bucket is made when missing; the newest 14 files are kept.
// Restore: see talingchan-online.md (memory) / README "Backups". GET /online/admin/backup/latest?key=ADMIN_KEY returns
// the newest file (gzip). Needs no new keys: it uses SUPABASE_URL + SUPABASE_SERVICE_KEY.
import zlib from 'node:zlib';

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const BUCKET = 'backups', KEEP = Number(process.env.BACKUP_KEEP || 14), DAY = 864e5;
export const TABLES: { name: string; select: string; order: string }[] = [
  { name: 'accounts', select: '*', order: 'id' },
  { name: 'matches', select: '*', order: 'id' },
  { name: 'reports', select: 'id,at,acct,name,text,version', order: 'id' },
];
const headers = (extra: Record<string, string> = {}) => {
  const h: Record<string, string> = { apikey: SB_KEY, ...extra };
  if (SB_KEY.startsWith('eyJ')) h.authorization = `Bearer ${SB_KEY}`;
  return h;
};
async function req(method: string, path: string, body?: any, extra: Record<string, string> = {}) {
  const isBuf = body instanceof Buffer;
  const r = await fetch(SB_URL + path, { method, headers: headers({ ...(body !== undefined && !isBuf ? { 'content-type': 'application/json' } : {}), ...extra }), body: body === undefined ? undefined : isBuf ? body : JSON.stringify(body) });
  return r;
}
async function readTable(t: { name: string; select: string; order: string }) {
  const rows: any[] = [];
  for (let off = 0; ; off += 1000) {
    const r = await req('GET', `/rest/v1/${t.name}?select=${t.select}&order=${t.order}&limit=1000&offset=${off}`);
    if (!r.ok) { if (r.status === 404 || r.status === 400) return null; throw new Error(`backup read ${t.name}: ${r.status} ${(await r.text()).slice(0, 200)}`); }
    const page = (await r.json()) as any[];
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}
async function list(): Promise<{ name: string; created_at?: string }[]> {
  const r = await req('POST', `/storage/v1/object/list/${BUCKET}`, { prefix: '', limit: 1000, sortBy: { column: 'name', order: 'desc' } });
  if (!r.ok) return [];
  return ((await r.json()) as any[]).filter((x) => /^\d{4}-\d\d-\d\d\.json\.gz$/.test(x.name)).sort((a, b) => b.name.localeCompare(a.name));
}
async function ensureBucket() {
  const r = await req('POST', '/storage/v1/bucket', { id: BUCKET, name: BUCKET, public: false });
  if (!r.ok && r.status !== 409 && r.status !== 400) throw new Error(`backup bucket: ${r.status} ${(await r.text()).slice(0, 200)}`);
}
export let lastBackup = { at: '', file: '', rows: {} as Record<string, number>, error: '' };
export async function runBackup(now = Date.now()) {
  const file = new Date(now + 7 * 3600e3).toISOString().slice(0, 10) + '.json.gz'; // Thai date
  try {
    await ensureBucket();
    const data: Record<string, any[]> = {}, rows: Record<string, number> = {};
    for (const t of TABLES) { const r = await readTable(t); if (r) { data[t.name] = r; rows[t.name] = r.length; } }
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify({ v: 1, at: new Date(now).toISOString(), tables: data })));
    const up = await req('POST', `/storage/v1/object/${BUCKET}/${file}`, gz, { 'content-type': 'application/gzip', 'x-upsert': 'true' });
    if (!up.ok) throw new Error(`backup upload: ${up.status} ${(await up.text()).slice(0, 200)}`);
    const old = (await list()).slice(KEEP).map((x) => x.name);
    if (old.length) await req('DELETE', `/storage/v1/object/${BUCKET}`, { prefixes: old });
    lastBackup = { at: new Date(now).toISOString(), file, rows, error: '' };
    console.log(`backup ${file}: ${JSON.stringify(rows)} (${gz.length} bytes)`);
  } catch (e: any) {
    lastBackup = { ...lastBackup, error: String(e?.message || e) };
    console.log('backup failed: ' + (e?.message || e));
  }
  return lastBackup;
}
export async function latestBackup(): Promise<{ name: string; data: Buffer } | null> {
  const f = (await list())[0];
  if (!f) return null;
  const r = await req('GET', `/storage/v1/object/${BUCKET}/${f.name}`);
  if (!r.ok) return null;
  return { name: f.name, data: Buffer.from(await r.arrayBuffer()) };
}
// start: back up now when the newest file is not from today, then every 24 h
export function startBackups() {
  if (!SB_URL || !SB_KEY || process.env.BACKUP === '0') return false;
  const first = async () => {
    const newest = (await list().catch(() => []))[0];
    const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
    if (!newest || !newest.name.startsWith(today)) await runBackup();
  };
  setTimeout(() => { first().catch(() => {}); }, 60_000).unref();
  setInterval(() => { runBackup().catch(() => {}); }, DAY).unref();
  return true;
}
