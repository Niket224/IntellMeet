const assert = require("node:assert/strict");
const http = require("node:http");
const { test } = require("node:test");
const { io: createClient } = require("socket.io-client");
const initializeSocket = require("../src/socket");
const User = require("../src/models/User");
const generateToken = require("../src/utils/generateToken");

const firstOrigin = "https://first.example.test";
const secondOrigin = "https://second.example.test";
const pollingPath = "/socket.io/?EIO=4&transport=polling";

function setClientUrl(t, value) {
  const previous = process.env.CLIENT_URL;
  if (value === undefined) delete process.env.CLIENT_URL;
  else process.env.CLIENT_URL = value;
  t.after(() => {
    if (previous === undefined) delete process.env.CLIENT_URL;
    else process.env.CLIENT_URL = previous;
  });
}

async function startServer(t, app) {
  const server = http.createServer(app);
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
  return { server, io, url: `http://127.0.0.1:${server.address().port}` };
}

async function connectClient(t, url, transport) {
  const client = createClient(url, {
    autoConnect: false,
    reconnection: false,
    timeout: 2000,
    transports: [transport],
    auth: { token: generateToken("507f1f77bcf86cd799439011") }
  });
  t.after(() => client.disconnect());
  await new Promise((resolve, reject) => {
    client.once("connect", resolve);
    client.once("connect_error", reject);
    client.connect();
  });
  return client;
}

test("Socket.IO initialization", { timeout: 30000 }, async (t) => {
  setClientUrl(t, ` ${firstOrigin}, ${secondOrigin} `);
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "initialization-suite-only-secret";
  t.after(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });
  t.mock.method(User, "findById", (id) => ({
    select() { return this; },
    async lean() { return { _id: id }; }
  }));
  const app = require("../src/app");

  await t.test("attaches to the supplied HTTP server without starting a listener", async () => {
    const server = http.createServer(app);
    const io = initializeSocket(server);
    try {
      assert.equal(io.httpServer, server);
      assert.equal(server.listening, false);
    } finally {
      await new Promise((resolve) => io.close(resolve));
    }
  });

  await t.test("serves Express routes and the Engine.IO handshake on the same port", async (t) => {
    const { url } = await startServer(t, app);
    const health = await fetch(`${url}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok", service: "intellimeet-backend" });
    const root = await fetch(url);
    assert.equal(root.status, 200);
    assert.deepEqual(await root.json(), { message: "IntelliMeet API is running" });
    const handshake = await fetch(`${url}${pollingPath}`);
    assert.equal(handshake.status, 200);
    const packet = await handshake.text();
    assert.equal(packet[0], "0");
    assert.equal(typeof JSON.parse(packet.slice(1)).sid, "string");
    const missing = await fetch(`${url}/api/missing`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { message: "Route not found: GET /api/missing" });
  });

  await t.test("accepts a real polling client and logs connection and disconnection", async (t) => {
    const messages = [];
    t.mock.method(console, "log", (message) => messages.push(message));
    const { io, url } = await startServer(t, app);
    const connected = new Promise((resolve) => io.once("connection", resolve));
    const client = await connectClient(t, url, "polling");
    const serverSocket = await connected;
    assert.equal(serverSocket.id, client.id);
    assert.ok(messages.includes(`Socket.IO connected: ${serverSocket.id}`));
    const disconnected = new Promise((resolve) => serverSocket.once("disconnect", resolve));
    client.disconnect();
    const reason = await disconnected;
    assert.equal(reason, "client namespace disconnect");
    assert.ok(messages.includes(`Socket.IO disconnected: ${serverSocket.id} (${reason})`));
    assert.equal(io.of("/").sockets.size, 0);
  });

  await t.test("accepts a real WebSocket client on the same server", async (t) => {
    const { url } = await startServer(t, app);
    const client = await connectClient(t, url, "websocket");
    assert.equal(client.connected, true);
    assert.equal(client.io.engine.transport.name, "websocket");
  });

  await t.test("shares trimmed configured origins and credentials across REST and Socket.IO", async (t) => {
    const { url } = await startServer(t, app);
    for (const origin of [firstOrigin, secondOrigin]) {
      for (const path of ["/api/health", pollingPath]) {
        const response = await fetch(`${url}${path}`, { headers: { Origin: origin } });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("access-control-allow-origin"), origin);
        assert.equal(response.headers.get("access-control-allow-credentials"), "true");
        await response.text();
      }
    }
  });

  await t.test("preserves requests without an Origin header", async (t) => {
    const { url } = await startServer(t, app);
    for (const path of ["/api/health", pollingPath]) {
      const response = await fetch(`${url}${path}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("access-control-allow-origin"), null);
      await response.text();
    }
  });

  await t.test("rejects unconfigured origins without granting CORS access", async (t) => {
    const { url } = await startServer(t, app);
    const headers = { Origin: "https://untrusted.example.test" };
    const rest = await fetch(`${url}/api/health`, { headers });
    // Preserve the existing Express error-handler status for CORS errors.
    assert.equal(rest.status, 500);
    assert.equal((await rest.json()).message, "Origin not allowed by CORS");
    assert.equal(rest.headers.get("access-control-allow-origin"), null);
    const socket = await fetch(`${url}${pollingPath}`, { headers });
    assert.equal(socket.status, 400);
    assert.equal(socket.headers.get("access-control-allow-origin"), null);
    await socket.text();
  });

  await t.test("answers preflight requests consistently for both transports", async (t) => {
    const { url } = await startServer(t, app);
    for (const path of ["/api/health", pollingPath]) {
      const response = await fetch(`${url}${path}`, {
        method: "OPTIONS",
        headers: {
          Origin: firstOrigin,
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "authorization"
        }
      });
      assert.equal(response.status, 204);
      assert.equal(response.headers.get("access-control-allow-origin"), firstOrigin);
      assert.equal(response.headers.get("access-control-allow-credentials"), "true");
      assert.match(response.headers.get("access-control-allow-methods"), /GET/);
      assert.equal(response.headers.get("access-control-allow-headers"), "authorization");
    }
  });

  await t.test("retains REST JWT rejection after attaching Socket.IO", async (t) => {
    const { url } = await startServer(t, app);
    const missing = await fetch(`${url}/api/users/me`);
    assert.equal(missing.status, 401);
    assert.deepEqual(await missing.json(), { message: "Authentication required" });
    const invalid = await fetch(`${url}/api/users/me`, {
      headers: { Authorization: "Bearer invalid-token" }
    });
    assert.equal(invalid.status, 401);
    assert.deepEqual(await invalid.json(), { message: "Invalid or expired token" });
  });

  await t.test("uses the localhost fallback when CLIENT_URL is unset", async (t) => {
    setClientUrl(t, undefined);
    const { url } = await startServer(t, app);
    const response = await fetch(`${url}${pollingPath}`, {
      headers: { Origin: "http://localhost:5173" }
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:5173");
    await response.text();
  });

  await t.test("uses the localhost fallback when CLIENT_URL is empty", async (t) => {
    setClientUrl(t, "");
    const { url } = await startServer(t, app);
    const response = await fetch(`${url}${pollingPath}`, {
      headers: { Origin: "http://localhost:5173" }
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:5173");
    await response.text();
  });
});
