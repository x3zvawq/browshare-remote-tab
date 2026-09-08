# Standalone daemon and API

> [!IMPORTANT]
> Standalone connects to an operator-managed Google Chrome Stable runtime. It does not install,
> launch, stop, update or configure Chrome. The first implementation binds the Embedder API only to
> `127.0.0.1` or `::1`; exposing it through an mTLS transport is Phase 6 work.

## Run one Session

Build the repository once:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

Start a public Signaling Gateway. Replace all example secrets and use `wss:` in production:

```bash
export BROWSHARE_REMOTE_TAB_GATEWAY_ID='gateway-1'
export BROWSHARE_REMOTE_TAB_GATEWAY_PUBLIC_ENDPOINT='ws://signal.example.test:8081'
export BROWSHARE_REMOTE_TAB_VIEWER_TICKET_SECRET='replace-with-at-least-32-bytes-ticket-secret'
export BROWSHARE_REMOTE_TAB_CORE_BINDING_TOKEN='replace-with-at-least-32-bytes-binding-token'
export BROWSHARE_REMOTE_TAB_ICE_SERVERS_JSON='[]'
export BROWSHARE_REMOTE_TAB_ICE_TRANSPORT_POLICY='all'
pnpm --filter @browshare/remote-tab-signaling start
```

`BROWSHARE_REMOTE_TAB_ICE_SERVERS_JSON` accepts standard WebRTC ICE server objects. An empty list is
appropriate only when direct host candidates are known to work. Production deployments normally
include short-lived TURN credentials supplied by a deployment adapter; the static CLI configuration
is intended for a single controlled deployment and initial integration.

On the Chrome host, apply the matching Extension managed policy, start the operator-managed Chrome,
and then start Standalone:

```bash
export BROWSHARE_REMOTE_TAB_CDP_ENDPOINT='http://127.0.0.1:9222'
export BROWSHARE_REMOTE_TAB_API_TOKEN='replace-with-at-least-32-bytes-api-token'
export BROWSHARE_REMOTE_TAB_EXTENSION_ID='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
export BROWSHARE_REMOTE_TAB_RUNTIME_SECRET='replace-with-the-managed-policy-runtime-secret'
export BROWSHARE_REMOTE_TAB_RUNTIME_GENERATION='worker-start-20260903-1'
export BROWSHARE_REMOTE_TAB_VIEWER_TICKET_SECRET='replace-with-at-least-32-bytes-ticket-secret'
export BROWSHARE_REMOTE_TAB_TEMP_ROOT='/var/lib/browshare-remote-tab/sessions'
pnpm --filter @browshare/remote-tab-standalone start
```

The runtime secret, runtime generation and Extension ID must exactly match the values in Chrome
managed policy. The Viewer Ticket secret, issuer and audience must exactly match the Gateway.
Standalone creates an owner-only download spool at
`$BROWSHARE_REMOTE_TAB_TEMP_ROOT/.browser-downloads`; Chrome and Standalone must run with access to
that same absolute path. It is deliberately separate from per-Session upload storage and every
Chrome Profile.

Create a Session through the loopback API:

```bash
curl --fail-with-body \
  -H 'Authorization: Bearer replace-with-at-least-32-bytes-api-token' \
  -H 'Content-Type: application/json' \
  --data '{
    "sessionId": "demo-1",
    "tab": {"mode": "create", "initialUrl": "https://example.com/"},
    "capabilities": ["navigation", "backForward", "reload", "fullscreen", "tabAudio"],
    "signaling": {
      "gatewayId": "gateway-1",
      "coreEndpoint": "ws://127.0.0.1:8081",
      "viewerEndpoint": "ws://signal.example.test:8081",
      "bindingToken": "replace-with-at-least-32-bytes-binding-token"
    },
    "navigationPolicy": "allow-all",
    "childTargetPolicy": "close-and-local-open",
    "localOpenRequestTimeoutMs": 30000,
    "pageScript": {
      "source": "document.addEventListener('browshare:on_load', (event) => console.info(event.detail))",
      "context": {"profile_id": "demo-profile", "display_name": "Demo user"}
    }
  }' \
  http://127.0.0.1:9230/v1/sessions
```

`navigationPolicy` is mandatory. `allow-all` delegates unrestricted tab navigation to the authorized
API caller; `deny-all` blocks Viewer navigation actions. Application-specific URL policy remains an
Embedder responsibility and should use Core directly until Standalone gains an external policy hook.

`childTargetPolicy` defaults to `close-and-local-open`: ordinary remote `window.open()` calls become
Viewer-local confirmations after navigation authorization. `retain` is intended for a trusted
maintenance Session and preserves remote child targets. `localOpenRequestTimeoutMs` controls how
long a Viewer response remains valid and defaults to 30 seconds.

`pageScript` is optional. `source` is one non-empty JavaScript program up to 512 KiB; `context` must
be a JSON object whose encoded form is at most 64 KiB. Core executes the source in the top-level page
MAIN world before dispatching fixed `browshare:*` lifecycle events. Syntax and runtime errors are
reported through redacted diagnostics without failing the Session. Standalone neither stores nor
versions the source: an Embedder that needs drafts, publication, applicability or rollback owns those
business records and passes the immutable Session snapshot at creation.

`coreEndpoint` is the route from Standalone to the assigned Gateway and may be a private or loopback
address. `viewerEndpoint` is the browser-reachable public route returned with each Ticket. Keeping
them separate avoids requiring a Worker host to hairpin through its own public ingress.

Issue a single-use Viewer Ticket. Standalone allocates the next generation atomically, so callers do
not race on generation numbers:

```bash
curl --fail-with-body \
  -H 'Authorization: Bearer replace-with-at-least-32-bytes-api-token' \
  -H 'Content-Type: application/json' \
  --data '{"expiresInSeconds": 120}' \
  http://127.0.0.1:9230/v1/sessions/demo-1/viewer-tickets
```

Pass only the returned `endpoint` and `ticket` to `@browshare/remote-tab-viewer` or the Headless
Client. Do not place a Ticket in a URL, log, cookie or persistent browser storage.

Core starts pairing when the Ticket is issued. If one pairing attempt times out or loses the Gateway
before a Viewer arrives, Core retries the same Session and generation with bounded backoff until the
Ticket expires. Callers may therefore deliver a Ticket at any point in its stated lifetime; they do
not need to synchronize against the 15-second Core attempt or the Gateway's unmatched-peer timeout.
This does not make a consumed Ticket reusable and does not reconnect a failed Headless Client.

## Configure the processes

### Standalone variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `BROWSHARE_REMOTE_TAB_CDP_ENDPOINT` | Yes | — | Trusted HTTP discovery or browser WebSocket CDP endpoint |
| `BROWSHARE_REMOTE_TAB_API_TOKEN` | Yes | — | Bearer credential for every `/v1` request; minimum 32 bytes |
| `BROWSHARE_REMOTE_TAB_API_HOST` | No | `127.0.0.1` | Embedder API bind; only loopback values are accepted |
| `BROWSHARE_REMOTE_TAB_API_PORT` | No | `9230` | Embedder API port |
| `BROWSHARE_REMOTE_TAB_API_MAX_BODY_BYTES` | No | `262144` | Maximum JSON request size |
| `BROWSHARE_REMOTE_TAB_EXTENSION_HOST` | No | `127.0.0.1` | Extension loopback bind |
| `BROWSHARE_REMOTE_TAB_EXTENSION_PORT` | No | `9224` | Extension loopback port and managed-policy target |
| `BROWSHARE_REMOTE_TAB_EXTENSION_ID` | Yes | — | Fixed 32-character Extension ID |
| `BROWSHARE_REMOTE_TAB_RUNTIME_SECRET` | Yes | — | Per-runtime Extension loopback secret |
| `BROWSHARE_REMOTE_TAB_RUNTIME_GENERATION` | Yes | — | Core/Worker startup generation shared by its managed Chrome runtimes; each Chrome process adds an Extension-generated instance ID |
| `BROWSHARE_REMOTE_TAB_EXTENSION_TIMEOUT_MS` | No | `15000` | Extension request and readiness deadline |
| `BROWSHARE_REMOTE_TAB_VIEWER_TICKET_SECRET` | Yes | — | HMAC secret shared with the assigned Gateway |
| `BROWSHARE_REMOTE_TAB_VIEWER_TICKET_ISSUER` | No | `remote-tab-standalone` | Ticket issuer shared with Gateway |
| `BROWSHARE_REMOTE_TAB_VIEWER_TICKET_AUDIENCE` | No | `remote-tab-viewer` | Ticket audience shared with Gateway |
| `BROWSHARE_REMOTE_TAB_VIEWER_TICKET_MAX_SECONDS` | No | `600` | Maximum lifetime accepted by the Ticket endpoint |
| `BROWSHARE_REMOTE_TAB_TEMP_ROOT` | Yes | — | Private `.sessions` upload subtree plus `.browser-downloads`, both outside Chrome Profile data |
| `BROWSHARE_REMOTE_TAB_MAX_SESSIONS` | No | `16` | Concurrent attached and attaching Session limit |

### Gateway variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `BROWSHARE_REMOTE_TAB_GATEWAY_ID` | Yes | — | Explicit Gateway identity in Core and Ticket bindings |
| `BROWSHARE_REMOTE_TAB_GATEWAY_PUBLIC_ENDPOINT` | Yes | — | Viewer-facing `ws:` or `wss:` URL |
| `BROWSHARE_REMOTE_TAB_GATEWAY_HOST` | No | `0.0.0.0` | WebSocket bind address |
| `BROWSHARE_REMOTE_TAB_GATEWAY_PORT` | No | `8081` | WebSocket port |
| `BROWSHARE_REMOTE_TAB_GATEWAY_PAIRING_TIMEOUT_MS` | No | `30000` | Maximum unmatched peer lifetime |
| `BROWSHARE_REMOTE_TAB_GATEWAY_MAX_MESSAGE_BYTES` | No | `262144` | Signaling message ceiling |
| `BROWSHARE_REMOTE_TAB_GATEWAY_MAX_PENDING_PAIRS` | No | `10000` | Pending pair capacity |
| `BROWSHARE_REMOTE_TAB_GATEWAY_MAX_CONNECTIONS` | No | `20000` | Total accepted WebSocket connection ceiling |
| `BROWSHARE_REMOTE_TAB_GATEWAY_MAX_CONNECTIONS_PER_IP` | No | `128` | Accepted connection ceiling for the immediate peer address |
| `BROWSHARE_REMOTE_TAB_GATEWAY_MESSAGE_RATE_WINDOW_MS` | No | `60000` | Per-connection fixed rate-limit window |
| `BROWSHARE_REMOTE_TAB_GATEWAY_MAX_MESSAGES_PER_WINDOW` | No | `1200` | Messages accepted from one connection during the window |
| `BROWSHARE_REMOTE_TAB_GATEWAY_MAX_CONSUMED_TICKETS` | No | `100000` | In-memory replay-entry ceiling after expired entries are pruned |
| `BROWSHARE_REMOTE_TAB_GATEWAY_METRICS_INTERVAL_MS` | No | `30000` | Structured capacity snapshot interval |
| `BROWSHARE_REMOTE_TAB_GATEWAY_METRICS_HOST` | No | `127.0.0.1` | Private Prometheus and metrics-liveness bind |
| `BROWSHARE_REMOTE_TAB_GATEWAY_METRICS_PORT` | No | `9090` | Private Prometheus and metrics-liveness port |
| `BROWSHARE_REMOTE_TAB_VIEWER_TICKET_SECRET` | Yes | — | Must match Standalone |
| `BROWSHARE_REMOTE_TAB_VIEWER_TICKET_ISSUER` | No | `remote-tab-standalone` | Must match Standalone |
| `BROWSHARE_REMOTE_TAB_VIEWER_TICKET_AUDIENCE` | No | `remote-tab-viewer` | Must match Standalone |
| `BROWSHARE_REMOTE_TAB_CORE_BINDING_TOKEN` | Yes | — | Static CLI Core credential; minimum 32 bytes |
| `BROWSHARE_REMOTE_TAB_ICE_SERVERS_JSON` | No | `[]` | JSON array of validated ICE server objects |
| `BROWSHARE_REMOTE_TAB_ICE_TRANSPORT_POLICY` | No | `all` | Standard WebRTC policy; use `relay` for a forced-TURN Gateway |

## Call the Embedder API

Every `/v1` response uses `Cache-Control: no-store`. Errors have a stable envelope:

```json
{
  "error": {
    "code": "SESSION_NOT_FOUND",
    "message": "Session was not found",
    "retryable": false
  }
}
```

| Method and path | Purpose | Successful result |
| --- | --- | --- |
| `GET /health/live` | Process liveness; no authentication | `200` with `ok` or `closing` |
| `GET /health/ready` | CDP and both Extension-role checks; no authentication | `200` ready, otherwise `503` with individual checks |
| `GET /metrics` | Fixed-state Standalone capacity metrics; no authentication, loopback listener only | Prometheus text |
| `GET /v1/reconciliation/targets` | List live page Targets and correlate current Standalone ownership | `200` |
| `GET /v1/sessions` | List non-sensitive Session summaries | `200` |
| `POST /v1/sessions` | Attach a created or trusted adopted tab | `201` |
| `GET /v1/sessions/{sessionId}` | Read state, trusted attachment identity, generation, capabilities and Gateway assignment | `200` |
| `POST /v1/sessions/{sessionId}/viewer-tickets` | Issue the next single-use Viewer generation | `201` |
| `PUT /v1/sessions/{sessionId}/capabilities` | Reduce or change the Session allow-list | `200` |
| `POST /v1/sessions/{sessionId}/notices` | Send a validated text-only Notice to the active Viewer | `204` |
| `DELETE /v1/sessions/{sessionId}` | Explicitly close the tab and clean Session files | `204` |

Successful creation and single-Session detail responses include the trusted attachment identity:

```json
{
  "sessionId": "session-1",
  "state": "READY",
  "attachment": {
    "targetId": "A1B2C3D4",
    "tabId": 17
  }
}
```

`targetId` and `tabId` are observation-only values resolved by Core and the authenticated Extension.
They let an Embedder correlate runtime diagnostics and reconcile Worker state; they are never
accepted from a Viewer. The collection endpoint omits them so ordinary capacity polling remains a
non-sensitive summary.

The authenticated reconciliation endpoint returns every live Chrome page Target as `tracked` or
`untracked`. A tracked entry includes its current `sessionId`; an untracked entry deliberately does
not infer an owner. The response also reports current tracked and attaching Session counts. It is an
observation API: it never closes, adopts or navigates a Target, and no Viewer can call it. The
Embedder compares this snapshot with durable business ownership, then explicitly creates an
`adopt` Session or uses its own trusted CDP administration path to close a confirmed orphan.

The API never returns CDP endpoints, runtime secrets, binding tokens or Ticket signing secrets.
Viewer Ticket responses contain the opaque single-use Ticket because delivering it is the endpoint's
purpose; callers must treat that response as a credential.

Common API-only errors are `API_UNAUTHORIZED`, `API_INVALID_JSON`, `API_INVALID_REQUEST`,
`SESSION_CONFLICT`, `SESSION_CAPACITY_REACHED` and `SESSION_NOT_FOUND`. Core errors keep their stable
Remote Tab codes. Retrying is appropriate only when `retryable` is `true`.

When Core reaches terminal `FAILED` or `CLOSED`, Standalone removes the matching Session record as
part of the same lifecycle. The identity check is against the Session object, not only its ID, so a
late terminal callback from an old Session cannot remove a same-ID replacement. Terminal cleanup
therefore releases the configured Session capacity without requiring a redundant API `DELETE`.

## Stop and recover

`SIGINT` and `SIGTERM` stop accepting API work, close all attached Sessions through Core, remove
Session temporary files, close the Extension loopback, and remove the browser download spool. The
daemon does not stop Chrome.

At startup Standalone removes and recreates only its private `.sessions` upload subtree and
`.browser-downloads` directory with mode `0700`. This is intentionally fail-closed: a file left by
a process that no longer has in-memory ownership is never offered to a new Session. Other files
under the configured temp root belong to the Embedder and are not removed. Operators must not point
two simultaneous Standalone/Chrome runtimes at the same temp root.

While Standalone remains alive, losing a tracked main target, its flattened CDP attachment, or the
browser-level CDP connection fails that Session and removes it from the API list without waiting for
another user command. Chrome loss also changes readiness to `503 not-ready`; Standalone itself stays
available for liveness and diagnostics. It never restarts Chrome. Once the operator restores Chrome
and both Extension roles, the Embedder may create a new Session explicitly.

After an unexpected daemon exit, Standalone starts with no in-memory Sessions and reports surviving
page Targets through `GET /v1/reconciliation/targets`. It does not silently delete them. The
Embedder decides from its durable business state whether each Target should be adopted or closed,
and adoption is explicit through `POST /v1/sessions` with `tab.mode = "adopt"`. One Target may have
only one current Core Session owner; repeated or concurrent attachment fails with
`TAB_ALREADY_ATTACHED`. This makes restart recovery inspectable without claiming transparent Viewer
or Session recovery. mTLS transport remains a deployment integration.
