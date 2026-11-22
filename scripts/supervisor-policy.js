export const RESTART_WINDOW_MS = 5 * 60 * 1000;
export const MAX_RESTARTS_IN_WINDOW = 3;
export function restartDelayMs(restartNumber) {
  return Math.min(1000 * (2 ** Math.max(0, restartNumber - 1)), 8000);
}
export function canRestart(restartTimes, now = Date.now()) {
  const recent = restartTimes.filter(time => now - time < RESTART_WINDOW_MS);
  return { allowed: recent.length < MAX_RESTARTS_IN_WINDOW, recent };
}
