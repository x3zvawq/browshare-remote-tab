# Embedding API

## API layers

Remote Tab exposes three layers:

1. Core API for a trusted server-side Embedder.
2. Headless Client for browser applications that build custom UI.
3. Viewer Web Component for a complete default experience.

This document defines the intended shape to guide implementation. Export names become stable only with the first public package release.

### Browser playback permission

`attachVideo(element)` attempts to play the attached stream. If Chrome rejects playback with
`NotAllowedError`, Headless Client emits `{type:'playback-blocked', reason:'user-activation-required'}`;
this is not a failed WebRTC connection. A custom Embedder should present a user action and call
`element.play()` directly in that trusted click or keyboard handler. It must not request a new
Ticket or silently mute audio to hide the rejection.

The default Viewer forwards the public `playback-blocked` event and owns the localized playback
overlay. It disables pointer, keyboard/IME, navigation and clipboard actions while the screen is
blocked; the native `playing` event restores the existing controls. End and fullscreen remain
available. Delayed rejection from a detached video or replaced stream is ignored. No media wire
protocol or Gateway behavior changes, and Portal must not replace this browser-owned interaction.

## Core contract

The Embedder supplies capabilities and already-authorized resources. Core uses the supplied capability
snapshot; navigation decisions remain explicit calls to the Embedder's navigation hook.

```ts
interface AttachSessionInput {
  sessionId: string
  cdpEndpoint: string
  tab: { mode: 'create'; initialUrl?: string } | { mode: 'adopt'; targetId: string }
  capabilities: ViewerCapabilities
  childTargetPolicy?: 'close-and-local-open' | 'retain'
  localOpenRequestTimeoutMs?: number
  pageScript?: {
    source: string
    context?: Readonly<Record<string, unknown>>
  }
  signaling: {
    gatewayId: string
    endpoint: string
    bindingToken: string
    connectionTimeoutMs?: number
  }
  storage: SessionStorageAdapter
  hooks: EmbedderHooks
}

interface RemoteTabSession {
  readonly id: string
  getState(): RemoteTabState
  getAttachment(): { readonly targetId: string; readonly tabId: number }
  sampleFrameChange(): Promise<{ changed: boolean; observedAt: number }>
  createViewerTicket(input: TicketRequest): Promise<ViewerTicket>
  updateCapabilities(next: ViewerCapabilities): Promise<void>
  sendNotice(notice: { level: 'info' | 'warning' | 'error'; code: string; message: string }): void
  close(reason: string, options?: RemoteTabCloseOptions): Promise<void>
}
```

Create one Core for the already-running Chrome runtime and its authenticated Extension loopback:

```ts
const core = new RemoteTabCore({
  extension: extensionLoopback,
  defaultViewport: {
    width: 1280,
    height: 720,
    deviceScaleFactor: 1,
    frameRate: 30,
  },
})

const session = await core.attachSession(input)
```

`cdpEndpoint` is trusted server configuration and must never reach the Viewer. Adopting a target is allowed only through a trusted server call; browser clients cannot submit a target ID.

`signaling.connectionTimeoutMs` controls one Core-to-Gateway pairing attempt. Omitting it uses Core's
conservative 15-second default. When a retryable attempt fails before the issued Ticket expires, Core
rebinds the same Session and Viewer generation with bounded backoff; the Session remains
`NEGOTIATING` or `RECONNECTING`. A non-retryable failure or Ticket expiry returns it to `READY`.
Gateway pairing timeout and Core's per-attempt timeout therefore do not shorten the Ticket's usable
lifetime.

Gateway `signal.ready` assignments may set the standard ICE transport policy to `relay`. Core passes
that value unchanged to the Extension publisher, and the Headless Client applies the same value to
the Viewer PeerConnection. Missing policy fields from a pre-freeze peer default to `all`.

The first ticket is issued while the Session is `READY`. To take over a connected, suspended or
reconnecting Session, issue a ticket with a strictly larger Viewer generation. Core invalidates old
input before replacing signaling and enters `RECONNECTING`; the Chrome tab and Profile state remain
alive. When the retiring signaling pair is still reachable, Core sends its Viewer a
`VIEWER_REPLACED` error before closing that pair. A Viewer departure also preserves the Session for
an Embedder-authorized replacement. Only an explicit `session.close()` performs tab and Session
storage cleanup.

### Embedder hooks

```ts
interface EmbedderHooks {
  authorizeNavigation(request: NavigationRequest): Promise<NavigationDecision>
  onStateChanged(event: StateChangedEvent): Promise<void> | void
  onInput?(event: { sessionId: string; observedAt: number }): Promise<void> | void
  onTitleChanged?(event: { sessionId: string; title: string }): Promise<void> | void
  onAuditEvent?(event: RedactedAuditEvent): Promise<void> | void
  onDiagnostic?(event: RedactedDiagnosticEvent): Promise<void> | void
}
```

`onTitleChanged` receives the current main-document title and subsequent changes, including an
empty title, up to 4096 Unicode code points. Core observes the document in a named isolated world;
subframe titles do not replace the main title. This hook does not depend on an active Viewer and
stops with Session cleanup. Titles are untrusted display data and may contain sensitive text;
embedders must render them as text, keep their own custom-name precedence, and avoid audit/log output.

Navigation authorization has an explicit timeout and denies on timeout. Capability authorization is
the normalized snapshot supplied by `AttachSessionInput.capabilities`, intersected with the Viewer
Ticket during `hello`; an Embedder revokes or changes it through `updateCapabilities()`. Core does not
perform a second per-action capability callback after the Session starts. Notification, audit or
diagnostic-hook failure must not silently change the authorization result or Session lifecycle.

Core creates a blank target, installs main-document interception, then loads `initialUrl`. Each HTTP
or HTTPS main-frame Document request calls `authorizeNavigation` with `action: 'go'`,
`source: 'document'`, the normalized `url`, `currentUrl`, HTTP `method`, and `isRedirect`. This includes
page links, scripts, forms and each HTTP redirect hop, independently of the navigation toolbar
Capability. No request headers, cookies or POST bodies are passed to the hook. Initial denial fails
attachment and closes the created target. Omitting `initialUrl` retains the bootstrap blank page.

Viewer commands use `source: 'viewer'`; local-open keeps its existing action. Hooks must tolerate both
the command decision and a subsequent Document decision. History/hash changes within an already
loaded document update the current URL but do not create a new Document request. Adopt mode only
controls future requests; it cannot undo content loaded before adoption.

Only the main frame is evaluated. Iframe Documents, images, scripts and XHR continue without a policy
decision. The guard uses CDP Fetch request-stage interception, not a resource URL allowlist. An allowed
replacement URL produces a real HTTP 303 redirect, changes the visible URL and drops any POST body;
the replacement request is evaluated again. Unsafe schemes or credential-bearing replacement URLs
are denied. A denied page navigation aborts the request, retains the prior page and sends a warning
Notice to a connected Viewer. Hook timeout or failure denies the request.

Site Service Worker responses bypass CDP Fetch interception. Core therefore enables target-scoped
`Network.setBypassServiceWorker` for its owned tab. This affects Service Worker request handling and
offline cache behavior in that tab; it does not unregister workers, erase Profile storage or change
unmanaged tabs. Embedders must account for this compatibility limit when selecting supported sites.
The Chrome extension service worker and media runtime are separate and continue operating.

Viewer close intent does not enter Core. The Viewer Web Component emits
`session-close-request` to its browser-side host, which decides whether to call the application
Backend and eventually invokes `session.close()` through its trusted server integration.

`onDiagnostic` is the server-side observability boundary. Extension outbound metrics arrive through
the validated loopback `media.diagnostic` message and Core converts them into this shape:

```ts
interface RedactedDiagnosticEvent {
  sessionId: string
  name: string
  occurredAt: number
  fields: Readonly<Record<string, string | number | boolean | null>>
}
```

Current metric names are `webrtc.media-metrics` and `data-channel.metrics`. The fields can include
media direction and kind, codec, frame dimensions, FPS, bitrate, packet loss, dropped frames,
jitter, RTT, sender quality-limitation reason, actual sample interval, DataChannel label and
`bufferedAmount`. They never contain RTCStats IDs, candidate IDs, addresses, ports, SSRC, SDP,
Tickets or page data. An Embedder may log, aggregate or discard these events; the hook is not an
authorization callback.

## Viewer Web Component

Intended markup:

```html
<browshare-tab-viewer
  ticket="viewer-ticket"
  endpoint="wss://signal.example.com"
  locale="zh-CN"
></browshare-tab-viewer>
```

Register it once in the browser entry point:

```ts
import { defineRemoteTabViewer } from '@browshare/remote-tab-viewer'

defineRemoteTabViewer()
```

The ticket is short-lived and single-use. Applications should create the element only after receiving a fresh ticket; they must not persist it in local storage or URLs.

### Events

```ts
viewer.addEventListener('session-close-request', (event) => {
  application.requestSessionClose(event.detail.reason)
})

viewer.addEventListener('connection-state-change', (event) => {
  application.renderConnectionState(event.detail)
})

viewer.addEventListener('page-script-event', (event) => {
  application.observePageLifecycle(event.detail.event)
})
```

The Viewer never assumes that clicking “end” may destroy an application Session. It emits a request. A standalone Embedder may approve automatically; BrowShare sends the request to its Backend.

Expected events:

| Event | Purpose |
| --- | --- |
| `viewer-ready` | Component initialized and waiting for connection |
| `connection-state-change` | Negotiating, connected, suspended, reconnecting, closed, failed |
| `session-close-request` | User asks the Embedder to end the Session |
| `local-open-request` | Host overrides default local-open UI |
| `clipboard-write-request` | Host optionally replaces local-to-remote clipboard acquisition |
| `clipboard-read-request` | Host optionally replaces remote-to-local clipboard interaction |
| `clipboard-progress` | Text or PNG transfer byte progress |
| `clipboard-write-complete` | Local content was written and pasted into the remote tab |
| `clipboard-read-complete` | Remote items are assembled; host may replace the default local write |
| `page-script-event` | Fixed top-level page lifecycle event forwarded to the host |
| `notice` | Headless structured notice for host rendering |
| `diagnostic` | Redacted signaling, ICE, PeerConnection, media and DataChannel progress |
| `error` | Stable code plus safe diagnostic context |

All events except `error` bubble from the custom element. `error` is dispatched on the Viewer
element without bubbling because browsers and development servers reserve global `error` handling
for uncaught runtime failures. Applications receive it by registering directly on the element, as
in the examples above.

### Styling

The component uses Shadow DOM and exposes documented CSS Custom Properties and `::part()` targets. Required focus indicators, blocking overlays and security confirmations cannot be removed through ordinary styling hooks.

### Mobile preview behavior

Mobile Viewer support is an explicit preview tier, not part of the desktop compatibility promise.
When `(pointer: coarse)` matches or the browser exposes touch points, the component:

- uses a three-row narrow toolbar without overflowing the host;
- gives visible actions at least 44 × 44 CSS pixels and preserves safe-area padding;
- shows a dismissible `mobile-guidance` note describing the interaction and permission limits;
- maps a single-finger tap to a remote click and movement past the gesture threshold to a left-button
  drag;
- maps a two-finger pan to remote wheel input without sending an accidental first-finger click; and
- exposes a `keyboard-button` that focuses the hidden IME proxy after the user selects a remote field.

The keyboard action is separate from remote tapping so an ordinary remote button does not open the
local soft keyboard. Clipboard, download, local-open and fullscreen behavior still depends on the
mobile browser and operating-system permission model. Hover, context-menu gestures, hardware-key
shortcut parity and simultaneous multi-touch page gestures are not promised. Embedders may style
the documented parts, but should not hide the support note unless they provide an equivalent product
explanation.

By default the component suspends media when its browser window is hidden or unfocused and resumes after focus returns. `suspend-when-unfocused="false"` opts into background streaming. Before suspension it releases pressed pointer buttons and keys to avoid stuck remote input.

The element also exposes `suspend()` and `resume()` promises. An Embedder can use them when its own
route, overlay or policy makes the Viewer inactive even though the document still has browser focus.
Both the automatic focus policy and explicit calls use the same reliable control path; suspension is
acknowledged by Core before the element reports `SUSPENDED`.

```ts
import { RemoteTabViewerElement } from '@browshare/remote-tab-viewer'

const viewer = document.querySelector('browshare-tab-viewer')

if (!(viewer instanceof RemoteTabViewerElement)) {
  throw new Error('Remote Tab Viewer is not registered')
}

document.querySelector('#show-business-overlay')?.addEventListener('click', async () => {
  await viewer.suspend()
})

document.querySelector('#hide-business-overlay')?.addEventListener('click', async () => {
  await viewer.resume()
})
```

Applications should await these methods before treating the transition as complete. A rejected call
means the reliable control path is unavailable or Core refused the transition; it must not be
presented as a successful pause or resume.

The default local-open dialog asks whether to open the URL on the Viewer device. Core emits a
request only after `authorizeNavigation({ action: 'local-open' })` approves an HTTP or HTTPS URL.
Approval calls local `window.open()` with `noopener,noreferrer`; rejection never opens a server-side
tab. A host can cancel the component's `local-open-request` event and render its own decision UI;
Portal does not need to own browser-interaction dialogs. The default confirmation uses a native modal
`dialog` for keyboard focus containment; Escape declines the request. It explains that remote sign-in
state, POST form data and the original window association do not transfer to the local browser.

`childTargetPolicy` defaults to `close-and-local-open`. Ordinary Sessions intercept new-context
`window.open()` calls in the page MAIN world before Chrome creates a remote target. The wrapped call
returns `null`, matching popup-blocked behavior, so sites that require a returned `WindowProxy` need
explicit compatibility testing. `_self`, `_parent`, and `_top` calls retain native behavior.
Native new-target paths such as `target="_blank"` anchors and POST forms are paused by a
browser-scoped CDP interceptor and closed before their first Document request. Controllers in the
same Core process share one interceptor per Chrome browser endpoint: it closes children of ordinary
Sessions and resumes/detaches unrelated targets, including trusted maintenance windows. It is
installed before navigating a newly created Session to its initial URL and released when its last
ordinary controller detaches or closes. Target observation still supplies the URL for authorization
and Viewer confirmation; the original POST is never replayed.
`retain` is intended for trusted maintenance Sessions: it disables this interception and keeps
child targets in Chrome until Session cleanup. Ownership follows the Chrome opener chain,
including popups opened by retained popups. Closing an intermediate opener does not release
its already discovered descendants. An owned child cannot be adopted by another Core Session
(`TAB_ALREADY_ATTACHED`); Session cleanup closes its descendants without closing targets owned
by an unrelated Session.

Adoption also discovers live descendants that existed before attachment. Core rejects adoption of
an ancestor whose discovered subtree overlaps another Session or a pending attachment, before
installing navigation or Page Script hooks. On that conflict it detaches the new CDP observer
without closing the existing pages. Ordinary adoption closes its discovered pre-existing children;
`retain` keeps them until the owning Session closes.

The low-level `CdpTabController.getChildTargets()` returns copied `{targetId, title, url}` records.
`child-target-changed` and `child-target-closed` complement the existing creation event. Titles and
URLs are untrusted page data, not diagnostic/log fields. Snapshot discovery reconciles Chrome's
unordered target list with live events; a closed intermediate opener does not release descendants
already proved by that snapshot or observed event chain. If an opener disappeared before any
observation and Chrome no longer exposes its ancestry, Core cannot infer a relationship from URL or
Profile membership; embedders must reconcile such orphan targets separately.

`CdpTabController.detach()` releases that CDP attachment and listeners without closing its target
or descendants. It is a low-level observer operation, not a substitute for high-level Session
`close()`: callers still own Extension mappings and browser/Session cleanup. Do not detach a live
Core Session's internal controller. The new low-level directory and detach operation do not expose
Viewer target selection; maintenance window selection, media switching and target-bound input are
still under implementation. `getAttachment()` continues to identify the immutable main Tab.

`sendNotice()` transports text-only, schema-validated status to Headless Client and Viewer. It is
appropriate for an Embedder's Session-scoped information, warning, or error message; it is not a
confirmation protocol and accepts neither HTML nor executable content.

The default Viewer owns clipboard prompts and browser permission fallbacks. “Paste to remote” reads
the local clipboard only after the click; “Copy from remote” writes the local clipboard only after
its click. If browser permission is denied, text falls back to an explicit editable paste field or
a selected read-only copy field. Images never silently disappear: the fallback explains that image
permission is required. `clipboard-write-request`, `clipboard-read-request`, and
`clipboard-read-complete` are cancelable, allowing an Embedder to replace acquisition, storage, or
UI without moving that responsibility into Portal.

`pageScript.source` is one already-authorized JavaScript program, limited to 512 KiB. Core runs it
in the top-level page MAIN world before installing and dispatching the fixed lifecycle events. The
optional JSON-object `context` is limited to 64 KiB and appears as `event.detail.context` inside the
remote page; Remote Tab does not decide which business fields are safe to include. Syntax and runtime
errors emit redacted `page-script.error` diagnostics and do not fail the Session. The Headless Client
emits `page-script-event`, and the Viewer forwards the same typed client event to its host without
adding UI.

## Headless Client

The Headless Client owns WebRTC, signaling, protocol state, input normalization and file flow without rendering controls.

```ts
const client = createRemoteTabClient({
  ticket,
  endpoint,
  reconnect: {
    async getConnection({ previousSessionId, previousViewerGeneration }) {
      const response = await fetch(`/api/sessions/${previousSessionId}/viewer-ticket`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ afterGeneration: previousViewerGeneration }),
      })
      if (!response.ok) throw new Error('Reconnect was not authorized')
      return response.json()
    },
  },
})

const unsubscribe = client.addEventListener((event) => renderApplicationUI(event))

await client.connect()
client.attachVideo(videoElement)
await client.requestQuality('balanced')
```

ICE restart is enabled by default with two bounded attempts while the authenticated signaling pair
remains available. `iceRestart: false` disables it; `iceRestart.maxAttempts`,
`disconnectedDelayMs` and `attemptTimeoutMs` tune it. An ICE restart keeps the current Ticket and
Viewer generation because the existing signaling pair remains authenticated.

When signaling is also gone, the optional `reconnect.getConnection` callback asks the Embedder for
fresh authorization. Its result is `{ ticket, endpoint }`. Headless Client requires Gateway's new
assignment to preserve `sessionId` and strictly increase `viewerGeneration`; it rejects a replayed or
misbound Ticket. Defaults are three attempts with exponential delays from 500 ms up to 5 seconds.
Applications may configure `maxAttempts`, `minimumDelayMs` and `maximumDelayMs`.

The real `0.1.9` lifecycle soak stopped the Gateway while Worker UDP was temporarily unavailable.
Each repaired iteration called `getConnection()` once, accepted a strictly larger generation,
returned to `CONNECTED`, and retained the original CDP target and DOM marker. The same runs then
performed an active Viewer replacement. Core's acknowledged Extension teardown completed before
requesting the successor capture ID, so the new Viewer did not race the retiring tabCapture stream.

The Viewer Web Component exposes the same policy as properties. Set them before connecting or before
appending a programmatically created element:

```ts
import {
  defineRemoteTabViewer,
  type RemoteTabViewerElement,
} from '@browshare/remote-tab-viewer'

defineRemoteTabViewer()
const viewer = document.createElement('browshare-tab-viewer') as RemoteTabViewerElement
viewer.setAttribute('ticket', ticket)
viewer.setAttribute('endpoint', endpoint)
viewer.reconnectOptions = {
  async getConnection(request) {
    const response = await fetch('/api/viewer-tickets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: request.previousSessionId,
        afterGeneration: request.previousViewerGeneration,
      }),
    })
    if (!response.ok) throw new Error('Reconnect was not authorized')
    return response.json()
  },
}
document.querySelector('#viewer-host')?.append(viewer)
```

Actions reject locally when the advertised capability is missing and may still be rejected by Core if authorization changed.

File selection is Viewer-owned. Headless applications respond only to an active `upload-request`:

```ts
const unsubscribe = client.addEventListener((event) => {
  if (event.type !== 'upload-request') return

  showLocalFilePicker({ multiple: event.multiple }).then((files) => {
    if (files.length === 0) return client.cancelUpload(event.requestId)
    return client.uploadFiles(event.requestId, files)
  })
})
```

`uploadFiles()` resolves only after Core commits every declared file and Google Chrome accepts the
runtime-local paths for the intercepted input. It rejects on limits, cancellation, disconnect, stale
request, storage failure, or CDP delivery failure. `upload-progress` reports bytes accepted for send
by the file DataChannel, not bytes durably committed by Core. `upload-cancelled` lets custom UI close
an outstanding picker when Core replaces or expires it.

Clipboard is also explicit and promise-based:

```ts
await client.writeRemoteClipboard([
  { mimeType: 'text/plain', data: 'Paste this into the remote tab' },
])

const remoteItems = await client.readRemoteClipboard()
for (const item of remoteItems) {
  if (item.mimeType === 'text/plain') {
    console.log(new TextDecoder().decode(item.data))
  }
}
```

`writeRemoteClipboard()` accepts one `text/plain` item, one `image/png` item, or both. String, Blob,
ArrayBuffer and Uint8Array inputs are normalized before transfer. `readRemoteClipboard()` returns
validated `Uint8Array` and Blob representations. Both methods require the corresponding negotiated
capability, reject concurrent operations and pending work on disconnect/replacement, and enforce
16 MiB per item, 24 MiB total and 120 seconds of inactivity. A Headless Embedder must call them only
from an explicit user action; the library intentionally provides no automatic synchronization.

`requestQuality()` accepts `data-saver`, `balanced` or `high`. A `quality-change` event contains the
settings acknowledged by the Extension publisher. The default Viewer renders the same presets in its
toolbar only when `qualityControl` is granted. It does not present a selection as applied until the
publisher acknowledges it. Protocol 1.4 adds automatic/custom modes through the separately negotiated
`advancedQuality` capability; see [advanced quality](#advanced-quality-unreleased-0123-protocol-14).

When `diagnostics` is granted, Headless Client samples inbound RTCStats immediately after connection
and then approximately every five seconds. Each `diagnostic` event contains a redacted
`webrtc.media-metrics` or `data-channel.metrics` record. Sampling stops and its history is cleared
when the owning PeerConnection is replaced, fails or closes; reconnect starts a new sampling epoch.

## Capabilities

```text
navigation
backForward
reload
upload
download
clipboardText
clipboardImage
localOpen
fullscreen
qualityControl
advancedQuality
diagnostics
tabAudio
```

Capabilities are allow-only. Unknown capabilities are ignored by older clients and do not grant access. Hiding a Viewer button is a usability consequence, not the enforcement boundary.

## Session close completion

`RemoteTabSession.close(reason, options?)` shares its in-flight cleanup promise across concurrent
calls. If Chrome rejects target closure or Session storage cleanup fails, it rejects and retains
Core ownership; a later call retries the incomplete cleanup. `Target.closeTarget` returning false
or an RPC error is not completion unless a same-browser target inventory proves that exact target
is gone. The first terminal reason wins; retry cannot turn a failed Session into a successful close.
An Embedder must await completion before releasing its Session capacity, file ownership or mappings.

`RemoteTabCore.closeSession(sessionId, reason, options?)` also recovers an attachment that failed
before the Embedder received its handle. It waits for an in-flight attachment and retries owned
cleanup by the original Session ID. That ID and its known target ancestry remain reserved until
cleanup succeeds. `core.close()` attempts every retained Session and rejects if any cleanup remains.
Failure-event cleanup does not emit unhandled rejected promises; the Embedder uses these explicit
close methods to observe or retry failure. Standalone retains a failed Session record until cleanup
succeeds, so an authenticated DELETE can retry it.

The additive `RemoteTabCloseOptions` has one optional boolean, `browserClosed`. Supply `true` only
after positively observing termination of the Chrome process/process group owned by the Embedder.
CDP socket loss, timeout, connection refusal or endpoint rediscovery are not such proof. Without
that proof Core reconnects to the original browser WebSocket identity, checks descendants through
known opener ancestry, and retains ownership if the original browser cannot be reached. With proof,
Chrome target cleanup is complete but Session storage cleanup must still succeed. The low-level
`CdpTabController.close(options?)` accepts the same proof. `CdpBrowser.cleanupFailedAttachments(options?)`
retries its failed create-mode attachments, and `ownsTargetPendingCleanup(targetId)` exposes their
retained ownership for trusted composition; Core handles both automatically.

These are additive embedding APIs in the unpublished 0.1.23 candidate. They do not change Viewer,
Gateway or control wire messages. They still require real Google Chrome close-fault/retry acceptance
and the complete publication Gate before release.

## Session storage adapter

Core needs a Session-scoped temporary storage abstraction for uploads and downloads. The Embedder decides the local directory or storage implementation, but it must support:

- Per-Session isolation.
- Size reservation before accepting chunks.
- Atomic completion.
- Expiration and cleanup.
- Safe file names independent of user input.

For uploads, the runtime-local basename must preserve the normalized display name because Google
Chrome exposes that basename as `File.name`. Uniqueness belongs in an opaque transfer directory, not
in a replacement basename. `.` and `..` are never valid normalized display names.

Google Chrome on Linux must run with a UTF-8 locale, for example `LANG=C.UTF-8`. Under the POSIX
locale Chrome can silently ignore a non-ASCII pathname passed to `DOM.setFileInputFiles` while
returning a successful CDP response. The supplied chrome-node image sets this locale. Keep upload
paths available for Chrome's lazy File reads until the Embedder can safely dispose of them.

Remote Tab does not place temporary files inside a Chrome Profile.

## Error model

Public errors contain a stable code, safe message, retry classification and optional redacted details:

```ts
interface RemoteTabErrorShape {
  code: string
  message: string
  retryable: boolean
  details?: Record<string, unknown>
}
```

Representative codes:

```text
CHROME_UNSUPPORTED
EXTENSION_UNAVAILABLE
TAB_NOT_FOUND
TAB_ALREADY_ATTACHED
CAPTURE_DENIED
VIEWER_TICKET_EXPIRED
VIEWER_REPLACED
NAVIGATION_DENIED
FILE_LIMIT_EXCEEDED
ICE_FAILED
TURN_UNAVAILABLE
SESSION_CLOSED
```

Errors never include cookies, full sensitive URLs, file contents, SDP, TURN passwords, CDP WebSocket URLs, or extension secrets.

Diagnostic events follow the same rule. ICE events expose candidate type and transport only; the
selected-pair event excludes addresses, ports, candidate IDs and credentials.

### Activity observation

`hooks.onInput` reports processed pointer, key, composition, navigation and explicit file/clipboard
intents from the authorized Viewer. It carries only Session identity and UTC epoch milliseconds,
never keys, coordinates, URLs, filenames or clipboard contents. It stops after Session teardown;
notification failures do not alter command authorization. Page JavaScript does not generate this hook.

`session.sampleFrameChange()` compares the current visible viewport with the previous sample. The
first sample reports changed. Core captures low-quality JPEG through CDP, retains only the previous
encoded frame in memory, and returns `{ changed, observedAt }`; no pixels cross this API. Concurrent
calls share a capture. Errors reject, and a closed Session cannot be sampled. The Embedder decides
whether and how often to sample and owns all idle/timeout policy; Core does not schedule recycling.

### Request a Viewer decision (0.1.16 / protocol 1.1)

`RemoteTabSession.requestNotice(content, { timeoutMs?, signal? }?)` requires the negotiated
`noticeRequests` capability and an active Viewer. It returns a Promise of
`{ requestId, buttonId: string | null, reason }`; reason is `response`, `expired`, `cancelled`,
`connection-lost`, `viewer-replaced`, `capability-revoked` or `session-closed`. Only an offered button
returned with `reason: 'response'` represents a user decision. Cancellation is never consent.
Request creation validates input and may throw before returning the Promise when the channel,
capability, content or rate allowance is unavailable.

For example, pass `{ kind: 'confirm', title: 'Continue?', body: 'Confirm this action.',
buttons: [{ id: 'continue', label: 'Continue' }] }`, then check both result fields. See the
[protocol contract](04-control-protocol.md#correlated-notice-requests-protocol-11) for limits.
Do not await a human decision in a short-lived authorization hook without explicitly arranging
its navigation lifecycle: attachment has no Viewer yet, and normal hooks still have their existing
timeout. The Notice API does not change that contract.


### Page Script Notice bridge (0.1.16)

When a Session enables `noticeRequests`, each fixed top-level `browshare:*` lifecycle event
includes optional `event.detail.requestNotice(content)`. Page Scripts can retain this function
and call it after a Viewer connects:

```js
document.addEventListener('browshare:on_session_attached', (event) => {
  const requestNotice = event.detail.requestNotice
  document.querySelector('#confirm')?.addEventListener('click', async () => {
    if (!requestNotice) return
    const result = await requestNotice({
      kind: 'confirm', title: 'Continue?', body: 'Confirm this page action.',
      buttons: [{ id: 'continue', label: 'Continue' }],
    })
    if (result.reason === 'response' && result.buttonId === 'continue') {
      // Perform the page's own experience-layer action.
    }
  })
})
```

The Promise returns `{ buttonId, reason }` (`NoticeDecision`); transport request IDs and Session
routing remain internal. Invalid content, unavailable Viewer/capability or limits reject with a
stable error `code`. The bridge uses the same text-only content schema, allows four pending
requests and ten attempts per minute, and expires requests after 60 seconds. Leaving the document,
Session cleanup, Viewer loss/replacement and capability revocation cancel pending decisions.

Core accepts requests only from the owned main frame's default execution context and sends replies
to its unique CDP context identity. Iframes and isolated worlds cannot issue requests through this
bridge. A retired document cannot receive a successor's result. Page Scripts and the page share
MAIN world and can modify their own events; this is an experience API, never authorization.
Embedders enforcing navigation must await their own Core request and cannot trust a page-reported
result. The Page Script bridge does not authorize navigation; use the separate
[remote navigation confirmation contract](#confirm-a-remote-navigation-0116-candidate).


### Confirm a remote navigation (0.1.16 candidate)

Enable both `navigationConfirmation` and `noticeRequests` for the Session and Viewer. A navigation
hook may return `{ allowed: true, confirmation: { title, body, confirmLabel } }` (with optional
approved `url`). Core resolves this condition for the actual intercepted main Document. The hook
itself retains its short authorization deadline; the subsequent Viewer decision has 60 seconds.
Only the offered button from the current Viewer authorizes continuation. The page's MAIN-world
events and Page Script Notice bridge cannot authorize this request.

A toolbar command's preliminary policy check does not show a second confirmation. The resulting
main Document and each redirected Document are checked independently. Confirmation continues
Chrome's original paused request, preserving its method and body, including native 307/308 redirects.
An Embedder-supplied replacement `url` retains the existing explicit 303 redirect contract instead.
Cancellation, expiry, unavailable capabilities, Viewer loss/replacement, Session close, or a
superseding main Document deny the pending request. Removing `navigationConfirmation` cancels its
requests independently from Page Script Notices. Accepted Notice responses count as input activity;
expired/stale responses do not.

For a created tab whose initial URL can require confirmation, set
`tab: { mode: 'create', initialUrl, deferUntilViewer: true }`. Core returns a READY blank tab, then
starts that URL once after the first accepted Viewer handshake. This allows the Embedder to issue
a ticket without waiting for the destination or a human response. Reconnecting does not replay the
initial URL. If initial navigation is rejected, the tab remains usable and the Viewer can request
another URL. Omitting the option preserves immediate initial navigation; a confirmation without a
connected Viewer fails closed. Embedders can precheck an initial URL before attachment, as BrowShare
does, to reject an immediately denied start without allocating a Session tab.

Chrome can hold renderer CDP commands while a Document awaits confirmation. Core defers these
commands outside their ordinary command timers, while Fetch decisions and explicit navigation/stop
remain able to proceed. Navigation CDP commands have a two-minute bound covering confirmation and
redirects; a command timeout cancels the pending decision and stops loading. Other CDP commands
retain their ordinary timeouts after the navigation decision finishes.


### Replace an Extension capture (0.1.17 candidate)

`ExtensionLoopbackServer.replaceMediaCapture({ sessionId, viewerGeneration, streamId, viewport,
audio })` is a low-level media operation, returning `Promise<void>` after the signed Extension
acknowledges sender replacement. Obtain the single-use stream ID through `prepareCapture` for a
resolved target in the same Chrome runtime. Core and Extension must use the coordinated package
version. This adds no public Viewer wire message; protocol remains 1.1.

The Extension acquires the new capture before retiring the old stream. It replaces the existing
peer's audio/video sender tracks and retains all three DataChannels without a new SDP offer. Audio
track topology must match the existing Publisher. Suspension remains effective during acquisition
and commit; resumed media uses the new source. A preparation/acquisition/topology failure leaves
the old source intact. Once sender replacement begins, failure stops the Publisher because mixed
old/new tracks cannot safely represent either selection. Stop acknowledgement waits for an in-flight
replacement's late capture to be released. An ended old stream cannot close the new Publisher.

Acknowledgements bind request ID, Chrome runtime, Session and Viewer generation. A missing ACK
makes source selection uncertain and requests Publisher teardown. The caller must serialize this
operation with Viewer replacement and Session cleanup, and keep target-dependent input disabled
until it has reconciled the result. A rejected operation does not always mean that the old stream
survived. Chrome does not provide another usable capture of an already captured target; selecting
the current source must be handled as a no-op before capture preparation.

This operation **does not change** `RemoteTabSession.getAttachment()` or any CDP input/navigation,
clipboard, file, Page Script, policy or target lifecycle routing. It must not be used to implement a
Viewer switch without coordinating those boundaries. A future Session-level selection operation
will own that coordination. `prepareCapture` records the most recently prepared target mapping;
the low-level caller owns all resolved child mappings and their release. Closing the immutable
Session root still closes the Session and its owned descendants.


### Select an owned window (0.1.18 development candidate)

Grant `windowSelection` only with `childTargetPolicy: 'retain'`. The Session keeps its immutable
`getAttachment()` identity and owns the full root/descendant tree. `session.getWindowState()` returns
`{ revision, selectedTargetId, selecting, windows }`; each window contains `targetId`, title, URL and
`main`. The catalog includes every owned window; title and URL are display excerpts capped at 256
and 512 Unicode code points. Use selected navigation state for the current location. Transport
framing is internal to Core and Headless Client. This is untrusted display content, not diagnostic
or audit data. The root remains the
Session lifetime boundary; closing it ends the Session and its descendants.

A protocol-1.2 Viewer negotiates `windowSelection`, receives `window.state`, and issues correlated
`window.select` or `window.close` commands. Headless Client and the default Web Component expose
`windowState`, `selectWindow(targetId): Promise<void>`, `closeWindow(): Promise<void>` and
`window-change`. The default Viewer supplies a localized selector and an action to close the
selected child. Closing the main window still uses the existing Session-close request.

The selection operation cancels pending upload/clipboard actions and Viewer decisions, releases
held keys/buttons on the old controller, configures the selected target and waits for Extension
capture acknowledgement before committing active CDP routing. Input, navigation, viewport,
clipboard and new uploads use the selected controller. Downloads remain Session-owned with their
originating controller recorded. Resolved child observers remain attached until Session cleanup;
Page Script is installed once for each resolved window. Only the selected window may request a
Viewer decision through its Page Script bridge. Already-open retained pages are adopted in their
current state; their initial historical requests cannot be authorized retroactively. The newly
installed controller applies the document hook to subsequent navigation. A confirmation-required
navigation from any inactive resolved window is denied without prompting the Viewer.

For negotiated Sessions, target-dependent Viewer commands carry `windowRevision`. Core drops
retired input/transfer commands and replies to stale selection requests with the current window
state and an error. Headless Client blocks target-dependent sends while selection or catalog
assembly is pending. Live capability revocation reaches protocol-1.2 clients through
`capabilities-change`; removing `windowSelection` returns capture to root and clears the selector.
Restored grants require a new Viewer negotiation.
Same-target selection is a no-op. Pre-capture preparation failure reports an error with the old
selection retained; an uncertain/partial media replacement closes the Session. A missing selection
ACK fails the client transport rather than allowing input with an unknown source.

The Extension identifies capture-ended events by Viewer generation and capture revision. For
window-selection Publishers it retains the peer so Core can return a closed child to the root;
ordinary Publishers retain their previous teardown behavior. Suspension survives selection. The
Core closes all owned windows, observers and target mappings on Session cleanup.

These interfaces remain unpublished development candidates. Focused Chrome Stable/WebRTC
acceptance covers media/input/UI, selected-window navigation and confirmation, file transfer,
clipboard, Page Script, capability revocation and Viewer replacement, multi-level descendants,
held-key release, selection/closure races, and complete 131-window catalogs with 16 KiB framing.
This establishes the owned-window feature boundary; it does not refresh the entire release matrix
or establish external publication. BrowShare's QA Worker now uses the coordinated 0.1.18 set;
its real Portal/Backend/Worker flow verifies child-window login and persisted Profile state.


### Session media limits (0.1.19 candidate)

`AttachSessionInput.mediaLimits` optionally supplies immutable `{ maxWidth, maxHeight, maxFrameRate,
maxBitrate }` bounds. Width/height are capture/output limits (up to1920/1080), frame rate is1–60,
and bitrate is100000–20000000 bits/s or null to retain engine preset selection. Invalid bounds
reject before tab attachment. Core copies the values, clamps initial and requested viewports and
quality settings, and retains them across child selection and Viewer replacement.

Core sends the initial bounded balanced quality in Extension `media.start.quality`. The Extension
sets video transceiver send encodings before offering media, so the initial stream is already bounded.
Subsequent preset changes apply bounded sender parameters; capture replacement retains that sender.
`hello.accepted` is followed by `quality.ack` for a Viewer with qualityControl; later ACKs report
Chrome-applied settings. The default Web Component forwards `quality-change` and exposes applied
FPS/bitrate in the quality control description. The Viewer protocol remains1.2; Core/Extension must
use the coordinated0.1.19 loopback set. No business policy store or global policy is added to Core.


### Upload constraints (0.1.20 / Viewer protocol 1.3 candidate)

`AttachSessionInput.fileTransferLimits.allowedExtensions` is an optional list of lowercase filename
suffixes, for example `['.txt', '.tar.gz']`; the default empty list permits all extensions. Up to 64
unique entries are accepted, matching `^\.[a-z0-9][a-z0-9._+-]{0,31}$`. This is a filename policy;
Core does not sniff MIME types or identify file contents. Core validates and copies this policy at
attachment, and rejects file count, per-file size, total batch size or suffix violations before
allocating storage. Limits remain enforced for older Viewers.

With negotiated Viewer minor >= 3, `file.upload.request.constraints` carries `maxFileBytes`,
`maxBatchBytes`, `maxFiles` and `allowedExtensions`. Core omits this optional field for older peers.
The Protocol package exports `UploadConstraintsSchema`, its type, and `assertUploadAllowed`.
Headless `uploadFiles` preflights these limits without consuming the chooser request on rejection.
The default Viewer displays the limits, sets the local file input's accept hint, and keeps the
picker available after preflight failure. The hint and client preflight do not replace Core checks.
The coordinated Core/Extension release is 0.1.20; Viewer protocol 1.3 is additive within major 1.


`fileTransferLimits.maxTemporaryBytes` optionally caps aggregate Session upload reservations and
Chrome download spool bytes. Omission adds no aggregate Core cap beyond the storage adapter's own
limits. Known download lengths are reserved on Chrome progress; unknown lengths use received bytes.
Core cancels downloads as soon as reported progress exceeds per-file, count or remaining aggregate
limits. Chrome can write between progress notifications, so this is not a filesystem hard quota.
Completion, cancellation, target close, capability revocation and Session cleanup release download
reservations. Successful uploads remain counted until Session cleanup because Chrome File objects
read their backing paths lazily. Failed or cancelled uploads release their reservation.

Opening another upload chooser or rejecting an upload does not cancel independent pending
downloads. The Viewer temporarily hides the download prompt while the upload picker is active
and resumes it afterward. These transfers still share the same configured temporary budget.


### Embedder-owned download sink (0.1.21 candidate)

Optional `AttachSessionInput.downloadSink: SessionDownloadSink` replaces immediate Viewer delivery
for that Session. `reserve({sessionId,downloadId,declaredSize})` is synchronous and atomically
reserves/resizes a Chrome download as length becomes known; failure leaves an earlier reservation
unchanged. `commit({sessionId,downloadId,localPath,displayName,size})` must take durable ownership
before resolving (move within the same filesystem, or finish a durable copy). Core then removes its
original spool pathname. `abort({sessionId,downloadId})` idempotently releases only uncommitted
reservations; it must not delete a successful commit. A sink must share retained-download quota
with its Embedder's upload storage adapter. Core's own aggregate cap counts only files still owned
by the active engine; retained-file accounting belongs to the sink.

With a sink, authorized downloads can finish without a Viewer, and Viewer departure/replacement
does not cancel Chrome downloads. No file offer or bytes enter the Viewer DataChannel for this
mode. Session close and download capability revocation cancel unfinished Chrome downloads but wait
for completed files already being committed. Core never calls sink cleanup for committed files and
never holds a Session alive for their retention period. The Embedder owns persisted ownership,
retention, access checks, serving bytes and cleanup after restart; the sink must not reenter Core
close from inside commit. Ordinary Embedders without a sink keep immediate-download behavior.

Store failure releases the spool/reservation and reports a generic file-transfer failure, without
logging source paths or file content and without failing the Chrome Session. A production sink
must complete its I/O or reject; commit is an ownership boundary, not a best-effort notification.

A synchronous reservation rejection may use `RemoteTabError` with `FILE_LIMIT_EXCEEDED` or
`FILE_TRANSFER_FAILED` and a nonempty public message of at most 1024 characters. Core forwards
only that code and message as the existing warning Notice. The Embedder must use a fixed,
content-free explanation; arbitrary exceptions and invalid messages receive a generic storage
failure. Error details and causes are never forwarded. This lets an Embedder explain disk or
storage quota rejection without introducing its business error codes into the Remote protocol.

### Viewer focus policy (unreleased 0.1.22)

`viewer.focusPolicy = { mode, gracePeriodMs }` accepts `NEVER`, `WHEN_HIDDEN` or
`WHEN_UNFOCUSED` and an integer grace period from0 through300000 milliseconds. The property is
validated and copied; its getter returns a copy. Set it before appending the element to apply the
policy on initial connection. Changing it cancels the old timer and evaluates current visibility
and focus. Returning during the grace period cancels suspension. A return during the suspension
acknowledgement is reconciled after that acknowledgement, preserving the same client and peer.
Only automatic focus suspension resumes automatically; explicit host suspension remains manual.
The suspended overlay also exposes a translated Resume button. Removal/disconnect cancels timers.

Without an explicit property, the frozen `suspend-when-unfocused` attribute retains its original
behavior (`false` disables it; otherwise unfocused/hidden suspension is immediate). Setting the
property to `undefined` restores that attribute behavior. Explicit `focusPolicy` takes precedence.
BrowShare selects its own15second default and global/Profile policy through this public property.

Extension suspension sets every audio/video sender encoding inactive before acknowledging the
state. Track disabling alone is insufficient because Chrome continues sending black frames/silence.
Sender parameter changes, quality changes and capture replacement are serialized per Publisher.
A failed partial change retires that Publisher without a false success acknowledgement. Capture
tracks, PeerConnection and DataChannels remain on successful suspension; reactivation resumes media.


### Advanced quality (unreleased 0.1.23, protocol 1.4)

Both the Session and Viewer ticket must allow `qualityControl` and `advancedQuality`, and the Viewer
must negotiate both in its protocol-minor-4-or-newer hello. Advanced quality requires matching Core
and Extension versions. An older Viewer continues to receive the unchanged preset `quality.ack`
contract; an advanced Viewer defaults to automatic mode after hello unless this Session retains a
previous successful configuration.

For an already connected Headless Client or `RemoteTabViewerElement`:

```ts
const state = await client.configureQuality({
  mode: 'custom',
  maxBitrate: 3_000_000,
  maxFrameRate: 24,
  scaleResolutionDownBy: 1.5,
})
console.log(state.applied)
await client.configureQuality({ mode: 'auto' })
```

The protocol package exports the following runtime-validated types and their `*Schema` equivalents:

```ts
type EncodingSettings = {
  maxBitrate: number             // integer bits/s, 100_000..20_000_000
  maxFrameRate: number           // integer FPS, 1..60
  scaleResolutionDownBy: number  // 1..4; 2 halves both encoded dimensions
}
type QualityConfiguration =
  | { mode: 'auto' }
  | { mode: 'preset'; preset: MediaQualityPreset }
  | ({ mode: 'custom' } & EncodingSettings)
type QualityState = { configuration: QualityConfiguration; applied: EncodingSettings }
```

`configureQuality()` resolves only with the matching sender acknowledgement, or rejects on its
structured failure, a superseding local configuration request, disconnect, capability loss or the
10-second acknowledgement timeout. State changes emit `quality-configuration-change` with `state`;
automatic adaptation also emits this event without a user request. The Web Component exposes a
copied `qualityState` snapshot, initially undefined. These applied values are confirmed encoding
limits, not measured throughput, frame rate or decoded dimensions.

`requestQuality(preset)` remains available. With advanced quality negotiated it calls the preset
configuration path and continues to emit `quality-change` for compatibility. Without that capability
it uses the unchanged legacy wire exchange. A legacy wire preset request stops automatic mode.
Failed application preserves the last acknowledged configuration when Chrome can restore it; if
restoring capture/sender parameters fails, the Publisher closes rather than reporting false success.

Core clamps custom bitrate/FPS to the immutable Session snapshot before forwarding it, and supplies
that ceiling for every mode. Presets retain their existing values. Auto starts at bounded balanced
settings and may recover up to 6 Mbit/s / 60 FPS / native encoded dimensions within that ceiling;
custom can explicitly request the full 20 Mbit/s protocol range when allowed. Core supplies the
Session FPS ceiling as optional `captureFrameRateLimit` in both initial and replacement captures.
The Extension acquires the source at that ceiling, then constrains the current capture/sender to
the acknowledged quality. This preserves the ability to move 30 → 60 → 15 → 60 FPS within the same
source; acquiring the source at the initial 30 FPS would permanently cap later track constraints.
Low-level callers that omit the new field keep the viewport FPS as their source limit. The CSS viewport and
its input-coordinate revision are separate: encoder downscale never changes pointer mapping.

Core retains the last successful configuration across new Publishers and Viewer replacement;
Headless fresh-Ticket reconnect also reapplies its last successful explicit choice when both
capabilities remain available. Capture replacement retains the configuration and reapplies encoding
and capture FPS to the new track. Pending request IDs cannot resolve work belonging to a replacement
Viewer. Revocation stops automatic control and removes the advanced controls.

The [Extension adaptation policy](05-extension-and-core.md#automatic-encoder-quality) specifies
pressure signals, sampling and recovery. This contract describes source behavior; the focused
0.1.23 real-Chrome acceptance and complete publication Gate are still pending.
