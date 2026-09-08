#!/usr/bin/env bash
set -euo pipefail

# CN contains the CJK glyphs absent from the Latin-only Maple Mono release.
# Keep the release and digest together; do not resolve a mutable "latest" asset at build time.
archive_url=https://github.com/subframe7536/maple-font/releases/download/v7.9/MapleMono-CN.zip
archive_sha256=cb1e79b2c23dff772ae351784ef2b84454a61b3920e9b20bd5db4bf207e4472d
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl --fail --show-error --silent --location "$archive_url" --output "$work/font.zip"
echo "$archive_sha256  $work/font.zip" | sha256sum --check --strict
unzip -q -j "$work/font.zip" \
  MapleMono-CN-Regular.ttf MapleMono-CN-Bold.ttf \
  MapleMono-CN-Italic.ttf MapleMono-CN-BoldItalic.ttf LICENSE.txt -d "$work"
install -d -m 0755 /usr/local/share/fonts/maple-mono-cn /usr/share/doc/maple-mono-cn
install -m 0644 "$work/"*.ttf /usr/local/share/fonts/maple-mono-cn/
install -m 0644 "$work/LICENSE.txt" /usr/share/doc/maple-mono-cn/LICENSE.txt
fc-cache --force /usr/local/share/fonts/maple-mono-cn
