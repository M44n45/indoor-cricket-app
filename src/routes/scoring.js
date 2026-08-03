// src/routes/scoring.js
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { getEligibleBatsmen } = require('../logic/rotation');

function oversToBalls(overs) {
  // Decimal overs where .5 = half an over = 3 balls (e.g. 3.5 -> 21 balls)
  return Math.round(parseFloat(overs) * 6);
}

function ballsToOversDisplay(totalBalls) {
  const oversInt = Math.floor(totalBalls / 6);
  const ballsIntoOver = totalBalls % 6;
  return parseFloat((oversInt + ballsIntoOver / 10).toFixed(1));
}

function cricketOversToBalls(overs) {
  const oversNum = parseFloat(overs) || 0;
  const oversInt = Math.floor(oversNum);
  const ballsIntoOver = Math.round((oversNum - oversInt) * 10);
  return oversInt * 6 + ballsIntoOver;
}

// Score a single ball
router.post('/innings/:inningsId/ball', async (req, res) => {
  const { inningsId } = req.params;
  const {
    runs = 0, extra_type = null, extra_runs = 0,
    is_wicket = false, wicket_type = null, fielder_id = null
  } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const inningsRes = await client.query('SELECT * FROM innings WHERE id=$1 FOR UPDATE', [inningsId]);
    const innings = inningsRes.rows[0];
    if (!innings) throw new Error('Innings not found');

    const matchRes = await client.query('SELECT * FROM matches WHERE id=$1', [innings.match_id]);
    const match = matchRes.rows[0];

    const isLegalBall = extra_type !== 'wide' && extra_type !== 'no_ball';
    const prevTotalBalls = innings.total_legal_balls || 0;
    const oversInt = Math.floor(prevTotalBalls / 6);
    const ballNo = isLegalBall ? (prevTotalBalls % 6) + 1 : (prevTotalBalls % 6);

    await client.query(
      `INSERT INTO ball_events (innings_id, over_no, ball_no, batsman_id, bowler_id, runs, extra_type, extra_runs, is_wicket, wicket_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [inningsId, oversInt, ballNo, innings.striker_id, innings.bowler_id, runs, extra_type, extra_runs, is_wicket, wicket_type]
    );

    const totalRunsThisBall = runs + extra_runs;
    const newTotalBalls = isLegalBall ? prevTotalBalls + 1 : prevTotalBalls;
    const newOversDisplay = ballsToOversDisplay(newTotalBalls);

    const wideAdd = extra_type === 'wide' ? extra_runs : 0;
    const noBallAdd = extra_type === 'no_ball' ? extra_runs : 0;

    await client.query(
      `UPDATE innings SET total_runs = total_runs + $1,
       total_wickets = total_wickets + $2,
       overs_completed = $3,
       total_legal_balls = $4,
       wide_runs = wide_runs + $5,
       no_ball_runs = no_ball_runs + $6
       WHERE id=$7`,
      [totalRunsThisBall, is_wicket ? 1 : 0, newOversDisplay, newTotalBalls, wideAdd, noBallAdd, inningsId]
    );

    // Batsman gets credit for runs scored off the bat even on a no-ball (but ball-faced count
    // only increases on legal deliveries). Wides never credit the batsman with runs.
    if (extra_type !== 'wide') {
      await client.query(
        `UPDATE batting_records SET balls_faced = balls_faced + $1, runs = runs + $2,
         fours = fours + $3, sixes = sixes + $4
         WHERE innings_id=$5 AND player_id=$6`,
        [isLegalBall ? 1 : 0, runs, runs === 4 ? 1 : 0, runs === 6 ? 1 : 0, inningsId, innings.striker_id]
      );
    }
    await client.query(
      `UPDATE bowling_records SET runs_conceded = runs_conceded + $1
       WHERE innings_id=$2 AND player_id=$3`,
      [totalRunsThisBall, inningsId, innings.bowler_id]
    );
    if (isLegalBall) {
      const bowlerRowRes = await client.query(
        `SELECT overs_bowled FROM bowling_records WHERE innings_id=$1 AND player_id=$2`,
        [inningsId, innings.bowler_id]
      );
      const prevBowlerBalls = cricketOversToBalls(bowlerRowRes.rows[0].overs_bowled || 0);
      const newBowlerOvers = ballsToOversDisplay(prevBowlerBalls + 1);
      await client.query(
        `UPDATE bowling_records SET overs_bowled = $1 WHERE innings_id=$2 AND player_id=$3`,
        [newBowlerOvers, inningsId, innings.bowler_id]
      );
    }

    let wicketFell = false;
    if (is_wicket) {
      wicketFell = true;
      await client.query(
        `UPDATE batting_records SET status='out', dismissal_type=$1, bowler_id=$2, fielder_id=$3, dismissal_over=$4
         WHERE innings_id=$5 AND player_id=$6`,
        [wicket_type, innings.bowler_id, fielder_id, newOversDisplay, inningsId, innings.striker_id]
      );
      await client.query(
        `UPDATE bowling_records SET wickets = wickets + 1 WHERE innings_id=$1 AND player_id=$2`,
        [inningsId, innings.bowler_id]
      );
      const wicketCountRes = await client.query(
        `SELECT COUNT(*) FROM batting_records WHERE innings_id=$1 AND status='out'`,
        [inningsId]
      );
      await client.query(
        `INSERT INTO fall_of_wickets (innings_id, wicket_no, team_score_at_fall, player_id, over_at_fall)
         VALUES ($1,$2,$3,$4,$5)`,
        [inningsId, wicketCountRes.rows[0].count, innings.total_runs + totalRunsThisBall, innings.striker_id, newOversDisplay]
      );
    } else if (isLegalBall) {
      const strikerRes = await client.query(
        'SELECT balls_faced FROM batting_records WHERE innings_id=$1 AND player_id=$2',
        [inningsId, innings.striker_id]
      );
      const ballsFaced = strikerRes.rows[0].balls_faced;
      const retirementBalls = oversToBalls(match.retirement_overs);
      if (ballsFaced >= retirementBalls) {
        await client.query(
          `UPDATE batting_records SET status='retired', retirement_count = retirement_count + 1
           WHERE innings_id=$1 AND player_id=$2`,
          [inningsId, innings.striker_id]
        );
      }
    }

    const oversLimitBalls = oversToBalls(match.overs_limit);
    const inningsOver = newTotalBalls >= oversLimitBalls;

    await client.query('COMMIT');
        const rosterSizeRes = await client.query(
      'SELECT COUNT(*) FROM batting_records WHERE innings_id=$1', [inningsId]
    );
    const outCountRes = await client.query(
      `SELECT COUNT(*) FROM batting_records WHERE innings_id=$1 AND status='out'`, [inningsId]
    );
    const rosterSize = parseInt(rosterSizeRes.rows[0].count);
    const outCount = parseInt(outCountRes.rows[0].count);
    const allOut = outCount >= rosterSize - 1; // one player always remains not-out

    res.json({ success: true, overs_completed: newOversDisplay, wicket_fell: wicketFell, innings_over: inningsOver, all_out: allOut });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Manually retire the current striker (can return once everyone else has batted)
router.post('/innings/:inningsId/retire-striker', async (req, res) => {
  const { inningsId } = req.params;
  const inningsRes = await pool.query('SELECT * FROM innings WHERE id=$1', [inningsId]);
  const innings = inningsRes.rows[0];
  await pool.query(
    `UPDATE batting_records SET status='retired', retirement_count = retirement_count + 1
     WHERE innings_id=$1 AND player_id=$2`,
    [inningsId, innings.striker_id]
  );
  res.json({ success: true });
});

// Get eligible batsmen for selection (respects retirement rotation)
router.get('/innings/:inningsId/eligible-batsmen', async (req, res) => {
  const { inningsId } = req.params;
  const battingRecords = await pool.query(
    'SELECT player_id, status, retirement_count FROM batting_records WHERE innings_id=$1',
    [inningsId]
  );
  const matchRes = await pool.query(
    `SELECT m.retirement_overs FROM matches m JOIN innings i ON i.match_id = m.id WHERE i.id=$1`,
    [inningsId]
  );
  const eligible = getEligibleBatsmen(battingRecords.rows, matchRes.rows[0].retirement_overs);
  res.json({ eligible_player_ids: eligible });
});

// Live scorecard for an innings, including extras breakdown and fall of wickets
router.get('/innings/:inningsId/scorecard', async (req, res) => {
  const { inningsId } = req.params;
  const innings = await pool.query('SELECT * FROM innings WHERE id=$1', [inningsId]);
  const battingInnings = innings.rows[0];
  const batting = await pool.query(
    `SELECT br.*, p.name,
      bowler.name AS bowler_name, fielder.name AS fielder_name
     FROM batting_records br
     JOIN players p ON p.id = br.player_id
     LEFT JOIN players bowler ON bowler.id = br.bowler_id
     LEFT JOIN players fielder ON fielder.id = br.fielder_id
     WHERE br.innings_id=$1 ORDER BY br.batting_order NULLS LAST`,
    [inningsId]
  );
  const bowling = await pool.query(
    `SELECT bwr.*, p.name FROM bowling_records bwr JOIN players p ON p.id = bwr.player_id
     WHERE bwr.innings_id=$1`,
    [inningsId]
  );
  const fow = await pool.query(
    `SELECT fow.*, p.name FROM fall_of_wickets fow JOIN players p ON p.id = fow.player_id
     WHERE fow.innings_id=$1 ORDER BY fow.wicket_no`,
    [inningsId]
  );

  let firstInnings = null;
  if (battingInnings && battingInnings.innings_no === 2) {
    const firstInningsRes = await pool.query(
      `SELECT i.*, m.team_a_name, m.team_b_name FROM innings i
       JOIN matches m ON m.id = i.match_id
       WHERE i.match_id=$1 AND i.innings_no=1`,
      [battingInnings.match_id]
    );
    if (firstInningsRes.rows.length > 0) {
      const fi = firstInningsRes.rows[0];
      firstInnings = {
        total_runs: fi.total_runs,
        total_wickets: fi.total_wickets,
        team_name: fi.batting_team === 'A' ? fi.team_a_name : fi.team_b_name,
        target: fi.total_runs + 1
      };
    }
  }

  res.json({ innings: battingInnings, batting: batting.rows, bowling: bowling.rows, fall_of_wickets: fow.rows, first_innings: firstInnings });
});

// Ball-by-ball events for a specific over
router.get('/innings/:inningsId/over/:overNo/balls', async (req, res) => {
  const { inningsId, overNo } = req.params;
  const result = await pool.query(
    'SELECT * FROM ball_events WHERE innings_id=$1 AND over_no=$2 ORDER BY id',
    [inningsId, overNo]
  );
  res.json(result.rows);
});

// Finalize match result (win/loss/tie) for tracking
router.post('/matches/:matchId/complete', async (req, res) => {
  const { matchId } = req.params;
  const { winner_team, result_summary } = req.body;
  await pool.query(
    `UPDATE matches SET status='completed', winner_team=$1, result_summary=$2 WHERE id=$3`,
    [winner_team, result_summary, matchId]
  );
  res.json({ success: true });
});

// Undo the most recent ball event for an innings, then fully recompute all
// derived state (innings totals, batting/bowling records, fall of wickets)
// by replaying every remaining ball event from scratch. This guarantees
// correctness no matter how many times undo is pressed in a row.
router.post('/innings/:inningsId/undo', async (req, res) => {
  const { inningsId } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const lastBallRes = await client.query(
      'SELECT id FROM ball_events WHERE innings_id=$1 ORDER BY id DESC LIMIT 1',
      [inningsId]
    );
    if (lastBallRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No balls to undo.' });
    }
    await client.query('DELETE FROM ball_events WHERE id=$1', [lastBallRes.rows[0].id]);

    await replayInnings(client, inningsId);

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Recomputes innings totals, batting_records, bowling_records and fall_of_wickets
// entirely from the remaining ball_events rows, in chronological order. This is
// the single source of truth used both for normal undo and for consistency checks.
async function replayInnings(client, inningsId) {
  const inningsRes = await client.query('SELECT * FROM innings WHERE id=$1 FOR UPDATE', [inningsId]);
  const innings = inningsRes.rows[0];

  await client.query(
    `UPDATE batting_records SET runs=0, balls_faced=0, fours=0, sixes=0, status='yet_to_bat',
     bowler_id=NULL, fielder_id=NULL, dismissal_type=NULL, retirement_count=0
     WHERE innings_id=$1`,
    [inningsId]
  );
  await client.query(
    `UPDATE batting_records SET status='batting' WHERE innings_id=$1 AND player_id=$2`,
    [inningsId, innings.striker_id]
  );
  await client.query(
    `UPDATE bowling_records SET overs_bowled=0, runs_conceded=0, wickets=0 WHERE innings_id=$1`,
    [inningsId]
  );
  await client.query(`DELETE FROM fall_of_wickets WHERE innings_id=$1`, [inningsId]);
  await client.query(
    `UPDATE innings SET total_runs=0, total_wickets=0, overs_completed=0, total_legal_balls=0,
     wide_runs=0, no_ball_runs=0 WHERE id=$1`,
    [inningsId]
  );

  const ballsRes = await client.query(
    'SELECT * FROM ball_events WHERE innings_id=$1 ORDER BY id ASC', [inningsId]
  );

  let currentStriker = innings.striker_id;
  let currentBowler = innings.bowler_id;
  let totalLegalBalls = 0;
  let totalRuns = 0;
  let totalWickets = 0;
  let wideRuns = 0;
  let noBallRuns = 0;
  let wicketNo = 0;
  const bowlerLegalBalls = {};

  for (const ball of ballsRes.rows) {
    currentStriker = ball.batsman_id;
    currentBowler = ball.bowler_id;
    const isLegalBall = ball.extra_type !== 'wide' && ball.extra_type !== 'no_ball';
    const totalRunsThisBall = ball.runs + ball.extra_runs;
    totalRuns += totalRunsThisBall;
    if (isLegalBall) totalLegalBalls += 1;
    if (ball.extra_type === 'wide') wideRuns += ball.extra_runs;
    if (ball.extra_type === 'no_ball') noBallRuns += ball.extra_runs;

    if (ball.extra_type !== 'wide') {
      await client.query(
        `UPDATE batting_records SET balls_faced = balls_faced + $1, runs = runs + $2,
         fours = fours + $3, sixes = sixes + $4
         WHERE innings_id=$5 AND player_id=$6`,
        [isLegalBall ? 1 : 0, ball.runs, ball.runs === 4 ? 1 : 0, ball.runs === 6 ? 1 : 0, inningsId, ball.batsman_id]
      );
    }
    await client.query(
      `UPDATE bowling_records SET runs_conceded = runs_conceded + $1 WHERE innings_id=$2 AND player_id=$3`,
      [totalRunsThisBall, inningsId, ball.bowler_id]
    );
    if (isLegalBall) {
      bowlerLegalBalls[ball.bowler_id] = (bowlerLegalBalls[ball.bowler_id] || 0) + 1;
      await client.query(
        `UPDATE bowling_records SET overs_bowled = $1 WHERE innings_id=$2 AND player_id=$3`,
        [ballsToOversDisplay(bowlerLegalBalls[ball.bowler_id]), inningsId, ball.bowler_id]
      );
    }
    if (ball.is_wicket) {
      totalWickets += 1;
      wicketNo += 1;
      await client.query(
        `UPDATE batting_records SET status='out', dismissal_type=$1, bowler_id=$2, fielder_id=$3
         WHERE innings_id=$4 AND player_id=$5`,
        [ball.wicket_type, ball.bowler_id, null, inningsId, ball.batsman_id]
      );
      await client.query(
        `UPDATE bowling_records SET wickets = wickets + 1 WHERE innings_id=$1 AND player_id=$2`,
        [inningsId, ball.bowler_id]
      );
      const oversAtFall = ballsToOversDisplay(totalLegalBalls);
      await client.query(
        `INSERT INTO fall_of_wickets (innings_id, wicket_no, team_score_at_fall, player_id, over_at_fall)
         VALUES ($1,$2,$3,$4,$5)`,
        [inningsId, wicketNo, totalRuns, ball.batsman_id, oversAtFall]
      );
    }
  }

  const finalOversDisplay = ballsToOversDisplay(totalLegalBalls);
  await client.query(
    `UPDATE innings SET total_runs=$1, total_wickets=$2, overs_completed=$3, total_legal_balls=$4,
     wide_runs=$5, no_ball_runs=$6, striker_id=$7, bowler_id=$8 WHERE id=$9`,
    [totalRuns, totalWickets, finalOversDisplay, totalLegalBalls, wideRuns, noBallRuns, currentStriker, currentBowler, inningsId]
  );

  // Ensure current striker is marked batting again if they're not already out (undo may have un-dismissed them)
  await client.query(
    `UPDATE batting_records SET status='batting' WHERE innings_id=$1 AND player_id=$2 AND status != 'out'`,
    [inningsId, currentStriker]
  );
}



// Per-over run totals for both innings of a match (for progress/worm charts)
router.get('/matches/:matchId/over-progress', async (req, res) => {
  const { matchId } = req.params;
  const inningsRes = await pool.query(
    'SELECT id, innings_no, batting_team FROM innings WHERE match_id=$1 ORDER BY innings_no',
    [matchId]
  );
  const result = [];
  for (const inn of inningsRes.rows) {
    const overs = await pool.query(
      `SELECT over_no, SUM(runs + extra_runs) AS runs_in_over
       FROM ball_events WHERE innings_id=$1 GROUP BY over_no ORDER BY over_no`,
      [inn.id]
    );
    let cumulative = 0;
    const perOver = overs.rows.map(o => {
      cumulative += parseInt(o.runs_in_over, 10);
      return { over_no: o.over_no, runs_in_over: parseInt(o.runs_in_over, 10), cumulative_runs: cumulative };
    });
    result.push({ innings_no: inn.innings_no, batting_team: inn.batting_team, per_over: perOver });
  }
  res.json(result);
});

// Full match scorecard: both innings' batting and bowling side by side
router.get('/matches/:matchId/full-scorecard', async (req, res) => {
  const { matchId } = req.params;
  const inningsRes = await pool.query(
    'SELECT * FROM innings WHERE match_id=$1 ORDER BY innings_no',
    [matchId]
  );
  const result = [];
  for (const inn of inningsRes.rows) {
    const batting = await pool.query(
      `SELECT br.*, p.name FROM batting_records br JOIN players p ON p.id = br.player_id
       WHERE br.innings_id=$1 ORDER BY br.batting_order NULLS LAST`,
      [inn.id]
    );
    const bowling = await pool.query(
      `SELECT bwr.*, p.name FROM bowling_records bwr JOIN players p ON p.id = bwr.player_id
       WHERE bwr.innings_id=$1`,
      [inn.id]
    );
    result.push({ innings: inn, batting: batting.rows, bowling: bowling.rows });
  }
  res.json(result);
});

module.exports = router;
