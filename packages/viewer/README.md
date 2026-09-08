# `@browshare/remote-tab-viewer`

Default framework-independent Web Component for BrowShare Remote Tab.

## Install

```bash
pnpm add @browshare/remote-tab-viewer
```

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

With negotiated `windowSelection`, the candidate Viewer shows an owned-window selector and a
child-close action. The element exposes `windowState`, `selectWindow(targetId)`, `closeWindow()`
and `window-change`, matching Headless Client. Selection blocks remote input until server ACK;
closing the main window continues to use `session-close-request`. See the
[selection contract](../../docs/design/03-embedding-api.md#select-an-owned-window-0118-development-candidate)
for the current development acceptance boundary.

`quality-change` reports the applied quality ACK, including bounded FPS and bitrate. The quality
control tooltip and accessible description show these actual limits alongside the selected preset.


## Automatic and custom quality

With both `qualityControl` and `advancedQuality` negotiated, the 0.1.23 candidate adds Auto and
Custom alongside the three presets. Auto is initially selected unless the Session retains a previous
choice. The custom dialog validates maximum bitrate (kbps), FPS and encoded-resolution downscale,
shows application progress/errors and keeps the confirmed selection until the sender acknowledges.
The applied description contains encoding ceilings, not measured performance.

A connected element also exposes `configureQuality(configuration): Promise<QualityState>`, a copied
`qualityState` getter and the `quality-configuration-change` DOM event. The event detail contains
`{ type: 'quality-configuration-change', state }`. Import the configuration/state types from
`@browshare/remote-tab-protocol`. Older negotiation retains the original three-preset UI and
`quality-change` event. See the [public contract](../../docs/design/03-embedding-api.md#advanced-quality-unreleased-0123-protocol-14).
This source implementation still requires the consolidated 0.1.23 Chrome/UI acceptance run.
