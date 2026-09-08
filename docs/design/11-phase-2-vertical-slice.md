# Phase 2 vertical-slice record

## Current boundary

Phase 2 completed on 2026-09-03. The single-tab path and the core four-tab concurrency/isolation
slice pass end to end through a signed managed Extension and real Google Chrome Stable. The final
single-tab run used the documented Standalone daemon, authenticated loopback API, Signaling Gateway
CLI and Viewer example rather than a development-only Gate launcher. Forced TURN/UDP has since
passed, followed by transport-specific forced TURN/TCP and trusted-certificate TURN/TLS passes;
file/clipboard, child-target, durable recovery and release evidence remain
later-phase work.

## Implemented

### CDP target control

`@browshare/remote-tab-core` can connect through an HTTP CDP discovery endpoint or a supplied browser WebSocket URL. It can:

- Create a page target or adopt an existing page target.
- Attach with flattened CDP sessions so one browser connection can serve multiple tabs.
- Enable Page, Runtime and DOM domains.
- Require a trusted `targetId → tabId` resolver before returning the attachment.
- Apply a bounded viewport and issue monotonically increasing viewport revisions.
- Reject pointer input carrying a stale revision or coordinates outside the acknowledged viewport.
- Dispatch pointer, key and committed IME text input.
- Navigate only through an explicitly named `navigateAuthorized` precondition.
- Traverse real CDP navigation history rather than injecting `history.back()` JavaScript.
- Observe top-level frame locations and close only the attached target.

The tests use a real HTTP and WebSocket mock CDP server, not method stubs, so request routing and flattened `sessionId` placement are exercised.

### Extension loopback identity

Core exposes a WebSocket service that can bind only to `127.0.0.1` or `::1`. A connecting extension runtime must present:

```text
fixed Extension ID
per-runtime secret
runtime generation
service-worker or media role
```

The service-worker role resolves a CDP target using trusted extension observations and returns a Chrome `tabId`. Requests have IDs and deadlines; disconnecting the service worker rejects all outstanding mappings. A newly authenticated peer of the same role replaces the stale peer.

### MV3 Extension runtime

The loadable Chrome artifact now contains:

- A managed-policy configured service worker that authenticates to loopback, resolves `targetId → tabId`, revalidates the mapping immediately before capture, and obtains a target-specific `tabCapture` stream ID.
- An offscreen media document that consumes the stream ID, publishes tab video and optional tab audio, creates reliable/realtime/file DataChannels, and exchanges offer/answer plus ICE only through Core.
- Explicit capture-start failure reporting, per-Session stop, pause/resume acknowledgement, heartbeat handling and peer-ready ordering that tolerates the Viewer arriving before `getUserMedia` completes.
- A build gate that requires all manifest/static entries and rejects bare package imports in generated JavaScript. Protocol, TypeBox and MessagePack code is bundled into local Extension chunks.
- A build-time Extension version constant sourced from `manifest.json`, allowing the service-worker
  and restricted offscreen context to report one coherent version without context-specific APIs.

### Viewer tickets

The protocol package provides a Web Crypto HMAC-SHA256 ticket codec. Tickets bind Session, Viewer generation, Gateway, capabilities, issuer, audience, issue time, expiry and a unique single-use ID. The codec validates claim schemas, signatures, issuer/audience and time bounds without exposing the secret to the Viewer.

### Signaling Gateway

The Gateway accepts two authenticated roles for an explicit `(sessionId, viewerGeneration)` pair:

- Viewer presents the short-lived ticket.
- Core presents a binding token checked by an Embedder adapter.

It consumes the Viewer ticket once, keeps replay state only for the ticket lifetime, obtains role-specific ICE servers from an adapter, and relays only:

```text
Core → Viewer: WebRTC offer and ICE
Viewer → Core: WebRTC answer and ICE
```

Role-reversed descriptions, non-signaling messages, duplicate peers, malformed data, oversized data and pairing timeouts fail with stable codes. Gateway never receives media or DataChannel bytes.

The Gateway assignment also carries the standard `all` or `relay` ICE transport policy to both
peers. This provides a repeatable forced-TURN diagnostic without changing the media path or exposing
TURN credentials outside normal WebRTC configuration.

### Headless Client

`createRemoteTabClient` is a real browser implementation. It:

- Opens the assigned Gateway and consumes the opaque Viewer ticket.
- Creates the Viewer-side `RTCPeerConnection` from validated ICE configuration.
- Answers a publisher offer and exchanges ICE.
- Attaches incoming media to an application-provided `<video>`.
- Discovers reliable and realtime DataChannels.
- Completes the MessagePack `hello`/`hello.accepted` control handshake.
- Sends validated viewport, navigation, pointer, key, composition, suspend/resume and local-open decisions.
- Rejects a Session/generation change in received control traffic.
- Emits typed state, capability, viewport, navigation, local-open and error events.
- Emits redacted signaling, ICE, selected-pair, media and DataChannel diagnostic events without SDP,
  candidate addresses, ports or credentials.

Core now supports Embedder-driven Viewer takeover and reconnection: a strictly higher generation
invalidates old input, replaces signaling and preserves the Chrome tab. Viewer departure no longer
destroys the Session; a fresh authorized ticket can reconnect it. Before a Viewer pairs, Core also
retries retryable Gateway failures with the same generation until Ticket expiry. Automatic retry and
ICE restart inside one Headless Client instance remain Phase 3 work.

### Core signaling and Session orchestration

`CoreSignalingClient` binds the exact assigned Gateway, Session and Viewer generation, waits for both role configuration and peer presence, validates the returned binding, and permits only Core offers plus bidirectional ICE. `RemoteTabCore` retries only retryable pre-pair failures with bounded backoff, reusing the generation while its Ticket remains valid. It then coordinates:

```text
CDP attach → trusted tab mapping → viewport → Viewer ticket
→ Gateway pairing → capture preparation → Extension publisher
→ control hello → authorized CDP input/navigation → per-Session cleanup
```

The integration test uses a real CDP discovery HTTP endpoint, CDP WebSocket, two authenticated Extension loopback peers and a signaling WebSocket. It verifies that the same Session reaches pointer dispatch, navigation authorization, suspension acknowledgement and storage cleanup.

The same test replaces a suspended Viewer with a higher generation, rejects stale-generation input,
accepts the replacement handshake, preserves the Session after Viewer departure and issues a third
reconnect ticket before explicit cleanup. It also forces a retryable first pairing failure and
verifies that Core rebinds the same generation without leaving `NEGOTIATING`.

### Default Viewer Web Component

`defineRemoteTabViewer()` registers an SSR-safe, framework-independent custom element. The default Viewer includes:

- Shadow DOM UI with navigation, address, fullscreen, end request, connection overlays and bilingual labels.
- Video-content coordinate mapping that rejects letterbox regions.
- Pointer, wheel, keyboard and IME forwarding with stuck-input release on focus loss.
- Responsive viewport requests capped at 1920×1080 and 60 FPS.
- Configurable focus suspension, defaulting to suspended while hidden or unfocused.
- Viewer-owned local-open confirmation, with a cancelable host override event.

### Real Google Chrome Stable evidence

On 2026-09-03 the development Gate verified:

```text
Worker: Ubuntu 24.04 x86_64
Google Chrome Stable: 152.0.7977.75
Signed Extension: 0.1.2
Viewer Chrome: 152.0.7977.65 on macOS
Selected path: direct UDP, Viewer prflx ↔ Worker host
Media: 1280×720 video plus one tab-audio track
```

The Viewer reached `CONNECTED`, received all three DataChannels and rendered the remote page.
Address navigation, a pointer-activated remote link, printable key events, committed Chinese text,
783×660 viewport acknowledgement and focus-driven `CONNECTED → SUSPENDED → CONNECTED` were
confirmed against the remote CDP target. Gateway diagnostics proved it carried only offer, answer
and ICE metadata; the selected media path bypassed Gateway.

The Gate also exposed and fixed two lifecycle defects: Core had not forwarded `peer-ready` to the
media runtime, and publisher replacement cleared a readiness edge before `createOffer()`. The signed
`0.1.2` artifact includes both fixes and the earlier offscreen-start serialization.

### Real Viewer takeover and reconnect evidence

A follow-up run deployed signed Extension `0.1.3` and the updated Core against the same Chrome and
Viewer versions. A connected Viewer was retired by a strictly higher generation, and a replacement
Viewer reached `CONNECTED` on the same Chrome tab. The page was then given a distinctive DOM input
value. After the replacement Viewer disconnected, Core kept the Session in `RECONNECTING`; another
higher-generation Ticket connected a third Viewer and rendered the retained value without recreating
the target or Profile. The selected paths were direct UDP.

The run validates Embedder-driven takeover and reconnect preservation in real Chrome. It does not
yet implement automatic retry inside one Headless Client instance, and it does not prove uninterrupted
video frames during replacement. Core now sends `VIEWER_REPLACED` through the existing signaling pair
before retiring it when that pair is still reachable, so the old Viewer can distinguish authorized
replacement from a generic network failure.

### Real four-tab isolation evidence

The same compatibility tuple subsequently ran four Sessions in one Chrome Profile. Every Session
had a unique application ID, Chrome `tabId`, CDP `targetId`, tabCapture stream and PeerConnection.
All four reached `CONNECTED`, opened the three defined DataChannels and selected direct UDP paths.
TURN/UDP relay candidates were also gathered from a temporary coturn service, but relay was not the
selected route and is therefore not counted as the forced TURN test.

An initial follow-up selected a relay candidate using TCP to coturn and opened all three
DataChannels, but did not complete the application `hello` handshake before timeout. That failure
also showed that browser WebSocket clients cannot actively send reserved close code `1008`. Headless
Client and Extension browser code now use private code `4000` for application failures and `1000`
for normal shutdown.

After redeployment, a clean forced-relay run used only
`turn:149.88.75.53:3478?transport=tcp`. The Viewer reached `CONNECTED`, opened all three
DataChannels and selected a `relay ↔ relay` pair with `relayProtocol: tcp`. Gateway recorded the
`relay` policy, one ICE server per role, pair completion and only relay candidates. This closes the
TURN/TCP item. TURN/TLS was tested separately because it also exercises certificate trust and the
TLS listener.

A subsequent run configured coturn with a publicly trusted certificate on 5349 and restricted the
Gateway to one `turns:` URL. The Viewer again reached `CONNECTED` with all three DataChannels open.
Its selected `relay ↔ relay` pair reported `relayProtocol: tls`, while Gateway recorded the forced
`relay` policy and only relay candidates from both roles. During this run the selected-pair
diagnostic was corrected to preserve the standards-defined TLS relay transport rather than silently
dismiss it through the narrower ICE candidate protocol union.

The run found a shared-loopback defect that the single-tab Gate could not expose: the media runtime's
binary control frames were broadcast to every Core Session listener. Non-owning Sessions correctly
rejected the foreign envelope as `VIEWER_REPLACED`, which then tore down otherwise healthy peers.
`ExtensionLoopbackServer` now validates the envelope once for routing and delivers the original bytes
only to listeners registered for that `sessionId`; the owning Session still validates both Session ID
and Viewer generation before acting.

After the fix, each Viewer navigated or wrote a different Chinese text value and CDP readback showed
no cross-Session mutation. Disconnecting one Viewer failed and cleaned up only that Session and tab;
the other three stayed connected and continued accepting input. A later four-Viewer run also proved
that suspending and resuming one Session changes only that Session while a sibling Viewer continues
to control its own target. The Phase 3 record contains that lifecycle evidence.

### Real Standalone and coordinated-version evidence

The final Phase 2 run used the built Standalone and Gateway CLIs, the authenticated `/v1` API, the
signed `0.1.5` managed Extension and the public Viewer example. The machine-readable capability
report returned:

```text
status: ready
Chrome: 152.0.7977.75, CDP 1.3
Extension service-worker/media: 0.1.5 / 0.1.5, coherent
Core/Standalone: workspace 0.0.0
control protocol: 1.0
```

The Viewer was intentionally delayed until after Core's initial 15-second pairing attempt. Gateway
recorded a second Core bind for the same Session and generation, after which the still-valid original
Ticket reached `CONNECTED`, opened all three DataChannels and selected direct UDP. The run confirms
that a short per-attempt timeout no longer shortens the Ticket lifetime.

## Phase 2 exit

The public flow controls one real Chrome tab without carrying media through Gateway, and the exact
runtime tuple is available through the documented capability endpoint. Phase 2 is therefore closed;
the transport, file/event, recovery and release items above remain assigned to later phases.

The old combined POC is used only as evidence for known Chrome behaviors. None of its unauthenticated single-publisher global state is reused.
