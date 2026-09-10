import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import WebSocket, { WebSocketServer } from 'ws'
import { describe, expect, it, vi } from 'vitest'

import {
  createProtocolMessage,
  decodeExtensionLoopbackMessage,
  decodeProtocolMessage,
  decodeSignalingMessage,
  encodeExtensionLoopbackMessage,
  encodeProtocolMessage,
  encodeSignalingMessage,
  HmacViewerTicketCodec,
  type ExtensionLoopbackMessage,
  type ProtocolMessage,
  type SignalingMessage,
} from '@browshare/remote-tab-protocol'

import { ExtensionLoopbackServer, RemoteTabCore } from '../src/index.js'
import type {
  SessionStorageReservation,
  SessionStorageReservationRequest,
} from '../src/index.js'

interface RecordedCdpCommand {
  id: number
  method: string
  params?: Record<string, unknown>
  sessionId?: string
}

describe('RemoteTabCore', () => {
  it.each([4, 5])('orchestrates one authorized tab through control and cleanup with minor %i', async minor => {
    const downloadDirectory = await mkdtemp(join(tmpdir(), 'remote-tab-core-downloads-'))
    const cdp = await createCdpFixture()
    const loopback = new ExtensionLoopbackServer({
      port: 0,
      extensionId: 'c'.repeat(32),
      runtimeGeneration: 'runtime-3',
      runtimeSecret: '0123456789abcdef0123456789abcdef',
      requestTimeoutMs: 1_000,
    })
    const loopbackAddress = await loopback.start()
    const serviceWorker = await openWebSocket(
      `ws://127.0.0.1:${loopbackAddress.port}`,
      'c'.repeat(32),
    )
    const media = await openWebSocket(
      `ws://127.0.0.1:${loopbackAddress.port}`,
      'c'.repeat(32),
    )
    const serviceWorkerInbox = new FrameInbox(serviceWorker)
    const mediaInbox = new FrameInbox(media)
    bindExtensionPeer(serviceWorker, 'service-worker')
    bindExtensionPeer(media, 'media')
    await expect(serviceWorkerInbox.nextText()).resolves.toMatchObject({ type: 'runtime.ready' })
    await expect(mediaInbox.nextText()).resolves.toMatchObject({ type: 'runtime.ready' })

    const signaling = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((resolve) => signaling.once('listening', resolve))
    const signalingAddress = signaling.address() as AddressInfo
    const gatewaySocketPromise = nextGatewayConnection(signaling)
    const ticketCodec = new HmacViewerTicketCodec({
      secret: 'viewer-ticket-secret-0123456789abcdef',
      issuer: 'test-embedder',
      audience: 'remote-tab-viewer',
      now: () => Math.floor(Date.now() / 1_000),
      createId: () => 'ticket-1',
    })
    const authorizeNavigation = vi.fn(async ({ url }: { url?: string }) => ({
      allowed: true,
      ...(url === undefined ? {} : { url }),
    }))
    const cleanupSession = vi.fn(async () => undefined)
    const uploadReservations: Array<{
      request: SessionStorageReservationRequest
      writes: Array<{ offset: number; data: Uint8Array }>
      abort: ReturnType<typeof vi.fn>
      commit: ReturnType<typeof vi.fn>
    }> = []
    const reserveUpload = vi.fn(
      async (request: SessionStorageReservationRequest): Promise<SessionStorageReservation> => {
        const writes: Array<{ offset: number; data: Uint8Array }> = []
        const abort = vi.fn(async () => undefined)
        const localPath = `/tmp/remote-tab/${uploadReservations.length}`
        const commit = vi.fn(async () => ({
          storageKey: localPath,
          localPath,
          displayName: request.displayName,
          size: request.declaredSize,
          ...(request.mimeType === undefined ? {} : { mimeType: request.mimeType }),
        }))
        uploadReservations.push({ request, writes, abort, commit })
        return {
          localPath,
          write: async (offset, data) => {
            writes.push({ offset, data: Uint8Array.from(data) })
          },
          commit,
          abort,
        }
      },
    )
    const stateChanges: string[] = []
    const diagnostics: unknown[] = []
    const audits: unknown[] = []
    const core = new RemoteTabCore({
      extension: loopback,
      downloadDirectory,
      hookTimeoutMs: 1_000,
    })

    try {
      const attaching = core.attachSession({
        sessionId: 'session-1',
        cdpEndpoint: cdp.endpoint,
        tab: { mode: 'create', initialUrl: 'https://example.test/' },
        capabilities: [
          'navigation', 'backForward', 'reload', 'localOpen', 'qualityControl', 'upload', 'download', 'noticeRequests', 'cursorFeedback',
        ],
        signaling: {
          gatewayId: 'gateway-1',
          endpoint: `ws://127.0.0.1:${signalingAddress.port}`,
          bindingToken: 'binding-token',
        },
        storage: {
          reserve: reserveUpload,
          cleanupSession,
        },
        fileTransferLimits: { maxFileBytes: 16 },
        localOpenRequestTimeoutMs: 30,
        hooks: {
          authorizeNavigation,
          onStateChanged: (event) => {
            stateChanges.push(event.current)
          },
          onAuditEvent: (event) => {
            audits.push(event)
          },
          onDiagnostic: (event) => {
            diagnostics.push(event)
          },
        },
        ticketIssuer: { issueViewerTicket: (request) => ticketCodec.issue(request) },
      })

      const targetRequest = await serviceWorkerInbox.nextText()
      expect(targetRequest).toMatchObject({ type: 'target.resolve', targetId: 'target-1' })
      if (targetRequest.type !== 'target.resolve') {
        throw new Error('Expected target.resolve')
      }
      serviceWorker.send(
        encodeExtensionLoopbackMessage({
          type: 'target.resolved',
          requestId: targetRequest.requestId,
          targetId: targetRequest.targetId,
          tabId: 17,
        }),
      )
      const session = await attaching
      expect(session.getState()).toBe('READY')
      expect(cdp.commands.find((command) => command.method === 'Target.createTarget')?.params)
        .toEqual({ url: 'about:blank' })
      expect(cdp.commands.findIndex((command) => command.method === 'Fetch.enable'))
        .toBeLessThan(cdp.commands.findIndex((command) => command.method === 'Page.navigate'))
      cdp.emitEvent('Fetch.requestPaused', {
        requestId: 'document-allowed', frameId: 'frame-1', resourceType: 'Document',
        request: { url: 'https://example.test/document', method: 'POST' },
      })
      await vi.waitFor(() => expect(authorizeNavigation).toHaveBeenCalledWith({
        sessionId: 'session-1', action: 'go', source: 'document',
        url: 'https://example.test/document', currentUrl: 'https://example.test/', method: 'POST', isRedirect: false,
      }))
      await vi.waitFor(() => expect(cdp.commands).toContainEqual(expect.objectContaining({
        method: 'Fetch.continueRequest', params: { requestId: 'document-allowed' },
      })))
      authorizeNavigation.mockResolvedValueOnce({ allowed: false })
      cdp.emitEvent('Fetch.requestPaused', {
        requestId: 'document-denied', frameId: 'frame-1', resourceType: 'Document',
        request: { url: 'https://example.test/denied', method: 'GET' },
      })
      await vi.waitFor(() => expect(cdp.commands).toContainEqual(expect.objectContaining({
        method: 'Fetch.failRequest', params: { requestId: 'document-denied', errorReason: 'Aborted' },
      })))
      const callsBeforeIframe = authorizeNavigation.mock.calls.length
      cdp.emitEvent('Fetch.requestPaused', {
        requestId: 'iframe', frameId: 'child-frame', resourceType: 'Document',
        request: { url: 'https://example.test/denied', method: 'GET' },
      })
      await vi.waitFor(() => expect(cdp.commands).toContainEqual(expect.objectContaining({
        method: 'Fetch.continueRequest', params: { requestId: 'iframe' },
      })))
      expect(authorizeNavigation.mock.calls).toHaveLength(callsBeforeIframe)
      await expect(
        core.attachSession({
          sessionId: 'session-duplicate-target',
          cdpEndpoint: cdp.endpoint,
          tab: { mode: 'adopt', targetId: 'target-1' },
          capabilities: [],
          signaling: {
            gatewayId: 'gateway-1',
            endpoint: `ws://127.0.0.1:${signalingAddress.port}`,
            bindingToken: 'duplicate-binding-token',
          },
          storage: {
            reserve: reserveUpload,
            cleanupSession,
          },
          hooks: {
            authorizeNavigation,
            onStateChanged: vi.fn(),
            onAuditEvent: vi.fn(),
            onDiagnostic: vi.fn(),
          },
          ticketIssuer: { issueViewerTicket: (request) => ticketCodec.issue(request) },
        }),
      ).rejects.toMatchObject({ code: 'TAB_ALREADY_ATTACHED' })

      const ticket = await session.createViewerTicket({
        viewerGeneration: 1,
        gatewayId: 'gateway-1',
        capabilities: [
          'navigation', 'backForward', 'reload', 'localOpen', 'qualityControl', 'upload', 'download', 'noticeRequests', 'cursorFeedback',
        ],
        expiresInSeconds: 60,
      })
      expect(ticket.claims).toMatchObject({ sessionId: 'session-1', viewerGeneration: 1 })

      let { socket: gatewaySocket, inbox: gatewayInbox } = await gatewaySocketPromise
      await expect(gatewayInbox.nextSignaling()).resolves.toEqual({
        type: 'core.bind',
        bindingToken: 'binding-token',
        sessionId: 'session-1',
        viewerGeneration: 1,
        gatewayId: 'gateway-1',
      })
      const retryGatewaySocketPromise = nextGatewayConnection(signaling)
      gatewaySocket.send(
        encodeSignalingMessage({
          type: 'signal.error',
          error: {
            code: 'SIGNALING_PAIR_TIMEOUT',
            message: 'Viewer has not arrived yet',
            retryable: true,
          },
        }),
      )
      await expect(mediaInbox.nextText()).resolves.toEqual({
        type: 'media.peer_left',
        sessionId: 'session-1',
      })
      ;({ socket: gatewaySocket, inbox: gatewayInbox } = await retryGatewaySocketPromise)
      await expect(gatewayInbox.nextSignaling()).resolves.toEqual({
        type: 'core.bind',
        bindingToken: 'binding-token',
        sessionId: 'session-1',
        viewerGeneration: 1,
        gatewayId: 'gateway-1',
      })
      gatewaySocket.send(
        encodeSignalingMessage({
          type: 'signal.ready',
          role: 'core',
          sessionId: 'session-1',
          viewerGeneration: 1,
          capabilities: [
            'navigation', 'backForward', 'reload', 'localOpen', 'qualityControl', 'upload', 'download', 'noticeRequests', 'cursorFeedback',
          ],
          iceServers: [{ urls: ['stun:stun.example.test:3478'] }],
        }),
      )
      gatewaySocket.send(encodeSignalingMessage({ type: 'signal.peer-ready' }))

      await expect(mediaInbox.nextText()).resolves.toEqual({
        type: 'media.peer_ready',
        sessionId: 'session-1',
      })

      const captureRequest = await serviceWorkerInbox.nextText()
      expect(captureRequest).toMatchObject({
        type: 'capture.prepare',
        sessionId: 'session-1',
        targetId: 'target-1',
        tabId: 17,
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
      await expect(mediaInbox.nextText()).resolves.toMatchObject({
        type: 'media.start',
        sessionId: 'session-1',
        streamId: 'stream-1',
        iceServers: [{ urls: ['stun:stun.example.test:3478'] }],
      })

      media.send(
        encodeExtensionLoopbackMessage({
          type: 'media.signal_description',
          sessionId: 'session-1',
          description: { type: 'offer', sdp: 'v=0\r\noffer' },
        }),
      )
      await expect(gatewayInbox.nextSignaling()).resolves.toEqual({
        type: 'signal.description',
        description: { type: 'offer', sdp: 'v=0\r\noffer' },
      })
      gatewaySocket.send(
        encodeSignalingMessage({
          type: 'signal.description',
          description: { type: 'answer', sdp: 'v=0\r\nanswer' },
        }),
      )
      await expect(mediaInbox.nextText()).resolves.toEqual({
        type: 'media.signal_description',
        sessionId: 'session-1',
        description: { type: 'answer', sdp: 'v=0\r\nanswer' },
      })

      media.send(
        encodeProtocolMessage(
          createProtocolMessage(
            'hello',
            { sessionId: 'session-1', viewerGeneration: 1, sequence: 1, minor },
            {
              clientVersion: 'test-viewer',
              capabilities: [
                'cursorFeedback',
                'navigation',
                'backForward',
                'reload',
                'localOpen',
                'noticeRequests',
                'qualityControl',
                'upload',
                'download',
              ],
            },
          ) as ProtocolMessage,
        ),
      )
      await expect(mediaInbox.nextControl()).resolves.toMatchObject({
        type: 'hello.accepted',
        sessionId: 'session-1',
        viewerGeneration: 1,
        payload: { viewport: { width: 1280, height: 720, frameRate: 30, revision: 1 } },
      })
      await expect(mediaInbox.nextControl()).resolves.toMatchObject({ type: 'quality.ack', payload: { preset: 'balanced' } })
      if (minor >= 5) await expect(mediaInbox.nextControl()).resolves.toMatchObject({ type: 'cursor.changed', payload: { cursor: 'default', viewportRevision: 1, windowRevision: 0 } })
      cdp.emitEvent('Runtime.executionContextCreated', { context: { id: 90, name: 'browshare.cursor', uniqueId: 'cursor-world', auxData: { frameId: 'frame-1', isDefault: false } } })
      cdp.emitEvent('Runtime.bindingCalled', { name: '__browshareCursor', executionContextId: 90, payload: 'text' })
      if (minor >= 5) await expect(mediaInbox.nextControl()).resolves.toMatchObject({ type: 'cursor.changed', payload: { cursor: 'text' } })
      // Old-minor peers and arbitrary main-world/URL payloads produce no extra control message.
      cdp.emitEvent('Runtime.bindingCalled', { name: '__browshareCursor', executionContextId: 91, payload: 'pointer' })
      cdp.emitEvent('Runtime.bindingCalled', { name: '__browshareCursor', executionContextId: 90, payload: 'url(secret)' })

      expect(session.getState()).toBe('CONNECTED')

      const noticeBody = { kind: 'confirm' as const, title: 'Continue?', body: 'Plain <b>text</b>', buttons: [{ id: 'continue', label: 'Continue' }] }
      const answer = (requestId: string, viewerGeneration: number, buttonId: string | null) => media.send(encodeProtocolMessage(createProtocolMessage(
        'notice.response', { sessionId: session.id, viewerGeneration, sequence: 2 }, { requestId, buttonId },
      )))
      const noticeResult = session.requestNotice(noticeBody)
      const noticeRequest = await mediaInbox.nextControl()
      if (noticeRequest.type !== 'notice.request') throw new Error('Expected Notice request')
      answer(noticeRequest.payload.requestId, 0, 'continue')
      await expect(mediaInbox.nextControl()).resolves.toMatchObject({ type: 'error', payload: { code: 'VIEWER_REPLACED' } })
      answer(noticeRequest.payload.requestId, 1, 'unknown')
      await expect(mediaInbox.nextControl()).resolves.toMatchObject({ type: 'error', payload: { code: 'PROTOCOL_MESSAGE_INVALID' } })
      answer(noticeRequest.payload.requestId, 1, 'continue')
      await expect(noticeResult).resolves.toMatchObject({ buttonId: 'continue', reason: 'response' })

      // The navigation hook holds the normal input queue; its response must bypass that queue.
      authorizeNavigation.mockImplementationOnce(async () => {
        const decision = await session.requestNotice(noticeBody)
        return { allowed: decision.buttonId === 'continue' }
      })
      media.send(encodeProtocolMessage(createProtocolMessage('navigation.request',
        { sessionId: session.id, viewerGeneration: 1, sequence: 3 },
        { action: 'go', url: 'https://example.test/confirmed' },
      )))
      const queuedNotice = await mediaInbox.nextControl()
      if (queuedNotice.type !== 'notice.request') throw new Error('Expected queued Notice')
      answer(queuedNotice.payload.requestId, 1, 'continue')
      await expect(mediaInbox.nextControl()).resolves.toMatchObject({ type: 'navigation.result', payload: { allowed: true } })

      cdp.emitEvent('Page.fileChooserOpened', {
        backendNodeId: 321,
        mode: 'selectMultiple',
      })
      const uploadRequest = await mediaInbox.nextControl()
      expect(uploadRequest).toMatchObject({
        type: 'file.upload.request',
        payload: { multiple: true },
      })
      if (uploadRequest.type !== 'file.upload.request') {
        throw new Error('Expected file.upload.request')
      }
      media.send(
        encodeProtocolMessage(
          createProtocolMessage(
            'file.upload.offer',
            { sessionId: 'session-1', viewerGeneration: 1, sequence: 10 },
            {
              requestId: uploadRequest.payload.requestId,
              transferId: 'transfer-1',
              files: [
                {
                  fileId: 'file-1',
                  displayName: '../unsafe\\name\u0000.txt',
                  mimeType: 'text/plain',
                  size: 3,
                },
                { fileId: 'file-2', displayName: 'empty.txt', size: 0 },
              ],
            },
          ) as ProtocolMessage,
        ),
      )
      await expect(mediaInbox.nextControl()).resolves.toMatchObject({
        type: 'file.upload.accept',
        payload: { transferId: 'transfer-1', maxChunkBytes: 64 * 1024 },
      })
      expect(reserveUpload).toHaveBeenCalledTimes(2)
      expect(uploadReservations.map(({ request }) => request)).toMatchObject([
        {
          sessionId: 'session-1',
          transferId: 'transfer-1:file-1',
          direction: 'upload',
          displayName: '.._unsafe_name_.txt',
          declaredSize: 3,
          mimeType: 'text/plain',
        },
        {
          sessionId: 'session-1',
          transferId: 'transfer-1:file-2',
          direction: 'upload',
          displayName: 'empty.txt',
          declaredSize: 0,
        },
      ])
      media.send(
        encodeProtocolMessage(
          createProtocolMessage(
            'file.upload.chunk',
            { sessionId: 'session-1', viewerGeneration: 1, sequence: 11 },
            {
              transferId: 'transfer-1',
              fileId: 'file-1',
              offset: 0,
              data: Uint8Array.of(1, 2, 3),
            },
          ) as ProtocolMessage,
        ),
      )
      media.send(
        encodeProtocolMessage(
          createProtocolMessage(
            'file.upload.complete',
            { sessionId: 'session-1', viewerGeneration: 1, sequence: 12 },
            { transferId: 'transfer-1' },
          ) as ProtocolMessage,
        ),
      )
      await expect(mediaInbox.nextControl()).resolves.toMatchObject({
        type: 'file.upload.result',
        payload: { transferId: 'transfer-1', delivered: true },
      })
      expect(uploadReservations[0]?.writes).toEqual([
        { offset: 0, data: Uint8Array.of(1, 2, 3) },
      ])
      expect(uploadReservations[1]?.writes).toEqual([])
      expect(uploadReservations.every(({ commit }) => commit.mock.calls.length === 1)).toBe(true)
      expect(cdp.commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: 'DOM.setFileInputFiles',
            sessionId: 'cdp-session-1',
            params: { backendNodeId: 321, files: ['/tmp/remote-tab/0', '/tmp/remote-tab/1'] },
          }),
        ]),
      )

      const downloadGuid = 'download-guid-1'
      await writeFile(join(downloadDirectory, downloadGuid), Uint8Array.of(4, 5, 6))
      cdp.emitEvent('Page.downloadWillBegin', {
        guid: downloadGuid,
        frameId: 'frame-1',
        suggestedFilename: '../unsafe\\report.txt',
        url: 'https://example.test/report.txt',
      })
      cdp.emitEvent('Page.downloadProgress', {
        guid: downloadGuid,
        receivedBytes: 3,
        totalBytes: 3,
        state: 'completed',
      })
      const downloadOffer = await mediaInbox.nextControl()
      expect(downloadOffer).toMatchObject({
        type: 'file.download.offer',
        payload: {
          file: { displayName: '.._unsafe_report.txt', size: 3 },
        },
      })
      if (downloadOffer.type !== 'file.download.offer') {
        throw new Error('Expected file.download.offer')
      }
      media.send(
        encodeProtocolMessage(
          createProtocolMessage(
            'file.download.accept',
            { sessionId: 'session-1', viewerGeneration: 1, sequence: 15 },
            { transferId: downloadOffer.payload.transferId },
          ) as ProtocolMessage,
        ),
      )
      const downloadChunk = await mediaInbox.nextControl()
      expect(downloadChunk).toMatchObject({
        type: 'file.download.chunk',
        payload: {
          transferId: downloadOffer.payload.transferId,
          offset: 0,
          data: Uint8Array.of(4, 5, 6),
        },
      })
      media.send(
        encodeExtensionLoopbackMessage({
          type: 'media.control_forwarded',
          sessionId: downloadChunk.sessionId,
          sequence: downloadChunk.sequence,
        }),
      )
      await expect(mediaInbox.nextControl()).resolves.toMatchObject({
        type: 'file.download.complete',
        payload: { transferId: downloadOffer.payload.transferId },
      })
      media.send(
        encodeProtocolMessage(
          createProtocolMessage(
            'file.download.result',
            { sessionId: 'session-1', viewerGeneration: 1, sequence: 16 },
            { transferId: downloadOffer.payload.transferId, received: true },
          ) as ProtocolMessage,
        ),
      )
      await waitUntil(async () => !(await pathExists(join(downloadDirectory, downloadGuid))))
      expect(audits).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'download.delivered', fields: { size: 3 } }),
        ]),
      )

      const emptyDownloadGuid = 'download-guid-empty'
      await writeFile(join(downloadDirectory, emptyDownloadGuid), new Uint8Array())
      cdp.emitEvent('Page.downloadWillBegin', {
        guid: emptyDownloadGuid,
        frameId: 'frame-1',
        suggestedFilename: 'empty.txt',
        url: 'https://example.test/empty.txt',
      })
      cdp.emitEvent('Page.downloadProgress', {
        guid: emptyDownloadGuid,
        receivedBytes: 0,
        totalBytes: 0,
        state: 'completed',
      })
      const emptyDownloadOffer = await mediaInbox.nextControl()
      if (emptyDownloadOffer.type !== 'file.download.offer') {
        throw new Error('Expected zero-byte file.download.offer')
      }
      media.send(
        encodeProtocolMessage(
          createProtocolMessage(
            'file.download.accept',
            { sessionId: 'session-1', viewerGeneration: 1, sequence: 17 },
            { transferId: emptyDownloadOffer.payload.transferId },
          ) as ProtocolMessage,
        ),
      )
      await expect(mediaInbox.nextControl()).resolves.toMatchObject({
        type: 'file.download.complete',
        payload: { transferId: emptyDownloadOffer.payload.transferId },
      })
      media.send(
        encodeProtocolMessage(
          createProtocolMessage(
            'file.download.result',
            { sessionId: 'session-1', viewerGeneration: 1, sequence: 18 },
            { transferId: emptyDownloadOffer.payload.transferId, received: true },
          ) as ProtocolMessage,
        ),
      )
      await waitUntil(async () => !(await pathExists(join(downloadDirectory, emptyDownloadGuid))))

      const rejectedDownloadGuid = 'download-guid-rejected'
      await writeFile(join(downloadDirectory, rejectedDownloadGuid), Uint8Array.of(7))
      cdp.emitEvent('Page.downloadWillBegin', {
        guid: rejectedDownloadGuid,
        frameId: 'frame-1',
        suggestedFilename: 'rejected.txt',
        url: 'https://example.test/rejected.txt',
      })
      cdp.emitEvent('Page.downloadProgress', {
        guid: rejectedDownloadGuid,
        receivedBytes: 1,
        totalBytes: 1,
        state: 'completed',
      })
      const rejectedDownloadOffer = await mediaInbox.nextControl()
      if (rejectedDownloadOffer.type !== 'file.download.offer') {
        throw new Error('Expected rejected file.download.offer')
      }
      media.send(
        encodeProtocolMessage(
          createProtocolMessage(
            'file.download.cancel',
            { sessionId: 'session-1', viewerGeneration: 1, sequence: 19 },
            { transferId: rejectedDownloadOffer.payload.transferId, reason: 'User declined' },
          ) as ProtocolMessage,
        ),
      )
      await waitUntil(async () => !(await pathExists(join(downloadDirectory, rejectedDownloadGuid))))

      const oversizedDownloadGuid = 'download-guid-oversized'
      await writeFile(join(downloadDirectory, oversizedDownloadGuid), new Uint8Array(17))
      cdp.emitEvent('Page.downloadWillBegin', {
        guid: oversizedDownloadGuid,
        frameId: 'frame-1',
        suggestedFilename: 'oversized.bin',
        url: 'https://example.test/oversized.bin',
      })
      cdp.emitEvent('Page.downloadProgress', {
        guid: oversizedDownloadGuid,
        receivedBytes: 17,
        totalBytes: 17,
        state: 'completed',
      })
      await expect(mediaInbox.nextControl()).resolves.toMatchObject({
        type: 'notice',
        payload: { code: 'FILE_LIMIT_EXCEEDED' },
      })
      await waitUntil(async () => !(await pathExists(join(downloadDirectory, oversizedDownloadGuid))))

      media.send(
        encodeProtocolMessage(
          createProtocolMessage(
            'file.download.accept',
            { sessionId: 'session-1', viewerGeneration: 1, sequence: 20 },
            { transferId: 'unknown-download' },
          ) as ProtocolMessage,
        ),
      )
      await expect(mediaInbox.nextControl()).resolves.toMatchObject({
        type: 'error',
        payload: { code: 'FILE_TRANSFER_FAILED' },
      })

      const pendingPointer = cdp.pauseNextCommand('Input.dispatchMouseEvent')
      media.send(
        encodeProtocolMessage(
          createProtocolMessage(
            'input.pointer',
            { sessionId: 'session-1', viewerGeneration: 1, sequence: 39 },
            {
              event: 'mousePressed',
              x: 100,
              y: 100,
              viewportRevision: 1,
              button: 'left',
              buttons: 1,
              modifiers: 0,
              clickCount: 1,
            },
          ) as ProtocolMessage,
        ),
      )
      await pendingPointer.observed
      cdp.emitEvent('Page.windowOpen', {
        url: 'https://example.test/open-locally',
        windowName: '_blank',
      })
      cdp.emitEvent(
        'Target.targetCreated',
        {
          targetInfo: {
            targetId: 'child-target-1',
            type: 'page',
            url: '',
            openerId: 'target-1',
          },
        },
        'browser',
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(cdp.commands).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: 'Target.closeTarget',
            params: { targetId: 'child-target-1' },
          }),
        ]),
      )
      pendingPointer.resume()
      const localOpen = await mediaInbox.nextControl()
      expect(localOpen).toMatchObject({
        type: 'navigation.local_open_request',
        payload: { url: 'https://example.test/open-locally' },
      })
      if (localOpen.type !== 'navigation.local_open_request') {
        throw new Error('Expected navigation.local_open_request')
      }
      expect(authorizeNavigation).toHaveBeenCalledWith({
        sessionId: 'session-1',
        action: 'local-open',
        url: 'https://example.test/open-locally',
      })
      expect(cdp.commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: 'Target.closeTarget',
            params: { targetId: 'child-target-1' },
          }),
        ]),
      )
      media.send(
        encodeProtocolMessage(
          createProtocolMessage(
            'navigation.local_open_result',
            { sessionId: 'session-1', viewerGeneration: 1, sequence: 40 },
            { requestId: localOpen.payload.requestId, approved: true },
          ) as ProtocolMessage,
        ),
      )
      await waitUntil(() =>
        audits.some(
          (event) =>
            typeof event === 'object' &&
            event !== null &&
            'name' in event &&
            event.name === 'local-open.approved',
        ),
      )

      cdp.emitEvent('Runtime.bindingCalled', {
        name: '__browshareRemoteTabOpen',
        payload: JSON.stringify({ url: 'https://example.test/intercepted-open' }),
      })
      const interceptedOpen = await mediaInbox.nextControl()
      expect(interceptedOpen).toMatchObject({
        type: 'navigation.local_open_request',
        payload: { url: 'https://example.test/intercepted-open' },
      })
      if (interceptedOpen.type !== 'navigation.local_open_request') {
        throw new Error('Expected intercepted navigation.local_open_request')
      }
      media.send(
        encodeProtocolMessage(
          createProtocolMessage(
            'navigation.local_open_result',
            { sessionId: 'session-1', viewerGeneration: 1, sequence: 41 },
            { requestId: interceptedOpen.payload.requestId, approved: false },
          ) as ProtocolMessage,
        ),
      )
      await waitUntil(() =>
        audits.some(
          (event) =>
            typeof event === 'object' &&
            event !== null &&
            'name' in event &&
            event.name === 'child-target.intercepted',
        ),
      )

      session.sendNotice({
        level: 'info',
        code: 'SESSION_HINT',
        message: 'The remote session is ready.',
      })
      await expect(mediaInbox.nextControl()).resolves.toMatchObject({
        type: 'notice',
        payload: { level: 'info', code: 'SESSION_HINT' },
      })

      media.send(
        encodeProtocolMessage(
          createProtocolMessage(
            'navigation.local_open_result',
            { sessionId: 'session-1', viewerGeneration: 1, sequence: 42 },
            { requestId: 'unknown-request', approved: false },
          ) as ProtocolMessage,
        ),
      )
      await expect(mediaInbox.nextControl()).resolves.toMatchObject({
        type: 'error',
        payload: { code: 'PROTOCOL_MESSAGE_INVALID' },
      })

      cdp.emitEvent('Page.windowOpen', {
        url: 'https://example.test/expired-local-open',
        windowName: '_blank',
      })
      cdp.emitEvent(
        'Target.targetCreated',
        {
          targetInfo: {
            targetId: 'child-target-expiring',
            type: 'page',
            url: '',
            openerId: 'target-1',
          },
        },
        'browser',
      )
      const expiringLocalOpen = await mediaInbox.nextControl()
      if (expiringLocalOpen.type !== 'navigation.local_open_request') {
        throw new Error('Expected expiring navigation.local_open_request')
      }
      await new Promise((resolve) => setTimeout(resolve, 40))
      media.send(
        encodeProtocolMessage(
          createProtocolMessage(
            'navigation.local_open_result',
            { sessionId: 'session-1', viewerGeneration: 1, sequence: 43 },
            { requestId: expiringLocalOpen.payload.requestId, approved: true },
          ) as ProtocolMessage,
        ),
      )
      await expect(mediaInbox.nextControl()).resolves.toMatchObject({
        type: 'error',
        payload: { code: 'PROTOCOL_MESSAGE_INVALID' },
      })

      cdp.emitEvent('Page.fileChooserOpened', {
        backendNodeId: 322,
        mode: 'selectSingle',
      })
      const rejectedUploadRequest = await mediaInbox.nextControl()
      if (rejectedUploadRequest.type !== 'file.upload.request') {
        throw new Error('Expected second file.upload.request')
      }
      media.send(
        encodeProtocolMessage(
          createProtocolMessage(
            'file.upload.offer',
            { sessionId: 'session-1', viewerGeneration: 1, sequence: 13 },
            {
              requestId: rejectedUploadRequest.payload.requestId,
              transferId: 'transfer-2',
              files: [{ fileId: 'file-3', displayName: 'broken.txt', size: 3 }],
            },
          ) as ProtocolMessage,
        ),
      )
      await expect(mediaInbox.nextControl()).resolves.toMatchObject({
        type: 'file.upload.accept',
        payload: { transferId: 'transfer-2' },
      })
      media.send(
        encodeProtocolMessage(
          createProtocolMessage(
            'file.upload.chunk',
            { sessionId: 'session-1', viewerGeneration: 1, sequence: 14 },
            {
              transferId: 'transfer-2',
              fileId: 'file-3',
              offset: 1,
              data: Uint8Array.of(9),
            },
          ) as ProtocolMessage,
        ),
      )
      await expect(mediaInbox.nextControl()).resolves.toMatchObject({
        type: 'file.upload.result',
        payload: {
          transferId: 'transfer-2',
          delivered: false,
          error: { code: 'PROTOCOL_MESSAGE_INVALID' },
        },
      })
      expect(uploadReservations[2]?.abort).toHaveBeenCalledOnce()
      expect(uploadReservations[2]?.commit).not.toHaveBeenCalled()

      media.send(
        encodeProtocolMessage(
          createProtocolMessage(
            'quality.request',
            { sessionId: 'session-1', viewerGeneration: 1, sequence: 100 },
            { preset: 'high' },
          ) as ProtocolMessage,
        ),
      )
      await expect(mediaInbox.nextText()).resolves.toEqual({
        type: 'media.set_quality',
        sessionId: 'session-1',
        settings: {
          preset: 'high',
          maxBitrate: 6_000_000,
          maxFrameRate: 60,
          scaleResolutionDownBy: 1,
        },
      })
      media.send(
        encodeExtensionLoopbackMessage({
          type: 'media.quality_changed',
          sessionId: 'session-1',
          settings: {
            preset: 'high',
            maxBitrate: 6_000_000,
            maxFrameRate: 60,
            scaleResolutionDownBy: 1,
          },
        }),
      )
      await expect(mediaInbox.nextControl()).resolves.toMatchObject({
        type: 'quality.ack',
        payload: { preset: 'high', maxBitrate: 6_000_000 },
      })

      media.send(
        encodeExtensionLoopbackMessage({
          type: 'media.diagnostic',
          sessionId: 'session-1',
          diagnostic: {
            name: 'webrtc.media-metrics',
            direction: 'outbound',
            kind: 'video',
            codec: 'video/VP8',
            bitrateBps: 1_500_000,
            roundTripTimeMs: 22,
            sampleIntervalMs: 5_000,
          },
        }),
      )
      await waitUntil(() => diagnostics.length === 1)
      expect(diagnostics[0]).toMatchObject({
        sessionId: 'session-1',
        name: 'webrtc.media-metrics',
        fields: {
          direction: 'outbound',
          kind: 'video',
          codec: 'video/VP8',
          bitrateBps: 1_500_000,
          roundTripTimeMs: 22,
          sampleIntervalMs: 5_000,
        },
      })

      gatewaySocket.send(encodeSignalingMessage({ type: 'signal.restart-ice' }))
      await expect(mediaInbox.nextText()).resolves.toEqual({
        type: 'media.restart_ice',
        sessionId: 'session-1',
      })

      media.send(
        encodeProtocolMessage(
          createProtocolMessage(
            'input.pointer',
            { sessionId: 'session-1', viewerGeneration: 1, sequence: 2 },
            {
              event: 'mousePressed',
              x: 20,
              y: 30,
              viewportRevision: 1,
              button: 'left',
              buttons: 1,
              modifiers: 0,
              clickCount: 1,
            },
          ) as ProtocolMessage,
        ),
      )
      await waitUntil(() => cdp.commands.some((command) => command.method === 'Input.dispatchMouseEvent' && command.params?.x === 20 && command.params?.y === 30))

      const hoverStart = cdp.commands.length
      const pausedHover = cdp.pauseNextCommand('Input.dispatchMouseEvent')
      const hover = (x: number, sequence: number) => media.send(encodeProtocolMessage(createProtocolMessage('input.pointer',
        { sessionId: session.id, viewerGeneration: 1, sequence },
        { event: 'mouseMoved', x, y: 30, viewportRevision: 1, button: 'none', buttons: 0, modifiers: 0, clickCount: 0 },
      )))
      hover(1, 100)
      await pausedHover.observed
      for (let x = 2; x <= 100; x++) hover(x, 100 + x)
      media.send(encodeProtocolMessage(createProtocolMessage('input.key',
        { sessionId: session.id, viewerGeneration: 1, sequence: 201 },
        { event: 'keyUp', key: 'Shift', code: 'ShiftLeft', modifiers: 0 },
      )))
      hover(200, 202)
      hover(250, 203)
      await new Promise(resolve => setTimeout(resolve, 20))
      pausedHover.resume()
      await waitUntil(() => cdp.commands.some(command => command.method === 'Input.dispatchMouseEvent' && command.params?.x === 250))
      expect(cdp.commands.slice(hoverStart).filter(command => ['Input.dispatchMouseEvent', 'Input.dispatchKeyEvent'].includes(command.method))
        .map(command => command.method === 'Input.dispatchKeyEvent' ? 'key' : command.params?.x)).toEqual([1, 100, 'key', 250])

      media.send(
        encodeProtocolMessage(
          createProtocolMessage(
            'input.key',
            { sessionId: 'session-1', viewerGeneration: 1, sequence: 3 },
            {
              event: 'keyDown',
              key: 'B',
              code: 'KeyB',
              text: 'B',
              unmodifiedText: 'B',
              modifiers: 0,
            },
          ) as ProtocolMessage,
        ),
      )
      await waitUntil(() => cdp.commands.some((command) => command.method === 'Input.dispatchKeyEvent' && command.params?.key === 'B'))
      expect(cdp.commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: 'Input.dispatchKeyEvent',
            params: expect.objectContaining({ key: 'B', code: 'KeyB', text: 'B' }),
          }),
        ]),
      )

      media.send(
        encodeProtocolMessage(
          createProtocolMessage(
            'navigation.request',
            { sessionId: 'session-1', viewerGeneration: 1, sequence: 4 },
            { action: 'go', url: 'https://example.test/next' },
          ) as ProtocolMessage,
        ),
      )
      await expect(mediaInbox.nextControl()).resolves.toMatchObject({
        type: 'navigation.result',
        payload: { allowed: true, action: 'go', currentUrl: 'https://example.test/redirected' },
      })
      expect(authorizeNavigation).toHaveBeenCalledWith({
        sessionId: 'session-1',
        action: 'go',
        source: 'viewer',
        url: 'https://example.test/next',
      })
      expect(cdp.commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ method: 'Page.navigate', sessionId: 'cdp-session-1' }),
        ]),
      )

      media.send(
        encodeProtocolMessage(
          createProtocolMessage(
            'session.suspend',
            { sessionId: 'session-1', viewerGeneration: 1, sequence: 5 },
            {},
          ) as ProtocolMessage,
        ),
      )
      await expect(mediaInbox.nextText()).resolves.toEqual({
        type: 'media.suspend',
        sessionId: 'session-1',
      })
      media.send(
        encodeExtensionLoopbackMessage({
          type: 'media.suspension_changed',
          sessionId: 'session-1',
          suspended: true,
        }),
      )
      await expect(mediaInbox.nextControl()).resolves.toMatchObject({
        type: 'session.state',
        payload: { state: 'SUSPENDED' },
      })

      const abandonedDownloadGuid = 'download-guid-abandoned'
      await writeFile(join(downloadDirectory, abandonedDownloadGuid), Uint8Array.of(8))
      cdp.emitEvent('Page.downloadWillBegin', {
        guid: abandonedDownloadGuid,
        frameId: 'frame-1',
        suggestedFilename: 'abandoned.txt',
        url: 'https://example.test/abandoned.txt',
      })
      cdp.emitEvent('Page.downloadProgress', {
        guid: abandonedDownloadGuid,
        receivedBytes: 1,
        totalBytes: 1,
        state: 'completed',
      })
      await expect(mediaInbox.nextControl()).resolves.toMatchObject({
        type: 'file.download.offer',
        payload: { file: { displayName: 'abandoned.txt', size: 1 } },
      })

      const replacementGatewaySocketPromise = nextGatewayConnection(signaling)
      const replacementTicketPromise = session.createViewerTicket({
        viewerGeneration: 2,
        gatewayId: 'gateway-1',
        capabilities: ['navigation', 'backForward', 'reload'],
        expiresInSeconds: 60,
      })
      const replacementStop = await mediaInbox.nextText()
      expect(replacementStop).toMatchObject({
        type: 'media.stop',
        sessionId: 'session-1',
        reason: 'Viewer generation replaced',
      })
      if (replacementStop.type !== 'media.stop') {
        throw new Error('Expected replacement media.stop')
      }
      media.send(
        encodeExtensionLoopbackMessage({
          type: 'media.stopped',
          requestId: replacementStop.requestId,
          sessionId: replacementStop.sessionId,
        }),
      )
      const replacementTicket = await replacementTicketPromise
      await waitUntil(async () => !(await pathExists(join(downloadDirectory, abandonedDownloadGuid))))
      expect(replacementTicket.claims.viewerGeneration).toBe(2)
      expect(session.getState()).toBe('RECONNECTING')
      await expect(gatewayInbox.nextSignaling()).resolves.toMatchObject({
        type: 'signal.error',
        error: { code: 'VIEWER_REPLACED', retryable: false },
      })

      const { socket: replacementGatewaySocket, inbox: replacementGatewayInbox } = await replacementGatewaySocketPromise
      await expect(replacementGatewayInbox.nextSignaling()).resolves.toEqual({
        type: 'core.bind',
        bindingToken: 'binding-token',
        sessionId: 'session-1',
        viewerGeneration: 2,
        gatewayId: 'gateway-1',
      })
      replacementGatewaySocket.send(
        encodeSignalingMessage({
          type: 'signal.ready',
          role: 'core',
          sessionId: 'session-1',
          viewerGeneration: 2,
          capabilities: ['navigation', 'backForward', 'reload'],
          iceServers: [],
        }),
      )
      replacementGatewaySocket.send(encodeSignalingMessage({ type: 'signal.peer-ready' }))
      await expect(mediaInbox.nextText()).resolves.toEqual({
        type: 'media.peer_ready',
        sessionId: 'session-1',
      })

      const replacementCapture = await serviceWorkerInbox.nextText()
      expect(replacementCapture).toMatchObject({
        type: 'capture.prepare',
        sessionId: 'session-1',
        viewerGeneration: 2,
      })
      if (replacementCapture.type !== 'capture.prepare') {
        throw new Error('Expected replacement capture.prepare')
      }
      serviceWorker.send(
        encodeExtensionLoopbackMessage({
          type: 'capture.prepared',
          requestId: replacementCapture.requestId,
          sessionId: replacementCapture.sessionId,
          streamId: 'stream-2',
        }),
      )
      await expect(mediaInbox.nextText()).resolves.toMatchObject({
        type: 'media.start',
        sessionId: 'session-1',
        viewerGeneration: 2,
        streamId: 'stream-2',
      })

      media.send(
        encodeProtocolMessage(
          createProtocolMessage(
            'input.key',
            { sessionId: 'session-1', viewerGeneration: 1, sequence: 6 },
            { event: 'keyDown', key: 'X', code: 'KeyX', text: 'X', modifiers: 0 },
          ) as ProtocolMessage,
        ),
      )
      await expect(mediaInbox.nextControl()).resolves.toMatchObject({
        type: 'error',
        sessionId: 'session-1',
        viewerGeneration: 2,
        payload: { code: 'VIEWER_REPLACED' },
      })

      media.send(
        encodeProtocolMessage(
          createProtocolMessage(
            'hello',
            { sessionId: 'session-1', viewerGeneration: 2, sequence: 1 },
            {
              clientVersion: 'replacement-viewer',
              capabilities: ['navigation', 'backForward', 'reload'],
            },
          ) as ProtocolMessage,
        ),
      )
      await expect(mediaInbox.nextControl()).resolves.toMatchObject({
        type: 'hello.accepted',
        viewerGeneration: 2,
      })
      expect(session.getState()).toBe('CONNECTED')

      replacementGatewaySocket.send(
        encodeSignalingMessage({ type: 'signal.peer-left', role: 'viewer' }),
      )
      await expect(mediaInbox.nextText()).resolves.toEqual({
        type: 'media.peer_left',
        sessionId: 'session-1',
      })
      await waitUntil(() => session.getState() === 'RECONNECTING')
      expect(cleanupSession).not.toHaveBeenCalled()

      media.send(
        encodeProtocolMessage(
          createProtocolMessage(
            'session.suspend',
            { sessionId: 'session-1', viewerGeneration: 2, sequence: 2 },
            {},
          ) as ProtocolMessage,
        ),
      )
      await expect(mediaInbox.nextControl()).resolves.toMatchObject({
        type: 'error',
        viewerGeneration: 2,
        payload: { code: 'ILLEGAL_STATE_TRANSITION' },
      })
      expect(session.getState()).toBe('RECONNECTING')
      expect(cleanupSession).not.toHaveBeenCalled()

      const reconnectGatewaySocketPromise = nextGatewayConnection(signaling)
      const reconnectTicketPromise = session.createViewerTicket({
        viewerGeneration: 3,
        gatewayId: 'gateway-1',
        capabilities: ['navigation'],
        expiresInSeconds: 60,
      })
      const reconnectStop = await mediaInbox.nextText()
      expect(reconnectStop).toMatchObject({
        type: 'media.stop',
        sessionId: 'session-1',
        reason: 'Viewer generation replaced',
      })
      if (reconnectStop.type !== 'media.stop') {
        throw new Error('Expected reconnect media.stop')
      }
      media.send(
        encodeExtensionLoopbackMessage({
          type: 'media.stopped',
          requestId: reconnectStop.requestId,
          sessionId: reconnectStop.sessionId,
        }),
      )
      const reconnectTicket = await reconnectTicketPromise
      expect(reconnectTicket.claims.viewerGeneration).toBe(3)
      const { inbox: reconnectGatewayInbox } = await reconnectGatewaySocketPromise
      await expect(reconnectGatewayInbox.nextSignaling()).resolves.toMatchObject({
        type: 'core.bind',
        viewerGeneration: 3,
      })

      const closing = session.close('test complete')
      const repeatedClosing = session.close('repeated close')
      expect(repeatedClosing).toBe(closing)
      let repeatedClosed = false
      void repeatedClosing.then(() => { repeatedClosed = true })
      const closingStop = await mediaInbox.nextText()
      expect(repeatedClosed).toBe(false)
      expect(closingStop).toMatchObject({
        type: 'media.stop',
        sessionId: 'session-1',
        reason: 'test complete',
      })
      if (closingStop.type !== 'media.stop') {
        throw new Error('Expected closing media.stop')
      }
      media.send(
        encodeExtensionLoopbackMessage({
          type: 'media.stopped',
          requestId: closingStop.requestId,
          sessionId: closingStop.sessionId,
        }),
      )
      await Promise.all([closing, repeatedClosing])
      expect(repeatedClosed).toBe(true)
      expect(session.getState()).toBe('CLOSED')
      expect(cleanupSession).toHaveBeenCalledWith('session-1')
      expect(stateChanges).toEqual([
        'READY',
        'NEGOTIATING',
        'CONNECTED',
        'SUSPENDED',
        'RECONNECTING',
        'CONNECTED',
        'RECONNECTING',
        'CLOSING',
        'CLOSED',
      ])
    } finally {
      await core.close()
      serviceWorker.terminate()
      media.terminate()
      await loopback.close()
      for (const client of signaling.clients) {
        client.terminate()
      }
      await closeWebSocketServer(signaling)
      await cdp.close()
      await rm(downloadDirectory, { recursive: true, force: true })
    }
  })
})

function nextGatewayConnection(server: WebSocketServer): Promise<{ socket: WebSocket; inbox: FrameInbox }> {
  // Core can send its bind before the caller finishes awaiting storage cleanup or a Ticket.
  // Attach the observer in the connection event so that first frame cannot be lost.
  return new Promise(resolve => server.once('connection', socket => {
    resolve({ socket, inbox: new FrameInbox(socket) })
  }))
}

class FrameInbox {
  readonly #texts: string[] = []
  readonly #binaries: Uint8Array[] = []
  readonly #textWaiters: Array<(value: string) => void> = []
  readonly #binaryWaiters: Array<(value: Uint8Array) => void> = []

  public constructor(socket: WebSocket) {
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        const value = Uint8Array.from(data as Buffer)
        const waiter = this.#binaryWaiters.shift()
        waiter === undefined ? this.#binaries.push(value) : waiter(value)
      } else {
        const value = data.toString()
        const waiter = this.#textWaiters.shift()
        waiter === undefined ? this.#texts.push(value) : waiter(value)
      }
    })
  }

  public async nextText(): Promise<ExtensionLoopbackMessage> {
    return decodeExtensionLoopbackMessage(await this.#nextTextRaw())
  }

  public async nextSignaling(): Promise<SignalingMessage> {
    return decodeSignalingMessage(await this.#nextTextRaw())
  }

  public async nextControl(): Promise<ProtocolMessage> {
    const current = this.#binaries.shift()
    const bytes = current ?? (await new Promise<Uint8Array>((resolve) => this.#binaryWaiters.push(resolve)))
    const message = decodeProtocolMessage(bytes)
    if (message === undefined) {
      throw new Error('Expected a known control message')
    }
    return message
  }

  async #nextTextRaw(): Promise<string> {
    const current = this.#texts.shift()
    return current ?? new Promise<string>((resolve) => this.#textWaiters.push(resolve))
  }
}

function bindExtensionPeer(socket: WebSocket, role: 'service-worker' | 'media'): void {
  socket.send(
    encodeExtensionLoopbackMessage({
      type: 'runtime.bind',
      role,
      secret: '0123456789abcdef0123456789abcdef',
      extensionId: 'c'.repeat(32),
      extensionVersion: '0.1.25',
      runtimeGeneration: 'runtime-3',
    }),
  )
}

async function createCdpFixture(): Promise<{
  endpoint: string
  commands: RecordedCdpCommand[]
  emitEvent(method: string, params: Record<string, unknown>, scope?: 'target' | 'browser'): void
  pauseNextCommand(method: string): { observed: Promise<void>; resume(): void }
  close(): Promise<void>
}> {
  const commands: RecordedCdpCommand[] = []
  const commandPauses = new Map<
    string,
    Array<{ observed(): void; resumed: Promise<void>; resume(): void }>
  >()
  const sockets = new Set<WebSocket>()
  const server = createServer()
  const webSockets = new WebSocketServer({ noServer: true })
  server.on('request', (request, response) => {
    if (request.url !== '/json/version') {
      response.writeHead(404).end()
      return
    }
    const address = server.address() as AddressInfo
    response.setHeader('content-type', 'application/json')
    response.end(
      JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/devtools/browser/mock` }),
    )
  })
  server.on('upgrade', (request, socket, head) => {
    webSockets.handleUpgrade(request, socket, head, (webSocket) =>
      webSockets.emit('connection', webSocket, request),
    )
  })
  webSockets.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.on('message', (data) => {
      void (async () => {
      const command = JSON.parse(data.toString()) as RecordedCdpCommand
      commands.push(command)
      const pause = commandPauses.get(command.method)?.shift()
      if (pause !== undefined) {
        pause.observed()
        await pause.resumed
      }
      if (command.method === 'Page.navigate') {
        // Chrome reports the committed destination, which can differ after a redirect.
        const url = command.params?.url === 'https://example.test/next'
          ? 'https://example.test/redirected' : command.params?.url
        socket.send(JSON.stringify({
          method: 'Page.frameNavigated', sessionId: 'cdp-session-1',
          params: { frame: { id: 'frame-1', url } },
        }))
      }
      const result =
        command.method === 'Target.createTarget'
          ? { targetId: 'target-1' }
          : command.method === 'Target.getTargets'
            ? { targetInfos: [{ targetId: 'target-1', type: 'page', url: 'about:blank' }] }
          : command.method === 'Target.closeTarget'
            ? { success: true }
          : command.method === 'Target.attachToTarget'
            ? { sessionId: 'cdp-session-1' }
            : command.method === 'Page.getFrameTree'
              ? { frameTree: { frame: { id: 'frame-1', url: 'about:blank' } } }
            : {}
      socket.send(JSON.stringify({ id: command.id, result }))
      })()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    commands,
    emitEvent: (method, params, scope = 'target') => {
      for (const socket of sockets) {
        socket.send(
          JSON.stringify({
            method,
            params,
            ...(scope === 'target' ? { sessionId: 'cdp-session-1' } : {}),
          }),
        )
      }
    },
    pauseNextCommand: (method) => {
      let markObserved: () => void = () => undefined
      let resume: () => void = () => undefined
      const observed = new Promise<void>((resolve) => {
        markObserved = resolve
      })
      const resumed = new Promise<void>((resolve) => {
        resume = resolve
      })
      const pauses = commandPauses.get(method) ?? []
      pauses.push({ observed: markObserved, resumed, resume })
      commandPauses.set(method, pauses)
      return { observed, resume }
    },
    close: async () => {
      for (const socket of sockets) {
        socket.terminate()
      }
      await closeWebSocketServer(webSockets)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      )
    },
  }
}

async function openWebSocket(endpoint: string, extensionId?: string): Promise<WebSocket> {
  const socket = new WebSocket(
    endpoint,
    extensionId === undefined ? {} : { origin: `chrome-extension://${extensionId}` },
  )
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  return socket
}

async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  )
}

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for integration state')
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
