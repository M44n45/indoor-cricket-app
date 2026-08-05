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

  // Migration: ball_events didn't originally record which fielder took a catch/
  // stumping/run-out, so replaying an innings (undo) had no way to restore it and
  // wiped fielder_id back to null. Storing it on the ball event itself fixes that.
  await pool.query(`ALTER TABLE ball_events ADD COLUMN IF NOT EXISTS fielder_id INT REFERENCES players(id);`);

  const countRes = await pool.query('SELECT COUNT(*) FROM players');
  if (parseInt(countRes.rows[0].count) === 0) {
    // seed_players.sql is gitignored on purpose — it holds one specific
    // group's real names, so a fresh clone of this repo shouldn't ship with
    // someone else's roster baked in. See seed_players.example.sql for how
    // to set up your own. No file present just means "start empty";
    // players can always be added later from the Setup screen.
    const seedPath = path.join(__dirname, 'seed_players.sql');
    if (fs.existsSync(seedPath)) {
      const seed = fs.readFileSync(seedPath, 'utf8');
      await pool.query(seed);
      console.log('Seeded initial player roster.');
    } else {
      console.log('No seed_players.sql found — starting with an empty roster (add players via Setup, or see seed_players.example.sql).');
    }
  }
  console.log('Database schema applied.');
}

module.exports = initDb;
