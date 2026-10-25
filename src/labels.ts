// Short choice labels written by the user (engine/data/choice_labels.json, made from v14/choice-labels.xlsx with
// v14/tools/import_choice_labels.py). Only the text shown on buttons / popup titles changes; never the rules.
// File: { "<card name or code>": { "<key>": "short Thai" | { "th": "...", "en": "..." } } }
//   "field:0" / "hand:1" / "hell:0" / "exile:0" / "cast:1" = that card's action button (index in fieldActs / handActs /
//   hellActs / exileActs, or the Magic option); "text:<label or title exactly as shown>" = a choice button
//   (เลือกปฏิบัติ / yes-no / pick title) with that text, whichever card shows it. "*" in a text key matches any text
//   (a card name, a number); a "*" in the new label puts that text back. th + en are shown as "th · en".
// Missing file, bad JSON or no entry = the label the engine builds now.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type Entry = string | { th?: string; en?: string };
export const LABELS_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'choice_labels.json');
let CARD = new Map<string, Map<string, string>>();
let EXACT = new Map<string, string>();
let WILD: { re: RegExp; val: string }[] = [];

const show = (e: Entry): string => (typeof e === 'string' ? e.trim()
  : e && typeof e === 'object' ? [e.th, e.en].map((s) => String(s ?? '').trim()).filter(Boolean).join(' · ') : '');
const esc = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/** (Re)load the labels: from data (tests) or from engine/data/choice_labels.json. */
export function loadLabels(data?: any): void {
  CARD = new Map(); EXACT = new Map(); WILD = [];
  if (data === undefined) {
    try { data = fs.existsSync(LABELS_FILE) ? JSON.parse(fs.readFileSync(LABELS_FILE, 'utf8')) : {}; } catch { data = {}; }
  }
  if (!data || typeof data !== 'object') return;
  for (const [card, keys] of Object.entries<any>(data)) {
    if (!keys || typeof keys !== 'object' || card.startsWith('_')) continue;
    for (const [k, e] of Object.entries<Entry>(keys)) {
      const v = show(e);
      if (!v) continue;
      if (k.startsWith('text:')) {
        const t = k.slice(5);
        if (t.includes('*')) WILD.push({ re: new RegExp('^' + t.split('*').map(esc).join('(.*?)') + '$', 's'), val: v });
        else EXACT.set(t, v);
      } else {
        if (!CARD.has(card)) CARD.set(card, new Map());
        CARD.get(card)!.set(k, v);
      }
    }
  }
}
/** A button / title text: the user's short label for it, else cur. */
export function textLabel(cur: string): string {
  if (!cur) return cur;
  const v = EXACT.get(cur);
  if (v) return v;
  for (const w of WILD) {
    const m = w.re.exec(cur);
    if (m) { let i = 1; return w.val.replace(/\*/g, () => m[i++] ?? ''); }
  }
  return cur;
}
/** A card's action button (key "field:0" etc.): by code, then by name, then by its text. */
export function cardLabel(code: string, name: string, key: string, cur: string): string {
  return CARD.get(code)?.get(key) ?? CARD.get(name)?.get(key) ?? textLabel(cur);
}
loadLabels();
