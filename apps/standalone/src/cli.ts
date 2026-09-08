#!/usr/bin/env node

import { loadStandaloneConfiguration } from './configuration.js'
import { formatStandaloneDiagnostic } from './diagnostics.js'
import { StandaloneDaemon } from './server.js'

try {
  const configuration = loadStandaloneConfiguration()
  const daemon = new StandaloneDaemon(configuration, {
    onDiagnostic(event) {
      process.stdout.write(formatStandaloneDiagnostic(event))
    },
  })
  const address = await daemon.start()
  process.stdout.write(
    `${JSON.stringify({ source: 'standalone', type: 'ready', api: address })}\n`,
  )

  let stopping = false
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) return
    stopping = true
    void daemon
      .close(`Standalone daemon received ${signal}`)
      .then(() => process.exit(0))
      .catch((cause: unknown) => {
        process.stderr.write(
          `${JSON.stringify({ source: 'standalone', type: 'shutdown.failed', message: safeMessage(cause) })}\n`,
        )
        process.exit(1)
      })
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
} catch (cause) {
  process.stderr.write(
    `${JSON.stringify({ source: 'standalone', type: 'startup.failed', message: safeMessage(cause) })}\n`,
  )
  process.exitCode = 1
}

function safeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Unknown standalone failure'
}
