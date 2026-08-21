const API = '/api';

// --- Anonymous device ID for usage tracking (no names/accounts — just a
// random ID generated once per browser and reused, so the admin console can
// count distinct devices). Stored in localStorage so it survives reloads.
function getDeviceId() {
  let id = localStorage.getItem('cricketDeviceId');
  if (!id) {
    id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : `dev-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    localStorage.setItem('cricketDeviceId', id);
  }
  return id;
}
// Tag every API call with the device ID without touching each fetch() call
// site individually. Piggybacks on requests the app is already making —
// no separate heartbeat/polling loop, so this never keeps a sleeping Render
// free-tier instance awake by itself.
(function tagFetchWithDeviceId() {
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.startsWith(API)) {
      init = { ...init, headers: { ...(init.headers || {}), 'X-Device-Id': getDeviceId() } };
    }
    return originalFetch(input, init);
  };
})();

let state = {
  players: [], matchId: null, inningsId: null,
  swipeQueue: [], swipeIndex: 0, teamAIds: [], teamBIds: [],
  teamACaptainId: null, teamBCaptainId: null,
  pendingExtraType: null,
  appMode: null, watchPollInterval: null, watchMatchId: null, watchInningsId: null, watchMatch: null,
  inningsCompletionHandled: false, overCompletedPendingBowlerChoice: null, lastOversCompleted: undefined, matchIsComplete: false,
  isOffline: !navigator.onLine,
  watchEventInningsId: undefined, watchEventOverNo: null, watchEventBallCount: 0
};

function scoringIsAllowed() {
  return !!state.matchId && !!state.inningsId && !state.matchIsComplete;
}

function ensureScoringAllowed() {
  if (!state.matchId) {
    alert('Select a match first before scoring.');
    return false;
  }
  if (!state.inningsId) {
    alert('Start the innings first before scoring.');
    return false;
  }
  if (state.matchIsComplete) {
    alert('Match has ended. Start a new match to continue scoring.');
    return false;
  }
  return true;
}

function updateScoringControls() {
  const badge = document.getElementById('score-match-status-badge');
  if (scoringIsAllowed()) {
    if (badge) badge.style.display = 'none';
    unlockScoringControls();
    return;
  }

  let badgeMessage = 'Match has ended. Only Undo is available.';
  if (!state.matchId) {
    badgeMessage = 'Select a match first to start scoring.';
  } else if (!state.inningsId) {
    badgeMessage = 'Start the innings first to enable scoring.';
  } else if (state.matchIsComplete) {
    badgeMessage = 'Match has ended. Start a new match to continue.';
  }

  if (badge) {
    badge.innerText = badgeMessage;
    badge.style.display = 'block';
  }

  lockScoringControls(state.matchIsComplete);
}

// ---- Offline coordination layer ----
// Wraps the scoring-critical API calls so they queue to IndexedDB when the
// network is down and replay automatically when connectivity is restored.
// Non-scoring reads (leaderboard, stats, watch) are allowed to fail gracefully.

function updateOfflineBanner() {
  const offline = document.getElementById('offline-banner');
  const sync = document.getElementById('sync-banner');
  if (!offline) return;
  if (state.isOffline) {
    offline.style.display = 'block';
    if (sync) sync.style.display = 'none';
    refreshOfflineQueueCount();
  } else {
    offline.style.display = 'none';
  }
}

async function refreshOfflineQueueCount() {
  if (!window.OfflineDB) return;
  const q = await OfflineDB.getQueue();
  const countEl = document.getElementById('offline-queue-count');
  if (!countEl) return;
  if (q.length > 0) {
    countEl.innerText = `${q.length} pending`;
    countEl.style.display = 'inline';
  } else {
    countEl.style.display = 'none';
  }
}

async function triggerSync() {
  if (!window.OfflineDB) return;
  const q = await OfflineDB.getQueue();
  if (q.length === 0) return;
  const syncBanner = document.getElementById('sync-banner');
  if (syncBanner) syncBanner.style.display = 'block';
  try {
    await OfflineDB.syncQueue();
  } catch (_) {}
  if (syncBanner) syncBanner.style.display = 'none';
  refreshOfflineQueueCount();
  // Refresh the live scorecard after syncing so the server state is displayed
  if (state.inningsId) {
    state.inningsCompletionHandled = false;
    await refreshScorecard(true);
  }
}

window.addEventListener('online', async () => {
  state.isOffline = false;
  updateOfflineBanner();
  await triggerSync();
});

window.addEventListener('offline', () => {
  state.isOffline = true;
  updateOfflineBanner();
});

// Offline-safe version of fetch for scoring mutations:
// - When online: behaves exactly like fetch, also caches the response for reads
// - When offline: queues the action and returns a synthetic response from cache
async function apiFetch(url, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : null;

  // Always try the network first if we're online
  if (!state.isOffline) {
    try {
      const res = await fetch(url, opts);
      // Opportunistically cache successful GET scorecard responses
      if (res.ok && method === 'GET' && window.OfflineDB) {
        const clone = res.clone();
        clone.json().then(data => {
          if (url.includes('/scorecard')) {
            const inningsIdMatch = url.match(/\/innings\/(-?\d+)\/scorecard/);
            if (inningsIdMatch) OfflineDB.cacheSet(`scorecard_${inningsIdMatch[1]}`, data);
          }
          if (url.includes('/players') && !url.includes('/stats')) {
            OfflineDB.cacheSet('players', data);
          }
        }).catch(() => {});
      }
      return res;
    } catch (err) {
      // Network failure mid-request — fall through to offline handling
      state.isOffline = true;
      updateOfflineBanner();
    }
  }

  // --- Offline path ---
  if (!window.OfflineDB) {
    return new Response(JSON.stringify({ error: 'Offline and no local cache available.' }), { status: 503 });
  }

  // Reads: serve from cache
  if (method === 'GET') {
    if (url.includes('/scorecard')) {
      const m = url.match(/\/innings\/(-?\d+)\/scorecard/);
      if (m) {
        const cached = await OfflineDB.cacheGet(`scorecard_${m[1]}`);
        if (cached) return new Response(JSON.stringify(cached), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    }
    if (url.includes('/players') && !url.includes('/stats')) {
      // Use in-memory state first (same session), then fall back to IndexedDB cache
      if (state.players && state.players.length > 0) {
        return new Response(JSON.stringify(state.players), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const cached = await OfflineDB.cacheGet('players');
      if (cached && cached.length > 0) {
        return new Response(JSON.stringify(cached), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      // Nothing cached at all — return empty array so the UI renders cleanly
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.match(/\/matches\/(-?\d+)\/players$/)) {
      const cached = await OfflineDB.cacheGet('current_roster');
      if (cached) return new Response(JSON.stringify(cached), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ team_a_player_ids: [], team_b_player_ids: [], common_player_ids: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.match(/\/matches\/(-?\d+)\/current-innings$/)) {
      const cached = await OfflineDB.cacheGet('current_innings');
      if (cached) return new Response(JSON.stringify(cached), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify(null), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.match(/\/matches$/) && method === 'GET') {
      // Return the cached current match as a one-item list so admin console can show it
      const cached = await OfflineDB.cacheGet('current_match');
      if (cached) return new Response(JSON.stringify([cached]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/eligible-batsmen')) {
      const m = url.match(/\/innings\/(-?\d+)\/eligible-batsmen/);
      if (m) {
        const ids = await OfflineDB.offlineEligibleBatsmen(parseInt(m[1]));
        return new Response(JSON.stringify({ eligible_player_ids: ids }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    }
    if (url.includes('/current-innings')) {
      const cached = await OfflineDB.cacheGet('current_innings');
      if (cached) return new Response(JSON.stringify(cached), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.match(/\/matches\/(-?\d+)$/)) {
      const cached = await OfflineDB.cacheGet('current_match');
      if (cached) return new Response(JSON.stringify(cached), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    // Fallback for other GETs — return empty/offline error
    return new Response(JSON.stringify({ error: 'offline' }), { status: 503 });
  }

  // Mutations: score a ball
  if (url.match(/\/innings\/(-?\d+)\/ball$/) && method === 'POST') {
    const m = url.match(/\/innings\/(-?\d+)\/ball$/);
    const inningsId = parseInt(m[1]);
    const result = await OfflineDB.offlineScoreBall(inningsId, body);
    await OfflineDB.enqueue(url, method, body, null);
    refreshOfflineQueueCount();
    if (!result) return new Response(JSON.stringify({ error: 'No cached innings data' }), { status: 503 });
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Mutations: retire striker
  if (url.match(/\/innings\/(-?\d+)\/retire-striker$/) && method === 'POST') {
    const m = url.match(/\/innings\/(-?\d+)\/retire-striker$/);
    await OfflineDB.offlineRetireStriker(parseInt(m[1]));
    await OfflineDB.enqueue(url, method, body, null);
    refreshOfflineQueueCount();
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Mutations: undo — not supported offline (queue must stay ordered)
  if (url.match(/\/innings\/(-?\d+)\/undo$/) && method === 'POST') {
    alert('Undo is not available while offline. It will work once you reconnect.');
    return new Response(JSON.stringify({ error: 'Undo not available offline' }), { status: 503 });
  }

  // Mutations: change batsman
  if (url.match(/\/innings\/(-?\d+)\/change-batsman$/) && method === 'POST') {
    const m = url.match(/\/innings\/(-?\d+)\/change-batsman$/);
    body.new_striker_id = normalizeNullableInt(body.new_striker_id);
    await OfflineDB.offlineChangeBatsman(parseInt(m[1]), body.new_striker_id);
    await OfflineDB.enqueue(url, method, body, null);
    refreshOfflineQueueCount();
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Mutations: change bowler
  if (url.match(/\/innings\/(-?\d+)\/change-bowler$/) && method === 'POST') {
    const m = url.match(/\/innings\/(-?\d+)\/change-bowler$/);
    body.new_bowler_id = normalizeNullableInt(body.new_bowler_id);
    await OfflineDB.offlineChangeBowler(parseInt(m[1]), body.new_bowler_id);
    await OfflineDB.enqueue(url, method, body, null);
    refreshOfflineQueueCount();
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Mutations: create match
  if (url.match(/\/matches$/) && method === 'POST') {
    const tempId = OfflineDB.nextTempId();
    const syntheticMatch = {
      id: tempId,
      match_date: new Date().toISOString().slice(0, 10),
      team_a_name: body.team_a_name || 'Team A',
      team_b_name: body.team_b_name || 'Team B',
      match_name: body.match_name || `${body.team_a_name} vs ${body.team_b_name}`,
      overs_limit: body.overs_limit || 8,
      retirement_overs: body.retirement_overs || 2,
      status: 'setup'
    };
    await OfflineDB.cacheSet('current_match', syntheticMatch);
    await OfflineDB.enqueue(url, method, body, tempId);
    refreshOfflineQueueCount();
    return new Response(JSON.stringify(syntheticMatch), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Mutations: start innings
  if (url.match(/\/matches\/(-?\d+)\/innings$/) && method === 'POST') {
    const matchId = parseInt(url.match(/\/matches\/(-?\d+)\/innings$/)[1]);
    const tempId = OfflineDB.nextTempId();
    const cachedMatch = await OfflineDB.cacheGet('current_match') || {};
    const syntheticInnings = {
      id: tempId,
      match_id: matchId,
      innings_no: body.innings_no || 1,
      batting_team: body.batting_team,
      bowling_team: body.bowling_team,
      total_runs: 0, total_wickets: 0, overs_completed: 0, total_legal_balls: 0,
      wide_runs: 0, no_ball_runs: 0,
      striker_id: null, bowler_id: null,
      status: 'in_progress',
      _overs_limit: cachedMatch.overs_limit || 8
    };
    await OfflineDB.cacheSet('current_innings', syntheticInnings);
    // Build empty scorecard for this innings using current roster
    const battingTeam = body.batting_team;
    const battingIds = battingTeam === 'A' ? [...(state.teamAIds || []), ...(state.commonPlayerIds || [])]
                                           : [...(state.teamBIds || []), ...(state.commonPlayerIds || [])];
    const bowlingIds = battingTeam === 'A' ? [...(state.teamBIds || []), ...(state.commonPlayerIds || [])]
                                           : [...(state.teamAIds || []), ...(state.commonPlayerIds || [])];
    const toPlayer = id => ({ id, name: nameOf(id) });
    await OfflineDB.offlineInitScorecard(
      tempId, syntheticInnings,
      battingIds.map(toPlayer), bowlingIds.map(toPlayer),
      cachedMatch.overs_limit || 8
    );
    await OfflineDB.enqueue(url, method, body, tempId);
    refreshOfflineQueueCount();
    return new Response(JSON.stringify(syntheticInnings), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Mutations: complete innings / match / status — just queue, synthetic OK response
  if (method === 'POST') {
    await OfflineDB.enqueue(url, method, body, null);
    refreshOfflineQueueCount();
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({ error: 'offline' }), { status: 503 });
}

// overs_bowled from the API is in cricket notation (e.g. 3.4 = 3 overs + 4
// balls, NOT a base-10 decimal). Dividing runs by that value directly
// undercounts the true overs bowled whenever balls-into-the-over is nonzero,
// so economy must go through this conversion first.
function trueOvers(cricketOvers) {
  const n = parseFloat(cricketOvers) || 0;
  const oversInt = Math.floor(n);
  const balls = Math.round((n - oversInt) * 10);
  return oversInt + balls / 6;
}

function calcEconomy(runsConceded, cricketOvers) {
  const overs = trueOvers(cricketOvers);
  return overs > 0 ? (runsConceded / overs).toFixed(2) : '0.00';
}

// Formats a fall-of-wickets / dismissal entry (expects dismissal_type,
// bowler_name, fielder_name fields, e.g. from the /scorecard fall_of_wickets rows)
// into standard cricket notation: "b Robin", "c Sameer b Robin", "st Sameer b Robin",
// "run out (Sameer)".
function formatDismissal(f) {
  const type = f.dismissal_type;
  if (!type) return '';
  if (type === 'caught') return `c ${f.fielder_name || 'sub'} b ${f.bowler_name || 'unknown'}`;
  if (type === 'stumped') return `st ${f.fielder_name || 'sub'} b ${f.bowler_name || 'unknown'}`;
  if (type === 'run_out') return `run out${f.fielder_name ? ' (' + f.fielder_name + ')' : ''}`;
  if (type === 'bowled') return `b ${f.bowler_name || 'unknown'}`;
  return f.bowler_name ? `b ${f.bowler_name}` : type;
}

// Per-batsman "How Out" cell text for a batting_records row (expects status,
// dismissal_type, bowler_name, fielder_name — present on rows returned by
// the /scorecard and /full-scorecard endpoints). Reuses formatDismissal()
// for the actual "c X b Y" / "run out (X)" wording.
// Comma-joined list of every batsman who faced a ball in an over (falls back
// to the single batsman_name field for older cached data that predates the
// batsmen_names array).
function formatOverBatsmen(over) {
  if (Array.isArray(over.batsmen_names) && over.batsmen_names.length) return over.batsmen_names.join(', ');
  return over.batsman_name || '';
}

function formatHowOut(b) {
  if (b.status === 'out') return formatDismissal(b) || 'out';
  if (b.status === 'retired') return 'retired';
  if (b.status === 'batting') return 'not out';
  return '';
}

// Renders a standard-format batting table body: batter name with the
// dismissal on a second line underneath (e.g. "c Fielder b Bowler"), plus
// trailing Extras and Total summary rows. `extras` is the {byes, leg_byes,
// wides, no_balls} object from the scorecard/full-scorecard endpoints;
// `totalLabel` is the pre-formatted "187/6 (20.0 ov, RR 9.35)" string.
function renderStandardBattingRows(batting, extras, totalLabel) {
  const rows = batting.map(b => {
    const sr = b.balls_faced > 0 ? ((b.runs / b.balls_faced) * 100).toFixed(1) : '0.0';
    const howOut = formatHowOut(b);
    const nameLabel = `${b.name}${b.is_captain ? ' (C)' : ''}`;
    return `<tr><td>${nameLabel}${howOut ? `<span class="dismissal-sub">${howOut}</span>` : ''}</td><td>${b.runs}</td><td>${b.balls_faced}</td><td>${b.fours}</td><td>${b.sixes}</td><td>${sr}</td></tr>`;
  }).join('');
  const extrasText = extras
    ? `${extras.total} (b ${extras.byes}, lb ${extras.leg_byes}, w ${extras.wides}, nb ${extras.no_balls})`
    : '0';
  const extrasRow = `<tr class="batting-extras-row"><td>Extras</td><td colspan="5">${extrasText}</td></tr>`;
  const totalRow = totalLabel ? `<tr class="batting-total-row"><td>Total</td><td colspan="5">${totalLabel}</td></tr>` : '';
  return rows + extrasRow + totalRow;
}


function updateTeamCountChips() {
  const a = document.getElementById('team-a-count-chip');
  const b = document.getElementById('team-b-count-chip');
  const c = document.getElementById('common-count-chip');
  if (a) a.innerText = `Team A: ${state.teamAIds.length}`;
  if (b) b.innerText = `Team B: ${state.teamBIds.length}`;
  if (c) c.innerText = `Common: ${state.commonPlayerIds.length}`;
}

async function addPlayer() {
  const nameInput = document.getElementById('player-name');
  const name = nameInput.value.trim();
  if (!name) return;
  const isCommon = document.getElementById('is-common').checked;
  await apiFetch(`${API}/players`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ name, is_common_player: isCommon })
  });
  nameInput.value = '';
  document.getElementById('is-common').checked = false;
  // Refresh the roster list only - don't touch attendance/team state,
  // otherwise adding a player mid-setup would silently wipe out selections made so far.
  const res = await apiFetch(`${API}/players`);
  state.players = await res.json();
  renderAttendanceList();
  renderTeamAssignList();
}

async function undoLastBall() {
  if (!state.inningsId) {
    alert('No active innings selected to undo.');
    return;
  }
  const res = await apiFetch(`${API}/innings/${state.inningsId}/undo`, { method: 'POST' });
  const result = await res.json();
  if (result.error) {
    alert(result.error);
    return;
  }
  state.inningsCompletionHandled = false;
  state.overCompletedPendingBowlerChoice = null;
  state.lastOversCompleted = undefined;
  state.matchIsComplete = false;
  unlockScoringControls();
  closeExtraModal();
  await refreshScorecard(true);
}

// ---- Player stat card modal ----

async function showPlayerCard(playerId) {
  const res = await fetch(`${API}/stats/player/${playerId}`);
  if (!res.ok) return;
  const d = await res.json();
  const initial = d.player.name.charAt(0).toUpperCase();

  const container = document.getElementById('player-card-container');
  container.innerHTML = `
    <div class="player-card-overlay" onclick="if(event.target===this) closePlayerCard()">
      <div class="player-card">
        <div class="player-card-header">
          <div class="player-card-avatar">${initial}</div>
          <p class="player-card-name">${d.player.name}</p>
        </div>
        <div class="player-card-grid">
          <div class="player-card-stat"><div class="value">${d.matches_played}</div><div class="label">Matches</div></div>
          <div class="player-card-stat"><div class="value">${d.total_runs}</div><div class="label">Runs</div></div>
          <div class="player-card-stat"><div class="value">${d.high_score}</div><div class="label">High</div></div>
          <div class="player-card-stat"><div class="value">${d.average}</div><div class="label">Average</div></div>
          <div class="player-card-stat"><div class="value">${d.strike_rate}</div><div class="label">Strike Rate</div></div>
          <div class="player-card-stat"><div class="value">${d.wickets}</div><div class="label">Wickets</div></div>
        </div>
        <button class="player-card-close" onclick="closePlayerCard()">Close</button>
      </div>
    </div>`;
}

function closePlayerCard() {
  document.getElementById('player-card-container').innerHTML = '';
}

// ---- Scorer / Watcher mode selection ----

function enterScorerMode() {
  state.appMode = 'scorer';
  document.getElementById('mode-select-view').style.display = 'none';
  document.getElementById('watch-view').style.display = 'none';
  document.getElementById('main-tabbar').style.display = 'flex';
  document.getElementById('share-watch-btn').style.display = state.matchId ? 'block' : 'none';
  const gear = document.getElementById('floating-admin-gear');
  if (gear) gear.style.display = 'none';
  const dateInput = document.getElementById('match-date');
  if (dateInput && !dateInput.value) dateInput.value = new Date().toLocaleDateString('en-CA');
  resetSetupPanelsForNewMatch();
  showView('setup');
  loadPlayers();
}

// Puts the Setup screen back into its pre-match-creation state: the
// attendance/team-assignment steps are shown again and the "match created"
// cards (teams summary, captains, schedule-later, start-match) are hidden.
// Used both when first entering Scorer mode and when the user wants to set
// up another match right after creating one, without leaving the screen.
function resetSetupPanelsForNewMatch() {
  state.matchId = null;
  state.teamACaptainId = null;
  state.teamBCaptainId = null;
  state.editingFromScore = false;
  const attendance = document.getElementById('attendance-assign-section');
  const addPlayer = document.getElementById('add-player-section');
  const teamsSummary = document.getElementById('teams-summary-card');
  const captainsCard = document.getElementById('captains-card');
  const editToggle = document.getElementById('edit-teams-toggle-card');
  const scheduleLater = document.getElementById('schedule-later-card');
  const startInnings = document.getElementById('start-innings-card');
  const matchStatus = document.getElementById('match-status');
  const matchName = document.getElementById('match-name');
  const shareBtn = document.getElementById('share-watch-btn');
  const backBtn = document.getElementById('back-to-score-btn');
  if (attendance) attendance.style.display = 'block';
  if (addPlayer) addPlayer.style.display = 'block';
  if (teamsSummary) teamsSummary.style.display = 'none';
  if (captainsCard) captainsCard.style.display = 'none';
  if (editToggle) editToggle.style.display = 'none';
  if (scheduleLater) scheduleLater.style.display = 'none';
  if (startInnings) startInnings.style.display = 'none';
  if (matchStatus) matchStatus.innerText = '';
  if (matchName) matchName.value = '';
  if (shareBtn) shareBtn.style.display = 'none';
  if (backBtn) backBtn.style.display = 'none';
  resetTossUI(null);
  toggleMatchSettings(false);
  updateCreateMatchButtonLabel();
}

// Called from the "Schedule Another Match" button that appears right after
// a match is created — lets the scorer set up several matches back-to-back
// (e.g. a whole night's fixture list) without bouncing back to the mode
// select screen in between.
function scheduleAnotherMatch() {
  resetSetupPanelsForNewMatch();
  loadPlayers();
  document.getElementById('match-status').innerText = 'Ready to set up your next match.';
  window.scrollTo(0, 0);
}

function enterLeaderboardMode() {
  state.appMode = 'scorer';
  document.getElementById('mode-select-view').style.display = 'none';
  document.getElementById('watch-view').style.display = 'none';
  document.getElementById('main-tabbar').style.display = 'flex';
  document.getElementById('share-watch-btn').style.display = 'none';
  const gear = document.getElementById('floating-admin-gear');
  if (gear) gear.style.display = 'none';
  showView('leaderboard');
}

function enterWatchMode() {
  state.appMode = 'watcher';
  document.getElementById('mode-select-view').style.display = 'none';
  document.getElementById('main-tabbar').style.display = 'none';
  const shareBtn = document.getElementById('share-watch-btn');
  if (shareBtn) shareBtn.style.display = 'block';
  document.getElementById('setup-view').style.display = 'none';
  document.getElementById('score-view').style.display = 'none';
  document.getElementById('leaderboard-view').style.display = 'none';
  document.getElementById('stats-view').style.display = 'none';
  document.getElementById('watch-view').style.display = 'block';
  document.getElementById('topbar-title').innerText = 'Live Match';
  const gear = document.getElementById('floating-admin-gear');
  if (gear) gear.style.display = 'none';
  promptWatchMatchSelection();
}

function enterAboutMode() {
  state.appMode = 'about';
  document.getElementById('mode-select-view').style.display = 'none';
  document.getElementById('watch-view').style.display = 'none';
  document.getElementById('main-tabbar').style.display = 'none';
  document.getElementById('share-watch-btn').style.display = 'none';
  document.getElementById('about-view').style.display = 'block';
  document.getElementById('topbar-title').innerText = 'About';
  const gear = document.getElementById('floating-admin-gear');
  if (gear) gear.style.display = 'none';
}

function backToModeSelect() {
  if (state.watchPollInterval) clearInterval(state.watchPollInterval);
  hideWatchEventOverlay();
  state.appMode = null;
  state.adminOpen = false;
  document.getElementById('watch-view').style.display = 'none';
  document.getElementById('setup-view').style.display = 'none';
  document.getElementById('score-view').style.display = 'none';
  document.getElementById('leaderboard-view').style.display = 'none';
  document.getElementById('stats-view').style.display = 'none';
  document.getElementById('scorecard-view').style.display = 'none';
  const aboutView = document.getElementById('about-view');
  if (aboutView) aboutView.style.display = 'none';
  const av = document.getElementById('admin-view');
  if (av) { av.style.display = 'none'; av.innerHTML = ''; }
  const gear = document.getElementById('floating-admin-gear');
  if (gear) gear.style.display = 'block';
  document.getElementById('main-tabbar').style.display = 'none';
  document.getElementById('share-watch-btn').style.display = 'none';
  document.getElementById('topbar-title').innerText = 'CageCricket Live';
  document.getElementById('mode-select-view').style.display = 'block';
}


async function promptWatchMatchSelection() {
  const urlParams = new URLSearchParams(window.location.search);
  const matchIdFromUrl = urlParams.get('match');
  if (matchIdFromUrl) {
    state.watchInningsId = null;
    state.watchMatchId = parseInt(matchIdFromUrl);
    await resolveWatchInnings();
    startWatchPolling();
    return;
  }
  const res = await fetch(`${API}/matches`);
  const matches = await res.json();
  const liveMatches = matches.filter(m => m.status === 'in_progress').sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const completedMatches = matches.filter(m => m.status === 'completed' || m.status === 'abandoned')
    .sort((a, b) => new Date(b.match_date || b.created_at || b.updated_at || 0) - new Date(a.match_date || a.created_at || a.updated_at || 0));
  const scheduledMatches = matches.filter(m => m.status === 'setup')
    .sort((a, b) => new Date(`${a.match_date || a.created_at}T${a.match_time || '00:00'}`) - new Date(`${b.match_date || b.created_at}T${b.match_time || '00:00'}`));

  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const todayCompleted = completedMatches.filter((m) => {
    const rawDate = m.match_date || m.created_at;
    if (!rawDate) return true;
    const matchDate = new Date(rawDate);
    if (Number.isNaN(matchDate.getTime())) return true;
    return `${matchDate.getFullYear()}-${String(matchDate.getMonth() + 1).padStart(2, '0')}-${String(matchDate.getDate()).padStart(2, '0')}` === todayKey;
  });
  const olderCompleted = completedMatches.filter(m => !todayCompleted.some(c => c.id === m.id));

  const scheduledCardsHtml = scheduledMatches.map(m => {
    const title = m.match_name || `${m.team_a_name} vs ${m.team_b_name}`;
    const teamA = m.team_a_name || 'Team A';
    const teamB = m.team_b_name || 'Team B';
    const aColor = teamColorCss(teamA, '#ef4444');
    const bColor = teamColorCss(teamB, '#3b82f6');
    const whenBits = [formatDateOnly(m.match_date), m.match_time].filter(Boolean);
    const whenLine = whenBits.length ? whenBits.join(' &middot; ') : 'Date TBC';
    const tossLine = m.toss_winner_team
      ? `🪙 ${m.toss_winner_team === 'A' ? teamA : teamB} won the toss, chose to ${m.toss_decision}`
      : 'Toss not done yet';
    return `
      <div class="watch-match-card" style="cursor:default;">
        <div class="watch-card-top">
          <div class="watch-team-stack">
            <div class="watch-team-row"><span class="watch-team-dot" style="background:${aColor}"></span><span class="watch-team-name">${teamA}</span></div>
            <div class="watch-team-row"><span class="watch-team-dot" style="background:${bColor}"></span><span class="watch-team-name">${teamB}</span></div>
          </div>
          <div class="watch-score-stack">
            <div class="watch-card-overs" style="font-weight:700;">Scheduled</div>
          </div>
        </div>
        <div class="watch-card-title">${title}</div>
        <div class="watch-card-bottom">${whenLine}</div>
        <div class="watch-card-bottom">${tossLine}</div>
      </div>`;
  }).join('');

  const renderMatchCard = async (m, kind = 'live') => {
    let score = kind === 'completed' ? 'Final' : 'Starting';
    let overs = '';
    let liveLine = '';
    try {
      const inningsRes = await fetch(`${API}/matches/${m.id}/current-innings`);
      const innings = inningsRes.ok ? await inningsRes.json() : null;
      if (innings) {
        const wkts = innings.total_wickets ?? innings.wickets ?? 0;
        const runs = innings.total_runs ?? innings.runs ?? 0;
        const ov = innings.overs_completed ?? innings.overs ?? 0;
        score = `${runs}/${wkts}`;
        overs = `${ov} ov`;
        liveLine = innings.innings_no === 2 ? 'Chase in progress' : 'Live score';
        if (kind === 'completed') {
          if (m.result_summary) {
            liveLine = m.result_summary;
          } else if (m.winner_team === 'A') {
            liveLine = `${m.team_a_name || 'Team A'} won`;
          } else if (m.winner_team === 'B') {
            liveLine = `${m.team_b_name || 'Team B'} won`;
          } else if (m.winner_team === 'tie') {
            liveLine = 'Match tied';
          } else {
            liveLine = 'Completed';
          }
        } else if (innings.innings_no === 2 && innings.id) {
          try {
            const scRes = await fetch(`${API}/innings/${innings.id}/scorecard`);
            const scData = scRes.ok ? await scRes.json() : null;
            const target = scData && scData.first_innings ? scData.first_innings.target : null;
            if (target != null) {
              const needRuns = Math.max(target - runs, 0);
              liveLine = `Target ${target} &middot; Need ${needRuns}`;
            }
          } catch (e) {}
        }
      } else if (kind === 'completed') {
        if (m.result_summary) {
          liveLine = m.result_summary;
        } else if (m.winner_team === 'A') {
          liveLine = `${m.team_a_name || 'Team A'} won`;
        } else if (m.winner_team === 'B') {
          liveLine = `${m.team_b_name || 'Team B'} won`;
        } else if (m.winner_team === 'tie') {
          liveLine = 'Match tied';
        } else {
          liveLine = 'Completed';
        }
      }
    } catch (e) {}
    const title = m.match_name || `${m.team_a_name} vs ${m.team_b_name}`;
    const teamA = m.team_a_name || 'Team A';
    const teamB = m.team_b_name || 'Team B';
    const aColor = teamColorCss(teamA, '#ef4444');
    const bColor = teamColorCss(teamB, '#3b82f6');
    return `
      <button class="watch-match-card" onclick="openWatchMatch(${m.id})">
        <div class="watch-card-top">
          <div class="watch-team-stack">
            <div class="watch-team-row"><span class="watch-team-dot" style="background:${aColor}"></span><span class="watch-team-name">${teamA}</span></div>
            <div class="watch-team-row"><span class="watch-team-dot" style="background:${bColor}"></span><span class="watch-team-name">${teamB}</span></div>
          </div>
          <div class="watch-score-stack">
            <div class="watch-card-score">${score}</div>
            <div class="watch-card-overs">${overs}</div>
          </div>
        </div>
        <div class="watch-card-title">${title}</div>
        <div class="watch-card-bottom">${liveLine || (kind === 'completed' ? 'Tap to review match' : 'Tap to view live score')}</div>
      </button>`;
  };

  const liveCards = await Promise.all(liveMatches.map(m => renderMatchCard(m, 'live')));
  const todayCompletedCards = await Promise.all(todayCompleted.map(m => renderMatchCard(m, 'completed')));
  const olderCompletedCards = await Promise.all(olderCompleted.map(m => renderMatchCard(m, 'completed')));

  document.getElementById('watch-view').innerHTML = `
    <div class="card" style="margin-top:24px;">
      <h2>Live Matches</h2>
      <p class="helper-text">Tap any match card to open the detailed live view.</p>
      ${liveCards.length ? `<div class="watch-card-grid">${liveCards.join('')}</div>` : '<p class="helper-text">No matches are in progress right now.</p>'}
    </div>
    ${todayCompletedCards.length ? `<div class="card" style="margin-top:12px;"><h2>Completed Today</h2><div class="watch-card-grid">${todayCompletedCards.join('')}</div></div>` : ''}
    ${olderCompletedCards.length ? `<details class="card" style="margin-top:12px;"><summary style="cursor:pointer; font-weight:700;">Earlier completed matches</summary><div class="watch-card-grid" style="margin-top:12px;">${olderCompletedCards.join('')}</div></details>` : ''}
    ${scheduledMatches.length ? `<div class="card" style="margin-top:12px;"><h2>Scheduled</h2><p class="helper-text">These matches are set up and waiting to start.</p><div class="watch-card-grid">${scheduledCardsHtml}</div></div>` : ''}`;
}

function openWatchMatch(matchId) {
  state.watchMatchId = parseInt(matchId);
  state.watchInningsId = null;
  const url = new URL(window.location.href);
  url.searchParams.set('match', matchId);
  history.replaceState({}, '', url.toString());
  resolveWatchInnings().then(() => startWatchPolling());
}


async function confirmWatchMatchPick() {
  const picked = document.getElementById('watch-match-picker').value;
  state.watchMatchId = parseInt(picked);
  state.watchInningsId = null;
  const url = new URL(window.location.href);
  url.searchParams.set('match', picked);
  history.replaceState({}, '', url.toString());
  resolveWatchInnings().then(() => startWatchPolling());
}

async function resolveWatchInnings() {
  const res = await fetch(`${API}/matches/${state.watchMatchId}`);
  const match = await res.json();
  state.watchMatch = match;
  // Find the latest innings for this match via matches-history isn't granular enough; use a direct query pattern:
  const inningsRes = await fetch(`${API}/matches/${state.watchMatchId}/current-innings`);
  if (inningsRes.ok) {
    const innings = await inningsRes.json();
    state.watchInningsId = innings ? innings.id : null;
  }
}

function startWatchPolling() {
  if (state.watchPollInterval) clearInterval(state.watchPollInterval);
  resetWatchEventTracking();
  refreshWatchScorecard();
  state.watchPollInterval = setInterval(refreshWatchScorecard, 4000);
}



// ---- Watch Live: pop-up commentary for fours, sixes and wickets ----
const WATCH_EVENT_PHRASES = {
  four: ["Cracking shot — FOUR!", "Finds the gap perfectly!", "Four more on the board!", "Races away to the boundary!", "Superb timing — FOUR!"],
  six: ["That's hit the roof!", "Into the stands — SIX!", "Massive hit — SIX!", "Out of the park!", "He's gone big — SIX!"],
  wicket: ["He's gone!", "Bowled him!", "Huge wicket!", "Gotcha, that's out!", "Big breakthrough!"]
};
let watchEventQueue = [];
let watchEventShowing = false;
let watchEventHideTimer = null;

function queueWatchEvent(type, label) {
  watchEventQueue.push({ type, label });
  processWatchEventQueue();
}

function processWatchEventQueue() {
  if (watchEventShowing || watchEventQueue.length === 0) return;
  watchEventShowing = true;
  const { type, label } = watchEventQueue.shift();
  renderWatchEventPopup(type, label);
  setTimeout(() => {
    watchEventShowing = false;
    processWatchEventQueue();
  }, 2500);
}

function renderWatchEventPopup(type, label) {
  let overlay = document.getElementById('watch-event-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'watch-event-overlay';
    overlay.className = 'watch-event-overlay';
    overlay.innerHTML = `<div class="watch-event-circle" id="watch-event-circle"></div><div class="watch-event-text" id="watch-event-text"></div>`;
    document.body.appendChild(overlay);
  }
  const circle = document.getElementById('watch-event-circle');
  const textEl = document.getElementById('watch-event-text');
  const phrases = WATCH_EVENT_PHRASES[type] || [];
  circle.className = `watch-event-circle ${type}`;
  circle.innerText = label;
  textEl.innerText = phrases.length ? phrases[Math.floor(Math.random() * phrases.length)] : '';
  overlay.classList.remove('show');
  void overlay.offsetWidth; // restart animation
  overlay.classList.add('show');
  if (watchEventHideTimer) clearTimeout(watchEventHideTimer);
  watchEventHideTimer = setTimeout(() => { overlay.classList.remove('show'); }, 2100);
}

function hideWatchEventOverlay() {
  watchEventQueue = [];
  watchEventShowing = false;
  if (watchEventHideTimer) clearTimeout(watchEventHideTimer);
  const overlay = document.getElementById('watch-event-overlay');
  if (overlay) overlay.classList.remove('show');
}

function resetWatchEventTracking() {
  state.watchEventInningsId = undefined;
  state.watchEventOverNo = null;
  state.watchEventBallCount = 0;
  hideWatchEventOverlay();
}

// Compares the latest over's balls against what we saw last poll and pops up
// a temporary "commentary" card for any new four, six or wicket.
function detectWatchEvents(inningsId, oversRecap) {
  const latest = oversRecap.length ? oversRecap[oversRecap.length - 1] : null;

  // First time we see this innings (page just opened / switched match): just
  // record where things stand, don't fire pop-ups for balls that already happened.
  if (state.watchEventInningsId !== inningsId) {
    state.watchEventInningsId = inningsId;
    state.watchEventOverNo = latest ? latest.over_no : null;
    state.watchEventBallCount = latest ? latest.balls.length : 0;
    return;
  }

  if (!latest) return;

  let newBalls = [];
  if (state.watchEventOverNo === latest.over_no) {
    if (latest.balls.length > state.watchEventBallCount) {
      newBalls = latest.balls.slice(state.watchEventBallCount);
    }
  } else {
    // Over has moved on since the last poll — treat every ball in the new
    // over as new (the rare ball that lands exactly on an over change may be
    // missed, which is an acceptable trade-off for a 4s poll).
    newBalls = latest.balls.slice();
  }

  state.watchEventOverNo = latest.over_no;
  state.watchEventBallCount = latest.balls.length;

  newBalls.forEach(b => {
    if (b.is_wicket) queueWatchEvent('wicket', 'W');
    else if (b.runs === 6 && !b.extra_type) queueWatchEvent('six', '6');
    else if (b.runs === 4 && !b.extra_type) queueWatchEvent('four', '4');
  });
}

function ensureWatchScorecardShell() {
  const view = document.getElementById('watch-view');
  if (!view) return false;
  const required = ['watch-select-other-match-btn','watch-batting-team','watch-overs-limit','watch-score','watch-overs','watch-crr','watch-striker-name','watch-striker-stats','watch-bowler-name','watch-bowler-stats','watch-this-over-balls','watch-overs-recap','watch-batting-table','watch-bowling-table','watch-first-innings-recap-card'];
  const existing = required.every(id => document.getElementById(id));
  if (!existing) {
    view.innerHTML = `
      <div class="scoreboard">
        <button id="watch-select-other-match-btn" class="btn btn-secondary btn-full" style="margin-bottom:10px; display:block;" onclick="backToWatchMatchList()">Select Other Match</button>
        <div id="watch-winner-banner" style="display:none; background:rgba(255,255,255,0.2); border-radius:10px; padding:10px 12px; margin-bottom:8px; font-weight:700; text-align:center;"></div>
        <div class="teams"><span id="watch-batting-team">Team A</span><span id="watch-players-count"></span><span id="watch-overs-limit"></span></div>
        <div class="runs" id="watch-score">0/0</div>
        <div class="meta"><span id="watch-overs">0.0 ov</span><span class="crr" id="watch-crr">CRR 0.00</span></div>
        <div class="target-row" id="watch-target-row" style="display:none; font-size:13px; margin-top:4px; opacity:0.9;">
          Need <span id="watch-need-runs">0</span> off <span id="watch-need-balls">0</span> balls &middot; RRR <span id="watch-rrr">0.00</span>
        </div>
        <div class="striker-score-row" id="watch-striker-row" style="margin-top:10px; background:rgba(255,255,255,0.15); border-radius:10px; padding:8px 12px;">
          <span id="watch-striker-name" style="font-weight:600; font-size:15px;">-</span>
          <span id="watch-striker-stats" style="float:right; font-size:15px;">0 (0) SR 0.0</span>
        </div>
        <div class="bowler-score-row" id="watch-bowler-row" style="margin-top:6px; background:rgba(255,255,255,0.1); border-radius:10px; padding:6px 12px; font-size:13px;">
          <span id="watch-bowler-name">-</span>
          <span id="watch-bowler-stats" style="float:right;">0-0 (0.0)</span>
        </div>
        <div class="first-innings-row" id="watch-first-innings-row" style="display:none; margin-top:6px; font-size:12.5px; opacity:0.85;">
          <span id="watch-first-innings-label">Team A</span>: <span id="watch-first-innings-score">0/0</span>
          <span id="watch-first-innings-toggle" onclick="toggleFirstInningsRecap()" style="float:right; text-decoration:underline; cursor:pointer;">View scorecard</span>
        </div>
      </div>
      <div id="watch-teams-container"></div>
      <div class="card" id="watch-first-innings-recap-card" style="display:none;">
        <h2 id="watch-fi-recap-title">Innings 1</h2>
        <table class="mini-table" id="watch-fi-batting-table"><thead><tr><th>Batsman</th><th>R</th><th>B</th><th>4s</th><th>6s</th><th>SR</th></tr></thead><tbody></tbody></table>
        <h3 style="margin-top:10px; font-size:13px; color:var(--sub);">Bowling</h3>
        <table class="mini-table" id="watch-fi-bowling-table"><thead><tr><th>Bowler</th><th>Ov</th><th>M</th><th>R</th><th>W</th><th>Wd</th><th>Nb</th><th>Econ</th></tr></thead><tbody></tbody></table>
        <h3 style="margin-top:10px; font-size:13px; color:var(--sub);">Fall of Wickets</h3>
        <div id="watch-fi-fow" style="font-size:12px; color:var(--sub); line-height:1.6;"></div>
        <h3 style="margin-top:10px; font-size:13px; color:var(--sub);">Ball by Ball Recap</h3>
        <div class="over-recap-container" id="watch-fi-overs-recap"></div>
      </div>
      <div class="card"><h2>This Over</h2><div class="balls-row" id="watch-this-over-balls"></div></div>
      <div class="card"><h2>Ball by Ball Recap</h2><div class="over-recap-container" id="watch-overs-recap"></div></div>
      <div class="card"><h2>Batting</h2><table id="watch-batting-table"><thead><tr><th>Batsman</th><th>R</th><th>B</th><th>4s</th><th>6s</th><th>SR</th></tr></thead><tbody></tbody></table></div>
      <div class="card"><h2>Bowling</h2><table id="watch-bowling-table"><thead><tr><th>Bowler</th><th>Ov</th><th>M</th><th>R</th><th>W</th><th>Wd</th><th>Nb</th><th>Econ</th></tr></thead><tbody></tbody></table></div>
      <div class="card"><h2>Fall of Wickets</h2><div id="watch-fow" style="font-size:12px; color:var(--sub); line-height:1.6;"></div></div>
      <div class="card" id="watch-back-to-list-card" style="display:none; text-align:center;">
        <button class="btn btn-primary btn-full" onclick="backToWatchMatchList()">Watch Another Match</button>
      </div>
    `;
  }
  return true;
}
function renderTeamsCard(containerId, teamAName, teamBName, teamAPlayers, teamBPlayers) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const bodyId = `${containerId}-roster-body`;
  const chevronId = `${containerId}-roster-chevron`;
  // Preserve open/closed state across re-renders (e.g. live polling) instead of
  // forcing it collapsed again every refresh.
  const existingBody = document.getElementById(bodyId);
  const wasExpanded = existingBody ? !existingBody.classList.contains('collapsed') : false;
  const totalCount = (teamAPlayers.length || 0) + (teamBPlayers.length || 0);
  const listHtml = (players) => players.length
    ? `<ul class="team-roster-list">${players.map(p => `<li class="clickable-name" onclick="showPlayerCard(${p.id})">${p.name}${p.is_captain ? ' <span class="captain-badge" title="Captain">(C)</span>' : ''}</li>`).join('')}</ul>`
    : '<p class="helper-text">No players listed.</p>';
  container.innerHTML = `
    <div class="card">
      <h2 class="roster-card-header" onclick="toggleRosterCard('${containerId}')">
        <span>Teams${totalCount ? ` (${totalCount})` : ''}</span>
        <span id="${chevronId}" class="roster-chevron${wasExpanded ? ' expanded' : ''}">▼</span>
      </h2>
      <div id="${bodyId}" class="roster-collapsible${wasExpanded ? '' : ' collapsed'}">
        <div class="team-roster-columns">
          <div class="team-roster-col">
            <h3 class="team-roster-heading">${teamAName || 'Team A'}</h3>
            ${listHtml(teamAPlayers)}
          </div>
          <div class="team-roster-col">
            <h3 class="team-roster-heading">${teamBName || 'Team B'}</h3>
            ${listHtml(teamBPlayers)}
          </div>
        </div>
      </div>
    </div>`;
  // Drive the collapse transition off the content's real height instead of
  // a large fixed max-height. A fixed max-height (e.g. 1000px) transitions
  // through mostly-empty range for any normal-sized roster, which reads as
  // the card not collapsing properly (a long pause, then a sudden snap)
  // rather than a smooth close.
  const body = document.getElementById(bodyId);
  if (body) body.style.maxHeight = wasExpanded ? `${body.scrollHeight}px` : '0px';
}

function toggleRosterCard(containerId) {
  const body = document.getElementById(`${containerId}-roster-body`);
  const chevron = document.getElementById(`${containerId}-roster-chevron`);
  if (!body) return;
  const collapsed = body.classList.toggle('collapsed');
  if (chevron) chevron.classList.toggle('expanded', !collapsed);
  body.style.maxHeight = collapsed ? '0px' : `${body.scrollHeight}px`;
}

async function loadTeamsForMatch(matchId, containerId, teamAName, teamBName) {
  const res = await fetch(`${API}/matches/${matchId}/players`);
  if (!res.ok) return;
  const data = await res.json();
  renderTeamsCard(containerId, teamAName, teamBName, data.team_a_players || [], data.team_b_players || []);
}

function renderWatchBallByBall(events) {
  const el = document.getElementById('watch-ball-by-ball');
  if (!el) return;
  if (!events || !events.length) {
    el.innerHTML = '<p class="helper-text">No balls recorded yet.</p>';
    return;
  }
  el.innerHTML = events.slice(-12).reverse().map(e => `<div class="ball-chip">${e.label || e.runs || ''}</div>`).join('');
}

async function refreshWatchScorecard() {
  if (!state.watchMatchId) return;
  if (!ensureWatchScorecardShell()) return;
  const matchRes = await fetch(`${API}/matches/${state.watchMatchId}`);
  if (!matchRes.ok) return;
  const matchFresh = await matchRes.json();
  state.watchMatch = matchFresh;

  if (state.watchTeamsMatchId !== state.watchMatchId) {
    state.watchTeamsMatchId = state.watchMatchId;
    loadTeamsForMatch(state.watchMatchId, 'watch-teams-container', matchFresh.team_a_name, matchFresh.team_b_name);
  }

  const banner = document.getElementById('watch-winner-banner');
  const selectBtn = document.getElementById('watch-select-other-match-btn');
  const backCard = document.getElementById('watch-back-to-list-card');
  const battingTeamEl = document.getElementById('watch-batting-team');
  const oversLimitEl = document.getElementById('watch-overs-limit');
  const scoreEl = document.getElementById('watch-score');
  const oversEl = document.getElementById('watch-overs');
  const crrEl = document.getElementById('watch-crr');
  const strikerNameEl = document.getElementById('watch-striker-name');
  const strikerStatsEl = document.getElementById('watch-striker-stats');
  const bowlerNameEl = document.getElementById('watch-bowler-name');
  const bowlerStatsEl = document.getElementById('watch-bowler-stats');
  const thisOverEl = document.getElementById('watch-this-over-balls');
  const battingBody = document.querySelector('#watch-batting-table tbody');
  const bowlingBody = document.querySelector('#watch-bowling-table tbody');
  const fowEl = document.getElementById('watch-fow');
  const oversRecapEl = document.getElementById('watch-overs-recap');
  const targetRow = document.getElementById('watch-target-row');
  const needRunsEl = document.getElementById('watch-need-runs');
  const needBallsEl = document.getElementById('watch-need-balls');
  const rrrEl = document.getElementById('watch-rrr');
  const firstInningsRow = document.getElementById('watch-first-innings-row');
  const firstInningsLabel = document.getElementById('watch-first-innings-label');
  const firstInningsScore = document.getElementById('watch-first-innings-score');

  if (selectBtn) selectBtn.style.display = 'block';

  if (matchFresh.status === 'completed' || matchFresh.status === 'abandoned') {
    if (banner) {
      let msg = 'Match ended';
      if (matchFresh.status === 'abandoned') msg = 'Match abandoned';
      else if (matchFresh.winner_team === 'A') msg = `${matchFresh.team_a_name} won`;
      else if (matchFresh.winner_team === 'B') msg = `${matchFresh.team_b_name} won`;
      else if (matchFresh.winner_team === 'tie') msg = 'Match tied';
      banner.innerText = msg;
      banner.style.display = 'block';
    }
    if (backCard) backCard.style.display = 'block';
    if (state.watchPollInterval) { clearInterval(state.watchPollInterval); state.watchPollInterval = null; }
    // Don't return here — a completed/abandoned match still has a final
    // innings with real batting/bowling/overs data that the code below
    // fetches and renders. Returning early left the scoreboard, batting
    // and bowling tables stuck on their empty shell defaults (0/0, no
    // rows) even though the match has a winner banner. Polling is
    // already stopped above since the result won't change further.
  }

  const inningsRes = await fetch(`${API}/matches/${state.watchMatchId}/current-innings`);
  if (!inningsRes.ok) return;
  const currentInnings = await inningsRes.json();
  state.watchInningsId = currentInnings ? currentInnings.id : null;
  if (!state.watchInningsId) return;

  const res = await fetch(`${API}/innings/${state.watchInningsId}/scorecard`);
  if (!res.ok) return;
  const data = await res.json();
  const innings = data.innings || {};
  const batting = Array.isArray(data.batting) ? data.batting : [];
  const bowling = Array.isArray(data.bowling) ? data.bowling : [];
  const fow = Array.isArray(data.fall_of_wickets) ? data.fall_of_wickets : [];
  const oversRecap = Array.isArray(data.overs_recap) ? data.overs_recap : [];
  detectWatchEvents(state.watchInningsId, oversRecap);
  const match = state.watchMatch || {};
  const runs = Number(innings.total_runs || 0);
  const wickets = Number(innings.total_wickets || 0);
  const oversCompleted = Number(innings.overs_completed || 0);
  const crrOvers = trueOvers(innings.overs_completed);
  const crr = crrOvers > 0 ? (runs / crrOvers).toFixed(2) : '0.00';

  if (battingTeamEl) battingTeamEl.innerText = innings.batting_team === 'A' ? (match.team_a_name || 'Team A') : (match.team_b_name || 'Team B');
  if (oversLimitEl) oversLimitEl.innerText = match.overs_limit ? `${match.overs_limit} ov limit` : '';
  if (scoreEl) scoreEl.innerText = `${runs}/${wickets}`;
  if (oversEl) oversEl.innerText = `${oversCompleted.toFixed(1)} ov`;
  if (crrEl) crrEl.innerText = `CRR ${crr}`;

  const striker = batting.find(p => p.player_id === innings.striker_id);
  if (striker) {
    const sr = striker.balls_faced > 0 ? ((striker.runs / striker.balls_faced) * 100).toFixed(1) : '0.0';
    if (strikerNameEl) strikerNameEl.innerText = striker.name;
    if (strikerStatsEl) strikerStatsEl.innerText = `${striker.runs} (${striker.balls_faced}) SR ${sr}`;
  } else {
    if (strikerNameEl) strikerNameEl.innerText = '-';
    if (strikerStatsEl) strikerStatsEl.innerText = '0 (0) SR 0.0';
  }

  const bowler = bowling.find(p => p.player_id === innings.bowler_id);
  if (bowler) {
    if (bowlerNameEl) bowlerNameEl.innerText = bowler.name;
    if (bowlerStatsEl) bowlerStatsEl.innerText = `${bowler.wickets}-${bowler.runs_conceded} (${bowler.overs_bowled})`;
  } else {
    if (bowlerNameEl) bowlerNameEl.innerText = '-';
    if (bowlerStatsEl) bowlerStatsEl.innerText = '0-0 (0.0)';
  }

  if (innings.innings_no === 2 && (match.first_innings_runs != null || data.first_innings)) {
    const fi = data.first_innings || {};
    if (firstInningsRow) firstInningsRow.style.display = 'block';
    if (firstInningsLabel) firstInningsLabel.innerText = fi.batting_team_name || fi.team_name || 'First Innings';
    if (firstInningsScore) firstInningsScore.innerText = `${fi.total_runs ?? match.first_innings_runs ?? 0}/${fi.total_wickets ?? match.first_innings_wickets ?? 0}`;
    if (targetRow) targetRow.style.display = 'block';
    const target = Number(fi.total_runs ?? match.first_innings_runs ?? 0) + 1;
    const needRuns = Math.max(target - runs, 0);
    const ballsLeft = Math.max((Number(match.overs_limit || 0) * 6) - Math.round(oversCompleted * 6), 0);
    if (needRunsEl) needRunsEl.innerText = String(needRuns);
    if (needBallsEl) needBallsEl.innerText = String(ballsLeft);
    if (rrrEl) rrrEl.innerText = ballsLeft > 0 ? (needRuns / (ballsLeft / 6)).toFixed(2) : '0.00';
    // Full first-innings stats/recap stay accessible via the "View scorecard"
    // toggle instead of disappearing once the second innings starts.
    state.watchFirstInnings = fi;
    renderFirstInningsRecap(fi);
  } else {
    if (firstInningsRow) firstInningsRow.style.display = 'none';
    if (targetRow) targetRow.style.display = 'none';
    state.watchFirstInnings = null;
    const recapCard = document.getElementById('watch-first-innings-recap-card');
    if (recapCard) recapCard.style.display = 'none';
  }

  const latestOver = oversRecap.length > 0 ? oversRecap[oversRecap.length - 1] : null;
  if (thisOverEl) thisOverEl.innerHTML = (latestOver ? latestOver.balls : []).map(b => `<div class="ball-chip">${b.display}</div>`).join('') || '<p class="helper-text">No balls recorded yet.</p>';
  if (battingBody) {
    const totalLabel = `${runs}/${wickets} (${oversCompleted.toFixed(1)} ov, RR: ${crr})`;
    battingBody.innerHTML = batting.length ? renderStandardBattingRows(batting, data.extras, totalLabel) : '<tr><td colspan="6">No batting data</td></tr>';
  }
  if (bowlingBody) bowlingBody.innerHTML = bowling.map(p => {
    const econ = calcEconomy(p.runs_conceded, p.overs_bowled);
    return `<tr><td>${p.name}</td><td>${p.overs_bowled}</td><td>${p.maidens || 0}</td><td>${p.runs_conceded}</td><td>${p.wickets}</td><td>${p.wides || 0}</td><td>${p.no_balls || 0}</td><td>${econ}</td></tr>`;
  }).join('') || '<tr><td colspan="8">No bowling data</td></tr>';
  if (fowEl) fowEl.innerHTML = fow.map(f => {
    const dismissal = formatDismissal(f);
    return `${f.wicket_no ?? ''}-${f.team_score_at_fall ?? ''} (${f.name || 'unknown'}${dismissal ? ', ' + dismissal : ''}, ${f.over_at_fall != null ? Number(f.over_at_fall).toFixed(1) : '0.0'} ov)`;
  }).join('<br>') || '<p class="helper-text">No wickets yet.</p>';
  if (oversRecapEl) {
    oversRecapEl.innerHTML = oversRecap.slice().reverse().map(over => {
      const pills = over.balls.map(b => {
        const cls = b.is_wicket ? 'ball-pill wicket' : (b.runs === 6 ? 'ball-pill six' : b.runs === 4 ? 'ball-pill four' : 'ball-pill');
        return `<span class="${cls}">${b.display}</span>`;
      }).join('');
      return `
        <div class="over-recap-row">
          <div class="over-recap-header">
            <span>Over ${over.over_no + 1} — <b>${over.bowler_name}</b> to ${formatOverBatsmen(over)}</span>
            <span class="over-recap-total">${over.runs} Runs, ${over.wickets} Wkt</span>
          </div>
          <div class="over-recap-balls">${pills}</div>
        </div>`;
    }).join('') || '<p class="helper-text">No balls recorded yet.</p>';
  }
}
function renderFirstInningsRecap(fi) {
  const titleEl = document.getElementById('watch-fi-recap-title');
  const battingBody = document.querySelector('#watch-fi-batting-table tbody');
  const bowlingBody = document.querySelector('#watch-fi-bowling-table tbody');
  const fowEl = document.getElementById('watch-fi-fow');
  const recapEl = document.getElementById('watch-fi-overs-recap');
  if (titleEl) titleEl.innerText = `Innings 1 — ${fi.team_name || 'Team'} (${fi.total_runs ?? 0}/${fi.total_wickets ?? 0})`;
  const batting = Array.isArray(fi.batting) ? fi.batting : [];
  const bowling = Array.isArray(fi.bowling) ? fi.bowling : [];
  const fow = Array.isArray(fi.fall_of_wickets) ? fi.fall_of_wickets : [];
  const oversRecap = Array.isArray(fi.overs_recap) ? fi.overs_recap : [];
  if (battingBody) {
    const fiCrr = trueOvers(fi.overs_completed) > 0 ? (Number(fi.total_runs || 0) / trueOvers(fi.overs_completed)).toFixed(2) : '0.00';
    const totalLabel = `${fi.total_runs ?? 0}/${fi.total_wickets ?? 0} (${Number(fi.overs_completed ?? 0).toFixed(1)} ov, RR: ${fiCrr})`;
    battingBody.innerHTML = batting.length ? renderStandardBattingRows(batting, fi.extras, totalLabel) : '<tr><td colspan="6">No batting data</td></tr>';
  }
  if (bowlingBody) bowlingBody.innerHTML = bowling.map(p => {
    const econ = calcEconomy(p.runs_conceded, p.overs_bowled);
    return `<tr><td>${p.name}</td><td>${p.overs_bowled}</td><td>${p.maidens || 0}</td><td>${p.runs_conceded}</td><td>${p.wickets}</td><td>${p.wides || 0}</td><td>${p.no_balls || 0}</td><td>${econ}</td></tr>`;
  }).join('') || '<tr><td colspan="8">No bowling data</td></tr>';
  if (fowEl) fowEl.innerHTML = fow.map(f => {
    const dismissal = formatDismissal(f);
    return `${f.wicket_no ?? ''}-${f.team_score_at_fall ?? ''} (${f.name || 'unknown'}${dismissal ? ', ' + dismissal : ''}, ${f.over_at_fall != null ? Number(f.over_at_fall).toFixed(1) : '0.0'} ov)`;
  }).join('<br>') || '<p class="helper-text">No wickets fell.</p>';
  if (recapEl) recapEl.innerHTML = oversRecap.slice().reverse().map(over => {
    const pills = over.balls.map(b => {
      const cls = b.is_wicket ? 'ball-pill wicket' : (b.runs === 6 ? 'ball-pill six' : b.runs === 4 ? 'ball-pill four' : 'ball-pill');
      return `<span class="${cls}">${b.display}</span>`;
    }).join('');
    return `
      <div class="over-recap-row">
        <div class="over-recap-header">
          <span>Over ${over.over_no + 1} — <b>${over.bowler_name}</b> to ${formatOverBatsmen(over)}</span>
          <span class="over-recap-total">${over.runs} Runs, ${over.wickets} Wkt</span>
        </div>
        <div class="over-recap-balls">${pills}</div>
      </div>`;
  }).join('') || '<p class="helper-text">No balls recorded.</p>';
}

function toggleFirstInningsRecap() {
  const card = document.getElementById('watch-first-innings-recap-card');
  const toggle = document.getElementById('watch-first-innings-toggle');
  if (!card) return;
  const showing = card.style.display !== 'none';
  card.style.display = showing ? 'none' : 'block';
  if (toggle) toggle.innerText = showing ? 'View scorecard' : 'Hide scorecard';
  if (!showing && state.watchFirstInnings) renderFirstInningsRecap(state.watchFirstInnings);
}

function backToWatchMatchList() {
  state.watchMatchId = null;
  state.watchInningsId = null;
  state.watchMatch = null;
  hideWatchEventOverlay();
  if (state.watchPollInterval) { clearInterval(state.watchPollInterval); state.watchPollInterval = null; }
  const banner = document.getElementById('watch-winner-banner');
  const backCard = document.getElementById('watch-back-to-list-card');
  const watchAnotherBtn = document.getElementById('watch-another-match-btn');
  if (banner) banner.style.display = 'none';
  if (backCard) backCard.style.display = 'none';
  if (watchAnotherBtn) watchAnotherBtn.style.display = 'none';
  const url = new URL(window.location.href);
  url.searchParams.delete('match');
  history.replaceState({}, '', url.toString());
  const view = document.getElementById('watch-view');
  if (view) view.innerHTML = '<div class="card" style="margin-top:24px; text-align:center;"><p class="helper-text" style="text-align:center;">Loading live matches...</p></div>';
  promptWatchMatchSelection();
}


function shareWatchLink() {
  const baseUrl = `${window.location.origin}${window.location.pathname}`;
  const url = `${baseUrl}?view=watch`;

  const copyLink = () => {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(() => {
        alert('Watch page link copied to clipboard:\n' + url);
      }).catch(() => {
        alert(url);
      });
      return;
    }
    alert(url);
  };

  if (navigator.share) {
    navigator.share({ title: 'Watch live matches', text: 'Open the live matches page', url }).catch(() => copyLink());
  } else {
    copyLink();
  }
}


function teamColorCss(name, fallback) {
  const map = {
    red: '#ef4444', blue: '#3b82f6', green: '#22c55e', yellow: '#eab308', orange: '#f97316', purple: '#a855f7', pink: '#ec4899', teal: '#14b8a6', indigo: '#6366f1', amber: '#f59e0b'
  };
  const key = String(name || '').trim().toLowerCase();
  return map[key] || fallback || '#64748b';
}

function backToModeSelectFromWatch() {
  if (state.watchPollInterval) { clearInterval(state.watchPollInterval); state.watchPollInterval = null; }
  hideWatchEventOverlay();
  state.watchMatchId = null;
  state.watchInningsId = null;
  state.watchMatch = null;
    const banner = document.getElementById('watch-winner-banner');
  const backBtn = document.getElementById('back-to-landing-btn');
  if (banner) banner.style.display = 'none';
  if (backBtn) backBtn.style.display = 'none';
  backToModeSelect();
}

function enterAdminConsole() {
  state.appMode = 'admin';
  document.getElementById('mode-select-view').style.display = 'none';
  document.getElementById('watch-view').style.display = 'none';
  document.getElementById('main-tabbar').style.display = 'none';
  document.getElementById('share-watch-btn').style.display = 'none';
  document.getElementById('setup-view').style.display = 'none';
  document.getElementById('score-view').style.display = 'none';
  document.getElementById('leaderboard-view').style.display = 'none';
  document.getElementById('stats-view').style.display = 'none';
  const av = document.getElementById('admin-view');
  if (av) av.style.display = 'block';
  const gear = document.getElementById('floating-admin-gear');
  if (gear) gear.style.display = 'none';
  document.getElementById('topbar-title').innerText = 'Admin Console';
  checkAdminAuth();
}

// Gate the admin console behind a password. First-ever visit: ask the user to
// set one. Afterwards: ask for it, once per browser session (token cached in
// sessionStorage so re-opening the console mid-session doesn't re-prompt).
async function checkAdminAuth() {
  const cachedToken = sessionStorage.getItem('adminToken');
  if (cachedToken) {
    state.adminToken = cachedToken;
    loadAdminConsole();
    return;
  }
  let configured = false;
  try {
    const res = await fetch(`${API}/admin/status`);
    const data = await res.json();
    configured = !!data.configured;
  } catch (_) {
    // Offline — can't reach server. Show login form so an existing admin can
    // still attempt to log in; don't show the setup form as it would just fail.
    configured = true;
  }
  if (configured) {
    renderAdminLoginForm();
  } else {
    renderAdminSetupForm();
  }
}

function renderAdminSetupForm() {
  const av = document.getElementById('admin-view');
  if (!av) return;
  av.innerHTML = `
    <div class="card" style="margin-top:24px; max-width:360px; margin-left:auto; margin-right:auto;">
      <h2>Set Admin Password</h2>
      <p class="helper-text">This is your first time opening the admin console. Choose a password to protect it going forward.</p>
      <input type="password" id="admin-setup-password" placeholder="New password" style="width:100%; margin-top:10px; padding:10px; border-radius:8px; border:1px solid #ddd; box-sizing:border-box;">
      <input type="password" id="admin-setup-password-confirm" placeholder="Confirm password" style="width:100%; margin-top:10px; padding:10px; border-radius:8px; border:1px solid #ddd; box-sizing:border-box;">
      <div id="admin-setup-error" style="color:#dc2626; font-size:12.5px; margin-top:6px; display:none;"></div>
      <button class="btn btn-primary btn-full" style="margin-top:12px;" onclick="submitAdminSetup()">Set Password</button>
      <button class="btn btn-secondary btn-full" style="margin-top:8px;" onclick="backToModeSelect()">Cancel</button>
    </div>`;
  const input = document.getElementById('admin-setup-password-confirm');
  if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAdminSetup(); });
}

async function submitAdminSetup() {
  const pwEl = document.getElementById('admin-setup-password');
  const pwConfirmEl = document.getElementById('admin-setup-password-confirm');
  const errEl = document.getElementById('admin-setup-error');
  const showError = (msg) => { if (errEl) { errEl.innerText = msg; errEl.style.display = 'block'; } };
  const pw = pwEl ? pwEl.value : '';
  const pwConfirm = pwConfirmEl ? pwConfirmEl.value : '';
  if (!pw || pw.length < 4) { showError('Password must be at least 4 characters.'); return; }
  if (pw !== pwConfirm) { showError('Passwords do not match.'); return; }
  const res = await fetch(`${API}/admin/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) });
  const data = await res.json();
  if (!res.ok) { showError(data.error || 'Could not set password.'); return; }
  state.adminToken = data.token;
  sessionStorage.setItem('adminToken', data.token);
  loadAdminConsole();
}

function renderAdminLoginForm() {
  const av = document.getElementById('admin-view');
  if (!av) return;
  av.innerHTML = `
    <div class="card" style="margin-top:24px; max-width:360px; margin-left:auto; margin-right:auto;">
      <h2>Admin Login</h2>
      <p class="helper-text">Enter the admin password to continue.</p>
      <input type="password" id="admin-login-password" placeholder="Password" style="width:100%; margin-top:10px; padding:10px; border-radius:8px; border:1px solid #ddd; box-sizing:border-box;">
      <div id="admin-login-error" style="color:#dc2626; font-size:12.5px; margin-top:6px; display:none;"></div>
      <button class="btn btn-primary btn-full" style="margin-top:12px;" onclick="submitAdminLogin()">Unlock</button>
      <button class="btn btn-secondary btn-full" style="margin-top:8px;" onclick="backToModeSelect()">Cancel</button>
    </div>`;
  const input = document.getElementById('admin-login-password');
  if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAdminLogin(); });
}

async function submitAdminLogin() {
  const pwEl = document.getElementById('admin-login-password');
  const errEl = document.getElementById('admin-login-error');
  const res = await fetch(`${API}/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pwEl ? pwEl.value : '' }) });
  const data = await res.json();
  if (!res.ok) {
    if (errEl) { errEl.innerText = data.error || 'Incorrect password.'; errEl.style.display = 'block'; }
    return;
  }
  state.adminToken = data.token;
  sessionStorage.setItem('adminToken', data.token);
  loadAdminConsole();
}


async function loadAdminConsole() {
  let matches = [];
  try {
    const res = await fetch(`${API}/matches`);
    if (res.ok) {
      matches = await res.json();
      // Cache the list so offline resume can find the active match
      if (window.OfflineDB && matches.length) {
        const active = matches.find(m => m.status === 'in_progress');
        if (active) OfflineDB.cacheSet('current_match', active);
      }
    } else {
      throw new Error('not ok');
    }
  } catch (_) {
    // Offline — try to show the cached active match
    if (window.OfflineDB) {
      const cached = await OfflineDB.cacheGet('current_match');
      if (cached) matches = [cached];
    }
  }
  const scheduledMatches = matches.filter(m => m.status === 'setup')
    .sort((a, b) => new Date(`${a.match_date || a.created_at}T${a.match_time || '00:00'}`) - new Date(`${b.match_date || b.created_at}T${b.match_time || '00:00'}`));
  const otherMatches = matches.filter(m => m.status !== 'setup');

  const scheduledRows = scheduledMatches.map(m => {
    const title = m.match_name || `${m.team_a_name} vs ${m.team_b_name}`;
    const whenBits = [formatDateOnly(m.match_date), m.match_time].filter(Boolean);
    const tossBit = m.toss_winner_team ? ` &middot; Toss done` : '';
    return `<div class="card admin-match-card" id="admin-match-card-${m.id}">
      <div class="admin-match-header">
        <div class="admin-match-title">${title}</div>
        <div class="helper-text">${whenBits.join(' &middot; ') || 'No date set'}${tossBit}</div>
      </div>
      <div class="admin-match-actions">
        <button class="btn btn-primary" onclick="continueScoring(${m.id})">Open &amp; Start</button>
        <button class="btn btn-secondary" onclick="startEditTeamNames(${m.id})">Edit Names</button>
        <button class="btn btn-secondary admin-btn-danger" onclick="deleteMatch(${m.id})">Delete</button>
      </div>
    </div>`;
  }).join('');

  const rows = otherMatches.sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).map(m => {
    const title = m.match_name || `${m.team_a_name} vs ${m.team_b_name}`;
    const canResume = m.status === 'in_progress' || m.status === 'completed' || m.status === 'abandoned';
    const resumeLabel = m.status === 'in_progress' ? 'Continue Scoring' : 'Resume & Edit';
    return `<div class="card admin-match-card" id="admin-match-card-${m.id}">
      <div class="admin-match-header">
        <div class="admin-match-title">${title}</div>
        <div class="helper-text">Status: <b>${m.status}</b></div>
      </div>
      <div class="admin-match-actions">
        ${m.status === 'in_progress' ? `<button class="btn btn-primary" onclick="markMatchCompleted(${m.id})">Mark Completed</button>` : ''}
        ${canResume ? `<button class="btn btn-secondary" onclick="continueScoring(${m.id})">${resumeLabel}</button>` : ''}
        <button class="btn btn-secondary" onclick="startEditTeamNames(${m.id})">Edit Names</button>
        ${m.status === 'completed' ? `<button class="btn btn-secondary" onclick="startFixPlayers(${m.id})">Fix Over</button>` : ''}
        <button class="btn btn-secondary admin-btn-danger" onclick="deleteMatch(${m.id})">Delete</button>
      </div>
    </div>`;
  }).join('');
  state.adminMatchesCache = matches;
  const gear = document.getElementById('floating-admin-gear');
  if (gear) gear.style.display = 'none';
  document.getElementById('admin-view').innerHTML = `
    <div id="admin-usage-card" class="card" style="margin-top:24px;"><p class="helper-text">Loading usage stats…</p></div>
    ${scheduledMatches.length ? `<div class="card"><h2>Scheduled Matches</h2><p class="helper-text">Set up in advance — do the toss and start these when ready.</p></div>${scheduledRows}` : ''}
    <div class="card"><div style="display:flex; justify-content:space-between; align-items:center; gap:12px;"><div><h2>Existing Matches</h2><p class="helper-text">Use this to force-match completion, resume a match to fix a mistake, or delete a match.</p></div><button class="btn btn-secondary" style="width:auto; flex:0 0 auto;" onclick="backToModeSelect()">Back</button></div>${rows || '<p class="helper-text">No matches found.</p>'}</div>`;
  loadAdminUsageStats();
}

async function loadAdminUsageStats() {
  const el = document.getElementById('admin-usage-card');
  if (!el) return;
  try {
    const res = await fetch(`${API}/admin/usage-stats`, { headers: { 'x-admin-token': state.adminToken || '' } });
    if (!res.ok) { el.innerHTML = '<p class="helper-text">Could not load usage stats.</p>'; return; }
    const d = await res.json();
    const dailyRows = (d.daily || []).map(r =>
      `<tr><td>${new Date(r.day).toISOString().slice(0,10)}</td><td>${r.devices}</td></tr>`
    ).join('') || '<tr><td colspan="2">No data yet</td></tr>';
    el.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <h2>Usage</h2>
        <button class="btn-small" onclick="loadAdminUsageStats()">↻ Refresh</button>
      </div>
      <p class="helper-text">Distinct devices, not accounts — anonymous, no names collected.</p>
      <div class="usage-stat-grid">
        <div class="usage-stat"><div class="value">${d.active_now}</div><div class="label">Active Now</div></div>
        <div class="usage-stat"><div class="value">${d.today}</div><div class="label">Today</div></div>
        <div class="usage-stat"><div class="value">${d.last_7_days}</div><div class="label">Last 7 Days</div></div>
        <div class="usage-stat"><div class="value">${d.last_30_days}</div><div class="label">Last 30 Days</div></div>
        <div class="usage-stat"><div class="value">${d.all_time}</div><div class="label">All Time</div></div>
      </div>
      <table class="mini-table">
        <thead><tr><th>Day</th><th>Devices</th></tr></thead>
        <tbody>${dailyRows}</tbody>
      </table>`;
  } catch (e) {
    el.innerHTML = '<p class="helper-text">Could not load usage stats.</p>';
  }
}

async function markMatchCompleted(matchId) {
  await fetch(`${API}/matches/${matchId}/complete`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ winner_team: 'tie', result_summary: 'Marked completed from admin console' }) });
  await loadAdminConsole();
}

function escapeHtmlAttr(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Swaps a match card into an inline "rename teams" form. Works for a match in
// any status (setup, in progress, or completed) — it's just fixing a label,
// not touching any scoring data.
function startEditTeamNames(matchId) {
  const match = (state.adminMatchesCache || []).find(m => m.id === matchId);
  if (!match) return;
  const card = document.getElementById(`admin-match-card-${matchId}`);
  if (!card) return;
  card.innerHTML = `
    <div class="admin-match-header">
      <div class="admin-match-title">Edit Team Names</div>
      <div class="helper-text">Update the names for this match.</div>
    </div>
    <input type="text" id="edit-team-a-name-${matchId}" class="field" value="${escapeHtmlAttr(match.team_a_name || 'Team A')}" placeholder="Team A name" style="margin-top:8px;">
    <input type="text" id="edit-team-b-name-${matchId}" class="field" value="${escapeHtmlAttr(match.team_b_name || 'Team B')}" placeholder="Team B name">
    <div id="edit-team-names-error-${matchId}" style="color:#dc2626; font-size:12.5px; margin-bottom:6px; display:none;"></div>
    <div class="admin-match-actions">
      <button class="btn btn-primary" onclick="saveEditTeamNames(${matchId})">Save</button>
      <button class="btn btn-secondary" onclick="loadAdminConsole()">Cancel</button>
    </div>`;
}

async function saveEditTeamNames(matchId) {
  const aEl = document.getElementById(`edit-team-a-name-${matchId}`);
  const bEl = document.getElementById(`edit-team-b-name-${matchId}`);
  const errEl = document.getElementById(`edit-team-names-error-${matchId}`);
  const teamAName = aEl ? aEl.value.trim() : '';
  const teamBName = bEl ? bEl.value.trim() : '';
  if (!teamAName || !teamBName) {
    if (errEl) { errEl.innerText = 'Both team names are required.'; errEl.style.display = 'block'; }
    return;
  }
  const res = await fetch(`${API}/matches/${matchId}/teams`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': state.adminToken || '' },
    body: JSON.stringify({ team_a_name: teamAName, team_b_name: teamBName })
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    if (errEl) { errEl.innerText = data.error || 'Could not save team names.'; errEl.style.display = 'block'; }
    return;
  }
  await loadAdminConsole();
}



// --- Fix Over (correct a completed match's per-over batting/bowling) ------
// Lets an admin fix a scoring error for one specific over — replace the
// bowler who bowled it, or the batter(s) who faced it — without touching
// any other over. Scoped to one innings at a time since that's how the
// underlying records are keyed.

async function startFixPlayers(matchId) {
  const card = document.getElementById(`admin-match-card-${matchId}`);
  if (!card) return;
  card.innerHTML = `<div class="admin-match-header"><div class="admin-match-title">Fix Over</div><div class="helper-text">Loading scorecard…</div></div>`;
  const [scorecardRes, playersRes] = await Promise.all([
    fetch(`${API}/matches/${matchId}/full-scorecard`),
    fetch(`${API}/players`)
  ]);
  const inningsList = await scorecardRes.json();
  const allPlayers = await playersRes.json();
  state.fixPlayersData = { matchId, innings: inningsList, allPlayers };
  renderFixPlayersPanel(matchId);
}

function fixPlayersOptionsHtml(allPlayers, excludeId) {
  return allPlayers
    .filter(p => p.id !== excludeId)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(p => `<option value="${p.id}">${escapeHtmlAttr(p.name)}</option>`)
    .join('');
}

function renderFixPlayersPanel(matchId) {
  const card = document.getElementById(`admin-match-card-${matchId}`);
  if (!card) return;
  const { innings } = state.fixPlayersData;
  if (!innings.length) {
    card.innerHTML = `<div class="admin-match-header"><div class="admin-match-title">Fix Over</div><div class="helper-text">No innings recorded for this match.</div></div>
      <div class="admin-match-actions"><button class="btn btn-secondary" onclick="loadAdminConsole()">Back</button></div>`;
    return;
  }
  const inningsHtml = innings.map(inn => {
    const teamLabel = inn.innings.batting_team === 'A' ? 'Team A' : 'Team B';
    const overOptions = (inn.overs_recap || [])
      .map(o => `<option value="${o.over_no}">Over ${o.over_no + 1} — ${escapeHtmlAttr(o.bowler_name)} to ${escapeHtmlAttr(o.batsman_name)}</option>`)
      .join('');
    return `
      <div style="margin-top:12px;">
        <div class="helper-text" style="font-weight:600;">${teamLabel} — Innings ${inn.innings.innings_no}</div>
        ${overOptions ? `
          <select id="fp-over-select-${inn.innings.id}" class="field" style="margin-top:6px;" onchange="loadOverFixUI(${matchId}, ${inn.innings.id}, this.value)">
            <option value="">— select an over —</option>
            ${overOptions}
          </select>
          <div id="fp-over-detail-${inn.innings.id}"></div>
        ` : '<div class="helper-text">No overs bowled yet.</div>'}
      </div>`;
  }).join('');
  card.innerHTML = `
    <div class="admin-match-header">
      <div class="admin-match-title">Fix Over</div>
      <div class="helper-text">Pick an over, then replace its bowler or batter — only that over changes, everything else stays as recorded.</div>
    </div>
    <div id="fix-players-error-${matchId}" style="color:#dc2626; font-size:12.5px; margin-top:6px; display:none;"></div>
    ${inningsHtml}
    <div class="admin-match-actions" style="margin-top:10px;">
      <button class="btn btn-secondary" onclick="loadAdminConsole()">Done</button>
    </div>`;
}

// Loads one over's ball-by-ball detail and renders a bowler-correction row
// plus one batter-correction row per distinct batter who faced that over
// (usually one, but a mid-over wicket means there can be two).
async function loadOverFixUI(matchId, inningsId, overNo) {
  const detailEl = document.getElementById(`fp-over-detail-${inningsId}`);
  if (!detailEl) return;
  if (overNo === '' || overNo === null || overNo === undefined) { detailEl.innerHTML = ''; return; }
  detailEl.innerHTML = '<div class="helper-text" style="margin-top:6px;">Loading over…</div>';
  const { allPlayers } = state.fixPlayersData;
  const res = await fetch(`${API}/innings/${inningsId}/over/${overNo}/balls`);
  const balls = await res.json();
  if (!balls.length) { detailEl.innerHTML = '<div class="helper-text" style="margin-top:6px;">No balls recorded for that over.</div>'; return; }
  const nameOf = (id) => { const p = allPlayers.find(pl => pl.id === id); return p ? p.name : `#${id}`; };
  const bowlerId = balls[0].bowler_id;
  const batsmanIds = [...new Set(balls.map(b => b.batsman_id))];

  const bowlerRow = `
    <tr>
      <td>${escapeHtmlAttr(nameOf(bowlerId))} (bowler)</td>
      <td><select id="fp-over-bowl-${inningsId}" class="field" style="padding:4px; font-size:12px;">
        <option value="">— replace with —</option>
        ${fixPlayersOptionsHtml(allPlayers, bowlerId)}
      </select></td>
      <td><button class="btn-small btn-small-primary" onclick="saveFixOverBowler(${matchId}, ${inningsId}, ${overNo}, ${bowlerId})">Save</button></td>
    </tr>`;
  const batsmanRows = batsmanIds.map(bid => `
    <tr>
      <td>${escapeHtmlAttr(nameOf(bid))} (batter)</td>
      <td><select id="fp-over-bat-${inningsId}-${bid}" class="field" style="padding:4px; font-size:12px;">
        <option value="">— replace with —</option>
        ${fixPlayersOptionsHtml(allPlayers, bid)}
      </select></td>
      <td><button class="btn-small btn-small-primary" onclick="saveFixOverBatsman(${matchId}, ${inningsId}, ${overNo}, ${bid})">Save</button></td>
    </tr>`).join('');

  detailEl.innerHTML = `
    <div id="fp-over-error-${inningsId}" style="color:#dc2626; font-size:12.5px; margin-top:6px; display:none;"></div>
    <div class="lb-table-scroll">
      <table class="mini-table" style="margin-top:6px;">
        <thead><tr><th>Player in over</th><th colspan="2">Replace with</th></tr></thead>
        <tbody>${bowlerRow}${batsmanRows}</tbody>
      </table>
    </div>`;
}

async function saveFixOverBowler(matchId, inningsId, overNo, oldBowlerId) {
  const sel = document.getElementById(`fp-over-bowl-${inningsId}`);
  const errEl = document.getElementById(`fp-over-error-${inningsId}`);
  if (errEl) errEl.style.display = 'none';
  const newBowlerId = sel && sel.value ? parseInt(sel.value, 10) : null;
  if (!newBowlerId) {
    if (errEl) { errEl.innerText = 'Pick a replacement player first.'; errEl.style.display = 'block'; }
    return;
  }
  const res = await fetch(`${API}/matches/innings/${inningsId}/overs/${overNo}/correct-bowler`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': state.adminToken || '' },
    body: JSON.stringify({ old_bowler_id: oldBowlerId, new_bowler_id: newBowlerId })
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    if (errEl) { errEl.innerText = data.error || 'Could not reassign that over\'s bowler.'; errEl.style.display = 'block'; }
    return;
  }
  await startFixPlayers(matchId);
}

async function saveFixOverBatsman(matchId, inningsId, overNo, oldBatsmanId) {
  const sel = document.getElementById(`fp-over-bat-${inningsId}-${oldBatsmanId}`);
  const errEl = document.getElementById(`fp-over-error-${inningsId}`);
  if (errEl) errEl.style.display = 'none';
  const newBatsmanId = sel && sel.value ? parseInt(sel.value, 10) : null;
  if (!newBatsmanId) {
    if (errEl) { errEl.innerText = 'Pick a replacement player first.'; errEl.style.display = 'block'; }
    return;
  }
  const res = await fetch(`${API}/matches/innings/${inningsId}/overs/${overNo}/correct-batsman`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': state.adminToken || '' },
    body: JSON.stringify({ old_batsman_id: oldBatsmanId, new_batsman_id: newBatsmanId })
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    if (errEl) { errEl.innerText = data.error || 'Could not reassign that over\'s batter.'; errEl.style.display = 'block'; }
    return;
  }
  await startFixPlayers(matchId);
}


async function continueScoring(matchId) {
  state.matchId = matchId;
  state.appMode = 'scorer';
  state.matchIsComplete = false;
  if (state.watchPollInterval) { clearInterval(state.watchPollInterval); state.watchPollInterval = null; }
  const av = document.getElementById('admin-view');
  if (av) { av.style.display = 'none'; av.innerHTML = ''; }
  const gear = document.getElementById('floating-admin-gear');
  if (gear) gear.style.display = 'none';
  document.getElementById('mode-select-view').style.display = 'none';
  document.getElementById('main-tabbar').style.display = 'flex';
  document.getElementById('share-watch-btn').style.display = 'block';

  const matchRes = await apiFetch(`${API}/matches/${matchId}`);
  const match = matchRes.ok ? await matchRes.json() : null;
  if (match && match.id) {
    state.matchId = match.id;
    // Persist so a page-refresh-then-offline can still resume
    if (window.OfflineDB) {
      OfflineDB.cacheSet('current_match', match);
      OfflineDB.cacheSet('current_match_id', match.id);
    }
    state.teamAIds = state.teamAIds || [];
    state.teamBIds = state.teamBIds || [];
    document.getElementById('team-a-name').value = match.team_a_name || document.getElementById('team-a-name').value || 'Team A';
    document.getElementById('team-b-name').value = match.team_b_name || document.getElementById('team-b-name').value || 'Team B';
    document.getElementById('match-name').value = match.match_name || '';
    const matchDateInput = document.getElementById('match-date');
    if (matchDateInput) matchDateInput.value = match.match_date ? String(match.match_date).slice(0, 10) : matchDateInput.value;
    const matchTimeInput = document.getElementById('match-time');
    if (matchTimeInput) matchTimeInput.value = match.match_time || '';
    document.getElementById('overs-limit').value = match.overs_limit || document.getElementById('overs-limit').value || 10;
    document.getElementById('retirement-overs').value = match.retirement_overs || document.getElementById('retirement-overs').value || 5;
    state.matchOversLimit = parseFloat(match.overs_limit) || 8;
    await loadPlayers();
    const rosterRes = await apiFetch(`${API}/matches/${matchId}/players`);
    if (rosterRes.ok) {
      const roster = await rosterRes.json();
      state.teamAIds = roster.team_a_player_ids || [];
      state.teamBIds = roster.team_b_player_ids || [];
      state.commonPlayerIds = roster.common_player_ids || [];
      state.teamACaptainId = roster.team_a_captain_id || null;
      state.teamBCaptainId = roster.team_b_captain_id || null;
      state.attendingIds = new Set([...state.teamAIds, ...state.teamBIds, ...state.commonPlayerIds]);
      // Cache roster for offline resume
      if (window.OfflineDB) OfflineDB.cacheSet('current_roster', roster);
      renderAttendanceList();
      renderTeamAssignList();
    }
    const inningsRes = await apiFetch(`${API}/matches/${matchId}/current-innings`);
    if (inningsRes.ok) {
      const innings = await inningsRes.json();
      if (innings && innings.id) {
        state.inningsId = innings.id;
        state.currentBattingTeam = innings.batting_team;
        state.currentBowlingTeamIds = (innings.bowling_team === 'A' ? state.teamAIds : state.teamBIds).concat(state.commonPlayerIds || []);
        if (window.OfflineDB) OfflineDB.cacheSet('current_innings', innings);
        const battingName = innings.batting_team === 'A' ? (match.team_a_name || 'Team A') : (match.team_b_name || 'Team B');
        document.getElementById('sb-batting-team').innerText = battingName;
        showView('score');

        // Innings 1 completed but innings 2 not started yet — restore target state
        // and re-show the innings-complete prompt so the scorer can kick off innings 2.
        if (innings.status === 'completed' && innings.innings_no === 1) {
          state.matchTarget = innings.total_runs + 1;
          state.firstInningsScore = `${innings.total_runs}/${innings.total_wickets}`;
          state.firstInningsTeamName = battingName;
          state.inningsCompletionHandled = false;
          await refreshScorecard(true);
          showInningsCompleteModal('Innings 1 is complete.');
          return;
        }

        await refreshScorecard(true);

        // Opener modal was dismissed before setting striker/bowler — re-prompt.
        if (!innings.striker_id || !innings.bowler_id) {
          promptOpeningBatsmanAndBowler(innings.batting_team);
        }
        return;
      }
    }
    // No innings yet — this is a scheduled/setup match. Show the same
    // "ready to start" UI as right after creating a match, so the scorer
    // can do the toss and start (or leave it scheduled for later again).
    showView('setup');
    document.getElementById('start-innings-card').style.display = 'block';
    document.getElementById('schedule-later-card').style.display = 'block';
    document.getElementById('attendance-assign-section').style.display = 'none';
    document.getElementById('add-player-section').style.display = 'none';
    document.getElementById('edit-teams-toggle-card').style.display = 'block';
    renderCaptainsCard();
    renderTeamsSummary(match);
    resetTossUI(match);
    document.getElementById('sb-overs-limit').innerText = `${match.overs_limit} overs`;
    return;
  }
  showView('setup');
}

async function deleteMatch(matchId) {
  if (!confirm('Delete this match? This cannot be undone.')) return;
  const res = await fetch(`${API}/matches/${matchId}`, { method: 'DELETE', headers: { 'x-admin-token': state.adminToken || '' } });
  if (res.status === 401) {
    sessionStorage.removeItem('adminToken');
    state.adminToken = null;
    alert('Your admin session has expired. Please log in again.');
    renderAdminLoginForm();
    return;
  }
  if (res.status === 404) { alert('Match not found — it may have already been deleted.'); await loadAdminConsole(); return; }
  if (!res.ok) { alert('Delete failed'); return; }
  await loadAdminConsole();
}


function refreshAdminView() {
  const av = document.getElementById('admin-view');
  if (av) av.innerHTML = '';
}
function formatDateOnly(dateStr) {
  if (!dateStr) return '';
  return String(dateStr).split('T')[0];
}
// public/app.js
function showView(view, contextMatchId) {
  document.getElementById('setup-view').style.display = view === 'setup' ? 'block' : 'none';
  document.getElementById('score-view').style.display = view === 'score' ? 'block' : 'none';
  document.getElementById('scorecard-view').style.display = view === 'scorecard' ? 'block' : 'none';
  document.getElementById('leaderboard-view').style.display = view === 'leaderboard' ? 'block' : 'none';
  document.getElementById('stats-view').style.display = view === 'stats' ? 'block' : 'none';
  document.getElementById('nav-setup').classList.toggle('active', view === 'setup');
  document.getElementById('nav-score').classList.toggle('active', view === 'score');
  document.getElementById('nav-scorecard').classList.toggle('active', view === 'scorecard');
  document.getElementById('nav-leaderboard').classList.toggle('active', view === 'leaderboard');
  document.getElementById('nav-stats').classList.toggle('active', view === 'stats');
  const titles = { setup: 'Setup Match', score: 'Live Score', scorecard: 'Scorecard', leaderboard: 'Leaderboard', stats: 'Match History' };
  document.getElementById('topbar-title').innerText = titles[view];
  if (view === 'stats') { loadMatchHistory(); }
  if (view === 'leaderboard') { loadLeaderboard(); }
  if (view === 'scorecard') { loadScorecardTab(contextMatchId); }
  if (view === 'score') {
    const banner = document.getElementById('sb-winner-banner');
    if (banner) banner.style.display = 'none';
    updateScoringControls();
  }
  window.scrollTo(0, 0);
}


// Entry point for the Scorecard tab. Opened with a specific match in mind
// (tapped a card in Match History, or came from Watch Live) -> go straight
// to that match's detail view. Opened directly (tapped the bottom-nav
// Scorecard tab itself, with no match in mind yet) -> show the tile picker
// first instead of silently defaulting to whichever match happens to sort
// first (which, if that was a still-unstarted scheduled match, is exactly
// how this used to render a blank scorecard).
async function loadScorecardTab(preferredMatchId) {
  const pickerCard = document.getElementById('scorecard-picker-card');
  const detail = document.getElementById('scorecard-detail-container');
  if (preferredMatchId != null) {
    if (pickerCard) pickerCard.style.display = 'none';
    if (detail) detail.style.display = 'block';
    await loadMatchListForScorecard(preferredMatchId);
    return;
  }
  if (pickerCard) pickerCard.style.display = 'block';
  if (detail) detail.style.display = 'none';
  await renderScorecardPicker();
}

async function renderScorecardPicker() {
  const container = document.getElementById('scorecard-picker-container');
  if (!container) return;
  container.innerHTML = '<p class="helper-text">Loading matches...</p>';
  const res = await fetch(`${API}/stats/matches-history`);
  const allRows = await res.json();
  // Scheduled ('setup') matches have no innings yet, so there's nothing to
  // show a scorecard for — leaving them out here is what actually fixes the
  // blank-scorecard bug (previously the dropdown defaulted to whichever
  // match sorted first, setup or not).
  const relevant = (allRows || []).filter(r => r.status !== 'setup');
  if (relevant.length === 0) {
    container.innerHTML = '<p class="helper-text">No matches yet.</p>';
    return;
  }
  container.innerHTML = `<div class="watch-card-grid">${relevant.map(renderHistoryCard).join('')}</div>`;
}

function backToScorecardPicker() {
  const pickerCard = document.getElementById('scorecard-picker-card');
  const detail = document.getElementById('scorecard-detail-container');
  if (detail) detail.style.display = 'none';
  if (pickerCard) pickerCard.style.display = 'block';
  renderScorecardPicker();
}

async function loadMatchListForScorecard(preferredMatchId) {
  const res = await fetch(`${API}/matches`);
  const matches = await res.json();
  state.scorecardMatches = matches;
  const sel = document.getElementById('scorecard-match-select');
  sel.innerHTML = matches.map(m => `<option value="${m.id}">${m.team_a_name} vs ${m.team_b_name} - ${new Date(m.created_at).toLocaleDateString()}</option>`).join('');
  if (matches.length === 0) return;
  const preferredExists = preferredMatchId != null && matches.some(m => String(m.id) === String(preferredMatchId));
  sel.value = preferredExists ? preferredMatchId : matches[0].id;
  loadFullScorecard();
}

let lastScorecardData = null; // { matchId, matchMeta, innings } from the most recent full-scorecard fetch, used by CSV/PDF export

async function loadFullScorecard() {
  const matchId = document.getElementById('scorecard-match-select').value;
  if (!matchId) return;
  const matchMeta = (state.scorecardMatches || []).find(m => String(m.id) === String(matchId));
  loadTeamsForMatch(matchId, 'scorecard-teams-container', matchMeta && matchMeta.team_a_name, matchMeta && matchMeta.team_b_name);
  const res = await fetch(`${API}/matches/${matchId}/full-scorecard`);
  const inningsList = await res.json();
  lastScorecardData = { matchId, matchMeta, innings: inningsList };
  const container = document.getElementById('scorecard-innings-container');
  container.innerHTML = inningsList.map(inn => {
    const teamLabel = inn.innings.batting_team === 'A' ? 'Team A' : 'Team B';
    const inningsCrr = trueOvers(inn.innings.overs_completed) > 0 ? (Number(inn.innings.total_runs || 0) / trueOvers(inn.innings.overs_completed)).toFixed(2) : '0.00';
    const inningsTotalLabel = `${inn.innings.total_runs}/${inn.innings.total_wickets} (${parseFloat(inn.innings.overs_completed).toFixed(1)} ov, RR: ${inningsCrr})`;
    const battingRows = inn.batting.length ? renderStandardBattingRows(inn.batting, inn.extras, inningsTotalLabel) : '<tr><td colspan="6">No data</td></tr>';
    const fowRows = (inn.fall_of_wickets || []).map(f => {
      const over = f.over_at_fall != null ? Number(f.over_at_fall).toFixed(1) : '0.0';
      return `<tr><td class="clickable-name" onclick="showPlayerCard(${f.player_id})">${f.name || 'unknown'}</td><td>${f.wicket_no ?? ''}-${f.team_score_at_fall ?? ''}</td><td>${over}</td></tr>`;
    }).join('');
    const bowlingRows = inn.bowling.map(b => {
      const econ = calcEconomy(b.runs_conceded, b.overs_bowled);
      const nameLabel = `${b.name}${b.is_captain ? ' (C)' : ''}`;
      return `<tr><td>${nameLabel}</td><td>${b.overs_bowled}</td><td>${b.maidens || 0}</td><td>${b.runs_conceded}</td><td>${b.wickets}</td><td>${b.wides || 0}</td><td>${b.no_balls || 0}</td><td>${econ}</td></tr>`;
    }).join('');
    const oversRecapHtml = (inn.overs_recap || []).map(over => {
      const pills = over.balls.map(b => {
        const cls = b.is_wicket ? 'ball-pill wicket' : (b.runs === 6 ? 'ball-pill six' : b.runs === 4 ? 'ball-pill four' : 'ball-pill');
        return `<span class="${cls}">${b.display}</span>`;
      }).join('');
      return `
        <div class="over-recap-row">
          <div class="over-recap-header">
            <span>Over ${over.over_no + 1} — <b>${over.bowler_name}</b> to ${formatOverBatsmen(over)}</span>
            <span class="over-recap-total">${over.runs} Runs, ${over.wickets} Wkt</span>
          </div>
          <div class="over-recap-balls">${pills}</div>
        </div>`;
    }).join('');
    return `
      <div class="card">
        <h2>${teamLabel} — Innings ${inn.innings.innings_no} (${inn.innings.total_runs}/${inn.innings.total_wickets}, ${parseFloat(inn.innings.overs_completed).toFixed(1)} ov)</h2>
        <table class="mini-table"><thead><tr><th>Batter</th><th>R</th><th>B</th><th>4s</th><th>6s</th><th>SR</th></tr></thead><tbody>${battingRows}</tbody></table>
        <h3 style="margin-top:10px; font-size:13px; color:var(--sub);">Bowling</h3>
        <table class="mini-table"><thead><tr><th>Bowler</th><th>O</th><th>M</th><th>R</th><th>W</th><th>Wd</th><th>Nb</th><th>Econ</th></tr></thead><tbody>${bowlingRows}</tbody></table>
        <h3 style="margin-top:10px; font-size:13px; color:var(--sub);">Fall of Wickets</h3>
        <table class="mini-table"><thead><tr><th>Fall of Wickets</th><th>Score</th><th>Over</th></tr></thead><tbody>${fowRows || '<tr><td colspan="3">No wickets fell</td></tr>'}</tbody></table>
      </div>
      <div class="card">
        <h3 style="margin-top:0; font-size:13px; color:var(--sub);">Ball-by-Ball Recap</h3>
        <div class="over-recap-container">${oversRecapHtml}</div>
      </div>`;
  }).join('');
}


// --- Per-match scorecard export (CSV / PDF) --------------------------------
// Reuses whatever loadFullScorecard() last fetched, so the export always
// matches the match currently open in the picker.

function scorecardMatchTitle(matchMeta) {
  if (!matchMeta) return 'Match';
  return matchMeta.match_name || `${matchMeta.team_a_name} vs ${matchMeta.team_b_name}`;
}

function scorecardFilenamePart(matchMeta, matchId) {
  const title = scorecardMatchTitle(matchMeta);
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return slug ? `${slug}-${matchId}` : `match-${matchId}`;
}

function exportScorecardCSV() {
  if (!lastScorecardData || !lastScorecardData.innings || !lastScorecardData.innings.length) {
    alert('Open a match\'s scorecard first — there\'s nothing to export yet.');
    return;
  }
  const { matchId, matchMeta, innings } = lastScorecardData;
  const lines = [scorecardMatchTitle(matchMeta), ''];
  innings.forEach(inn => {
    const teamLabel = inn.innings.batting_team === 'A' ? (matchMeta?.team_a_name || 'Team A') : (matchMeta?.team_b_name || 'Team B');
    lines.push(`Innings ${inn.innings.innings_no} — ${teamLabel} (${inn.innings.total_runs}/${inn.innings.total_wickets}, ${parseFloat(inn.innings.overs_completed).toFixed(1)} ov)`);
    lines.push(['Batter', 'R', 'B', '4s', '6s', 'SR', 'How Out'].map(csvEscape).join(','));
    if (inn.batting.length) {
      inn.batting.forEach(b => {
        const sr = b.balls_faced > 0 ? ((b.runs / b.balls_faced) * 100).toFixed(1) : '0.0';
        const nameLabel = `${b.name}${b.is_captain ? ' (C)' : ''}`;
        lines.push([nameLabel, b.runs, b.balls_faced, b.fours, b.sixes, sr, formatHowOut(b)].map(csvEscape).join(','));
      });
      const ex = inn.extras;
      const extrasText = ex ? `${ex.total} (b ${ex.byes}, lb ${ex.leg_byes}, w ${ex.wides}, nb ${ex.no_balls})` : '0';
      lines.push(['Extras', '', '', '', '', '', extrasText].map(csvEscape).join(','));
      const inningsCrr = trueOvers(inn.innings.overs_completed) > 0 ? (Number(inn.innings.total_runs || 0) / trueOvers(inn.innings.overs_completed)).toFixed(2) : '0.00';
      const totalText = `${inn.innings.total_runs}/${inn.innings.total_wickets} (${parseFloat(inn.innings.overs_completed).toFixed(1)} ov, RR: ${inningsCrr})`;
      lines.push(['Total', '', '', '', '', '', totalText].map(csvEscape).join(','));
    } else {
      lines.push('No data');
    }
    lines.push('');
    lines.push(['Bowler', 'O', 'M', 'R', 'W', 'Wd', 'Nb', 'Econ'].map(csvEscape).join(','));
    if (inn.bowling.length) {
      inn.bowling.forEach(b => {
        const econ = calcEconomy(b.runs_conceded, b.overs_bowled);
        const nameLabel = `${b.name}${b.is_captain ? ' (C)' : ''}`;
        lines.push([nameLabel, b.overs_bowled, b.maidens || 0, b.runs_conceded, b.wickets, b.wides || 0, b.no_balls || 0, econ].map(csvEscape).join(','));
      });
    } else {
      lines.push('No data');
    }
    lines.push('');
    lines.push('Fall of Wickets');
    lines.push(['Batter', 'Score', 'Over'].map(csvEscape).join(','));
    if (inn.fall_of_wickets && inn.fall_of_wickets.length) {
      inn.fall_of_wickets.forEach(f => {
        const over = f.over_at_fall != null ? Number(f.over_at_fall).toFixed(1) : '0.0';
        lines.push([f.name || 'unknown', `${f.wicket_no ?? ''}-${f.team_score_at_fall ?? ''}`, over].map(csvEscape).join(','));
      });
    } else {
      lines.push('No wickets fell');
    }
    lines.push('');
    lines.push('Ball-by-Ball');
    lines.push(['Over', 'Bowler', 'Batter', 'Runs', 'Wkts', 'Balls'].map(csvEscape).join(','));
    if (inn.overs_recap && inn.overs_recap.length) {
      inn.overs_recap.forEach(over => {
        const ballsStr = over.balls.map(b => b.display).join(' ');
        lines.push([over.over_no + 1, over.bowler_name, formatOverBatsmen(over), over.runs, over.wickets, ballsStr].map(csvEscape).join(','));
      });
    } else {
      lines.push('No data');
    }
    lines.push('');
  });
  const csv = lines.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `scorecard-${scorecardFilenamePart(matchMeta, matchId)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportScorecardPDF() {
  if (!lastScorecardData || !lastScorecardData.innings || !lastScorecardData.innings.length) {
    alert('Open a match\'s scorecard first — there\'s nothing to export yet.');
    return;
  }
  if (!window.jspdf || !window.jspdf.jsPDF) {
    alert('PDF export isn\'t available right now — check your internet connection and try again.');
    return;
  }
  const { matchId, matchMeta, innings } = lastScorecardData;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const title = scorecardMatchTitle(matchMeta);

  doc.setFontSize(16);
  doc.text(title, 14, 16);
  doc.setFontSize(10);
  doc.setTextColor(100);
  const dateBit = matchMeta && matchMeta.match_date ? formatDateOnly(matchMeta.match_date) : '';
  doc.text([dateBit, `Generated ${new Date().toLocaleDateString()}`].filter(Boolean).join('  •  '), 14, 22);

  let y = 30;
  innings.forEach(inn => {
    const teamLabel = inn.innings.batting_team === 'A' ? (matchMeta?.team_a_name || 'Team A') : (matchMeta?.team_b_name || 'Team B');
    if (y > 260) { doc.addPage(); y = 16; }
    doc.setFontSize(12);
    doc.setTextColor(0);
    doc.text(`Innings ${inn.innings.innings_no} — ${teamLabel} (${inn.innings.total_runs}/${inn.innings.total_wickets}, ${parseFloat(inn.innings.overs_completed).toFixed(1)} ov)`, 14, y);

    let battingBody;
    if (inn.batting.length) {
      battingBody = inn.batting.map(b => {
        const sr = b.balls_faced > 0 ? ((b.runs / b.balls_faced) * 100).toFixed(1) : '0.0';
        const nameLabel = `${b.name}${b.is_captain ? ' (C)' : ''}`;
        const howOut = formatHowOut(b);
        return [howOut ? `${nameLabel}\n${howOut}` : nameLabel, b.runs, b.balls_faced, b.fours, b.sixes, sr];
      });
      const ex = inn.extras;
      const extrasText = ex ? `${ex.total} (b ${ex.byes}, lb ${ex.leg_byes}, w ${ex.wides}, nb ${ex.no_balls})` : '0';
      battingBody.push([{ content: 'Extras', styles: { fontStyle: 'bold' } }, { content: extrasText, colSpan: 5 }]);
      const inningsCrr = trueOvers(inn.innings.overs_completed) > 0 ? (Number(inn.innings.total_runs || 0) / trueOvers(inn.innings.overs_completed)).toFixed(2) : '0.00';
      const totalText = `${inn.innings.total_runs}/${inn.innings.total_wickets} (${parseFloat(inn.innings.overs_completed).toFixed(1)} ov, RR: ${inningsCrr})`;
      battingBody.push([{ content: 'Total', styles: { fontStyle: 'bold' } }, { content: totalText, colSpan: 5, styles: { fontStyle: 'bold' } }]);
    } else {
      battingBody = [['No data', '', '', '', '', '']];
    }
    doc.autoTable({
      startY: y + 3,
      head: [['Batter', 'R', 'B', '4s', '6s', 'SR']],
      body: battingBody,
      styles: { fontSize: 8 },
      headStyles: { fillColor: [30, 144, 255] },
      margin: { left: 14, right: 14 }
    });

    const bowlingBody = inn.bowling.length ? inn.bowling.map(b => {
      const econ = calcEconomy(b.runs_conceded, b.overs_bowled);
      const nameLabel = `${b.name}${b.is_captain ? ' (C)' : ''}`;
      return [nameLabel, b.overs_bowled, b.maidens || 0, b.runs_conceded, b.wickets, b.wides || 0, b.no_balls || 0, econ];
    }) : [['No data', '', '', '', '', '', '', '']];
    doc.autoTable({
      startY: doc.lastAutoTable.finalY + 3,
      head: [['Bowler', 'O', 'M', 'R', 'W', 'Wd', 'Nb', 'Econ']],
      body: bowlingBody,
      styles: { fontSize: 8 },
      headStyles: { fillColor: [30, 144, 255] },
      margin: { left: 14, right: 14 }
    });

    const fowBody = (inn.fall_of_wickets && inn.fall_of_wickets.length) ? inn.fall_of_wickets.map(f => {
      const over = f.over_at_fall != null ? Number(f.over_at_fall).toFixed(1) : '0.0';
      return [f.name || 'unknown', `${f.wicket_no ?? ''}-${f.team_score_at_fall ?? ''}`, over];
    }) : [['No wickets fell', '', '']];
    doc.autoTable({
      startY: doc.lastAutoTable.finalY + 3,
      head: [['Fall of Wickets', 'Score', 'Over']],
      body: fowBody,
      styles: { fontSize: 8 },
      headStyles: { fillColor: [30, 144, 255] },
      margin: { left: 14, right: 14 }
    });

    const oversRecapBody = (inn.overs_recap && inn.overs_recap.length) ? inn.overs_recap.map(over => {
      const ballsStr = over.balls.map(b => b.display).join(' ');
      return [over.over_no + 1, over.bowler_name, formatOverBatsmen(over), over.runs, over.wickets, ballsStr];
    }) : [['No data', '', '', '', '', '']];
    doc.autoTable({
      startY: doc.lastAutoTable.finalY + 6,
      head: [['Over', 'Bowler', 'Batter', 'R', 'W', 'Balls']],
      body: oversRecapBody,
      styles: { fontSize: 7 },
      headStyles: { fillColor: [30, 144, 255] },
      margin: { left: 14, right: 14 }
    });

    y = doc.lastAutoTable.finalY + 12;
  });

  doc.save(`scorecard-${scorecardFilenamePart(matchMeta, matchId)}.pdf`);
}


let leaderboardMode = 'overall';
let lastLeaderboardData = null; // { batting, bowling } from the most recent /stats/leaderboard fetch, used by CSV/PDF export

function switchLeaderboardMode(mode) {
  leaderboardMode = mode;
  document.getElementById('lb-mode-overall-btn').classList.toggle('active', mode === 'overall');
  document.getElementById('lb-mode-day-btn').classList.toggle('active', mode === 'day');
  const pickerCard = document.getElementById('lb-day-picker-card');
  if (pickerCard) pickerCard.style.display = mode === 'day' ? 'block' : 'none';
  const dateInput = document.getElementById('lb-date-picker');
  if (mode === 'day' && dateInput && !dateInput.value) {
    dateInput.value = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
  }
  loadLeaderboard();
}

async function loadLeaderboard() {
  const dateInput = document.getElementById('lb-date-picker');
  const dateQuery = (leaderboardMode === 'day' && dateInput && dateInput.value) ? `?date=${dateInput.value}` : '';
  const res = await fetch(`${API}/stats/leaderboard${dateQuery}`);
  const data = await res.json();
  lastLeaderboardData = data;
  const emptyMsg = leaderboardMode === 'day' ? 'No matches played on this day.' : 'No matches recorded yet.';
  const battingBody = document.querySelector('#lb-live-batting-table tbody');
  battingBody.innerHTML = data.batting.length ? data.batting.map(r => `
    <tr>
      <td class="clickable-name" onclick="showPlayerCard(${r.player_id || r.id})">${r.name}</td><td>${r.matches_played}</td><td>${r.innings_played}</td><td>${r.total_runs}</td>
      <td>${r.fours}</td><td>${r.sixes}</td><td>${r.avg}</td><td>${Math.round(r.strike_rate)}</td>
      <td>${r.wins}-${r.losses}</td><td>${r.win_pct}%</td>
    </tr>`).join('') : `<tr><td colspan="10" class="helper-text">${emptyMsg}</td></tr>`;
  const liveBowlingBody = document.querySelector('#lb-live-bowling-table tbody');
  if (liveBowlingBody) {
    liveBowlingBody.innerHTML = (data.bowling && data.bowling.length) ? data.bowling.map(r => `
      <tr>
        <td class="clickable-name" onclick="showPlayerCard(${r.player_id || r.id})">${r.name}</td><td>${r.matches_played}</td><td>${r.overs_bowled}</td>
        <td>${r.wickets}</td><td>${r.runs_conceded}</td><td>${r.economy}</td>
      </tr>`).join('') : `<tr><td colspan="6" class="helper-text">${emptyMsg}</td></tr>`;
  }
}
function switchLeaderboardTab(tab) {
  document.getElementById('lb-tab-batting').style.display = tab === 'batting' ? 'block' : 'none';
  document.getElementById('lb-tab-bowling').style.display = tab === 'bowling' ? 'block' : 'none';
  document.getElementById('lb-tab-batting-btn').classList.toggle('active', tab === 'batting');
  document.getElementById('lb-tab-bowling-btn').classList.toggle('active', tab === 'bowling');
}

// --- Leaderboard export (CSV / PDF) ---------------------------------------
// Both exports reuse whatever the leaderboard last fetched (lastLeaderboardData)
// rather than re-querying, so the exported file always matches what's on screen
// (same Overall/Day mode and date).

const LB_BATTING_COLUMNS = [
  { key: 'name', label: 'Player' }, { key: 'matches_played', label: 'M' },
  { key: 'innings_played', label: 'Inn' }, { key: 'total_runs', label: 'R' },
  { key: 'fours', label: '4s' }, { key: 'sixes', label: '6s' },
  { key: 'avg', label: 'Avg' }, { key: 'strike_rate', label: 'SR' },
  { key: 'wl', label: 'W-L' }, { key: 'win_pct', label: 'Win%' }
];
const LB_BOWLING_COLUMNS = [
  { key: 'name', label: 'Player' }, { key: 'matches_played', label: 'M' },
  { key: 'overs_bowled', label: 'Ov' }, { key: 'wickets', label: 'W' },
  { key: 'runs_conceded', label: 'RC' }, { key: 'economy', label: 'Econ' }
];

function lbExportRows(data) {
  const batting = (data.batting || []).map(r => ({
    name: r.name, matches_played: r.matches_played, innings_played: r.innings_played,
    total_runs: r.total_runs, fours: r.fours, sixes: r.sixes, avg: r.avg,
    strike_rate: Math.round(r.strike_rate), wl: `${r.wins}-${r.losses}`, win_pct: `${r.win_pct}%`
  }));
  const bowling = (data.bowling || []).map(r => ({
    name: r.name, matches_played: r.matches_played, overs_bowled: r.overs_bowled,
    wickets: r.wickets, runs_conceded: r.runs_conceded, economy: r.economy
  }));
  return { batting, bowling };
}

function lbExportMeta() {
  const dateInput = document.getElementById('lb-date-picker');
  const dateVal = (leaderboardMode === 'day' && dateInput && dateInput.value) ? dateInput.value : null;
  const label = dateVal ? `Day — ${dateVal}` : 'Overall';
  const filenamePart = dateVal ? `day-${dateVal}` : 'overall';
  return { label, filenamePart };
}

function csvEscape(val) {
  const s = (val === null || val === undefined) ? '' : String(val);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvSection(title, columns, rows) {
  const lines = [title, columns.map(c => csvEscape(c.label)).join(',')];
  if (rows.length) {
    rows.forEach(r => lines.push(columns.map(c => csvEscape(r[c.key])).join(',')));
  } else {
    lines.push('No data');
  }
  return lines.join('\n');
}

function exportLeaderboardCSV() {
  if (!lastLeaderboardData) { alert('Leaderboard hasn\'t loaded yet — try again in a moment.'); return; }
  const { batting, bowling } = lbExportRows(lastLeaderboardData);
  const meta = lbExportMeta();
  const csv = [
    `Leaderboard (${meta.label})`,
    '',
    csvSection('Batting', LB_BATTING_COLUMNS, batting),
    '',
    csvSection('Bowling', LB_BOWLING_COLUMNS, bowling)
  ].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `leaderboard-${meta.filenamePart}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportLeaderboardPDF() {
  if (!lastLeaderboardData) { alert('Leaderboard hasn\'t loaded yet — try again in a moment.'); return; }
  if (!window.jspdf || !window.jspdf.jsPDF) { alert('PDF export isn\'t available right now — check your internet connection and try again.'); return; }
  const { batting, bowling } = lbExportRows(lastLeaderboardData);
  const meta = lbExportMeta();
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();

  doc.setFontSize(16);
  doc.text('CageCricket Leaderboard', 14, 16);
  doc.setFontSize(10);
  doc.setTextColor(100);
  doc.text(`${meta.label}  •  Generated ${new Date().toLocaleDateString()}`, 14, 22);

  doc.setFontSize(12);
  doc.setTextColor(0);
  doc.text('Batting', 14, 32);
  doc.autoTable({
    startY: 35,
    head: [LB_BATTING_COLUMNS.map(c => c.label)],
    body: batting.length ? batting.map(r => LB_BATTING_COLUMNS.map(c => r[c.key])) : [['No data', '', '', '', '', '', '', '', '', '']],
    styles: { fontSize: 8 },
    headStyles: { fillColor: [30, 144, 255] },
    margin: { left: 14, right: 14 }
  });

  const afterBatting = doc.lastAutoTable.finalY + 10;
  doc.setFontSize(12);
  doc.text('Bowling', 14, afterBatting);
  doc.autoTable({
    startY: afterBatting + 3,
    head: [LB_BOWLING_COLUMNS.map(c => c.label)],
    body: bowling.length ? bowling.map(r => LB_BOWLING_COLUMNS.map(c => r[c.key])) : [['No data', '', '', '', '', '']],
    styles: { fontSize: 8 },
    headStyles: { fillColor: [30, 144, 255] },
    margin: { left: 14, right: 14 }
  });

  doc.save(`leaderboard-${meta.filenamePart}.pdf`);
}


async function loadMatchHistory() {
  const res = await fetch(`${API}/stats/matches-history`);
  const allRows = await res.json();
  // Match History is a record of what already happened — matches still being
  // set up or actively scored belong in Watch Live / the scorer's own tabs,
  // not here.
  const rows = (allRows || []).filter(r => r.status === 'completed' || r.status === 'abandoned');
  const container = document.getElementById('history-container');
  if (!container) return;
  if (!rows || rows.length === 0) {
    container.innerHTML = '<p class="helper-text">No matches yet.</p>';
    return;
  }
  // Rows already arrive sorted most-recent-first, so grouping into day
  // buckets while iterating preserves that order for free.
  const dayGroups = [];
  const dayIndex = {};
  for (const r of rows) {
    if (!dayIndex[r.match_date]) {
      const group = { date: r.match_date, matches: [] };
      dayIndex[r.match_date] = group;
      dayGroups.push(group);
    }
    dayIndex[r.match_date].matches.push(r);
  }
  const latestDate = dayGroups[0].date;
  let html = '';
  let currentMonthKey = null;
  for (const group of dayGroups) {
    const dateObj = new Date(group.date + 'T00:00:00');
    const monthKey = group.date.slice(0, 7);
    if (monthKey !== currentMonthKey) {
      currentMonthKey = monthKey;
      const monthLabel = dateObj.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
      html += `<div class="history-month-header">${monthLabel}</div>`;
    }
    const dayLabel = dateObj.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    const isLatest = group.date === latestDate;
    html += `
      <button class="history-day-header${isLatest ? ' expanded' : ''}" onclick="toggleHistoryDay('${group.date}')">
        <span><span class="history-day-chevron">▶</span> ${dayLabel}</span>
        <span class="history-day-count">${group.matches.length} match${group.matches.length === 1 ? '' : 'es'}</span>
      </button>
      <div class="watch-card-grid history-day-cards" id="history-day-${group.date}" style="display:${isLatest ? 'grid' : 'none'};">
        ${group.matches.map(renderHistoryCard).join('')}
      </div>`;
  }
  container.innerHTML = html;
}

function toggleHistoryDay(date) {
  const el = document.getElementById(`history-day-${date}`);
  if (!el) return;
  const isOpen = el.style.display !== 'none';
  el.style.display = isOpen ? 'none' : 'grid';
  const header = el.previousElementSibling;
  if (header && header.classList.contains('history-day-header')) {
    header.classList.toggle('expanded', !isOpen);
  }
}

function renderHistoryCard(m) {
  const title = m.match_name || `${m.team_a_name} vs ${m.team_b_name}`;
  const teamA = m.team_a_name || 'Team A';
  const teamB = m.team_b_name || 'Team B';
  const aColor = teamColorCss(teamA, '#ef4444');
  const bColor = teamColorCss(teamB, '#3b82f6');
  const inningsArr = Array.isArray(m.innings) ? m.innings : [];
  const aInnings = inningsArr.find(i => i.batting_team === 'A');
  const bInnings = inningsArr.find(i => i.batting_team === 'B');
  const scoreLine = (inn) => inn ? `${inn.total_runs}/${inn.total_wickets} (${parseFloat(inn.overs_completed).toFixed(1)} ov)` : '—';
  let resultText, resultClass;
  if (m.status === 'completed') {
    if (m.winner_team === 'tie') { resultText = 'Match tied'; resultClass = 'history-result-tie'; }
    else if (m.winner_team === 'A' || m.winner_team === 'B') { resultText = `${m.winner_team === 'A' ? teamA : teamB} won`; resultClass = 'history-result-win'; }
    else { resultText = m.result_summary || 'Completed'; resultClass = 'history-result-win'; }
  } else if (m.status === 'abandoned') {
    resultText = 'Abandoned';
    resultClass = 'history-result-tie';
  } else {
    resultText = 'In progress';
    resultClass = 'history-result-progress';
  }
  return `
    <button class="watch-match-card" onclick="openMatchScorecard(${m.id})">
      <div class="watch-card-top">
        <div class="watch-team-stack">
          <div class="watch-team-row"><span class="watch-team-dot" style="background:${aColor}"></span><span class="watch-team-name">${teamA}</span></div>
          <div class="watch-team-row"><span class="watch-team-dot" style="background:${bColor}"></span><span class="watch-team-name">${teamB}</span></div>
        </div>
        <div class="watch-score-stack">
          <div class="watch-card-overs">${scoreLine(aInnings)}</div>
          <div class="watch-card-overs">${scoreLine(bInnings)}</div>
        </div>
      </div>
      <div class="watch-card-title">${title}</div>
      <div class="watch-card-bottom ${resultClass}">${resultText}</div>
    </button>`;
}

function openMatchScorecard(matchId) {
  showView('scorecard', matchId);
}

async function loadPlayers() {
  const res = await apiFetch(`${API}/players`);
  const data = await res.json();
  // Only overwrite in-memory players if we got a real array back (not an error object)
  if (Array.isArray(data)) {
    state.players = data;
    if (window.OfflineDB && data.length > 0) OfflineDB.cacheSet('players', data);
  }
  // If we're offline and already had players in memory, keep them — don't wipe
  state.attendingIds = new Set();
  state.teamAIds = [];
  state.teamBIds = [];
  state.commonPlayerIds = [];
  renderAttendanceList();
  renderTeamAssignList();
}

function toggleMatchSettings(forceCollapse) {
  const body = document.getElementById('match-settings-body');
  const chevron = document.getElementById('match-settings-chevron');
  if (!body) return;
  const shouldCollapse = forceCollapse !== undefined ? forceCollapse : !body.classList.contains('collapsed');
  body.classList.toggle('collapsed', shouldCollapse);
  if (chevron) chevron.innerText = shouldCollapse ? '▼' : '▲';
}

// Step 1: who's playing today. A plain search + tick list of the whole roster.
function renderAttendanceList() {
  const container = document.getElementById('attendance-list');
  if (!container) return;
  const query = (document.getElementById('attendance-search')?.value || '').trim().toLowerCase();
  if (!state.players || state.players.length === 0) {
    container.innerHTML = `<p class="helper-text" style="margin:6px;">No players yet — add one above.</p>`;
    updateAttendanceCount();
    return;
  }
  const filtered = state.players.filter(p => !query || p.name.toLowerCase().includes(query));
  if (filtered.length === 0) {
    container.innerHTML = `<p class="roster-no-results">No players match "${query}".</p>`;
    updateAttendanceCount();
    return;
  }
  container.innerHTML = filtered.map(p => `
    <div class="attend-row">
      <input type="checkbox" id="attend-${p.id}" ${state.attendingIds.has(p.id) ? 'checked' : ''} onchange="toggleAttendance(${p.id})">
      <label for="attend-${p.id}">${p.name}</label>
    </div>`).join('');
  updateAttendanceCount();
}

function updateAttendanceCount() {
  const el = document.getElementById('attendance-count');
  if (el) el.innerText = `${state.attendingIds.size} player(s) selected`;
}

function toggleAttendance(playerId) {
  if (state.attendingIds.has(playerId)) {
    state.attendingIds.delete(playerId);
    // No longer playing today - clear any team assignment they had too.
    state.teamAIds = state.teamAIds.filter(id => id !== playerId);
    state.teamBIds = state.teamBIds.filter(id => id !== playerId);
    state.commonPlayerIds = state.commonPlayerIds.filter(id => id !== playerId);
  } else {
    state.attendingIds.add(playerId);
    // Auto-collapse Match Settings once the user starts selecting players,
    // so the screen focuses on team assignment instead of scrolling past settings.
    if (state.attendingIds.size === 1) {
      toggleMatchSettings(true);
    }
  }
  updateAttendanceCount();
  renderTeamAssignList();
}

// Which team (if any) a player is currently assigned to: 'A', 'B', 'C' (common), or null.
function playerTeamOf(playerId) {
  if (state.commonPlayerIds.includes(playerId)) return 'C';
  if (state.teamAIds.includes(playerId)) return 'A';
  if (state.teamBIds.includes(playerId)) return 'B';
  return null;
}

// Step 2: only players ticked in Step 1 show up here, as compact wrapping chips.
// Tap cycles: unassigned -> Team A -> Team B -> Common -> unassigned. Kept compact
// on purpose (vs. one row per player) since attendance lists can run 15-20+ names.
function renderTeamAssignList() {
  const container = document.getElementById('team-assign-list');
  if (!container) return;
  const attendingPlayers = state.players.filter(p => state.attendingIds.has(p.id));
  if (attendingPlayers.length === 0) {
    container.innerHTML = `<p class="helper-text" style="margin:6px;">Tick who's playing in Step 1 first, then assign teams here.</p>`;
    updateTeamCountChips();
    return;
  }
  // Always render in stable (original) order - never re-sort by group,
  // otherwise chips visually jump around as players get assigned.
  container.innerHTML = attendingPlayers.map(p => {
    const team = playerTeamOf(p.id);
    let cls = '';
    if (team === 'C') cls = 'common';
    else if (team === 'A') cls = 'team-a';
    else if (team === 'B') cls = 'team-b';
    return `<span class="player-chip ${cls}" onclick="cyclePlayerChip(${p.id})">${p.name}</span>`;
  }).join('');
  updateTeamCountChips();
}

function cyclePlayerChip(playerId) {
  const current = playerTeamOf(playerId);
  state.teamAIds = state.teamAIds.filter(id => id !== playerId);
  state.teamBIds = state.teamBIds.filter(id => id !== playerId);
  state.commonPlayerIds = state.commonPlayerIds.filter(id => id !== playerId);

  if (!current) {
    state.teamAIds.push(playerId);
  } else if (current === 'A') {
    state.teamBIds.push(playerId);
  } else if (current === 'B') {
    // Only one Common Player is allowed per match - selecting a new one
    // automatically clears any previously assigned common player.
    state.commonPlayerIds = [playerId];
  }
  // else current === 'C': cycles back to unassigned (already removed above)
  renderTeamAssignList();
}


function toggleAttendanceAssignSection() {
  const section = document.getElementById('attendance-assign-section');
  const addPlayerSection = document.getElementById('add-player-section');
  const label = document.getElementById('edit-teams-toggle-label');
  const isHidden = section.style.display === 'none';
  section.style.display = isHidden ? 'block' : 'none';
  addPlayerSection.style.display = isHidden ? 'block' : 'none';
  label.innerText = isHidden ? '✕ Close Editing' : '✏️ Edit Players / Teams';
  updateCreateMatchButtonLabel();
}

// The bottom button of the team-assignment step does double duty: "Create
// Match" for a brand-new match, "Save Team Changes" for editing the roster
// of a match that already exists (pre-start editing via the toggle above,
// or mid-match editing via openTeamEditorFromScore()).
function updateCreateMatchButtonLabel() {
  const btn = document.getElementById('create-match-btn');
  if (btn) btn.innerText = state.matchId ? 'Save Team Changes' : 'Create Match';
}

function handleCreateOrSaveMatch() {
  if (state.matchId) {
    saveTeamAssignment();
  } else {
    createMatch();
  }
}

// Saves roster changes for a match that already exists — including one
// that's already in progress. Adds/removes players (or turns an existing
// player into the Common Player) without touching any stats already
// recorded; see PUT /matches/:matchId/players for the details.
async function saveTeamAssignment() {
  const teamAPlayerIds = [...state.teamAIds, ...state.commonPlayerIds];
  const teamBPlayerIds = [...state.teamBIds, ...state.commonPlayerIds];
  if (teamAPlayerIds.length < 2 || teamBPlayerIds.length < 2) {
    document.getElementById('match-status').innerText = 'Assign at least a few players to each team first.';
    return;
  }
  const res = await apiFetch(`${API}/matches/${state.matchId}/players`, {
    method: 'PUT', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ team_a_player_ids: teamAPlayerIds, team_b_player_ids: teamBPlayerIds })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    document.getElementById('match-status').innerText = err.error || 'Could not save team changes.';
    return;
  }
  if (window.OfflineDB) {
    OfflineDB.cacheSet('current_roster', {
      team_a_player_ids: state.teamAIds,
      team_b_player_ids: state.teamBIds,
      common_player_ids: state.commonPlayerIds || []
    });
  }
  document.getElementById('match-status').innerText = 'Team changes saved.';
  renderCaptainsCard();
  if (state.editingFromScore) {
    cancelTeamEditFromScore();
  }
}

// Opens the Setup screen's attendance/team-assignment steps for editing the
// roster of the match currently being scored, then returns to Live Score.
function openTeamEditorFromScore() {
  state.editingFromScore = true;
  document.getElementById('attendance-assign-section').style.display = 'block';
  document.getElementById('add-player-section').style.display = 'block';
  const teamsSummary = document.getElementById('teams-summary-card');
  const captainsCard = document.getElementById('captains-card');
  const startInnings = document.getElementById('start-innings-card');
  const scheduleLater = document.getElementById('schedule-later-card');
  const editToggle = document.getElementById('edit-teams-toggle-card');
  if (teamsSummary) teamsSummary.style.display = 'none';
  if (captainsCard) captainsCard.style.display = 'none';
  if (startInnings) startInnings.style.display = 'none';
  if (scheduleLater) scheduleLater.style.display = 'none';
  if (editToggle) editToggle.style.display = 'none';
  toggleMatchSettings(true);
  const backBtn = document.getElementById('back-to-score-btn');
  if (backBtn) backBtn.style.display = 'block';
  updateCreateMatchButtonLabel();
  showView('setup');
  renderAttendanceList();
  renderTeamAssignList();
  document.getElementById('match-status').innerText = "Editing players for the match in progress — stats already recorded are kept.";
}

function cancelTeamEditFromScore() {
  state.editingFromScore = false;
  const backBtn = document.getElementById('back-to-score-btn');
  if (backBtn) backBtn.style.display = 'none';
  if (state.inningsId) {
    state.currentBowlingTeamIds = (state.currentBattingTeam === 'A' ? state.teamBIds : state.teamAIds).concat(state.commonPlayerIds || []);
    refreshScorecard(true);
  }
  showView('score');
}

function renderTeamsSummary(match) {
  const card = document.getElementById('teams-summary-card');
  const content = document.getElementById('teams-summary-content');
  if (!card || !content) return;
  const nameWithCaptain = (id, captainId) => id === captainId ? `${nameOf(id)} (C)` : nameOf(id);
  const teamANames = state.teamAIds.map(id => nameWithCaptain(id, state.teamACaptainId));
  const teamBNames = state.teamBIds.map(id => nameWithCaptain(id, state.teamBCaptainId));
  const commonNames = state.commonPlayerIds.map(id => {
    const tags = [];
    if (id === state.teamACaptainId) tags.push(`${match.team_a_name} C`);
    if (id === state.teamBCaptainId) tags.push(`${match.team_b_name} C`);
    return tags.length ? `${nameOf(id)} (${tags.join(', ')})` : nameOf(id);
  });
  content.innerHTML = `
    <div style="margin-bottom:10px;">
      <span class="sub-label" style="color:var(--red);">${match.team_a_name}</span>
      <div style="font-size:13px; line-height:1.6;">${teamANames.join(', ') || 'No players'}</div>
    </div>
    <div style="margin-bottom:10px;">
      <span class="sub-label" style="color:var(--blue);">${match.team_b_name}</span>
      <div style="font-size:13px; line-height:1.6;">${teamBNames.join(', ') || 'No players'}</div>
    </div>
    ${commonNames.length > 0 ? `<div>
      <span class="sub-label" style="color:var(--primary-dark);">Common Player</span>
      <div style="font-size:13px; line-height:1.6;">${commonNames.join(', ')}</div>
    </div>` : ''}
  `;
  card.style.display = 'block';
}

// Populate the two captain dropdowns from the current team assignment, and
// pre-select whichever captains are already saved for this match (if any).
function renderCaptainsCard() {
  const card = document.getElementById('captains-card');
  if (!card) return;
  const teamAOptions = [...state.teamAIds, ...(state.commonPlayerIds || [])];
  const teamBOptions = [...state.teamBIds, ...(state.commonPlayerIds || [])];
  const buildOptions = (ids, selectedId) => `<option value="">No captain</option>` +
    ids.map(id => `<option value="${id}" ${id === selectedId ? 'selected' : ''}>${nameOf(id)}</option>`).join('');
  document.getElementById('team-a-captain-select').innerHTML = buildOptions(teamAOptions, state.teamACaptainId);
  document.getElementById('team-b-captain-select').innerHTML = buildOptions(teamBOptions, state.teamBCaptainId);
  card.style.display = 'block';
}

async function saveCaptain(team) {
  if (!state.matchId) return;
  const selectId = team === 'A' ? 'team-a-captain-select' : 'team-b-captain-select';
  const value = document.getElementById(selectId).value;
  const playerId = value ? parseInt(value, 10) : null;
  const res = await apiFetch(`${API}/matches/${state.matchId}/captain`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ team, player_id: playerId })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(err.error || 'Could not save captain.');
    return;
  }
  if (team === 'A') state.teamACaptainId = playerId; else state.teamBCaptainId = playerId;
  const match = {
    team_a_name: document.getElementById('team-a-name').value || 'Team A',
    team_b_name: document.getElementById('team-b-name').value || 'Team B'
  };
  renderTeamsSummary(match);
}

async function createMatch() {
  const teamAName = document.getElementById('team-a-name').value || 'Team A';
  const teamBName = document.getElementById('team-b-name').value || 'Team B';
  const matchNameInput = document.getElementById('match-name').value.trim();
  const matchDateInput = document.getElementById('match-date');
  const matchTimeInput = document.getElementById('match-time');
  const body = {
    team_a_name: teamAName,
    team_b_name: teamBName,
    match_name: matchNameInput || `${teamAName} vs ${teamBName}`,
    match_date: (matchDateInput && matchDateInput.value) || undefined,
    match_time: (matchTimeInput && matchTimeInput.value) || null,
    overs_limit: parseFloat(document.getElementById('overs-limit').value),
    retirement_overs: parseFloat(document.getElementById('retirement-overs').value),
    team_a_player_ids: [...state.teamAIds, ...state.commonPlayerIds],
    team_b_player_ids: [...state.teamBIds, ...state.commonPlayerIds]
  };
  if (body.team_a_player_ids.length < 2 || body.team_b_player_ids.length < 2) {
    document.getElementById('match-status').innerText = 'Assign at least a few players to each team first.';
    return;
  }
  const res = await apiFetch(`${API}/matches`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)
  });
  const match = await res.json();
  state.matchId = match.id;
  updateCreateMatchButtonLabel();
  // Cache for offline reads (innings start, scorecard, etc.)
  if (window.OfflineDB) {
    OfflineDB.cacheSet('current_match', match);
    OfflineDB.cacheSet('current_match_id', match.id);
    OfflineDB.cacheSet('current_roster', {
      team_a_player_ids: state.teamAIds,
      team_b_player_ids: state.teamBIds,
      common_player_ids: state.commonPlayerIds || []
    });
  }
  document.getElementById('match-status').innerText = `Match created: ${match.team_a_name} vs ${match.team_b_name}`;
  document.getElementById('start-innings-card').style.display = 'block';
  document.getElementById('schedule-later-card').style.display = 'block';
  document.getElementById('attendance-assign-section').style.display = 'none';
  document.getElementById('add-player-section').style.display = 'none';
  document.getElementById('edit-teams-toggle-card').style.display = 'block';
  state.teamACaptainId = null;
  state.teamBCaptainId = null;
  renderCaptainsCard();
  renderTeamsSummary(match);
  resetTossUI(match);
  populateInningsSelectors();
  document.getElementById('sb-overs-limit').innerText = `${match.overs_limit} overs`;
  document.getElementById('share-watch-btn').style.display = 'block';
}


function populateInningsSelectors() {
  // Striker/bowler are now chosen via the opening-players modal after the innings starts,
  // so this function is now a no-op kept for backward compatibility with existing calls.
}

function nameOf(id) { return (state.players.find(p => p.id === id) || {}).name || id; }

// Shared by both "over complete" bowler-selection modals (with or without a
// wicket alongside it). Only prompts when the newly picked bowler is the
// same one who just bowled the over that ended — a normal rotation change
// needs no confirmation.
function confirmSameBowlerIfNeeded(newBowlerId) {
  if (newBowlerId != null && newBowlerId === state.pendingOverBowlerId) {
    return confirm(`${nameOf(newBowlerId)} just bowled that over. Bowl them again for back-to-back overs?`);
  }
  return true;
}

function normalizeNullableInt(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.trunc(value) : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || trimmed.toLowerCase() === 'null' || trimmed.toLowerCase() === 'undefined') return null;
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

async function startInnings(inningsNo = 1) {
  const battingTeam = document.getElementById('innings-batting-team').value;
  const bowlingTeam = battingTeam === 'A' ? 'B' : 'A';
  const teamName = battingTeam === 'A' ? document.getElementById('team-a-name').value : document.getElementById('team-b-name').value;
  state.currentBattingTeamName = teamName;
  state.matchIsComplete = false;
  unlockScoringControls();
  if (inningsNo === 1) { state.matchTarget = null; state.firstInningsScore = null; state.firstInningsTeamName = null; }
  const res = await apiFetch(`${API}/matches/${state.matchId}/innings`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ innings_no: inningsNo, batting_team: battingTeam, bowling_team: bowlingTeam })
  });
  const innings = await res.json();
  state.inningsId = innings.id;
  state.currentBattingTeam = battingTeam;
  state.currentBowlingTeamIds = (bowlingTeam === 'A' ? state.teamAIds : state.teamBIds).concat(state.commonPlayerIds);
  // Cache innings for offline reads
  if (window.OfflineDB) OfflineDB.cacheSet('current_innings', innings);
  document.getElementById('sb-batting-team').innerText = teamName;
  document.getElementById('sb-players-count').innerText = '';
  const banner = document.getElementById('sb-winner-banner');
  if (banner) banner.style.display = 'none';
  showView('score');
  await refreshScorecard();
  promptOpeningBatsmanAndBowler(battingTeam);
}

function promptOpeningBatsmanAndBowler(battingTeam) {
  const battingIds = battingTeam === 'A' ? state.teamAIds : state.teamBIds;
  const bowlingIds = state.currentBowlingTeamIds;
  const container = document.getElementById('extra-modal-container');
  container.innerHTML = `
    <div class="modal-overlay">
      <div class="modal-sheet">
        <h3>Who's opening?</h3>
        <span class="sub-label">Opening Batsman</span>
        <select id="opening-striker-select" class="field">
          ${battingIds.map(id => `<option value="${id}">${nameOf(id)}</option>`).join('')}
        </select>
        <span class="sub-label">Opening Bowler</span>
        <select id="opening-bowler-select" class="field">
          ${bowlingIds.map(id => `<option value="${id}">${nameOf(id)}</option>`).join('')}
        </select>
        <button class="btn btn-primary btn-full" onclick="confirmOpeningPlayers()">Confirm &amp; Start</button>
      </div>
    </div>`;
}

async function confirmOpeningPlayers() {
  const strikerId = normalizeNullableInt(document.getElementById('opening-striker-select').value);
  const bowlerId = normalizeNullableInt(document.getElementById('opening-bowler-select').value);
  if (strikerId === null || bowlerId === null) {
    alert('Please choose both an opening batsman and bowler.');
    return;
  }
  await apiFetch(`${API}/matches/innings/${state.inningsId}/change-batsman`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ new_striker_id: strikerId })
  });
  await apiFetch(`${API}/matches/innings/${state.inningsId}/change-bowler`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ new_bowler_id: bowlerId })
  });
  closeExtraModal();
  refreshScorecard();
}

// --- Coin toss (done on match day, separate from team setup) ---

// Shows/hides the toss-not-done vs toss-done blocks in the Start Match card
// based on whether this match already has a recorded toss (e.g. resuming a
// match that was scheduled earlier, or re-entering after the toss was done).
function resetTossUI(match) {
  const notDone = document.getElementById('toss-not-done-block');
  const done = document.getElementById('toss-done-block');
  if (!notDone || !done) return;
  if (match && match.toss_winner_team && match.toss_decision) {
    notDone.style.display = 'none';
    done.style.display = 'block';
    applyTossResult(match);
  } else {
    notDone.style.display = 'block';
    done.style.display = 'none';
  }
}

function applyTossResult(match) {
  const teamAName = document.getElementById('team-a-name').value || 'Team A';
  const teamBName = document.getElementById('team-b-name').value || 'Team B';
  const winnerName = match.toss_winner_team === 'A' ? teamAName : teamBName;
  const battingTeam = match.toss_decision === 'bat' ? match.toss_winner_team : (match.toss_winner_team === 'A' ? 'B' : 'A');
  const summaryEl = document.getElementById('toss-result-summary');
  if (summaryEl) summaryEl.innerText = `🪙 ${winnerName} won the toss and chose to ${match.toss_decision}.`;
  const select = document.getElementById('innings-batting-team');
  if (select) select.value = battingTeam;
}

function openTossModal() {
  const teamAName = document.getElementById('team-a-name').value || 'Team A';
  const teamBName = document.getElementById('team-b-name').value || 'Team B';
  if (!state.tossPick) state.tossPick = { winner: null, decision: null };
  const pick = state.tossPick;
  const container = document.getElementById('extra-modal-container');
  container.innerHTML = `
    <div class="modal-overlay" onclick="if(event.target===this) closeExtraModal()">
      <div class="modal-sheet">
        <h3>Who won the toss?</h3>
        <div class="pill-grid" style="grid-template-columns:repeat(2,1fr);">
          <button onclick="selectTossWinner('A')" class="${pick.winner === 'A' ? 'selected' : ''}">${teamAName}</button>
          <button onclick="selectTossWinner('B')" class="${pick.winner === 'B' ? 'selected' : ''}">${teamBName}</button>
        </div>
        <div id="toss-decision-block" style="${pick.winner ? '' : 'display:none;'}">
          <span class="sub-label">Elected to</span>
          <div class="pill-grid" style="grid-template-columns:repeat(2,1fr);">
            <button onclick="selectTossDecision('bat')" class="${pick.decision === 'bat' ? 'selected' : ''}">Bat</button>
            <button onclick="selectTossDecision('bowl')" class="${pick.decision === 'bowl' ? 'selected' : ''}">Bowl</button>
          </div>
        </div>
        <button class="btn btn-primary btn-full" onclick="confirmToss()" ${pick.winner && pick.decision ? '' : 'disabled'}>Confirm Toss</button>
        <button class="btn btn-secondary btn-full" onclick="closeExtraModal()">Cancel</button>
      </div>
    </div>`;
}

function selectTossWinner(team) {
  state.tossPick = state.tossPick || {};
  state.tossPick.winner = team;
  openTossModal();
}

function selectTossDecision(decision) {
  state.tossPick = state.tossPick || {};
  state.tossPick.decision = decision;
  openTossModal();
}

async function confirmToss() {
  const pick = state.tossPick;
  if (!pick || !pick.winner || !pick.decision || !state.matchId) return;
  const res = await apiFetch(`${API}/matches/${state.matchId}/toss`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ toss_winner_team: pick.winner, toss_decision: pick.decision })
  });
  const match = await res.json();
  state.tossPick = null;
  closeExtraModal();
  resetTossUI(match);
}

function openCompleteMatchModal() {
  const container = document.getElementById('extra-modal-container');
  const teamAName = document.getElementById('team-a-name').value || 'Team A';
  const teamBName = document.getElementById('team-b-name').value || 'Team B';
  container.innerHTML = `
    <div class="modal-overlay" onclick="if(event.target===this) closeExtraModal()">
      <div class="modal-sheet">
        <h3>Record Match Result</h3>
        <div class="pill-grid" style="grid-template-columns:repeat(2,1fr);">
          <button onclick="confirmMatchResult('A')">${teamAName} Won</button>
          <button onclick="confirmMatchResult('B')">${teamBName} Won</button>
          <button onclick="confirmMatchResult('tie')" style="grid-column:1 / span 2;">Tie</button>
        </div>
        <button class="btn btn-secondary btn-full" onclick="confirmAbandonMatch()">Abandon Match</button>
        <button class="btn btn-secondary btn-full" onclick="closeExtraModal()">Cancel</button>
      </div>
    </div>`;
}

async function confirmMatchResult(winner) {
  await apiFetch(`${API}/matches/${state.matchId}/complete`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ winner_team: winner, result_summary: 'Recorded via scorer UI' })
  });
  closeExtraModal();
  alert('Match result recorded.');
}

async function confirmAbandonMatch() {
  await apiFetch(`${API}/matches/${state.matchId}/status`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ status: 'abandoned', result_summary: 'Abandoned from scorer UI' })
  });
  closeExtraModal();
  alert('Match marked abandoned. Watch Live can now switch away.');
}

async function recordMatchResult(winnerTeam) {
  if (!state.matchId) return;
  await apiFetch(`${API}/matches/${state.matchId}/complete`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ winner_team: winnerTeam, result_summary: 'Auto-recorded at innings completion' })
  });
}

async function scoreBall(runs) {
  if (!ensureScoringAllowed()) return;
  await apiFetch(`${API}/innings/${state.inningsId}/ball`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ runs })
  });
  refreshScorecard();
}

async function scoreWide() {
  if (!ensureScoringAllowed()) return;
  await apiFetch(`${API}/innings/${state.inningsId}/ball`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ runs: 0, extra_type: 'wide', extra_runs: 1 })
  });
  refreshScorecard();
}

function openWicketModal() {
  if (!ensureScoringAllowed()) return;
  const bowlingTeamIds = state.currentBowlingTeamIds || [];
  const container = document.getElementById('extra-modal-container');
  const dismissalTypes = ['bowled','caught','run_out','stumped','other'];
  container.innerHTML = `
    <div class="modal-overlay" onclick="if(event.target===this) closeExtraModal()">
      <div class="modal-sheet">
        <h3>Wicket — dismissal type</h3>
        <p class="helper-text" id="dismissal-required-hint">Select how the batsman was out.</p>
        <div class="pill-grid" id="dismissal-pill-grid">
          ${dismissalTypes.map(t => `<button onclick="selectDismissalType('${t}')" data-type="${t}">${t.replace('_',' ')}</button>`).join('')}
        </div>
        <div id="fielder-select-wrap" style="display:none; margin-bottom:12px;">
          <span class="sub-label">Fielder / Catcher</span>
          <select id="fielder-select" class="field" onchange="updateConfirmWicketButtonState()">
            <option value="">Select fielder...</option>
            ${bowlingTeamIds.map(id => `<option value="${id}">${nameOf(id)}</option>`).join('')}
          </select>
        </div>
        <button class="btn btn-primary btn-full" id="confirm-wicket-btn" onclick="confirmWicket()" disabled style="opacity:0.4; pointer-events:none;">Confirm Wicket</button>
        <button class="btn btn-secondary btn-full" style="margin-top:6px;" onclick="closeExtraModal()">Cancel</button>
      </div>
    </div>`;
  state.pendingDismissalType = null;
}

function selectDismissalType(type) {
  state.pendingDismissalType = type;
  document.querySelectorAll('#dismissal-pill-grid button').forEach(b =>
    b.classList.toggle('selected', b.dataset.type === type));
  const needsFielder = (type === 'caught' || type === 'run_out' || type === 'stumped');
  document.getElementById('fielder-select-wrap').style.display = needsFielder ? 'block' : 'none';
  const hint = document.getElementById('dismissal-required-hint');
  if (hint) hint.style.display = 'none';
  updateConfirmWicketButtonState();
}

function updateConfirmWicketButtonState() {
  const confirmBtn = document.getElementById('confirm-wicket-btn');
  if (!confirmBtn) return;
  const type = state.pendingDismissalType;
  const needsFielder = (type === 'caught' || type === 'run_out' || type === 'stumped');
  const fielderSelect = document.getElementById('fielder-select');
  const fielderChosen = fielderSelect && fielderSelect.value;
  const canConfirm = type && (!needsFielder || fielderChosen);
  confirmBtn.disabled = !canConfirm;
  confirmBtn.style.opacity = canConfirm ? '1' : '0.4';
  confirmBtn.style.pointerEvents = canConfirm ? 'auto' : 'none';
}

async function confirmWicket() {
  if (!ensureScoringAllowed()) return;
  if (!state.pendingDismissalType) return;
  const fielderSelect = document.getElementById('fielder-select');
  const fielderId = fielderSelect && fielderSelect.value ? parseInt(fielderSelect.value) : null;
  const needsFielder = ['caught','run_out','stumped'].includes(state.pendingDismissalType);
  if (needsFielder && !fielderId) return;
  await apiFetch(`${API}/innings/${state.inningsId}/ball`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      runs: 0, is_wicket: true, wicket_type: state.pendingDismissalType,
      fielder_id: needsFielder ? fielderId : null
    })
  });
  closeExtraModal();
  const inningsEnded = await refreshScorecard(true);
  if (!inningsEnded) {
    if (state.overCompletedPendingBowlerChoice) {
      await promptNextBatsmanThenBowler();
    } else {
      promptNextBatsman();
    }
  }
}

async function promptNextBatsmanThenBowler() {
  const bowlIds = state.overCompletedPendingBowlerChoice.bowlIds;
  const currentBowlerId = state.overCompletedPendingBowlerChoice.currentBowlerId;
  state.overCompletedPendingBowlerChoice = null;
  state.pendingOverBowlerId = currentBowlerId;

  const eligibleRes = await apiFetch(`${API}/innings/${state.inningsId}/eligible-batsmen`);
  const eligible = (await eligibleRes.json()).eligible_player_ids;
  const otherOptions = bowlIds.filter(id => id !== currentBowlerId);
  const defaultBowlerId = otherOptions.length > 0 ? otherOptions[0] : currentBowlerId;

  const container = document.getElementById('extra-modal-container');
  container.innerHTML = `
    <div class="modal-overlay">
      <div class="modal-sheet">
        <h3>Wicket &amp; over complete</h3>
        <p class="helper-text">Select the next batsman and the next bowler before continuing.</p>
        <span class="sub-label">Next Batsman</span>
        <select id="next-batsman-select" class="field">
          ${eligible.map(id => `<option value="${id}">${nameOf(id)}</option>`).join('')}
        </select>
        <span class="sub-label">Next Bowler</span>
        <select id="next-bowler-select" class="field">
          ${bowlIds.map(id => `<option value="${id}" ${id === defaultBowlerId ? 'selected' : ''}>${nameOf(id)}${id === currentBowlerId ? ' (bowled last over)' : ''}</option>`).join('')}
        </select>
        <button class="btn btn-primary btn-full" onclick="confirmNextBatsmanAndBowler()">Confirm &amp; Continue</button>
      </div>
    </div>`;
}

async function confirmNextBatsmanAndBowler() {
  const strikerId = normalizeNullableInt(document.getElementById('next-batsman-select').value);
  const bowlerId = normalizeNullableInt(document.getElementById('next-bowler-select').value);
  if (!confirmSameBowlerIfNeeded(bowlerId)) return;
  await apiFetch(`${API}/matches/innings/${state.inningsId}/change-batsman`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ new_striker_id: strikerId })
  });
  await apiFetch(`${API}/matches/innings/${state.inningsId}/change-bowler`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ new_bowler_id: bowlerId })
  });
  closeExtraModal();
  refreshScorecard();
}

async function retireBatsman() {
  if (!ensureScoringAllowed()) return;
  await apiFetch(`${API}/innings/${state.inningsId}/retire-striker`, { method: 'POST' });
  const inningsEnded = await refreshScorecard(true);
  if (!inningsEnded) {
    if (state.overCompletedPendingBowlerChoice) {
      await promptNextBatsmanThenBowler();
    } else {
      promptNextBatsman();
    }
  }
}

async function promptNextBatsman() {
  const eligibleRes = await apiFetch(`${API}/innings/${state.inningsId}/eligible-batsmen`);
  const eligible = (await eligibleRes.json()).eligible_player_ids;
  const container = document.getElementById('extra-modal-container');
  container.innerHTML = `
    <div class="modal-overlay">
      <div class="modal-sheet">
        <h3>Select next batsman</h3>
        <select id="next-batsman-select" class="field">
          ${eligible.map(id => `<option value="${id}">${nameOf(id)}</option>`).join('')}
        </select>
        <button class="btn btn-primary btn-full" onclick="confirmNextBatsman()">Confirm Batsman</button>
      </div>
    </div>`;
}

async function confirmNextBatsman() {
  const newId = normalizeNullableInt(document.getElementById('next-batsman-select').value);
  await apiFetch(`${API}/matches/innings/${state.inningsId}/change-batsman`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ new_striker_id: newId })
  });
  closeExtraModal();
  refreshScorecard();
}

function openExtraModal(type) {
  state.pendingExtraType = type;
  const isNoBall = type === 'no_ball';
  const container = document.getElementById('extra-modal-container');
  const options = [0,1,2,3,4,6];
  container.innerHTML = `
    <div class="modal-overlay" onclick="if(event.target===this) closeExtraModal()">
      <div class="modal-sheet">
        <h3>${labelFor(type)} — select runs</h3>
        <div class="pill-grid">
          ${options.map(r => `<button onclick="selectExtraRuns(${r})">${r}</button>`).join('')}
        </div>
        <button class="btn btn-secondary btn-full" onclick="closeExtraModal()">Cancel</button>
      </div>
    </div>`;
}

function labelFor(type) {
  return { wide: 'Wide', no_ball: 'No Ball', bye: 'Bye', leg_bye: 'Leg Bye' }[type] || type;
}

function closeExtraModal() {
  document.getElementById('extra-modal-container').innerHTML = '';
  state.pendingExtraType = null;
}

async function selectExtraRuns(runs) {
  if (!ensureScoringAllowed()) return;
  const type = state.pendingExtraType; // 'wide' or 'no_ball'
  if (type === 'no_ball') {
    // No ball always carries a fixed 1-run penalty; 'runs' here are runs scored off the bat by the batsman.
    await apiFetch(`${API}/innings/${state.inningsId}/ball`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ runs: runs, extra_type: type, extra_runs: 1 })
    });
  } else {
    const extraRuns = runs === 0 ? 1 : runs;
    await apiFetch(`${API}/innings/${state.inningsId}/ball`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ runs: 0, extra_type: type, extra_runs: extraRuns })
    });
  }
  closeExtraModal();
  refreshScorecard();
}

async function changeBatsman() {
  if (!ensureScoringAllowed()) return;
  const newId = normalizeNullableInt(document.getElementById('striker-select').value);
  await apiFetch(`${API}/matches/innings/${state.inningsId}/change-batsman`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ new_striker_id: newId })
  });
  refreshScorecard();
}

async function changeBowler() {
  if (!ensureScoringAllowed()) return;
  const newId = normalizeNullableInt(document.getElementById('bowler-select').value);
  await apiFetch(`${API}/matches/innings/${state.inningsId}/change-bowler`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ new_bowler_id: newId })
  });
  refreshScorecard();
}

async function refreshScorecard(skipBowlerPrompt = false) {
  const res = await apiFetch(`${API}/innings/${state.inningsId}/scorecard`);
  const data = await res.json();
  if (data.error) return false;
  // Cache fresh scorecard for offline use
  if (window.OfflineDB && !state.isOffline) OfflineDB.cacheSet(`scorecard_${state.inningsId}`, data);

  const prevOvers = state.lastOversCompleted;
  const newOvers = parseFloat(data.innings.overs_completed);
  const overJustCompleted = prevOvers !== undefined && Number.isInteger(newOvers) && newOvers > prevOvers;
  state.lastOversCompleted = newOvers;

  document.getElementById('sb-score').innerText = `${data.innings.total_runs}/${data.innings.total_wickets}`;
  document.getElementById('sb-overs').innerText = `${parseFloat(data.innings.overs_completed).toFixed(1)} ov`;
  const oversNum = trueOvers(data.innings.overs_completed);
  const crr = oversNum > 0 ? (data.innings.total_runs / oversNum).toFixed(2) : '0.00';
  document.getElementById('sb-crr').innerText = `CRR ${crr}`;

  const striker = data.batting.find(b => b.player_id === data.innings.striker_id);
  if (striker) {
    const sSr = striker.balls_faced > 0 ? ((striker.runs / striker.balls_faced) * 100).toFixed(1) : '0.0';
    document.getElementById('sb-striker-name').innerText = striker.name;
    document.getElementById('sb-striker-stats').innerText = `${striker.runs} (${striker.balls_faced}) SR ${sSr}`;
  }

  const currentBowler = data.bowling.find(b => b.player_id === data.innings.bowler_id);
  if (currentBowler) {
    document.getElementById('sb-bowler-name').innerText = currentBowler.name;
    document.getElementById('sb-bowler-stats').innerText = `${currentBowler.wickets}-${currentBowler.runs_conceded} (${parseFloat(currentBowler.overs_bowled).toFixed(1)})`;
  }

  const firstInningsRow = document.getElementById('sb-first-innings-row');
  if (data.innings.innings_no === 2 && state.firstInningsScore) {
    document.getElementById('sb-first-innings-label').innerText = state.firstInningsTeamName || 'Team';
    document.getElementById('sb-first-innings-score').innerText = state.firstInningsScore;
    firstInningsRow.style.display = 'block';
  } else if (firstInningsRow) {
    firstInningsRow.style.display = 'none';
  }

  const targetRow = document.getElementById('sb-target-row');
  if (state.matchTarget) {
    const oversLimit = state.matchOversLimit || 0;
    const ballsBowled = Math.floor(oversNum) * 6 + Math.round((oversNum % 1) * 10);
    const totalBalls = Math.round(oversLimit * 6);
    const ballsLeft = Math.max(totalBalls - ballsBowled, 0);
    const oversLeft = (ballsLeft / 6).toFixed(1);
    const runsNeeded = Math.max(state.matchTarget - data.innings.total_runs, 0);
    const rrr = ballsLeft > 0 ? (runsNeeded / (ballsLeft / 6)).toFixed(2) : '0.00';
    document.getElementById('sb-need-runs').innerText = runsNeeded;
    document.getElementById('sb-need-balls').innerText = `${ballsLeft} balls (${oversLeft} ov)`;
    document.getElementById('sb-rrr').innerText = rrr;
    targetRow.style.display = 'block';
  } else if (targetRow) {
    targetRow.style.display = 'none';
  }

  const battingBody = document.querySelector('#batting-table tbody');
  battingBody.innerHTML = data.batting.map(b => {
    const sr = b.balls_faced > 0 ? ((b.runs / b.balls_faced) * 100).toFixed(1) : '0.0';
    const cls = b.player_id === data.innings.striker_id ? 'striker' : '';
    return `<tr class="${cls}"><td class="clickable-name" onclick="showPlayerCard(${b.player_id})">${b.name}${b.status==='retired' ? ' (ret)' : b.status==='out' ? ' (out)' : ''}</td><td>${b.runs}</td><td>${b.balls_faced}</td><td>${b.fours}</td><td>${b.sixes}</td><td>${sr}</td></tr>`;
  }).join('');

  const bowlingBody = document.querySelector('#bowling-table tbody');
  bowlingBody.innerHTML = data.bowling.map(b => {
    const econ = calcEconomy(b.runs_conceded, b.overs_bowled);
    return `<tr><td class="clickable-name" onclick="showPlayerCard(${b.player_id})">${b.name}</td><td>${b.overs_bowled}</td><td>${b.maidens || 0}</td><td>${b.runs_conceded}</td><td>${b.wickets}</td><td>${b.wides || 0}</td><td>${b.no_balls || 0}</td><td>${econ}</td></tr>`;
  }).join('');

  const eligibleRes = await apiFetch(`${API}/innings/${state.inningsId}/eligible-batsmen`);
  const eligible = (await eligibleRes.json()).eligible_player_ids;
  const commonIds = state.commonPlayerIds || [];
  const currentBowlerId = data.innings.bowler_id;
  const currentStrikerId = data.innings.striker_id;

  const strikerOptions = eligible.filter(id => !(commonIds.includes(id) && id === currentBowlerId));
  document.getElementById('striker-select').innerHTML = strikerOptions.map(id =>
    `<option value="${id}" ${id === currentStrikerId ? 'selected' : ''}>${nameOf(id)}</option>`).join('');

  const bowlIds = data.bowling.map(b => b.player_id);
  const bowlerOptions = bowlIds.filter(id => !(commonIds.includes(id) && id === currentStrikerId));
  document.getElementById('bowler-select').innerHTML = bowlerOptions.map(id =>
    `<option value="${id}" ${id === currentBowlerId ? 'selected' : ''}>${nameOf(id)}</option>`).join('');

  renderThisOverBalls(data.innings);
  renderScoreOversRecap(data.overs_recap);

  const inningsEnded = await checkInningsCompletion(data);

  if (data.innings.innings_no === 1 && !inningsEnded) {
    state.matchTarget = null;
    state.firstInningsScore = null;
    state.firstInningsTeamName = null;
  }

  if (!inningsEnded && overJustCompleted && !skipBowlerPrompt) {
    promptNextBowler(data.bowling.map(b => b.player_id), data.innings.bowler_id);
  } else if (!inningsEnded && overJustCompleted && skipBowlerPrompt) {
    state.overCompletedPendingBowlerChoice = {
      bowlIds: data.bowling.map(b => b.player_id),
      currentBowlerId: data.innings.bowler_id
    };
  }

  return inningsEnded;
}

async function checkInningsCompletion(data) {
  if (state.inningsCompletionHandled) return true;

  const matchRes = await apiFetch(`${API}/matches/${state.matchId}`);
  const match = await matchRes.json();
  const oversLimit = parseFloat(match.overs_limit);
  const oversDone = parseFloat(data.innings.overs_completed);
  state.matchOversLimit = oversLimit;

  const eligibleRes = await apiFetch(`${API}/innings/${state.inningsId}/eligible-batsmen`);
  const eligible = (await eligibleRes.json()).eligible_player_ids;
  const allOut = eligible.length <= 0;
  const oversFinished = oversDone >= oversLimit;

  const bowlingTeamName = state.currentBattingTeam === 'A' ? (match.team_b_name || 'Team B') : (match.team_a_name || 'Team A');
  const battingTeamName = state.currentBattingTeamName || 'Batting team';

  if (data.innings.innings_no === 2 && state.matchTarget && data.innings.total_runs >= state.matchTarget) {
    state.inningsCompletionHandled = true;
    const wicketsInHand = eligible.length;
    const winnerText = `${battingTeamName} won by ${Math.max(wicketsInHand, 0)} wicket(s), chasing down the target!`;
    recordMatchResult(state.currentBattingTeam);
    showMatchCompleteModal(winnerText, battingTeamName);
    return true;
  }

  if (allOut || oversFinished) {
    state.inningsCompletionHandled = true;
    if (data.innings.innings_no === 2) {
      const firstInningsRuns = state.matchTarget - 1;
      const isTie = data.innings.total_runs === firstInningsRuns;
      const won = data.innings.total_runs > firstInningsRuns;
      const margin = firstInningsRuns - data.innings.total_runs;
      const bowlingTeam = state.currentBattingTeam === 'A' ? 'B' : 'A';

      if (isTie) {
        state.matchTarget = null;
        recordMatchResult('tie');
        showMatchCompleteModal(`Match tied! Both teams scored ${data.innings.total_runs} runs.`, null);
      } else {
        const winnerName = won ? battingTeamName : bowlingTeamName;
        const winnerTeam = won ? state.currentBattingTeam : bowlingTeam;
        const reason = won
          ? `${battingTeamName} won by chasing the target!`
          : `${bowlingTeamName} won! ${battingTeamName} fell short by ${Math.max(margin, 0)} run(s).`;
        state.matchTarget = null;
        recordMatchResult(winnerTeam);
        showMatchCompleteModal(reason, winnerName);
      }
    } else {
      state.matchTarget = data.innings.total_runs + 1;
      state.firstInningsScore = `${data.innings.total_runs}/${data.innings.total_wickets}`;
      state.firstInningsTeamName = state.currentBattingTeamName;
      const reason = allOut ? 'All batsmen are out.' : 'Overs limit reached.';
      showInningsCompleteModal(reason);
    }
    return true;
  }
  return false;
}


function lockScoringControls(showMatchEndedNotice = true) {
  const buttons = document.getElementById('score-ball-buttons');
  const actions = document.getElementById('score-ball-actions');
  const notice = document.getElementById('match-ended-notice');
  if (buttons) buttons.classList.add('scoring-disabled');
  if (actions) actions.classList.add('scoring-disabled');
  if (notice) notice.style.display = showMatchEndedNotice ? 'block' : 'none';
}

function unlockScoringControls() {
  const buttons = document.getElementById('score-ball-buttons');
  const actions = document.getElementById('score-ball-actions');
  const notice = document.getElementById('match-ended-notice');
  if (buttons) buttons.classList.remove('scoring-disabled');
  if (actions) actions.classList.remove('scoring-disabled');
  if (notice) notice.style.display = 'none';
}

function showMatchCompleteModal(reason, winnerName = null) {
  state.matchIsComplete = true;
  lockScoringControls();
  const banner = document.getElementById('sb-winner-banner');
  const winnerTextEl = document.getElementById('sb-winner-text');
  if (banner && winnerTextEl) {
    winnerTextEl.innerText = winnerName ? `${winnerName} won!` : reason;
    banner.style.display = 'block';
  }
  const container = document.getElementById('extra-modal-container');
  container.innerHTML = `
    <div class="modal-overlay">
      <div class="modal-sheet">
        <h3>🏆 Match Complete</h3>
        <p class="helper-text">${reason}</p>
        <button class="btn btn-primary btn-full" onclick="startNextGame()">🏏 Start Next Game</button>
        <button class="btn btn-secondary btn-full" style="margin-top:6px;" onclick="closeExtraModal()">Stay Here</button>
      </div>
    </div>`;
}

function startNextGame() {
  closeExtraModal();
  document.getElementById('sb-winner-banner').style.display = 'none';
  state.matchId = null;
  state.inningsId = null;
  state.matchTarget = null;
  state.firstInningsScore = null;
  state.firstInningsTeamName = null;
  state.matchIsComplete = false;
  state.inningsCompletionHandled = false;
  document.getElementById('start-innings-card').style.display = 'none';
  document.getElementById('match-status').innerText = '';
  document.getElementById('attendance-assign-section').style.display = 'block';
  document.getElementById('add-player-section').style.display = 'block';
  document.getElementById('edit-teams-toggle-card').style.display = 'none';
  document.getElementById('teams-summary-card').style.display = 'none';
  showView('setup');
}

function showInningsCompleteModal(reason) {
  const container = document.getElementById('extra-modal-container');
  container.innerHTML = `
    <div class="modal-overlay">
      <div class="modal-sheet">
        <h3>Innings Complete</h3>
        <p class="helper-text">${reason} Ready to start the next innings?</p>
        <button class="btn btn-primary btn-full" onclick="startNextInnings()">Start Next Innings</button>
        <button class="btn btn-secondary btn-full" style="margin-top:6px;" onclick="closeExtraModal()">Not yet</button>
      </div>
    </div>`;
}

async function startNextInnings() {
  await apiFetch(`${API}/matches/innings/${state.inningsId}/complete`, { method: 'POST' });
  closeExtraModal();
  const nextBattingTeam = state.currentBattingTeam === 'A' ? 'B' : 'A';
  state.inningsCompletionHandled = false;
  state.lastOversCompleted = undefined;
  document.getElementById('innings-batting-team').value = nextBattingTeam;
  await startInnings(2);
}

function promptNextBowler(bowlIds, currentBowlerId) {
  const container = document.getElementById('extra-modal-container');
  state.pendingOverBowlerId = currentBowlerId;
  const otherOptions = bowlIds.filter(id => id !== currentBowlerId);
  const defaultId = otherOptions.length > 0 ? otherOptions[0] : currentBowlerId;
  container.innerHTML = `
    <div class="modal-overlay">
      <div class="modal-sheet">
        <h3>Over complete — pick next bowler</h3>
        <p class="helper-text">${nameOf(currentBowlerId)} bowled the last over. Pick a different bowler to keep the attack rotating (you can still re-select them if needed).</p>
        <select id="next-bowler-select" class="field">
          ${bowlIds.map(id => `<option value="${id}" ${id === defaultId ? 'selected' : ''}>${nameOf(id)}${id === currentBowlerId ? ' (bowled last over)' : ''}</option>`).join('')}
        </select>
        <button class="btn btn-primary btn-full" onclick="confirmNextBowler()">Confirm Bowler</button>
      </div>
    </div>`;
}

async function confirmNextBowler() {
  const newId = normalizeNullableInt(document.getElementById('next-bowler-select').value);
  if (!confirmSameBowlerIfNeeded(newId)) return;
  await apiFetch(`${API}/matches/innings/${state.inningsId}/change-bowler`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ new_bowler_id: newId })
  });
  closeExtraModal();
  refreshScorecard();
}

function renderScoreOversRecap(oversRecap) {
  const el = document.getElementById('score-overs-recap');
  if (!el) return;
  const overs = Array.isArray(oversRecap) ? oversRecap : [];
  el.innerHTML = overs.slice().reverse().map(over => {
    const pills = over.balls.map(b => {
      const cls = b.is_wicket ? 'ball-pill wicket' : (b.runs === 6 ? 'ball-pill six' : b.runs === 4 ? 'ball-pill four' : 'ball-pill');
      return `<span class="${cls}">${b.display}</span>`;
    }).join('');
    return `
      <div class="over-recap-row">
        <div class="over-recap-header">
          <span>Over ${over.over_no + 1} — <b>${over.bowler_name}</b> to ${formatOverBatsmen(over)}</span>
          <span class="over-recap-total">${over.runs} Runs, ${over.wickets} Wkt</span>
        </div>
        <div class="over-recap-balls">${pills}</div>
      </div>`;
  }).join('') || '<p class="helper-text">No balls recorded yet.</p>';
}

async function renderThisOverBalls(innings) {
  const oversInt = Math.floor(innings.overs_completed);
  const container = document.getElementById('this-over-balls');
  // When offline, derive this-over pills from the cached overs_recap rather
  // than making a separate network call that will fail.
  let balls;
  if (state.isOffline && window.OfflineDB) {
    const sc = await OfflineDB.cacheGet(`scorecard_${state.inningsId}`);
    const overEntry = sc && sc.overs_recap ? sc.overs_recap.find(o => o.over_no === oversInt) : null;
    balls = overEntry ? overEntry.balls.map((b, i) => ({
      id: i, runs: b.runs, extra_type: b.extra_type, is_wicket: b.is_wicket
    })) : [];
  } else {
    const res = await fetch(`${API}/innings/${state.inningsId}/over/${oversInt}/balls`);
    balls = await res.json();
  }
  if (balls.length === 0) {
    container.innerHTML = `<span style="font-size:12px; color:var(--sub);">Over ${oversInt + 1} — no balls yet</span>`;
    return;
  }
  container.innerHTML = balls.map(b => {
    const cls = b.is_wicket ? 'ball-pill wicket' : (b.runs === 6 ? 'ball-pill six' : b.runs === 4 ? 'ball-pill four' : 'ball-pill');
    const label = b.is_wicket ? 'W' : (b.extra_type === 'wide' ? 'Wd' : b.extra_type === 'no_ball' ? 'Nb' : String(b.runs));
    return `<span class="${cls}">${label}</span>`;
  }).join('');
}

// On load: show the Scorer/Watcher choice screen. Do NOT auto-jump into setup.
// If the URL has a ?match= param or a ?view=watch param, assume the visitor wants to watch directly.
(function initApp() {
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('match') || urlParams.get('view') === 'watch') {
    document.getElementById('mode-select-view').style.display = 'none';
    enterWatchMode();
  }
})();

// ---- PWA: service worker + install prompt ----
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
    // Show offline banner immediately if starting without a network
    updateOfflineBanner();
    // If we came back online while the app was closed, drain the queue now
    if (navigator.onLine) triggerSync();
  });
}

let deferredPwaInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredPwaInstallPrompt = event;
  const btn = document.getElementById('pwa-install-btn');
  if (btn) btn.style.display = 'block';
});

function triggerPwaInstall() {
  const btn = document.getElementById('pwa-install-btn');
  if (btn) btn.style.display = 'none';
  if (!deferredPwaInstallPrompt) return;
  deferredPwaInstallPrompt.prompt();
  deferredPwaInstallPrompt = null;
}

window.addEventListener('appinstalled', () => {
  const btn = document.getElementById('pwa-install-btn');
  if (btn) btn.style.display = 'none';
  deferredPwaInstallPrompt = null;
});
