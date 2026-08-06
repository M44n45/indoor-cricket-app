const test = require('node:test');
const assert = require('node:assert/strict');
const { ballsToOversDisplay, cricketOversToBalls, oversToBalls } = require('../src/routes/scoring');

test('three legal balls are displayed as half an over', () => {
  assert.equal(ballsToOversDisplay(3), 0.5);
  assert.equal(oversToBalls(0.5), 3);
});

test('three-ball overs convert back to the correct ball count', () => {
  assert.equal(cricketOversToBalls(0.5), 3);
});
