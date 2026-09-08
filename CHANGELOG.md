# Changelog

All notable changes to BrowShare Remote Tab are documented here. The project uses one coordinated
version for its public npm packages, private service packages, example application and runtime
version diagnostics. Wire compatibility is tracked separately by the protocol major and minor
version in `deploy/compatibility.json`.

## 0.1.23 - 2026-09-07

Unpublished coordinated source candidate. This dated entry records the prepared changes; it does
not claim npm, GHCR, official Extension signing or GitHub Release publication.

- Core adds content-free Viewer input notification and coalesced viewport-change sampling for Embedder-owned activity policies.

### Added

- `RemoteTabCore.closeSession(sessionId, reason, options?)` permits cleanup by Session identity
  when attachment initialization fails before returning a handle. `browserClosed: true` permits
  cleanup after the Embedder has positively confirmed termination of the owned Chrome process group.

- Protocol 1.4 `advancedQuality`, gated together with `qualityControl`, adds correlated
  `quality.configure`, `quality.configuration` and `quality.configuration_failed` messages without
  changing the legacy preset request/ACK. Matching Core/Extension 0.1.23 is required.
- Public `EncodingSettings`, `QualityConfiguration` and `QualityState`; Headless Client and Viewer
  `configureQuality()`, `quality-configuration-change`, and Viewer `qualityState`. The default Viewer
  adds Auto/Custom controls and an acknowledged, localized custom-settings dialog.
- Automatic quality starts from bounded balanced settings and reacts to sustained sender/network
  pressure, with slower recovery. Explicit custom settings support up to 20 Mbit/s, 60 FPS and
  4× downscale, within the immutable Session media limits. Focused real Chrome configuration,
  adaptation, negotiation and failure/retry acceptance is recorded in `docs/design/08-testing.md`.

- Negotiated `windowSelection` (protocol 1.2): an owned window catalog, select/close commands,
  window revision on target-dependent control, and capture-ended recovery to the immutable root.
- Headless Client and Viewer expose `windowState`, `selectWindow()` and `closeWindow()`; the Viewer
  includes a localized window selector and child-close control, with real media replacement and
  target-bound input acceptance recorded in `docs/design/08-testing.md`.

- Owned child-window CDP snapshots, title/location/closure events and observer-only detach.
- Acknowledged Extension capture replacement within the existing WebRTC peer and DataChannels,
  preserving suspension and audio topology. The low-level operation was first exercised in 0.1.17;
  the current coordinated candidate integrates it with Session/Viewer window selection.

- Core exposes `onTitleChanged` for initial and changing main-document titles, independently of
  Viewer connectivity. Observation runs in an isolated world and excludes subframes.

- Headless Client and Viewer emit `playback-blocked` when Chrome requires a user gesture to
  play the attached media element. Viewer provides a localized, keyboard-accessible playback action.

- Explicit ESM and TypeScript exports for the private signaling package, allowing coordinated
  embedders to instantiate the existing Gateway with their own authorization adapters.

### Fixed

- Headless Client binds a shared audio/video MediaStream once, preserving pending playback when
  its tracks arrive separately. Real Safari previously reset the media element and aborted the
  first play request when the same stream was assigned twice; new stream replacement, reattachment
  and explicit autoplay permission feedback remain unchanged.

- Standalone creation, Viewer Ticket and capability-update requests accept the full supported
  capability set. The obsolete twelve-item limit rejected valid combinations containing newer
  quality, Notice and window capabilities; unknown and duplicate names remain invalid.

- Standalone diagnostic output retains fixed events and machine fields while omitting free-form
  Page Script error messages that can contain page data; the public Core debug hook is unchanged.

- Failed CDP target closure retains Session/target ownership and temporary files for retry,
  including owned descendants, disconnected CDP transports and partially initialized attachments.
  Exact target absence completes cleanup; a connection error alone does not prove Chrome exited.

- After an upload is rejected, Viewer clears the sending indicator and explains how to close
  the completed chooser request and select files again on the remote page, in both supported locales.

- Download sinks can explain admission rejection through existing public file errors; arbitrary
  storage exceptions remain private and produce a generic transfer failure instead of falsely
  claiming that a Session quota was exceeded. No wire or package signature changes.

- Initial and replacement capture acquire at the Session FPS ceiling through optional
  `captureFrameRateLimit`, keeping the current encoding/capture constraints separate. This fixes a
  source initially acquired at 30 FPS preventing later 60 FPS quality requests from taking effect;
  real 30 → 60 → 15 → 60 FPS capture/encoder changes were verified in the same connection.
  These are configured maxima, not a promise of sustained 60 FPS delivery.

- Adoption discovers pre-existing opener descendants and rejects overlapping Session ownership
  without closing another Session's pages; normal adoption removes pre-existing child windows.

- Direct Viewer entry no longer leaves a silent black screen after autoplay rejection. The
  connection stays alive, remote input is disabled until playback starts, and a trusted click or
  keyboard activation resumes the existing video without requesting a new Ticket.

- A newer authorized Viewer Ticket can replace an initial negotiation before any Viewer has
  connected, preserving the Tab and retiring the old signaling attempt.

- Main-frame HTTP document navigation now calls the Embedder hook before the request, including
  initial URLs, page scripts, links, forms and redirect hops. Denial preserves the previous page.
  Owned tabs bypass site Service Worker request handling so synthetic responses cannot skip the
  document guard; this limits Service Worker/offline functionality in those tabs.
- Repeated Session close calls, including close from a failure notification, now share the actual
  cleanup promise. Embedders can wait for cleanup before releasing Tab ownership.
- The Linux chrome-node image sets `LANG=C.UTF-8` so Chrome accepts uploaded paths containing
  non-ASCII filenames instead of silently leaving the file input empty.

### Verified

- Signed 0.1.17 Extension with Linux Chrome Stable 152.0.7977.75 and local Stable 152.0.7977.76:
  repeated red/blue capture changes, decoded audio, one peer/offer, all three DataChannels,
  Notice round trip, suspension, invalid/stale requests and prior-source closure. This focused
  result does not replace the full release Gate or imply cross-window input support.

- BrowShare Worker integration with two real Chrome Stable `152.0.7977.75` tabs, signed Extension
  `0.1.15`, and local Stable Viewers: direct WebRTC media, Chinese/Emoji input, Unicode upload,
  download, clipboard, suspend/resume, Viewer takeover and independent close.
- Concurrent close waiting, Worker lease expiry, cancellation and Chrome SIGKILL cleanup. The
  protocol for that historical 0.1.15 run was `1.0`; it does not describe the current protocol `1.4`.
  Full TURN/browser-matrix evidence for that run remains the earlier Gate 0 baseline.
- BrowShare's independent Gateway image imports the public signaling export and delegates ticket
  consumption and Core binding authorization to its Backend. Real TLS/WebSocket role clients
  verify relay, concurrent single-use consumption and replay rejection after process restart.
  This integration check does not add a new Chrome media or TURN matrix result.
- Real Stable main-document authorization for initial requests, scripts, links, forms, redirects,
  failure/timeout, Service Worker synthetic responses and independent tabs. Two real Stable browser
  clients decode 1280x720 video, deliver Chinese input and receive denial Notices after the change.

## 0.1.15 - 2026-09-05

### Fixed

- Recover unattended Extension startup when a fresh force-install starts the service worker before
  Chrome supplies its managed policy values. Listen for managed storage changes and coalesce an
  in-flight configuration retry without reconnecting an already successful startup.

### Verified

- Two fresh persistent Profile directories in Google Chrome Stable `152.0.7977.75`: both Extension
  roles connect, each Profile passes unattended tab capture and emits its own real WebRTC offer.
- Worker-owned Profile stop, crash and new-generation restart preserve the other Profile's runtime;
  Worker shutdown closes all owned Chrome endpoints. This verifies startup and publisher readiness;
  the full direct/TURN Viewer evidence below remains the `0.1.14` baseline.

## 0.1.14 - 2026-09-04

First stable source and artifact candidate.

### Added

- A reusable Core that binds one authorized Session to one Google Chrome Stable tab through CDP and
  an authenticated fixed-ID Extension loopback connection.
- A MessagePack protocol with TypeBox runtime validation, stable error codes, capability
  negotiation, Viewer generation takeover and single-use HMAC Viewer Tickets.
- A Chrome MV3 Extension that publishes one tab through WebRTC with optional tab audio and separate
  reliable, realtime and file-transfer DataChannels.
- A framework-independent Headless Client and Viewer Web Component with navigation, pointer,
  keyboard, IME, quality, lifecycle, upload, download, clipboard, local-open and Notice behavior.
- A public Signaling Gateway that forwards only authenticated SDP and ICE records and exports
  bounded health, capacity and Prometheus metrics.
- A Standalone daemon for third-party embedding, including authenticated Session APIs, capability
  diagnostics, temporary storage, reconciliation and deterministic shutdown.
- Extension signing and managed-policy tooling, direct and TURN deployment guidance, Linux Compose
  examples, Chrome-free service images and a locally built Chrome-node target.
- Coordinated compatibility, release artifact, SBOM, checksum, provenance, upgrade, rollback,
  security review and operational runbooks.

### Verified

- Google Chrome Stable `152.0.7977.75` with signed Extension `0.1.14` and protocol `1.0` on Ubuntu
  24.04 x86_64.
- Four concurrent tabs over direct ICE and forced TURN/TLS with independent capture, input, file,
  clipboard, lifecycle, suspension and cleanup behavior.
- Current desktop Chrome, Edge, Safari and Firefox Viewer paths. Mobile remains an explicit preview
  tier rather than a parity claim.
- A clean third-party-style source deployment and a separate release-candidate security review.

### Security boundaries

- Media, input and files never traverse the Signaling Gateway.
- CDP, Extension loopback, Standalone API, metrics and Extension update serving remain loopback or
  private-network concerns.
- Google Chrome Stable is proprietary and is not redistributed in a public image or source release.
- Tabs sharing one Chrome Profile share cookies and site storage and are not security-isolated.
