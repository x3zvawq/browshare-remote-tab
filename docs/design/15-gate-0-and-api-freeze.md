# Gate 0 and first public API freeze

> [!IMPORTANT]
> This document records the source-level baseline for the first stable Remote Tab API and wire
> protocol. That first freeze used coordinated package and runtime versions `0.1.14`; the current
> unreleased candidate is `0.1.23` with protocol `1.4`, as recorded in
> [the compatibility manifest](../../deploy/compatibility.json).
> The npm, GHCR, official CRX and GitHub assets remain unpublished until the tag-gated release
> workflow succeeds. Changing a frozen surface requires an explicit design update and the change
> gate below; a new published compatibility set requires complete direct and TURN Gate 0 reruns.

The unreleased `0.1.23` sink-rejection correction uses existing `RemoteTabError` file codes and the
existing warning Notice. It adds no package parameter, wire field or capability. The bounded
public-message rule is specified in [the download sink contract](03-embedding-api.md#embedder-owned-download-sink-0121-candidate);
arbitrary storage exceptions remain private. Real download admission is part of its owning
acceptance; publication still requires the complete release Gate.

The unpublished `0.1.23` cleanup correction adds `RemoteTabCloseOptions.browserClosed`,
`RemoteTabCore.closeSession(sessionId, reason, options?)`, optional close options on Session and
CDP controller, and low-level `CdpBrowser.cleanupFailedAttachments(options?)` /
`ownsTargetPendingCleanup(targetId)`. Rejected close retains ownership and permits retry; only
positive owned-process termination permits the Embedder proof. No wire version changes. The
[Session close contract](03-embedding-api.md#session-close-completion) owns these semantics and
real Chrome fault/recovery acceptance; local CDP fixtures do not satisfy that release requirement.

### Unreleased embedding additions

The coordinated `0.1.15` integration source adds optional Core `onTitleChanged` and the browser-local
`playback-blocked` notification. These are additive package API changes, with behavior and limits
defined in [the embedding API](03-embedding-api.md). Neither changes a wire message or an
authorization decision, so wire protocol `1.0` is unchanged. Chrome Stable integration tests cover
their owning flows. The next published package version and compatibility set still require release
assembly and complete direct/TURN Gate 0; test-server deployment is not publication of that set.

## Frozen compatibility set

The first compatibility baseline is:

| Component | Frozen baseline |
| --- | --- |
| Google Chrome | Stable `152.0.7977.75` on Ubuntu 24.04 x86_64 |
| Chrome Extension | Signed managed `0.1.14`; service-worker and media roles coherent |
| Wire protocol | Major `1`, minor `0` |
| Server libraries | Coordinated Core, Protocol and Standalone `0.1.14` source |
| Browser libraries | Coordinated Headless Client and Viewer `0.1.14` source |
| Viewer proof | Chromium on macOS through the Codex in-app browser |
| Network proof | Direct ICE and forced TURN/TLS |

This table is a tested set, not a promise that every later Chrome, Extension or Core combination is
compatible. Capability diagnostics must still pass before accepting a Session. A combination not in
the published compatibility table is unsupported until it completes the same Gate.

## Evolving the protocol

At the first freeze, `PROTOCOL_VERSION` was `{ major: 1, minor: 0 }`. The current candidate uses
`{ major: 1, minor: 4 }`; the envelope carries both numbers. The baseline tables below retain the
original freeze's scope rather than claiming a completed release Gate for the newer candidate.

- Increment the major version for a removed or renamed message, changed required field, changed
  field meaning, incompatible validation rule, sequence/generation semantic change, or changed
  authorization boundary. Different major versions are rejected.
- Increment the minor version for an additive optional message, optional field, capability or
  diagnostic. Same-major peers can connect, but they may use only mutually known capabilities and
  schemas.
- Unknown capabilities never grant behavior. Unknown messages are rejected by default;
  `unknownMessage: 'ignore'` is an explicit opt-in only for channels where skipping an additive
  message is safe.
- Capability names are authorization inputs, not UI hints. Core checks both the Session allow-list
  and the negotiated Viewer list at the side-effect boundary.
- Extension loopback and public signaling schemas are part of the coordinated compatibility set.
  They may not silently accept malformed or oversized records.

The frozen control registry contains handshake, Session lifecycle, pointer/key/composition,
navigation/local-open, Notice, Page Script lifecycle, upload, download, clipboard, viewport,
quality and structured error messages. The canonical registry is `ProtocolPayloadSchemas`; the
canonical capabilities and errors are `CAPABILITIES` and `REMOTE_TAB_ERROR_CODES`.

## Embedding Core

The primary server-side path is:

```ts
const extension = new ExtensionLoopbackServer(extensionOptions)
await extension.start()

const core = new RemoteTabCore({ extension, downloadDirectory })
const session = await core.attachSession(input)

const { targetId, tabId } = session.getAttachment()
const ticket = await session.createViewerTicket(ticketRequest)
```

The frozen high-level Core surface is:

| Area | Public contract |
| --- | --- |
| Runtime composition | `RemoteTabCore`, `RemoteTabCoreOptions`, `ExtensionLoopbackServer`, its options, address and runtime status |
| Session creation | `AttachSessionInput`, `TabAttachment`, `SignalingAssignment`, `PageScriptConfiguration` |
| Session use | `RemoteTabSession`, `RemoteTabAttachmentIdentity`, `ViewerTicketRequest`, `ViewerTicket`, `ViewerTicketIssuer` |
| Authorization | `EmbedderHooks`, navigation/capability/state/close/audit/diagnostic request and event types |
| File ownership | `SessionStorageAdapter`, reservation and stored-file contracts, `FileTransferLimits` |
| Low-level integration | Exported CDP, Extension loopback, Core signaling and state-machine types remain public for custom runtimes |

`getAttachment()` is observation-only. Its values come from CDP and the authenticated Extension;
Viewer traffic cannot declare or change them. `close()` is the only Session teardown operation.
Core does not start, stop, install or upgrade Chrome.

## Embedding the Headless Client

Create one client with `createRemoteTabClient(options)`. The stable `RemoteTabClient` methods are:

```text
connect, disconnect, attachVideo, detachVideo, suspend, resume
navigate, requestViewport, requestQuality
sendPointer, sendKey, sendComposition
respondToLocalOpen
uploadFiles, cancelUpload, acceptDownload, cancelDownload
writeRemoteClipboard, readRemoteClipboard
addEventListener
```

Connection options include a short-lived Ticket, Gateway endpoint, cancellation signal, timeout,
bounded ICE restart and a callback that obtains a fresh Ticket for reconnect. A reconnect callback
must preserve Session identity and return a strictly newer Viewer generation; the library never
reuses a consumed Ticket.

The wire-derived event union for protocol `1.0` contains connection state, capabilities, viewport, navigation,
quality, local-open, upload, download, clipboard, Page Script, Notice, diagnostics and structured
errors. Adding a wire event is a protocol-minor change; changing an existing wire event meaning is
a major change. Local media-element notifications such as `playback-blocked` evolve with the package
API and are not sent to Core, Extension or Gateway.

## Embedding the Viewer

Call `defineRemoteTabViewer()` once, then render `<browshare-tab-viewer>`. The frozen attributes are:

| Attribute | Meaning |
| --- | --- |
| `ticket` | Short-lived, single-use Viewer credential |
| `endpoint` | Viewer-facing `ws:` or `wss:` Gateway endpoint |
| `locale` | `zh-CN` by default; `en-US` for the bundled English strings |
| `suspend-when-unfocused` | Suspends on focus loss unless explicitly set to `false` |

The element properties `iceRestartOptions` and `reconnectOptions` configure bounded recovery. Its
public methods are `connect`, `disconnect`, `suspend`, `resume`, `respondToLocalOpen`,
`acceptDownload`, `cancelDownload`, `writeRemoteClipboard` and `readRemoteClipboard`.

The frozen DOM events are:

```text
viewer-ready, connection-state-change, session-close-request
local-open-request
upload-request, upload-progress, upload-cancelled, upload-complete
download-request, download-progress, download-cancelled, download-complete
clipboard-write-request, clipboard-read-request, clipboard-progress
clipboard-write-complete, clipboard-read-complete
page-script-event, notice, diagnostic, error
```

Cancelable interaction events let an Embedder replace UI without moving browser interaction into a
Portal. The Viewer emits `session-close-request`; it never assumes it may destroy the application
Session itself.

## Running Standalone

Standalone is the reference wrapper around the same Core implementation. Its `/v1` routes are
frozen at the method/path level:

| Method | Path |
| --- | --- |
| `GET` | `/v1/diagnostics/capabilities` |
| `GET` | `/v1/reconciliation/targets` |
| `GET`, `POST` | `/v1/sessions` |
| `GET`, `DELETE` | `/v1/sessions/{sessionId}` |
| `POST` | `/v1/sessions/{sessionId}/viewer-tickets` |
| `PUT` | `/v1/sessions/{sessionId}/capabilities` |
| `POST` | `/v1/sessions/{sessionId}/notices` |

`GET /health/live` and `GET /health/ready` remain unauthenticated health endpoints. All `/v1`
routes require the configured bearer token. Session creation and single-Session reads return the
trusted attachment identity; the collection response omits it. Error responses retain the stable
`code`, safe `message`, `retryable` and optional redacted `details` envelope.

The reconciliation route is an additive authenticated observation API. It exposes live page Target
IDs and current in-process ownership so an Embedder can compare them with durable business state. It
does not mutate Chrome and does not weaken the rule that a Viewer can never choose a Target.

The Gateway CLI configuration names in [Standalone daemon and API](12-standalone-api.md) are also
frozen. The Gateway carries only SDP and ICE records; media, input and files never traverse it.
`SignalingGateway.getMetrics()` returns bounded process-local capacity gauges and counters without
Session or network-address labels. Additive limit variables and metrics fields are compatible
operational extensions; removing or changing their meaning requires a coordinated release.

## Extension and signing surface

The Extension package exposes managed-runtime parsing, the six fixed Page Script event names and
Extension identity/binding types. Its built MV3 service worker, offscreen page and loopback bundle
form one signed artifact and must be versioned together.

The signing package freezes `generateExtensionPrivateKey`, `signExtension` and
`createManagedPolicyTemplate`, plus their input/output types. A private key is an operator secret and
is never included in a release artifact. A new signed Extension version keeps the fixed Extension ID
only when it uses the same key.

## Gate 0 evidence

The current baseline passed one full four-Session run over direct ICE and another over forced
TURN/TLS. Each run proved unique attachment identities, four decoded streams, all three DataChannels,
isolated input, clipboard, upload, owned download bytes, local-open, Notice, Page Script reload,
independent suspension, one-target destruction isolation and final zero-resource cleanup.

The forced relay run reported `relay` to `relay`, ICE protocol `udp` and `relayProtocol=tls` for all
four selected pairs. The direct run reported peer-reflexive Viewer candidates against remote host
candidates. Detailed evidence and the ignored reproduction harness live under
`tmp/gate0/phase5-full-gate/`.

## Change gate

Before merging a change to a frozen surface:

1. Classify it as compatible patch, additive minor or breaking major.
2. Update the owning design document and this baseline when the surface changes.
3. Pass typecheck, build, package export validation and the relevant source tests.
4. Rerun the smallest real-browser flow that owns the behavior.
5. Rerun complete direct and TURN Gate 0 for a new published compatibility set.

Browser support matrices, deployment Compose files, metrics, release-candidate artifacts and
third-party deployment reproduction are complete. Registry and GitHub publication remain separate
external release evidence and are not implied by the source-level freeze.

The current source candidate additionally exposes optional `EmbedderHooks.onInput` and
`RemoteTabSession.sampleFrameChange()` for Embedder-owned activity observation. These are package
API additions; no media/signaling/DataChannel wire schema changes. BrowShare exercises them through
real Chrome input and dynamic/static frame policy before integration. A newly published compatibility
set still requires the full release Gate described above.

## Additive 0.1.16 development boundary

Protocol 1.1 adds the optional `noticeRequests` capability and correlated Notice request/response/
cancellation, plus generation-bound Extension `media.control_closed`. It adds
`RemoteTabSession.requestNotice`, Headless Client and Viewer `respondToNotice`, and
`notice-request`/`notice-closed` events. Existing `notice` and navigation contracts retain their
meaning. A 1.0 Viewer is not granted the new capability. The coordinated source/package/Extension
version is 0.1.16; this is a development candidate, not a formal publication or a claim that the
full Direct and TURN Gate 0 release matrix has been rerun. See the
[protocol contract](04-control-protocol.md#correlated-notice-requests-protocol-11).

The same unreleased candidate adds optional `PageScriptEventDetail.requestNotice` and shared
`NoticeDecision`. The bridge is scoped to the owned MAIN-world document and uses the existing
Notice wire messages; no further protocol version change. Viewer layout now fits the acknowledged
viewport to its stage and crops capture-track padding, preserving visible/input alignment after
resize. Four real Chrome window sizes, including narrow and short viewports, exercised all four
corners. These checks do not replace the complete release matrix.

The unreleased candidate also adds `navigationConfirmation`, `NavigationDecision.confirmation`
and `TabAttachment` create-mode `deferUntilViewer`. The capability requires `noticeRequests`;
protocol 1.0 peers receive neither capability. Navigation confirmation reuses Notice payloads and introduces no Worker control
field. Existing hooks without a confirmation and attachments without the deferred
option retain their behavior. The [embedding contract](03-embedding-api.md#confirm-a-remote-navigation-0116-candidate)
defines request preservation, cancellation and initial-tab readiness.

`navigationState` independently enables the new `navigation.location_changed` payload and typed
Client/Viewer `navigation-location-change` event. It reports observed main-frame commits and
same-document changes, rather than treating a command reply as a committed location. The candidate
remains unreleased 0.1.16 / protocol 1.1; location messages are never sent without negotiation.


### Owned child window observation (unreleased 0.1.16)

The low-level CDP API adds `CdpChildTarget`, `getChildTargets()`, child metadata/closure events and
`detach()`. These are additive package APIs; no wire messages or Viewer authorization changes are
introduced. Adoption now discovers existing opener descendants and rejects subtree ownership
conflicts without closing the conflicting pages. Chrome Stable verification covers initial
subtrees, metadata/closure events, isolated child input, observer detach and final cleanup. This is
preparation for maintenance window selection, not a completed Viewer selection API or published
compatibility set. See [owned child behavior](03-embedding-api.md) for the boundary and limitations.


## Additive 0.1.17 development boundary

The current coordinated candidate is 0.1.17, with Viewer wire protocol 1.1. It adds Extension
loopback `media.replace_capture`, `media.capture_replaced` and `media.capture_replace_failed`, and
Core's public low-level `replaceMediaCapture` operation. The new request requires a matching
Extension version and binds its acknowledgement to the runtime, Session and Viewer generation.
See the [capture contract](03-embedding-api.md#replace-an-extension-capture-0117-candidate) for
failure and lifecycle responsibilities. Earlier 0.1.16 sections describe the preceding candidate.

Focused real Chrome/WebRTC verification establishes capture replacement with preserved peer,
audio/video tracks, DataChannels and suspension. It does not establish Session window selection,
cross-window input, a refreshed full Direct/TURN/browser matrix, or publication. At that verification point BrowShare's Worker remained on 0.1.16; the later
0.1.18 integration is described below.


## Additive 0.1.18 development boundary

The current source candidate is 0.1.18 / protocol 1.2. It adds negotiated owned-window state,
selection/close commands, bounded catalog snapshot frames, live `session.capabilities` updates,
`windowRevision` control metadata and capture-ended events. The package
APIs and lifecycle are specified in [owned window selection](03-embedding-api.md#select-an-owned-window-0118-development-candidate).
Extension/Core versions must match for this capability. The preceding 0.1.17 focused media result
remains historical evidence for the lower-level operation. BrowShare's QA Worker now uses
Core/Extension 0.1.18 and Control 1.13, with real Portal child-window login and Profile restart
persistence verified. This candidate deployment uses existing image dependencies with mounted
built artifacts; it does not establish a newly published container image.

Focused real Chrome Stable acceptance now covers the Headless/default Viewer selection boundary,
including 131-window catalogs, selected-window navigation/files/clipboard/Page Scripts, closure
races, capability revocation during selection and replacement by a Viewer without selection.
The complete release matrix and public artifacts still require release preparation and publication.


## Additive 0.1.19 development boundary

The current candidate adds optional per-Session mediaLimits and initial Extension media.start.quality;
Viewer wire remains1.2. Core bounds initial capture, viewport and quality requests and retains the
snapshot through window selection/reconnection. See the media-limits embedding contract.
The Web Component forwards quality-change and describes applied FPS/bitrate. This supersedes0.1.18
as the coordinated source candidate; publication and the full release matrix remain separate gates.


## Additive 0.1.20 development boundary

Viewer wire 1.3 adds optional `file.upload.request.constraints` for upload count, per-file and batch
bytes, and filename suffixes. Core emits it only to peers that negotiate minor 3 or later. The
optional Core allowlist and Headless event field are defined in the embedding API. Policy remains
an Embedder decision and Core validates every offer before reserving storage, including offers
from older clients. This does not introduce a durable download inbox. The coordinated package and
Extension version is 0.1.20; full direct/TURN release Gate and publication remain separate gates.

The same development boundary adds optional Core `fileTransferLimits.maxTemporaryBytes` and
exported `CdpDownloadProgressEvent` to account for upload reservations and Chrome download spool
in one Session. It cancels on Chrome-reported per-file/count/aggregate excess and removes partial
files, while successful uploads stay reserved for lazy File reads until Session cleanup. No new
wire message is needed for this Core/CDP behavior. The embedding API documents progress accuracy
and the absence of a filesystem hard-quota guarantee.


## Additive 0.1.21 download ownership boundary

Optional `AttachSessionInput.downloadSink` adds a generic reserve/commit/abort ownership contract.
It permits an Embedder to retain completed files outside Viewer and Session lifetime. No Viewer,
signaling or Extension loopback schema changes; wire1.3 remains unchanged. Explicit design and
real Chrome evidence cover Viewer departure, Session-close/commit ordering, sink rejection and
reservation cleanup. Full direct/TURN release Gate and publication remain separate requirements.

### Viewer focus and sender suspension (unreleased 0.1.22)

The optional typed `RemoteTabViewerElement.focusPolicy` property and exported `ViewerFocusPolicy`
are compatible additive package APIs. Existing focus attributes remain supported with explicit
property precedence; no signaling, Extension loopback or DataChannel schema changes. The coordinated
0.1.22 candidate also corrects suspension to disable sender encodings, rather than merely sending
black/silent tracks. The existing suspension acknowledgement is sent after sender changes succeed.
Owning behavior and configuration limits are defined in the embedding API. Source checks and real
Chrome audio/video pause/resume are required; public publication still requires complete direct/TURN
Gate and release assembly.


### Advanced quality (unreleased 0.1.23)

The coordinated candidate uses Viewer protocol 1.4. It adds `advancedQuality`, the three
`quality.configure`/`quality.configuration`/`quality.configuration_failed` wire messages, and three
corresponding Extension loopback configuration messages. The existing `quality.request` and
`quality.ack` payloads are unchanged. `media.start` and `media.replace_capture` add only optional
`captureFrameRateLimit` (1–60 FPS), supplied by Core from the Session ceiling; callers omitting it
keep the viewport source limit. These messages have no additional required field.

The additive package surface consists of protocol `EncodingSettings`, `QualityConfiguration`,
`QualityState` and their schemas; Headless/Viewer `configureQuality()`;
`quality-configuration-change`; and the Viewer `qualityState` getter. `requestQuality()` retains
its preset API and legacy event. Both `qualityControl` authorization and negotiated
`advancedQuality` are required. Older peers receive only the existing preset protocol; new
messages are not sent as a substitute for old ACKs to peers that cannot decode them.

Automatic mode is the default only after advanced negotiation succeeds. The Session retains
its last successful choice, every mode respects immutable Session ceilings, and native encoder
congestion control remains active. The coordinated Core/Extension version check is required for
advanced operation. These are compatible additions within protocol major 1, not a rewrite of the
frozen baseline. New peers opt into the new capability; an old peer never gains it implicitly.

See the [embedding API](03-embedding-api.md#advanced-quality-unreleased-0123-protocol-14),
[wire messages](04-control-protocol.md#advanced-quality-messages-protocol-14), and
[adaptation implementation](05-extension-and-core.md#automatic-encoder-quality). Focused
0.1.23 sender/UI/pressure/recovery acceptance and the complete Direct/TURN release Gate remain
pending. Earlier Chrome results do not establish this candidate's advanced-quality behavior or
public availability.
