# Implementation plan

## Using this plan

Phases describe dependencies and exit criteria, not a mandatory sequence to repeat for every task. Use [PROGRESS.md](../../PROGRESS.md) and its supporting evidence to locate the remaining work. Preserve the dated phase records below as historical evidence; current versions come from package and compatibility manifests, not old phase summaries.

The [frozen API baseline](15-gate-0-and-api-freeze.md) governs public-surface changes. Source readiness and external publication are separate outcomes: complete the authorized work and record missing external evidence without treating an implementation request as permission to publish.

## Principles

Build one reusable implementation for embedded and standalone modes. Standalone wraps Core; it must not fork protocol or browser behavior. Preserve only verified ideas from earlier POCs, not their combined server structure.

## Phase 1：Workspace and contracts

Status: complete on 2026-09-03. Phase 1 originally used development version `0.0.0`. After the
complete Gate 0 and security review, that recorded baseline coordinated workspace packages and
runtime diagnostics at stable release candidate `0.1.14`. See the current manifests for later versions.

Create the pnpm workspace:

```text
packages/core
packages/protocol
packages/headless-client
packages/viewer
packages/extension
apps/signaling
apps/standalone
tools/extension-signing
examples/embed
```

Define package exports, tsdown builds, test runner, strict TypeScript settings, runtime schemas, error codes, capabilities and state machines.

Exit: packages build independently, protocol round trips pass, public API documentation matches exports. Current evidence is recorded in [Phase 1 package contracts](10-package-contracts.md).

## Phase 2：Single-tab vertical slice

Status: complete on 2026-09-03. Core, Viewer, the authenticated Standalone API and runnable Gateway
CLI have passed the documented real-Chrome flow. See [Phase 2 vertical-slice
record](11-phase-2-vertical-slice.md) for the exact evidence and remaining later-phase boundary.

Implement one complete Session:

- Core CDP connection and target binding.
- Extension loopback authentication and `tabCapture`.
- Signaling Gateway and Viewer ticket adapter.
- Headless Client PeerConnection.
- Viewer Web Component video surface.
- Pointer, keyboard, IME, navigation and viewport acknowledgement.

Exit: a standalone example controls one tab through real Google Chrome Stable without media passing through Gateway.

## Phase 3：Channels and lifecycle

Status: complete on 2026-09-04. The three DataChannels, Viewer generation takeover,
Core-side pre-pair retry, explicit and focus-driven suspension, tab audio, selected-route diagnostics
four-Session pause isolation, bounded ICE restart, fresh-Ticket Headless Client reconnect and
acknowledged quality presets are implemented. Real Chrome runs verify all three sender presets,
decoded Viewer resolution, ICE-restart recovery during a UDP outage, and periodic inbound/outbound
media metrics with sampler cleanup. Eight real lifecycle iterations also verify fresh-Ticket
reconnect, active takeover, target/DOM preservation and cleanup after an acknowledged-publisher
teardown correction. A final destructive-runtime probe records service-worker, offscreen and
Standalone graceful/crash behavior and fixes Standalone terminal-record eviction. See [Phase 3
lifecycle status](13-phase-3-lifecycle.md).

Add reliable/realtime/file DataChannels, Viewer generations, takeover, suspension, reconnect and deterministic cleanup. Implement tab audio, quality control and diagnostics.

Standalone crash reconciliation remains deliberately assigned to Phase 6: an ungraceful process
loss forgets in-memory Session state and can leave a Chrome target for the Embedder to reconcile.

Exit: repeated connect, suspend, resume, replace and close cycles leave no stuck input, orphan transfer or leaked tab.

## Phase 4：Files and browser events

Implement uploads, file chooser, download attribution, clipboard, child-target interception, local-open requests, Page Script event plumbing and structured Notice.

Status: complete. Remote file chooser upload is complete across runtime schemas, Core/CDP,
Session storage, Extension file DataChannel, Headless Client and default Viewer. Normal-Session
child-target interception, Embedder-authorized Viewer-local open, trusted maintenance `retain`, and
structured Notice are also complete. Download GUID ownership, host spool cleanup, acknowledged
transfer, Headless Client Blob assembly, and default Viewer confirmation/save are complete, including
a two-Session real Chrome isolation run. Text and PNG clipboard transfer is complete across Protocol,
Core/CDP, Extension, Headless Client and the default Viewer, including runtime-wide serialization,
browser permission fallbacks and a two-Session real Chrome isolation run. Fixed Page Script lifecycle
delivery is complete across Protocol, Core/CDP, Extension transport, Headless Client, Viewer and
Standalone, including SPA/full navigation, error isolation and close ordering. Unit, integration,
browser-component and real Google Chrome Stable evidence is recorded in
[Phase 4 browser I/O status](14-phase-4-browser-io.md).

Exit: all data is Session-scoped and ambiguous downloads/targets are never assigned to a user.

## Phase 5：Multi-tab Gate 0

Status: complete on 2026-09-04. The current Google Chrome Stable `152.0.7977.75`, signed managed
Extension `0.1.14` and workspace source passed the consolidated four-Session functional/isolation
Gate over both direct ICE and forced TURN/TLS. The protocol remains major `1`, minor `0`; the first
public Core, Headless Client, Viewer, Standalone, Extension and signing surface is recorded in
[Gate 0 and first public API freeze](15-gate-0-and-api-freeze.md).

Run the full Gate in [testing](08-testing.md), fix shared-state assumptions and freeze the first public protocol and embedding API.

Exit: four concurrent tabs pass functional isolation; resource evidence and known limits are published.

## Phase 6：Standalone and operations

Build the Standalone daemon, local/mTLS Embedder API, capability diagnostics, extension signing tools, policy templates, coturn example, health endpoints, metrics and structured logs.

Status: complete for the first release scope. The loopback Embedder API, capability diagnostics,
signing/policy tooling, health endpoints, metrics, structured logs, Compose deployment and
Standalone-crash reconciliation are implemented. Tracked Sessions reconcile immediately when
their main target, flattened CDP attachment, browser connection or Standalone process disappears.
A clean third-party-style host followed only the repository README to self-sign the Extension,
build isolated images, bootstrap a fresh Profile, attach and delete a real Session, return all
Session gauges to zero and restore the pre-existing runtime baseline.

Exit: a third party can follow only this repository's README and docs to supply Chrome, start services, embed Viewer and diagnose failures.

## Phase 7：Release

Status: release engineering complete; public publication pending. The coordinated `0.1.14` source
tree has a complete changelog, package metadata and READMEs, official-Extension assembly, final
release manifest, checksums, SBOM/provenance inputs and a tag-gated publication workflow. Actual
npm, GHCR, official CRX and GitHub release results remain external evidence and are not claimed
until the first tag run succeeds.

Publish MIT-licensed source, npm packages, Chrome-free Signaling/Standalone GHCR images, signed CRX,
update manifest, checksums, SBOM, compatibility table and release notes. Publish the Chrome-node
Dockerfile but no image or archive containing proprietary Google Chrome.

The first stable release requires:

- Frozen public API and protocol major.
- Current desktop browser Viewer matrix.
- Real Google Chrome Stable compatibility evidence.
- Direct and TURN path evidence.
- Security review of tickets, loopback, target binding and file isolation.
- Upgrade instructions for Core, Extension and Chrome compatibility changes.

## Deferred work

- Full mobile Viewer parity.
- Microphone forwarding.
- Multi-viewer collaborative control.
- General desktop or browser-window capture.
- Remote Chrome installation and lifecycle management.
- Embedder-specific users, billing, Profiles, proxies or policy stores.
