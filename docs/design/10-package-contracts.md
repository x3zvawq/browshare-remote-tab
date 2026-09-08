# Phase 1 package contracts

## Status and intent

Phase 1 established the workspace and the contracts needed by the single-tab vertical slice. Later
phases completed and verified Chrome attachment, `tabCapture`, WebRTC negotiation, signaling and the
Viewer UI.

The first stable candidate coordinates every workspace package at `0.1.14`. Protocol `1.0` and the
public exports are frozen by [Gate 0 and first public API freeze](15-gate-0-and-api-freeze.md);
subsequent changes must follow its patch, minor or major classification and keep code, package
metadata and documentation synchronized.

## Workspace

The repository requires Node.js 24.11 or newer and pnpm 10.28.2. Packages use TypeScript 6.0.3 and build as ESM with tsdown, emitting `.mjs` plus `.d.mts` files. TypeScript 7 was evaluated but not retained because tsdown still treated its compiler API as experimental and leaked intermediate declarations into source directories.

| Workspace | Package name | Phase 1 content |
| --- | --- | --- |
| `packages/protocol` | `@browshare/remote-tab-protocol` | MessagePack control, validated signaling/loopback messages, HMAC Viewer tickets, capabilities, versions, states and stable errors |
| `packages/core` | `@browshare/remote-tab-core` | Embedder/storage contracts, state machine, CDP tab controller, authenticated extension loopback, Core signaling client and Session orchestration |
| `packages/headless-client` | `@browshare/remote-tab-client` | Concrete Viewer-side signaling/WebRTC client plus event and command contracts |
| `packages/viewer` | `@browshare/remote-tab-viewer` | Registered-on-demand Web Component, default interaction UI and embedding contracts |
| `packages/extension` | `@browshare/remote-tab-extension` | Extension identity and Page Script contracts plus loadable MV3 service-worker/offscreen artifacts |
| `apps/signaling` | private workspace | In-memory explicit-Gateway pairing, ticket consumption and directional SDP/ICE relay |
| `apps/standalone` | private workspace | Loopback Embedder API, Core composition, health checks, generation allocation and local Session storage |
| `tools/extension-signing` | `@browshare/remote-tab-extension-signing` | Signing input/output and managed-policy types only |
| `examples/embed` | private workspace | Reserved build boundary for the Phase 2 example |

No package exports a factory that only throws a placeholder error. The Headless Client, Gateway, Core Session orchestration, Extension media runtime and Viewer element have concrete implementations. Standalone now wraps the same Core behind an authenticated loopback API; real Chrome compatibility is recorded separately from simulated integration tests.

## Protocol envelope

Every current control message is MessagePack-encoded and has this envelope:

```ts
interface ProtocolEnvelope<TypeName extends ProtocolMessageType> {
  version: number
  minor: number
  type: TypeName
  sessionId: string
  viewerGeneration: number
  sequence: number
  payload: ProtocolPayload<TypeName>
}
```

`version` is the incompatible major. Peers with the same major and a different minor are compatible at the envelope level; capabilities and known message schemas decide usable behavior.

The decoder checks byte length before MessagePack decoding, validates the envelope, rejects an incompatible major, selects a registered payload schema, and validates the payload before returning it. The default maximum is 1 MiB. File messages use a 256 KiB encoded-frame ceiling and preserve chunk data as `Uint8Array`.

Unknown messages are rejected by default with `PROTOCOL_MESSAGE_UNKNOWN`. `decodeProtocolMessage` has an explicit `unknownMessage: 'ignore'` mode for future optional-message channels. Lifecycle and authorization callers must keep the default reject behavior.

## Capabilities

The known capability names are:

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
diagnostics
tabAudio
```

Wire capability lists accept strings so a newer peer can advertise names an older peer does not
know. `normalizeCapabilities` removes unknown and duplicate names and returns known capabilities in
canonical order. Unknown names never grant behavior. Core checks both the Session allow-list and
current negotiated Viewer capabilities before each capability-gated side effect, including
local-open delivery.

## Message registry

The registry now covers handshake, lifecycle and the Phase 2 control slice:

```text
hello
hello.accepted
hello.rejected
session.state
session.suspend
session.resume
input.pointer
input.key
input.composition
navigation.request
navigation.result
navigation.local_open_request
navigation.local_open_result
file.upload.request
file.upload.offer
file.upload.accept
file.upload.chunk
file.upload.complete
file.upload.cancel
file.upload.result
file.download.offer
file.download.accept
file.download.chunk
file.download.complete
file.download.cancel
file.download.result
clipboard.write.offer
clipboard.write.accept
clipboard.write.chunk
clipboard.write.complete
clipboard.write.result
clipboard.read.request
clipboard.read.offer
clipboard.read.accept
clipboard.read.chunk
clipboard.read.complete
clipboard.read.result
page.lifecycle
viewport.request
viewport.ack
quality.request
quality.ack
notice
error
```

Download, clipboard, Page Script lifecycle and Notice messages were added with their owning Phase 4
vertical slices and use the same runtime schema registry. Clipboard and file chunk payloads remain
MessagePack binary values on the ordered `file-transfer` DataChannel; `page.lifecycle` remains a
small structured message on `control-reliable`.

## Error contract

`RemoteTabError` carries a stable code, safe message, retry classification and optional redacted details. Phase 1 defines the representative runtime errors from the embedding design and protocol-specific errors for size, decode, schema, type, version and state failures.

Errors constructed from untrusted input must not place URLs, file content, SDP, credentials, CDP endpoints or runtime secrets into `message` or `details`.

## Core contracts

`AttachSessionInput` accepts only already-authorized resources: a trusted CDP endpoint,
create-or-adopt tab request, capabilities, explicit Gateway assignment, Session storage, optional
Page Script source/context, Embedder hooks and a Viewer ticket issuer.

The storage interface reserves quota before writing, exposes a runtime-local path for CDP file operations, commits atomically, supports abort, and cleans all files for one Session. It does not write into the Chrome Profile.

The state machine begins at `ATTACHING`; `CLOSED` and `FAILED` are terminal. Invalid transitions throw `ILLEGAL_STATE_TRANSITION` without changing state. An attaching or negotiating Session can be closed because Embedder cancellation must not strand resources.

`RemoteTabCore` takes one already-started `ExtensionLoopbackServer`. The loopback server may contain
one legacy Extension runtime or multiple `runtimeInstanceId`-identified Chrome runtime pairs.
`attachSession` creates or adopts the requested CDP target, requires exactly one service-worker
runtime to resolve the trusted `tabId`, pins the Session to that runtime before signaling can begin,
applies the initial viewport and enters `READY`. Every capture, media and binary-control operation
then follows that mapping. Ticket issuance
starts the assigned Core signaling binding without delaying ticket delivery; when the Viewer pairs,
Core prepares capture, starts Extension media, relays only SDP/ICE and processes MessagePack control
against the owning CDP controller.

`getRuntimeStatus()` preserves the original single-runtime diagnostic surface and returns the first
coherent runtime when several are present. `getRuntimeStatuses()` exposes every connected runtime for
multi-Chrome diagnostics. `releaseSession()` and `releaseTarget()` remove routing state during normal
or failed attachment cleanup, after Chrome target and Session storage cleanup succeeds. Failed
cleanup retains ownership for `RemoteTabCore.closeSession(sessionId, reason, options?)` retries;
see the [close contract](03-embedding-api.md#session-close-completion).

The returned `RemoteTabSession.getAttachment()` exposes the read-only `targetId`/`tabId` pair that
Core already resolved through CDP and the authenticated Extension. It exists for trusted Embedder
diagnostics and reconciliation; it is not a mutation API and no Viewer message can provide either
identifier.

## Extension Page Script events

The extension contract exports exactly these MAIN-world event names:

```text
browshare:on_document_start
browshare:on_dom_content_loaded
browshare:on_load
browshare:on_location_changed
browshare:on_session_attached
browshare:on_session_detached
```

Core executes the Embedder-provided source in the top-level MAIN world before it installs and emits
these events on both `document` and `window`. Headless Client and Viewer receive the corresponding
`page.lifecycle` messages. BrowShare owns the administrator code editor, draft/publish/version
history, applicability and execution policy.

## Verification

Run the Phase 1 gate from the repository root:

```bash
pnpm check
```

This performs strict TypeScript checking for every workspace, Vitest unit tests, topological tsdown builds and publint checks for all six publishable packages.

The check includes an HTTP/WebSocket integration fixture covering target mapping, capture preparation, Core signaling, offer/answer forwarding, control handshake, pointer input, navigation authorization, suspension and cleanup. Real Google Chrome Stable, Extension policy, actual WebRTC media and Gate 0 evidence begin in later phases and are not implied by this command.
