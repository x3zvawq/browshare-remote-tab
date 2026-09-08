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

## Maple Mono CN

The source-build `chrome-node` target installs the unmodified Regular, Bold, Italic and Bold
Italic fonts from [Maple Mono CN v7.9](https://github.com/subframe7536/maple-font/releases/tag/v7.9),
by the Maple Mono Project Authors, under the SIL Open Font License 1.1. Its Chinese and Japanese
glyphs derive from Resource Han Rounded, as documented by upstream. The pinned archive SHA-256
is `cb1e79b2c23dff772ae351784ef2b84454a61b3920e9b20bd5db4bf207e4472d`.
The complete upstream copyright and license are installed at
`/usr/share/doc/maple-mono-cn/LICENSE.txt` alongside the runtime. Preserve these notices when
redistributing font files. The OFL permits bundling and redistribution with software, subject
to its terms, including retaining the license and not selling the fonts on their own. The
separate restriction on publishing Chrome-containing images remains unchanged.

The launcher sets Chrome's default standard, serif, sans-serif and fixed font families to Maple
Mono CN before starting Chrome. It preserves other Profile preferences and does not inject CSS
or replace a website's explicitly selected available font or web font. CJK support is substantial
but does not cover every Unicode character; other installed fonts remain available for fallback.
