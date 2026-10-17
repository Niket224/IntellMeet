const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const User = require("../models/User");

const MAX_TOKEN_LENGTH = 8192;
const MAX_TIMEOUT_MS = 2147483647;
const messages = {
  AUTH_REQUIRED: "Authentication required",
  AUTH_INVALID: "Invalid authentication token",
  AUTH_EXPIRED: "Authentication token expired",
  AUTH_UNAVAILABLE: "Authentication temporarily unavailable"
};

function authError(code) {
  const error = new Error(messages[code]);
  error.data = { code, retryable: code === "AUTH_UNAVAILABLE" };
  return error;
}

async function authenticateSocket(socket, next) {
  const token = socket.handshake.auth?.token;
  if (token === undefined || token === null || (typeof token === "string" && !token.trim())) {
    return next(authError("AUTH_REQUIRED"));
  }
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) {
    return next(authError("AUTH_INVALID"));
  }

  const secret = process.env.JWT_SECRET;
  if (!secret || !secret.trim()) {
    return next(authError("AUTH_UNAVAILABLE"));
  }

  let decoded;
  try {
    // generateToken() issues HS256 tokens containing the user ID and expiry.
    decoded = jwt.verify(token, secret, { algorithms: ["HS256"] });
  } catch (error) {
    return next(authError(error instanceof jwt.TokenExpiredError ? "AUTH_EXPIRED" : "AUTH_INVALID"));
  }

  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)
    || typeof decoded.id !== "string" || !mongoose.isObjectIdOrHexString(decoded.id)
    || !Number.isSafeInteger(decoded.exp) || !Number.isSafeInteger(decoded.exp * 1000)) {
    return next(authError("AUTH_INVALID"));
  }

  let user;
  try {
    user = await User.findById(decoded.id).select("_id").lean();
  } catch {
    // Never expose database details, tokens, or verification internals.
    return next(authError("AUTH_UNAVAILABLE"));
  }
  if (!user) return next(authError("AUTH_INVALID"));

  const expiresAt = decoded.exp * 1000;
  // The token can expire while the asynchronous user lookup is running.
  if (Date.now() >= expiresAt) return next(authError("AUTH_EXPIRED"));

  socket.data.user = { id: String(user._id) };
  socket.data.auth = { expiresAt };
  return next();
}

function enforceSocketExpiry(socket) {
  if (!socket.connected) return false;
  const expiresAt = socket.data.auth.expiresAt;
  let timer;
  let stopped = false;

  socket.once("disconnect", () => {
    stopped = true;
    clearTimeout(timer);
  });

  function expire() {
    if (stopped) return;
    socket.emit("auth:error", {
      code: "AUTH_EXPIRED",
      message: messages.AUTH_EXPIRED,
      retryable: false
    });
    socket.disconnect(true);
  }

  function schedule() {
    if (stopped) return;
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) return expire();

    // Node clamps larger delays to 1ms. Recheck long-lived tokens in chunks.
    timer = setTimeout(schedule, Math.min(remaining, MAX_TIMEOUT_MS));
    timer.unref();
  }

  // Expiry is checked before incoming events too, in case a timer is delayed.
  socket.use((packet, next) => {
    if (Date.now() >= expiresAt) return expire();
    next();
  });

  // Start only after connection, so aborted handshakes allocate no timers.
  schedule();
  return socket.connected;
}

module.exports = { authenticateSocket, enforceSocketExpiry };
