import { WindowCatalogReceiver } from './window-catalog.js'
import {
  createProtocolMessage,
  assertUploadAllowed,
  isWindowScopedMessage,
  decodeProtocolMessage,
  decodeSignalingMessage,
  encodeProtocolMessage,
  encodeSignalingMessage,
  normalizeCapabilities,
  RemoteTabError,
  summarizeIceCandidate,
  summarizeSelectedIceCandidatePair,
  summarizeWebRtcMediaMetrics,
  type Capability,
  type MediaQualityPreset,
  type QualityConfiguration,
  type QualityState,
  type ProtocolMessage,
  type ProtocolPayload,
  type RemoteTabState,
  type SignalingMessage,
  type Viewport,
  type WindowState,
  type WebRtcMetricsHistory,
} from '@browshare/remote-tab-protocol'

import type {
  NavigationCommand,
  RemoteTabClient,
  RemoteTabClientEvent,
  RemoteTabClientEventListener,
  RemoteTabClientOptions,
  RemoteTabClipboardItem,
  RemoteTabClipboardWriteItem,
  RemoteTabDiagnostic,
  RemoteTabDownloadedFile,
  RemoteTabUploadFile,
} from './index.js'

const CLIENT_VERSION = '0.1.23'
const APPLICATION_ERROR_CLOSE_CODE = 4_000
const DEFAULT_ICE_RESTART_ATTEMPTS = 2
const DEFAULT_ICE_DISCONNECTED_DELAY_MS = 2_000
const DEFAULT_ICE_RESTART_TIMEOUT_MS = 10_000
const DEFAULT_RECONNECT_ATTEMPTS = 3
const DEFAULT_RECONNECT_MINIMUM_DELAY_MS = 500
const DEFAULT_RECONNECT_MAXIMUM_DELAY_MS = 5_000
const CONTROL_ACK_TIMEOUT_MS = 10_000
const METRICS_INTERVAL_MS = 5_000
const FILE_BUFFER_HIGH_WATER_BYTES = 1024 * 1024
const FILE_BUFFER_LOW_WATER_BYTES = 256 * 1024
const FILE_BUFFER_WAIT_TIMEOUT_MS = 10_000
const CLIPBOARD_TRANSFER_TIMEOUT_MS = 120_000
const MAX_CLIPBOARD_ITEM_BYTES = 16 * 1024 * 1024
const MAX_CLIPBOARD_TOTAL_BYTES = 24 * 1024 * 1024

interface NormalizedUploadFile {
  fileId: string
  displayName: string
  mimeType?: string
  size: number
  data: Blob | Uint8Array
}

interface UploadRequestState {
  request: ProtocolPayload<'file.upload.request'>
  timer: ReturnType<typeof setTimeout>
}

interface LocalOpenRequestState {
  request: ProtocolPayload<'navigation.local_open_request'>
  timer: ReturnType<typeof setTimeout>
}

interface PendingUpload {
  requestId: string
  transferId: string
  files: readonly NormalizedUploadFile[]
  totalBytes: number
  accepted: boolean
  resolve(): void
  reject(reason: unknown): void
}

interface DownloadTransfer {
  offer: ProtocolPayload<'file.download.offer'>
  accepted: boolean
  chunks: Uint8Array<ArrayBuffer>[]
  receivedBytes: number
  timer: ReturnType<typeof setTimeout>
  promise?: Promise<RemoteTabDownloadedFile>
  resolve?(download: RemoteTabDownloadedFile): void
  reject?(reason: unknown): void
}

interface NormalizedClipboardWriteItem {
  descriptor: ProtocolPayload<'clipboard.write.offer'>['items'][number]
  data: Blob | Uint8Array
}

interface PendingClipboardWrite {
  requestId: string
  transferId: string
  items: readonly NormalizedClipboardWriteItem[]
  totalBytes: number
  accepted: boolean
  timer: ReturnType<typeof setTimeout>
  resolve(): void
  reject(reason: unknown): void
}

interface PendingClipboardReadItem {
  descriptor: ProtocolPayload<'clipboard.read.offer'>['items'][number]
  chunks: Uint8Array<ArrayBuffer>[]
  nextOffset: number
}

interface PendingClipboardRead {
  requestId: string
  transferId?: string
  items: Map<string, PendingClipboardReadItem>
  totalBytes: number
  receivedBytes: number
  timer: ReturnType<typeof setTimeout>
  resolve(items: readonly RemoteTabClipboardItem[]): void
  reject(reason: unknown): void
}

export function createRemoteTabClient(options: RemoteTabClientOptions): RemoteTabClient {
  return new BrowserRemoteTabClient(options)
}

class BrowserRemoteTabClient implements RemoteTabClient {
  readonly #options: RemoteTabClientOptions
  readonly #listeners = new Set<RemoteTabClientEventListener>()
  #ticket: string
  #endpoint: string
  #state: RemoteTabState = 'ATTACHING'
  #capabilities: readonly Capability[] = []
  #windowState: WindowState | undefined
  readonly #windowCatalog = new WindowCatalogReceiver()
  #pendingWindow: { requestId: string; timer: ReturnType<typeof setTimeout>; resolve(): void; reject(reason: unknown): void } | undefined
  #socket: WebSocket | undefined
  #peerConnection: RTCPeerConnection | undefined
  #reliableChannel: RTCDataChannel | undefined
  #realtimeChannel: RTCDataChannel | undefined
  #fileChannel: RTCDataChannel | undefined
  readonly #dataChannels = new Map<string, RTCDataChannel>()
  #pendingIce: RTCIceCandidateInit[] = []
  #remoteStream: MediaStream | undefined
  #videoElement: HTMLVideoElement | undefined
  #sessionId: string | undefined
  #viewerGeneration: number | undefined
  #sequence = 0
  #connectPromise: Promise<void> | undefined
  #resolveConnect: (() => void) | undefined
  #rejectConnect: ((reason: unknown) => void) | undefined
  #connectionTimer: ReturnType<typeof setTimeout> | undefined
  #iceRestartTimer: ReturnType<typeof setTimeout> | undefined
  #metricsTimer: ReturnType<typeof setTimeout> | undefined
  #metricsHistory: WebRtcMetricsHistory = new Map()
  #iceRestartAttempt = 0
  #connectedOnce = false
  #stateBeforeRecovery: 'CONNECTED' | 'SUSPENDED' = 'CONNECTED'
  #requestedQuality: MediaQualityPreset | undefined
  #requestedQualityConfiguration: QualityConfiguration | undefined
  #pendingQualityConfiguration: {
    requestId: string
    timer: ReturnType<typeof setTimeout>
    resolve(state: QualityState): void
    reject(reason: unknown): void
  } | undefined
  #reconnectAttempt = 0
  #requestingReconnectCredentials = false
  #awaitingReconnectHandshake = false
  #reconnectDelayTimer: ReturnType<typeof setTimeout> | undefined
  #resolveReconnectDelay: ((ready: boolean) => void) | undefined
  #pendingStateTransition:
    | {
        target: 'CONNECTED' | 'SUSPENDED'
        promise: Promise<void>
        resolve(): void
        reject(reason: unknown): void
        timer: ReturnType<typeof setTimeout>
      }
    | undefined
  #pendingQuality:
    | {
        preset: MediaQualityPreset
        promise: Promise<void>
        resolve(): void
        reject(reason: unknown): void
        timer: ReturnType<typeof setTimeout>
      }
    | undefined
  readonly #uploadRequests = new Map<string, UploadRequestState>()
  readonly #downloads = new Map<string, DownloadTransfer>()
  readonly #noticeRequests = new Map<string, {
    request: ProtocolPayload<'notice.request'>
    timer: ReturnType<typeof setTimeout>
  }>()
  readonly #localOpenRequests = new Map<string, LocalOpenRequestState>()
  #pendingUpload: PendingUpload | undefined
  #pendingClipboardWrite: PendingClipboardWrite | undefined
  #pendingClipboardRead: PendingClipboardRead | undefined
  #disconnecting = false

  public constructor(options: RemoteTabClientOptions) {
    validateIceRestartOptions(options)
    validateReconnectOptions(options)
    this.#options = options
    this.#ticket = options.ticket
    this.#endpoint = options.endpoint
  }

  public get windowState(): WindowState | undefined {
    if (this.#windowState === undefined) return undefined
    return { ...this.#windowState, selecting: this.#windowState.selecting || this.#pendingWindow !== undefined || this.#windowCatalog.pending,
      windows: this.#windowState.windows.map(window => ({ ...window })) }
  }

  public selectWindow(targetId: string): Promise<void> { return this.#requestWindowAction(targetId) }

  public closeWindow(): Promise<void> {
    const state = this.windowState
    if (state?.windows.find(window => window.targetId === state.selectedTargetId)?.main) {
      return Promise.reject(new RemoteTabError('CAPABILITY_UNAVAILABLE', 'End the Session to close its main window'))
    }
    return this.#requestWindowAction()
  }

  #requestWindowAction(targetId?: string): Promise<void> {
    if (!this.#capabilities.includes('windowSelection')) return Promise.reject(new RemoteTabError('CAPABILITY_UNAVAILABLE', 'Window selection is unavailable'))
    const state = this.windowState
    if (state === undefined || state.selecting) return Promise.reject(new RemoteTabError('ILLEGAL_STATE_TRANSITION', 'Window selection is not ready'))
    if (targetId === state.selectedTargetId) return Promise.resolve()
    if (targetId !== undefined && !state.windows.some(window => window.targetId === targetId)) return Promise.reject(new RemoteTabError('TAB_NOT_FOUND', 'Window is not in the owned catalog'))
    const requestId = crypto.randomUUID()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.#handleFailure(new RemoteTabError('CAPTURE_DENIED', 'Window selection acknowledgement timed out')), 30_000)
      this.#pendingWindow = { requestId, timer, resolve, reject }
      try {
        if (targetId === undefined) this.#sendReliable('window.close', { requestId })
        else this.#sendReliable('window.select', { requestId, targetId })
        this.#emit({ type: 'window-change', state: this.windowState! })
      } catch (cause) {
        clearTimeout(timer)
        this.#pendingWindow = undefined
        reject(cause)
      }
    })
  }

  public get state(): RemoteTabState {
    return this.#state
  }

  public get capabilities(): readonly Capability[] {
    return this.#capabilities
  }

  public connect(): Promise<void> {
    if (this.#connectPromise !== undefined) {
      return this.#connectPromise
    }
    if (this.#options.signal?.aborted === true) {
      return Promise.reject(this.#options.signal.reason)
    }

    this.#connectPromise = new Promise<void>((resolve, reject) => {
      this.#resolveConnect = resolve
      this.#rejectConnect = reject
    })
    const timeoutMs = this.#options.connectionTimeoutMs ?? 15_000
    this.#connectionTimer = setTimeout(
      () =>
        this.#handleFailure(
          new RemoteTabError('SIGNALING_PAIR_TIMEOUT', 'Remote Tab connection timed out', {
            retryable: true,
          }),
        ),
      timeoutMs,
    )

    this.#options.signal?.addEventListener('abort', () => void this.disconnect(), { once: true })
    this.#openSignaling()
    return this.#connectPromise
  }

  public async disconnect(): Promise<void> {
    if (this.#disconnecting || this.#state === 'CLOSED') {
      return
    }
    this.#disconnecting = true
    this.#clearConnectionTimer()
    this.#clearIceRestartTimer()
    this.#stopMetrics()
    this.#cancelReconnectDelay()
    this.#rejectPendingActions(new RemoteTabError('SESSION_CLOSED', 'Viewer disconnected'))
    this.#rejectUpload(new RemoteTabError('SESSION_CLOSED', 'Viewer disconnected'))
    this.#clearDownloads(new RemoteTabError('SESSION_CLOSED', 'Viewer disconnected'))
    this.#clearClipboardTransfers(new RemoteTabError('SESSION_CLOSED', 'Viewer disconnected'))
    this.#clearUploadRequests()
    this.#clearNoticeRequests()
    this.#clearLocalOpenRequests('connection-lost')
    this.#reliableChannel?.close()
    this.#realtimeChannel?.close()
    this.#fileChannel?.close()
    this.#peerConnection?.close()
    this.#socket?.close(1000, 'Viewer disconnected')
    this.#reliableChannel = undefined
    this.#realtimeChannel = undefined
    this.#fileChannel = undefined
    this.#dataChannels.clear()
    this.#peerConnection = undefined
    this.#socket = undefined
    this.#remoteStream = undefined
    if (this.#videoElement !== undefined) {
      this.#videoElement.srcObject = null
    }
    this.#setState('CLOSED')
    this.#rejectConnect?.(new RemoteTabError('SESSION_CLOSED', 'Viewer disconnected'))
    this.#resolveConnect = undefined
    this.#rejectConnect = undefined
  }

  public attachVideo(element: HTMLVideoElement): void {
    this.#videoElement = element
    element.srcObject = this.#remoteStream ?? null
    if (this.#remoteStream !== undefined) {
      this.#playVideo(element)
    }
  }

  public detachVideo(): void {
    if (this.#videoElement !== undefined) {
      this.#videoElement.srcObject = null
      this.#videoElement = undefined
    }
  }

  #playVideo(element: HTMLVideoElement): void {
    const stream = element.srcObject
    void element.play().catch((cause: unknown) => {
      if (this.#videoElement !== element || element.srcObject !== stream) return
      if (cause instanceof DOMException && cause.name === 'NotAllowedError') {
        this.#emit({ type: 'playback-blocked', reason: 'user-activation-required' })
      }
    })
  }

  public async suspend(): Promise<void> {
    if (this.#state === 'SUSPENDED') return
    const waiting = this.#waitForState('SUSPENDED')
    try {
      this.#sendReliable('session.suspend', {})
      await waiting
    } catch (cause) {
      this.#rejectPendingActions(cause)
      await waiting.catch(() => undefined)
      throw cause
    }
  }

  public async resume(): Promise<void> {
    if (this.#state === 'CONNECTED') return
    const waiting = this.#waitForState('CONNECTED')
    try {
      this.#sendReliable('session.resume', {})
      await waiting
    } catch (cause) {
      this.#rejectPendingActions(cause)
      await waiting.catch(() => undefined)
      throw cause
    }
  }

  public async navigate(command: NavigationCommand): Promise<void> {
    this.#sendReliable('navigation.request', command)
  }

  public async requestViewport(request: ProtocolPayload<'viewport.request'>): Promise<void> {
    this.#sendReliable('viewport.request', request)
  }

  public async requestQuality(preset: MediaQualityPreset): Promise<void> {
    if (!this.#capabilities.includes('qualityControl')) {
      throw new RemoteTabError('CAPABILITY_UNAVAILABLE', 'Media quality control is not available')
    }
    if (this.#capabilities.includes('advancedQuality')) {
      await this.configureQuality({ mode: 'preset', preset })
      return
    }
    this.#requestedQualityConfiguration = undefined
    this.#requestedQuality = preset
    const waiting = this.#waitForQuality(preset)
    try {
      this.#sendReliable('quality.request', { preset })
      await waiting
    } catch (cause) {
      this.#rejectPendingActions(cause)
      await waiting.catch(() => undefined)
      throw cause
    }
  }

  public async configureQuality(configuration: QualityConfiguration): Promise<QualityState> {
    if (!this.#capabilities.includes('qualityControl') || !this.#capabilities.includes('advancedQuality')) {
      throw new RemoteTabError('CAPABILITY_UNAVAILABLE', 'Advanced media quality control is not available')
    }
    const requested = { ...configuration }
    const requestId = crypto.randomUUID()
    this.#rejectQualityConfiguration(new RemoteTabError('ILLEGAL_STATE_TRANSITION', 'A different quality configuration replaced this request'))
    return new Promise<QualityState>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pendingQualityConfiguration?.requestId !== requestId) return
        this.#rejectQualityConfiguration(new RemoteTabError('CAPABILITY_UNAVAILABLE', 'Media quality acknowledgement timed out', { retryable: true }))
      }, CONTROL_ACK_TIMEOUT_MS)
      this.#pendingQualityConfiguration = { requestId, timer, resolve: state => {
        this.#requestedQuality = undefined
        this.#requestedQualityConfiguration = requested
        resolve(state)
      }, reject }
      try {
        this.#sendReliable('quality.configure', { requestId, configuration: requested })
      } catch (cause) {
        this.#rejectQualityConfiguration(cause)
      }
    })
  }

  public sendPointer(input: ProtocolPayload<'input.pointer'>): void {
    const realtime = input.event === 'mouseMoved' || input.event === 'mouseWheel'
    this.#sendControl('input.pointer', input, realtime ? this.#realtimeChannel : this.#reliableChannel)
  }

  public sendKey(input: ProtocolPayload<'input.key'>): void {
    this.#sendReliable('input.key', input)
  }

  public sendComposition(input: ProtocolPayload<'input.composition'>): void {
    this.#sendReliable('input.composition', input)
  }

  public async respondToNotice(requestId: string, buttonId: string | null): Promise<void> {
    if (!this.#capabilities.includes('noticeRequests')) {
      throw new RemoteTabError('CAPABILITY_UNAVAILABLE', 'Notice requests are not available')
    }
    const pending = this.#noticeRequests.get(requestId)
    if (pending === undefined || pending.request.expiresAt <= Date.now()) {
      this.#closeNotice(requestId, 'expired')
      throw new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Notice request expired or closed')
    }
    if (buttonId !== null && !pending.request.content.buttons.some((button) => button.id === buttonId)) {
      throw new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Notice response names an unavailable button')
    }
    this.#sendReliable('notice.response', { requestId, buttonId })
    this.#closeNotice(requestId, 'response')
  }

  public async respondToLocalOpen(requestId: string, approved: boolean): Promise<void> {
    const request = this.#localOpenRequests.get(requestId)
    if (request === undefined || request.request.expiresAt <= Date.now()) {
      this.#removeLocalOpenRequest(requestId)
      throw new RemoteTabError('NAVIGATION_DENIED', 'Local-open request expired')
    }
    this.#removeLocalOpenRequest(requestId)
    this.#sendReliable('navigation.local_open_result', { requestId, approved })
  }

  public uploadFiles(requestId: string, files: readonly RemoteTabUploadFile[]): Promise<void> {
    if (!this.#capabilities.includes('upload')) {
      return Promise.reject(new RemoteTabError('CAPABILITY_UNAVAILABLE', 'File upload is not available'))
    }
    const request = this.#uploadRequests.get(requestId)?.request
    if (request === undefined || request.expiresAt <= Date.now()) {
      return Promise.reject(new RemoteTabError('FILE_TRANSFER_FAILED', 'Remote file chooser request expired'))
    }
    if (files.length === 0 || (!request.multiple && files.length !== 1)) {
      return Promise.reject(new RemoteTabError('FILE_LIMIT_EXCEEDED', 'Selected file count is invalid'))
    }
    if (this.#pendingUpload !== undefined) {
      return Promise.reject(new RemoteTabError('FILE_TRANSFER_FAILED', 'Another upload is active'))
    }
    const normalized = files.map((file) => normalizeUploadFile(file))
    if (request.constraints !== undefined) {
      try { assertUploadAllowed(normalized, request.constraints) } catch (cause) { return Promise.reject(cause) }
    }
    const transferId = crypto.randomUUID()
    let resolve!: () => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    this.#pendingUpload = {
      requestId,
      transferId,
      files: normalized,
      totalBytes: normalized.reduce((total, file) => total + file.size, 0),
      accepted: false,
      resolve,
      reject,
    }
    this.#removeUploadRequest(requestId)
    try {
      this.#sendFile('file.upload.offer', {
        requestId,
        transferId,
        files: normalized.map(({ fileId, displayName, size, mimeType }) => ({
          fileId,
          displayName,
          size,
          ...(mimeType === undefined || mimeType === '' ? {} : { mimeType }),
        })),
      })
    } catch (cause) {
      this.#rejectUpload(cause)
    }
    return promise
  }

  public async cancelUpload(requestId: string): Promise<void> {
    const transferId =
      this.#pendingUpload?.requestId === requestId ? this.#pendingUpload.transferId : undefined
    this.#sendFile('file.upload.cancel', {
      requestId,
      ...(transferId === undefined ? {} : { transferId }),
      reason: 'Viewer cancelled the upload',
    })
    this.#removeUploadRequest(requestId)
    if (transferId !== undefined) {
      this.#rejectUpload(new RemoteTabError('FILE_TRANSFER_FAILED', 'File upload was cancelled'))
    }
  }

  public acceptDownload(transferId: string): Promise<RemoteTabDownloadedFile> {
    if (!this.#capabilities.includes('download')) {
      return Promise.reject(new RemoteTabError('CAPABILITY_UNAVAILABLE', 'File download is not available'))
    }
    const transfer = this.#downloads.get(transferId)
    if (transfer === undefined || transfer.offer.expiresAt <= Date.now()) {
      if (transfer !== undefined) {
        this.#removeDownload(transferId)
      }
      return Promise.reject(new RemoteTabError('FILE_TRANSFER_FAILED', 'Download request expired'))
    }
    if (transfer.promise !== undefined) return transfer.promise

    let resolve!: (download: RemoteTabDownloadedFile) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<RemoteTabDownloadedFile>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    transfer.accepted = true
    transfer.promise = promise
    transfer.resolve = resolve
    transfer.reject = reject
    clearTimeout(transfer.timer)
    try {
      this.#sendFile('file.download.accept', { transferId })
    } catch (cause) {
      this.#failDownload(
        transfer,
        asRemoteTabError(cause, 'FILE_TRANSFER_FAILED', 'Could not accept download'),
        false,
      )
    }
    return promise
  }

  public async cancelDownload(transferId: string): Promise<void> {
    const transfer = this.#downloads.get(transferId)
    if (transfer === undefined) {
      throw new RemoteTabError('FILE_TRANSFER_FAILED', 'Download request is not active')
    }
    this.#sendFile('file.download.cancel', {
      transferId,
      reason: 'Viewer cancelled the download',
    })
    this.#failDownload(
      transfer,
      new RemoteTabError('FILE_TRANSFER_FAILED', 'File download was cancelled'),
      false,
    )
  }

  public writeRemoteClipboard(items: readonly RemoteTabClipboardWriteItem[]): Promise<void> {
    if (items.length === 0 || items.length > 2) {
      return Promise.reject(
        new RemoteTabError('FILE_LIMIT_EXCEEDED', 'Clipboard must contain one or two supported items'),
      )
    }
    if (this.#pendingClipboardWrite !== undefined) {
      return Promise.reject(new RemoteTabError('FILE_TRANSFER_FAILED', 'Another clipboard write is active'))
    }

    let normalized: readonly NormalizedClipboardWriteItem[]
    try {
      normalized = normalizeClipboardWriteItems(items, this.#capabilities)
    } catch (cause) {
      return Promise.reject(cause)
    }
    const requestId = crypto.randomUUID()
    const transferId = crypto.randomUUID()
    let resolve!: () => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    const transfer: PendingClipboardWrite = {
      requestId,
      transferId,
      items: normalized,
      totalBytes: normalized.reduce((total, item) => total + item.descriptor.size, 0),
      accepted: false,
      timer: this.#createClipboardTimer('write', transferId),
      resolve,
      reject,
    }
    this.#pendingClipboardWrite = transfer
    try {
      this.#sendTransfer('clipboard.write.offer', {
        requestId,
        transferId,
        items: normalized.map((item) => item.descriptor),
      })
    } catch (cause) {
      this.#failClipboardWrite(
        transfer,
        asRemoteTabError(cause, 'FILE_TRANSFER_FAILED', 'Could not offer clipboard data'),
      )
    }
    return promise
  }

  public readRemoteClipboard(): Promise<readonly RemoteTabClipboardItem[]> {
    if (
      !this.#capabilities.includes('clipboardText') &&
      !this.#capabilities.includes('clipboardImage')
    ) {
      return Promise.reject(new RemoteTabError('CAPABILITY_UNAVAILABLE', 'Clipboard is not available'))
    }
    if (this.#pendingClipboardRead !== undefined) {
      return Promise.reject(new RemoteTabError('FILE_TRANSFER_FAILED', 'Another clipboard read is active'))
    }
    const requestId = crypto.randomUUID()
    let resolve!: (items: readonly RemoteTabClipboardItem[]) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<readonly RemoteTabClipboardItem[]>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    const transfer: PendingClipboardRead = {
      requestId,
      items: new Map(),
      totalBytes: 0,
      receivedBytes: 0,
      timer: this.#createClipboardTimer('read', requestId),
      resolve,
      reject,
    }
    this.#pendingClipboardRead = transfer
    try {
      this.#sendTransfer('clipboard.read.request', { requestId })
    } catch (cause) {
      this.#failClipboardRead(
        transfer,
        asRemoteTabError(cause, 'FILE_TRANSFER_FAILED', 'Could not request remote clipboard'),
        false,
      )
    }
    return promise
  }

  public addEventListener(listener: RemoteTabClientEventListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #openSignaling(reconnecting = false): void {
    this.#setState(reconnecting ? 'RECONNECTING' : 'NEGOTIATING')
    if (reconnecting) this.#armConnectionTimer()
    const socket = new WebSocket(this.#endpoint)
    this.#socket = socket
    socket.addEventListener('open', () => {
      if (this.#socket !== socket) return
      this.#diagnose({ name: 'signaling.socket-open' })
      socket.send(
        encodeSignalingMessage({
          type: 'viewer.bind',
          ticket: this.#ticket,
        }),
      )
    })
    socket.addEventListener('message', (event) => {
      if (this.#socket !== socket) return
      try {
        const message = decodeSignalingMessage(String(event.data))
        void this.#handleSignal(message).catch((cause: unknown) => {
          this.#handleFailure(
            asRemoteTabError(cause, 'PROTOCOL_MESSAGE_INVALID', 'Signaling message failed'),
          )
        })
      } catch (cause) {
        this.#handleFailure(
          asRemoteTabError(cause, 'PROTOCOL_DECODE_FAILED', 'Signaling message failed'),
        )
      }
    })
    socket.addEventListener('error', () => {
      if (this.#socket !== socket) return
      this.#handleFailure(
        new RemoteTabError('ICE_FAILED', 'Viewer could not connect to the signaling Gateway', {
          retryable: true,
        }),
      )
    })
    socket.addEventListener('close', () => {
      if (this.#socket !== socket) return
      this.#socket = undefined
      this.#diagnose({ name: 'signaling.socket-close' })
      if (
        !this.#disconnecting &&
        this.#state !== 'FAILED' &&
        this.#state !== 'CLOSED' &&
        (!this.#connectedOnce || this.#peerConnection?.connectionState !== 'connected')
      ) {
        this.#handleFailure(
          new RemoteTabError('ICE_FAILED', 'Viewer signaling connection closed', {
            retryable: true,
          }),
        )
      }
    })
  }

  async #handleSignal(message: SignalingMessage): Promise<void> {
    if (message.type === 'signal.error') {
      this.#handleFailure(
        new RemoteTabError(message.error.code, message.error.message, {
          retryable: message.error.retryable,
          ...(message.error.details === undefined ? {} : { details: message.error.details }),
        }),
      )
      return
    }
    if (message.type === 'signal.ready') {
      if (message.role !== 'viewer') {
        throw new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Viewer received a Core signaling role')
      }
      if (
        this.#connectedOnce &&
        (message.sessionId !== this.#sessionId ||
          this.#viewerGeneration === undefined ||
          message.viewerGeneration <= this.#viewerGeneration)
      ) {
        throw new RemoteTabError(
          'VIEWER_TICKET_INVALID',
          'Reconnect credentials did not advance the Viewer generation for this Session',
        )
      }
      this.#sessionId = message.sessionId
      this.#viewerGeneration = message.viewerGeneration
      this.#capabilities = normalizeCapabilities(message.capabilities)
      this.#emit({ type: 'capabilities-change', capabilities: this.#capabilities })
      const iceTransportPolicy = message.iceTransportPolicy ?? 'all'
      this.#diagnose({ name: 'signaling.ready', iceServerCount: message.iceServers.length, iceTransportPolicy })
      this.#createPeerConnection(message.iceServers, iceTransportPolicy)
      return
    }
    if (message.type === 'signal.description') {
      if (message.description.type !== 'offer' || this.#peerConnection === undefined) {
        throw new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Viewer expected a WebRTC offer')
      }
      this.#diagnose({
        name: 'signaling.description-received',
        descriptionType: 'offer',
      })
      await this.#peerConnection.setRemoteDescription(message.description)
      for (const candidate of this.#pendingIce.splice(0)) {
        await this.#peerConnection.addIceCandidate(candidate)
      }
      const answer = await this.#peerConnection.createAnswer()
      await this.#peerConnection.setLocalDescription(answer)
      this.#sendSignal({
        type: 'signal.description',
        description: { type: 'answer', sdp: answer.sdp ?? '' },
      })
      this.#diagnose({ name: 'signaling.description-sent', descriptionType: 'answer' })
      return
    }
    if (message.type === 'signal.ice') {
      const candidate: RTCIceCandidateInit = message.candidate
      this.#diagnose({
        name: 'ice.candidate-received',
        ...summarizeIceCandidate(message.candidate.candidate),
      })
      if (this.#peerConnection !== undefined && this.#peerConnection.remoteDescription !== null) {
        await this.#peerConnection.addIceCandidate(candidate)
      } else {
        this.#pendingIce.push(candidate)
      }
      return
    }
    if (message.type === 'signal.peer-left') {
      this.#handleFailure(
        new RemoteTabError('ICE_FAILED', 'Remote Tab publisher disconnected', { retryable: true }),
      )
    }
  }

  #createPeerConnection(
    iceServers: readonly import('@browshare/remote-tab-protocol').IceServer[],
    iceTransportPolicy: RTCIceTransportPolicy,
  ): void {
    this.#stopMetrics()
    this.#peerConnection?.close()
    this.#reliableChannel = undefined
    this.#realtimeChannel = undefined
    this.#fileChannel = undefined
    this.#dataChannels.clear()
    this.#pendingIce = []
    const peer = new RTCPeerConnection({
      iceServers: iceServers.map((server) => ({
        urls: [...server.urls],
        ...(server.username === undefined ? {} : { username: server.username }),
        ...(server.credential === undefined ? {} : { credential: server.credential }),
      })),
      bundlePolicy: 'max-bundle',
      iceTransportPolicy,
    })
    this.#peerConnection = peer
    peer.addEventListener('icecandidate', (event) => {
      if (event.candidate !== null) {
        const candidate = event.candidate.toJSON()
        this.#diagnose({
          name: 'ice.candidate-sent',
          ...summarizeIceCandidate(candidate.candidate ?? ''),
        })
        this.#sendSignal({
          type: 'signal.ice',
          candidate: {
            candidate: candidate.candidate ?? '',
            sdpMid: candidate.sdpMid ?? null,
            sdpMLineIndex: candidate.sdpMLineIndex ?? null,
            ...(candidate.usernameFragment == null
              ? {}
              : { usernameFragment: candidate.usernameFragment }),
          },
        })
      }
    })
    const emitPeerState = (): void => {
      this.#diagnose({
        name: 'webrtc.state',
        signalingState: peer.signalingState,
        iceGatheringState: peer.iceGatheringState,
        iceConnectionState: peer.iceConnectionState,
        connectionState: peer.connectionState,
      })
    }
    peer.addEventListener('signalingstatechange', emitPeerState)
    peer.addEventListener('icegatheringstatechange', emitPeerState)
    peer.addEventListener('iceconnectionstatechange', emitPeerState)
    peer.addEventListener('track', (event) => {
      if (event.track.kind === 'audio' || event.track.kind === 'video') {
        this.#diagnose({ name: 'media.track-received', kind: event.track.kind })
      }
      this.#remoteStream = event.streams[0] ?? new MediaStream([event.track])
      // Audio and video can arrive separately in the same stream. Reassigning it
      // resets playback in Safari and can abort the first pending play request.
      if (
        this.#videoElement !== undefined &&
        this.#videoElement.srcObject !== this.#remoteStream
      ) {
        this.#videoElement.srcObject = this.#remoteStream
        this.#playVideo(this.#videoElement)
      }
    })
    peer.addEventListener('datachannel', (event) => this.#installDataChannel(event.channel))
    peer.addEventListener('connectionstatechange', () => {
      if (this.#peerConnection !== peer) return
      emitPeerState()
      if (peer.connectionState === 'connected') {
        this.#clearIceRestartTimer()
        this.#iceRestartAttempt = 0
        void this.#diagnoseSelectedCandidatePair(peer)
        this.#startMetrics(peer)
        if (
          this.#connectedOnce &&
          !this.#awaitingReconnectHandshake &&
          this.#state === 'RECONNECTING'
        ) {
          this.#setState(this.#stateBeforeRecovery)
        }
      } else if (peer.connectionState === 'disconnected') {
        this.#scheduleIceRestart(peer)
      }
      if (peer.connectionState === 'failed') {
        this.#requestIceRestart(peer)
      }
    })
  }

  #installDataChannel(channel: RTCDataChannel): void {
    channel.binaryType = 'arraybuffer'
    if (
      channel.label === 'control-reliable' ||
      channel.label === 'control-realtime' ||
      channel.label === 'file-transfer'
    ) {
      this.#dataChannels.set(channel.label, channel)
    }
    channel.addEventListener('open', () =>
      this.#diagnose({ name: 'data-channel.open', label: channel.label }),
    )
    channel.addEventListener('close', () => {
      this.#diagnose({ name: 'data-channel.close', label: channel.label })
      if (this.#dataChannels.get(channel.label) === channel) {
        this.#dataChannels.delete(channel.label)
      }
      if (channel.label === 'control-reliable' && this.#reliableChannel === channel && !this.#disconnecting) {
        this.#handleFailure(new RemoteTabError('ICE_FAILED', 'Reliable Viewer control channel closed', { retryable: true }))
      }
      if (channel.label === 'file-transfer' && this.#fileChannel === channel) {
        this.#fileChannel = undefined
        const error = new RemoteTabError('SESSION_CLOSED', 'File channel closed during transfer', {
          retryable: true,
        })
        this.#rejectUpload(error)
        this.#clearDownloads(error)
        this.#clearClipboardTransfers(error)
      }
    })
    if (channel.label === 'control-reliable') {
      this.#reliableChannel = channel
      channel.addEventListener('open', () => {
        this.#sendReliable('hello', {
          clientVersion: CLIENT_VERSION,
          capabilities: [...this.#capabilities],
        })
      })
      channel.addEventListener('message', (event) => void this.#handleControlData(event.data))
    } else if (channel.label === 'control-realtime') {
      this.#realtimeChannel = channel
    } else if (channel.label === 'file-transfer') {
      this.#fileChannel = channel
      channel.addEventListener('message', (event) => void this.#handleFileData(event.data))
    }
  }

  async #handleFileData(data: unknown): Promise<void> {
    let bytes: Uint8Array
    if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data)
    } else if (data instanceof Blob) {
      bytes = new Uint8Array(await data.arrayBuffer())
    } else {
      this.#handleFailure(new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'File message is not binary'))
      return
    }
    try {
      const message = decodeProtocolMessage(bytes)
      if (message === undefined) return
      this.#handleFileMessage(message)
    } catch (cause) {
      this.#handleFailure(asRemoteTabError(cause, 'PROTOCOL_DECODE_FAILED', 'File message failed'))
    }
  }

  #handleFileMessage(message: ProtocolMessage): void {
    if (message.sessionId !== this.#sessionId || message.viewerGeneration !== this.#viewerGeneration) {
      this.#handleFailure(
        new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'File message Session binding changed'),
      )
      return
    }
    if (message.type === 'file.upload.request') {
      this.#clearUploadRequests()
      const delay = Math.max(0, message.payload.expiresAt - Date.now())
      const state: UploadRequestState = {
        request: message.payload,
        timer: setTimeout(() => this.#removeUploadRequest(message.payload.requestId), delay),
      }
      this.#uploadRequests.set(message.payload.requestId, state)
      this.#emit({ type: 'upload-request', ...message.payload })
    } else if (message.type === 'file.upload.accept') {
      const upload = this.#pendingUpload
      if (upload === undefined || upload.transferId !== message.payload.transferId || upload.accepted) {
        this.#handleFailure(
          new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Upload acceptance does not match an offer'),
        )
        return
      }
      upload.accepted = true
      void this.#sendUploadBytes(upload, message.payload.maxChunkBytes)
    } else if (message.type === 'file.upload.cancel') {
      this.#removeUploadRequest(message.payload.requestId)
      if (
        this.#pendingUpload?.requestId === message.payload.requestId &&
        (message.payload.transferId === undefined ||
          this.#pendingUpload.transferId === message.payload.transferId)
      ) {
        this.#rejectUpload(
          new RemoteTabError('FILE_TRANSFER_FAILED', message.payload.reason ?? 'Upload was cancelled'),
        )
      }
      this.#emit({ type: 'upload-cancelled', ...message.payload })
    } else if (message.type === 'file.upload.result') {
      const upload = this.#pendingUpload
      if (upload === undefined || upload.transferId !== message.payload.transferId) {
        this.#handleFailure(
          new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Upload result does not match an active transfer'),
        )
        return
      }
      this.#pendingUpload = undefined
      if (message.payload.delivered) {
        upload.resolve()
      } else {
        const error = message.payload.error
        upload.reject(
          error === undefined
            ? new RemoteTabError('FILE_TRANSFER_FAILED', 'Remote file upload failed')
            : new RemoteTabError(error.code, error.message, {
                retryable: error.retryable,
                ...(error.details === undefined ? {} : { details: error.details }),
              }),
        )
      }
    } else if (message.type === 'file.download.offer') {
      this.#handleDownloadOffer(message.payload)
    } else if (message.type === 'file.download.chunk') {
      this.#handleDownloadChunk(message.payload)
    } else if (message.type === 'file.download.complete') {
      this.#handleDownloadComplete(message.payload.transferId)
    } else if (message.type === 'file.download.cancel') {
      const transfer = this.#downloads.get(message.payload.transferId)
      if (transfer !== undefined) {
        this.#failDownload(
          transfer,
          new RemoteTabError(
            'FILE_TRANSFER_FAILED',
            message.payload.reason ?? 'Remote download was cancelled',
          ),
          false,
        )
      }
    } else if (message.type === 'clipboard.write.accept') {
      this.#handleClipboardWriteAccept(message.payload)
    } else if (message.type === 'clipboard.write.result') {
      this.#handleClipboardWriteResult(message.payload)
    } else if (message.type === 'clipboard.read.offer') {
      this.#handleClipboardReadOffer(message.payload)
    } else if (message.type === 'clipboard.read.chunk') {
      this.#handleClipboardReadChunk(message.payload)
    } else if (message.type === 'clipboard.read.complete') {
      this.#handleClipboardReadComplete(message.payload.transferId)
    } else if (message.type === 'clipboard.read.result') {
      this.#handleClipboardReadResult(message.payload)
    }
  }

  #handleClipboardWriteAccept(payload: ProtocolPayload<'clipboard.write.accept'>): void {
    const transfer = this.#pendingClipboardWrite
    if (transfer === undefined || transfer.transferId !== payload.transferId || transfer.accepted) {
      this.#handleFailure(
        new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Clipboard write acceptance does not match an offer'),
      )
      return
    }
    transfer.accepted = true
    this.#resetClipboardTimer(transfer, 'write')
    void this.#sendClipboardWriteBytes(transfer, payload.maxChunkBytes)
  }

  #handleClipboardWriteResult(payload: ProtocolPayload<'clipboard.write.result'>): void {
    const transfer = this.#pendingClipboardWrite
    if (transfer === undefined || transfer.transferId !== payload.transferId) {
      this.#handleFailure(
        new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Clipboard write result does not match an active transfer'),
      )
      return
    }
    this.#pendingClipboardWrite = undefined
    clearTimeout(transfer.timer)
    if (payload.written) {
      transfer.resolve()
      return
    }
    transfer.reject(remoteErrorFromPayload(payload.error, 'Remote clipboard write failed'))
  }

  #handleClipboardReadOffer(offer: ProtocolPayload<'clipboard.read.offer'>): void {
    const transfer = this.#pendingClipboardRead
    if (
      transfer === undefined ||
      transfer.requestId !== offer.requestId ||
      transfer.transferId !== undefined
    ) {
      this.#handleFailure(
        new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Clipboard read offer does not match a request'),
      )
      return
    }
    try {
      const itemIds = new Set<string>()
      const mimeTypes = new Set<string>()
      let totalBytes = 0
      for (const descriptor of offer.items) {
        const capability = descriptor.mimeType === 'text/plain' ? 'clipboardText' : 'clipboardImage'
        if (
          itemIds.has(descriptor.itemId) ||
          mimeTypes.has(descriptor.mimeType) ||
          !this.#capabilities.includes(capability)
        ) {
          throw new RemoteTabError(
            'PROTOCOL_MESSAGE_INVALID',
            'Clipboard read items are duplicated or were not negotiated',
          )
        }
        if (descriptor.size > MAX_CLIPBOARD_ITEM_BYTES) {
          throw new RemoteTabError('FILE_LIMIT_EXCEEDED', 'Clipboard item exceeds the size limit')
        }
        totalBytes += descriptor.size
        if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_CLIPBOARD_TOTAL_BYTES) {
          throw new RemoteTabError('FILE_LIMIT_EXCEEDED', 'Clipboard payload exceeds the size limit')
        }
        itemIds.add(descriptor.itemId)
        mimeTypes.add(descriptor.mimeType)
        transfer.items.set(descriptor.itemId, { descriptor, chunks: [], nextOffset: 0 })
      }
      transfer.transferId = offer.transferId
      transfer.totalBytes = totalBytes
      this.#resetClipboardTimer(transfer, 'read')
      this.#sendTransfer('clipboard.read.accept', { transferId: offer.transferId })
    } catch (cause) {
      this.#failClipboardRead(
        transfer,
        asRemoteTabError(cause, 'PROTOCOL_MESSAGE_INVALID', 'Clipboard read offer is invalid'),
        true,
        offer.transferId,
      )
    }
  }

  #handleClipboardReadChunk(payload: ProtocolPayload<'clipboard.read.chunk'>): void {
    const transfer = this.#pendingClipboardRead
    const item = transfer?.items.get(payload.itemId)
    if (
      transfer === undefined ||
      transfer.transferId !== payload.transferId ||
      item === undefined ||
      payload.data.byteLength === 0 ||
      payload.offset !== item.nextOffset ||
      item.nextOffset + payload.data.byteLength > item.descriptor.size
    ) {
      const error = new RemoteTabError(
        'PROTOCOL_MESSAGE_INVALID',
        'Clipboard read chunks are not contiguous or exceed the declared size',
      )
      if (transfer !== undefined) this.#failClipboardRead(transfer, error, true, payload.transferId)
      this.#emit({ type: 'error', error: error.toJSON() })
      return
    }
    item.chunks.push(Uint8Array.from(payload.data))
    item.nextOffset += payload.data.byteLength
    transfer.receivedBytes += payload.data.byteLength
    this.#resetClipboardTimer(transfer, 'read')
    this.#emit({
      type: 'clipboard-progress',
      direction: 'read',
      transferId: payload.transferId,
      transferredBytes: transfer.receivedBytes,
      totalBytes: transfer.totalBytes,
    })
  }

  #handleClipboardReadComplete(transferId: string): void {
    const transfer = this.#pendingClipboardRead
    if (transfer === undefined || transfer.transferId !== transferId) {
      this.#handleFailure(
        new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Clipboard read completion is unexpected'),
      )
      return
    }
    for (const item of transfer.items.values()) {
      if (item.nextOffset !== item.descriptor.size) {
        this.#failClipboardRead(
          transfer,
          new RemoteTabError('FILE_TRANSFER_FAILED', 'Clipboard data ended before its declared size'),
          true,
        )
        return
      }
    }
    const items = [...transfer.items.values()].map<RemoteTabClipboardItem>((item) => {
      const data = joinByteChunks(item.chunks, item.descriptor.size)
      return {
        mimeType: item.descriptor.mimeType,
        size: item.descriptor.size,
        data,
        blob: new Blob([data], { type: item.descriptor.mimeType }),
      }
    })
    try {
      this.#sendTransfer('clipboard.read.result', {
        requestId: transfer.requestId,
        transferId,
        received: true,
      })
      this.#pendingClipboardRead = undefined
      clearTimeout(transfer.timer)
      transfer.resolve(items)
    } catch (cause) {
      this.#failClipboardRead(
        transfer,
        asRemoteTabError(cause, 'FILE_TRANSFER_FAILED', 'Could not acknowledge clipboard read'),
        false,
      )
    }
  }

  #handleClipboardReadResult(payload: ProtocolPayload<'clipboard.read.result'>): void {
    const transfer = this.#pendingClipboardRead
    if (
      transfer === undefined ||
      transfer.requestId !== payload.requestId ||
      (payload.transferId !== undefined &&
        transfer.transferId !== undefined &&
        transfer.transferId !== payload.transferId)
    ) {
      this.#handleFailure(
        new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Clipboard read result does not match a request'),
      )
      return
    }
    if (payload.received) {
      this.#failClipboardRead(
        transfer,
        new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Core cannot acknowledge a Viewer clipboard read'),
        false,
      )
      return
    }
    this.#failClipboardRead(
      transfer,
      remoteErrorFromPayload(payload.error, 'Remote clipboard read failed'),
      false,
    )
  }

  #handleDownloadOffer(offer: ProtocolPayload<'file.download.offer'>): void {
    if (!this.#capabilities.includes('download')) {
      this.#sendFile('file.download.cancel', {
        transferId: offer.transferId,
        reason: 'Viewer did not negotiate file download',
      })
      return
    }
    if (this.#downloads.has(offer.transferId)) {
      this.#handleFailure(
        new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Download transfer ID was reused'),
      )
      return
    }
    const delay = Math.max(0, offer.expiresAt - Date.now())
    const transfer: DownloadTransfer = {
      offer,
      accepted: false,
      chunks: [],
      receivedBytes: 0,
      timer: setTimeout(() => {
        if (this.#downloads.get(offer.transferId) !== transfer) return
        try {
          this.#sendFile('file.download.cancel', {
            transferId: offer.transferId,
            reason: 'Download request expired',
          })
        } catch {
          // The file channel may close at the same time as the request expires.
        }
        this.#failDownload(
          transfer,
          new RemoteTabError('FILE_TRANSFER_FAILED', 'Download request expired'),
          false,
        )
      }, delay),
    }
    this.#downloads.set(offer.transferId, transfer)
    this.#emit({ type: 'download-request', ...offer })
  }

  #handleDownloadChunk(payload: ProtocolPayload<'file.download.chunk'>): void {
    const transfer = this.#downloads.get(payload.transferId)
    if (transfer === undefined || !transfer.accepted) {
      this.#rejectUnexpectedDownload(payload.transferId, 'Download data arrived before acceptance')
      return
    }
    const nextSize = transfer.receivedBytes + payload.data.byteLength
    if (
      payload.data.byteLength === 0 ||
      payload.offset !== transfer.receivedBytes ||
      !Number.isSafeInteger(nextSize) ||
      nextSize > transfer.offer.file.size
    ) {
      this.#failDownloadProtocol(transfer, 'Download chunks are not contiguous or exceed declared size')
      return
    }
    transfer.chunks.push(Uint8Array.from(payload.data))
    transfer.receivedBytes = nextSize
    this.#emit({
      type: 'download-progress',
      transferId: payload.transferId,
      receivedBytes: nextSize,
      totalBytes: transfer.offer.file.size,
    })
  }

  #handleDownloadComplete(transferId: string): void {
    const transfer = this.#downloads.get(transferId)
    if (transfer === undefined || !transfer.accepted) {
      this.#rejectUnexpectedDownload(transferId, 'Download completion arrived before acceptance')
      return
    }
    if (transfer.receivedBytes !== transfer.offer.file.size) {
      this.#failDownloadProtocol(transfer, 'Downloaded bytes do not match the declared file size')
      return
    }
    const descriptor = transfer.offer.file
    const blob = new Blob(transfer.chunks, {
      ...(descriptor.mimeType === undefined ? {} : { type: descriptor.mimeType }),
    })
    if (blob.size !== descriptor.size) {
      this.#failDownloadProtocol(transfer, 'Assembled download size changed')
      return
    }
    const download: RemoteTabDownloadedFile = {
      transferId,
      displayName: descriptor.displayName,
      size: descriptor.size,
      ...(descriptor.mimeType === undefined ? {} : { mimeType: descriptor.mimeType }),
      blob,
    }
    this.#removeDownload(transferId)
    this.#sendFile('file.download.result', { transferId, received: true })
    transfer.resolve?.(download)
    this.#emit({ type: 'download-complete', download })
  }

  #failDownloadProtocol(transfer: DownloadTransfer, message: string): void {
    const error = new RemoteTabError('PROTOCOL_MESSAGE_INVALID', message)
    this.#failDownload(transfer, error, true)
    this.#emit({ type: 'error', error: error.toJSON() })
  }

  #rejectUnexpectedDownload(transferId: string, message: string): void {
    const error = new RemoteTabError('PROTOCOL_MESSAGE_INVALID', message)
    try {
      this.#sendFile('file.download.result', {
        transferId,
        received: false,
        error: error.toJSON(),
      })
    } catch {
      // The file channel may already be unavailable.
    }
    this.#emit({ type: 'error', error: error.toJSON() })
  }

  #failDownload(transfer: DownloadTransfer, error: RemoteTabError, sendResult: boolean): void {
    const transferId = transfer.offer.transferId
    if (this.#downloads.get(transferId) !== transfer) return
    this.#removeDownload(transferId)
    if (sendResult) {
      try {
        this.#sendFile('file.download.result', {
          transferId,
          received: false,
          error: error.toJSON(),
        })
      } catch {
        // The file channel may be the source of the failure.
      }
    }
    transfer.reject?.(error)
    this.#emit({ type: 'download-cancelled', transferId, reason: error.message })
  }

  #removeDownload(transferId: string): void {
    const transfer = this.#downloads.get(transferId)
    if (transfer === undefined) return
    clearTimeout(transfer.timer)
    this.#downloads.delete(transferId)
    transfer.chunks.length = 0
  }

  #clearDownloads(reason: RemoteTabError): void {
    for (const transfer of [...this.#downloads.values()]) {
      this.#failDownload(transfer, reason, false)
    }
  }

  async #sendClipboardWriteBytes(
    transfer: PendingClipboardWrite,
    maxChunkBytes: number,
  ): Promise<void> {
    let sentBytes = 0
    try {
      for (const item of transfer.items) {
        for (let offset = 0; offset < item.descriptor.size; offset += maxChunkBytes) {
          if (this.#pendingClipboardWrite !== transfer) return
          const data = await readUploadChunk(
            item.data,
            offset,
            Math.min(item.descriptor.size, offset + maxChunkBytes),
          )
          await this.#waitForFileBackpressure()
          this.#sendTransfer('clipboard.write.chunk', {
            transferId: transfer.transferId,
            itemId: item.descriptor.itemId,
            offset,
            data,
          })
          sentBytes += data.byteLength
          this.#resetClipboardTimer(transfer, 'write')
          this.#emit({
            type: 'clipboard-progress',
            direction: 'write',
            transferId: transfer.transferId,
            transferredBytes: sentBytes,
            totalBytes: transfer.totalBytes,
          })
        }
      }
      if (this.#pendingClipboardWrite === transfer) {
        this.#sendTransfer('clipboard.write.complete', { transferId: transfer.transferId })
        this.#resetClipboardTimer(transfer, 'write')
      }
    } catch (cause) {
      if (this.#pendingClipboardWrite !== transfer) return
      this.#failClipboardWrite(
        transfer,
        asRemoteTabError(cause, 'FILE_TRANSFER_FAILED', 'Clipboard write failed'),
      )
    }
  }

  #createClipboardTimer(
    direction: 'read' | 'write',
    operationId: string,
  ): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      const error = new RemoteTabError(
        'FILE_TRANSFER_FAILED',
        `Clipboard ${direction} timed out`,
        { retryable: true },
      )
      if (direction === 'write') {
        const transfer = this.#pendingClipboardWrite
        if (transfer?.transferId === operationId) this.#failClipboardWrite(transfer, error)
      } else {
        const transfer = this.#pendingClipboardRead
        if (transfer?.requestId === operationId) this.#failClipboardRead(transfer, error, true)
      }
    }, CLIPBOARD_TRANSFER_TIMEOUT_MS)
  }

  #resetClipboardTimer(
    transfer: PendingClipboardWrite | PendingClipboardRead,
    direction: 'read' | 'write',
  ): void {
    clearTimeout(transfer.timer)
    transfer.timer = this.#createClipboardTimer(
      direction,
      direction === 'write'
        ? (transfer as PendingClipboardWrite).transferId
        : (transfer as PendingClipboardRead).requestId,
    )
  }

  #failClipboardWrite(transfer: PendingClipboardWrite, error: RemoteTabError): void {
    if (this.#pendingClipboardWrite !== transfer) return
    this.#pendingClipboardWrite = undefined
    clearTimeout(transfer.timer)
    transfer.reject(error)
  }

  #failClipboardRead(
    transfer: PendingClipboardRead,
    error: RemoteTabError,
    sendResult: boolean,
    transferId = transfer.transferId,
  ): void {
    if (this.#pendingClipboardRead !== transfer) return
    this.#pendingClipboardRead = undefined
    clearTimeout(transfer.timer)
    if (sendResult && transferId !== undefined) {
      try {
        this.#sendTransfer('clipboard.read.result', {
          requestId: transfer.requestId,
          transferId,
          received: false,
          error: error.toJSON(),
        })
      } catch {
        // The file channel may be the source of the failure.
      }
    }
    transfer.reject(error)
  }

  #clearClipboardTransfers(error: RemoteTabError): void {
    const write = this.#pendingClipboardWrite
    if (write !== undefined) this.#failClipboardWrite(write, error)
    const read = this.#pendingClipboardRead
    if (read !== undefined) this.#failClipboardRead(read, error, false)
  }

  async #sendUploadBytes(upload: PendingUpload, maxChunkBytes: number): Promise<void> {
    let sentBytes = 0
    try {
      for (const file of upload.files) {
        for (let offset = 0; offset < file.size; offset += maxChunkBytes) {
          if (this.#pendingUpload !== upload) return
          const data = await readUploadChunk(file.data, offset, Math.min(file.size, offset + maxChunkBytes))
          await this.#waitForFileBackpressure()
          this.#sendFile('file.upload.chunk', {
            transferId: upload.transferId,
            fileId: file.fileId,
            offset,
            data,
          })
          sentBytes += data.byteLength
          this.#emit({
            type: 'upload-progress',
            transferId: upload.transferId,
            sentBytes,
            totalBytes: upload.totalBytes,
          })
        }
      }
      if (this.#pendingUpload === upload) {
        this.#sendFile('file.upload.complete', { transferId: upload.transferId })
      }
    } catch (cause) {
      if (this.#pendingUpload !== upload) return
      try {
        this.#sendFile('file.upload.cancel', {
          requestId: upload.requestId,
          transferId: upload.transferId,
          reason: 'Viewer could not send the selected files',
        })
      } catch {
        // The file channel may be the source of the failure.
      }
      this.#rejectUpload(asRemoteTabError(cause, 'FILE_TRANSFER_FAILED', 'File upload failed'))
    }
  }

  async #waitForFileBackpressure(): Promise<void> {
    const channel = this.#fileChannel
    if (channel === undefined || channel.readyState !== 'open') {
      throw new RemoteTabError('SESSION_CLOSED', 'Remote Tab file channel is not ready', {
        retryable: true,
      })
    }
    if (channel.bufferedAmount <= FILE_BUFFER_HIGH_WATER_BYTES) return
    channel.bufferedAmountLowThreshold = FILE_BUFFER_LOW_WATER_BYTES
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(
          new RemoteTabError('FILE_TRANSFER_FAILED', 'File channel backpressure did not drain', {
            retryable: true,
          }),
        )
      }, FILE_BUFFER_WAIT_TIMEOUT_MS)
      const ready = (): void => {
        cleanup()
        resolve()
      }
      const closed = (): void => {
        cleanup()
        reject(new RemoteTabError('SESSION_CLOSED', 'File channel closed during upload'))
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

  #sendFile<TypeName extends Extract<Parameters<typeof createProtocolMessage>[0], `file.${string}`>>(
    type: TypeName,
    payload: ProtocolPayload<TypeName>,
  ): void {
    this.#sendControl(type, payload, this.#fileChannel)
  }

  #sendTransfer<
    TypeName extends Extract<
      Parameters<typeof createProtocolMessage>[0],
      `file.${string}` | `clipboard.${string}`
    >,
  >(type: TypeName, payload: ProtocolPayload<TypeName>): void {
    this.#sendControl(type, payload, this.#fileChannel)
  }

  #removeUploadRequest(requestId: string): void {
    const request = this.#uploadRequests.get(requestId)
    if (request === undefined) return
    clearTimeout(request.timer)
    this.#uploadRequests.delete(requestId)
  }

  #clearUploadRequests(): void {
    for (const request of this.#uploadRequests.values()) clearTimeout(request.timer)
    this.#uploadRequests.clear()
  }

  #rejectUpload(reason: unknown): void {
    const upload = this.#pendingUpload
    if (upload === undefined) return
    this.#pendingUpload = undefined
    upload.reject(reason)
  }

  async #handleControlData(data: unknown): Promise<void> {
    let bytes: Uint8Array
    if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data)
    } else if (data instanceof Blob) {
      bytes = new Uint8Array(await data.arrayBuffer())
    } else {
      this.#handleFailure(new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Control message is not binary'))
      return
    }

    try {
      const message = decodeProtocolMessage(bytes)
      if (message !== undefined) {
        this.#handleControlMessage(message)
      }
    } catch (cause) {
      this.#handleFailure(asRemoteTabError(cause, 'PROTOCOL_DECODE_FAILED', 'Control message failed'))
    }
  }

  #handleControlMessage(message: ProtocolMessage): void {
    if (message.sessionId !== this.#sessionId || message.viewerGeneration !== this.#viewerGeneration) {
      this.#handleFailure(
        new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Control message Session binding changed'),
      )
      return
    }
    if (message.type === 'window.state') {
      if (!this.#capabilities.includes('windowSelection')) throw new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Window state was not negotiated')
      if (this.#windowState !== undefined && message.payload.revision < this.#windowState.revision) return
      const state = this.#windowCatalog.accept(message.payload)
      if (state === undefined) {
        if (this.windowState !== undefined) this.#emit({ type: 'window-change', state: this.windowState })
        return
      }
      this.#windowState = state
      const pending = this.#pendingWindow
      if (pending !== undefined && state.requestId === pending.requestId && !state.selecting) {
        this.#pendingWindow = undefined
        clearTimeout(pending.timer)
        if (state.error !== undefined) pending.reject(new RemoteTabError(state.error.code, state.error.message))
        else pending.resolve()
      }
      this.#emit({ type: 'window-change', state: this.windowState! })
      return
    }
    if (message.type === 'hello.accepted') {
      const reconnected = this.#connectedOnce
      this.#capabilities = normalizeCapabilities(message.payload.capabilities)
      this.#emit({ type: 'capabilities-change', capabilities: this.#capabilities })
      this.#emit({ type: 'viewport-change', viewport: message.payload.viewport })
      this.#setState('CONNECTED')
      this.#connectedOnce = true
      this.#reconnectAttempt = 0
      this.#awaitingReconnectHandshake = false
      this.#clearConnectionTimer()
      this.#resolveConnect?.()
      this.#resolveConnect = undefined
      this.#rejectConnect = undefined
      if (reconnected && this.#requestedQualityConfiguration !== undefined &&
        this.#capabilities.includes('advancedQuality') && this.#capabilities.includes('qualityControl')) {
        void this.configureQuality(this.#requestedQualityConfiguration).catch(cause => {
          this.#emit({ type: 'error', error: asRemoteTabError(cause, 'CAPABILITY_UNAVAILABLE', 'Restoring media quality failed').toJSON() })
        })
      } else if (
        reconnected &&
        this.#requestedQuality !== undefined &&
        this.#capabilities.includes('qualityControl')
      ) {
        this.#sendReliable('quality.request', { preset: this.#requestedQuality })
      }
      return
    }
    if (message.type === 'hello.rejected') {
      const error = message.payload
      this.#handleFailure(
        new RemoteTabError(error.code, error.message, {
          retryable: error.retryable,
          ...(error.details === undefined ? {} : { details: error.details }),
        }),
      )
      return
    }
    if (message.type === 'error') {
      const error = new RemoteTabError(message.payload.code, message.payload.message, {
        retryable: message.payload.retryable,
        ...(message.payload.details === undefined ? {} : { details: message.payload.details }),
      })
      this.#rejectPendingActions(error)
      this.#emit({ type: 'error', error: error.toJSON() })
      return
    }
    if (message.type === 'session.capabilities') {
      this.#capabilities = normalizeCapabilities(message.payload.capabilities)
      if (!this.#capabilities.includes('advancedQuality') || !this.#capabilities.includes('qualityControl')) {
        this.#rejectQualityConfiguration(new RemoteTabError('CAPABILITY_UNAVAILABLE', 'Advanced quality control was revoked'))
      }
      if (!this.#capabilities.includes('windowSelection')) {
        this.#windowState = undefined
        this.#windowCatalog.reset()
        if (this.#pendingWindow !== undefined) {
          clearTimeout(this.#pendingWindow.timer)
          this.#pendingWindow.reject(new RemoteTabError('CAPABILITY_UNAVAILABLE', 'Window selection was revoked'))
          this.#pendingWindow = undefined
        }
      }
      this.#emit({ type: 'capabilities-change', capabilities: this.#capabilities })
      return
    }
    if (message.type === 'session.state') {
      this.#setState(message.payload.state, message.payload.reason)
      if (this.#pendingStateTransition?.target === message.payload.state) {
        const pending = this.#pendingStateTransition
        this.#pendingStateTransition = undefined
        clearTimeout(pending.timer)
        pending.resolve()
      }
      return
    }
    if (message.type === 'viewport.ack') {
      this.#emit({ type: 'viewport-change', viewport: message.payload as Viewport })
      return
    }
    if (message.type === 'navigation.result') {
      this.#emit({ type: 'navigation-result', result: message.payload })
      return
    }
    if (message.type === 'navigation.location_changed') {
      this.#emit({ type: 'navigation-location-change', url: message.payload.url })
      return
    }
    if (message.type === 'page.lifecycle') {
      this.#emit({ type: 'page-script-event', event: message.payload })
      return
    }
    if (message.type === 'quality.configuration') {
      if (!this.#capabilities.includes('advancedQuality') || !this.#capabilities.includes('qualityControl')) {
        throw new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Advanced quality state was not negotiated')
      }
      const { requestId, state } = message.payload
      if (requestId !== undefined) {
        const pending = this.#pendingQualityConfiguration
        // A superseded request must never resolve or visually replace a newer request.
        if (pending?.requestId !== requestId) return
        this.#pendingQualityConfiguration = undefined
        clearTimeout(pending.timer)
        pending.resolve(state)
      }
      this.#emit({ type: 'quality-configuration-change', state })
      if (state.configuration.mode === 'preset') {
        this.#emit({ type: 'quality-change', quality: { preset: state.configuration.preset, ...state.applied } })
      }
      return
    }
    if (message.type === 'quality.configuration_failed') {
      if (this.#pendingQualityConfiguration?.requestId !== message.payload.requestId) return
      const { error } = message.payload
      this.#rejectQualityConfiguration(new RemoteTabError(error.code, error.message, {
        retryable: error.retryable,
        ...(error.details === undefined ? {} : { details: error.details }),
      }))
      return
    }
    if (message.type === 'quality.ack') {
      if (
        this.#pendingQuality !== undefined &&
        this.#pendingQuality.preset !== message.payload.preset
      ) {
        this.#handleFailure(
          new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Quality acknowledgement changed preset'),
        )
        return
      }
      this.#emit({ type: 'quality-change', quality: message.payload })
      if (this.#pendingQuality !== undefined) {
        const pending = this.#pendingQuality
        this.#pendingQuality = undefined
        clearTimeout(pending.timer)
        pending.resolve()
      }
      return
    }
    if (message.type === 'navigation.local_open_request') {
      if (normalizeHttpUrl(message.payload.url) === undefined) {
        this.#handleFailure(
          new RemoteTabError(
            'PROTOCOL_MESSAGE_INVALID',
            'Local-open request URL must use HTTP or HTTPS',
          ),
        )
        return
      }
      if (this.#localOpenRequests.has(message.payload.requestId)) {
        this.#handleFailure(
          new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Local-open request ID was reused'),
        )
        return
      }
      const delay = Math.max(0, message.payload.expiresAt - Date.now())
      const state: LocalOpenRequestState = {
        request: message.payload,
        timer: setTimeout(() => {
          if (!this.#localOpenRequests.has(message.payload.requestId)) return
          this.#localOpenRequests.delete(message.payload.requestId)
          this.#emit({
            type: 'local-open-cancelled',
            requestId: message.payload.requestId,
            reason: 'expired',
          })
        }, delay),
      }
      this.#localOpenRequests.set(message.payload.requestId, state)
      this.#emit({ type: 'local-open-request', ...message.payload })
      return
    }
    if (message.type === 'notice.request') {
      const request = message.payload
      if (!this.#capabilities.includes('noticeRequests') || message.minor < 1 ||
          this.#noticeRequests.has(request.requestId) || this.#noticeRequests.size >= 4 ||
          new Set(request.content.buttons.map((button) => button.id)).size !== request.content.buttons.length) {
        this.#handleFailure(new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Notice request is not valid for this Viewer'))
        return
      }
      if (request.expiresAt <= Date.now()) return
      this.#noticeRequests.set(request.requestId, {
        request,
        timer: setTimeout(() => this.#closeNotice(request.requestId, 'expired'),
          Math.min(120_000, request.expiresAt - Date.now())),
      })
      this.#emit({ type: 'notice-request', request })
      return
    }
    if (message.type === 'notice.cancel') {
      this.#closeNotice(message.payload.requestId, message.payload.reason)
      return
    }
    if (message.type === 'notice') {
      this.#emit({ type: 'notice', notice: message.payload })
    }
  }

  #closeNotice(requestId: string, reason: Extract<RemoteTabClientEvent, { type: 'notice-closed' }>['reason']): void {
    const pending = this.#noticeRequests.get(requestId)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    this.#noticeRequests.delete(requestId)
    this.#emit({ type: 'notice-closed', requestId, reason })
  }

  #clearNoticeRequests(): void {
    for (const requestId of this.#noticeRequests.keys()) this.#closeNotice(requestId, 'connection-lost')
  }

  #removeLocalOpenRequest(requestId: string): void {
    const request = this.#localOpenRequests.get(requestId)
    if (request === undefined) return
    clearTimeout(request.timer)
    this.#localOpenRequests.delete(requestId)
  }

  #clearLocalOpenRequests(reason: 'connection-lost'): void {
    for (const request of this.#localOpenRequests.values()) {
      clearTimeout(request.timer)
      this.#emit({
        type: 'local-open-cancelled',
        requestId: request.request.requestId,
        reason,
      })
    }
    this.#localOpenRequests.clear()
  }

  #sendReliable<TypeName extends Parameters<typeof createProtocolMessage>[0]>(
    type: TypeName,
    payload: ProtocolPayload<TypeName>,
  ): void {
    this.#sendControl(type, payload, this.#reliableChannel)
  }

  #sendControl<TypeName extends Parameters<typeof createProtocolMessage>[0]>(
    type: TypeName,
    payload: ProtocolPayload<TypeName>,
    channel: RTCDataChannel | undefined,
  ): void {
    if (
      channel === undefined ||
      channel.readyState !== 'open' ||
      this.#sessionId === undefined ||
      this.#viewerGeneration === undefined
    ) {
      throw new RemoteTabError('SESSION_CLOSED', 'Remote Tab control channel is not ready', {
        retryable: true,
      })
    }
    const scoped = this.#capabilities.includes('windowSelection') && isWindowScopedMessage(type)
    if (scoped && (this.#windowState === undefined || this.#windowState.selecting || this.#windowCatalog.pending ||
        (this.#pendingWindow !== undefined && type !== 'window.select' && type !== 'window.close'))) {
      throw new RemoteTabError('ILLEGAL_STATE_TRANSITION', 'Remote window selection is in progress')
    }
    const message = createProtocolMessage(
      type,
      {
        ...(scoped ? { windowRevision: this.#windowState!.revision } : {}),
        sessionId: this.#sessionId,
        viewerGeneration: this.#viewerGeneration,
        sequence: ++this.#sequence,
      },
      payload,
    )
    channel.send(new Uint8Array(encodeProtocolMessage(message as ProtocolMessage)))
  }

  #sendSignal(message: SignalingMessage): void {
    if (this.#socket?.readyState !== WebSocket.OPEN) {
      throw new RemoteTabError('SIGNALING_NOT_PAIRED', 'Signaling socket is not open', {
        retryable: true,
      })
    }
    this.#socket.send(encodeSignalingMessage(message))
  }

  #setState(state: RemoteTabState, reason?: string): void {
    if (this.#state === state) {
      return
    }
    this.#state = state
    this.#emit({
      type: 'connection-state-change',
      state,
      ...(reason === undefined ? {} : { reason }),
    })
  }

  #emit(event: RemoteTabClientEvent): void {
    for (const listener of this.#listeners) {
      listener(event)
    }
  }

  #diagnose(diagnostic: RemoteTabDiagnostic): void {
    this.#emit({ type: 'diagnostic', diagnostic })
  }

  async #diagnoseSelectedCandidatePair(peer: RTCPeerConnection): Promise<void> {
    const summary = summarizeSelectedIceCandidatePair(await peer.getStats())
    if (this.#peerConnection === peer && summary !== undefined) {
      this.#diagnose({ name: 'webrtc.selected-candidate-pair', ...summary })
    }
  }

  #startMetrics(peer: RTCPeerConnection): void {
    if (!this.#capabilities.includes('diagnostics') || this.#metricsTimer !== undefined) return
    this.#metricsTimer = setTimeout(() => void this.#sampleMetrics(peer), 0)
  }

  async #sampleMetrics(peer: RTCPeerConnection): Promise<void> {
    this.#metricsTimer = undefined
    if (this.#peerConnection !== peer || peer.connectionState !== 'connected') return
    try {
      const sample = summarizeWebRtcMediaMetrics(
        await peer.getStats(),
        'inbound',
        this.#metricsHistory,
      )
      if (this.#peerConnection !== peer) return
      this.#metricsHistory = sample.history
      for (const metrics of sample.metrics) this.#diagnose(metrics)
      for (const [label, channel] of this.#dataChannels) {
        if (
          label === 'control-reliable' ||
          label === 'control-realtime' ||
          label === 'file-transfer'
        ) {
          this.#diagnose({
            name: 'data-channel.metrics',
            label,
            bufferedAmount: channel.bufferedAmount,
          })
        }
      }
    } catch {
      // A transient stats failure must not alter Viewer or Session lifecycle.
    }
    if (this.#peerConnection === peer && peer.connectionState === 'connected') {
      this.#metricsTimer = setTimeout(() => void this.#sampleMetrics(peer), METRICS_INTERVAL_MS)
    }
  }

  #stopMetrics(): void {
    if (this.#metricsTimer !== undefined) {
      clearTimeout(this.#metricsTimer)
      this.#metricsTimer = undefined
    }
    this.#metricsHistory = new Map()
  }

  #waitForState(target: 'CONNECTED' | 'SUSPENDED'): Promise<void> {
    if (this.#pendingStateTransition?.target === target) {
      return this.#pendingStateTransition.promise
    }
    if (this.#pendingStateTransition !== undefined) {
      const previous = this.#pendingStateTransition
      this.#pendingStateTransition = undefined
      clearTimeout(previous.timer)
      previous.reject(
        new RemoteTabError('ILLEGAL_STATE_TRANSITION', 'A different lifecycle transition is pending'),
      )
    }
    let resolve!: () => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    const timer = setTimeout(() => {
      if (this.#pendingStateTransition?.promise !== promise) return
      this.#pendingStateTransition = undefined
      reject(
        new RemoteTabError('ILLEGAL_STATE_TRANSITION', 'Lifecycle acknowledgement timed out', {
          retryable: true,
        }),
      )
    }, CONTROL_ACK_TIMEOUT_MS)
    this.#pendingStateTransition = { target, promise, resolve, reject, timer }
    return promise
  }

  #waitForQuality(preset: MediaQualityPreset): Promise<void> {
    if (this.#pendingQuality?.preset === preset) return this.#pendingQuality.promise
    if (this.#pendingQuality !== undefined) {
      const previous = this.#pendingQuality
      this.#pendingQuality = undefined
      clearTimeout(previous.timer)
      previous.reject(
        new RemoteTabError('ILLEGAL_STATE_TRANSITION', 'A different quality request is pending'),
      )
    }
    let resolve!: () => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    const timer = setTimeout(() => {
      if (this.#pendingQuality?.promise !== promise) return
      this.#pendingQuality = undefined
      reject(
        new RemoteTabError('CAPABILITY_UNAVAILABLE', 'Media quality acknowledgement timed out', {
          retryable: true,
        }),
      )
    }, CONTROL_ACK_TIMEOUT_MS)
    this.#pendingQuality = { preset, promise, resolve, reject, timer }
    return promise
  }

  #rejectQualityConfiguration(reason: unknown): void {
    const pending = this.#pendingQualityConfiguration
    if (pending === undefined) return
    this.#pendingQualityConfiguration = undefined
    clearTimeout(pending.timer)
    pending.reject(reason)
  }

  #rejectPendingActions(reason: unknown): void {
    this.#rejectQualityConfiguration(reason)
    if (this.#pendingWindow !== undefined) {
      clearTimeout(this.#pendingWindow.timer)
      this.#pendingWindow.reject(reason)
      this.#pendingWindow = undefined
    }
    if (this.#pendingStateTransition !== undefined) {
      const pending = this.#pendingStateTransition
      this.#pendingStateTransition = undefined
      clearTimeout(pending.timer)
      pending.reject(reason)
    }
    if (this.#pendingQuality !== undefined) {
      const pending = this.#pendingQuality
      this.#pendingQuality = undefined
      clearTimeout(pending.timer)
      pending.reject(reason)
    }
  }

  #handleFailure(error: RemoteTabError): void {
    if (this.#state === 'FAILED' || this.#state === 'CLOSED') return
    if (
      error.retryable &&
      this.#connectedOnce &&
      this.#reconnectConfiguration() !== undefined &&
      this.#sessionId !== undefined &&
      this.#viewerGeneration !== undefined &&
      !this.#disconnecting
    ) {
      void this.#requestReconnectCredentials(error)
      return
    }
    this.#fail(error)
  }

  async #requestReconnectCredentials(error: RemoteTabError): Promise<void> {
    if (this.#requestingReconnectCredentials || this.#disconnecting) return
    const configuration = this.#reconnectConfiguration()
    const previousSessionId = this.#sessionId
    const previousViewerGeneration = this.#viewerGeneration
    if (
      configuration === undefined ||
      previousSessionId === undefined ||
      previousViewerGeneration === undefined ||
      this.#reconnectAttempt >= configuration.maxAttempts
    ) {
      this.#fail(error)
      return
    }

    this.#requestingReconnectCredentials = true
    this.#reconnectAttempt += 1
    const attempt = this.#reconnectAttempt
    if (this.#state === 'CONNECTED' || this.#state === 'SUSPENDED') {
      this.#stateBeforeRecovery = this.#state
    }
    this.#setState('RECONNECTING', error.code)
    this.#rejectPendingActions(error)
    this.#rejectUpload(error)
    this.#clearDownloads(error)
    this.#clearClipboardTransfers(error)
    this.#clearUploadRequests()
    this.#clearNoticeRequests()
    this.#clearLocalOpenRequests('connection-lost')
    this.#teardownTransport()
    this.#diagnose({
      name: 'reconnect.credentials-requested',
      attempt,
      maximumAttempts: configuration.maxAttempts,
    })

    const delayMs = Math.min(
      configuration.minimumDelayMs * 2 ** Math.min(attempt - 1, 8),
      configuration.maximumDelayMs,
    )
    if (!(await this.#waitForReconnectDelay(delayMs))) {
      this.#requestingReconnectCredentials = false
      return
    }

    try {
      const credentials = await configuration.getConnection({
        attempt,
        cause: error.toJSON(),
        previousSessionId,
        previousViewerGeneration,
      })
      if (credentials.ticket.trim() === '' || credentials.endpoint.trim() === '') {
        throw new RemoteTabError(
          'VIEWER_TICKET_INVALID',
          'Reconnect provider returned empty connection credentials',
        )
      }
      if (this.#disconnecting || this.#state === 'CLOSED') {
        this.#requestingReconnectCredentials = false
        return
      }
      this.#ticket = credentials.ticket
      this.#endpoint = credentials.endpoint
      this.#requestingReconnectCredentials = false
      this.#awaitingReconnectHandshake = true
      this.#openSignaling(true)
    } catch (cause) {
      this.#requestingReconnectCredentials = false
      const reconnectError =
        cause instanceof RemoteTabError
          ? cause
          : new RemoteTabError('ICE_FAILED', 'Embedder could not issue reconnect credentials', {
              cause,
              retryable: true,
            })
      this.#handleFailure(reconnectError)
    }
  }

  #teardownTransport(): void {
    this.#windowState = undefined
    this.#windowCatalog.reset()
    this.#clearConnectionTimer()
    this.#clearIceRestartTimer()
    this.#stopMetrics()
    const reliable = this.#reliableChannel
    const realtime = this.#realtimeChannel
    const file = this.#fileChannel
    const peer = this.#peerConnection
    const socket = this.#socket
    this.#reliableChannel = undefined
    this.#realtimeChannel = undefined
    this.#fileChannel = undefined
    this.#peerConnection = undefined
    this.#socket = undefined
    this.#pendingIce = []
    this.#dataChannels.clear()
    reliable?.close()
    realtime?.close()
    file?.close()
    peer?.close()
    socket?.close(1000, 'Viewer reconnecting')
    this.#remoteStream = undefined
    if (this.#videoElement !== undefined) this.#videoElement.srcObject = null
  }

  #armConnectionTimer(): void {
    this.#clearConnectionTimer()
    const timeoutMs = this.#options.connectionTimeoutMs ?? 15_000
    this.#connectionTimer = setTimeout(
      () =>
        this.#handleFailure(
          new RemoteTabError('SIGNALING_PAIR_TIMEOUT', 'Remote Tab reconnect timed out', {
            retryable: true,
          }),
        ),
      timeoutMs,
    )
  }

  #reconnectConfiguration():
    | (Required<Omit<NonNullable<Exclude<RemoteTabClientOptions['reconnect'], false>>, 'getConnection'>> &
        Pick<NonNullable<Exclude<RemoteTabClientOptions['reconnect'], false>>, 'getConnection'>)
    | undefined {
    if (this.#options.reconnect === false || this.#options.reconnect === undefined) return undefined
    return {
      getConnection: this.#options.reconnect.getConnection,
      maxAttempts: this.#options.reconnect.maxAttempts ?? DEFAULT_RECONNECT_ATTEMPTS,
      minimumDelayMs:
        this.#options.reconnect.minimumDelayMs ?? DEFAULT_RECONNECT_MINIMUM_DELAY_MS,
      maximumDelayMs:
        this.#options.reconnect.maximumDelayMs ?? DEFAULT_RECONNECT_MAXIMUM_DELAY_MS,
    }
  }

  #waitForReconnectDelay(delayMs: number): Promise<boolean> {
    this.#cancelReconnectDelay()
    return new Promise<boolean>((resolve) => {
      this.#resolveReconnectDelay = resolve
      this.#reconnectDelayTimer = setTimeout(() => {
        this.#reconnectDelayTimer = undefined
        this.#resolveReconnectDelay = undefined
        resolve(true)
      }, delayMs)
    })
  }

  #cancelReconnectDelay(): void {
    if (this.#reconnectDelayTimer !== undefined) {
      clearTimeout(this.#reconnectDelayTimer)
      this.#reconnectDelayTimer = undefined
    }
    this.#resolveReconnectDelay?.(false)
    this.#resolveReconnectDelay = undefined
  }

  #fail(error: RemoteTabError): void {
    if (this.#state === 'FAILED' || this.#state === 'CLOSED') {
      return
    }
    this.#clearConnectionTimer()
    this.#clearIceRestartTimer()
    this.#stopMetrics()
    this.#cancelReconnectDelay()
    this.#requestingReconnectCredentials = false
    this.#awaitingReconnectHandshake = false
    this.#rejectPendingActions(error)
    this.#rejectUpload(error)
    this.#clearDownloads(error)
    this.#clearClipboardTransfers(error)
    this.#clearUploadRequests()
    this.#clearNoticeRequests()
    this.#clearLocalOpenRequests('connection-lost')
    this.#setState('FAILED', error.code)
    this.#emit({ type: 'error', error: error.toJSON() })
    this.#rejectConnect?.(error)
    this.#resolveConnect = undefined
    this.#rejectConnect = undefined
    this.#peerConnection?.close()
    this.#socket?.close(APPLICATION_ERROR_CLOSE_CODE, error.code)
  }

  #clearConnectionTimer(): void {
    if (this.#connectionTimer !== undefined) {
      clearTimeout(this.#connectionTimer)
      this.#connectionTimer = undefined
    }
  }

  #scheduleIceRestart(peer: RTCPeerConnection): void {
    if (this.#iceRestartTimer !== undefined || this.#state === 'FAILED' || this.#state === 'CLOSED') {
      return
    }
    const delayMs = this.#iceRestartConfiguration()?.disconnectedDelayMs
    if (delayMs === undefined) {
      this.#handleFailure(
        new RemoteTabError('ICE_FAILED', 'WebRTC peer connection was disconnected', { retryable: true }),
      )
      return
    }
    this.#iceRestartTimer = setTimeout(() => {
      this.#iceRestartTimer = undefined
      if (this.#peerConnection === peer && peer.connectionState === 'disconnected') {
        this.#requestIceRestart(peer)
      }
    }, delayMs)
  }

  #requestIceRestart(peer: RTCPeerConnection): void {
    if (
      this.#peerConnection !== peer ||
      this.#state === 'FAILED' ||
      this.#state === 'CLOSED' ||
      this.#disconnecting
    ) {
      return
    }
    const configuration = this.#iceRestartConfiguration()
    if (
      configuration === undefined ||
      this.#socket?.readyState !== WebSocket.OPEN ||
      this.#iceRestartAttempt >= configuration.maxAttempts
    ) {
      this.#handleFailure(
        new RemoteTabError('ICE_FAILED', 'WebRTC peer connection could not recover', { retryable: true }),
      )
      return
    }
    if (this.#state === 'CONNECTED' || this.#state === 'SUSPENDED') {
      this.#stateBeforeRecovery = this.#state
    }
    this.#setState('RECONNECTING', 'ICE restart requested')
    this.#iceRestartAttempt += 1
    this.#diagnose({
      name: 'ice.restart-requested',
      attempt: this.#iceRestartAttempt,
      maximumAttempts: configuration.maxAttempts,
    })
    try {
      this.#sendSignal({ type: 'signal.restart-ice' })
    } catch (cause) {
      this.#handleFailure(asRemoteTabError(cause, 'ICE_FAILED', 'ICE restart request failed'))
      return
    }
    this.#clearIceRestartTimer()
    this.#iceRestartTimer = setTimeout(() => {
      this.#iceRestartTimer = undefined
      if (this.#peerConnection === peer && peer.connectionState !== 'connected') {
        this.#requestIceRestart(peer)
      }
    }, configuration.attemptTimeoutMs)
  }

  #iceRestartConfiguration(): Required<NonNullable<Exclude<RemoteTabClientOptions['iceRestart'], false>>> | undefined {
    if (this.#options.iceRestart === false) return undefined
    return {
      maxAttempts: this.#options.iceRestart?.maxAttempts ?? DEFAULT_ICE_RESTART_ATTEMPTS,
      disconnectedDelayMs:
        this.#options.iceRestart?.disconnectedDelayMs ?? DEFAULT_ICE_DISCONNECTED_DELAY_MS,
      attemptTimeoutMs:
        this.#options.iceRestart?.attemptTimeoutMs ?? DEFAULT_ICE_RESTART_TIMEOUT_MS,
    }
  }

  #clearIceRestartTimer(): void {
    if (this.#iceRestartTimer !== undefined) {
      clearTimeout(this.#iceRestartTimer)
      this.#iceRestartTimer = undefined
    }
  }
}

function normalizeUploadFile(file: RemoteTabUploadFile): NormalizedUploadFile {
  if ('data' in file) {
    const data = file.data instanceof ArrayBuffer ? new Uint8Array(file.data) : file.data
    return {
      fileId: crypto.randomUUID(),
      displayName: file.displayName,
      ...(file.mimeType === undefined || file.mimeType === '' ? {} : { mimeType: file.mimeType }),
      size: data instanceof Blob ? data.size : data.byteLength,
      data,
    }
  }

  return {
    fileId: crypto.randomUUID(),
    displayName: file.name,
    ...(file.type === '' ? {} : { mimeType: file.type }),
    size: file.size,
    data: file,
  }
}

function normalizeClipboardWriteItems(
  items: readonly RemoteTabClipboardWriteItem[],
  capabilities: readonly Capability[],
): readonly NormalizedClipboardWriteItem[] {
  const mimeTypes = new Set<string>()
  let totalBytes = 0
  return items.map((item) => {
    const capability = item.mimeType === 'text/plain' ? 'clipboardText' : 'clipboardImage'
    if (!capabilities.includes(capability)) {
      throw new RemoteTabError(
        'CAPABILITY_UNAVAILABLE',
        `${item.mimeType} clipboard access is not available`,
      )
    }
    if (mimeTypes.has(item.mimeType)) {
      throw new RemoteTabError(
        'PROTOCOL_MESSAGE_INVALID',
        'Clipboard MIME types must be unique',
      )
    }
    mimeTypes.add(item.mimeType)
    const data = normalizeClipboardData(item.data)
    const size = data instanceof Blob ? data.size : data.byteLength
    if (size > MAX_CLIPBOARD_ITEM_BYTES) {
      throw new RemoteTabError('FILE_LIMIT_EXCEEDED', 'Clipboard item exceeds the size limit')
    }
    totalBytes += size
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_CLIPBOARD_TOTAL_BYTES) {
      throw new RemoteTabError('FILE_LIMIT_EXCEEDED', 'Clipboard payload exceeds the size limit')
    }
    return {
      descriptor: {
        itemId: crypto.randomUUID(),
        mimeType: item.mimeType,
        size,
      },
      data,
    }
  })
}

function normalizeClipboardData(
  data: RemoteTabClipboardWriteItem['data'],
): Blob | Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data)
  if (data instanceof Blob) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0))
  return Uint8Array.from(data)
}

async function readUploadChunk(
  data: Blob | Uint8Array,
  start: number,
  end: number,
): Promise<Uint8Array> {
  if (data instanceof Blob) {
    return new Uint8Array(await data.slice(start, end).arrayBuffer())
  }
  return data.slice(start, end)
}

function joinByteChunks(
  chunks: readonly Uint8Array<ArrayBuffer>[],
  totalBytes: number,
): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function remoteErrorFromPayload(
  error: ProtocolPayload<'error'> | undefined,
  fallbackMessage: string,
): RemoteTabError {
  return error === undefined
    ? new RemoteTabError('FILE_TRANSFER_FAILED', fallbackMessage)
    : new RemoteTabError(error.code, error.message, {
        retryable: error.retryable,
        ...(error.details === undefined ? {} : { details: error.details }),
      })
}

function normalizeHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function asRemoteTabError(
  cause: unknown,
  code: ConstructorParameters<typeof RemoteTabError>[0],
  message: string,
): RemoteTabError {
  return cause instanceof RemoteTabError ? cause : new RemoteTabError(code, message, { cause })
}

function validateIceRestartOptions(options: RemoteTabClientOptions): void {
  if (options.iceRestart === false || options.iceRestart === undefined) return
  for (const [name, value] of Object.entries(options.iceRestart)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`iceRestart.${name} must be a positive safe integer`)
    }
  }
}

function validateReconnectOptions(options: RemoteTabClientOptions): void {
  if (options.reconnect === false || options.reconnect === undefined) return
  for (const [name, value] of Object.entries({
    maxAttempts: options.reconnect.maxAttempts,
    minimumDelayMs: options.reconnect.minimumDelayMs,
    maximumDelayMs: options.reconnect.maximumDelayMs,
  })) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new RangeError(`reconnect.${name} must be a positive safe integer`)
    }
  }
  if (
    options.reconnect.minimumDelayMs !== undefined &&
    options.reconnect.maximumDelayMs !== undefined &&
    options.reconnect.maximumDelayMs < options.reconnect.minimumDelayMs
  ) {
    throw new RangeError('reconnect.maximumDelayMs must be greater than or equal to minimumDelayMs')
  }
}
