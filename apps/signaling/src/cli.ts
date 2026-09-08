#!/usr/bin/env node

import { timingSafeEqual } from 'node:crypto'

import { HmacViewerTicketCodec } from '@browshare/remote-tab-protocol'

import { loadSignalingProcessConfiguration } from './configuration.js'
import { SignalingGateway, SignalingMetricsServer } from './index.js'

try {
  const configuration = loadSignalingProcessConfiguration()
  const ticketCodec = new HmacViewerTicketCodec({
    secret: configuration.viewerTickets.secret,
    issuer: configuration.viewerTickets.issuer,
    audience: configuration.viewerTickets.audience,
  })
  const gateway = new SignalingGateway({
    configuration: {
      gatewayId: configuration.gatewayId,
      host: configuration.host,
      port: configuration.port,
      publicEndpoint: configuration.publicEndpoint,
      pairingTimeoutMs: configuration.pairingTimeoutMs,
      maxMessageBytes: configuration.maxMessageBytes,
      maxPendingPairs: configuration.maxPendingPairs,
      maxConnections: configuration.maxConnections,
      maxConnectionsPerIp: configuration.maxConnectionsPerIp,
      messageRateWindowMs: configuration.messageRateWindowMs,
      maxMessagesPerWindow: configuration.maxMessagesPerWindow,
      maxConsumedTickets: configuration.maxConsumedTickets,
      iceTransportPolicy: configuration.iceTransportPolicy,
    },
    viewerTicketVerifier: {
      async verifyViewerTicket(ticket) {
        return { claims: await ticketCodec.verify(ticket) }
      },
    },
    coreBindingAuthorizer: {
      async authorizeCoreBinding({ bindingToken, gatewayId }) {
        return gatewayId === configuration.gatewayId && safeEqual(
          bindingToken,
          configuration.coreBindingToken,
        )
      },
    },
    iceServerProvider: {
      async getIceServers() {
        return configuration.iceServers
      },
    },
    onDiagnostic(event) {
      process.stdout.write(`${JSON.stringify({ source: 'signaling', ...event })}\n`)
    },
  })
  const address = await gateway.start()
  const metricsServer = new SignalingMetricsServer({
    host: configuration.metricsHost,
    port: configuration.metricsPort,
    getMetrics: () => gateway.getMetrics(),
  })
  let metricsAddress
  try {
    metricsAddress = await metricsServer.start()
  } catch (cause) {
    await gateway.close()
    throw cause
  }
  process.stdout.write(
    `${JSON.stringify({ source: 'signaling', type: 'ready', gatewayId: configuration.gatewayId, address, metricsAddress, publicEndpoint: configuration.publicEndpoint })}\n`,
  )
  const metricsTimer = setInterval(() => {
    process.stdout.write(
      `${JSON.stringify({ source: 'signaling', type: 'capacity.snapshot', ...gateway.getMetrics() })}\n`,
    )
  }, configuration.metricsIntervalMs)
  metricsTimer.unref()

  let stopping = false
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) return
    stopping = true
    clearInterval(metricsTimer)
    void Promise.all([gateway.close(), metricsServer.close()])
      .then(() => process.exit(0))
      .catch((cause: unknown) => {
        process.stderr.write(
          `${JSON.stringify({ source: 'signaling', type: 'shutdown.failed', signal, message: safeMessage(cause) })}\n`,
        )
        process.exit(1)
      })
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
} catch (cause) {
  process.stderr.write(
    `${JSON.stringify({ source: 'signaling', type: 'startup.failed', message: safeMessage(cause) })}\n`,
  )
  process.exitCode = 1
}

function safeEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

function safeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Unknown signaling failure'
}
