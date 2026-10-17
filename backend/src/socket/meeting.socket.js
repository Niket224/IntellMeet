const mongoose = require("mongoose");
const Meeting = require("../models/Meeting");
const Workspace = require("../models/Workspace");
const User = require("../models/User");

const MAX_PENDING_REQUESTS = 16;
const messages = {
  INVALID_REQUEST: "Expected an object containing only meetingId",
  INVALID_MEETING_ID: "Invalid meeting ID",
  AUTH_REQUIRED: "Authentication required",
  AUTH_INVALID: "Invalid authentication",
  AUTH_EXPIRED: "Authentication token expired",
  MEETING_NOT_FOUND: "Meeting not found",
  MEETING_ENROLLMENT_REQUIRED: "Join the meeting through the REST API first",
  MEETING_FORBIDDEN: "Meeting access denied",
  MEETING_ENDED: "Meeting has ended",
  MEETING_NOT_LIVE: "Start or join the meeting through the REST API first",
  MEETING_CONFLICT: "Leave the current meeting before joining another",
  MEETING_NOT_JOINED: "Socket has not joined this meeting",
  MEETING_BUSY: "Too many pending meeting requests",
  MEETING_UNAVAILABLE: "Meeting operation temporarily unavailable",
  SOCKET_DISCONNECTED: "Socket disconnected"
};

class MeetingRequestError extends Error {
  constructor(code) {
    super(messages[code]);
    this.code = code;
  }
}

function failure(error) {
  const code = error instanceof MeetingRequestError ? error.code : "MEETING_UNAVAILABLE";
  return {
    ok: false,
    error: {
      code,
      message: messages[code],
      retryable: code === "MEETING_UNAVAILABLE" || code === "MEETING_BUSY"
    }
  };
}

function meetingIdFrom(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || Object.keys(payload).length !== 1 || !Object.hasOwn(payload, "meetingId")) {
    throw new MeetingRequestError("INVALID_REQUEST");
  }
  if (typeof payload.meetingId !== "string" || !mongoose.isObjectIdOrHexString(payload.meetingId)) {
    throw new MeetingRequestError("INVALID_MEETING_ID");
  }
  return payload.meetingId.toLowerCase();
}

function requireSession(socket) {
  if (!socket.connected) throw new MeetingRequestError("SOCKET_DISCONNECTED");
  const userId = socket.data.user?.id;
  const expiresAt = socket.data.auth?.expiresAt;
  if (typeof userId !== "string" || !mongoose.isObjectIdOrHexString(userId)
    || !Number.isSafeInteger(expiresAt)) {
    throw new MeetingRequestError("AUTH_REQUIRED");
  }
  if (Date.now() >= expiresAt) {
    socket.disconnect(true);
    throw new MeetingRequestError("AUTH_EXPIRED");
  }
  return userId;
}

async function authorizeMeeting(socket, meetingId) {
  const userId = requireSession(socket);
  const meeting = await Meeting.findById(meetingId)
    .select("_id host workspace participants status").lean();
  if (!meeting) throw new MeetingRequestError("MEETING_NOT_FOUND");
  if (!meeting.participants.some((id) => String(id) === userId)) {
    throw new MeetingRequestError("MEETING_ENROLLMENT_REQUIRED");
  }
  if (meeting.status === "ended") throw new MeetingRequestError("MEETING_ENDED");
  if (meeting.status !== "live") throw new MeetingRequestError("MEETING_NOT_LIVE");

  // Match REST join's current-workspace-membership check and host exception.
  if (meeting.workspace && String(meeting.host) !== userId) {
    const member = await Workspace.exists({ _id: meeting.workspace, members: userId });
    if (!member) throw new MeetingRequestError("MEETING_FORBIDDEN");
  }
  if (!await User.exists({ _id: userId })) throw new MeetingRequestError("AUTH_INVALID");
  requireSession(socket);
}

function registerMeetingHandlers(io, socket, presence) {
  const roomName = (meetingId) => `meeting:${meetingId}`;
  let queue = Promise.resolve();
  let pending = 0;

  function broadcast(roster) {
    io.to(roomName(roster.meetingId)).emit("meeting:participants", roster);
  }

  function removePresence() {
    const roster = presence.remove(socket.id);
    delete socket.data.meetingId;
    if (roster) broadcast(roster);
    return Boolean(roster);
  }

  async function leaveCurrent() {
    const current = presence.getMembership(socket.id);
    if (!current) return false;
    try {
      await socket.leave(roomName(current.meetingId));
    } catch (error) {
      socket.disconnect(true);
      throw error;
    }
    removePresence();
    return true;
  }

  async function authorize(meetingId) {
    try {
      await authorizeMeeting(socket, meetingId);
    } catch (error) {
      const current = presence.getMembership(socket.id);
      const accessLost = error instanceof MeetingRequestError
        && ["MEETING_NOT_FOUND", "MEETING_ENROLLMENT_REQUIRED", "MEETING_FORBIDDEN",
          "MEETING_ENDED", "MEETING_NOT_LIVE", "AUTH_INVALID"].includes(error.code);
      if (accessLost && current?.meetingId === meetingId) await leaveCurrent();
      throw error;
    }
  }

  function register(event, handler, options = {}) {
    const parse = options.parse || meetingIdFrom;
    const formatFailure = options.failure || failure;
    socket.on(event, (payload, acknowledge) => {
      // No acknowledgment means no operation, preventing unconfirmed joins.
      if (typeof acknowledge !== "function") return;
      if (pending >= MAX_PENDING_REQUESTS) {
        acknowledge(formatFailure(options.busyError
          ? options.busyError() : new MeetingRequestError("MEETING_BUSY")));
        return;
      }
      pending += 1;
      queue = queue.then(async () => {
        try {
          requireSession(socket);
          const input = parse(payload);
          const data = await handler(input);
          if (socket.connected) acknowledge({ ok: true, data });
        } catch (error) {
          if (socket.connected) acknowledge(formatFailure(error));
        } finally {
          pending -= 1;
        }
      }).catch(() => {
        // A closed transport or acknowledgment failure must not poison the queue.
      });
    });
  }

  register("meeting:join", async (meetingId) => {
    const current = presence.getMembership(socket.id);
    if (current && current.meetingId !== meetingId) throw new MeetingRequestError("MEETING_CONFLICT");
    await authorize(meetingId);
    if (current) {
      return { ...presence.snapshot(meetingId), socketId: socket.id, joined: false };
    }

    try {
      await socket.join(roomName(meetingId));
      requireSession(socket);
    } catch (error) {
      try { await socket.leave(roomName(meetingId)); } catch { socket.disconnect(true); }
      throw error;
    }
    presence.add(meetingId, socket.data.user.id, socket.id);
    socket.data.meetingId = meetingId;
    const roster = presence.snapshot(meetingId);
    broadcast(roster);
    return { ...roster, socketId: socket.id, joined: true };
  });

  register("meeting:leave", async (meetingId) => {
    const current = presence.getMembership(socket.id);
    if (current && current.meetingId !== meetingId) throw new MeetingRequestError("MEETING_NOT_JOINED");
    return { meetingId, left: await leaveCurrent() };
  });

  function requireJoined(meetingId) {
    const userId = requireSession(socket);
    const current = presence.getMembership(socket.id);
    if (current?.meetingId !== meetingId || current.userId !== userId
      || !socket.rooms.has(roomName(meetingId))) {
      throw new MeetingRequestError("MEETING_NOT_JOINED");
    }
    return current;
  }

  async function authorizeJoined(meetingId) {
    requireJoined(meetingId);
    await authorize(meetingId);
    return requireJoined(meetingId);
  }

  register("meeting:roster", async (meetingId) => {
    await authorizeJoined(meetingId);
    return presence.snapshot(meetingId);
  });

  socket.once("disconnect", removePresence);

  return {
    registerRequest: register,
    requireJoined,
    authorizeJoined,
    parseMeetingId: meetingIdFrom,
    roomName,
    formatAccessError: (error) => error instanceof MeetingRequestError ? failure(error) : null
  };
}

module.exports = registerMeetingHandlers;
