import { describe, expect, it } from 'vitest'

import { loadSignalingProcessConfiguration } from '../src/index.js'

describe('Signaling process configuration', () => {
  it('loads a runnable static Gateway configuration from the environment', () => {
    const configuration = loadSignalingProcessConfiguration({
      BROWSHARE_REMOTE_TAB_GATEWAY_ID: 'gateway-1',
      BROWSHARE_REMOTE_TAB_GATEWAY_PUBLIC_ENDPOINT: 'wss://signal.example.test/remote-tab',
      BROWSHARE_REMOTE_TAB_VIEWER_TICKET_SECRET: 'viewer-ticket-secret-0123456789abcdef',
      BROWSHARE_REMOTE_TAB_CORE_BINDING_TOKEN: 'core-binding-token-0123456789abcdef0',
      BROWSHARE_REMOTE_TAB_ICE_TRANSPORT_POLICY: 'relay',
      BROWSHARE_REMOTE_TAB_ICE_SERVERS_JSON: JSON.stringify([
        { urls: ['turns:turn.example.test:5349'], username: 'user', credential: 'password' },
      ]),
    })

    expect(configuration).toMatchObject({
      gatewayId: 'gateway-1',
      host: '0.0.0.0',
      port: 8081,
      publicEndpoint: 'wss://signal.example.test/remote-tab',
      pairingTimeoutMs: 30_000,
      maxConnections: 20_000,
      maxConnectionsPerIp: 128,
      messageRateWindowMs: 60_000,
      maxMessagesPerWindow: 1_200,
      maxConsumedTickets: 100_000,
      metricsIntervalMs: 30_000,
      metricsHost: '127.0.0.1',
      metricsPort: 9090,
      iceTransportPolicy: 'relay',
      iceServers: [{ urls: ['turns:turn.example.test:5349'] }],
    })
  })

  it('rejects malformed ICE JSON and non-WebSocket public endpoints', () => {
    const base = {
      BROWSHARE_REMOTE_TAB_GATEWAY_ID: 'gateway-1',
      BROWSHARE_REMOTE_TAB_VIEWER_TICKET_SECRET: 'viewer-ticket-secret-0123456789abcdef',
      BROWSHARE_REMOTE_TAB_CORE_BINDING_TOKEN: 'core-binding-token-0123456789abcdef0',
    }
    expect(() =>
      loadSignalingProcessConfiguration({
        ...base,
        BROWSHARE_REMOTE_TAB_GATEWAY_PUBLIC_ENDPOINT: 'wss://signal.example.test/remote-tab',
        BROWSHARE_REMOTE_TAB_ICE_SERVERS_JSON: '{',
      }),
    ).toThrow(/must be valid JSON/u)
    expect(() =>
      loadSignalingProcessConfiguration({
        ...base,
        BROWSHARE_REMOTE_TAB_GATEWAY_PUBLIC_ENDPOINT: 'https://signal.example.test/',
      }),
    ).toThrow(/must use WebSocket/u)
  })
})
