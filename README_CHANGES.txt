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
