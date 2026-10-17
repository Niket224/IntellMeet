# Developer 2 integration handoff

Derived from the implementation at Phase 6 checkpoint
`f499199c6d67225e03cc157ab8e5b4fea44e943e`. This is a condensed contract, not a new
protocol. See [authentication](socket-authentication.md),
[meetings](socket-meetings.md), [chat](socket-chat.md), and
[signaling](socket-webrtc.md) for the complete validation/error tables.

## Endpoint and connection sequence

- Local backend base URL: **`http://localhost:5000`** (configured `PORT=5000`).
- Socket.IO namespace: **`/`**; Engine.IO path: **`/socket.io/`**. This is a
  Socket.IO protocol endpoint, not a raw WebSocket endpoint or `/api` route.
- Frontend origin: **`http://localhost:5173`** in the current local configuration.
  CORS uses the existing comma-separated `CLIENT_URL`; that same URL is its fallback.
  Use deployment-specific base URLs/origins when deploying.

1. Obtain the existing REST JWT through `/api/auth/login` or `/api/auth/register`.
2. Call `POST http://localhost:5000/api/meetings/:meetingId/join` with
   `Authorization: Bearer <JWT>`. No request body is required. Require HTTP 200.
   This owns enrollment and starts a scheduled meeting; socket join does neither.
   The host is already persisted as a participant at creation but should follow
   this sequence too. Ended meetings and unauthorized workspace access are rejected.
3. Create the socket below, install roster/chat/signaling/auth/disconnect listeners,
   connect, and wait for `connect`. Then acknowledge `meeting:join` successfully
   before enabling chat/signaling. A notification may arrive before its ack.

```js
// In Developer 2's existing app: import { io } from "socket.io-client";
const socket = io("http://localhost:5000", {
  path: "/socket.io",
  auth: { token: tokenFromRest }, // bare JWT; no "Bearer " prefix here
  autoConnect: false,
  retries: 0 // no automatic replay of stale signaling
});
// Install roster/chat/signaling/auth/disconnect listeners here.
// REST enrollment must already have succeeded.
await new Promise((resolve, reject) => {
  socket.once("connect", resolve);
  socket.once("connect_error", reject);
  socket.connect();
});
const result = await socket.timeout(5000).emitWithAck("meeting:join", { meetingId });
if (!result.ok) handleError(result.error); // existing app's error handling
```

Handshake authentication reads only `handshake.auth.token`, verifies HS256 with
the existing secret, and loads the User. Never send client user IDs/roles as proof
of identity. All room/chat/signaling requests require an ack callback (or
`emitWithAck`); requests without one are ignored. Extra request fields are rejected.

## Meeting events and presence

All three requests take exactly `{ meetingId }`, a 24-hex ID normalized to lowercase.
Success is `{ ok: true, data: ... }`:

| Client event | Exact successful `data` |
| --- | --- |
| `meeting:join` | `{ meetingId, socketId, joined, revision, participants }` |
| `meeting:leave` | `{ meetingId, left }` |
| `meeting:roster` | `{ meetingId, revision, participants }` |

The room-scoped notification `meeting:participants` has no ack wrapper:
`{ meetingId, revision, participants: [{ userId, socketIds: [socketId] }] }`.
The array contains one entry per trusted user and all that user's active sockets.
Map IDs to names using existing authorized REST data; names/emails are not in this
notification. Build one RTCPeerConnection per remote socket ID, excluding self.

`joined: false` means an idempotent duplicate join succeeded; `left: false` means
the socket was already outside all meetings. One socket can occupy one meeting.
Ignore stale roster revisions within a connection/server lifetime, and reset
roster state on reconnect so a server restart's revisions can be accepted.

## Chat

Request `chat:send`:

```js
{ meetingId, clientMessageId, text }
```

`clientMessageId` is 1-64 ASCII letters/digits/`_`/`-` (a UUID works). Raw text is
limited to 2,000 UTF-16 code units and 4,096 UTF-8 bytes; JSON to 8,192 UTF-8 bytes.
Text is edge-trimmed, must be nonblank, and rejects unsupported control characters.
Render as text, never HTML. No sender identity/timestamp is accepted from clients.

Server message schema:
`{ id, clientMessageId, meetingId, sender: { userId }, text, sentAt }`.
`id` is a server UUID; `sentAt` is a server UTC ISO string. `chat:message` delivers
this object to the meeting room, including the sender and its other joined tabs.
The send ack is `{ ok: true, data: { message, duplicate } }`.

Deduplicate the event and ack in the UI by server `id`. Retry uncertain chat with
the same client ID and normalized text after rejoin; a changed-text reuse returns
`CHAT_DUPLICATE_CONFLICT`. Server duplicate suppression lasts up to five minutes,
with a 2,048-message cap and loss on restart. There is no history/replay/persistence.
User-wide chat budget across tabs/meetings: burst 10, refill 1/second.

## WebRTC signaling

Exact requests (choose the event and its matching field):

```js
// webrtc:offer
{ meetingId, targetSocketId, negotiationId, description: { type: "offer", sdp } }
// webrtc:answer
{ meetingId, targetSocketId, negotiationId, description: { type: "answer", sdp } }
// webrtc:ice-candidate
{ meetingId, targetSocketId, negotiationId,
  candidate: { candidate, sdpMid, sdpMLineIndex, usernameFragment } }
// candidate may instead be null. usernameFragment is the only optional object key.
```

The candidate object's other three fields are required. `candidate` is a string;
`sdpMid` is string/null, `sdpMLineIndex` is integer 0-65,535/null, and
`usernameFragment` is string/null when present. Nonempty candidates require at
least one non-null routing field. Empty string/null support end-of-candidates.

Target socket IDs and negotiation IDs are 1-64 ASCII letters/digits/`_`/`-`.
Generate a fresh negotiation UUID per offer; echo it in the answer and associated
ICE. Description type must match the event; SDP must be nonblank without NUL.
SDP: at most 65,536 UTF-16 code units and UTF-8 bytes. ICE candidate string: at most
4,096 code units/bytes, no NUL/CR/LF. `sdpMid`/`usernameFragment`: at most 256 UTF-8
bytes each. Signaling JSON: at most 73,728 UTF-8 bytes, including escaping.

Only the target receives the same event name, containing the validated request
plus `sender: { userId, socketId }` derived by the server. Other tabs receive no
copy. Both peers must remain authorized and actively joined to the same meeting.
Success ack:

```js
{ ok: true, data: { forwarded: true, meetingId, targetSocketId, negotiationId } }
```

This confirms server emission only, not recipient receipt or successful peer/media
connection. There is no signaling deduplication/replay/state machine. Do not blindly
retry timed-out SDP/ICE. Refresh peers or restart negotiation as browser state requires.

Offers/answers share a user budget of burst 20, refill 2/second. ICE has a separate
burst 200, refill 40/second. These budgets span tabs/reconnects. Every meeting/chat/
signaling request shares a 16-operation per-socket queue: bound client concurrency
(for example four in flight) and pace ICE rather than flooding the queue.

## Error and reconnect handling

- **Handshake:** `connect_error` has `message` and `data: { code, retryable }`.
  Codes: `AUTH_REQUIRED`, `AUTH_INVALID`, `AUTH_EXPIRED`, `AUTH_UNAVAILABLE`.
  Only `AUTH_UNAVAILABLE` is retryable.
- **Active expiry:** best-effort `auth:error { code: "AUTH_EXPIRED", message,
  retryable: false }`, followed by forced disconnect. Get a valid JWT through the
  existing auth flow, replace `socket.auth`, explicitly reconnect, then rejoin.
- **Request failure:** `{ ok: false, error: { code, message, retryable,
  retryAfterMs? } }`; `retryAfterMs` occurs only for chat/signaling rate limits.
  Busy/unavailable/rate errors permit bounded backoff, subject to current state.
  Do not automatically retry access denial or stale signaling.
- **Access errors:** `INVALID_REQUEST`, `INVALID_MEETING_ID`, `AUTH_*`,
  `SOCKET_DISCONNECTED`, and the documented `MEETING_*` codes. `MEETING_BUSY` and
  `MEETING_UNAVAILABLE` are retryable. Follow REST enrollment for
  `MEETING_ENROLLMENT_REQUIRED`; stop sends for ended/forbidden meetings.
- **Chat errors:** `CHAT_INVALID_PAYLOAD`, `CHAT_INVALID_MESSAGE_ID`,
  `CHAT_INVALID_TEXT`, `CHAT_TOO_LARGE`, `CHAT_DUPLICATE_CONFLICT`,
  `CHAT_RATE_LIMITED`, `CHAT_BUSY`, `CHAT_UNAVAILABLE` (last three retryable).
- **Signaling errors:** `WEBRTC_INVALID_PAYLOAD`, `WEBRTC_TOO_LARGE`,
  `WEBRTC_INVALID_TARGET`, `WEBRTC_TARGET_UNAVAILABLE`, `WEBRTC_RATE_LIMITED`,
  `WEBRTC_BUSY`, `WEBRTC_UNAVAILABLE` (last three retryable). Target-unavailable
  deliberately hides target policy/account details; refresh the roster.
- **Ack timeout/transport loss:** outcome is uncertain, not a structured rejection.
  Disable sends while offline/unjoined. Socket.IO may otherwise buffer old events.
  After reconnect, discard old peer IDs, pending signals, ICE queues, and peer
  connections; reset room state, explicitly rejoin, and negotiate afresh.

Browser code owns camera/mic permissions, `addTrack`, local/remote descriptions,
perfect negotiation for collisions, bounded early-ICE queues, renegotiation,
`ontrack`, playback/autoplay handling, and stopping tracks/closing peers on exit.
See the [Phase 7 verification checklist](phase7-browser-checklist.md).

## Outstanding coordination

[Issue #1](https://github.com/Niket224/IntellMeet/issues/1) remains open pending
Developer 1 review. Immediate workspace revocation and REST meeting-end eviction
are not implemented; `meeting:ended` and `meeting:access-revoked` are proposals,
not existing emitted events. Request-time checks do not revoke already established
browser media or make database policy checks and forwarding atomic. Existing chat
may still reach passive revoked sockets until removal/refresh/disconnect.
Non-workspace prototype REST admission is not private. Initial deployment is one
Node process. No REST policy/controller/model changes are part of this handoff.
