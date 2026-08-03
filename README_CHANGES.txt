v0.32 UPDATE - FILES TO REPLACE
================================

This package contains 3 updated files. Copy each one into your project,
overwriting the existing file at the same path:

1. public/index.html      -> replaces public/index.html
2. public/app.js          -> replaces public/app.js
3. src/routes/scoring.js  -> replaces src/routes/scoring.js

WHAT CHANGED:
- Version badge updated from v31 to v0.32 (topbar + landing page)
- New "Leaderboard & Stats" card added to the landing page
- New ball-by-ball recap section added to the Full Scorecard view,
  showing per-over pills (runs/wickets/boundaries) like a cricket
  scoring app, using your existing ball_events table.

DEPLOY STEPS (PowerShell):
  cd C:\cricket\indoor-cricket-app-package
  # copy these 3 files into place, overwriting originals
  git add -A
  git commit -m "v0.32: add leaderboard link, per-ball over recap, version format fix"
  git push
