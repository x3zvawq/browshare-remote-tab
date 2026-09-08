# Supply-chain artifacts and provenance

> [!IMPORTANT]
> A checksum proves bytes match a referenced value; it does not prove who produced them. The local
> in-toto build record describes inputs and subjects but is not a signature. Trust for a hosted build
> comes from the separate GitHub OIDC provenance attestation. Trust for a published container comes
> from its immutable registry digest, Buildx provenance and digest-bound release attestation.

Remote Tab produces reviewable npm tarballs, unpacked Extension files, container images, two source
SBOM formats, container SBOMs, checksums and provenance metadata without giving ordinary CI any
publication secret.

## Artifact layers

| Layer | Format | Purpose |
| --- | --- | --- |
| Public packages | npm `.tgz` | Inspect the exact files that a later npm release will publish |
| Browser artifact | Unpacked MV3 directory | Inspect the Extension input before official CRX signing |
| Source dependency inventory | CycloneDX 1.7 JSON and SPDX 2.3 JSON | Track Node packages and licenses from the built workspace |
| Installed Node license inventory | Normalized JSON from `pnpm licenses list` | Fill the registry-license metadata that source Syft scans do not reliably enrich |
| Runtime dependency inventory | SPDX 2.3 JSON per image | Track Debian, Chrome, Node and application packages in each image |
| Integrity list | `SHA256SUMS` | Bind every retained source artifact and SBOM to exact bytes |
| Local build metadata | in-toto Statement v1 with SLSA provenance v1 predicate | Record compatibility inputs, builder identity and checksum subjects |
| Hosted provenance | GitHub artifact attestation | Bind `SHA256SUMS` subjects to a GitHub Actions run through OIDC |

The compatibility manifest remains the release tuple. The artifact index embeds it and records file
sizes; the checksum list covers the index, both SBOMs, dependency-license report, every tarball,
Extension file, license, third-party notices and manifest.

## Generate and verify locally

Install Syft `1.51.1` from its official release and verify the downloaded archive against the
release checksum file. Then run:

```bash
pnpm build
pnpm artifacts:bundle
```

The bundle command performs four stages:

1. Recreate `tmp/ci-artifacts`, pack the six public packages and normalize production/development
   dependency licenses from the installed lockfile without retaining machine-specific paths.
2. Generate CycloneDX and SPDX source SBOMs with `.syft.yaml` exclusions for `.git` and `tmp`.
3. Rebuild the artifact index, calculate sorted SHA-256 subjects and emit the local in-toto record.
4. Recompute every digest and require the build-record subjects and both SBOM schemas to agree.

The final verification output reports checksum and provenance-subject counts plus the component
counts parsed from both SBOMs. A path outside `tmp/`, duplicate checksum path, traversal path,
missing file, byte mismatch, malformed SBOM or subject mismatch fails explicitly.

Conventional checksum verification also works from the bundle directory:

```bash
cd tmp/ci-artifacts
sha256sum --check SHA256SUMS
```

On macOS use `shasum -a 256 -c SHA256SUMS`.

## Container SBOMs

CI loads the two locally built images, scans each with the same pinned Syft version and retains:

- `signaling.spdx.json`
- `standalone.spdx.json`
- `chrome-node.spdx.json`
- `SHA256SUMS` covering all three image SBOMs

The Chrome-node SBOM must contain `google-chrome-stable` at the exact package version in
`deploy/compatibility.json`. The source-manifest gate separately ensures the Dockerfile and both
Chrome Compose definitions name the same URL, digest and version.

Container SBOMs describe packages in the image; they do not prove which image digest was eventually
published. The GHCR release matrix enables Buildx SBOM and maximum provenance for each pushed
Signaling or Standalone image, then creates a GitHub attestation against the returned immutable
digest rather than only a mutable tag.

## Chrome redistribution boundary

The repository source and authored packages are MIT licensed. Google Chrome Stable is a proprietary
runtime and is not relicensed by this project. The current official Chrome additional terms say they
apply to executable versions, while the linked Google software terms grant a personal,
non-transferable license and prohibit distributing the software. The engineering release policy is
therefore fail-closed:

- Never publish `chrome-node`, the Chrome `.deb`, or any archive/image layer containing Chrome.
- Publish only the Chrome-free Signaling and Standalone application images.
- Keep `chrome-node` as a reproducible Dockerfile target that downloads the exact package from
  Google's host during the operator's own build and verifies its version and SHA-256.
- CI may build and scan Chrome-node ephemerally, but retained artifacts contain only its SBOM—not
  the proprietary image or package.

This policy is recorded in [third-party notices](../../THIRD_PARTY_NOTICES.md). A future explicit
redistribution grant from Google may change the release policy; absence of such a grant may not be
treated as permission.

## License metadata

Syft's source scan identifies lockfile components but, without registry enrichment, many entries do
not contain license metadata. That is an inventory limitation rather than evidence that those
packages are unlicensed. `dependency-licenses.json` is generated from installed package manifests
through `pnpm licenses list`, strips absolute paths, separates production from development scope and
is covered by the artifact checksum and provenance subjects. Verification rejects missing license
values and duplicate package-version identities.

Container OS packages use their own licenses, including GPL/LGPL and multi-license combinations.
Those licenses do not change the license of BrowShare source, but a public image must preserve the
package metadata and notice files carried by its Debian and Node layers. The release security record
must review any remaining `NOASSERTION` values rather than claiming that SBOM detection establishes
license compliance.

## GitHub provenance

Pull requests run with repository read permission and do not request an OIDC token. On a `main` push
or manual run, the dedicated `attest` job:

1. Depends on the completed source artifact job.
2. Downloads the commit-specific retained bundle.
3. Reads subjects from `SHA256SUMS`.
4. Uses GitHub OIDC with `attestations: write` to issue build provenance.

The aggregate gate requires this job to be skipped on pull requests and successful on non-PR runs.
The attestation job receives no npm token, container registry password, Extension private key,
runtime bearer token or Profile data.

## Verify a hosted bundle

After the first GitHub-hosted run, download the commit-specific artifact and verify its checksums.
Use GitHub CLI attestation verification against the repository identity:

```bash
repository="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
gh attestation verify tmp/ci-artifacts/npm/*.tgz \
  --repo "$repository"
```

Repeat verification for the Extension files and SBOMs named in `SHA256SUMS`. The command resolves
the actual GitHub owner and repository instead of hard-coding an unpublished remote.

## Security boundaries

- Official Extension signing happens only in a release job with its private key, never in ordinary CI.
- npm and GHCR publication use separate least-privilege jobs; GHCR is limited to Chrome-free
  Signaling and Standalone targets.
- SBOM findings require reachability and deployment-context review; a version match alone is not a
  vulnerability proof.
- `.syft.yaml` excludes ignored evidence and Git internals, not installed production dependencies.
- Action sources, Node, pnpm, Syft, Chrome and the design linter are pinned independently.
- Runtime images install available Debian security updates and remove npm, Corepack and Yarn after
  the application has been copied; those build tools are not part of the service runtime contract.
- A failed checksum, attestation or compatibility check blocks the release tuple; it is never
  downgraded to a warning.

The CI topology is documented in [CI and release-candidate gates](19-ci-and-release-gates.md). The
full runtime tuple and restore path are documented in
[Coordinated upgrade and rollback](18-upgrade-and-rollback.md).
