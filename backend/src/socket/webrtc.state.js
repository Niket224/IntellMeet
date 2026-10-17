const { performance } = require("node:perf_hooks");

const LIMITS = { description: { burst: 20, perSecond: 2 }, ice: { burst: 200, perSecond: 40 } };
const TTL_MS = 5 * 60 * 1000;
const MAX_USERS = 1024;

function createWebrtcState({ now = () => performance.now() } = {}) {
  const users = new Map();
  let nextPrune = 0;
  let closed = false;

  function take(userId, kind) {
    if (closed) return { allowed: false, unavailable: true };
    const at = now();
    if (at >= nextPrune || users.size >= MAX_USERS) {
      for (const [id, user] of users) {
        if (at - user.lastSeen >= TTL_MS) users.delete(id);
      }
      nextPrune = at + 1000;
    }
    let user = users.get(userId);
    if (!user) {
      if (users.size >= MAX_USERS) return { allowed: false, unavailable: true };
      user = { lastSeen: at, buckets: {} };
      users.set(userId, user);
    }
    user.lastSeen = at;
    const limit = LIMITS[kind];
    const bucket = user.buckets[kind] ||= { tokens: limit.burst, at };
    bucket.tokens = Math.min(limit.burst, bucket.tokens + (at - bucket.at) * limit.perSecond / 1000);
    bucket.at = at;
    if (bucket.tokens < 1) {
      return { allowed: false, retryAfterMs: Math.max(1, Math.ceil((1 - bucket.tokens) * 1000 / limit.perSecond)) };
    }
    bucket.tokens -= 1;
    return { allowed: true };
  }

  function close() {
    closed = true;
    users.clear();
  }

  // Only numeric rate metadata is retained: no peers, SDP, ICE, or timers.
  return { take, close };
}

module.exports = createWebrtcState;
