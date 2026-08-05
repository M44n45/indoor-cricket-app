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
const adminRouter = require('./routes/admin');
const { usageMiddleware } = require('./logic/usageTracking');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public', {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('Surrogate-Control', 'no-store');
  }
}));

// Anonymous device-count tracking (no PII) — see src/logic/usageTracking.js.
app.use('/api', usageMiddleware);

app.use('/api/players', playersRouter);
app.use('/api/matches', matchesRouter);
app.use('/api', scoringRouter);
app.use('/api/stats', statsRouter);
app.use('/api/admin', adminRouter);

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
