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

## Noto CJK

The Chrome image installs Debian's `fonts-noto-cjk` package, containing
[Noto CJK](https://github.com/notofonts/noto-cjk) fonts under the SIL Open Font License 1.1.
The package's copyright notices and complete license are retained at
`/usr/share/doc/fonts-noto-cjk/copyright`. Retain those notices when redistributing fonts;
Chrome's separate distribution conditions above still apply.

Chrome's standard and sans-serif defaults use Noto Sans CJK SC (proportional text), serif
uses Noto Serif CJK SC, and fixed-width content uses Noto Sans Mono CJK SC. The launcher
preserves unrelated Profile preferences. Available fonts selected explicitly by a website
and web fonts still take precedence; other installed fonts provide missing-glyph fallback.
Apple's PingFang font is not copied into the Linux image.
