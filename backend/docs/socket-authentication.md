# Socket authentication — Phase 3

The backend uses one HTTP server for Express and Socket.IO. Socket connections
now require the same JWT issued by the existing REST registration/login APIs.
REST authentication, token generation, models, and meeting policies are unchanged.

Phase 4 meeting rooms use this authentication contract; their event and presence
contract is documented in [socket-meetings.md](socket-meetings.md).

## Connection payload for Developer 2

```js
const socket = io("http://localhost:5000", {
  auth: { token: tokenFromLogin }
});

socket.on("connect_error", (error) => {
  console.log(error.message, error.data.code, error.data.retryable);
});

socket.on("auth:error", (error) => {
  // AUTH_EXPIRED: obtain a new valid token before reconnecting.
  console.log(error.code);
});

socket.on("disconnect", (reason) => {
  // "io server disconnect" requires an explicit reconnect with valid credentials.
});

// After obtaining a new valid token from the existing authentication flow:
socket.auth = { token: newToken };
socket.connect();
```

Send a bare JWT in `auth.token`, without a `Bearer ` prefix. Query parameters,
HTTP Authorization headers, client-supplied user IDs, names, and roles are not
accepted as socket credentials or identity. The server reads only the verified
`id` claim, retrieves the User, and sets `socket.data.user = { id }` from MongoDB.
It stores only the verified expiration time in `socket.data.auth.expiresAt`.

The verifier accepts HS256, matching the current token generator. Tokens must
contain a valid MongoDB user ID and an integer `exp` claim representable in
milliseconds. Missing-expiry tokens are rejected because they cannot enforce
the active-session expiry requirement. Tokens longer than 8192 characters are
rejected. No socket-specific token issuer or refresh endpoint is introduced.

## Error contract

A rejected handshake produces `connect_error` with a safe `message` and
`data: { code, retryable }`:

| Code | Message | Retryable |
| --- | --- | --- |
| `AUTH_REQUIRED` | Authentication required | false |
| `AUTH_INVALID` | Invalid authentication token | false |
| `AUTH_EXPIRED` | Authentication token expired | false |
| `AUTH_UNAVAILABLE` | Authentication temporarily unavailable | true |

`AUTH_INVALID` covers malformed tokens/claims, invalid signatures, unsupported
algorithms, tokens not yet valid, and deleted or missing users. Database errors
and unavailable server secret configuration fail closed as `AUTH_UNAVAILABLE`.
No token, secret, database details, or exception stack is returned to the client.
For retryable failures, use bounded retries with backoff rather than a tight loop.

## Active expiration

Expiration is checked after the database lookup and again on connection. A timer
disconnects an admitted socket at its verified expiry, even if it is idle. Long
delays are checked in bounded chunks to respect Node.js timer limits. Incoming
socket events also check expiry in case the event loop delayed the timer.
All expiry timers are cleared on disconnect/server shutdown.

On expiry the server emits, on a best-effort basis:

```json
{
  "code": "AUTH_EXPIRED",
  "message": "Authentication token expired",
  "retryable": false
}
```

It then forcibly disconnects the transport. The disconnect enforces expiration;
delivery of the notification is not guaranteed after a network failure. Changing
`socket.auth` on an existing connection does not extend its verified lifetime.
Use a new valid token and explicitly reconnect. Timer execution follows the Node
event loop; the incoming-event check blocks expired events if a timer is delayed.

## Coordination notes for Developers 1 and 2

Decisions A–I are provisionally accepted with the user's qualifications:

| Decision | Agreed direction / work deferred to relevant phase |
| --- | --- |
| A | REST join owns persisted enrollment/start; socket join later manages active presence and rechecks authorization. Coordinate the frontend sequence and shared checks. |
| B | Preserve existing non-workspace access for the prototype. Any authenticated user knowing the ID can currently join; this is **not private admission**. |
| C | Workspace revocation must eventually evict active sockets, including passive recipients. Event-time checks alone cannot accomplish immediate passive-recipient eviction; coordinate a revocation notification with Developer 1. |
| D | Preserve the existing ability of an authorized REST join to start a scheduled meeting early. |
| E | Host disconnect alone does not end a meeting. Coordinate a post-persistence REST-end notification before implementing socket eviction/room cleanup. |
| F | Multiple tabs/devices per user, separate peers per socket, one active meeting per socket in the planned room implementation. |
| G | Explicit reauthentication/rejoin and fresh peer setup on reconnect; planned immediate disconnect cleanup. |
| H | **Implemented here:** active JWT expiry. User existence is checked on every new socket connection. Immediate account-deletion eviction still requires a Developer 1 notification hook; it is not implemented in this phase. |
| I | One Node.js process initially. Multi-process presence and lifecycle distribution remain future work. |

No shared meeting policy changes are included in Phase 3. Developer 1 retains
REST authentication and lifecycle ownership; Developer 2 needs the handshake,
error, and reconnect contract above. These notes are a handoff for review, not a
record that either developer has reviewed or approved code changes.

## Tests

From `backend/`:

```powershell
npm test
npm run test:auth

# Uses a local MongoDB instance and creates/drops a unique test database.
$env:TEST_MONGODB_URI = 'mongodb://127.0.0.1:27017/intellimeet_phase3_test_' + [Guid]::NewGuid().ToString('N')
npm run test:auth:integration

$env:TEST_MONGODB_URI = 'mongodb://127.0.0.1:27017/intellimeet_phase2_test_' + [Guid]::NewGuid().ToString('N')
npm run test:rest
```

Integration suites skip when `TEST_MONGODB_URI` is absent. They require their
dedicated database-name prefixes and validate the connected database before
cleanup. Never point them at an application database.

Meeting rooms and participant presence are implemented separately in Phase 4.
Phase 5 chat is documented in [socket-chat.md](socket-chat.md).
Phase 6 signaling is documented in [socket-webrtc.md](socket-webrtc.md).
WebRTC media processing, AI, and transcription remain outside the implemented scope.
