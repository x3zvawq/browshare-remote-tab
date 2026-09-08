import type { AddressInfo } from 'node:net'

import Type from 'typebox'
import Schema from 'typebox/schema'
import WebSocket, { WebSocketServer, type RawData } from 'ws'

import {
  decodeSignalingMessage,
  encodeSignalingMessage,
  MAX_SIGNALING_MESSAGE_BYTES,
  RemoteTabError,
  summarizeIceCandidate,
  ViewerTicketClaimsSchema,
  type IceServer,
  type IceTransportPolicy,
  type IceCandidateSummary,
  type RemoteTabErrorShape,
  type SignalingMessage,
  type ViewerTicketClaims,
} from '@browshare/remote-tab-protocol'

export const SignalingGatewayConfigurationSchema = Type.Object(
  {
    gatewayId: Type.String({ minLength: 1 }),
    host: Type.String({ minLength: 1 }),
    port: Type.Integer({ minimum: 0, maximum: 65535 }),
    publicEndpoint: Type.String({ minLength: 1 }),
    pairingTimeoutMs: Type.Integer({ minimum: 1 }),
    maxMessageBytes: Type.Integer({ minimum: 1, maximum: MAX_SIGNALING_MESSAGE_BYTES }),
    maxPendingPairs: Type.Integer({ minimum: 1 }),
    maxConnections: Type.Integer({ minimum: 1 }),
    maxConnectionsPerIp: Type.Integer({ minimum: 1 }),
    messageRateWindowMs: Type.Integer({ minimum: 1 }),
    maxMessagesPerWindow: Type.Integer({ minimum: 1 }),
    maxConsumedTickets: Type.Integer({ minimum: 1 }),
    iceTransportPolicy: Type.Enum(['all', 'relay'] as const),
  },
  { additionalProperties: false },
)

export type SignalingGatewayConfiguration = Type.Static<
  typeof SignalingGatewayConfigurationSchema
>

export interface VerifyViewerTicketResult {
  claims: ViewerTicketClaims
}

export interface ViewerTicketVerifier {
  verifyViewerTicket(ticket: string): Promise<VerifyViewerTicketResult>
}

export interface AuthorizeCoreBindingInput {
  bindingToken: string
  sessionId: string
  viewerGeneration: number
  gatewayId: string
}

export interface CoreBindingAuthorizer {
  authorizeCoreBinding(input: AuthorizeCoreBindingInput): Promise<boolean>
}

export type SignalingPeerRole = 'core' | 'viewer'

export interface IceServerProvider {
  getIceServers(role: SignalingPeerRole, claims: ViewerTicketClaims): Promise<readonly IceServer[]>
}

export interface SignalingGatewayOptions {
  configuration: SignalingGatewayConfiguration
  viewerTicketVerifier: ViewerTicketVerifier
  coreBindingAuthorizer: CoreBindingAuthorizer
  iceServerProvider?: IceServerProvider
  now?: () => number
  onDiagnostic?: (event: SignalingGatewayDiagnosticEvent) => void
}

interface SessionDiagnosticContext {
  sessionId: string
  viewerGeneration: number
}

export type SignalingGatewayDiagnosticEvent =
  | { type: 'peer.connected' }
  | { type: 'connection.rejected'; reason: 'gateway-capacity' | 'ip-capacity' }
  | ({ type: 'peer.rate-limited'; role?: SignalingPeerRole } & Partial<SessionDiagnosticContext>)
  | ({ type: 'peer.bound'; role: SignalingPeerRole } & SessionDiagnosticContext)
  | ({
      type: 'pair.completed'
      coreIceServerCount: number
      viewerIceServerCount: number
      iceTransportPolicy: IceTransportPolicy
    } & SessionDiagnosticContext)
  | ({
      type: 'description.relayed'
      fromRole: SignalingPeerRole
      descriptionType: 'offer' | 'answer'
    } & SessionDiagnosticContext)
  | ({ type: 'ice.relayed'; fromRole: SignalingPeerRole } &
      SessionDiagnosticContext &
      IceCandidateSummary)
  | ({ type: 'ice-restart.relayed'; fromRole: 'viewer' } & SessionDiagnosticContext)
  | ({ type: 'error.relayed'; fromRole: 'core'; code: RemoteTabErrorShape['code'] } &
      SessionDiagnosticContext)
  | ({ type: 'peer.disconnected'; role: SignalingPeerRole } & SessionDiagnosticContext)
  | ({ type: 'pair.expired'; missingRoles: readonly SignalingPeerRole[] } &
      SessionDiagnosticContext)
  | ({
      type: 'peer.rejected'
      code: RemoteTabErrorShape['code']
      role?: SignalingPeerRole
    } & Partial<SessionDiagnosticContext>)

export interface SignalingGatewayAddress {
  host: string
  port: number
}

export interface SignalingGatewayMetrics {
  connectionsActive: number
  connectionsAcceptedTotal: number
  connectionsRejectedTotal: number
  messagesReceivedTotal: number
  messageBytesReceivedTotal: number
  messagesRelayedTotal: number
  rateLimitedConnectionsTotal: number
  peersBound: number
  pairsTracked: number
  pairsCompletedTotal: number
  pairsExpiredTotal: number
  consumedTickets: number
  maximumConnections: number
  maximumPendingPairs: number
  maximumConsumedTickets: number
}

interface BoundPeer {
  role: SignalingPeerRole
  key: string
}

interface Pairing {
  key: string
  sessionId: string
  viewerGeneration: number
  core: WebSocket | undefined
  viewer: WebSocket | undefined
  claims: ViewerTicketClaims | undefined
  timer: ReturnType<typeof setTimeout>
}

interface ConnectionRecord {
  address: string
  windowStartedAt: number
  messagesInWindow: number
  bindInProgress: boolean
}

const configurationValidator = Schema.Compile(SignalingGatewayConfigurationSchema)
const ticketClaimsValidator = Schema.Compile(ViewerTicketClaimsSchema)

export class SignalingGateway {
  readonly #configuration: SignalingGatewayConfiguration
  readonly #viewerTicketVerifier: ViewerTicketVerifier
  readonly #coreBindingAuthorizer: CoreBindingAuthorizer
  readonly #iceServerProvider: IceServerProvider | undefined
  readonly #now: () => number
  readonly #onDiagnostic: ((event: SignalingGatewayDiagnosticEvent) => void) | undefined
  readonly #pairs = new Map<string, Pairing>()
  readonly #peers = new Map<WebSocket, BoundPeer>()
  readonly #connections = new Map<WebSocket, ConnectionRecord>()
  readonly #connectionsByAddress = new Map<string, number>()
  readonly #consumedTickets = new Map<string, number>()
  #connectionsAcceptedTotal = 0
  #connectionsRejectedTotal = 0
  #messagesReceivedTotal = 0
  #messageBytesReceivedTotal = 0
  #messagesRelayedTotal = 0
  #rateLimitedConnectionsTotal = 0
  #pairsCompletedTotal = 0
  #pairsExpiredTotal = 0
  #server: WebSocketServer | undefined

  public constructor(options: SignalingGatewayOptions) {
    if (!configurationValidator.Check(options.configuration)) {
      throw new TypeError('Signaling Gateway configuration is invalid')
    }
    this.#configuration = options.configuration
    this.#viewerTicketVerifier = options.viewerTicketVerifier
    this.#coreBindingAuthorizer = options.coreBindingAuthorizer
    this.#iceServerProvider = options.iceServerProvider
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000))
    this.#onDiagnostic = options.onDiagnostic
  }

  public async start(): Promise<SignalingGatewayAddress> {
    if (this.#server !== undefined) {
      throw new Error('Signaling Gateway is already started')
    }

    const server = new WebSocketServer({
      host: this.#configuration.host,
      port: this.#configuration.port,
      maxPayload: this.#configuration.maxMessageBytes,
      perMessageDeflate: false,
    })
    this.#server = server
    server.on('connection', (socket, request) => {
      this.#accept(socket, normalizeRemoteAddress(request.socket.remoteAddress))
    })

    await new Promise<void>((resolve, reject) => {
      const handleListening = (): void => {
        server.off('error', handleError)
        resolve()
      }
      const handleError = (error: Error): void => {
        server.off('listening', handleListening)
        reject(error)
      }
      server.once('listening', handleListening)
      server.once('error', handleError)
    })

    const address = server.address() as AddressInfo
    return { host: address.address, port: address.port }
  }

  public async close(): Promise<void> {
    const server = this.#server
    if (server === undefined) {
      return
    }
    this.#server = undefined

    for (const pairing of this.#pairs.values()) {
      clearTimeout(pairing.timer)
    }
    this.#pairs.clear()
    this.#peers.clear()
    this.#connections.clear()
    this.#connectionsByAddress.clear()
    this.#consumedTickets.clear()
    for (const client of server.clients) {
      client.close(1001, 'Gateway shutting down')
    }

    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)))
    })
  }

  public getMetrics(): SignalingGatewayMetrics {
    this.#pruneConsumedTickets(this.#now())
    return {
      connectionsActive: this.#connections.size,
      connectionsAcceptedTotal: this.#connectionsAcceptedTotal,
      connectionsRejectedTotal: this.#connectionsRejectedTotal,
      messagesReceivedTotal: this.#messagesReceivedTotal,
      messageBytesReceivedTotal: this.#messageBytesReceivedTotal,
      messagesRelayedTotal: this.#messagesRelayedTotal,
      rateLimitedConnectionsTotal: this.#rateLimitedConnectionsTotal,
      peersBound: this.#peers.size,
      pairsTracked: this.#pairs.size,
      pairsCompletedTotal: this.#pairsCompletedTotal,
      pairsExpiredTotal: this.#pairsExpiredTotal,
      consumedTickets: this.#consumedTickets.size,
      maximumConnections: this.#configuration.maxConnections,
      maximumPendingPairs: this.#configuration.maxPendingPairs,
      maximumConsumedTickets: this.#configuration.maxConsumedTickets,
    }
  }

  #accept(socket: WebSocket, address: string): void {
    if (this.#connections.size >= this.#configuration.maxConnections) {
      this.#connectionsRejectedTotal += 1
      this.#diagnose({ type: 'connection.rejected', reason: 'gateway-capacity' })
      socket.close(1013, 'Gateway capacity reached')
      return
    }
    const addressConnections = this.#connectionsByAddress.get(address) ?? 0
    if (addressConnections >= this.#configuration.maxConnectionsPerIp) {
      this.#connectionsRejectedTotal += 1
      this.#diagnose({ type: 'connection.rejected', reason: 'ip-capacity' })
      socket.close(1013, 'Gateway address capacity reached')
      return
    }
    this.#connections.set(socket, {
      address,
      windowStartedAt: Date.now(),
      messagesInWindow: 0,
      bindInProgress: false,
    })
    this.#connectionsByAddress.set(address, addressConnections + 1)
    this.#connectionsAcceptedTotal += 1
    this.#diagnose({ type: 'peer.connected' })
    const bindTimer = setTimeout(() => {
      this.#rejectSocket(
        socket,
        new RemoteTabError('SIGNALING_AUTH_FAILED', 'Signaling peer did not authenticate in time'),
      )
    }, this.#configuration.pairingTimeoutMs)

    socket.on('message', (data, isBinary) => {
      if (!this.#consumeMessage(socket, data)) return
      try {
        const record = this.#connections.get(socket)
        if (record === undefined) return
        if (record.bindInProgress) {
          throw new RemoteTabError(
            'SIGNALING_AUTH_FAILED',
            'Only one signaling bind may be processed at a time',
          )
        }
        if (isBinary) {
          throw new RemoteTabError(
            'PROTOCOL_MESSAGE_INVALID',
            'Signaling messages must be UTF-8 JSON text',
          )
        }
        const message = decodeSignalingMessage(
          data.toString(),
          this.#configuration.maxMessageBytes,
        )
        if (this.#peers.has(socket)) {
          this.#relay(socket, message)
          return
        }
        record.bindInProgress = true
        void this.#bind(socket, message)
          .then(() => {
            const current = this.#connections.get(socket)
            if (current === undefined || socket.readyState !== WebSocket.OPEN) return
            current.bindInProgress = false
            clearTimeout(bindTimer)
          })
          .catch((cause: unknown) => this.#rejectBindFailure(socket, cause))
      } catch (cause) {
        this.#rejectBindFailure(socket, cause)
      }
    })
    socket.on('close', () => {
      clearTimeout(bindTimer)
      this.#removePeer(socket)
      this.#removeConnection(socket)
    })
    socket.on('error', () => {
      clearTimeout(bindTimer)
      this.#removePeer(socket)
      this.#removeConnection(socket)
    })
  }

  #consumeMessage(socket: WebSocket, data: RawData): boolean {
    const record = this.#connections.get(socket)
    if (record === undefined) return false
    this.#messagesReceivedTotal += 1
    this.#messageBytesReceivedTotal += rawDataBytes(data)
    const now = Date.now()
    if (now - record.windowStartedAt >= this.#configuration.messageRateWindowMs) {
      record.windowStartedAt = now
      record.messagesInWindow = 0
    }
    record.messagesInWindow += 1
    if (record.messagesInWindow <= this.#configuration.maxMessagesPerWindow) return true

    this.#rateLimitedConnectionsTotal += 1
    const peer = this.#peers.get(socket)
    const pairing = peer === undefined ? undefined : this.#pairs.get(peer.key)
    this.#diagnose({
      type: 'peer.rate-limited',
      ...(peer === undefined ? {} : { role: peer.role }),
      ...(pairing === undefined
        ? {}
        : { sessionId: pairing.sessionId, viewerGeneration: pairing.viewerGeneration }),
    })
    this.#removePeer(socket)
    this.#removeConnection(socket)
    socket.close(1008, 'Signaling message rate exceeded')
    return false
  }

  #removeConnection(socket: WebSocket): void {
    const record = this.#connections.get(socket)
    if (record === undefined) return
    this.#connections.delete(socket)
    const count = this.#connectionsByAddress.get(record.address) ?? 0
    if (count <= 1) this.#connectionsByAddress.delete(record.address)
    else this.#connectionsByAddress.set(record.address, count - 1)
  }

  async #bind(socket: WebSocket, message: SignalingMessage): Promise<void> {
    if (message.type === 'viewer.bind') {
      await this.#bindViewer(socket, message.ticket)
      return
    }
    if (message.type === 'core.bind') {
      await this.#bindCore(socket, message)
      return
    }
    throw new RemoteTabError('SIGNALING_AUTH_FAILED', 'First signaling message must bind a peer')
  }

  async #bindViewer(socket: WebSocket, ticket: string): Promise<void> {
    let result: VerifyViewerTicketResult
    try {
      result = await this.#viewerTicketVerifier.verifyViewerTicket(ticket)
    } catch (cause) {
      throw new RemoteTabError('SIGNALING_AUTH_FAILED', 'Viewer ticket is not valid', { cause })
    }
    this.#assertConnectionOpen(socket)

    if (!ticketClaimsValidator.Check(result.claims)) {
      throw new RemoteTabError('SIGNALING_AUTH_FAILED', 'Viewer ticket claims are invalid')
    }
    const claims = result.claims
    const now = this.#now()
    this.#pruneConsumedTickets(now)
    if (claims.gatewayId !== this.#configuration.gatewayId) {
      throw new RemoteTabError('SIGNALING_AUTH_FAILED', 'Viewer ticket targets another Gateway')
    }
    if (claims.issuedAt > now + 60 || claims.expiresAt <= now) {
      throw new RemoteTabError('VIEWER_TICKET_EXPIRED', 'Viewer ticket is expired')
    }
    if (this.#consumedTickets.has(claims.jti)) {
      throw new RemoteTabError('VIEWER_TICKET_REPLAYED', 'Viewer ticket was already consumed')
    }
    if (this.#consumedTickets.size >= this.#configuration.maxConsumedTickets) {
      throw new RemoteTabError('SIGNALING_PAIR_CONFLICT', 'Gateway ticket capacity is full', {
        retryable: true,
      })
    }

    const key = pairingKey(claims.sessionId, claims.viewerGeneration)
    const pairing = this.#getOrCreatePairing(key, claims.sessionId, claims.viewerGeneration)
    if (pairing.viewer !== undefined) {
      throw new RemoteTabError(
        'SIGNALING_PAIR_CONFLICT',
        'A Viewer is already bound to this Session generation',
      )
    }

    this.#consumedTickets.set(claims.jti, claims.expiresAt)
    pairing.viewer = socket
    pairing.claims = claims
    this.#peers.set(socket, { role: 'viewer', key })
    this.#diagnose({
      type: 'peer.bound',
      role: 'viewer',
      sessionId: claims.sessionId,
      viewerGeneration: claims.viewerGeneration,
    })
    await this.#completePair(pairing)
  }

  async #bindCore(
    socket: WebSocket,
    message: Extract<SignalingMessage, { type: 'core.bind' }>,
  ): Promise<void> {
    if (message.gatewayId !== this.#configuration.gatewayId) {
      throw new RemoteTabError('SIGNALING_AUTH_FAILED', 'Core binding targets another Gateway')
    }
    const allowed = await this.#coreBindingAuthorizer.authorizeCoreBinding({
      bindingToken: message.bindingToken,
      sessionId: message.sessionId,
      viewerGeneration: message.viewerGeneration,
      gatewayId: message.gatewayId,
    })
    this.#assertConnectionOpen(socket)
    if (!allowed) {
      throw new RemoteTabError('SIGNALING_AUTH_FAILED', 'Core binding is not authorized')
    }

    const key = pairingKey(message.sessionId, message.viewerGeneration)
    const pairing = this.#getOrCreatePairing(key, message.sessionId, message.viewerGeneration)
    if (pairing.core !== undefined) {
      throw new RemoteTabError(
        'SIGNALING_PAIR_CONFLICT',
        'Core is already bound to this Session generation',
      )
    }
    pairing.core = socket
    this.#peers.set(socket, { role: 'core', key })
    this.#diagnose({
      type: 'peer.bound',
      role: 'core',
      sessionId: message.sessionId,
      viewerGeneration: message.viewerGeneration,
    })
    await this.#completePair(pairing)
  }

  #getOrCreatePairing(key: string, sessionId: string, viewerGeneration: number): Pairing {
    const current = this.#pairs.get(key)
    if (current !== undefined) {
      return current
    }
    if (this.#pairs.size >= this.#configuration.maxPendingPairs) {
      throw new RemoteTabError('SIGNALING_PAIR_CONFLICT', 'Gateway pairing capacity is full', {
        retryable: true,
      })
    }

    const pairing: Pairing = {
      key,
      sessionId,
      viewerGeneration,
      core: undefined,
      viewer: undefined,
      claims: undefined,
      timer: setTimeout(() => this.#expirePair(key), this.#configuration.pairingTimeoutMs),
    }
    this.#pairs.set(key, pairing)
    return pairing
  }

  async #completePair(pairing: Pairing): Promise<void> {
    if (pairing.core === undefined || pairing.viewer === undefined || pairing.claims === undefined) {
      return
    }
    const core = pairing.core
    const viewer = pairing.viewer
    const claims = pairing.claims
    clearTimeout(pairing.timer)

    const coreIceServers = await this.#getIceServers('core', claims)
    if (!this.#isPairCurrent(pairing, core, viewer, claims)) return
    const viewerIceServers = await this.#getIceServers('viewer', claims)
    if (!this.#isPairCurrent(pairing, core, viewer, claims)) return
    this.#pairsCompletedTotal += 1
    this.#diagnose({
      type: 'pair.completed',
      sessionId: pairing.sessionId,
      viewerGeneration: pairing.viewerGeneration,
      coreIceServerCount: coreIceServers.length,
      viewerIceServerCount: viewerIceServers.length,
      iceTransportPolicy: this.#configuration.iceTransportPolicy,
    })
    this.#send(core, {
      type: 'signal.ready',
      role: 'core',
      sessionId: pairing.sessionId,
      viewerGeneration: pairing.viewerGeneration,
      capabilities: pairing.claims.capabilities,
      iceServers: [...coreIceServers],
      iceTransportPolicy: this.#configuration.iceTransportPolicy,
    })
    this.#send(viewer, {
      type: 'signal.ready',
      role: 'viewer',
      sessionId: pairing.sessionId,
      viewerGeneration: pairing.viewerGeneration,
      capabilities: pairing.claims.capabilities,
      iceServers: [...viewerIceServers],
      iceTransportPolicy: this.#configuration.iceTransportPolicy,
    })
    this.#send(core, { type: 'signal.peer-ready' })
    this.#send(viewer, { type: 'signal.peer-ready' })
  }

  #isPairCurrent(
    pairing: Pairing,
    core: WebSocket,
    viewer: WebSocket,
    claims: ViewerTicketClaims,
  ): boolean {
    return (
      this.#pairs.get(pairing.key) === pairing &&
      pairing.core === core &&
      pairing.viewer === viewer &&
      pairing.claims === claims &&
      this.#peers.get(core)?.key === pairing.key &&
      this.#peers.get(viewer)?.key === pairing.key &&
      core.readyState === WebSocket.OPEN &&
      viewer.readyState === WebSocket.OPEN
    )
  }

  #relay(socket: WebSocket, message: SignalingMessage): void {
    const peer = this.#peers.get(socket)
    if (peer === undefined) {
      throw new RemoteTabError('SIGNALING_AUTH_FAILED', 'Signaling peer is not bound')
    }
    const pairing = this.#pairs.get(peer.key)
    if (pairing === undefined) {
      throw new RemoteTabError('SIGNALING_NOT_PAIRED', 'Signaling pair no longer exists', {
        retryable: true,
      })
    }
    const destination = peer.role === 'core' ? pairing.viewer : pairing.core
    if (destination === undefined || destination.readyState !== WebSocket.OPEN) {
      throw new RemoteTabError('SIGNALING_NOT_PAIRED', 'Signaling peer is not paired', {
        retryable: true,
      })
    }

    if (message.type === 'signal.description') {
      const validDirection =
        (peer.role === 'core' && message.description.type === 'offer') ||
        (peer.role === 'viewer' && message.description.type === 'answer')
      if (!validDirection) {
        throw new RemoteTabError(
          'PROTOCOL_MESSAGE_INVALID',
          'Session description is not valid for this signaling role',
        )
      }
      this.#send(destination, message)
      this.#messagesRelayedTotal += 1
      this.#diagnose({
        type: 'description.relayed',
        fromRole: peer.role,
        descriptionType: message.description.type,
        sessionId: pairing.sessionId,
        viewerGeneration: pairing.viewerGeneration,
      })
      return
    }
    if (message.type === 'signal.ice') {
      this.#send(destination, message)
      this.#messagesRelayedTotal += 1
      this.#diagnose({
        type: 'ice.relayed',
        fromRole: peer.role,
        sessionId: pairing.sessionId,
        viewerGeneration: pairing.viewerGeneration,
        ...summarizeIceCandidate(message.candidate.candidate),
      })
      return
    }
    if (message.type === 'signal.restart-ice' && peer.role === 'viewer') {
      this.#send(destination, message)
      this.#messagesRelayedTotal += 1
      this.#diagnose({
        type: 'ice-restart.relayed',
        fromRole: 'viewer',
        sessionId: pairing.sessionId,
        viewerGeneration: pairing.viewerGeneration,
      })
      return
    }
    if (message.type === 'signal.error' && peer.role === 'core') {
      this.#send(destination, message)
      this.#messagesRelayedTotal += 1
      this.#diagnose({
        type: 'error.relayed',
        fromRole: 'core',
        code: message.error.code,
        sessionId: pairing.sessionId,
        viewerGeneration: pairing.viewerGeneration,
      })
      return
    }
    throw new RemoteTabError(
      'PROTOCOL_MESSAGE_INVALID',
      'Bound signaling peer sent a non-relay message',
    )
  }

  #removePeer(socket: WebSocket): void {
    const peer = this.#peers.get(socket)
    if (peer === undefined) {
      return
    }
    this.#peers.delete(socket)
    const pairing = this.#pairs.get(peer.key)
    if (pairing === undefined) {
      return
    }

    if (peer.role === 'core' && pairing.core === socket) {
      pairing.core = undefined
    } else if (peer.role === 'viewer' && pairing.viewer === socket) {
      pairing.viewer = undefined
      pairing.claims = undefined
    }

    this.#diagnose({
      type: 'peer.disconnected',
      role: peer.role,
      sessionId: pairing.sessionId,
      viewerGeneration: pairing.viewerGeneration,
    })

    const destination = peer.role === 'core' ? pairing.viewer : pairing.core
    if (destination !== undefined) {
      this.#send(destination, { type: 'signal.peer-left', role: peer.role })
    }
    clearTimeout(pairing.timer)
    pairing.timer = setTimeout(
      () => this.#expirePair(pairing.key),
      this.#configuration.pairingTimeoutMs,
    )
  }

  #expirePair(key: string): void {
    const pairing = this.#pairs.get(key)
    if (pairing === undefined) {
      return
    }
    this.#pairs.delete(key)
    this.#pairsExpiredTotal += 1
    const missingRoles: SignalingPeerRole[] = []
    if (pairing.core === undefined) missingRoles.push('core')
    if (pairing.viewer === undefined) missingRoles.push('viewer')
    this.#diagnose({
      type: 'pair.expired',
      sessionId: pairing.sessionId,
      viewerGeneration: pairing.viewerGeneration,
      missingRoles,
    })
    const error = new RemoteTabError(
      'SIGNALING_PAIR_TIMEOUT',
      'Signaling peer did not pair in time',
      { retryable: true },
    )
    if (pairing.core !== undefined) {
      this.#peers.delete(pairing.core)
      this.#rejectSocket(pairing.core, error)
    }
    if (pairing.viewer !== undefined) {
      this.#peers.delete(pairing.viewer)
      this.#rejectSocket(pairing.viewer, error)
    }
  }

  async #getIceServers(
    role: SignalingPeerRole,
    claims: ViewerTicketClaims,
  ): Promise<readonly IceServer[]> {
    return (await this.#iceServerProvider?.getIceServers(role, claims)) ?? []
  }

  #pruneConsumedTickets(now: number): void {
    for (const [jti, expiresAt] of this.#consumedTickets) {
      if (expiresAt <= now) {
        this.#consumedTickets.delete(jti)
      }
    }
  }

  #send(socket: WebSocket, message: SignalingMessage): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(encodeSignalingMessage(message, this.#configuration.maxMessageBytes))
    }
  }

  #rejectSocket(socket: WebSocket, error: RemoteTabError): void {
    const peer = this.#peers.get(socket)
    const pairing = peer === undefined ? undefined : this.#pairs.get(peer.key)
    this.#diagnose({
      type: 'peer.rejected',
      code: error.code,
      ...(peer === undefined ? {} : { role: peer.role }),
      ...(pairing === undefined
        ? {}
        : {
            sessionId: pairing.sessionId,
            viewerGeneration: pairing.viewerGeneration,
          }),
    })
    const shape: RemoteTabErrorShape = error.toJSON()
    this.#send(socket, { type: 'signal.error', error: shape })
    socket.close(1008, error.code)
  }

  #rejectBindFailure(socket: WebSocket, cause: unknown): void {
    const record = this.#connections.get(socket)
    if (record !== undefined) record.bindInProgress = false
    const error =
      cause instanceof RemoteTabError
        ? cause
        : new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Signaling message failed')
    this.#rejectSocket(socket, error)
  }

  #assertConnectionOpen(socket: WebSocket): void {
    if (!this.#connections.has(socket) || socket.readyState !== WebSocket.OPEN) {
      throw new RemoteTabError(
        'SIGNALING_AUTH_FAILED',
        'Signaling peer disconnected before authentication completed',
      )
    }
  }

  #diagnose(event: SignalingGatewayDiagnosticEvent): void {
    try {
      this.#onDiagnostic?.(event)
    } catch {
      // Observability must never interrupt signaling.
    }
  }
}

function pairingKey(sessionId: string, viewerGeneration: number): string {
  return `${sessionId}\u0000${viewerGeneration}`
}

function normalizeRemoteAddress(value: string | undefined): string {
  if (value === undefined || value.length === 0) return 'unknown'
  return value.startsWith('::ffff:') ? value.slice(7) : value
}

function rawDataBytes(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((total, chunk) => total + chunk.byteLength, 0)
  return data.byteLength
}

export * from './configuration.js'
export * from './metrics.js'
