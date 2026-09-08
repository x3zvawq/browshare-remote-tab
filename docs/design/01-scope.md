# Scope and use cases

## Purpose

BrowShare Remote Tab turns one already-authorized Google Chrome tab into an embeddable web session. It combines extension-based `tabCapture` media with CDP input and browser control, preserving native WebRTC congestion behavior without streaming a full desktop.

The library is intended for controlled browser runtimes operated by the Embedder. It is not a consumer extension installed into an arbitrary personal browser.

## Users

| User | Goal |
| --- | --- |
| Embedder developer | Attach an application session to one Chrome tab and render a Viewer |
| Runtime operator | Install the signed extension, supply Chrome, configure signaling/TURN, and run diagnostics |
| End user | View and control an authorized remote webpage without installing local software |
| BrowShare Worker | Embed Core and connect BrowShare Session lifecycle to Remote Tab |

## Capabilities

- Capture one designated tab as WebRTC video and optional tab audio.
- Dispatch pointer, wheel, keyboard, shortcut, IME, and text input through CDP.
- Navigate, go back, go forward, and reload under Embedder authorization.
- Upload files to a designated file input and deliver tab-owned downloads.
- Transfer text and image clipboard data on explicit user actions.
- Report title, location, viewport, connection, media, and diagnostic state.
- Intercept new windows and ask the Embedder or Viewer how to handle them.
- Render a complete default Viewer or expose the same behavior through a Headless Client.
- Signal peers through a standalone Gateway and fall back to configured TURN.

## Non-goals

- Installing, launching, updating, or assigning Google Chrome.
- Choosing or copying a Chrome Profile or `user-data-dir`.
- Configuring the webpage's HTTP/SOCKS proxy.
- Managing application users, roles, subscriptions, audit retention, or resource scheduling.
- Streaming a desktop, browser chrome, native dialog, or arbitrary application.
- Isolating cookies or storage between tabs in the same Profile.
- Hiding automation or bypassing website anti-abuse systems.
- Guaranteeing compatibility with untested Chrome versions.

## Integration modes

### Embedded Core

The application imports Core into its Worker or server process. It supplies CDP access, extension loopback configuration, authorization callbacks, temporary file storage, and signaling credentials. This is BrowShare's mode.

### Standalone daemon

The operator starts a Remote Tab daemon and points it at an already running, supported Chrome. The daemon exposes a documented local or mutually authenticated API to the Embedder. It diagnoses Chrome and extension capability but does not install or start Chrome.

### Headless Viewer

The application uses the Headless Client to build custom UI while retaining protocol, WebRTC, input, file, and state-machine behavior.

### Default Viewer

The application mounts a framework-agnostic Web Component and handles emitted lifecycle requests such as ending a business Session.

## Product guarantees

Remote Tab guarantees behavior only for a published compatibility set of Core, Extension, protocol, and Google Chrome Stable. The capability probe reports unsupported conditions before accepting sessions.

It does not guarantee a fixed frame rate, direct ICE connectivity, target-site stability, remote cookie compatibility with local-open URLs, or preservation of a tab after Chrome or Core crashes.

## Success criteria

- A third party can understand deployment and embedding without reading BrowShare source.
- Embedded and standalone modes use the same Core and protocol implementation.
- Multiple tabs in one Chrome can stream and receive input without cross-session leakage.
- Media and file bytes never traverse the signaling Gateway.
- Chrome and extension problems produce actionable diagnostic codes.
- Viewer can be used in Vue, React, plain HTML, or another framework without an iframe.

