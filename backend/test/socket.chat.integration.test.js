const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const http = require("node:http");
const { performance } = require("node:perf_hooks");
const { test } = require("node:test");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { io: createClient } = require("socket.io-client");

const testUri = process.env.TEST_MONGODB_URI;
const databasePattern = /^intellimeet_phase5_test_[A-Za-z0-9_]+$/;
const event = (client, name, meetingId) => client.timeout(5000).emitWithAck(name, { meetingId });
const send = (client, meetingId, clientMessageId, text = "Hello") => client.timeout(5000)
  .emitWithAck("chat:send", { meetingId, clientMessageId, text });

function rejected(result, code, retryable = false) {
  assert.equal(result.ok, false);
  assert.equal(result.error.code, code);
  assert.equal(result.error.retryable, retryable);
}

function waitFor(socket, name) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(name, handler);
      reject(new Error(`Timed out waiting for ${name}`));
    }, 5000);
    function handler(value) {
      clearTimeout(timer);
      socket.off(name, handler);
      resolve(value);
    }
    socket.once(name, handler);
  });
}

test("chat with real REST enrollment, JWTs, and MongoDB", {
  skip: !testUri && "Set TEST_MONGODB_URI to a dedicated intellimeet_phase5_test_<suffix> database",
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
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  const connectDB = require("../src/config/db");
  const Meeting = require("../src/models/Meeting");
  const Workspace = require("../src/models/Workspace");
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
    async function register(name) {
      const result = await rest("POST", "/api/auth/register", null, {
        name, email: `${name}-${randomBytes(8).toString("hex")}@example.test`, password: "phase5-test-password"
      });
      assert.equal(result.status, 201);
      return { id: result.body.user.id, token: result.body.token };
    }
    const host = await register("host");
    const member = await register("member");
    async function createMeeting(workspace = null) {
      const result = await rest("POST", "/api/meetings", host, { title: "Chat integration", workspace });
      assert.equal(result.status, 201);
      return result.body.meeting._id;
    }
    async function enroll(user, meetingId) {
      assert.equal((await rest("POST", `/api/meetings/${meetingId}/join`, user)).status, 200);
    }
    async function connect(user, { token = user.token, transport = "websocket" } = {}) {
      const client = createClient(url, {
        autoConnect: false, reconnection: false, timeout: 2000,
        transports: [transport], auth: { token }
      });
      clients.add(client);
      await new Promise((resolve, reject) => {
        client.once("connect", resolve);
        client.once("connect_error", reject);
        client.connect();
      });
      return client;
    }
    async function readyRoom() {
      const meetingId = await createMeeting();
      await enroll(host, meetingId);
      await enroll(member, meetingId);
      return meetingId;
    }
    return { io, rest, host, member, createMeeting, enroll, connect, readyRoom };
  }

  await t.test("requires actual REST enrollment and active socket room membership", async (t) => {
    const { host, member, createMeeting, enroll, connect } = await setup(t);
    const meetingId = await createMeeting();
    await enroll(host, meetingId);
    const sender = await connect(member);
    rejected(await send(sender, meetingId, "not-joined"), "MEETING_NOT_JOINED");
    rejected(await event(sender, "meeting:join", meetingId), "MEETING_ENROLLMENT_REQUIRED");
    await enroll(member, meetingId);
    await event(sender, "meeting:join", meetingId);
    assert.equal((await send(sender, meetingId, "enrolled")).ok, true);
  });

  await t.test("delivers trusted plain text over WebSocket and polling without changing the meeting", async (t) => {
    const { host, member, readyRoom, connect } = await setup(t);
    const meetingId = await readyRoom();
    const sender = await connect(host);
    const recipient = await connect(member, { transport: "polling" });
    await event(sender, "meeting:join", meetingId);
    await event(recipient, "meeting:join", meetingId);
    const before = await Meeting.findById(meetingId).lean();
    const received = waitFor(recipient, "chat:message");
    const result = await send(sender, meetingId, "actual-token", "  Hello from REST login  ");
    assert.equal(result.ok, true);
    assert.equal(result.data.duplicate, false);
    assert.deepEqual((await received).sender, { userId: host.id });
    assert.equal(result.data.message.text, "Hello from REST login");
    assert.match(result.data.message.sentAt, /^\d{4}-\d\d-\d\dT.*Z$/);
    const after = await Meeting.findById(meetingId).lean();
    assert.deepEqual(after.participants, before.participants);
    assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime());
  });

  await t.test("isolates rooms and scopes client IDs by meeting and user", async (t) => {
    const { host, member, readyRoom, connect } = await setup(t);
    const firstId = await readyRoom();
    const secondId = await readyRoom();
    const first = await connect(host);
    const second = await connect(host);
    const otherUser = await connect(member);
    await event(first, "meeting:join", firstId);
    await event(second, "meeting:join", secondId);
    await event(otherUser, "meeting:join", firstId);
    const otherMessages = [];
    second.on("chat:message", (message) => otherMessages.push(message));
    const firstResult = await send(first, firstId, "shared-client-id");
    await event(second, "meeting:roster", secondId);
    assert.deepEqual(otherMessages, []);
    const secondResult = await send(second, secondId, "shared-client-id");
    const otherResult = await send(otherUser, firstId, "shared-client-id");
    assert.equal(secondResult.data.duplicate, false);
    assert.equal(otherResult.data.duplicate, false);
    assert.equal(new Set([firstResult, secondResult, otherResult].map((reply) => reply.data.message.id)).size, 3);
    rejected(await send(second, firstId, "wrong-room"), "MEETING_NOT_JOINED");
  });

  await t.test("deduplicates concurrent tabs and detects changed submissions", async (t) => {
    const { host, readyRoom, connect } = await setup(t);
    const meetingId = await readyRoom();
    const first = await connect(host);
    const second = await connect(host);
    await event(first, "meeting:join", meetingId);
    await event(second, "meeting:join", meetingId);
    const delivered = [];
    first.on("chat:message", (message) => delivered.push(message));
    const replies = await Promise.all([send(first, meetingId, "duplicate"), send(second, meetingId, "duplicate")]);
    assert.equal(replies.filter((reply) => reply.data.duplicate).length, 1);
    assert.equal(replies[0].data.message.id, replies[1].data.message.id);
    rejected(await send(first, meetingId, "duplicate", "Different"), "CHAT_DUPLICATE_CONFLICT");
    assert.equal(delivered.length, 1);
  });

  await t.test("enforces the user rate limit across actual authenticated tabs", async (t) => {
    const { host, readyRoom, connect } = await setup(t);
    const meetingId = await readyRoom();
    const first = await connect(host);
    const second = await connect(host);
    await event(first, "meeting:join", meetingId);
    await event(second, "meeting:join", meetingId);
    t.mock.method(performance, "now", () => 1000);
    const replies = await Promise.all(Array.from({ length: 10 }, (_, index) => send(first, meetingId, `rate-${index}`)));
    assert.equal(replies.every((reply) => reply.ok), true);
    const limited = await send(second, meetingId, "rate-overflow");
    rejected(limited, "CHAT_RATE_LIMITED", true);
    assert.equal(limited.error.retryAfterMs, 1000);
  });

  await t.test("rejects invalid text and client-supplied identity or time", async (t) => {
    const { host, readyRoom, connect } = await setup(t);
    const meetingId = await readyRoom();
    const sender = await connect(host);
    await event(sender, "meeting:join", meetingId);
    rejected(await send(sender, meetingId, "blank", "  "), "CHAT_INVALID_TEXT");
    rejected(await send(sender, meetingId, "large", "x".repeat(2001)), "CHAT_TOO_LARGE");
    rejected(await sender.timeout(5000).emitWithAck("chat:send", {
      meetingId, clientMessageId: "spoof", text: "Hello", sender: { userId: "fake" }
    }), "CHAT_INVALID_PAYLOAD");
    rejected(await sender.timeout(5000).emitWithAck("chat:send", {
      meetingId, clientMessageId: "time", text: "Hello", sentAt: "fake"
    }), "CHAT_INVALID_PAYLOAD");
  });

  await t.test("rechecks REST-ended meetings and current workspace authorization on send", async (t) => {
    const { host, member, rest, createMeeting, enroll, connect } = await setup(t);
    const created = await rest("POST", "/api/workspaces", host, { name: "Chat workspace" });
    const workspaceId = created.body.workspace._id;
    // Test fixture only: membership-removal hooks/routes remain pending Issue #1.
    await Workspace.updateOne({ _id: workspaceId }, { $addToSet: { members: member.id } });
    const meetingId = await createMeeting(workspaceId);
    await enroll(host, meetingId);
    await enroll(member, meetingId);
    const sender = await connect(member);
    const hostClient = await connect(host);
    await event(sender, "meeting:join", meetingId);
    await event(hostClient, "meeting:join", meetingId);
    await Workspace.updateOne({ _id: workspaceId }, { $pull: { members: member.id } });
    rejected(await send(sender, meetingId, "revoked"), "MEETING_FORBIDDEN");
    assert.equal((await rest("PATCH", `/api/meetings/${meetingId}/end`, host)).status, 200);
    rejected(await send(hostClient, meetingId, "ended"), "MEETING_ENDED");
  });

  await t.test("cleans membership on leave/disconnect and reconciles retries after explicit rejoin", async (t) => {
    const { host, readyRoom, connect } = await setup(t);
    const meetingId = await readyRoom();
    const sender = await connect(host);
    await event(sender, "meeting:join", meetingId);
    const original = await send(sender, meetingId, "retry");
    await event(sender, "meeting:leave", meetingId);
    rejected(await send(sender, meetingId, "after-leave"), "MEETING_NOT_JOINED");
    sender.disconnect();
    const connectedAgain = waitFor(sender, "connect");
    sender.connect();
    await connectedAgain;
    rejected(await send(sender, meetingId, "before-rejoin"), "MEETING_NOT_JOINED");
    await event(sender, "meeting:join", meetingId);
    const duplicate = await send(sender, meetingId, "retry");
    assert.equal(duplicate.data.duplicate, true);
    assert.deepEqual(duplicate.data.message, original.data.message);
  });

  await t.test("rejects expired credentials and removes active send authority at expiry", async (t) => {
    const { host, member, readyRoom, connect } = await setup(t);
    const meetingId = await readyRoom();
    const observer = await connect(host);
    await event(observer, "meeting:join", meetingId);
    const expiredToken = jwt.sign({ id: member.id }, process.env.JWT_SECRET, { expiresIn: -1 });
    await assert.rejects(connect(member, { token: expiredToken }), (error) => error.data.code === "AUTH_EXPIRED");
    const shortToken = jwt.sign({ id: member.id }, process.env.JWT_SECRET, { expiresIn: 2 });
    const sender = await connect(member, { token: shortToken });
    await event(sender, "meeting:join", meetingId);
    assert.equal((await send(sender, meetingId, "before-expiry")).ok, true);
    const socketId = sender.id;
    assert.equal(await waitFor(sender, "disconnect"), "io server disconnect");
    const roster = await event(observer, "meeting:roster", meetingId);
    assert.equal(roster.data.participants.some((user) => user.socketIds.includes(socketId)), false);
  });
});
