// src/routes/matches.js
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { requireAdminToken } = require('./admin');

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

// Create a match, split teams (supports one common player on both sides)
router.post('/', async (req, res) => {
  const {
    match_date, match_time = null, overs_limit = 8, retirement_overs = 2,
    team_a_name, team_b_name, match_name, team_a_player_ids, team_b_player_ids
  } = req.body;

  if (!team_a_player_ids || !team_b_player_ids) {
    return res.status(400).json({ error: 'team_a_player_ids and team_b_player_ids are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const matchResult = await client.query(
      `INSERT INTO matches (match_date, match_time, overs_limit, retirement_overs, team_a_name, team_b_name, match_name, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'setup') RETURNING *`,
      [match_date || new Date(), match_time || null, overs_limit, retirement_overs, team_a_name, team_b_name, match_name || `${team_a_name} vs ${team_b_name}`]
    );
    const match = matchResult.rows[0];

    for (const pid of team_a_player_ids) {
      await client.query(
        'INSERT INTO match_players (match_id, player_id, team) VALUES ($1,$2,$3)',
        [match.id, pid, 'A']
      );
    }
    for (const pid of team_b_player_ids) {
      await client.query(
        'INSERT INTO match_players (match_id, player_id, team) VALUES ($1,$2,$3)',
        [match.id, pid, 'B']
      );
    }
    await client.query('COMMIT');
    res.json(match);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Start an innings: sets initial striker/bowler, creates batting/bowling records
router.post('/:matchId/innings', async (req, res) => {
  const { matchId } = req.params;
  const { innings_no, batting_team, bowling_team, striker_id = null, bowler_id = null } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inningsResult = await client.query(
      `INSERT INTO innings (match_id, innings_no, batting_team, bowling_team, striker_id, bowler_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [matchId, innings_no, batting_team, bowling_team, striker_id, bowler_id]
    );
    const innings = inningsResult.rows[0];

    const battingPlayers = await client.query(
      'SELECT player_id FROM match_players WHERE match_id=$1 AND team=$2',
      [matchId, batting_team]
    );
    for (const row of battingPlayers.rows) {
      await client.query(
        `INSERT INTO batting_records (innings_id, player_id, status)
         VALUES ($1, $2, $3)`,
        [innings.id, row.player_id, striker_id && row.player_id === striker_id ? 'batting' : 'yet_to_bat']
      );
    }

    const bowlingPlayers = await client.query(
      'SELECT player_id FROM match_players WHERE match_id=$1 AND team=$2',
      [matchId, bowling_team]
    );
    for (const row of bowlingPlayers.rows) {
      await client.query(
        `INSERT INTO bowling_records (innings_id, player_id) VALUES ($1, $2)`,
        [innings.id, row.player_id]
      );
    }

    await client.query('UPDATE matches SET status=$1 WHERE id=$2', ['in_progress', matchId]);
    await client.query('COMMIT');
    res.json(innings);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Change striker mid-innings
router.post('/innings/:inningsId/change-batsman', async (req, res) => {
  const { inningsId } = req.params;
  const newStrikerId = normalizeNullableInt(req.body.new_striker_id);
  await pool.query('UPDATE innings SET striker_id=$1 WHERE id=$2', [newStrikerId, inningsId]);
  await pool.query(
    `UPDATE batting_records SET status='batting' WHERE innings_id=$1 AND player_id=$2`,
    [inningsId, newStrikerId]
  );
  res.json({ success: true });
});

// Change bowler mid-innings
router.post('/innings/:inningsId/change-bowler', async (req, res) => {
  const { inningsId } = req.params;
  const newBowlerId = normalizeNullableInt(req.body.new_bowler_id);
  await pool.query('UPDATE innings SET bowler_id=$1 WHERE id=$2', [newBowlerId, inningsId]);
  res.json({ success: true });
});

// --- Post-hoc scoring corrections -----------------------------------------
// Unlike change-batsman/change-bowler above (which just move the live
// striker/bowler pointer during scoring), these rewrite who a set of
// already-recorded stats belongs to — e.g. the wrong player was selected
// while scoring and every run/ball/wicket in that innings needs to move to
// the right person. Admin-gated, like other after-the-fact match edits
// (team rename, delete), since it silently rewrites completed data.

// Reassign every batting stat in one innings from old_player_id to
// new_player_id: the batting_records row itself, the ball-by-ball batsman_id
// on every ball they faced, and their fall-of-wickets entry if they got out.
// Does NOT touch bowler_id/fielder_id on OTHER batsmen's dismissals — those
// record old_player_id correctly performing a different role (bowling/
// fielding), which this correction isn't about.
router.post('/innings/:inningsId/correct-batsman', requireAdminToken, async (req, res) => {
  const { inningsId } = req.params;
  const oldPlayerId = normalizeNullableInt(req.body.old_player_id);
  const newPlayerId = normalizeNullableInt(req.body.new_player_id);
  if (!oldPlayerId || !newPlayerId) {
    return res.status(400).json({ error: 'old_player_id and new_player_id are required' });
  }
  if (oldPlayerId === newPlayerId) {
    return res.status(400).json({ error: 'New player must be different from the current player' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inningsRes = await client.query('SELECT * FROM innings WHERE id=$1 FOR UPDATE', [inningsId]);
    const innings = inningsRes.rows[0];
    if (!innings) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Innings not found' }); }

    const existingRes = await client.query(
      'SELECT id FROM batting_records WHERE innings_id=$1 AND player_id=$2', [inningsId, oldPlayerId]
    );
    if (existingRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'That player has no batting record in this innings' });
    }
    const conflictRes = await client.query(
      'SELECT id FROM batting_records WHERE innings_id=$1 AND player_id=$2', [inningsId, newPlayerId]
    );
    if (conflictRes.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'The new player already has a batting record in this innings — merge is not supported' });
    }

    // Make sure the corrected player is actually on the batting team's roster
    // for this match, so leaderboard/history joins and future editing pick
    // them up correctly.
    await client.query(
      `INSERT INTO match_players (match_id, player_id, team) VALUES ($1, $2, $3)
       ON CONFLICT (match_id, player_id, team) DO NOTHING`,
      [innings.match_id, newPlayerId, innings.batting_team]
    );

    await client.query('UPDATE batting_records SET player_id=$1 WHERE innings_id=$2 AND player_id=$3', [newPlayerId, inningsId, oldPlayerId]);
    await client.query('UPDATE ball_events SET batsman_id=$1 WHERE innings_id=$2 AND batsman_id=$3', [newPlayerId, inningsId, oldPlayerId]);
    await client.query('UPDATE fall_of_wickets SET player_id=$1 WHERE innings_id=$2 AND player_id=$3', [newPlayerId, inningsId, oldPlayerId]);
    if (innings.striker_id === oldPlayerId) {
      await client.query('UPDATE innings SET striker_id=$1 WHERE id=$2', [newPlayerId, inningsId]);
    }

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Reassign every bowling stat in one innings from old_player_id to
// new_player_id: the bowling_records row, ball-by-ball bowler_id, and any
// dismissal credit (batting_records.bowler_id) they earned as the bowler.
router.post('/innings/:inningsId/correct-bowler', requireAdminToken, async (req, res) => {
  const { inningsId } = req.params;
  const oldPlayerId = normalizeNullableInt(req.body.old_player_id);
  const newPlayerId = normalizeNullableInt(req.body.new_player_id);
  if (!oldPlayerId || !newPlayerId) {
    return res.status(400).json({ error: 'old_player_id and new_player_id are required' });
  }
  if (oldPlayerId === newPlayerId) {
    return res.status(400).json({ error: 'New player must be different from the current player' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inningsRes = await client.query('SELECT * FROM innings WHERE id=$1 FOR UPDATE', [inningsId]);
    const innings = inningsRes.rows[0];
    if (!innings) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Innings not found' }); }

    const existingRes = await client.query(
      'SELECT id FROM bowling_records WHERE innings_id=$1 AND player_id=$2', [inningsId, oldPlayerId]
    );
    if (existingRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'That player has no bowling record in this innings' });
    }
    const conflictRes = await client.query(
      'SELECT id FROM bowling_records WHERE innings_id=$1 AND player_id=$2', [inningsId, newPlayerId]
    );
    if (conflictRes.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'The new player already has a bowling record in this innings — merge is not supported' });
    }

    await client.query(
      `INSERT INTO match_players (match_id, player_id, team) VALUES ($1, $2, $3)
       ON CONFLICT (match_id, player_id, team) DO NOTHING`,
      [innings.match_id, newPlayerId, innings.bowling_team]
    );

    await client.query('UPDATE bowling_records SET player_id=$1 WHERE innings_id=$2 AND player_id=$3', [newPlayerId, inningsId, oldPlayerId]);
    await client.query('UPDATE ball_events SET bowler_id=$1 WHERE innings_id=$2 AND bowler_id=$3', [newPlayerId, inningsId, oldPlayerId]);
    await client.query('UPDATE batting_records SET bowler_id=$1 WHERE innings_id=$2 AND bowler_id=$3', [newPlayerId, inningsId, oldPlayerId]);
    if (innings.bowler_id === oldPlayerId) {
      await client.query('UPDATE innings SET bowler_id=$1 WHERE id=$2', [newPlayerId, inningsId]);
    }

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.get('/:matchId', async (req, res) => {
  const result = await pool.query('SELECT * FROM matches WHERE id=$1', [req.params.matchId]);
  res.json(result.rows[0]);
});

// Rename a match's teams after setup (e.g. fixing a typo, or a sponsor name
// change). If match_name was still the auto-generated "A vs B" default, it's
// regenerated with the new names too; a custom match_name is left alone.
// Admin-only, like other match-editing/destructive actions.
router.post('/:matchId/teams', requireAdminToken, async (req, res) => {
  const { matchId } = req.params;
  const teamAName = (req.body.team_a_name || '').trim();
  const teamBName = (req.body.team_b_name || '').trim();
  if (!teamAName || !teamBName) {
    return res.status(400).json({ error: 'Both team names are required' });
  }
  const current = await pool.query('SELECT team_a_name, team_b_name, match_name FROM matches WHERE id=$1', [matchId]);
  if (current.rows.length === 0) {
    return res.status(404).json({ error: 'Match not found' });
  }
  const existing = current.rows[0];
  const hadDefaultMatchName = existing.match_name === `${existing.team_a_name} vs ${existing.team_b_name}`;
  const newMatchName = hadDefaultMatchName ? `${teamAName} vs ${teamBName}` : existing.match_name;
  const result = await pool.query(
    `UPDATE matches SET team_a_name=$1, team_b_name=$2, match_name=$3 WHERE id=$4 RETURNING *`,
    [teamAName, teamBName, newMatchName, matchId]
  );
  res.json(result.rows[0]);
});

// Latest (most recent) innings for a match — used by watch mode to auto-follow
router.get('/:matchId/current-innings', async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM innings WHERE match_id=$1 ORDER BY innings_no DESC LIMIT 1',
    [req.params.matchId]
  );
  res.json(result.rows[0] || null);
});

// The player roster actually assigned to this match, split back into team A,
// team B, and "common" (players who appear in both teams' lists). Used to
// rehydrate scorer state when re-entering an in-progress match (e.g. via
// admin console's "Continue Scoring"), since the setup screen's in-memory
// team-assignment state doesn't survive a fresh page/session.
router.get('/:matchId/players', async (req, res) => {
  const result = await pool.query(
    `SELECT mp.player_id, mp.team, mp.is_captain, p.name FROM match_players mp
     JOIN players p ON p.id = mp.player_id WHERE mp.match_id=$1`,
    [req.params.matchId]
  );
  const aSet = new Set(), bSet = new Set();
  const names = {};
  let teamACaptainId = null, teamBCaptainId = null;
  for (const row of result.rows) {
    names[row.player_id] = row.name;
    if (row.team === 'A') {
      aSet.add(row.player_id);
      if (row.is_captain) teamACaptainId = row.player_id;
    } else if (row.team === 'B') {
      bSet.add(row.player_id);
      if (row.is_captain) teamBCaptainId = row.player_id;
    }
  }
  const commonIds = [...aSet].filter(id => bSet.has(id));
  const commonSet = new Set(commonIds);
  const teamAIds = [...aSet].filter(id => !commonSet.has(id));
  const teamBIds = [...bSet].filter(id => !commonSet.has(id));
  // Team rosters for display purposes (e.g. listing both squads on the
  // watch/scorecard views) — common players appear on both sides since
  // they actually play for both teams.
  const byName = (a, b) => a.name.localeCompare(b.name);
  const teamAPlayers = [...aSet].map(id => ({ id, name: names[id], is_captain: id === teamACaptainId })).sort(byName);
  const teamBPlayers = [...bSet].map(id => ({ id, name: names[id], is_captain: id === teamBCaptainId })).sort(byName);
  res.json({
    team_a_player_ids: teamAIds, team_b_player_ids: teamBIds, common_player_ids: commonIds,
    team_a_players: teamAPlayers, team_b_players: teamBPlayers,
    team_a_captain_id: teamACaptainId, team_b_captain_id: teamBCaptainId
  });
});

// Assign (or clear) the captain for one team in a match. Pass player_id: null
// to clear that team's captain. Assigning a new captain automatically
// replaces any previous captain for the same team (only one at a time).
router.post('/:matchId/captain', async (req, res) => {
  const { matchId } = req.params;
  const { team, player_id } = req.body;
  if (!['A', 'B'].includes(team)) {
    return res.status(400).json({ error: "team must be 'A' or 'B'" });
  }
  const pid = normalizeNullableInt(player_id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE match_players SET is_captain=FALSE WHERE match_id=$1 AND team=$2',
      [matchId, team]
    );
    if (pid !== null) {
      const check = await client.query(
        'SELECT id FROM match_players WHERE match_id=$1 AND player_id=$2 AND team=$3',
        [matchId, pid, team]
      );
      if (check.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'That player is not on this team for this match.' });
      }
      await client.query(
        'UPDATE match_players SET is_captain=TRUE WHERE match_id=$1 AND player_id=$2 AND team=$3',
        [matchId, pid, team]
      );
    }
    await client.query('COMMIT');
    res.json({ success: true, team, captain_id: pid });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.get('/', async (req, res) => {
  const result = await pool.query('SELECT * FROM matches ORDER BY created_at DESC');
  res.json(result.rows);
});

// Matches that have been set up (teams assigned) but not yet started —
// i.e. scheduled for a future/upcoming session. Ordered by when they're due
// to be played, not when they were created, so the soonest game is first.
router.get('/status/scheduled', async (req, res) => {
  const result = await pool.query(
    `SELECT * FROM matches WHERE status='setup'
     ORDER BY match_date ASC, match_time ASC NULLS LAST, created_at ASC`
  );
  res.json(result.rows);
});

// Record the on-the-day coin toss for a match that was set up in advance
// (or just before starting the first innings). Doesn't change match status —
// the match still only becomes 'in_progress' once the first innings starts.
router.post('/:matchId/toss', async (req, res) => {
  const { matchId } = req.params;
  const { toss_winner_team, toss_decision } = req.body;
  if (!['A', 'B'].includes(toss_winner_team)) {
    return res.status(400).json({ error: "toss_winner_team must be 'A' or 'B'" });
  }
  if (!['bat', 'bowl'].includes(toss_decision)) {
    return res.status(400).json({ error: "toss_decision must be 'bat' or 'bowl'" });
  }
  const result = await pool.query(
    `UPDATE matches SET toss_winner_team=$1, toss_decision=$2 WHERE id=$3 RETURNING *`,
    [toss_winner_team, toss_decision, matchId]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Match not found' });
  res.json(result.rows[0]);
});

// Mark an innings as completed (all out, or overs finished, or manually ended)
router.post('/innings/:inningsId/complete', async (req, res) => {
  const { inningsId } = req.params;
  await pool.query(`UPDATE innings SET status='completed' WHERE id=$1`, [inningsId]);
  res.json({ success: true });
});



// Update a match status directly (e.g. abandon a match or switch its state)
router.post('/:matchId/status', async (req, res) => {
  const { matchId } = req.params;
  const { status, winner_team = null, result_summary = null } = req.body;
  await pool.query(
    `UPDATE matches SET status=$1, winner_team=$2, result_summary=$3 WHERE id=$4`,
    [status, winner_team, result_summary, matchId]
  );
  res.json({ success: true });
});

// Permanently delete a match and everything under it (innings, batting/bowling
// records, ball events, fall of wickets — all cascade via FK ON DELETE CASCADE).
// Admin-only: requires a valid admin session token from /api/admin/login.
router.delete('/:matchId', requireAdminToken, async (req, res) => {
  const result = await pool.query('DELETE FROM matches WHERE id=$1 RETURNING id', [req.params.matchId]);
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Match not found' });
  }
  res.json({ success: true });
});

// Update a match's team roster — including after the match has already
// started. Body: { team_a_player_ids: [...], team_b_player_ids: [...] }
// (a player id present in BOTH arrays is a Common Player, same convention
// used at match creation). This diffs against the current match_players
// rows rather than wiping and re-inserting, so it works safely mid-match:
//
// - Newly added players are inserted into match_players. If the match has
//   an innings currently in_progress and the newly-added player's team is
//   batting or bowling in that innings, a batting_records / bowling_records
//   row is also created for them (status 'yet_to_bat' for batting) so they
//   immediately show up as selectable — this is what lets you convert an
//   existing player to a Common Player (add them to the other team too) or
//   bring on a replacement mid-game.
// - Removed players just lose their match_players eligibility row. Any
//   batting/bowling stats they've already recorded are left completely
//   alone (never deleted). If they hadn't faced a ball / bowled a ball yet
//   in the current innings (a still-empty 'yet_to_bat' / 0-for-0 record —
//   e.g. a no-show), that empty placeholder record is cleaned up too, so
//   they drop out of the striker/bowler pickers. A player currently at the
//   crease or bowling is left untouched even if removed from the roster —
//   change the striker/bowler first.
router.put('/:matchId/players', async (req, res) => {
  const { matchId } = req.params;
  const toIntArray = (v) => Array.isArray(v) ? [...new Set(v.map(x => parseInt(x, 10)).filter(Number.isFinite))] : [];
  const teamAIds = toIntArray(req.body.team_a_player_ids);
  const teamBIds = toIntArray(req.body.team_b_player_ids);
  if (teamAIds.length === 0 || teamBIds.length === 0) {
    return res.status(400).json({ error: 'Both teams need at least one player.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query('SELECT player_id, team FROM match_players WHERE match_id=$1', [matchId]);
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Match not found (or has no players yet — use match creation instead).' });
    }
    const existingA = new Set(existing.rows.filter(r => r.team === 'A').map(r => r.player_id));
    const existingB = new Set(existing.rows.filter(r => r.team === 'B').map(r => r.player_id));
    const newA = new Set(teamAIds);
    const newB = new Set(teamBIds);

    const removedA = [...existingA].filter(id => !newA.has(id));
    const removedB = [...existingB].filter(id => !newB.has(id));
    const addedA = [...newA].filter(id => !existingA.has(id));
    const addedB = [...newB].filter(id => !existingB.has(id));

    for (const pid of removedA) {
      await client.query('DELETE FROM match_players WHERE match_id=$1 AND player_id=$2 AND team=$3', [matchId, pid, 'A']);
    }
    for (const pid of removedB) {
      await client.query('DELETE FROM match_players WHERE match_id=$1 AND player_id=$2 AND team=$3', [matchId, pid, 'B']);
    }
    for (const pid of addedA) {
      await client.query(
        `INSERT INTO match_players (match_id, player_id, team) VALUES ($1,$2,'A') ON CONFLICT (match_id, player_id, team) DO NOTHING`,
        [matchId, pid]
      );
    }
    for (const pid of addedB) {
      await client.query(
        `INSERT INTO match_players (match_id, player_id, team) VALUES ($1,$2,'B') ON CONFLICT (match_id, player_id, team) DO NOTHING`,
        [matchId, pid]
      );
    }

    // Keep the currently-live innings (if any) in sync so newly-added
    // players are immediately eligible, and cleanly-removed no-shows drop out.
    const inningsRes = await client.query(
      `SELECT id, striker_id, bowler_id, batting_team, bowling_team FROM innings WHERE match_id=$1 AND status='in_progress'`,
      [matchId]
    );
    for (const inn of inningsRes.rows) {
      const battingAdds = inn.batting_team === 'A' ? addedA : addedB;
      const bowlingAdds = inn.bowling_team === 'A' ? addedA : addedB;
      const battingRemoves = inn.batting_team === 'A' ? removedA : removedB;
      const bowlingRemoves = inn.bowling_team === 'A' ? removedA : removedB;

      for (const pid of battingAdds) {
        await client.query(
          `INSERT INTO batting_records (innings_id, player_id, status) VALUES ($1,$2,'yet_to_bat')
           ON CONFLICT (innings_id, player_id) DO NOTHING`,
          [inn.id, pid]
        );
      }
      for (const pid of bowlingAdds) {
        await client.query(
          `INSERT INTO bowling_records (innings_id, player_id) VALUES ($1,$2)
           ON CONFLICT (innings_id, player_id) DO NOTHING`,
          [inn.id, pid]
        );
      }
      for (const pid of battingRemoves) {
        if (pid === inn.striker_id) continue; // currently batting — leave alone
        await client.query(
          `DELETE FROM batting_records
           WHERE innings_id=$1 AND player_id=$2 AND status='yet_to_bat' AND runs=0 AND balls_faced=0 AND retirement_count=0`,
          [inn.id, pid]
        );
      }
      for (const pid of bowlingRemoves) {
        if (pid === inn.bowler_id) continue; // currently bowling — leave alone
        await client.query(
          `DELETE FROM bowling_records
           WHERE innings_id=$1 AND player_id=$2 AND overs_bowled=0 AND runs_conceded=0 AND wickets=0`,
          [inn.id, pid]
        );
      }
    }

    await client.query('COMMIT');
    res.json({ success: true, added: { A: addedA, B: addedB }, removed: { A: removedA, B: removedB } });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
