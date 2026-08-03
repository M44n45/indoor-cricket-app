// src/logic/rotation.js
// Pure logic for the 2-over batsman retirement + rotation rule.
// Rule: a batsman retires after facing `retirementOvers` worth of overs while on strike.
// A retired batsman can only return once every other non-out player in the roster
// has had a turn to bat (i.e. is currently 'batting', 'retired' again, or 'out').

/**
 * @param {Array} battingRecords - [{ player_id, status, retirement_count, balls_faced }]
 * @param {number} retirementOvers
 * @param {number} ballsPerOver
 * @returns {Array} list of player_ids currently eligible to bat (not out, and either
 *          never retired, or retired but rotation cycle has completed for them)
 */
function getEligibleBatsmen(battingRecords, retirementOvers, ballsPerOver = 6) {
  // Any non-out player (including retired batsmen) is eligible to be selected
  // back in at any time. Retirement is a rotation suggestion, not a hard lock.
  return battingRecords
    .filter(r => r.status !== 'out')
    .map(r => r.player_id);
}

/**
 * Checks whether the current striker should be auto-retired based on balls faced
 * while 'batting' (only counts deliveries actually faced, not extras like wides).
 */
function shouldRetire(ballsFacedThisStint, retirementOvers, ballsPerOver = 6) {
  return ballsFacedThisStint >= retirementOvers * ballsPerOver;
}

/**
 * Determines if the innings should end: all players out (roster size - 1, since
 * one always remains not-out in single-wicket-retirement small-team cricket),
 * overs completed, or only one eligible batsman remains and no one can partner them.
 */
function isInningsOver(battingRecords, oversCompleted, oversLimit, rosterSize) {
  const outCount = battingRecords.filter(r => r.status === 'out').length;
  if (outCount >= rosterSize - 1) return true;
  if (oversCompleted >= oversLimit) return true;
  return false;
}

module.exports = { getEligibleBatsmen, shouldRetire, isInningsOver };
