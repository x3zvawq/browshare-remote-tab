# Phase 4 browser I/O status

## Scope

Phase 4 connects browser-owned interactions that cannot be represented as ordinary pointer,
keyboard, or navigation commands. Upload, download, child-target/local-open, and Notice now have
complete runtime and real-browser slices. Text and PNG clipboard transfer and fixed Page Script
lifecycle delivery are also complete.

## Upload ownership

```text
Remote page file input
  → CDP Page.fileChooserOpened
  → Core expiring chooser request
  → Extension file-transfer DataChannel
  → Headless Client / Viewer local selection
  → descriptor offer and quota reservation
  → contiguous MessagePack binary chunks
  → storage commit
  → CDP DOM.setFileInputFiles
  → remote page change event
```

Viewer owns every local prompt, selection, progress indicator, and cancel action. Portal and Gateway
do not receive file metadata or bytes. Core owns authorization, limits, storage, the intercepted
`backendNodeId`, and final CDP delivery. Extension routes file frames but does not inspect or persist
file content.

## Implemented contracts

- Protocol validates all seven upload message types and enforces a dedicated encoded-frame limit.
- Core enables file chooser interception on attachment and accepts one chooser/transfer at a time.
- Storage is reserved before acceptance; partial reservations abort together.
- File IDs are unique within an offer and offsets must be contiguous.
- File names remove control characters and path separators; empty, `.` and `..` names become `file`.
- Standalone stores the normalized basename below an encoded transfer directory, preserving the name
  exposed by Google Chrome without permitting path traversal.
- Headless Client accepts `File`, `Blob`, `ArrayBuffer`, or `Uint8Array` data and applies buffered
  amount backpressure while chunking.
- Default Viewer renders a local single/multiple picker, progress bar, cancel action, and failures in
  Chinese or English. It closes stale UI on Core cancellation.
- Disconnect, Viewer replacement, capability revocation, timeout, malformed input, and Session close
  clean active transfer state.

## Default limits

| Limit | Default |
| --- | ---: |
| Files per chooser | 32 |
| Bytes per file | 512 MiB |
| Bytes per batch | 1 GiB |
| Chunk payload | 64 KiB |
| Request and inactivity timeout | 120 seconds |
| Viewer buffered high water | 1 MiB |
| Viewer buffered low water | 256 KiB |

Embedders configure positive integer Core limits per Session. Viewer cannot raise the negotiated
chunk ceiling or bypass Core limits.

## Failure semantics

An offer rejected before acceptance returns `file.upload.result` with a stable error and consumes the
chooser request. A transfer failure aborts all reservations and returns one failed result. Successful
delivery resolves only after storage commit and `DOM.setFileInputFiles`. Files remain Session-scoped
until Session cleanup because Google Chrome may read them after the CDP command returns.

The default Viewer shows transport failure and leaves a close action; it never silently reopens a
local file picker because the original remote chooser has already been consumed.

## Verification

Automated coverage includes:

- Protocol round trips, binary preservation, malformed binary rejection, and frame size limits.
- CDP file chooser events and `DOM.setFileInputFiles` translation.
- Core success with zero-byte files, malicious names, storage reservations, contiguous chunks, and
  delivery; invalid offset aborts without committing.
- Headless Client offer, negotiated chunking, progress, completion, cancel, channel close, and
  disconnect behavior.
- Default Viewer single/multiple mode, file selection, progress, user cancel, Core cancel, and success
  close behavior in a real DOM implementation.
- Standalone exact-size, zero-byte, post-commit abort, confined name, and Session cleanup semantics.

The real compatibility run on 2026-09-04 used Google Chrome Stable `152.0.7977.75` on Ubuntu 24.04,
signed managed Extension `0.1.10`, and a macOS in-app Chrome Viewer. It uploaded 37 bytes, observed
the exact content and `client-proof.txt` in the remote page, cancelled a second chooser without a
second change event, then verified zero Session temporary files and targets after cleanup.

## Download ownership

```text
Remote page starts a download
  → owning flattened CDP Session receives Page.downloadWillBegin
  → Core records GUID and normalized suggested filename in that Session
  → Chrome writes GUID into the runtime-wide allowAndName spool
  → owning CDP Session receives Page.downloadProgress completed
  → Core verifies the file and applies Session limits
  → Viewer receives an expiring offer
  → accept, acknowledged 64 KiB chunks, complete, Viewer result
  → Core removes the GUID file
```

`chrome.downloads.DownloadItem` has no reliable source `tabId`; Extension therefore cannot safely
attribute a browser-global download. The ownership boundary is the CDP Session that received
`Page.downloadWillBegin`. GUID state never moves between Sessions, and a Session refuses to open a
GUID it did not record.

Core configures one absolute spool using `Browser.setDownloadBehavior` with `allowAndName`. This
keeps Chrome filenames opaque and prevents suggested names from selecting host paths. Standalone
places the spool at `<temp-root>/.browser-downloads`, recreates it with mode `0700` after clearing
crash residue, and removes it during graceful shutdown or failed startup.

After Chrome completes a file, Core checks that it is regular, within the per-file limit, and still
owned by an active download-capable Session. Headless Client accepts or rejects the offer. Accepted
chunks require contiguous offsets and cannot exceed the declared size; Blob assembly must exactly
match the descriptor before the client returns `received: true`. Extension applies file-channel
buffer backpressure and waits for a loopback acknowledgement after every chunk. Rejection, timeout,
Viewer replacement, media-runtime loss, capability revocation, Session close, and protocol failure
all cancel state and remove the spool file.

Default Viewer owns the user interaction. It shows the normalized name and formatted size, changes
to live receive progress after confirmation, assembles the Blob, and saves through a temporary
object URL. Both `download-request` and `download-complete` are cancelable element events so an
Embedder may replace the confirmation or storage behavior. Portal and Gateway never handle this UI
or receive file bytes.

### Download verification

The 2026-09-04 real compatibility run used Google Chrome Stable `152.0.7977.75`, signed managed
Extension `0.1.12`, current Standalone/Core builds on Ubuntu 24.04, and a macOS in-app Viewer.
Two Sessions initiated different 2,097,152-byte files concurrently. Each Headless Client observed
32 chunks, a distinct transfer ID and its own filename; both assembled Blob payloads matched their
per-Session expected bytes exactly. A second download in Session A was rejected and emitted
`download-cancelled`. Closing both Sessions left zero spool files.

A separate default-Viewer run displayed the Chinese `保存远程下载？` dialog with the exact filename
and `2 MB` size, rendered progressive receive state after confirmation, verified all bytes, invoked
the default local save path, and produced Core `download.delivered`. The spool again contained zero
files.

The deployment portion exposed an upgrade boundary: Chrome downloaded and installed `0.1.12` while
its active service-worker and media roles remained at `0.1.11`. A second Chrome restart loaded
`0.1.12`; Standalone then reported both roles at `0.1.12` and `coherent: true`. Release checks must
inspect active-role diagnostics rather than treating an installed Extension directory as proof.

## Clipboard ownership

```text
Explicit Viewer click
  → local Clipboard API or manual text fallback
  → descriptor offer and capability/limit validation
  → contiguous binary chunks on file-transfer
  → runtime-global Core clipboard queue
  → owning tab activated and origin permission granted temporarily
  → page Clipboard API with userGesture
  → remote paste or data returned to Viewer
```

The Viewer owns the local user gesture and permission UI. Portal, Gateway and Signaling never see
clipboard metadata or bytes. Headless Client exposes `writeRemoteClipboard()` and
`readRemoteClipboard()` for custom Embedders, which must provide the same explicit-action boundary.
The default Viewer exposes “Paste to remote” and “Copy from remote” controls only when
`clipboardText` or `clipboardImage` was negotiated.

Clipboard data is one `text/plain` item, one `image/png` item, or both. Items are independently
capability-gated and have unique IDs and MIME types. Limits are 16 MiB per item, 24 MiB per
operation, 64 KiB chunks, and 120 seconds of inactivity. The eleven message types use
offer/accept/chunk/complete/result flows and the ordered `file-transfer` DataChannel. Both endpoints
validate descriptors, continuous offsets and exact final sizes. Disconnect, Viewer replacement,
generation change, channel close and Session cleanup reject pending promises and discard buffers.

The host clipboard is shared by every tab in one Google Chrome runtime, so Core serializes complete
clipboard operations across all Sessions. It calls `Page.bringToFront`, verifies a secure non-opaque
origin, temporarily grants the exact `clipboard-read` or `clipboard-write` PermissionDescriptor,
and passes `userGesture: true` to `Runtime.evaluate`. A local-to-remote operation writes the Chrome
clipboard and sends Ctrl+V only while it owns that queue slot. The permission returns to `prompt`
even on failure. Briefly activating the owning tab is a documented side effect.

When the local browser rejects Clipboard API access, the Viewer does not retry invisibly. For paste,
it offers an editable text field and an explicit “Send to remote” action. For copy, it exposes
remote text in a selected read-only field. If rejected content includes only an image, or text plus
an image, the dialog explains that image transfer needs clipboard permission. Cancelable
`clipboard-write-request`, `clipboard-read-request`, and `clipboard-read-complete` events let the
host replace the defaults. Progress and completion remain element-local typed events.

### Clipboard verification

The 2026-09-04 compatibility run used Google Chrome Stable `152.0.7977.75`, signed managed
Extension `0.1.13`, Standalone/Core on Ubuntu 24.04 and a macOS in-app Viewer. Both active Extension
roles reported `0.1.13` and `coherent: true` after the required restart.

Two simultaneous Sessions wrote distinct text values and each remote page received only its own
value. Session A then pasted text plus a 107-byte 4×4 PNG while Session B received neither item.
Remote-to-local read returned the exact text and a 4×4 image whose decoded pixels matched the source.
The PNG assertion intentionally compared dimensions and pixels because Chrome decodes and
re-encodes clipboard images.

The default Viewer passed local text paste, remote copy, simulated `NotAllowedError` manual paste,
manual copy with explicit image-denial feedback, and a host-cancelled
`clipboard-write-request`. The run also identified and fixed three Chrome 152 requirements:
PermissionDescriptor aliases are invalid, the page must be focused with `Page.bringToFront`, and
`Runtime.evaluate` needs `userGesture: true`. Final cleanup left zero Standalone Sessions, and the
source passed workspace typecheck, build and package export checks.

## Page Script lifecycle ownership

```text
Embedder-authorized source and JSON context
  → Core validates 512 KiB / 64 KiB limits
  → top-level MAIN-world source runs on every document
  → fixed bootstrap dispatches document and window CustomEvents
  → Runtime binding returns lifecycle metadata to Core
  → Extension reliable DataChannel transport
  → Headless Client page-script-event
  → Viewer host event without default UI
```

The administrator source runs before the bootstrap so it can register listeners for the initial
events. The bootstrap emits document start, Session attached, initial location, DOMContentLoaded and
load for each complete top-level document. It wraps `pushState` and `replaceState`, listens to
`popstate` and `hashchange`, and checks BFCache `pageshow` so SPA location changes are visible without
polling. Full navigation installs a fresh document instance but does not emit Session detached;
Core explicitly emits that event once during actual Session close and permits it through the
`CLOSING` state before media teardown.

Each remote CustomEvent carries frozen `{ sessionId, occurredAt, location?, context? }` detail. The
Viewer-facing `page.lifecycle` payload deliberately omits business context and carries only the fixed
name, time and optional location inside the normal Session/generation envelope. Administrator syntax
or runtime errors become redacted diagnostics. A syntax failure skips only the administrator source;
the bootstrap remains installed. A runtime failure is caught locally. Neither can fail the Session or
change navigation authorization.

### Page Script verification

The 2026-09-04 compatibility run used Google Chrome Stable `152.0.7977.75`, signed managed
Extension `0.1.14`, Standalone/Core on Ubuntu 24.04 and a macOS in-app Viewer. The page observed all
five initial events exactly once on both `document` and `window`, with expected context, and proved
MAIN-world access alongside its own JavaScript. SPA and full navigation re-fired the appropriate
lifecycle. Viewer received location and final Session-detached events. Throwing and syntactically
invalid sources left the Viewer connected and fixed events available while producing the expected
`page-script.error` diagnostics. Final cleanup left zero Sessions and matching targets.

## Child target and local open ownership

The default policy keeps the remote runtime at one tab while preserving an explicit user choice:

```text
page MAIN-world window.open
  → Runtime binding, without creating a child target
  → Core HTTP/HTTPS normalization
  → Embedder navigation authorization
  → Session- and generation-bound request
  → Viewer “Open on this device?” dialog
  → local browser window.open with noopener,noreferrer
```

`window.open()` with `_self`, `_parent`, or `_top` keeps native same-context semantics. A new-context
call returns `null`, so a page that depends on a returned `WindowProxy` is a known compatibility
limit. `retain` skips the wrapper and preserves reliably attributed remote children for maintenance.
Declarative or browser-created children remain covered by CDP `Page.windowOpen`,
`Target.targetCreated`, and `openerId`; normal Sessions serialize their closure after the current
input operation and then run the same authorization/request flow.

The first real approach closed a newly created target directly. Chrome kept the opener's synchronous
click listener blocked and timed out `Input.dispatchMouseEvent`, even with close delays through one
second. The final `0.1.11` run intercepted before target creation: the remote listener completed,
Viewer cancel opened nothing, Viewer approval opened only the local URL, the server stayed at one
parent and zero child targets, and no CDP timeout occurred.

## Structured Notice

Core exposes `sendNotice({ level, code, message })`; Standalone exposes the same validated payload at
`POST /v1/sessions/{sessionId}/notices`. It is a one-way text-only message over
`control-reliable`. Headless Client emits the structure, and Viewer first emits a cancelable
`notice` event before rendering its dismissible default toast. A real `0.1.11` run observed the
complete Standalone-to-Viewer path.

Viewer's separate `error` event is intentionally non-bubbling. Hosts register it directly on the
custom element, preventing a typed component failure from being mistaken for an uncaught global
browser error.

## Phase result

Phase 4 is complete. BrowShare, not Remote Tab, stores administrator JavaScript, versions,
applicability and publication policy. Durable daemon crash reconciliation, the full Gate 0 rerun and
release hardening remain later phases.
