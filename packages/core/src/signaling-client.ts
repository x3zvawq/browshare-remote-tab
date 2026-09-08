import WebSocket from 'ws'

import {
  decodeSignalingMessage,
  encodeSignalingMessage,
  MAX_SIGNALING_MESSAGE_BYTES,
  normalizeCapabilities,
  RemoteTabError,
  type Capability,
  type IceCandidate,
  type IceServer,
  type IceTransportPolicy,
  type RemoteTabErrorShape,
  type SessionDescription,
  type SignalingMessage,
} from '@browshare/remote-tab-protocol'

export interface CoreSignalingClientOptions {
  endpoint: string
  gatewayId: string
  bindingToken: string
  sessionId: string
  viewerGeneration: number
  connectionTimeoutMs?: number
  maxMessageBytes?: number
}

export type CoreSignalingEvent =
  | { type: 'ready'; capabilities: readonly Capability[]; iceServers: readonly IceServer[]; iceTransportPolicy: IceTransportPolicy }
  | { type: 'peer-ready' }
  | { type: 'description'; description: SessionDescription }
  | { type: 'ice'; candidate: IceCandidate }
  | { type: 'ice-restart-request' }
  | { type: 'peer-left' }
  | { type: 'error'; error: RemoteTabErrorShape }

export type CoreSignalingEventListener = (event: CoreSignalingEvent) => void

export interface CoreSignalingReady {
  capabilities: readonly Capability[]
  iceServers: readonly IceServer[]
  iceTransportPolicy: IceTransportPolicy
}

export class CoreSignalingClient {
  readonly #options: Required<Pick<CoreSignalingClientOptions, 'connectionTimeoutMs' | 'maxMessageBytes'>> &
    Omit<CoreSignalingClientOptions, 'connectionTimeoutMs' | 'maxMessageBytes'>
  readonly #listeners = new Set<CoreSignalingEventListener>()
  #socket: WebSocket | undefined
  #connectPromise: Promise<CoreSignalingReady> | undefined
  #resolveConnect: ((ready: CoreSignalingReady) => void) | undefined
  #rejectConnect: ((reason: unknown) => void) | undefined
  #timer: ReturnType<typeof setTimeout> | undefined
  #ready = false
  #peerReady = false
  #readyAssignment: CoreSignalingReady | undefined
  #closed = false

  public constructor(options: CoreSignalingClientOptions) {
    const connectionTimeoutMs = options.connectionTimeoutMs ?? 15_000
    const maxMessageBytes = options.maxMessageBytes ?? MAX_SIGNALING_MESSAGE_BYTES
    if (!Number.isSafeInteger(connectionTimeoutMs) || connectionTimeoutMs <= 0) {
      throw new RangeError('connectionTimeoutMs must be a positive safe integer')
    }
    if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes <= 0) {
      throw new RangeError('maxMessageBytes must be a positive safe integer')
    }
    if (!Number.isSafeInteger(options.viewerGeneration) || options.viewerGeneration < 0) {
      throw new RangeError('viewerGeneration must be a non-negative safe integer')
    }
    this.#options = { ...options, connectionTimeoutMs, maxMessageBytes }
  }

  public connect(): Promise<CoreSignalingReady> {
    if (this.#closed) {
      return Promise.reject(new RemoteTabError('SESSION_CLOSED', 'Core signaling client is closed'))
    }
    if (this.#connectPromise !== undefined) {
      return this.#connectPromise
    }

    this.#connectPromise = new Promise<CoreSignalingReady>((resolve, reject) => {
      this.#resolveConnect = resolve
      this.#rejectConnect = reject
    })
    this.#timer = setTimeout(() => {
      this.#fail(
        new RemoteTabError('SIGNALING_PAIR_TIMEOUT', 'Timed out waiting for the assigned Viewer', {
          retryable: true,
        }),
      )
    }, this.#options.connectionTimeoutMs)

    const socket = new WebSocket(this.#options.endpoint, {
      maxPayload: this.#options.maxMessageBytes,
      perMessageDeflate: false,
    })
    this.#socket = socket
    socket.once('open', () => {
      this.#send({
        type: 'core.bind',
        bindingToken: this.#options.bindingToken,
        sessionId: this.#options.sessionId,
        viewerGeneration: this.#options.viewerGeneration,
        gatewayId: this.#options.gatewayId,
      })
    })
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        this.#fail(new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Signaling message must be text'))
        return
      }
      try {
        this.#handleMessage(
          decodeSignalingMessage(data.toString(), this.#options.maxMessageBytes),
        )
      } catch (cause) {
        this.#fail(asRemoteTabError(cause, 'PROTOCOL_DECODE_FAILED', 'Signaling message failed'))
      }
    })
    socket.once('error', (cause) => {
      this.#fail(
        new RemoteTabError('ICE_FAILED', 'Core could not connect to the signaling Gateway', {
          cause,
          retryable: true,
        }),
      )
    })
    socket.once('close', () => {
      if (!this.#closed) {
        this.#fail(
          new RemoteTabError('ICE_FAILED', 'Core signaling connection closed', {
            retryable: true,
          }),
        )
      }
    })
    return this.#connectPromise
  }

  public sendDescription(description: SessionDescription): void {
    if (description.type !== 'offer') {
      throw new RemoteTabError(
        'PROTOCOL_MESSAGE_INVALID',
        'Core may send only WebRTC offers through signaling',
      )
    }
    this.#send({ type: 'signal.description', description })
  }

  public sendIce(candidate: IceCandidate): void {
    this.#send({ type: 'signal.ice', candidate })
  }

  public sendError(error: RemoteTabErrorShape): void {
    this.#send({ type: 'signal.error', error })
  }

  public onEvent(listener: CoreSignalingEventListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  public async close(): Promise<void> {
    if (this.#closed) {
      return
    }
    this.#closed = true
    this.#clearTimer()
    const socket = this.#socket
    this.#socket = undefined
    this.#listeners.clear()
    this.#rejectConnect?.(new RemoteTabError('SESSION_CLOSED', 'Core signaling client closed'))
    this.#resolveConnect = undefined
    this.#rejectConnect = undefined
    if (socket !== undefined && socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        socket.once('close', () => resolve())
        socket.close(1000, 'Core signaling client closed')
      })
    }
  }

  #handleMessage(message: SignalingMessage): void {
    if (message.type === 'signal.error') {
      this.#fail(
        new RemoteTabError(message.error.code, message.error.message, {
          retryable: message.error.retryable,
          ...(message.error.details === undefined ? {} : { details: message.error.details }),
        }),
      )
      return
    }
    if (message.type === 'signal.ready') {
      if (
        message.role !== 'core' ||
        message.sessionId !== this.#options.sessionId ||
        message.viewerGeneration !== this.#options.viewerGeneration
      ) {
        throw new RemoteTabError(
          'PROTOCOL_MESSAGE_INVALID',
          'Gateway returned a different Core Session binding',
        )
      }
      if (this.#ready) {
        throw new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Gateway sent signal.ready twice')
      }
      this.#ready = true
      this.#readyAssignment = {
        capabilities: normalizeCapabilities(message.capabilities),
        iceServers: message.iceServers,
        iceTransportPolicy: message.iceTransportPolicy ?? 'all',
      }
      this.#emit({ type: 'ready', ...this.#readyAssignment })
      this.#completeIfPaired()
      return
    }
    if (message.type === 'signal.peer-ready') {
      if (!this.#ready || this.#peerReady) {
        throw new RemoteTabError(
          'PROTOCOL_MESSAGE_INVALID',
          'Gateway sent signal.peer-ready in an invalid state',
        )
      }
      this.#peerReady = true
      this.#emit({ type: 'peer-ready' })
      this.#completeIfPaired()
      return
    }
    if (!this.#ready || !this.#peerReady) {
      throw new RemoteTabError(
        'SIGNALING_NOT_PAIRED',
        'Gateway relayed signaling before pairing completed',
      )
    }
    if (message.type === 'signal.description') {
      if (message.description.type !== 'answer') {
        throw new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Core expected a WebRTC answer')
      }
      this.#emit({ type: 'description', description: message.description })
      return
    }
    if (message.type === 'signal.ice') {
      this.#emit({ type: 'ice', candidate: message.candidate })
      return
    }
    if (message.type === 'signal.restart-ice') {
      this.#emit({ type: 'ice-restart-request' })
      return
    }
    if (message.type === 'signal.peer-left') {
      if (message.role !== 'viewer') {
        throw new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Core received its own peer-left event')
      }
      this.#emit({ type: 'peer-left' })
      return
    }
    throw new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Gateway sent an unexpected message')
  }

  #completeIfPaired(): void {
    if (!this.#ready || !this.#peerReady || this.#readyAssignment === undefined) {
      return
    }
    this.#clearTimer()
    this.#resolveConnect?.(this.#readyAssignment)
    this.#resolveConnect = undefined
    this.#rejectConnect = undefined
  }

  #send(message: SignalingMessage): void {
    if (this.#socket?.readyState !== WebSocket.OPEN) {
      throw new RemoteTabError('SIGNALING_NOT_PAIRED', 'Core signaling socket is not open', {
        retryable: true,
      })
    }
    this.#socket.send(encodeSignalingMessage(message, this.#options.maxMessageBytes))
  }

  #fail(error: RemoteTabError): void {
    if (this.#closed) {
      return
    }
    this.#closed = true
    this.#clearTimer()
    this.#emit({ type: 'error', error: error.toJSON() })
    this.#rejectConnect?.(error)
    this.#resolveConnect = undefined
    this.#rejectConnect = undefined
    this.#socket?.close(1011, error.code)
  }

  #emit(event: CoreSignalingEvent): void {
    for (const listener of this.#listeners) {
      listener(event)
    }
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
  }
}

function asRemoteTabError(
  cause: unknown,
  code: 'PROTOCOL_DECODE_FAILED' | 'PROTOCOL_MESSAGE_INVALID',
  message: string,
): RemoteTabError {
  return cause instanceof RemoteTabError ? cause : new RemoteTabError(code, message, { cause })
}
