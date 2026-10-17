const { randomUUID } = require("node:crypto");

const messages = {
  CHAT_INVALID_PAYLOAD: "Expected meetingId, clientMessageId, and text only",
  CHAT_INVALID_MESSAGE_ID: "Invalid client message ID",
  CHAT_INVALID_TEXT: "Text must be nonblank plain text without unsupported control characters",
  CHAT_TOO_LARGE: "Chat payload exceeds the text or payload size limit",
  CHAT_DUPLICATE_CONFLICT: "Client message ID was already used with different text",
  CHAT_RATE_LIMITED: "Chat rate limit exceeded",
  CHAT_BUSY: "Too many pending socket requests",
  CHAT_UNAVAILABLE: "Chat operation temporarily unavailable"
};

class ChatRequestError extends Error {
  constructor(code, retryAfterMs) {
    super(messages[code]);
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

function registerChatHandlers(io, socket, meeting, chatState) {
  function failure(error) {
    if (!(error instanceof ChatRequestError)) {
      const accessError = meeting.formatAccessError(error);
      if (accessError) return accessError;
    }
    const code = error instanceof ChatRequestError ? error.code : "CHAT_UNAVAILABLE";
    return {
      ok: false,
      error: {
        code,
        message: messages[code],
        retryable: ["CHAT_RATE_LIMITED", "CHAT_BUSY", "CHAT_UNAVAILABLE"].includes(code),
        ...(code === "CHAT_RATE_LIMITED" ? { retryAfterMs: error.retryAfterMs } : {})
      }
    };
  }

  function parse(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)
      || Object.keys(payload).length !== 3
      || !["meetingId", "clientMessageId", "text"].every((key) => Object.hasOwn(payload, key))) {
      throw new ChatRequestError("CHAT_INVALID_PAYLOAD");
    }
    const meetingId = meeting.parseMeetingId({ meetingId: payload.meetingId });
    if (typeof payload.clientMessageId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(payload.clientMessageId)) {
      throw new ChatRequestError("CHAT_INVALID_MESSAGE_ID");
    }
    if (typeof payload.text !== "string") throw new ChatRequestError("CHAT_INVALID_TEXT");
    if (payload.text.length > 2000 || Buffer.byteLength(payload.text, "utf8") > 4096
      || Buffer.byteLength(JSON.stringify(payload), "utf8") > 8192) {
      throw new ChatRequestError("CHAT_TOO_LARGE");
    }
    const text = payload.text.trim();
    if (!text || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
      throw new ChatRequestError("CHAT_INVALID_TEXT");
    }
    return { meetingId, clientMessageId: payload.clientMessageId, text };
  }

  meeting.registerRequest("chat:send", async ({ meetingId, clientMessageId, text }) => {
    const { userId } = meeting.requireJoined(meetingId);
    const rate = chatState.take(userId);
    if (!rate.allowed) {
      throw new ChatRequestError(rate.unavailable ? "CHAT_UNAVAILABLE" : "CHAT_RATE_LIMITED", rate.retryAfterMs);
    }
    await meeting.authorizeJoined(meetingId);
    meeting.requireJoined(meetingId);

    const previous = chatState.get(userId, meetingId, clientMessageId);
    if (previous) {
      if (previous.text !== text) throw new ChatRequestError("CHAT_DUPLICATE_CONFLICT");
      return { message: previous, duplicate: true };
    }

    const message = Object.freeze({
      id: randomUUID(),
      clientMessageId,
      meetingId,
      sender: Object.freeze({ userId }),
      text,
      sentAt: new Date().toISOString()
    });
    // No await between checking/recording/publishing: duplicates across tabs
    // cannot both publish in this single-process deployment.
    chatState.remember(userId, meetingId, clientMessageId, message);
    io.to(meeting.roomName(meetingId)).emit("chat:message", message);
    return { message, duplicate: false };
  }, {
    parse,
    failure,
    busyError: () => new ChatRequestError("CHAT_BUSY")
  });
}

module.exports = registerChatHandlers;
