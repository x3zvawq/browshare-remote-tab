import { REMOTE_TAB_CORE_VERSION } from './version.js'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'

import WebSocket, { WebSocketServer } from 'ws'

import {
  decodeProtocolMessage,
  decodeExtensionLoopbackMessage,
  encodeExtensionLoopbackMessage,
  MAX_LOOPBACK_MESSAGE_BYTES,
  RemoteTabError,
  type Capability,
  type ExtensionLoopbackMessage,
  type ExtensionMediaDiagnostic,
  type IceCandidate,
  type IceServer,
  type IceTransportPolicy,
  type MediaQualitySettings,
  type EncodingSettings,
  type QualityConfiguration,
  type QualityState,
  type SessionDescription,
  type Viewport,
} from '@browshare/remote-tab-protocol'

import type { ResolveTabIdRequest, TabIdentityResolver } from './cdp.js'

export interface ExtensionLoopbackServerOptions {
  host?: '127.0.0.1' | '::1'
  port: number
  extensionId: string
  runtimeGeneration: string
  runtimeSecret: string
  requestTimeoutMs?: number
  maxMessageBytes?: number
  maxConnections?: number
}

export interface ExtensionLoopbackAddress {
  host: string
  port: number
}

export type ExtensionRuntimeRole = 'service-worker' | 'media'

interface BoundExtensionPeer {
  role: ExtensionRuntimeRole
  runtimeGeneration: string
  runtimeInstanceId: string
  advertisedRuntimeInstanceId: boolean
  extensionVersion: string
}

interface ExtensionRuntimePeers {
  runtimeInstanceId: string
  advertisedRuntimeInstanceId: boolean
  serviceWorker?: WebSocket
  media?: WebSocket
}

export interface ExtensionRuntimeStatus {
  extensionId: string
  runtimeGeneration: string
  runtimeInstanceId?: string
  serviceWorkerVersion?: string
  mediaVersion?: string
  coherent: boolean
}

interface PendingTargetResolution {
  targetId: string
  awaitingRuntimeIds: Set<string>
  resolvedTabs: Map<string, number>
  timer: ReturnType<typeof setTimeout>
  resolve(tabId: number): void
  reject(reason: unknown): void
}

interface PendingCapturePreparation {
  sessionId: string
  targetId: string
  runtimeInstanceId: string
  timer: ReturnType<typeof setTimeout>
  resolve(streamId: string): void
  reject(reason: unknown): void
}

interface PendingMediaStop {
  sessionId: string
  runtimeInstanceId: string
  timer: ReturnType<typeof setTimeout>
  resolve(): void
  reject(reason: unknown): void
}

interface PendingMediaControlForward {
  runtimeInstanceId: string
  timer: ReturnType<typeof setTimeout>
  resolve(): void
  reject(reason: unknown): void
}

interface RuntimeReadyWaiter {
  roles: readonly ExtensionRuntimeRole[]
  timer: ReturnType<typeof setTimeout>
  resolve(): void
  reject(reason: unknown): void
}

export interface PrepareCaptureRequest {
  sessionId: string
  targetId: string
  tabId: number
  viewerGeneration: number
}

export interface StartExtensionMediaRequest {
  quality?: MediaQualitySettings
  sessionId: string
  viewerGeneration: number
  tabId: number
  streamId: string
  capabilities: readonly Capability[]
  iceServers: readonly IceServer[]
  iceTransportPolicy: IceTransportPolicy
  viewport: Viewport
  captureFrameRateLimit?: number
  audio: boolean
  captureRevision?: number
}

export type ReplaceExtensionCaptureRequest = Pick<StartExtensionMediaRequest,
  'sessionId' | 'viewerGeneration' | 'streamId' | 'viewport' | 'captureFrameRateLimit' | 'audio' | 'captureRevision'>

export type ExtensionMediaSignal =
  | { type: 'capture-ended'; sessionId: string; viewerGeneration: number; captureRevision: number }
  | { type: 'control-closed'; sessionId: string; viewerGeneration: number }
  | { type: 'description'; sessionId: string; description: SessionDescription }
  | { type: 'ice'; sessionId: string; candidate: IceCandidate }
  | { type: 'start-failed'; sessionId: string; error: RemoteTabError }
  | { type: 'suspension-changed'; sessionId: string; suspended: boolean }
  | { type: 'quality-configuration'; sessionId: string; requestId?: string; state: QualityState }
  | { type: 'quality-configuration-failed'; sessionId: string; requestId: string; error: RemoteTabError }
  | { type: 'quality-changed'; sessionId: string; settings: MediaQualitySettings }
  | { type: 'quality-failed'; sessionId: string; error: RemoteTabError }
  | { type: 'diagnostic'; sessionId: string; diagnostic: ExtensionMediaDiagnostic }

export type ExtensionMediaSignalListener = (signal: ExtensionMediaSignal) => void
export type ExtensionMediaControlListener = (data: Uint8Array<ArrayBuffer>) => void

export class ExtensionLoopbackServer implements TabIdentityResolver {
  readonly #options: Required<
    Pick<
      ExtensionLoopbackServerOptions,
      | 'host'
      | 'port'
      | 'extensionId'
      | 'runtimeGeneration'
      | 'runtimeSecret'
      | 'requestTimeoutMs'
      | 'maxMessageBytes'
      | 'maxConnections'
    >
  >
  readonly #peers = new Map<WebSocket, BoundExtensionPeer>()
  readonly #runtimes = new Map<string, ExtensionRuntimePeers>()
  readonly #pending = new Map<string, PendingTargetResolution>()
  readonly #pendingCaptures = new Map<string, PendingCapturePreparation>()
  readonly #pendingMediaStops = new Map<string, PendingMediaStop>()
  readonly #pendingCaptureReplacements = new Map<string, PendingMediaStop & { viewerGeneration: number }>()
  readonly #pendingMediaControlForwards = new Map<string, PendingMediaControlForward>()
  readonly #mediaSignalListeners = new Set<ExtensionMediaSignalListener>()
  readonly #mediaControlListeners = new Map<string, Set<ExtensionMediaControlListener>>()
  readonly #readyWaiters = new Set<RuntimeReadyWaiter>()
  readonly #targetRuntimes = new Map<string, string>()
  readonly #sessionRuntimes = new Map<string, string>()
  readonly #sessionTargets = new Map<string, string>()
  #server: WebSocketServer | undefined
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined

  public constructor(options: ExtensionLoopbackServerOptions) {
    if (!/^[a-p]{32}$/u.test(options.extensionId)) {
      throw new TypeError('extensionId must be a 32-character Chrome extension ID')
    }
    if (new TextEncoder().encode(options.runtimeSecret).byteLength < 32) {
      throw new TypeError('runtimeSecret must contain at least 32 bytes')
    }
    if (options.runtimeGeneration.length === 0) {
      throw new TypeError('runtimeGeneration must not be empty')
    }
    const requestTimeoutMs = options.requestTimeoutMs ?? 10_000
    const maxMessageBytes = options.maxMessageBytes ?? MAX_LOOPBACK_MESSAGE_BYTES
    const maxConnections = options.maxConnections ?? 16
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new RangeError('requestTimeoutMs must be a positive safe integer')
    }
    if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes <= 0) {
      throw new RangeError('maxMessageBytes must be a positive safe integer')
    }
    if (!Number.isSafeInteger(maxConnections) || maxConnections < 2) {
      throw new RangeError('maxConnections must be a safe integer of at least 2')
    }
    this.#options = {
      host: options.host ?? '127.0.0.1',
      port: options.port,
      extensionId: options.extensionId,
      runtimeGeneration: options.runtimeGeneration,
      runtimeSecret: options.runtimeSecret,
      requestTimeoutMs,
      maxMessageBytes,
      maxConnections,
    }
  }

  public async start(): Promise<ExtensionLoopbackAddress> {
    if (this.#server !== undefined) {
      throw new Error('Extension loopback server is already started')
    }
    const expectedOrigin = `chrome-extension://${this.#options.extensionId}`
    const verifyClient: WebSocket.VerifyClientCallbackSync = ({ req }) =>
      req.headers.origin === expectedOrigin
    const server = new WebSocketServer({
      host: this.#options.host,
      port: this.#options.port,
      maxPayload: this.#options.maxMessageBytes,
      perMessageDeflate: false,
      verifyClient,
    })
    this.#server = server
    server.on('connection', (socket) => {
      if (server.clients.size > this.#options.maxConnections) {
        socket.close(1013, 'Extension loopback capacity reached')
        return
      }
      this.#accept(socket)
    })
    await new Promise<void>((resolve, reject) => {
      const listening = (): void => {
        server.off('error', failed)
        resolve()
      }
      const failed = (error: Error): void => {
        server.off('listening', listening)
        reject(error)
      }
      server.once('listening', listening)
      server.once('error', failed)
    })
    const address = server.address() as AddressInfo
    this.#heartbeatTimer = setInterval(() => {
      const nonce = randomUUID()
      for (const socket of this.#peers.keys()) {
        this.#send(socket, { type: 'runtime.ping', nonce })
      }
    }, 20_000)
    this.#heartbeatTimer.unref?.()
    return { host: address.address, port: address.port }
  }

  public async resolveTabId(request: ResolveTabIdRequest): Promise<number> {
    const serviceWorkers = this.#readyRuntimeSockets('service-worker')
    if (serviceWorkers.length === 0) {
      throw new RemoteTabError(
        'EXTENSION_UNAVAILABLE',
        'Remote Tab extension service worker is not connected',
        { retryable: true },
      )
    }
    const requestId = randomUUID()
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId)
        reject(
          new RemoteTabError(
            'TARGET_MAPPING_FAILED',
            'Timed out resolving a Chrome target to exactly one extension runtime',
            { retryable: true },
          ),
        )
      }, this.#options.requestTimeoutMs)
      this.#pending.set(requestId, {
        targetId: request.targetId,
        awaitingRuntimeIds: new Set(serviceWorkers.map(([runtimeInstanceId]) => runtimeInstanceId)),
        resolvedTabs: new Map(),
        timer,
        resolve,
        reject,
      })
      for (const [, socket] of serviceWorkers) {
        this.#send(socket, { type: 'target.resolve', requestId, targetId: request.targetId })
      }
    })
  }

  public waitUntilReady(
    roles: readonly ExtensionRuntimeRole[] = ['service-worker', 'media'],
    timeoutMs = this.#options.requestTimeoutMs,
  ): Promise<void> {
    if (roles.length === 0 || this.#areRolesReady(roles)) {
      return Promise.resolve()
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new RangeError('timeoutMs must be a positive safe integer'))
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: RuntimeReadyWaiter = {
        roles: [...new Set(roles)],
        timer: setTimeout(() => {
          this.#readyWaiters.delete(waiter)
          reject(
            new RemoteTabError(
              'EXTENSION_UNAVAILABLE',
              'Timed out waiting for the Remote Tab extension runtime',
              { retryable: true, details: { roles: waiter.roles.join(',') } },
            ),
          )
        }, timeoutMs),
        resolve,
        reject,
      }
      this.#readyWaiters.add(waiter)
    })
  }

  public getReadyRoles(): readonly ExtensionRuntimeRole[] {
    return (['service-worker', 'media'] as const).filter((role) => this.#isRoleReady(role))
  }

  public getRuntimeStatus(): ExtensionRuntimeStatus {
    const statuses = this.getRuntimeStatuses()
    return statuses.find((status) => status.coherent) ?? statuses[0] ?? {
      extensionId: this.#options.extensionId,
      runtimeGeneration: this.#options.runtimeGeneration,
      coherent: false,
    }
  }

  public getRuntimeStatuses(): readonly ExtensionRuntimeStatus[] {
    return [...this.#runtimes.values()]
      .sort((left, right) => left.runtimeInstanceId.localeCompare(right.runtimeInstanceId))
      .map((runtime) => {
        const serviceWorkerVersion = this.#versionForSocket(runtime.serviceWorker)
        const mediaVersion = this.#versionForSocket(runtime.media)
        return {
          extensionId: this.#options.extensionId,
          runtimeGeneration: this.#options.runtimeGeneration,
          ...(runtime.advertisedRuntimeInstanceId
            ? { runtimeInstanceId: runtime.runtimeInstanceId }
            : {}),
          ...(serviceWorkerVersion === undefined ? {} : { serviceWorkerVersion }),
          ...(mediaVersion === undefined ? {} : { mediaVersion }),
          coherent:
            serviceWorkerVersion !== undefined &&
            mediaVersion !== undefined &&
            serviceWorkerVersion === mediaVersion,
        }
      })
  }

  public async prepareCapture(request: PrepareCaptureRequest): Promise<string> {
    const runtimeInstanceId = this.#requireTargetRuntime(request.targetId)
    const socket = this.#requireRuntimeSocket(runtimeInstanceId, 'service-worker')
    const existingRuntime = this.#sessionRuntimes.get(request.sessionId)
    if (existingRuntime !== undefined && existingRuntime !== runtimeInstanceId) {
      throw new RemoteTabError(
        'TARGET_MAPPING_FAILED',
        'Remote Tab Session is already bound to another Chrome runtime',
      )
    }
    const requestId = randomUUID()
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingCaptures.delete(requestId)
        reject(
          new RemoteTabError('CAPTURE_DENIED', 'Timed out preparing tab capture', {
            retryable: true,
          }),
        )
      }, this.#options.requestTimeoutMs)
      this.#pendingCaptures.set(requestId, {
        sessionId: request.sessionId,
        targetId: request.targetId,
        runtimeInstanceId,
        timer,
        resolve: (streamId) => {
          this.#sessionRuntimes.set(request.sessionId, runtimeInstanceId)
          this.#sessionTargets.set(request.sessionId, request.targetId)
          resolve(streamId)
        },
        reject,
      })
      this.#send(socket, { type: 'capture.prepare', requestId, ...request })
    })
  }

  public bindSession(sessionId: string, targetId: string): void {
    const runtimeInstanceId = this.#requireTargetRuntime(targetId)
    const existingRuntimeId = this.#sessionRuntimes.get(sessionId)
    if (existingRuntimeId !== undefined && existingRuntimeId !== runtimeInstanceId) {
      throw new RemoteTabError(
        'TARGET_MAPPING_FAILED',
        'Remote Tab Session is already bound to another Chrome runtime',
      )
    }
    this.#sessionRuntimes.set(sessionId, runtimeInstanceId)
    this.#sessionTargets.set(sessionId, targetId)
  }

  public startMedia(request: StartExtensionMediaRequest): void {
    const socket = this.#requireMediaSocket(request.sessionId)
    // Older Extensions reject the new Viewer response in their strict channel allowlist.
    if ((request.captureFrameRateLimit !== undefined || request.capabilities.some((capability) =>
        ['noticeRequests', 'navigationState', 'windowSelection', 'advancedQuality'].includes(capability))) &&
        this.#versionForSocket(socket) !== REMOTE_TAB_CORE_VERSION) {
      throw new RemoteTabError('CAPABILITY_UNAVAILABLE',
        `Negotiated capabilities and capture source limits require the coordinated Extension ${REMOTE_TAB_CORE_VERSION}`)
    }
    this.#send(socket, {
      type: 'media.start',
      ...request,
      capabilities: [...request.capabilities],
      iceServers: request.iceServers.map((server) => ({
        urls: [...server.urls],
        ...(server.username === undefined ? {} : { username: server.username }),
        ...(server.credential === undefined ? {} : { credential: server.credential }),
      })),
    })
  }

  /** The caller must gate target-dependent input until this acknowledgement completes. */
  public replaceMediaCapture(request: ReplaceExtensionCaptureRequest): Promise<void> {
    const runtimeInstanceId = this.#requireSessionRuntime(request.sessionId)
    const socket = this.#requireRuntimeSocket(runtimeInstanceId, 'media')
    if (this.#versionForSocket(socket) !== REMOTE_TAB_CORE_VERSION) {
      throw new RemoteTabError('CAPABILITY_UNAVAILABLE', `Capture replacement requires the coordinated Extension ${REMOTE_TAB_CORE_VERSION}`)
    }
    const requestId = randomUUID()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingCaptureReplacements.delete(requestId)
        // A lost acknowledgement makes the selected source uncertain. Stop before further use.
        void this.stopMedia(request.sessionId, 'Capture replacement acknowledgement timed out').catch(() => undefined)
        reject(new RemoteTabError('CAPTURE_DENIED', 'Timed out replacing tab capture'))
      }, this.#options.requestTimeoutMs)
      this.#pendingCaptureReplacements.set(requestId, { sessionId: request.sessionId,
        viewerGeneration: request.viewerGeneration, runtimeInstanceId, timer, resolve, reject })
      this.#send(socket, { type: 'media.replace_capture', requestId, ...request })
    })
  }

  public stopMedia(sessionId: string, reason: string): Promise<void> {
    const runtimeInstanceId = this.#requireSessionRuntime(sessionId)
    const socket = this.#requireRuntimeSocket(runtimeInstanceId, 'media')
    const requestId = randomUUID()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingMediaStops.delete(requestId)
        reject(
          new RemoteTabError('EXTENSION_UNAVAILABLE', 'Timed out stopping Extension media', {
            retryable: true,
          }),
        )
      }, this.#options.requestTimeoutMs)
      this.#pendingMediaStops.set(requestId, {
        sessionId,
        runtimeInstanceId,
        timer,
        resolve,
        reject,
      })
      this.#send(socket, { type: 'media.stop', requestId, sessionId, reason })
    })
  }

  public setMediaSuspended(sessionId: string, suspended: boolean): void {
    this.#send(this.#requireMediaSocket(sessionId), {
      type: suspended ? 'media.suspend' : 'media.resume',
      sessionId,
    })
  }

  public restartMediaIce(sessionId: string): void {
    this.#send(this.#requireMediaSocket(sessionId), { type: 'media.restart_ice', sessionId })
  }

  public configureMediaQuality(sessionId: string, requestId: string, configuration: QualityConfiguration, limits: EncodingSettings): void {
    this.#send(this.#requireMediaSocket(sessionId), { type: 'media.configure_quality', sessionId, requestId, configuration, limits })
  }

  public setMediaQuality(sessionId: string, settings: MediaQualitySettings): void {
    this.#send(this.#requireMediaSocket(sessionId), { type: 'media.set_quality', sessionId, settings })
  }

  public sendMediaSignal(
    signal: Extract<ExtensionMediaSignal, { type: 'description' | 'ice' }>,
  ): void {
    const socket = this.#requireMediaSocket(signal.sessionId)
    if (signal.type === 'description') {
      this.#send(socket, {
        type: 'media.signal_description',
        sessionId: signal.sessionId,
        description: signal.description,
      })
    } else {
      this.#send(socket, {
        type: 'media.signal_ice',
        sessionId: signal.sessionId,
        candidate: signal.candidate,
      })
    }
  }

  public sendMediaPeerState(sessionId: string, connected: boolean): void {
    this.#send(this.#requireMediaSocket(sessionId), {
      type: connected ? 'media.peer_ready' : 'media.peer_left',
      sessionId,
    })
  }

  public sendMediaControl(data: Uint8Array): void {
    const message = decodeProtocolMessage(data)
    if (message === undefined) return
    const socket = this.#requireMediaSocket(message.sessionId)
    socket.send(new Uint8Array(data))
  }

  public sendMediaControlAndWait(
    data: Uint8Array,
    sessionId: string,
    sequence: number,
  ): Promise<void> {
    const runtimeInstanceId = this.#requireSessionRuntime(sessionId)
    const socket = this.#requireRuntimeSocket(runtimeInstanceId, 'media')
    const key = mediaControlForwardKey(sessionId, sequence)
    if (this.#pendingMediaControlForwards.has(key)) {
      return Promise.reject(
        new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Media control sequence is already pending'),
      )
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingMediaControlForwards.delete(key)
        reject(
          new RemoteTabError('EXTENSION_UNAVAILABLE', 'Timed out forwarding file data to Viewer', {
            retryable: true,
          }),
        )
      }, this.#options.requestTimeoutMs)
      this.#pendingMediaControlForwards.set(key, {
        runtimeInstanceId,
        timer,
        resolve,
        reject,
      })
      socket.send(new Uint8Array(data), (error) => {
        if (error == null) return
        const pending = this.#pendingMediaControlForwards.get(key)
        if (pending === undefined) return
        this.#pendingMediaControlForwards.delete(key)
        clearTimeout(pending.timer)
        pending.reject(
          new RemoteTabError('EXTENSION_UNAVAILABLE', 'Could not forward file data to Extension', {
            cause: error,
            retryable: true,
          }),
        )
      })
    })
  }

  public onMediaSignal(listener: ExtensionMediaSignalListener): () => void {
    this.#mediaSignalListeners.add(listener)
    return () => this.#mediaSignalListeners.delete(listener)
  }

  public onMediaControl(sessionId: string, listener: ExtensionMediaControlListener): () => void {
    let listeners = this.#mediaControlListeners.get(sessionId)
    if (listeners === undefined) {
      listeners = new Set()
      this.#mediaControlListeners.set(sessionId, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) {
        this.#mediaControlListeners.delete(sessionId)
      }
    }
  }

  public releaseSession(sessionId: string): void {
    this.#sessionRuntimes.delete(sessionId)
    const targetId = this.#sessionTargets.get(sessionId)
    this.#sessionTargets.delete(sessionId)
    if (targetId !== undefined) {
      this.#targetRuntimes.delete(targetId)
    }
  }

  public releaseTarget(targetId: string): void {
    this.#targetRuntimes.delete(targetId)
    for (const [sessionId, sessionTargetId] of this.#sessionTargets) {
      if (sessionTargetId === targetId) {
        this.#sessionTargets.delete(sessionId)
        this.#sessionRuntimes.delete(sessionId)
      }
    }
  }

  public async close(): Promise<void> {
    const server = this.#server
    if (server === undefined) {
      return
    }
    this.#server = undefined
    if (this.#heartbeatTimer !== undefined) {
      clearInterval(this.#heartbeatTimer)
      this.#heartbeatTimer = undefined
    }
    this.#rejectPending(
      new RemoteTabError('EXTENSION_UNAVAILABLE', 'Extension loopback server closed', {
        retryable: true,
      }),
    )
    this.#rejectPendingCaptures(
      new RemoteTabError('EXTENSION_UNAVAILABLE', 'Extension loopback server closed', {
        retryable: true,
      }),
    )
    this.#rejectPendingMediaStops(
      new RemoteTabError('EXTENSION_UNAVAILABLE', 'Extension loopback server closed', {
        retryable: true,
      }),
    )
    this.#rejectPendingMediaControlForwards(
      new RemoteTabError('EXTENSION_UNAVAILABLE', 'Extension loopback server closed', {
        retryable: true,
      }),
    )
    this.#rejectReadyWaiters(
      new RemoteTabError('EXTENSION_UNAVAILABLE', 'Extension loopback server closed', {
        retryable: true,
      }),
    )
    this.#peers.clear()
    this.#runtimes.clear()
    this.#targetRuntimes.clear()
    this.#sessionRuntimes.clear()
    this.#sessionTargets.clear()
    for (const client of server.clients) {
      client.close(1001, 'Loopback shutting down')
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)))
    })
  }

  #accept(socket: WebSocket): void {
    const bindTimer = setTimeout(() => socket.close(1008, 'runtime.bind required'), this.#options.requestTimeoutMs)
    socket.on('message', (data, isBinary) => {
      try {
        if (isBinary) {
          const peer = this.#peers.get(socket)
          if (peer?.role !== 'media') {
            throw new RemoteTabError(
              'PROTOCOL_MESSAGE_INVALID',
              'Only the authenticated media runtime may send binary control messages',
            )
          }
          const bytes = copyBinary(data)
          const message = decodeProtocolMessage(bytes)
          if (message === undefined) return
          if (!this.#isSessionOwnedByRuntime(message.sessionId, peer.runtimeInstanceId)) {
            throw new RemoteTabError(
              'PROTOCOL_MESSAGE_INVALID',
              'Binary control message belongs to another Chrome runtime',
            )
          }
          for (const listener of this.#mediaControlListeners.get(message.sessionId) ?? []) {
            listener(bytes)
          }
          return
        }
        const message = decodeExtensionLoopbackMessage(
          data.toString(),
          this.#options.maxMessageBytes,
        )
        if (!this.#peers.has(socket)) {
          this.#bind(socket, message)
          clearTimeout(bindTimer)
        } else {
          this.#handleBoundMessage(socket, message)
        }
      } catch (cause) {
        const code = cause instanceof RemoteTabError ? cause.code : 'PROTOCOL_MESSAGE_INVALID'
        socket.close(1008, code)
      }
    })
    socket.on('close', () => {
      clearTimeout(bindTimer)
      this.#removePeer(socket)
    })
    socket.on('error', () => {
      clearTimeout(bindTimer)
      this.#removePeer(socket)
    })
  }

  #bind(socket: WebSocket, message: ExtensionLoopbackMessage): void {
    if (message.type !== 'runtime.bind') {
      throw new RemoteTabError('EXTENSION_AUTH_FAILED', 'Extension runtime must authenticate first')
    }
    if (
      message.extensionId !== this.#options.extensionId ||
      message.runtimeGeneration !== this.#options.runtimeGeneration ||
      !secretsEqual(message.secret, this.#options.runtimeSecret)
    ) {
      throw new RemoteTabError('EXTENSION_AUTH_FAILED', 'Extension runtime identity is invalid')
    }

    const runtimeInstanceId = message.runtimeInstanceId ?? message.runtimeGeneration
    let runtime = this.#runtimes.get(runtimeInstanceId)
    if (runtime === undefined) {
      runtime = {
        runtimeInstanceId,
        advertisedRuntimeInstanceId: message.runtimeInstanceId !== undefined,
      }
      this.#runtimes.set(runtimeInstanceId, runtime)
    } else if (runtime.advertisedRuntimeInstanceId !== (message.runtimeInstanceId !== undefined)) {
      throw new RemoteTabError(
        'EXTENSION_AUTH_FAILED',
        'Extension runtime identity mode changed between roles',
      )
    }

    const previous = message.role === 'service-worker' ? runtime.serviceWorker : runtime.media
    if (previous !== undefined && previous !== socket) {
      previous.close(1012, 'Runtime peer replaced')
      this.#peers.delete(previous)
    }
    if (message.role === 'service-worker') {
      runtime.serviceWorker = socket
    } else {
      runtime.media = socket
    }
    this.#peers.set(socket, {
      role: message.role,
      runtimeGeneration: message.runtimeGeneration,
      runtimeInstanceId,
      advertisedRuntimeInstanceId: message.runtimeInstanceId !== undefined,
      extensionVersion: message.extensionVersion,
    })
    this.#send(socket, {
      type: 'runtime.ready',
      role: message.role,
      extensionVersion: message.extensionVersion,
      runtimeGeneration: message.runtimeGeneration,
      ...(message.runtimeInstanceId === undefined
        ? {}
        : { runtimeInstanceId: message.runtimeInstanceId }),
    })
    this.#resolveReadyWaiters()
  }

  #handleBoundMessage(socket: WebSocket, message: ExtensionLoopbackMessage): void {
    if (message.type === 'runtime.pong') {
      return
    }
    if (message.type === 'runtime.ping') {
      this.#send(socket, { type: 'runtime.pong', nonce: message.nonce })
      return
    }
    const peer = this.#peers.get(socket)
    if (peer === undefined) {
      throw new RemoteTabError('EXTENSION_AUTH_FAILED', 'Extension runtime is not authenticated')
    }
    if (peer.role !== 'service-worker') {
      this.#handleMediaMessage(peer, message)
      return
    }
    if (message.type === 'capture.prepared' || message.type === 'capture.prepare_failed') {
      this.#handleCapturePreparation(peer, message)
      return
    }
    if (message.type !== 'target.resolved' && message.type !== 'target.resolve_failed') {
      throw new RemoteTabError(
        'PROTOCOL_MESSAGE_INVALID',
        'Extension service worker sent an unexpected loopback message',
      )
    }
    const pending = this.#pending.get(message.requestId)
    if (pending === undefined) {
      return
    }
    if (message.targetId !== pending.targetId) {
      this.#pending.delete(message.requestId)
      clearTimeout(pending.timer)
      pending.reject(
        new RemoteTabError(
          'TARGET_MAPPING_FAILED',
          'Extension target mapping response did not match its request',
        ),
      )
      return
    }
    if (!pending.awaitingRuntimeIds.delete(peer.runtimeInstanceId)) {
      return
    }
    if (message.type === 'target.resolved') {
      pending.resolvedTabs.set(peer.runtimeInstanceId, message.tabId)
      if (pending.resolvedTabs.size > 1) {
        this.#pending.delete(message.requestId)
        clearTimeout(pending.timer)
        pending.reject(
          new RemoteTabError(
            'TARGET_MAPPING_FAILED',
            'Chrome target resolved in more than one extension runtime',
          ),
        )
        return
      }
    }
    if (pending.awaitingRuntimeIds.size !== 0) return
    this.#pending.delete(message.requestId)
    clearTimeout(pending.timer)
    const resolution = [...pending.resolvedTabs.entries()][0]
    if (resolution === undefined) {
      pending.reject(
        new RemoteTabError(
          'TARGET_MAPPING_FAILED',
          'Chrome target did not resolve in any extension runtime',
          { retryable: message.type === 'target.resolve_failed' && message.error.retryable },
        ),
      )
      return
    }
    const [runtimeInstanceId, tabId] = resolution
    this.#targetRuntimes.set(pending.targetId, runtimeInstanceId)
    pending.resolve(tabId)
  }

  #handleCapturePreparation(
    peer: BoundExtensionPeer,
    message: Extract<
      ExtensionLoopbackMessage,
      { type: 'capture.prepared' | 'capture.prepare_failed' }
    >,
  ): void {
    const pending = this.#pendingCaptures.get(message.requestId)
    if (pending === undefined) {
      return
    }
    if (pending.runtimeInstanceId !== peer.runtimeInstanceId) {
      throw new RemoteTabError(
        'PROTOCOL_MESSAGE_INVALID',
        'Capture response came from another Chrome runtime',
      )
    }
    this.#pendingCaptures.delete(message.requestId)
    clearTimeout(pending.timer)
    if (message.sessionId !== pending.sessionId) {
      pending.reject(
        new RemoteTabError('CAPTURE_DENIED', 'Capture response did not match its Session'),
      )
    } else if (message.type === 'capture.prepare_failed') {
      pending.reject(
        new RemoteTabError(message.error.code, message.error.message, {
          retryable: message.error.retryable,
        }),
      )
    } else {
      pending.resolve(message.streamId)
    }
  }

  #handleMediaMessage(peer: BoundExtensionPeer, message: ExtensionLoopbackMessage): void {
    const sessionId = 'sessionId' in message ? message.sessionId : undefined
    if (
      sessionId !== undefined &&
      !this.#isSessionOwnedByRuntime(sessionId, peer.runtimeInstanceId)
    ) {
      throw new RemoteTabError(
        'PROTOCOL_MESSAGE_INVALID',
        'Extension media message belongs to another Chrome runtime',
      )
    }
    if (message.type === 'media.control_forwarded') {
      const key = mediaControlForwardKey(message.sessionId, message.sequence)
      const pending = this.#pendingMediaControlForwards.get(key)
      if (pending === undefined) return
      if (pending.runtimeInstanceId !== peer.runtimeInstanceId) {
        throw new RemoteTabError(
          'PROTOCOL_MESSAGE_INVALID',
          'Media forwarding acknowledgement came from another Chrome runtime',
        )
      }
      this.#pendingMediaControlForwards.delete(key)
      clearTimeout(pending.timer)
      pending.resolve()
      return
    }
    if (message.type === 'media.capture_ended') {
      if (!this.#isSessionOwnedByRuntime(message.sessionId, peer.runtimeInstanceId)) {
        throw new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Capture ended came from another Chrome runtime')
      }
      for (const listener of this.#mediaSignalListeners) listener({ type: 'capture-ended', sessionId: message.sessionId,
        viewerGeneration: message.viewerGeneration, captureRevision: message.captureRevision })
      return
    }
    if (message.type === 'media.capture_replaced' || message.type === 'media.capture_replace_failed') {
      const pending = this.#pendingCaptureReplacements.get(message.requestId)
      if (pending === undefined) return
      if (pending.runtimeInstanceId !== peer.runtimeInstanceId) {
        throw new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Capture replacement response came from another Chrome runtime')
      }
      this.#pendingCaptureReplacements.delete(message.requestId)
      clearTimeout(pending.timer)
      if (message.sessionId !== pending.sessionId || message.viewerGeneration !== pending.viewerGeneration) {
        pending.reject(new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Capture replacement response changed Session or Viewer generation'))
      } else if (message.type === 'media.capture_replace_failed') {
        pending.reject(new RemoteTabError(message.error.code, message.error.message, { retryable: message.error.retryable }))
      } else pending.resolve()
      return
    }
    if (message.type === 'media.stopped') {
      const pending = this.#pendingMediaStops.get(message.requestId)
      if (pending === undefined) return
      if (pending.runtimeInstanceId !== peer.runtimeInstanceId) {
        throw new RemoteTabError(
          'PROTOCOL_MESSAGE_INVALID',
          'Media stop acknowledgement came from another Chrome runtime',
        )
      }
      this.#pendingMediaStops.delete(message.requestId)
      clearTimeout(pending.timer)
      if (message.sessionId !== pending.sessionId) {
        pending.reject(
          new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Media stop response changed Session'),
        )
      } else {
        pending.resolve()
      }
      return
    }
    let signal: ExtensionMediaSignal
    if (message.type === 'media.signal_description') {
      signal = {
        type: 'description',
        sessionId: message.sessionId,
        description: message.description,
      }
    } else if (message.type === 'media.signal_ice') {
      signal = {
        type: 'ice',
        sessionId: message.sessionId,
        candidate: message.candidate,
      }
    } else if (message.type === 'media.start_failed') {
      signal = {
        type: 'start-failed',
        sessionId: message.sessionId,
        error: new RemoteTabError(message.error.code, message.error.message, {
          retryable: message.error.retryable,
          ...(message.error.details === undefined ? {} : { details: message.error.details }),
        }),
      }
    } else if (message.type === 'media.suspension_changed') {
      signal = {
        type: 'suspension-changed',
        sessionId: message.sessionId,
        suspended: message.suspended,
      }
    } else if (message.type === 'media.quality_configuration') {
      signal = { type: 'quality-configuration', sessionId: message.sessionId, state: message.state,
        ...(message.requestId === undefined ? {} : { requestId: message.requestId }) }
    } else if (message.type === 'media.quality_configuration_failed') {
      signal = { type: 'quality-configuration-failed', sessionId: message.sessionId, requestId: message.requestId,
        error: new RemoteTabError(message.error.code, message.error.message, { retryable: message.error.retryable,
          ...(message.error.details === undefined ? {} : { details: message.error.details }) }) }
    } else if (message.type === 'media.quality_changed') {
      signal = {
        type: 'quality-changed',
        sessionId: message.sessionId,
        settings: message.settings,
      }
    } else if (message.type === 'media.quality_failed') {
      signal = {
        type: 'quality-failed',
        sessionId: message.sessionId,
        error: new RemoteTabError(message.error.code, message.error.message, {
          retryable: message.error.retryable,
          ...(message.error.details === undefined ? {} : { details: message.error.details }),
        }),
      }
    } else if (message.type === 'media.control_closed') {
      signal = { type: 'control-closed', sessionId: message.sessionId, viewerGeneration: message.viewerGeneration }
    } else if (message.type === 'media.diagnostic') {
      signal = {
        type: 'diagnostic',
        sessionId: message.sessionId,
        diagnostic: message.diagnostic,
      }
    } else {
      throw new RemoteTabError(
        'PROTOCOL_MESSAGE_INVALID',
        'Extension media runtime sent an unexpected loopback message',
      )
    }
    for (const listener of this.#mediaSignalListeners) {
      listener(signal)
    }
  }

  #removePeer(socket: WebSocket): void {
    const peer = this.#peers.get(socket)
    if (peer === undefined) {
      return
    }
    this.#peers.delete(socket)
    const runtime = this.#runtimes.get(peer.runtimeInstanceId)
    if (runtime === undefined) return
    if (peer.role === 'service-worker' && runtime.serviceWorker === socket) {
      delete runtime.serviceWorker
      this.#removeRuntimeFromTargetResolutions(peer.runtimeInstanceId)
      this.#rejectPendingCapturesForRuntime(
        peer.runtimeInstanceId,
        new RemoteTabError('EXTENSION_UNAVAILABLE', 'Extension service worker disconnected', {
          retryable: true,
        }),
      )
      this.#clearTargetsForRuntime(peer.runtimeInstanceId)
    } else if (peer.role === 'media' && runtime.media === socket) {
      delete runtime.media
      this.#rejectPendingMediaStopsForRuntime(
        peer.runtimeInstanceId,
        new RemoteTabError('EXTENSION_UNAVAILABLE', 'Extension media runtime disconnected', {
          retryable: true,
        }),
      )
      this.#rejectPendingMediaControlForwardsForRuntime(
        peer.runtimeInstanceId,
        new RemoteTabError('EXTENSION_UNAVAILABLE', 'Extension media runtime disconnected', {
          retryable: true,
        }),
      )
    }
    if (runtime.serviceWorker === undefined && runtime.media === undefined) {
      this.#runtimes.delete(peer.runtimeInstanceId)
    }
  }

  #rejectPending(error: RemoteTabError): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }

  #rejectPendingCaptures(error: RemoteTabError): void {
    for (const pending of this.#pendingCaptures.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pendingCaptures.clear()
  }

  #rejectPendingMediaStops(error: RemoteTabError): void {
    for (const requests of [this.#pendingMediaStops, this.#pendingCaptureReplacements]) {
      for (const pending of requests.values()) {
        clearTimeout(pending.timer)
        pending.reject(error)
      }
      requests.clear()
    }
  }

  #rejectPendingMediaControlForwards(error: RemoteTabError): void {
    for (const pending of this.#pendingMediaControlForwards.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pendingMediaControlForwards.clear()
  }

  #removeRuntimeFromTargetResolutions(runtimeInstanceId: string): void {
    for (const [requestId, pending] of this.#pending) {
      if (!pending.awaitingRuntimeIds.delete(runtimeInstanceId)) continue
      pending.resolvedTabs.delete(runtimeInstanceId)
      if (pending.awaitingRuntimeIds.size !== 0) continue
      this.#pending.delete(requestId)
      clearTimeout(pending.timer)
      const resolution = [...pending.resolvedTabs.entries()][0]
      if (resolution === undefined) {
        pending.reject(
          new RemoteTabError(
            'TARGET_MAPPING_FAILED',
            'Chrome target did not resolve in any connected extension runtime',
            { retryable: true },
          ),
        )
      } else {
        const [resolvedRuntimeId, tabId] = resolution
        this.#targetRuntimes.set(pending.targetId, resolvedRuntimeId)
        pending.resolve(tabId)
      }
    }
  }

  #rejectPendingCapturesForRuntime(runtimeInstanceId: string, error: RemoteTabError): void {
    for (const [requestId, pending] of this.#pendingCaptures) {
      if (pending.runtimeInstanceId !== runtimeInstanceId) continue
      this.#pendingCaptures.delete(requestId)
      clearTimeout(pending.timer)
      pending.reject(error)
    }
  }

  #rejectPendingMediaStopsForRuntime(runtimeInstanceId: string, error: RemoteTabError): void {
    for (const requests of [this.#pendingMediaStops, this.#pendingCaptureReplacements]) {
      for (const [requestId, pending] of requests) {
        if (pending.runtimeInstanceId !== runtimeInstanceId) continue
        requests.delete(requestId)
        clearTimeout(pending.timer)
        pending.reject(error)
      }
    }
  }

  #rejectPendingMediaControlForwardsForRuntime(
    runtimeInstanceId: string,
    error: RemoteTabError,
  ): void {
    for (const [key, pending] of this.#pendingMediaControlForwards) {
      if (pending.runtimeInstanceId !== runtimeInstanceId) continue
      this.#pendingMediaControlForwards.delete(key)
      clearTimeout(pending.timer)
      pending.reject(error)
    }
  }

  #clearTargetsForRuntime(runtimeInstanceId: string): void {
    for (const [targetId, assignedRuntimeId] of this.#targetRuntimes) {
      if (assignedRuntimeId === runtimeInstanceId) this.#targetRuntimes.delete(targetId)
    }
  }

  #requireTargetRuntime(targetId: string): string {
    let runtimeInstanceId = this.#targetRuntimes.get(targetId)
    if (runtimeInstanceId === undefined) {
      const ready = this.#readyRuntimeSockets('service-worker')
      if (ready.length === 1) {
        runtimeInstanceId = ready[0]?.[0]
        if (runtimeInstanceId !== undefined) this.#targetRuntimes.set(targetId, runtimeInstanceId)
      }
    }
    if (runtimeInstanceId === undefined) {
      throw new RemoteTabError(
        'TARGET_MAPPING_FAILED',
        'Chrome target has not been resolved to an extension runtime',
      )
    }
    return runtimeInstanceId
  }

  #requireSessionRuntime(sessionId: string): string {
    let runtimeInstanceId = this.#sessionRuntimes.get(sessionId)
    if (runtimeInstanceId === undefined) {
      const ready = this.#readyRuntimeSockets('media')
      if (ready.length === 1) {
        runtimeInstanceId = ready[0]?.[0]
        if (runtimeInstanceId !== undefined) this.#sessionRuntimes.set(sessionId, runtimeInstanceId)
      }
    }
    if (runtimeInstanceId === undefined) {
      throw new RemoteTabError(
        'EXTENSION_UNAVAILABLE',
        'Remote Tab Session is not bound to a Chrome extension runtime',
        { retryable: true },
      )
    }
    return runtimeInstanceId
  }

  #isSessionOwnedByRuntime(sessionId: string, runtimeInstanceId: string): boolean {
    const assignedRuntimeId = this.#sessionRuntimes.get(sessionId)
    if (assignedRuntimeId !== undefined) return assignedRuntimeId === runtimeInstanceId
    const ready = this.#readyRuntimeSockets('media')
    if (ready.length !== 1 || ready[0]?.[0] !== runtimeInstanceId) return false
    this.#sessionRuntimes.set(sessionId, runtimeInstanceId)
    return true
  }

  #requireMediaSocket(sessionId: string): WebSocket {
    return this.#requireRuntimeSocket(this.#requireSessionRuntime(sessionId), 'media')
  }

  #requireRuntimeSocket(runtimeInstanceId: string, role: ExtensionRuntimeRole): WebSocket {
    const runtime = this.#runtimes.get(runtimeInstanceId)
    const socket = role === 'service-worker' ? runtime?.serviceWorker : runtime?.media
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      throw new RemoteTabError(
        'EXTENSION_UNAVAILABLE',
        `Remote Tab extension ${role} runtime is not connected`,
        { retryable: true },
      )
    }
    return socket
  }

  #isRoleReady(role: ExtensionRuntimeRole): boolean {
    return this.#readyRuntimeSockets(role).length > 0
  }

  #versionForSocket(socket: WebSocket | undefined): string | undefined {
    if (socket?.readyState !== WebSocket.OPEN) {
      return undefined
    }
    return this.#peers.get(socket)?.extensionVersion
  }

  #readyRuntimeSockets(role: ExtensionRuntimeRole): Array<[string, WebSocket]> {
    const sockets: Array<[string, WebSocket]> = []
    for (const [runtimeInstanceId, runtime] of this.#runtimes) {
      const socket = role === 'service-worker' ? runtime.serviceWorker : runtime.media
      if (socket?.readyState === WebSocket.OPEN) sockets.push([runtimeInstanceId, socket])
    }
    return sockets
  }

  #areRolesReady(roles: readonly ExtensionRuntimeRole[]): boolean {
    if (roles.includes('service-worker') && roles.includes('media')) {
      return this.getRuntimeStatuses().some((status) => status.coherent)
    }
    return roles.every((role) => this.#isRoleReady(role))
  }

  #resolveReadyWaiters(): void {
    for (const waiter of this.#readyWaiters) {
      if (this.#areRolesReady(waiter.roles)) {
        clearTimeout(waiter.timer)
        this.#readyWaiters.delete(waiter)
        waiter.resolve()
      }
    }
  }

  #rejectReadyWaiters(error: RemoteTabError): void {
    for (const waiter of this.#readyWaiters) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.#readyWaiters.clear()
  }

  #send(socket: WebSocket, message: ExtensionLoopbackMessage): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(encodeExtensionLoopbackMessage(message, this.#options.maxMessageBytes))
    }
  }
}

function secretsEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

function copyBinary(data: Buffer | ArrayBuffer | Buffer[]): Uint8Array<ArrayBuffer> {
  if (Array.isArray(data)) {
    return Uint8Array.from(Buffer.concat(data))
  }
  return Uint8Array.from(new Uint8Array(data))
}

function mediaControlForwardKey(sessionId: string, sequence: number): string {
  return `${sessionId}:${sequence}`
}
