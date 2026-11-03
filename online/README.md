# Online duels: how to run the server

The game's **DUEL > ONLINE MODE** talks to one online server. The rules run on that server, so nobody can cheat
or see the other player's hand. One server is enough for all your friends.

## Quick test with friends (free)

1. On the PC that hosts, double-click `engine/start-online-server.bat` (Linux/Mac: `engine/start-online-server.sh`).
   It says `online server ... on http://localhost:8787/online`. Keep the window open.
2. Players on the **same Wi-Fi**: in ONLINE MODE type the host PC's address, for example `http://192.168.1.20:8787`
   (on the host: `ipconfig` shows the IPv4 address). Allow Node.js through the Windows firewall when asked.
3. Players **over the internet**, free, no router setup: install Cloudflare's `cloudflared` on the host and run
   `cloudflared tunnel --url http://localhost:8787`. It prints an address like `https://something.trycloudflare.com`.
   Everyone types that address in ONLINE MODE. (The address changes every time you start the tunnel.)

The host can play too: type `http://127.0.0.1:8787` on the host PC.

## A real server (always on)

Any small Linux server with Node.js 22.6 or newer works (a card game needs very little: 512 MB RAM is fine).
Copy the `engine` folder, then `PORT=8787 ADMIN_KEY=<secret> ./start-online-server.sh`, or use Docker:

```
docker build -f online/Dockerfile -t talingchan-online .     # in the engine folder
docker run -d -p 8787:8787 -v talingchan-data:/data -e ADMIN_KEY=<secret> talingchan-online
```

Put HTTPS in front of it (Caddy, nginx, or the hosting service). The **browser version needs HTTPS** when the game page
itself is on HTTPS. Easiest: serve the web build and this server on the same site, the server under `/online`
(the browser version then finds the server by itself).

## Settings (environment variables)

| Name | Default | What |
|---|---|---|
| `PORT` | 8787 | port |
| `DATA_DIR` | `online/data` | chat log, reports, results, mutes/bans, saved logins |
| `ADMIN_KEY` | (off) | turns on the admin calls below |
| `TURN_SEC` | 120 | seconds per own turn; when it runs out the server passes for you |
| `REACT_SEC` | 30 | seconds for each question in the opponent's turn (React) |
| `ORIGIN` | `*` | CORS allow-origin |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `PUBLIC_URL` | (off) | Discord login (see below) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | (off) | player accounts (see below) |
| `TIMER` | (off) | `1` = turn timer on (`TURN_SEC` / `REACT_SEC`) |
| `ONLINE_SPEED` | 0.5 | engine pauses (0.5 = 2x speed) |

## Chat safety

- Bad-word filter: `online/badwords.txt` (add more in `DATA_DIR/badwords.txt`). Links are removed.
- Rate limit: 1 message per 1.2 s, 5 per 10 s; spamming = muted 2 minutes.
- Players can mute someone (on their own PC) and report a message by clicking the name.
- 3 reports from different players within 10 minutes = muted 30 minutes. Reports are kept in `DATA_DIR/reports.jsonl`.
- Admin (with `ADMIN_KEY`): `POST /online/admin` with JSON `{"key":"<secret>","op":"mute","name":"<player>","minutes":60}`.
  Ops: `mute`, `unmute`, `ban`, `unban`, `clear` (delete their messages), `reports`, `reloadwords`, `announce` (`text`).

## Discord login (optional)

Make an application at https://discord.com/developers, add the redirect `<PUBLIC_URL>/online/discord/callback`, then
start the server with `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` and `PUBLIC_URL` (your server's https address).
A "LOG IN WITH DISCORD" button then shows in the game. Without these, players log in with a nickname.

## Player accounts: Google login (optional)

A Google login is a player account: changeable name and profile picture, 3 showcase cards, level/XP
(win 30, loss 10, draw 15; duels shorter than 3 turns count for nothing), win rate, match history, and decks saved
online (synced with the PC's own decks). Guests (nickname) still play, without any of this. Code: `online/accounts.ts`.

Server settings: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PUBLIC_URL` (this server's https address), and where
accounts are kept: `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` (the free Render server forgets its files, so use Supabase;
without them accounts go to `DATA_DIR/accounts.json`). Optional `SESSION_SECRET` (default: the Google secret).

1. **Supabase** (free): supabase.com, New project. SQL Editor, run:
   ```sql
   create table accounts (id text primary key, name text not null, avatar text default '', showcase jsonb default '[]',
     xp int default 0, wins int default 0, losses int default 0, draws int default 0, decks jsonb default '{}',
     banned text, created timestamptz default now(), updated timestamptz default now());
   create table matches (id bigint generated always as identity primary key, at timestamptz default now(),
     a text, b text, a_name text, b_name text, a_avatar text, b_avatar text, a_deck text, b_deck text,
     winner int, reason text, turns int, secs int);
   create index matches_a on matches (a, at desc);
   create index matches_b on matches (b, at desc);
   alter table accounts enable row level security;
   alter table matches enable row level security;
   ```
   (Row level security with no policies: only this server, with the secret key, can read or write.)
   Project Settings, API Keys: copy the project URL and the **secret** key.
2. **Google**: console.cloud.google.com, a new project. APIs & Services, OAuth consent screen: External, app name,
   your email, privacy policy `<PUBLIC_URL>/online/privacy`; then Publish app. Credentials, Create credentials,
   OAuth client ID, Web application, Authorized redirect URI `<PUBLIC_URL>/online/google/callback`. Copy the ID and secret.
3. Put the 5 values in the server's environment and restart it. The game then shows LOG IN WITH GOOGLE.

Calls: `GET /online/google/start?state=` (opens Google), `/online/google/callback`, `/online/oauth/poll?state=`,
`GET|POST /online/me/profile {name, avatar, showcase}`, `GET /online/profile?id=<player id>`,
`GET|POST /online/me/decks {decks: {slug: {d, t}}}`. Results are recorded by the server itself.

## Game economy: rewards, packs, cards, Ranked (online/economy.ts)
Needs the accounts above plus **SQL step 2** (Supabase SQL Editor, run once). Until then the server runs without it
(`/online/ping` says `economy:false`) and the calls below answer 503.
```sql
alter table accounts add column prog jsonb default '{}', add column rank_pts int default 0,
  add column mmr int default 1000, add column season text default '';
alter table matches add column ranked boolean default false;
create index accounts_rank on accounts (season, rank_pts desc);
```
All values are decided by the server (no real money). Guests get 403 `{guest:true}`. Errors are 400 `{error}`.
- `GET /me/home`: profile, level, wallet (also flat `coins tickets dust`), login calendar, 3 missions, bot caps,
  `rank {tier, div, pts, name, season}`, `badges {login, missions (count), shop, starter}`, `firstTime`, `gift` (start gift, once).
- Name banner: `/me/home` `nameplate {title, titleName, banner, frame, unlocked, locked}`; set with
  `POST /me/profile {title, banner, frame}` (400 if not unlocked). Profiles show title, titleName, banner, frame.
- `POST /me/setup {name, avatar, starter:"SD01"}` first-time flow, answers like /me/home.
- `POST /me/login-reward`, `POST /me/missions/claim {i}`, `POST /me/missions/reroll {i}` (one reroll a day).
- Bot games (EXP always, coins only with an all-owned deck; daily cap 400 EXP / 200 coins; never in match history):
  `POST /me/botgame {level, win, turns, deck?}` -> `{xpGain, coins, level, xpIn, xpNext, leveledUp, firstWin}`,
  or the stricter pair `POST /me/bot/start {level, deck}` -> `{ticket}` then `POST /me/bot/finish {ticket, won, turns}`.
- Cards: `GET /shop/packs` (sets, odds, pity 40), `POST /me/packs/open {set, count 1-10, pay: coins|ticket|free}`,
  `GET /me/collection` -> `{cards: {code: copies}, dust}`, `POST /me/craft {code}`, `POST /me/starter {set}`,
  `POST /me/deck/check {deck}` -> `{legal, missing}` (Ranked = owned cards only; same card name counts across prints).
- Ranked: `POST /ranked/queue {deck, char}` (refuses unowned decks), `POST /ranked/leave`, `GET /me/ranked`,
  `GET /ranked/leaderboard`. A match appears as a private ranked room in `/poll`; its `last.myRewards` shows rewards.

## How it works (for programmers)

- `online/server.ts`: lobby (login, rooms, room list, world + room chat, long-poll `/online/poll`) and duels.
  Duel calls are the same as the local engine's (`/online/api/new|state|answer`), so `main.gd` only routes `api()`
  through the `Online` autoload (`scripts/online_client.gd`) when `start_config.online` is set.
- `online/duel_worker.ts`: one worker thread per duel, both seats human (engine `setAskSeats` / `askSeat`). Each seat
  gets only its own hand and deck list; seat 1 gets a mirrored view, so the screen always sees itself as player 0.
- Disconnect: 45 s away in a room = leaves the room; 120 s away in a duel = loses. Coming back within that time
  (ONLINE MODE logs in again with the saved token) rejoins the same duel.
- Tests: `node --experimental-strip-types --no-warnings qa/online_test.ts 12` (two scripted players, hidden-info checks;
  `IDLE=1 TIMER=1 TURN_SEC=2 REACT_SEC=1` tests the timer; `ACCOUNTS=1` tests accounts, cloud decks and restart restore).
