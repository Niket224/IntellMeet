const messages = {
  WEBRTC_INVALID_PAYLOAD: "Invalid signaling payload",
  WEBRTC_TOO_LARGE: "Signaling payload exceeds its size limit",
  WEBRTC_INVALID_TARGET: "Invalid target socket ID",
  WEBRTC_TARGET_UNAVAILABLE: "Target is unavailable for this meeting",
  WEBRTC_RATE_LIMITED: "Signaling rate limit exceeded",
  WEBRTC_BUSY: "Too many pending socket requests",
  WEBRTC_UNAVAILABLE: "Signaling temporarily unavailable"
};

class SignalingError extends Error {
  constructor(code, retryAfterMs) {
    super(messages[code]);
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function parseSignal(payload, type, meeting) {
  const field = type === "ice-candidate" ? "candidate" : "description";
  if (!exactKeys(payload, ["meetingId", "targetSocketId", "negotiationId", field])) {
    throw new SignalingError("WEBRTC_INVALID_PAYLOAD");
  }
  const meetingId = meeting.parseMeetingId({ meetingId: payload.meetingId });
  const { targetSocketId, negotiationId } = payload;
  if (typeof targetSocketId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(targetSocketId)) {
    throw new SignalingError("WEBRTC_INVALID_TARGET");
  }
  if (typeof negotiationId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(negotiationId)) {
    throw new SignalingError("WEBRTC_INVALID_PAYLOAD");
  }

  let value = payload[field];
  if (field === "description") {
    if (!exactKeys(value, ["type", "sdp"]) || value.type !== type || typeof value.sdp !== "string") {
      throw new SignalingError("WEBRTC_INVALID_PAYLOAD");
    }
    if (value.sdp.length > 65536 || Buffer.byteLength(value.sdp, "utf8") > 65536) {
      throw new SignalingError("WEBRTC_TOO_LARGE");
    }
    if (!value.sdp.trim() || value.sdp.includes("\u0000")) throw new SignalingError("WEBRTC_INVALID_PAYLOAD");
    value = { type, sdp: value.sdp };
  } else if (value !== null) {
    const keys = ["candidate", "sdpMid", "sdpMLineIndex"];
    if (value && Object.hasOwn(value, "usernameFragment")) keys.push("usernameFragment");
    if (!exactKeys(value, keys) || typeof value.candidate !== "string"
      || !(value.sdpMid === null || typeof value.sdpMid === "string")
      || !(value.sdpMLineIndex === null || (Number.isInteger(value.sdpMLineIndex)
        && value.sdpMLineIndex >= 0 && value.sdpMLineIndex <= 65535))
      || (Object.hasOwn(value, "usernameFragment") && value.usernameFragment !== null
        && typeof value.usernameFragment !== "string")) {
      throw new SignalingError("WEBRTC_INVALID_PAYLOAD");
    }
    if (value.candidate.length > 4096 || Buffer.byteLength(value.candidate, "utf8") > 4096
      || (value.sdpMid !== null && Buffer.byteLength(value.sdpMid, "utf8") > 256)
      || (typeof value.usernameFragment === "string" && Buffer.byteLength(value.usernameFragment, "utf8") > 256)) {
      throw new SignalingError("WEBRTC_TOO_LARGE");
    }
    if (/[\u0000\r\n]/.test(value.candidate)
      || (value.candidate !== "" && value.sdpMid === null && value.sdpMLineIndex === null)) {
      throw new SignalingError("WEBRTC_INVALID_PAYLOAD");
    }
    value = { ...value };
  }
  const input = { meetingId, targetSocketId, negotiationId, [field]: value };
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > 73728) throw new SignalingError("WEBRTC_TOO_LARGE");
  return input;
}

function registerWebrtcHandlers(io, socket, meeting, presence, state) {
  function failure(error) {
    if (!(error instanceof SignalingError)) {
      const access = meeting.formatAccessError(error);
      if (access) return access;
    }
    const code = error instanceof SignalingError ? error.code : "WEBRTC_UNAVAILABLE";
    return { ok: false, error: {
      code, message: messages[code],
      retryable: ["WEBRTC_UNAVAILABLE", "WEBRTC_BUSY", "WEBRTC_RATE_LIMITED"].includes(code),
      ...(code === "WEBRTC_RATE_LIMITED" ? { retryAfterMs: error.retryAfterMs } : {})
    } };
  }

  function targetFor(meetingId, targetSocketId) {
    if (targetSocketId === socket.id) throw new SignalingError("WEBRTC_INVALID_TARGET");
    const target = io.of("/").sockets.get(targetSocketId);
    const member = presence.getMembership(targetSocketId);
    if (!target?.connected || member?.meetingId !== meetingId || member.userId !== target.data.user?.id
      || !target.rooms.has(meeting.roomName(meetingId))
      || !Number.isSafeInteger(target.data.auth?.expiresAt) || Date.now() >= target.data.auth.expiresAt) {
      throw new SignalingError("WEBRTC_TARGET_UNAVAILABLE");
    }
    return target;
  }

  for (const type of ["offer", "answer", "ice-candidate"]) {
    const event = `webrtc:${type}`;
    meeting.registerRequest(event, async (input) => {
      const { meetingId, targetSocketId, negotiationId } = input;
      const { userId } = meeting.requireJoined(meetingId);
      const rate = state.take(userId, type === "ice-candidate" ? "ice" : "description");
      if (!rate.allowed) throw new SignalingError(rate.unavailable ? "WEBRTC_UNAVAILABLE" : "WEBRTC_RATE_LIMITED", rate.retryAfterMs);
      const target = targetFor(meetingId, targetSocketId);
      const senderRevision = presence.getMembershipRevision(socket.id);
      const targetRevision = presence.getMembershipRevision(targetSocketId);
      await meeting.authorizeJoined(meetingId);
      try {
        await meeting.authorizePeer(target, meetingId);
      } catch (error) {
        // Hide target identity/account/policy details; distinguish a DB outage.
        if (meeting.formatAccessError(error)) throw new SignalingError("WEBRTC_TARGET_UNAVAILABLE");
        throw error;
      }
      meeting.requireJoined(meetingId);
      if (presence.getMembershipRevision(socket.id) !== senderRevision) throw new SignalingError("WEBRTC_TARGET_UNAVAILABLE");
      if (targetFor(meetingId, targetSocketId) !== target
        || presence.getMembershipRevision(targetSocketId) !== targetRevision) {
        throw new SignalingError("WEBRTC_TARGET_UNAVAILABLE");
      }
      // No await from final live membership checks through direct emission.
      // Never log or persist the SDP/candidate, and never broadcast signaling.
      target.emit(event, { ...input, sender: { userId, socketId: socket.id } });
      return { forwarded: true, meetingId, targetSocketId, negotiationId };
    }, {
      parse: (payload) => parseSignal(payload, type, meeting),
      failure,
      busyError: () => new SignalingError("WEBRTC_BUSY")
    });
  }
}

module.exports = registerWebrtcHandlers;
