# `@browshare/remote-tab-core`

Server-side Remote Tab engine for binding an Embedder-authorized Session to one already running
Google Chrome Stable tab.

## Install

```bash
pnpm add @browshare/remote-tab-core
```

## Attach a Session

```ts
import { ExtensionLoopbackServer, RemoteTabCore } from '@browshare/remote-tab-core'

const extension = new ExtensionLoopbackServer(extensionOptions)
await extension.start()

const core = new RemoteTabCore({ extension, downloadDirectory })
const session = await core.attachSession(authorizedAttachment)

const { targetId, tabId } = session.getAttachment()
const viewerTicket = await session.createViewerTicket(ticketRequest)
```

The Embedder supplies Chrome/CDP lifecycle, authorization, signaling assignment, storage and ticket
issuance. Core does not install or launch Chrome and does not own application users, Profiles,
proxies, billing or business policy.

One loopback server may accept multiple managed Chrome processes. Current Extensions identify each
process with a `runtimeInstanceId`; target discovery and every later Session operation stay on the
same service-worker/media pair. Inspect all connected pairs without exposing their secrets:

```ts
for (const runtime of extension.getRuntimeStatuses()) {
  console.log(runtime.runtimeInstanceId, runtime.coherent)
}
```

An older Extension without an instance ID remains supported as a single legacy runtime.

An optional `hooks.onTitleChanged({ sessionId, title })` receives initial and changing main-document
titles without requiring a Viewer. Core observes an isolated world, excludes subframes, and limits
titles to 4096 Unicode code points. Empty titles are reported as empty strings. Render titles as
untrusted text and keep them out of default logs; application naming policy belongs to the Embedder.

For Embedder-owned activity policy, `hooks.onInput({ sessionId, observedAt })` observes processed
Viewer input without its contents. `session.sampleFrameChange()` returns `{ changed, observedAt }`
from a current viewport comparison; the first sample is changed, concurrent calls coalesce, and
errors reject. Pixels remain in Core memory. Sampling frequency, timers and recycling belong to
the Embedder; no observation loop runs unless requested.

`session.requestNotice(content, { timeoutMs?, signal? }?)` requests a correlated Viewer decision
under the negotiated `noticeRequests` capability (Core/Extension 0.1.18, protocol 1.1). Its result
contains `requestId`, `buttonId` (null on cancellation), and an explicit reason. No cancellation
represents consent. See the [embedding contract](../../docs/design/03-embedding-api.md#request-a-viewer-decision-0116--protocol-11)
for limits, validation and the distinction from the existing one-way `sendNotice`.

Page Scripts receive optional `event.detail.requestNotice(content)` on fixed lifecycle events when
`noticeRequests` is enabled. It returns a `NoticeDecision` to the original main document and cancels
when that document retires. See the [Page Script bridge](../../docs/design/03-embedding-api.md#page-script-notice-bridge-0116)
for limits and the MAIN-world trust boundary.

For policy-owned remote navigation confirmation, enable `navigationConfirmation` with
`noticeRequests` and return `NavigationDecision.confirmation`. Core pauses the actual main Document
and continues its original request only after approval. Use create-mode `deferUntilViewer: true`
when the initial URL can need a Viewer decision. See the [navigation confirmation contract](../../docs/design/03-embedding-api.md#confirm-a-remote-navigation-0116-candidate).

For retained child windows, grant the candidate `windowSelection` capability (protocol 1.2).
`getAttachment()` remains the root; `getWindowState()` describes the selected window and owned
catalog. See the [selection contract](../../docs/design/03-embedding-api.md#select-an-owned-window-0118-development-candidate)
for command binding, cleanup and acceptance status.

Optional `mediaLimits` on attachSession bounds capture dimensions, FPS and bitrate for the Session.
Limits are copied at creation, apply to every Viewer/window and survive reconnects. See
[Session media limits](../../docs/design/03-embedding-api.md#session-media-limits-0119-candidate).


Advanced quality requires both `qualityControl` and `advancedQuality` in the authorized Session,
Viewer ticket and protocol-1.4 hello. Core configures the matching 0.1.23 Extension only after
negotiation, defaults a new advanced Session to auto, and retains the last successful configuration
across Viewer replacement. It clamps custom bitrate/FPS and passes the immutable Session ceiling
to the Publisher for every mode. Older Viewers keep the existing preset wire exchange. See the
[advanced-quality contract](../../docs/design/03-embedding-api.md#advanced-quality-unreleased-0123-protocol-14).


The optional low-level `StartExtensionMediaRequest.captureFrameRateLimit` and
`ReplaceExtensionCaptureRequest.captureFrameRateLimit` set the source acquisition ceiling (1–60 FPS).
Core Sessions populate it from `mediaLimits.maxFrameRate`, independently of current quality FPS,
so later upgrades can actually use the allowed source rate. The coordinated Extension is required
when supplied; omission preserves the caller's viewport FPS acquisition limit.


Await `session.close(reason)` before releasing Session ownership. A rejected cleanup keeps the
Session reserved and may be retried. Use `core.closeSession(sessionId, reason)` when attachSession
rejected before returning a handle. Optional `{ browserClosed: true }` is valid only after the
Embedder proves its owned Chrome process/group terminated; CDP disconnect is not proof. See the
[close contract](../../docs/design/03-embedding-api.md#session-close-completion).
