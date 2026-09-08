import type { AddressInfo } from 'node:net'

import WebSocket, { WebSocketServer } from 'ws'
import { describe, expect, it } from 'vitest'

import {
  decodeSignalingMessage,
  encodeSignalingMessage,
  type SignalingMessage,
} from '@browshare/remote-tab-protocol'

import { CoreSignalingClient, type CoreSignalingEvent } from '../src/index.js'

describe('CoreSignalingClient', () => {
  it('binds the assigned generation and exchanges only Core-side signaling', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const address = server.address() as AddressInfo
    const received: SignalingMessage[] = []
    let gatewaySocket: WebSocket | undefined
    server.on('connection', (socket) => {
      gatewaySocket = socket
      socket.on('message', (data) => received.push(decodeSignalingMessage(data.toString())))
    })

    const client = new CoreSignalingClient({
      endpoint: `ws://127.0.0.1:${address.port}`,
      gatewayId: 'gateway-1',
      bindingToken: 'binding-token',
      sessionId: 'session-1',
      viewerGeneration: 4,
      connectionTimeoutMs: 1_000,
    })
    const events: CoreSignalingEvent[] = []
    client.onEvent((event) => events.push(event))

    try {
      const connecting = client.connect()
      await waitUntil(() => received.length === 1 && gatewaySocket !== undefined)
      expect(received[0]).toEqual({
        type: 'core.bind',
        bindingToken: 'binding-token',
        sessionId: 'session-1',
        viewerGeneration: 4,
        gatewayId: 'gateway-1',
      })
      gatewaySocket?.send(
        encodeSignalingMessage({
          type: 'signal.ready',
          role: 'core',
          sessionId: 'session-1',
          viewerGeneration: 4,
          capabilities: ['navigation'],
          iceServers: [{ urls: ['stun:relay.example.test:3478'] }],
          iceTransportPolicy: 'all',
        }),
      )
      gatewaySocket?.send(encodeSignalingMessage({ type: 'signal.peer-ready' }))
      await connecting

      client.sendDescription({ type: 'offer', sdp: 'v=0\r\n' })
      client.sendIce({ candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 })
      client.sendError({
        code: 'VIEWER_REPLACED',
        message: 'Viewer was replaced by a newer authorized connection',
        retryable: false,
      })
      gatewaySocket?.send(
        encodeSignalingMessage({
          type: 'signal.description',
          description: { type: 'answer', sdp: 'v=0\r\nanswer' },
        }),
      )
      gatewaySocket?.send(encodeSignalingMessage({ type: 'signal.restart-ice' }))
      await waitUntil(() => received.length === 4 && events.length === 4)

      expect(events).toEqual([
        {
          type: 'ready',
          capabilities: ['navigation'],
          iceServers: [{ urls: ['stun:relay.example.test:3478'] }],
          iceTransportPolicy: 'all',
        },
        { type: 'peer-ready' },
        { type: 'description', description: { type: 'answer', sdp: 'v=0\r\nanswer' } },
        { type: 'ice-restart-request' },
      ])
      expect(received.slice(1)).toEqual([
        { type: 'signal.description', description: { type: 'offer', sdp: 'v=0\r\n' } },
        {
          type: 'signal.ice',
          candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 },
        },
        {
          type: 'signal.error',
          error: {
            code: 'VIEWER_REPLACED',
            message: 'Viewer was replaced by a newer authorized connection',
            retryable: false,
          },
        },
      ])
      expect(() => client.sendDescription({ type: 'answer', sdp: 'invalid' })).toThrow(
        /only WebRTC offers/u,
      )
    } finally {
      await client.close()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      )
    }
  })
})

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for signaling')
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
