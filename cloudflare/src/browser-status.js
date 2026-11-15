export function summarizeBrowserLimits(limits = {}) {
  const active = Array.isArray(limits.activeSessions) ? limits.activeSessions.length : 0;
  const max = Number.isFinite(limits.maxConcurrentSessions) ? limits.maxConcurrentSessions : null;
  const allowed = Number.isFinite(limits.allowedBrowserAcquisitions) ? limits.allowedBrowserAcquisitions : null;
  const wait = Number.isFinite(limits.timeUntilNextAllowedBrowserAcquisition)
    ? Math.max(0, limits.timeUntilNextAllowedBrowserAcquisition)
    : null;
  return {
    active_sessions: active,
    max_concurrent_sessions: max,
    allowed_browser_acquisitions: allowed,
    time_until_next_allowed_acquisition_ms: wait,
    capacity_available: allowed === null ? null : allowed > 0 && (max === null || active < max)
  };
}

export function isBrowserRateLimited(error) {
  const message = String(error?.message || error || "");
  return /(?:\b429\b|rate.?limit|too many requests|quota exceeded)/i.test(message);
}

export function retryAfterMs(limits = {}) {
  const value = limits.timeUntilNextAllowedBrowserAcquisition;
  return Number.isFinite(value) ? Math.max(0, value) : null;
}
