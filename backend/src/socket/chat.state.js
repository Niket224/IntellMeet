const { performance } = require("node:perf_hooks");

const BURST = 10;
const REFILL_MS = 1000;
const TTL_MS = 5 * 60 * 1000;
const MAX_USERS = 1024;
const MAX_MESSAGES = 2048;

function createChatState({ now = () => performance.now() } = {}) {
  const users = new Map();
  const messages = new Map();
  let nextPrune = 0;
  let closed = false;
  const keyFor = (userId, meetingId, clientMessageId) => JSON.stringify([userId, meetingId, clientMessageId]);

  function prune(at) {
    if (at < nextPrune && users.size < MAX_USERS) return;
    for (const [key, entry] of messages) {
      if (at - entry.acceptedAt >= TTL_MS) messages.delete(key);
    }
    for (const [userId, entry] of users) {
      if (at - entry.lastSeen >= TTL_MS) users.delete(userId);
    }
    nextPrune = at + REFILL_MS;
  }

  function take(userId) {
    if (closed) return { allowed: false, unavailable: true };
    const at = now();
    prune(at);
    let bucket = users.get(userId);
    if (!bucket) {
      if (users.size >= MAX_USERS) return { allowed: false, unavailable: true };
      bucket = { tokens: BURST, lastRefill: at, lastSeen: at };
      users.set(userId, bucket);
    }
    bucket.tokens = Math.min(BURST, bucket.tokens + (at - bucket.lastRefill) / REFILL_MS);
    bucket.lastRefill = at;
    bucket.lastSeen = at;
    if (bucket.tokens < 1) {
      return { allowed: false, retryAfterMs: Math.max(1, Math.ceil((1 - bucket.tokens) * REFILL_MS)) };
    }
    bucket.tokens -= 1;
    return { allowed: true };
  }

  function get(userId, meetingId, clientMessageId) {
    if (closed) return null;
    const key = keyFor(userId, meetingId, clientMessageId);
    const entry = messages.get(key);
    if (!entry) return null;
    if (now() - entry.acceptedAt >= TTL_MS) {
      messages.delete(key);
      return null;
    }
    return entry.message;
  }

  function remember(userId, meetingId, clientMessageId, message) {
    if (closed) return;
    const key = keyFor(userId, meetingId, clientMessageId);
    if (!messages.has(key) && messages.size >= MAX_MESSAGES) {
      messages.delete(messages.keys().next().value);
    }
    messages.set(key, { acceptedAt: now(), message });
  }

  function close() {
    closed = true;
    users.clear();
    messages.clear();
  }

  return { take, get, remember, close };
}

module.exports = createChatState;
