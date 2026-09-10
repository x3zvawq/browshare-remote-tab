# `@browshare/remote-tab-client`

Framework-independent browser client for connecting to one BrowShare Remote Tab Session without the
default Viewer UI.

## Get started

Build the coordinated workspace with the [source setup guide](../../docs/getting-started.md#build-from-source).

## Connect

```ts
import { createRemoteTabClient } from '@browshare/remote-tab-client'

const client = createRemoteTabClient({
  ticket: singleUseTicket,
  endpoint: 'wss://signal.example.com',
})

client.addEventListener((event) => {
  if (event.type === 'error') console.error(event.error.code, event.error.message)
})

client.attachVideo(document.querySelector('video')!)
await client.connect()
```

The client supports bounded ICE restart and fresh-Ticket reconnect. It never reuses a consumed
Ticket; the embedding application must issue a strictly newer Viewer generation when reconnecting.

With `noticeRequests`, listen for `notice-request` and render `event.request.content` as plain text.
Call `client.respondToNotice(requestId, buttonId)` with an offered button ID or null to dismiss.
Remove host UI on `notice-closed` (expiry, response, cancellation or connection loss). The reliable
control channel closing triggers the existing bounded fresh-Ticket reconnect when configured,
or a structured failure otherwise. Retiring channels cannot affect a replacement connection.

With negotiated `navigationState`, `navigation-location-change` reports the main frame's observed
URL, including redirects and same-document changes. `navigation-result` remains the separate
command outcome; it is not proof that the requested URL became the committed destination.

## Configure encoder quality

With both `advancedQuality` and `qualityControl` negotiated on protocol 1.4:

```ts
client.addEventListener(event => {
  if (event.type === 'quality-configuration-change') console.log(event.state.applied)
})
const applied = await client.configureQuality({
  mode: 'custom', maxBitrate: 3_000_000, maxFrameRate: 24, scaleResolutionDownBy: 1.5,
})
await client.configureQuality({ mode: 'auto' })
```

The result is `QualityState` from `@browshare/remote-tab-protocol`, with `configuration` and
confirmed `applied` encoding limits. Permission loss, a superseding request, disconnect, sender
failure or a ten-second acknowledgement timeout rejects the promise. Auto is the default after
advanced negotiation; it also emits updates when the sender adapts. These limits are not measured
throughput or decoded dimensions. Successful explicit choices are reapplied on fresh-Ticket reconnect
when still authorized.

`requestQuality('balanced')` remains supported, using the advanced preset path when available and
the original wire exchange otherwise. Only preset states emit the legacy `quality-change` event.
See [types, bounds and lifecycle](../../docs/design/03-embedding-api.md#advanced-quality-unreleased-0123-protocol-14).
See [testing and compatibility](../../docs/design/08-testing.md) for verified browser and transport combinations.

### Remote cursor

When `cursorFeedback` is negotiated with a protocol-1.5 Core and matching Extension, `cursor-change`
reports a standard CSS cursor keyword. The Viewer applies it locally; custom cursor images and page
content are never copied. See the [cursor contract](../../docs/design/04-control-protocol.md#cursor-feedback)
for frame, shadow-root, navigation and compatibility behavior.

### Native file drop and selection clipboard

With negotiated `fileDrop` and `upload`, call `client.dropFiles({ x, y, viewportRevision }, files)`
using the acknowledged viewport. Files use the normal bounded transfer and reach Chrome as native
drag/drop events. The promise rejects if the document, selected window or viewport becomes stale;
the website remains responsible for accepting the drop.

With negotiated `clipboardSelection` plus a clipboard capability, `readRemoteClipboard('copy')`
or `readRemoteClipboard('cut')` first edits the actual remote selection inside the same exclusive
operation. Calling it without an argument reads the existing clipboard. A browser embedder still
owns local clipboard permission and user-gesture requirements.
