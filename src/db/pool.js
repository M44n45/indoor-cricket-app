// src/db/pool.js
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://cricket:cricket@localhost:5432/cricketdb'
});

module.exports = pool;
