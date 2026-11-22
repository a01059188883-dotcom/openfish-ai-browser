import test from "node:test";
import assert from "node:assert/strict";
import { canRestart, restartDelayMs, MAX_RESTARTS_IN_WINDOW, RESTART_WINDOW_MS } from "../../../scripts/supervisor-policy.js";

test("local supervisor applies bounded exponential restart delays", () => {
  assert.equal(restartDelayMs(1), 1000);
  assert.equal(restartDelayMs(2), 2000);
  assert.equal(restartDelayMs(3), 4000);
  assert.equal(restartDelayMs(4), 8000);
  assert.equal(restartDelayMs(8), 8000);
});

test("local supervisor allows at most three restarts in a rolling five-minute window", () => {
  const now = 1_000_000;
  const times = [now - 30_000, now - 20_000, now - 10_000];
  assert.equal(MAX_RESTARTS_IN_WINDOW, 3);
  assert.equal(RESTART_WINDOW_MS, 300_000);
  assert.equal(canRestart(times, now).allowed, false);
  assert.equal(canRestart([now - RESTART_WINDOW_MS - 1, now - 10_000], now).allowed, true);
  assert.equal(canRestart([], now).allowed, true);
});
