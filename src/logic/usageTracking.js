// src/logic/usageTracking.js
//
// Anonymous "how many devices are using this app" tracking.
//
// No names/accounts involved — just a random device ID the client generates
// once and stores in localStorage (see app.js), sent as the X-Device-Id
// header, plus the request IP as a secondary signal. Designed to stay cheap
// on a free-tier Postgres instance:
//   - device_last_seen: ONE row per device ever, upserted. Bounded size.
//   - device_visits: ONE row per device PER DAY, upserted. Grows by at most
//     (distinct devices per day) rows/day, not per request.
//   - writes are debounced in-memory so a burst of API calls from one
//     device (e.g. rapid scoring taps) only hits the DB once a minute.
const pool = require('../db/pool');

const DEBOUNCE_MS = 60 * 1000; // one DB write per device per minute, max
const lastWrite = new Map(); // device_id -> ms epoch of last successful write

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || null;
}

async function trackDevice(deviceId, req) {
  if (!deviceId || typeof deviceId !== 'string' || deviceId.length > 100) return;
  const now = Date.now();
  const last = lastWrite.get(deviceId);
  if (last && (now - last) < DEBOUNCE_MS) return; // seen this device recently, skip
  lastWrite.set(deviceId, now);

  const ip = getClientIp(req);
  const ua = (req.headers['user-agent'] || '').slice(0, 255);

  try {
    await pool.query(
      `INSERT INTO device_last_seen (device_id, ip, user_agent, last_seen)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (device_id) DO UPDATE SET ip = $2, user_agent = $3, last_seen = NOW()`,
      [deviceId, ip, ua]
    );
    await pool.query(
      `INSERT INTO device_visits (device_id, day, first_seen, last_seen, request_count)
       VALUES ($1, CURRENT_DATE, NOW(), NOW(), 1)
       ON CONFLICT (device_id, day) DO UPDATE
         SET last_seen = NOW(), request_count = device_visits.request_count + 1`,
      [deviceId]
    );
  } catch (err) {
    // Never let tracking failures affect the actual app.
    console.error('usage tracking failed:', err.message);
  }
}

// Fire-and-forget: never delays or fails the real request.
function usageMiddleware(req, res, next) {
  const deviceId = req.headers['x-device-id'];
  if (deviceId) trackDevice(deviceId, req).catch(() => {});
  next();
}

module.exports = { usageMiddleware };
