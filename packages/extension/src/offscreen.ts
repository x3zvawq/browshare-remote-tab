/// <reference types="chrome" />

import {
  decodeExtensionLoopbackMessage,
  decodeProtocolMessage,
  encodeExtensionLoopbackMessage,
  summarizeIceCandidate,
  summarizeSelectedIceCandidatePair,
  summarizeWebRtcMediaMetrics,
  type DataChannelMetrics,
  type ExtensionLoopbackMessage,
  type EncodingSettings,
  type QualityState,
  type IceCandidate,
  type MediaQualitySettings,
  type ProtocolMessage,
  type WebRtcMediaMetrics,
  type WebRtcMetricsHistory,
} from '@browshare/remote-tab-protocol'
import { adaptEncoding, boundEncoding, configuredEncoding, type AutomaticQualityHistory } from './media-quality-policy.js'
import type { RuntimeConfiguration } from './runtime-config.js'
import {
  decodeBoundViewerControl,
  type ViewerControlChannel,
} from './viewer-control.js'

interface RuntimeConfigurationResponse {
  ok: boolean
  configuration?: RuntimeConfiguration
}

interface Publisher {
  sessionId: string
  viewerGeneration: number
  peer: RTCPeerConnection
  stream: MediaStream
  suspended: boolean
  mediaOperations: Promise<void>
  encodingSettings: EncodingSettings | undefined
  qualityState: QualityState | undefined
  qualityLimits: EncodingSettings | undefined
  automaticQualityHistory: AutomaticQualityHistory
  captureRevision: number | undefined
  captureReplacement: Promise<void> | undefined
  reliable: RTCDataChannel
  realtime: RTCDataChannel
  fileTransfer: RTCDataChannel
  pendingIce: RTCIceCandidateInit[]
  peerReady: boolean
  offerStarted: boolean
  restartInProgress: boolean
  failureTimer: ReturnType<typeof setTimeout> | undefined
  diagnosticsEnabled: boolean
  metricsTimer: ReturnType<typeof setTimeout> | undefined
  metricsSampling: boolean
  metricsRevision: number
  metricsHistory: WebRtcMetricsHistory
}

interface PublisherStartAttempt {
  token: object
  settled: Promise<void>
}

const APPLICATION_ERROR_CLOSE_CODE = 4_000
const METRICS_INTERVAL_MS = 5_000
const FILE_BUFFER_HIGH_WATER_BYTES = 1024 * 1024
const FILE_BUFFER_LOW_WATER_BYTES = 256 * 1024
const FILE_BUFFER_WAIT_TIMEOUT_MS = 10_000
const publishers = new Map<string, Publisher>()
const publisherStartAttempts = new Map<string, PublisherStartAttempt>()
const peerReadySessions = new Set<string>()
let socket: WebSocket | undefined
let reconnectTimer: ReturnType<typeof setTimeout> | undefined

void initialize()

async function initialize(): Promise<void> {
  const response = (await chrome.runtime.sendMessage({
    type: 'runtime.get-config',
  })) as RuntimeConfigurationResponse
  if (!response.ok || response.configuration === undefined) {
    throw new Error('Remote Tab runtime configuration is unavailable')
  }
  connectLoopback(response.configuration)
}

function connectLoopback(configuration: RuntimeConfiguration): void {
  clearTimeout(reconnectTimer)
  const next = new WebSocket(configuration.loopbackUrl)
  next.binaryType = 'arraybuffer'
  socket = next
  next.addEventListener('open', () => {
    diagnose({ name: 'loopback.socket-open' })
    send({
      type: 'runtime.bind',
      role: 'media',
      secret: configuration.runtimeSecret,
      extensionId: chrome.runtime.id,
      extensionVersion: __BROWSHARE_EXTENSION_VERSION__,
      runtimeGeneration: configuration.runtimeGeneration,
      runtimeInstanceId: configuration.runtimeInstanceId,
    })
  })
  next.addEventListener('message', (event) => {
    if (typeof event.data === 'string') {
      handleTextMessage(event.data)
    } else if (event.data instanceof ArrayBuffer) {
      void handleControlMessage(new Uint8Array(event.data)).catch(() => undefined)
    } else {
      next.close(APPLICATION_ERROR_CLOSE_CODE, 'Unsupported loopback frame')
    }
  })
  next.addEventListener('close', () => {
    diagnose({ name: 'loopback.socket-close' })
    if (socket === next) {
      socket = undefined
    }
    closeAllPublishers()
    reconnectTimer = setTimeout(() => connectLoopback(configuration), 1_000)
  })
}

function handleTextMessage(raw: string): void {
  let message: ExtensionLoopbackMessage
  try {
    message = decodeExtensionLoopbackMessage(raw)
  } catch {
    socket?.close(APPLICATION_ERROR_CLOSE_CODE, 'Invalid loopback message')
    return
  }
  if (message.type === 'runtime.ping') {
    send({ type: 'runtime.pong', nonce: message.nonce })
  } else if (message.type === 'media.start') {
    beginPublisherStart(message)
  } else if (message.type === 'media.replace_capture') {
    beginCaptureReplacement(message)
  } else if (message.type === 'media.stop') {
    void stopPublisherAndAcknowledge(message)
  } else if (message.type === 'media.suspend' || message.type === 'media.resume') {
    void setPublisherSuspended(message.sessionId, message.type === 'media.suspend')
  } else if (message.type === 'media.restart_ice') {
    const publisher = publishers.get(message.sessionId)
    if (publisher !== undefined) {
      void restartIce(publisher)
    }
  } else if (message.type === 'media.configure_quality') {
    void configurePublisherQuality(message)
  } else if (message.type === 'media.set_quality') {
    void setPublisherQuality(message.sessionId, message.settings)
  } else if (message.type === 'media.peer_ready') {
    peerReadySessions.add(message.sessionId)
    diagnose({ name: 'signaling.peer-ready', sessionId: message.sessionId })
    const publisher = publishers.get(message.sessionId)
    if (publisher !== undefined) {
      publisher.peerReady = true
      void startOffer(publisher)
    }
  } else if (message.type === 'media.peer_left') {
    peerReadySessions.delete(message.sessionId)
    stopPublisher(message.sessionId)
  } else if (message.type === 'media.signal_description') {
    void applyDescription(message)
  } else if (message.type === 'media.signal_ice') {
    void applyIce(message)
  }
}

function beginPublisherStart(
  message: Extract<ExtensionLoopbackMessage, { type: 'media.start' }>,
): void {
  // Pairing normally completes before capture preparation. Preserve that edge while replacing a
  // stale Publisher; stopPublisher also clears readiness for ordinary teardown.
  const peerReady = peerReadySessions.delete(message.sessionId)
  stopPublisher(message.sessionId)
  let resolveSettled!: () => void
  const attempt: PublisherStartAttempt = {
    token: {},
    settled: new Promise<void>((resolve) => {
      resolveSettled = resolve
    }),
  }
  publisherStartAttempts.set(message.sessionId, attempt)
  void startPublisher(message, peerReady, attempt.token)
    .catch((cause: unknown) => {
      if (publisherStartAttempts.get(message.sessionId) !== attempt) return
      stopPublisher(message.sessionId)
      send({
        type: 'media.start_failed',
        sessionId: message.sessionId,
        error: {
          code: 'CAPTURE_DENIED',
          message: cause instanceof Error ? cause.message : 'Chrome tab media capture failed',
          retryable: false,
        },
      })
    })
    .finally(resolveSettled)
}

async function stopPublisherAndAcknowledge(
  message: Extract<ExtensionLoopbackMessage, { type: 'media.stop' }>,
): Promise<void> {
  const pendingStart = publisherStartAttempts.get(message.sessionId)?.settled
  const pendingReplacement = publishers.get(message.sessionId)?.captureReplacement
  stopPublisher(message.sessionId)
  await Promise.all([pendingStart, pendingReplacement])
  send({ type: 'media.stopped', requestId: message.requestId, sessionId: message.sessionId })
}

async function acquireTabCapture(message: {
  streamId: string
  audio: boolean
  viewport: { width: number; height: number; frameRate: number }
  captureFrameRateLimit?: number
}): Promise<MediaStream> {
  // Chrome fixes the underlying tab source's maximum rate at acquisition. Starting the
  // source at the current 30 FPS preset prevents a later 60 FPS track constraint from working.
  const sourceFrameRate = message.captureFrameRateLimit ?? message.viewport.frameRate
  const constraints = {
    audio: message.audio
      ? {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: message.streamId,
          },
        }
      : false,
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: message.streamId,
        minWidth: message.viewport.width,
        maxWidth: message.viewport.width,
        minHeight: message.viewport.height,
        maxHeight: message.viewport.height,
        minFrameRate: sourceFrameRate,
        maxFrameRate: sourceFrameRate,
      },
    },
  } as unknown as MediaStreamConstraints
  const stream = await navigator.mediaDevices.getUserMedia(constraints)
  if (message.captureFrameRateLimit !== undefined) {
    try {
      // This changes delivery on the existing source, leaving room to increase it later up
      // to the authorized acquisition rate. No frames reach an RTP sender before this step.
      for (const track of stream.getVideoTracks()) {
        await applyCaptureFrameRate(track, Math.min(message.viewport.frameRate, sourceFrameRate))
      }
    } catch (error) {
      for (const track of stream.getTracks()) track.stop()
      throw error
    }
  }
  return stream
}

async function startPublisher(
  message: Extract<ExtensionLoopbackMessage, { type: 'media.start' }>,
  peerReady: boolean,
  startToken: object,
): Promise<void> {
  diagnose({
    name: 'media.capture-started',
    sessionId: message.sessionId,
    width: message.viewport.width,
    height: message.viewport.height,
    frameRate: message.viewport.frameRate,
    audio: message.audio,
  })
  if (message.capabilities.includes('windowSelection') && message.captureRevision === undefined) {
    throw new Error('Window selection requires a capture revision')
  }
  const stream = await acquireTabCapture(message)
  if (publisherStartAttempts.get(message.sessionId)?.token !== startToken) {
    for (const track of stream.getTracks()) track.stop()
    return
  }
  diagnose({
    name: 'media.stream-acquired',
    sessionId: message.sessionId,
    audioTrackCount: stream.getAudioTracks().length,
    videoTrackCount: stream.getVideoTracks().length,
  })
  for (const videoTrack of stream.getVideoTracks()) {
    videoTrack.contentHint = 'detail'
  }

  const peer = new RTCPeerConnection({
    iceServers: message.iceServers.map((server) => ({
      urls: [...server.urls],
      ...(server.username === undefined ? {} : { username: server.username }),
      ...(server.credential === undefined ? {} : { credential: server.credential }),
    })),
    bundlePolicy: 'max-bundle',
    iceTransportPolicy: message.iceTransportPolicy,
  })
  for (const track of stream.getTracks()) {
    if (track.kind === 'video' && message.quality !== undefined) {
      // Initial send encodings enforce the bound before the first media packet is sent.
      peer.addTransceiver(track, { direction: 'sendonly', streams: [stream], sendEncodings: [{
        maxBitrate: message.quality.maxBitrate, maxFramerate: message.quality.maxFrameRate,
        scaleResolutionDownBy: message.quality.scaleResolutionDownBy,
      }] })
    } else {
      peer.addTrack(track, stream)
    }
  }

  const reliable = peer.createDataChannel('control-reliable', { ordered: true })
  const realtime = peer.createDataChannel('control-realtime', {
    ordered: false,
    maxRetransmits: 0,
  })
  const fileTransfer = peer.createDataChannel('file-transfer', { ordered: true })
  const publisher: Publisher = {
    sessionId: message.sessionId,
    viewerGeneration: message.viewerGeneration,
    peer,
    stream,
    suspended: false,
    mediaOperations: Promise.resolve(),
    encodingSettings: message.quality,
    qualityState: undefined,
    qualityLimits: undefined,
    automaticQualityHistory: { pressureSamples: 0, healthySamples: 0 },
    captureRevision: message.capabilities.includes('windowSelection') ? message.captureRevision : undefined,
    captureReplacement: undefined,
    reliable,
    realtime,
    fileTransfer,
    pendingIce: [],
    peerReady,
    offerStarted: false,
    restartInProgress: false,
    failureTimer: undefined,
    diagnosticsEnabled: message.capabilities.includes('diagnostics'),
    metricsTimer: undefined,
    metricsSampling: false,
    metricsRevision: 0,
    metricsHistory: new Map(),
  }
  publishers.set(message.sessionId, publisher)
  observeCaptureEnd(publisher, stream)
  diagnose({ name: 'media.publisher-created', sessionId: message.sessionId, peerReady })
  reliable.addEventListener('close', () => {
    send({ type: 'media.control_closed', sessionId: publisher.sessionId, viewerGeneration: publisher.viewerGeneration })
  })
  installViewerControlChannel(publisher, reliable, 'control-reliable')
  installViewerControlChannel(publisher, realtime, 'control-realtime')
  installViewerControlChannel(publisher, fileTransfer, 'file-transfer')
  peer.addEventListener('icecandidate', (event) => {
    if (event.candidate !== null) {
      diagnose({
        name: 'ice.candidate-sent',
        sessionId: message.sessionId,
        ...summarizeIceCandidate(event.candidate.candidate),
      })
      send({
        type: 'media.signal_ice',
        sessionId: message.sessionId,
        candidate: normalizeIceCandidate(event.candidate.toJSON()),
      })
    }
  })
  const reportPeerState = (): void => {
    diagnose({
      name: 'webrtc.state',
      sessionId: message.sessionId,
      signalingState: peer.signalingState,
      iceGatheringState: peer.iceGatheringState,
      iceConnectionState: peer.iceConnectionState,
      connectionState: peer.connectionState,
    })
  }
  peer.addEventListener('signalingstatechange', reportPeerState)
  peer.addEventListener('icegatheringstatechange', reportPeerState)
  peer.addEventListener('iceconnectionstatechange', reportPeerState)
  peer.addEventListener('connectionstatechange', () => {
    reportPeerState()
    if (peer.connectionState === 'connected') {
      void peer
        .getStats()
        .then((report) => {
          if (publishers.get(message.sessionId)?.peer !== peer) return
          const summary = summarizeSelectedIceCandidatePair(report)
          if (summary !== undefined) {
            diagnose({
              name: 'webrtc.selected-candidate-pair',
              sessionId: message.sessionId,
              ...summary,
            })
          }
        })
        .catch(() => undefined)
    }
    if (peer.connectionState === 'connected') {
      clearTimeout(publisher.failureTimer)
      publisher.failureTimer = undefined
      startPublisherMetrics(publisher)
    } else if (peer.connectionState === 'failed') {
      resetAutomaticQualityHistory(publisher)
      clearTimeout(publisher.failureTimer)
      publisher.failureTimer = setTimeout(
        () => stopPublisher(message.sessionId, publisher),
        15_000,
      )
    } else if (peer.connectionState === 'closed') {
      stopPublisher(message.sessionId, publisher)
    } else {
      resetAutomaticQualityHistory(publisher)
    }
  })
  await startOffer(publisher)
  if (publisherStartAttempts.get(message.sessionId)?.token === startToken) {
    publisherStartAttempts.delete(message.sessionId)
  }
}

function observeCaptureEnd(publisher: Publisher, stream: MediaStream): void {
  for (const track of stream.getVideoTracks()) {
    track.addEventListener('ended', () => {
      if (publisher.stream !== stream || publishers.get(publisher.sessionId) !== publisher) return
      if (publisher.captureRevision === undefined) stopPublisher(publisher.sessionId, publisher)
      else send({ type: 'media.capture_ended', sessionId: publisher.sessionId,
        viewerGeneration: publisher.viewerGeneration, captureRevision: publisher.captureRevision })
    }, { once: true })
  }
}

type CaptureReplacement = Extract<ExtensionLoopbackMessage, { type: 'media.replace_capture' }>

function captureReplacementFailed(message: CaptureReplacement): void {
  send({
    type: 'media.capture_replace_failed', requestId: message.requestId,
    sessionId: message.sessionId, viewerGeneration: message.viewerGeneration,
    error: { code: 'CAPTURE_DENIED', message: 'Chrome could not replace the active tab capture', retryable: false },
  })
}

function beginCaptureReplacement(message: CaptureReplacement): void {
  const publisher = publishers.get(message.sessionId)
  if (!publisher || publisher.viewerGeneration !== message.viewerGeneration ||
      publisher.captureReplacement !== undefined || publisher.peer.connectionState !== 'connected' ||
      (publisher.captureRevision === undefined) !== (message.captureRevision === undefined) ||
      (publisher.captureRevision !== undefined && message.captureRevision! <= publisher.captureRevision)) {
    captureReplacementFailed(message)
    return
  }
  let settle!: () => void
  const settled = new Promise<void>(resolve => { settle = resolve })
  publisher.captureReplacement = settled
  void withPublisherMedia(publisher, () => replaceCapture(publisher, message)).catch(() => captureReplacementFailed(message)).finally(() => {
    publisher.captureReplacement = undefined
    settle()
  })
}

async function replaceCapture(publisher: Publisher, message: CaptureReplacement): Promise<void> {
  const original = publisher.stream
  let next: MediaStream | undefined
  let replacing = false
  const current = () => publishers.get(message.sessionId) === publisher
  try {
    next = await acquireTabCapture(message)
    if (!current()) throw new Error('Publisher retired')
    const tracks = next.getTracks()
    const senders = publisher.peer.getSenders().filter(sender => sender.track !== null)
    // Changing track topology needs renegotiation; maintenance switches preserve audio policy.
    if (tracks.length !== senders.length || next.getVideoTracks().length !== 1 ||
        tracks.some(track => track.readyState !== 'live' || !senders.some(sender => sender.track?.kind === track.kind))) {
      throw new Error('Capture topology changed')
    }
    for (const track of tracks) {
      track.enabled = false
      if (track.kind === 'video') {
        track.contentHint = 'detail'
        if (publisher.encodingSettings !== undefined) await applyCaptureFrameRate(track, publisher.encodingSettings.maxFrameRate)
      }
    }
    replacing = true
    for (const sender of senders) {
      await sender.replaceTrack(tracks.find(track => track.kind === sender.track?.kind)!)
      if (!current()) throw new Error('Publisher retired')
    }
    if (tracks.some(track => track.readyState !== 'live')) throw new Error('Capture ended')
    publisher.stream = next
    resetAutomaticQualityHistory(publisher)
    publisher.captureRevision = message.captureRevision
    observeCaptureEnd(publisher, next)
    for (const track of tracks) track.enabled = !publisher.suspended
    for (const track of original.getTracks()) track.stop()
    send({ type: 'media.capture_replaced', requestId: message.requestId, sessionId: message.sessionId, viewerGeneration: message.viewerGeneration })
  } catch (error) {
    for (const track of next?.getTracks() ?? []) track.stop()
    // After the first sender mutation the old source is no longer an atomic fallback.
    if (replacing && current()) stopPublisher(message.sessionId, publisher)
    throw error
  }
}

function installViewerControlChannel(
  publisher: Publisher,
  channel: RTCDataChannel,
  channelType: ViewerControlChannel,
): void {
  channel.binaryType = 'arraybuffer'
  installChannelDiagnostics(publisher.sessionId, channel)
  channel.addEventListener('message', (event) => {
    if (publishers.get(publisher.sessionId) !== publisher) return
    try {
      if (!(event.data instanceof ArrayBuffer)) {
        throw new Error('Viewer control frame must be binary')
      }
      decodeBoundViewerControl(event.data, publisher, channelType)
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(event.data)
      }
    } catch {
      diagnose({
        name: 'security.viewer-control-rejected',
        sessionId: publisher.sessionId,
        label: channel.label,
      })
      stopPublisher(publisher.sessionId, publisher)
    }
  })
}

function installChannelDiagnostics(sessionId: string, channel: RTCDataChannel): void {
  channel.addEventListener('open', () =>
    diagnose({ name: 'data-channel.open', sessionId, label: channel.label }),
  )
  channel.addEventListener('close', () =>
    diagnose({ name: 'data-channel.close', sessionId, label: channel.label }),
  )
}

async function startOffer(publisher: Publisher): Promise<void> {
  if (!publisher.peerReady || publisher.offerStarted) {
    return
  }
  publisher.offerStarted = true
  const offer = await publisher.peer.createOffer()
  await publisher.peer.setLocalDescription(offer)
  diagnose({
    name: 'signaling.description-sent',
    sessionId: publisher.sessionId,
    descriptionType: 'offer',
  })
  send({
    type: 'media.signal_description',
    sessionId: publisher.sessionId,
    description: { type: 'offer', sdp: offer.sdp ?? '' },
  })
}

async function restartIce(publisher: Publisher): Promise<void> {
  if (
    publishers.get(publisher.sessionId) !== publisher ||
    publisher.restartInProgress ||
    publisher.peer.signalingState !== 'stable'
  ) {
    return
  }
  publisher.restartInProgress = true
  clearTimeout(publisher.failureTimer)
  publisher.failureTimer = undefined
  try {
    const offer = await publisher.peer.createOffer({ iceRestart: true })
    await publisher.peer.setLocalDescription(offer)
    diagnose({
      name: 'signaling.ice-restart-offer-sent',
      sessionId: publisher.sessionId,
    })
    send({
      type: 'media.signal_description',
      sessionId: publisher.sessionId,
      description: { type: 'offer', sdp: offer.sdp ?? '' },
    })
  } catch {
    stopPublisher(publisher.sessionId, publisher)
  }
}

async function applyDescription(
  message: Extract<ExtensionLoopbackMessage, { type: 'media.signal_description' }>,
): Promise<void> {
  const publisher = publishers.get(message.sessionId)
  if (publisher === undefined || message.description.type !== 'answer') {
    return
  }
  diagnose({
    name: 'signaling.description-received',
    sessionId: message.sessionId,
    descriptionType: 'answer',
  })
  await publisher.peer.setRemoteDescription(message.description)
  publisher.restartInProgress = false
  for (const candidate of publisher.pendingIce.splice(0)) {
    await publisher.peer.addIceCandidate(candidate)
  }
}

async function applyIce(
  message: Extract<ExtensionLoopbackMessage, { type: 'media.signal_ice' }>,
): Promise<void> {
  const publisher = publishers.get(message.sessionId)
  if (publisher === undefined) {
    return
  }
  diagnose({
    name: 'ice.candidate-received',
    sessionId: message.sessionId,
    ...summarizeIceCandidate(message.candidate.candidate),
  })
  if (publisher.peer.remoteDescription !== null) {
    await publisher.peer.addIceCandidate(message.candidate)
  } else {
    publisher.pendingIce.push(message.candidate)
  }
}

async function handleControlMessage(bytes: Uint8Array): Promise<void> {
  let message: ProtocolMessage | undefined
  try {
    message = decodeProtocolMessage(bytes)
  } catch {
    return
  }
  if (message === undefined) {
    return
  }
  const publisher = publishers.get(message.sessionId)
  const channel =
    message.type.startsWith('file.') || message.type.startsWith('clipboard.')
      ? publisher?.fileTransfer
      : publisher?.reliable
  if (channel?.readyState === 'open') {
    if (message.type === 'file.download.chunk' || message.type === 'clipboard.read.chunk') {
      await waitForFileBackpressure(channel)
    }
    channel.send(new Uint8Array(bytes))
    if (
      message.type.startsWith('file.download.') ||
      message.type === 'clipboard.read.chunk'
    ) {
      send({
        type: 'media.control_forwarded',
        sessionId: message.sessionId,
        sequence: message.sequence,
      })
    }
  }
}

async function waitForFileBackpressure(channel: RTCDataChannel): Promise<void> {
  if (channel.bufferedAmount <= FILE_BUFFER_HIGH_WATER_BYTES) return
  channel.bufferedAmountLowThreshold = FILE_BUFFER_LOW_WATER_BYTES
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('File DataChannel backpressure did not drain'))
    }, FILE_BUFFER_WAIT_TIMEOUT_MS)
    const ready = (): void => {
      cleanup()
      resolve()
    }
    const closed = (): void => {
      cleanup()
      reject(new Error('File DataChannel closed while waiting for backpressure'))
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      channel.removeEventListener('bufferedamountlow', ready)
      channel.removeEventListener('close', closed)
    }
    channel.addEventListener('bufferedamountlow', ready, { once: true })
    channel.addEventListener('close', closed, { once: true })
  })
}

function stopPublisher(sessionId: string, expected?: Publisher): void {
  const publisher = publishers.get(sessionId)
  if (expected !== undefined && publisher !== expected) {
    return
  }
  peerReadySessions.delete(sessionId)
  publisherStartAttempts.delete(sessionId)
  if (publisher === undefined) {
    return
  }
  publishers.delete(sessionId)
  clearTimeout(publisher.failureTimer)
  clearTimeout(publisher.metricsTimer)
  diagnose({ name: 'media.publisher-stopped', sessionId })
  publisher.reliable.close()
  publisher.realtime.close()
  publisher.fileTransfer.close()
  publisher.peer.close()
  for (const track of publisher.stream.getTracks()) {
    track.stop()
  }
}

function startPublisherMetrics(publisher: Publisher): void {
  if ((!publisher.diagnosticsEnabled && publisher.qualityState?.configuration.mode !== 'auto') ||
      publisher.metricsTimer !== undefined || publisher.metricsSampling || publisher.peer.connectionState !== 'connected') return
  publisher.metricsTimer = setTimeout(() => void samplePublisherMetrics(publisher), 0)
}

async function samplePublisherMetrics(publisher: Publisher): Promise<void> {
  publisher.metricsTimer = undefined
  if (
    publishers.get(publisher.sessionId) !== publisher ||
    publisher.peer.connectionState !== 'connected'
  ) {
    return
  }
  publisher.metricsSampling = true
  const metricsRevision = publisher.metricsRevision
  try {
    const sample = summarizeWebRtcMediaMetrics(
      await publisher.peer.getStats(),
      'outbound',
      publisher.metricsHistory,
    )
    if (metricsRevision === publisher.metricsRevision) publisher.metricsHistory = sample.history
    if (publisher.diagnosticsEnabled) for (const metrics of sample.metrics) emitPublisherDiagnostic(publisher, metrics)
    if (metricsRevision === publisher.metricsRevision) await adaptPublisherQuality(publisher, sample.metrics.find(metrics => metrics.kind === 'video'))
    const channels = [
      ['control-reliable', publisher.reliable],
      ['control-realtime', publisher.realtime],
      ['file-transfer', publisher.fileTransfer],
    ] as const
    if (publisher.diagnosticsEnabled) for (const [label, channel] of channels) {
      emitPublisherDiagnostic(publisher, {
        name: 'data-channel.metrics',
        label,
        bufferedAmount: channel.bufferedAmount,
      })
    }
  } catch {
    // A transient stats failure must not alter media or Session lifecycle.
    resetAutomaticQualityHistory(publisher)
  } finally {
    publisher.metricsSampling = false
  }
  if (
    publishers.get(publisher.sessionId) === publisher &&
    publisher.peer.connectionState === 'connected' &&
    (publisher.diagnosticsEnabled || publisher.qualityState?.configuration.mode === 'auto')
  ) {
    publisher.metricsTimer = setTimeout(
      () => void samplePublisherMetrics(publisher),
      METRICS_INTERVAL_MS,
    )
  }
}

function emitPublisherDiagnostic(
  publisher: Publisher,
  diagnostic: WebRtcMediaMetrics | DataChannelMetrics,
): void {
  diagnose({ sessionId: publisher.sessionId, ...diagnostic })
  send({ type: 'media.diagnostic', sessionId: publisher.sessionId, diagnostic })
}

// Sender parameters and capture replacement must not race over one RTCRtpSender.
function withPublisherMedia(publisher: Publisher, operation: () => Promise<void>): Promise<void> {
  const next = publisher.mediaOperations.then(async () => {
    if (publishers.get(publisher.sessionId) !== publisher) return
    await operation()
  })
  publisher.mediaOperations = next.catch(() => undefined)
  return next
}

async function setPublisherSuspended(sessionId: string, suspended: boolean): Promise<void> {
  const publisher = publishers.get(sessionId)
  if (publisher === undefined) return
  try {
    await withPublisherMedia(publisher, async () => {
      // Disabling a Track sends black frames/silence. Inactive encodings stop media RTP
      // while retaining the capture tracks, PeerConnection and all DataChannels.
      for (const sender of publisher.peer.getSenders().filter(sender => sender.track !== null)) {
        const parameters = sender.getParameters()
        for (const encoding of parameters.encodings) encoding.active = !suspended
        await sender.setParameters(parameters)
      }
      if (publishers.get(sessionId) !== publisher) return
      publisher.suspended = suspended
      resetAutomaticQualityHistory(publisher)
      for (const track of publisher.stream.getTracks()) track.enabled = !suspended
      send({ type: 'media.suspension_changed', sessionId, suspended })
    })
  } catch {
    diagnose({ name: 'media.suspension-failed', sessionId })
    // A partially changed sender set cannot be acknowledged as suspended/resumed.
    stopPublisher(sessionId, publisher)
  }
}

async function setPublisherQuality(
  sessionId: string,
  settings: MediaQualitySettings,
): Promise<void> {
  const publisher = publishers.get(sessionId)
  const sender = publisher?.peer.getSenders().find((candidate) => candidate.track?.kind === 'video')
  if (publisher === undefined || sender === undefined) {
    send({
      type: 'media.quality_failed',
      sessionId,
      error: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'Remote Tab video sender is unavailable',
        retryable: true,
      },
    })
    return
  }
  try {
    await withPublisherMedia(publisher, async () => {
      const applied = await applyPublisherEncoding(publisher, settings,
        settings.preset === 'data-saver' ? 'balanced' : 'maintain-resolution')
      if (publishers.get(sessionId) !== publisher) return
      publisher.qualityState = undefined
      publisher.qualityLimits = undefined
      resetAutomaticQualityHistory(publisher)
      settings = { preset: settings.preset, ...applied }
      diagnose({
        name: 'media.quality-changed',
        sessionId,
        preset: settings.preset,
        maxBitrate: settings.maxBitrate,
        maxFrameRate: settings.maxFrameRate,
        scaleResolutionDownBy: settings.scaleResolutionDownBy,
      })
      send({ type: 'media.quality_changed', sessionId, settings })
    })
  } catch {
    send({
      type: 'media.quality_failed',
      sessionId,
      error: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'Chrome could not apply the requested media quality',
        retryable: false,
      },
    })
  }
}

type ConfigureQualityMessage = Extract<ExtensionLoopbackMessage, { type: 'media.configure_quality' }>

function resetAutomaticQualityHistory(publisher: Publisher): void {
  publisher.metricsRevision += 1
  publisher.automaticQualityHistory = { pressureSamples: 0, healthySamples: 0 }
  publisher.metricsHistory = new Map()
}

function mutableCaptureConstraints(track: MediaStreamTrack): MediaTrackConstraints {
  const constraints = track.getConstraints()
  // tabCapture reports its acquisition deviceId here. Reapplying that source token is not
  // supported; only these mutable dimensions belong in an active capture update/rollback.
  return {
    ...(constraints.width === undefined ? {} : { width: constraints.width }),
    ...(constraints.height === undefined ? {} : { height: constraints.height }),
    ...(constraints.frameRate === undefined ? {} : { frameRate: constraints.frameRate }),
  }
}

async function applyCaptureFrameRate(track: MediaStreamTrack, frameRate: number): Promise<void> {
  // Changing only RTP parameters cannot raise a capture acquired at 30 FPS to 60 FPS.
  await track.applyConstraints({ ...mutableCaptureConstraints(track), frameRate: { ideal: frameRate, max: frameRate } })
}

async function applyPublisherEncoding(
  publisher: Publisher,
  settings: EncodingSettings,
  degradationPreference: RTCDegradationPreference = 'balanced',
): Promise<EncodingSettings> {
  const sender = publisher.peer.getSenders().find(candidate => candidate.track?.kind === 'video')
  const track = sender?.track
  if (sender === undefined || track == null || track.readyState !== 'live') throw new Error('Video sender unavailable')
  const originalConstraints = mutableCaptureConstraints(track)
  // Keep one transaction snapshot: another getParameters() refreshes Chrome's transactionId.
  const parameters = sender.getParameters()
  const originalParameters = structuredClone(parameters)
  if (parameters.encodings.length !== 1) throw new Error('Unsupported video sender encoding topology')
  Object.assign(parameters.encodings[0]!, {
    maxBitrate: settings.maxBitrate,
    maxFramerate: settings.maxFrameRate,
    scaleResolutionDownBy: settings.scaleResolutionDownBy,
  })
  parameters.degradationPreference = degradationPreference
  let senderApplied = false
  let captureApplied = false
  try {
    // Keep the sender limit in place before increasing the capture frame rate.
    await sender.setParameters(parameters)
    senderApplied = true
    await applyCaptureFrameRate(track, settings.maxFrameRate)
    captureApplied = true
    const encoding = sender.getParameters().encodings[0]
    if (encoding?.maxBitrate === undefined || encoding.maxFramerate === undefined ||
        encoding.scaleResolutionDownBy === undefined || encoding.maxBitrate > settings.maxBitrate ||
        encoding.maxFramerate > settings.maxFrameRate || encoding.scaleResolutionDownBy < settings.scaleResolutionDownBy) {
      throw new Error('Chrome did not enforce requested encoding bounds')
    }
    const applied = {
      maxBitrate: encoding.maxBitrate,
      maxFrameRate: encoding.maxFramerate,
      scaleResolutionDownBy: encoding.scaleResolutionDownBy,
    }
    publisher.encodingSettings = applied
    return applied
  } catch (error) {
    try {
      if (captureApplied) await track.applyConstraints(originalConstraints)
      if (senderApplied) {
        const rollback = sender.getParameters()
        rollback.encodings = originalParameters.encodings
        if (originalParameters.degradationPreference !== undefined) rollback.degradationPreference = originalParameters.degradationPreference
        else delete rollback.degradationPreference
        await sender.setParameters(rollback)
      }
    } catch {
      // A partially changed sender/capture cannot be reported as the old configuration.
      stopPublisher(publisher.sessionId, publisher)
    }
    throw error
  }
}

async function configurePublisherQuality(message: ConfigureQualityMessage): Promise<void> {
  const { sessionId, requestId } = message
  const publisher = publishers.get(sessionId)
  const fail = () => send({ type: 'media.quality_configuration_failed', sessionId, requestId,
    error: { code: 'CAPABILITY_UNAVAILABLE', message: 'Chrome could not apply the requested media quality', retryable: false } })
  if (publisher === undefined) { fail(); return }
  try {
    let acknowledged = false
    await withPublisherMedia(publisher, async () => {
      const applied = await applyPublisherEncoding(publisher, configuredEncoding(message.configuration, message.limits))
      if (publishers.get(sessionId) !== publisher) return
      publisher.qualityLimits = { ...message.limits }
      publisher.qualityState = { configuration: { ...message.configuration }, applied }
      resetAutomaticQualityHistory(publisher)
      send({ type: 'media.quality_configuration', sessionId, requestId, state: publisher.qualityState })
      acknowledged = true
      startPublisherMetrics(publisher)
    })
    if (!acknowledged) fail()
  } catch { fail() }
}

async function adaptPublisherQuality(publisher: Publisher, metrics: WebRtcMediaMetrics | undefined): Promise<void> {
  const state = publisher.qualityState
  const limits = publisher.qualityLimits
  if (state?.configuration.mode !== 'auto' || limits === undefined) return
  if (publisher.suspended || publisher.captureReplacement !== undefined || publisher.peer.connectionState !== 'connected') {
    resetAutomaticQualityHistory(publisher)
    return
  }
  const ceiling = boundEncoding({ maxBitrate: 6_000_000, maxFrameRate: 60, scaleResolutionDownBy: 1 }, limits)
  const settings = adaptEncoding(metrics, state.applied, ceiling, publisher.automaticQualityHistory)
  if (settings === undefined) return
  await withPublisherMedia(publisher, async () => {
    // Manual requests and suspension may arrive while this sample waits for a capture mutation.
    if (publisher.qualityState !== state || publisher.suspended || publisher.captureReplacement !== undefined ||
        publisher.peer.connectionState !== 'connected') return
    try {
      const applied = await applyPublisherEncoding(publisher, boundEncoding(settings, limits))
      if (publishers.get(publisher.sessionId) !== publisher) return
      publisher.qualityState = { configuration: state.configuration, applied }
      send({ type: 'media.quality_configuration', sessionId: publisher.sessionId, state: publisher.qualityState })
    } catch {
      // Preserve the last successfully applied state after rollback. Automatic work has no
      // request ID; retry only after a fresh sustained-pressure/healthy window.
      resetAutomaticQualityHistory(publisher)
      diagnose({ name: 'media.automatic-quality-failed', sessionId: publisher.sessionId })
    }
  })
}

function closeAllPublishers(): void {
  for (const sessionId of new Set([...publishers.keys(), ...publisherStartAttempts.keys()])) {
    stopPublisher(sessionId)
  }
}

function normalizeIceCandidate(candidate: RTCIceCandidateInit): IceCandidate {
  return {
    candidate: candidate.candidate ?? '',
    sdpMid: candidate.sdpMid ?? null,
    sdpMLineIndex: candidate.sdpMLineIndex ?? null,
    ...(candidate.usernameFragment == null ? {} : { usernameFragment: candidate.usernameFragment }),
  }
}

function send(message: ExtensionLoopbackMessage): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(encodeExtensionLoopbackMessage(message))
  }
}

interface ExtensionDiagnosticEvent {
  name: string
  sessionId?: string
  [field: string]: string | number | boolean | undefined
}

function diagnose(event: ExtensionDiagnosticEvent): void {
  console.info('[browshare:remote-tab]', JSON.stringify(event))
}
