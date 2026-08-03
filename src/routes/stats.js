// src/routes/stats.js
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

router.get('/daily', async (req, res) => {
  const { date } = req.query;
  const params = [];
  let whereClause = '';
  if (date) {
    params.push(date);
    whereClause = 'WHERE m.match_date = $1';
  }
  const result = await pool.query(`
    SELECT p.id AS player_id, p.name, m.match_date,
      COALESCE(SUM(br.runs),0) AS total_runs,
      COALESCE(SUM(br.balls_faced),0) AS balls_faced,
      COALESCE(SUM(br.fours),0) AS fours,
      COALESCE(SUM(br.sixes),0) AS sixes,
      COUNT(DISTINCT CASE WHEN br.status='out' THEN br.id END) AS dismissals,
      COALESCE(SUM(bwr.wickets),0) AS wickets,
      COALESCE(SUM(bwr.runs_conceded),0) AS runs_conceded,
      COALESCE(SUM(bwr.overs_bowled),0) AS overs_bowled
    FROM players p
    LEFT JOIN batting_records br ON br.player_id = p.id
    LEFT JOIN innings i ON i.id = br.innings_id
    LEFT JOIN matches m ON m.id = i.match_id
    LEFT JOIN bowling_records bwr ON bwr.player_id = p.id AND bwr.innings_id = i.id
    ${whereClause}
    GROUP BY p.id, p.name, m.match_date
    ORDER BY m.match_date DESC, total_runs DESC
  `, params);
  res.json(result.rows);
});

// Overall stats including win/loss tally per player (mirrors leaderboard PDF columns)
router.get('/overall', async (req, res) => {
  const result = await pool.query(`
    WITH player_matches AS (
      SELECT DISTINCT mp.player_id, mp.match_id, mp.team, m.winner_team, m.status
      FROM match_players mp
      JOIN matches m ON m.id = mp.match_id
      WHERE m.status = 'completed' AND m.winner_team IS NOT NULL AND m.winner_team <> 'tie'
    ),
    -- Common players who played on BOTH teams in the same match have their
    -- win/loss for that match cancel out, so we exclude those match rows entirely.
    team_count_per_match AS (
      SELECT player_id, match_id, COUNT(DISTINCT team) AS teams_played
      FROM player_matches
      GROUP BY player_id, match_id
    ),
    decisive_player_matches AS (
      SELECT pm.*
      FROM player_matches pm
      JOIN team_count_per_match tc
        ON tc.player_id = pm.player_id AND tc.match_id = pm.match_id
      WHERE tc.teams_played = 1
    ),
    win_loss AS (
      SELECT player_id,
        COUNT(*) FILTER (WHERE team = winner_team) AS wins,
        COUNT(*) FILTER (WHERE team <> winner_team) AS losses
      FROM decisive_player_matches
      GROUP BY player_id
    )
    SELECT p.id AS player_id, p.name,
      COALESCE(SUM(br.runs),0) AS total_runs,
      COALESCE(SUM(br.balls_faced),0) AS balls_faced,
      COALESCE(SUM(br.fours),0) AS fours,
      COALESCE(SUM(br.sixes),0) AS sixes,
      COUNT(DISTINCT br.innings_id) AS innings_played,
      COUNT(DISTINCT CASE WHEN br.status='out' THEN br.id END) AS dismissals,
      COALESCE(SUM(bwr.wickets),0) AS wickets,
      COALESCE(SUM(bwr.runs_conceded),0) AS runs_conceded,
      CASE WHEN COALESCE(SUM(br.balls_faced),0) > 0
        THEN ROUND(SUM(br.runs)::numeric / SUM(br.balls_faced) * 100, 0)
        ELSE 0 END AS strike_rate,
      COALESCE(wl.wins, 0) AS wins,
      COALESCE(wl.losses, 0) AS losses,
      CASE WHEN COALESCE(wl.wins,0) + COALESCE(wl.losses,0) > 0
        THEN ROUND(wl.wins::numeric / (wl.wins + wl.losses) * 100, 1)
        ELSE 0 END AS win_pct
    FROM players p
    LEFT JOIN batting_records br ON br.player_id = p.id
    LEFT JOIN bowling_records bwr ON bwr.player_id = p.id
    LEFT JOIN win_loss wl ON wl.player_id = p.id
    GROUP BY p.id, p.name, wl.wins, wl.losses
    ORDER BY total_runs DESC
  `);
  res.json(result.rows);
});

// Match history with results, for tracking day-to-day wins/losses
router.get('/matches-history', async (req, res) => {
  const result = await pool.query(`
    SELECT id, to_char(match_date, 'YYYY-MM-DD') AS match_date, team_a_name, team_b_name, winner_team, result_summary, status
    FROM matches ORDER BY match_date DESC, id DESC
  `);
  res.json(result.rows);
});

// Full leaderboard mimicking the reference PDF format (batting + bowling)
router.get('/leaderboard', async (req, res) => {
  const battingRes = await pool.query(`
    WITH player_matches AS (
      SELECT DISTINCT mp.player_id, mp.match_id, mp.team, m.winner_team, m.status
      FROM match_players mp
      JOIN matches m ON m.id = mp.match_id
      WHERE m.status = 'completed' AND m.winner_team IS NOT NULL AND m.winner_team <> 'tie'
    ),
    team_count_per_match AS (
      SELECT player_id, match_id, COUNT(DISTINCT team) AS teams_played
      FROM player_matches GROUP BY player_id, match_id
    ),
    decisive_player_matches AS (
      SELECT pm.* FROM player_matches pm
      JOIN team_count_per_match tc ON tc.player_id = pm.player_id AND tc.match_id = pm.match_id
      WHERE tc.teams_played = 1
    ),
    win_loss AS (
      SELECT player_id,
        COUNT(*) FILTER (WHERE team = winner_team) AS wins,
        COUNT(*) FILTER (WHERE team <> winner_team) AS losses
      FROM decisive_player_matches GROUP BY player_id
    ),
    match_counts AS (
      SELECT player_id, COUNT(DISTINCT match_id) AS matches_played
      FROM match_players GROUP BY player_id
    )
    SELECT p.id AS player_id, p.name,
      COALESCE(mc.matches_played, 0) AS matches_played,
      COUNT(DISTINCT br.innings_id) AS innings_played,
      COALESCE(SUM(br.runs), 0) AS total_runs,
      COALESCE(SUM(br.fours), 0) AS fours,
      COALESCE(SUM(br.sixes), 0) AS sixes,
      COUNT(DISTINCT br.innings_id) FILTER (WHERE br.status IN ('out')) AS dismissals,
      CASE WHEN COUNT(DISTINCT br.innings_id) > 0
        THEN ROUND(SUM(br.runs)::numeric / COUNT(DISTINCT br.innings_id), 1)
        ELSE 0 END AS avg,
      CASE WHEN COALESCE(SUM(br.balls_faced), 0) > 0
        THEN ROUND(SUM(br.runs)::numeric / SUM(br.balls_faced) * 100, 0)
        ELSE 0 END AS strike_rate,
      COALESCE(wl.wins, 0) AS wins,
      COALESCE(wl.losses, 0) AS losses,
      CASE WHEN COALESCE(wl.wins,0) + COALESCE(wl.losses,0) > 0
        THEN ROUND(wl.wins::numeric / (wl.wins + wl.losses) * 100, 1)
        ELSE 0 END AS win_pct
    FROM players p
    LEFT JOIN batting_records br ON br.player_id = p.id
    LEFT JOIN win_loss wl ON wl.player_id = p.id
    LEFT JOIN match_counts mc ON mc.player_id = p.id
    GROUP BY p.id, p.name, wl.wins, wl.losses, mc.matches_played
    ORDER BY total_runs DESC
  `);

  const bowlingRes = await pool.query(`
    WITH match_counts AS (
      SELECT player_id, COUNT(DISTINCT match_id) AS matches_played
      FROM match_players GROUP BY player_id
    )
    SELECT p.id AS player_id, p.name,
      COALESCE(mc.matches_played, 0) AS matches_played,
      COALESCE(SUM(bwr.overs_bowled), 0) AS overs_bowled,
      COALESCE(SUM(bwr.wickets), 0) AS wickets,
      COALESCE(SUM(bwr.runs_conceded), 0) AS runs_conceded,
      CASE WHEN COALESCE(SUM(bwr.overs_bowled), 0) > 0
        THEN ROUND(SUM(bwr.runs_conceded)::numeric / SUM(bwr.overs_bowled), 2)
        ELSE 0 END AS economy
    FROM players p
    LEFT JOIN bowling_records bwr ON bwr.player_id = p.id
    LEFT JOIN match_counts mc ON mc.player_id = p.id
    GROUP BY p.id, p.name, mc.matches_played
    ORDER BY wickets DESC, economy ASC
  `);

  res.json({ batting: battingRes.rows, bowling: bowlingRes.rows });
});

// Individual player overall stats card (batting + bowling combined)
router.get('/player/:playerId', async (req, res) => {
  const { playerId } = req.params;
  const playerRes = await pool.query('SELECT * FROM players WHERE id=$1', [playerId]);
  if (!playerRes.rows[0]) return res.status(404).json({ error: 'Player not found' });

  const battingRes = await pool.query(`
    SELECT
      COUNT(DISTINCT br.innings_id) AS innings_played,
      COALESCE(SUM(br.runs), 0) AS total_runs,
      COALESCE(MAX(br.runs), 0) AS high_score,
      COUNT(*) FILTER (WHERE br.status = 'out') AS dismissals,
      COALESCE(SUM(br.balls_faced), 0) AS balls_faced,
      COALESCE(SUM(br.fours), 0) AS fours,
      COALESCE(SUM(br.sixes), 0) AS sixes
    FROM batting_records br WHERE br.player_id = $1
  `, [playerId]);

  const bowlingRes = await pool.query(`
    SELECT COALESCE(SUM(wickets), 0) AS wickets, COALESCE(SUM(overs_bowled), 0) AS overs_bowled,
      COALESCE(SUM(runs_conceded), 0) AS runs_conceded
    FROM bowling_records WHERE player_id = $1
  `, [playerId]);

  const matchCountRes = await pool.query(`
    SELECT COUNT(DISTINCT match_id) AS matches_played FROM match_players WHERE player_id = $1
  `, [playerId]);

  const b = battingRes.rows[0];
  const bowl = bowlingRes.rows[0];
  const dismissals = parseInt(b.dismissals);
  const inningsPlayed = parseInt(b.innings_played);
  const ballsFaced = parseInt(b.balls_faced);
  const totalRuns = parseInt(b.total_runs);

  const average = dismissals > 0 ? Math.round((totalRuns / dismissals) * 10) / 10 : totalRuns;
  const strikeRate = ballsFaced > 0 ? Math.round((totalRuns / ballsFaced) * 100) : 0;
  const highScoreOut = await pool.query(
    `SELECT runs, status FROM batting_records WHERE player_id=$1 ORDER BY runs DESC LIMIT 1`, [playerId]
  );
  const topScore = highScoreOut.rows[0];
  const highDisplay = topScore ? `${topScore.runs}${topScore.status !== 'out' ? '*' : ''}` : '0';

  res.json({
    player: playerRes.rows[0],
    matches_played: parseInt(matchCountRes.rows[0].matches_played),
    innings_played: inningsPlayed,
    total_runs: totalRuns,
    high_score: highDisplay,
    average,
    strike_rate: strikeRate,
    wickets: parseInt(bowl.wickets),
    overs_bowled: parseFloat(bowl.overs_bowled),
    runs_conceded: parseInt(bowl.runs_conceded)
  });
});

module.exports = router;
