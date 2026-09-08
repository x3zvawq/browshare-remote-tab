import WebSocket from 'ws'
import { describe, expect, it, vi } from 'vitest'

import {
  decodeSignalingMessage,
  encodeSignalingMessage,
  type SignalingMessage,
  type ViewerTicketClaims,
} from '@browshare/remote-tab-protocol'

import {
  SignalingGateway,
  type SignalingGatewayDiagnosticEvent,
} from '../src/index.js'

class MessageInbox {
  readonly #messages: SignalingMessage[] = []
  readonly #waiters: Array<(message: SignalingMessage) => void> = []

  public constructor(socket: WebSocket) {
    socket.on('message', (data) => {
      const message = decodeSignalingMessage(data.toString())
      const waiter = this.#waiters.shift()
      if (waiter === undefined) {
        this.#messages.push(message)
      } else {
        waiter(message)
      }
    })
  }

  public async next(): Promise<SignalingMessage> {
    const message = this.#messages.shift()
    if (message !== undefined) {
      return message
    }
    return new Promise((resolve) => this.#waiters.push(resolve))
  }
}

describe('SignalingGateway', () => {
  it('authenticates, pairs, relays only signaling, and prevents ticket replay', async () => {
    const claims: ViewerTicketClaims = {
      sessionId: 'session-1',
      viewerGeneration: 3,
      gatewayId: 'gateway-1',
      capabilities: ['navigation', 'diagnostics'],
      issuedAt: 900,
      expiresAt: 1_100,
      jti: 'ticket-1',
      issuer: 'test-issuer',
      audience: 'remote-tab-viewer',
    }
    const verifyViewerTicket = vi.fn(async (ticket: string) => {
      if (ticket !== 'viewer-ticket') {
        throw new Error('invalid')
      }
      return { claims }
    })
    const authorizeCoreBinding = vi.fn(async ({ bindingToken }: { bindingToken: string }) => {
      return bindingToken === 'core-token'
    })
    const diagnostics: SignalingGatewayDiagnosticEvent[] = []
    const gateway = new SignalingGateway({
      configuration: {
        gatewayId: 'gateway-1',
        host: '127.0.0.1',
        port: 0,
        publicEndpoint: 'ws://127.0.0.1',
        pairingTimeoutMs: 1_000,
        maxMessageBytes: 262_144,
        maxPendingPairs: 10,
        maxConnections: 20,
        maxConnectionsPerIp: 20,
        messageRateWindowMs: 60_000,
        maxMessagesPerWindow: 100,
        maxConsumedTickets: 100,
        iceTransportPolicy: 'relay',
      },
      viewerTicketVerifier: { verifyViewerTicket },
      coreBindingAuthorizer: { authorizeCoreBinding },
      iceServerProvider: {
        async getIceServers(role) {
          return [{ urls: [`stun:${role}.example.test:3478`] }]
        },
      },
      now: () => 1_000,
      onDiagnostic: (event) => diagnostics.push(event),
    })
    const address = await gateway.start()
    const endpoint = `ws://127.0.0.1:${address.port}`
    const core = await openWebSocket(endpoint)
    const viewer = await openWebSocket(endpoint)
    const coreInbox = new MessageInbox(core)
    const viewerInbox = new MessageInbox(viewer)

    try {
      core.send(
        encodeSignalingMessage({
          type: 'core.bind',
          bindingToken: 'core-token',
          sessionId: 'session-1',
          viewerGeneration: 3,
          gatewayId: 'gateway-1',
        }),
      )
      viewer.send(encodeSignalingMessage({ type: 'viewer.bind', ticket: 'viewer-ticket' }))

      await expect(coreInbox.next()).resolves.toMatchObject({
        type: 'signal.ready',
        role: 'core',
        sessionId: 'session-1',
        iceTransportPolicy: 'relay',
      })
      await expect(coreInbox.next()).resolves.toEqual({ type: 'signal.peer-ready' })
      await expect(viewerInbox.next()).resolves.toMatchObject({
        type: 'signal.ready',
        role: 'viewer',
        capabilities: ['navigation', 'diagnostics'],
        iceTransportPolicy: 'relay',
      })
      await expect(viewerInbox.next()).resolves.toEqual({ type: 'signal.peer-ready' })

      const offer: SignalingMessage = {
        type: 'signal.description',
        description: { type: 'offer', sdp: 'v=0\r\n' },
      }
      core.send(encodeSignalingMessage(offer))
      await expect(viewerInbox.next()).resolves.toEqual(offer)

      const answer: SignalingMessage = {
        type: 'signal.description',
        description: { type: 'answer', sdp: 'v=0\r\n' },
      }
      viewer.send(encodeSignalingMessage(answer))
      await expect(coreInbox.next()).resolves.toEqual(answer)

      const candidate: SignalingMessage = {
        type: 'signal.ice',
        candidate: {
          candidate: 'candidate:1 1 udp 1 203.0.113.7 49152 typ srflx',
          sdpMid: '0',
          sdpMLineIndex: 0,
        },
      }
      core.send(encodeSignalingMessage(candidate))
      await expect(viewerInbox.next()).resolves.toEqual(candidate)

      const iceRestart: SignalingMessage = { type: 'signal.restart-ice' }
      viewer.send(encodeSignalingMessage(iceRestart))
      await expect(coreInbox.next()).resolves.toEqual(iceRestart)

      const replacementError: SignalingMessage = {
        type: 'signal.error',
        error: {
          code: 'VIEWER_REPLACED',
          message: 'Viewer was replaced by a newer authorized connection',
          retryable: false,
        },
      }
      core.send(encodeSignalingMessage(replacementError))
      await expect(viewerInbox.next()).resolves.toEqual(replacementError)

      const replay = await openWebSocket(endpoint)
      const replayInbox = new MessageInbox(replay)
      replay.send(encodeSignalingMessage({ type: 'viewer.bind', ticket: 'viewer-ticket' }))
      await expect(replayInbox.next()).resolves.toMatchObject({
        type: 'signal.error',
        error: { code: 'VIEWER_TICKET_REPLAYED' },
      })
      replay.close()

      expect(verifyViewerTicket).toHaveBeenCalledTimes(2)
      expect(authorizeCoreBinding).toHaveBeenCalledWith({
        bindingToken: 'core-token',
        sessionId: 'session-1',
        viewerGeneration: 3,
        gatewayId: 'gateway-1',
      })
      expect(diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'pair.completed',
            sessionId: 'session-1',
            viewerGeneration: 3,
            coreIceServerCount: 1,
            viewerIceServerCount: 1,
          }),
          expect.objectContaining({
            type: 'description.relayed',
            fromRole: 'core',
            descriptionType: 'offer',
          }),
          expect.objectContaining({
            type: 'description.relayed',
            fromRole: 'viewer',
            descriptionType: 'answer',
          }),
          expect.objectContaining({
            type: 'ice.relayed',
            fromRole: 'core',
            candidateType: 'srflx',
            protocol: 'udp',
          }),
          expect.objectContaining({
            type: 'ice-restart.relayed',
            fromRole: 'viewer',
          }),
          expect.objectContaining({
            type: 'error.relayed',
            fromRole: 'core',
            code: 'VIEWER_REPLACED',
          }),
        ]),
      )
      expect(JSON.stringify(diagnostics)).not.toContain('203.0.113.7')
      expect(JSON.stringify(diagnostics)).not.toContain('viewer-ticket')
      expect(JSON.stringify(diagnostics)).not.toContain('v=0')
      expect(gateway.getMetrics()).toMatchObject({
        connectionsAcceptedTotal: 3,
        connectionsRejectedTotal: 0,
        messagesRelayedTotal: 5,
        rateLimitedConnectionsTotal: 0,
        peersBound: 2,
        pairsCompletedTotal: 1,
        consumedTickets: 1,
        maximumConnections: 20,
        maximumPendingPairs: 10,
        maximumConsumedTickets: 100,
      })
    } finally {
      core.close()
      viewer.close()
      await gateway.close()
    }
  })

  it('bounds connection capacity and per-connection message rate', async () => {
    const diagnostics: SignalingGatewayDiagnosticEvent[] = []
    const gateway = new SignalingGateway({
      configuration: {
        gatewayId: 'gateway-limits',
        host: '127.0.0.1',
        port: 0,
        publicEndpoint: 'ws://127.0.0.1',
        pairingTimeoutMs: 1_000,
        maxMessageBytes: 262_144,
        maxPendingPairs: 10,
        maxConnections: 1,
        maxConnectionsPerIp: 1,
        messageRateWindowMs: 60_000,
        maxMessagesPerWindow: 1,
        maxConsumedTickets: 10,
        iceTransportPolicy: 'all',
      },
      viewerTicketVerifier: {
        async verifyViewerTicket() {
          throw new Error('Viewer is not used by this test')
        },
      },
      coreBindingAuthorizer: {
        async authorizeCoreBinding() {
          return true
        },
      },
      onDiagnostic: (event) => diagnostics.push(event),
    })
    const address = await gateway.start()
    const endpoint = `ws://127.0.0.1:${address.port}`
    const first = await openWebSocket(endpoint)
    const rejected = await openWebSocket(endpoint)

    try {
      await expect(waitForClose(rejected)).resolves.toMatchObject({ code: 1013 })
      first.send(encodeSignalingMessage({
        type: 'core.bind',
        bindingToken: 'core-token',
        sessionId: 'session-limits',
        viewerGeneration: 1,
        gatewayId: 'gateway-limits',
      }))
      await waitUntil(() => diagnostics.some((event) => event.type === 'peer.bound'))
      const rateLimited = waitForClose(first)
      first.send(encodeSignalingMessage({ type: 'signal.restart-ice' }))
      await expect(rateLimited).resolves.toMatchObject({ code: 1008 })
      expect(gateway.getMetrics()).toMatchObject({
        connectionsAcceptedTotal: 1,
        connectionsRejectedTotal: 1,
        messagesReceivedTotal: 2,
        rateLimitedConnectionsTotal: 1,
      })
      expect(diagnostics).toEqual(expect.arrayContaining([
        { type: 'connection.rejected', reason: 'gateway-capacity' },
        expect.objectContaining({ type: 'peer.rate-limited', role: 'core' }),
      ]))
    } finally {
      first.close()
      rejected.close()
      await gateway.close()
    }
  })

  it('removes expired consumed tickets before reporting capacity metrics', async () => {
    let now = 1_000
    const claims: ViewerTicketClaims = {
      sessionId: 'session-expired-metric',
      viewerGeneration: 1,
      gatewayId: 'gateway-expired-metric',
      capabilities: [],
      issuedAt: 900,
      expiresAt: 1_001,
      jti: 'ticket-expired-metric',
      issuer: 'test-issuer',
      audience: 'remote-tab-viewer',
    }
    const gateway = new SignalingGateway({
      configuration: createConfiguration('gateway-expired-metric'),
      viewerTicketVerifier: {
        async verifyViewerTicket() {
          return { claims }
        },
      },
      coreBindingAuthorizer: { async authorizeCoreBinding() { return true } },
      now: () => now,
    })
    const address = await gateway.start()
    const viewer = await openWebSocket(`ws://127.0.0.1:${address.port}`)
    try {
      viewer.send(encodeSignalingMessage({ type: 'viewer.bind', ticket: 'viewer-ticket' }))
      await waitUntil(() => gateway.getMetrics().consumedTickets === 1)
      now = 1_002
      expect(gateway.getMetrics().consumedTickets).toBe(0)
    } finally {
      viewer.terminate()
      await gateway.close()
    }
  })

  it('rejects a second message while bind is pending without consuming the ticket', async () => {
    let releaseVerification!: () => void
    const verificationGate = new Promise<void>((resolve) => {
      releaseVerification = resolve
    })
    const diagnostics: SignalingGatewayDiagnosticEvent[] = []
    const claims: ViewerTicketClaims = {
      sessionId: 'session-pending-bind',
      viewerGeneration: 1,
      gatewayId: 'gateway-pending-bind',
      capabilities: [],
      issuedAt: 900,
      expiresAt: 1_100,
      jti: 'ticket-pending-bind',
      issuer: 'test-issuer',
      audience: 'remote-tab-viewer',
    }
    const gateway = new SignalingGateway({
      configuration: createConfiguration('gateway-pending-bind'),
      viewerTicketVerifier: {
        async verifyViewerTicket() {
          await verificationGate
          return { claims }
        },
      },
      coreBindingAuthorizer: { async authorizeCoreBinding() { return true } },
      now: () => 1_000,
      onDiagnostic: (event) => diagnostics.push(event),
    })
    const address = await gateway.start()
    const socket = await openWebSocket(`ws://127.0.0.1:${address.port}`)
    const inbox = new MessageInbox(socket)
    try {
      socket.send(encodeSignalingMessage({ type: 'viewer.bind', ticket: 'viewer-ticket' }))
      socket.send(encodeSignalingMessage({ type: 'viewer.bind', ticket: 'viewer-ticket' }))
      await expect(inbox.next()).resolves.toMatchObject({
        type: 'signal.error',
        error: { code: 'SIGNALING_AUTH_FAILED' },
      })
      await expect(waitForClose(socket)).resolves.toMatchObject({ code: 1008 })
      releaseVerification()
      await waitUntil(() => gateway.getMetrics().connectionsActive === 0)
      expect(gateway.getMetrics()).toMatchObject({
        consumedTickets: 0,
        peersBound: 0,
        pairsTracked: 0,
      })
      expect(diagnostics).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'peer.bound' })]),
      )
    } finally {
      releaseVerification()
      socket.terminate()
      await gateway.close()
    }
  })

  it('does not bind or consume a ticket after the socket closes during verification', async () => {
    let releaseVerification!: () => void
    const verificationGate = new Promise<void>((resolve) => {
      releaseVerification = resolve
    })
    const diagnostics: SignalingGatewayDiagnosticEvent[] = []
    const gateway = new SignalingGateway({
      configuration: createConfiguration('gateway-closed-bind'),
      viewerTicketVerifier: {
        async verifyViewerTicket() {
          await verificationGate
          return {
            claims: {
              sessionId: 'session-closed-bind',
              viewerGeneration: 1,
              gatewayId: 'gateway-closed-bind',
              capabilities: [],
              issuedAt: 900,
              expiresAt: 1_100,
              jti: 'ticket-closed-bind',
              issuer: 'test-issuer',
              audience: 'remote-tab-viewer',
            },
          }
        },
      },
      coreBindingAuthorizer: { async authorizeCoreBinding() { return true } },
      now: () => 1_000,
      onDiagnostic: (event) => diagnostics.push(event),
    })
    const address = await gateway.start()
    const socket = await openWebSocket(`ws://127.0.0.1:${address.port}`)
    try {
      socket.send(encodeSignalingMessage({ type: 'viewer.bind', ticket: 'viewer-ticket' }))
      socket.terminate()
      await waitUntil(() => gateway.getMetrics().connectionsActive === 0)
      releaseVerification()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(gateway.getMetrics()).toMatchObject({
        consumedTickets: 0,
        peersBound: 0,
        pairsTracked: 0,
      })
      expect(diagnostics).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'peer.bound' })]),
      )
    } finally {
      releaseVerification()
      socket.terminate()
      await gateway.close()
    }
  })

  it('does not complete a pair after a peer disconnects during ICE assignment', async () => {
    let releaseIce!: () => void
    const iceGate = new Promise<void>((resolve) => {
      releaseIce = resolve
    })
    const diagnostics: SignalingGatewayDiagnosticEvent[] = []
    const gateway = new SignalingGateway({
      configuration: createConfiguration('gateway-pair-race'),
      viewerTicketVerifier: {
        async verifyViewerTicket() {
          return {
            claims: {
              sessionId: 'session-pair-race',
              viewerGeneration: 1,
              gatewayId: 'gateway-pair-race',
              capabilities: [],
              issuedAt: 900,
              expiresAt: 1_100,
              jti: 'ticket-pair-race',
              issuer: 'test-issuer',
              audience: 'remote-tab-viewer',
            },
          }
        },
      },
      coreBindingAuthorizer: { async authorizeCoreBinding() { return true } },
      iceServerProvider: {
        async getIceServers(role) {
          if (role === 'core') await iceGate
          return []
        },
      },
      now: () => 1_000,
      onDiagnostic: (event) => diagnostics.push(event),
    })
    const address = await gateway.start()
    const endpoint = `ws://127.0.0.1:${address.port}`
    const core = await openWebSocket(endpoint)
    const viewer = await openWebSocket(endpoint)
    const coreInbox = new MessageInbox(core)
    try {
      core.send(encodeSignalingMessage({
        type: 'core.bind',
        bindingToken: 'core-token',
        sessionId: 'session-pair-race',
        viewerGeneration: 1,
        gatewayId: 'gateway-pair-race',
      }))
      await waitUntil(() => diagnostics.some((event) =>
        event.type === 'peer.bound' && event.role === 'core'))
      viewer.send(encodeSignalingMessage({ type: 'viewer.bind', ticket: 'viewer-ticket' }))
      await waitUntil(() => diagnostics.some((event) =>
        event.type === 'peer.bound' && event.role === 'viewer'))
      viewer.terminate()
      await expect(coreInbox.next()).resolves.toEqual({ type: 'signal.peer-left', role: 'viewer' })
      releaseIce()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(gateway.getMetrics()).toMatchObject({ pairsCompletedTotal: 0, peersBound: 1 })
      expect(diagnostics).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'pair.completed' })]),
      )
    } finally {
      releaseIce()
      core.terminate()
      viewer.terminate()
      await gateway.close()
    }
  })
})

function createConfiguration(gatewayId: string) {
  return {
    gatewayId,
    host: '127.0.0.1',
    port: 0,
    publicEndpoint: 'ws://127.0.0.1',
    pairingTimeoutMs: 1_000,
    maxMessageBytes: 262_144,
    maxPendingPairs: 10,
    maxConnections: 20,
    maxConnectionsPerIp: 20,
    messageRateWindowMs: 60_000,
    maxMessagesPerWindow: 100,
    maxConsumedTickets: 100,
    iceTransportPolicy: 'all' as const,
  }
}

async function openWebSocket(endpoint: string): Promise<WebSocket> {
  const socket = new WebSocket(endpoint)
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })
  return socket
}

function waitForClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
  })
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Timed out waiting for signaling condition')
}
