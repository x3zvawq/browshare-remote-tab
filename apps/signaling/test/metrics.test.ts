import { afterEach, describe, expect, it } from 'vitest'

import {
  SignalingMetricsServer,
  renderSignalingPrometheusMetrics,
  type SignalingGatewayMetrics,
} from '../src/index.js'

const servers: SignalingMetricsServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

describe('Signaling Prometheus metrics', () => {
  it('renders a low-cardinality Prometheus endpoint and liveness route', async () => {
    const snapshot: SignalingGatewayMetrics = {
      connectionsActive: 2,
      connectionsAcceptedTotal: 11,
      connectionsRejectedTotal: 1,
      messagesReceivedTotal: 30,
      messageBytesReceivedTotal: 4_096,
      messagesRelayedTotal: 20,
      rateLimitedConnectionsTotal: 1,
      peersBound: 2,
      pairsTracked: 1,
      pairsCompletedTotal: 4,
      pairsExpiredTotal: 1,
      consumedTickets: 4,
      maximumConnections: 100,
      maximumPendingPairs: 50,
      maximumConsumedTickets: 500,
    }
    const server = new SignalingMetricsServer({
      host: '127.0.0.1',
      port: 0,
      getMetrics: () => snapshot,
    })
    servers.push(server)
    const address = await server.start()
    const baseUrl = `http://127.0.0.1:${address.port}`

    const metrics = await fetch(`${baseUrl}/metrics`)
    expect(metrics.status).toBe(200)
    expect(metrics.headers.get('content-type')).toContain('text/plain; version=0.0.4')
    const body = await metrics.text()
    expect(body).toContain('# TYPE browshare_remote_tab_signaling_connections_active gauge')
    expect(body).toContain('browshare_remote_tab_signaling_connections_active 2')
    expect(body).toContain('browshare_remote_tab_signaling_connections_accepted_total 11')
    expect(body).toContain('browshare_remote_tab_signaling_pairs_max 50')
    expect(body).not.toContain('{session')

    await expect(fetch(`${baseUrl}/health/live`).then((response) => response.text())).resolves.toBe(
      'ok\n',
    )
    expect((await fetch(`${baseUrl}/unknown`)).status).toBe(404)
    expect(renderSignalingPrometheusMetrics(snapshot)).toBe(body)
  })
})
