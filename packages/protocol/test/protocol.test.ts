import { decode, encode } from '@msgpack/msgpack'
import { describe, expect, it } from 'vitest'

import {
  assessProtocolVersion,
  createProtocolMessage,
  decodeExtensionLoopbackMessage,
  decodeProtocolMessage,
  decodeSignalingMessage,
  encodeExtensionLoopbackMessage,
  encodeProtocolMessage,
  encodeSignalingMessage,
  normalizeCapabilities,
  RemoteTabError,
  summarizeIceCandidate,
  summarizeSelectedIceCandidatePair,
  summarizeWebRtcMediaMetrics,
  type ProtocolMessage,
} from '../src/index.js'

describe('capabilities', () => {
  it('deduplicates known capabilities and ignores unknown names', () => {
    expect(normalizeCapabilities(['download', 'futureCapability', 'navigation', 'download'])).toEqual([
      'navigation',
      'download',
    ])
  })
})

describe('protocol versions', () => {
  it('accepts different minor versions within the same major', () => {
    expect(assessProtocolVersion({ major: 1, minor: 0 }).relationship).toBe('remote-older')
    expect(assessProtocolVersion({ major: 1, minor: 5 }).relationship).toBe('same')
    expect(assessProtocolVersion({ major: 1, minor: 6 }).relationship).toBe('remote-newer')
    expect(assessProtocolVersion({ major: 2, minor: 0 }).compatible).toBe(false)
  })
})

describe('ICE restart contracts', () => {
  it('round trips the Viewer signaling request and Extension loopback command', () => {
    const signaling = { type: 'signal.restart-ice' } as const
    const loopback = { type: 'media.restart_ice', sessionId: 'session-1' } as const

    expect(decodeSignalingMessage(encodeSignalingMessage(signaling))).toEqual(signaling)
    expect(decodeExtensionLoopbackMessage(encodeExtensionLoopbackMessage(loopback))).toEqual(loopback)
  })

  it('round trips bounded Extension media diagnostics', () => {
    const message = {
      type: 'media.diagnostic',
      sessionId: 'session-1',
      diagnostic: {
        name: 'webrtc.media-metrics',
        direction: 'outbound',
        kind: 'video',
        codec: 'video/VP8',
        bitrateBps: 1_250_000,
        roundTripTimeMs: 24.5,
        qualityLimitationReason: 'bandwidth',
        sampleIntervalMs: 5_000,
      },
    } as const
    expect(decodeExtensionLoopbackMessage(encodeExtensionLoopbackMessage(message))).toEqual(message)
  })

  it('round trips acknowledged media teardown messages', () => {
    const request = {
      type: 'media.stop',
      requestId: 'stop-1',
      sessionId: 'session-1',
      reason: 'Viewer generation replaced',
    } as const
    const response = {
      type: 'media.stopped',
      requestId: 'stop-1',
      sessionId: 'session-1',
    } as const

    expect(decodeExtensionLoopbackMessage(encodeExtensionLoopbackMessage(request))).toEqual(request)
    expect(decodeExtensionLoopbackMessage(encodeExtensionLoopbackMessage(response))).toEqual(response)
  })

  it('round trips download chunks and Extension forwarding acknowledgements', () => {
    const chunk = createProtocolMessage(
      'file.download.chunk',
      { sessionId: 'session-1', viewerGeneration: 2, sequence: 17 },
      { transferId: 'download-1', offset: 0, data: Uint8Array.of(1, 2, 3) },
    )
    const decoded = decodeProtocolMessage(encodeProtocolMessage(chunk as ProtocolMessage))
    expect(decoded).toEqual(chunk)
    expect(
      decodeExtensionLoopbackMessage(
        encodeExtensionLoopbackMessage({
          type: 'media.control_forwarded',
          sessionId: 'session-1',
          sequence: 17,
        }),
      ),
    ).toEqual({ type: 'media.control_forwarded', sessionId: 'session-1', sequence: 17 })
  })
})

describe('ICE candidate diagnostics', () => {
  it('returns routing metadata without retaining the candidate address or port', () => {
    expect(
      summarizeIceCandidate(
        'candidate:1 1 TCP 1518280447 203.0.113.9 443 typ relay raddr 10.0.0.2 rport 53422 tcptype passive',
      ),
    ).toEqual({ candidateType: 'relay', protocol: 'tcp', tcpType: 'passive' })
  })

  it('ignores malformed or unknown candidate fields', () => {
    expect(summarizeIceCandidate('')).toEqual({})
    expect(summarizeIceCandidate('candidate:1 1 quic 1 redacted 9 typ future')).toEqual({})
  })

  it('summarizes a selected pair without exposing stats identifiers or addresses', () => {
    const records = [
      { id: 'transport-1', type: 'transport', selectedCandidatePairId: 'pair-1' },
      {
        id: 'pair-1',
        type: 'candidate-pair',
        localCandidateId: 'local-1',
        remoteCandidateId: 'remote-1',
      },
      {
        id: 'local-1',
        type: 'local-candidate',
        candidateType: 'relay',
        protocol: 'udp',
        relayProtocol: 'tcp',
        address: '203.0.113.7',
        port: 49152,
      },
      {
        id: 'remote-1',
        type: 'remote-candidate',
        candidateType: 'srflx',
        protocol: 'udp',
        address: '198.51.100.4',
        port: 60000,
      },
    ] as unknown as RTCStats[]
    const report = {
      forEach(callback: (record: RTCStats) => void) {
        records.forEach(callback)
      },
    } as RTCStatsReport

    const summary = summarizeSelectedIceCandidatePair(report)
    expect(summary).toEqual({
      localCandidateType: 'relay',
      remoteCandidateType: 'srflx',
      protocol: 'udp',
      relayProtocol: 'tcp',
    })
    expect(JSON.stringify(summary)).not.toContain('203.0.113.7')
    expect(JSON.stringify(summary)).not.toContain('pair-1')
  })

  it('preserves the distinct TLS relay transport reported by browser stats', () => {
    const records = [
      { id: 'transport-1', type: 'transport', selectedCandidatePairId: 'pair-1' },
      {
        id: 'pair-1',
        type: 'candidate-pair',
        localCandidateId: 'local-1',
        remoteCandidateId: 'remote-1',
      },
      {
        id: 'local-1',
        type: 'local-candidate',
        candidateType: 'relay',
        protocol: 'udp',
        relayProtocol: 'TLS',
      },
      {
        id: 'remote-1',
        type: 'remote-candidate',
        candidateType: 'relay',
        protocol: 'udp',
      },
    ] as unknown as RTCStats[]
    const report = {
      forEach(callback: (record: RTCStats) => void) {
        records.forEach(callback)
      },
    } as RTCStatsReport

    expect(summarizeSelectedIceCandidatePair(report)).toEqual({
      localCandidateType: 'relay',
      remoteCandidateType: 'relay',
      protocol: 'udp',
      relayProtocol: 'tls',
    })
  })
})

describe('WebRTC media metrics', () => {
  it('derives redacted inbound bitrate, loss, codec, jitter, RTT, and resolution deltas', () => {
    const first = createStatsReport([
      { id: 'transport-secret', type: 'transport', selectedCandidatePairId: 'pair-secret' },
      {
        id: 'pair-secret',
        type: 'candidate-pair',
        state: 'succeeded',
        nominated: true,
        currentRoundTripTime: 0.0345,
        localAddress: '192.0.2.8',
      },
      { id: 'codec-secret', type: 'codec', mimeType: 'video/VP8', sdpFmtpLine: 'secret' },
      {
        id: 'inbound-secret',
        type: 'inbound-rtp',
        timestamp: 1_000,
        kind: 'video',
        codecId: 'codec-secret',
        bytesReceived: 1_000,
        packetsReceived: 100,
        packetsLost: 2,
        framesDropped: 3,
        framesPerSecond: 30,
        frameWidth: 1280,
        frameHeight: 720,
        jitter: 0.01234,
      },
    ])
    const initial = summarizeWebRtcMediaMetrics(first, 'inbound')
    expect(initial.metrics).toEqual([
      {
        name: 'webrtc.media-metrics',
        direction: 'inbound',
        kind: 'video',
        codec: 'video/VP8',
        frameWidth: 1280,
        frameHeight: 720,
        framesPerSecond: 30,
        packetsLost: 2,
        framesDropped: 3,
        jitterMs: 12.34,
        roundTripTimeMs: 34.5,
      },
    ])

    const second = createStatsReport([
      { id: 'transport-secret', type: 'transport', selectedCandidatePairId: 'pair-secret' },
      { id: 'pair-secret', type: 'candidate-pair', currentRoundTripTime: 0.04 },
      { id: 'codec-secret', type: 'codec', mimeType: 'video/VP8' },
      {
        id: 'inbound-secret',
        type: 'inbound-rtp',
        timestamp: 2_000,
        kind: 'video',
        codecId: 'codec-secret',
        bytesReceived: 3_000,
        packetsReceived: 198,
        packetsLost: 4,
        framesDropped: 4,
        framesPerSecond: 29.5,
        frameWidth: 1280,
        frameHeight: 720,
        jitter: 0.01,
      },
    ])
    const next = summarizeWebRtcMediaMetrics(second, 'inbound', initial.history)
    expect(next.metrics[0]).toMatchObject({
      bitrateBps: 16_000,
      packetsLost: 4,
      packetLossRatio: 0.02,
      sampleIntervalMs: 1_000,
      roundTripTimeMs: 40,
    })
    expect(JSON.stringify(next.metrics)).not.toContain('secret')
    expect(JSON.stringify(next.metrics)).not.toContain('192.0.2.8')
  })

  it('uses remote inbound feedback for outbound loss, jitter, and RTT', () => {
    const initial = summarizeWebRtcMediaMetrics(
      createStatsReport([
        {
          id: 'outbound-1',
          type: 'outbound-rtp',
          timestamp: 5_000,
          kind: 'audio',
          bytesSent: 500,
          packetsSent: 50,
          remoteId: 'remote-1',
        },
        {
          id: 'remote-1',
          type: 'remote-inbound-rtp',
          localId: 'outbound-1',
          packetsReceived: 49,
          packetsLost: 1,
          jitter: 0.004,
          roundTripTime: 0.08,
        },
      ]),
      'outbound',
    )
    const next = summarizeWebRtcMediaMetrics(
      createStatsReport([
        {
          id: 'outbound-1',
          type: 'outbound-rtp',
          timestamp: 7_000,
          kind: 'audio',
          bytesSent: 2_500,
          packetsSent: 150,
          remoteId: 'remote-1',
        },
        {
          id: 'remote-1',
          type: 'remote-inbound-rtp',
          localId: 'outbound-1',
          packetsReceived: 147,
          packetsLost: 3,
          jitter: 0.005,
          roundTripTime: 0.09,
        },
      ]),
      'outbound',
      initial.history,
    )
    expect(next.metrics).toEqual([
      {
        name: 'webrtc.media-metrics',
        direction: 'outbound',
        kind: 'audio',
        bitrateBps: 8_000,
        packetsLost: 3,
        packetLossRatio: 0.02,
        jitterMs: 5,
        roundTripTimeMs: 90,
        sampleIntervalMs: 2_000,
      },
    ])
  })
})

describe('MessagePack protocol codec', () => {
  it('round trips a runtime-validated message', () => {
    const message = createProtocolMessage(
      'hello',
      { sessionId: 'session-1', viewerGeneration: 2, sequence: 7 },
      { clientVersion: '0.1.15', capabilities: ['navigation', 'diagnostics'] },
    )

    expect(decodeProtocolMessage(encodeProtocolMessage(message))).toEqual(message)
  })

  it('validates bounded media quality settings', () => {
    const message = createProtocolMessage(
      'quality.ack',
      { sessionId: 'session-1', viewerGeneration: 2, sequence: 8 },
      {
        preset: 'balanced',
        maxBitrate: 2_500_000,
        maxFrameRate: 30,
        scaleResolutionDownBy: 1,
      },
    )

    expect(decodeProtocolMessage(encodeProtocolMessage(message))).toEqual(message)
  })

  it('round trips a structured non-HTML Notice', () => {
    const message = createProtocolMessage(
      'notice',
      { sessionId: 'session-1', viewerGeneration: 2, sequence: 9 },
      {
        level: 'warning',
        code: 'LOCAL_OPEN_DENIED',
        message: 'This link is not allowed by the Embedder policy.',
      },
    )

    expect(decodeProtocolMessage(encodeProtocolMessage(message))).toEqual(message)
  })

  it('round trips native binary upload chunks and rejects non-binary data', () => {
    const message = createProtocolMessage(
      'file.upload.chunk',
      { sessionId: 'session-1', viewerGeneration: 2, sequence: 9 },
      {
        transferId: 'transfer-1',
        fileId: 'file-1',
        offset: 0,
        data: new Uint8Array([0, 1, 2, 255]),
      },
    )

    const decoded = decodeProtocolMessage(encodeProtocolMessage(message))
    expect(decoded).toEqual(message)
    if (decoded?.type !== 'file.upload.chunk') throw new Error('Expected upload chunk')
    expect(decoded.payload.data).toBeInstanceOf(Uint8Array)

    const malformed = encode({
      ...message,
      payload: { ...message.payload, data: 'not-binary' },
    })
    expect(() => decodeProtocolMessage(malformed)).toThrowError(
      expect.objectContaining({ code: 'PROTOCOL_MESSAGE_INVALID' }),
    )
  })

  it('rejects malformed payloads after decoding', () => {
    const malformed = encode({
      version: 1,
      minor: 0,
      type: 'viewport.request',
      sessionId: 'session-1',
      viewerGeneration: 1,
      sequence: 1,
      payload: { width: 0, height: 720, deviceScaleFactor: 1, frameRate: 30 },
    })

    expect(() => decodeProtocolMessage(malformed)).toThrowError(
      expect.objectContaining({ code: 'PROTOCOL_MESSAGE_INVALID' }),
    )
  })

  it('rejects bytes over the configured limit before decoding', () => {
    expect(() => decodeProtocolMessage(new Uint8Array(8), { maxBytes: 4 })).toThrowError(
      expect.objectContaining({ code: 'PROTOCOL_MESSAGE_TOO_LARGE' }),
    )
  })

  it('rejects unknown messages by default and can ignore optional additions', () => {
    const unknown = encode({
      version: 1,
      minor: 1,
      type: 'diagnostics.future',
      sessionId: 'session-1',
      viewerGeneration: 1,
      sequence: 2,
      payload: {},
    })

    expect(() => decodeProtocolMessage(unknown)).toThrowError(
      expect.objectContaining({ code: 'PROTOCOL_MESSAGE_UNKNOWN' }),
    )
    expect(decodeProtocolMessage(unknown, { unknownMessage: 'ignore' })).toBeUndefined()
  })

  it('rejects incompatible protocol majors', () => {
    const message = decode(
      encode({
        version: 2,
        minor: 0,
        type: 'session.suspend',
        sessionId: 'session-1',
        viewerGeneration: 1,
        sequence: 3,
        payload: {},
      }),
    )

    expect(() => decodeProtocolMessage(encode(message))).toThrowError(RemoteTabError)
    expect(() => decodeProtocolMessage(encode(message))).toThrowError(
      expect.objectContaining({ code: 'PROTOCOL_VERSION_UNSUPPORTED' }),
    )
  })
})

function createStatsReport(records: unknown[]): RTCStatsReport {
  return {
    forEach(callback: (record: RTCStats) => void) {
      ;(records as RTCStats[]).forEach(callback)
    },
  } as RTCStatsReport
}


describe('window selection envelope', () => {
  it('round trips window revisions and rejects invalid revision metadata', () => {
    const message = createProtocolMessage('input.composition', { sessionId: 's', viewerGeneration: 1, sequence: 2, windowRevision: 4 }, { event: 'commit', text: 'hello' })
    expect(decodeProtocolMessage(encodeProtocolMessage(message))).toEqual(message)
    expect(() => encodeProtocolMessage({ ...message, windowRevision: -1 })).toThrow()
    expect(() => encodeProtocolMessage({ ...message, windowRevision: 1.5 })).toThrow()
    // The optional field remains absent for Sessions without the negotiated capability.
    const legacy = createProtocolMessage('input.composition', { sessionId: 's', viewerGeneration: 1, sequence: 2 }, { event: 'commit', text: 'hello' })
    expect(decodeProtocolMessage(encodeProtocolMessage(legacy))).not.toHaveProperty('windowRevision')
  })
})

// Cursor feedback contains presentation keywords only, never custom image URLs.
describe('cursor feedback', () => {
  it('round trips scoped keywords and rejects arbitrary CSS', () => {
    const message = createProtocolMessage('cursor.changed', { sessionId: 'cursor', viewerGeneration: 1, sequence: 1 },
      { cursor: 'text', viewportRevision: 1, windowRevision: 1 })
    expect(decodeProtocolMessage(encodeProtocolMessage(message as ProtocolMessage))).toEqual(message)
    expect(() => encodeProtocolMessage({ ...message, payload: { ...message.payload, cursor: 'url(https://example.test/cursor), pointer' } } as unknown as ProtocolMessage)).toThrow()
  })
})
