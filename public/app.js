
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
  await fetch(`${API}/players`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ name, is_common_player: isCommon })
  });
  nameInput.value = '';
  document.getElementById('is-common').checked = false;
  await loadPlayers();
}

async function undoLastBall() {
  if (!state.inningsId) return;
  const res = await fetch(`${API}/innings/${state.inningsId}/undo`, { method: 'POST' });
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
  const role = d.wickets > 0 && d.total_runs > 100 ? 'All-Rounder' : (d.wickets > 0 ? 'Bowler' : 'Batsman');

  const container = document.getElementById('player-card-container');
  container.innerHTML = `
    <div class="player-card-overlay" onclick="if(event.target===this) closePlayerCard()">
      <div class="player-card">
        <div class="player-card-header">
          <div class="player-card-avatar">${initial}</div>
          <div>
            <p class="player-card-name">${d.player.name}</p>
            <p class="player-card-role">${role}</p>
          </div>
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
  showView('setup');
  loadPlayers();
}

function enterLeaderboardMode() {
  state.appMode = 'scorer';
  document.getElementById('mode-select-view').style.display = 'none';
  document.getElementById('watch-view').style.display = 'none';
  document.getElementById('main-tabbar').style.display = 'flex';
  document.getElementById('share-watch-btn').style.display = 'none';
  showView('leaderboard');
}

function enterWatchMode() {
  state.appMode = 'watcher';
  document.getElementById('mode-select-view').style.display = 'none';
  document.getElementById('main-tabbar').style.display = 'none';
  document.getElementById('share-watch-btn').style.display = 'none';
  document.getElementById('setup-view').style.display = 'none';
  document.getElementById('score-view').style.display = 'none';
  document.getElementById('leaderboard-view').style.display = 'none';
  document.getElementById('stats-view').style.display = 'none';
  document.getElementById('watch-view').style.display = 'block';
  document.getElementById('topbar-title').innerText = 'Live Match';
  promptWatchMatchSelection();
}

function backToModeSelect() {
  if (state.watchPollInterval) clearInterval(state.watchPollInterval);
  state.appMode = null;
  document.getElementById('watch-view').style.display = 'none';
  document.getElementById('setup-view').style.display = 'none';
  document.getElementById('score-view').style.display = 'none';
  document.getElementById('leaderboard-view').style.display = 'none';
  document.getElementById('stats-view').style.display = 'none';
  document.getElementById('main-tabbar').style.display = 'none';
  document.getElementById('share-watch-btn').style.display = 'none';
  document.getElementById('topbar-title').innerText = 'Cricket Scorer';
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
  const inProgress = matches.filter(m => m.status === 'in_progress');
  if (inProgress.length === 0) {
    document.getElementById('watch-view').innerHTML = `<div class="card" style="margin-top:60px; text-align:center;"><p class="helper-text" style="text-align:center;">No match is currently in progress. Ask the scorer to start one, or check back soon.</p></div>`;
    return;
  }
  state.watchMatchId = inProgress[0].id;
  await resolveWatchInnings();
  startWatchPolling();
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
  refreshWatchScorecard();
  state.watchPollInterval = setInterval(refreshWatchScorecard, 4000);
}

async function refreshWatchScorecard() {
  if (!state.watchInningsId) {
    await resolveWatchInnings();
    if (!state.watchInningsId) return;
  } else {
    const latestRes = await fetch(`${API}/matches/${state.watchMatchId}/current-innings`);
    if (latestRes.ok) {
      const latestInnings = await latestRes.json();
      if (latestInnings && latestInnings.id !== state.watchInningsId) {
        state.watchInningsId = latestInnings.id;
        document.getElementById('watch-target-row').style.display = 'none';
        document.getElementById('watch-first-innings-row').style.display = 'none';
      }
    }
  }
  const res = await fetch(`${API}/innings/${state.watchInningsId}/scorecard`);
  const data = await res.json();
  const match = state.watchMatch || {};
  const teamName = data.innings.batting_team === 'A' ? match.team_a_name : match.team_b_name;

  document.getElementById('watch-batting-team').innerText = teamName || 'Batting Team';
  document.getElementById('watch-overs-limit').innerText = match.overs_limit ? `${match.overs_limit} ov limit` : '';
  document.getElementById('watch-score').innerText = `${data.innings.total_runs}/${data.innings.total_wickets}`;
  document.getElementById('watch-overs').innerText = `${parseFloat(data.innings.overs_completed).toFixed(1)} ov`;
  const crr = data.innings.overs_completed > 0 ? (data.innings.total_runs / parseFloat(data.innings.overs_completed)).toFixed(2) : '0.00';
  document.getElementById('watch-crr').innerText = `CRR ${crr}`;

  const watchStriker = data.batting.find(b => b.player_id === data.innings.striker_id);
  if (watchStriker) {
    const wSr = watchStriker.balls_faced > 0 ? ((watchStriker.runs / watchStriker.balls_faced) * 100).toFixed(1) : '0.0';
    document.getElementById('watch-striker-name').innerText = watchStriker.name;
    document.getElementById('watch-striker-stats').innerText = `${watchStriker.runs} (${watchStriker.balls_faced}) SR ${wSr}`;
  }

  const watchBowler = data.bowling.find(b => b.player_id === data.innings.bowler_id);
  if (watchBowler) {
    document.getElementById('watch-bowler-name').innerText = watchBowler.name;
    document.getElementById('watch-bowler-stats').innerText = `${watchBowler.wickets}-${watchBowler.runs_conceded} (${parseFloat(watchBowler.overs_bowled).toFixed(1)})`;
  }

  const watchTargetRow = document.getElementById('watch-target-row');
  const watchFirstInningsRow = document.getElementById('watch-first-innings-row');
  if (data.first_innings) {
    document.getElementById('watch-first-innings-label').innerText = data.first_innings.team_name || 'Team';
    document.getElementById('watch-first-innings-score').innerText = `${data.first_innings.total_runs}/${data.first_innings.total_wickets}`;
    watchFirstInningsRow.style.display = 'block';

    const oversLimit = match.overs_limit || 0;
    const oversNumW = parseFloat(data.innings.overs_completed) || 0;
    const ballsBowledW = Math.floor(oversNumW) * 6 + Math.round((oversNumW % 1) * 10);
    const totalBallsW = Math.round(oversLimit * 6);
    const ballsLeftW = Math.max(totalBallsW - ballsBowledW, 0);
    const oversLeftW = (ballsLeftW / 6).toFixed(1);
    const runsNeededW = Math.max(data.first_innings.target - data.innings.total_runs, 0);
    const rrrW = ballsLeftW > 0 ? (runsNeededW / (ballsLeftW / 6)).toFixed(2) : '0.00';
    document.getElementById('watch-need-runs').innerText = runsNeededW;
    document.getElementById('watch-need-balls').innerText = `${ballsLeftW} balls (${oversLeftW} ov)`;
    document.getElementById('watch-rrr').innerText = rrrW;
    watchTargetRow.style.display = 'block';
  } else {
    if (watchTargetRow) watchTargetRow.style.display = 'none';
    if (watchFirstInningsRow) watchFirstInningsRow.style.display = 'none';
  }

  document.querySelector('#watch-batting-table tbody').innerHTML = data.batting.map(b => `
    <tr><td>${b.name}${b.status === 'out' ? '' : b.status === 'batting' ? ' *' : ''}</td><td>${b.runs}</td><td>${b.balls_faced}</td><td>${b.fours}</td><td>${b.sixes}</td>
    <td>${b.balls_faced > 0 ? Math.round(b.runs / b.balls_faced * 100) : 0}</td></tr>`).join('');

  document.querySelector('#watch-bowling-table tbody').innerHTML = data.bowling.map(bw => `
    <tr><td>${bw.name}</td><td>${bw.overs_bowled}</td><td>${bw.runs_conceded}</td><td>${bw.wickets}</td></tr>`).join('');

  document.getElementById('watch-fow').innerHTML = data.fall_of_wickets.map(f =>
    `${f.team_score_at_fall}-${f.wicket_no} (${f.name}, ${f.over_at_fall} ov)`).join(' &nbsp;•&nbsp; ') || 'No wickets yet';

  const oversInt = Math.floor(parseFloat(data.innings.overs_completed));
  const ballsRes = await fetch(`${API}/innings/${state.watchInningsId}/over/${oversInt}/balls`);
  const balls = await ballsRes.json();
  document.getElementById('watch-this-over-balls').innerHTML = balls.map(b => {
    let cls = 'runs', label = String(b.runs);
    if (b.is_wicket) { cls = 'wicket'; label = 'W'; }
    else if (b.extra_type === 'wide') { cls = 'extra'; label = 'Wd'; }
    else if (b.extra_type === 'no_ball') { cls = 'extra'; label = `${b.runs}nb`; }
    else if (b.runs === 4) { cls = 'four'; }
    else if (b.runs === 6) { cls = 'six'; }
    return `<div class="ball-pill ${cls}">${label}</div>`;
  }).join('') || '<span style="font-size:12px; color:var(--sub);">Over in progress</span>';
}

function shareWatchLink() {
  if (!state.matchId) { alert('Start a match first.'); return; }
  const url = `${window.location.origin}${window.location.pathname}?match=${state.matchId}`;
  if (navigator.share) {
    navigator.share({ title: 'Follow the live score', url });
  } else {
    navigator.clipboard.writeText(url);
    alert('Watch link copied to clipboard:\n' + url);
  }
}

function formatDateOnly(dateStr) {
  if (!dateStr) return '';
  return String(dateStr).split('T')[0];
}
// public/app.js
const API = '/api';
let state = {
  players: [], matchId: null, inningsId: null,
  swipeQueue: [], swipeIndex: 0, teamAIds: [], teamBIds: [],
  pendingExtraType: null
};

function showView(view) {
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
  const titles = { setup: 'Setup Match', score: 'Live Score', scorecard: 'Scorecard', leaderboard: 'Leaderboard', stats: 'Stats' };
  document.getElementById('topbar-title').innerText = titles[view];
  if (view === 'stats') { loadDailyStats(); loadOverallStats(); loadMatchHistory(); loadMatchListForProgress(); }
  if (view === 'leaderboard') { loadLeaderboard(); }
  if (view === 'scorecard') { loadMatchListForScorecard(); }
  window.scrollTo(0, 0);
}


async function loadMatchListForScorecard() {
  const res = await fetch(`${API}/matches`);
  const matches = await res.json();
  const sel = document.getElementById('scorecard-match-select');
  sel.innerHTML = matches.map(m => `<option value="${m.id}">${m.team_a_name} vs ${m.team_b_name} - ${new Date(m.created_at).toLocaleDateString()}</option>`).join('');
  if (matches.length > 0) { sel.value = matches[0].id; loadFullScorecard(); }
}

async function loadFullScorecard() {
  const matchId = document.getElementById('scorecard-match-select').value;
  if (!matchId) return;
  const res = await fetch(`${API}/matches/${matchId}/full-scorecard`);
  const inningsList = await res.json();
  const container = document.getElementById('scorecard-innings-container');
  container.innerHTML = inningsList.map(inn => {
    const teamLabel = inn.innings.batting_team === 'A' ? 'Team A' : 'Team B';
    const battingRows = inn.batting.map(b => {
      const sr = b.balls_faced > 0 ? ((b.runs / b.balls_faced) * 100).toFixed(1) : '0.0';
      return `<tr><td>${b.name}${b.status==='retired' ? ' (ret)' : b.status==='out' ? ' (out)' : ''}</td><td>${b.runs}</td><td>${b.balls_faced}</td><td>${b.fours}</td><td>${b.sixes}</td><td>${sr}</td></tr>`;
    }).join('');
    const bowlingRows = inn.bowling.map(b => {
      const econ = b.overs_bowled > 0 ? (b.runs_conceded / b.overs_bowled).toFixed(2) : '0.00';
      return `<tr><td>${b.name}</td><td>${b.overs_bowled}</td><td>${b.runs_conceded}</td><td>${b.wickets}</td><td>${econ}</td></tr>`;
    }).join('');
    const oversRecapHtml = (inn.overs_recap || []).map(over => {
      const pills = over.balls.map(b => {
        const isBoundary = b.runs === 4 || b.runs === 6;
        const cls = b.is_wicket ? 'ball-pill wicket' : (isBoundary ? 'ball-pill boundary' : 'ball-pill');
        return `<span class="${cls}">${b.display}</span>`;
      }).join('');
      return `
        <div class="over-recap-row">
          <div class="over-recap-header">Over ${over.over_no + 1} — <b>${over.bowler_name}</b> to ${over.batsman_name}
            <span class="over-recap-total">(${over.runs} Runs, ${over.wickets} Wkt)</span>
          </div>
          <div class="over-recap-balls">${pills}</div>
        </div>`;
    }).join('');
    return `
      <div class="card">
        <h2>${teamLabel} — Innings ${inn.innings.innings_no} (${inn.innings.total_runs}/${inn.innings.total_wickets}, ${parseFloat(inn.innings.overs_completed).toFixed(1)} ov)</h2>
        <table class="mini-table"><thead><tr><th>Batter</th><th>R</th><th>B</th><th>4s</th><th>6s</th><th>SR</th></tr></thead><tbody>${battingRows}</tbody></table>
        <h3 style="margin-top:10px; font-size:13px; color:var(--sub);">Bowling</h3>
        <table class="mini-table"><thead><tr><th>Bowler</th><th>O</th><th>R</th><th>W</th><th>Econ</th></tr></thead><tbody>${bowlingRows}</tbody></table>
      </div>
      <div class="card">
        <h3 style="margin-top:0; font-size:13px; color:var(--sub);">Ball-by-Ball Recap</h3>
        <div class="over-recap-container">${oversRecapHtml}</div>
      </div>`;
  }).join('');
}

async function loadMatchListForProgress() {
  const res = await fetch(`${API}/matches`);
  const matches = await res.json();
  const sel = document.getElementById('progress-match-select');
  sel.innerHTML = matches.map(m => `<option value="${m.id}">${m.team_a_name} vs ${m.team_b_name} - ${new Date(m.created_at).toLocaleDateString()}</option>`).join('');
  if (matches.length > 0) { sel.value = matches[0].id; loadOverProgress(); }
}

let overProgressChartInstance = null;
async function loadOverProgress() {
  const matchId = document.getElementById('progress-match-select').value;
  if (!matchId) return;
  const res = await fetch(`${API}/matches/${matchId}/over-progress`);
  const inningsProgress = await res.json();
  const ctx = document.getElementById('over-progress-chart');
  if (overProgressChartInstance) { overProgressChartInstance.destroy(); }
  const colors = ['#22c55e', '#3b82f6'];
  const maxOvers = Math.max(0, ...inningsProgress.map(ip => ip.per_over.length));
  const labels = Array.from({length: maxOvers}, (_, i) => `Ov ${i+1}`);
  const datasets = inningsProgress.map((ip, idx) => ({
    label: `Innings ${ip.innings_no} (Team ${ip.batting_team})`,
    data: ip.per_over.map(o => o.cumulative_runs),
    borderColor: colors[idx % colors.length],
    backgroundColor: colors[idx % colors.length],
    tension: 0.3,
    fill: false
  }));
  overProgressChartInstance = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: { responsive: true, maintainAspectRatio: false, scales: { y: { title: { display: true, text: 'Cumulative Runs' } } } }
  });
}

async function loadLeaderboard() {
  const res = await fetch(`${API}/stats/leaderboard`);
  const data = await res.json();
  document.querySelector('#lb-live-batting-table tbody').innerHTML = data.batting.map(r => `
    <tr>
      <td class="clickable-name" onclick="showPlayerCard(${r.player_id || r.id})">${r.name}</td><td>${r.matches_played}</td><td>${r.innings_played}</td><td>${r.total_runs}</td>
      <td>${r.fours}</td><td>${r.sixes}</td><td>${r.avg}</td><td>${Math.round(r.strike_rate)}</td>
      <td>${r.wins}-${r.losses}</td><td>${r.win_pct}%</td>
    </tr>`).join('');
  loadUploadedAggregate();
  loadUploadsList();
}

async function loadUploadedAggregate() {
  const res = await fetch(`${API}/leaderboard/aggregate`);
  const rows = await res.json();
  document.querySelector('#lb-batting-table tbody').innerHTML = rows.map(r => `
    <tr>
      <td>${r.player_name}</td><td>${r.matches_played}</td><td>${r.innings_played}</td><td>${r.runs}</td>
      <td>${r.fours}</td><td>${r.sixes}</td><td>${r.avg}</td><td>${Math.round(r.strike_rate)}</td>
      <td>${r.wins}-${r.losses}</td><td>${r.win_pct}%</td>
    </tr>`).join('');
  document.querySelector('#lb-bowling-table tbody').innerHTML = rows.filter(r => r.wickets > 0 || r.overs_bowled > 0).map(r => `
    <tr>
      <td>${r.player_name}</td><td>${r.matches_played}</td><td>${r.overs_bowled}</td><td>${r.wickets}</td>
      <td>${r.runs_conceded}</td><td>${r.economy}</td>
    </tr>`).join('');
}

async function loadUploadsList() {
  const res = await fetch(`${API}/leaderboard/uploads`);
  const rows = await res.json();
  document.querySelector('#uploads-table tbody').innerHTML = rows.map(r => `
    <tr>
      <td>${r.source_label}</td><td>${r.player_count}</td><td>${formatDateOnly(r.uploaded_at)}</td>
      <td><button class="btn" style="padding:6px 10px; font-size:12px; background:var(--red); color:white;" onclick="deleteUploadBatch('${r.source_label}')">Delete</button></td>
    </tr>`).join('');
}

function toggleAdminPanel() {
  const panel = document.getElementById('admin-panel');
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

function getAdminPassword() {
  return document.getElementById('admin-password').value;
}

async function uploadLeaderboardPdf() {
  const fileInput = document.getElementById('pdf-upload-input');
  const label = document.getElementById('upload-label').value || 'Untitled upload';
  const password = getAdminPassword();
  if (!password) {
    document.getElementById('upload-status').innerText = 'Enter the admin password first.';
    return;
  }
  if (!fileInput.files.length) {
    document.getElementById('upload-status').innerText = 'Please choose a PDF file first.';
    return;
  }
  const formData = new FormData();
  formData.append('file', fileInput.files[0]);
  formData.append('source_label', label);
  formData.append('admin_password', password);
  document.getElementById('upload-status').innerText = 'Uploading and parsing...';
  try {
    const res = await fetch(`${API}/leaderboard/upload`, { method: 'POST', body: formData });
    const result = await res.json();
    if (result.error) {
      document.getElementById('upload-status').innerText = `Error: ${result.error}`;
    } else {
      document.getElementById('upload-status').innerText = `Imported ${result.rows_imported} player rows.`;
      fileInput.value = '';
      document.getElementById('upload-label').value = '';
      loadUploadedAggregate();
      loadUploadsList();
    }
  } catch (err) {
    document.getElementById('upload-status').innerText = 'Upload failed: ' + err.message;
  }
}

async function deleteUploadBatch(label) {
  const password = getAdminPassword();
  if (!password) { alert('Enter the admin password first.'); return; }
  if (!confirm(`Delete uploaded batch "${label}"?`)) return;
  const res = await fetch(`${API}/leaderboard/uploads/${encodeURIComponent(label)}?admin_password=${encodeURIComponent(password)}`, { method: 'DELETE' });
  const result = await res.json();
  if (result.error) { alert(result.error); return; }
  loadUploadedAggregate();
  loadUploadsList();
}

async function deleteAllUploads() {
  const password = getAdminPassword();
  if (!password) { alert('Enter the admin password first.'); return; }
  if (!confirm('This will delete ALL uploaded overall leaderboard data. Continue?')) return;
  const res = await fetch(`${API}/leaderboard/all?admin_password=${encodeURIComponent(password)}`, { method: 'DELETE' });
  const result = await res.json();
  if (result.error) { alert(result.error); return; }
  loadUploadedAggregate();
  loadUploadsList();
}

async function loadMatchHistory() {
  const res = await fetch(`${API}/stats/matches-history`);
  const rows = await res.json();
  document.querySelector('#history-table tbody').innerHTML = rows.map(r => {
    const result = r.status === 'completed'
      ? (r.winner_team === 'tie' ? 'Tie' : `${r.winner_team === 'A' ? r.team_a_name : r.team_b_name} won`)
      : 'In progress';
    return `<tr><td>${formatDateOnly(r.match_date)}</td><td>${r.team_a_name} vs ${r.team_b_name}</td><td>${result}</td></tr>`;
  }).join('');
}

async function loadPlayers() {
  const res = await fetch(`${API}/players`);
  state.players = await res.json();
  state.attendingIds = new Set();
  state.teamAIds = [];
  state.teamBIds = [];
  state.commonPlayerIds = [];
  renderAttendanceList();
  renderAssignTapList();
}

function renderAttendanceList() {
  const container = document.getElementById('attendance-list');
  container.innerHTML = state.players.map(p => `
    <div class="attend-row">
      <input type="checkbox" id="attend-${p.id}" ${state.attendingIds.has(p.id) ? 'checked' : ''} onchange="toggleAttendance(${p.id})">
      <label for="attend-${p.id}">${p.name}</label>
    </div>`).join('');
  updateAttendanceCount();
}

function toggleAttendance(playerId) {
  if (state.attendingIds.has(playerId)) {
    state.attendingIds.delete(playerId);
    state.teamAIds = state.teamAIds.filter(id => id !== playerId);
    state.teamBIds = state.teamBIds.filter(id => id !== playerId);
    state.commonPlayerIds = state.commonPlayerIds.filter(id => id !== playerId);
  } else {
    state.attendingIds.add(playerId);
  }
  updateAttendanceCount();
  renderAssignTapList();
}

function updateAttendanceCount() {
  document.getElementById('attendance-count').innerText = `${state.attendingIds.size} player(s) selected`;
}

function renderAssignTapList() {
  const container = document.getElementById('assign-chip-box');
  if (!container) return;
  const attendingPlayers = state.players.filter(p => state.attendingIds.has(p.id));
  if (attendingPlayers.length === 0) {
    container.innerHTML = `<p class="helper-text" style="margin:6px;">Tick attendance above first, then assign teams here.</p>`;
    updateTeamCountChips();
    return;
  }
  const allAssigned = attendingPlayers.every(p =>
    state.teamAIds.includes(p.id) || state.teamBIds.includes(p.id) || state.commonPlayerIds.includes(p.id)
  );
  const groupRank = (p) => {
    if (state.teamAIds.includes(p.id)) return 0;
    if (state.teamBIds.includes(p.id)) return 1;
    if (state.commonPlayerIds.includes(p.id)) return 2;
    return 3;
  };
  const displayPlayers = allAssigned
    ? [...attendingPlayers].sort((a, b) => groupRank(a) - groupRank(b))
    : attendingPlayers;
  container.innerHTML = displayPlayers.map(p => {
    let cls = '';
    if (state.commonPlayerIds.includes(p.id)) cls = 'common';
    else if (state.teamAIds.includes(p.id)) cls = 'team-a';
    else if (state.teamBIds.includes(p.id)) cls = 'team-b';
    return `<span class="player-chip ${cls}" onclick="cyclePlayerChip(${p.id})">${p.name}</span>`;
  }).join('');
  updateTeamCountChips();
}

function cyclePlayerChip(playerId) {
  const inCommon = state.commonPlayerIds.includes(playerId);
  const inA = !inCommon && state.teamAIds.includes(playerId);
  const inB = !inCommon && state.teamBIds.includes(playerId);

  state.teamAIds = state.teamAIds.filter(id => id !== playerId);
  state.teamBIds = state.teamBIds.filter(id => id !== playerId);
  state.commonPlayerIds = state.commonPlayerIds.filter(id => id !== playerId);

  if (!inA && !inB && !inCommon) {
    state.teamAIds.push(playerId);
  } else if (inA) {
    state.teamBIds.push(playerId);
  } else if (inB) {
    state.commonPlayerIds.push(playerId);
  } else if (inCommon) {
    // cycles back to unassigned
  }
  renderAssignTapList();
}


function toggleAttendanceAssignSection() {
  const section = document.getElementById('attendance-assign-section');
  const addPlayerSection = document.getElementById('add-player-section');
  const label = document.getElementById('edit-teams-toggle-label');
  const isHidden = section.style.display === 'none';
  section.style.display = isHidden ? 'block' : 'none';
  addPlayerSection.style.display = isHidden ? 'block' : 'none';
  label.innerText = isHidden ? '✕ Close Editing' : '✏️ Edit Players / Teams';
}

function renderTeamsSummary(match) {
  const card = document.getElementById('teams-summary-card');
  const content = document.getElementById('teams-summary-content');
  if (!card || !content) return;
  const teamANames = state.teamAIds.map(id => nameOf(id));
  const teamBNames = state.teamBIds.map(id => nameOf(id));
  const commonNames = state.commonPlayerIds.map(id => nameOf(id));
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
      <span class="sub-label" style="color:var(--primary-dark);">Common Players</span>
      <div style="font-size:13px; line-height:1.6;">${commonNames.join(', ')}</div>
    </div>` : ''}
  `;
  card.style.display = 'block';
}

async function createMatch() {
  const body = {
    team_a_name: document.getElementById('team-a-name').value || 'Team A',
    team_b_name: document.getElementById('team-b-name').value || 'Team B',
    overs_limit: parseFloat(document.getElementById('overs-limit').value),
    retirement_overs: parseFloat(document.getElementById('retirement-overs').value),
    team_a_player_ids: [...state.teamAIds, ...state.commonPlayerIds],
    team_b_player_ids: [...state.teamBIds, ...state.commonPlayerIds]
  };
  if (body.team_a_player_ids.length < 2 || body.team_b_player_ids.length < 2) {
    document.getElementById('match-status').innerText = 'Assign at least a few players to each team first.';
    return;
  }
  const res = await fetch(`${API}/matches`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)
  });
  const match = await res.json();
  state.matchId = match.id;
  document.getElementById('match-status').innerText = `Match created: ${match.team_a_name} vs ${match.team_b_name}`;
  document.getElementById('start-innings-card').style.display = 'block';
  document.getElementById('attendance-assign-section').style.display = 'none';
  document.getElementById('add-player-section').style.display = 'none';
  document.getElementById('edit-teams-toggle-card').style.display = 'block';
  renderTeamsSummary(match);
  populateInningsSelectors();
  document.getElementById('sb-overs-limit').innerText = `${match.overs_limit} overs`;
  document.getElementById('share-watch-btn').style.display = 'block';
}

function populateInningsSelectors() {
  // Striker/bowler are now chosen via the opening-players modal after the innings starts,
  // so this function is now a no-op kept for backward compatibility with existing calls.
}

function nameOf(id) { return (state.players.find(p => p.id === id) || {}).name || id; }

async function startInnings(inningsNo = 1) {
  const battingTeam = document.getElementById('innings-batting-team').value;
  const bowlingTeam = battingTeam === 'A' ? 'B' : 'A';
  const teamName = battingTeam === 'A' ? document.getElementById('team-a-name').value : document.getElementById('team-b-name').value;
  state.currentBattingTeamName = teamName;
  state.matchIsComplete = false;
  unlockScoringControls();
  if (inningsNo === 1) { state.matchTarget = null; state.firstInningsScore = null; state.firstInningsTeamName = null; }
  const res = await fetch(`${API}/matches/${state.matchId}/innings`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ innings_no: inningsNo, batting_team: battingTeam, bowling_team: bowlingTeam })
  });
  const innings = await res.json();
  state.inningsId = innings.id;
  state.currentBattingTeam = battingTeam;
  state.currentBowlingTeamIds = (bowlingTeam === 'A' ? state.teamAIds : state.teamBIds).concat(state.commonPlayerIds);
  document.getElementById('sb-batting-team').innerText = teamName;
  const battingIdsCount = battingTeam === 'A' ? state.teamAIds.length : state.teamBIds.length;
  document.getElementById('sb-players-count').innerText = `(${battingIdsCount} players)`;
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
  const strikerId = parseInt(document.getElementById('opening-striker-select').value);
  const bowlerId = parseInt(document.getElementById('opening-bowler-select').value);
  await fetch(`${API}/matches/innings/${state.inningsId}/change-batsman`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ new_striker_id: strikerId })
  });
  await fetch(`${API}/matches/innings/${state.inningsId}/change-bowler`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ new_bowler_id: bowlerId })
  });
  closeExtraModal();
  refreshScorecard();
}

function openCompleteMatchModal() {
  const container = document.getElementById('extra-modal-container');
  const teamAName = document.getElementById('team-a-name').value || 'Team A';
  const teamBName = document.getElementById('team-b-name').value || 'Team B';
  container.innerHTML = `
    <div class="modal-overlay" onclick="if(event.target===this) closeExtraModal()">
      <div class="modal-sheet">
        <h3>Record Match Result</h3>
        <div class="pill-grid" style="grid-template-columns:repeat(3,1fr);">
          <button onclick="confirmMatchResult('A')">${teamAName} Won</button>
          <button onclick="confirmMatchResult('B')">${teamBName} Won</button>
          <button onclick="confirmMatchResult('tie')">Tie</button>
        </div>
        <button class="btn btn-secondary btn-full" onclick="closeExtraModal()">Cancel</button>
      </div>
    </div>`;
}

async function confirmMatchResult(winner) {
  await fetch(`${API}/matches/${state.matchId}/complete`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ winner_team: winner, result_summary: 'Recorded via scorer UI' })
  });
  closeExtraModal();
  alert('Match result recorded.');
}

async function scoreBall(runs) {
  if (state.matchIsComplete) return;
  await fetch(`${API}/innings/${state.inningsId}/ball`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ runs })
  });
  refreshScorecard();
}

async function scoreWide() {
  if (state.matchIsComplete) return;
  await fetch(`${API}/innings/${state.inningsId}/ball`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ runs: 0, extra_type: 'wide', extra_runs: 1 })
  });
  refreshScorecard();
}

function openWicketModal() {
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
  if (!state.pendingDismissalType) return;
  const fielderSelect = document.getElementById('fielder-select');
  const fielderId = fielderSelect && fielderSelect.value ? parseInt(fielderSelect.value) : null;
  const needsFielder = ['caught','run_out','stumped'].includes(state.pendingDismissalType);
  if (needsFielder && !fielderId) return;
  await fetch(`${API}/innings/${state.inningsId}/ball`, {
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

  const eligibleRes = await fetch(`${API}/innings/${state.inningsId}/eligible-batsmen`);
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
  const strikerId = parseInt(document.getElementById('next-batsman-select').value);
  const bowlerId = parseInt(document.getElementById('next-bowler-select').value);
  await fetch(`${API}/matches/innings/${state.inningsId}/change-batsman`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ new_striker_id: strikerId })
  });
  await fetch(`${API}/matches/innings/${state.inningsId}/change-bowler`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ new_bowler_id: bowlerId })
  });
  closeExtraModal();
  refreshScorecard();
}

async function retireBatsman() {
  await fetch(`${API}/innings/${state.inningsId}/retire-striker`, { method: 'POST' });
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
  const eligibleRes = await fetch(`${API}/innings/${state.inningsId}/eligible-batsmen`);
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
  const newId = parseInt(document.getElementById('next-batsman-select').value);
  await fetch(`${API}/matches/innings/${state.inningsId}/change-batsman`, {
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
  const type = state.pendingExtraType; // 'wide' or 'no_ball'
  if (type === 'no_ball') {
    // No ball always carries a fixed 1-run penalty; 'runs' here are runs scored off the bat by the batsman.
    await fetch(`${API}/innings/${state.inningsId}/ball`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ runs: runs, extra_type: type, extra_runs: 1 })
    });
  } else {
    const extraRuns = runs === 0 ? 1 : runs;
    await fetch(`${API}/innings/${state.inningsId}/ball`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ runs: 0, extra_type: type, extra_runs: extraRuns })
    });
  }
  closeExtraModal();
  refreshScorecard();
}

async function changeBatsman() {
  const newId = parseInt(document.getElementById('striker-select').value);
  await fetch(`${API}/matches/innings/${state.inningsId}/change-batsman`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ new_striker_id: newId })
  });
  refreshScorecard();
}

async function changeBowler() {
  const newId = parseInt(document.getElementById('bowler-select').value);
  await fetch(`${API}/matches/innings/${state.inningsId}/change-bowler`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ new_bowler_id: newId })
  });
  refreshScorecard();
}

async function refreshScorecard(skipBowlerPrompt = false) {
  const res = await fetch(`${API}/innings/${state.inningsId}/scorecard`);
  const data = await res.json();

  const prevOvers = state.lastOversCompleted;
  const newOvers = parseFloat(data.innings.overs_completed);
  const overJustCompleted = prevOvers !== undefined && Number.isInteger(newOvers) && newOvers > prevOvers;
  state.lastOversCompleted = newOvers;

  document.getElementById('sb-score').innerText = `${data.innings.total_runs}/${data.innings.total_wickets}`;
  document.getElementById('sb-overs').innerText = `${parseFloat(data.innings.overs_completed).toFixed(1)} ov`;
  const oversNum = parseFloat(data.innings.overs_completed) || 0.0001;
  const crr = (data.innings.total_runs / oversNum).toFixed(2);
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
    const econ = b.overs_bowled > 0 ? (b.runs_conceded / b.overs_bowled).toFixed(2) : '0.00';
    return `<tr><td class="clickable-name" onclick="showPlayerCard(${b.player_id})">${b.name}</td><td>${b.overs_bowled}</td><td>${b.runs_conceded}</td><td>${b.wickets}</td><td>${econ}</td></tr>`;
  }).join('');

  const eligibleRes = await fetch(`${API}/innings/${state.inningsId}/eligible-batsmen`);
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

  const inningsEnded = await checkInningsCompletion(data);

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

  const matchRes = await fetch(`${API}/matches/${state.matchId}`);
  const match = await matchRes.json();
  const oversLimit = parseFloat(match.overs_limit);
  const oversDone = parseFloat(data.innings.overs_completed);
  state.matchOversLimit = oversLimit;

  const eligibleRes = await fetch(`${API}/innings/${state.inningsId}/eligible-batsmen`);
  const eligible = (await eligibleRes.json()).eligible_player_ids;
  const allOut = eligible.length <= 0;
  const oversFinished = oversDone >= oversLimit;

  const bowlingTeamName = state.currentBattingTeam === 'A' ? (match.team_b_name || 'Team B') : (match.team_a_name || 'Team A');
  const battingTeamName = state.currentBattingTeamName || 'Batting team';

  if (data.innings.innings_no === 2 && state.matchTarget && data.innings.total_runs >= state.matchTarget) {
    state.inningsCompletionHandled = true;
    const wicketsInHand = eligible.length;
    const winnerText = `${battingTeamName} won by ${Math.max(wicketsInHand, 0)} wicket(s), chasing down the target!`;
    showMatchCompleteModal(winnerText, battingTeamName);
    return true;
  }

  if (allOut || oversFinished) {
    state.inningsCompletionHandled = true;
    if (data.innings.innings_no === 2) {
      const won = data.innings.total_runs >= state.matchTarget;
      const margin = state.matchTarget - data.innings.total_runs - 1;
      const winnerName = won ? battingTeamName : bowlingTeamName;
      const reason = won
        ? `${battingTeamName} won by chasing the target!`
        : `${bowlingTeamName} won! ${battingTeamName} fell short by ${Math.max(margin + 1, 0)} run(s).`;
      state.matchTarget = null;
      showMatchCompleteModal(reason, winnerName);
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


function lockScoringControls() {
  const buttons = document.getElementById('score-ball-buttons');
  const actions = document.getElementById('score-ball-actions');
  const notice = document.getElementById('match-ended-notice');
  if (buttons) buttons.classList.add('scoring-disabled');
  if (actions) actions.classList.add('scoring-disabled');
  if (notice) notice.style.display = 'block';
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
  await fetch(`${API}/matches/innings/${state.inningsId}/complete`, { method: 'POST' });
  closeExtraModal();
  const nextBattingTeam = state.currentBattingTeam === 'A' ? 'B' : 'A';
  state.inningsCompletionHandled = false;
  state.lastOversCompleted = undefined;
  document.getElementById('innings-batting-team').value = nextBattingTeam;
  await startInnings(2);
}

function promptNextBowler(bowlIds, currentBowlerId) {
  const container = document.getElementById('extra-modal-container');
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
  const newId = parseInt(document.getElementById('next-bowler-select').value);
  await fetch(`${API}/matches/innings/${state.inningsId}/change-bowler`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ new_bowler_id: newId })
  });
  closeExtraModal();
  refreshScorecard();
}

async function renderThisOverBalls(innings) {
  const oversInt = Math.floor(innings.overs_completed);
  const container = document.getElementById('this-over-balls');
  const res = await fetch(`${API}/innings/${state.inningsId}/over/${oversInt}/balls`);
  const balls = await res.json();
  if (balls.length === 0) {
    container.innerHTML = `<span style="font-size:12px; color:var(--sub);">Over ${oversInt + 1} — no balls yet</span>`;
    return;
  }
  container.innerHTML = balls.map(b => {
    let cls = 'runs', label = String(b.runs);
    if (b.is_wicket) { cls = 'wicket'; label = 'W'; }
    else if (b.extra_type === 'wide') { cls = 'extra'; label = 'Wd'; }
    else if (b.extra_type === 'no_ball') { cls = 'extra'; label = `${b.runs}nb`; }
    else if (b.runs === 4) { cls = 'four'; }
    else if (b.runs === 6) { cls = 'six'; }
    return `<div class="ball-pill ${cls}">${label}</div>`;
  }).join('');
}

async function loadDailyStats() {
  const date = document.getElementById('stats-date').value;
  const url = date ? `${API}/stats/daily?date=${date}` : `${API}/stats/daily`;
  const res = await fetch(url);
  const rows = await res.json();
  document.querySelector('#daily-stats-table tbody').innerHTML = rows.map(r =>
    `<tr><td>${r.name}</td><td>${r.total_runs}</td><td>${r.balls_faced}</td><td>${r.wickets}</td></tr>`).join('');
}

async function loadOverallStats() {
  const res = await fetch(`${API}/stats/overall`);
  const rows = await res.json();
  document.querySelector('#overall-stats-table tbody').innerHTML = rows.map(r =>
    `<tr><td>${r.name}</td><td>${r.innings_played}</td><td>${r.total_runs}</td><td>${Math.round(r.strike_rate)}</td><td>${r.wickets}</td><td>${r.wins}-${r.losses}</td><td>${r.win_pct}%</td></tr>`).join('');
}

// On load: show the Scorer/Watcher choice screen. Do NOT auto-jump into setup.
// If the URL has a ?match= param, assume the visitor wants to watch that match directly.
(function initApp() {
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('match')) {
    document.getElementById('mode-select-view').style.display = 'none';
    enterWatchMode();
  }
})();
