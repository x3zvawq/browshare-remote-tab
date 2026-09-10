import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import {
  ExtensionLoopbackServer,
  type AttachSessionInput,
  type RemoteTabSession,
  type ViewerTicketRequest,
} from '@browshare/remote-tab-core'
import { CAPABILITIES, HmacViewerTicketCodec, type Capability, type RemoteTabState } from '@browshare/remote-tab-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'

import {
  LocalSessionStorage,
  StandaloneDaemon,
  loadStandaloneConfiguration,
  type StandaloneConfiguration,
  type StandaloneCore,
} from '../src/index.js'

const daemons: StandaloneDaemon[] = []
const cdpServers: WebSocketServer[] = []

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.close('test cleanup')))
  await Promise.all(
    cdpServers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  )
})

describe('Standalone configuration', () => {
  it('loads required secrets and conservative loopback defaults from the environment', () => {
    const configuration = loadStandaloneConfiguration({
      BROWSHARE_REMOTE_TAB_CDP_ENDPOINT: 'http://127.0.0.1:9222',
      BROWSHARE_REMOTE_TAB_API_TOKEN: 'a'.repeat(32),
      BROWSHARE_REMOTE_TAB_EXTENSION_ID: 'b'.repeat(32),
      BROWSHARE_REMOTE_TAB_RUNTIME_SECRET: 'c'.repeat(32),
      BROWSHARE_REMOTE_TAB_RUNTIME_GENERATION: 'runtime-1',
      BROWSHARE_REMOTE_TAB_VIEWER_TICKET_SECRET: 'd'.repeat(32),
      BROWSHARE_REMOTE_TAB_TEMP_ROOT: '/tmp/remote-tab-test',
    })

    expect(configuration).toMatchObject({
      cdpEndpoint: 'http://127.0.0.1:9222',
      embedderApi: { host: '127.0.0.1', port: 9230 },
      extension: { host: '127.0.0.1', port: 9224, id: 'b'.repeat(32) },
      maxSessions: 16,
    })
  })

  it('fails before startup when required configuration is missing', () => {
    expect(() => loadStandaloneConfiguration({})).toThrow(
      /BROWSHARE_REMOTE_TAB_CDP_ENDPOINT/u,
    )
  })
})

describe('LocalSessionStorage', () => {
  it('writes exact-size Session files and removes them with Session cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'remote-tab-storage-'))
    const storage = new LocalSessionStorage(root)
    const reservation = await storage.reserve({
      sessionId: 'session-1',
      transferId: 'transfer-1',
      direction: 'upload',
      displayName: 'example.txt',
      declaredSize: 5,
      mimeType: 'text/plain',
    })
    await reservation.write(0, new TextEncoder().encode('hello'))
    const stored = await reservation.commit()
    expect(await readFile(stored.localPath, 'utf8')).toBe('hello')
    expect(stored).toMatchObject({ displayName: 'example.txt', size: 5, mimeType: 'text/plain' })
    expect(basename(stored.localPath)).toBe('example.txt')

    await storage.cleanupSession('session-1')
    await expect(readFile(stored.localPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects chunks beyond the declared reservation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'remote-tab-storage-limit-'))
    const storage = new LocalSessionStorage(root)
    const reservation = await storage.reserve({
      sessionId: 'session-2',
      transferId: 'transfer-2',
      direction: 'download',
      displayName: 'example.bin',
      declaredSize: 2,
    })
    await expect(reservation.write(0, new Uint8Array(3))).rejects.toMatchObject({
      code: 'FILE_LIMIT_EXCEEDED',
    })
    await reservation.abort()
  })

  it('supports zero-byte files and lets a failed consumer discard a committed file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'remote-tab-storage-empty-'))
    const storage = new LocalSessionStorage(root)
    const reservation = await storage.reserve({
      sessionId: 'session-empty',
      transferId: 'transfer-empty',
      direction: 'upload',
      displayName: 'empty.txt',
      declaredSize: 0,
    })
    const stored = await reservation.commit()
    expect(await readFile(stored.localPath)).toHaveLength(0)

    await reservation.abort('The file chooser rejected the committed path')
    await expect(readFile(stored.localPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps storage paths confined when called with a path-like display name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'remote-tab-storage-name-'))
    const storage = new LocalSessionStorage(root)
    const reservation = await storage.reserve({
      sessionId: 'session-name',
      transferId: 'transfer/name',
      direction: 'upload',
      displayName: '..',
      declaredSize: 0,
    })
    const stored = await reservation.commit()
    expect(stored.localPath.startsWith(`${root}/.sessions/session-name/transfer%2Fname/`)).toBe(true)
    expect(basename(stored.localPath)).toMatch(/^file-/u)
    await storage.cleanupSession('session-name')
  })

  it('clears only the private Session subtree during startup reconciliation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'remote-tab-storage-reconcile-'))
    await mkdir(join(root, '.sessions', 'crashed-session'), { recursive: true })
    await writeFile(join(root, '.sessions', 'crashed-session', 'stale.bin'), 'stale')
    await writeFile(join(root, 'embedder-owned.txt'), 'preserve')

    const storage = new LocalSessionStorage(root)
    await storage.initialize()

    await expect(
      readFile(join(root, '.sessions', 'crashed-session', 'stale.bin')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(root, 'embedder-owned.txt'), 'utf8')).resolves.toBe('preserve')
  })
})

describe('Standalone Embedder API', () => {
  it('accepts every supported capability across creation, tickets and updates while rejecting invalid lists', async () => {
    const core = new FakeCore()
    const configuration = await testConfiguration()
    const daemon = new StandaloneDaemon(configuration, { core })
    daemons.push(daemon)
    const address = await daemon.start()
    const baseUrl = `http://${address.host}:${address.port}`
    const input = {
      sessionId: 'all-capabilities',
      tab: { mode: 'create' },
      childTargetPolicy: 'retain',
      capabilities: [...CAPABILITIES],
      signaling: {
        gatewayId: 'gateway-1',
        coreEndpoint: 'ws://127.0.0.1:8081',
        viewerEndpoint: 'wss://signal.example.test/remote-tab',
        bindingToken: 'binding-token',
      },
      navigationPolicy: 'allow-all',
    }
    const created = await api(baseUrl, configuration, '/v1/sessions', {
      method: 'POST', body: input,
    })
    expect(created.status).toBe(201)
    expect(core.inputs[0]?.capabilities).toEqual(CAPABILITIES)
    const sessionPath = '/v1/sessions/all-capabilities'
    const ticket = await api(baseUrl, configuration, `${sessionPath}/viewer-tickets`, {
      method: 'POST', body: { capabilities: [...CAPABILITIES], expiresInSeconds: 60 },
    })
    expect(ticket.status).toBe(201)
    await expect(ticket.json()).resolves.toMatchObject({ viewerGeneration: 1 })
    const updated = await api(baseUrl, configuration, `${sessionPath}/capabilities`, {
      method: 'PUT', body: { capabilities: [...CAPABILITIES] },
    })
    expect(updated.status).toBe(200)
    await expect(updated.json()).resolves.toMatchObject({ capabilities: [...CAPABILITIES] })

    for (const capabilities of [['navigation', 'unknown-capability'], ['navigation', 'navigation']]) {
      for (const [path, method, body] of [
        ['/v1/sessions', 'POST', { ...input, sessionId: 'invalid-capabilities', capabilities }],
        [`${sessionPath}/viewer-tickets`, 'POST', { capabilities, expiresInSeconds: 60 }],
        [`${sessionPath}/capabilities`, 'PUT', { capabilities }],
      ] as const) {
        const rejected = await api(baseUrl, configuration, path, { method, body })
        expect(rejected.status).toBe(400)
        await expect(rejected.json()).resolves.toMatchObject({ error: { code: 'API_INVALID_REQUEST' } })
      }
    }
    expect(core.inputs).toHaveLength(1)
    const current = await api(baseUrl, configuration, sessionPath, { method: 'GET' })
    await expect(current.json()).resolves.toMatchObject({ viewerGeneration: 1, capabilities: [...CAPABILITIES] })
  })

  it('authenticates, owns generation allocation, and manages a complete Session lifecycle', async () => {
    const fakeCore = new FakeCore()
    const cdp = await createTargetListCdpFixture([
      'target-session-1',
      'orphan-target',
    ])
    const configuration = {
      ...(await testConfiguration()),
      cdpEndpoint: cdp.endpoint,
    }
    const extension = new ExtensionLoopbackServer({
      port: 0,
      extensionId: configuration.extension.id,
      runtimeGeneration: configuration.extension.runtimeGeneration,
      runtimeSecret: configuration.extension.runtimeSecret,
    })
    const diagnostics = vi.fn()
    const daemon = new StandaloneDaemon(configuration, {
      core: fakeCore,
      extension,
      onDiagnostic: diagnostics,
    })
    daemons.push(daemon)
    const address = await daemon.start()
    const baseUrl = `http://${address.host}:${address.port}`

    const live = await fetch(`${baseUrl}/health/live`)
    expect(live.status).toBe(200)
    const notReady = await fetch(`${baseUrl}/health/ready`)
    expect(notReady.status).toBe(503)

    const unauthorized = await fetch(`${baseUrl}/v1/sessions`)
    expect(unauthorized.status).toBe(401)
    await expect(unauthorized.json()).resolves.toMatchObject({
      error: { code: 'API_UNAUTHORIZED' },
    })
    const unauthorizedReconciliation = await fetch(
      `${baseUrl}/v1/reconciliation/targets`,
    )
    expect(unauthorizedReconciliation.status).toBe(401)

    const capabilities = await api(
      baseUrl,
      configuration,
      '/v1/diagnostics/capabilities',
      { method: 'GET' },
    )
    expect(capabilities.status).toBe(200)
    const capabilityReport = await capabilities.json()
    expect(capabilityReport).toMatchObject({
      status: 'not-ready',
      versions: {
        standalone: '0.1.25',
        core: '0.1.25',
        controlProtocol: { major: 1, minor: 6 },
        extension: { extensionId: configuration.extension.id, coherent: false },
      },
    })
    expect(JSON.stringify(capabilityReport)).not.toContain(configuration.extension.runtimeSecret)

    const create = await api(baseUrl, configuration, '/v1/sessions', {
      method: 'POST',
      body: {
        sessionId: 'session-1',
        tab: { mode: 'create', initialUrl: 'https://example.test/' },
        capabilities: ['navigation', 'reload'],
        signaling: {
          gatewayId: 'gateway-1',
          coreEndpoint: 'ws://127.0.0.1:8081',
          viewerEndpoint: 'wss://signal.example.test/remote-tab',
          bindingToken: 'binding-token',
          connectionTimeoutMs: 10_000,
        },
        navigationPolicy: 'allow-all',
        childTargetPolicy: 'close-and-local-open',
        localOpenRequestTimeoutMs: 45_000,
      },
    })
    expect(create.status).toBe(201)
    await expect(create.json()).resolves.toMatchObject({
      sessionId: 'session-1',
      state: 'READY',
      viewerGeneration: 0,
      capabilities: ['navigation', 'reload'],
    })
    expect(fakeCore.inputs[0]?.cdpEndpoint).toBe(configuration.cdpEndpoint)
    expect(fakeCore.inputs[0]).toMatchObject({
      childTargetPolicy: 'close-and-local-open',
      localOpenRequestTimeoutMs: 45_000,
    })
    const metrics = await fetch(`${baseUrl}/metrics`)
    expect(metrics.status).toBe(200)
    expect(metrics.headers.get('content-type')).toContain('text/plain; version=0.0.4')
    const metricsBody = await metrics.text()
    expect(metricsBody).toContain(
      'browshare_remote_tab_standalone_sessions{state="READY"} 1',
    )
    expect(metricsBody).toContain('browshare_remote_tab_standalone_sessions_max 1')
    expect(metricsBody).not.toContain('session-1')
    const reconciliation = await api(
      baseUrl,
      configuration,
      '/v1/reconciliation/targets',
      { method: 'GET' },
    )
    expect(reconciliation.status).toBe(200)
    await expect(reconciliation.json()).resolves.toEqual({
      targets: [
        {
          targetId: 'target-session-1',
          status: 'tracked',
          sessionId: 'session-1',
        },
        { targetId: 'orphan-target', status: 'untracked' },
      ],
      trackedSessionCount: 1,
      attachingSessionCount: 0,
    })
    expect(cdp.methods.filter((method) => method === 'Target.getTargets')).toHaveLength(1)
    expect(cdp.methods).not.toContain('Target.closeTarget')
    await expect(
      fakeCore.inputs[0]?.hooks.authorizeNavigation({
        sessionId: 'session-1',
        action: 'go',
        url: 'https://example.test/next',
      }),
    ).resolves.toMatchObject({ allowed: true, url: 'https://example.test/next' })

    for (const viewerGeneration of [1, 2]) {
      const ticket = await api(
        baseUrl,
        configuration,
        '/v1/sessions/session-1/viewer-tickets',
        { method: 'POST', body: { expiresInSeconds: 60 } },
      )
      expect(ticket.status).toBe(201)
      await expect(ticket.json()).resolves.toMatchObject({
        sessionId: 'session-1',
        viewerGeneration,
        endpoint: 'wss://signal.example.test/remote-tab',
      })
    }

    const notice = await api(baseUrl, configuration, '/v1/sessions/session-1/notices', {
      method: 'POST',
      body: { level: 'info', code: 'SESSION_HINT', message: 'The Session is ready.' },
    })
    expect(notice.status).toBe(204)
    expect(fakeCore.sessions[0]?.notices).toEqual([
      { level: 'info', code: 'SESSION_HINT', message: 'The Session is ready.' },
    ])

    const update = await api(
      baseUrl,
      configuration,
      '/v1/sessions/session-1/capabilities',
      { method: 'PUT', body: { capabilities: ['navigation'] } },
    )
    expect(update.status).toBe(200)
    await expect(update.json()).resolves.toMatchObject({ capabilities: ['navigation'] })

    const secondSessionRequest = {
      method: 'POST',
      body: {
        sessionId: 'session-2',
        tab: { mode: 'create' },
        capabilities: [],
        signaling: {
          gatewayId: 'gateway-1',
          coreEndpoint: 'ws://127.0.0.1:8081',
          viewerEndpoint: 'wss://signal.example.test/remote-tab',
          bindingToken: 'binding-token',
        },
        navigationPolicy: 'deny-all',
      },
    } as const
    const capacity = await api(baseUrl, configuration, '/v1/sessions', secondSessionRequest)
    expect(capacity.status).toBe(429)

    await fakeCore.sessions[0]?.fail('Extension media runtime disconnected')
    const afterFailure = await api(baseUrl, configuration, '/v1/sessions', { method: 'GET' })
    await expect(afterFailure.json()).resolves.toEqual({ sessions: [] })

    const replacement = await api(
      baseUrl,
      configuration,
      '/v1/sessions',
      secondSessionRequest,
    )
    expect(replacement.status).toBe(201)

    const remove = await api(baseUrl, configuration, '/v1/sessions/session-2', {
      method: 'DELETE',
    })
    expect(remove.status).toBe(204)
    expect(fakeCore.sessions[1]?.closed).toBe(true)
    expect(diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'api.started', port: address.port }),
    )
  })
})

class FakeCore implements StandaloneCore {
  public readonly inputs: AttachSessionInput[] = []
  public readonly sessions: FakeSession[] = []

  public async attachSession(input: AttachSessionInput): Promise<RemoteTabSession> {
    this.inputs.push(input)
    const session = new FakeSession(input)
    this.sessions.push(session)
    return session
  }

  public async close(): Promise<void> {
    await Promise.all(this.sessions.map((session) => session.close('fake Core closed')))
  }
}

async function createTargetListCdpFixture(
  targetIds: readonly string[],
): Promise<{ endpoint: string; methods: string[] }> {
  const methods: string[] = []
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  cdpServers.push(server)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  server.on('connection', (socket) => {
    socket.on('message', (data) => {
      const command = JSON.parse(data.toString()) as { id: number; method: string }
      methods.push(command.method)
      socket.send(
        JSON.stringify({
          id: command.id,
          result: {
            targetInfos: [
              ...targetIds.map((targetId) => ({ targetId, type: 'page' })),
              { targetId: 'extension-worker', type: 'service_worker' },
            ],
          },
        }),
      )
    })
  })
  const address = server.address() as AddressInfo
  return {
    endpoint: `ws://127.0.0.1:${address.port}/devtools/browser/mock`,
    methods,
  }
}

class FakeSession implements RemoteTabSession {
  public readonly id: string
  public closed = false
  public readonly notices: Array<{
    level: 'info' | 'warning' | 'error'
    code: string
    message: string
  }> = []
  #state: RemoteTabState = 'READY'
  #capabilities: Capability[]
  readonly #input: AttachSessionInput

  public constructor(input: AttachSessionInput) {
    this.id = input.sessionId
    this.#input = input
    this.#capabilities = [...input.capabilities]
  }

  public getState(): RemoteTabState {
    return this.#state
  }

  public getAttachment() {
    return {
      targetId: this.#input.tab.mode === 'adopt' ? this.#input.tab.targetId : `target-${this.id}`,
      tabId: 17,
    }
  }

  public createViewerTicket(input: Omit<ViewerTicketRequest, 'sessionId'>) {
    this.#state = 'NEGOTIATING'
    return this.#input.ticketIssuer.issueViewerTicket({ ...input, sessionId: this.id })
  }

  public async updateCapabilities(next: readonly Capability[]): Promise<void> {
    this.#capabilities = [...next]
  }

  public sendNotice(notice: { level: 'info' | 'warning' | 'error'; code: string; message: string }): void {
    this.notices.push(notice)
  }

  public async fail(reason: string): Promise<void> {
    const previous = this.#state
    this.#state = 'FAILED'
    await this.#input.hooks.onStateChanged({
      sessionId: this.id,
      previous,
      current: this.#state,
      reason,
    })
  }

  public async close(): Promise<void> {
    this.closed = true
    this.#state = 'CLOSED'
  }
}

async function testConfiguration(): Promise<StandaloneConfiguration> {
  return {
    cdpEndpoint: 'ws://127.0.0.1:9/devtools/browser/unreachable',
    embedderApi: {
      host: '127.0.0.1',
      port: 0,
      token: 'api-token-0123456789abcdef0123456789',
      maxRequestBodyBytes: 65_536,
    },
    extension: {
      host: '127.0.0.1',
      port: 0,
      id: 'e'.repeat(32),
      runtimeSecret: 'runtime-secret-0123456789abcdef0123',
      runtimeGeneration: 'test-runtime',
      requestTimeoutMs: 1_000,
    },
    viewerTickets: {
      secret: 'viewer-ticket-secret-0123456789abcdef',
      issuer: 'standalone-test',
      audience: 'remote-tab-viewer',
      maximumLifetimeSeconds: 120,
    },
    tempRoot: await mkdtemp(join(tmpdir(), 'remote-tab-daemon-')),
    maxSessions: 1,
  }
}

function api(
  baseUrl: string,
  configuration: StandaloneConfiguration,
  path: string,
  input: { method: string; body?: unknown },
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: input.method,
    headers: {
      authorization: `Bearer ${configuration.embedderApi.token}`,
      ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  })
}
