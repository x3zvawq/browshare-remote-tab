import WebSocket from 'ws'
import { describe, expect, it } from 'vitest'

import {
  createProtocolMessage,
  decodeExtensionLoopbackMessage,
  encodeProtocolMessage,
  encodeExtensionLoopbackMessage,
  type ExtensionLoopbackMessage,
  type ProtocolMessage,
} from '@browshare/remote-tab-protocol'

import { ExtensionLoopbackServer } from '../src/index.js'
import { REMOTE_TAB_CORE_VERSION } from '../src/version.js'

describe('ExtensionLoopbackServer', () => {
  it('binds capture replacement acknowledgements and stops on an uncertain timeout', async () => {
    const loopback = new ExtensionLoopbackServer({ port: 0, extensionId: 'b'.repeat(32),
      runtimeGeneration: 'replace-runtime', runtimeSecret: 'a'.repeat(32), requestTimeoutMs: 100 })
    const address = await loopback.start()
    const service = await openWebSocket(`ws://127.0.0.1:${address.port}`, 'b'.repeat(32))
    const media = await openWebSocket(`ws://127.0.0.1:${address.port}`, 'b'.repeat(32))
    const serviceInbox = createInbox(service), mediaInbox = createInbox(media)
    try {
      for (const [socket, role] of [[service, 'service-worker'], [media, 'media']] as const) {
        socket.send(encodeExtensionLoopbackMessage({ type: 'runtime.bind', role,
          secret: 'a'.repeat(32), extensionId: 'b'.repeat(32), extensionVersion: REMOTE_TAB_CORE_VERSION,
          runtimeGeneration: 'replace-runtime' }))
      }
      await serviceInbox.next(); await mediaInbox.next()
      const prepared = loopback.prepareCapture({ sessionId: 'session', targetId: 'target', tabId: 1, viewerGeneration: 3 })
      const preparation = await serviceInbox.next()
      if (preparation.type !== 'capture.prepare') throw new Error('Expected capture.prepare')
      service.send(encodeExtensionLoopbackMessage({ type: 'capture.prepared', requestId: preparation.requestId,
        sessionId: 'session', streamId: 'initial' }))
      await prepared
      const replacement = { sessionId: 'session', viewerGeneration: 3, streamId: 'next',
        viewport: { width: 900, height: 600, deviceScaleFactor: 1, frameRate: 15, revision: 1 }, audio: true }
      for (const changed of [undefined, 'session', 'generation'] as const) {
        const pending = loopback.replaceMediaCapture(replacement)
        const assertion = changed === undefined ? expect(pending).resolves.toBeUndefined()
          : expect(pending).rejects.toMatchObject({ code: 'PROTOCOL_MESSAGE_INVALID' })
        const request = await mediaInbox.next()
        if (request.type !== 'media.replace_capture') throw new Error('Expected replacement')
        media.send(encodeExtensionLoopbackMessage({ type: 'media.capture_replaced', requestId: request.requestId,
          sessionId: changed === 'session' ? 'other' : 'session', viewerGeneration: changed === 'generation' ? 4 : 3 }))
        await assertion
      }
      const failed = loopback.replaceMediaCapture(replacement)
      const failedAssertion = expect(failed).rejects.toMatchObject({ code: 'CAPTURE_DENIED' })
      const failedRequest = await mediaInbox.next()
      if (failedRequest.type !== 'media.replace_capture') throw new Error('Expected replacement')
      media.send(encodeExtensionLoopbackMessage({ type: 'media.capture_replace_failed', requestId: failedRequest.requestId,
        sessionId: 'session', viewerGeneration: 3, error: { code: 'CAPTURE_DENIED', message: 'denied', retryable: false } }))
      await failedAssertion
      const timeout = loopback.replaceMediaCapture(replacement)
      const timedOut = expect(timeout).rejects.toMatchObject({ code: 'CAPTURE_DENIED' })
      await mediaInbox.next()
      const stop = await mediaInbox.next()
      expect(stop.type).toBe('media.stop')
      if (stop.type !== 'media.stop') throw new Error('Expected media.stop')
      media.send(encodeExtensionLoopbackMessage({ type: 'media.stopped', requestId: stop.requestId, sessionId: 'session' }))
      await timedOut
      const disconnected = loopback.replaceMediaCapture(replacement)
      const disconnectedAssertion = expect(disconnected).rejects.toMatchObject({ code: 'EXTENSION_UNAVAILABLE' })
      await mediaInbox.next(); media.close()
      await disconnectedAssertion
    } finally { service.terminate(); media.terminate(); await loopback.close() }
  })


  it('accepts only the configured Chrome extension Origin', async () => {
    const extensionId = 'g'.repeat(32)
    const loopback = new ExtensionLoopbackServer({
      port: 0,
      extensionId,
      runtimeGeneration: 'runtime-origin',
      runtimeSecret: '0123456789abcdef0123456789abcdef',
    })
    const address = await loopback.start()
    const endpoint = `ws://127.0.0.1:${address.port}`
    try {
      await expect(openWebSocket(endpoint)).rejects.toThrow(/401/u)
      await expect(openWebSocket(endpoint, 'h'.repeat(32))).rejects.toThrow(/401/u)
      const accepted = await openWebSocket(endpoint, extensionId)
      accepted.terminate()
    } finally {
      await loopback.close()
    }
  })

  it('authenticates the extension runtime and resolves a CDP target to tabId', async () => {
    const loopback = new ExtensionLoopbackServer({
      port: 0,
      extensionId: 'a'.repeat(32),
      runtimeGeneration: 'runtime-1',
      runtimeSecret: '0123456789abcdef0123456789abcdef',
      requestTimeoutMs: 1_000,
    })
    const address = await loopback.start()
    const socket = await openWebSocket(`ws://127.0.0.1:${address.port}`, 'a'.repeat(32))
    const inbox: ExtensionLoopbackMessage[] = []
    let wake: (() => void) | undefined
    socket.on('message', (data) => {
      inbox.push(decodeExtensionLoopbackMessage(data.toString()))
      wake?.()
      wake = undefined
    })

    try {
      socket.send(
        encodeExtensionLoopbackMessage({
          type: 'runtime.bind',
          role: 'service-worker',
          secret: '0123456789abcdef0123456789abcdef',
          extensionId: 'a'.repeat(32),
          extensionVersion: '1.2.3',
          runtimeGeneration: 'runtime-1',
        }),
      )
      await expect(nextMessage(inbox, () => new Promise((resolve) => (wake = resolve)))).resolves.toEqual({
        type: 'runtime.ready',
        role: 'service-worker',
        extensionVersion: '1.2.3',
        runtimeGeneration: 'runtime-1',
      })

      const resolution = loopback.resolveTabId({ targetId: 'target-1' })
      const request = await nextMessage(inbox, () => new Promise((resolve) => (wake = resolve)))
      expect(request).toMatchObject({ type: 'target.resolve', targetId: 'target-1' })
      if (request.type !== 'target.resolve') {
        throw new Error('Expected target.resolve')
      }
      socket.send(
        encodeExtensionLoopbackMessage({
          type: 'target.resolved',
          requestId: request.requestId,
          targetId: request.targetId,
          tabId: 73,
        }),
      )
      await expect(resolution).resolves.toBe(73)
    } finally {
      socket.close()
      await loopback.close()
    }
  })

  it('waits until both extension runtime roles are authenticated', async () => {
    const loopback = new ExtensionLoopbackServer({
      port: 0,
      extensionId: 'd'.repeat(32),
      runtimeGeneration: 'runtime-ready',
      runtimeSecret: 'fedcba9876543210fedcba9876543210',
      requestTimeoutMs: 1_000,
    })
    const address = await loopback.start()
    expect(loopback.getReadyRoles()).toEqual([])
    const waiting = loopback.waitUntilReady()
    const sockets: WebSocket[] = []
    try {
      for (const role of ['service-worker', 'media'] as const) {
        const socket = await openWebSocket(`ws://127.0.0.1:${address.port}`, 'd'.repeat(32))
        sockets.push(socket)
        socket.send(
          encodeExtensionLoopbackMessage({
            type: 'runtime.bind',
            role,
            secret: 'fedcba9876543210fedcba9876543210',
            extensionId: 'd'.repeat(32),
            extensionVersion: '1.2.3',
            runtimeGeneration: 'runtime-ready',
          }),
        )
      }
      await expect(waiting).resolves.toBeUndefined()
      expect(loopback.getReadyRoles()).toEqual(['service-worker', 'media'])
      expect(loopback.getRuntimeStatus()).toEqual({
        extensionId: 'd'.repeat(32),
        runtimeGeneration: 'runtime-ready',
        serviceWorkerVersion: '1.2.3',
        mediaVersion: '1.2.3',
        coherent: true,
      })
    } finally {
      for (const socket of sockets) socket.close()
      await loopback.close()
    }
  })

  it('bounds unauthenticated loopback connections', async () => {
    const loopback = new ExtensionLoopbackServer({
      port: 0,
      extensionId: 'c'.repeat(32),
      runtimeGeneration: 'runtime-capacity',
      runtimeSecret: '0123456789abcdef0123456789abcdef',
      requestTimeoutMs: 1_000,
      maxConnections: 2,
    })
    const address = await loopback.start()
    const first = await openWebSocket(`ws://127.0.0.1:${address.port}`, 'c'.repeat(32))
    const second = await openWebSocket(`ws://127.0.0.1:${address.port}`, 'c'.repeat(32))
    const rejected = await openWebSocket(`ws://127.0.0.1:${address.port}`, 'c'.repeat(32))
    try {
      await expect(waitForClose(rejected)).resolves.toMatchObject({ code: 1013 })
      expect(first.readyState).toBe(WebSocket.OPEN)
      expect(second.readyState).toBe(WebSocket.OPEN)
    } finally {
      first.terminate()
      second.terminate()
      rejected.terminate()
      await loopback.close()
    }
  })

  it('prepares capture and forwards media signaling, failures, and binary control', async () => {
    const loopback = new ExtensionLoopbackServer({
      port: 0,
      extensionId: 'b'.repeat(32),
      runtimeGeneration: 'runtime-2',
      runtimeSecret: 'abcdef0123456789abcdef0123456789',
      requestTimeoutMs: 1_000,
    })
    const address = await loopback.start()
    const serviceWorker = await openWebSocket(`ws://127.0.0.1:${address.port}`, 'b'.repeat(32))
    const media = await openWebSocket(`ws://127.0.0.1:${address.port}`, 'b'.repeat(32))
    const serviceWorkerInbox = createInbox(serviceWorker)
    const mediaInbox = createInbox(media)

    try {
      serviceWorker.send(
        encodeExtensionLoopbackMessage({
          type: 'runtime.bind',
          role: 'service-worker',
          secret: 'abcdef0123456789abcdef0123456789',
          extensionId: 'b'.repeat(32),
          extensionVersion: '1.2.3',
          runtimeGeneration: 'runtime-2',
        }),
      )
      media.send(
        encodeExtensionLoopbackMessage({
          type: 'runtime.bind',
          role: 'media',
          secret: 'abcdef0123456789abcdef0123456789',
          extensionId: 'b'.repeat(32),
          extensionVersion: '1.2.3',
          runtimeGeneration: 'runtime-2',
        }),
      )
      await expect(serviceWorkerInbox.next()).resolves.toMatchObject({ type: 'runtime.ready' })
      await expect(mediaInbox.next()).resolves.toMatchObject({ type: 'runtime.ready' })

      const capture = loopback.prepareCapture({
        sessionId: 'session-1',
        targetId: 'target-1',
        tabId: 42,
        viewerGeneration: 3,
      })
      const captureRequest = await serviceWorkerInbox.next()
      expect(captureRequest).toMatchObject({
        type: 'capture.prepare',
        sessionId: 'session-1',
        targetId: 'target-1',
        tabId: 42,
        viewerGeneration: 3,
      })
      if (captureRequest.type !== 'capture.prepare') {
        throw new Error('Expected capture.prepare')
      }
      serviceWorker.send(
        encodeExtensionLoopbackMessage({
          type: 'capture.prepared',
          requestId: captureRequest.requestId,
          sessionId: captureRequest.sessionId,
          streamId: 'stream-1',
        }),
      )
      await expect(capture).resolves.toBe('stream-1')

      const signals: unknown[] = []
      const session1Controls: Uint8Array[] = []
      const session2Controls: Uint8Array[] = []
      loopback.onMediaSignal((signal) => signals.push(signal))
      loopback.onMediaControl('session-1', (data) => session1Controls.push(data))
      const unsubscribeSession2 = loopback.onMediaControl('session-2', (data) =>
        session2Controls.push(data),
      )
      loopback.restartMediaIce('session-1')
      await expect(mediaInbox.next()).resolves.toEqual({
        type: 'media.restart_ice',
        sessionId: 'session-1',
      })
      const stopping = loopback.stopMedia('session-1', 'Viewer generation replaced')
      const stopRequest = await mediaInbox.next()
      expect(stopRequest).toMatchObject({
        type: 'media.stop',
        sessionId: 'session-1',
        reason: 'Viewer generation replaced',
      })
      if (stopRequest.type !== 'media.stop') {
        throw new Error('Expected media.stop')
      }
      media.send(
        encodeExtensionLoopbackMessage({
          type: 'media.stopped',
          requestId: stopRequest.requestId,
          sessionId: stopRequest.sessionId,
        }),
      )
      await expect(stopping).resolves.toBeUndefined()
      media.send(
        encodeExtensionLoopbackMessage({
          type: 'media.start_failed',
          sessionId: 'session-1',
          error: { code: 'CAPTURE_DENIED', message: 'capture failed', retryable: false },
        }),
      )
      media.send(
        encodeExtensionLoopbackMessage({
          type: 'media.diagnostic',
          sessionId: 'session-1',
          diagnostic: {
            name: 'webrtc.media-metrics',
            direction: 'outbound',
            kind: 'video',
            codec: 'video/VP8',
            bitrateBps: 2_000_000,
            roundTripTimeMs: 18.5,
            qualityLimitationReason: 'none',
            sampleIntervalMs: 5_000,
          },
        }),
      )
      const session1Control = encodeProtocolMessage(
        createProtocolMessage(
          'session.suspend',
          { sessionId: 'session-1', viewerGeneration: 3, sequence: 1 },
          {},
        ) as ProtocolMessage,
      )
      const session2Control = encodeProtocolMessage(
        createProtocolMessage(
          'session.resume',
          { sessionId: 'session-2', viewerGeneration: 4, sequence: 1 },
          {},
        ) as ProtocolMessage,
      )
      media.send(session1Control)
      media.send(session2Control)
      await waitUntil(
        () => signals.length === 2 && session1Controls.length === 1 && session2Controls.length === 1,
      )
      expect(signals[0]).toMatchObject({
        type: 'start-failed',
        sessionId: 'session-1',
        error: { code: 'CAPTURE_DENIED', message: 'capture failed', retryable: false },
      })
      expect(signals[1]).toEqual({
        type: 'diagnostic',
        sessionId: 'session-1',
        diagnostic: {
          name: 'webrtc.media-metrics',
          direction: 'outbound',
          kind: 'video',
          codec: 'video/VP8',
          bitrateBps: 2_000_000,
          roundTripTimeMs: 18.5,
          qualityLimitationReason: 'none',
          sampleIntervalMs: 5_000,
        },
      })
      expect(session1Controls).toEqual([session1Control])
      expect(session2Controls).toEqual([session2Control])

      unsubscribeSession2()
      media.send(session2Control)
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(session2Controls).toEqual([session2Control])
    } finally {
      serviceWorker.close()
      media.close()
      await loopback.close()
    }
  })

  it('waits for the media runtime to forward file data and rejects pending sends on disconnect', async () => {
    const loopback = new ExtensionLoopbackServer({
      port: 0,
      extensionId: 'e'.repeat(32),
      runtimeGeneration: 'runtime-forwarding',
      runtimeSecret: '0123456789abcdef0123456789abcdef',
      requestTimeoutMs: 1_000,
    })
    const address = await loopback.start()
    const media = await openWebSocket(`ws://127.0.0.1:${address.port}`, 'e'.repeat(32))
    const inbox = createInbox(media)

    try {
      media.send(
        encodeExtensionLoopbackMessage({
          type: 'runtime.bind',
          role: 'media',
          secret: '0123456789abcdef0123456789abcdef',
          extensionId: 'e'.repeat(32),
          extensionVersion: '1.2.3',
          runtimeGeneration: 'runtime-forwarding',
        }),
      )
      await expect(inbox.next()).resolves.toMatchObject({ type: 'runtime.ready' })

      const bytes = encodeProtocolMessage(
        createProtocolMessage(
          'file.download.chunk',
          { sessionId: 'session-1', viewerGeneration: 2, sequence: 73 },
          { transferId: 'transfer-1', offset: 0, data: Uint8Array.of(1, 2, 3) },
        ) as ProtocolMessage,
      )
      const received = nextBinary(media)
      const forwarded = loopback.sendMediaControlAndWait(bytes, 'session-1', 73)
      await expect(received).resolves.toEqual(bytes)
      media.send(
        encodeExtensionLoopbackMessage({
          type: 'media.control_forwarded',
          sessionId: 'session-1',
          sequence: 73,
        }),
      )
      await expect(forwarded).resolves.toBeUndefined()

      const pendingBytes = encodeProtocolMessage(
        createProtocolMessage(
          'file.download.chunk',
          { sessionId: 'session-1', viewerGeneration: 2, sequence: 74 },
          { transferId: 'transfer-1', offset: 3, data: Uint8Array.of(4) },
        ) as ProtocolMessage,
      )
      const pending = expect(
        loopback.sendMediaControlAndWait(pendingBytes, 'session-1', 74),
      ).rejects.toMatchObject({ code: 'EXTENSION_UNAVAILABLE' })
      media.terminate()
      await pending
    } finally {
      media.terminate()
      await loopback.close()
    }
  })

  it('times out when the media runtime does not confirm file-data forwarding', async () => {
    const loopback = new ExtensionLoopbackServer({
      port: 0,
      extensionId: 'f'.repeat(32),
      runtimeGeneration: 'runtime-forward-timeout',
      runtimeSecret: '0123456789abcdef0123456789abcdef',
      requestTimeoutMs: 20,
    })
    const address = await loopback.start()
    const media = await openWebSocket(`ws://127.0.0.1:${address.port}`, 'f'.repeat(32))
    const inbox = createInbox(media)

    try {
      media.send(
        encodeExtensionLoopbackMessage({
          type: 'runtime.bind',
          role: 'media',
          secret: '0123456789abcdef0123456789abcdef',
          extensionId: 'f'.repeat(32),
          extensionVersion: '1.2.3',
          runtimeGeneration: 'runtime-forward-timeout',
        }),
      )
      await expect(inbox.next()).resolves.toMatchObject({ type: 'runtime.ready' })
      const bytes = encodeProtocolMessage(
        createProtocolMessage(
          'file.download.chunk',
          { sessionId: 'session-timeout', viewerGeneration: 1, sequence: 1 },
          { transferId: 'transfer-timeout', offset: 0, data: Uint8Array.of(1) },
        ) as ProtocolMessage,
      )
      await expect(
        loopback.sendMediaControlAndWait(bytes, 'session-timeout', 1),
      ).rejects.toMatchObject({ code: 'EXTENSION_UNAVAILABLE' })
    } finally {
      media.terminate()
      await loopback.close()
    }
  })

  it('isolates target discovery, capture, media, and disconnects across Chrome runtimes', async () => {
    const loopback = new ExtensionLoopbackServer({
      port: 0,
      extensionId: 'g'.repeat(32),
      runtimeGeneration: 'worker-generation',
      runtimeSecret: '0123456789abcdef0123456789abcdef',
      requestTimeoutMs: 1_000,
    })
    const address = await loopback.start()
    const endpoint = `ws://127.0.0.1:${address.port}`
    const peers = await Promise.all(
      ['a-service-worker', 'a-media', 'b-service-worker', 'b-media'].map((name) =>
        openWebSocket(endpoint, 'g'.repeat(32)).then((socket) => ({
          name,
          socket,
          inbox: createInbox(socket),
        })),
      ),
    )
    const peer = (name: string) => {
      const found = peers.find((candidate) => candidate.name === name)
      if (found === undefined) throw new Error(`Missing test peer ${name}`)
      return found
    }
    try {
      for (const runtimeInstanceId of ['runtime-a', 'runtime-b']) {
        for (const role of ['service-worker', 'media'] as const) {
          const selected = peer(`${runtimeInstanceId.at(-1)}-${role}`)
          selected.socket.send(
            encodeExtensionLoopbackMessage({
              type: 'runtime.bind',
              role,
              secret: '0123456789abcdef0123456789abcdef',
              extensionId: 'g'.repeat(32),
              extensionVersion: '1.2.3',
              runtimeGeneration: 'worker-generation',
              runtimeInstanceId,
            }),
          )
          await expect(selected.inbox.next()).resolves.toMatchObject({
            type: 'runtime.ready',
            role,
            runtimeInstanceId,
          })
        }
      }

      expect(loopback.getRuntimeStatuses()).toEqual([
        expect.objectContaining({ runtimeInstanceId: 'runtime-a', coherent: true }),
        expect.objectContaining({ runtimeInstanceId: 'runtime-b', coherent: true }),
      ])

      for (const owner of ['a', 'b'] as const) {
        const targetId = `target-${owner}`
        const resolution = loopback.resolveTabId({ targetId })
        const requests = await Promise.all([
          peer('a-service-worker').inbox.next(),
          peer('b-service-worker').inbox.next(),
        ])
        for (const [index, request] of requests.entries()) {
          if (request.type !== 'target.resolve') throw new Error('Expected target.resolve')
          const respondingOwner = index === 0 ? 'a' : 'b'
          peer(`${respondingOwner}-service-worker`).socket.send(
            encodeExtensionLoopbackMessage(
              respondingOwner === owner
                ? {
                    type: 'target.resolved',
                    requestId: request.requestId,
                    targetId,
                    tabId: owner === 'a' ? 41 : 42,
                  }
                : {
                    type: 'target.resolve_failed',
                    requestId: request.requestId,
                    targetId,
                    error: {
                      code: 'TARGET_MAPPING_FAILED',
                      message: 'Target belongs to another Chrome runtime',
                      retryable: false,
                    },
                  },
            ),
          )
        }
        await expect(resolution).resolves.toBe(owner === 'a' ? 41 : 42)
        loopback.bindSession(`session-${owner}`, targetId)
        expect(() => loopback.startMedia({
          sessionId: `session-${owner}`, viewerGeneration: 1, tabId: 41, streamId: 'unused',
          capabilities: ['noticeRequests'], iceServers: [], iceTransportPolicy: 'all',
          viewport: { width: 1280, height: 720, deviceScaleFactor: 1, frameRate: 30, revision: 1 }, audio: false,
        })).toThrow('coordinated Extension')
        loopback.sendMediaPeerState(`session-${owner}`, true)
        await expect(peer(`${owner}-media`).inbox.next()).resolves.toEqual({
          type: 'media.peer_ready',
          sessionId: `session-${owner}`,
        })

        const capture = loopback.prepareCapture({
          sessionId: `session-${owner}`,
          targetId,
          tabId: owner === 'a' ? 41 : 42,
          viewerGeneration: 1,
        })
        const captureRequest = await peer(`${owner}-service-worker`).inbox.next()
        expect(captureRequest).toMatchObject({
          type: 'capture.prepare',
          sessionId: `session-${owner}`,
        })
        if (captureRequest.type !== 'capture.prepare') throw new Error('Expected capture.prepare')
        peer(`${owner}-service-worker`).socket.send(
          encodeExtensionLoopbackMessage({
            type: 'capture.prepared',
            requestId: captureRequest.requestId,
            sessionId: captureRequest.sessionId,
            streamId: `stream-${owner}`,
          }),
        )
        await expect(capture).resolves.toBe(`stream-${owner}`)
        loopback.restartMediaIce(`session-${owner}`)
        await expect(peer(`${owner}-media`).inbox.next()).resolves.toEqual({
          type: 'media.restart_ice',
          sessionId: `session-${owner}`,
        })
      }

      const ambiguous = loopback.resolveTabId({ targetId: 'target-ambiguous' })
      const ambiguousRequests = await Promise.all([
        peer('a-service-worker').inbox.next(),
        peer('b-service-worker').inbox.next(),
      ])
      for (const [index, request] of ambiguousRequests.entries()) {
        if (request.type !== 'target.resolve') throw new Error('Expected target.resolve')
        peer(`${index === 0 ? 'a' : 'b'}-service-worker`).socket.send(
          encodeExtensionLoopbackMessage({
            type: 'target.resolved',
            requestId: request.requestId,
            targetId: request.targetId,
            tabId: index + 50,
          }),
        )
      }
      await expect(ambiguous).rejects.toMatchObject({ code: 'TARGET_MAPPING_FAILED' })

      peer('a-media').socket.terminate()
      await waitUntil(
        () =>
          loopback.getRuntimeStatuses().find((status) => status.runtimeInstanceId === 'runtime-a')
            ?.coherent === false,
      )
      expect(() => loopback.restartMediaIce('session-a')).toThrow(/not connected/u)
      loopback.restartMediaIce('session-b')
      await expect(peer('b-media').inbox.next()).resolves.toEqual({
        type: 'media.restart_ice',
        sessionId: 'session-b',
      })
    } finally {
      for (const { socket } of peers) socket.terminate()
      await loopback.close()
    }
  })
})

function nextBinary(socket: WebSocket): Promise<Uint8Array> {
  return new Promise((resolve) => {
    const handleMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
      if (!isBinary) return
      socket.off('message', handleMessage)
      resolve(Uint8Array.from(data as Buffer))
    }
    socket.on('message', handleMessage)
  })
}

function waitForClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
  })
}

function createInbox(socket: WebSocket): { next(): Promise<ExtensionLoopbackMessage> } {
  const messages: ExtensionLoopbackMessage[] = []
  const waiters: Array<(message: ExtensionLoopbackMessage) => void> = []
  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      return
    }
    const message = decodeExtensionLoopbackMessage(data.toString())
    const waiter = waiters.shift()
    if (waiter === undefined) {
      messages.push(message)
    } else {
      waiter(message)
    }
  })
  return {
    next: () => {
      const message = messages.shift()
      return message === undefined
        ? new Promise<ExtensionLoopbackMessage>((resolve) => waiters.push(resolve))
        : Promise.resolve(message)
    },
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for loopback events')
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function nextMessage(
  inbox: ExtensionLoopbackMessage[],
  wait: () => Promise<void>,
): Promise<ExtensionLoopbackMessage> {
  while (inbox.length === 0) {
    await wait()
  }
  const message = inbox.shift()
  if (message === undefined) {
    throw new Error('Message inbox unexpectedly empty')
  }
  return message
}

async function openWebSocket(endpoint: string, extensionId?: string): Promise<WebSocket> {
  const socket = new WebSocket(
    endpoint,
    extensionId === undefined ? {} : { origin: `chrome-extension://${extensionId}` },
  )
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })
  return socket
}
