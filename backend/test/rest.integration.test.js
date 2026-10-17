const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const http = require("node:http");
const test = require("node:test");
const mongoose = require("mongoose");

const testUri = process.env.TEST_MONGODB_URI;
const testDatabasePattern = /^intellimeet_phase2_test_[A-Za-z0-9_]+$/;

test("existing REST APIs with Socket.IO attached and a real MongoDB connection", {
  skip: !testUri && "Set TEST_MONGODB_URI to a dedicated intellimeet_phase2_test_<suffix> database",
  timeout: 60000
}, async (t) => {
  const parsedUri = new URL(testUri);
  assert.match(parsedUri.protocol, /^mongodb(?:\+srv)?:$/);
  const databaseName = decodeURIComponent(parsedUri.pathname.slice(1));

  // This suite drops its database. Refuse ordinary application database names.
  assert.match(databaseName, testDatabasePattern,
    "TEST_MONGODB_URI must name a dedicated intellimeet_phase2_test_<suffix> database");

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

  t.after(async () => {
    try {
      if (io) {
        await new Promise((resolve) => io.close(resolve));
      } else if (server && server.listening) {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    } finally {
      try {
        if (connected) {
          // Check the actual connected database again immediately before cleanup.
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

  async function request(method, path, { token, body } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000)
    });
    return { status: response.status, body: await response.json() };
  }

  async function registerUser(label) {
    const credentials = {
      name: `Phase 2 ${label}`,
      email: `${label}-${randomBytes(8).toString("hex")}@example.test`,
      password: "phase2-test-password"
    };
    const result = await request("POST", "/api/auth/register", { body: credentials });
    assert.equal(result.status, 201);
    assert.equal(result.body.user.email, credentials.email);
    assert.equal(typeof result.body.token, "string");
    assert.equal(result.body.user.password, undefined);
    return { ...result.body, credentials };
  }

  await t.test("health and root remain available on the shared HTTP server", async () => {
    const health = await request("GET", "/api/health");
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { status: "ok", service: "intellimeet-backend" });
    const root = await request("GET", "/");
    assert.equal(root.status, 200);
    assert.deepEqual(root.body, { message: "IntelliMeet API is running" });
  });

  await t.test("registration and password-verified login still issue working JWTs", async () => {
    const registered = await registerUser("login");
    const login = await request("POST", "/api/auth/login", {
      body: { email: registered.credentials.email, password: registered.credentials.password }
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.id, registered.user.id);
    const profile = await request("GET", "/api/users/me", { token: login.body.token });
    assert.equal(profile.status, 200);
    assert.equal(profile.body.user.id, registered.user.id);
    const invalidPassword = await request("POST", "/api/auth/login", {
      body: { email: registered.credentials.email, password: "incorrect-password" }
    });
    assert.equal(invalidPassword.status, 401);
    assert.equal(invalidPassword.body.message, "Invalid email or password");
  });

  await t.test("protected REST routes continue rejecting missing and invalid JWTs", async () => {
    const missing = await request("GET", "/api/users/me");
    assert.equal(missing.status, 401);
    assert.equal(missing.body.message, "Authentication required");
    const invalid = await request("GET", "/api/users/me", { token: "invalid-token" });
    assert.equal(invalid.status, 401);
    assert.equal(invalid.body.message, "Invalid or expired token");
  });

  await t.test("authenticated profile updates persist through MongoDB", async () => {
    const user = await registerUser("profile");
    const update = await request("PATCH", "/api/users/me", {
      token: user.token,
      body: { name: "Updated Phase 2 Name", jobTitle: "Developer" }
    });
    assert.equal(update.status, 200);
    const profile = await request("GET", "/api/users/me", { token: user.token });
    assert.equal(profile.status, 200);
    assert.equal(profile.body.user.name, "Updated Phase 2 Name");
    assert.equal(profile.body.user.jobTitle, "Developer");
  });

  await t.test("workspace creation, retrieval, and listing still use persisted membership", async () => {
    const user = await registerUser("workspace");
    const created = await request("POST", "/api/workspaces", {
      token: user.token,
      body: { name: "Phase 2 Workspace" }
    });
    assert.equal(created.status, 201);
    const workspaceId = created.body.workspace._id;
    assert.equal(created.body.workspace.owner._id, user.user.id);
    assert.equal(created.body.workspace.members[0]._id, user.user.id);
    const retrieved = await request("GET", `/api/workspaces/${workspaceId}`, { token: user.token });
    assert.equal(retrieved.status, 200);
    assert.equal(retrieved.body.workspace._id, workspaceId);
    const listed = await request("GET", "/api/workspaces", { token: user.token });
    assert.equal(listed.status, 200);
    assert.ok(listed.body.workspaces.some((workspace) => workspace._id === workspaceId));
  });

  await t.test("meeting creation, joining, authorization, and host-ended lifecycle remain unchanged", async () => {
    const host = await registerUser("host");
    const participant = await registerUser("participant");
    const created = await request("POST", "/api/meetings", {
      token: host.token,
      body: { title: "Phase 2 Meeting" }
    });
    assert.equal(created.status, 201);
    const meetingId = created.body.meeting._id;
    assert.equal(created.body.meeting.status, "scheduled");
    assert.equal(created.body.meeting.host._id, host.user.id);
    const retrieved = await request("GET", `/api/meetings/${meetingId}`, { token: host.token });
    assert.equal(retrieved.status, 200);
    assert.equal(retrieved.body.meeting._id, meetingId);
    const listed = await request("GET", "/api/meetings", { token: host.token });
    assert.equal(listed.status, 200);
    assert.ok(listed.body.meetings.some((meeting) => meeting._id === meetingId));

    const joined = await request("POST", `/api/meetings/${meetingId}/join`, { token: participant.token });
    assert.equal(joined.status, 200);
    assert.equal(joined.body.meeting.status, "live");
    assert.ok(joined.body.meeting.startedAt);
    assert.ok(joined.body.meeting.participants.some((user) => user._id === participant.user.id));
    const unauthorizedEnd = await request("PATCH", `/api/meetings/${meetingId}/end`, { token: participant.token });
    assert.equal(unauthorizedEnd.status, 404);
    const ended = await request("PATCH", `/api/meetings/${meetingId}/end`, { token: host.token });
    assert.equal(ended.status, 200);
    assert.equal(ended.body.meeting.status, "ended");
    assert.ok(ended.body.meeting.endedAt);
    const endedJoin = await request("POST", `/api/meetings/${meetingId}/join`, { token: participant.token });
    assert.equal(endedJoin.status, 400);
    assert.equal(endedJoin.body.message, "This meeting has already ended");
  });

  await t.test("action item creation, listing, and updates still persist", async () => {
    const user = await registerUser("action-item");
    const created = await request("POST", "/api/action-items", {
      token: user.token,
      body: { title: "Verify Phase 2", priority: "high" }
    });
    assert.equal(created.status, 201);
    const actionItemId = created.body.actionItem._id;
    assert.equal(created.body.actionItem.createdBy._id, user.user.id);
    assert.equal(created.body.actionItem.priority, "high");
    const listed = await request("GET", "/api/action-items", { token: user.token });
    assert.equal(listed.status, 200);
    assert.ok(listed.body.actionItems.some((item) => item._id === actionItemId));
    const updated = await request("PATCH", `/api/action-items/${actionItemId}`, {
      token: user.token,
      body: { status: "completed" }
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.actionItem.status, "completed");
    const refreshed = await request("GET", "/api/action-items", { token: user.token });
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.body.actionItems.find((item) => item._id === actionItemId).status, "completed");
  });
});
