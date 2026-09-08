import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createProtocolMessage,
  decodeProtocolMessage,
  decodeSignalingMessage,
  encodeProtocolMessage,
  encodeSignalingMessage,
  type Capability,
  type ProtocolMessage,
  type SignalingMessage,
} from '@browshare/remote-tab-protocol'

import { createRemoteTabClient } from '../src/index.js'

describe('BrowserRemoteTabClient ICE recovery', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    FakeWebSocket.instances.length = 0
    FakePeerConnection.instances.length = 0
  })

  it('publishes negotiated cursor keywords only for the current viewport', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection)
    const client = createRemoteTabClient({ ticket: 'viewer-ticket', endpoint: 'wss://signal.example.test' })
    const cursors: string[] = []
    client.addEventListener(event => { if (event.type === 'cursor-change') cursors.push(event.cursor) })
    try {
      const { reliable } = await connectClient(client, ['cursorFeedback'])
      const send = (viewportRevision: number) => reliable.receive(encodeProtocolMessage(createProtocolMessage('cursor.changed',
        { sessionId: 'session-1', viewerGeneration: 1, sequence: viewportRevision },
        { cursor: 'text', viewportRevision, windowRevision: 1 })))
      send(2)
      send(1)
      await Promise.resolve()
      expect(cursors).toEqual(['text'])
    } finally { await client.disconnect() }
  })

  it('keeps pending playback when audio and video arrive in the same MediaStream', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection)
    const client = createRemoteTabClient({
      ticket: 'viewer-ticket',
      endpoint: 'wss://signal.example.test',
    })
    const stream = { id: 'remote-stream' } as MediaStream
    const blockedReasons: string[] = []
    client.addEventListener((event) => {
      if (event.type === 'playback-blocked') blockedReasons.push(event.reason)
    })
    const assignments: (MediaProvider | null)[] = []
    let srcObject: MediaProvider | null = null
    const playback = Promise.withResolvers<void>()
    const play = vi.fn(() => playback.promise)
    const video = {
      get srcObject() {
        return srcObject
      },
      set srcObject(value: MediaProvider | null) {
        assignments.push(value)
        srcObject = value
      },
      play,
    } as unknown as HTMLVideoElement
    client.attachVideo(video)
    try {
      await connectClient(client, [])
      const peer = FakePeerConnection.instances.at(-1)!
      peer.dispatchEvent(eventWith('track', { track: { kind: 'video' }, streams: [stream] }))
      peer.dispatchEvent(eventWith('track', { track: { kind: 'audio' }, streams: [stream] }))
      expect([...assignments]).toEqual([null, stream])
      expect(play).toHaveBeenCalledTimes(1)
      expect(video.srcObject).toBe(stream)
      playback.reject(new DOMException('User activation required', 'NotAllowedError'))
      await Promise.resolve()
      expect(blockedReasons).toEqual(['user-activation-required'])
    } finally {
      playback.resolve()
      await client.disconnect()
    }
  })

  it('binds a new stream identity and preserves detached stream updates and reattachment', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection)
    const client = createRemoteTabClient({
      ticket: 'viewer-ticket',
      endpoint: 'wss://signal.example.test',
    })
    const stream = { id: 'remote-stream' } as MediaStream
    const replacement = { id: 'remote-stream' } as MediaStream
    const detachedStream = { id: 'detached-stream' } as MediaStream
    const play = vi.fn(async () => {})
    const video = { srcObject: null, play } as unknown as HTMLVideoElement
    client.attachVideo(video)
    try {
      await connectClient(client, [])
      const peer = FakePeerConnection.instances.at(-1)!
      peer.dispatchEvent(eventWith('track', { track: { kind: 'video' }, streams: [stream] }))
      peer.dispatchEvent(eventWith('track', { track: { kind: 'video' }, streams: [replacement] }))
      expect(video.srcObject).toBe(replacement)
      expect(play).toHaveBeenCalledTimes(2)

      client.detachVideo()
      expect(video.srcObject).toBeNull()
      peer.dispatchEvent(eventWith('track', { track: { kind: 'video' }, streams: [detachedStream] }))
      expect(video.srcObject).toBeNull()
      expect(play).toHaveBeenCalledTimes(2)

      client.attachVideo(video)
      expect(video.srcObject).toBe(detachedStream)
      expect(play).toHaveBeenCalledTimes(3)
    } finally {
      await client.disconnect()
    }
    expect(video.srcObject).toBeNull()
  })

  it('requests an ICE restart over the authenticated signaling pair and restores state', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection)

    const client = createRemoteTabClient({
      ticket: 'viewer-ticket',
      endpoint: 'wss://signal.example.test',
      iceRestart: { maxAttempts: 2, disconnectedDelayMs: 1, attemptTimeoutMs: 50 },
    })
    const states: string[] = []
    const quality: string[] = []
    client.addEventListener((event) => {
      if (event.type === 'connection-state-change') states.push(event.state)
      if (event.type === 'quality-change') quality.push(event.quality.preset)
    })

    const connecting = client.connect()
    const socket = FakeWebSocket.instances[0]
    expect(socket).toBeDefined()
    socket?.open()
    expect(socket?.sent.map((value) => decodeSignalingMessage(value))).toEqual([
      { type: 'viewer.bind', ticket: 'viewer-ticket' },
    ])

    socket?.receive({
      type: 'signal.ready',
      role: 'viewer',
      sessionId: 'session-1',
      viewerGeneration: 3,
      capabilities: ['qualityControl', 'diagnostics'],
      iceServers: [],
      iceTransportPolicy: 'all',
    })
    await waitUntil(() => FakePeerConnection.instances.length === 1)
    const peer = FakePeerConnection.instances[0]
    expect(peer).toBeDefined()
    const reliable = new FakeDataChannel('control-reliable')
    peer?.emitDataChannel(reliable)
    reliable.open()
    expect(decodeProtocolMessage(reliable.sent[0] ?? new Uint8Array())).toMatchObject({
      type: 'hello',
      sessionId: 'session-1',
      viewerGeneration: 3,
    })

    reliable.receive(
      encodeProtocolMessage(
        createProtocolMessage(
          'hello.accepted',
          { sessionId: 'session-1', viewerGeneration: 3, sequence: 1 },
          {
            capabilities: ['qualityControl', 'diagnostics'],
            viewport: {
              width: 1280,
              height: 720,
              deviceScaleFactor: 1,
              frameRate: 30,
              revision: 1,
            },
          },
        ) as ProtocolMessage,
      ),
    )
    await connecting
    expect(client.state).toBe('CONNECTED')
    const changingQuality = client.requestQuality('high')
    expect(decodeProtocolMessage(reliable.sent[1] ?? new Uint8Array())).toMatchObject({
      type: 'quality.request',
      payload: { preset: 'high' },
    })
    reliable.receive(
      encodeProtocolMessage(
        createProtocolMessage(
          'quality.ack',
          { sessionId: 'session-1', viewerGeneration: 3, sequence: 2 },
          {
            preset: 'high',
            maxBitrate: 6_000_000,
            maxFrameRate: 60,
            scaleResolutionDownBy: 1,
          },
        ) as ProtocolMessage,
      ),
    )
    await changingQuality
    await waitUntil(() => quality.length === 1)
    expect(quality).toEqual(['high'])

    const rejectedSuspend = client.suspend()
    reliable.receive(
      encodeProtocolMessage(
        createProtocolMessage(
          'error',
          { sessionId: 'session-1', viewerGeneration: 3, sequence: 3 },
          {
            code: 'ILLEGAL_STATE_TRANSITION',
            message: 'Suspend raced with another lifecycle transition',
            retryable: false,
          },
        ) as ProtocolMessage,
      ),
    )
    await expect(rejectedSuspend).rejects.toMatchObject({ code: 'ILLEGAL_STATE_TRANSITION' })
    expect(client.state).toBe('CONNECTED')

    peer?.setConnectionState('failed')
    await waitUntil(() => socket?.sent.length === 2)
    expect(decodeSignalingMessage(socket?.sent[1] ?? '')).toEqual({ type: 'signal.restart-ice' })
    expect(client.state).toBe('RECONNECTING')

    socket?.receive({
      type: 'signal.description',
      description: { type: 'offer', sdp: 'v=0\r\nice-restart' },
    })
    await waitUntil(() => peer?.answersCreated === 1)
    expect(decodeSignalingMessage(socket?.sent[2] ?? '')).toEqual({
      type: 'signal.description',
      description: { type: 'answer', sdp: 'v=0\r\nanswer' },
    })

    peer?.setConnectionState('connected')
    expect(client.state).toBe('CONNECTED')
    expect(states).toEqual(['NEGOTIATING', 'CONNECTED', 'RECONNECTING', 'CONNECTED'])

    await client.disconnect()
  })

  it('asks the Embedder for a fresh higher-generation Ticket when signaling is gone', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection)
    const getConnection = vi.fn(async () => ({
      ticket: 'viewer-ticket-2',
      endpoint: 'wss://signal-2.example.test',
    }))
    const client = createRemoteTabClient({
      ticket: 'viewer-ticket-1',
      endpoint: 'wss://signal-1.example.test',
      reconnect: {
        getConnection,
        maxAttempts: 2,
        minimumDelayMs: 1,
        maximumDelayMs: 2,
      },
    })

    const connecting = client.connect()
    const firstSocket = FakeWebSocket.instances[0]
    firstSocket?.open()
    firstSocket?.receive(readyMessage(3))
    await waitUntil(() => FakePeerConnection.instances.length === 1)
    const firstPeer = FakePeerConnection.instances[0]
    const firstReliable = new FakeDataChannel('control-reliable')
    firstPeer?.emitDataChannel(firstReliable)
    firstReliable.open()
    firstReliable.receive(acceptedMessage(3))
    await connecting
    firstPeer?.setConnectionState('connected')

    firstSocket?.close()
    expect(client.state).toBe('CONNECTED')
    firstPeer?.setConnectionState('failed')
    await waitUntil(() => FakeWebSocket.instances.length === 2)
    expect(getConnection).toHaveBeenCalledWith({
      attempt: 1,
      cause: expect.objectContaining({ code: 'ICE_FAILED', retryable: true }),
      previousSessionId: 'session-1',
      previousViewerGeneration: 3,
    })

    const secondSocket = FakeWebSocket.instances[1]
    expect(secondSocket?.url).toBe('wss://signal-2.example.test')
    secondSocket?.open()
    expect(decodeSignalingMessage(secondSocket?.sent[0] ?? '')).toEqual({
      type: 'viewer.bind',
      ticket: 'viewer-ticket-2',
    })
    secondSocket?.receive(readyMessage(4))
    await waitUntil(() => FakePeerConnection.instances.length === 2)
    const secondPeer = FakePeerConnection.instances[1]
    const secondReliable = new FakeDataChannel('control-reliable')
    secondPeer?.emitDataChannel(secondReliable)
    secondReliable.open()
    secondReliable.receive(acceptedMessage(4))
    await waitUntil(() => client.state === 'CONNECTED')

    expect(client.state).toBe('CONNECTED')
    await client.disconnect()
  })

  it('emits redacted inbound media and DataChannel metrics when diagnostics are granted', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection)
    const client = createRemoteTabClient({
      ticket: 'viewer-ticket',
      endpoint: 'wss://signal.example.test',
    })
    const diagnostics: unknown[] = []
    client.addEventListener((event) => {
      if (event.type === 'diagnostic') diagnostics.push(event.diagnostic)
    })

    const connecting = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive(readyMessage(1))
    await waitUntil(() => FakePeerConnection.instances.length === 1)
    const peer = FakePeerConnection.instances[0]!
    peer.statsReport = statsReport([
      { id: 'transport-internal', type: 'transport', selectedCandidatePairId: 'pair-internal' },
      {
        id: 'pair-internal',
        type: 'candidate-pair',
        state: 'succeeded',
        nominated: true,
        currentRoundTripTime: 0.025,
        remoteAddress: '198.51.100.9',
      },
      { id: 'codec-internal', type: 'codec', mimeType: 'video/VP8' },
      {
        id: 'rtp-internal',
        type: 'inbound-rtp',
        timestamp: 1_000,
        kind: 'video',
        codecId: 'codec-internal',
        bytesReceived: 1_000,
        packetsReceived: 50,
        packetsLost: 1,
        frameWidth: 1280,
        frameHeight: 720,
        framesPerSecond: 30,
        jitter: 0.006,
      },
    ])
    const reliable = new FakeDataChannel('control-reliable')
    reliable.bufferedAmount = 12
    const file = new FakeDataChannel('file-transfer')
    file.bufferedAmount = 34
    peer.emitDataChannel(reliable)
    peer.emitDataChannel(file)
    reliable.open()
    file.open()
    reliable.receive(acceptedMessage(1))
    await connecting
    peer.setConnectionState('connected')

    await waitUntil(() =>
      diagnostics.some(
        (diagnostic) =>
          typeof diagnostic === 'object' &&
          diagnostic !== null &&
          'name' in diagnostic &&
          diagnostic.name === 'webrtc.media-metrics',
      ),
    )
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'webrtc.media-metrics',
          direction: 'inbound',
          kind: 'video',
          codec: 'video/VP8',
          frameWidth: 1280,
          frameHeight: 720,
          framesPerSecond: 30,
          packetsLost: 1,
          jitterMs: 6,
          roundTripTimeMs: 25,
        }),
        { name: 'data-channel.metrics', label: 'control-reliable', bufferedAmount: 12 },
        { name: 'data-channel.metrics', label: 'file-transfer', bufferedAmount: 34 },
      ]),
    )
    expect(JSON.stringify(diagnostics)).not.toContain('internal')
    expect(JSON.stringify(diagnostics)).not.toContain('198.51.100.9')
    await client.disconnect()
  })

  it('rejects invalid retry limits before opening a socket', () => {
    expect(() =>
      createRemoteTabClient({
        ticket: 'viewer-ticket',
        endpoint: 'wss://signal.example.test',
        iceRestart: { maxAttempts: 0 },
      }),
    ).toThrow(/iceRestart\.maxAttempts/u)
  })

  it('closes pending Notices when the active reliable channel disappears', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection)
    const client = createRemoteTabClient({ ticket: 'viewer-ticket', endpoint: 'wss://signal.example.test' })
    const events: unknown[] = []
    client.addEventListener((event) => events.push(event))
    const { reliable } = await connectClient(client, ['noticeRequests'])
    reliable.receive(encodeProtocolMessage(createProtocolMessage('notice.request',
      { sessionId: 'session-1', viewerGeneration: 1, sequence: 2 },
      { requestId: 'notice-1', expiresAt: Date.now() + 60000,
        content: { kind: 'confirm', title: 'Confirm?', body: 'Decision pending', buttons: [{ id: 'yes', label: 'Yes' }] } },
    )))
    await waitUntil(() => events.some((event) => isEventType(event, 'notice-request')))
    await expect(client.respondToNotice('notice-1', 'unknown')).rejects.toMatchObject({ code: 'PROTOCOL_MESSAGE_INVALID' })
    reliable.close()
    expect(events).toContainEqual({ type: 'notice-closed', requestId: 'notice-1', reason: 'connection-lost' })
    expect(client.state).toBe('FAILED')
    await expect(client.respondToNotice('notice-1', 'yes')).rejects.toThrow()
    await client.disconnect()
  })

  it('emits Notices and accepts only active HTTP or HTTPS local-open requests', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection)
    const client = createRemoteTabClient({
      ticket: 'viewer-ticket',
      endpoint: 'wss://signal.example.test',
    })
    const events: unknown[] = []
    client.addEventListener((event) => events.push(event))
    const { reliable } = await connectClient(client, [])

    reliable.receive(
      encodeProtocolMessage(
        createProtocolMessage(
          'notice',
          { sessionId: 'session-1', viewerGeneration: 1, sequence: 2 },
          { level: 'warning', code: 'POLICY_HINT', message: 'Review this action.' },
        ) as ProtocolMessage,
      ),
    )
    reliable.receive(
      encodeProtocolMessage(
        createProtocolMessage(
          'navigation.local_open_request',
          { sessionId: 'session-1', viewerGeneration: 1, sequence: 3 },
          {
            requestId: 'local-1',
            url: 'https://example.test/local',
            expiresAt: Date.now() + 10_000,
          },
        ) as ProtocolMessage,
      ),
    )
    await waitUntil(() => events.some((event) => isEventType(event, 'local-open-request')))
    expect(events).toEqual(
      expect.arrayContaining([
        {
          type: 'notice',
          notice: { level: 'warning', code: 'POLICY_HINT', message: 'Review this action.' },
        },
        expect.objectContaining({
          type: 'local-open-request',
          requestId: 'local-1',
          url: 'https://example.test/local',
        }),
      ]),
    )

    await client.respondToLocalOpen('local-1', true)
    expect(decodeProtocolMessage(reliable.sent.at(-1) ?? new Uint8Array())).toMatchObject({
      type: 'navigation.local_open_result',
      payload: { requestId: 'local-1', approved: true },
    })
    await expect(client.respondToLocalOpen('local-1', false)).rejects.toMatchObject({
      code: 'NAVIGATION_DENIED',
    })

    reliable.receive(
      encodeProtocolMessage(
        createProtocolMessage(
          'navigation.local_open_request',
          { sessionId: 'session-1', viewerGeneration: 1, sequence: 4 },
          {
            requestId: 'local-expiring',
            url: 'http://example.test/expiring',
            expiresAt: Date.now() + 5,
          },
        ) as ProtocolMessage,
      ),
    )
    await waitUntil(() =>
      events.some(
        (event) =>
          isEventType(event, 'local-open-cancelled') && event.requestId === 'local-expiring',
      ),
    )
    await expect(client.respondToLocalOpen('local-expiring', true)).rejects.toMatchObject({
      code: 'NAVIGATION_DENIED',
    })
    await client.disconnect()
  })

  it('uploads selected files in negotiated chunks and resolves after remote delivery', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection)
    const client = createRemoteTabClient({
      ticket: 'viewer-ticket',
      endpoint: 'wss://signal.example.test',
    })
    const events: unknown[] = []
    client.addEventListener((event) => events.push(event))

    const { file } = await connectClient(client, ['upload'])
    file.receive(fileMessage('file.upload.request', 2, {
      requestId: 'request-1',
      multiple: true,
      expiresAt: Date.now() + 10_000,
    }))
    await waitUntil(() => events.some((event) => isEventType(event, 'upload-request')))

    const uploading = client.uploadFiles('request-1', [
      {
        displayName: 'notes.txt',
        mimeType: 'text/plain',
        data: Uint8Array.of(1, 2, 3, 4, 5),
      },
      { displayName: 'empty.txt', data: new ArrayBuffer(0) },
    ])
    const offer = decodeProtocolMessage(file.sent[0] ?? new Uint8Array())
    expect(offer).toMatchObject({
      type: 'file.upload.offer',
      payload: {
        requestId: 'request-1',
        files: [
          { displayName: 'notes.txt', mimeType: 'text/plain', size: 5 },
          { displayName: 'empty.txt', size: 0 },
        ],
      },
    })
    if (offer?.type !== 'file.upload.offer') throw new Error('Expected upload offer')

    file.receive(fileMessage('file.upload.accept', 3, {
      transferId: offer.payload.transferId,
      maxChunkBytes: 2,
    }))
    await waitUntil(() => file.sent.length === 5)
    const outbound = file.sent.slice(1).map((bytes) => decodeProtocolMessage(bytes))
    expect(outbound.slice(0, 3)).toEqual([
      expect.objectContaining({
        type: 'file.upload.chunk',
        payload: expect.objectContaining({ offset: 0, data: Uint8Array.of(1, 2) }),
      }),
      expect.objectContaining({
        type: 'file.upload.chunk',
        payload: expect.objectContaining({ offset: 2, data: Uint8Array.of(3, 4) }),
      }),
      expect.objectContaining({
        type: 'file.upload.chunk',
        payload: expect.objectContaining({ offset: 4, data: Uint8Array.of(5) }),
      }),
    ])
    expect(outbound[3]).toMatchObject({
      type: 'file.upload.complete',
      payload: { transferId: offer.payload.transferId },
    })
    expect(events.filter((event) => isEventType(event, 'upload-progress'))).toMatchObject([
      { sentBytes: 2, totalBytes: 5 },
      { sentBytes: 4, totalBytes: 5 },
      { sentBytes: 5, totalBytes: 5 },
    ])

    file.receive(fileMessage('file.upload.result', 4, {
      transferId: offer.payload.transferId,
      delivered: true,
    }))
    await expect(uploading).resolves.toBeUndefined()
    await client.disconnect()
  })

  it('cancels chooser requests and rejects active uploads when the file channel closes', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection)
    const client = createRemoteTabClient({
      ticket: 'viewer-ticket',
      endpoint: 'wss://signal.example.test',
    })
    const events: unknown[] = []
    client.addEventListener((event) => events.push(event))
    const { file } = await connectClient(client, ['upload'])

    file.receive(fileMessage('file.upload.request', 2, {
      requestId: 'request-cancelled',
      multiple: false,
      expiresAt: Date.now() + 10_000,
    }))
    await client.cancelUpload('request-cancelled')
    expect(decodeProtocolMessage(file.sent[0] ?? new Uint8Array())).toMatchObject({
      type: 'file.upload.cancel',
      payload: { requestId: 'request-cancelled' },
    })
    await expect(
      client.uploadFiles('request-cancelled', [{ displayName: 'late.txt', data: Uint8Array.of(1) }]),
    ).rejects.toMatchObject({ code: 'FILE_TRANSFER_FAILED' })

    file.receive(fileMessage('file.upload.cancel', 3, {
      requestId: 'request-expired',
      reason: 'Remote file chooser request expired',
    }))
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'upload-cancelled',
          requestId: 'request-expired',
          reason: 'Remote file chooser request expired',
        }),
      ]),
    )

    file.receive(fileMessage('file.upload.request', 4, {
      requestId: 'request-active',
      multiple: false,
      expiresAt: Date.now() + 10_000,
    }))
    const uploading = client.uploadFiles('request-active', [
      { displayName: 'active.txt', data: Uint8Array.of(1, 2, 3) },
    ])
    file.close()
    await expect(uploading).rejects.toMatchObject({ code: 'SESSION_CLOSED', retryable: true })
    await client.disconnect()
  })
})

class FakeWebSocket extends EventTarget {
  public static readonly OPEN = 1
  public static readonly CLOSED = 3
  public static readonly instances: FakeWebSocket[] = []

  public readyState = 0
  public readonly sent: string[] = []

  public constructor(public readonly url: string) {
    super()
    FakeWebSocket.instances.push(this)
  }

  public open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  public receive(message: SignalingMessage): void {
    this.dispatchEvent(eventWith('message', { data: encodeSignalingMessage(message) }))
  }

  public send(value: string): void {
    this.sent.push(value)
  }

  public close(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.dispatchEvent(new Event('close'))
  }
}

class FakeDataChannel extends EventTarget {
  public binaryType = 'arraybuffer'
  public readyState: RTCDataChannelState = 'connecting'
  public readonly sent: Uint8Array[] = []
  public bufferedAmount = 0
  public bufferedAmountLowThreshold = 0

  public constructor(public readonly label: string) {
    super()
  }

  public open(): void {
    this.readyState = 'open'
    this.dispatchEvent(new Event('open'))
  }

  public receive(value: Uint8Array): void {
    const bytes = Uint8Array.from(value)
    this.dispatchEvent(eventWith('message', { data: bytes.buffer }))
  }

  public send(value: Uint8Array): void {
    this.sent.push(Uint8Array.from(value))
  }

  public close(): void {
    this.readyState = 'closed'
    this.dispatchEvent(new Event('close'))
  }
}

class FakePeerConnection extends EventTarget {
  public static readonly instances: FakePeerConnection[] = []

  public signalingState: RTCSignalingState = 'stable'
  public iceGatheringState: RTCIceGatheringState = 'new'
  public iceConnectionState: RTCIceConnectionState = 'new'
  public connectionState: RTCPeerConnectionState = 'new'
  public remoteDescription: RTCSessionDescription | null = null
  public answersCreated = 0
  public statsReport = statsReport([])

  public constructor() {
    super()
    FakePeerConnection.instances.push(this)
  }

  public emitDataChannel(channel: FakeDataChannel): void {
    this.dispatchEvent(eventWith('datachannel', { channel: channel as unknown as RTCDataChannel }))
  }

  public setConnectionState(state: RTCPeerConnectionState): void {
    this.connectionState = state
    this.dispatchEvent(new Event('connectionstatechange'))
  }

  public async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description as RTCSessionDescription
  }

  public async addIceCandidate(): Promise<void> {}

  public async createAnswer(): Promise<RTCSessionDescriptionInit> {
    this.answersCreated += 1
    return { type: 'answer', sdp: 'v=0\r\nanswer' }
  }

  public async setLocalDescription(): Promise<void> {}

  public async getStats(): Promise<RTCStatsReport> {
    return this.statsReport
  }

  public close(): void {
    this.connectionState = 'closed'
  }
}

function eventWith(type: string, values: Record<string, unknown>): Event {
  const event = new Event(type)
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(event, name, { value })
  }
  return event
}

function statsReport(records: unknown[]): RTCStatsReport {
  return {
    forEach(callback: (record: RTCStats) => void) {
      ;(records as RTCStats[]).forEach(callback)
    },
  } as RTCStatsReport
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for client state')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

function readyMessage(viewerGeneration: number): SignalingMessage {
  return {
    type: 'signal.ready',
    role: 'viewer',
    sessionId: 'session-1',
    viewerGeneration,
    capabilities: ['qualityControl', 'diagnostics'],
    iceServers: [],
    iceTransportPolicy: 'all',
  }
}

function acceptedMessage(viewerGeneration: number): Uint8Array {
  return encodeProtocolMessage(
    createProtocolMessage(
      'hello.accepted',
      { sessionId: 'session-1', viewerGeneration, sequence: 1 },
      {
        capabilities: ['qualityControl', 'diagnostics'],
        viewport: {
          width: 1280,
          height: 720,
          deviceScaleFactor: 1,
          frameRate: 30,
          revision: 1,
        },
      },
    ) as ProtocolMessage,
  )
}

async function connectClient(
  client: ReturnType<typeof createRemoteTabClient>,
  capabilities: readonly Capability[],
): Promise<{ reliable: FakeDataChannel; file: FakeDataChannel }> {
  const connecting = client.connect()
  const socket = FakeWebSocket.instances.at(-1)
  socket?.open()
  socket?.receive({
    type: 'signal.ready',
    role: 'viewer',
    sessionId: 'session-1',
    viewerGeneration: 1,
    capabilities,
    iceServers: [],
    iceTransportPolicy: 'all',
  })
  await waitUntil(() => FakePeerConnection.instances.length > 0)
  const peer = FakePeerConnection.instances.at(-1)
  if (peer === undefined) throw new Error('Expected peer connection')
  const reliable = new FakeDataChannel('control-reliable')
  const file = new FakeDataChannel('file-transfer')
  peer.emitDataChannel(reliable)
  peer.emitDataChannel(file)
  reliable.open()
  file.open()
  reliable.receive(
    encodeProtocolMessage(
      createProtocolMessage(
        'hello.accepted',
        { sessionId: 'session-1', viewerGeneration: 1, sequence: 1 },
        {
          capabilities,
          viewport: {
            width: 1280,
            height: 720,
            deviceScaleFactor: 1,
            frameRate: 30,
            revision: 1,
          },
        },
      ) as ProtocolMessage,
    ),
  )
  await connecting
  return { reliable, file }
}

function fileMessage<TypeName extends Extract<ProtocolMessage['type'], `file.${string}`>>(
  type: TypeName,
  sequence: number,
  payload: Extract<ProtocolMessage, { type: TypeName }>['payload'],
): Uint8Array {
  return encodeProtocolMessage(
    createProtocolMessage(
      type,
      { sessionId: 'session-1', viewerGeneration: 1, sequence },
      payload,
    ) as ProtocolMessage,
  )
}

function isEventType(value: unknown, type: string): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && 'type' in value && value.type === type
}
