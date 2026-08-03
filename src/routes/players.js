// src/routes/players.js
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// Add a player to the roster
router.post('/', async (req, res) => {
  const { name, is_common_player = false } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const result = await pool.query(
    'INSERT INTO players (name, is_common_player) VALUES ($1, $2) RETURNING *',
    [name, is_common_player]
  );
  res.json(result.rows[0]);
});

// List all players
router.get('/', async (req, res) => {
  const result = await pool.query('SELECT * FROM players ORDER BY name');
  res.json(result.rows);
});

// Delete a player
router.delete('/:id', async (req, res) => {
  await pool.query('DELETE FROM players WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

module.exports = router;
