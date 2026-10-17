const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const { EventEmitter } = require("node:events");
const http = require("node:http");
const { test } = require("node:test");
const jwt = require("jsonwebtoken");
const { io: createClient } = require("socket.io-client");
const User = require("../src/models/User");
const generateToken = require("../src/utils/generateToken");
const initializeSocket = require("../src/socket");
const { authenticateSocket, enforceSocketExpiry } = require("../src/socket/auth.socket");

const secret = "socket-auth-test-secret-for-local-tests-only";
const userId = "507f1f77bcf86cd799439011";
const otherUserId = "507f1f77bcf86cd799439012";

function setEnvironment(t, name, value) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

function signedToken(claims = {}, options = {}) {
  return jwt.sign({ id: userId, ...claims }, secret, {
    expiresIn: "5m",
    ...options
  });
}

// Real HMAC signatures let us exercise claims rejected by jwt.sign's own validation.
function signedRawClaims(claims) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const data = `${header}.${payload}`;
  return `${data}.${createHmac("sha256", secret).update(data).digest("base64url")}`;
}

function mockUserLookup(t, result = { _id: userId }) {
  const calls = [];
  const method = t.mock.method(User, "findById", (id) => {
    calls.push(id);
    return {
      select(selection) {
        assert.equal(selection, "_id");
        return {
          async lean() {
            if (result instanceof Error) throw result;
            return typeof result === "function" ? result() : result;
          }
        };
      }
    };
  });
  return { calls, method };
}

function handshakeSocket(auth) {
  return { handshake: { auth }, data: {} };
}

async function authenticate(socket) {
  const calls = [];
  await authenticateSocket(socket, (error) => calls.push(error));
  assert.equal(calls.length, 1, "authentication must call next exactly once");
  return calls[0];
}

function assertAuthError(error, code, retryable = false) {
  assert.ok(error instanceof Error);
  assert.equal(typeof error.message, "string");
  assert.deepEqual(error.data, { code, retryable });
  assert.doesNotMatch(error.message, /MongoServer|mongodb:\/\/|internal-database|test-secret|stack|JWT_SECRET/);
}

async function startServer(t) {
  const server = http.createServer((req, res) => res.end("ok"));
  const io = initializeSocket(server);
  t.after(async () => {
    const closed = new Promise((resolve) => io.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { io, url: `http://127.0.0.1:${server.address().port}` };
}

function makeClient(t, url, auth) {
  const client = createClient(url, {
    auth,
    autoConnect: false,
    forceNew: true,
    reconnection: false,
    timeout: 2000,
    transports: ["websocket"]
  });
  t.after(() => client.disconnect());
  return client;
}

function connect(client) {
  return new Promise((resolve, reject) => {
    client.once("connect", resolve);
    client.once("connect_error", reject);
    client.connect();
  });
}

class FakeSocket extends EventEmitter {
  constructor(expiresAt, connected = true) {
    super();
    this.connected = connected;
    this.data = { user: { id: userId }, auth: { expiresAt } };
    this.packetMiddleware = [];
    this.disconnectCalls = [];
  }

  use(middleware) {
    this.packetMiddleware.push(middleware);
    return this;
  }

  disconnect(close) {
    this.disconnectCalls.push(close);
    this.connected = false;
    this.emit("disconnect", "server namespace disconnect");
    return this;
  }
}

function mockClock(t, initialNow) {
  let now = initialNow;
  const timers = [];
  const cleared = [];
  t.mock.method(Date, "now", () => now);
  t.mock.method(global, "setTimeout", (callback, delay) => {
    const timer = { callback, delay, unrefCalls: 0, unref() { this.unrefCalls += 1; } };
    timers.push(timer);
    return timer;
  });
  t.mock.method(global, "clearTimeout", (timer) => cleared.push(timer));
  return { timers, cleared, setNow(value) { now = value; } };
}

test("Socket.IO JWT authentication", { timeout: 30000 }, async (t) => {
  setEnvironment(t, "JWT_SECRET", secret);
  setEnvironment(t, "JWT_EXPIRES_IN", "5m");
  t.mock.method(console, "log", () => {});

  await t.test("requires a token and rejects malformed handshake values before querying users", async (t) => {
    const { calls } = mockUserLookup(t);
    for (const auth of [undefined, {}, { token: undefined }, { token: null }, { token: "" }, { token: "   " }]) {
      assertAuthError(await authenticate(handshakeSocket(auth)), "AUTH_REQUIRED");
    }
    for (const token of [123, {}, [], true, "bad-token", "Bearer token", "x".repeat(8193)]) {
      assertAuthError(await authenticate(handshakeSocket({ token })), "AUTH_INVALID");
    }
    assert.equal(calls.length, 0);
  });

  await t.test("rejects wrong signatures, unsupported algorithms, and future-not-before tokens", async (t) => {
    const { calls } = mockUserLookup(t);
    const now = Math.floor(Date.now() / 1000);
    const tokens = [
      jwt.sign({ id: userId }, "wrong-secret", { expiresIn: "5m" }),
      signedToken({}, { algorithm: "HS384" }),
      jwt.sign({ id: userId, exp: now + 60 }, null, { algorithm: "none" }),
      signedToken({ nbf: now + 60 })
    ];
    for (const token of tokens) {
      assertAuthError(await authenticate(handshakeSocket({ token })), "AUTH_INVALID");
    }
    assert.equal(calls.length, 0);
  });

  await t.test("rejects expired JWTs without a database query", async (t) => {
    const { calls } = mockUserLookup(t);
    const token = signedToken({}, { expiresIn: -1 });
    assertAuthError(await authenticate(handshakeSocket({ token })), "AUTH_EXPIRED");
    assert.equal(calls.length, 0);
  });

  await t.test("rejects malformed identity and expiration claims", async (t) => {
    const { calls } = mockUserLookup(t);
    const exp = Math.floor(Date.now() / 1000) + 300;
    const payloads = [
      { exp },
      { id: "not-an-object-id", exp },
      { id: 123, exp },
      { id: { toString: userId }, exp },
      { id: userId },
      { id: userId, exp: String(exp) },
      { id: userId, exp: null },
      { id: userId, exp: exp + 0.5 },
      { id: userId, exp: Number.MAX_SAFE_INTEGER }
    ];
    for (const claims of payloads) {
      assertAuthError(await authenticate(handshakeSocket({ token: signedRawClaims(claims) })), "AUTH_INVALID");
    }
    assertAuthError(await authenticate(handshakeSocket({ token: jwt.sign("string-payload", secret) })), "AUTH_INVALID");
    assert.equal(calls.length, 0);
  });

  await t.test("rejects deleted users without disclosing whether their account existed", async (t) => {
    const { calls } = mockUserLookup(t, null);
    const error = await authenticate(handshakeSocket({ token: signedToken() }));
    assertAuthError(error, "AUTH_INVALID");
    assert.deepEqual(calls, [userId]);
    assert.doesNotMatch(error.message, /deleted|not found|account/i);
  });

  await t.test("treats missing JWT configuration as a safe retryable server error", async (t) => {
    setEnvironment(t, "JWT_SECRET", undefined);
    const { calls } = mockUserLookup(t);
    assertAuthError(await authenticate(handshakeSocket({ token: signedToken() })), "AUTH_UNAVAILABLE", true);
    assert.equal(calls.length, 0);
  });

  await t.test("sanitizes database failures and does not attach partial identity", async (t) => {
    mockUserLookup(t, new Error("MongoServer internal-database mongodb://secret-host/password"));
    const socket = handshakeSocket({ token: signedToken() });
    assertAuthError(await authenticate(socket), "AUTH_UNAVAILABLE", true);
    assert.deepEqual(socket.data, {});
  });

  await t.test("accepts the existing token generator and stores only trusted database identity and expiry", async (t) => {
    mockUserLookup(t, { _id: otherUserId });
    const token = generateToken(userId);
    const socket = handshakeSocket({ token, userId, user: { id: userId, role: "admin" }, expiresAt: Infinity });
    assert.equal(await authenticate(socket), undefined);
    assert.deepEqual(socket.data, {
      user: { id: otherUserId },
      auth: { expiresAt: jwt.decode(token).exp * 1000 }
    });
    assert.equal(JSON.stringify(socket.data).includes(token), false);
  });

  await t.test("rechecks JWT expiry after an asynchronous database lookup", async (t) => {
    const now = Math.floor(Date.now() / 1000) * 1000;
    let clock = now;
    t.mock.method(Date, "now", () => clock);
    mockUserLookup(t, () => {
      clock = now + 2000;
      return { _id: userId };
    });
    const token = signedRawClaims({ id: userId, exp: now / 1000 + 1 });
    const socket = handshakeSocket({ token });
    assertAuthError(await authenticate(socket), "AUTH_EXPIRED");
    assert.deepEqual(socket.data, {});
  });

  await t.test("sends structured handshake failures to a real client and never connects it", async (t) => {
    const { calls } = mockUserLookup(t);
    const { io, url } = await startServer(t);
    let connections = 0;
    io.on("connection", () => { connections += 1; });
    for (const [auth, code] of [
      [{}, "AUTH_REQUIRED"],
      [{ token: signedToken({}, { expiresIn: -1 }) }, "AUTH_EXPIRED"],
      [{ token: "bad-token" }, "AUTH_INVALID"]
    ]) {
      const client = makeClient(t, url, auth);
      await assert.rejects(connect(client), (error) => {
        assertAuthError(error, code);
        return true;
      });
      assert.equal(client.connected, false);
    }
    assert.equal(connections, 0);
    assert.equal(calls.length, 0);
  });

  await t.test("sends a safe retryable database error over the Socket.IO handshake", async (t) => {
    mockUserLookup(t, new Error("internal-database secret connection string"));
    const { url } = await startServer(t);
    const client = makeClient(t, url, { token: signedToken() });
    await assert.rejects(connect(client), (error) => {
      assertAuthError(error, "AUTH_UNAVAILABLE", true);
      return true;
    });
  });

  await t.test("authenticates a real client and disconnects it when its JWT expires", { timeout: 6000 }, async (t) => {
    mockUserLookup(t);
    const { io, url } = await startServer(t);
    const token = signedToken({}, { expiresIn: 2 });
    const connected = new Promise((resolve) => io.once("connection", resolve));
    const client = makeClient(t, url, { token, userId: otherUserId });
    const events = [];
    const expiry = new Promise((resolve) => client.once("auth:error", (payload) => { events.push("auth:error"); resolve(payload); }));
    const disconnected = new Promise((resolve) => client.once("disconnect", (reason) => { events.push("disconnect"); resolve(reason); }));
    await connect(client);
    const serverSocket = await connected;
    assert.deepEqual(serverSocket.data, { user: { id: userId }, auth: { expiresAt: jwt.decode(token).exp * 1000 } });
    assert.deepEqual(await expiry, { code: "AUTH_EXPIRED", message: "Authentication token expired", retryable: false });
    assert.equal(await disconnected, "io server disconnect");
    assert.deepEqual(events, ["auth:error", "disconnect"]);
    assert.equal(serverSocket.connected, false);
    assert.equal(client.connected, false);
    assert.equal(io.of("/").sockets.size, 0);
  });

  await t.test("caps long-lived expiry timers, recomputes remaining time, and cleans up on disconnect", (t) => {
    const now = 1700000000000;
    const maxDelay = 2147483647;
    const clock = mockClock(t, now);
    const socket = new FakeSocket(now + maxDelay + 5000);
    assert.equal(enforceSocketExpiry(socket), true);
    assert.equal(clock.timers.length, 1);
    assert.equal(clock.timers[0].delay, maxDelay);
    assert.equal(clock.timers[0].unrefCalls, 1);
    clock.setNow(now + maxDelay);
    clock.timers[0].callback();
    assert.equal(socket.connected, true);
    assert.equal(clock.timers.length, 2);
    assert.equal(clock.timers[1].delay, 5000);
    assert.equal(clock.timers[1].unrefCalls, 1);
    socket.disconnect(true);
    assert.ok(clock.cleared.includes(clock.timers[1]));
    assert.deepEqual(socket.disconnectCalls, [true]);
  });

  await t.test("checks expiry on incoming packets even before a delayed timer runs", (t) => {
    const now = 1700000000000;
    const clock = mockClock(t, now);
    const socket = new FakeSocket(now + 1000);
    const errors = [];
    socket.on("auth:error", (payload) => errors.push(payload));
    enforceSocketExpiry(socket);
    assert.equal(socket.packetMiddleware.length, 1);
    let nextCalls = 0;
    socket.packetMiddleware[0](["probe"], () => { nextCalls += 1; });
    assert.equal(nextCalls, 1);
    clock.setNow(now + 1000);
    socket.packetMiddleware[0](["probe"], () => { nextCalls += 1; });
    assert.equal(nextCalls, 1, "expired event must not reach downstream handlers");
    assert.equal(socket.connected, false);
    assert.deepEqual(socket.disconnectCalls, [true]);
    assert.deepEqual(errors, [{ code: "AUTH_EXPIRED", message: "Authentication token expired", retryable: false }]);
    assert.ok(clock.cleared.includes(clock.timers[0]));
  });

  await t.test("expires an already-expired connection immediately without creating a timer", (t) => {
    const now = 1700000000000;
    const clock = mockClock(t, now);
    const socket = new FakeSocket(now);
    assert.equal(enforceSocketExpiry(socket), false);
    assert.equal(clock.timers.length, 0);
    assert.deepEqual(socket.disconnectCalls, [true]);
  });

  await t.test("does not create expiry timers for sockets disconnected during authentication", (t) => {
    const now = 1700000000000;
    const clock = mockClock(t, now);
    const socket = new FakeSocket(now + 10000, false);
    assert.equal(enforceSocketExpiry(socket), false);
    assert.equal(clock.timers.length, 0);
    assert.deepEqual(socket.disconnectCalls, []);
  });
});
