# Two-browser signaling smoke test

This optional development-console example uses a data channel to check genuine
browser SDP/ICE negotiation. It adds no production UI or media features. Automated
server tests do not execute this example or replace the manual checks below.

## Setup

1. Run MongoDB and `npm start` from `backend/`. Use the existing local `.env`.
2. Run Developer 2's frontend at an origin allowed by the backend `CLIENT_URL`
   (default `http://localhost:5173`). Open it in two separate browsers/profiles.
   Use two test accounts logged in through the normal authentication flow.
3. Create a test meeting with REST/the frontend. In each browser use that account's
   JWT and the same meeting ID. Never paste tokens into shared logs or screenshots.
4. The snippet below loads the backend's bundled Socket.IO client. It needs no npm
   install. If the frontend CSP blocks development-console script loading, use the
   frontend's already imported `io` function and omit the script-loading lines.

## Paste in each browser's console

This intentionally has one offerer, one peer per browser, and no automatic retry
or reconnect. Production React code must implement the perfect-negotiation and
bounded queue guidance in [socket-webrtc.md](socket-webrtc.md).

```js
await new Promise((resolve, reject) => {
  const script = document.createElement("script");
  script.src = "http://localhost:5000/socket.io/socket.io.js";
  script.onload = resolve;
  script.onerror = reject;
  document.head.appendChild(script);
});
const token = prompt("Local test JWT (never share this value)");
const meetingId = prompt("Meeting ID");
const enrollment = await fetch(`http://localhost:5000/api/meetings/${meetingId}/join`, {
  method: "POST", headers: { Authorization: `Bearer ${token}` }
});
if (!enrollment.ok) throw new Error(`REST enrollment failed: ${enrollment.status}`);
const smokeSocket = io("http://localhost:5000", {
  autoConnect: false, auth: { token }, reconnection: false, retries: 0
});
const smokePc = new RTCPeerConnection(); // no STUN/TURN setup; try same-machine browsers
let peerId, negotiationId, channel;
let receiving = Promise.resolve();
let sendingIce = Promise.resolve();
const earlyIce = [];
function watchChannel(value) {
  channel = value;
  channel.onopen = () => console.info("Data channel open");
  channel.onmessage = ({ data }) => console.info("Received data:", data);
}
function sendSignal(type, extra) {
  if (!smokeSocket.connected) throw new Error("Socket disconnected; restart this smoke test");
  return smokeSocket.timeout(5000).emitWithAck(`webrtc:${type}`, {
    meetingId, targetSocketId: peerId, negotiationId, ...extra
  }).then((result) => {
    if (!result.ok) throw new Error(result.error.code);
    return result;
  });
}
smokePc.ondatachannel = ({ channel }) => watchChannel(channel);
smokePc.onconnectionstatechange = () => console.info("Peer state:", smokePc.connectionState);
smokePc.onicecandidate = ({ candidate }) => {
  // Serialize ICE sends to stay below the shared 16-request queue limit.
  const data = candidate ? candidate.toJSON() : null;
  sendingIce = sendingIce.then(() => sendSignal("ice-candidate", { candidate: data }))
    .catch((error) => console.error("ICE forwarding failed:", error.message));
};
async function receive(type, message) {
  if (message.meetingId !== meetingId) return;
  if (peerId && message.sender.socketId !== peerId) return;
  peerId ||= message.sender.socketId;
  negotiationId ||= message.negotiationId;
  if (message.negotiationId !== negotiationId) return;
  if (type === "ice-candidate") {
    if (!smokePc.remoteDescription) {
      if (earlyIce.length >= 200) throw new Error("Early ICE queue full; restart test");
      earlyIce.push(message.candidate);
    } else await smokePc.addIceCandidate(message.candidate);
    return;
  }
  await smokePc.setRemoteDescription(message.description);
  while (earlyIce.length) await smokePc.addIceCandidate(earlyIce.shift());
  if (type === "offer") {
    await smokePc.setLocalDescription(await smokePc.createAnswer());
    const { type, sdp } = smokePc.localDescription;
    await sendSignal("answer", { description: { type, sdp } });
  }
}
for (const type of ["offer", "answer", "ice-candidate"]) {
  smokeSocket.on(`webrtc:${type}`, (message) => {
    receiving = receiving.then(() => receive(type, message))
      .catch((error) => console.error("Peer negotiation failed:", error.message));
  });
}
smokeSocket.on("disconnect", () => { smokePc.close(); earlyIce.length = 0; });
await new Promise((resolve, reject) => {
  smokeSocket.once("connect", resolve);
  smokeSocket.once("connect_error", (error) => reject(new Error(error.data?.code || "Connection failed")));
  smokeSocket.connect();
});
const joined = await smokeSocket.timeout(5000).emitWithAck("meeting:join", { meetingId });
if (!joined.ok) throw new Error(joined.error.code);
console.info("My peer socket ID:", smokeSocket.id);
```

After **both** browsers have successfully joined, paste this in **browser A only**:

```js
peerId = prompt("Browser B's current socket ID");
negotiationId = crypto.randomUUID();
watchChannel(smokePc.createDataChannel("smoke"));
await smokePc.setLocalDescription(await smokePc.createOffer());
const { type, sdp } = smokePc.localDescription;
console.info("Forwarded:", (await sendSignal("offer", { description: { type, sdp } })).data.forwarded);
```

Wait for `Data channel open` in both browsers. Then send `channel.send("hello")`
from A and `channel.send("reply")` from B. The other browser should print each
message. A forwarding ack alone is insufficient: check `smokePc.connectionState`
and channel opening. This test deliberately avoids printing SDP, ICE, or tokens.

## Additional manual checks and teardown

- Open a third test tab in the meeting: it must receive no SDP/ICE directed to B.
- Send to an unknown/cross-meeting socket ID: expect `WEBRTC_TARGET_UNAVAILABLE`.
- In A run `await smokeSocket.timeout(5000).emitWithAck("meeting:leave", { meetingId })`;
  a subsequent `sendSignal` must fail with `MEETING_NOT_JOINED`. Close `smokePc`
  yourself on an explicit leave; production code should do this automatically.
- Disconnect B while A negotiates: A must handle unavailable target/ack timeout,
  and neither browser should assume the forwarding ack guarantees connectivity.
- Refresh/reconnect B: its new socket must reauthenticate/rejoin. Old target IDs
  must fail. Refresh both pages and rerun with fresh peer connections to retry.
- With Developer 2's production perfect-negotiation implementation, trigger offers
  simultaneously, delay remote-description installation to force early ICE, and
  renegotiate/restart ICE. Check ignored-offer candidate cleanup and new IDs. The
  one-off snippet above does not implement these production behaviors.
- Same-machine success does not prove NAT traversal or cross-network media. This
  phase adds no TURN infrastructure; failures on other networks remain possible.
- End/revoke a meeting via REST/fixtures only in a dedicated development database.
  New signaling must fail after the DB change; **do not expect immediate socket
  eviction or an existing peer connection to close**. Those hooks remain pending
  [Issue #1](https://github.com/Niket224/IntellMeet/issues/1).

When finished, run `smokeSocket.disconnect(); smokePc.close();` in each browser and
close/reload the pages to remove the local test credentials and bindings.
