const assert = require("node:assert/strict");
const http = require("node:http");
const { performance } = require("node:perf_hooks");
const { test } = require("node:test");
const jwt = require("jsonwebtoken");
const { io: createClient } = require("socket.io-client");
const initializeSocket = require("../src/socket");
const createWebrtcState = require("../src/socket/webrtc.state");
const createPresenceStore = require("../src/socket/presence.store");
const User = require("../src/models/User");
const Meeting = require("../src/models/Meeting");
const Workspace = require("../src/models/Workspace");

const secret = "webrtc-tests-only-secret";
const hostId = "507f1f77bcf86cd799439011";
const memberId = "507f1f77bcf86cd799439012";
const meetingA = "65abcdef0123456789abcdef";
const meetingB = "65abcdef0123456789abcdee";
const workspaceId = "65abcdef0123456789abcded";
const candidate = { candidate: "candidate:1 1 UDP 2122260223 192.0.2.1 5000 typ host", sdpMid: "0", sdpMLineIndex: 0 };
const request = (client, event, meetingId = meetingA) => client.timeout(5000).emitWithAck(event, { meetingId });
function payload(targetSocketId, type = "offer", overrides = {}) {
  return {
    meetingId: meetingA, targetSocketId, negotiationId: "negotiation-1",
    ...(type === "ice-candidate" ? { candidate: { ...candidate } } : { description: { type, sdp: "v=0\r\ns=fixture\r\n" } }),
    ...overrides
  };
}
const signal = (client, targetSocketId, type = "offer", overrides = {}) => client.timeout(5000)
  .emitWithAck(`webrtc:${type}`, payload(targetSocketId, type, overrides));
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function waitFor(socket, event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(event, handler); reject(new Error(`Timed out waiting for ${event}`)); }, 5000);
    function handler(value) { clearTimeout(timer); socket.off(event, handler); resolve(value); }
    socket.once(event, handler);
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
  const users = new Set([hostId, memberId]);
  const members = new Set([hostId, memberId]);
  const state = { loadMeeting: async (id) => meetings.get(id) || null, userExists: async (id) => users.has(String(id)) };
  t.mock.method(User, "findById", (id) => ({
    select() { return this; }, async lean() { return users.has(id) ? { _id: id } : null; }
  }));
  t.mock.method(User, "exists", async ({ _id }) => await state.userExists(_id) ? { _id } : null);
  t.mock.method(Meeting, "findById", (id) => ({ select() { return this; }, lean() { return state.loadMeeting(id); } }));
  t.mock.method(Workspace, "exists", async ({ members: id }) => members.has(id) ? { _id: workspaceId } : null);
  const server = http.createServer((req, res) => res.end("ok"));
  const io = initializeSocket(server);
  const clients = new Set();
  t.after(async () => {
    for (const client of clients) client.disconnect();
    const closed = new Promise((resolve) => io.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  async function connect(userId = hostId, expiresIn = "5m") {
    const client = createClient(`http://127.0.0.1:${server.address().port}`, {
      autoConnect: false, reconnection: false, timeout: 2000, transports: ["websocket"],
      auth: { token: jwt.sign({ id: userId }, secret, { expiresIn }) }
    });
    clients.add(client);
    await new Promise((resolve, reject) => {
      client.once("connect", resolve); client.once("connect_error", reject); client.connect();
    });
    return client;
  }
  async function pair() {
    const sender = await connect();
    const target = await connect(memberId);
    assert.equal((await request(sender, "meeting:join")).ok, true);
    assert.equal((await request(target, "meeting:join")).ok, true);
    return { sender, target };
  }
  return { io, connect, pair, state, meetings, members, users };
}

test("signaling state and membership generations", async (t) => {
  await t.test("separates description and ICE limits and refills monotonically", () => {
    let now = 0;
    const state = createWebrtcState({ now: () => now });
    for (let index = 0; index < 20; index += 1) assert.equal(state.take(hostId, "description").allowed, true);
    assert.deepEqual(state.take(hostId, "description"), { allowed: false, retryAfterMs: 500 });
    for (let index = 0; index < 200; index += 1) assert.equal(state.take(hostId, "ice").allowed, true);
    assert.deepEqual(state.take(hostId, "ice"), { allowed: false, retryAfterMs: 25 });
    now = 250;
    assert.equal(state.take(hostId, "ice").allowed, true);
    assert.equal(state.take(hostId, "description").retryAfterMs, 250);
    now = 500;
    assert.equal(state.take(hostId, "description").allowed, true);
    assert.equal(state.take(memberId, "description").allowed, true);
  });
  await t.test("bounds user metadata, prunes idle buckets, and clears on close", () => {
    let now = 0;
    const state = createWebrtcState({ now: () => now });
    for (let index = 0; index < 1024; index += 1) assert.equal(state.take(String(index), "ice").allowed, true);
    assert.equal(state.take("overflow", "ice").unavailable, true);
    now = 300000;
    assert.equal(state.take("new", "ice").allowed, true);
    state.close();
    assert.equal(state.take("new", "ice").unavailable, true);
  });
  await t.test("changes generation only for a new membership, without changing roster schemas", () => {
    const presence = createPresenceStore();
    presence.add(meetingA, hostId, "peer");
    const first = presence.getMembershipRevision("peer");
    assert.deepEqual(presence.getMembership("peer"), { meetingId: meetingA, userId: hostId });
    presence.add(meetingA, hostId, "peer");
    assert.equal(presence.getMembershipRevision("peer"), first);
    presence.remove("peer");
    assert.equal(presence.getMembershipRevision("peer"), null);
    presence.add(meetingA, hostId, "peer");
    assert.ok(presence.getMembershipRevision("peer") > first);
  });
});

test("authorized real-client WebRTC signaling", { timeout: 60000 }, async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = secret;
  t.after(() => { if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret; });
  const logs = [];
  t.mock.method(console, "log", (...values) => logs.push(values.join(" ")));

  await t.test("forwards offer, answer, and ICE only to the intended peer with trusted identity", async (t) => {
    const { pair, connect } = await setup(t);
    const { sender, target } = await pair();
    const bystander = await connect();
    await request(bystander, "meeting:join");
    const leaked = [];
    for (const client of [sender, bystander]) {
      for (const type of ["offer", "answer", "ice-candidate"]) client.on(`webrtc:${type}`, (value) => leaked.push(value));
    }
    for (const type of ["offer", "answer", "ice-candidate"]) {
      const received = waitFor(target, `webrtc:${type}`);
      const reply = await signal(sender, target.id, type);
      assert.deepEqual(reply, { ok: true, data: {
        forwarded: true, meetingId: meetingA, targetSocketId: target.id, negotiationId: "negotiation-1"
      } });
      assert.deepEqual(await received, { ...payload(target.id, type), sender: { userId: hostId, socketId: sender.id } });
    }
    await request(bystander, "meeting:roster");
    assert.deepEqual(leaked, []);
    assert.equal(logs.some((line) => line.includes("s=fixture") || line.includes("candidate:1")), false);
  });

  await t.test("accepts null/empty end-of-candidates and optional ICE username fragments", async (t) => {
    const { pair } = await setup(t);
    const { sender, target } = await pair();
    for (const value of [null, { candidate: "", sdpMid: null, sdpMLineIndex: null },
      { ...candidate, usernameFragment: "ice-generation" }, { ...candidate, usernameFragment: null }]) {
      const received = waitFor(target, "webrtc:ice-candidate");
      assert.equal((await signal(sender, target.id, "ice-candidate", { candidate: value })).ok, true);
      assert.deepEqual((await received).candidate, value);
    }
  });

  await t.test("rejects malformed envelopes, spoofed sender, invalid IDs, and wrong description types", async (t) => {
    const { pair } = await setup(t);
    const { sender, target } = await pair();
    for (const value of [null, [], "offer", {}, { ...payload(target.id), sender: { userId: memberId } },
      { ...payload(target.id), negotiationId: "bad id" }, { ...payload(target.id), negotiationId: "x".repeat(65) },
      { ...payload(target.id), description: { type: "answer", sdp: "v=0" } },
      { ...payload(target.id), description: { type: "offer", sdp: " " } },
      { ...payload(target.id), description: { type: "offer", sdp: "a\u0000b" } },
      { ...payload(target.id), description: { type: "offer", sdp: "v=0", extra: true } }]) {
      rejected(await sender.timeout(5000).emitWithAck("webrtc:offer", value), "WEBRTC_INVALID_PAYLOAD");
    }
    rejected(await signal(sender, target.id, "offer", { meetingId: "bad" }), "INVALID_MEETING_ID");
    for (const id of [null, 1, "bad id", "x".repeat(65), sender.id]) {
      rejected(await signal(sender, id), "WEBRTC_INVALID_TARGET");
    }
  });

  await t.test("rejects invalid ICE types, routing fields, and unsupported extra keys", async (t) => {
    const { pair } = await setup(t);
    const { sender, target } = await pair();
    for (const value of [[], "ice", 1, {}, { ...candidate, candidate: 2 },
      { ...candidate, sdpMid: 1 }, { ...candidate, sdpMLineIndex: -1 },
      { ...candidate, sdpMLineIndex: 0.5 }, { ...candidate, sdpMLineIndex: 65536 },
      { ...candidate, sdpMid: null, sdpMLineIndex: null }, { ...candidate, usernameFragment: 1 },
      { ...candidate, candidate: "candidate\nline" }, { ...candidate, userId: hostId }]) {
      rejected(await signal(sender, target.id, "ice-candidate", { candidate: value }), "WEBRTC_INVALID_PAYLOAD");
    }
  });

  await t.test("enforces UTF-8 SDP, ICE, and escaped envelope limits", async (t) => {
    const { pair } = await setup(t);
    const { sender, target } = await pair();
    for (const sdp of ["x".repeat(65537), "🙂".repeat(16385), "x" + "\r\n".repeat(25000)]) {
      rejected(await signal(sender, target.id, "offer", { description: { type: "offer", sdp } }), "WEBRTC_TOO_LARGE");
    }
    for (const value of [{ ...candidate, candidate: "x".repeat(4097) },
      { ...candidate, candidate: "🙂".repeat(1025) }, { ...candidate, sdpMid: "x".repeat(257) },
      { ...candidate, usernameFragment: "x".repeat(257) }]) {
      rejected(await signal(sender, target.id, "ice-candidate", { candidate: value }), "WEBRTC_TOO_LARGE");
    }
    const received = waitFor(target, "webrtc:offer");
    assert.equal((await signal(sender, target.id, "offer", { description: { type: "offer", sdp: "x".repeat(65536) } })).ok, true);
    assert.equal((await received).description.sdp.length, 65536);
  });

  await t.test("rejects nonjoined senders, cross-room, missing, and nonjoined targets", async (t) => {
    const { pair, connect } = await setup(t);
    const { sender, target } = await pair();
    const outsider = await connect();
    rejected(await signal(outsider, target.id), "MEETING_NOT_JOINED");
    rejected(await signal(sender, outsider.id), "WEBRTC_TARGET_UNAVAILABLE");
    rejected(await signal(sender, "unknown-peer"), "WEBRTC_TARGET_UNAVAILABLE");
    await request(outsider, "meeting:join", meetingB);
    rejected(await signal(sender, outsider.id), "WEBRTC_TARGET_UNAVAILABLE");
    rejected(await signal(sender, target.id, "answer", { meetingId: meetingB }), "MEETING_NOT_JOINED");
  });

  await t.test("rechecks sender enrollment, account existence, workspace policy and meeting status", async (t) => {
    const { pair, meetings, members, users } = await setup(t);
    const { sender, target } = await pair();
    meetings.get(meetingA).participants = [memberId];
    rejected(await signal(sender, target.id), "MEETING_ENROLLMENT_REQUIRED");
    meetings.get(meetingA).participants.push(hostId);
    await request(sender, "meeting:join");
    users.delete(hostId);
    rejected(await signal(sender, target.id), "AUTH_INVALID");
    users.add(hostId);
    await request(sender, "meeting:join");
    meetings.get(meetingA).workspace = workspaceId;
    members.delete(memberId);
    rejected(await signal(target, sender.id), "MEETING_FORBIDDEN");
    members.add(memberId);
    await request(target, "meeting:join");
    meetings.get(meetingA).status = "ended";
    rejected(await signal(sender, target.id), "MEETING_ENDED");
  });

  await t.test("rechecks passive target authorization and hides its policy and account details", async (t) => {
    const { pair, meetings, members, users } = await setup(t);
    const { sender, target } = await pair();
    meetings.get(meetingA).workspace = workspaceId;
    members.delete(memberId);
    rejected(await signal(sender, target.id), "WEBRTC_TARGET_UNAVAILABLE");
    members.add(memberId);
    users.delete(memberId);
    rejected(await signal(sender, target.id), "WEBRTC_TARGET_UNAVAILABLE");
    users.add(memberId);
    meetings.get(meetingA).participants = [hostId];
    rejected(await signal(sender, target.id), "WEBRTC_TARGET_UNAVAILABLE");
  });

  await t.test("returns sanitized database failures for either peer and recovers the queue", async (t) => {
    const { pair, state, meetings } = await setup(t);
    const { sender, target } = await pair();
    state.loadMeeting = async () => { throw new Error("database-secret-SDP-sentinel"); };
    let reply = await signal(sender, target.id);
    rejected(reply, "WEBRTC_UNAVAILABLE", true);
    assert.doesNotMatch(JSON.stringify(reply), /database-secret|sentinel/);
    state.loadMeeting = async (id) => meetings.get(id);
    state.userExists = async (id) => { if (id === memberId) throw new Error("target-secret"); return true; };
    reply = await signal(sender, target.id);
    rejected(reply, "WEBRTC_UNAVAILABLE", true);
    assert.doesNotMatch(JSON.stringify(reply), /target-secret/);
    state.userExists = async () => true;
    assert.equal((await signal(sender, target.id)).ok, true);
  });

  await t.test("serializes signaling with leave and denies a send queued after leave", async (t) => {
    const { pair, state, meetings } = await setup(t);
    const { sender, target } = await pair();
    const gate = deferred();
    const started = deferred();
    t.after(() => gate.resolve());
    state.loadMeeting = async (id) => { started.resolve(); await gate.promise; return meetings.get(id); };
    const sent = signal(sender, target.id);
    await started.promise;
    const left = request(sender, "meeting:leave");
    const late = signal(sender, target.id, "ice-candidate");
    gate.resolve();
    assert.equal((await sent).data.forwarded, true);
    assert.equal((await left).data.left, true);
    rejected(await late, "MEETING_NOT_JOINED");
  });

  await t.test("does not forward after sender disconnects during authorization", async (t) => {
    const { io, pair, state, meetings } = await setup(t);
    const { sender, target } = await pair();
    const received = [];
    target.on("webrtc:offer", (value) => received.push(value));
    const gate = deferred();
    const started = deferred();
    t.after(() => gate.resolve());
    state.loadMeeting = async (id) => { started.resolve(); await gate.promise; return meetings.get(id); };
    sender.emit("webrtc:offer", payload(target.id), () => {});
    await started.promise;
    const closed = waitFor(io.of("/").sockets.get(sender.id), "disconnect");
    sender.disconnect();
    await closed;
    gate.resolve();
    await request(target, "meeting:roster");
    assert.deepEqual(received, []);
  });

  await t.test("rejects a target disconnected during either peer's authorization", async (t) => {
    for (const gatedQuery of [1, 2]) {
      const { io, pair, state, meetings } = await setup(t);
      const { sender, target } = await pair();
      const gate = deferred();
      const started = deferred();
      t.after(() => gate.resolve());
      let queries = 0;
      state.loadMeeting = async (id) => { if (++queries === gatedQuery) { started.resolve(); await gate.promise; } return meetings.get(id); };
      const pending = signal(sender, target.id);
      await started.promise;
      const closed = waitFor(io.of("/").sockets.get(target.id), "disconnect");
      target.disconnect();
      await closed;
      gate.resolve();
      rejected(await pending, "WEBRTC_TARGET_UNAVAILABLE");
    }
  });

  await t.test("rejects target leave/rejoin in the same room while a send is in flight", async (t) => {
    const { pair, state, meetings } = await setup(t);
    const { sender, target } = await pair();
    const received = [];
    target.on("webrtc:offer", (value) => received.push(value));
    const gate = deferred();
    const started = deferred();
    t.after(() => gate.resolve());
    state.loadMeeting = async (id) => { started.resolve(); await gate.promise; return meetings.get(id); };
    const pending = signal(sender, target.id);
    await started.promise;
    await request(target, "meeting:leave");
    state.loadMeeting = async (id) => meetings.get(id);
    await request(target, "meeting:join");
    gate.resolve();
    rejected(await pending, "WEBRTC_TARGET_UNAVAILABLE");
    await request(target, "meeting:roster");
    assert.deepEqual(received, []);
    assert.equal((await signal(sender, target.id)).ok, true);
  });

  await t.test("never resolves stale peer IDs after reconnect, and requires explicit rejoin", async (t) => {
    const { io, pair } = await setup(t);
    const { sender, target } = await pair();
    const oldId = target.id;
    const closed = waitFor(io.of("/").sockets.get(oldId), "disconnect");
    target.disconnect();
    await closed;
    const connected = waitFor(target, "connect");
    target.connect();
    await connected;
    assert.notEqual(target.id, oldId);
    rejected(await signal(sender, oldId), "WEBRTC_TARGET_UNAVAILABLE");
    rejected(await signal(sender, target.id), "WEBRTC_TARGET_UNAVAILABLE");
    await request(target, "meeting:join");
    const received = waitFor(target, "webrtc:answer");
    assert.equal((await signal(sender, target.id, "answer")).ok, true);
    assert.equal((await received).targetSocketId, target.id);
  });

  await t.test("forwards simultaneous offers and concurrent ICE without a global peer lock", async (t) => {
    const { pair } = await setup(t);
    const { sender, target } = await pair();
    const firstOffer = waitFor(sender, "webrtc:offer");
    const secondOffer = waitFor(target, "webrtc:offer");
    const offers = await Promise.all([signal(sender, target.id), signal(target, sender.id, "offer", { negotiationId: "other-offer" })]);
    assert.equal(offers.every((reply) => reply.ok), true);
    assert.equal((await firstOffer).negotiationId, "other-offer");
    assert.equal((await secondOffer).negotiationId, "negotiation-1");
    const candidates = [];
    target.on("webrtc:ice-candidate", (value) => candidates.push(value));
    const replies = await Promise.all(Array.from({ length: 12 }, (_, index) => signal(sender, target.id, "ice-candidate", { negotiationId: `ice-${index}` })));
    assert.equal(replies.every((reply) => reply.ok), true);
    await request(target, "meeting:roster");
    assert.deepEqual(candidates.map((value) => value.negotiationId), Array.from({ length: 12 }, (_, i) => `ice-${i}`));
  });

  await t.test("shares rate budgets across tabs/reconnects and keeps ICE separate from descriptions/chat", async (t) => {
    t.mock.method(performance, "now", () => 1000);
    const { io, pair, connect } = await setup(t);
    const { sender, target } = await pair();
    const tab = await connect();
    await request(tab, "meeting:join");
    for (let index = 0; index < 20; index += 1) assert.equal((await signal(sender, target.id)).ok, true);
    const limited = await signal(tab, target.id, "answer");
    rejected(limited, "WEBRTC_RATE_LIMITED", true);
    assert.equal(limited.error.retryAfterMs, 500);
    for (let index = 0; index < 200; index += 1) assert.equal((await signal(tab, target.id, "ice-candidate")).ok, true);
    rejected(await signal(sender, target.id, "ice-candidate"), "WEBRTC_RATE_LIMITED", true);
    assert.equal((await signal(target, sender.id)).ok, true);
    assert.equal((await sender.timeout(5000).emitWithAck("chat:send", { meetingId: meetingA, clientMessageId: "independent", text: "Hello" })).ok, true);
    const closed = waitFor(io.of("/").sockets.get(sender.id), "disconnect");
    sender.disconnect();
    await closed;
    const connected = waitFor(sender, "connect");
    sender.connect();
    await connected;
    await request(sender, "meeting:join");
    rejected(await signal(sender, target.id), "WEBRTC_RATE_LIMITED", true);
  });

  await t.test("bounds the shared queue and ignores requests without acknowledgments", async (t) => {
    const { pair, state, meetings } = await setup(t);
    const { sender, target } = await pair();
    const received = [];
    target.on("webrtc:offer", (value) => received.push(value));
    sender.emit("webrtc:offer", payload(target.id));
    await request(sender, "meeting:roster");
    const gate = deferred();
    t.after(() => gate.resolve());
    state.loadMeeting = async (id) => { await gate.promise; return meetings.get(id); };
    const pending = Array.from({ length: 17 }, () => signal(sender, target.id));
    try {
      rejected(await pending[16], "WEBRTC_BUSY", true);
      rejected(await request(sender, "meeting:leave"), "MEETING_BUSY", true);
    } finally { gate.resolve(); }
    assert.equal((await Promise.all(pending.slice(0, 16))).every((reply) => reply.ok), true);
    await request(target, "meeting:roster");
    assert.equal(received.length, 16);
  });

  await t.test("blocks expiry during sender authorization without emitting stale signals", async (t) => {
    const { connect, state, meetings } = await setup(t);
    const sender = await connect(hostId, 2);
    const target = await connect(memberId);
    await request(sender, "meeting:join");
    await request(target, "meeting:join");
    const received = [];
    target.on("webrtc:offer", (value) => received.push(value));
    const gate = deferred();
    const started = deferred();
    t.after(() => gate.resolve());
    state.loadMeeting = async (id) => { started.resolve(); await gate.promise; return meetings.get(id); };
    sender.emit("webrtc:offer", payload(target.id), () => {});
    await started.promise;
    assert.equal(await waitFor(sender, "disconnect"), "io server disconnect");
    gate.resolve();
    await request(target, "meeting:roster");
    assert.deepEqual(received, []);
  });

  await t.test("blocks target expiry during authorization and delayed expiry timers at final delivery", async (t) => {
    const { io, pair, state } = await setup(t);
    const { sender, target } = await pair();
    const serverTarget = io.of("/").sockets.get(target.id);
    state.userExists = async (id) => { if (id === memberId) serverTarget.data.auth.expiresAt = Date.now() - 1; return true; };
    rejected(await signal(sender, target.id), "WEBRTC_TARGET_UNAVAILABLE");
    assert.equal(serverTarget.connected, false);
  });
});
