# Compose deployment

> [!IMPORTANT]
> These examples target a Linux `amd64` Docker Engine host. They use host networking so CDP,
> Extension loopback, the Standalone API and metrics can remain bound to `127.0.0.1`. Docker
> Desktop does not provide the same network namespace contract and is not a supported production
> host for these files.

The repository provides one all-in-one deployment and two independently deployable roles. The
all-in-one mode is one Compose project, not one container: the public Signaling Gateway, the
Chrome node and the Extension update server still have separate process and trust boundaries.

## Choose a deployment

| File | Services | Use it when |
| --- | --- | --- |
| `deploy/compose/compose.all-in-one.yml` | Signaling, Chrome node, Extension updates | Evaluating the complete stack on one Linux host |
| `deploy/compose/compose.gateway.yml` | Signaling | Running the public Gateway on a separate host |
| `deploy/compose/compose.chrome-node.yml` | Chrome node, Extension updates | Running Chrome and Standalone close to Profile storage |

The Chrome node image is a deployment convenience wrapper around Google Chrome Stable, the signed
Extension and Standalone. It does not change the public library boundary: Core and the Standalone
binary still connect to an operator-supplied Chrome and never install, update or schedule it. The
wrapper owns only the child processes inside its container and performs no automatic version
upgrade.

The repository publishes the Dockerfile, not a prebuilt `chrome-node` image. Google Chrome Stable is
proprietary and its software license does not grant this project redistribution rights. Running the
build makes the operator's Docker daemon download the pinned package directly from Google and verify
it before installation. Only the Chrome-free `signaling` and `standalone` targets are eligible for
public GHCR publication; see [third-party notices](../../THIRD_PARTY_NOTICES.md) and [supply-chain
artifacts](20-supply-chain-artifacts.md).

Both built images use the explicit tag `${REMOTE_TAB_IMAGE_TAG:-local}`. The Extension mount can be
selected with `${REMOTE_TAB_EXTENSION_RELEASE_DIR:-./extension-release}`. These shell-level Compose
variables make a previous image tuple and signed CRX directory selectable without overwriting the
candidate; the coordinated procedure is in
[Coordinated upgrade and rollback](18-upgrade-and-rollback.md).

`${REMOTE_TAB_EXTENSION_UPDATE_PORT:-8090}` selects the loopback host port for the nginx update
server. Sign the CRX with the same base URL and set the matching
`BROWSHARE_REMOTE_TAB_EXTENSION_UPDATE_URL`; the Compose interpolation variable is not read from
the service `runtime.env`.

The current image pins this tested compatibility set:

| Component | Pinned value |
| --- | --- |
| Platform | `linux/amd64` |
| Node.js runtime | `24.12.0`, base image pinned by digest |
| Google Chrome Stable package | `152.0.7977.75-1` |
| Google Chrome Stable runtime | `152.0.7977.75` |
| Chrome `.deb` SHA-256 | `a0b7a64f768ffc0ff5ccc9260ad9ebb53fd16f7a131e2e36994da58b82d913df` |
| Chrome seccomp profile | `deploy/docker/chrome-seccomp.json` |
| Remote Tab Extension | `0.1.14` |
| Maximum headless screen | `1920x1080` |

The Docker build downloads the exact `.deb` URL, verifies its SHA-256 and then checks the installed
Debian package version. A removed or changed upstream artifact fails the build instead of silently
installing a different Chrome.

Both Chrome-node Compose files load the repository's dedicated seccomp profile and give `/dev/shm`
2 GiB. The profile is derived from the pinned Moby default and remains deny-by-default; it only makes
`clone`, `clone3`, `setns` and `unshare` unconditional so the nonroot Chrome sandbox can create its
internal namespaces without `SYS_ADMIN`. Do not replace it with `seccomp=unconfined`, add
`privileged`, grant `SYS_ADMIN`, or add Chrome's `--no-sandbox`. If the Compose file is moved, set
`REMOTE_TAB_CHROME_SECCOMP_PROFILE` to the corresponding host path before running Compose.

## Prepare the Extension

Use a published signed CRX when one is available. For a source deployment, build and self-sign the
Extension from the repository root:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @browshare/remote-tab-extension build
pnpm --filter @browshare/remote-tab-extension-signing build
mkdir -p tmp/extension-signing
node tools/extension-signing/dist/cli.mjs generate-key \
  --key tmp/extension-signing/private.pem
node tools/extension-signing/dist/cli.mjs build \
  --source packages/extension/build/chrome \
  --key tmp/extension-signing/private.pem \
  --out deploy/compose/extension-release \
  --base-url http://127.0.0.1:8090/
```

The final command reports the Extension ID. Set that exact value in `runtime.env`. The mounted
`extension-release` directory needs the generated CRX and `updates.xml`; it must never contain the
private key. Keep the same private key for later Extension versions or Chrome will see a different
Extension ID.

The loopback update URL is intentional in the provided Linux topology. `extension-updates` binds
host port `8090` only to `127.0.0.1`, and the host-networked Chrome reaches it in the same network
namespace. When the update server moves elsewhere, regenerate `updates.xml` with the actual HTTPS
base URL and set the matching `BROWSHARE_REMOTE_TAB_EXTENSION_UPDATE_URL`.

## Configure one host

Create the ignored runtime configuration next to the Compose files:

```bash
cp deploy/compose/runtime.env.example deploy/compose/runtime.env
chmod 600 deploy/compose/runtime.env
```

Replace every `replace-with-...` value. Generate each of the Viewer Ticket, Core binding, API and
Extension runtime secrets independently; this command produces one suitable value at a time:

```bash
openssl rand -hex 32
```

Set `BROWSHARE_REMOTE_TAB_GATEWAY_PUBLIC_ENDPOINT` to the URL a Viewer can actually reach. A plain
`ws:` endpoint is acceptable only for a controlled initial test; production uses `wss:` through a
TLS terminator. Configure `BROWSHARE_REMOTE_TAB_ICE_SERVERS_JSON` for the intended direct or TURN
path. The empty array in the example does not promise that direct ICE works across arbitrary NATs.

The Chrome node derives its `--remote-debugging-port` from the loopback HTTP origin in
`BROWSHARE_REMOTE_TAB_CDP_ENDPOINT`. Its managed policy derives the Extension loopback URL from
`BROWSHARE_REMOTE_TAB_EXTENSION_HOST` and `BROWSHARE_REMOTE_TAB_EXTENSION_PORT`. Compose health
checks likewise read the configured Gateway metrics and Standalone API ports. This keeps one
runtime configuration authoritative when an operator uses non-default loopback ports.

Do not set a runtime generation in this Compose mode. The Chrome node entrypoint generates a fresh
UUID on every container start and gives the same value to managed policy and Standalone. On a new
Profile, Chrome must first install the policy-forced CRX before it knows that Extension's managed
schema; the entrypoint detects this one-time bootstrap and performs one controlled Chrome restart.
Established Profile volumes skip that restart.

Validate and start the all-in-one stack:

```bash
docker compose -f deploy/compose/compose.all-in-one.yml config --quiet
docker compose -f deploy/compose/compose.all-in-one.yml up -d --build
docker compose -f deploy/compose/compose.all-in-one.yml ps
```

The default environment file is `deploy/compose/runtime.env`. To use an absolute external secret
file, set `REMOTE_TAB_ENV_FILE` for every Compose invocation:

```bash
REMOTE_TAB_ENV_FILE=/etc/browshare/remote-tab.env \
  docker compose -f deploy/compose/compose.all-in-one.yml up -d --build
```

## Verify the running stack

Wait until both services with health checks report `healthy`, then inspect liveness, readiness and
capabilities on the host:

```bash
curl --fail http://127.0.0.1:9090/health/live
curl --fail http://127.0.0.1:9230/health/ready
set -a
. deploy/compose/runtime.env
set +a
curl --fail \
  -H "Authorization: Bearer ${BROWSHARE_REMOTE_TAB_API_TOKEN}" \
  http://127.0.0.1:9230/v1/diagnostics/capabilities
```

Readiness requires CDP plus both Extension roles. The capability report must name the intended
Chrome and Extension versions and set `coherent` to `true`. Creating and deleting a real Session
through the API is the final deployment check; use the request in
[Standalone daemon and API](12-standalone-api.md), then confirm the Session list and READY metric
return to zero.

The intended listener boundary is:

| Port | Bind | Purpose |
| ---: | --- | --- |
| `8081` | `0.0.0.0` by default | Public Signaling WebSocket; terminate TLS for production |
| `8090` | `127.0.0.1` | Local CRX and update manifest |
| `9090` | `127.0.0.1` | Gateway metrics and metrics liveness |
| `9222` | `127.0.0.1` | Chrome CDP |
| `9224` | `127.0.0.1` | Authenticated Extension loopback |
| `9230` | `127.0.0.1` | Authenticated Standalone Embedder API |

Host firewall rules still need to expose only the intended public ingress. Do not publish or proxy
the five loopback services. The `chrome-profile` volume contains site credentials and cookies;
protect its host storage and backups as account secrets.

To run an isolated second Compose project on the same test host, choose a different project name,
set distinct values for the Gateway, metrics, CDP, Extension loopback and API ports in its
`runtime.env`, and export a distinct `REMOTE_TAB_EXTENSION_UPDATE_PORT` for every Compose command.
The CRX signing base URL and `BROWSHARE_REMOTE_TAB_EXTENSION_UPDATE_URL` must use that same update
port. Production normally runs one Chrome node per host, so alternate ports are primarily an
integration and migration aid.

## Split Gateway and Chrome nodes

On the Gateway host, prepare its runtime file and run:

```bash
docker compose -f deploy/compose/compose.gateway.yml config --quiet
docker compose -f deploy/compose/compose.gateway.yml up -d --build
```

On each Chrome host, prepare the matching Extension release and runtime file, then run:

```bash
docker compose -f deploy/compose/compose.chrome-node.yml config --quiet
docker compose -f deploy/compose/compose.chrome-node.yml up -d --build
```

The Viewer-facing endpoint must resolve to the Gateway host. A Session's `coreEndpoint` must also
reach that same in-memory Gateway instance; it may use a private address from the Chrome host.
Compose does not add a Backend relay, arbitrary round-robin load balancing or cross-host Profile
storage. Those are Embedder and infrastructure responsibilities.

## Stop or remove a deployment

Stop and remove containers while retaining the Profile and private runtime volumes:

```bash
docker compose -f deploy/compose/compose.all-in-one.yml down
```

`down --volumes` also destroys the Chrome Profile, cookies and any remaining private Session data.
Use it only when intentionally resetting a test deployment. Keep
`deploy/compose/runtime.env`, Extension signing keys and Profile backups out of source control and
container images.

## Troubleshoot startup

Inspect bounded service logs without printing `runtime.env`:

```bash
docker compose -f deploy/compose/compose.all-in-one.yml ps -a
docker compose -f deploy/compose/compose.all-in-one.yml logs --tail=200 signaling
docker compose -f deploy/compose/compose.all-in-one.yml logs --tail=300 chrome-node
docker compose -f deploy/compose/compose.all-in-one.yml logs --tail=100 extension-updates
```

Use the following failure boundaries:

| Symptom | Check |
| --- | --- |
| Extension never installs | CRX name and codebase in `updates.xml`, local update-server response, Extension ID |
| Extension roles stay disconnected | managed-policy values, runtime secret, one-time bootstrap restart and Chrome log |
| Capability versions disagree | installed CRX version, both role versions and the current runtime generation |
| Chrome image no longer builds | exact `.deb` availability, SHA-256 and declared package version; do not relax the checks |
| Gateway is healthy but Viewer cannot connect | public DNS/TLS route, `wss:` endpoint, firewall and single-instance pairing route |
| Session attaches but media does not connect | ICE server configuration, TURN reachability and selected candidate diagnostics |

The broader incident sequence and Prometheus alerts are in
[Operations metrics, alerts and runbook](16-operations-runbook.md).
