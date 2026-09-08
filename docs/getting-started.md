# Getting started

Build Remote Tab from source, deploy its Standalone runtime, or bring its Viewer into your application.
For an overview of the components, start with the [project README](../README.md).

## Build from source

Use Node.js 24.11.0 or newer and the pnpm version declared in `package.json`. Run the following from
the directory where you keep source checkouts:

```bash
git clone https://github.com/x3zvawq/browshare-remote-tab.git browshare-tab-remote
cd browshare-tab-remote
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

**All remaining shell commands in this guide run from this repository root**, unless a step explicitly
switches to your application directory. Building packages does not start Chrome or a Session.

The source build is the installation path documented here; it does not require published npm packages
or project images from a registry. When promoting a deployment, record the exact source commit and
keep its [compatibility set](../deploy/compatibility.json) together through upgrades.

## Deploy one complete host


This quick start takes a fresh source checkout to one working Linux `amd64` host with a Signaling
Gateway, an operator-built Google Chrome Stable node, a self-signed Extension and the Standalone
Embedder API. It verifies a real `READY` Session before declaring the deployment usable.

> [!WARNING]
> The quick start uses plain `ws:` for an initial controlled test. Put the public Gateway behind a
> trusted TLS terminator and use `wss:` before exposing it to real users. CDP, Extension loopback,
> metrics, the Extension update server and the Standalone API must remain on loopback.

### Check the host

Run these commands from the repository root on a Linux `amd64` Docker Engine host. Docker Desktop
does not provide the host-network contract used by this deployment.

```bash
test "$(uname -s)" = Linux
test "$(uname -m)" = x86_64
docker version
docker compose version
node --version
openssl version
curl --version
```

The source build requires Node.js `24.11.0` or newer, Corepack and the pnpm version declared in
`package.json`. The Docker daemon needs outbound HTTPS access to npm registries, the pinned Node
base image, Google Chrome's Debian package and the nginx image.

Choose the browser-reachable host or DNS name and keep the default ports unless they are already in
use. The project name keeps this deployment's containers and volumes separate from other Compose
projects.

```bash
read -r -p 'Public host or DNS name for the Signaling Gateway: ' REMOTE_TAB_PUBLIC_HOST
test -n "$REMOTE_TAB_PUBLIC_HOST"

export REMOTE_TAB_COMPOSE_PROJECT='browshare-remote-tab'
export REMOTE_TAB_GATEWAY_PORT='8081'
export REMOTE_TAB_GATEWAY_METRICS_PORT='9090'
export REMOTE_TAB_EXTENSION_UPDATE_PORT='8090'
export REMOTE_TAB_CDP_PORT='9222'
export REMOTE_TAB_EXTENSION_PORT='9224'
export REMOTE_TAB_API_PORT='9230'
```

Only `${REMOTE_TAB_GATEWAY_PORT}` is intended for public ingress. If the host firewall or an
upstream proxy cannot expose that port, fix the ingress before testing a Viewer; never publish the
five loopback ports as a workaround.

### Build and sign the Extension

Generate the private key outside the served release directory. Preserve this key securely for
upgrades: a different key produces a different Extension ID.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @browshare/remote-tab-extension build
pnpm --filter @browshare/remote-tab-extension-signing build

mkdir -p tmp/extension-signing deploy/compose/extension-release
node tools/extension-signing/dist/cli.mjs generate-key \
  --key tmp/extension-signing/private.pem

extension_result="$(node tools/extension-signing/dist/cli.mjs build \
  --source packages/extension/build/chrome \
  --key tmp/extension-signing/private.pem \
  --out deploy/compose/extension-release \
  --base-url "http://127.0.0.1:${REMOTE_TAB_EXTENSION_UPDATE_PORT}/")"
extension_id="$(printf '%s' "$extension_result" | node -e \
  "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>process.stdout.write(JSON.parse(s).extensionId))")"
test "${#extension_id}" -eq 32
printf 'Extension ID: %s\n' "$extension_id"
```

The served directory must contain the generated `.crx` and `updates.xml`, but not
`private.pem`. The signing command also writes the SHA-256 digest into its JSON result for release
verification.

### Create the private runtime configuration

The four credentials below are intentionally independent. The file is ignored by Git and must stay
owner-readable only.

```bash
viewer_ticket_secret="$(openssl rand -hex 32)"
core_binding_token="$(openssl rand -hex 32)"
api_token="$(openssl rand -hex 32)"
runtime_secret="$(openssl rand -hex 32)"

umask 077
cat > deploy/compose/runtime.env <<EOF
BROWSHARE_REMOTE_TAB_GATEWAY_ID=gateway-1
BROWSHARE_REMOTE_TAB_GATEWAY_PUBLIC_ENDPOINT=ws://${REMOTE_TAB_PUBLIC_HOST}:${REMOTE_TAB_GATEWAY_PORT}
BROWSHARE_REMOTE_TAB_GATEWAY_HOST=0.0.0.0
BROWSHARE_REMOTE_TAB_GATEWAY_PORT=${REMOTE_TAB_GATEWAY_PORT}
BROWSHARE_REMOTE_TAB_GATEWAY_METRICS_HOST=127.0.0.1
BROWSHARE_REMOTE_TAB_GATEWAY_METRICS_PORT=${REMOTE_TAB_GATEWAY_METRICS_PORT}
BROWSHARE_REMOTE_TAB_VIEWER_TICKET_SECRET=${viewer_ticket_secret}
BROWSHARE_REMOTE_TAB_CORE_BINDING_TOKEN=${core_binding_token}
BROWSHARE_REMOTE_TAB_ICE_SERVERS_JSON=[]
BROWSHARE_REMOTE_TAB_ICE_TRANSPORT_POLICY=all

BROWSHARE_REMOTE_TAB_CDP_ENDPOINT=http://127.0.0.1:${REMOTE_TAB_CDP_PORT}
BROWSHARE_REMOTE_TAB_API_TOKEN=${api_token}
BROWSHARE_REMOTE_TAB_API_HOST=127.0.0.1
BROWSHARE_REMOTE_TAB_API_PORT=${REMOTE_TAB_API_PORT}
BROWSHARE_REMOTE_TAB_EXTENSION_HOST=127.0.0.1
BROWSHARE_REMOTE_TAB_EXTENSION_PORT=${REMOTE_TAB_EXTENSION_PORT}
BROWSHARE_REMOTE_TAB_EXTENSION_ID=${extension_id}
BROWSHARE_REMOTE_TAB_EXTENSION_UPDATE_URL=http://127.0.0.1:${REMOTE_TAB_EXTENSION_UPDATE_PORT}/updates.xml
BROWSHARE_REMOTE_TAB_RUNTIME_SECRET=${runtime_secret}
BROWSHARE_REMOTE_TAB_TEMP_ROOT=/var/lib/browshare/remote-tab
BROWSHARE_REMOTE_TAB_MAX_SESSIONS=16
EOF
chmod 600 deploy/compose/runtime.env
```

An empty ICE server list is suitable only when direct candidates are known to work. A production
deployment normally supplies STUN/TURN configuration through
`BROWSHARE_REMOTE_TAB_ICE_SERVERS_JSON`; see [Signaling, ICE, and TURN](design/06-signaling-and-ice.md).

### Start and verify the stack

Validate interpolation before building. The first Chrome start on a fresh Profile installs the
force-installed CRX, then performs one controlled restart so both Extension roles receive their
managed runtime configuration.

```bash
docker compose -p "$REMOTE_TAB_COMPOSE_PROJECT" \
  -f deploy/compose/compose.all-in-one.yml config --quiet
docker compose -p "$REMOTE_TAB_COMPOSE_PROJECT" \
  -f deploy/compose/compose.all-in-one.yml up -d --build
docker compose -p "$REMOTE_TAB_COMPOSE_PROJECT" \
  -f deploy/compose/compose.all-in-one.yml ps
```

Wait for both health-checked services to become healthy, then verify the exact Chrome, Extension,
Core and protocol compatibility tuple:

```bash
until curl --fail --silent \
  "http://127.0.0.1:${REMOTE_TAB_GATEWAY_METRICS_PORT}/health/live" >/dev/null; do sleep 2; done
until curl --fail --silent \
  "http://127.0.0.1:${REMOTE_TAB_API_PORT}/health/ready" >/dev/null; do sleep 2; done

set -a
. deploy/compose/runtime.env
set +a
node deploy/compose/check-runtime.mjs \
  --base-url "http://127.0.0.1:${REMOTE_TAB_API_PORT}"
```

Finish with a real Session attach and deterministic cleanup. `READY` proves that CDP resolved the
created target and both Extension roles accepted the same runtime identity.

```bash
session_id="readme-deploy-$(date +%s)"
session_result="$(curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer ${BROWSHARE_REMOTE_TAB_API_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data "{
    \"sessionId\": \"${session_id}\",
    \"tab\": {\"mode\": \"create\", \"initialUrl\": \"https://example.com/\"},
    \"capabilities\": [\"navigation\", \"backForward\", \"reload\"],
    \"signaling\": {
      \"gatewayId\": \"${BROWSHARE_REMOTE_TAB_GATEWAY_ID}\",
      \"coreEndpoint\": \"ws://127.0.0.1:${BROWSHARE_REMOTE_TAB_GATEWAY_PORT}\",
      \"viewerEndpoint\": \"${BROWSHARE_REMOTE_TAB_GATEWAY_PUBLIC_ENDPOINT}\",
      \"bindingToken\": \"${BROWSHARE_REMOTE_TAB_CORE_BINDING_TOKEN}\"
    },
    \"navigationPolicy\": \"allow-all\"
  }" \
  "http://127.0.0.1:${REMOTE_TAB_API_PORT}/v1/sessions")"
printf '%s\n' "$session_result"
printf '%s' "$session_result" | node -e \
  "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{if(JSON.parse(s).state!=='READY')process.exit(1)})"

curl --fail-with-body --silent --show-error -X DELETE \
  -H "Authorization: Bearer ${BROWSHARE_REMOTE_TAB_API_TOKEN}" \
  "http://127.0.0.1:${REMOTE_TAB_API_PORT}/v1/sessions/${session_id}"

node deploy/compose/check-runtime.mjs \
  --base-url "http://127.0.0.1:${REMOTE_TAB_API_PORT}"
curl --fail --silent \
  -H "Authorization: Bearer ${BROWSHARE_REMOTE_TAB_API_TOKEN}" \
  "http://127.0.0.1:${REMOTE_TAB_API_PORT}/v1/reconciliation/targets" | \
  node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const r=JSON.parse(s);if(r.trackedSessionCount!==0||r.attachingSessionCount!==0)process.exit(1);console.log(JSON.stringify(r,null,2))})"
```

The reconciliation result can contain Chrome's untracked startup tab; both Session counters must be
zero. This smoke check closes its test Session. To connect a Viewer, create another Session and issue a
single-use Ticket as described in the [Standalone API](design/12-standalone-api.md#run-one-session).
Then use the [Viewer integration section](#use-the-viewer-in-your-application).

### Stop or reset the deployment

Normal shutdown preserves the Chrome Profile volume, which contains cookies and site credentials:

```bash
docker compose -p "$REMOTE_TAB_COMPOSE_PROJECT" \
  -f deploy/compose/compose.all-in-one.yml down
```

For a disposable test only, append `--volumes` to destroy the Profile and private runtime volumes.
See [Compose deployment](design/17-compose-deployment.md) for split roles, TLS/TURN, alternate
ports and failure diagnosis.

## Use the Viewer in your application

The Viewer is a framework-independent Web Component. Your server creates or authorizes a Session
and returns a short-lived single-use Ticket and browser-reachable signaling endpoint. Keep the
Standalone API token, CDP endpoint and Extension credentials on the server.

From the Remote Tab repository root, build and stage the Viewer with its production dependencies:

```bash
pnpm --filter @browshare/remote-tab-viewer... build
pnpm --filter @browshare/remote-tab-viewer deploy --legacy --prod tmp/viewer-package
```

The output directory must be new. For a local integration with a bundler, link that staged package
into **your application's directory**; use the actual absolute path of the checkout:

```bash
REMOTE_TAB_SOURCE=/absolute/path/to/browshare-tab-remote
cd /absolute/path/to/your-web-application
mkdir -p node_modules/@browshare
ln -s "$REMOTE_TAB_SOURCE/tmp/viewer-package" node_modules/@browshare/remote-tab-viewer
```

The link is local build configuration, not a dependency declaration to commit. In a production build,
recreate the staged package from the same fixed source input. An existing package at the link path
must be handled by your application's dependency configuration rather than overwritten.

Register the component in your browser entry point. Explicit registration keeps the package import
safe for server-rendered applications:

```ts
import { defineRemoteTabViewer } from '@browshare/remote-tab-viewer'

defineRemoteTabViewer()
```

Render it with the authorized values returned by your backend:

```html
<browshare-tab-viewer
  ticket="short-lived-single-use-ticket"
  endpoint="wss://signal.example.com"
  locale="en-US"
></browshare-tab-viewer>
```

The attributes above are placeholders; the deployment guide's Session smoke check does not issue a
Ticket. Use the [Standalone Ticket endpoint](design/12-standalone-api.md#run-one-session) or the
[Core embedding API](design/03-embedding-api.md) from your trusted backend. Tickets belong in the
component's in-memory state, not URLs, logs or persistent storage.

The default Viewer supplies navigation, acknowledged quality controls, input/IME, upload selection,
download confirmation and explicit clipboard actions according to the Session's granted capabilities.
When a browser requires a user gesture to start playback, the Viewer presents a playback button.
Media is suspended when the local window loses focus by default; set
`suspend-when-unfocused="false"` only when background streaming is a deliberate application choice.

Choose the [Headless Client API](design/03-embedding-api.md) when your application needs its own UI.
The embedding application remains responsible for users, authorization, Session lifetime and Chrome
Profile storage. See [all documentation](README.md) for navigation policy, child windows, Page Script,
operations and integration contracts.
