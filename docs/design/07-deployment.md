# Deployment and diagnostics

## Deployment modes

### Embedded

An application imports Core into its trusted Worker or server process. The application supplies:

- An already running, supported Google Chrome Stable CDP endpoint.
- Extension loopback configuration and runtime secret.
- Session authorization and capability decisions.
- Temporary storage.
- A Signaling Gateway assignment and ticket issuer.
- Lifecycle callbacks.

This mode avoids an additional daemon. BrowShare Worker uses it.

### Standalone

The standalone daemon wraps the same Core and connects to Chrome configured by the operator. It exposes a local or mutually authenticated Embedder API, health endpoints, structured logs and diagnostics.

Standalone does not install, launch, stop, update or configure Chrome. Repository tools can generate extension signing material, enterprise-policy templates and example service configuration, but the operator applies them.

### Reference Compose deployment

The optional Linux `amd64` Compose deployment packages a pinned Google Chrome Stable, the signed
Extension and Standalone in one `chrome-node` image. This is an operator-facing deployment wrapper,
not browser lifecycle logic in Core or the Standalone API. An all-in-one project and independently
deployable Gateway and Chrome-node projects are documented in
[Compose deployment](17-compose-deployment.md).

The examples use Linux host networking to preserve the loopback boundary for CDP, Extension
loopback, the Standalone API, metrics and the local Extension update server. They are not a
production topology for Docker Desktop. Only the Signaling Gateway binds publicly by default.

## Runtime requirements

- A published compatible Google Chrome Stable build.
- Signed fixed-ID Remote Tab Extension installed through Managed Policy or an equivalent controlled mechanism.
- The Extension ID passed to Chrome with `--allowlisted-extension-id=<extension-id>` so unattended
  tab capture does not depend on a toolbar click.
- Chrome's own sandbox enabled. The reference Linux Compose deployment uses a deny-by-default
  seccomp profile that permits its namespace setup without `SYS_ADMIN`, `privileged` or unconfined
  seccomp.
- CDP bound to loopback or private IPC.
- Core loopback endpoint inaccessible from webpages and public networks.
- Network access from Core and Viewer to the assigned Gateway.
- Direct ICE or at least one working TURN route.
- Session-scoped temporary storage outside Chrome Profile data.
- A private absolute download spool at `<temp-root>/.browser-downloads`, writable by Chrome and Core.

Official release diagnostics fail before accepting a Session when a required capability is absent.

The allowlist and sandbox configuration belong to the operator-managed Chrome service. Standalone
and Core may report a missing capability, but Remote Tab does not add flags by launching or replacing
Chrome. The optional Compose wrapper is the explicit exception because it owns its own child Chrome;
it launches Google Chrome Stable as a nonroot user with the sandbox enabled.

## Extension artifacts

Each release publishes:

- Signed CRX.
- Public extension ID.
- Update manifest.
- Version and checksum metadata.
- Chrome Managed Policy template.
- Self-signing tool for third-party IDs.
- Capability-probe command.

The official private key remains in release CI secrets. Self-signing creates a different extension ID, so operators must regenerate matching policy and startup configuration.

The signing input is the verified output directory `packages/extension/build/chrome`, never the
static source template under `packages/extension/extension`. The signing tool rejects an artifact
that is missing the built service worker, offscreen runtime or bundled loopback module before it can
publish an unloadable CRX.

## Gateway and TURN

Gateway is deployed as a separate public service. It can run next to the Embedder or independently. Multiple instances have explicit IDs and endpoints; the Embedder assigns both peers to one instance per Session.

The repository provides a coturn deployment example with 3478 UDP/TCP, 5349 TLS, a bounded relay range and REST credentials. Production operators must configure certificates, public/private address mapping and firewall rules for their network.

## Configuration

Configuration is validated at process start. Unknown or malformed required values fail fast.

| Category | Examples |
| --- | --- |
| Core | CDP endpoint, loopback bind, extension ID, temp root |
| Gateway | public endpoint, ticket verifier, pairing timeout, limits |
| TURN | ICE URLs, REST secret/provider, credential lifetime |
| Standalone | Embedder bind/authentication, allowed origins, session limits |
| Diagnostics | output detail, redaction, probe timeout |

Secrets come from environment variables or read-only files and never appear in diagnostic output. Public endpoints and allowed origins are explicit; permissive wildcard origins are not the default.

## Health endpoints

- **Liveness:** process event loop and server respond.
- **Readiness:** required configuration is valid and dependencies needed for new Sessions are reachable.
- **Capability:** real Chrome/Extension/CDP checks, cached for a short interval and rerun on runtime changes.

Gateway readiness does not depend on a specific Viewer. Core readiness does not promise a target website is reachable.

## Gateway deployment baseline

Production exposes only a TLS-terminated `wss:` Gateway endpoint. The Core-facing and Viewer-facing
connections for one explicit Gateway assignment must reach the same in-memory Gateway process;
load balancing by arbitrary request round-robin cannot pair them. CDP, Extension loopback,
Standalone API and metrics collectors remain on loopback or a private service network.

Gateway protects itself with five independent bounds:

| Bound | Default | Rejection behavior |
| --- | ---: | --- |
| Active WebSockets | 20,000 | Close new connection with WebSocket `1013` |
| Active WebSockets from one immediate IP | 128 | Close new connection with WebSocket `1013` |
| Tracked Session-generation pairs | 10,000 | Retryable signaling pair-capacity error |
| Messages per connection per 60 seconds | 1,200 | Close the connection with WebSocket `1008` |
| Unexpired consumed Ticket replay entries | 100,000 | Retryable signaling pair-capacity error |

The address limit uses the TCP peer address and deliberately ignores `X-Forwarded-For`. When a
reverse proxy hides all clients behind one address, configure that ceiling for the proxy's expected
aggregate or use an L4 path that preserves source addresses. Do not trust a forwarded header without
an explicit trusted-proxy design.

The process emits a bounded `capacity.snapshot` JSON record every 30 seconds. It reports active and
accepted/rejected connections, received message and byte totals, relayed messages, rate-limited
connections, bound peers, tracked/completed/expired pairs, replay entries and configured ceilings.
It contains no Session ID, IP address, URL, SDP, ICE address or credential. Operators should first
measure an expected workload, then lower or raise defaults deliberately; defaults are safety bounds,
not a capacity promise.

## Structured logs

Logs use stable event names and correlation fields such as Session ID, Viewer generation, transfer ID and request ID. They exclude:

- Full sensitive URLs and query strings.
- Page content and titles unless the Embedder explicitly treats them as non-sensitive.
- Clipboard and file content.
- SDP, ICE passwords and TURN credentials.
- CDP WebSocket URLs and runtime secrets.

Verbose protocol frame logging must remain a development-only option and still redact payloads containing user data.

Standalone currently writes `session.diagnostic` events as one JSON object per line. Extension
outbound RTCStats flow through the loopback and Core hook into that stream; Viewer inbound RTCStats
are exposed to the embedding page as `diagnostic` events. These are event streams for logs or an
Embedder-owned collector, not an implicit high-cardinality metrics backend.

## Signaling keepalive

The signaling Gateway sends a native WebSocket ping every 25 seconds to both Core and Viewer
connections. A peer that has not answered with a pong by the next interval is terminated, using the
existing peer-departure lifecycle. Browsers and the Node WebSocket client answer these control frames
automatically; no application signaling message or Viewer timer is required. Gateway shutdown clears
the heartbeat timer. Configure the reverse proxy's WebSocket read timeout above 25 seconds (the
BrowShare ingress uses 75 seconds). Media and input traffic use WebRTC and do not keep an otherwise
idle signaling socket alive.

## Metrics

The Signaling CLI exposes its process-local capacity snapshot as Prometheus text on a dedicated
listener, defaulting to `127.0.0.1:9090`. Standalone exposes fixed lifecycle-state gauges and its
configured Session ceiling at `GET /metrics` on the existing loopback API listener. Both endpoints
are unauthenticated by design and must remain on loopback or a private metrics network.

Metrics use bounded labels. Session IDs, URLs, IP addresses and file names are not metric labels.
The five-second diagnostic sampler still provides redacted media and DataChannel observations to an
Embedder-owned collector; the built-in exporter does not turn per-Session samples into unbounded
Prometheus series.

Scrape configuration, capacity alerts and the incident procedure are defined in
[Operations metrics, alerts and runbook](16-operations-runbook.md). Gateway metrics are also
available through `SignalingGateway.getMetrics()` and periodic `capacity.snapshot` logs for an
embedded deployment that owns its HTTP serving layer.

## Upgrade

Remote Tab packages, Extension and Chrome form a compatibility set. The Embedder pins exact package versions. A release that changes the required Extension or Chrome version declares it prominently.

Upgrade sequence:

1. Stop accepting new Sessions.
2. Let active Sessions finish or close them explicitly.
3. Replace Core/daemon and Extension artifacts as one tested change.
4. Restart the operator-managed Chrome if extension or startup configuration changed.
5. Run capability diagnostics.
6. Resume new Sessions.

Remote Tab does not hot-swap an Extension inside an active capture or promise to preserve PeerConnections across a Core upgrade.

The Compose Chrome-node wrapper generates a new runtime generation on every container start. A
fresh Profile also receives one controlled bootstrap restart after the policy-forced Extension is
installed, so Chrome can load its managed schema before Standalone begins accepting Sessions.
The complete drain, compatibility check, Profile snapshot and full-tuple restore sequence is in
[Coordinated upgrade and rollback](18-upgrade-and-rollback.md).

Chrome may download and install a newer policy-managed CRX while the old service worker and offscreen
document remain active. An installed `Extensions/<id>/<version>` directory is therefore not proof
that the runtime upgraded. Restart Chrome after the update has landed, then require capability
diagnostics to report the intended version for both Extension roles with `coherent: true` before
admitting Sessions.

Standalone owns exactly two children of its configured temp root: `.sessions` for per-Session
uploads and `.browser-downloads` for the Chrome spool. It removes crash residue from both before
accepting work, recreates them with owner-only permissions, and removes them on graceful shutdown.
It does not recursively remove the configured temp root or other Embedder-owned siblings. Neither
private directory may be placed inside a Profile or shared with a different Chrome runtime.

## Restart and reconciliation boundary

The Extension service worker and offscreen document are separate runtime owners. Restarting only
the service worker can leave an active offscreen WebRTC publisher connected; readiness temporarily
drops until the worker rebinds. Losing offscreen is different: existing media Sessions fail closed,
Core closes their CDP targets and Standalone evicts the terminal records. Operators recover
readiness by restoring both Extension roles before admitting new Sessions. Remote Tab does not
promise transparent Viewer recovery across offscreen loss.

If Standalone remains running but an attached main target, flattened CDP Session, or browser-level
CDP WebSocket disappears, Core fails that tracked Session immediately. Standalone removes the
terminal record and releases capacity; `/health/ready` reports CDP unavailable while Chrome is down.
After the operator or Worker restores a coherent Chrome/Extension runtime, readiness returns and the
Embedder may create a new Session, including reuse of the old application Session ID. Remote Tab does
not restart Chrome or claim to preserve the old tab.

Standalone handles `SIGTERM` by closing Core Sessions before its process exits. Deployment managers
must allow that drain to finish. `SIGKILL`, host loss or process corruption cannot execute cleanup:
the new Standalone process starts with no in-memory Sessions while Chrome may still contain orphan
targets. The authenticated `GET /v1/reconciliation/targets` endpoint lists live page Targets and
marks only current in-process ownership as `tracked`; all other Targets are `untracked`. It is
read-only and never closes an unknown tab. The Embedder/Worker must compare the snapshot with
durable application ownership, then explicitly adopt a confirmed surviving Target or close a
confirmed orphan through a trusted administration path. Core prevents two Sessions from attaching
the same Target concurrently.

## Troubleshooting order

1. Confirm exact Core, Extension and Chrome versions.
2. Run the local capability probe.
3. Confirm CDP and loopback endpoints are not public.
4. Verify Viewer and Core reach the assigned Gateway.
5. Inspect ICE candidate type and force TURN for a relay test.
6. Check actual viewport acknowledgement before investigating pointer mismatch.
7. Check Viewer generation before investigating ignored input.
8. Check flattened `Page.downloadWillBegin` ownership, the GUID spool, transfer quota, and Viewer
   acknowledgement before investigating download failures.
9. Compare `session.state` terminal reasons with `/health/ready` before deciding whether a single
   target, CDP attachment, or the whole Chrome runtime disappeared.
10. After an ungraceful Standalone restart, compare durable ownership with
    `/v1/reconciliation/targets`; do not treat every `untracked` Target as disposable.

This order separates runtime, signaling, network, input and file faults instead of masking them with retries.
