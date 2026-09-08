# `@browshare/remote-tab-viewer`

Default framework-independent Web Component for BrowShare Remote Tab.

## Get started

Follow the [source build and Viewer integration guide](../../docs/getting-started.md#use-the-viewer-in-your-application)
to prepare this package with its production dependencies and connect it to your web application.

## Render the Viewer

```ts
import { defineRemoteTabViewer } from '@browshare/remote-tab-viewer'

defineRemoteTabViewer()
```

```html
<browshare-tab-viewer
  ticket="short-lived-single-use-ticket"
  endpoint="wss://signal.example.com"
  locale="zh-CN"
></browshare-tab-viewer>
```

The Viewer suspends the remote media path when its local window is hidden or unfocused by default.
It owns browser interactions such as upload selection, download confirmation, clipboard permission
fallbacks and “open on this device” confirmation, while the embedding Portal remains responsible for
business workflow.

Correlated Notice requests use a native modal with plain-text title/body/buttons, Escape/Cancel,
focus containment and restoration, and bounded scrolling. The existing one-way Notice remains a
toast. To supply host UI, cancel the `notice-request` DOM event with `preventDefault()`, then call
`viewer.respondToNotice(requestId, buttonId)`; remove that UI on `notice-closed`. Requests require
the negotiated `noticeRequests` capability and the coordinated Core/Extension 0.1.18 set.

With `navigationState`, the address bar follows Chrome's observed location and the host receives
`navigation-location-change`. Live location changes preserve address edits; submission
ends editing and blur restores the latest observed location.

With negotiated `windowSelection`, the Viewer shows an owned-window selector and a
child-close action. The element exposes `windowState`, `selectWindow(targetId)`, `closeWindow()`
and `window-change`, matching Headless Client. Selection blocks remote input until server ACK;
closing the main window continues to use `session-close-request`. See the
[selection contract](../../docs/design/03-embedding-api.md#select-an-owned-window-0118-development-candidate)
for ownership, selection and cleanup rules.

`quality-change` reports the applied quality ACK, including bounded FPS and bitrate. The quality
control tooltip and accessible description show these actual limits alongside the selected preset.

## Automatic and custom quality

With both `qualityControl` and `advancedQuality` negotiated, the Viewer offers Auto and
Custom alongside the three presets. Auto is initially selected unless the Session retains a previous
choice. The custom dialog validates maximum bitrate (kbps), FPS and encoded-resolution downscale,
shows application progress/errors and keeps the confirmed selection until the sender acknowledges.
The applied description contains encoding ceilings, not measured performance.

A connected element also exposes `configureQuality(configuration): Promise<QualityState>`, a copied
`qualityState` getter and the `quality-configuration-change` DOM event. The event detail contains
`{ type: 'quality-configuration-change', state }`. Import the configuration/state types from
`@browshare/remote-tab-protocol`. Older negotiation retains the original three-preset UI and
`quality-change` event. See the [public contract](../../docs/design/03-embedding-api.md#advanced-quality-unreleased-0123-protocol-14).
See [testing and compatibility](../../docs/design/08-testing.md) for the desktop browser matrix and runtime requirements.

### Immersive controls

The toolbar uses 24px SVG icons with 44px click targets and localized labels.
Use the Immersive button, or set `viewer.immersive = true`, to hide navigation and window controls.
An always-visible Exit immersive button restores them. Listen for `immersive-change` with
`event.detail.immersive` to collapse your application's header and footer as well.
Media, input mapping, Notices and dialogs stay active; the remote website is unchanged.

### Remote cursor

When `cursorFeedback` is negotiated with a protocol-1.5 Core and matching Extension, `cursor-change`
reports a standard CSS cursor keyword. The Viewer applies it locally; custom cursor images and page
content are never copied. See the [cursor contract](../../docs/design/04-control-protocol.md#cursor-feedback)
for frame, shadow-root, navigation and compatibility behavior.
