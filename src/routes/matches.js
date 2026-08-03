// src/routes/matches.js
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// Create a match, split teams (supports one common player on both sides)
router.post('/', async (req, res) => {
  const {
    match_date, overs_limit = 8, retirement_overs = 2,
    team_a_name, team_b_name, match_name, team_a_player_ids, team_b_player_ids
  } = req.body;

  if (!team_a_player_ids || !team_b_player_ids) {
    return res.status(400).json({ error: 'team_a_player_ids and team_b_player_ids are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const matchResult = await client.query(
      `INSERT INTO matches (match_date, overs_limit, retirement_overs, team_a_name, team_b_name, match_name, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'setup') RETURNING *`,
      [match_date || new Date(), overs_limit, retirement_overs, team_a_name, team_b_name, match_name || `${team_a_name} vs ${team_b_name}`]
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
  const { new_striker_id } = req.body;
  await pool.query('UPDATE innings SET striker_id=$1 WHERE id=$2', [new_striker_id, inningsId]);
  await pool.query(
    `UPDATE batting_records SET status='batting' WHERE innings_id=$1 AND player_id=$2`,
    [inningsId, new_striker_id]
  );
  res.json({ success: true });
});

// Change bowler mid-innings
router.post('/innings/:inningsId/change-bowler', async (req, res) => {
  const { inningsId } = req.params;
  const { new_bowler_id } = req.body;
  await pool.query('UPDATE innings SET bowler_id=$1 WHERE id=$2', [new_bowler_id, inningsId]);
  res.json({ success: true });
});

router.get('/:matchId', async (req, res) => {
  const result = await pool.query('SELECT * FROM matches WHERE id=$1', [req.params.matchId]);
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

router.get('/', async (req, res) => {
  const result = await pool.query('SELECT * FROM matches ORDER BY created_at DESC');
  res.json(result.rows);
});

// Mark an innings as completed (all out, or overs finished, or manually ended)
router.post('/innings/:inningsId/complete', async (req, res) => {
  const { inningsId } = req.params;
  await pool.query(`UPDATE innings SET status='completed' WHERE id=$1`, [inningsId]);
  res.json({ success: true });
});

module.exports = router;
