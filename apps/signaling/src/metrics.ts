import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { SignalingGatewayMetrics } from './index.js'

export interface SignalingMetricsServerOptions {
  host: string
  port: number
  getMetrics(): SignalingGatewayMetrics
}

export interface SignalingMetricsAddress {
  host: string
  port: number
}

const METRICS = [
  ['connectionsActive', 'connections_active', 'gauge', 'Current accepted WebSocket connections.'],
  ['connectionsAcceptedTotal', 'connections_accepted_total', 'counter', 'Accepted WebSocket connections.'],
  ['connectionsRejectedTotal', 'connections_rejected_total', 'counter', 'WebSocket connections rejected by capacity limits.'],
  ['messagesReceivedTotal', 'messages_received_total', 'counter', 'Signaling messages received.'],
  ['messageBytesReceivedTotal', 'message_bytes_received_total', 'counter', 'Signaling message bytes received.'],
  ['messagesRelayedTotal', 'messages_relayed_total', 'counter', 'Signaling messages relayed to a paired peer.'],
  ['rateLimitedConnectionsTotal', 'rate_limited_connections_total', 'counter', 'Connections closed by the message rate limit.'],
  ['peersBound', 'peers_bound', 'gauge', 'Currently authenticated signaling peers.'],
  ['pairsTracked', 'pairs_tracked', 'gauge', 'Current Session-generation pairing records.'],
  ['pairsCompletedTotal', 'pairs_completed_total', 'counter', 'Completed Core and Viewer pairings.'],
  ['pairsExpiredTotal', 'pairs_expired_total', 'counter', 'Pairings that expired before both peers arrived.'],
  ['consumedTickets', 'consumed_tickets', 'gauge', 'Unexpired consumed Viewer Ticket replay records.'],
  ['maximumConnections', 'connections_max', 'gauge', 'Configured connection capacity.'],
  ['maximumPendingPairs', 'pairs_max', 'gauge', 'Configured pairing-record capacity.'],
  ['maximumConsumedTickets', 'consumed_tickets_max', 'gauge', 'Configured consumed-Ticket replay capacity.'],
] as const satisfies readonly [keyof SignalingGatewayMetrics, string, 'counter' | 'gauge', string][]

export function renderSignalingPrometheusMetrics(metrics: SignalingGatewayMetrics): string {
  const lines: string[] = []
  for (const [property, suffix, type, help] of METRICS) {
    const name = `browshare_remote_tab_signaling_${suffix}`
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, `${name} ${metrics[property]}`)
  }
  return `${lines.join('\n')}\n`
}

export class SignalingMetricsServer {
  readonly #options: SignalingMetricsServerOptions
  #server: Server | undefined

  public constructor(options: SignalingMetricsServerOptions) {
    if (options.host.length === 0) throw new TypeError('Metrics host must not be empty')
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
      throw new RangeError('Metrics port must be an integer from 0 through 65535')
    }
    this.#options = options
  }

  public async start(): Promise<SignalingMetricsAddress> {
    if (this.#server !== undefined) throw new Error('Metrics server is already started')
    const server = createServer((request, response) => {
      response.setHeader('cache-control', 'no-store')
      response.setHeader('x-content-type-options', 'nosniff')
      if (request.method === 'GET' && request.url === '/health/live') {
        sendText(response, 200, 'text/plain; charset=utf-8', 'ok\n')
        return
      }
      if (request.method === 'GET' && request.url === '/metrics') {
        sendText(
          response,
          200,
          'text/plain; version=0.0.4; charset=utf-8',
          renderSignalingPrometheusMetrics(this.#options.getMetrics()),
        )
        return
      }
      sendText(response, 404, 'text/plain; charset=utf-8', 'not found\n')
    })
    this.#server = server
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve)
        server.once('error', reject)
        server.listen(this.#options.port, this.#options.host)
      })
    } catch (cause) {
      this.#server = undefined
      throw cause
    }
    const address = server.address() as AddressInfo
    return { host: address.address, port: address.port }
  }

  public async close(): Promise<void> {
    const server = this.#server
    if (server === undefined) return
    this.#server = undefined
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)))
      server.closeAllConnections()
    })
  }
}

function sendText(
  response: import('node:http').ServerResponse,
  status: number,
  contentType: string,
  body: string,
): void {
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}
