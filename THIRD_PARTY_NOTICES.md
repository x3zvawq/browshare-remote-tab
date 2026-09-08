# Third-party notices

BrowShare Remote Tab source code is released under the MIT License in [`LICENSE`](LICENSE). Its
runtime and development dependencies remain under their respective licenses; the build produces a
machine-readable `dependency-licenses.json` from the installed lockfile and source/image SBOMs for
the exact release candidate.

Public npm packages do not bundle their external dependencies. Public Signaling and Standalone
images preserve the dependency package metadata and license files installed with those packages.
Operators should use the release SBOM and dependency-license report as the inventory for a specific
build rather than treating this prose file as a frozen dependency list.

## Google Chrome Stable

Google Chrome Stable is proprietary third-party software and is not covered by this repository's
MIT License. Google states that its Chrome additional terms apply to executable versions and its
general software license is personal and non-transferable and prohibits distribution of the
software. Accordingly, BrowShare does not publish a container image, archive, or package containing
the Chrome executable or `.deb` package.

The `chrome-node` Docker target is source-only deployment tooling. An operator who chooses that
target downloads the exact Google-hosted `.deb` during their own build, verifies its pinned SHA-256
and accepts responsibility for the applicable terms. Ordinary CI may build and scan that target in
an ephemeral runner, but must not upload or publish its image layers.

Official terms reviewed for this engineering boundary:

- [Google Chrome and ChromeOS Additional Terms of Service](https://www.google.com/chrome/terms/)
- [Google Terms of Service](https://policies.google.com/terms)

The public container release set is therefore limited to application-only images that do not
contain Google Chrome: `remote-tab-signaling` and `remote-tab-standalone`.
