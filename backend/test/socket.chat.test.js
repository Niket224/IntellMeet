const assert = require("node:assert/strict");
const http = require("node:http");
const { performance } = require("node:perf_hooks");
const { test } = require("node:test");
const jwt = require("jsonwebtoken");
const { io: createClient } = require("socket.io-client");
const initializeSocket = require("../src/socket");
const createChatState = require("../src/socket/chat.state");
const User = require("../src/models/User");
const Meeting = require("../src/models/Meeting");
const Workspace = require("../src/models/Workspace");

const secret = "chat-tests-only-secret";
const hostId = "507f1f77bcf86cd799439011";
const memberId = "507f1f77bcf86cd799439012";
const meetingA = "65abcdef0123456789abcdef";
const meetingB = "65abcdef0123456789abcdee";
const workspaceId = "65abcdef0123456789abcded";
const request = (client, event, meetingId) => client.timeout(5000).emitWithAck(event, { meetingId });
const send = (client, meetingId, clientMessageId, text = "Hello") => client.timeout(5000)
  .emitWithAck("chat:send", { meetingId, clientMessageId, text });

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

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

function rejected(result, code, retryable = false) {
  assert.equal(result.ok, false);
  assert.equal(result.error.code, code);
  assert.equal(result.error.retryable, retryable);
  assert.equal(typeof result.error.message, "string");
}

async function setup(t) {
  const meetings = new Map([meetingA, meetingB].map((id) => [id, {
    _id: id, host: hostId, participants: [hostId, memberId], workspace: null, status: "live"
  }]));
  const members = new Set([hostId, memberId]);
  const users = new Set([hostId, memberId]);
  const state = { loadMeeting: async (id) => meetings.get(id) || null };
  t.mock.method(User, "findById", (id) => ({
    select() { return this; },
    async lean() { return users.has(id) ? { _id: id } : null; }
  }));
  t.mock.method(User, "exists", async ({ _id }) => users.has(String(_id)) ? { _id } : null);
  t.mock.method(Meeting, "findById", (id) => ({
    select() { return this; },
    lean() { return state.loadMeeting(id); }
  }));
  t.mock.method(Workspace, "exists", async () => members.has(memberId) ? { _id: workspaceId } : null);
  const server = http.createServer((req, res) => res.end("ok"));
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
  async function connect(userId = hostId, expiresIn = "5m") {
    const client = createClient(`http://127.0.0.1:${server.address().port}`, {
      autoConnect: false, reconnection: false, timeout: 2000,
      transports: ["websocket"], auth: { token: jwt.sign({ id: userId }, secret, { expiresIn }) }
    });
    clients.add(client);
    await new Promise((resolve, reject) => {
      client.once("connect", resolve);
      client.once("connect_error", reject);
      client.connect();
    });
    return client;
  }
  return { io, connect, state, meetings, members, users };
}

test("chat state bounds and monotonic rate limits", async (t) => {
  await t.test("limits bursts per user, refills, and reports retry delays", () => {
    let now = 0;
    const state = createChatState({ now: () => now });
    for (let index = 0; index < 10; index += 1) assert.equal(state.take(hostId).allowed, true);
    assert.deepEqual(state.take(hostId), { allowed: false, retryAfterMs: 1000 });
    assert.equal(state.take(memberId).allowed, true);
    now = 500;
    assert.deepEqual(state.take(hostId), { allowed: false, retryAfterMs: 500 });
    now = 1000;
    assert.equal(state.take(hostId).allowed, true);
    state.close();
    assert.equal(state.take(hostId).unavailable, true);
  });

  await t.test("scopes deduplication by user and meeting and expires it after five minutes", () => {
    let now = 0;
    const state = createChatState({ now: () => now });
    const message = { id: "original", text: "Hello" };
    state.remember(hostId, meetingA, "client-id", message);
    assert.deepEqual(state.get(hostId, meetingA, "client-id"), message);
    assert.equal(state.get(memberId, meetingA, "client-id"), null);
    assert.equal(state.get(hostId, meetingB, "client-id"), null);
    now = 300000;
    assert.equal(state.get(hostId, meetingA, "client-id"), null);
    state.close();
  });

  await t.test("bounds cached messages and releases idle rate buckets", () => {
    let now = 0;
    const state = createChatState({ now: () => now });
    for (let index = 0; index < 2049; index += 1) {
      state.remember(hostId, meetingA, String(index), { id: String(index) });
    }
    assert.equal(state.get(hostId, meetingA, "0"), null);
    assert.equal(state.get(hostId, meetingA, "2048").id, "2048");
    for (let index = 0; index < 1024; index += 1) assert.equal(state.take(`user-${index}`).allowed, true);
    assert.equal(state.take("new-user").unavailable, true);
    now = 300000;
    assert.equal(state.take("new-user").allowed, true);
    state.close();
    assert.equal(state.get(hostId, meetingA, "2048"), null);
  });
});

test("real-client chat", { timeout: 60000 }, async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = secret;
  t.after(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });
  t.mock.method(console, "log", () => {});

  await t.test("publishes plain text with trusted identity, server UUID and timestamp, including the sender", async (t) => {
    const { connect } = await setup(t);
    const sender = await connect();
    const recipient = await connect(memberId);
    await request(sender, "meeting:join", meetingA);
    await request(recipient, "meeting:join", meetingA);
    const own = waitFor(sender, "chat:message");
    const received = waitFor(recipient, "chat:message");
    const before = Date.now();
    const result = await send(sender, meetingA, "first-message", "  <b>Hello</b>\nworld  ");
    assert.equal(result.ok, true);
    assert.equal(result.data.duplicate, false);
    const message = result.data.message;
    assert.match(message.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.deepEqual(message.sender, { userId: hostId });
    assert.equal(message.text, "<b>Hello</b>\nworld");
    assert.ok(Date.parse(message.sentAt) >= before && Date.parse(message.sentAt) <= Date.now());
    assert.deepEqual(await own, message);
    assert.deepEqual(await received, message);
  });

  await t.test("rejects malformed, spoofed and oversized payloads", async (t) => {
    const { connect } = await setup(t);
    const sender = await connect();
    await request(sender, "meeting:join", meetingA);
    const base = { meetingId: meetingA, clientMessageId: "valid-id", text: "Hello" };
    for (const payload of [null, [], {}, { ...base, sender: { userId: memberId } }, { ...base, sentAt: "fake" }]) {
      rejected(await sender.timeout(5000).emitWithAck("chat:send", payload), "CHAT_INVALID_PAYLOAD");
    }
    for (const text of [123, "", " \n ", "Hello\u0000", "bad\u007ftext"]) {
      rejected(await sender.timeout(5000).emitWithAck("chat:send", { ...base, text }), "CHAT_INVALID_TEXT");
    }
    for (const text of ["a".repeat(2001), "界".repeat(1366), "\u0001".repeat(1400)]) {
      rejected(await sender.timeout(5000).emitWithAck("chat:send", { ...base, text }), "CHAT_TOO_LARGE");
    }
    for (const clientMessageId of [12, "", "bad id", "x".repeat(65)]) {
      rejected(await sender.timeout(5000).emitWithAck("chat:send", { ...base, clientMessageId }), "CHAT_INVALID_MESSAGE_ID");
    }
    rejected(await send(sender, "invalid-id", "id"), "INVALID_MEETING_ID");
    assert.equal((await send(sender, meetingA, "emoji", "😀".repeat(1000))).ok, true);
  });

  await t.test("rejects non-members and isolates delivery across rooms", async (t) => {
    const { connect } = await setup(t);
    const sender = await connect();
    const outsider = await connect(memberId);
    rejected(await send(outsider, meetingA, "not-joined"), "MEETING_NOT_JOINED");
    await request(sender, "meeting:join", meetingA);
    await request(outsider, "meeting:join", meetingB);
    const otherMessages = [];
    outsider.on("chat:message", (message) => otherMessages.push(message));
    assert.equal((await send(sender, meetingA, "room-a")).ok, true);
    await request(outsider, "meeting:roster", meetingB);
    assert.deepEqual(otherMessages, []);
    rejected(await send(outsider, meetingA, "wrong-room"), "MEETING_NOT_JOINED");
  });

  await t.test("acknowledges duplicates without republishing and rejects changed text", async (t) => {
    const { connect } = await setup(t);
    const sender = await connect();
    await request(sender, "meeting:join", meetingA);
    const published = [];
    sender.on("chat:message", (message) => published.push(message));
    const original = await send(sender, meetingA, "same-id", "  hello  ");
    const duplicate = await send(sender, meetingA, "same-id", "hello");
    assert.equal(duplicate.data.duplicate, true);
    assert.deepEqual(duplicate.data.message, original.data.message);
    rejected(await send(sender, meetingA, "same-id", "changed"), "CHAT_DUPLICATE_CONFLICT");
    assert.equal(published.length, 1);
  });

  await t.test("deduplicates concurrent submissions across the same user's tabs", async (t) => {
    const { connect } = await setup(t);
    const first = await connect();
    const second = await connect();
    await request(first, "meeting:join", meetingA);
    await request(second, "meeting:join", meetingA);
    const delivered = [];
    first.on("chat:message", (message) => delivered.push(message));
    const replies = await Promise.all([send(first, meetingA, "same-tab-id"), send(second, meetingA, "same-tab-id")]);
    assert.equal(replies.filter((reply) => reply.data.duplicate).length, 1);
    assert.equal(replies[0].data.message.id, replies[1].data.message.id);
    await request(first, "meeting:roster", meetingA);
    assert.equal(delivered.length, 1);
  });

  await t.test("shares rate limits across tabs and counts duplicate attempts", async (t) => {
    t.mock.method(performance, "now", () => 1000);
    const { connect } = await setup(t);
    const first = await connect();
    const second = await connect();
    const otherUser = await connect(memberId);
    for (const client of [first, second, otherUser]) await request(client, "meeting:join", meetingA);
    const replies = await Promise.all(Array.from({ length: 10 }, () => send(first, meetingA, "rate-id")));
    assert.equal(replies.every((reply) => reply.ok), true);
    const limited = await send(second, meetingA, "new-id");
    rejected(limited, "CHAT_RATE_LIMITED", true);
    assert.equal(limited.error.retryAfterMs, 1000);
    assert.equal((await send(otherUser, meetingA, "other-user")).ok, true);
    await request(first, "meeting:leave", meetingA);
    await request(first, "meeting:join", meetingA);
    rejected(await send(first, meetingA, "after-rejoin"), "CHAT_RATE_LIMITED", true);
  });

  await t.test("retains duplicate IDs across rejoin and reconnect without replaying history", async (t) => {
    const { connect } = await setup(t);
    const sender = await connect();
    await request(sender, "meeting:join", meetingA);
    const original = await send(sender, meetingA, "retry-id");
    await request(sender, "meeting:leave", meetingA);
    await request(sender, "meeting:join", meetingA);
    assert.equal((await send(sender, meetingA, "retry-id")).data.duplicate, true);
    sender.disconnect();
    const reconnected = waitFor(sender, "connect");
    sender.connect();
    await reconnected;
    await request(sender, "meeting:join", meetingA);
    const retry = await send(sender, meetingA, "retry-id");
    assert.deepEqual(retry.data.message, original.data.message);
    assert.equal(retry.data.duplicate, true);
    const newcomer = await connect(memberId);
    const replayed = [];
    newcomer.on("chat:message", (message) => replayed.push(message));
    await request(newcomer, "meeting:join", meetingA);
    await request(newcomer, "meeting:roster", meetingA);
    assert.deepEqual(replayed, []);
  });

  await t.test("orders sends with leave and denies sends after leaving", async (t) => {
    const { connect } = await setup(t);
    const sender = await connect();
    await request(sender, "meeting:join", meetingA);
    const sent = send(sender, meetingA, "before-leave");
    const left = request(sender, "meeting:leave", meetingA);
    assert.equal((await sent).ok, true);
    assert.equal((await left).data.left, true);
    rejected(await send(sender, meetingA, "after-leave"), "MEETING_NOT_JOINED");
    const [again, late] = await Promise.all([
      request(sender, "meeting:join", meetingA), send(sender, meetingA, "after-join")
    ]);
    assert.equal(again.ok, true);
    assert.equal(late.ok, true);
  });

  await t.test("does not publish a send whose socket disconnects during authorization", async (t) => {
    const { io, connect, state, meetings } = await setup(t);
    const sender = await connect();
    const observer = await connect(memberId);
    await request(sender, "meeting:join", meetingA);
    await request(observer, "meeting:join", meetingA);
    const published = [];
    observer.on("chat:message", (message) => published.push(message));
    const gate = deferred();
    const started = deferred();
    t.after(() => gate.resolve());
    state.loadMeeting = async (id) => { started.resolve(); await gate.promise; return meetings.get(id); };
    const serverSocket = io.of("/").sockets.get(sender.id);
    sender.emit("chat:send", { meetingId: meetingA, clientMessageId: "aborted", text: "Hello" }, () => {});
    await started.promise;
    const disconnected = waitFor(serverSocket, "disconnect");
    sender.disconnect();
    await disconnected;
    gate.resolve();
    await new Promise(setImmediate);
    await request(observer, "meeting:roster", meetingA);
    assert.deepEqual(published, []);
  });

  await t.test("rejects newly ended meetings and revoked senders without publishing", async (t) => {
    const { connect, meetings, members } = await setup(t);
    meetings.get(meetingA).workspace = workspaceId;
    const sender = await connect(memberId);
    await request(sender, "meeting:join", meetingA);
    members.delete(memberId);
    rejected(await send(sender, meetingA, "revoked"), "MEETING_FORBIDDEN");
    members.add(memberId);
    await request(sender, "meeting:join", meetingA);
    meetings.get(meetingA).status = "ended";
    rejected(await send(sender, meetingA, "ended"), "MEETING_ENDED");
  });

  await t.test("returns safe database failures and recovers without caching rejected sends", async (t) => {
    const { connect, state, meetings } = await setup(t);
    const sender = await connect();
    await request(sender, "meeting:join", meetingA);
    state.loadMeeting = async () => { throw new Error("private-db-error fixture-sentinel"); };
    const failed = await send(sender, meetingA, "retry-after-db");
    rejected(failed, "CHAT_UNAVAILABLE", true);
    assert.doesNotMatch(JSON.stringify(failed), /private-db-error|fixture-sentinel/);
    state.loadMeeting = async (id) => meetings.get(id);
    assert.equal((await send(sender, meetingA, "retry-after-db")).data.duplicate, false);
  });

  await t.test("ignores unacknowledged sends and processes concurrent unique messages once", async (t) => {
    const { connect } = await setup(t);
    const sender = await connect();
    const second = await connect(memberId);
    for (const client of [sender, second]) await request(client, "meeting:join", meetingA);
    const published = [];
    sender.on("chat:message", (message) => published.push(message));
    sender.emit("chat:send", { meetingId: meetingA, clientMessageId: "no-ack", text: "Hello" });
    const replies = await Promise.all([
      send(sender, meetingA, "no-ack"), send(sender, meetingA, "a-1"), send(sender, meetingA, "a-2"),
      send(second, meetingA, "b-0"), send(second, meetingA, "b-1"), send(second, meetingA, "b-2")
    ]);
    assert.equal(replies.every((reply) => reply.ok && !reply.data.duplicate), true);
    await request(sender, "meeting:roster", meetingA);
    assert.equal(published.length, 6);
    assert.equal(new Set(published.map((message) => message.id)).size, 6);
    assert.deepEqual(published.filter((message) => message.sender.userId === hostId)
      .map((message) => message.clientMessageId), ["no-ack", "a-1", "a-2"]);
  });

  await t.test("bounds pending chat requests and recovers the shared meeting queue", async (t) => {
    t.mock.method(performance, "now", () => 1000);
    const { connect, state, meetings } = await setup(t);
    const sender = await connect();
    await request(sender, "meeting:join", meetingA);
    const gate = deferred();
    t.after(() => gate.resolve());
    state.loadMeeting = async (id) => { await gate.promise; return meetings.get(id); };
    const replies = Array.from({ length: 17 }, (_, index) => send(sender, meetingA, `queued-${index}`));
    try {
      rejected(await replies[16], "CHAT_BUSY", true);
      rejected(await request(sender, "meeting:leave", meetingA), "MEETING_BUSY", true);
    } finally { gate.resolve(); }
    const completed = await Promise.all(replies.slice(0, 16));
    assert.equal(completed.filter((reply) => reply.ok).length, 10);
    assert.equal(completed.filter((reply) => reply.error?.code === "CHAT_RATE_LIMITED").length, 6);
    assert.equal((await request(sender, "meeting:leave", meetingA)).data.left, true);
  });

  await t.test("expires credentials during a pending send without publishing stale chat", async (t) => {
    const { connect, state, meetings } = await setup(t);
    const observer = await connect();
    const sender = await connect(memberId, 2);
    await request(observer, "meeting:join", meetingA);
    await request(sender, "meeting:join", meetingA);
    const published = [];
    observer.on("chat:message", (message) => published.push(message));
    const gate = deferred();
    const started = deferred();
    t.after(() => gate.resolve());
    state.loadMeeting = async (id) => { started.resolve(); await gate.promise; return meetings.get(id); };
    sender.emit("chat:send", { meetingId: meetingA, clientMessageId: "expired", text: "Hello" }, () => {});
    await started.promise;
    assert.equal(await waitFor(sender, "disconnect"), "io server disconnect");
    gate.resolve();
    await new Promise(setImmediate);
    await request(observer, "meeting:roster", meetingA);
    assert.deepEqual(published, []);
  });
});
