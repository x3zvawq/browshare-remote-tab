# BrowShare Remote Tab agent guide

Deliver the smallest complete change for the requested outcome, grounded in the actual callers, implementation and supported runtime.

## Mission and ownership

Remote Tab exposes one Google Chrome tab as an embeddable web session. The Extension captures media, WebRTC transports it, and Core uses CDP for input and browser actions. This repository is the reusable engine; BrowShare Worker is one Embedder.

- Own Session-to-`tabId`/`targetId` binding, capture, media, input, IME, navigation, files, clipboard, downloads, Notice, Viewer and Headless Client state machines, signaling, ICE, standalone wrappers, extension packaging/signing and diagnostics.
- The Embedder owns users, authorization policy, billing, audit policy, Profile storage, proxy, Chrome installation/process lifecycle, scheduling, and application URL policy/Page Scripts. Remote Tab carries validated hook decisions and events without importing these business models.
- Standalone wraps the same Core. Core connects to an already running, supported Chrome; it does not install or manage Chrome.

## Read by task

- Use [README](README.md) for entry points and [PROGRESS.md](PROGRESS.md) for delivery status; read only the relevant entries and evidence.
- Consult the relevant topic in [the design index](README.md) and the owning package's README, exports, schemas and callers. Use [DESIGN.md](docs/DESIGN.md) for Viewer UI and [the API freeze](docs/design/15-gate-0-and-api-freeze.md) for public contract changes.
- Design documents define intended contracts, source/tests establish current behavior, and progress records delivery. Resolve relevant discrepancies explicitly. Phase plans are not instructions to restart completed work; historical test results are not fresh verification.
- Inspect BrowShare consumers when a change crosses the embedding boundary. Locate the actual checkout rather than assuming a sibling is always available. Ignored `tmp/` material may inform investigation but is not a public interface or distributed release evidence.

## Engineering constraints

- TypeScript, pnpm workspace, strict compiler settings and tsdown packages. Public browser APIs remain framework-agnostic Web Component and Headless Client APIs.
- Control messages use runtime schemas and stable error codes. Media and files never traverse Gateway; CDP and Extension loopback endpoints never bind publicly.
- One active Viewer per Session; reject old peer input after takeover. Pointer coordinates use the acknowledged remote viewport, not decoded frame size. DataChannels retain their distinct reliability requirements.
- Chrome, the signed fixed-ID Extension, Core and protocols form a tested compatibility set. Capability probes determine runtime usability; unsupported combinations fail with actionable errors rather than silent fallback.
- Production documentation says “Google Chrome Stable” or “Chrome”; use “Chromium” for upstream implementation details. Chrome for Testing may support development probes but does not replace production-runtime evidence.
- Do not commit extension private keys, Profile data, cookies, TURN secrets or recordings. Preserve existing uncommitted work.

## Collaboration and completion

- Treat a request to change or fix something as authorization to perform the work within scope. Carry existing authorization forward. Resolve low-risk ambiguity with a stated assumption; ask only when missing information materially affects correctness or scope, while completing independent work first.
- Incorporate user corrections without losing the original goal or completed work unless the user explicitly cancels or replaces the task.
- Current user instructions take precedence over general guidance here and in Skills, subject to higher-priority rules. If an instruction blocks progress, cite its exact file and wording and identify the affected action; do not invent an approval requirement.
- Prepare a concrete, reviewable result before requesting any required approval for publication, deployment or destructive actions. Do not treat ordinary local edits as a release request.
- Reuse existing patterns and fix supported, reachable failures. Update affected contracts, callers and necessary tests together. Preserve the [frozen compatibility boundary](docs/design/15-gate-0-and-api-freeze.md); avoid speculative wrappers, fallback paths or business features.
- Choose verification using [Testing and compatibility](docs/design/08-testing.md). Stop after relevant checks pass and material issues are resolved; required release gates still apply to releases.
- Report the outcome, reason, scope, checks actually run and remaining limitations concisely. Distinguish local tests from real Chrome evidence and source readiness from external publication.
