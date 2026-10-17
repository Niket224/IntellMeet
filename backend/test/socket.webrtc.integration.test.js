const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const http = require("node:http");
const { performance } = require("node:perf_hooks");
const { test } = require("node:test");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { io: createClient } = require("socket.io-client");

const testUri = process.env.TEST_MONGODB_URI;
const databasePattern = /^intellimeet_phase6_test_[A-Za-z0-9_]+$/;
const event = (client, name, meetingId) => client.timeout(5000).emitWithAck(name, { meetingId });
function signal(client, meetingId, targetSocketId, type = "offer", overrides = {}) {
  return client.timeout(5000).emitWithAck(`webrtc:${type}`, {
    meetingId, targetSocketId, negotiationId: "real-negotiation",
    ...(type === "ice-candidate"
      ? { candidate: { candidate: "candidate:1 1 UDP 2122260223 192.0.2.1 5000 typ host", sdpMid: "0", sdpMLineIndex: 0 } }
      : { description: { type, sdp: "v=0\r\ns=real-db-fixture\r\n" } }), ...overrides
  });
}
function rejected(result, code, retryable = false) {
  assert.equal(result.ok, false);
  assert.equal(result.error.code, code);
  assert.equal(result.error.retryable, retryable);
}
function waitFor(socket, name) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, handler); reject(new Error(`Timed out waiting for ${name}`)); }, 5000);
    function handler(value) { clearTimeout(timer); socket.off(name, handler); resolve(value); }
    socket.once(name, handler);
  });
}

test("WebRTC signaling with REST-issued JWTs and real meeting authorization", {
  skip: !testUri && "Set TEST_MONGODB_URI to a dedicated intellimeet_phase6_test_<suffix> database",
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
  let connected = false;
  t.after(async () => {
    try {
      if (connected) {
        assert.equal(mongoose.connection.name, databaseName);
        assert.match(mongoose.connection.name, databasePattern);
        await mongoose.connection.dropDatabase();
      }
    } finally {
      await mongoose.disconnect();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
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

  async function setup(t) {
    const server = http.createServer(app);
    const io = initializeSocket(server);
    const clients = new Set();
    t.after(async () => {
      for (const client of clients) client.disconnect();
      const closed = new Promise((resolve) => io.close(resolve));
      server.closeAllConnections();
      await closed;
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const url = `http://127.0.0.1:${server.address().port}`;
    async function rest(method, path, user, body) {
      const response = await fetch(`${url}${path}`, {
        method, headers: {
          ...(user ? { Authorization: `Bearer ${user.token}` } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000)
      });
      return { status: response.status, body: await response.json() };
    }
    async function register(name) {
      const result = await rest("POST", "/api/auth/register", null, {
        name, email: `${name}-${randomBytes(8).toString("hex")}@example.test`, password: "phase6-test-password"
      });
      assert.equal(result.status, 201);
      return { id: result.body.user.id, token: result.body.token };
    }
    const host = await register("host");
    const member = await register("member");
    async function createMeeting(workspace = null) {
      const result = await rest("POST", "/api/meetings", host, { title: "Signaling integration", workspace });
      assert.equal(result.status, 201);
      return result.body.meeting._id;
    }
    async function enroll(user, meetingId) {
      assert.equal((await rest("POST", `/api/meetings/${meetingId}/join`, user)).status, 200);
    }
    async function connect(user, { token = user.token, transport = "websocket" } = {}) {
      const client = createClient(url, {
        autoConnect: false, reconnection: false, timeout: 2000, transports: [transport], auth: { token }
      });
      clients.add(client);
      await new Promise((resolve, reject) => {
        client.once("connect", resolve); client.once("connect_error", reject); client.connect();
      });
      return client;
    }
    async function pair(transport = "websocket") {
      const meetingId = await createMeeting();
      await enroll(host, meetingId);
      await enroll(member, meetingId);
      const sender = await connect(host);
      const target = await connect(member, { transport });
      assert.equal((await event(sender, "meeting:join", meetingId)).ok, true);
      assert.equal((await event(target, "meeting:join", meetingId)).ok, true);
      return { sender, target, meetingId };
    }
    return { io, rest, host, member, createMeeting, enroll, connect, pair };
  }

  await t.test("forwards all three events across WebSocket and polling without DB writes", async (t) => {
    const { pair, host } = await setup(t);
    const { sender, target, meetingId } = await pair("polling");
    const before = await Meeting.findById(meetingId).lean();
    const collections = (await mongoose.connection.db.listCollections().toArray()).map((value) => value.name).sort();
    for (const type of ["offer", "answer", "ice-candidate"]) {
      const received = waitFor(target, `webrtc:${type}`);
      const result = await signal(sender, meetingId, target.id, type);
      assert.deepEqual(result.data, { forwarded: true, meetingId, targetSocketId: target.id, negotiationId: "real-negotiation" });
      assert.deepEqual((await received).sender, { userId: host.id, socketId: sender.id });
    }
    const after = await Meeting.findById(meetingId).lean();
    assert.deepEqual(after, before);
    assert.deepEqual((await mongoose.connection.db.listCollections().toArray()).map((value) => value.name).sort(), collections);
  });

  await t.test("requires prior REST enrollment and active socket room membership", async (t) => {
    const { host, member, createMeeting, enroll, connect } = await setup(t);
    const meetingId = await createMeeting();
    await enroll(host, meetingId);
    const sender = await connect(host);
    const target = await connect(member);
    await event(sender, "meeting:join", meetingId);
    rejected(await signal(sender, meetingId, target.id), "WEBRTC_TARGET_UNAVAILABLE");
    rejected(await event(target, "meeting:join", meetingId), "MEETING_ENROLLMENT_REQUIRED");
    await enroll(member, meetingId);
    rejected(await signal(sender, meetingId, target.id), "WEBRTC_TARGET_UNAVAILABLE");
    await event(target, "meeting:join", meetingId);
    assert.equal((await signal(sender, meetingId, target.id)).ok, true);
    await Meeting.updateOne({ _id: meetingId }, { $pull: { participants: member.id } });
    rejected(await signal(sender, meetingId, target.id), "WEBRTC_TARGET_UNAVAILABLE");
  });

  await t.test("isolates cross-room targets and other tabs of the target user", async (t) => {
    const { pair, connect, member, host, createMeeting, enroll } = await setup(t);
    const { sender, target, meetingId } = await pair();
    const tab = await connect(member);
    const outsider = await connect(host);
    await event(tab, "meeting:join", meetingId);
    const otherId = await createMeeting();
    await enroll(host, otherId);
    await event(outsider, "meeting:join", otherId);
    const leaked = [];
    for (const client of [tab, outsider, sender]) client.on("webrtc:offer", (value) => leaked.push(value));
    const received = waitFor(target, "webrtc:offer");
    assert.equal((await signal(sender, meetingId, target.id)).ok, true);
    await received;
    rejected(await signal(sender, meetingId, outsider.id), "WEBRTC_TARGET_UNAVAILABLE");
    await event(tab, "meeting:roster", meetingId);
    await event(outsider, "meeting:roster", otherId);
    assert.deepEqual(leaked, []);
  });

  await t.test("checks revoked passive target, requesting sender, and actual REST-ended state", async (t) => {
    const { rest, host, member, createMeeting, enroll, connect } = await setup(t);
    const workspace = await rest("POST", "/api/workspaces", host, { name: "Signaling workspace" });
    const workspaceId = workspace.body.workspace._id;
    // Fixture only. Immediate revocation hooks remain pending GitHub Issue #1.
    await Workspace.updateOne({ _id: workspaceId }, { $addToSet: { members: member.id } });
    const meetingId = await createMeeting(workspaceId);
    await enroll(host, meetingId);
    await enroll(member, meetingId);
    const sender = await connect(host);
    const target = await connect(member);
    await event(sender, "meeting:join", meetingId);
    await event(target, "meeting:join", meetingId);
    await Workspace.updateOne({ _id: workspaceId }, { $pull: { members: member.id } });
    rejected(await signal(sender, meetingId, target.id), "WEBRTC_TARGET_UNAVAILABLE");
    rejected(await signal(target, meetingId, sender.id), "MEETING_FORBIDDEN");
    await Workspace.updateOne({ _id: workspaceId }, { $addToSet: { members: member.id } });
    await event(target, "meeting:join", meetingId);
    assert.equal((await rest("PATCH", `/api/meetings/${meetingId}/end`, host)).status, 200);
    rejected(await signal(sender, meetingId, target.id), "MEETING_ENDED");
  });

  await t.test("rejects a deleted target user despite its still-connected socket", async (t) => {
    const { pair, member } = await setup(t);
    const { sender, target, meetingId } = await pair();
    await User.deleteOne({ _id: member.id });
    rejected(await signal(sender, meetingId, target.id), "WEBRTC_TARGET_UNAVAILABLE");
  });

  await t.test("shares description rate limits across real tabs while allowing normal ICE", async (t) => {
    t.mock.method(performance, "now", () => 1000);
    const { pair, host, connect } = await setup(t);
    const { sender, target, meetingId } = await pair();
    const tab = await connect(host);
    await event(tab, "meeting:join", meetingId);
    for (let index = 0; index < 20; index += 1) assert.equal((await signal(sender, meetingId, target.id)).ok, true);
    rejected(await signal(tab, meetingId, target.id, "answer"), "WEBRTC_RATE_LIMITED", true);
    for (let batch = 0; batch < 5; batch += 1) {
      const replies = await Promise.all(Array.from({ length: 12 }, () => signal(tab, meetingId, target.id, "ice-candidate")));
      assert.equal(replies.every((reply) => reply.ok), true);
    }
  });

  await t.test("rejects spoofed and oversized payloads on real authenticated connections", async (t) => {
    const { pair } = await setup(t);
    const { sender, target, meetingId } = await pair();
    rejected(await signal(sender, meetingId, target.id, "offer", { sender: { userId: "fake" } }), "WEBRTC_INVALID_PAYLOAD");
    rejected(await signal(sender, meetingId, target.id, "offer", { description: { type: "offer", sdp: "x".repeat(65537) } }), "WEBRTC_TOO_LARGE");
    rejected(await signal(sender, meetingId, target.id, "ice-candidate", { candidate: { candidate: "x".repeat(4097), sdpMid: "0", sdpMLineIndex: 0 } }), "WEBRTC_TOO_LARGE");
  });

  await t.test("supports simultaneous offers, explicit leave, and fresh peer IDs after reconnect", async (t) => {
    const { pair, io } = await setup(t);
    const { sender, target, meetingId } = await pair();
    const receivedAtSender = waitFor(sender, "webrtc:offer");
    const receivedAtTarget = waitFor(target, "webrtc:offer");
    const replies = await Promise.all([signal(sender, meetingId, target.id), signal(target, meetingId, sender.id)]);
    assert.equal(replies.every((reply) => reply.ok), true);
    await Promise.all([receivedAtSender, receivedAtTarget]);
    await event(sender, "meeting:leave", meetingId);
    rejected(await signal(sender, meetingId, target.id), "MEETING_NOT_JOINED");
    await event(sender, "meeting:join", meetingId);
    const oldId = target.id;
    const closed = waitFor(io.of("/").sockets.get(oldId), "disconnect");
    target.disconnect();
    await closed;
    const reconnected = waitFor(target, "connect");
    target.connect();
    await reconnected;
    rejected(await signal(sender, meetingId, oldId), "WEBRTC_TARGET_UNAVAILABLE");
    rejected(await signal(sender, meetingId, target.id), "WEBRTC_TARGET_UNAVAILABLE");
    await event(target, "meeting:join", meetingId);
    assert.equal((await signal(sender, meetingId, target.id)).ok, true);
  });

  await t.test("rejects expired JWTs and removes an expired peer from signaling authority", async (t) => {
    const { pair, connect, member } = await setup(t);
    const { sender, target, meetingId } = await pair();
    await assert.rejects(connect(member, { token: jwt.sign({ id: member.id }, process.env.JWT_SECRET, { expiresIn: -1 }) }),
      (error) => error.data.code === "AUTH_EXPIRED");
    const short = await connect(member, { token: jwt.sign({ id: member.id }, process.env.JWT_SECRET, { expiresIn: 2 }) });
    await event(short, "meeting:join", meetingId);
    const expiredId = short.id;
    assert.equal((await signal(short, meetingId, target.id)).ok, true);
    assert.equal(await waitFor(short, "disconnect"), "io server disconnect");
    rejected(await signal(sender, meetingId, expiredId), "WEBRTC_TARGET_UNAVAILABLE");
  });
});
