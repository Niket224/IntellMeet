# WebRTC signaling - Phase 6

This backend relays bounded signaling messages between individual sockets in an
authorized, live meeting. Browsers own RTCPeerConnection and transport their data
and media directly. Socket.IO carries no video/audio. There are no new REST
routes, models, dependencies, database writes, or persistent signaling queues.

## Connection and peer identity

1. Obtain the existing REST JWT and connect with `auth: { token }` as documented in
   [socket-authentication.md](socket-authentication.md).
2. Enroll through REST, then explicitly send `meeting:join` with an acknowledgment
   using [socket-meetings.md](socket-meetings.md). Both peers must do this.
3. Install signaling listeners before creating an offer. Discover individual peer
   socket IDs in the join acknowledgment or `meeting:participants` snapshot.
4. Use one RTCPeerConnection per remote **socket ID**, including separate tabs of
   the same user. Exclude your own current socket ID.
5. Send only while connected and successfully joined. Do not configure automatic
   Socket.IO retries for signaling. On reconnect, use a valid token, explicitly
   rejoin, refresh the roster, discard old connections/candidates, and negotiate
   anew with the new socket IDs. There is no automatic room recovery/replay.

## Exact request schemas

Every request requires an acknowledgment callback. Requests without one are
ignored. Extra fields, including any supplied sender identity, are rejected.

### `webrtc:offer` and `webrtc:answer`

```js
{
  meetingId: "65abcdef0123456789abcdef",
  targetSocketId: "current-target-socket-id",
  negotiationId: "uuid-created-for-this-offer",
  description: { type: "offer", sdp: "v=0\r\n..." }
}
```

Use `type: "answer"` for `webrtc:answer`. Only `type` and `sdp` are accepted inside
`description`; rollback/pranswer are browser-local states, not server events.

- `meetingId`: 24-hex MongoDB ID, normalized to lowercase.
- `targetSocketId`: case-sensitive 1-64 ASCII letters/digits/`_`/`-`. Must be another
  currently connected, authorized socket in the same active meeting.
- `negotiationId`: case-sensitive 1-64 ASCII letters/digits/`_`/`-`. The offerer
  generates a fresh UUID per negotiation; the answer and associated ICE use it.
  This is correlation metadata, not a server-issued permission or deduplication
  key. The server does not maintain an offer/answer state machine.
- `sdp`: nonblank string, no NUL, maximum **65,536 UTF-16 code units and 65,536
  UTF-8 bytes**. Its content is preserved, not parsed or logged. Browsers validate
  its actual SDP syntax and semantics in `setRemoteDescription`.

### `webrtc:ice-candidate`

```js
{
  meetingId: "65abcdef0123456789abcdef",
  targetSocketId: "current-target-socket-id",
  negotiationId: "same-id-as-the-associated-offer",
  candidate: {
    candidate: "candidate:1 1 UDP 2122260223 192.0.2.1 5000 typ host",
    sdpMid: "0",
    sdpMLineIndex: 0,
    usernameFragment: "optional-ice-generation"
  }
}
```

`candidate` may instead be `null` for end-of-candidates. For an object:

- `candidate`, `sdpMid`, and `sdpMLineIndex` are required; `usernameFragment` is the
  only optional field. Use `RTCIceCandidate.toJSON()` and retain null routing fields.
- Candidate string maximum: **4,096 UTF-16 code units and 4,096 UTF-8 bytes**, no
  NUL/CR/LF. `""` is an end-of-candidates marker.
- `sdpMid`: null or string of at most 256 UTF-8 bytes.
- `sdpMLineIndex`: null or integer from 0 through 65,535. A nonempty candidate
  must provide at least one non-null routing field.
- `usernameFragment`: absent, null, or string of at most 256 UTF-8 bytes. Use this
  to distinguish ICE generations in renegotiation/ICE restart.

The normalized JSON request for any event must fit **73,728 UTF-8 bytes (72 KiB)**,
including JSON escaping. Binary payloads and unknown nested keys are rejected.
Transport-level oversized packets may disconnect before an application ack;
the application's bounds do not replace Socket.IO's transport packet limit.

## Recipient notifications and acknowledgments

The selected target receives the **same event name** and validated request fields,
plus a server-derived sender:

```js
{
  meetingId, targetSocketId, negotiationId, description, // or candidate
  sender: { userId: "trusted-mongodb-user-id", socketId: "current-sender-socket-id" }
}
```

No broadcast, room-wide notification, echo to the sender, or forwarding to the
target user's other tabs occurs. There is no recipient acknowledgment protocol.

Successful acknowledgment to the sender:

```js
{
  ok: true,
  data: { forwarded: true, meetingId, targetSocketId, negotiationId }
}
```

This means the server validated and emitted to the live target socket. It does
**not** confirm receipt, remote SDP acceptance, ICE connectivity, or successful
peer connection. The notification can arrive before the sender's ack. A disconnect
after emission can still lose the signal. No delivery retry, deduplication, or
replay is implemented. Sending the same payload twice forwards it twice. On ack
timeout, do not blindly retransmit a stale SDP/candidate; reconcile browser state
or rebuild the peer connection and start a fresh negotiation. Socket.IO's default
[delivery guarantees](https://socket.io/docs/v4/delivery-guarantees/) apply.

## Errors

```js
{
  ok: false,
  error: { code: "WEBRTC_RATE_LIMITED", message: "Signaling rate limit exceeded",
    retryable: true, retryAfterMs: 25 }
}
```

`retryAfterMs` is included only for `WEBRTC_RATE_LIMITED`. Retryable means a later
new request may work; it is not permission to replay stale negotiation state.

| Code | Meaning | Retryable |
| --- | --- | --- |
| `WEBRTC_INVALID_PAYLOAD` | Wrong envelope, negotiation ID, SDP type/content, or ICE shape | false |
| `WEBRTC_TOO_LARGE` | Field or JSON envelope exceeds a documented size bound | false |
| `WEBRTC_INVALID_TARGET` | Malformed socket ID or target is this socket | false |
| `WEBRTC_TARGET_UNAVAILABLE` | Target is missing, disconnected, expired, unauthorized, not in this room, or changed membership during validation | false |
| `WEBRTC_RATE_LIMITED` | User's description or ICE budget exhausted | true |
| `WEBRTC_BUSY` | Shared per-socket request queue is full | true |
| `WEBRTC_UNAVAILABLE` | Database/internal failure or rate-state capacity reached | true |

Sender failures reuse the existing meeting codes: `INVALID_MEETING_ID`,
`AUTH_REQUIRED`, `AUTH_INVALID`, `AUTH_EXPIRED`, `SOCKET_DISCONNECTED`,
`MEETING_NOT_JOINED`, `MEETING_NOT_FOUND`, `MEETING_ENROLLMENT_REQUIRED`,
`MEETING_FORBIDDEN`, `MEETING_NOT_LIVE`, and `MEETING_ENDED`. Their messages and
retryability follow the meeting contract. Expiry/disconnect during a request may
prevent the ack from arriving; handle `auth:error`, `disconnect`, and ack timeout.
Target policy/account failures use only `WEBRTC_TARGET_UNAVAILABLE`, without
disclosing a target's private account or workspace status. Internal exceptions
never return database details, stacks, tokens, SDP, or ICE contents.

## Authorization, ordering, rate limits, and cleanup

The existing authenticated identity/expiry is checked on admission and each
request. Authorization reuses the Phase 4 policy for **both** sender and target:
persisted REST enrollment, live meeting, current workspace membership (existing
host exception), and existing User. Both must have actual room and presence
membership. No alternative authorization policy is introduced.

Signaling, chat, join, leave, and roster operations use the same per-socket FIFO
queue, with **16 total pending/running requests**. A leave queued first prevents a
later signal; a signal queued first can finish before a later leave. Disconnects
remove presence immediately and invalidate in-flight sends. Target leaves have
their own queue and can run during sender authorization. A monotonic membership
generation changes on each fresh join; a final check rejects even leave/rejoin
to the same room with the same socket. Duplicate joins do not change generation.
Do not send a burst of hundreds of unacknowledged requests: pace candidate sends,
limit client concurrency (for example four in flight), and bound the client queue.

Per authenticated user across tabs, devices, meetings, and reconnects in this
process:

| Budget | Initial burst | Refill |
| --- | --- | --- |
| Offers + answers combined | 20 | 2 per second |
| ICE events, including end markers | 200 | 40 per second |

These budgets are independent of chat. Structurally valid requests from joined
sockets consume budget before target/DB checks, including failed target attempts.
Limits do not bypass the 16-request queue. State is capped at 1,024 users; excess
new users fail closed with `WEBRTC_UNAVAILABLE`. Idle metadata expires after five
minutes and is pruned opportunistically; shutdown clears it. No payload, socket
reference, peer graph, deduplication cache, or per-user timer is retained. These
prototype limits require load measurement before larger mesh meetings.

## Developer 2: browser negotiation responsibilities

Maintain a serialized browser-side operation queue per RTCPeerConnection. Server
request order does not serialize asynchronous `setRemoteDescription` calls in
client listeners, nor impose an order between different senders.

- **Offer collisions:** implement the browser
  [perfect negotiation pattern](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation).
  Choose a stable polite peer for each current socket pair (for example,
  `localSocketId > remoteSocketId` with ASCII comparison). Track `makingOffer`,
  `isSettingRemoteAnswerPending`, and ignored-offer state. The polite side accepts
  a colliding offer using browser rollback; the impolite side ignores it. The
  server deliberately permits simultaneous offers and performs no rollback.
- **Correlation:** use a fresh negotiation ID for each offer and echo it on the
  answer and associated ICE from either side. Track local/remote descriptions
  and ICE username fragments per peer. Discard answers for superseded offers and
  candidates associated with ignored offers or stale ICE generations. Do not
  overwrite a pending offer's ID before its own candidates have been classified.
- **Early ICE:** asynchronously setting the remote description takes time even
  if packets arrived in order. Queue candidates by sender socket, negotiation ID,
  and ICE generation until the associated remote description is installed. Then
  drain in order via `addIceCandidate`, including null/empty end markers. Bound
  queue length/lifetime and discard it on teardown. See
  [addIceCandidate](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/addIceCandidate).
- **Renegotiation:** handle `negotiationneeded` through perfect negotiation.
  Correlate ICE restarts with new SDP/username fragments and a fresh offer ID;
  changing tracks or starting renegotiation remains entirely browser-side.
- **Reconnect/leave:** close old peer connections and clear pending operations.
  Reauthenticate if needed, explicitly rejoin, consume the fresh roster, create
  new peer connections, and renegotiate. Never reuse stale target IDs or replay
  offline-buffered signaling. Recheck `socket.connected` and joined state before
  each emit; disable automatic retries. Remove a peer when its socket leaves the
  roster even if another socket of that user remains.
- **Connection success:** use browser `connectionState`, ICE state, remote track
  events/data channel opening, and error handling. A forwarding ack is insufficient.
  Handle permission requests and media tracks in React; no media backend is added.

Small send example (within Developer 2's existing implementation):

```js
async function forwardDescription(socket, meetingId, targetSocketId, negotiationId, pc) {
  if (!socket.connected) throw new Error("Reconnect and rejoin before signaling");
  const { type, sdp } = pc.localDescription;
  const result = await socket.timeout(5000).emitWithAck(`webrtc:${type}`, {
    meetingId, targetSocketId, negotiationId, description: { type, sdp }
  });
  if (!result.ok) throw new Error(result.error.code); // handle code in React UI
  return result.data.forwarded; // not proof that the peer connected
}
```

## Pending integration and practical limits

[GitHub Issue #1](https://github.com/Niket224/IntellMeet/issues/1) stays open.
Immediate workspace revocation and REST meeting-end eviction/notifications are
**not implemented**. Signaling checks passive targets on every forwarding attempt,
but that is not a lifecycle subscriber or immediate eviction. Existing chat may
still reach passive revoked recipients until removal/refresh/disconnect. Already
established browser media/data connections are not closed by this backend; the
frontend must close them when future lifecycle notifications are integrated.

Database checks and emission are not an atomic transaction: a policy change just
after its check can race with an in-flight signal. Future lifecycle hooks must
invalidate pending signals as well as admissions/chat and remove passive sockets.
The membership generation protects local leave/rejoin races; it does not close
this database notification gap. Developer 1's files/policies remain unchanged.
Non-workspace prototype REST admission is still open to authenticated users who
know the ID; it is not private admission.

Deployment remains one Node process with local presence/rate metadata. No
cross-process adapter, SFU, TURN service, screen sharing, recording, transcription,
AI, or chat persistence is added. Server tests use real Socket.IO transports and
synthetic SDP/ICE; they do not prove browser SDP compatibility, NAT traversal, or
media connectivity. Use [the two-browser smoke guide](webrtc-manual-test.md) and
test the React perfect-negotiation implementation separately.

## Tests

From `backend/`:

```powershell
npm test
npm run test:webrtc
$env:TEST_MONGODB_URI = 'mongodb://127.0.0.1:27017/intellimeet_phase6_test_' + [Guid]::NewGuid().ToString('N')
npm run test:webrtc:integration
```

The MongoDB suite skips without `TEST_MONGODB_URI`. It requires the shown dedicated
prefix and validates the actual connected database before dropping it at teardown.
Run existing chat, meeting, authentication, and REST suites with their own prefixes
as documented in their contracts.
