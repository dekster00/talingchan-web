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

## How it works (for programmers)

- `online/server.ts`: lobby (login, rooms, room list, world + room chat, long-poll `/online/poll`) and duels.
  Duel calls are the same as the local engine's (`/online/api/new|state|answer`), so `main.gd` only routes `api()`
  through the `Online` autoload (`scripts/online_client.gd`) when `start_config.online` is set.
- `online/duel_worker.ts`: one worker thread per duel, both seats human (engine `setAskSeats` / `askSeat`). Each seat
  gets only its own hand and deck list; seat 1 gets a mirrored view, so the screen always sees itself as player 0.
- Disconnect: 45 s away in a room = leaves the room; 120 s away in a duel = loses. Coming back within that time
  (ONLINE MODE logs in again with the saved token) rejoins the same duel.
- Tests: `node --experimental-strip-types --no-warnings qa/online_test.ts 12` (two scripted players, hidden-info checks;
  `IDLE=1 TURN_SEC=2 REACT_SEC=1` tests the timer).
