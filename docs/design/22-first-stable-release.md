# First stable release and installation

> [!IMPORTANT]
> Version `0.1.23` is the current unpublished coordinated source candidate. It is not a published release
> until the tag workflow succeeds in npm, GHCR, official Extension signing and GitHub Release jobs.
> Never substitute a self-signed test CRX for the official fixed-ID artifact in a compatibility
> claim.

This document is the operator and maintainer entry point for publishing, installing, upgrading,
rolling back and diagnosing the first stable Remote Tab compatibility set.

## Understand the release set

The release tag is `v0.1.23`. [`deploy/compatibility.json`](../../deploy/compatibility.json) is the
machine-readable authority for the coordinated source version, Chrome build, Extension version and
protocol version.

| Deliverable | Release location | Boundary |
| --- | --- | --- |
| Six public libraries and tools | npm under `@browshare` | Exact `0.1.23` tarballs; public access; npm provenance |
| Signaling image | GHCR `browshare-remote-tab-signaling` | Chrome-free application image |
| Standalone image | GHCR `browshare-remote-tab-standalone` | Chrome-free application image; operator supplies Chrome |
| Official Extension | GitHub Release CRX, update manifest, policy and metadata | Fixed ID derived from the release-only private key |
| Source release | GitHub tag and release | MIT source plus reviewed release assets |
| Chrome node | Repository Dockerfile only | Built locally by the operator; never published with Google Chrome |

The final `release-manifest.json` records every downloadable asset and digest.
`SHA256SUMS` covers the manifest, npm tarballs, Extension artifacts, source SBOMs, license inventory,
compatibility record, security review and operational evidence.

## Prepare repository publishing

The GitHub repository must have these external settings before the first tag is pushed:

1. The confirmed source is `x3zvawq/browshare-remote-tab`. All six public manifests now declare
   `type: "git"`, `url: "git+https://github.com/x3zvawq/browshare-remote-tab.git"` (exact case) and
   `directory` equal to the package path, such as `packages/core`; local `origin` points to the same
   repository. npm provenance requires this metadata to match its build origin. The hosted
   `release:check` checks all six before publication; locally run
   `pnpm release:check --tag v0.1.23 --repository x3zvawq/browshare-remote-tab`.
2. Configure npm trusted publishing for each of the six public packages and bind it to
   `.github/workflows/release.yml` in this repository.
3. Add `BROWSHARE_EXTENSION_PRIVATE_KEY_PEM` as the persistent RSA private key secret. Never rotate
   it for an ordinary update because key replacement changes the Extension ID.
4. Add `BROWSHARE_EXTENSION_ID` as the 32-character ID derived from that key. The release job signs
   and then requires an exact match before retaining any artifact.
5. Allow the workflow's `GITHUB_TOKEN` to write packages and attestations. Decide GHCR public or
   private visibility explicitly after the first image exists.
6. Require the normal CI aggregate gate on the default branch before a release tag can be created.

Private vulnerability reporting is enabled for the confirmed repository and was read back through
the GitHub API on 2026-09-08. The [security policy](../SECURITY.md) identifies the private report
entry point; no report or advisory was submitted as a configuration probe.

Do not add an npm token, registry password, Chrome package, Profile archive, runtime bearer token or
TURN secret. npm uses OIDC trusted publishing; GHCR uses the scoped workflow token; Extension
signing is isolated to its own job, and its temporary key is removed on success or failure.
Repository requirements are specified by [npm provenance documentation](https://docs.npmjs.com/generating-provenance-statements).

## Build the candidate locally

Run the exact preflight before tagging:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm release:check --tag v0.1.23 --repository x3zvawq/browshare-remote-tab
pnpm check
npx --yes @google/design.md@0.4.0 lint docs/DESIGN.md
```

Resolve all three Compose graphs with `runtime.env.example`, then generate and verify the source
artifact bundle with Syft `1.51.1`:

```bash
export REMOTE_TAB_ENV_FILE=runtime.env.example
docker compose -f deploy/compose/compose.all-in-one.yml config --quiet
docker compose -f deploy/compose/compose.gateway.yml config --quiet
docker compose -f deploy/compose/compose.chrome-node.yml config --quiet
pnpm artifacts:bundle
```

Use a disposable key only to exercise the signing and assembly path locally. A local rehearsal must
not overwrite or expose the official key:

```bash
mkdir -p tmp/release-rehearsal
node tools/extension-signing/dist/cli.mjs generate-key \
  --key tmp/release-rehearsal/private.pem
node tools/extension-signing/dist/cli.mjs build \
  --source packages/extension/build/chrome \
  --key tmp/release-rehearsal/private.pem \
  --out tmp/release-rehearsal/signed \
  --base-url https://downloads.example.com/remote-tab/v0.1.23/ \
  > tmp/release-rehearsal/signing-result.json
node tools/ci/prepare-extension-release.mjs \
  --signing-result tmp/release-rehearsal/signing-result.json \
  --out tmp/extension-release
node tools/ci/assemble-release.mjs
rm -f tmp/release-rehearsal/private.pem
```

All rehearsal keys and outputs stay under ignored `tmp/`.

## Publish the tag

Create `v0.1.23` only from the reviewed default-branch commit. The release workflow refuses a tag
whose value differs from the compatibility manifest or changelog.

The workflow then:

1. Repeats the full source, package, design and Compose gate and produces source SBOMs.
2. Publishes the six reviewed npm tarballs. If a retry sees an existing version, it requires the npm
   integrity value to match the exact retained tarball before skipping it.
3. Builds and pushes only Signaling and Standalone, with immutable digests, SBOM/provenance metadata
   and digest-bound attestations.
4. Materializes the Extension key in a private temporary file, signs the built MV3 directory,
   verifies the fixed ID, creates release metadata and deletes the temporary key.
5. Assembles one checksum-covered asset set, attests it and creates the immutable GitHub Release.

The final source-release job runs only after all registry and Extension jobs succeed. It refuses to
replace an existing GitHub Release, so changed bytes require a new version and tag.

## Install the published packages

Applications embedding Core and the Viewer pin the exact coordinated version:

```bash
pnpm add \
  @browshare/remote-tab-core@0.1.23 \
  @browshare/remote-tab-protocol@0.1.23 \
  @browshare/remote-tab-client@0.1.23 \
  @browshare/remote-tab-viewer@0.1.23
```

Use the Extension contract or signing tool only when the integration owns those tasks:

```bash
pnpm add @browshare/remote-tab-extension@0.1.23
pnpm add --save-dev @browshare/remote-tab-extension-signing@0.1.23
```

Before using GHCR images, resolve and retain their digests. Tags aid discovery but are not the
rollback identity. The Standalone image still requires an operator-managed, compatible Chrome,
fixed-ID Extension, CDP endpoint and loopback policy.

For a complete single-host source deployment, follow the root
[`README.md`](../../README.md). For split roles and listener exposure, use
[Compose deployment](17-compose-deployment.md).

## Verify downloaded assets

Download the release assets into one directory and run:

```bash
shasum -a 256 -c SHA256SUMS
```

On Linux, use `sha256sum --check SHA256SUMS`. Then compare `compatibility.json` with live diagnostics:

```bash
set -a
. /opt/browshare/runtime.env
set +a
node deploy/compose/check-runtime.mjs \
  --manifest /opt/browshare/releases/0.1.23/compatibility.json
```

The check requires zero active Sessions, exact Core/Standalone `0.1.23`, Chrome
`152.0.7977.75`, coherent Extension `0.1.23` roles and protocol `1.4`.

## Upgrade and roll back

Never upgrade a live member of the compatibility tuple independently. Drain new work, reach zero
Sessions, snapshot the stopped Profile before a new Chrome opens it, replace the complete tuple,
run compatibility diagnostics and create/delete one real smoke Session before restoring assignment.

Rollback restores the previous image digests, Extension directory, compatibility manifest and—if
the candidate Chrome opened it—the pre-upgrade Profile snapshot. The full procedure and failure
boundaries are in [Coordinated upgrade and rollback](18-upgrade-and-rollback.md).

## Troubleshoot a release

Use the owning failure first:

| Symptom | First check | Do not do |
| --- | --- | --- |
| Tag preflight fails | `pnpm release:check --tag v0.1.23` | Do not edit only one package version |
| npm retry finds an existing version | Compare npm `dist.integrity` with the retained tarball | Do not overwrite an immutable npm version |
| GHCR image fails | Build the exact Signaling or Standalone target locally | Do not publish `chrome-node` |
| Extension ID differs | Verify the configured private key and expected ID | Do not rotate the key to make the job pass |
| CRX downloads but will not update | Inspect `updates.xml` codebase, version and HTTPS reachability from Chrome | Do not expose loopback services publicly |
| Runtime reports mismatched roles | Restart Chrome after the policy update and rerun diagnostics | Do not admit Sessions with one old Extension role |
| Live compatibility fails | Compare the complete tuple and require zero Sessions | Do not accept a partial upgrade |
| Viewer connects without media | Inspect selected ICE route and TURN health | Do not route media through Gateway |

Operational metrics and incident order are in
[Operations metrics, alerts and runbook](16-operations-runbook.md). Security assumptions and the
independent candidate review are in
[Release-candidate security review](21-release-candidate-security-review.md).
The historical 0.1.14 baseline and subsequent local release-preparation evidence are recorded in
[First stable release candidate record](23-first-stable-release-candidate.md). Current changed-path
Chrome acceptance is recorded with its exact versions in [Testing](08-testing.md); historical
results do not establish hosted publication of this candidate.
