// src/routes/admin.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('../db/pool');

// Simple in-memory admin session tokens. Fine for a small single-instance app;
// tokens just live for the process lifetime / TTL, no need for a sessions table.
const activeTokens = new Map(); // token -> expiry (ms epoch)
const TOKEN_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function issueToken() {
  const token = crypto.randomBytes(24).toString('hex');
  activeTokens.set(token, Date.now() + TOKEN_TTL_MS);
  return token;
}

// Exported so other routers (e.g. matches.js) can protect destructive endpoints.
function requireAdminToken(req, res, next) {
  const token = req.headers['x-admin-token'];
  const expiry = token && activeTokens.get(token);
  if (!expiry || expiry < Date.now()) {
    if (token) activeTokens.delete(token);
    return res.status(401).json({ error: 'Admin authentication required' });
  }
  next();
}

// Whether an admin password has already been set up.
router.get('/status', async (req, res) => {
  const result = await pool.query('SELECT 1 FROM admin_settings WHERE id=1');
  res.json({ configured: result.rows.length > 0 });
});

// First-time setup only — refuses if a password already exists.
router.post('/setup', async (req, res) => {
  const { password } = req.body;
  if (!password || String(password).length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
  }
  const existing = await pool.query('SELECT 1 FROM admin_settings WHERE id=1');
  if (existing.rows.length > 0) {
    return res.status(409).json({ error: 'Admin password already configured' });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(String(password), salt);
  await pool.query('INSERT INTO admin_settings (id, password_hash, salt) VALUES (1, $1, $2)', [hash, salt]);
  res.json({ token: issueToken() });
});

// Regular login against the stored password.
router.post('/login', async (req, res) => {
  const { password } = req.body;
  const result = await pool.query('SELECT password_hash, salt FROM admin_settings WHERE id=1');
  if (result.rows.length === 0) {
    return res.status(409).json({ error: 'Admin password not yet configured' });
  }
  const { password_hash, salt } = result.rows[0];
  const hash = hashPassword(String(password || ''), salt);
  const hashBuf = Buffer.from(hash, 'hex');
  const storedBuf = Buffer.from(password_hash, 'hex');
  const isMatch = hashBuf.length === storedBuf.length && crypto.timingSafeEqual(hashBuf, storedBuf);
  if (!isMatch) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  res.json({ token: issueToken() });
});

router.requireAdminToken = requireAdminToken;
module.exports = router;
