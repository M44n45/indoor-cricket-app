v0.993 UPDATE — Confirm before repeating the same bowler back-to-back
========================================================================
Added a confirmation prompt when the bowler picked for the next over is
the same one who just bowled the over that ended — covers both the plain
"over complete" bowler picker and the "wicket & over complete" combined
batsman+bowler picker (they're two separate modals in the code, same
underlying situation). Picking any other bowler still submits immediately
with no prompt, same as before.

Implementation: new shared confirmSameBowlerIfNeeded() helper, gated on a
new state.pendingOverBowlerId (the bowler who just finished their over),
called right before the change-bowler API request fires in both
confirmNextBowler() and confirmNextBatsmanAndBowler(). Cancelling leaves
the modal open with no request sent, so the scorer can pick someone else.

Bumped: app.js cache-busting query string to ?v=84, sw.js CACHE_NAME to
v23.

(public/app.js, public/index.html, public/sw.js)

v0.992 UPDATE — Watch Live: completed match showed no scorecard
=================================================================
Fixed: opening a completed (or abandoned) match from Watch Live — e.g. via
"Earlier completed matches" or a shared match link — showed the winner
banner ("Team A won") but the score, overs, batting and bowling tables
stayed on their empty placeholder state (0/0, 0.0 ov, no rows).

Root cause: refreshWatchScorecard() (public/app.js) branches early for
matches with status 'completed'/'abandoned' — it sets the winner banner,
stops polling, and `return`s. But all the code that actually fetches the
innings scorecard and renders score/overs/batting/bowling/fall-of-wickets
lives *after* that branch, so it never ran for a completed match. The
scoreboard shell (built fresh by ensureWatchScorecardShell()) was left on
its static default markup the whole time.

Fix: removed the early `return`. The banner still shows and polling still
stops (since a completed match's result won't change), but execution now
falls through to fetch current-innings + /scorecard and render the final
state, exactly as it already does for in-progress matches. No other
behavior changes — in-progress matches are unaffected.

Bumped: app.js cache-busting query string to ?v=83, sw.js CACHE_NAME to
v22.

(public/app.js, public/index.html, public/sw.js)

UPDATE - FILES CHANGED THIS ROUND
==================================

Files touched:
1. public/index.html       -> watch-live template: added Ball by Ball Recap card
2. public/app.js           -> Watch Live fixes, admin password gate, delete wiring
3. src/db/schema.sql       -> new admin_settings table
4. src/server.js           -> mounted new /api/admin routes
5. src/routes/admin.js     -> NEW FILE: password setup/login + admin token middleware
6. src/routes/matches.js   -> NEW: DELETE /api/matches/:matchId (admin-token protected)
7. src/routes/scoring.js   -> shared computeOversRecap() helper; scorecard endpoint
                               now returns overs_recap; full-scorecard endpoint
                               reuses the same helper instead of duplicating it

WHAT CHANGED

1) Fall of Wickets on Watch Live was always blank ("1 - ()")
   The render code referenced f.runs / f.over, but the API returns
   team_score_at_fall / over_at_fall (plus the player's name via a join).
   Fixed to render as "1-14 (Kailas, 1.0 ov)".

2) Ball-by-ball recap added to Watch Live
   The /innings/:id/scorecard endpoint never actually returned ball_events,
   so "This Over" was silently always empty too. Both "This Over" and the
   new "Ball by Ball Recap" card now come from a proper overs_recap array
   (same per-over grouping logic already used by the Scorecard tab's
   full-scorecard endpoint — pulled into one shared computeOversRecap()
   helper so the two views can't drift out of sync again).

3) Admin console "Delete" button
   There was no DELETE route for a match at all. Added
   DELETE /api/matches/:matchId — deletes the match row; every dependent
   row (match_players, innings, batting/bowling records, ball_events,
   fall_of_wickets) cascades via the existing ON DELETE CASCADE foreign
   keys, so nothing needs cleaning up manually.

4) Admin console password protection
   New src/routes/admin.js: GET /api/admin/status, POST /api/admin/setup
   (first-time only), POST /api/admin/login. Passwords are hashed with
   scrypt + a random salt (admin_settings table, one row) — never stored
   in plaintext. A successful login/setup returns a short-lived token
   (4h) that the browser caches in sessionStorage and sends as
   x-admin-token on admin-only calls. The Delete endpoint requires this
   token; other existing endpoints (match complete/status used by normal
   scoring) were intentionally left as-is since they're shared with the
   regular scoring flow, not admin-only actions.
   First time anyone opens the admin console (gear icon), they're asked
   to set a password. After that, opening the console asks for it again
   — once per browser session.

DEPLOY NOTES
- No new npm dependencies were added (password hashing uses Node's
  built-in crypto module).
- The new admin_settings table is created automatically on next boot via
  the existing schema.sql migration path in src/db/init.js — no manual
  DB steps needed.
v0.65 UPDATE
=============
Fixed: Continue Scoring (admin console) left the fielder dropdown empty on
a caught/run-out/stumped dismissal.

Root cause: continueScoring() called loadPlayers(), which resets
state.teamAIds / teamBIds / commonPlayerIds to empty (it's built for the
Setup screen's fresh-match player picker, not for restoring an existing
match's roster). The fielder dropdown is built from state.currentBowlingTeamIds,
which is derived from those now-empty arrays -> no options.

Fix: added GET /api/matches/:matchId/players (src/routes/matches.js),
returning the match's real team assignments from match_players.
continueScoring() now calls it right after loadPlayers() and repopulates
teamAIds/teamBIds/commonPlayerIds from the DB before computing
currentBowlingTeamIds.

v0.66 UPDATE
=============
Match History (Stats tab) redesigned to match the Watch Live card style,
grouped by month and day.

Backend: GET /api/stats/matches-history now also returns match_name and
each match's per-innings scores (src/routes/stats.js), so history cards
can show final scores instead of just win/loss text.

Frontend (public/app.js, public/index.html):
- Replaced the old <table id="history-table"> with a card grid
  (#history-container), reusing the same .watch-match-card /
  .watch-card-grid styling as the Watch Live match picker.
- Matches are grouped into day buckets, with a month divider header
  whenever the month changes ("August 2026", "July 2026", ...).
- Only the single most recent day's matches are expanded by default;
  every other day shows a clickable header (date + match count) that
  expands/collapses that day's cards via toggleHistoryDay().

v0.67 UPDATE
=============
Fixed: clicking a match card in Match History opened the Scorecard tab but
always showed the latest match, not the one clicked.

Root cause: showView('scorecard') always kicks off loadMatchListForScorecard()
(async), which repopulates the dropdown and defaults it to the newest match.
openMatchScorecard() was setting the dropdown to the clicked match
synchronously *before* that async load finished — so the async load's
default selection ran afterwards and silently overwrote it. Classic race
condition, not visible from reading either function in isolation.

Fix: showView() and loadMatchListForScorecard() now take an optional
preferred match id. openMatchScorecard(matchId) passes it through, and
the dropdown is set to that match once, after the list finishes loading,
instead of being set twice by two competing code paths.

v0.68 UPDATE
=============
Scoring page (score-view):
- Added a "Ball by Ball Recap" card, same over-by-over pill layout as the
  Scorecard tab and Watch Live, right under "This Over". Uses the
  overs_recap already returned by /innings/:id/scorecard (added in v0.66),
  rendered via new renderScoreOversRecap().
- Moved "End Match / Record Result" and "Abandon Match" from between the
  Batting and Bowling tables down to the very bottom of the page, after
  Bowling.

v0.69 UPDATE — PWA WIRED UP
============================
Your project already had public/manifest.json, public/sw.js, and a full
icon set sitting there unused — none of it was actually linked from
index.html, and the service worker was never registered. Wired it up:

- index.html <head>: added <link rel="manifest">, theme-color meta,
  apple-touch-icon / apple-mobile-web-app meta tags (so "Add to Home
  Screen" gets a proper icon and standalone display on iOS too).
- app.js: registers /sw.js on window load; listens for
  beforeinstallprompt and shows a small floating "Install App" button
  (bottom-left, next to the admin gear) that triggers the native
  install prompt on Chrome/Edge/Android. Hides itself once installed.
- sw.js: bumped CACHE_NAME to v3 so existing visitors' browsers pick up
  this update instead of serving a stale cached app shell.
- Bumped the app.js cache-busting query string to ?v=69.

Note: the beforeinstallprompt flow is Chrome/Edge/Android only — iOS
Safari has no install prompt API, users there still add via the Share
sheet, but now get a proper name/icon/standalone window when they do.

v0.92 — new app icon
======================
Replaced the placeholder icon (a plain yellow circle with a red seam
on a green gradient) across icon-192.png, icon-512.png,
icon-512-maskable.png and apple-touch-icon.png with a proper cricket
bat-and-ball design on the same green gradient background, so it
matches the app's existing colour scheme. Also fixed the old files
actually being JPEGs saved with a .png extension — they're now real
PNGs.

Checked the maskable variant against a circular crop (Android
adaptive icon shape) to confirm the artwork stays inside the safe
zone.

Bumped sw.js CACHE_NAME to v8 so existing installs pick up the new
icon (icons are in the service worker's precache list).

v0.91.1 — remove stray "Select Other Match" from scoring view
================================================================
The active scorer's "score-view" had a leftover "Select Other Match"
button (id="watch-select-other-match-btn", wired to
backToWatchMatchList()) that belonged to the spectator "watch-view"
only. Since watch-view builds its own copy of that same id
dynamically, this also meant the page briefly had two elements
sharing one id — and ensureWatchScorecardShell()'s existence check
could find the scoring view's copy and wrongly conclude the watch
shell was already built.

Removed the button from score-view entirely. The scorer no longer
sees a "Select Other Match" control while actively scoring; watch
mode's own button is untouched.

Bumped sw.js CACHE_NAME to v7 so existing installs pick up the
updated markup.

v0.91 — "This Over" ball readability fix
=========================================
The scoring page's "This Over" strip and the Ball by Ball Recap were
both built from a class named .ball-pill, but two separate, conflicting
.ball-pill CSS rules existed in index.html. The Recap's version (white
pill, dark text, purple boundary / red wicket) was declared later in
the stylesheet, so it silently overrode the *text colour* of the This
Over version — while This Over's own colour-coded backgrounds (blue
for a run, purple six, orange extra, etc.) stayed active. Net result:
dark grey text on dark/coloured pills in This Over, which was hard to
read.

Fix:
- Rewrote renderThisOverBalls() in app.js to build pills the same way
  the recap does — plain pill by default, "boundary" for 4s/6s,
  "wicket" for a dismissal — so This Over now renders with identical
  box and text colours to the Ball by Ball Recap.
- Removed the now-unused first .ball-pill CSS block (and its .runs/
  .four/.six/.extra colour modifiers) from index.html so there's only
  one .ball-pill definition left to avoid this drifting apart again.

Bumped the visible version badge (topbar + landing page) to v0.91.

v0.9 — bowler economy fix
==========================
Economy was being calculated by dividing runs by the raw overs_bowled
value (e.g. runs_conceded / 1.4), but overs are stored in cricket
notation where 1.4 means "1 over, 4 balls" — not the decimal 1.4. That
made economy read too high any time a bowler's spell didn't end on a
whole over (e.g. 10 runs off 1.4 overs, i.e. 10 balls, showed 7.14
instead of the correct 6.00).

Fixed everywhere economy is computed:
- Scoring page bowling table and the post-match full scorecard
  (public/app.js): added a shared trueOvers()/calcEconomy() helper
  that converts cricket-notation overs to real decimal overs (balls/6)
  before dividing.
- Bowling leaderboard (/stats/overall in src/routes/stats.js): the SQL
  was also summing overs_bowled across multiple bowling_records rows
  as plain decimals, which is doubly wrong when aggregating more than
  one spell/match (e.g. 3.4 + 2.5 summed to 5.9 instead of the correct
  6.3). Rewrote it to convert each row to a ball count, sum balls, then
  derive both the displayed overs and the economy from the true total.
- /stats/player/:id: same ball-count fix applied to overs_bowled for
  consistency, even though economy isn't shown on the player card
  today.

Bumped app.js cache-busting query string to ?v=71 and sw.js
CACHE_NAME to v5.

v0.8 — scoring page layout + bowler extras
============================================
- Scoring page reorder: "Ball by Ball Recap" now sits after the "Score
  Ball" card instead of before it, so scoring controls come first.
- "Undo Last Ball" moved into the "Score Ball" card itself (it no
  longer sits alone under the striker/bowler pills). It's kept outside
  the disable-on-match-complete row so it stays usable once a match
  ends, per the existing "Match has ended. Only Undo is available."
  notice.
- Bowling tables (scoring page, and the post-match full scorecard) now
  show Maidens (M), Wides (Wd) and No Balls (Nb) alongside overs/runs/
  wickets/econ. These are computed live from ball_events on each
  request (not stored columns), so undo/replay can never leave them
  out of sync — no DB migration needed.
- Bumped app.js cache-busting query string to ?v=70 and sw.js
  CACHE_NAME to v4 so existing installs pick up the update.

v0.7 — version badge bump
==========================
No functional change — bumped the visible version badge (topbar +
landing page) from v0.64 to v0.7 to reflect everything accumulated in
this session (watch-live fixes, admin auth + delete, continue-scoring
fielder fix, match history redesign, scoring-page ball-by-ball recap,
and the PWA wiring).

v0.93 UPDATE
=============
1) Watch Live bowling table was missing Maidens/Wides/No-Balls
   The /scorecard endpoint already computed these (bowlerExtras), the
   Watch Live table just never rendered them. Header/row now match the
   Scoring page: Bowler | Ov | M | R | W | Wd | Nb | Econ.
   (public/app.js, public/index.html)

2) Fall of Wickets never showed who took the wicket
   fall_of_wickets query only joined the batsman's name. Added a join
   through batting_records (which already stores bowler_id/fielder_id/
   dismissal_type on dismissal) to bowler + fielder names, and a new
   formatDismissal() helper on the frontend. Now renders e.g.
   "1-14 (Kailas, b Robin, 1.0 ov)" with c/st/run-out formatting.
   (src/routes/scoring.js, public/app.js)

3) Match Setup: merged "Who's Playing Today?" + "Assign Teams" into a
   single searchable roster list. Each row has A/B/C buttons - tapping
   one adds the player to that team AND marks them as playing in one
   tap; tapping the active letter again removes them. Added a search
   box. Removes the old two-list, tick-then-find-again, tap-to-cycle
   flow. (public/index.html, public/app.js)

4) Bonus fix found while tracing #3: addPlayer() was calling
   loadPlayers(), which resets teamAIds/teamBIds/commonPlayerIds -
   adding a player mid-setup silently wiped out team assignments
   already made. addPlayer() now just refreshes the player list
   without touching current assignments.

Bumped app.js cache-busting query string to ?v=73, sw.js CACHE_NAME to
v9, and the visible version badge to v0.93.

v0.94 UPDATE
=============
Reworked Setup back into 2 explicit steps per feedback (the merged
single-list version from v0.93 combined ticking attendance with team
assignment into one action, but that's not how the workflow actually
runs):

Step 1 - "Who's Playing Today?" - tick everyone present from the full
roster (search box included). This is attendance only, no team yet.

Step 2 - "Assign Teams" - only players ticked in Step 1 appear here.
Tap A / B / C per player (C = the one shared Common Player, tapping
a new C automatically replaces any previous one). Tap an active
letter again to clear that player's assignment. Kept the explicit
A/B/C buttons from v0.93 instead of going back to the old blind
tap-to-cycle chip.

Un-ticking someone in Step 1 also clears any team assignment they
had in Step 2.

(public/index.html, public/app.js)

Bumped app.js cache-busting query string to ?v=74, sw.js CACHE_NAME to
v10, and the visible version badge to v0.94.

v0.95 UPDATE
=============
Step 2 "Assign Teams" reverted from one-row-per-player with A/B/C
buttons back to the original compact wrapping chip list (tap a name
to cycle unassigned -> Team A -> Team B -> Common -> unassigned).
The button-row version took too much vertical space with 15-20+
players ticked in Step 1. Step 1 (attendance ticking) is unchanged.
(public/index.html, public/app.js)

Bumped app.js cache-busting query string to ?v=75, sw.js CACHE_NAME to
v11, and the visible version badge to v0.95.

v0.96 UPDATE
=============
Admin console:
- Fixed button overflow: .btn-primary/.btn-secondary both force width:100%,
  which broke down badly with 3 buttons inline. Match rows now use a
  flex-wrap action row (title/status on its own line, buttons wrap on
  narrow screens instead of overflowing).
- "Continue Scoring" now also appears (as "Resume & Edit") for completed
  and abandoned matches, not just in_progress ones.
- Fixed a latent bug where state.matchIsComplete could still be true from
  a previous match when resuming a different/completed one, silently
  blocking all scoring input with no visible error. Reset on resume.

Floating admin gear icon:
- Root cause found: enterLeaderboardMode() and enterWatchMode() never
  hid the gear button, so entering Leaderboard mode directly from the
  landing page left the fixed bottom-right gear sitting on top of the
  rightmost tab icon (History). Both now hide it like every other mode
  entry point already did.

Stats tab -> renamed "Match History":
- Nav label/icon updated (🗓️ History). Page trimmed to just the match
  history cards; the old Daily Stats / Overall Stats tables were removed
  (that data now lives in the Leaders tab's new Day/Overall toggle).
- Now filtered to only completed/abandoned matches — in-progress matches
  no longer show up here (they belong in Watch Live / the scorer tabs).

Leaders tab -> Day / Overall toggle:
- New toggle above the existing Batting/Bowling sub-tabs. "Overall" is
  unchanged existing behavior. "Day" adds a date picker and calls
  GET /api/stats/leaderboard?date=YYYY-MM-DD (src/routes/stats.js),
  which scopes runs, wickets, win/loss, and even which players appear
  at all to matches played on that single day.

App renamed: Indoor Cricket -> CageCricket Live
- Updated: <title>, apple-mobile-web-app-title meta, topbar title (incl.
  the JS reset in backToModeSelect), landing page h1, manifest.json
  name/short_name ("CageCricket Live" / "CageCricket"), README.md, and
  the sw.js file header comment.

Bumped: app.js cache-busting query string to ?v=76, sw.js CACHE_NAME to
v12, visible version badge to v0.96.

v0.97 UPDATE — India jersey color theme
=========================================
Replaced the green theme with an India-cricket-jersey-inspired palette:
deep blue primary (#1e56c9 / #0b2f73 dark) with saffron/orange accents
(#ff9933), matching the current Team India kit.

- :root CSS variables updated (--primary, --primary-dark, --accent, --bg,
  --bg-light, --text, --border) — most of the UI recolors automatically
  since it's variable-driven.
- Manually recolored the remaining hardcoded greens: scoreboard gradient
  and text, primary button gradient/shadow, landing page hero gradient,
  landing version badge (now saffron), "common player" chips (now
  saffron instead of green, to stay distinct from the new blue primary),
  leaderboard batting-card accent, striker pill background, and a couple
  of stray green-tinted text colors sitting on the scoreboard.
- App icons (icon-192, icon-512, icon-512-maskable, apple-touch-icon)
  had a green gradient background baked into the PNGs themselves. Used a
  targeted HSV hue-shift (green hues -> blue, ~146° -> ~220°) to recolor
  just the background while leaving the bat/ball artwork's colors
  untouched — no manual redraw needed.
- manifest.json background_color/theme_color updated to match, plus
  <meta name="theme-color"> in index.html.
- Intentionally left alone: team-a/team-b chip colors (red/blue — these
  identify teams, not app branding) and the teamColorCss() name->color
  lookup in app.js (used when a team is literally named "Green", etc.)

Bumped: app.js cache-busting query string to ?v=77, sw.js CACHE_NAME to
v13 (important this time since cached icons changed too), visible
version badge to v0.97.

v0.98 UPDATE
=============
Fixed the topbar, which was still showing the old dark-green gradient
after the v0.97 color theme change. It had its own standalone
background:linear-gradient(...) not driven by the --primary/--bg CSS
variables, so it slipped past that pass. Changed to
linear-gradient(135deg,#0a1128,#12224d) to match the rest of the navy/
blue theme.

Bumped: app.js cache-busting query string to ?v=78, sw.js CACHE_NAME to
v14, visible version badge to v0.98.

v0.98 UPDATE (About page)
=============
Added an "About" entry to the landing screen alongside Score a Match /
Watch Live / Leaderboard & Stats. Opens a new about-view with a short
description of the app, an explicit "free and open to replicate" note,
and a link to the GitHub repo (https://github.com/M44n45/indoor-cricket-app).
Uses the existing "← Modes" topbar button to go back, same as the other
modes.

Bumped: app.js cache-busting query string to ?v=79, sw.js CACHE_NAME to
v15. Version badge left at v0.98 (no functional/scoring change).

v0.98 UPDATE (About link resized/relocated)
=============
Reworked the About entry per feedback: removed it as a full-size landing
card and replaced it with a small text link ("ℹ️ About") tucked under the
footer note, in line with normal placement for a secondary/meta page.
On the About view itself, moved the GitHub link out of a big primary
button and into a small "🔗 Source on GitHub" text link in the page
footer, matching how source-code links are usually presented (subtle,
not a primary call-to-action).

Bumped: sw.js CACHE_NAME to v16 (index.html changed). app.js itself is
unchanged this pass, so its cache-busting query string stays at ?v=79.

v0.98 UPDATE (Anonymous usage tracking)
=============
Added lightweight, anonymous device tracking to answer "how many people are
using this" — both historic and concurrent — without collecting any names,
and without risking the Render free-tier limits (750 free instance-hours/
month, 1GB/30-day Postgres).

How it works:
- Client generates a random UUID once (localStorage: cricketDeviceId) and
  sends it as an X-Device-Id header on API calls. No new network traffic
  was added for this — it rides along on requests the app already makes
  (button taps, live-score polling, page loads), so it can never keep a
  sleeping free-tier instance awake the way a dedicated heartbeat would.
- Server-side (src/logic/usageTracking.js) debounces writes to at most once
  per device per minute, then upserts into two new tables:
    - device_last_seen: ONE row per device, ever. Powers "active now" via
      last_seen > now() - 3 minutes.
    - device_visits: ONE row per device PER DAY. Powers historic distinct-
      device counts (today / 7d / 30d / all-time / daily breakdown).
  Both stay tiny regardless of traffic volume — nowhere close to the 1GB
  free Postgres cap.
- New GET /api/admin/usage-stats endpoint (password-protected, same admin
  token as the rest of the admin console).
- Admin Console now shows a Usage card: Active Now / Today / Last 7 Days /
  Last 30 Days / All Time, plus a 14-day daily breakdown table.

Known limitation: Render's free Postgres plan itself expires after 30 days
(14-day grace period) unless upgraded, so "all-time" history resets if that
ever happens — this is a property of the free DB plan, not something this
feature can work around.

Bumped: app.js cache-busting query string to ?v=80, sw.js CACHE_NAME to v17.

v0.98 UPDATE (Don't ship the real roster to GitHub)
=============
seed_players.sql (the actual player names) is now gitignored, so pushing
this repo to GitHub won't carry a specific group's roster along with it.

- .gitignore: added src/db/seed_players.sql
- Added src/db/seed_players.example.sql — a template with placeholder names
  and instructions (copy to seed_players.sql, edit, rebuild) for anyone who
  wants pre-seeded data on their own deploy.
- src/db/init.js: now checks whether seed_players.sql exists before reading
  it. If present (a real deployment with the real file, e.g. this one),
  behavior is unchanged — seeds on first boot as before. If absent (a fresh
  GitHub clone), it logs a note and starts with an empty roster instead of
  throwing — players can always be added via the Setup screen.
- No Docker/build changes needed: `COPY . .` in the Dockerfile copies
  whatever's in the local build context regardless of .gitignore, so this
  deployment's local seed_players.sql keeps working exactly as before.
  Only `git push` stops carrying it.

No public/ files touched this pass, so no cache-busting version bump needed.
