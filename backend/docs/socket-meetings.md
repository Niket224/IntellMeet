# Meeting rooms and presence - Phase 4

This contract adds transient rooms to the authenticated Socket.IO server. It does
not change REST enrollment, meeting lifecycle, workspace policy, or persisted
participants. Authentication and active JWT expiry are described in
[socket-authentication.md](socket-authentication.md).
Phase 5 chat reuses these room/session checks and the same per-socket operation
queue; its contract is in [socket-chat.md](socket-chat.md).

## Admission and lifecycle ownership

Developer 2 should call `POST /api/meetings/:id/join` with the existing REST bearer
token before emitting `meeting:join`. The socket handler requires:

1. A currently connected, authenticated socket with an unexpired JWT.
2. A valid meeting ID and existing meeting.
3. The authenticated user in `Meeting.participants`.
4. A live meeting. Scheduled meetings must be activated through REST; ended
   meetings are rejected.
5. Current workspace membership, when applicable, with the existing REST host
   exception preserved.
6. The User still existing in MongoDB.

Persisted participants are the existing enrollment record. REST creation already
enrolls the host. The model does not record whether that host separately called
the REST join endpoint; no extra enrollment flag is introduced here. Clients
should still follow REST join first. Socket entry never starts a meeting or adds
the user to persisted participants.

For the prototype, a non-workspace meeting can still be joined through REST by
any authenticated user knowing its ID. This is **not private admission**.

## Requests and acknowledgments

Every request accepts exactly `{ meetingId: "<24-hex MongoDB ID>" }` plus an
acknowledgment callback. IDs are normalized to lowercase. Additional identity,
role, or other fields are rejected. A request without an acknowledgment is
ignored and changes nothing.

### `meeting:join`

```js
const result = await socket.timeout(5000).emitWithAck("meeting:join", { meetingId });
```

Successful acknowledgment:

```json
{
  "ok": true,
  "data": {
    "meetingId": "65abcdef0123456789abcdef",
    "socketId": "current-socket-id",
    "joined": true,
    "revision": 1,
    "participants": [
      { "userId": "507f1f77bcf86cd799439011", "socketIds": ["current-socket-id"] }
    ]
  }
}
```

A duplicate join to the current meeting rechecks authorization and returns
`joined: false` with the current snapshot. It does not duplicate a peer, advance
the revision, or broadcast another roster. A socket must leave its current
meeting before joining another; its other tabs/devices may join independently.

### `meeting:leave`

The same request shape returns:

```json
{ "ok": true, "data": { "meetingId": "65abcdef0123456789abcdef", "left": true } }
```

Leaving while already outside all meetings succeeds with `left: false`. Leaving
a different meeting while currently in one returns `MEETING_NOT_JOINED` and
preserves the actual membership. Leave does not require a database lookup, so an
authenticated client can clean up after a meeting ends or the database fails.

### `meeting:roster`

The same request shape returns `ok: true` with `data` containing `meetingId`,
`revision`, and `participants`. It requires active membership in that meeting
and repeats database authorization. An outsider cannot fetch another room's
roster. If refresh or duplicate join discovers access loss, the requesting socket
is removed from that room before its error acknowledgment.

### Errors

```json
{
  "ok": false,
  "error": {
    "code": "MEETING_ENROLLMENT_REQUIRED",
    "message": "Join the meeting through the REST API first",
    "retryable": false
  }
}
```

| Code | Meaning |
| --- | --- |
| `INVALID_REQUEST` | Payload must contain only `meetingId`. |
| `INVALID_MEETING_ID` | ID is not a 24-hex string. |
| `AUTH_REQUIRED` / `AUTH_INVALID` / `AUTH_EXPIRED` | Trusted session is absent, account is gone, or JWT expired. |
| `MEETING_NOT_FOUND` | Meeting does not exist. |
| `MEETING_ENROLLMENT_REQUIRED` | User is absent from persisted participants. |
| `MEETING_FORBIDDEN` | Current workspace admission check failed. |
| `MEETING_ENDED` / `MEETING_NOT_LIVE` | Lifecycle does not allow entry or refresh. |
| `MEETING_CONFLICT` | Socket already occupies another meeting. |
| `MEETING_NOT_JOINED` | Socket has not joined the requested meeting. |
| `MEETING_BUSY` | The per-socket queue already has 16 pending requests; retry with backoff. |
| `MEETING_UNAVAILABLE` | Safe generic operation/database failure; retry with backoff. |

Only `MEETING_BUSY` and `MEETING_UNAVAILABLE` are retryable. Database exception
details and stacks are never placed in acknowledgments. At JWT expiry, transport
disconnection takes precedence over delivering a pending request acknowledgment.
An acknowledgment timeout does not prove the operation failed; an idempotent
join/leave retry reconciles state after a lost acknowledgment.

## Roster broadcasts

`meeting:participants` is sent only to the affected `meeting:<id>` room:

```json
{
  "meetingId": "65abcdef0123456789abcdef",
  "revision": 2,
  "participants": [
    { "userId": "507f1f77bcf86cd799439011", "socketIds": ["tab-one", "tab-two"] }
  ]
}
```

There is one visible participant per user, with each socket ID preserved for
future peer targeting. A user disappears only after their last socket leaves.
Roster entries expose no email, password, JWT, or client-supplied profile fields.
Developer 2 can map user IDs to profiles from the existing authorized REST data.

Install roster listeners before joining: the broadcast can arrive before the
join acknowledgment. Reconcile full snapshots by revision and meeting ID;
ignore updates for a meeting the UI has left. Revisions increase for every
socket addition/removal within one server instance, including changes to a
user's tab set. Duplicate joins do not advance them. Empty rooms are deleted;
rejoining an emptied room still receives a newer revision in the same instance.

## State, ordering, and reconnect

The initializer creates one presence store for its Socket.IO server:

- Meeting ID -> user ID -> set of socket IDs.
- Socket ID -> meeting/user membership.
- A monotonic in-memory change revision; each active meeting retains its latest.

Snapshots are copies, and empty meetings/user sets are removed. The state is not
written into MongoDB. A bounded per-socket promise queue serializes join, leave,
and refresh requests. Connection and expiry are rechecked after async admission
work. Disconnect cleanup removes presence without waiting for database work;
pending joins cannot later recreate that disconnected socket's presence.

Disconnect, JWT expiry, and server shutdown remove the socket from the roster.
Host disconnection only changes presence; it does not end the meeting.
Abrupt network loss is cleaned up when Socket.IO detects the disconnect (for
example, after its heartbeat timeout), rather than at the instant a cable or
network connection fails. Until detection, an old peer can remain in the roster.

On authenticated reconnect:

1. Discard old roster revisions and socket/peer IDs, especially after a server restart.
2. Follow the REST enrollment flow and explicitly emit `meeting:join` again.
3. Apply the new snapshot and current socket ID. Rooms are not auto-restored.

The deployment assumption is one Node.js process. Presence is lost on restart;
multiple instances require an agreed adapter/shared-presence design.

## Developer 1 coordination: hooks NOT implemented

**Immediate workspace revocation and REST host-end notifications are not
implemented.** Current tests cover checks at join/refresh and removal of the
requesting socket after detected loss of access. A passive socket can remain in
its existing room until disconnect/expiry or a request discovers the change.
Checking incoming events alone cannot evict passive recipients.

The database read and in-memory admission are not a single atomic transaction.
Lifecycle changes can race with in-flight joins. The integration must address
those races rather than claiming every post-read change is already enforced.

The following are proposed internal hook contracts for Developer 1 review, not
exported functions or client socket events:

| Proposed notification | Publish point | Required socket-side behavior |
| --- | --- | --- |
| `notifyMeetingEnded({ meetingId, endedAt })` | After the host-authorized REST end is persisted. | Notify connected clients, invalidate in-flight admissions, remove every socket from that meeting's room and presence, and reject subsequent operations. |
| `notifyWorkspaceMembershipRevoked({ workspaceId, userId })` | After an authorized membership removal is persisted. | Find affected meeting sockets, respect the existing host exception, invalidate pending admissions, and evict every affected tab/device, including passive recipients. |

The current workspace controller has no membership-removal route. A future
membership API must own this publication; direct MongoDB edits do not currently
produce a socket notification. No REST controller or shared policy is changed
by Phase 4. Immediate account-deletion eviction remains a related future hook;
this phase rechecks the account on join/refresh only.

### Shared files requiring Developer 1 review

| File | Proposed change, pending approval |
| --- | --- |
| `backend/src/controllers/meeting.controller.js` | Publish the end notification after successful `endMeeting` persistence. Review conditional updates in `joinMeeting` so a stale scheduled-to-live save cannot overwrite a concurrent end. |
| `backend/src/controllers/workspace.controller.js` | Implement an approved membership-removal policy and publish revocation only after successful persistence; no such handler exists today. |
| `backend/src/routes/workspace.routes.js` | Add a membership-removal endpoint only after Developer 1 approves its authorization and request contract. |
| Proposed `backend/src/events/meeting-lifecycle.events.js` | Transport-neutral internal publisher for the two notifications, with no client-controlled publication path. This file does not exist yet. |
| `backend/src/socket/index.js` | Register one lifecycle subscriber per Socket.IO server and dispose it on shutdown. |
| `backend/src/socket/meeting.socket.js` and `presence.store.js` | Locate affected sockets, invalidate pending admissions, remove room/presence membership, and send the approved client notifications. |
| `backend/test/socket.meeting.integration.test.js` | Exercise the real REST-to-publisher-to-socket integrations, including passive recipients and races. |

Proposed end flow: existing REST host authorization -> persist end -> internal
`notifyMeetingEnded` publication -> invalidate pending room admissions -> notify
and evict all meeting sockets -> update presence. Proposed workspace flow:
approved REST removal authorization -> persist removal -> internal
`notifyWorkspaceMembershipRevoked` publication -> locate affected meeting sockets
and apply the host exception -> invalidate pending admissions -> notify and evict
every affected tab -> update remaining rosters. Publication failures after a
successful database write need an agreed handling/retry policy; they cannot be
treated as if persistence never happened.

For Developer 2 review, candidate future server notifications are
`meeting:ended { meetingId, endedAt }` and
`meeting:access-revoked { meetingId, reason: "workspace_membership_revoked" }`.
Neither event is emitted in Phase 4. The names and payloads remain proposals
until Developers 1 and 2 approve the integration.

Coordination channel: GitHub Issues and Pull Requests in `Niket224/IntellMeet`.
Developer 1's handle is not confirmed, so this review is not assigned to an
assumed account. All changes listed above remain pending Developer 1 review.
The review handoff is tracked in
[GitHub issue #1](https://github.com/Niket224/IntellMeet/issues/1).

Developer 2 should review notification names/payloads with Developer 1 before
those hooks are implemented. Required integration acceptance tests include:

- Real REST end with passive clients: all receive the agreed notification and
  lose room/presence membership without sending a refresh.
- Real workspace removal with several tabs: all affected passive sockets are
  evicted while unrelated rooms/users and the agreed host exception remain correct.
- End/revocation racing with delayed database/adapter admission cannot re-add
  an evicted socket after the notification.
- Failed persistence emits no successful lifecycle/revocation notification.

This document is a coordination handoff, not a claim of external developer
approval or completed hook integration.

## Tests

From `backend/`:

```powershell
npm test
npm run test:meeting

$env:TEST_MONGODB_URI = 'mongodb://127.0.0.1:27017/intellimeet_phase4_test_' + [Guid]::NewGuid().ToString('N')
npm run test:meeting:integration

$env:TEST_MONGODB_URI = 'mongodb://127.0.0.1:27017/intellimeet_phase3_test_' + [Guid]::NewGuid().ToString('N')
npm run test:auth:integration

$env:TEST_MONGODB_URI = 'mongodb://127.0.0.1:27017/intellimeet_phase2_test_' + [Guid]::NewGuid().ToString('N')
npm run test:rest
```

Database suites require MongoDB and their dedicated test-database prefixes. They
skip without `TEST_MONGODB_URI` and validate the connected database before cleanup.
Room tests use real Socket.IO clients; the integration suite uses real REST
enrollment, JWTs, MongoDB models, and workspace-membership fixtures.

Browser UI behavior still needs manual multi-tab/two-browser verification by
Developer 2. Chat is added separately in Phase 5; WebRTC signaling/media,
transcription, and AI remain outside the implemented scope.
