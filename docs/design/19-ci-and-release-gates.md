# CI and release-candidate gates

The CI workflow validates every pull request, every push to `main` and an explicit manual run. The
separate release workflow accepts only a `v<major>.<minor>.<patch>` tag or a manual run whose selected
ref is that exact tag. Ordinary CI never receives publication credentials.

The completed white-box runtime review, fixed findings and independent clean deployment are recorded
in [Release-candidate security review](21-release-candidate-security-review.md). The release
workflow preserves those listener, credential, Origin, replay and log boundaries and is documented
in [First stable release and installation](22-first-stable-release.md).

## Required jobs

| Job | Owns | Successful evidence |
| --- | --- | --- |
| Source, packages, docs and Compose | TypeScript, tests, compatibility manifest, builds, exports, Viewer design rules and Compose parsing | `pnpm check`, design lint and three resolved Compose graphs |
| Container targets | Signaling, application-only Standalone and pinned Chrome-node Docker targets | All three Docker build targets complete without pushing |
| Merge and release-candidate gate | Aggregated admission decision | Both owning jobs report `success` |

The final gate uses `if: always()` and checks dependency results explicitly. A cancelled, skipped or
failed owning job therefore cannot make the aggregate job green.

## Retained artifacts

After a successful workspace build, `tools/ci/prepare-artifacts.mjs` creates an ignored
`tmp/ci-artifacts` directory containing:

- Six npm tarballs for the public library and signing-tool packages.
- The complete unpacked built Chrome Extension.
- The machine-readable compatibility manifest.
- CycloneDX and SPDX source SBOMs.
- A normalized production/development dependency-license report.
- The MIT license, third-party notices, a JSON artifact index, `SHA256SUMS` and an in-toto/SLSA build record.

GitHub retains this bundle for 14 days under a commit-specific artifact name. A missing bundle makes
the upload step fail. These files are review evidence, not signed release artifacts: the official
CRX key is never available to ordinary CI, and no package is published from this workflow.

Run the same preparation locally after `pnpm build` with Syft `1.51.1` on `PATH`:

```bash
pnpm artifacts:bundle
```

The preparation, finalization and verification scripts only accept an artifact directory below the
repository's ignored `tmp/` tree. This keeps deterministic cleanup and checksum traversal from
targeting source or operator data.

## Supply-chain boundary

Every external GitHub Action is pinned to the exact commit currently associated with its declared
major release. Node.js and pnpm are exact versions, the design linter is pinned to `0.4.0`, and the
Chrome image still verifies the exact `.deb` digest from the compatibility manifest.

The Chrome-node target is an ephemeral build-and-scan input only. CI never uploads its image layers,
and a release workflow must not push it to GHCR because Google Chrome is not part of the MIT-licensed
project. Only the Chrome-free Signaling and Standalone targets are public-image candidates. An
operator builds Chrome-node locally, causing that operator's build to download the pinned `.deb`
from Google.

CI Buildx uses a GitHub cache scope but does not push an image. Workflow permissions are read-only
at the repository level. Non-PR runs download the retained artifact in a separate job with only
`id-token: write` and `attestations: write`, then create a GitHub-hosted provenance attestation from
`SHA256SUMS`.

The release workflow grants `packages: write` only to the Signaling/Standalone image matrix, uses
npm trusted publishing only in the npm job, materializes the Extension private key only in the
signing job, and grants `contents: write` only to the final source-release job. The two images embed
Buildx SBOM/provenance metadata and receive digest-bound GitHub attestations. No release job builds
or pushes `chrome-node`.

## Reproduce a failure

Run the smallest owning command first:

| Failure | Local command |
| --- | --- |
| Type, test, build or export | `pnpm check` |
| Compatibility drift | `pnpm check:compatibility` |
| Design-system drift | `npx --yes @google/design.md@0.4.0 lint docs/DESIGN.md` |
| Compose interpolation | `REMOTE_TAB_ENV_FILE=runtime.env.example docker compose -f deploy/compose/compose.all-in-one.yml config --quiet` |
| Artifact packaging, SBOM and hashes | `pnpm artifacts:bundle` |
| Workflow syntax and expressions | `actionlint .github/workflows/*.yml` |
| Signaling container | `docker build --target signaling -f deploy/docker/Dockerfile .` |
| Standalone container | `docker build --target standalone -f deploy/docker/Dockerfile .` |
| Chrome-node container | `docker build --target chrome-node -f deploy/docker/Dockerfile .` |

Do not rerun the aggregate gate to conceal a deterministic owning-job failure. Fix the source,
manifest, deployment input or workflow that owns the failed evidence.

## First hosted run

The repository currently has no initial commit, so this development pass cannot produce a genuine
GitHub-hosted run without violating the no-commit boundary. Before the first merge or release,
confirm the hosted CI workflow reports all owning jobs green and that the retained artifact can be
downloaded and inspected. Then configure npm trusted publishers, the two Extension secrets and
GHCR package visibility before pushing the coordinated tag from `deploy/compatibility.json` (currently `v0.1.23`). Local workflow linting, exact workspace gates,
artifact preparation, Compose resolution and all three real Linux container builds provide the
pre-push evidence.
