const assert = require("node:assert/strict");
const http = require("node:http");
const { test } = require("node:test");
const jwt = require("jsonwebtoken");
const { io: createClient } = require("socket.io-client");
const initializeSocket = require("../src/socket");
const createPresenceStore = require("../src/socket/presence.store");
const User = require("../src/models/User");
const Meeting = require("../src/models/Meeting");
const Workspace = require("../src/models/Workspace");

const secret = "meeting-tests-only-secret";
const hostId = "507f1f77bcf86cd799439011";
const memberId = "507f1f77bcf86cd799439012";
const outsiderId = "507f1f77bcf86cd799439013";
const meetingA = "65abcdef0123456789abcdef";
const meetingB = "65abcdef0123456789abcdee";
const workspaceId = "65abcdef0123456789abcded";
const room = (id) => `meeting:${id}`;

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
    }, 4000);
    function handler(value) {
      if (!predicate(value)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(value);
    }
    socket.on(event, handler);
  });
}

const request = (client, event, meetingId) => client.timeout(4000)
  .emitWithAck(event, { meetingId });

function assertFailure(result, code, retryable = false) {
  assert.equal(result.ok, false);
  assert.deepEqual(Object.keys(result), ["ok", "error"]);
  assert.equal(result.error.code, code);
  assert.equal(result.error.retryable, retryable);
  assert.equal(typeof result.error.message, "string");
}

async function setup(t) {
  const users = new Set([hostId, memberId, outsiderId]);
  const meetings = new Map([meetingA, meetingB].map((id) => [id, {
    _id: id, host: hostId, participants: [hostId, memberId], workspace: null, status: "live"
  }]));
  const workspaces = new Map([[workspaceId, new Set([hostId, memberId])]]);
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
  t.mock.method(Workspace, "exists", async ({ _id, members }) => (
    workspaces.get(String(_id))?.has(members) ? { _id } : null
  ));

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
  const url = `http://127.0.0.1:${server.address().port}`;

  async function connect(userId = hostId, expiresIn = "5m") {
    const client = createClient(url, {
      autoConnect: false, reconnection: false, timeout: 2000,
      transports: ["websocket"],
      auth: { token: jwt.sign({ id: userId }, secret, { expiresIn }) }
    });
    clients.add(client);
    await new Promise((resolve, reject) => {
      client.once("connect", resolve);
      client.once("connect_error", reject);
      client.connect();
    });
    return client;
  }

  return { io, users, meetings, workspaces, state, connect };
}

test("meeting rooms and presence", { timeout: 60000 }, async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = secret;
  t.after(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });
  t.mock.method(console, "log", () => {});

  await t.test("store snapshots are detached and revisions survive an empty room", () => {
    const presence = createPresenceStore();
    assert.equal(presence.add(meetingA, hostId, "socket-one"), true);
    const first = presence.snapshot(meetingA);
    first.participants[0].socketIds.push("forged");
    assert.deepEqual(presence.snapshot(meetingA).participants, [{ userId: hostId, socketIds: ["socket-one"] }]);
    assert.equal(presence.add(meetingA, hostId, "socket-one"), false);
    assert.throws(() => presence.add(meetingB, hostId, "socket-one"));
    const empty = presence.remove("socket-one");
    assert.deepEqual(empty.participants, []);
    assert.equal(presence.getMembership("socket-one"), null);
    assert.equal(presence.remove("socket-one"), null);
    presence.add(meetingA, hostId, "socket-two");
    assert.ok(presence.snapshot(meetingA).revision > empty.revision);
  });

  await t.test("joins enrolled users and returns trusted IDs and individual peers", async (t) => {
    const { io, connect } = await setup(t);
    const client = await connect();
    const update = waitFor(client, "meeting:participants");
    const result = await request(client, "meeting:join", meetingA.toUpperCase());
    assert.equal(result.ok, true);
    assert.equal(result.data.joined, true);
    assert.equal(result.data.meetingId, meetingA);
    assert.equal(result.data.socketId, client.id);
    assert.deepEqual(result.data.participants, [{ userId: hostId, socketIds: [client.id] }]);
    assert.deepEqual(await update, {
      meetingId: meetingA, revision: result.data.revision, participants: result.data.participants
    });
    assert.equal(io.of("/").sockets.get(client.id).data.meetingId, meetingA);
  });

  await t.test("isolates roster broadcasts and snapshots across meetings", async (t) => {
    const { connect } = await setup(t);
    const first = await connect();
    const second = await connect();
    const member = await connect(memberId);
    await request(first, "meeting:join", meetingA);
    await request(second, "meeting:join", meetingB);
    const otherUpdates = [];
    second.on("meeting:participants", (roster) => otherUpdates.push(roster));
    const updated = waitFor(first, "meeting:participants", (roster) => roster.participants.length === 2);
    assert.equal((await request(member, "meeting:join", meetingA)).ok, true);
    assert.equal((await updated).meetingId, meetingA);
    const ownRoster = await request(second, "meeting:roster", meetingB);
    assert.equal(ownRoster.data.participants.length, 1);
    assert.deepEqual(otherUpdates, []);
    assertFailure(await request(second, "meeting:roster", meetingA), "MEETING_NOT_JOINED");
  });

  await t.test("deduplicates tabs and keeps a user visible until their last socket leaves", async (t) => {
    const { io, connect } = await setup(t);
    const first = await connect();
    const second = await connect();
    await request(first, "meeting:join", meetingA);
    const joined = await request(second, "meeting:join", meetingA);
    assert.deepEqual(joined.data.participants, [{ userId: hostId, socketIds: [first.id, second.id].sort() }]);
    assert.equal((await request(second, "meeting:leave", meetingA)).data.left, true);
    const remaining = await request(first, "meeting:roster", meetingA);
    assert.deepEqual(remaining.data.participants, [{ userId: hostId, socketIds: [first.id] }]);
    assert.equal((await request(first, "meeting:leave", meetingA)).data.left, true);
    assert.equal(io.of("/").adapter.rooms.has(room(meetingA)), false);
    assert.equal((await request(first, "meeting:leave", meetingA)).data.left, false);
  });

  await t.test("revalidates duplicate joins without duplicate broadcasts or revision changes", async (t) => {
    const { connect, meetings } = await setup(t);
    const client = await connect();
    const first = await request(client, "meeting:join", meetingA);
    const updates = [];
    client.on("meeting:participants", (roster) => updates.push(roster));
    const duplicate = await request(client, "meeting:join", meetingA);
    assert.equal(duplicate.data.joined, false);
    assert.equal(duplicate.data.revision, first.data.revision);
    assert.deepEqual(updates, []);
    meetings.get(meetingA).participants = [];
    assertFailure(await request(client, "meeting:join", meetingA), "MEETING_ENROLLMENT_REQUIRED");
    assertFailure(await request(client, "meeting:roster", meetingA), "MEETING_NOT_JOINED");
  });

  await t.test("rejects switching rooms and leaving the wrong room", async (t) => {
    const { connect } = await setup(t);
    const client = await connect();
    await request(client, "meeting:join", meetingA);
    assertFailure(await request(client, "meeting:join", meetingB), "MEETING_CONFLICT");
    assertFailure(await request(client, "meeting:leave", meetingB), "MEETING_NOT_JOINED");
    assert.equal((await request(client, "meeting:roster", meetingA)).ok, true);
    await request(client, "meeting:leave", meetingA);
    assert.equal((await request(client, "meeting:join", meetingB)).ok, true);
  });

  await t.test("rejects malformed payloads, IDs, extra identity fields, and missing meetings", async (t) => {
    const { connect } = await setup(t);
    const client = await connect();
    for (const payload of [null, [], {}, "meeting", { meetingId: meetingA, userId: outsiderId }]) {
      assertFailure(await client.timeout(4000).emitWithAck("meeting:join", payload), "INVALID_REQUEST");
    }
    for (const meetingId of [null, 123, "bad-id", "a".repeat(10000), { $ne: null }]) {
      assertFailure(await client.timeout(4000).emitWithAck("meeting:join", { meetingId }), "INVALID_MEETING_ID");
    }
    assertFailure(await request(client, "meeting:join", "65abcdef0123456789abcd00"), "MEETING_NOT_FOUND");
  });

  await t.test("ignores requests without acknowledgments without changing membership", async (t) => {
    const { connect } = await setup(t);
    const client = await connect();
    client.emit("meeting:join", { meetingId: meetingA });
    assertFailure(await request(client, "meeting:roster", meetingA), "MEETING_NOT_JOINED");
  });

  await t.test("requires persisted enrollment even for non-workspace meetings", async (t) => {
    const { connect, meetings } = await setup(t);
    const client = await connect(outsiderId);
    assertFailure(await request(client, "meeting:join", meetingA), "MEETING_ENROLLMENT_REQUIRED");
    assert.deepEqual(meetings.get(meetingA).participants, [hostId, memberId]);
  });

  await t.test("rejects scheduled and ended meetings without changing lifecycle", async (t) => {
    const { connect, meetings } = await setup(t);
    const client = await connect();
    meetings.get(meetingA).status = "scheduled";
    assertFailure(await request(client, "meeting:join", meetingA), "MEETING_NOT_LIVE");
    assert.equal(meetings.get(meetingA).status, "scheduled");
    meetings.get(meetingA).status = "ended";
    assertFailure(await request(client, "meeting:join", meetingA), "MEETING_ENDED");
  });

  await t.test("enforces current workspace membership and preserves the host exception", async (t) => {
    const { connect, meetings, workspaces } = await setup(t);
    meetings.get(meetingA).workspace = workspaceId;
    workspaces.get(workspaceId).delete(memberId);
    const member = await connect(memberId);
    assertFailure(await request(member, "meeting:join", meetingA), "MEETING_FORBIDDEN");
    workspaces.delete(workspaceId);
    const host = await connect();
    assert.equal((await request(host, "meeting:join", meetingA)).ok, true);
  });

  await t.test("evicts a requesting socket when reauthorization discovers workspace revocation", async (t) => {
    const { io, connect, meetings, workspaces } = await setup(t);
    meetings.get(meetingA).workspace = workspaceId;
    const host = await connect();
    const member = await connect(memberId);
    await request(host, "meeting:join", meetingA);
    await request(member, "meeting:join", meetingA);
    workspaces.get(workspaceId).delete(memberId);
    const update = waitFor(host, "meeting:participants", (roster) => roster.participants.length === 1);
    assertFailure(await request(member, "meeting:roster", meetingA), "MEETING_FORBIDDEN");
    assert.equal((await update).participants[0].userId, hostId);
    assert.equal(io.of("/").adapter.rooms.get(room(meetingA)).has(member.id), false);
  });

  await t.test("rejects newly ended rooms and evicts the requester on reauthorization", async (t) => {
    const { io, connect, meetings } = await setup(t);
    const client = await connect();
    await request(client, "meeting:join", meetingA);
    meetings.get(meetingA).status = "ended";
    assertFailure(await request(client, "meeting:roster", meetingA), "MEETING_ENDED");
    assert.equal(io.of("/").adapter.rooms.has(room(meetingA)), false);
  });

  await t.test("requires trusted authentication and rechecks deleted accounts", async (t) => {
    const { io, connect, users } = await setup(t);
    const client = await connect();
    users.delete(hostId);
    assertFailure(await request(client, "meeting:join", meetingA), "AUTH_INVALID");
    delete io.of("/").sockets.get(client.id).data.user;
    assertFailure(await request(client, "meeting:join", meetingA), "AUTH_REQUIRED");
  });

  await t.test("returns safe database errors and allows retry after failure", async (t) => {
    const { connect, state, meetings } = await setup(t);
    const client = await connect();
    state.loadMeeting = async () => { throw new Error("internal-database fixture-sentinel"); };
    const failed = await request(client, "meeting:join", meetingA);
    assertFailure(failed, "MEETING_UNAVAILABLE", true);
    assert.doesNotMatch(JSON.stringify(failed), /fixture-sentinel|internal-database/);
    state.loadMeeting = async (id) => meetings.get(id);
    assert.equal((await request(client, "meeting:join", meetingA)).ok, true);
  });

  await t.test("serializes concurrent duplicate joins and rejects a second active meeting", async (t) => {
    const { connect } = await setup(t);
    const client = await connect();
    const [first, duplicate, other] = await Promise.all([
      request(client, "meeting:join", meetingA),
      request(client, "meeting:join", meetingA),
      request(client, "meeting:join", meetingB)
    ]);
    assert.equal(first.data.joined, true);
    assert.equal(duplicate.data.joined, false);
    assert.equal(duplicate.data.participants[0].socketIds.length, 1);
    assertFailure(other, "MEETING_CONFLICT");
  });

  await t.test("bounds queued requests while database authorization is pending", async (t) => {
    const { connect, state, meetings } = await setup(t);
    const client = await connect();
    const gate = deferred();
    t.after(() => gate.resolve());
    state.loadMeeting = async (id) => { await gate.promise; return meetings.get(id); };
    const replies = Array.from({ length: 17 }, () => request(client, "meeting:join", meetingA));
    try { assertFailure(await replies[16], "MEETING_BUSY", true); } finally { gate.resolve(); }
    const accepted = await Promise.all(replies.slice(0, 16));
    assert.equal(accepted.filter((result) => result.data.joined).length, 1);
  });

  await t.test("preserves join-then-leave order during a slow authorization", async (t) => {
    const { io, connect, state, meetings } = await setup(t);
    const client = await connect();
    const gate = deferred();
    const started = deferred();
    t.after(() => gate.resolve());
    state.loadMeeting = async (id) => { started.resolve(); await gate.promise; return meetings.get(id); };
    const joined = request(client, "meeting:join", meetingA);
    await started.promise;
    const left = request(client, "meeting:leave", meetingA);
    gate.resolve();
    assert.equal((await joined).data.joined, true);
    assert.equal((await left).data.left, true);
    assert.equal(io.of("/").adapter.rooms.has(room(meetingA)), false);
  });

  await t.test("does not create stale presence when a client disconnects during database authorization", async (t) => {
    const { io, connect, state, meetings } = await setup(t);
    const client = await connect();
    const serverSocket = io.of("/").sockets.get(client.id);
    const gate = deferred();
    const started = deferred();
    t.after(() => gate.resolve());
    state.loadMeeting = async (id) => { started.resolve(); await gate.promise; return meetings.get(id); };
    client.emit("meeting:join", { meetingId: meetingA }, () => {});
    await started.promise;
    const disconnected = waitFor(serverSocket, "disconnect");
    client.disconnect();
    await disconnected;
    gate.resolve();
    await new Promise(setImmediate);
    assert.equal(io.of("/").adapter.rooms.has(room(meetingA)), false);
    assert.equal(serverSocket.data.meetingId, undefined);
  });

  await t.test("cleans up disconnects and requires explicit rejoin with the new socket ID", async (t) => {
    const { io, connect } = await setup(t);
    const observer = await connect();
    const client = await connect(memberId);
    await request(observer, "meeting:join", meetingA);
    await request(client, "meeting:join", meetingA);
    const oldId = client.id;
    const update = waitFor(observer, "meeting:participants", (roster) => roster.participants.length === 1);
    client.disconnect();
    await update;
    const connected = waitFor(client, "connect");
    client.connect();
    await connected;
    assert.notEqual(client.id, oldId);
    assertFailure(await request(client, "meeting:roster", meetingA), "MEETING_NOT_JOINED");
    const joined = await request(client, "meeting:join", meetingA);
    assert.deepEqual(joined.data.participants.find((user) => user.userId === memberId).socketIds, [client.id]);
    assert.equal(io.of("/").adapter.rooms.get(room(meetingA)).has(oldId), false);
  });

  await t.test("JWT expiration removes the socket from other participants' rosters", async (t) => {
    const { io, connect } = await setup(t);
    const observer = await connect();
    const client = await connect(memberId, 2);
    await request(observer, "meeting:join", meetingA);
    await request(client, "meeting:join", meetingA);
    const expiringId = client.id;
    const update = waitFor(observer, "meeting:participants", (roster) => roster.participants.length === 1);
    assert.equal(await waitFor(client, "disconnect"), "io server disconnect");
    assert.deepEqual((await update).participants, [{ userId: hostId, socketIds: [observer.id] }]);
    assert.equal(io.of("/").adapter.rooms.get(room(meetingA)).has(expiringId), false);
  });
});
