# Testing and compatibility

## Verification by change

Choose checks that can detect the failure introduced by the current change. The compatibility and release requirements below still apply when their triggers are met.

| Change | Required evidence for the task |
| --- | --- |
| Prose or comments | Affected links, terminology, command entry points and code fences; validate changed diagrams or DESIGN.md as described in [Contributing](../CONTRIBUTING.md) |
| Schema, state machine, coordinates or channel logic | Relevant Vitest files and affected package typechecks; include actual callers when changing a contract |
| Capture, input, extension policy or CDP behavior | The smallest real Google Chrome Stable flow that exercises the change, including Session isolation when relevant |
| Frozen public API or protocol | The [API change gate](15-gate-0-and-api-freeze.md#change-gate), including exports, compatibility classification and affected browser flow |
| New published compatibility set or release | Full applicable direct/TURN Gate, browser matrix and release evidence; local tests alone do not satisfy publication gates |

Use scripts defined in the root and owning package's `package.json`. For a focused protocol run, use `pnpm exec vitest run packages/protocol/test/protocol.test.ts` from this repository. `pnpm check` runs the workspace suite; it does not establish real Chrome or external publication evidence.

After relevant checks pass, stop unless a new change, failure or unresolved concern justifies more verification. Report unavailable environments and unrun checks explicitly, without replacing browser evidence with mocks or dated records.

## Compatibility set

A release records exact or bounded versions for:

```text
Remote Tab Core
Headless Client and Viewer
Extension
Google Chrome Stable
Signaling protocol
Control protocol
```

An untested combination may pass capability diagnostics, but only a published set receives a compatibility claim. Chrome for Testing evidence does not replace Google Chrome Stable release evidence.

### Provisional development evidence

| Date | Core/Viewer | Extension | Chrome | Worker OS | Viewer | Result |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-09-03 | workspace `0.0.0` | `0.1.2` | Google Chrome Stable `152.0.7977.75` | Ubuntu 24.04 x86_64 | Chrome `152.0.7977.65` on macOS | Single tab passed over direct UDP |
| 2026-09-03 | workspace `0.0.0` | `0.1.2` | Google Chrome Stable `152.0.7977.75` | Ubuntu 24.04 x86_64 | Chrome `152.0.7977.65` on macOS | Four tabs passed concurrent capture and control isolation over direct UDP |
| 2026-09-03 | workspace `0.0.0` | `0.1.3` | Google Chrome Stable `152.0.7977.75` | Ubuntu 24.04 x86_64 | Chrome `152.0.7977.65` on macOS | Viewer takeover and reconnect preserved one tab and its DOM state over direct UDP |
| 2026-09-03 | workspace `0.0.0` | `0.1.5` | Google Chrome Stable `152.0.7977.75` | Ubuntu 24.04 x86_64 | Chrome `152.0.7977.65` on macOS | Public Standalone/Gateway flow passed after a delayed Viewer crossed the first Core pairing window |
| 2026-09-03 | workspace `0.0.0` | `0.1.6` | Google Chrome Stable `152.0.7977.75` | Ubuntu 24.04 x86_64 | Codex in-app browser on macOS | Forced TURN/UDP passed with a selected `relay ↔ relay` pair |
| 2026-09-03 | workspace `0.0.0` | `0.1.6` | Google Chrome Stable `152.0.7977.75` | Ubuntu 24.04 x86_64 | Codex in-app browser on macOS | Forced TURN/TCP passed with a selected `relay ↔ relay` pair |
| 2026-09-03 | workspace `0.0.0` | `0.1.6` | Google Chrome Stable `152.0.7977.75` | Ubuntu 24.04 x86_64 | Codex in-app browser on macOS | Forced TURN/TLS passed with a selected `relay ↔ relay` pair and trusted certificate |
| 2026-09-04 | workspace `0.0.0` | `0.1.6` | Google Chrome Stable `152.0.7977.75` | Ubuntu 24.04 x86_64 | Four Chrome Viewers on macOS | One Session suspended and resumed while three sibling Sessions stayed connected and isolated |
| 2026-09-04 | workspace `0.0.0` | `0.1.8` | Google Chrome Stable `152.0.7977.75` | Ubuntu 24.04 x86_64 | Chrome Viewer on macOS | All three quality presets changed real encoder limits and decoded resolution as documented |
| 2026-09-04 | workspace `0.0.0` | `0.1.8` | Google Chrome Stable `152.0.7977.75` | Ubuntu 24.04 x86_64 | Chrome Viewer on macOS | A temporary 12-second UDP outage recovered `CONNECTED → RECONNECTING → CONNECTED` through ICE restart without replacing the tab or generation |
| 2026-09-04 | workspace `0.0.0` | `0.1.8` | Google Chrome Stable `152.0.7977.75` | Ubuntu 24.04 x86_64 | Chrome Viewer on macOS | Inbound/outbound media and three DataChannel metrics flowed every five seconds and stopped after Viewer disconnect |
| 2026-09-04 | workspace `0.0.0` | `0.1.9` | Google Chrome Stable `152.0.7977.75` | Ubuntu 24.04 x86_64 | Chrome Viewer on macOS | Eight repaired lifecycle iterations passed fresh-Ticket reconnect, active takeover, DOM/target preservation and deterministic cleanup |
| 2026-09-04 | workspace `0.0.0` | `0.1.9` | Google Chrome Stable `152.0.7977.75` | Ubuntu 24.04 x86_64 | Chrome Viewer on macOS | Service-worker/offscreen and Standalone graceful/crash boundaries passed with terminal-record cleanup and explicit orphan handling |
| 2026-09-04 | workspace `0.0.0` | `0.1.10` | Google Chrome Stable `152.0.7977.75` | Ubuntu 24.04 x86_64 | Codex in-app browser on macOS | File chooser uploaded and read back 37 bytes, preserved `client-proof.txt`, cancelled a second chooser, and removed Session temporary files |
| 2026-09-04 | workspace `0.0.0` | `0.1.11` | Google Chrome Stable `152.0.7977.75` | Ubuntu 24.04 x86_64 | Chrome Viewer on macOS | MAIN-world local-open interception completed the opener click, created no remote child, honored local cancel/approve, and delivered structured Notice |
| 2026-09-04 | workspace `0.0.0` | `0.1.12` | Google Chrome Stable `152.0.7977.75` | Ubuntu 24.04 x86_64 | Codex in-app browser on macOS | Two concurrent 2 MiB downloads retained Session ownership through 32 chunks each; rejection, default Viewer save, and zero-spool cleanup passed |
| 2026-09-04 | workspace `0.0.0` | `0.1.14` | Google Chrome Stable `152.0.7977.75` | Ubuntu 24.04 x86_64 | Codex in-app browser on macOS | Page Script navigation, refresh, failure isolation, Viewer delivery, and final detach ordering passed |
| 2026-09-04 | workspace `0.0.0` | `0.1.14` | Google Chrome Stable `152.0.7977.75` | Ubuntu 24.04 x86_64 | Not required | Main-target close and whole-Chrome crash evicted idle READY Sessions; readiness and same-ID recovery passed |
| 2026-09-04 | workspace `0.0.0` | `0.1.14` | Google Chrome Stable `152.0.7977.75` | Ubuntu 24.04 x86_64 | Chrome `152.0.7977.65`, Edge `152.0.4191.62`, Safari `26.5`, Firefox `155.0.1` on macOS | All four branded desktop browsers passed the same public Viewer Web Component sequence over forced relay |
| 2026-09-04 | workspace `0.0.0` | `0.1.14` | Google Chrome Stable `152.0.7977.75` | Ubuntu 24.04 x86_64 | Not required | A clean source snapshot followed only the README to self-sign the Extension, build isolated images, bootstrap a fresh Profile, reach coherent readiness, attach/delete a real Session and return every Session gauge to zero |
| 2026-09-05 | workspace `0.0.0` | `0.1.14` | Two Google Chrome Stable `152.0.7977.75` processes | Ubuntu 24.04 x86_64 | Headless Chrome 152 on macOS | One loopback kept two runtime IDs coherent; both Sessions decoded 1280 × 720 video, opened three DataChannels and delivered distinct input to the owning Chrome only |
| 2026-09-05 | workspace `0.1.14` | `0.1.14` | Google Chrome Stable `152.0.7977.75` | Ubuntu 24.04 x86_64 | Not required | Reference Chrome-node Compose ran nonroot with Chrome sandbox enabled under the pinned deny-by-default seccomp profile; readiness, Extension bootstrap and real Session create/delete passed without added capabilities |

This is development evidence, not a published compatibility promise. It covers signed managed
installation, unattended capture, 1280×720 video, one tab-audio track, SDP/ICE, three DataChannels,
navigation, pointer, printable keys, committed Chinese text, viewport acknowledgement and
focus-driven suspend/resume. The four-tab run additionally covers four simultaneous PeerConnections,
unique Session/`tabId`/`targetId` bindings, independent navigation and Chinese text, and closing one
Session without affecting the other three. A later forced-relay run selected TURN/UDP on both peers;
another selected a TURN relay whose client-to-coturn transport was TCP, followed by a trusted
TURN/TLS relay. Separate Viewer pages were used for the later lifecycle run.

The four-Viewer lifecycle run used the public Viewer API against four simultaneous Sessions. After
one Viewer called `suspend()`, Standalone reported `SUSPENDED, CONNECTED, CONNECTED, CONNECTED`.
A sibling Viewer then wrote `Sibling-live-after-pause-20260904`; CDP readback found that value only
in the sibling target, while the suspended and two remaining targets stayed unchanged. Calling
`resume()` returned all four Sessions to `CONNECTED` without replacing their PeerConnections or
Chrome tabs. A disconnect race found during the run was fixed so a late control request rejected with
`ILLEGAL_STATE_TRANSITION` no longer fails an otherwise recoverable Core Session.

The `0.1.3` run used one Session across generations 1, 4 and 5. Issuing a newer Ticket retired the
active Viewer, connected a replacement to the same CDP target, and retained the page. After the
replacement disconnected voluntarily, Core reported `RECONNECTING` rather than closing the tab. A
fifth-generation Viewer then connected and rendered the previously written input value
`接管状态-保持-20260903`. The run also confirms that browser WebSocket close paths use valid
application close codes. This is lifecycle evidence, not a claim of seamless frame continuity or
automatic in-client retry.

The `0.1.5` run used only the built Standalone API, Gateway CLI, signed managed Extension and public
Viewer example. Its capability report was `ready` with Chrome product, CDP protocol/revision/V8,
Core, control protocol, Extension ID/runtime generation and matching `0.1.5` service-worker/media
versions. The Viewer was intentionally connected after Core's first 15-second pairing attempt had
closed. Gateway then recorded another Core bind for the same Session and generation; the original
Ticket reached `CONNECTED`, opened all three DataChannels and selected direct UDP. This is Core-side
pre-pair retry evidence, not automatic retry or Ticket replay inside one Headless Client instance.

## Test layers

- Pure unit tests for runtime schemas, state machines, coordinates, capabilities and error redaction.
- Browser component tests for Viewer controls and accessibility.
- Mock CDP tests for command translation and failure handling.
- Real Chrome integration tests for extension policy, capture, input, files and lifecycle.
- Network integration tests for direct, STUN and TURN paths.
- Standalone examples that a third party can execute without BrowShare.

## Multi-tab Gate 0

Before the first public API freeze, one Google Chrome Stable Profile must support at least four concurrent Sessions:

1. Four unique mappings between application Session, `tabId`, and CDP `targetId`.
2. Four independent tabCapture streams and PeerConnections.
3. Correct pointer, drag, wheel, keyboard, shortcuts, Chinese IME and Emoji per tab.
4. Independent navigation, viewport, title and quality changes.
5. Upload, download and clipboard data delivered only to the owning Session.
6. One Session pause, Viewer takeover, close or tab crash without impact on the other three.
7. Child-target handling attributed to the correct Session.
8. Extension service-worker and Core recovery behavior recorded.
9. Direct ICE, TURN/UDP and TURN/TCP or TLS.
10. CPU, memory, FPS, bitrate, RTT, packet loss and sender limitation evidence.

The Gate proves architecture and isolation of session mechanics. It does not promise four simultaneous 1080p/60 streams on a small CPU-only host.

### Four-tab development result

A fresh attachment capture immediately after the isolation run recorded four distinct trusted
bindings. These IDs are runtime-scoped evidence, not stable identifiers:

| Session | Chrome `tabId` | CDP `targetId` |
| --- | ---: | --- |
| `gate0-session-1` | `1333472802` | `39467F4AD1D1C5635944A505AF0C6226` |
| `gate0-session-2` | `1333472803` | `D73ED43CE46E31C1970B1E0F7C36AB1F` |
| `gate0-session-3` | `1333472805` | `2F77ADF11BEC9563534946403FF9A41F` |
| `gate0-session-4` | `1333472804` | `7692BDEED45DD43283057F9AED7DCC57` |

In the isolation run, all four Viewers reached `CONNECTED` and opened `control-reliable`,
`control-realtime` and `file-transfer`. Their selected candidate pairs were direct UDP (`host` on
Worker and `prflx` or `srflx` on Viewer). A local coturn instance also produced relay candidates,
proving credential and allocation plumbing without claiming a forced-relay pass.

A later attachment selected a TURN relay with TCP between Viewer and coturn, but its application
`hello` handshake timed out after the DataChannels opened. That attempt therefore does not count as
a TURN/TCP pass. Its failure path exposed browser-side uses of reserved WebSocket close code `1008`;
browser callers now use private application code `4000`, while Node WebSocket servers retain the
standard protocol close codes. The relay handshake still requires a clean repeat after redeployment.

The four remote inputs contained four different values (`Gate0-A-甲` through `Gate0-D-丁`) when read
back from their owning CDP targets. Closing Session 4 removed only its tab; Session 3 then accepted
additional input while Sessions 1 and 2 retained their values. The shared Extension loopback routes
binary control frames by the validated envelope `sessionId`; Session-level generation checks remain
the second authorization boundary.

The later four-Viewer lifecycle run closed the remaining pause-isolation item. Suspending Session 1
changed only its Standalone state, and Session 2 continued accepting remote text while Sessions 1,
3 and 4 remained unchanged. Resuming Session 1 restored all four to `CONNECTED`. All four test pages
were then disconnected and closed, and all four Standalone Sessions were deleted.

The Worker-side sample used an actual 1086×700 acknowledged viewport after Viewer sizing. With three
Sessions left connected, Chrome's main process reported about 267 MiB RSS, the Core/Gateway Gate
process about 90 MiB RSS and coturn about 17 MiB RSS. Chrome encoder logs reported approximately
28 FPS with active allocations up to 2.5 Mbit/s per stream. These are one-host observations, not
capacity promises; repeatable metrics collection remains part of the Standalone diagnostic work.

### Forced TURN/UDP development result

The signed `0.1.6` Extension and matching workspace builds added a Gateway-assigned standard
`iceTransportPolicy`. A diagnostic Gateway was restarted with `relay`, while its ICE list retained
the existing coturn UDP/TCP endpoints. The Gateway recorded `iceTransportPolicy: relay`, two relay
candidates from Core and two from Viewer, without host or server-reflexive candidates in that pair.

The Viewer reached `CONNECTED`, opened `control-reliable`, `control-realtime` and `file-transfer`,
and reported the selected pair as Viewer `relay` to Worker `relay`, with candidate protocol and relay
protocol both UDP. This closes the forced TURN/UDP item. It does not provide TURN/TCP or TURN/TLS
evidence; those runs require transport-specific ICE URLs and matching coturn listeners.

### Forced TURN/TCP development result

The same signed `0.1.6` Extension and workspace builds were then tested with the Gateway ICE list
reduced to a single `turn:149.88.75.53:3478?transport=tcp` URL and
`iceTransportPolicy=relay`. Gateway recorded one ICE server per role, `pair.completed`, and only a
relay candidate from each peer. The Viewer reached `CONNECTED` and opened `control-reliable`,
`control-realtime` and `file-transfer`.

The selected pair diagnostic reported Viewer `relay` to Worker `relay`, candidate protocol UDP and
`relayProtocol: tcp`. This distinction is expected: the relay candidate transports media as UDP at
the ICE layer while the client-to-coturn allocation uses TCP. The result closes the forced TURN/TCP
item. It does not provide TURN/TLS evidence; that requires a trusted certificate, a TLS listener and
a transport-specific `turns:` URL.

### Forced TURN/TLS development result

The diagnostic host obtained a publicly trusted certificate for a temporary DNS name resolving to
the Worker. coturn listened on 5349 with that certificate, and an independent TLS probe negotiated
TLS 1.2 with certificate verification enabled. Gateway was then restricted to one
`turns:` URL with `transport=tcp` and `iceTransportPolicy=relay`; no STUN, plain TURN or alternate
ICE server was present.

The Viewer reached `CONNECTED`, opened all three DataChannels, and reported Viewer `relay` to Worker
`relay` with candidate protocol UDP and `relayProtocol: tls`. Gateway independently recorded one ICE
server per role, `pair.completed`, and only relay candidates from both peers. This closes the forced
TURN/TLS item. The certificate and temporary DNS name are development evidence rather than a
production deployment recommendation.

This run also exposed a diagnostics type error: the selected-pair sanitizer reused the ICE candidate
protocol union and therefore discarded the valid browser stats value `tls`. Relay transport is now
modeled separately as `udp | tcp | tls`, with a unit regression covering case normalization and the
safe redacted summary.

### Quality preset development result

The signed `0.1.8` Extension was exercised against one real sender while Chrome verbose WebRTC logs
were retained. Each acknowledged preset produced a `ReconfigureEncoder` entry with the expected
limits, and the Viewer inspected its decoded frame dimensions:

| Preset | Encoder maximum bitrate | Encoder maximum FPS | Encoder scale | Decoded Viewer frame |
| --- | ---: | ---: | ---: | ---: |
| `data-saver` | 750 kbit/s | 15 | 2× downscale | 425×356 |
| `balanced` | 2.5 Mbit/s | 30 | Native | 850×712 |
| `high` | 6 Mbit/s | 60 | Native | 850×712 |

This proves sender reconfiguration and decoded output for one test viewport. It is not a throughput
or sustained-60-FPS capacity claim; actual delivery still depends on content, CPU and network.

### ICE restart development result

A connected Session first stored `ice-restart-preserved-20260904` in its page. UDP was then dropped
on the Worker for approximately 12 seconds. Viewer state changed from `CONNECTED` to `RECONNECTING`,
Extension logged `signaling.ice-restart-offer-sent`, and the original Session returned to
`CONNECTED` after the fault was removed.

Standalone still reported Viewer generation 2, CDP still referenced the original target, and CDP
readback returned the stored value. The temporary firewall rule was removed after the test. This
proves the bounded in-pair recovery path; it does not substitute for a real test of
`reconnect.getConnection()`, which requires signaling loss and an Embedder-issued fresh Ticket.

### Periodic media metrics development result

The `0.1.8` run observed Viewer inbound and Extension outbound `webrtc.media-metrics` for audio and
video, plus `data-channel.metrics` for all three channels. One real inbound video sample reported
VP8, 1280×720, 7 FPS, 43,825 bit/s, zero interval packet loss, 7 ms jitter, 59 ms RTT and a 5,004 ms
sample interval. Values are observations, not service-level targets.

The event path was Extension RTCStats → validated loopback schema → Core
`EmbedderHooks.onDiagnostic` → Standalone structured log. It omitted RTCStats and candidate IDs,
addresses, ports, SSRC, SDP, Ticket and page content. After Viewer disconnect, the number of
Standalone metric rows for that Session remained 35 before and after a six-second wait, and
Extension logged one `media.publisher-stopped`. This confirms the observed sampler stopped with its
publisher; repeated lifecycle soak must still check longer-running resource trends.

### Lifecycle soak and replacement correction

The first automated `0.1.8` iteration passed the fresh-Ticket path but exposed a real active-takeover
race. Gateway completed the successor pair while Chrome still considered the old tabCapture stream
active, so the next `getMediaStreamId()` failed and Core reported `Chrome denied tab capture`.

Extension loopback now acknowledges `media.stop` with the matching request and Session. Core waits
for that acknowledgement before asking the service worker for a successor stream ID. Offscreen also
cancels and waits for an in-flight publisher start, and track/PeerConnection callbacks can stop only
the Publisher instance that installed them. This prevents a retired track's late `ended` event from
stopping its successor.

The signed `0.1.9` compatibility set then passed three consecutive iterations followed by five more.
Each iteration changed all three quality presets, preserved a unique DOM marker, suspended and
resumed, restarted the Gateway during a temporary Worker UDP outage, obtained one fresh Ticket,
reconnected with a larger generation, actively replaced the next Viewer, and explicitly closed the
Session. Assertions required the same CDP target and marker across both recovery paths.

Each of the eight passing iterations recorded four completed Gateway pairs, zero pair timeouts, four
publisher stops, outbound media metrics, and no remaining Session, target or temporary file. Across
the five-cycle run Chrome file descriptors stayed at 212 and threads at 32; Standalone descriptors
stayed at 26 and threads at 11. Chrome RSS moved from 273,668 KiB to 274,376 KiB, while Standalone RSS
moved from 104,756 KiB to 97,444 KiB. Gateway was deliberately restarted each cycle and ended with
22 descriptors and 11 threads. This is short deterministic-cleanup evidence, not a multi-hour load
claim.

### Runtime restart development result

A separate destructive probe connected a real Viewer before each runtime event. Restarting only the
Extension service worker preserved `CONNECTED`, the original CDP target and its DOM marker because
the offscreen document continued owning the WebRTC publisher. Capability returned to `ready` after
the worker rebound.

Closing offscreen made the Viewer reach `FAILED`, changed capability to `not-ready`, and caused Core
to close the Session target and temporary state. That run exposed and fixed a Standalone indexing
bug: Core had disposed the Session, but Standalone retained a terminal record. The daemon now evicts
the matching `FAILED` or `CLOSED` record, and a regression proves the released capacity accepts a
new Session. Restarting the service worker recreated offscreen and restored capability to `ready`.

With another active Session, `SIGTERM` left zero Standalone Sessions and zero matching Chrome
targets after restart. A final active Session was then interrupted with `SIGKILL`; the new process
correctly had no undocumented Session state, while the original Chrome target and DOM marker
remained as one expected orphan. The harness closed that target through CDP, and the final snapshot
contained zero Sessions and zero probe targets.

This records the current boundary rather than promising transparent process recovery. Durable
Session ownership and orphan reconciliation belong to Phase 6.

### CDP ownership-loss reconciliation result

Current Core/Standalone builds and signed managed Extension `0.1.14` ran two destructive cases
against Google Chrome Stable `152.0.7977.75` on Ubuntu 24.04. The Sessions intentionally remained
`READY` with no Viewer and no CDP command in flight, ensuring reconciliation did not depend on a
later user action discovering the failure.

Closing the first Session's main target produced `READY → FAILED` with reason
`The attached Chrome CDP Session detached`; Standalone removed it in 43 ms and both Chrome and
Standalone remained available. Killing the whole Chrome process with `SIGKILL` produced
`READY → FAILED` with reason `Chrome CDP connection closed`; Standalone removed it in 104 ms,
kept the same process alive, and returned `503 not-ready` with CDP `unreachable`.

The harness restarted Google Chrome Stable with the exact captured command, environment, working
directory, Profile and log destination. Both Extension roles rebound at `0.1.14`, readiness returned
with coherent versions, and a replacement `READY` Session reused the same ID. Explicit deletion left
zero Standalone Sessions. This proves tracked live-process reconciliation, not recovery of unknown
targets after Standalone itself crashes.

### Standalone crash and orphan reconciliation result

On 2026-09-04, the current Core and Standalone build attached one new Target while preserving an
ordinary baseline Chrome page. A second Session attempting to adopt the same Target received HTTP
`409` with `TAB_ALREADY_ATTACHED`. The harness then placed a crash residue inside the Session-private
temporary subtree, placed an Embedder-owned marker beside that subtree, and sent `SIGKILL` to
Standalone.

Before restart, both the Chrome Target and private residue remained. After the daemon restarted,
readiness returned to `ready`, the Session list was empty, the authenticated reconciliation endpoint
reported the surviving Target as `untracked`, and an unauthenticated request received `401`. Startup
removed the private residue while preserving the Embedder marker and the ordinary baseline Target.
The harness explicitly adopted the orphan by trusted Target ID; the endpoint then reported it as
`tracked` with the correct Session ID. Explicit deletion closed only that Target. The final snapshot
had zero Sessions, no probe Target, the baseline Target intact and no private crash residue.

This proves inspectable recovery and single-owner enforcement. It does not persist business
ownership inside Remote Tab or automatically decide that an unknown Target is safe to delete.

### File upload development result

The signed managed Extension `0.1.10` and rebuilt protocol/client artifacts ran one real upload
against the Standalone API. CDP attached a dedicated target containing a native file input. Remote
pointer input opened that chooser; Core emitted one Session-bound request; the Headless Client sent a
37-byte `text/plain` file over `file-transfer`; and the remote page observed one `change` event with
the exact content.

The first successful byte run exposed that a UUID-only temporary path changes the page-visible
`File.name`. Standalone storage now puts the normalized display name under an opaque per-file transfer
directory. The repeat run observed `client-proof.txt`, then opened a second chooser and cancelled it;
the original input retained exactly one change and the same bytes. Deleting the Session left zero
matching temporary files and zero matching Chrome targets.

An earlier attempt also loaded a stale protocol `dist` and correctly failed with
`PROTOCOL_MESSAGE_UNKNOWN` on `file.upload.request`. Rebuilding the consumer artifacts fixed the
attempt. This is evidence that source tests alone do not validate publishable package coherence; the
workspace build remains part of the required gate.

### File download development result

The signed managed Extension `0.1.12` and current workspace builds used a runtime-wide absolute
Chrome spool configured with `Browser.setDownloadBehavior { behavior: allowAndName }`. Two attached
page targets triggered different 2,097,152-byte downloads concurrently. Each owning flattened CDP
Session received its own `Page.downloadWillBegin` GUID and completion event; no browser-global
`chrome.downloads` source-tab assumption was used.

Two Headless Clients accepted the offers in parallel. Each observed 32 contiguous 64 KiB progress
chunks, a distinct transfer ID, and the expected Session-specific filename. Both assembled Blobs
matched the expected bytes exactly, proving that concurrent files did not cross Session boundaries.
A second download in one Session was rejected through the public client API and emitted
`download-cancelled`. After Viewer disconnect, explicit Session close, and Core result
acknowledgements, the shared `.browser-downloads` spool contained zero files.

The default Chinese Viewer then received another real 2 MiB file. It displayed the exact filename
and formatted size in `保存远程下载？`, changed to progressive receive state after the user selected
`保存到本机`, verified the final Blob, invoked the default object-URL save path, and caused Core to
emit `download.delivered`. The spool again returned to zero files.

This deployment also proved that CRX installation and active runtime version are separate states.
Chrome downloaded `0.1.12` while both active Extension roles continued to report `0.1.11`; restarting
Chrome once more loaded the new code. The final Standalone capability report showed service-worker
and media versions `0.1.12`, the intended runtime generation, and `coherent: true`.

### Child target, local open, and Notice development result

An initial real-Chrome implementation observed `Page.windowOpen`, then synchronously closed the new
target through `Target.closeTarget`. Chrome `152.0.7977.75` left the opener's click listener blocked
and the originating `Input.dispatchMouseEvent` timed out. Delaying close by 50, 100, 250, 500, or
1,000 ms did not restore the opener. That design was rejected rather than hiding the timeout.

The signed managed Extension `0.1.11` run instead installed the normal-Session MAIN-world
`window.open` interception. A remote click listener called `window.open()`, continued to completion,
and updated its page output. Core authorized the resolved URL; Viewer cancellation opened nothing,
and Viewer approval opened `https://example.com/` only in the local browser. Chrome remained at one
parent and zero child targets throughout, and no `CDP_COMMAND_TIMEOUT` occurred. A structured Notice
also traversed Standalone, Core, Extension, DataChannel, Headless Client, and the Viewer, where both
the default toast and typed event were observed.

Automated tests retain `Page.windowOpen` plus `Target.targetCreated`/`openerId` coverage for child
targets that Chrome creates outside the intercepted function, `retain` coverage for maintenance
Sessions, expiry and generation checks for responses, and schema validation for Notice. Viewer
regression coverage additionally proves its public `error` event remains element-local and cannot
reach a global runtime-error handler.

## Input tests

- Coordinate mapping across video letterboxing and viewport revisions.
- Pointer capture, drag selection, button cancellation and reconnect.
- Horizontal/vertical wheel and high-frequency coalescing.
- Printable keys, non-printable keys, modifiers, repeats and key release cleanup.
- IME composition start/update/commit/cancel without double insertion.
- Viewer suspension prevents blind input.
- Replaced Viewer generation cannot send control.

## Media tests

- Capture start, stop, unexpected end and resume.
- Video-only and video-plus-tab-audio.
- Automatic adaptation up to the Embedder cap.
- Resolution changes keep input coordinates correct while old frames drain.
- Viewer autoplay rejection produces a recoverable audio prompt.
- Gateway loss after connection does not stop an otherwise healthy PeerConnection.
- Forced relay confirms TURN rather than accidentally using a direct candidate.

## File and clipboard tests

- Exact size, count and aggregate quota boundaries.
- Chunk backpressure and cancellation.
- Unicode, duplicate and malicious file names.
- Temporary cleanup after success, failure, disconnect and Session close.
- Download attribution by the owning flattened CDP Session; unknown GUIDs are withheld.
- Clipboard reads and writes occur only after an explicit local user action; no timer, focus event or
  page event starts a transfer.
- Clipboard descriptors reject duplicate item IDs or MIME types, unsupported capabilities, items
  above 16 MiB, aggregate payloads above 24 MiB, non-contiguous offsets and activity beyond 120
  seconds.
- Two concurrent Sessions writing different text values receive only their own results even though
  Google Chrome uses a runtime-global host clipboard.
- Text plus PNG paste reaches only the owning remote tab; remote-to-local read validates the PNG by
  decoded dimensions and pixels because Chrome may re-encode the PNG bytes.
- Viewer browser permission denial falls back to manual text paste or a selectable text copy field.
  A denied image write remains visible as an actionable limitation and is never reported as success.
- Cancelable Viewer request/completion events let an Embedder replace the default permission and UI
  behavior without Portal involvement.

The 2026-09-04 real clipboard run used Ubuntu 24.04, Google Chrome Stable `152.0.7977.75`, signed
managed Extension `0.1.13`, current Standalone/Core builds and a macOS in-app Viewer. It passed the
two-Session text isolation, text-plus-4×4-PNG remote paste, remote text/PNG readback, default Viewer
permission-allowed paths, both manual text fallbacks, explicit image-denial feedback and host
`preventDefault()` override. Cleanup left zero Standalone Sessions. The same source then passed
workspace typecheck, build, all six package export checks, and 15 test files with 62 tests.
Reproduction evidence lives in the ignored `tmp/gate0/phase4-clipboard/` directory and is not a
release artifact.

### Page Script development result

The 2026-09-04 real Page Script run used Ubuntu 24.04, Google Chrome Stable `152.0.7977.75`, signed
managed Extension `0.1.14`, current Standalone/Core builds and a macOS in-app Viewer. Both active
Extension roles reported `0.1.14` and `coherent: true` after two Chrome restarts, which prevented an
older embedded Protocol decoder from silently discarding `page.lifecycle`.

One administrator source registered listeners before the fixed bootstrap ran. The remote page
observed document start, Session attached, initial location, DOMContentLoaded and load exactly once
on both `document` and `window`, with the expected Session ID, location and JSON context. A
`history.pushState` change emitted one location event, a full navigation created a new MAIN-world
instance with the same ordered initial lifecycle, and the Viewer received subsequent typed
`page-script-event` values. Closing the Session delivered `on_session_detached` to the Viewer before
the transport closed; full document navigation did not emit it.

Separate Sessions supplied a throwing script and a syntactically invalid script. Both retained a
connected WebRTC Viewer, a usable remote page, and fixed SPA lifecycle delivery. Core recorded
redacted `page-script.error` diagnostics and never converted either failure into a Session failure.
Final cleanup left zero Standalone Sessions and zero matching page targets. Reproduction evidence
lives in the ignored `tmp/gate0/phase4-page-script/` directory and is not a release artifact.

### Initial compatibility Gate 0 result

The 2026-09-04 consolidated Gate used Google Chrome Stable `152.0.7977.75`, signed managed
Extension `0.1.14`, the current workspace Core/Standalone/Protocol/Headless Client builds and a
macOS in-app Chromium Viewer harness. It ran four concurrent Sessions through the whole functional
sequence in one pass: unique trusted Session/`tabId`/`targetId` mappings, video, three DataChannels,
independent input, 60 fps viewport requests, high quality, Page Script context, text clipboard,
upload, owned download bytes, local-open rejection, Notice delivery, reload lifecycle, independent
suspension and deliberate loss of one main target while the other three Viewers stayed connected.

The compatibility set passed twice. The direct run selected server-reflexive or peer-reflexive
Viewer candidates against remote host candidates. The forced TURN/TLS run used only one trusted
`turns:` endpoint with `iceTransportPolicy=relay`; all four pairs reported `relay` to `relay`, ICE
protocol `udp` and `relayProtocol=tls`. Both runs ended with zero Standalone Sessions and zero
Gate-owned targets. Detailed reproducible evidence lives in the ignored
`tmp/gate0/phase5-full-gate/` directory.

The Gate also replaced an invalid evidence technique. Chrome 152 listed Extension service-worker
and offscreen DevTools target sockets that did not answer direct `Runtime.evaluate`; the harness no
longer treats that unsupported behavior as a prerequisite. Core instead exposes its already trusted
read-only attachment identity to the Embedder. Standalone returns that identity only in Session
creation and single-Session detail responses, while Viewer-controlled messages still cannot select
either identifier.

## Security tests

- Expired, replayed, wrong-Gateway and wrong-Session tickets fail without existence disclosure.
- A retryable unmatched Core attempt rebinds the same generation only until Ticket expiry.
- Viewer cannot declare arbitrary `tabId`, `targetId` or CDP endpoint.
- Stale Viewer generation input is ignored.
- Page cannot reach Core loopback or obtain runtime secrets.
- Signaling service rejects oversized and malformed messages.
- DataChannel schema fuzzer cannot trigger an unauthorized action.
- Errors and diagnostics redact secrets and page data.
- Public-port scan cannot reach CDP or extension loopback.

## Viewer support

The first stable release targets current desktop Chrome, Edge, Firefox and Safari. This remains a
tested compatibility set rather than an engine-level assumption: a browser is listed as supported
only after the same built Viewer completes a real Session against the release Chrome node.

| Viewer browser | Host and exact build | Real Viewer result | Current release status |
| --- | --- | --- | --- |
| Google Chrome Stable | macOS, app `152.0.7977.65` | Passed Web Component render, 1280 × 720 video decode, three DataChannels, input, remote clipboard and suspend/resume | Verified |
| Safari | macOS, `26.5 (21624.2.5.11.4)` | Passed the same real Viewer sequence | Verified |
| Microsoft Edge Stable | macOS, official notarized app `152.0.4191.62` | Passed the same real Viewer sequence from an isolated temporary profile | Verified |
| Mozilla Firefox Stable | macOS, official notarized app `155.0.1` | Passed the same real Viewer sequence from an isolated temporary profile | Verified |

The Chrome user agent exposes the reduced `Chrome/152.0.0.0` value; compatibility evidence records
the installed application version separately. Edge similarly exposes `Edg/152.0.0.0`, and Firefox
exposes `Firefox/155.0`. The Safari selected-pair diagnostic omits `relayProtocol`, while Chrome,
Edge and Firefox report `relayProtocol=tcp`; all four established relay-to-relay media and opened all
three DataChannels. Optional diagnostics are not treated as required browser API fields.

The ignored `tmp/gate0/phase7-browser-compat/` harness drives the public Viewer element rather than
the Headless Client directly. Each browser autonomously creates one Session and short-lived Ticket,
requires its browser primitives, waits for decoded video and all DataChannels, drives the Viewer IME
path, round-trips the remote text clipboard, suspends and resumes, verifies Shadow DOM layout, then
deletes its Session and posts a credential-free JSON result. On 2026-09-04 all four verified runs
ended with zero Standalone Sessions. Chrome and Safari used the installed system applications. Edge was
downloaded from Microsoft's Enterprise update feed, matched its published SHA-256, and passed Apple
installer and application notarization checks before temporary package expansion. Firefox came from
Mozilla's official Stable download redirect, passed DMG verification and application notarization,
and was copied only into ignored `tmp/`. Neither additional browser was installed into
`/Applications`, and each used an isolated ignored profile directory.

Mobile browsers are a preview tier rather than part of the first stable desktop guarantee. A
Google Chrome Stable `152.0.7977.65` run used CDP device and touch emulation with a 390 × 844 CSS
viewport, device scale factor 3, five touch points, Android 16 mobile UA metadata and a coarse
pointer. It completed the real Viewer Ticket/WebRTC path, decoded 1280 × 720 video, opened all three
DataChannels, rendered a 390 × 844 non-overflowing shell with a 159-pixel responsive toolbar, and
kept every visible action at least 44 × 44 CSS pixels. A real touch tap focused the remote input,
the explicit mobile keyboard action delivered committed Chinese text, a single-finger gesture moved
a remote range control from 0 to 88, and a two-finger gesture scrolled the remote document to
`scrollY=102`. The same changed Viewer then passed the complete desktop Chrome input, clipboard and
suspend/resume sequence. This is interaction-path and responsive-layout evidence, not a physical
Android or iOS device compatibility claim.

The preview degradation is deliberate: the component displays its support boundary, keeps narrow
controls horizontally reachable, exposes a separate soft-keyboard button, and retains permission
fallbacks for clipboard and downloads. Hover, right-click, desktop shortcut parity, simultaneous
multi-touch page gestures and browser-specific fullscreen/download behavior are not promised. Full
mobile parity remains deferred.

## Multi-Chrome runtime isolation

On 2026-09-05 one `ExtensionLoopbackServer` accepted the service-worker and media roles from two
Google Chrome Stable `152.0.7977.75` processes. Both used Extension `0.1.14`, a shared Worker
generation and secret, separate Profiles and CDP endpoints, and distinct `runtimeInstanceId` values.
Core broadcast each Target lookup, obtained exactly one successful runtime response, and attached one
Session to each Chrome.

Two simultaneous public Viewers then completed Signaling and WebRTC. Each decoded 1280 × 720 video,
opened `control-reliable`, `control-realtime` and `file-transfer`, and reached `CONNECTED`. Distinct
IME markers changed only the title/input in the owning Chrome target; the other runtime retained its
own marker. The chosen path was UDP server-reflexive to server-reflexive, with TURN/UDP and TURN/TCP
available as fallbacks.

The first real Viewer attempt found a sequencing defect that the single-runtime fallback had hidden:
Gateway `peer-ready` could arrive before capture established the Session/runtime mapping. Core now
binds `Session → runtimeInstanceId` immediately after unique Target resolution and before signaling
can begin. The repaired build passed the same real sequence. Deterministic loopback coverage also
keeps two runtime pairs connected without replacement, rejects a Target claimed by two runtimes,
routes Capture/media/binary control by Session, preserves one runtime when another disconnects, and
retains legacy binds that omit the optional instance ID.

Credential-free evidence and the ignored harness are retained in
`tmp/multi-runtime-20260905/RESULTS.md`.

## README-only clean deployment evidence

On 2026-09-04 an authorized Ubuntu 24.04 `x86_64` host received a 2.3 MB source snapshot containing
no `.git`, `node_modules`, `tmp`, build output, runtime environment, CRX or private key. Starting
from that directory, the README commands installed the locked pnpm workspace, built Extension
`0.1.14`, generated a new private key, self-signed a CRX and produced its update manifest. The
private key remained outside the served release directory and `runtime.env` was mode `0600`.

An isolated Compose project used six non-default ports to ensure the container entrypoint, managed
policy and health checks honored one runtime configuration rather than historical default port
constants. The Docker build verified the pinned Google Chrome `.deb` SHA-256 and exact Debian
package version. A fresh Profile installed the force-managed CRX and completed its controlled
bootstrap restart. Readiness then reported CDP plus both Extension roles connected and coherent;
the compatibility checker reported Chrome `152.0.7977.75`, Extension `0.1.14`, protocol `1.0` and
zero active Sessions.

The same README request created a new `https://example.com/` tab and returned `READY` with trusted
`targetId` and `tabId` attachment identity. Deleting it returned all eight bounded Standalone
Session gauges to zero, with reconciliation reporting zero tracked and zero attaching Sessions.
Listener inspection independently found only the Signaling Gateway on `0.0.0.0`; metrics, update
server, CDP, Extension loopback and Standalone API remained on `127.0.0.1`. A normal Compose `down`
preserved all three named volumes. The pre-existing rollback baseline was then restarted with its
original images and volumes and returned healthy with coherent Extension roles.

Credential-free command and result evidence is retained in ignored
`tmp/gate0/phase7-readme-deployment/RESULTS.md`. This proves a source/Compose evaluation deployment;
it does not replace a future hosted source release, TLS ingress, TURN configuration or published
artifact verification.

## Release-candidate security evidence

The final source then ran a second isolated clean deployment with another Extension key, four new
runtime credentials, a fresh Profile and separate volumes. Fourteen Standalone/Gateway negative
cases, four Extension loopback Origin cases, an expired-Ticket metric case and a bounded runtime-log
secret scan all passed after the resulting fixes. Listener inspection exposed only Signaling; CDP,
Extension loopback, Standalone, metrics and updates remained on loopback. Details, fixed findings
and residual limits are in
[Release-candidate security review](21-release-candidate-security-review.md).

Accessibility checks cover keyboard access, focus visibility, dialog focus traps, accessible labels, status announcements, reduced motion and WCAG AA contrast for Viewer UI.

## Release evidence

Every release records:

- Git revision and package versions.
- Chrome and Extension versions.
- Operating system and architecture.
- Gate 0 or regression-suite result.
- ICE/TURN route evidence.
- Known browser limitations.
- npm tarball and image checksums, image digest and SBOM.

### Public source and hosted candidates (2026-09-08)

The public `x3zvawq/browshare-remote-tab` repository contains the initial `init` commit
`c4457f08580812349e68c31c741d010fdd5f0c82`. Its MIT `LICENSE` and complete `CHANGELOG.md`, including
the explicitly unpublished 0.1.23 candidate, were fetched anonymously from that exact public commit
and compared byte for byte with the checkout. The source-publication checkbox records this result;
it does not require or imply a version tag, npm package, public container or official CRX release.

[Hosted CI](https://github.com/x3zvawq/browshare-remote-tab/actions/runs/34207712780) passed source,
package, test, documentation and Compose checks, three container builds, GitHub provenance and the
aggregate gate. The received candidate's 19 checksums and provenance subjects passed verification.
Each of the six npm tarballs passed GitHub attestation verification bound to this repository,
`.github/workflows/ci.yml`, the full source commit and `refs/heads/main`, rejecting self-hosted
signing runners. Downloaded chrome-node, signaling and standalone SBOM checksums also passed,
with 226, 96 and 97 packages respectively. This verifies received CI artifacts; the final current-candidate transport and desktop
results are recorded below, separately from these initial hosted artifact checks.

Credential-free results are retained under the ignored `tmp/hosted-ci-qa/`, including
`source-publication/result.json`, `npm-attestation-result.json` and `container-sbom-result.json`.

### Correlated Notice 0.1.16 development result (2026-09-06)

An isolated Linux container ran Google Chrome Stable 152.0.7977.75, the fixed-ID signed 0.1.16
Extension, built Core/Gateway and protocol 1.1. Local Google Chrome Stable 152.0.7977.76 used the
built default Viewer over real WebRTC. Selected candidate evidence was UDP prflx → host; visible
1280×720 video advanced during decisions. Button correlation, null dismissal, Escape, expiry,
AbortSignal, four-request capacity, custom host UI, duplicate response rejection, capability
revocation, Viewer replacement, disconnect and Session close were observed end to end. A Viewer
without the capability stayed connected and could not receive a Notice request.

Closing only the reliable DataChannel exposed a stale Viewer modal. The client now enters its
existing transport-failure/reconnect flow on closure of its current reliable channel. A rerun
observed the Extension's generation-bound control-closed event, Core null/connection-lost result,
Viewer notice-closed event, removed modal and explicit FAILED state when no reconnect provider
was configured. The source also retains the established fresh-Ticket recovery path.

At 390px, a maximal long button initially overflowed its fixed height. Automatic button height
and a separately scrollable message body fixed it: page width390, dialog width354, button content
height94 with no overflow, and visible heading/actions. HTML-looking content remained text, with
zero child elements inside the message body. Local task browser and forwarding were closed; the
QA container exited0 with Core/Chrome cleanup complete.

This is focused development verification. Page Script Notice routing and human navigation
confirmation are not implied by the transport result, and the full Direct/TURN release Gate 0
matrix has not been rerun for 0.1.16. No npm, image or Extension publication was performed.

### Page Script Notice and resized Viewer candidate verification

The 0.1.16 candidate was exercised with Linux Google Chrome Stable 152.0.7977.75, the signed
fixed-ID Extension and macOS Google Chrome Stable 152.0.7977.76 over real WebRTC. The Page Script
bridge delivered approval and dismissal to its originating main document, rejected invalid content,
ignored iframe/isolated-world and foreign-Session envelopes, cancelled retired-document requests,
and accepted a fresh request after navigation. Four pending requests, pagehide cancellation and
capability revocation were also exercised. A second Session without a Viewer could not borrow the
first Session's Viewer.

Viewer windows 1280×800, 1280×500, 390×844 and 600×1000 preserved all four remote corners and
delivered actual pointer clicks to each. This caught and fixed intrinsic grid expansion and a status
badge intercepting input. Capture padding is cropped within an ACK-shaped video element; pointer
coordinates continue to use the acknowledged remote viewport. Existing tests (77 in 18 files),
workspace type checking, builds and package export checks passed. This focused candidate check
does not constitute a fresh complete Direct/TURN release matrix.


### Capture replacement 0.1.17 development result (2026-09-06)

An isolated Linux Google Chrome Stable 152.0.7977.75 runtime used the fixed-ID signed 0.1.17
Extension and built Core, with protocol 1.1 and a local Google Chrome Stable 152.0.7977.76 Headless
Client receiver. Two remote pages painted red and blue and generated an audio oscillator. Decoded
900×600 frames changed across repeated main/child capture replacements. There was one peer, one
SDP offer and the same three open DataChannels throughout. A correlated Notice completed after
replacement. Audio RTP reached the receiver and, with audio playback enabled, reported nonzero
decoded audio energy.

Invalid stream ID, stale generation and changed audio topology rejected while preserving the old
blue capture. Replacement while suspended stayed black and resumed to the new red source. Closing
the previous child source preserved the current capture. Session close closed all channels; the
receiver without reconnect entered its explicit FAILED state. Test-owned local Chrome, forwarding
and the isolated server runtime were closed. The existing BrowShare Worker was not upgraded.

Targeted lifecycle tests cover partial sender failure closing both streams/peer/channels, delayed
capture resolution after stop, concurrent replacement rejection, old-stream ended events,
suspension preservation, ACK Session/generation binding, disconnect rejection and timeout teardown.
These checks supplement the real media path; they do not establish Viewer window selection,
cross-window input or a full release Direct/TURN/browser matrix. Temporary scripts and detailed
evidence remain under ignored `tmp/capture-replacement-qa/` and are not distributed release assets.

### Local-open startup boundary (2026-09-06, unpublished 0.1.21 candidate)

Real Google Chrome Stable 152.0.7977.75 on Linux and Viewer Chrome152.0.7977.76 on macOS
verified browser-scoped Target startup interception. Concurrent ordinary controllers closed anchor
and POST popup targets before any destination request; retained maintenance-style and unrelated
controllers continued loading. Closing one owner preserved the other owner's interception, and
last-owner detach released it without leaving paused pages.

The BrowShare Portal/Backend/Worker/Core/Extension/WebRTC flow then verified native local-open
confirmation with640px video. Before approval neither native popup path reached the destination;
after approval the local browser issued GET without remote cookies, Referer or POST body, with null
opener. Cancel, Escape, denied policy, unsafe URL and expiry caused no destination request. Native
modality, Chinese/English text and390px mobile fit were checked. Session and fixture cleanup and
local Chrome/forward shutdown completed. Core typecheck/build and the existing CDP/Session tests
passed; Viewer typecheck and Portal build passed. This candidate evidence does not replace the
full published compatibility or release Gate.

### Focus suspension and RTP pause (2026-09-06, unpublished 0.1.22 candidate)

The BrowShare Portal → Backend → Worker → Core/Extension flow used real Google Chrome Stable
152.0.7977.75 on Linux and 152.0.7977.76 on macOS, with video and synthesized tab audio.
Returning within the 15-second grace period cancelled suspension. After the next grace period,
two samples 1.2 seconds apart retained identical inbound audio bytes (70923), video bytes (119002)
and decoded frames (118). Resume increased all media counters and decoded a new video keyframe,
with one PeerConnection throughout. The three DataChannels remained open and the remote canvas
continued updating during suspension. This caught and fixed the previous track-only pause, which
continued sending black video and silent audio; sender encodings now become inactive.

WHEN_HIDDEN remained connected while visible and unfocused. Native Chrome window minimization
produced actual hidden visibility and suspension, and restoration resumed the stream. NEVER and
the manual Resume button were exercised. The macOS desktop was locked: visible focus/blur input
was supplied by overriding document.hasFocus and dispatching events in real Chrome, then restored.
This verifies policy handling and real media effects, not an unlocked native app-switching gesture.
API permission, validation, global inheritance and Profile override checks passed in BrowShare.
Temporary fixtures and RTP samples live in ignored tmp/focus-policy-qa; this focused acceptance
does not replace the full Direct/TURN release matrix or establish publication of 0.1.22.


### Advanced quality development evidence (2026-09-06, unpublished 0.1.23 / protocol 1.4)

The real BrowShare Portal → Backend → Worker → Core/Extension → Google Chrome Stable/WebRTC
path has now exercised advanced configuration with a Linux Publisher and a macOS Chrome Viewer.
The following results are focused development evidence, not a refreshed release Gate. Detailed
artifacts are in BrowShare's ignored `tmp/advanced-quality-qa/`; they are local QA evidence, not
publicly distributed release assets. Each filename below identifies the inspected evidence.

| Real-media case | Observed result | Evidence |
| --- | --- | --- |
| Default auto → high | Confirmed 6 Mbit/s, 60 FPS, scale 1; decoded 1280×720 at about 46.9 FPS over four seconds | `high60-receiver.json`, `high60-sender.json` |
| High → data saver | Confirmed 750 kbit/s, 15 FPS, scale 2; decoded 640×360 at about 14.5 FPS | `saver15-receiver.json` |
| Data saver → custom 60 FPS | Capture track reports 60 FPS and sender maxFramerate 60; decoded resolution returns to 1280×720 with about 49.2 FPS over four seconds | `custom60-receiver.json`, `custom60-sender.json` |
| Custom scale 2 | 1.5 Mbit/s, 20 FPS, scale 2 produced 640×360 at about 19.1 FPS | `custom-scale2.json` |
| Input under encoded downscale | A center pointer reached remote CSS coordinates 640,321.5 in a 1280×643 viewport | `pointer-scale2.json` |
| Two immediate configurations | The superseded promise rejected with ILLEGAL_STATE_TRANSITION; the second resolved to its own 1 Mbit/s, 20 FPS, scale 1 state | `correlation.json` |
| Rejected publisher configuration | CAPABILITY_UNAVAILABLE preserved the previous confirmed state, CONNECTED and one peer | `rollback.json` |

The source can now move from initial 30 to 60 to 15 and back to 60 FPS within the same connection.
These are capture/encoding maxima, not a guarantee of stable 60 FPS delivery: the measured high and
custom intervals were approximately 46.9 and 49.2 decoded FPS. A sender ACK alone was insufficient
proof; the earlier implementation reported higher encoding limits while the source remained at 30.

Suspension retained one peer and fixed audio/video RTP byte counters across a six-second interval.
The decoder finished two already-buffered frames during that pause, so the evidence does not claim
an immediately frozen decoded-frame counter. A new 500 kbit/s, 10 FPS, scale 2 configuration was
present after resume, with increasing audio/video bytes and decoded frames on the same peer
(`suspended.json`, `resumed.json`).

#### Real network and encoder pressure

An owned UDP-flow egress policer limited the active WebRTC flow to 500 kbit/s. A real sender sample
reported approximately 16.9% packet loss. Within the 24-second receiver observation auto reduced
2.5 Mbit/s / 30 FPS / scale 1 to 1.75 Mbit/s / 24 FPS / scale 1.25; decoded dimensions changed from
1280×720 to 1024×576. Removing the owned pressure rule and observing for 35 seconds restored
2.5 Mbit/s / 30 FPS / scale 1 and 1280×720. Both intervals retained one CONNECTED peer. The evidence
is `network-pressure-receiver.json`, `network-pressure-sender.jsonl`, and
`network-recovery-receiver.json`; it uses actual packet impairment and RTP, not injected RTCStats.

The first CPU experiment capped the whole container at 0.5 CPU and produced low FPS while the
sender still reported limitation reason `none`. That result was not treated as proof of the encoder
CPU branch. Subsequent competition on the actual encoding process produced sender
`qualityLimitationReason: cpu`, around 1 FPS, zero sampled loss and RTT around 77–82 ms
(`encoder-contention.jsonl`). Automatic state then stepped down under sustained pressure.

The latter run negotiated both quality capabilities while omitting `diagnostics`. Its hello and
confirmed state events show auto changing from healthy 5.10 Mbit/s / 48 FPS through repeated
reductions to 1.225 Mbit/s / 19 FPS / scale 2.44140625, with one connected peer
(`no-diagnostics-cpu-proof.json`). This establishes that the policy sampler continues without
diagnostic-delivery permission. The earlier short `capability-no-diagnostics.json` observation
correctly recorded no adjustment; it is not used as the pressure proof.

A 22-second static-page interval encoded only about 6.5 FPS and 43.8 kbit/s while retaining auto's
2.5 Mbit/s / 30 FPS / scale 1 limits (`static-page.json`). Low activity by itself did not cause a
downgrade. Temporary encoding-process affinity was restored and the owned network pressure removed;
the later normal-runtime report confirms the rebuilt container has no test CPU quota, as detailed below.

#### Negotiation and failure boundaries

Each capability case reloaded Portal and confirmed takeover to obtain a new Viewer generation.
Only the outgoing hello's capabilities/minor were altered on real DataChannels; the Publisher,
media, control requests and responses remained real. The mode reports all passed:

| Mode | Verified boundary | Evidence |
| --- | --- | --- |
| Minor 3 still requests advancedQuality | Advanced capability is not accepted; all three legacy presets ACK; no unsolicited new quality message | `capability-minor3.json` |
| Minor 4 omits advancedQuality | Existing three-preset controls and legacy ACKs remain usable | `capability-no-advanced.json` |
| Omits qualityControl but requests advancedQuality | Advanced capability is removed, quality UI hidden | `capability-no-quality-control.json` |
| Both quality capabilities, no diagnostics | Auto configuration and continuing media; later actual CPU-pressure adaptation as described above | `capability-no-diagnostics.json`, `no-diagnostics-cpu-proof.json` |

For the first three modes, a deliberately sent raw `quality.configure` returned
`quality.configuration_failed` with the same request ID and CAPABILITY_UNAVAILABLE. This explicit
negative probe is separate from the assertion that an old peer receives no unsolicited advanced
messages. Video continued with increasing decoded frames and no peer replacement after rejection.
These are negotiation cases; they do not establish live capability revocation after an active grant.

#### Capped Session, replacement and Viewer dialog

A separately created Session with a 400 kbit/s / 12 FPS ceiling acknowledged both initial auto and
custom at those values. The sender reported maxBitrate 400000, maxFramerate 12 and capture-track
frameRate 12; the real Viewer remained CONNECTED and decoded increasing frames
(`capped-created.json`, `capped-ack.json`, `capped-sender.json`, `capped-receiver.json`). The 4.5-second
receiver sample was about 6.2 FPS and 459.8 kbit/s. The latter is above the configured target over this
short interval: this verifies capture/encoder settings, not a hard instantaneous network-byte quota.
This evidence covers the new auto/custom clamp path together with the existing preset and immutable
Session-snapshot evidence. It is not presented as an exhaustive permutation of every mode and reconnect.

The owned-window test selected a child while custom 1.5 Mbit/s / 40 FPS / scale 2 was active, then
suspended, returned to the main window and resumed. The quality state remained identical, the same
single peer remained connected, and child video decoded at width 640. Both sender samples report
capture FPS 40 and the same encoder limits (`capture-replacement-report.json`,
`capture-replacement-sender.json`). This proves preservation through real replacement and paused replacement. Together with the source
ceiling and frame-rate transition evidence above, it covers the changed capture boundary.

The default Viewer dialog now has real browser evidence for blank/range/integer validation,
0.001-kbps precision, pending controls and successful retry. Entering 1200.123 kbps / 17 FPS / 1.5
produced a real sender ACK of 1200123 bits/s / 17 FPS / 1.5, and reopening retained valid decimal
values. Cancel discarded edits. Keyboard navigation reached the fields/actions, and the dialog's
input probe recorded no remote input. Native Tab navigation can visit browser chrome; the evidence
does not claim that browser chrome is trapped by the page modal. Escape preserved the confirmed
configuration (`ui-fields-report.json`, `ui-report.json`).

A controlled public-method rejection kept the dialog open with its draft and retry message; retry
then applied against the real sender. The rejection itself was an injected UI fault, separate from
`rollback.json`'s Publisher failure evidence. A delayed public call exercised pending-control
lockout, then completed the real send/ACK path. In the 390px English view, document width remained
390px and the dialog fit at 356px. Automated Viewer/dialog scans reported zero definite violations,
with manual-review items remaining for contrast and live-video captions (`ui-a11y.json`,
`ui-dialog-a11y-fixed.json`); these scans are not a full accessibility conformance claim.

Final Portal typecheck/build passed (`portal-final-typecheck.log`, `portal-final-build.log`), and the
final UI was deployed. A controlled failure of the real sender's next capture-constraint operation
was triggered by an actual form submission: the modal remained open with its error, the previous
1.5 Mbit/s / 40 FPS / scale 2 state remained confirmed, the Session stayed CONNECTED and no Reconnect
UI appeared. Retrying the form succeeded against the sender at 1.3 Mbit/s / 40 FPS / scale 2.
The final primary-button foreground was rgb(11,12,16) (`final-ui-report.json`). This closes the
sender-failure-to-Portal/UI retry path, separately from the earlier public-method-only UI injection.

The rebuilt normal Worker reports NanoCpus 0, `cpu.max` equal to `max 100000`, no unsafe Extension
debugging flag and no temporary DeveloperToolsAvailability policy override. It runs Google Chrome
152.0.7977.75 (`normal-runtime-report.json`). This proves the normal runtime configuration has been
restored. Its final normal-runtime smoke has also passed (`normal-final-smoke-report.json`):
initial auto was CONNECTED; custom 1.4 Mbit/s / 40 FPS / scale 2 decoded 640×360 at about 38.52 FPS;
high 6 Mbit/s / 60 FPS / scale 1 decoded 1280×720 at about 57.61 FPS. Suspending, configuring auto
while paused, and resuming returned CONNECTED with the same single peer. These are measured
intervals, not a stable 60 FPS throughput promise.

The final harness reported clean with no pending requests (`final-harness.log`). The owned local
Chrome process was terminated, the `advanced-quality` browser-automation session closed and all
three test forwards cancelled. Server pressure processes were absent and the original root qdiscs
remained without the temporary clsact rule. No test CPU quota or Extension-debugging configuration
remains in the normal Worker.

#### Fixes driven by the real path and completion boundary

The real Publisher investigation corrected five related boundaries: use one `getParameters()`
transaction snapshot for each `setParameters()` operation; update only mutable capture dimensions,
not the original tabCapture device token; roll back only stages that actually applied; acquire the
source at the Session FPS ceiling so subsequent capture constraints can increase FPS; and admit the
new quality messages on the Extension's reliable control allowlist. Source/UI also preserves integer
bit/s values through fractional kbps input at 0.001-kbps precision, verified by the real dialog ACK
described above. The actual sender and capture-operation samples support the media
fixes; typechecks alone are not the evidence for effective FPS.

The advanced-quality module's focused implementation, real-path acceptance, final normal-runtime
smoke and owned-resource cleanup are complete. Capped configuration, negotiated refusal, request
correlation, capture replacement and final UI failure/retry have the concrete evidence above.
This does not claim every combinatorial preset/reconnect/FPS permutation or a dedicated
live-revocation run; those proof limits do not replace the completed changed-path checks.

The full Direct/TURN/browser compatibility matrix, reproducible final artifact assembly and external
publication remain separate release requirements. This development evidence does not mark those
Gate items complete.

### Deterministic close and owned Chrome exit (2026-09-06, unpublished 0.1.23)

The candidate was exercised with Google Chrome Stable 152.0.7977.75, actual Core,
BrowShare Worker Session ownership and file storage. A scoped CDP relay injected main-target
`Target.closeTarget` false/error responses and a descendant-close RPC error. Failed cleanup
preserved CLOSING ownership and uploads; removing the fault and retrying removed exactly the
owned targets and files, leaving the baseline targets unchanged.

Disconnect/reconnect used the same Chrome browser WebSocket identity. A descendant created while
the Session CDP connection was unavailable was found by the known opener graph and cleaned on
recovery. Attachment initialization failure before a public handle was returned also preserved
ownership, and a subsequent manager `closeSession` retry completed cleanup.

An independent actual ProfileChromeRuntime supervisor/flock/Chrome process group supplied the
owned-process exit proof. CDP observation was disconnected before stopping Chrome, so a target
destruction event could not substitute for owner proof. After both the actual Chrome PID and its
process group were absent, closing without proof still returned `CHROME_CONNECTION_FAILED` and
retained files. The Embedder's verified `browserClosed: true` then completed cleanup.

These fault harnesses explicitly fixture numeric Extension tabId mapping, bind/release and media;
the configured Extension service worker rejected CDP attachment. They prove actual Chrome CDP,
Core, Worker ownership and file cleanup, not a media negotiation by the harness. A separate normal
deployed signed-Extension Viewer retained the same PeerConnection/stream and decoded 85–89 frames
per three-second sample during the close/reconnect fault runs. The subsequent normal, maintenance
and throwing-Page-Script Sessions each completed actual WebRTC and API closure.

Temporary evidence lives under the Embedder's ignored `tmp/lifecycle-qa/` and `tmp/page-context-qa/`.
All owned test Chrome processes, targets, fixtures and local Viewer browsers were closed. Backend
periodic retry under persistent cleanup failure remains a separate Control recovery acceptance;
these results do not establish external publication or a new full release compatibility Gate.


### Standalone diagnostic log privacy correction (2026-09-07)

The Standalone stdout sink previously serialized the public Core `page-script.error` event's
free-form message. An Embedder Page Script can throw an error containing page data. The CLI now
logs the fixed `PAGE_SCRIPT_FAILED` code for that event, retaining Session ID, event name and time;
the Core diagnostic hook and the event delivered to embedders are unchanged.

Standalone typecheck/build and the production formatter check passed. The check used the actual
Core-to-Standalone event shape with three synthetic sensitive markers: the old stdout expression
included them, the new formatter omitted them, and the original event and unrelated lifecycle logs
were preserved. This is log-sink evidence, not a new Chrome/CDP/WebRTC run. Local paired-workspace
proof is in ignored `browshare/tmp/observability-qa/standalone-log-result.json`; no external artifact
was published.

### Current candidate transport Gate (2026-09-08, 0.1.23 / protocol 1.4)

The runtime was rebuilt from the anonymous public source commit
`8fb6909954be2fe5590ba6a5241684e9378827cb`, using the formal Dockerfile targets. It ran
Google Chrome Stable `152.0.7977.75`, managed signed Extension `0.1.23` and protocol `1.4`
on Ubuntu 24.04 amd64. The independent QA Extension signing identity is not an official
publisher identity. Client, Protocol and Viewer browser inputs were the received, attested
0.1.23 candidate tarballs from public commit `c4457f08580812349e68c31c741d010fdd5f0c82`;
those components and Core/Extension did not change between these two commits.

The real first request with thirteen known capabilities exposed a Standalone REST schema
limit of twelve despite the protocol registry containing seventeen. Session creation, Ticket
issuance and capability updates now derive their shared limit from `CAPABILITIES.length`.
The actual Chrome runtime accepted all seventeen with the required `childTargetPolicy: retain`,
while six unknown/duplicate-list requests returned 400 without leaving a Session. The nine
Standalone HTTP tests passed, and [CI for the runtime fix](https://github.com/x3zvawq/browshare-remote-tab/actions/runs/34219026564)
completed successfully. Window selection without retained child targets remains correctly rejected.

Each of the following routes passed the same four-concurrent-Session flow in local branded
Google Chrome Stable `152.0.7977.76`:

| Route | Actual selected candidate evidence | Result |
| --- | --- | --- |
| Direct | local prflx, remote host, UDP; no relay | Passed |
| Forced TURN/UDP | both relay, `relayProtocol: udp` | Passed |
| Forced TURN/TCP | both relay, `relayProtocol: tcp` | Passed |
| Forced TURN/TLS | both relay, `relayProtocol: tls` | Passed |

Every run verified unique Session/tabId/targetId mappings, decoded video and all three
DataChannels, pointer/drag/wheel/key/Ctrl+A and Chinese/Emoji input, custom and automatic
quality acknowledgements, Page Script context, clipboard round-trip, actual uploaded bytes,
two concurrent downloads with distinct ownership and exact bytes, local-open rejection, Notice,
reload and per-Session navigation/back/forward/suspend/resume. Generation-two Viewer takeover
rejected the retired peer's input; destroying one suspended target left the other three connected.
Final authenticated inventory and CDP inspection showed zero Sessions and owned targets.
All four container memory-event counters showed no OOM, and each owned local browser closed.
Configured frame-rate limits and collected media metrics are not a sustained 60 FPS capacity claim.

TURN/TLS used only a `turns:` endpoint with the publicly trusted Let's Encrypt YE2 certificate
for `149-88-75-53.sslip.io`, valid from 2026-09-08 through 2026-12-07. Browser certificate-error
bypasses were not used. The temporary Chrome profile mapped only this hostname to the server IP.
The one-shot certificate tool exited without a renewal service.

Original failed attempts remain under ignored `tmp/release-gate-0123/`. The temporary harness's
script-only file click was replaced by real public pointer events; unchanged upload/download
runtime code then passed all four routes. Accepted run directories are
`direct-1788866627009`, `udp-1788866729119`, `tcp-1788866837280` and `tls-1788866931964`.
This transport result is one part of the current-candidate Gate; the final corrected-client
desktop matrix below completes its browser coverage. It does not publish npm packages, GHCR
images or an official signed Extension.

### Shared-stream playback correction (2026-09-08, unpublished 0.1.23)

Native Safari playback instrumentation found that the audio and video `track` callbacks supplied
the same MediaStream object, but Headless Client assigned it twice to `video.srcObject`. The
second assignment reset the actual media element and rejected the first pending `play()` with
`AbortError`. A subsequent play could succeed, so this observed reset is not proof that every
black frame has the same cause. The client now binds and starts playback only when the stream
object changes; explicit attach/detach and genuinely new stream replacement retain their semantics.

The added client tests failed against the original implementation and passed after correction
(10 scoped tests total), including pending playback, shared audio/video tracks, distinct stream
objects with the same ID, detach/reattach and unchanged `NotAllowedError` feedback. Client
typecheck and package build passed. The packed corrected client was used by the same Viewer
package in actual Safari: one stream binding and one resolved play request, no duplicate-binding
AbortError, advancing video time before and after suspend/resume, complete functional flow, and
zero final Sessions. Detailed evidence is under `tmp/release-gate-0123/client-media-fix/`.

The original Safari supplementary playback timeout remains recorded, rather than overwritten
by later success. A separate background-connect/foreground-return diagnostic run completed:
play waited while the document was hidden and resolved on returning to the visible foreground.
No new retry loop, autoplay bypass or speculative native-pause policy was introduced.

### Final corrected-client compatibility result (2026-09-08)

Client fix `97f3bd2e60e90064ff5fcd0d3ca5e9a79d32e75b` completed the same four-Session
Direct, forced TURN/UDP, TURN/TCP and TURN/TLS flow using the packed corrected client.
Each route retained decoded video, all three channels, isolated functional and lifecycle checks,
actual selected-pair/media metrics, zero final Sessions/targets and owned browser cleanup.
The runtime remained the separately identified 8fb6909 build because this change affects the
browser client only. Accepted reruns are `direct-1788869155425`, `udp-1788869012236`,
`tcp-1788868905699` and `tls-1788868776475` under the ignored Gate evidence directory.

The same corrected Client with the unchanged Viewer/Protocol packages also passed the real
desktop Viewer matrix, including layout, advancing video time, three channels, Chinese/Emoji
input, clipboard round-trip, applied custom/auto quality, suspend/resume, usable controls and
zero final Sessions:

| Actual desktop browser | Version | Transport evidence | Result |
| --- | --- | --- | --- |
| Google Chrome Stable | 152.0.7977.76 | both relay, `relayProtocol: tls` | Passed |
| Microsoft Edge | 152.0.4191.66 | both relay, `relayProtocol: tls` | Passed |
| Safari | 26.5 (21624.2.5.11.4) | both relay; only `turns:` offered | Passed |
| Firefox | 155.0.1 | both relay, `relayProtocol: tls` | Passed |

Safari was operated through native desktop UI because WebDriver remote automation was disabled;
that setting was not changed. Safari does not expose `relayProtocol` in these candidate statistics.
Its TLS route is inferred from the sole `turns:` configuration, actual relay pair and independently
observed established TCP connections to the TLS-only TURN listener during an isolated Safari run,
not from a fabricated browser field. System DNS and certificate validation were retained.

Chrome/Edge and Firefox used real user clicks when playback needed activation. Firefox's temporary
Profile first-use terms were accepted only after explicit user confirmation. Its repeated-profile
startup initially restored a previous QA page and violated the zero-Session baseline; the temporary
Firefox harness now starts only after clicking its verification button, so inactive restored QA
pages cannot create competing Sessions. These driver failures and the Safari diagnostic timeout
remain in evidence. All owned local browser processes and test tabs were closed after acceptance.

This completes the current 0.1.23 candidate Direct/TURN and four-desktop matrix. Official npm,
GHCR and signed Extension distribution remain separate unchecked external-publication items.

The subsequently published source commit `968a66092edff2de72f36055ec97a08c4b473f47` passed
[its hosted CI](https://github.com/x3zvawq/browshare-remote-tab/actions/runs/34225368970),
including the three container targets and GitHub build provenance. The received artifact bundle
passed the formal verifier for all 19 checksums and provenance subjects. Its Client, Protocol and
Viewer `dist/index.mjs` files were byte-identical to the entries used in the accepted matrix above.
The received Client tarball also passed GitHub attestation verification constrained to this
repository, CI workflow, full source commit, main ref and hosted runner. This connects the tested
client to the publicly retrievable CI candidate; it does not claim registry publication. Evidence is
retained in ignored `tmp/hosted-ci-qa/current-968a660*` and
`tmp/release-gate-0123/client-media-fix/final-gate-manifest.json`. Gate containers, temporary
volumes, target service, local controllers and owned SSH forwards were removed after acceptance.

## Maple fonts and complete Chrome Node image (2026-09-08)

Clean public source `a2ae55c0c46aa6e8aabd5c4e98cc8aed055698b3` was built using the complete
`chrome-node` Docker target under a restrictive checkout umask. The real production entrypoint
installed the existing signed QA Extension 0.1.23, completed its first-install restart, and created
two READY Sessions through the Standalone API before and after restarting the same owned Profile.
Chrome platform-font inspection confirmed Maple Mono CN for Latin and Chinese in standard,
serif, sans-serif and fixed families, including bold and italic; an explicit website font remained
Liberation Serif. The Profile restart retained site localStorage and unrelated Chrome preferences.
The image includes the upstream OFL text with readable permissions.

This run found and fixed a real nonroot startup failure: `pnpm deploy` preserved a root-owned
0600 package manifest, preventing UID 1000 from resolving package exports. Both runtime application
COPY instructions now assign ownership to `node`. The clean full rebuild and actual Signaling and
Standalone startup passed. The earlier failing image and temporary HTTP fixture query-routing
failure remain recorded separately; they are not reported as successful runs.

Evidence lives in ignored `tmp/maple-font-qa/chrome-node-image/attempt-a2ae55c/` in the paired
BrowShare workspace. Both Sessions closed through the public API, tracked Session count reached
zero, and all owned containers, target processes and builders were stopped or removed. This proves
the complete image, Extension binding, real font rendering and persistent Profile behavior; it
does not establish new signed Extension provenance or public image distribution.

## Idle signaling through a reverse proxy (2026-09-08)

An actual BrowShare Viewer exposed periodic reconnects at roughly 75.8 seconds: the Viewer element
remained mounted, but Backend Viewer generations increased and public connection events reported
`ICE_FAILED`. An isolated real Nginx with a 75-second WebSocket read timeout reproduced the old
SignalingGateway's idle disconnection. The final baseline Core closed at 74.998 seconds with 1006;
the surviving Viewer received `signal.peer-left`, then closed on the fixture's existing pairing
deadline. Media/input traffic does not keep this separate signaling connection active.

The corrected Gateway sends native ping frames every 25 seconds. In the same 110-second observation,
both Core and Viewer sockets remained open and each received four pings. A client configured not
to answer pong was terminated at 48.062 seconds and its peer received the existing departure event.
Gateway close left zero heartbeat timers. Signaling typecheck/build and six existing tests passed.
The schema and peer-departure lifecycle did not change.

Evidence is retained in ignored `tmp/signaling-heartbeat-qa/`. An initial candidate incorrectly
treated the `ws` successful callback value `null` as an error; the actual experiment found it and
the check was corrected before deployment. The final raw result also retains a failed temporary
assertion that expected both baseline sockets to close at 75 seconds. Its separate evaluated result
records why peer-departure traffic resets the surviving socket's timer and verifies the actual
failure and correction without overwriting raw evidence. This isolated experiment used authorization
fixtures and real Node WebSockets/Nginx; it is not Chrome or WebRTC proof. All owned test containers
and the isolated network were removed.

## Viewer immersive controls in BrowShare (2026-09-08)

The paired deployment used Viewer source `c7d0033` and the corrected SignalingGateway source
`5923c76596213e7a83ab92cca2f382ac64be30cb`. Its actual maintenance Session verified 24px SVG
icons with 44px button targets, the public `immersive-change` event, hidden embedder header and
toolbar/window controls, a floating keyboard-operable exit, and retained child-window selection.
The remote website itself is unchanged. Actual normal and immersive input reached the target page;
desktop, 390px portrait and 844px landscape layouts fit the acknowledged remote viewport. Encoded
frame dimensions were not mistaken for viewport dimensions after capture resizing.

After the Gateway update, the same Viewer and video elements and media track remained active over
247.625 seconds, with decoded frames increasing from 415 to 7469 and no error/reconnecting events.
The observation included immersion enter/exit and mobile resizing. Backend administration API
observations 238.509 seconds apart retained Viewer generation 1 and identical connectedAt; further
input reached the real page afterward. This closes the idle-proxy regression exposed during UX
acceptance without claiming a new four-browser or TURN matrix. The current signaling commit also
passed [hosted CI](https://github.com/x3zvawq/browshare-remote-tab/actions/runs/34246166211).

Evidence is in the paired BrowShare workspace's ignored `tmp/profile-viewer-ux/`. Target services,
owned maintenance Sessions/Profiles, local Chrome, isolated proxies and builders were cleaned up;
the six business services and original user Profile remain available. Existing Viewer tests,
typechecks/builds and scoped UI accessibility checks passed within the limits documented by the
paired acceptance report. External npm, GHCR and signed Extension publications remain separate.

## Cursor feedback and passive input scheduling (2026-09-09)

Source `f7d897e` coordinates package/Extension version 0.1.24 and wire 1.5. The optional
`cursorFeedback` capability sends an enum-only cursor event scoped to the Session, generation,
window and viewport revision. It does not transfer custom cursor assets or page text. The isolated
document observer and CDP hit test preserve the parent page's cursor when it covers a child frame.

Actual local Chrome verified sixteen cases covering inputs, links, editable content, open shadow
roots, cross-origin and nested frames, overlays, custom cursor keyword fallback and navigation
cleanup. The first fractional-coordinate run exposed three failures because CDP's hit-test method
requires integer coordinates. Flooring only that hit-test argument corrected all sixteen cases;
actual dispatched input coordinates remain fractional. Scoped typechecks/builds, public exports,
compatibility and release checks passed, alongside 90 existing tests in 19 files and
[hosted CI](https://github.com/x3zvawq/browshare-remote-tab/actions/runs/34261873036).

Only queued passive `mouseMoved` commands with zero pressed buttons and the same control context
can replace an older pending hover. A controlled Core/CDP queue fixture verified a burst of 100
hover inputs with a key-command ordering barrier. Drag, click, key and wheel commands retain their
ordering and are not dropped. This establishes queue behavior, not physical input-to-display latency.

The paired BrowShare deployment built clean public source into verified OCI candidates and used its
existing private QA Extension signing key. Actual Linux Chrome 152.0.7977.75, active Extension/Core
0.1.24 and the deployed Viewer passed ten cursor cases: input, link, editable, open shadow input,
cross-origin frame input/link, return to the parent, parent overlay covering two frame targets and
removing that overlay. Trusted local Chrome input used fractional coordinates; the actual rendered
Viewer surface showed the expected text, pointer, wait or default cursor. Chinese text reached the
target page's real input handler. No synthetic cursor messages were used. The embedder advertises
the capability only when its Worker supports it.

The same deployment compared old 0.1.23 and new 0.1.24 media in three 30-second phases after a
5-second settling period each. Both used a 1280×713 viewport, 1280×720/30fps/3000kbps policy ceiling,
VP8, no audio and the same UDP relay candidate types. These are actual receiver video RTP byte and
decoded-frame deltas; signaling, TURN/IP overhead and fixture HTTP requests are excluded.

| Scenario | 0.1.23 video kbps / decoded fps | 0.1.24 video kbps / decoded fps |
| --- | --- | --- |
| Static | 25.5 / 6.2 | 22.4 / 5.8 |
| Typing | 47.9 / 10.0 | 50.4 / 10.6 |
| Scrolling | 673.1 / 14.4 | 806.2 / 16.1 |

Each run delivered all 150 input commits, returned to the starting scroll position after 60 wheel
actions, retained its media track and advanced decoded frames. Video packet-loss deltas were zero
in these intervals. Scrolling used both more bitrate and more frames in the candidate; this is not
evidence of universal bandwidth savings. Encoding/quality policy was unchanged. Publisher encode
time and physical input-to-display latency were not measured, and this scoped acceptance does not
replace the full browser/TURN matrix required before external release.

Evidence is retained in ignored `tmp/cursor-feedback-qa/` and the paired workspace's
`tmp/workspace-experience-qa/`. An initial integration attempt exposed a separate Worker offer-wait
ownership bug; BrowShare `497445f` fixes that lifecycle, with original failure and independent Node
proof retained in its acceptance report. A stale native Chrome lock was manually removed only from
the owned QA Profile after exclusive-lock and process checks. The successful real media/cursor run
followed that repair and the Worker fix deployment. All owned Sessions became terminal, the QA
Profile/Proxy and Profile storage were removed through business cleanup, and local browsers,
targets and builders stopped. The public test deployment and original user Profile remain running;
npm, GHCR and public signed artifacts were not published.
