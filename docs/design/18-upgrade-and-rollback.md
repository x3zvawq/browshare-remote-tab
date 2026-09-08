# Coordinated upgrade and rollback

> [!WARNING]
> Chrome, the signed Extension, Core, Standalone, Viewer and protocol are one tested compatibility
> set. Do not upgrade or roll back one member in place while Sessions are active. Chrome Profile
> formats can move forward during startup; never start an older Chrome against a Profile already
> opened by a newer Chrome unless that exact downgrade path was tested.

This procedure gives the reference Compose deployment a fail-closed release boundary. It does not
promise uninterrupted Sessions: upgrades drain new assignments, finish or explicitly close current
Sessions, restart the runtime and admit work only after diagnostics and a real smoke Session pass.

## Read the compatibility set

[`deploy/compatibility.json`](../../deploy/compatibility.json) is the machine-readable release
tuple. It records the coordinated package version, exact Chrome product and Debian artifact,
Extension version and protocol version.

Validate that the source tree, Docker inputs and package versions still agree with it:

```bash
pnpm check:compatibility
```

Run the live checker from the repository root after sourcing the private runtime configuration:

```bash
set -a
. deploy/compose/runtime.env
set +a
node deploy/compose/check-runtime.mjs
```

The live check fails unless Standalone is ready, both Extension roles are coherent, Chrome,
Extension and protocol match the manifest, and the Session list is empty. A released non-zero
version also requires Core and Standalone to report that exact coordinated version. Its JSON output
contains no bearer token, ticket secret, runtime secret, Profile data or page URL.

Use `--manifest /absolute/path/to/compatibility.json` when checking an installed previous release
from a newer checkout. Use `--base-url` only for an authorized private Standalone endpoint.

## Prepare a candidate

Before changing a running host, prepare these immutable inputs:

| Input | Requirement |
| --- | --- |
| Source and packages | One coordinated version accepted by `pnpm check:compatibility` |
| Signaling image | Candidate tag or digest built from that source |
| Chrome-node image | Same candidate tag, including the manifest's exact Chrome `.deb` |
| Extension directory | Signed CRX and matching `updates.xml`, retained under a versioned path |
| Previous release record | Previous image tag/digests, Extension directory and compatibility manifest |
| Profile recovery point | Stopped-volume or infrastructure snapshot taken before candidate Chrome starts |

The Compose files assign explicit local image names and accept one shell-level tag. Build an example
candidate without replacing the currently selected tag:

```bash
REMOTE_TAB_IMAGE_TAG=0.1.14 \
  docker compose -f deploy/compose/compose.all-in-one.yml build
```

Keep each Extension release in its own directory. Select it with an absolute path so rollback does
not depend on copying files over a live mount:

```bash
export REMOTE_TAB_IMAGE_TAG=0.1.14
export REMOTE_TAB_EXTENSION_RELEASE_DIR=/opt/browshare/releases/0.1.14/extension
docker compose -f deploy/compose/compose.all-in-one.yml config --quiet
```

`REMOTE_TAB_IMAGE_TAG` and `REMOTE_TAB_EXTENSION_RELEASE_DIR` are Compose interpolation variables;
they are not read from the service `runtime.env`. Record them in the deployment manager or an
operator-owned release file and export the same values for every build, up, down and inspection
command.

Verify the candidate CRX identity and `updates.xml` codebase before the maintenance window. The
Extension ID must remain the one in `runtime.env`, and the update URL must resolve from the
host-networked Chrome. Never put the signing private key in the release directory, Profile snapshot
or image.

## Drain the current runtime

The Embedder owns scheduling, so it first marks the Worker or Standalone allocation unavailable for
new Sessions. Remote Tab deliberately has no public "drain every application" switch.

After new assignments stop, wait for current Sessions to finish or explicitly close them through
the authorized application. Then run the previous release's live check. An empty Session list is a
hard precondition for the reference procedure:

```bash
node deploy/compose/check-runtime.mjs \
  --manifest /opt/browshare/releases/current/compatibility.json
```

Record bounded metrics and logs needed for incident comparison. Do not copy bearer tokens, Viewer
Tickets, SDP, ICE credentials, cookies or Profile files into the change record.

## Upgrade one all-in-one host

1. Drain the runtime and prove zero Sessions with the previous compatibility manifest.
2. Stop the Compose project. Wait for Standalone's `SIGTERM` cleanup to finish.
3. Snapshot the stopped `chrome-profile` volume using the host's storage facility. Also retain the
   previous Extension directory, compatibility manifest and exact image digests.
4. Export the candidate image tag and Extension directory.
5. Start the project and wait for Signaling and Chrome-node health checks.
6. Run `check-runtime.mjs` against the candidate manifest.
7. Create and delete one real Session, then confirm the list and READY metric return to zero.
8. Re-enable Embedder assignment only after every preceding check passes.

The command transition is:

```bash
docker compose -f deploy/compose/compose.all-in-one.yml down
export REMOTE_TAB_IMAGE_TAG=0.1.14
export REMOTE_TAB_EXTENSION_RELEASE_DIR=/opt/browshare/releases/0.1.14/extension
docker compose -f deploy/compose/compose.all-in-one.yml up -d
docker compose -f deploy/compose/compose.all-in-one.yml ps
node deploy/compose/check-runtime.mjs \
  --manifest /opt/browshare/releases/0.1.14/compatibility.json
```

The Chrome-node entrypoint creates a new runtime generation on every start. Chrome may install the
candidate CRX while an older service worker is still resident, so the entrypoint restart and final
two-role version check are the acceptance boundary—not the presence of an Extension directory.

## Upgrade split hosts

Keep the runtime drained across the whole assigned set. With no Backend high-availability contract,
the safest initial sequence is:

1. Stop affected Chrome nodes after they reach zero Sessions and snapshot each stopped Profile.
2. Upgrade the assigned Gateway and require its liveness and Prometheus endpoint to pass.
3. Upgrade Chrome nodes one at a time with the candidate tag and Extension directory.
4. Run the live compatibility checker and a real Session on each node.
5. Return only verified nodes to the Embedder scheduler.

Every Session binds Core and Viewer to one explicit in-memory Gateway. Do not put an arbitrary
round-robin proxy in front of mixed old and new Gateway instances. A future rolling strategy may
assign distinct Gateway IDs, but it still cannot migrate an active PeerConnection between them.

## Roll back a failed candidate

Rollback restores the entire previous tuple:

1. Keep new assignment disabled and close any candidate smoke Session.
2. Stop the candidate project.
3. If candidate Chrome opened the Profile, restore the pre-upgrade Profile snapshot. Do not rely on
   an in-place Chrome downgrade.
4. Export the previous image tag and previous Extension directory.
5. Start the previous project and wait for health checks.
6. Run the previous `compatibility.json` through the live checker.
7. Create and delete a real Session; require zero Sessions and no extra page Target afterward.
8. Resume assignment only after the old tuple is coherent again.

If failure occurred before candidate Chrome started, the Profile snapshot does not need restoration.
If a Profile snapshot is unavailable after newer Chrome opened it, keep the node out of service and
recover through the operator's Profile backup policy; silently trying the old binary is not an
accepted rollback.

## Acceptance and failure boundaries

| Check | Required result | Failure action |
| --- | --- | --- |
| Source manifest check | No mismatched package, Chrome, Extension or protocol value | Do not build or deploy |
| Pre-change Session check | Zero active Sessions | Continue draining |
| Gateway health | Healthy and metrics reachable on its private listener | Keep nodes drained |
| Standalone readiness | CDP reachable and both Extension roles connected | Inspect Chrome, policy and loopback logs |
| Runtime compatibility | Exact Chrome and Extension versions; coherent roles; expected protocol | Roll back the full tuple |
| Real Session smoke | READY attachment, explicit close, zero Session/Target residue | Keep assignment disabled |
| Post-rollback check | Previous tuple and smoke both pass | Escalate to Profile or infrastructure recovery |

Operational alerts and incident evidence collection remain in
[Operations metrics, alerts and runbook](16-operations-runbook.md). Compose preparation and listener
boundaries remain in [Compose deployment](17-compose-deployment.md).
