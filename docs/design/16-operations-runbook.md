# Operations metrics, alerts and runbook

## Scope

Remote Tab exports Prometheus text without Session IDs, URLs, IP addresses, file names or other
unbounded labels. Metrics are process-local. A deployment assigns stable Prometheus `job` and
`instance` labels and aggregates across instances in its own dashboards.

The Signaling CLI starts a dedicated HTTP listener, defaulting to `127.0.0.1:9090`:

```text
GET /health/live
GET /metrics
```

Configure it with `BROWSHARE_REMOTE_TAB_GATEWAY_METRICS_HOST` and
`BROWSHARE_REMOTE_TAB_GATEWAY_METRICS_PORT`. Bind it to a private service network only when an
external Prometheus collector cannot reach loopback. It has no application authentication and must
never be exposed to the public Internet.

Standalone serves unauthenticated `GET /metrics` on its existing loopback-only Embedder listener.
It reports a fixed set of lifecycle states, attaching work and the configured maximum. The endpoint
does not run CDP commands, probe Chrome or enumerate Targets during a scrape.

## Metric families

Signaling exports gauges for active connections, bound peers, tracked pairs, consumed Ticket replay
records and their three configured ceilings. It exports counters for accepted and rejected
connections, received messages and bytes, relayed messages, rate-limited connections, completed
pairs and expired pairs.

Standalone exports:

```text
browshare_remote_tab_standalone_sessions{state="ATTACHING|READY|NEGOTIATING|CONNECTED|SUSPENDED|RECONNECTING|FAILED|CLOSED"}
browshare_remote_tab_standalone_sessions_max
```

The fixed `state` label is bounded. `FAILED` and `CLOSED` should normally be zero because terminal
records are evicted promptly; non-zero values indicate a lifecycle callback still being processed.

Example Prometheus scrape configuration and alert rules live under `deploy/observability/`. The
thresholds are conservative starting points, not capacity promises. Tune the `for` durations only
after measuring normal connection churn and Session duration.

## Capacity response

### Signaling connections above 80%

Confirm that `connections_active` and `peers_bound` rise together. If active connections are mostly
unbound, inspect client authentication failures and the pairing timeout. Drain new assignments from
the instance before changing a hard ceiling. Add a Gateway instance and let the Embedder assign both
peers of each new Session to the same explicit Gateway ID; arbitrary per-request load balancing does
not preserve in-memory pairing.

Do not immediately raise `maxConnections`. First check file descriptors, memory, CPU, TLS proxy
limits and the immediate-source-address distribution. A proxy can make all clients share one source
address and exhaust the per-IP ceiling even when total capacity is healthy.

### Pair records above 80% or expiry rising

Compare `pairs_tracked`, `pairs_completed_total` and `pairs_expired_total`. A rising expiry rate
usually means only one peer reaches the assigned instance, Tickets arrive too late, or a reverse
proxy sends Core and Viewer to different Gateway processes. Verify Gateway ID, endpoint assignment,
clock skew and route affinity before increasing the pairing timeout.

### Consumed Tickets above 90%

Consumed entries remain until their Ticket expiry so replays can be rejected. Check Ticket lifetime
and issuance rate. Prefer shorter operationally sufficient lifetimes or more Gateway instances.
Never disable replay tracking and never log Tickets to diagnose this alert.

Metric snapshots prune expired records before reporting this gauge. A non-zero value therefore
means a currently unexpired consumed Ticket, not idle historical state.

### Standalone Sessions above 80%

Check the fixed state distribution. A large `SUSPENDED` population may be expected when inactive
Viewers preserve tabs; a large `RECONNECTING` population points to signaling or network failure.
Drain new work and add a separately managed Chrome runtime when sustained demand approaches the
limit. Raising `maxSessions` is safe only after validating Chrome CPU, memory, GPU/software-renderer
load, file descriptors, upload storage and real WebRTC quality at the new concurrency.

## Incident order

1. Confirm Prometheus target health and `GET /health/live` before interpreting missing series.
2. Confirm Standalone `/health/ready` and capability diagnostics before blaming WebRTC.
3. Check capacity and rejection counters, then pairing expiry and rate limiting.
4. Check selected ICE path and TURN health for connected peers with media failure.
5. Check fixed Standalone state counts and the authenticated Session list.
6. After an ungraceful Standalone restart, compare durable ownership with
   `/v1/reconciliation/targets`; never bulk-delete every untracked page.
7. Drain new assignments before restart or upgrade. Preserve evidence using bounded metric snapshots
   and redacted structured logs, not protocol payloads.

## Recovery completion

An incident is recovered when health endpoints are stable, rejection/rate-limit counters stop
increasing unexpectedly, capacity remains below the tuned threshold, new two-peer pairing succeeds,
and any crash orphan decision has completed explicitly. A process restart alone is not evidence that
the original routing or capacity fault is fixed.

## Validation evidence

On 2026-09-04, the production builds ran on the Google Chrome Stable compatibility host. The
Signaling listener returned 15 Prometheus metric families on its private port and its liveness route
returned `ok`. Standalone reported `READY` counts of `0 → 1 → 0` while a real CDP Session was
created and deleted; its output contained no Session ID, and final readiness was `ready` with zero
Sessions. Prometheus `promtool 2.45.3` accepted both live metric streams and all nine example alert
rules.
