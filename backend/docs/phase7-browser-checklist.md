# Phase 7 preparation: two-browser verification checklist

Status: **prepared, not executed**. The 143 automated tests passed at Phase 6
checkpoint `f499199c6d67225e03cc157ab8e5b4fea44e943e` (including parent tests).
They test Socket.IO transports, authentication, authorization, ordering, signaling
payloads, and REST/MongoDB behavior. They use synthetic SDP/ICE and do not invoke a
browser, camera, microphone, RTCPeerConnection, or actual remote media playback.

Use the [Developer 2 handoff](developer-2-integration.md) for exact wire contracts.
No additional application functionality is implemented by this checklist.

## Prerequisites and commands

- MongoDB must be available at the configured local URI. Tests create/drop only
  dedicated uniquely named test databases; do not point tests at the app database.
- Existing backend dependencies/local `.env` must be present. Keep credentials local.
- Developer 2 must provide/start the React frontend using its documented command
  at `http://localhost:5173` (or another configured `CLIENT_URL` origin).
  **There is no frontend package in this checkout**, so its startup command cannot
  be verified here. No frontend dev command or media implementation is assumed.
- Use two authenticated browsers/profiles with different test users and one test
  meeting, plus camera/microphone access. Use headphones to avoid feedback. If
  shared hardware cannot be opened by both browsers, use separate devices/cameras
  and record the limitation; a device error is not automatically a signaling error.
- Capture requires a secure context, such as localhost or HTTPS. A second physical
  device needs a reachable backend/frontend URL and configured allowed origin;
  its `localhost` points to that device. See
  [MDN getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia).

From the repository root in PowerShell:

```powershell
Set-Location backend
npm start
```

Use the existing running server instead if port 5000 is already occupied by it.
In another PowerShell terminal, after Developer 2 starts the frontend:

```powershell
Invoke-RestMethod http://localhost:5000/api/health
# Expect: status = ok, service = intellimeet-backend

# If these browsers are installed, open one test window in each:
Start-Process msedge.exe -ArgumentList '--new-window', 'http://localhost:5173'
Start-Process chrome.exe -ArgumentList '--new-window', 'http://localhost:5173'
```

Alternatively open the URL in two browsers/profiles manually. Use separate test
logins; do not assume browser A's session/token is available in browser B.

For signaling-only testing, follow [webrtc-manual-test.md](webrtc-manual-test.md):
paste its first console block in both browsers, its offer block only in A, then
exchange `channel.send("hello")` / `channel.send("reply")`. That data-channel
snippet does **not** acquire camera/mic or prove audio/video playback. The full
media checklist below needs Developer 2's implementation.

## Full media acceptance checklist

All items start unchecked. Record pass/fail/blocked for both browser directions.

- [ ] **REST enrollment:** create one test meeting through the existing UI/REST.
  Both users call `POST /api/meetings/:id/join` with their own bearer JWT; require
  HTTP 200 and a live meeting before socket entry. Non-enrolled room entry fails.
- [ ] **JWT handshake:** both connect to `http://localhost:5000`, namespace `/`,
  Engine.IO path `/socket.io/`, with `auth: { token }`. Confirm `connect`; missing,
  invalid, and expired JWTs fail with the documented `connect_error.data.code`.
  Never capture tokens in screenshots/logs.
- [ ] **Authorized room join:** install listeners first, then acknowledge
  `meeting:join { meetingId }` in each browser. Verify trusted socket IDs and
  `joined: true` (or `false` for a duplicate); no chat/signaling before success.
  Joining another room without leaving fails with `MEETING_CONFLICT`.
- [ ] **Presence and identity:** both rosters show the two correct User IDs and
  socket IDs, mapped to authorized REST profile data. An extra tab adds a socket
  under the same user, not a duplicate visible participant. Leaving one tab keeps
  that user present until its final socket leaves. No client-supplied identity.
- [ ] **Local camera/mic:** each browser requests permission from a user action,
  obtains a live audio/video MediaStream, and shows a muted local preview.
  Permission denial does not bypass JWT/meeting checks or show false success.
- [ ] **Peer creation:** one new RTCPeerConnection per remote socket, excluding
  self. Add local audio/video tracks before the intended offer. Register ICE,
  track, state, and error handlers before negotiation. No media is sent in socket
  events. Confirm both browsers actually have local tracks, not only a data channel.
- [ ] **SDP offer/answer:** A sets its local offer and sends `webrtc:offer` to B;
  B installs the remote offer, sets a local answer, and sends `webrtc:answer` to A.
  A installs the answer. The same negotiation ID correlates the exchange; check
  stable browser signaling state. Forwarding ack alone is not connection success.
- [ ] **ICE in both directions:** both send `webrtc:ice-candidate`, including the
  supported end markers. Only the intended socket receives each event. Queue
  early candidates until the matching remote description is installed, then drain
  in order; bound queue/concurrency. No cross-room or other-tab signal leakage.
- [ ] **Remote video and audio:** both receive remote tracks and attach streams to
  remote elements. Verify moving video and audible speech A -> B **and** B -> A,
  not just a connected state or local preview. Confirm remote audio is unmuted.
  Handle rejected `play()` promises with a user-visible playback action; browser
  autoplay can block playback. See
  [MDN play](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/play).
- [ ] **Simultaneous offers / renegotiation:** trigger negotiation in both clients.
  Apply the browser [perfect negotiation pattern](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation)
  with deterministic polite/impolite roles. Verify no deadlock, ignored-offer ICE
  cleanup, correct negotiation IDs/ICE generations, and successful later renegotiation.
- [ ] **Explicit leave:** acknowledge `meeting:leave`, close that browser's peer
  connections, stop owned local tracks, clear remote streams and pending signals.
  The other browser removes that socket/peer from its roster and UI. Later sends
  from the departed socket fail. Socket leave alone does not stop browser tracks.
- [ ] **Disconnect cleanup:** close a tab or drop its transport. After the server
  detects disconnect, confirm presence removes that socket and the other browser
  closes its peer. Do not require an instantaneous roster update during a network
  partition; detection depends on transport/heartbeat timeouts.
- [ ] **Reconnect:** reconnect with a valid JWT, explicitly rejoin, refresh/reset
  roster revisions, discard old socket IDs/connections/candidates, and renegotiate
  with fresh peer IDs. Verify bidirectional media again. Old target IDs fail, and
  offline-buffered or stale signals are not replayed into the new connection.
- [ ] **Active JWT expiry:** use a dedicated development test credential whose
  expiry is known. Observe best-effort `auth:error` and forced disconnect, removed
  presence, and browser track/peer cleanup. Obtain a valid token through the normal
  authentication flow before reconnect/rejoin; changing `socket.auth` alone does
  not extend an existing connection's lifetime.
- [ ] **Permission/device failures:** deny camera, deny microphone, revoke site
  permissions, and test unavailable/busy hardware. Verify safe recoverable UI,
  stopped partial streams, no unhandled promise rejection, and retry after user
  correction. Record actual browser error names (for example `NotAllowedError`,
  `NotFoundError`, `NotReadableError`); do not log secrets, SDP, or ICE.
- [ ] **Network failures:** test backend outage, wrong origin, transport loss during
  negotiation, and target disconnect. Handle ack timeout as uncertain delivery,
  with bounded backoff and no blind SDP retry. Test a restrictive/other network
  separately: no TURN infrastructure is included, so traversal is not guaranteed.
  DevTools offline emulation may not sever every existing WebRTC path; verify
  actual peer/ICE states rather than assuming it did.
- [ ] **Chat regression in browsers:** both receive room chat, the sender displays
  ack/event only once, HTML-looking text displays literally, and a different room
  receives nothing. Reconnect provides no chat history. Validate chat separately
  from remote media so one cannot mask failure of the other.

## Known pending work and evidence record

- [Issue #1](https://github.com/Niket224/IntellMeet/issues/1) stays open until
  Developer 1 reviews and the lifecycle/revocation integration is implemented and
  tested. Do not mark immediate passive-socket eviction as passed. Request-time
  rejection after REST end/revocation is the existing behavior, not that hook.
- Developer 2's frontend/start command, permission UI, peer negotiation and media
  rendering are prerequisites; the backend cannot prove them automatically.
- Cross-network traversal, multi-browser/device compatibility, and load limits
  remain unverified. Non-workspace REST admission is prototype access, not private.
- No transcription, AI summaries, recording, screen sharing, persistence, or new
  server/frontend functionality is added in this preparation step.

Record results without credentials or raw SDP/ICE:

| Evidence | Result |
| --- | --- |
| Backend checkpoint | `f499199c6d67225e03cc157ab8e5b4fea44e943e` |
| Frontend commit and startup command | Not supplied |
| Tester/date, browser versions, OS/devices | Not run |
| Frontend/backend origins, network scenario | Not run |
| Enrollment, handshake, join, roster | Not run |
| Camera/mic permission and local tracks in A/B | Not run |
| Offer/answer, bidirectional ICE, peer state | Not run |
| Remote video/audio A -> B and B -> A | Not run |
| Collision, leave, disconnect, reconnect, failures | Not run |
| Issue #1 immediate eviction | Pending Developer 1 review/integration |

## Reproduce the automated backend verification

From `backend/`, with local MongoDB running:

```powershell
npm test
$env:TEST_MONGODB_URI = 'mongodb://127.0.0.1:27017/intellimeet_phase6_test_' + [Guid]::NewGuid().ToString('N')
npm run test:webrtc:integration
$env:TEST_MONGODB_URI = 'mongodb://127.0.0.1:27017/intellimeet_phase5_test_' + [Guid]::NewGuid().ToString('N')
npm run test:chat:integration
$env:TEST_MONGODB_URI = 'mongodb://127.0.0.1:27017/intellimeet_phase4_test_' + [Guid]::NewGuid().ToString('N')
npm run test:meeting:integration
$env:TEST_MONGODB_URI = 'mongodb://127.0.0.1:27017/intellimeet_phase3_test_' + [Guid]::NewGuid().ToString('N')
npm run test:auth:integration
$env:TEST_MONGODB_URI = 'mongodb://127.0.0.1:27017/intellimeet_phase2_test_' + [Guid]::NewGuid().ToString('N')
npm run test:rest
Remove-Item Env:TEST_MONGODB_URI
```

Actual checkpoint rerun: 94 unit/real-client + 10 signaling integration + 10 chat
integration + 15 meeting integration + 6 auth integration + 8 REST regression =
**143 reported tests, zero failures/skips**. This is automated backend evidence,
not a passed browser-media checklist.
