# Phase 3 lifecycle status

## Current boundary

Phase 3 is complete. Reliable, realtime and file DataChannels exist; Viewer takeover,
suspension, reconnectable Core state, tab audio and redacted connection diagnostics have passed real
Google Chrome Stable runs. Bounded ICE restart and fresh-Ticket Headless Client reconnect now have
unit and cross-package integration coverage. Real Chrome runs additionally verify bounded ICE
restart, all three acknowledged sender presets and decoded Viewer resolutions. Five-second redacted
inbound/outbound WebRTC and DataChannel metrics are implemented and have passed an end-to-end run.
Eight real lifecycle iterations pass fresh-Ticket automatic reconnect, active takeover and
deterministic cleanup. A destructive-runtime probe records Extension service-worker/offscreen and
Standalone graceful/crash behavior. Phase 6 subsequently added authenticated live-Target
reconciliation, private temporary-tree startup cleanup and explicit orphan adoption; transparent
Viewer recovery across a daemon crash is still not promised.

This phase does not implement file payloads, clipboard or child-target handling. Those remain Phase 4
even though the ordered file DataChannel already exists.

## Implemented lifecycle

The current Session path supports:

- One active Viewer generation with stale-generation input rejection.
- Embedder-issued replacement Tickets that preserve the Chrome tab and Profile state.
- Core retry of an unmatched signaling attempt until the issued Ticket expires.
- Viewer departure transitioning the Session to `RECONNECTING` instead of destroying the tab.
- Focus-driven and explicit `suspend()`/`resume()` over the same acknowledged control path.
- Pressed pointer and key release before Viewer suspension or teardown.
- Deterministic explicit Session cleanup of media, signaling, CDP target and temporary storage.
- Redacted ICE candidate, selected-pair, media-track and DataChannel lifecycle diagnostics.
- Redacted inbound/outbound WebRTC metrics and all three DataChannel buffered amounts, sampled about
  every five seconds and stopped when their owning peer is replaced, fails or closes.

Suspension disables the Session's captured tracks and rejects blind input without closing the
PeerConnection or tab. It is therefore cheaper and faster than issuing a replacement Ticket, but it
does not revoke the Viewer generation.

## Four-Session pause evidence

On 2026-09-04, four real Viewer pages connected to four Sessions in one Google Chrome Stable Profile:

```text
pause-final-1-20260904
pause-final-2-20260904
pause-final-3-20260904
pause-final-4-20260904
```

All four initially reported `CONNECTED`. Suspending the first Viewer produced this Standalone state
vector:

```text
SUSPENDED
CONNECTED
CONNECTED
CONNECTED
```

While the first Session remained suspended, the second Viewer entered
`Sibling-live-after-pause-20260904`. CDP readback showed:

```text
pause-final-1 = ""
pause-final-2 = "Sibling-live-after-pause-20260904"
pause-final-3 = ""
pause-final-4 = ""
```

Resuming the first Viewer returned all four Sessions to `CONNECTED` without recreating the four tabs
or PeerConnections. The test then closed every Viewer and deleted every Session; the Standalone
Session list was empty.

Evidence establishes that pause state and input routing are Session-scoped. It does not yet establish
long-running recovery under packet loss, repeated browser sleep/wake, or Extension service-worker
restart.

## Disconnect-race correction

The run exposed a reachable race:

```text
Viewer becomes inactive
→ Viewer sends session.suspend
→ Core has already entered RECONNECTING
→ Core rejects the late request with ILLEGAL_STATE_TRANSITION
```

The rejection is an expected control result, not proof that Session internals are corrupt. Core now
returns the stable error to the active generation and preserves `RECONNECTING`. Unknown internal
exceptions and inability to send the error remain fatal because Core can no longer prove coherent
state in those cases.

A regression test starts a Session in `RECONNECTING`, delivers the late suspend, verifies the error
response and unchanged state, and then proves a newer Viewer generation can still be issued.

## Recovery authorization boundary

A consumed Viewer Ticket is never replayed. Automatic recovery has two distinct paths:

1. When signaling remains paired, Headless Client requests a bounded ICE restart without changing
   Viewer authorization. Gateway accepts the request only from Viewer to Core; Extension creates the
   restart offer on the existing publisher.
2. When signaling or the peer is gone, Headless Client asks the Embedder callback for a fresh Ticket
   with a higher Viewer generation. The browser library cannot manufacture this authorization.

The public API makes this distinction explicit. A static Ticket is suitable for a single connection
attempt. A reconnecting application supplies an asynchronous `getConnection` callback that returns
the next Ticket and endpoint. Headless Client verifies the same Session ID and a strictly larger
generation before accepting the new binding. Exhausted retries or denied authorization produce a
stable terminal error rather than an unbounded reconnect loop.

## Real quality and ICE-restart evidence

On 2026-09-04, Extension `0.1.8` and Google Chrome Stable `152.0.7977.75` exercised all three
quality presets. Chrome's own `ReconfigureEncoder` log recorded the requested limits, and the Viewer
reported the decoded frame:

| Preset | Maximum bitrate | Maximum FPS | Scale | Decoded frame |
| --- | ---: | ---: | ---: | ---: |
| `data-saver` | 750 kbit/s | 15 | 2× downscale | 425×356 |
| `balanced` | 2.5 Mbit/s | 30 | Native | 850×712 |
| `high` | 6 Mbit/s | 60 | Native | 850×712 |

The same compatibility set recovered from an approximately 12-second Worker-side UDP outage. The
Viewer moved `CONNECTED → RECONNECTING → CONNECTED`, Extension emitted
`signaling.ice-restart-offer-sent`, and recovery retained Viewer generation 2, the original CDP
target and page value `ice-restart-preserved-20260904`. The temporary fault-injection rule was
removed. This closes real validation of the existing-pair ICE-restart path, not the distinct
fresh-Ticket path.

## Periodic diagnostics evidence

Headless Client samples inbound RTCStats when connected and approximately every five seconds when
the `diagnostics` capability is present. Extension samples outbound RTCStats on the same cadence and
sends validated `media.diagnostic` loopback messages. Core exposes those records through
`EmbedderHooks.onDiagnostic`; Standalone writes them as structured `session.diagnostic` events.

The records cover codec, encoded or decoded dimensions, FPS, bitrate, interval packet loss, dropped
frames, jitter, RTT, sender quality limitation, actual sample interval and the buffered amount of
all three DataChannels. RTCStats IDs, candidate IDs, addresses, ports, SSRC, SDP, Ticket and page
content remain local or are discarded.

The real run received inbound and outbound audio/video records and DataChannel records. After Viewer
disconnect, the Session's Standalone metric-row count stayed at 35 across a six-second wait, while
Extension emitted `media.publisher-stopped` once. That observation verifies timer cleanup for the
tested teardown path; the soak must still exercise every transition repeatedly and watch process
resources.

## Lifecycle soak and acknowledged replacement

The first automated `0.1.8` iteration completed the injected signaling-loss recovery but exposed an
active-takeover race. Core requested a new capture ID before the retiring Publisher had released its
tabCapture stream. Gateway paired the successor generation, but Chrome denied capture and the new
Viewer received `Remote Tab publisher disconnected`.

The `0.1.9` correction makes media teardown an acknowledged loopback operation. Core does not request
the successor capture ID until Extension replies with the same stop request ID and Session. Offscreen
cancels and awaits an in-flight start, and late track or PeerConnection callbacks carry Publisher
identity so they cannot stop a newer instance under the same Session ID.

After the correction, one three-cycle run and one five-cycle run passed. Every cycle performed:

```text
connect → three quality presets → DOM marker
→ suspend → resume
→ Gateway restart plus temporary UDP outage
→ one fresh-Ticket reconnect with a larger generation
→ active Viewer replacement
→ disconnect → explicit Session close → cleanup inspection
```

All eight cycles preserved the original CDP target and unique DOM marker across reconnect and
replacement. Each recorded four completed Gateway pairs, zero timeouts, four Publisher stops,
outbound metrics, and zero remaining Session, target or temporary entry. In the five-cycle run,
Chrome and Standalone descriptor/thread counts were unchanged; Chrome RSS increased by 708 KiB and
Standalone RSS decreased by 7,312 KiB. No fault-injection firewall rule remained.

## Runtime restart boundary

One real `0.1.9` run exercised four destructive events against an active Session:

| Event | Observed result | Supported boundary |
| --- | --- | --- |
| Extension service worker stopped and restarted | Viewer stayed `CONNECTED`; the offscreen publisher, CDP target and DOM marker were unchanged; capability returned to `ready` after the worker rebound | Service-worker restart may preserve an active media Session because offscreen owns WebRTC |
| Extension offscreen target closed | Viewer reached `FAILED`; Core closed the Chrome target and temporary state; Standalone removed its terminal record; capability became `not-ready` until both Extension roles recovered | Fail closed; transparent offscreen recovery is not promised |
| Standalone received `SIGTERM` | Active Session, publisher, target and temporary state were closed; the restarted process had zero Sessions | Graceful shutdown is deterministic; Viewer continuity across the process restart is not promised |
| Standalone received `SIGKILL` | The restarted process had zero Sessions, while the Chrome target and its DOM marker remained as one orphan | Reconcile durable application ownership against the authenticated live-Target snapshot, then explicitly adopt or close |

The offscreen run exposed a real cross-layer leak: Core disposed the failed Session and target, but
Standalone retained its own terminal `SessionRecord`, consuming capacity and blocking reuse of the
ID. Standalone now evicts `FAILED` and `CLOSED` records only when the terminal callback belongs to
the same Session object, so a late callback from an old Session cannot delete a same-ID successor.
The regression test proves terminal eviction releases capacity.

The original crash probe explicitly closed its expected orphan through CDP. A later Phase 6 run
proved that the restarted Standalone reports that Target as `untracked`, clears only stale private
Session files, preserves an unrelated Embedder file and ordinary baseline tab, and accepts explicit
adoption of the orphan. Deleting the adopted Session then left zero Standalone Sessions and zero
probe targets. Standalone state remains volatile; the Embedder owns the durable decision and no
transparent recovery is claimed after offscreen/Core loss.
