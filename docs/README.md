# Documentation

Remote Tab provides the reusable capture, transport and browser-control layer. Pick the guide that
matches how you want to run or embed it.

## Start here

| Task | Guide |
| --- | --- |
| Build the source and deploy a complete Linux host | [Getting started](getting-started.md) |
| Add the default Viewer to a web application | [Viewer integration](getting-started.md#use-the-viewer-in-your-application) |
| Embed Core or build a custom browser client | [Embedding API](design/03-embedding-api.md) |
| Use the Standalone HTTP API | [Standalone daemon and API](design/12-standalone-api.md) |
| Configure signaling, TLS and TURN | [Signaling and ICE](design/06-signaling-and-ice.md), [Compose deployment](design/17-compose-deployment.md) |
| Operate, diagnose or upgrade a deployment | [Operations runbook](design/16-operations-runbook.md), [Upgrade and rollback](design/18-upgrade-and-rollback.md) |
| Contribute or report a security issue | [Contributing](CONTRIBUTING.md), [Security policy](SECURITY.md) |

## Components and boundaries

- **Core and Extension** bind a Session to Chrome targets, capture media and apply browser actions.
- **Viewer and Headless Client** receive media and implement browser-facing interaction.
- **Signaling Gateway** authenticates pairing and forwards signaling; media and files use WebRTC.
- **Standalone** wraps Core behind a loopback API. The embedding application owns Chrome lifecycle,
  persistent Profile data and business authorization.

[Architecture](design/02-architecture.md) explains the component boundaries, and
[the compatibility manifest](../deploy/compatibility.json) records the coordinated runtime set.

## Design and reference index

The numbered design documents include current contracts and dated implementation or acceptance
records. Use their stated version and scope when interpreting historical evidence.

- [Implementation progress](../PROGRESS.md)
- [Agent guide](../AGENTS.md)
- [Viewer design system](DESIGN.md)
- [Scope and use cases](design/01-scope.md)
- [Architecture](design/02-architecture.md)
- [Embedding API](design/03-embedding-api.md)
- [Control protocol](design/04-control-protocol.md)
- [Chrome extension and Core](design/05-extension-and-core.md)
- [Signaling, ICE, and TURN](design/06-signaling-and-ice.md)
- [Deployment and diagnostics](design/07-deployment.md)
- [Testing and compatibility](design/08-testing.md)
- [Implementation plan](design/09-implementation-plan.md)
- [Phase 1 package contracts](design/10-package-contracts.md)
- [Phase 2 vertical-slice status](design/11-phase-2-vertical-slice.md)
- [Standalone daemon and API](design/12-standalone-api.md)
- [Phase 3 lifecycle status](design/13-phase-3-lifecycle.md)
- [Phase 4 browser I/O status](design/14-phase-4-browser-io.md)
- [Gate 0 and first public API freeze](design/15-gate-0-and-api-freeze.md)
- [Operations metrics, alerts and runbook](design/16-operations-runbook.md)
- [Compose deployment](design/17-compose-deployment.md)
- [Coordinated upgrade and rollback](design/18-upgrade-and-rollback.md)
- [CI and release-candidate gates](design/19-ci-and-release-gates.md)
- [Supply-chain artifacts and provenance](design/20-supply-chain-artifacts.md)
- [Release-candidate security review](design/21-release-candidate-security-review.md)
- [First stable release and installation](design/22-first-stable-release.md)
- [First stable release candidate record](design/23-first-stable-release-candidate.md)
- [Third-party notices](../THIRD_PARTY_NOTICES.md)
