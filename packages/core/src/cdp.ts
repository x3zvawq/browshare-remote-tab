import { rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import WebSocket from 'ws'

import {
  PAGE_SCRIPT_EVENTS,
  RemoteTabError,
  type PageScriptEventName,
} from '@browshare/remote-tab-protocol'

import { PageScriptNotices, PAGE_NOTICE_BINDING, createPageNoticeBootstrap, pageNoticeReplyExpression, type PageScriptNoticeHandler } from './page-script-notices.js'

import type { NavigationDecision, TabAttachment, RemoteTabCloseOptions } from './contracts.js'

interface CdpCommand {
  id: number
  method: string
  params?: Readonly<Record<string, unknown>>
  sessionId?: string
}

interface CdpErrorResponse {
  code: number
  message: string
}

interface CdpResponse {
  id: number
  result?: unknown
  error?: CdpErrorResponse
}

interface CdpEvent {
  method: string
  params: Readonly<Record<string, unknown>>
  sessionId?: string
}

interface PendingCommand {
  method: string
  timer: ReturnType<typeof setTimeout>
  resolve(value: unknown): void
  reject(reason: unknown): void
}

type CdpEventListener = (event: CdpEvent) => void
type CdpConnectionCloseListener = (error: RemoteTabError) => void

class CdpConnection {
  readonly #socket: WebSocket
  readonly #requestTimeoutMs: number
  readonly #pending = new Map<number, PendingCommand>()
  readonly #listeners = new Set<CdpEventListener>()
  readonly #closeListeners = new Set<CdpConnectionCloseListener>()
  #nextId = 0
  #closed = false

  private constructor(socket: WebSocket, requestTimeoutMs: number) {
    this.#socket = socket
    this.#requestTimeoutMs = requestTimeoutMs
    socket.on('message', (data, isBinary) => {
      if (!isBinary) {
        this.#handleMessage(data.toString())
      }
    })
    socket.on('close', () => this.#handleClose())
    socket.on('error', () => this.#handleClose())
  }

  public static async connect(webSocketUrl: string, requestTimeoutMs: number): Promise<CdpConnection> {
    const socket = new WebSocket(webSocketUrl, { maxPayload: 16 * 1024 * 1024 })

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate()
        reject(
          new RemoteTabError('CHROME_CONNECTION_FAILED', 'Timed out connecting to the Chrome CDP endpoint'),
        )
      }, requestTimeoutMs)

      const cleanup = (): void => {
        clearTimeout(timer)
        socket.off('open', handleOpen)
        socket.off('error', handleError)
      }
      const handleOpen = (): void => {
        cleanup()
        resolve()
      }
      const handleError = (cause: Error): void => {
        cleanup()
        reject(
          new RemoteTabError('CHROME_CONNECTION_FAILED', 'Could not connect to the Chrome CDP endpoint', {
            cause,
          }),
        )
      }

      socket.once('open', handleOpen)
      socket.once('error', handleError)
    })

    return new CdpConnection(socket, requestTimeoutMs)
  }

  public get open(): boolean { return !this.#closed && this.#socket.readyState === WebSocket.OPEN }

  public call<Result = Readonly<Record<string, unknown>>>(
    method: string,
    params?: Readonly<Record<string, unknown>>,
    sessionId?: string,
    timeoutMs = this.#requestTimeoutMs,
  ): Promise<Result> {
    if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new RemoteTabError('CHROME_CONNECTION_FAILED', 'Chrome CDP connection is closed'),
      )
    }

    const id = ++this.#nextId
    const command: CdpCommand = {
      id,
      method,
      ...(params === undefined ? {} : { params }),
      ...(sessionId === undefined ? {} : { sessionId }),
    }

    return new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(
          new RemoteTabError('CDP_COMMAND_TIMEOUT', `Chrome CDP command timed out: ${method}`, {
            retryable: true,
            details: { method },
          }),
        )
      }, timeoutMs)

      this.#pending.set(id, {
        method,
        timer,
        resolve: (value) => resolve(value as Result),
        reject,
      })

      this.#socket.send(JSON.stringify(command), (error) => {
        if (error == null) {
          return
        }

        const pending = this.#pending.get(id)
        if (pending !== undefined) {
          clearTimeout(pending.timer)
          this.#pending.delete(id)
          pending.reject(
            new RemoteTabError('CHROME_CONNECTION_FAILED', 'Chrome CDP command could not be sent', {
              cause: error,
              retryable: true,
              details: { method },
            }),
          )
        }
      })
    })
  }

  public onEvent(listener: CdpEventListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  public onClose(listener: CdpConnectionCloseListener): () => void {
    if (this.#closed) {
      listener(chromeConnectionClosedError())
      return () => undefined
    }
    this.#closeListeners.add(listener)
    return () => this.#closeListeners.delete(listener)
  }

  public close(): void {
    if (!this.#closed) {
      this.#socket.close()
      this.#handleClose()
    }
  }

  #handleMessage(raw: string): void {
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      return
    }

    if (!isRecord(value)) {
      return
    }

    if (typeof value.id === 'number') {
      const pending = this.#pending.get(value.id)
      if (pending === undefined) {
        return
      }

      clearTimeout(pending.timer)
      this.#pending.delete(value.id)
      const response = value as unknown as CdpResponse
      if (isRecord(response.error) && typeof response.error.message === 'string') {
        pending.reject(
          new RemoteTabError('CDP_COMMAND_FAILED', `Chrome CDP command failed: ${pending.method}`, {
            details: {
              method: pending.method,
              cdpCode: typeof response.error.code === 'number' ? response.error.code : 0,
            },
          }),
        )
      } else {
        pending.resolve(response.result ?? {})
      }
      return
    }

    if (typeof value.method === 'string') {
      const event: CdpEvent = {
        method: value.method,
        params: isRecord(value.params) ? value.params : {},
        ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}),
      }
      for (const listener of this.#listeners) {
        listener(event)
      }
    }
  }

  #handleClose(): void {
    if (this.#closed) {
      return
    }

    this.#closed = true
    const error = chromeConnectionClosedError()
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
    for (const listener of this.#closeListeners) {
      listener(error)
    }
    this.#closeListeners.clear()
  }
}

function chromeConnectionClosedError(): RemoteTabError {
  return new RemoteTabError('CHROME_CONNECTION_FAILED', 'Chrome CDP connection closed', {
    retryable: true,
  })
}

function safeNavigationUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined
    return url.href
  } catch {
    return undefined
  }
}

export interface CdpBrowserOptions {
  requestTimeoutMs?: number
  fetch?: typeof globalThis.fetch
  downloadDirectory?: string
}

export interface ResolveTabIdRequest {
  targetId: string
}

export interface TabIdentityResolver {
  resolveTabId(request: ResolveTabIdRequest): Promise<number>
  releaseTarget?(targetId: string): void
}

export interface AttachedCdpTab {
  targetId: string
  tabId: number
  controller: CdpTabController
}

interface CreateTargetResult {
  targetId: string
}

interface AttachTargetResult {
  sessionId: string
}

interface TargetInfo {
  targetId: string
  type: string
  url: string
  openerId?: string
  title?: string
}

interface GetTargetsResult {
  targetInfos: TargetInfo[]
}

const LOCAL_OPEN_BINDING = '__browshareRemoteTabOpen'
const PAGE_SCRIPT_BINDING = '__browshareRemoteTabPageScript'
const TITLE_BINDING = '__browshareRemoteTabTitle'
const TITLE_WORLD = 'browshare.remote-tab.title'
// Chrome does not reliably emit Target.targetInfoChanged for title edits while a page is attached.
const TITLE_OBSERVER = String.raw`(() => {
  if (window !== window.top || globalThis.__browshareTitleObserved) return
  globalThis.__browshareTitleObserved = true
  const publish = globalThis.__browshareRemoteTabTitle
  let previous, root, head
  const send = () => {
    const title = [...document.title].slice(0, 4096).join('')
    if (title !== previous) { previous = title; publish(title) }
  }
  const titleObserver = new MutationObserver(send)
  const rootObserver = new MutationObserver(bind)
  function bind() {
    if (root !== document.documentElement) {
      rootObserver.disconnect()
      root = document.documentElement
      if (root) rootObserver.observe(root, { childList: true })
    }
    const next = document.head || document.documentElement
    if (head !== next) {
      titleObserver.disconnect()
      head = next
      if (head) titleObserver.observe(head, { childList: true, subtree: true, characterData: true })
    }
    send()
  }
  new MutationObserver(bind).observe(document, { childList: true })
  window.addEventListener('pageshow', bind)
  bind()
})()`
const PAGE_SCRIPT_MARKER = 'browshare.remote-tab.page-script'
const PAGE_SCRIPT_SOURCE_URL = 'browshare-page-script.js'
const PAGE_SCRIPT_EVENT_NAMES = new Set<string>(PAGE_SCRIPT_EVENTS)
const LOCAL_OPEN_HOOK = String.raw`(() => {
  const marker = Symbol.for('browshare.remote-tab.window-open')
  if (globalThis[marker] === true) return
  globalThis[marker] = true
  const binding = globalThis.__browshareRemoteTabOpen
  const originalOpen = globalThis.open
  if (typeof binding !== 'function' || typeof originalOpen !== 'function') return
  Object.defineProperty(globalThis, 'open', {
    configurable: false,
    writable: false,
    value(url, target, features) {
      const normalizedTarget = typeof target === 'string' ? target.toLowerCase() : '_blank'
      if (normalizedTarget === '_self' || normalizedTarget === '_parent' || normalizedTarget === '_top') {
        return Reflect.apply(originalOpen, this, [url, target, features])
      }
      try {
        binding(JSON.stringify({ url: new URL(String(url ?? ''), location.href).href }))
      } catch {}
      return null
    },
  })
})()`

export interface ChromeCdpVersion {
  protocolVersion: string
  product: string
  revision: string
  userAgent: string
  jsVersion: string
}

export interface CdpPageTarget {
  targetId: string
}

// Browser interception and Session cleanup can observe the same child concurrently.
async function closeObservedChild(connection: CdpConnection, targetId: string): Promise<void> {
  try {
    const result = await connection.call<{ success: boolean }>('Target.closeTarget', { targetId })
    if (!result.success) throw new RemoteTabError('CDP_COMMAND_FAILED', 'Chrome did not close the owned target')
  } catch (cause) {
    const { targetInfos } = await connection.call<GetTargetsResult>('Target.getTargets')
    if (targetInfos.some(target => target.targetId === targetId)) throw cause
  }
}

interface ChildTargetInterceptionOwner {
  ownsTarget(targetId: string): boolean
  failed(error: RemoteTabError): void
}

// Chrome only pauses popup startup at the browser Target domain. All controllers for one
// browser share this owner so an unrelated Session cannot resume a child we must close.
class BrowserChildTargetInterception {
  static readonly instances = new Map<string, BrowserChildTargetInterception>()
  readonly owners = new Set<ChildTargetInterceptionOwner>()
  readonly ready: Promise<CdpConnection>

  private constructor(readonly endpoint: string, requestTimeoutMs: number) {
    this.ready = CdpConnection.connect(endpoint, requestTimeoutMs).then(async connection => {
      connection.onClose(error => {
        if (BrowserChildTargetInterception.instances.get(endpoint) === this) {
          BrowserChildTargetInterception.instances.delete(endpoint)
        }
        for (const owner of this.owners) owner.failed(error)
      })
      connection.onEvent(event => {
        if (event.method !== 'Target.attachedToTarget') return
        const { sessionId, targetInfo, waitingForDebugger } = event.params
        if (typeof sessionId !== 'string' || !isRecord(targetInfo) || typeof targetInfo.targetId !== 'string') return
        const owner = typeof targetInfo.openerId === 'string'
          ? [...this.owners].find(candidate => candidate.ownsTarget(targetInfo.openerId as string))
          : undefined
        const operation = async (): Promise<void> => {
          if (owner !== undefined) {
            // Close while the renderer is paused, before even its first Document request.
            await closeObservedChild(connection, targetInfo.targetId as string)
          } else {
            if (waitingForDebugger === true) await connection.call('Runtime.runIfWaitingForDebugger', {}, sessionId)
            await connection.call('Target.detachFromTarget', { sessionId })
          }
        }
        void operation().catch(() => {
          // A target can close itself between notification and detach. An owned target
          // failure must end its Session instead of releasing potentially unauthorized work.
          owner?.failed(new RemoteTabError('CHROME_CONNECTION_FAILED', 'Could not close an intercepted child target'))
        })
      })
      try {
        await connection.call('Target.setAutoAttach', {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true,
          filter: [{ type: 'page', exclude: false }],
        })
        return connection
      } catch (cause) {
        connection.close()
        throw cause
      }
    })
  }

  static async acquire(endpoint: string, requestTimeoutMs: number, owner: ChildTargetInterceptionOwner): Promise<() => void> {
    let shared = this.instances.get(endpoint)
    if (shared === undefined) {
      shared = new BrowserChildTargetInterception(endpoint, requestTimeoutMs)
      this.instances.set(endpoint, shared)
    }
    const instance = shared
    instance.owners.add(owner)
    try {
      const connection = await instance.ready
      return () => {
        instance.owners.delete(owner)
        if (instance.owners.size === 0) {
          if (this.instances.get(endpoint) === instance) this.instances.delete(endpoint)
          connection.close()
        }
      }
    } catch (cause) {
      instance.owners.delete(owner)
      if (this.instances.get(endpoint) === instance) this.instances.delete(endpoint)
      throw cause
    }
  }
}

export class CdpBrowser {
  readonly #failedAttachments = new Map<string, { ownsTarget(id: string): boolean; close(options?: RemoteTabCloseOptions): Promise<void> }>()
  readonly #connection: CdpConnection
  readonly #downloadDirectory: string | undefined
  readonly #webSocketUrl: string
  readonly #requestTimeoutMs: number

  private constructor(connection: CdpConnection, downloadDirectory: string | undefined, webSocketUrl: string, requestTimeoutMs: number) {
    this.#webSocketUrl = webSocketUrl
    this.#requestTimeoutMs = requestTimeoutMs
    this.#connection = connection
    this.#downloadDirectory = downloadDirectory
  }

  public static async connect(endpoint: string, options: CdpBrowserOptions = {}): Promise<CdpBrowser> {
    const requestTimeoutMs = options.requestTimeoutMs ?? 15_000
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new RangeError('requestTimeoutMs must be a positive safe integer')
    }

    const webSocketUrl = await resolveBrowserWebSocketUrl(
      endpoint,
      options.fetch ?? globalThis.fetch,
      requestTimeoutMs,
    )
    const connection = await CdpConnection.connect(webSocketUrl, requestTimeoutMs)
    if (options.downloadDirectory !== undefined) {
      if (!isAbsolute(options.downloadDirectory)) {
        connection.close()
        throw new TypeError('downloadDirectory must be an absolute path')
      }
      await connection.call('Browser.setDownloadBehavior', {
        behavior: 'allowAndName',
        downloadPath: options.downloadDirectory,
        eventsEnabled: true,
      }).catch((cause) => {
        connection.close()
        throw cause
      })
    }
    return new CdpBrowser(connection, options.downloadDirectory, webSocketUrl, requestTimeoutMs)
  }

  public async getVersion(): Promise<ChromeCdpVersion> {
    const result = await this.#connection.call<Record<string, unknown>>('Browser.getVersion')
    return {
      protocolVersion: requireString(
        result.protocolVersion,
        'Browser.getVersion did not return a protocolVersion',
      ),
      product: requireString(result.product, 'Browser.getVersion did not return a product'),
      revision: requireString(result.revision, 'Browser.getVersion did not return a revision'),
      userAgent: requireString(result.userAgent, 'Browser.getVersion did not return a userAgent'),
      jsVersion: requireString(result.jsVersion, 'Browser.getVersion did not return a jsVersion'),
    }
  }

  public async listPageTargets(): Promise<readonly CdpPageTarget[]> {
    const result = await this.#connection.call<GetTargetsResult>('Target.getTargets')
    return result.targetInfos
      .filter((target) => target.type === 'page')
      .map((target) => ({ targetId: target.targetId }))
  }

  public async closePageTarget(targetId: string): Promise<void> {
    let recovery: CdpConnection | undefined
    try {
      const connection = this.#connection.open ? this.#connection :
        recovery = await CdpConnection.connect(this.#webSocketUrl, this.#requestTimeoutMs)
      const { targetInfos } = await connection.call<GetTargetsResult>('Target.getTargets')
      if (!targetInfos.some(target => target.targetId === targetId && target.type === 'page'))
        throw new RemoteTabError('TAB_NOT_FOUND', 'The requested Chrome page target was not found')
      await closeObservedChild(connection, targetId)
    } finally { recovery?.close() }
  }

  public async attachTab(
    attachment: TabAttachment,
    identityResolver: TabIdentityResolver,
  ): Promise<AttachedCdpTab> {
    let targetId: string
    let created = false

    if (attachment.mode === 'create') {
      const result = await this.#connection.call<CreateTargetResult>('Target.createTarget', {
        url: attachment.initialUrl ?? 'about:blank',
      })
      targetId = requireString(result.targetId, 'Target.createTarget did not return a targetId')
      created = true
    } else {
      const result = await this.#connection.call<GetTargetsResult>('Target.getTargets')
      const target = result.targetInfos.find(
        (candidate) => candidate.targetId === attachment.targetId && candidate.type === 'page',
      )
      if (target === undefined) {
        throw new RemoteTabError('TAB_NOT_FOUND', 'The requested Chrome page target was not found')
      }
      targetId = target.targetId
    }

    let sessionId: string | undefined
    let identityResolved = false
    let controller: CdpTabControllerImplementation | undefined
    try {
      const attached = await this.#connection.call<AttachTargetResult>('Target.attachToTarget', {
        targetId,
        flatten: true,
      })
      sessionId = requireString(
        attached.sessionId,
        'Target.attachToTarget did not return a sessionId',
      )

      await Promise.all([
        this.#connection.call('Target.setDiscoverTargets', { discover: true }),
        this.#connection.call('Page.enable', {}, sessionId),
        this.#connection.call('Runtime.enable', {}, sessionId),
        this.#connection.call('DOM.enable', {}, sessionId),
        this.#connection.call(
          'Page.setInterceptFileChooserDialog',
          { enabled: true, cancel: false },
          sessionId,
        ),
      ])

      const tabId = await identityResolver.resolveTabId({ targetId })
      identityResolved = true
      if (!Number.isSafeInteger(tabId) || tabId < 0) {
        throw new RemoteTabError(
          'TARGET_MAPPING_FAILED',
          'The extension returned an invalid Chrome tab ID',
        )
      }

      controller = new CdpTabControllerImplementation(this.#connection, targetId, sessionId, this.#downloadDirectory, this.#webSocketUrl, this.#requestTimeoutMs)
      await controller.discoverChildren()
      return { targetId, tabId, controller }
    } catch (cause) {
      const provenTargets = new Set([targetId])
      const cleanup = async (options: RemoteTabCloseOptions = {}): Promise<void> => {
        if (created) {
          if (controller) await controller.close(options)
          else if (!options.browserClosed) {
            let recovery: CdpConnection | undefined
            try {
              const connection = this.#connection.open ? this.#connection :
                recovery = await CdpConnection.connect(this.#webSocketUrl, this.#requestTimeoutMs)
              const observeOwned = async (): Promise<string[]> => {
                const { targetInfos } = await connection.call<GetTargetsResult>('Target.getTargets')
                let changed = true
                while (changed) {
                  changed = false
                  for (const info of targetInfos) {
                    if (info.type === 'page' && info.openerId && provenTargets.has(info.openerId) && !provenTargets.has(info.targetId)) {
                      provenTargets.add(info.targetId)
                      changed = true
                    }
                  }
                }
                return targetInfos.filter(info => provenTargets.has(info.targetId)).map(info => info.targetId)
              }
              const owned = await observeOwned()
              const results = await Promise.allSettled(owned.filter(id => id !== targetId).map(id => closeObservedChild(connection, id)))
              try { await closeObservedChild(connection, targetId) }
              catch (reason) { results.push({ status: 'rejected', reason }) }
              const remaining = await observeOwned()
              const failure = results.find(result => result.status === 'rejected')
              if (failure?.status === 'rejected') throw failure.reason
              if (remaining.length) throw new RemoteTabError('CDP_COMMAND_FAILED', 'Owned attachment targets still require cleanup', { retryable: true })
            } finally { recovery?.close() }
          }
        } else {
          await controller?.detach().catch(() => undefined)
          if (sessionId !== undefined) await this.#connection.call('Target.detachFromTarget', { sessionId }).catch(() => undefined)
        }
        if (identityResolved) identityResolver.releaseTarget?.(targetId)
        this.#failedAttachments.delete(targetId)
      }
      if (created) this.#failedAttachments.set(targetId, {
        ownsTarget: id => provenTargets.has(id) || controller?.ownsTarget(id) === true,
        close: cleanup,
      })
      await cleanup().catch(() => undefined)

      if (cause instanceof RemoteTabError) {
        throw cause
      }
      throw new RemoteTabError(
        'TARGET_MAPPING_FAILED',
        'Chrome target could not be mapped to an extension tab',
        { cause },
      )
    }
  }

  /** Failed attachment ownership remains available to the Session manager until proven cleanup. */
  public ownsTargetPendingCleanup(targetId: string): boolean {
    return [...this.#failedAttachments.values()].some(entry => entry.ownsTarget(targetId))
  }

  public async cleanupFailedAttachments(options?: RemoteTabCloseOptions): Promise<void> {
    const results = await Promise.allSettled([...this.#failedAttachments.values()].map(entry => entry.close(options)))
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }

  public close(): void {
    this.#connection.close()
  }
}

export type CdpMouseEventType = 'mouseMoved' | 'mousePressed' | 'mouseReleased' | 'mouseWheel'
export type CdpMouseButton = 'none' | 'left' | 'middle' | 'right' | 'back' | 'forward'

export interface CdpPointerInput {
  type: CdpMouseEventType
  x: number
  y: number
  viewportRevision: number
  button: CdpMouseButton
  buttons: number
  modifiers: number
  clickCount: number
  deltaX?: number
  deltaY?: number
  pointerType?: 'mouse' | 'pen'
}

export type CdpKeyEventType = 'keyDown' | 'keyUp' | 'rawKeyDown' | 'char'

export interface CdpKeyInput {
  type: CdpKeyEventType
  key: string
  code: string
  text?: string
  unmodifiedText?: string
  modifiers: number
  windowsVirtualKeyCode?: number
  nativeVirtualKeyCode?: number
  autoRepeat?: boolean
  isKeypad?: boolean
}

export interface CdpViewportRequest {
  width: number
  height: number
  deviceScaleFactor: number
}

export interface CdpViewport {
  width: number
  height: number
  deviceScaleFactor: number
  revision: number
}

export interface CdpClipboardItem {
  mimeType: 'text/plain' | 'image/png'
  data: Uint8Array<ArrayBuffer>
}

export interface CdpTabLocationEvent {
  type: 'location-changed'
  url: string
}

export interface CdpTabTitleEvent {
  type: 'title-changed'
  title: string
}

export interface CdpFileChooserEvent {
  type: 'file-chooser-opened'
  backendNodeId: number
  multiple: boolean
}

export interface CdpChildTarget {
  readonly targetId: string
  readonly title: string
  readonly url: string
}

export interface CdpChildTargetChangedEvent {
  type: 'child-target-changed'
  target: CdpChildTarget
}

export interface CdpChildTargetClosedEvent {
  type: 'child-target-closed'
  targetId: string
}

export interface CdpChildTargetCreatedEvent {
  type: 'child-target-created'
  targetId: string
  url?: string
}

export interface CdpLocalOpenRequestedEvent {
  type: 'local-open-requested'
  url: string
}

export interface CdpDownloadProgressEvent {
  type: 'download-progress'
  guid: string
  receivedBytes: number
  totalBytes: number
  state: 'inProgress' | 'completed' | 'canceled'
}

export interface CdpDownloadCompletedEvent {
  type: 'download-completed'
  guid: string
  displayName: string
  localPath: string
  totalBytes: number
}

export interface CdpPageScriptLifecycleEvent {
  type: 'page-script-event'
  name: PageScriptEventName
  occurredAt: number
  location?: string
}

export interface CdpPageScriptErrorEvent {
  type: 'page-script-error'
  occurredAt: number
  message: string
}

export interface CdpTabUnavailableEvent {
  type: 'tab-unavailable'
  error: RemoteTabError
}

export interface CdpNavigationRequest {
  url: string
  currentUrl: string
  method: string
  isRedirect: boolean
}

export interface CdpNavigationBlockedEvent {
  type: 'navigation-blocked'
  reason: string
}

export type CdpTabEvent =
  | CdpTabLocationEvent
  | CdpTabTitleEvent
  | CdpFileChooserEvent
  | CdpChildTargetCreatedEvent
  | CdpChildTargetChangedEvent
  | CdpChildTargetClosedEvent
  | CdpLocalOpenRequestedEvent
  | CdpDownloadCompletedEvent
  | CdpDownloadProgressEvent
  | CdpPageScriptLifecycleEvent
  | CdpPageScriptErrorEvent
  | CdpTabUnavailableEvent
  | CdpNavigationBlockedEvent
export type CdpTabEventListener = (event: CdpTabEvent) => void

export interface CdpTabController {
  readonly targetId: string
  readonly viewport: CdpViewport | undefined
  onEvent(listener: CdpTabEventListener): () => void
  readonly title: string | undefined
  readonly currentUrl: string
  observeTitle(): Promise<void>
  sampleFrameChange(): Promise<boolean>
  setViewport(request: CdpViewportRequest): Promise<CdpViewport>
  dispatchPointer(input: CdpPointerInput): Promise<void>
  dispatchKey(input: CdpKeyInput): Promise<void>
  releaseInput(): Promise<void>
  insertText(text: string): Promise<void>
  readClipboard(): Promise<readonly CdpClipboardItem[]>
  writeClipboardAndPaste(items: readonly CdpClipboardItem[]): Promise<void>
  installPageScript(input: {
    sessionId: string
    source: string
    context?: Readonly<Record<string, unknown>>
    requestNotice?: PageScriptNoticeHandler
  }): Promise<void>
  dispatchPageScriptDetached(): Promise<void>
  setFileInputFiles(backendNodeId: number, files: readonly string[]): Promise<void>
  enableLocalOpenInterception(): Promise<void>
  ownsTarget(targetId: string): boolean
  getChildTargets(): readonly CdpChildTarget[]
  /** Detach CDP without closing the page or its owned descendants. */
  detach(): Promise<void>
  closeChildTarget(targetId: string): Promise<void>
  removeDownload(guid: string): Promise<void>
  enableNavigationInterception(
    authorize: (request: CdpNavigationRequest, signal: AbortSignal) => Promise<NavigationDecision>,
  ): Promise<void>
  navigateAuthorized(url: string): Promise<void>
  reload(): Promise<void>
  goHistory(direction: 'back' | 'forward'): Promise<boolean>
  close(options?: RemoteTabCloseOptions): Promise<void>
}

class CdpTabControllerImplementation implements CdpTabController {
  readonly #connection: CdpConnection
  readonly #pressedKeys = new Map<string, CdpKeyInput>()
  readonly #pressedButtons = new Map<string, CdpPointerInput>()
  readonly #sessionId: string
  readonly #targetId: string
  readonly #downloadDirectory: string | undefined
  readonly #listeners = new Set<CdpTabEventListener>()
  readonly #childTargets = new Map<string, CdpChildTarget>()
  #childrenDiscovered = false
  #retiredDuringDiscovery: Set<string> | undefined = new Set()
  readonly #downloads = new Map<string, { displayName: string; complete: boolean }>()
  readonly #pendingWindowOpens: Array<{ url: string; observedAt: number }> = []
  readonly #unsubscribe: () => void
  readonly #unsubscribeConnectionClose: () => void
  #releaseChildInterception: (() => void) | undefined
  #viewport: CdpViewport | undefined
  readonly #mainWorldContexts = new Map<number, { uniqueId: string; frameId: string }>()
  #pageScriptNotices: PageScriptNotices | undefined
  #pageScriptInstalled = false
  #mainFrameId: string | undefined
  #currentUrl = 'about:blank'
  #title: string | undefined
  #previousFrame: string | undefined
  #frameSample: Promise<boolean> | undefined
  #authorizeNavigation: ((request: CdpNavigationRequest, signal: AbortSignal) => Promise<NavigationDecision>) | undefined
  #pendingNavigation: { abort: AbortController; networkId: unknown; finished: Promise<void>; finish(): void } | undefined
  #unavailableError: RemoteTabError | undefined
  #closed = false
  #detached = false
  #rootClosed = false
  #browserClosed = false
  #closePromise: Promise<void> | undefined

  public constructor(
    connection: CdpConnection,
    targetId: string,
    sessionId: string,
    downloadDirectory: string | undefined,
    readonly browserWebSocketUrl: string,
    readonly requestTimeoutMs: number,
  ) {
    this.#connection = connection
    this.#targetId = targetId
    this.#sessionId = sessionId
    this.#downloadDirectory = downloadDirectory
    this.#unsubscribeConnectionClose = connection.onClose((error) => {
      this.#markUnavailable(error)
    })
    this.#unsubscribe = connection.onEvent((event) => {
      if (event.sessionId === undefined && event.method === 'Target.targetCreated') {
        const targetInfo = event.params.targetInfo
        if (
          isRecord(targetInfo) &&
          targetInfo.type === 'page' &&
          (targetInfo.openerId === this.#targetId ||
            (typeof targetInfo.openerId === 'string' && this.#childTargets.has(targetInfo.openerId))) &&
          typeof targetInfo.targetId === 'string'
        ) {
          this.#pruneWindowOpens()
          // Page.windowOpen belongs to the main target; a descendant has its own opener.
          const windowOpen = targetInfo.openerId === this.#targetId
            ? this.#pendingWindowOpens.shift()
            : undefined
          const discoveredUrl =
            windowOpen?.url ??
            (typeof targetInfo.url === 'string' && targetInfo.url !== ''
              ? targetInfo.url
              : undefined)
          if (this.#childTargets.has(targetInfo.targetId)) return
          this.#childTargets.set(targetInfo.targetId, this.#childSummary(targetInfo))
          this.#emit({
            type: 'child-target-created',
            targetId: targetInfo.targetId,
            ...(discoveredUrl === undefined ? {} : { url: discoveredUrl }),
          })
        }
        return
      }
      if (event.sessionId === undefined && event.method === 'Target.targetInfoChanged') {
        const info = event.params.targetInfo
        if (isRecord(info) && typeof info.targetId === 'string' && this.#childTargets.has(info.targetId)) {
          const target = this.#childSummary(info)
          this.#childTargets.set(target.targetId, target)
          this.#emit({ type: 'child-target-changed', target })
        }
        return
      }
      if (event.sessionId === undefined && event.method === 'Target.targetDestroyed') {
        if (typeof event.params.targetId === 'string') {
          this.#retiredDuringDiscovery?.add(event.params.targetId)
          if (event.params.targetId === this.#targetId) {
            this.#rootClosed = true
            this.#markUnavailable(
              new RemoteTabError('TAB_NOT_FOUND', 'The attached Chrome tab was closed'),
            )
            return
          }
          if (this.#childTargets.delete(event.params.targetId)) this.#emit({ type: 'child-target-closed', targetId: event.params.targetId })
        }
        return
      }
      if (
        event.sessionId === undefined &&
        event.method === 'Target.targetCrashed' &&
        event.params.targetId === this.#targetId
      ) {
        this.#markUnavailable(
          new RemoteTabError('CHROME_CONNECTION_FAILED', 'The attached Chrome tab crashed', {
            retryable: true,
          }),
        )
        return
      }
      if (
        event.sessionId === undefined &&
        event.method === 'Target.detachedFromTarget' &&
        event.params.sessionId === this.#sessionId
      ) {
        this.#markUnavailable(
          new RemoteTabError('CHROME_CONNECTION_FAILED', 'The attached Chrome CDP Session detached', {
            retryable: true,
          }),
        )
        return
      }
      if (event.sessionId !== this.#sessionId) {
        return
      }
      if (event.method === 'Inspector.detached') {
        this.#markUnavailable(
          new RemoteTabError('CHROME_CONNECTION_FAILED', 'The attached Chrome CDP Session detached', {
            retryable: true,
          }),
        )
        return
      }
      if (event.method === 'Runtime.executionContextCreated') {
        const context = event.params.context
        if (isRecord(context) && Number.isSafeInteger(context.id) && typeof context.uniqueId === 'string' &&
            isRecord(context.auxData) && context.auxData.isDefault === true && typeof context.auxData.frameId === 'string') {
          this.#mainWorldContexts.set(context.id as number, { uniqueId: context.uniqueId, frameId: context.auxData.frameId })
        }
      } else if (event.method === 'Runtime.executionContextDestroyed') {
        const contextId = event.params.executionContextId
        if (typeof contextId === 'number') {
          const context = this.#mainWorldContexts.get(contextId)
          if (context !== undefined) this.#pageScriptNotices?.cancelContext(context.uniqueId)
          this.#mainWorldContexts.delete(contextId)
        }
      } else if (event.method === 'Runtime.executionContextsCleared') {
        this.#pageScriptNotices?.cancelAll()
        this.#mainWorldContexts.clear()
      } else if (event.method === 'Network.loadingFailed') {
        if (this.#pendingNavigation?.networkId === event.params.requestId) this.#pendingNavigation?.abort.abort()
      } else if (event.method === 'Fetch.requestPaused') {
        void this.#handleNavigationRequest(event.params).catch(() => {
          this.#markUnavailable(new RemoteTabError('NAVIGATION_DENIED', 'Navigation interception failed'))
        })
      } else if (event.method === 'Runtime.bindingCalled' && event.params.name === TITLE_BINDING) {
        if (typeof event.params.payload === 'string' && event.params.payload !== this.#title) {
          this.#title = event.params.payload
          this.#emit({ type: 'title-changed', title: this.#title })
        }
      } else if (event.method === 'Runtime.bindingCalled' && event.params.name === PAGE_NOTICE_BINDING) {
        const context = this.#getMainWorldContext(event.params.executionContextId)
        if (context !== undefined) this.#pageScriptNotices?.handle(event.params.payload, context.uniqueId)
      } else if (event.method === 'Runtime.bindingCalled' && event.params.name === PAGE_SCRIPT_BINDING) {
        if (this.#getMainWorldContext(event.params.executionContextId) !== undefined) {
          this.#handlePageScriptBinding(event.params.payload)
        }
      } else if (
        event.method === 'Runtime.exceptionThrown' &&
        isPageScriptException(event.params.exceptionDetails)
      ) {
        this.#emit({
          type: 'page-script-error',
          occurredAt: Date.now(),
          message: pageScriptExceptionMessage(event.params.exceptionDetails),
        })
      } else if (event.method === 'Page.frameNavigated') {
        const frame = event.params.frame
        if (isRecord(frame) && frame.parentId === undefined && typeof frame.url === 'string') {
          this.#pageScriptNotices?.cancelAll()
          if (typeof frame.id === 'string') this.#mainFrameId = frame.id
          this.#currentUrl = frame.url
          this.#emit({ type: 'location-changed', url: frame.url })
        }
      } else if (
        event.method === 'Page.navigatedWithinDocument' &&
        event.params.frameId === this.#mainFrameId &&
        typeof event.params.url === 'string'
      ) {
        this.#currentUrl = event.params.url
        this.#emit({ type: 'location-changed', url: event.params.url })
      } else if (
        event.method === 'Page.fileChooserOpened' &&
        Number.isSafeInteger(event.params.backendNodeId) &&
        (event.params.mode === 'selectSingle' || event.params.mode === 'selectMultiple')
      ) {
        this.#emit({
          type: 'file-chooser-opened',
          backendNodeId: event.params.backendNodeId as number,
          multiple: event.params.mode === 'selectMultiple',
        })
      } else if (event.method === 'Page.windowOpen' && typeof event.params.url === 'string') {
        this.#pruneWindowOpens()
        this.#pendingWindowOpens.push({ url: event.params.url, observedAt: Date.now() })
      } else if (
        event.method === 'Page.downloadWillBegin' &&
        this.#downloadDirectory !== undefined &&
        isSafeDownloadGuid(event.params.guid) &&
        typeof event.params.suggestedFilename === 'string' &&
        event.params.suggestedFilename !== ''
      ) {
        this.#downloads.set(event.params.guid, {
          displayName: event.params.suggestedFilename,
          complete: false,
        })
        this.#emit({ type: 'download-progress', guid: event.params.guid, receivedBytes: 0, totalBytes: 0, state: 'inProgress' })
      } else if (
        event.method === 'Page.downloadProgress' &&
        this.#downloadDirectory !== undefined &&
        isSafeDownloadGuid(event.params.guid) &&
        (event.params.state === 'inProgress' || event.params.state === 'completed' || event.params.state === 'canceled')
      ) {
        const download = this.#downloads.get(event.params.guid)
        if (download === undefined) return
        if (event.params.state === 'canceled') {
          this.#emit({ type: 'download-progress', guid: event.params.guid, receivedBytes: 0, totalBytes: 0, state: 'canceled' })
          void this.removeDownload(event.params.guid).catch(() => undefined)
          return
        }
        if (!Number.isSafeInteger(event.params.receivedBytes) || (event.params.receivedBytes as number) < 0) {
          void this.removeDownload(event.params.guid)
          return
        }
        const totalBytes = Number.isSafeInteger(event.params.totalBytes) && (event.params.totalBytes as number) >= 0
          ? event.params.totalBytes as number : event.params.receivedBytes as number
        download.complete = event.params.state === 'completed'
        this.#emit({ type: 'download-progress', guid: event.params.guid,
          receivedBytes: event.params.receivedBytes as number, totalBytes, state: event.params.state })
        // A Session can cancel synchronously when this progress exceeds its transfer budget.
        if (event.params.state !== 'completed' || !this.#downloads.has(event.params.guid)) return
        this.#emit({
          type: 'download-completed',
          guid: event.params.guid,
          displayName: download.displayName,
          localPath: join(this.#downloadDirectory, event.params.guid),
          totalBytes: event.params.receivedBytes as number,
        })
      } else if (
        event.method === 'Runtime.bindingCalled' &&
        event.params.name === LOCAL_OPEN_BINDING &&
        typeof event.params.payload === 'string' &&
        event.params.payload.length <= 16 * 1024
      ) {
        const payload = parseJsonRecord(event.params.payload)
        if (typeof payload?.url === 'string') {
          this.#emit({ type: 'local-open-requested', url: payload.url })
        }
      }
    })
  }

  public get targetId(): string {
    return this.#targetId
  }

  public get viewport(): CdpViewport | undefined {
    return this.#viewport
  }

  public onEvent(listener: CdpTabEventListener): () => void {
    if (this.#unavailableError !== undefined) {
      listener({ type: 'tab-unavailable', error: this.#unavailableError })
      return () => undefined
    }
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  public get title(): string | undefined {
    return this.#title
  }

  public async observeTitle(): Promise<void> {
    await this.#call('Runtime.addBinding', { name: TITLE_BINDING, executionContextName: TITLE_WORLD })
    await this.#call('Page.addScriptToEvaluateOnNewDocument', {
      source: TITLE_OBSERVER, worldName: TITLE_WORLD, runImmediately: true,
    })
  }

  public sampleFrameChange(): Promise<boolean> {
    this.#frameSample ??= this.#call<{ data: string }>('Page.captureScreenshot', {
      format: 'jpeg', quality: 20, fromSurface: true, captureBeyondViewport: false,
    }).then(({ data }) => {
      requireString(data, 'Page.captureScreenshot did not return a frame')
      const changed = data !== this.#previousFrame
      this.#previousFrame = data
      return changed
    }).finally(() => { this.#frameSample = undefined })
    return this.#frameSample
  }

  public async setViewport(request: CdpViewportRequest): Promise<CdpViewport> {
    assertIntegerInRange(request.width, 1, 1920, 'width')
    assertIntegerInRange(request.height, 1, 1080, 'height')
    if (!Number.isFinite(request.deviceScaleFactor) || request.deviceScaleFactor <= 0 || request.deviceScaleFactor > 4) {
      throw new RangeError('deviceScaleFactor must be greater than 0 and at most 4')
    }

    await this.#call('Emulation.setDeviceMetricsOverride', {
      width: request.width,
      height: request.height,
      deviceScaleFactor: request.deviceScaleFactor,
      mobile: false,
    })

    this.#viewport = {
      ...request,
      revision: (this.#viewport?.revision ?? 0) + 1,
    }
    return this.#viewport
  }

  public async dispatchPointer(input: CdpPointerInput): Promise<void> {
    if (this.#viewport === undefined || input.viewportRevision !== this.#viewport.revision) {
      throw new RemoteTabError(
        'VIEWPORT_STALE',
        'Pointer input does not match the acknowledged remote viewport',
        { retryable: true },
      )
    }
    if (
      !Number.isFinite(input.x) ||
      !Number.isFinite(input.y) ||
      input.x < 0 ||
      input.y < 0 ||
      input.x > this.#viewport.width ||
      input.y > this.#viewport.height
    ) {
      throw new RangeError('Pointer coordinates must be inside the acknowledged remote viewport')
    }

    await this.#call('Input.dispatchMouseEvent', {
      type: input.type,
      x: input.x,
      y: input.y,
      button: input.button,
      buttons: input.buttons,
      modifiers: input.modifiers,
      clickCount: input.clickCount,
      ...(input.deltaX === undefined ? {} : { deltaX: input.deltaX }),
      ...(input.deltaY === undefined ? {} : { deltaY: input.deltaY }),
      ...(input.pointerType === undefined ? {} : { pointerType: input.pointerType }),
    })
    if (input.type === 'mousePressed') this.#pressedButtons.set(input.button, { ...input })
    if (input.type === 'mouseReleased') this.#pressedButtons.delete(input.button)
  }

  public async dispatchKey(input: CdpKeyInput): Promise<void> {
    await this.#call('Input.dispatchKeyEvent', {
      type: input.type,
      key: input.key,
      code: input.code,
      ...(input.text === undefined ? {} : { text: input.text }),
      ...(input.unmodifiedText === undefined ? {} : { unmodifiedText: input.unmodifiedText }),
      modifiers: input.modifiers,
      ...(input.windowsVirtualKeyCode === undefined
        ? {}
        : { windowsVirtualKeyCode: input.windowsVirtualKeyCode }),
      ...(input.nativeVirtualKeyCode === undefined
        ? {}
        : { nativeVirtualKeyCode: input.nativeVirtualKeyCode }),
      ...(input.autoRepeat === undefined ? {} : { autoRepeat: input.autoRepeat }),
      ...(input.isKeypad === undefined ? {} : { isKeypad: input.isKeypad }),
    })
    if (input.type === 'keyDown' || input.type === 'rawKeyDown') this.#pressedKeys.set(input.code, { ...input })
    if (input.type === 'keyUp') this.#pressedKeys.delete(input.code)
  }

  public async releaseInput(): Promise<void> {
    for (const input of this.#pressedKeys.values()) {
      await this.dispatchKey({ type: 'keyUp', key: input.key, code: input.code, modifiers: 0 })
    }
    for (const input of this.#pressedButtons.values()) {
      await this.#call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: input.x, y: input.y,
        button: input.button, buttons: 0, modifiers: 0, clickCount: input.clickCount })
    }
    this.#pressedKeys.clear()
    this.#pressedButtons.clear()
  }

  public async insertText(text: string): Promise<void> {
    if (text.length === 0) {
      return
    }
    await this.#call('Input.insertText', { text })
  }

  public async readClipboard(): Promise<readonly CdpClipboardItem[]> {
    return this.#withClipboardPermission('clipboard-read', async () => {
      const result = await this.#call<{
        result?: { value?: unknown }
        exceptionDetails?: unknown
      }>('Runtime.evaluate', {
        expression: `(${READ_CLIPBOARD_EXPRESSION})()`,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      })
      const exception = runtimeExceptionDescription(result.exceptionDetails)
      if (exception !== undefined) {
        throw new RemoteTabError(
          'FILE_TRANSFER_FAILED',
          `Chrome could not read the remote clipboard: ${exception}`,
        )
      }
      const value = result.result?.value
      if (!Array.isArray(value)) {
        throw new RemoteTabError('FILE_TRANSFER_FAILED', 'Chrome could not read the remote clipboard')
      }
      const items: CdpClipboardItem[] = []
      for (const candidate of value) {
        if (!isRecord(candidate)) continue
        if (candidate.mimeType !== 'text/plain' && candidate.mimeType !== 'image/png') continue
        if (typeof candidate.base64 !== 'string') continue
        const data = Uint8Array.from(Buffer.from(candidate.base64, 'base64'))
        items.push({ mimeType: candidate.mimeType, data })
      }
      if (items.length === 0) {
        throw new RemoteTabError('FILE_TRANSFER_FAILED', 'Remote clipboard has no supported content')
      }
      return items
    })
  }

  public async writeClipboardAndPaste(items: readonly CdpClipboardItem[]): Promise<void> {
    if (
      items.length === 0 ||
      items.length > 2 ||
      items.some((item) => item.mimeType !== 'text/plain' && item.mimeType !== 'image/png')
    ) {
      throw new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Clipboard items are invalid')
    }
    const uniqueTypes = new Set(items.map((item) => item.mimeType))
    if (uniqueTypes.size !== items.length) {
      throw new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Clipboard MIME types must be unique')
    }
    const payload = items.map((item) => ({
      mimeType: item.mimeType,
      base64: Buffer.from(item.data).toString('base64'),
    }))
    await this.#withClipboardPermission('clipboard-write', async () => {
      const result = await this.#call<{
        result?: { value?: unknown }
        exceptionDetails?: unknown
      }>('Runtime.evaluate', {
        expression: `(${WRITE_CLIPBOARD_EXPRESSION})(${JSON.stringify(payload)})`,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      })
      const exception = runtimeExceptionDescription(result.exceptionDetails)
      if (exception !== undefined) {
        throw new RemoteTabError(
          'FILE_TRANSFER_FAILED',
          `Chrome could not write the remote clipboard: ${exception}`,
        )
      }
      if (result.result?.value !== true) {
        throw new RemoteTabError('FILE_TRANSFER_FAILED', 'Chrome could not write the remote clipboard')
      }
      await this.dispatchKey({
        type: 'rawKeyDown',
        key: 'v',
        code: 'KeyV',
        modifiers: 2,
        windowsVirtualKeyCode: 86,
        nativeVirtualKeyCode: 86,
      })
      await this.dispatchKey({
        type: 'keyUp',
        key: 'v',
        code: 'KeyV',
        modifiers: 2,
        windowsVirtualKeyCode: 86,
        nativeVirtualKeyCode: 86,
      })
    })
  }

  public async installPageScript(input: {
    sessionId: string
    source: string
    context?: Readonly<Record<string, unknown>>
    requestNotice?: PageScriptNoticeHandler
  }): Promise<void> {
    if (this.#pageScriptInstalled) {
      throw new RemoteTabError('ILLEGAL_STATE_TRANSITION', 'A Page Script is already installed')
    }
    if (input.source.length === 0) {
      throw new TypeError('Page Script source must not be empty')
    }
    if (input.source.length > 524_288) {
      throw new RangeError('Page Script source exceeds 512 KiB')
    }
    const context = serializePageScriptContext(input.context)
    // Attachment enabled Runtime before this controller subscribed. Re-enable reporting to obtain
    // the existing document contexts as well as all future contexts before installing bindings.
    await this.#call('Runtime.disable')
    await this.#call('Runtime.enable')
    const tree = await this.#call<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree')
    this.#mainFrameId = tree.frameTree.frame.id
    if (input.requestNotice !== undefined) {
      this.#pageScriptNotices = new PageScriptNotices(input.requestNotice, async (uniqueContextId, requestId, reply) => {
        if (![...this.#mainWorldContexts.values()].some((value) => value.uniqueId === uniqueContextId && value.frameId === this.#mainFrameId)) return
        await this.#call('Runtime.evaluate', {
          expression: pageNoticeReplyExpression(requestId, reply), uniqueContextId,
          awaitPromise: false, returnByValue: true, silent: true, timeout: 1_000,
        })
      })
      await this.#call('Runtime.addBinding', { name: PAGE_NOTICE_BINDING })
    }
    await this.#call('Runtime.addBinding', { name: PAGE_SCRIPT_BINDING })

    let source = input.source
    try {
      Function(source)
    } catch (cause) {
      source = ''
      this.#emit({
        type: 'page-script-error',
        occurredAt: Date.now(),
        message: safePageScriptError(cause),
      })
    }

    if (source !== '') {
      await this.#call('Page.addScriptToEvaluateOnNewDocument', {
        source: createPageScriptSource(source),
        runImmediately: true,
      })
    }
    await this.#call('Page.addScriptToEvaluateOnNewDocument', {
      source: createPageScriptBootstrap(input.sessionId, context, input.requestNotice !== undefined),
      runImmediately: true,
    })
    this.#pageScriptInstalled = true
  }

  public async dispatchPageScriptDetached(): Promise<void> {
    if (!this.#pageScriptInstalled || this.#closed) return
    this.#pageScriptNotices?.cancelAll()
    await this.#call('Runtime.evaluate', {
      expression: `globalThis[Symbol.for(${JSON.stringify(PAGE_SCRIPT_MARKER)})]?.detach?.()`,
      awaitPromise: false,
      returnByValue: true,
    })
  }

  public async setFileInputFiles(backendNodeId: number, files: readonly string[]): Promise<void> {
    if (!Number.isSafeInteger(backendNodeId) || backendNodeId < 0) {
      throw new RangeError('backendNodeId must be a non-negative safe integer')
    }
    if (files.length === 0 || files.some((file) => file.length === 0)) {
      throw new RangeError('At least one runtime-local file path is required')
    }
    await this.#call('DOM.setFileInputFiles', { backendNodeId, files: [...files] })
  }

  public async enableLocalOpenInterception(): Promise<void> {
    if (this.#releaseChildInterception !== undefined) return
    this.#releaseChildInterception = await BrowserChildTargetInterception.acquire(
      this.browserWebSocketUrl, this.requestTimeoutMs, {
        ownsTarget: targetId => this.ownsTarget(targetId),
        failed: error => this.#markUnavailable(error),
      },
    )
    await this.#call('Runtime.addBinding', { name: LOCAL_OPEN_BINDING })
    await this.#call('Page.addScriptToEvaluateOnNewDocument', {
      source: LOCAL_OPEN_HOOK,
      runImmediately: true,
    })
  }

  #childSummary(info: Readonly<Record<string, unknown>>): CdpChildTarget {
    return {
      targetId: info.targetId as string,
      title: typeof info.title === 'string' ? [...info.title].slice(0, 4096).join('') : '',
      url: typeof info.url === 'string' ? info.url : '',
    }
  }

  /** Attach can adopt a page which already has popup descendants. Listen before taking the snapshot. */
  public async discoverChildren(): Promise<void> {
    try {
      const { targetInfos } = await this.#connection.call<GetTargetsResult>('Target.getTargets')
      if (this.#closed) throw new RemoteTabError('SESSION_CLOSED', 'CDP controller is closed')
      if (this.#unavailableError !== undefined) throw this.#unavailableError
      this.#rememberDescendants(targetInfos)
      this.#childrenDiscovered = true
    } finally {
      this.#retiredDuringDiscovery = undefined
    }
  }

  #rememberDescendants(targetInfos: readonly TargetInfo[], ancestry = new Set([this.#targetId, ...this.#childTargets.keys()])): void {
    let pending = targetInfos.filter(info => info.type === 'page' && info.targetId !== this.#targetId)
    while (pending.length > 0) {
      const next: TargetInfo[] = []
      for (const info of pending) {
        if (info.openerId !== undefined && ancestry.has(info.openerId)) {
          // A closing opener in this snapshot still proves its live descendants' ancestry.
          ancestry.add(info.targetId)
          if (!this.#retiredDuringDiscovery?.has(info.targetId) && !this.#childTargets.has(info.targetId)) {
            this.#childTargets.set(info.targetId, this.#childSummary({ ...info }))
          }
        } else next.push(info)
      }
      if (next.length === pending.length) break
      pending = next
    }
  }

  public getChildTargets(): readonly CdpChildTarget[] {
    return [...this.#childTargets.values()].map(target => ({ ...target }))
  }

  public ownsTarget(targetId: string): boolean {
    return targetId === this.#targetId || this.#childTargets.has(targetId)
  }

  public async closeChildTarget(targetId: string): Promise<void> {
    if (!this.#childTargets.has(targetId)) {
      throw new RemoteTabError('TAB_NOT_FOUND', 'The child target is not owned by this Session')
    }
    await closeObservedChild(this.#connection, targetId)
    if (this.#childTargets.delete(targetId)) this.#emit({ type: 'child-target-closed', targetId })
  }

  public async removeDownload(guid: string): Promise<void> {
    const download = this.#downloads.get(guid)
    if (download === undefined || this.#downloadDirectory === undefined) {
      throw new RemoteTabError('FILE_TRANSFER_FAILED', 'The download is not owned by this Session')
    }
    this.#downloads.delete(guid)
    if (!download.complete) {
      await this.#connection.call('Browser.cancelDownload', { guid }).catch(() => undefined)
    }
    await Promise.all([guid, `${guid}.crdownload`].map(name =>
      rm(join(this.#downloadDirectory!, name), { force: true }).catch(() => undefined)))
    this.#emit({ type: 'download-progress', guid, receivedBytes: 0, totalBytes: 0, state: 'canceled' })
  }

  public get currentUrl(): string { return this.#currentUrl }

  public async enableNavigationInterception(
    authorize: (request: CdpNavigationRequest, signal: AbortSignal) => Promise<NavigationDecision>,
  ): Promise<void> {
    const tree = await this.#call<{ frameTree: { frame: { id: string; url: string } } }>('Page.getFrameTree')
    this.#mainFrameId = requireString(tree.frameTree?.frame.id, 'Chrome did not return a main frame')
    this.#currentUrl = tree.frameTree.frame.url
    this.#authorizeNavigation = authorize
    // Service Worker responses otherwise bypass Fetch interception, including main Documents.
    // This is target-scoped; do not unregister workers or change the shared Profile's storage.
    await this.#call('Network.enable')
    await this.#call('Network.setBypassServiceWorker', { bypass: true })
    await this.#call('Fetch.enable', {
      patterns: [{ resourceType: 'Document', requestStage: 'Request' }],
    })
  }

  async #handleNavigationRequest(params: Readonly<Record<string, unknown>>): Promise<void> {
    const requestId = requireString(params.requestId, 'Chrome did not return an intercepted request ID')
    // A Document can also belong to an iframe. Only the owned top-level frame is policy-controlled.
    if (params.frameId !== this.#mainFrameId || params.resourceType !== 'Document') {
      await this.#call('Fetch.continueRequest', { requestId })
      return
    }
    this.#pendingNavigation?.abort.abort()
    const completion = Promise.withResolvers<void>()
    const pending = { abort: new AbortController(), networkId: params.networkId, finished: completion.promise, finish: completion.resolve }
    this.#pendingNavigation = pending
    try {
      let decision: NavigationDecision = { allowed: false }
      let approvedUrl: string | undefined
      try {
        if (!isRecord(params.request)) throw new TypeError('Chrome request is invalid')
        const url = safeNavigationUrl(params.request.url)
        if (url !== undefined && this.#authorizeNavigation !== undefined) {
          decision = await this.#authorizeNavigation({
            url,
            currentUrl: this.#currentUrl,
            method: requireString(params.request.method, 'Chrome request method is invalid'),
            isRedirect: typeof params.redirectedRequestId === 'string',
          }, pending.abort.signal)
          if (decision.allowed === true && !pending.abort.signal.aborted) approvedUrl = safeNavigationUrl(decision.url ?? url)
        }
      } catch {
        decision = { allowed: false, reason: 'Navigation authorization failed' }
      }
      if (approvedUrl === undefined) {
        const superseded = pending.abort.signal.aborted
        await this.#call('Fetch.failRequest', { requestId, errorReason: 'Aborted' }).catch((cause: unknown) => {
          if (!pending.abort.signal.aborted) throw cause
        })
        if (!superseded) this.#emit({ type: 'navigation-blocked', reason: decision.reason ?? 'Navigation is not allowed' })
        return
      }
      const requested = (params.request as Record<string, unknown>).url
      if (approvedUrl !== safeNavigationUrl(requested)) {
        // A real redirect changes the visible origin and does not forward a POST body to a new site.
        await this.#call('Fetch.fulfillRequest', {
          requestId,
          responseCode: 303,
          responseHeaders: [{ name: 'Location', value: approvedUrl }],
        })
      } else {
        await this.#call('Fetch.continueRequest', { requestId })
      }
    } finally {
      if (this.#pendingNavigation === pending) this.#pendingNavigation = undefined
      pending.finish()
    }
  }

  /** Viewer commands are authorized separately; the document guard also checks redirects. */
  public async navigateAuthorized(url: string): Promise<void> {
    const normalized = safeNavigationUrl(url)
    if (normalized === undefined) throw new RemoteTabError('NAVIGATION_DENIED', 'Navigation requires an HTTP or HTTPS URL')
    const result = await this.#navigationCommand<{ errorText?: string }>('Page.navigate', { url: normalized })
    if (result.errorText !== undefined) throw new RemoteTabError('NAVIGATION_DENIED', 'Chrome could not load the authorized page')
  }

  public async reload(): Promise<void> {
    await this.#navigationCommand('Page.reload', { ignoreCache: false })
  }

  public async goHistory(direction: 'back' | 'forward'): Promise<boolean> {
    const history = await this.#call<{
      currentIndex: number
      entries: Array<{ id: number }>
    }>('Page.getNavigationHistory')
    const targetIndex = history.currentIndex + (direction === 'back' ? -1 : 1)
    const entry = history.entries[targetIndex]
    if (entry === undefined) {
      return false
    }
    await this.#navigationCommand('Page.navigateToHistoryEntry', { entryId: entry.id })
    return true
  }

  async #navigationCommand<Result = Readonly<Record<string, unknown>>>(method: string, params: Readonly<Record<string, unknown>>): Promise<Result> {
    try {
      // A human confirmation may outlive the ordinary 15-second CDP command timeout.
      // Bound the complete navigation (including redirects) to two minutes.
      return await this.#call<Result>(method, params, 120_000)
    } catch (cause) {
      if (cause instanceof RemoteTabError && cause.code === 'CDP_COMMAND_TIMEOUT') {
        this.#pendingNavigation?.abort.abort()
        await this.#call('Page.stopLoading').catch(() => undefined)
      }
      throw cause
    }
  }

  public async detach(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#detached = true
    this.#pendingNavigation?.abort.abort()
    this.#pageScriptNotices?.cancelAll()
    this.#mainWorldContexts.clear()
    this.#unsubscribe()
    this.#unsubscribeConnectionClose()
    this.#listeners.clear()
    try {
      await this.#connection.call('Target.detachFromTarget', { sessionId: this.#sessionId })
    } finally {
      this.#childTargets.clear()
      this.#releaseChildInterception?.()
      this.#releaseChildInterception = undefined
    }
  }

  public close(options: RemoteTabCloseOptions = {}): Promise<void> {
    this.#browserClosed ||= options.browserClosed === true
    if (this.#detached) return Promise.resolve()
    if (this.#closePromise !== undefined) return this.#closePromise
    this.#closed = true
    this.#pendingNavigation?.abort.abort()
    this.#pageScriptNotices?.cancelAll()
    this.#mainWorldContexts.clear()
    this.#listeners.clear()
    // Keep Target discovery subscribed until cleanup succeeds: descendants can appear while
    // Chrome is processing a close. Their proven opener identities remain owned across retries.
    this.#closePromise = this.#closeTargets().catch(cause => {
      this.#closePromise = undefined
      throw cause
    })
    return this.#closePromise
  }

  async #closeTargets(): Promise<void> {
    let recovery: CdpConnection | undefined
    try {
      await Promise.allSettled([...this.#downloads.keys()].map(guid => this.removeDownload(guid)))
      if (!this.#browserClosed) {
        const connection = this.#connection.open ? this.#connection :
          recovery = await CdpConnection.connect(this.browserWebSocketUrl, this.requestTimeoutMs)
        // Reconcile only proven opener ancestry, including popups created during a CDP outage.
        const ancestry = new Set([this.#targetId, ...this.#childTargets.keys()])
        if (recovery || !this.#childrenDiscovered) this.#rememberDescendants((await connection.call<GetTargetsResult>('Target.getTargets')).targetInfos, ancestry)
        const children = await Promise.allSettled([...this.#childTargets.keys()].map(async targetId => {
          await closeObservedChild(connection, targetId)
          this.#childTargets.delete(targetId)
        }))
        let failure = children.find(result => result.status === 'rejected')
        if (!this.#rootClosed) {
          try { await closeObservedChild(connection, this.#targetId); this.#rootClosed = true }
          catch (reason) { failure ??= { status: 'rejected', reason } }
        }
        if (recovery || !this.#childrenDiscovered) this.#rememberDescendants((await connection.call<GetTargetsResult>('Target.getTargets')).targetInfos, ancestry)
        if (failure?.status === 'rejected') throw failure.reason
        if (this.#childTargets.size !== 0)
          throw new RemoteTabError('CDP_COMMAND_FAILED', 'New owned targets still require cleanup', { retryable: true })
        await connection.call('Target.detachFromTarget', { sessionId: this.#sessionId }).catch(() => undefined)
      }
    } catch (cause) {
      // Socket failure alone is never proof of process death. Only the owner can supply it.
      if (!this.#browserClosed) throw cause
    } finally { recovery?.close() }
    this.#rootClosed = true
    this.#childTargets.clear()
    this.#unsubscribe()
    this.#unsubscribeConnectionClose()
    this.#releaseChildInterception?.()
    this.#releaseChildInterception = undefined
  }

  async #call<Result = Readonly<Record<string, unknown>>>(
    method: string,
    params?: Readonly<Record<string, unknown>>,
    timeoutMs?: number,
  ): Promise<Result> {
    // Chrome may defer renderer commands while its initial Document is paused. Wait outside
    // the command timer; Fetch decisions and explicit navigation/stop must remain able to unblock it.
    if (!method.startsWith('Fetch.') && !['Page.navigate', 'Page.reload', 'Page.navigateToHistoryEntry', 'Page.stopLoading'].includes(method)) {
      while (this.#pendingNavigation !== undefined) await this.#pendingNavigation.finished
    }
    if (this.#closed) {
      throw new RemoteTabError('SESSION_CLOSED', 'The Chrome tab controller is closed')
    }
    if (this.#unavailableError !== undefined) {
      throw this.#unavailableError
    }
    return this.#connection.call<Result>(method, params, this.#sessionId, timeoutMs)
  }

  #markUnavailable(error: RemoteTabError): void {
    if (this.#closed || this.#unavailableError !== undefined) return
    this.#unavailableError = error
    this.#emit({ type: 'tab-unavailable', error })
  }

  async #withClipboardPermission<Result>(
    permissionName: 'clipboard-read' | 'clipboard-write',
    operation: () => Promise<Result>,
  ): Promise<Result> {
    await this.#call('Page.bringToFront')
    const context = await this.#call<{
      result?: { value?: unknown }
    }>('Runtime.evaluate', {
      expression: '({ origin: location.origin, secure: isSecureContext, available: typeof navigator.clipboard === "object" })',
      returnByValue: true,
    })
    const value = context.result?.value
    if (
      !isRecord(value) ||
      typeof value.origin !== 'string' ||
      value.origin === 'null' ||
      value.secure !== true ||
      value.available !== true
    ) {
      throw new RemoteTabError(
        'CAPABILITY_UNAVAILABLE',
        'Remote clipboard requires a secure HTTP origin with the Clipboard API',
      )
    }
    const permission = { name: permissionName }
    await this.#connection.call('Browser.setPermission', {
      permission,
      setting: 'granted',
      origin: value.origin,
    })
    try {
      return await operation()
    } finally {
      await this.#connection.call('Browser.setPermission', {
        permission,
        setting: 'prompt',
        origin: value.origin,
      }).catch(() => undefined)
    }
  }

  #emit(event: CdpTabEvent): void {
    for (const listener of this.#listeners) {
      listener(event)
    }
  }

  #getMainWorldContext(id: unknown): { uniqueId: string; frameId: string } | undefined {
    if (typeof id !== 'number') return undefined
    const context = this.#mainWorldContexts.get(id)
    return context?.frameId === this.#mainFrameId ? context : undefined
  }

  #handlePageScriptBinding(payload: unknown): void {
    if (typeof payload !== 'string' || payload.length > 65_536) return
    let value: unknown
    try {
      value = JSON.parse(payload)
    } catch {
      return
    }
    if (!isRecord(value) || typeof value.type !== 'string') return
    if (value.type === 'event') {
      if (
        typeof value.name !== 'string' ||
        !PAGE_SCRIPT_EVENT_NAMES.has(value.name) ||
        !Number.isSafeInteger(value.occurredAt) ||
        (value.location !== undefined &&
          (typeof value.location !== 'string' || value.location.length === 0 || value.location.length > 16_384))
      ) return
      this.#emit({
        type: 'page-script-event',
        name: value.name as PageScriptEventName,
        occurredAt: value.occurredAt as number,
        ...(typeof value.location === 'string' ? { location: value.location } : {}),
      })
    } else if (
      value.type === 'error' &&
      Number.isSafeInteger(value.occurredAt) &&
      typeof value.message === 'string'
    ) {
      this.#emit({
        type: 'page-script-error',
        occurredAt: value.occurredAt as number,
        message: value.message.slice(0, 512) || 'Page Script failed',
      })
    }
  }

  #pruneWindowOpens(): void {
    const cutoff = Date.now() - 5_000
    while ((this.#pendingWindowOpens[0]?.observedAt ?? cutoff) < cutoff) {
      this.#pendingWindowOpens.shift()
    }
  }
}

function createPageScriptSource(source: string): string {
  return `(() => {
  if (globalThis.top !== globalThis) return
  const binding = globalThis[${JSON.stringify(PAGE_SCRIPT_BINDING)}]
  try {
    ;(() => {
${source}
    }).call(globalThis)
  } catch (error) {
    try {
      if (typeof binding === 'function') binding(JSON.stringify({
        type: 'error',
        occurredAt: Date.now(),
        message: error instanceof Error ? error.message : String(error),
      }))
    } catch {}
  }
})()
//# sourceURL=${PAGE_SCRIPT_SOURCE_URL}`
}

function createPageScriptBootstrap(sessionId: string, context: string | undefined, notices: boolean): string {
  const contextExpression =
    context === undefined ? 'undefined' : `JSON.parse(${JSON.stringify(context)})`
  return `(() => {
  if (globalThis.top !== globalThis) return
  const marker = Symbol.for(${JSON.stringify(PAGE_SCRIPT_MARKER)})
  if (globalThis[marker] !== undefined) return
  const binding = globalThis[${JSON.stringify(PAGE_SCRIPT_BINDING)}]
  const sessionId = ${JSON.stringify(sessionId)}
  const context = ${contextExpression}
  let detached = false
  let lastLocation = ''
  ${notices ? createPageNoticeBootstrap() : ''}

  const emit = (name) => {
    const occurredAt = Date.now()
    const currentLocation = String(globalThis.location?.href ?? '').slice(0, 16384)
    const detail = Object.freeze({
      sessionId,
      occurredAt,
      ...(currentLocation === '' ? {} : { location: currentLocation }),
      ...(context === undefined ? {} : { context }),
      ${notices ? 'requestNotice,' : ''}
    })
    document.dispatchEvent(new CustomEvent(name, { detail }))
    globalThis.dispatchEvent(new CustomEvent(name, { detail }))
    try {
      if (typeof binding === 'function') binding(JSON.stringify({
        type: 'event',
        name,
        occurredAt,
        ...(currentLocation === '' ? {} : { location: currentLocation }),
      }))
    } catch {}
  }

  const emitLocation = () => {
    const current = String(globalThis.location?.href ?? '')
    if (current === lastLocation) return
    lastLocation = current
    emit('browshare:on_location_changed')
  }
  const detach = () => {
    if (detached) return
    detached = true
    ${notices ? 'cancelNotices()' : ''}
    emit('browshare:on_session_detached')
  }
  Object.defineProperty(globalThis, marker, {
    configurable: true,
    value: Object.freeze({ detach }),
  })

  for (const method of ['pushState', 'replaceState']) {
    const original = history[method]
    if (typeof original !== 'function') continue
    Object.defineProperty(history, method, {
      configurable: true,
      writable: true,
      value(...args) {
        const result = Reflect.apply(original, this, args)
        queueMicrotask(emitLocation)
        return result
      },
    })
  }
  globalThis.addEventListener('popstate', () => queueMicrotask(emitLocation))
  globalThis.addEventListener('hashchange', () => queueMicrotask(emitLocation))
  globalThis.addEventListener('pageshow', (event) => {
    if (event.persisted) queueMicrotask(emitLocation)
  }, { capture: true })

  emit('browshare:on_document_start')
  emit('browshare:on_session_attached')
  emitLocation()
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      emit('browshare:on_dom_content_loaded')
    }, { once: true })
  } else {
    queueMicrotask(() => emit('browshare:on_dom_content_loaded'))
  }
  if (document.readyState === 'complete') {
    queueMicrotask(() => emit('browshare:on_load'))
  } else {
    globalThis.addEventListener('load', () => emit('browshare:on_load'), { once: true })
  }
})()
//# sourceURL=browshare-page-script-bootstrap.js`
}

function serializePageScriptContext(context: Readonly<Record<string, unknown>> | undefined): string | undefined {
  if (context === undefined) return undefined
  let value: string | undefined
  try {
    value = JSON.stringify(context)
  } catch (cause) {
    throw new TypeError(`Page Script context must be JSON serializable: ${safePageScriptError(cause)}`)
  }
  if (value === undefined || !isRecord(JSON.parse(value))) {
    throw new TypeError('Page Script context must be a JSON object')
  }
  if (new TextEncoder().encode(value).byteLength > 65_536) {
    throw new RangeError('Page Script context exceeds 64 KiB')
  }
  return value
}

function safePageScriptError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  return (message || 'Page Script failed').slice(0, 512)
}

function isPageScriptException(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value.url === PAGE_SCRIPT_SOURCE_URL) return true
  const stackTrace = value.stackTrace
  if (!isRecord(stackTrace) || !Array.isArray(stackTrace.callFrames)) return false
  return stackTrace.callFrames.some(
    (frame) => isRecord(frame) && frame.url === PAGE_SCRIPT_SOURCE_URL,
  )
}

function pageScriptExceptionMessage(value: unknown): string {
  return runtimeExceptionDescription(value) ?? 'Page Script failed'
}

const READ_CLIPBOARD_EXPRESSION = String.raw`async function () {
  const output = []
  for (const item of await navigator.clipboard.read()) {
    for (const mimeType of ['text/plain', 'image/png']) {
      if (!item.types.includes(mimeType)) continue
      const bytes = new Uint8Array(await (await item.getType(mimeType)).arrayBuffer())
      let binary = ''
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
      }
      output.push({ mimeType, base64: btoa(binary) })
    }
  }
  return output
}`

const WRITE_CLIPBOARD_EXPRESSION = String.raw`async function (items) {
  const parts = {}
  for (const item of items) {
    const binary = atob(item.base64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    parts[item.mimeType] = new Blob([bytes], { type: item.mimeType })
  }
  await navigator.clipboard.write([new ClipboardItem(parts)])
  return true
}`

function isSafeDownloadGuid(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z\d-]{1,128}$/iu.test(value)
}

function runtimeExceptionDescription(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const exception = value.exception
  const description = isRecord(exception) ? exception.description : undefined
  const candidate = typeof description === 'string' ? description : value.text
  return typeof candidate === 'string' && candidate !== '' ? candidate.slice(0, 512) : undefined
}

async function resolveBrowserWebSocketUrl(
  endpoint: string,
  fetchImplementation: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<string> {
  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch (cause) {
    throw new RemoteTabError('CHROME_CONNECTION_FAILED', 'Chrome CDP endpoint is not a valid URL', {
      cause,
    })
  }

  if (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') {
    return parsed.toString()
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new RemoteTabError(
      'CHROME_CONNECTION_FAILED',
      'Chrome CDP endpoint must use http, https, ws, or wss',
    )
  }

  parsed.pathname = '/json/version'
  parsed.search = ''
  parsed.hash = ''

  let response: Response
  try {
    response = await fetchImplementation(parsed, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (cause) {
    throw new RemoteTabError(
      'CHROME_CONNECTION_FAILED',
      'Chrome CDP version endpoint could not be reached',
      { cause, retryable: true },
    )
  }

  if (!response.ok) {
    throw new RemoteTabError(
      'CHROME_CONNECTION_FAILED',
      `Chrome CDP version endpoint returned HTTP ${response.status}`,
      { retryable: response.status >= 500 },
    )
  }

  const value: unknown = await response.json()
  if (!isRecord(value) || typeof value.webSocketDebuggerUrl !== 'string') {
    throw new RemoteTabError(
      'CHROME_UNSUPPORTED',
      'Chrome CDP version response does not contain webSocketDebuggerUrl',
    )
  }
  return value.webSocketDebuggerUrl
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RemoteTabError('CHROME_UNSUPPORTED', message)
  }
  return value
}

function assertIntegerInRange(value: number, minimum: number, maximum: number, name: string): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
}
