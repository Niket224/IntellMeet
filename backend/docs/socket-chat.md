# Real-time chat - Phase 5

Chat uses the existing authenticated Socket.IO connection and Phase 4 meeting
rooms. No REST controller, meeting model, authentication policy, or database write
is added. There is no message history, replay endpoint, recording, or persistence.

## Client sequence

1. Obtain a token using the existing REST login/registration flow.
2. Connect with `auth: { token }` as described in
   [socket-authentication.md](socket-authentication.md).
3. Follow REST enrollment and explicitly join the socket meeting as described in
   [socket-meetings.md](socket-meetings.md).
4. Install a `chat:message` listener before sending. Send only while connected and
   after a successful room join. A broadcast can arrive before its acknowledgment.

## Events and schemas

### Client -> server: `chat:send`

Send exactly these three fields plus an acknowledgment:

```json
{
  "meetingId": "65abcdef0123456789abcdef",
  "clientMessageId": "a-unique-id-for-this-submission",
  "text": "Hello everyone"
}
```

- `meetingId`: 24-hex MongoDB ID, normalized to lowercase.
- `clientMessageId`: case-sensitive 1-64 ASCII letters, digits, `_`, or `-`.
  Generate a fresh UUID for each new submission. Retain that ID when retrying it.
- `text`: string, trimmed at its edges. Internal tabs/newlines are preserved.
  Blank text and control characters other than tab, LF, and CR are rejected.
- Raw text limits: **2,000 UTF-16 code units and 4,096 UTF-8 bytes**. The entire
  JSON request must also fit within **8,192 UTF-8 bytes**, including escaping.
- Extra fields, including client-supplied sender IDs, roles, IDs, or timestamps,
  are rejected. Requests without an acknowledgment do not change state or publish.

Successful acknowledgment:

```json
{
  "ok": true,
  "data": {
    "duplicate": false,
    "message": {
      "id": "88042825-bcbb-477f-92a0-45d24415babc",
      "clientMessageId": "a-unique-id-for-this-submission",
      "meetingId": "65abcdef0123456789abcdef",
      "sender": { "userId": "507f1f77bcf86cd799439011" },
      "text": "Hello everyone",
      "sentAt": "2026-10-17T00:00:00.000Z"
    }
  }
}
```

The server generates `id` with a UUID, derives the sender from trusted socket
identity, and generates `sentAt` in UTC. Clients do not control those fields.

### Server -> meeting room: `chat:message`

The event payload is the `message` object above, without the acknowledgment
wrapper. It goes to the currently joined `meeting:<id>` room, including the
sender and that sender's other joined tabs/devices. It is not broadcast globally.
Sender names/profiles can be mapped from existing authorized REST data; no email,
JWT, password, or client-supplied identity is attached.

Text is **plain text, not sanitized HTML**. Developer 2 must render it as text
(for example, a React string child or `textContent`), never as raw HTML or with
`dangerouslySetInnerHTML`. HTML-looking text is intentionally preserved literally.

## Authorization and operation ordering

Every attempt requires trusted authentication and current socket presence in the
requested room. The handler reuses Phase 4's database authorization: persisted
enrollment, live/non-ended meeting, current workspace membership or the existing
host exception, and current account existence. It rechecks active room/session
membership after asynchronous work before publishing or returning a duplicate.
Discovery of sender access loss uses Phase 4's requesting-socket eviction.

Chat and meeting requests share one bounded per-socket queue. Sends arriving
before leave complete first; sends arriving after leave are rejected. A pending
send cannot publish after that socket disconnects or expires while awaiting DB
authorization. Concurrent tabs share rate/deduplication state, but have separate
socket queues. Acceptance order across different sockets follows authorization
completion, not a promised global client-send order. Timestamps are not sequence
numbers.

## Message IDs, duplicate submissions, and delivery

The retry key is `(authenticated user ID, meeting ID, clientMessageId)`.
After authorization, an identical normalized text retry returns the original
server message ID/timestamp with `duplicate: true` and does not broadcast again.
Reusing that key with different text returns `CHAT_DUPLICATE_CONFLICT`.

The duplicate cache is **temporary memory**, retained across leave/rejoin and
reconnect in the same server instance. Entries expire after five minutes; the
cache holds at most 2,048 accepted messages server-wide and evicts the oldest
entry when full. A retry after expiry, eviction, or process restart can become a
new message. This is bounded duplicate suppression, not durable exactly-once
delivery. The cache is not a history API; late joiners receive no old messages.

An acknowledgment means server acceptance, not that every browser displayed the
message. Delivery is best-effort; disconnected recipients miss events and receive
no replay on reconnect. See the official
[Socket.IO delivery guarantees](https://socket.io/docs/v4/delivery-guarantees/).
Deduplicate the acknowledgment and received event by server `message.id` in the
UI so the sender does not display the same message twice.

## Rate limiting and cleanup

- User-wide token bucket across all sockets/meetings: burst of **10** eligible
  attempts, then refill **one token per second**, up to 10.
- Valid, joined attempts count even if duplicate, conflicting, or subsequently
  rejected by database authorization. Invalid payloads and non-joined attempts
  are rejected before consuming a token.
- Rate timing uses a monotonic clock rather than the wall-clock message timestamp.
- Leaving, switching rooms, or reconnecting does not reset the user bucket.
- At most 1,024 user buckets are retained; a new bucket at capacity fails safely
  with `CHAT_UNAVAILABLE`. Buckets idle for five minutes are eligible for cleanup.
- Idle/expired state is pruned opportunistically on attempts, and a cache lookup
  always rejects an expired entry. There are no per-socket cache references or
  cleanup timers. Bounded idle state can remain until the next attempt or shutdown.
- Closing the HTTP server clears all chat state. Restart loses both rate and
  duplicate memory. This implementation assumes the agreed single server process.
- The shared queue accepts at most 16 pending operations per socket. Disconnect
  cleanup is immediate once detected, regardless of queued database work.

## Error acknowledgments

```json
{
  "ok": false,
  "error": {
    "code": "CHAT_RATE_LIMITED",
    "message": "Chat rate limit exceeded",
    "retryable": true,
    "retryAfterMs": 1000
  }
}
```

| Code | Meaning / action |
| --- | --- |
| `CHAT_INVALID_PAYLOAD` | Supply exactly the three documented fields. |
| `CHAT_INVALID_MESSAGE_ID` | Supply a valid client submission ID. |
| `CHAT_INVALID_TEXT` | Supply nonblank valid plain text. |
| `CHAT_TOO_LARGE` | Reduce the text/payload size. |
| `CHAT_DUPLICATE_CONFLICT` | Use a new client ID for intentionally different text. |
| `CHAT_RATE_LIMITED` | Retry after at least `retryAfterMs`; avoid a tight retry loop. |
| `CHAT_BUSY` | Shared socket queue is full; retry with backoff. |
| `CHAT_UNAVAILABLE` | Safe generic database/operation/capacity failure; retry with backoff. |
| Phase 4 `MEETING_*` / `AUTH_*` codes | Follow the existing room/authentication contract; leave, reauthenticate, or regain admission as appropriate. |

Only the three chat rate/busy/unavailable errors are retryable. Access errors use
the existing room error contract. No database exception, stack, credential, or
token is returned. JWT expiration can disconnect the transport before a pending
request is acknowledged; an acknowledgment timeout is not proof of rejection.

## Small Developer 2 example

```js
// Use the existing authenticated socket after REST enrollment and room join.
const seen = new Set();
function displayOnce(message) {
  if (seen.has(message.id)) return;
  seen.add(message.id); // Bound this set with the UI's message list lifetime.
  renderAsText(message); // App-owned React/text rendering, never raw HTML.
}
socket.on("chat:message", (message) => {
  if (message.meetingId === activeMeetingId) displayOnce(message);
});

const submission = {
  meetingId: activeMeetingId,
  clientMessageId: crypto.randomUUID(),
  text: inputText
};

async function submitOrRetrySameMessage() {
  if (!socket.connected || joinedMeetingId !== submission.meetingId) return;
  try {
    const reply = await socket.timeout(5000).emitWithAck("chat:send", submission);
    if (reply.ok) displayOnce(reply.data.message);
    else showSendError(reply.error); // Honor retryAfterMs/backoff; no tight loop.
  } catch {
    showUncertainDelivery(); // After rejoin, retry the SAME submission ID/text.
  }
}
```

Do not emit while offline: Socket.IO may buffer client events and flush them
before your application has rejoined the room. Reauthenticate and explicitly
rejoin before retrying. On leave/disconnect, clear active-room UI/send state and
ignore events from a previous room. This example does not replace the React app.

## Pending Issue #1 and privacy limits

[GitHub Issue #1](https://github.com/Niket224/IntellMeet/issues/1) remains open.
Immediate workspace revocation, passive-recipient eviction, and REST meeting-end
notification/eviction are not implemented. Sender checks happen at send time;
a previously admitted passive socket may continue receiving chat after workspace
revocation until a request discovers access loss or disconnect/expiry removes it.
Database authorization and emission are not atomic, so lifecycle changes can
also race after a successful read. The pending hooks must invalidate in-flight
chat sends as well as room admissions and remove passive recipients before
future broadcasts. No shared-controller or policy integration is claimed here.

Prototype non-workspace admission remains open to authenticated users knowing the
meeting ID through REST; it is not private admission. Developer 1 retains control
of REST lifecycle/membership policies. Developer 2 needs manual browser tests for
plain-text display, duplicate UI suppression, retry timing, and network loss.

## Testing

From `backend/`:

```powershell
npm test
npm run test:chat
$env:TEST_MONGODB_URI = 'mongodb://127.0.0.1:27017/intellimeet_phase5_test_' + [Guid]::NewGuid().ToString('N')
npm run test:chat:integration

# Existing regression suites, each with its own unique test database prefix:
$env:TEST_MONGODB_URI = 'mongodb://127.0.0.1:27017/intellimeet_phase4_test_' + [Guid]::NewGuid().ToString('N')
npm run test:meeting:integration
$env:TEST_MONGODB_URI = 'mongodb://127.0.0.1:27017/intellimeet_phase3_test_' + [Guid]::NewGuid().ToString('N')
npm run test:auth:integration
$env:TEST_MONGODB_URI = 'mongodb://127.0.0.1:27017/intellimeet_phase2_test_' + [Guid]::NewGuid().ToString('N')
npm run test:rest
```

Integration suites skip without `TEST_MONGODB_URI`, require their dedicated
database-name prefix, and validate the connected database before cleanup.
No WebRTC signaling, AI, transcription, recording, or message persistence is
implemented in Phase 5. Phase 6 signaling is documented separately in
[socket-webrtc.md](socket-webrtc.md) and shares meeting/chat request ordering.
