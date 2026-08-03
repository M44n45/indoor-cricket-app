// src/server.js
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
require('dotenv').config();

const initDb = require('./db/init');
const playersRouter = require('./routes/players');
const matchesRouter = require('./routes/matches');
const scoringRouter = require('./routes/scoring');
const statsRouter = require('./routes/stats');
const leaderboardUploadRouter = require('./routes/leaderboardUpload');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public', {
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));

app.use('/api/players', playersRouter);
app.use('/api/matches', matchesRouter);
app.use('/api', scoringRouter);
app.use('/api/stats', statsRouter);
app.use('/api/leaderboard', leaderboardUploadRouter);

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

async function start() {
  try {
    await initDb();
  } catch (err) {
    console.error('DB init failed, retrying in 3s...', err.message);
    setTimeout(start, 3000);
    return;
  }
  app.listen(PORT, () => console.log(`Indoor Cricket app listening on port ${PORT}`));
}

start();
