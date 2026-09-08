import { readFileSync } from 'node:fs'

import { defineConfig } from 'tsdown'

interface ChromeExtensionManifest {
  version: string
}

const manifest = JSON.parse(
  readFileSync(new URL('./extension/manifest.json', import.meta.url), 'utf8'),
) as ChromeExtensionManifest

if (!/^\d+(?:\.\d+){0,3}$/u.test(manifest.version)) {
  throw new TypeError('Chrome extension manifest version is invalid')
}

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: 'esm',
    platform: 'neutral',
    dts: true,
    outDir: 'dist',
    clean: true,
    outExtensions: () => ({ js: '.mjs', dts: '.d.mts' }),
  },
  {
    entry: {
      'service-worker': 'src/service-worker.ts',
      offscreen: 'src/offscreen.ts',
    },
    format: 'esm',
    platform: 'browser',
    target: 'chrome136',
    dts: false,
    outDir: 'build/chrome',
    clean: true,
    hash: false,
    define: {
      __BROWSHARE_EXTENSION_VERSION__: JSON.stringify(manifest.version),
    },
    outExtensions: () => ({ js: '.js' }),
    deps: {
      alwaysBundle: [
        /^@browshare\/remote-tab-protocol(?:\/|$)/u,
        /^@msgpack\/msgpack(?:\/|$)/u,
        /^typebox(?:\/|$)/u,
      ],
      onlyBundle: [/^@msgpack\/msgpack$/u, /^typebox$/u],
    },
    copy: [{ from: 'extension/*', to: 'build/chrome', flatten: true }],
  },
])
