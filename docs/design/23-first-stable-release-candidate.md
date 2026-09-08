# First stable release candidate record

> [!IMPORTANT]
> The current coordinated candidate is `0.1.23` / protocol `1.4`. Source publication, hosted CI
> and the current real-browser matrix are complete; npm, GHCR and official fixed-ID Extension
> publication remain pending. The `0.1.14` and `0.1.15` sections preserve historical evidence.

## Current public candidate — 2026-09-08

Source commit `968a66092edff2de72f36055ec97a08c4b473f47` is publicly available from
[`x3zvawq/browshare-remote-tab`](https://github.com/x3zvawq/browshare-remote-tab/tree/968a66092edff2de72f36055ec97a08c4b473f47).
[Its hosted CI](https://github.com/x3zvawq/browshare-remote-tab/actions/runs/34225368970)
passed source/package/Compose checks, all three container targets, GitHub provenance and the
aggregate gate. The received candidate passed its 19 checksum/subject checks; the received
Client tarball passed GitHub attestation verification for that exact source and workflow.

The corrected Client, unchanged Viewer and Protocol entries in the received packages are
byte-identical to those used in the current four-Session Direct, forced TURN/UDP, TURN/TCP,
TURN/TLS and Chrome/Edge/Safari/Firefox acceptance. Runtime Chrome remains
`152.0.7977.75`, managed signed Extension `0.1.23` and protocol `1.4`. Exact browser versions,
runtime source, Safari transport inference and original failures are retained in
[the current compatibility result](08-testing.md#final-corrected-client-compatibility-result-2026-09-08).
All Gate Sessions, owned targets, local browsers and temporary runtime services were cleaned up.

Source publication is complete. The three remaining external-publication items require the
confirmed npm scope and package trusted publishers, an official persistent Extension signing
identity, the reviewed version-tag workflow and receiver verification of the published bytes.
QA signing identities are not official publisher identities. The release workflow has not been
triggered, and no npm, GHCR or official CRX release is claimed here. Follow
[First stable release and installation](22-first-stable-release.md) for that remaining sequence.

## Historical 0.1.14 local candidate

On 2026-09-04, the coordinated Remote Tab source, package, service-image and downloadable-asset
paths completed their final local and isolated-Linux rehearsal. The accepted compatibility tuple is
Google Chrome Stable `152.0.7977.75`, Extension `0.1.14`, Core and Standalone `0.1.14`, and control
protocol `1.0`.

## Accept the candidate

The candidate is ready for a first hosted CI run and external publishing configuration. The source
contract, package metadata, release workflow, Chrome-free service images, temporary-key Extension
assembly, SBOMs, license inventory and checksum-covered release directory agree on version
`0.1.14`.

External publication remains intentionally separate. The repository has no initial commit, the
official Extension private key was not used, and no registry or GitHub Release was modified during
this rehearsal.

## Reproduce the final source gates

Run these commands from the repository root:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm release:check --tag v0.1.14
pnpm check
npx --yes @google/design.md@0.4.0 lint docs/DESIGN.md
actionlint .github/workflows/ci.yml .github/workflows/release.yml
```

The final run completed 17 test files and 73 tests, built every package and application, passed
`publint` for all six public packages, accepted 10 coordinated package versions and three runtime
version sources, and reported no design or workflow error.

## Verify the Linux service images

The two release targets were built from a clean source transfer on an isolated Linux
`6.8.0-48-generic` x86_64 host with Docker `29.1.3`:

| Target | Local image result | Runtime contract |
| --- | --- | --- |
| Signaling | `sha256:06cc15a40a8821ce046b791ec8dbbc19da8eb7cf3b85822cb65c90de1d85840e` | Runs as `node` through `tini`; liveness returned `ok` |
| Standalone | `sha256:506bd14ba26c6120d13262609670ad12e89dc4dc867a7e2ea439252d1e4d16d6` | Runs as `node` through `tini`; liveness returned `status: ok` |

Standalone was deliberately started without Chrome or an Extension. It returned `503 not-ready`
with CDP and both Extension roles disconnected while its authenticated diagnostics still reported
Standalone `0.1.14`, Core `0.1.14` and protocol `1.0`. This is the expected application-only image
boundary: an operator or BrowShare Worker supplies the compatible Chrome runtime.

Both temporary containers were removed after the probe. The locally built images were retained on
the authorized test host as reproducible evidence and were not pushed to a registry.

## Assemble the downloadable assets

Syft `1.51.1` regenerated the source bundle after the final source edits. The verified result
contains:

| Artifact set | Verified result |
| --- | --- |
| Public npm packages | Six `0.1.14` tarballs with package-specific README files |
| Source checksums and provenance | 19 checksum entries and 19 in-toto subject records |
| CycloneDX SBOM | 165 components |
| SPDX SBOM | 162 packages |
| Dependency licenses | 4 production and 80 development package records |
| Extension rehearsal | CRX3, update manifest, managed policy and metadata from a disposable key |
| Final release directory | 22 checksum-covered assets, including six npm tarballs |

The disposable signing key and all generated evidence remain under ignored `tmp/`. The official
release job must materialize its configured key only inside the signing job and must reject an
Extension ID that differs from `BROWSHARE_EXTENSION_ID`.

## Trace evidence to the release path

| Evidence | Finding | Path |
| --- | --- | --- |
| `pnpm check` and `pnpm release:check --tag v0.1.14` passed | Source, public exports and coordinated versions form one candidate | Permit the hosted source gate to run from the exact reviewed tag |
| Both Chrome-free Docker targets built and started on Linux | Published service images do not need or redistribute Google Chrome | Push only Signaling and Standalone; operators build Chrome-node locally |
| Standalone reported exact application/protocol versions while browser checks remained unavailable | The image exposes honest readiness rather than concealing a missing browser runtime | Require live compatibility diagnostics before a Worker admits Sessions |
| Six tarballs, two SBOM formats, license inventory and final checksums verified | Downloadable inputs are enumerable and integrity-checkable | Publish immutable bytes and attest the retained manifest and image digests |
| Temporary CRX3 assembly verified ID, version, policy and update manifest coherence | The release-only signing boundary is executable without exposing the real key locally | Configure the official key and expected ID before pushing the tag |

## Complete external publication

The remaining release sequence is:

1. Create the first reviewed commit and confirm the hosted CI aggregate gate and retained artifact.
2. Configure npm trusted publishing for the six public packages.
3. Configure the official Extension private key and expected fixed ID.
4. Push the reviewed `v0.1.14` tag.
5. Confirm npm provenance, the two GHCR digests and attestations, the official CRX asset set and the
   immutable GitHub Release.
6. Install the published tuple on a clean node and run the real Chrome compatibility smoke before
   marking the four external publication items complete.

Publishing and installation commands are defined in
[First stable release and installation](22-first-stable-release.md). Release security assumptions
remain in [Release-candidate security review](21-release-candidate-security-review.md).

## 0.1.15 managed cold-start follow-up — 2026-09-05

The current source candidate is 0.1.15. It fixes the service worker's first-install Managed Storage
race without changing wire protocol 1.0, the Extension ID or the Chrome version. The 0.1.14 records
above remain historical evidence; the new version has not been externally published.

Two fresh Worker-managed Chrome Profiles completed Extension force-install, both runtime roles,
unattended tab capture and real WebRTC publisher offer creation during their first Chrome process.
Worker bootstrap and capability refresh use isolated temporary Chrome runtimes. A refresh left both
persistent Profiles available; stop, crash and new-generation restart were exercised separately.
The full four-Viewer direct/TURN test above remains the 0.1.14 baseline, not a new 0.1.15 claim.

The 0.1.15 source passed all package typechecks, 17 existing test files/74 tests, workspace build,
six public export checks, compatibility and release metadata gates. The new ignored
`tmp/profile-runtime-015/` contains six npm tarballs, the fixed-ID candidate CRX, SBOMs, 19 source
checksum/provenance subjects and a 22-asset checksum-verified release directory. The signing key is
still the existing local test key; public registry, official signing and source publication remain
pending. Runtime evidence is under BrowShare's ignored `tmp/profile-runtime-qa/`.

## Historical 0.1.23 working-tree release preparation — 2026-09-08

At this preparation stage the candidate was an unpublished working tree: no Git commit, remote,
release tag or hosted run had been created. The current public candidate section above supersedes
that source-publication status; the following results retain their original proof scope.
Current versions are coordinated at 0.1.23 with protocol 1.4 and Google Chrome Stable
152.0.7977.75. Current changed-path Chrome results are recorded in [Testing](08-testing.md).

The local release gate passed all workspace typechecks, 19 existing test files / 83 tests,
compatibility validation, complete builds and all six public export checks. Two stale test fixtures
were corrected during this run: the Extension sender now supplies real encoding parameter shape
and waits for asynchronous suspension; the Core signaling fixture installs its inbox during the
connection callback so `core.bind` cannot arrive before observation after Ticket/file cleanup.
Neither correction changes production behavior or increases test timeouts. The initial failing
runs are retained with the successful gate in ignored `tmp/release-readiness-023/`.

Actionlint 1.7.7 accepted both workflows; the pinned design linter reported zero errors/warnings;
all three Compose graphs resolved using the existing example environment directly. CI no longer
creates an environment copy outside `tmp/`, and the release workflow removes its temporary signing
key even if signing or fixed-ID validation fails. No Docker daemon was available locally, so this
run does not claim new container build/start evidence or replace the hosted container gate.

Fresh candidate artifacts contain six npm archives (including MIT licenses), 165 CycloneDX
components, 162 SPDX packages, 4 production / 80 development license records, and 19 verified source
checksum/provenance subjects. Syft 1.51.1 produced both SBOM formats. The provenance is explicitly a
local build record without a Git revision or hosted signature. A disposable RSA key exercised CRX3,
update manifest, fixed-ID checking and 22-asset release assembly; mismatched Extension ID was
rejected. The disposable private key was removed. These local bytes are reviewable rehearsal
artifacts, not the official fixed-ID Extension or publicly downloadable release.

The user subsequently confirmed `x3zvawq/browshare-remote-tab` as the source repository on
2026-09-08. GitHub reports the public repository as empty; local `origin` and all six public package
manifests now reference its exact URL and package directories. The paired BrowShare repository is
`x3zvawq/browshare`. This supplies the identity required by
[First stable release and installation](22-first-stable-release.md), but no commit or push was made.
The release gate checks exact URL case and directory whenever `GITHUB_REPOSITORY` or `--repository`
is supplied, so hosted publication fails before npm/GHCR/signing when metadata is mismatched.
An isolated copied-manifest fixture proved missing metadata and case mismatch rejection and a
matching configuration passing; its placeholder repository is not copied into product manifests.
A local gate without that identity explicitly reports the repository check as not performed.

The real `--repository x3zvawq/browshare-remote-tab` gate now passes. All six freshly packed npm
archives were inspected and contain the exact repository URL, package directory and coordinated
version. These are local archives; no npm publication or Git commit was performed.

At that stage four external publication checkboxes remained unchecked. Their remaining boundary was a reviewed
source commit/tag and trusted publishers, successful hosted gates,
GHCR digests/attestations, official signing identity, immutable external release assets and clean-node
installation of those published bytes. No local artifact assembly substitutes for those results.
