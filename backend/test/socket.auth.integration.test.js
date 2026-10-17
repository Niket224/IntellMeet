const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const http = require("node:http");
const test = require("node:test");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { io: createClient } = require("socket.io-client");

const testUri = process.env.TEST_MONGODB_URI;
const testDatabasePattern = /^intellimeet_phase3_test_[A-Za-z0-9_]+$/;

test("Socket.IO authentication with REST-issued JWTs and real MongoDB users", {
  skip: !testUri && "Set TEST_MONGODB_URI to a dedicated intellimeet_phase3_test_<suffix> database",
  timeout: 60000
}, async (t) => {
  const parsedUri = new URL(testUri);
  assert.match(parsedUri.protocol, /^mongodb(?:\+srv)?:$/);
  const databaseName = decodeURIComponent(parsedUri.pathname.slice(1));

  // This suite drops its database; never accept an application database name.
  assert.match(databaseName, testDatabasePattern,
    "TEST_MONGODB_URI must name a dedicated intellimeet_phase3_test_<suffix> database");

  const originalEnv = Object.fromEntries(
    ["MONGODB_URI", "JWT_SECRET", "JWT_EXPIRES_IN", "NODE_ENV"].map((key) => [key, process.env[key]])
  );
  process.env.MONGODB_URI = testUri;
  process.env.JWT_SECRET = randomBytes(32).toString("hex");
  process.env.JWT_EXPIRES_IN = "5m";
  process.env.NODE_ENV = "test";

  let server;
  let io;
  let connected = false;
  const clients = new Set();

  t.after(async () => {
    try {
      for (const client of clients) client.disconnect();
      if (io) {
        const closed = new Promise((resolve) => io.close(resolve));
        server.closeAllConnections();
        await closed;
      } else if (server && server.listening) {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    } finally {
      try {
        if (connected) {
          // Validate the actual connection again immediately before destructive cleanup.
          assert.equal(mongoose.connection.name, databaseName);
          assert.match(mongoose.connection.name, testDatabasePattern);
          await mongoose.connection.dropDatabase();
        }
      } finally {
        await mongoose.disconnect();
        for (const [key, value] of Object.entries(originalEnv)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    }
  });

  const connectDB = require("../src/config/db");
  const User = require("../src/models/User");
  const generateToken = require("../src/utils/generateToken");
  const app = require("../src/app");
  const initializeSocket = require("../src/socket");

  await connectDB();
  connected = true;
  assert.equal(mongoose.connection.name, databaseName);

  server = http.createServer(app);
  io = initializeSocket(server);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function registerUser(label) {
    const response = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `Phase 3 ${label}`,
        email: `${label}-${randomBytes(8).toString("hex")}@example.test`,
        password: "phase3-test-password"
      }),
      signal: AbortSignal.timeout(10000)
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(typeof body.token, "string");
    return body;
  }

  function clientWith(auth) {
    const client = createClient(baseUrl, {
      autoConnect: false,
      reconnection: false,
      timeout: 3000,
      transports: ["websocket"],
      auth
    });
    clients.add(client);
    return client;
  }

  function attemptConnection(client) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Socket.IO authentication attempt timed out"));
      }, 5000);
      function cleanup() {
        clearTimeout(timer);
        client.off("connect", onConnect);
        client.off("connect_error", onError);
      }
      function onConnect() {
        cleanup();
        resolve({ connected: true });
      }
      function onError(error) {
        cleanup();
        resolve({ connected: false, error });
      }
      client.once("connect", onConnect);
      client.once("connect_error", onError);
      client.connect();
    });
  }

  function assertRejected(result, code) {
    assert.equal(result.connected, false);
    assert.equal(result.error.message, code === "AUTH_EXPIRED"
      ? "Authentication token expired"
      : "Invalid authentication token");
    assert.deepEqual(result.error.data, { code, retryable: false });
  }

  const registered = await registerUser("active");

  await t.test("accepts a REST-issued token and derives minimal identity from MongoDB", async () => {
    const spoofedId = new mongoose.Types.ObjectId().toString();
    const client = clientWith({
      token: registered.token,
      user: { id: spoofedId, email: "spoofed@example.test", role: "admin" },
      userId: spoofedId
    });
    const result = await attemptConnection(client);
    assert.equal(result.connected, true);
    const serverSocket = io.of("/").sockets.get(client.id);
    assert.ok(serverSocket);
    assert.deepEqual(serverSocket.data.user, { id: registered.user.id });
    assert.deepEqual(serverSocket.data.auth, { expiresAt: jwt.decode(registered.token).exp * 1000 });
    assert.equal(serverSocket.data.user.password, undefined);
    assert.equal(serverSocket.data.user.email, undefined);
    client.disconnect();
  });

  await t.test("rejects a deleted MongoDB user despite a correctly signed unexpired token", async () => {
    const deleted = await registerUser("deleted");
    const deletion = await User.deleteOne({ _id: deleted.user.id });
    assert.equal(deletion.deletedCount, 1);
    assertRejected(await attemptConnection(clientWith({ token: deleted.token })), "AUTH_INVALID");
  });

  await t.test("rejects a valid ObjectId for a user that does not exist", async () => {
    const token = generateToken(new mongoose.Types.ObjectId().toString());
    assertRejected(await attemptConnection(clientWith({ token })), "AUTH_INVALID");
  });

  await t.test("rejects a wrong signature and an expired token without leaking JWT details", async () => {
    const wrongSignature = jwt.sign({ id: registered.user.id }, randomBytes(32).toString("hex"), {
      expiresIn: "5m"
    });
    assertRejected(await attemptConnection(clientWith({ token: wrongSignature })), "AUTH_INVALID");
    const expired = jwt.sign({ id: registered.user.id }, process.env.JWT_SECRET, { expiresIn: -1 });
    assertRejected(await attemptConnection(clientWith({ token: expired })), "AUTH_EXPIRED");
  });

  await t.test("expires an active connection, rejects its old credentials, and accepts a fresh token", async () => {
    const token = jwt.sign({ id: registered.user.id }, process.env.JWT_SECRET, { expiresIn: 2 });
    const client = clientWith({ token });
    let expiryPayload;
    client.once("auth:error", (payload) => { expiryPayload = payload; });
    assert.equal((await attemptConnection(client)).connected, true);
    const socketId = client.id;
    const disconnected = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        client.off("disconnect", onDisconnect);
        reject(new Error("Authenticated socket did not disconnect at JWT expiry"));
      }, 5000);
      function onDisconnect(reason) {
        clearTimeout(timer);
        resolve(reason);
      }
      client.once("disconnect", onDisconnect);
    });
    assert.equal(disconnected, "io server disconnect");
    assert.deepEqual(expiryPayload, {
      code: "AUTH_EXPIRED",
      retryable: false,
      message: "Authentication token expired"
    });
    assert.equal(client.connected, false);
    assert.equal(io.of("/").sockets.has(socketId), false);

    assertRejected(await attemptConnection(client), "AUTH_EXPIRED");
    client.auth = { token: generateToken(registered.user.id) };
    assert.equal((await attemptConnection(client)).connected, true);
    assert.deepEqual(io.of("/").sockets.get(client.id).data.user, { id: registered.user.id });
    client.disconnect();
  });
});
