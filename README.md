# CageCricket Live

A modern, iOS-styled mobile web app for scoring indoor cricket with custom rules, plus historical stats import.

## Key features
- Simplified single-mode launch (Scorer only for now — Watcher mode temporarily hidden while it's stabilized)
- Team assignment via colored chips: tap a player to cycle Unassigned → Team A (red) → Team B (blue) → Common (green)
- Undo Last Ball button on the Live Score screen — fully replays the innings from the remaining ball history after every undo, so you can undo as many times in a row as needed with guaranteed consistency
- Click any player's name (leaderboard or live scorecard) to see their stat card: matches, runs, high score, average, strike rate, wickets
- No-ball scoring fixed: runs off the bat + fixed 1-run penalty are both credited correctly, shown as e.g. "2nb" on the ball tracker
- Attendance-first setup: tick who's actually playing today
- Team size counters shown live during setup (Team A: X / Team B: X) and on the scoreboard once an innings starts
- Simple tap-to-assign team selection (no drag-and-drop) — tap "Team A" or "Team B" next to each attending player
- Dedicated "Common Player" dropdown below team assignment for a shared player who plays both sides; their win/loss cancels out for matches where this applies
- Half-over support: overs limits and retirement thresholds accept decimals (e.g. 3.5 overs = 3 overs + 3 balls)
- Simplified match start: just pick who bats first — opening batsman and bowler are chosen via a quick popup right when the innings begins
- Auto-retirement after N overs, plus a manual "Retire Batsman" button — retired batsmen return once everyone else has batted
- After every wicket or manual retirement, prompted to select the next batsman
- Automatic prompt to pick the next bowler when an over completes — soft-blocks the same bowler from being pre-selected for consecutive overs (still selectable manually if needed)
- Innings-completion detection: when overs run out or the side is all out, a modal prompts you to start the next innings (fixed a bug where the next-batsman popup was overriding this after the final wicket)
- Wide auto-scores 1 run instantly; No Ball opens a run-selector and shows the exact extra on the live ball tracker (e.g. "Nb+2")
- No byes/leg byes
- Detailed dismissal capture (bowled/caught/run-out/stumped + fielder), fall-of-wickets, extras breakdown
- Match result (win/loss/tie) recording
- Leaderboard tab: Overall Leaderboard (from uploaded PDFs), Live-Tracked Leaderboard (from matches scored in-app), and a password-protected admin panel for uploading/deleting stats PDFs
- Strike rate shown as whole numbers throughout
- Dates shown as plain YYYY-MM-DD, no timestamps
- Polished iOS-style UI: gradient scoreboard, pill-styled striker/bowler selectors, bottom tab bar, bottom-sheet modals
- About page (landing screen footer link): what the app is, and a link to the GitHub repo — free to fork/self-host
- Anonymous usage stats in the admin console: distinct devices active now, plus historic counts (today/7d/30d/all-time + daily breakdown) — no names or accounts, just a random per-browser device ID

## Stack
Node.js + Express + PostgreSQL, containerized with Docker Compose. PDF parsing via `pdf-parse`, file uploads via `multer`.

## Project structure
```
indoor-cricket-app/
├── Dockerfile
├── docker-compose.yml
├── package.json
├── .env.example
├── public/            (index.html, app.js — iOS-style UI)
└── src/
    ├── server.js
    ├── db/
    │   ├── schema.sql
    │   ├── seed_players.example.sql  (template — copy to seed_players.sql to use)
    │   ├── pool.js
    │   └── init.js
    ├── logic/rotation.js
    ├── logic/usageTracking.js
    └── routes/
        ├── players.js
        ├── matches.js
        ├── scoring.js
        ├── stats.js
        └── leaderboardUpload.js
```

## Pre-loaded roster
Player names aren't hardcoded into the app — `src/db/seed_players.sql` is gitignored, so a
fresh clone of this repo boots with an empty roster rather than someone else's friend group.
To pre-seed your own: copy `src/db/seed_players.example.sql` to `src/db/seed_players.sql`,
edit in your own names, then (re)build. Or skip it entirely and add players anytime via Setup
in the app itself.

## Deploy on your Proxmox VM

### 1. Prepare the VM (first time only)
```bash
ssh ubuntu@<vm-ip>
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker
```

### 2. Transfer the package
```bash
scp indoor-cricket-app-v6-final.zip ubuntu@<vm-ip>:/home/ubuntu/
ssh ubuntu@<vm-ip>
unzip -o indoor-cricket-app-v6-final.zip -d indoor-cricket-app
cd indoor-cricket-app
```

### 3. Build and run
This round changed backend innings-creation logic (striker_id/bowler_id now optional) and admin
password checks — no destructive schema change, but a clean rebuild is recommended:
```bash
docker compose down -v
docker compose up -d --build
```

### 4. Access the app
Open `http://<vm-ip>:3000`. Add to home screen for an app-like feel.

### 5. Using the app
1. **Setup tab**: tick attendance, tap "Team A"/"Team B" next to each attending player to assign them, pick a Common Player if one exists, set overs (decimals allowed), and create the match.
2. **Start the Match**: choose who bats first and tap Start Innings — you'll then be asked to confirm the opening batsman and bowler right on the Live Score screen.
3. **Live Score tab**: score deliveries; Wide is instant, No Ball prompts for exact extra runs (shown on the tracker), Wicket prompts for dismissal + fielder then the next batsman. Use "Retire Batsman" anytime. Bowler-change prompt appears automatically each over-end, and an innings-complete prompt appears when overs run out or the side is all out.
4. **Leaders tab**: view Overall (uploaded) and Live-Tracked leaderboards. Tap "⚙ Manage uploads" to reveal the password-protected admin panel for uploading weekly PDFs or deleting batches.
5. **Stats tab**: match history (date-only), daily stats, overall stats with win/loss and win%.

### 6. Admin password for leaderboard uploads
Default password is `cricket123`. Override it by setting an environment variable in `docker-compose.yml`:
```yaml
environment:
  - LEADERBOARD_ADMIN_PASSWORD=your_new_password
```

### 7. Expose remotely via Cloudflare Tunnel (optional)
```yaml
ingress:
  - hostname: cricket.yourdomain.com
    service: http://<vm-ip>:3000
  - service: http_status:404
```

### 8. Backups
```bash
docker exec indoor-cricket-db pg_dump -U cricket cricketdb > cricket_backup_$(date +%F).sql
```

## API quick reference
- `POST /api/players` — add player `{name, is_common_player}`
- `POST /api/matches` — create match + split teams
- `POST /api/matches/:matchId/innings` — start an innings `{innings_no, batting_team, bowling_team}` (striker/bowler set separately)
- `POST /api/matches/innings/:inningsId/change-batsman` / `change-bowler`
- `POST /api/innings/:inningsId/ball` — score a ball `{runs, extra_type, extra_runs, is_wicket, wicket_type, fielder_id}`
- `POST /api/innings/:inningsId/retire-striker`
- `POST /api/matches/innings/:inningsId/complete` — mark innings completed
- `POST /api/matches/:matchId/complete` — record match result `{winner_team, result_summary}`
- `GET /api/innings/:inningsId/scorecard`, `GET /api/innings/:inningsId/over/:overNo/balls`, `GET /api/innings/:inningsId/eligible-batsmen`
- `GET /api/stats/daily`, `GET /api/stats/overall`, `GET /api/stats/matches-history`, `GET /api/stats/leaderboard`
- `POST /api/leaderboard/upload` — password-protected PDF upload (multipart: file, source_label, admin_password)
- `GET /api/leaderboard/uploads`, `GET /api/leaderboard/aggregate`
- `DELETE /api/leaderboard/uploads/:label`, `DELETE /api/leaderboard/all` — password-protected (admin_password query param)
- `GET /api/admin/usage-stats` — admin-token-protected; distinct-device counts (active now, today, 7d, 30d, all-time, daily breakdown)
