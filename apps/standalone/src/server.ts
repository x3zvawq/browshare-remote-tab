import { timingSafeEqual } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'

import {
  CdpBrowser,
  ExtensionLoopbackServer,
  REMOTE_TAB_CORE_VERSION,
  RemoteTabCore,
  type AttachSessionInput,
  type RemoteTabSession,
  type SessionStorageAdapter,
} from '@browshare/remote-tab-core'
import {
  CAPABILITIES,
  HmacViewerTicketCodec,
  PROTOCOL_VERSION,
  RemoteTabError,
  type Capability,
  type RemoteTabErrorShape,
  type RemoteTabState,
} from '@browshare/remote-tab-protocol'

import {
  parseStandaloneConfiguration,
  type StandaloneConfiguration,
} from './configuration.js'
import {
  isCreateStandaloneSessionInput,
  isCreateViewerTicketInput,
  isSendNoticeInput,
  isUpdateCapabilitiesInput,
  type CreateStandaloneSessionInput,
} from './schemas.js'
import { LocalSessionStorage } from './session-storage.js'
import { REMOTE_TAB_STANDALONE_VERSION } from './version.js'

export interface StandaloneAddress {
  host: string
  port: number
}

export type StandaloneDiagnosticEvent =
  | { type: 'session.state'; sessionId: string; previous: string; current: string; reason?: string }
  | { type: 'session.audit'; sessionId: string; name: string; occurredAt: number }
  | {
      type: 'session.diagnostic'
      sessionId: string
      name: string
      occurredAt: number
      fields: Readonly<Record<string, string | number | boolean | null>>
    }
  | { type: 'api.started'; host: string; port: number }

export interface StandaloneCore {
  attachSession(input: AttachSessionInput): Promise<RemoteTabSession>
  close(reason?: string): Promise<void>
}

export interface StandaloneDaemonDependencies {
  core?: StandaloneCore
  extension?: ExtensionLoopbackServer
  storage?: SessionStorageAdapter
  onDiagnostic?(event: StandaloneDiagnosticEvent): void
}

interface SessionRecord {
  session: RemoteTabSession
  capabilities: Capability[]
  gatewayId: string
  endpoint: string
  viewerGeneration: number
  ticketQueue: Promise<void>
}

interface ApiFailureShape {
  code: string
  message: string
  retryable: boolean
  details?: Readonly<Record<string, unknown>>
}

interface CapabilityReport {
  status: 'ready' | 'not-ready'
  versions: Readonly<Record<string, unknown>>
  checks: Readonly<Record<string, string>>
  supportedCapabilities: readonly Capability[]
}

class ApiFailure extends Error {
  public readonly status: number
  public readonly code: string
  public readonly retryable: boolean

  public constructor(status: number, code: string, message: string, retryable = false) {
    super(message)
    this.status = status
    this.code = code
    this.retryable = retryable
  }
}

export class StandaloneDaemon {
  readonly #configuration: StandaloneConfiguration
  readonly #extension: ExtensionLoopbackServer
  readonly #core: StandaloneCore
  readonly #storage: SessionStorageAdapter
  readonly #localStorage: LocalSessionStorage | undefined
  readonly #ticketCodec: HmacViewerTicketCodec
  readonly #onDiagnostic: ((event: StandaloneDiagnosticEvent) => void) | undefined
  readonly #downloadDirectory: string | undefined
  readonly #sessions = new Map<string, SessionRecord>()
  readonly #attaching = new Set<string>()
  #server: Server | undefined
  #closing = false

  public constructor(
    configuration: StandaloneConfiguration,
    dependencies: StandaloneDaemonDependencies = {},
  ) {
    this.#configuration = parseStandaloneConfiguration(configuration)
    this.#extension =
      dependencies.extension ??
      new ExtensionLoopbackServer({
        host: configuration.extension.host,
        port: configuration.extension.port,
        extensionId: configuration.extension.id,
        runtimeSecret: configuration.extension.runtimeSecret,
        runtimeGeneration: configuration.extension.runtimeGeneration,
        requestTimeoutMs: configuration.extension.requestTimeoutMs,
      })
    const downloadDirectory = resolve(configuration.tempRoot, '.browser-downloads')
    this.#downloadDirectory = dependencies.core === undefined ? downloadDirectory : undefined
    this.#core =
      dependencies.core ??
      new RemoteTabCore({
        extension: this.#extension,
        downloadDirectory,
      })
    this.#localStorage = dependencies.storage === undefined
      ? new LocalSessionStorage(configuration.tempRoot)
      : undefined
    this.#storage = dependencies.storage ?? this.#localStorage!
    this.#ticketCodec = new HmacViewerTicketCodec({
      secret: configuration.viewerTickets.secret,
      issuer: configuration.viewerTickets.issuer,
      audience: configuration.viewerTickets.audience,
    })
    this.#onDiagnostic = dependencies.onDiagnostic
  }

  public async start(): Promise<StandaloneAddress> {
    if (this.#server !== undefined) {
      throw new Error('Standalone daemon is already started')
    }
    this.#closing = false
    await this.#localStorage?.initialize()
    if (this.#downloadDirectory !== undefined) {
      await rm(this.#downloadDirectory, { recursive: true, force: true })
      await mkdir(this.#downloadDirectory, { recursive: true, mode: 0o700 })
    }
    try {
      await this.#extension.start()
    } catch (cause) {
      if (this.#downloadDirectory !== undefined) {
        await rm(this.#downloadDirectory, { recursive: true, force: true })
      }
      throw cause
    }
    const server = createServer((request, response) => {
      void this.#handle(request, response).catch((cause: unknown) => {
        this.#sendFailure(response, cause)
      })
    })
    this.#server = server
    try {
      await new Promise<void>((resolve, reject) => {
        const onListening = (): void => {
          server.off('error', onError)
          resolve()
        }
        const onError = (error: Error): void => {
          server.off('listening', onListening)
          reject(error)
        }
        server.once('listening', onListening)
        server.once('error', onError)
        server.listen(
          this.#configuration.embedderApi.port,
          this.#configuration.embedderApi.host,
        )
      })
    } catch (cause) {
      this.#server = undefined
      await this.#extension.close()
      if (this.#downloadDirectory !== undefined) {
        await rm(this.#downloadDirectory, { recursive: true, force: true })
      }
      throw cause
    }
    const address = server.address() as AddressInfo
    const result = { host: address.address, port: address.port }
    this.#diagnose({ type: 'api.started', ...result })
    return result
  }

  public async close(reason = 'Standalone daemon shutting down'): Promise<void> {
    if (this.#closing) {
      return
    }
    this.#closing = true
    const server = this.#server
    this.#server = undefined
    if (server !== undefined) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)))
        server.closeAllConnections()
      })
    }
    let closeFailure: unknown
    try {
      await this.#core.close(reason)
    } catch (cause) {
      // Core still owns live targets: retain mappings/storage/Extension for a shutdown retry.
      this.#closing = false
      throw cause
    }
    this.#sessions.clear()
    this.#attaching.clear()
    try {
      await this.#localStorage?.cleanupAll()
    } catch (cause) {
      closeFailure ??= cause
    }
    try {
      await this.#extension.close()
    } catch (cause) {
      closeFailure ??= cause
    }
    if (this.#downloadDirectory !== undefined) {
      try {
        await rm(this.#downloadDirectory, { recursive: true, force: true })
      } catch (cause) {
        closeFailure ??= cause
      }
    }
    if (closeFailure !== undefined) { this.#closing = false; throw closeFailure }
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('cache-control', 'no-store')
    response.setHeader('x-content-type-options', 'nosniff')
    const url = new URL(request.url ?? '/', 'http://standalone.invalid')

    if (request.method === 'GET' && url.pathname === '/health/live') {
      this.#sendJson(response, 200, { status: this.#closing ? 'closing' : 'ok' })
      return
    }
    if (request.method === 'GET' && url.pathname === '/health/ready') {
      await this.#handleReadiness(response)
      return
    }
    if (request.method === 'GET' && url.pathname === '/metrics') {
      this.#sendPrometheusMetrics(response)
      return
    }

    this.#authorize(request)
    if (request.method === 'GET' && url.pathname === '/v1/diagnostics/capabilities') {
      this.#sendJson(response, 200, await this.#probeCapabilities())
      return
    }
    if (request.method === 'GET' && url.pathname === '/v1/reconciliation/targets') {
      this.#sendJson(response, 200, await this.#listReconciliationTargets())
      return
    }
    if (request.method === 'GET' && url.pathname === '/v1/sessions') {
      this.#sendJson(response, 200, {
        sessions: [...this.#sessions.values()].map((record) => toSessionJson(record)),
      })
      return
    }
    if (request.method === 'POST' && url.pathname === '/v1/sessions') {
      const input = await this.#readJson(request)
      if (!isCreateStandaloneSessionInput(input)) {
        throw new ApiFailure(400, 'API_INVALID_REQUEST', 'Session request is invalid')
      }
      const record = await this.#createSession(input)
      this.#sendJson(response, 201, toSessionJson(record, true))
      return
    }

    const sessionMatch = /^\/v1\/sessions\/([^/]+)$/u.exec(url.pathname)
    if (sessionMatch !== null) {
      const sessionId = decodePathSegment(sessionMatch[1]!)
      const record = this.#requireSession(sessionId)
      if (request.method === 'GET') {
        this.#sendJson(response, 200, toSessionJson(record, true))
        return
      }
      if (request.method === 'DELETE') {
        await record.ticketQueue
        await record.session.close('Standalone Embedder requested Session close')
        this.#sessions.delete(sessionId)
        response.writeHead(204)
        response.end()
        return
      }
    }

    const ticketMatch = /^\/v1\/sessions\/([^/]+)\/viewer-tickets$/u.exec(url.pathname)
    if (request.method === 'POST' && ticketMatch !== null) {
      const sessionId = decodePathSegment(ticketMatch[1]!)
      const record = this.#requireSession(sessionId)
      const input = await this.#readJson(request)
      if (!isCreateViewerTicketInput(input)) {
        throw new ApiFailure(400, 'API_INVALID_REQUEST', 'Viewer Ticket request is invalid')
      }
      if (input.expiresInSeconds > this.#configuration.viewerTickets.maximumLifetimeSeconds) {
        throw new ApiFailure(
          400,
          'API_INVALID_REQUEST',
          'Viewer Ticket lifetime exceeds the configured maximum',
        )
      }
      const ticket = await this.#issueViewerTicket(record, input)
      this.#sendJson(response, 201, ticket)
      return
    }

    const capabilitiesMatch = /^\/v1\/sessions\/([^/]+)\/capabilities$/u.exec(url.pathname)
    if (request.method === 'PUT' && capabilitiesMatch !== null) {
      const sessionId = decodePathSegment(capabilitiesMatch[1]!)
      const record = this.#requireSession(sessionId)
      const input = await this.#readJson(request)
      if (!isUpdateCapabilitiesInput(input)) {
        throw new ApiFailure(400, 'API_INVALID_REQUEST', 'Capabilities request is invalid')
      }
      await record.session.updateCapabilities(input.capabilities)
      record.capabilities = [...input.capabilities]
      this.#sendJson(response, 200, toSessionJson(record))
      return
    }

    const noticesMatch = /^\/v1\/sessions\/([^/]+)\/notices$/u.exec(url.pathname)
    if (request.method === 'POST' && noticesMatch !== null) {
      const sessionId = decodePathSegment(noticesMatch[1]!)
      const record = this.#requireSession(sessionId)
      const input = await this.#readJson(request)
      if (!isSendNoticeInput(input)) {
        throw new ApiFailure(400, 'API_INVALID_REQUEST', 'Notice request is invalid')
      }
      record.session.sendNotice(input)
      response.writeHead(204)
      response.end()
      return
    }

    throw new ApiFailure(404, 'API_ROUTE_NOT_FOUND', 'Route not found')
  }

  async #createSession(input: CreateStandaloneSessionInput): Promise<SessionRecord> {
    if (this.#closing) {
      throw new ApiFailure(503, 'API_SHUTTING_DOWN', 'Standalone daemon is shutting down', true)
    }
    if (this.#sessions.has(input.sessionId) || this.#attaching.has(input.sessionId)) {
      throw new ApiFailure(409, 'SESSION_CONFLICT', 'Session ID is already in use')
    }
    if (this.#sessions.size + this.#attaching.size >= this.#configuration.maxSessions) {
      throw new ApiFailure(429, 'SESSION_CAPACITY_REACHED', 'Standalone Session capacity is full', true)
    }
    assertSignalingEndpoint(input.signaling.coreEndpoint)
    assertSignalingEndpoint(input.signaling.viewerEndpoint)
    this.#attaching.add(input.sessionId)
    try {
      let attachedSession: RemoteTabSession | undefined
      const session = await this.#core.attachSession({
        sessionId: input.sessionId,
        cdpEndpoint: this.#configuration.cdpEndpoint,
        tab: input.tab,
        capabilities: input.capabilities,
        signaling: {
          gatewayId: input.signaling.gatewayId,
          endpoint: input.signaling.coreEndpoint,
          bindingToken: input.signaling.bindingToken,
          ...(input.signaling.connectionTimeoutMs === undefined
            ? {}
            : { connectionTimeoutMs: input.signaling.connectionTimeoutMs }),
        },
        storage: this.#storage,
        ...(input.childTargetPolicy === undefined
          ? {}
          : { childTargetPolicy: input.childTargetPolicy }),
        ...(input.localOpenRequestTimeoutMs === undefined
          ? {}
          : { localOpenRequestTimeoutMs: input.localOpenRequestTimeoutMs }),
        ...(input.pageScript === undefined ? {} : { pageScript: input.pageScript }),
        hooks: {
          authorizeNavigation: async (request) => ({
            allowed: input.navigationPolicy === 'allow-all',
            ...(request.url === undefined ? {} : { url: request.url }),
            ...(input.navigationPolicy === 'allow-all'
              ? {}
              : { reason: 'Standalone Session navigation policy denies this action' }),
          }),
          onStateChanged: (event) => {
            this.#diagnose({ type: 'session.state', ...event })
            if (isTerminalState(event.current) && attachedSession !== undefined) {
              const current = this.#sessions.get(event.sessionId)
              if (current?.session === attachedSession) {
                const session = attachedSession
                void session.close(event.reason ?? 'Remote Tab reached a terminal state').then(() => {
                  if (this.#sessions.get(event.sessionId)?.session === session) this.#sessions.delete(event.sessionId)
                }).catch(() => {
                  this.#diagnose({ type: 'session.diagnostic', sessionId: event.sessionId,
                    name: 'session.cleanup.pending', occurredAt: Date.now(), fields: {} })
                })
              }
            }
          },
          onAuditEvent: (event) =>
            this.#diagnose({
              type: 'session.audit',
              sessionId: event.sessionId,
              name: event.name,
              occurredAt: event.occurredAt,
            }),
          onDiagnostic: (event) => this.#diagnose({ type: 'session.diagnostic', ...event }),
        },
        ticketIssuer: { issueViewerTicket: (request) => this.#ticketCodec.issue(request) },
      })
      attachedSession = session
      const record: SessionRecord = {
        session,
        capabilities: [...input.capabilities],
        gatewayId: input.signaling.gatewayId,
        endpoint: input.signaling.viewerEndpoint,
        viewerGeneration: 0,
        ticketQueue: Promise.resolve(),
      }
      this.#sessions.set(input.sessionId, record)
      return record
    } finally {
      this.#attaching.delete(input.sessionId)
    }
  }

  async #listReconciliationTargets(): Promise<Readonly<Record<string, unknown>>> {
    const browser = await CdpBrowser.connect(this.#configuration.cdpEndpoint)
    try {
      const tracked = new Map(
        [...this.#sessions.values()].map((record) => [
          record.session.getAttachment().targetId,
          record.session.id,
        ]),
      )
      const targets = await browser.listPageTargets()
      return {
        targets: targets.map((target) => {
          const sessionId = tracked.get(target.targetId)
          return {
            targetId: target.targetId,
            status: sessionId === undefined ? 'untracked' : 'tracked',
            ...(sessionId === undefined ? {} : { sessionId }),
          }
        }),
        trackedSessionCount: tracked.size,
        attachingSessionCount: this.#attaching.size,
      }
    } finally {
      browser.close()
    }
  }

  #issueViewerTicket(
    record: SessionRecord,
    input: { capabilities?: readonly Capability[]; expiresInSeconds: number },
  ): Promise<Readonly<Record<string, unknown>>> {
    const operation = record.ticketQueue.then(async () => {
      const viewerGeneration = record.viewerGeneration + 1
      const capabilities = input.capabilities ?? record.capabilities
      const ticket = await record.session.createViewerTicket({
        viewerGeneration,
        gatewayId: record.gatewayId,
        capabilities,
        expiresInSeconds: input.expiresInSeconds,
      })
      record.viewerGeneration = viewerGeneration
      return {
        sessionId: record.session.id,
        viewerGeneration,
        endpoint: record.endpoint,
        ticket: ticket.token,
        expiresAt: ticket.claims.expiresAt,
        capabilities: ticket.claims.capabilities,
      }
    })
    record.ticketQueue = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  async #handleReadiness(response: ServerResponse): Promise<void> {
    const report = await this.#probeCapabilities()
    const ready = report.status === 'ready'
    this.#sendJson(response, ready ? 200 : 503, {
      status: ready ? 'ready' : 'not-ready',
      checks: report.checks,
    })
  }

  async #probeCapabilities(): Promise<CapabilityReport> {
    const extension = this.#extension.getRuntimeStatus()
    let chrome:
      | { reachable: true; product: string; protocolVersion: string; revision: string; jsVersion: string }
      | { reachable: false }
    try {
      const browser = await CdpBrowser.connect(this.#configuration.cdpEndpoint, {
        requestTimeoutMs: 3_000,
      })
      try {
        const version = await browser.getVersion()
        chrome = {
          reachable: true,
          product: version.product,
          protocolVersion: version.protocolVersion,
          revision: version.revision,
          jsVersion: version.jsVersion,
        }
      } finally {
        browser.close()
      }
    } catch {
      chrome = { reachable: false }
    }
    const roles = this.#extension.getReadyRoles()
    const ready = chrome.reachable && extension.coherent && !this.#closing
    return {
      status: ready ? 'ready' : 'not-ready',
      versions: {
        standalone: REMOTE_TAB_STANDALONE_VERSION,
        core: REMOTE_TAB_CORE_VERSION,
        controlProtocol: PROTOCOL_VERSION,
        chrome,
        extension,
      },
      checks: {
        cdp: chrome.reachable ? 'reachable' : 'unreachable',
        extensionServiceWorker: roles.includes('service-worker') ? 'connected' : 'disconnected',
        extensionMedia: roles.includes('media') ? 'connected' : 'disconnected',
        extensionVersions: extension.coherent ? 'coherent' : 'mismatch-or-incomplete',
      },
      supportedCapabilities: CAPABILITIES,
    }
  }

  #authorize(request: IncomingMessage): void {
    const header = request.headers.authorization
    const expected = `Bearer ${this.#configuration.embedderApi.token}`
    if (typeof header !== 'string' || !safeEqual(header, expected)) {
      throw new ApiFailure(401, 'API_UNAUTHORIZED', 'Embedder API authentication failed')
    }
  }

  async #readJson(request: IncomingMessage): Promise<unknown> {
    const contentType = request.headers['content-type']
    if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
      throw new ApiFailure(415, 'API_UNSUPPORTED_MEDIA_TYPE', 'Request body must be JSON')
    }
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.byteLength
      if (size > this.#configuration.embedderApi.maxRequestBodyBytes) {
        throw new ApiFailure(413, 'API_REQUEST_TOO_LARGE', 'Request body exceeds the configured limit')
      }
      chunks.push(buffer)
    }
    if (size === 0) {
      throw new ApiFailure(400, 'API_INVALID_REQUEST', 'Request body is required')
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    } catch {
      throw new ApiFailure(400, 'API_INVALID_JSON', 'Request body is not valid JSON')
    }
  }

  #requireSession(sessionId: string): SessionRecord {
    const record = this.#sessions.get(sessionId)
    if (record === undefined) {
      throw new ApiFailure(404, 'SESSION_NOT_FOUND', 'Session was not found')
    }
    return record
  }

  #sendFailure(response: ServerResponse, cause: unknown): void {
    if (response.headersSent || response.writableEnded) {
      response.destroy()
      return
    }
    if (cause instanceof ApiFailure) {
      this.#sendJson(response, cause.status, {
        error: { code: cause.code, message: cause.message, retryable: cause.retryable },
      })
      return
    }
    if (cause instanceof RemoteTabError) {
      this.#sendJson(response, statusForRemoteTabError(cause), { error: cause.toJSON() })
      return
    }
    this.#sendJson(response, 500, {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Standalone request failed',
        retryable: false,
      } satisfies ApiFailureShape,
    })
  }

  #sendJson(response: ServerResponse, status: number, value: unknown): void {
    const body = JSON.stringify(value)
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    })
    response.end(body)
  }

  #sendPrometheusMetrics(response: ServerResponse): void {
    const states = new Map<string, number>()
    for (const state of STANDALONE_SESSION_STATES) states.set(state, 0)
    states.set('ATTACHING', this.#attaching.size)
    for (const record of this.#sessions.values()) {
      const state = record.session.getState()
      states.set(state, (states.get(state) ?? 0) + 1)
    }
    const lines = [
      '# HELP browshare_remote_tab_standalone_sessions Current Sessions by bounded lifecycle state.',
      '# TYPE browshare_remote_tab_standalone_sessions gauge',
      ...[...states].map(
        ([state, count]) => `browshare_remote_tab_standalone_sessions{state="${state}"} ${count}`,
      ),
      '# HELP browshare_remote_tab_standalone_sessions_max Configured attached and attaching Session capacity.',
      '# TYPE browshare_remote_tab_standalone_sessions_max gauge',
      `browshare_remote_tab_standalone_sessions_max ${this.#configuration.maxSessions}`,
    ]
    const body = `${lines.join('\n')}\n`
    response.writeHead(200, {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    })
    response.end(body)
  }

  #diagnose(event: StandaloneDiagnosticEvent): void {
    try {
      this.#onDiagnostic?.(event)
    } catch {
      // Observability must not interrupt Session or API lifecycle.
    }
  }
}

function isTerminalState(state: RemoteTabState): boolean {
  return state === 'FAILED' || state === 'CLOSED'
}

const STANDALONE_SESSION_STATES = [
  'READY',
  'NEGOTIATING',
  'CONNECTED',
  'SUSPENDED',
  'RECONNECTING',
  'FAILED',
  'CLOSED',
] as const satisfies readonly RemoteTabState[]

function toSessionJson(
  record: SessionRecord,
  includeAttachment = false,
): Readonly<Record<string, unknown>> {
  return {
    sessionId: record.session.id,
    state: record.session.getState(),
    ...(includeAttachment ? { attachment: record.session.getAttachment() } : {}),
    viewerGeneration: record.viewerGeneration,
    capabilities: record.capabilities,
    gatewayId: record.gatewayId,
    endpoint: record.endpoint,
  }
}

function safeEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new ApiFailure(400, 'API_INVALID_REQUEST', 'Session path is invalid')
  }
}

function assertSignalingEndpoint(value: string): void {
  let endpoint: URL
  try {
    endpoint = new URL(value)
  } catch {
    throw new ApiFailure(400, 'API_INVALID_REQUEST', 'Signaling endpoint is invalid')
  }
  if (endpoint.protocol !== 'ws:' && endpoint.protocol !== 'wss:') {
    throw new ApiFailure(400, 'API_INVALID_REQUEST', 'Signaling endpoint must use WebSocket')
  }
  if (endpoint.username.length > 0 || endpoint.password.length > 0) {
    throw new ApiFailure(400, 'API_INVALID_REQUEST', 'Signaling endpoint must not contain credentials')
  }
}

function statusForRemoteTabError(error: RemoteTabError): number {
  const conflicts = new Set(['TAB_ALREADY_ATTACHED', 'VIEWER_REPLACED', 'ILLEGAL_STATE_TRANSITION'])
  if (conflicts.has(error.code)) return 409
  if (error.code === 'TAB_NOT_FOUND') return 404
  if (error.retryable) return 503
  return 400
}
