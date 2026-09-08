import { fileURLToPath } from 'node:url'

import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'tmp/**'],
  },
  resolve: {
    alias: {
      '@browshare/remote-tab-protocol': fileURLToPath(
        new URL('./packages/protocol/src/index.ts', import.meta.url),
      ),
      '@browshare/remote-tab-core': fileURLToPath(
        new URL('./packages/core/src/index.ts', import.meta.url),
      ),
      '@browshare/remote-tab-client': fileURLToPath(
        new URL('./packages/headless-client/src/index.ts', import.meta.url),
      ),
      '@browshare/remote-tab-viewer': fileURLToPath(
        new URL('./packages/viewer/src/index.ts', import.meta.url),
      ),
    },
  },
})
