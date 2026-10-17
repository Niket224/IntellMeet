const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const http = require("node:http");
const { test } = require("node:test");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { io: createClient } = require("socket.io-client");

const testUri = process.env.TEST_MONGODB_URI;
const databasePattern = /^intellimeet_phase4_test_[A-Za-z0-9_]+$/;

function waitFor(socket, event, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for ${event}`));
    }, 5000);
    function handler(value) {
      if (!predicate(value)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(value);
    }
    socket.on(event, handler);
  });
}

const event = (client, name, meetingId) => client.timeout(4000).emitWithAck(name, { meetingId });

function rejected(result, code) {
  assert.equal(result.ok, false);
  assert.equal(result.error.code, code);
  assert.equal(result.error.retryable, false);
}

test("meeting rooms with REST enrollment and real MongoDB authorization", {
  skip: !testUri && "Set TEST_MONGODB_URI to a dedicated intellimeet_phase4_test_<suffix> database",
  timeout: 60000
}, async (t) => {
  const parsed = new URL(testUri);
  assert.match(parsed.protocol, /^mongodb(?:\+srv)?:$/);
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  assert.match(databaseName, databasePattern);
  const previous = Object.fromEntries(["MONGODB_URI", "JWT_SECRET", "JWT_EXPIRES_IN", "NODE_ENV"]
    .map((key) => [key, process.env[key]]));
  process.env.MONGODB_URI = testUri;
  process.env.JWT_SECRET = randomBytes(32).toString("hex");
  process.env.JWT_EXPIRES_IN = "5m";
  process.env.NODE_ENV = "test";
  t.mock.method(console, "log", () => {});

  let io;
  let server;
  let connected = false;
  const clients = new Set();
  t.after(async () => {
    try {
      for (const client of clients) client.disconnect();
      if (io) {
        const closed = new Promise((resolve) => io.close(resolve));
        server.closeAllConnections();
        await closed;
      } else if (server?.listening) {
        await new Promise((resolve) => server.close(resolve));
      }
    } finally {
      try {
        if (connected) {
          assert.equal(mongoose.connection.name, databaseName);
          assert.match(mongoose.connection.name, databasePattern);
          await mongoose.connection.dropDatabase();
        }
      } finally {
        await mongoose.disconnect();
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    }
  });

  const connectDB = require("../src/config/db");
  const Meeting = require("../src/models/Meeting");
  const Workspace = require("../src/models/Workspace");
  const User = require("../src/models/User");
  const initializeSocket = require("../src/socket");
  const app = require("../src/app");
  await connectDB();
  connected = true;
  assert.equal(mongoose.connection.name, databaseName);
  server = http.createServer(app);
  io = initializeSocket(server);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}`;

  async function rest(method, path, user, body) {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: {
        ...(user ? { Authorization: `Bearer ${user.token}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000)
    });
    return { status: response.status, body: await response.json() };
  }

  async function register(label) {
    const result = await rest("POST", "/api/auth/register", null, {
      name: label,
      email: `${label}-${randomBytes(8).toString("hex")}@example.test`,
      password: "phase4-test-password"
    });
    assert.equal(result.status, 201);
    return { id: result.body.user.id, token: result.body.token };
  }

  const host = await register("host");
  const member = await register("member");
  const outsider = await register("outsider");

  async function createMeeting(workspace = null) {
    const created = await rest("POST", "/api/meetings", host, { title: "Phase 4 test", workspace });
    assert.equal(created.status, 201);
    return created.body.meeting._id;
  }

  async function enroll(user, meetingId) {
    const joined = await rest("POST", `/api/meetings/${meetingId}/join`, user);
    assert.equal(joined.status, 200);
    assert.equal(joined.body.meeting.status, "live");
  }

  async function connect(t, user, token = user.token) {
    const client = createClient(url, {
      autoConnect: false, reconnection: false, timeout: 2000,
      transports: ["websocket"], auth: { token }
    });
    clients.add(client);
    t.after(() => client.disconnect());
    await new Promise((resolve, reject) => {
      client.once("connect", resolve);
      client.once("connect_error", reject);
      client.connect();
    });
    return client;
  }

  async function workspaceMeeting() {
    const created = await rest("POST", "/api/workspaces", host, { name: "Phase 4 workspace" });
    assert.equal(created.status, 201);
    const workspace = created.body.workspace._id;
    // Fixture membership only: the current REST API has no add/remove-member route.
    await Workspace.updateOne({ _id: workspace }, { $addToSet: { members: member.id } });
    const meetingId = await createMeeting(workspace);
    await enroll(host, meetingId);
    await enroll(member, meetingId);
    return { workspace, meetingId };
  }

  await t.test("rejects an unauthenticated transport before room handlers are admitted", async (t) => {
    const client = createClient(url, {
      autoConnect: false, reconnection: false, timeout: 2000, transports: ["websocket"]
    });
    clients.add(client);
    t.after(() => client.disconnect());
    const failed = waitFor(client, "connect_error");
    client.connect();
    assert.equal((await failed).data.code, "AUTH_REQUIRED");
    assert.equal(client.connected, false);
  });

  await t.test("requires REST enrollment and preserves prototype non-workspace admission", async (t) => {
    const meetingId = await createMeeting();
    await enroll(host, meetingId);
    const client = await connect(t, outsider);
    rejected(await event(client, "meeting:join", meetingId), "MEETING_ENROLLMENT_REQUIRED");
    await enroll(outsider, meetingId);
    const before = await Meeting.findById(meetingId).lean();
    assert.equal((await event(client, "meeting:join", meetingId)).ok, true);
    assert.equal((await event(client, "meeting:leave", meetingId)).data.left, true);
    const after = await Meeting.findById(meetingId).lean();
    assert.deepEqual(after.participants, before.participants);
    assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime());
  });

  await t.test("requires REST to activate a scheduled meeting", async (t) => {
    const meetingId = await createMeeting();
    const client = await connect(t, host);
    rejected(await event(client, "meeting:join", meetingId), "MEETING_NOT_LIVE");
    assert.equal((await Meeting.findById(meetingId)).status, "scheduled");
    await enroll(host, meetingId);
    assert.equal((await event(client, "meeting:join", meetingId)).ok, true);
  });

  await t.test("returns a deduplicated roster of authenticated users and socket IDs", async (t) => {
    const meetingId = await createMeeting();
    await enroll(host, meetingId);
    await enroll(member, meetingId);
    const first = await connect(t, host);
    const second = await connect(t, member);
    await event(first, "meeting:join", meetingId);
    const result = await event(second, "meeting:join", meetingId);
    assert.equal(result.data.participants.length, 2);
    assert.deepEqual(result.data.participants.find((user) => user.userId === host.id).socketIds, [first.id]);
    assert.deepEqual(result.data.participants.find((user) => user.userId === member.id).socketIds, [second.id]);
    assert.equal(result.data.socketId, second.id);
  });

  await t.test("keeps a multi-tab user present until their final socket disconnects", async (t) => {
    const meetingId = await createMeeting();
    await enroll(host, meetingId);
    await enroll(member, meetingId);
    const observer = await connect(t, host);
    const first = await connect(t, member);
    const second = await connect(t, member);
    await event(observer, "meeting:join", meetingId);
    await event(first, "meeting:join", meetingId);
    const result = await event(second, "meeting:join", meetingId);
    assert.equal(result.data.participants.length, 2);
    assert.equal(result.data.participants.find((user) => user.userId === member.id).socketIds.length, 2);
    await event(first, "meeting:leave", meetingId);
    const roster = await event(observer, "meeting:roster", meetingId);
    assert.deepEqual(roster.data.participants.find((user) => user.userId === member.id).socketIds, [second.id]);
    const update = waitFor(observer, "meeting:participants", (data) => data.participants.length === 1);
    second.disconnect();
    await update;
    assert.ok((await Meeting.findById(meetingId)).participants.some((id) => String(id) === member.id));
  });

  await t.test("never broadcasts a roster into a different meeting", async (t) => {
    const firstId = await createMeeting();
    const secondId = await createMeeting();
    await enroll(host, firstId);
    await enroll(host, secondId);
    await enroll(member, firstId);
    const first = await connect(t, host);
    const second = await connect(t, host);
    const joining = await connect(t, member);
    await event(first, "meeting:join", firstId);
    await event(second, "meeting:join", secondId);
    const updates = [];
    second.on("meeting:participants", (roster) => updates.push(roster));
    const changed = waitFor(first, "meeting:participants", (data) => data.participants.length === 2);
    await event(joining, "meeting:join", firstId);
    await changed;
    assert.equal((await event(second, "meeting:roster", secondId)).data.participants.length, 1);
    assert.deepEqual(updates, []);
    rejected(await event(second, "meeting:roster", firstId), "MEETING_NOT_JOINED");
  });

  await t.test("enforces current workspace membership despite persisted enrollment", async (t) => {
    const { workspace, meetingId } = await workspaceMeeting();
    await Workspace.updateOne({ _id: workspace }, { $pull: { members: member.id } });
    const client = await connect(t, member);
    rejected(await event(client, "meeting:join", meetingId), "MEETING_FORBIDDEN");
    assert.ok((await Meeting.findById(meetingId)).participants.some((id) => String(id) === member.id));
    await Workspace.updateOne({ _id: workspace }, { $pull: { members: host.id } });
    const hostClient = await connect(t, host);
    assert.equal((await event(hostClient, "meeting:join", meetingId)).ok, true);
  });

  await t.test("evicts the requesting socket when a roster refresh discovers revocation", async (t) => {
    const { workspace, meetingId } = await workspaceMeeting();
    const observer = await connect(t, host);
    const client = await connect(t, member);
    await event(observer, "meeting:join", meetingId);
    await event(client, "meeting:join", meetingId);
    await Workspace.updateOne({ _id: workspace }, { $pull: { members: member.id } });
    const update = waitFor(observer, "meeting:participants", (data) => data.participants.length === 1);
    rejected(await event(client, "meeting:roster", meetingId), "MEETING_FORBIDDEN");
    await update;
    assert.equal(io.of("/").adapter.rooms.get(`meeting:${meetingId}`).has(client.id), false);
  });

  await t.test("checks REST-ended state on subsequent join and roster requests", async (t) => {
    const meetingId = await createMeeting();
    await enroll(host, meetingId);
    await enroll(member, meetingId);
    const hostClient = await connect(t, host);
    const memberClient = await connect(t, member);
    await event(hostClient, "meeting:join", meetingId);
    assert.equal((await rest("PATCH", `/api/meetings/${meetingId}/end`, host)).status, 200);
    rejected(await event(memberClient, "meeting:join", meetingId), "MEETING_ENDED");
    rejected(await event(hostClient, "meeting:roster", meetingId), "MEETING_ENDED");
    assert.equal(io.of("/").adapter.rooms.has(`meeting:${meetingId}`), false);
  });

  await t.test("makes duplicate joins idempotent and requires leave before switching meetings", async (t) => {
    const firstId = await createMeeting();
    const secondId = await createMeeting();
    await enroll(host, firstId);
    await enroll(host, secondId);
    const client = await connect(t, host);
    const joined = await event(client, "meeting:join", firstId);
    const duplicate = await event(client, "meeting:join", firstId);
    assert.equal(duplicate.data.joined, false);
    assert.equal(duplicate.data.revision, joined.data.revision);
    rejected(await event(client, "meeting:join", secondId), "MEETING_CONFLICT");
    await event(client, "meeting:leave", firstId);
    assert.equal((await event(client, "meeting:join", secondId)).ok, true);
  });

  await t.test("rejects invalid meeting IDs and identity-bearing payloads", async (t) => {
    const client = await connect(t, host);
    rejected(await event(client, "meeting:join", "not-an-id"), "INVALID_MEETING_ID");
    rejected(await client.timeout(4000).emitWithAck("meeting:join", {
      meetingId: new mongoose.Types.ObjectId().toString(), userId: member.id
    }), "INVALID_REQUEST");
    rejected(await event(client, "meeting:join", new mongoose.Types.ObjectId().toString()), "MEETING_NOT_FOUND");
  });

  await t.test("requires explicit rejoin after authenticated reconnection and drops the old peer ID", async (t) => {
    const meetingId = await createMeeting();
    await enroll(host, meetingId);
    const client = await connect(t, host);
    await event(client, "meeting:join", meetingId);
    const oldId = client.id;
    const oldSocket = io.of("/").sockets.get(oldId);
    const removed = waitFor(oldSocket, "disconnect");
    client.disconnect();
    await removed;
    const connectedAgain = waitFor(client, "connect");
    client.connect();
    await connectedAgain;
    assert.notEqual(client.id, oldId);
    rejected(await event(client, "meeting:roster", meetingId), "MEETING_NOT_JOINED");
    const joined = await event(client, "meeting:join", meetingId);
    assert.deepEqual(joined.data.participants, [{ userId: host.id, socketIds: [client.id] }]);
  });

  await t.test("rechecks account existence before joining with a previously authenticated socket", async (t) => {
    const temporary = await register("temporary");
    const meetingId = await createMeeting();
    await enroll(temporary, meetingId);
    const client = await connect(t, temporary);
    await User.deleteOne({ _id: temporary.id });
    rejected(await event(client, "meeting:join", meetingId), "AUTH_INVALID");
  });

  await t.test("active JWT expiry removes the expired socket from the real meeting roster", async (t) => {
    const meetingId = await createMeeting();
    await enroll(host, meetingId);
    await enroll(member, meetingId);
    const observer = await connect(t, host);
    await event(observer, "meeting:join", meetingId);
    const token = jwt.sign({ id: member.id }, process.env.JWT_SECRET, { expiresIn: 2 });
    const client = await connect(t, member, token);
    await event(client, "meeting:join", meetingId);
    const socketId = client.id;
    const update = waitFor(observer, "meeting:participants", (data) => data.participants.length === 1);
    assert.equal(await waitFor(client, "disconnect"), "io server disconnect");
    assert.deepEqual((await update).participants, [{ userId: host.id, socketIds: [observer.id] }]);
    assert.equal(io.of("/").adapter.rooms.get(`meeting:${meetingId}`).has(socketId), false);
  });
});
