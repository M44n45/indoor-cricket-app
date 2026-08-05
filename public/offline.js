// offline.js — offline-first layer for CageCricket Live
//
// Strategy:
//   - All API mutations (POST/DELETE) during offline are queued to IndexedDB.
//   - Key read data (players list, active match/innings scorecard) is cached
//     in IndexedDB so Setup + Scoring keep working when the network is gone.
//   - When connectivity returns, queued actions are replayed in order against
//     the real server, with temp-ID rewriting for IDs created while offline.
//   - The scorer never notices the network is down — balls keep scoring,
//     the display updates from the local cache, and sync happens silently.
//
// IndexedDB stores:
//   "queue"   — pending offline actions (autoIncrement id)
//   "cache"   — key/value read cache (players, scorecards, match data)
//   "tempIds" — temp negative ID -> real server ID mapping

(function (global) {
  'use strict';

  const DB_NAME = 'cricket-offline';
  const DB_VERSION = 1;
  let _db = null;

  function openDb() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('queue')) {
          db.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('cache')) {
          db.createObjectStore('cache', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('tempIds')) {
          db.createObjectStore('tempIds', { keyPath: 'tempId' });
        }
      };
      req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  function dbGet(store, key) {
    return openDb().then(db => new Promise((resolve, reject) => {
      const req = db.transaction(store, 'readonly').objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    }));
  }

  function dbPut(store, value) {
    return openDb().then(db => new Promise((resolve, reject) => {
      const req = db.transaction(store, 'readwrite').objectStore(store).put(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }

  function dbDelete(store, key) {
    return openDb().then(db => new Promise((resolve, reject) => {
      const req = db.transaction(store, 'readwrite').objectStore(store).delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    }));
  }

  function dbGetAll(store) {
    return openDb().then(db => new Promise((resolve, reject) => {
      const req = db.transaction(store, 'readonly').objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    }));
  }

  function dbClear(store) {
    return openDb().then(db => new Promise((resolve, reject) => {
      const req = db.transaction(store, 'readwrite').objectStore(store).clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    }));
  }

  // ---- Cache (offline read store) ----

  async function cacheSet(key, value) {
    await dbPut('cache', { key, value, ts: Date.now() });
  }

  async function cacheGet(key) {
    const row = await dbGet('cache', key);
    return row ? row.value : null;
  }

  // ---- Queue (offline write store) ----

  async function enqueue(url, method, body, tempId) {
    await dbPut('queue', { url, method, body: body || null, _tempId: tempId || null, ts: Date.now() });
  }

  async function getQueue() {
    return dbGetAll('queue');
  }

  async function dequeue(id) {
    await dbDelete('queue', id);
  }

  async function clearQueue() {
    await dbClear('queue');
  }

  // ---- Temporary ID management ----
  // When offline, new matches/innings get a negative temp ID so the rest of
  // the offline session can reference them. On sync the real ID is recorded
  // so later queued actions that embed the temp ID get it rewritten first.

  let _tempIdCounter = -1;

  function nextTempId() {
    return _tempIdCounter--;
  }

  async function saveTempIdMapping(tempId, realId) {
    await dbPut('tempIds', { tempId, realId });
  }

  async function rewriteTempIds(url, body) {
    const all = await dbGetAll('tempIds');
    if (!all.length) return { url, body };
    let u = url;
    let b = body ? JSON.parse(JSON.stringify(body)) : null;
    for (const { tempId, realId } of all) {
      const ts = String(tempId), rs = String(realId);
      u = u.split(ts).join(rs);
      if (b) b = JSON.parse(JSON.stringify(b, (k, v) => (String(v) === ts ? parseInt(rs) : v)));
    }
    return { url: u, body: b };
  }

  // ---- Sync: replay queue against the real server ----

  async function syncQueue(onProgress) {
    const queue = await getQueue();
    if (!queue.length) return 0;
    let synced = 0;
    for (const item of queue) {
      try {
        const { url, body } = await rewriteTempIds(item.url, item.body);
        const opts = { method: item.method, headers: { 'Content-Type': 'application/json' } };
        if (body) opts.body = JSON.stringify(body);
        const res = await fetch(url, opts);
        if (!res.ok) {
          console.warn('[offline] sync skipped (server error)', item.url, res.status);
          await dequeue(item.id);
          continue;
        }
        if (item.method === 'POST' && item._tempId) {
          try {
            const data = await res.json();
            if (data && data.id) await saveTempIdMapping(item._tempId, data.id);
          } catch (_) {}
        }
        await dequeue(item.id);
        synced++;
        if (onProgress) onProgress(synced, queue.length);
      } catch (err) {
        console.warn('[offline] sync stopped (network error):', err.message);
        break;
      }
    }
    return synced;
  }

  // ---- Local scorecard mutations (keep the cache in sync while offline) ----

  function cricketToBalls(overs) {
    const n = parseFloat(overs) || 0;
    return Math.floor(n) * 6 + Math.round((n - Math.floor(n)) * 10);
  }

  function ballsToOvers(balls) {
    return parseFloat((Math.floor(balls / 6) + (balls % 6) / 10).toFixed(1));
  }

  async function offlineScoreBall(inningsId, payload) {
    const key = `scorecard_${inningsId}`;
    const sc = await cacheGet(key);
    if (!sc) return null;

    const { runs = 0, extra_type = null, extra_runs = 0, is_wicket = false, wicket_type = null, fielder_id = null } = payload;
    const isLegal = extra_type !== 'wide' && extra_type !== 'no_ball';
    const totalRuns = runs + (extra_runs || 0);
    const innings = sc.innings;

    innings.total_runs = (innings.total_runs || 0) + totalRuns;
    if (is_wicket) innings.total_wickets = (innings.total_wickets || 0) + 1;
    const prevBalls = innings.total_legal_balls || 0;
    const newBalls = isLegal ? prevBalls + 1 : prevBalls;
    innings.total_legal_balls = newBalls;
    innings.overs_completed = ballsToOvers(newBalls);
    if (extra_type === 'wide') innings.wide_runs = (innings.wide_runs || 0) + (extra_runs || 0);
    if (extra_type === 'no_ball') innings.no_ball_runs = (innings.no_ball_runs || 0) + (extra_runs || 0);

    const strikerId = innings.striker_id;
    const batRec = sc.batting.find(b => b.player_id === strikerId);
    if (batRec && extra_type !== 'wide') {
      if (isLegal) batRec.balls_faced = (batRec.balls_faced || 0) + 1;
      batRec.runs = (batRec.runs || 0) + runs;
      if (runs === 4) batRec.fours = (batRec.fours || 0) + 1;
      if (runs === 6) batRec.sixes = (batRec.sixes || 0) + 1;
      if (is_wicket) { batRec.status = 'out'; batRec.dismissal_type = wicket_type; batRec.fielder_id = fielder_id; }
    }

    const bowlerId = innings.bowler_id;
    const bowlRec = sc.bowling.find(b => b.player_id === bowlerId);
    if (bowlRec) {
      bowlRec.runs_conceded = (bowlRec.runs_conceded || 0) + totalRuns;
      if (is_wicket) bowlRec.wickets = (bowlRec.wickets || 0) + 1;
      if (isLegal) bowlRec.overs_bowled = ballsToOvers(cricketToBalls(bowlRec.overs_bowled || 0) + 1);
    }

    // Build overs recap (for ball-by-ball display)
    if (!sc.overs_recap) sc.overs_recap = [];
    const overNo = Math.floor(prevBalls / 6);
    let overEntry = sc.overs_recap.find(o => o.over_no === overNo);
    if (!overEntry) {
      overEntry = {
        over_no: overNo,
        bowler_name: (sc.bowling.find(b => b.player_id === bowlerId) || {}).name || '',
        batsman_name: (sc.batting.find(b => b.player_id === strikerId) || {}).name || '',
        balls: [], runs: 0, wickets: 0
      };
      sc.overs_recap.push(overEntry);
    }
    const display = is_wicket ? 'W' : (extra_type === 'wide' ? 'Wd' : extra_type === 'no_ball' ? 'Nb' : String(runs));
    overEntry.balls.push({ runs, extra_type, extra_runs, is_wicket, display });
    overEntry.runs += totalRuns;
    if (is_wicket) overEntry.wickets += 1;

    await cacheSet(key, sc);

    const oversLimitBalls = Math.round(parseFloat(innings._overs_limit || 8) * 6);
    const inningsOver = newBalls >= oversLimitBalls;
    const outCount = sc.batting.filter(b => b.status === 'out').length;
    const allOut = outCount >= sc.batting.length - 1;

    return { success: true, overs_completed: innings.overs_completed, wicket_fell: is_wicket, innings_over: inningsOver, all_out: allOut };
  }

  function normalizeNullableInt(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') {
      return Number.isFinite(value) ? Math.trunc(value) : null;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed || trimmed.toLowerCase() === 'null' || trimmed.toLowerCase() === 'undefined') return null;
      const parsed = Number.parseInt(trimmed, 10);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  async function offlineChangeBatsman(inningsId, newStrikerId) {
    const key = `scorecard_${inningsId}`;
    const sc = await cacheGet(key);
    if (!sc) return;
    const strikerId = normalizeNullableInt(newStrikerId);
    sc.innings.striker_id = strikerId;
    const rec = sc.batting.find(b => b.player_id === strikerId);
    if (rec && rec.status !== 'out') rec.status = 'batting';
    await cacheSet(key, sc);
  }

  async function offlineChangeBowler(inningsId, newBowlerId) {
    const key = `scorecard_${inningsId}`;
    const sc = await cacheGet(key);
    if (!sc) return;
    sc.innings.bowler_id = normalizeNullableInt(newBowlerId);
    await cacheSet(key, sc);
  }

  async function offlineRetireStriker(inningsId) {
    const key = `scorecard_${inningsId}`;
    const sc = await cacheGet(key);
    if (!sc) return;
    const strikerId = sc.innings.striker_id;
    const rec = sc.batting.find(b => b.player_id === strikerId);
    if (rec) { rec.status = 'retired'; rec.retirement_count = (rec.retirement_count || 0) + 1; }
    await cacheSet(key, sc);
  }

  async function offlineEligibleBatsmen(inningsId) {
    const key = `scorecard_${inningsId}`;
    const sc = await cacheGet(key);
    if (!sc) return [];
    return sc.batting.filter(b => b.status !== 'out').map(b => b.player_id);
  }

  // Build an initial scorecard cache entry for a newly started offline innings
  async function offlineInitScorecard(inningsId, innings, battingPlayers, bowlingPlayers, oversLimit) {
    const batting = battingPlayers.map((p, i) => ({
      player_id: p.id, name: p.name, runs: 0, balls_faced: 0, fours: 0, sixes: 0,
      status: i === 0 ? 'batting' : 'yet_to_bat', retirement_count: 0, batting_order: i
    }));
    const bowling = bowlingPlayers.map(p => ({
      player_id: p.id, name: p.name, overs_bowled: 0, runs_conceded: 0, wickets: 0, maidens: 0, wides: 0, no_balls: 0
    }));
    const sc = {
      innings: { ...innings, _overs_limit: oversLimit },
      batting,
      bowling,
      fall_of_wickets: [],
      overs_recap: []
    };
    await cacheSet(`scorecard_${inningsId}`, sc);
  }

  // Expose everything under a single global namespace
  global.OfflineDB = {
    cacheSet,
    cacheGet,
    enqueue,
    getQueue,
    clearQueue,
    syncQueue,
    nextTempId,
    saveTempIdMapping,
    offlineScoreBall,
    offlineChangeBatsman,
    offlineChangeBowler,
    offlineRetireStriker,
    offlineEligibleBatsmen,
    offlineInitScorecard
  };

})(window);
