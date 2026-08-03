// src/routes/leaderboardUpload.js
const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const router = express.Router();
const pool = require('../db/pool');

const ADMIN_PASSWORD = process.env.LEADERBOARD_ADMIN_PASSWORD || 'cricket123';

function checkAdminPassword(req, res, next) {
  const provided = req.body.admin_password || req.query.admin_password || req.headers['x-admin-password'];
  if (provided !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect admin password.' });
  }
  next();
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Best-effort parser for the ABHI_CRICSCORER-style leaderboard PDF text.
// Expected per-player pattern (batting section):
// Name MP INN R 4s 6s AVG SR W NL SWN%
// e.g. "Abhinav434382642313419.2141.2271662.8%"
function parseBattingRows(text) {
  const rows = [];
  const regex = /([A-Za-z]+)(\d+)(\d+)(\d+)(\d+)(\d+)(\d+\.\d+)(\d+\.\d+)(\d+)(\d+)(\d+\.\d+)%/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    rows.push({
      player_name: match[1],
      matches_played: parseInt(match[2]),
      innings_played: parseInt(match[3]),
      runs: parseInt(match[4]),
      fours: parseInt(match[5]),
      sixes: parseInt(match[6]),
      avg: parseFloat(match[7]),
      strike_rate: parseFloat(match[8]),
      wins: parseInt(match[9]),
      losses: parseInt(match[10]),
      win_pct: parseFloat(match[11])
    });
  }
  return rows;
}

function parseBowlingRows(text) {
  const rows = [];
  // Name MP IB OV W BBI RC ECO  e.g. "Abhinav434380.0313/186137.66"
  const regex = /([A-Za-z]+)(\d+)(\d+)(\d+\.\d+)(\d+)(\d+\/\d+)(\d+)(\d+\.\d+)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    rows.push({
      player_name: match[1],
      matches_played: parseInt(match[2]),
      innings_bowled: parseInt(match[3]),
      overs_bowled: parseFloat(match[4]),
      wickets: parseInt(match[5]),
      best_bowling: match[6],
      runs_conceded: parseInt(match[7]),
      economy: parseFloat(match[8])
    });
  }
  return rows;
}

// Upload a leaderboard PDF; parses and stores rows (does not delete existing data)
router.post('/upload', upload.single('file'), checkAdminPassword, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const data = await pdfParse(req.file.buffer);
    const text = data.text.replace(/\n/g, '').replace(/\s+/g, '');
    const battingRows = parseBattingRows(text);
    const bowlingRows = parseBowlingRows(text);

    const bowlingByName = {};
    bowlingRows.forEach(r => { bowlingByName[r.player_name] = r; });

    const label = req.body.source_label || req.file.originalname;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const b of battingRows) {
        const bowl = bowlingByName[b.player_name] || {};
        await client.query(
          `INSERT INTO external_leaderboard
           (source_label, player_name, matches_played, innings_played, runs, fours, sixes, avg, strike_rate,
            wins, losses, win_pct, wickets, innings_bowled, overs_bowled, runs_conceded, economy, best_bowling)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
          [label, b.player_name, b.matches_played, b.innings_played, b.runs, b.fours, b.sixes, b.avg, b.strike_rate,
           b.wins, b.losses, b.win_pct, bowl.wickets || 0, bowl.innings_bowled || 0, bowl.overs_bowled || 0,
           bowl.runs_conceded || 0, bowl.economy || 0, bowl.best_bowling || null]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.json({ success: true, rows_imported: battingRows.length, players: battingRows.map(r => r.player_name) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to parse PDF: ' + err.message, hint: 'PDF layout may differ from expected format. Try manual entry instead.' });
  }
});

// List all uploaded batches (grouped by source_label)
router.get('/uploads', async (req, res) => {
  const result = await pool.query(`
    SELECT source_label, COUNT(*) AS player_count, MIN(uploaded_at) AS uploaded_at
    FROM external_leaderboard GROUP BY source_label ORDER BY uploaded_at DESC
  `);
  res.json(result.rows);
});

// Get merged/aggregated external leaderboard (sum across all uploads per player)
router.get('/aggregate', async (req, res) => {
  const result = await pool.query(`
    SELECT player_name,
      SUM(matches_played) AS matches_played,
      SUM(innings_played) AS innings_played,
      SUM(runs) AS runs,
      SUM(fours) AS fours,
      SUM(sixes) AS sixes,
      CASE WHEN SUM(innings_played) > 0 THEN ROUND(SUM(runs)::numeric / SUM(innings_played), 2) ELSE 0 END AS avg,
      CASE WHEN SUM(innings_played) > 0 THEN ROUND(AVG(strike_rate), 0) ELSE 0 END AS strike_rate,
      SUM(wins) AS wins,
      SUM(losses) AS losses,
      CASE WHEN SUM(wins) + SUM(losses) > 0 THEN ROUND(SUM(wins)::numeric / (SUM(wins)+SUM(losses)) * 100, 1) ELSE 0 END AS win_pct,
      SUM(wickets) AS wickets,
      SUM(innings_bowled) AS innings_bowled,
      SUM(overs_bowled) AS overs_bowled,
      SUM(runs_conceded) AS runs_conceded,
      CASE WHEN SUM(overs_bowled) > 0 THEN ROUND(SUM(runs_conceded)::numeric / SUM(overs_bowled), 2) ELSE 0 END AS economy
    FROM external_leaderboard
    GROUP BY player_name
    ORDER BY runs DESC
  `);
  res.json(result.rows);
});

// Delete a specific uploaded batch by source_label
router.delete('/uploads/:label', checkAdminPassword, async (req, res) => {
  await pool.query('DELETE FROM external_leaderboard WHERE source_label=$1', [req.params.label]);
  res.json({ success: true });
});

// Delete ALL uploaded/overall leaderboard data
router.delete('/all', checkAdminPassword, async (req, res) => {
  await pool.query('DELETE FROM external_leaderboard');
  res.json({ success: true });
});

module.exports = router;
