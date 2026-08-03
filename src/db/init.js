// src/db/init.js
const fs = require('fs');
const path = require('path');
const pool = require('./pool');

async function initDb() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);

  // Migration: add match_name column for existing databases created before
  // named matches were introduced (lets Watch Live pick the right match by name).
  await pool.query(`ALTER TABLE matches ADD COLUMN IF NOT EXISTS match_name TEXT;`);

  const countRes = await pool.query('SELECT COUNT(*) FROM players');
  if (parseInt(countRes.rows[0].count) === 0) {
    const seed = fs.readFileSync(path.join(__dirname, 'seed_players.sql'), 'utf8');
    await pool.query(seed);
    console.log('Seeded initial player roster.');
  }
  console.log('Database schema applied.');
}

module.exports = initDb;
