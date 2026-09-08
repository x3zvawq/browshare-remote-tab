import { randomUUID } from 'node:crypto'
import { open, stat } from 'node:fs/promises'

import {
  createProtocolMessage,
  assertUploadAllowed,
  isWindowScopedMessage,
  decodeProtocolMessage,
  encodeProtocolMessage,
  normalizeCapabilities,
  RemoteTabError,
  type Capability,
  type ClipboardItemDescriptor,
  type FileDescriptor,
  type MediaQualityPreset,
  type MediaQualitySettings,
  type EncodingSettings,
  type QualityConfiguration,
  type QualityState,
  type ProtocolMessage,
  type ProtocolMessageType,
  type ProtocolPayload,
  type RemoteTabErrorCode,
  type Viewport,
  type WindowState,
} from '@browshare/remote-tab-protocol'

import { normalizeMediaLimits, limitViewport, limitQuality } from './media-limits.js'
import { splitWindowState } from './window-catalog.js'
import { NoticeRequests } from './notice-requests.js'
import { CdpBrowser, type AttachedCdpTab, type CdpTabController } from './cdp.js'
import type {
  AttachSessionInput,
  SessionMediaLimits,
  FileTransferLimits,
  NavigationAction,
  NavigationDecision,
  NoticeRequestOptions,
  NoticeResult,
  RemoteTabSession,
  RemoteTabCloseOptions,
  SessionStorageReservation,
  ViewerTicket,
  ViewerTicketRequest,
} from './contracts.js'
import {
  ExtensionLoopbackServer,
  type ExtensionMediaSignal,
} from './extension-loopback.js'
import { CoreSignalingClient, type CoreSignalingEvent } from './signaling-client.js'
import { RemoteTabStateMachine, isTerminalRemoteTabState } from './state-machine.js'

export interface RemoteTabCoreOptions {
  extension: ExtensionLoopbackServer
  downloadDirectory?: string
  defaultViewport?: Omit<Viewport, 'revision'>
  hookTimeoutMs?: number
  extensionReadyTimeoutMs?: number
}

const DEFAULT_VIEWPORT = Object.freeze({
  width: 1280,
  height: 720,
  deviceScaleFactor: 1,
  frameRate: 30,
})

const SIGNALING_RETRY_MIN_DELAY_MS = 250
const SIGNALING_RETRY_MAX_DELAY_MS = 2_000
const DEFAULT_LOCAL_OPEN_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_FILE_TRANSFER_LIMITS: FileTransferLimits = Object.freeze({
  allowedExtensions: [],
  maxFileBytes: 512 * 1024 * 1024,
  maxBatchBytes: 1024 * 1024 * 1024,
  maxTemporaryBytes: Number.MAX_SAFE_INTEGER,
  maxFiles: 32,
  maxChunkBytes: 64 * 1024,
  requestTimeoutMs: 120_000,
})
const MAX_CLIPBOARD_ITEM_BYTES = 16 * 1024 * 1024
const MAX_CLIPBOARD_TOTAL_BYTES = 24 * 1024 * 1024
const QUALITY_PRESETS: Readonly<Record<MediaQualityPreset, MediaQualitySettings>> = Object.freeze({
  'data-saver': {
    preset: 'data-saver',
    maxBitrate: 750_000,
    maxFrameRate: 15,
    scaleResolutionDownBy: 2,
  },
  balanced: {
    preset: 'balanced',
    maxBitrate: 2_500_000,
    maxFrameRate: 30,
    scaleResolutionDownBy: 1,
  },
  high: {
    preset: 'high',
    maxBitrate: 6_000_000,
    maxFrameRate: 60,
    scaleResolutionDownBy: 1,
  },
})

export class RemoteTabCore {
  readonly #extension: ExtensionLoopbackServer
  readonly #downloadDirectory: string | undefined
  readonly #defaultViewport: Omit<Viewport, 'revision'>
  readonly #hookTimeoutMs: number
  readonly #extensionReadyTimeoutMs: number
  readonly #sessions = new Map<string, RemoteTabSessionImplementation>()
  readonly #attaching = new Map<string, Promise<RemoteTabSession>>()
  readonly #pendingCleanup = new Map<string, { browser: CdpBrowser | undefined; close(options?: RemoteTabCloseOptions): Promise<void> }>()
  readonly #targetOwners = new Map<string, string>()
  readonly #targetReservations = new Set<string>()
  readonly #pendingAttachments = new Map<string, AttachedCdpTab>()
  #clipboardChain = Promise.resolve()

  public constructor(options: RemoteTabCoreOptions) {
    const hookTimeoutMs = options.hookTimeoutMs ?? 5_000
    const extensionReadyTimeoutMs = options.extensionReadyTimeoutMs ?? 15_000
    if (!Number.isSafeInteger(hookTimeoutMs) || hookTimeoutMs <= 0) {
      throw new RangeError('hookTimeoutMs must be a positive safe integer')
    }
    if (!Number.isSafeInteger(extensionReadyTimeoutMs) || extensionReadyTimeoutMs <= 0) {
      throw new RangeError('extensionReadyTimeoutMs must be a positive safe integer')
    }
    this.#extension = options.extension
    this.#downloadDirectory = options.downloadDirectory
    this.#defaultViewport = options.defaultViewport ?? DEFAULT_VIEWPORT
    this.#hookTimeoutMs = hookTimeoutMs
    this.#extensionReadyTimeoutMs = extensionReadyTimeoutMs
  }

  public attachSession(input: AttachSessionInput): Promise<RemoteTabSession> {
    if (this.#sessions.has(input.sessionId) || this.#attaching.has(input.sessionId) || this.#pendingCleanup.has(input.sessionId))
      return Promise.reject(new RemoteTabError('TAB_ALREADY_ATTACHED', 'A Remote Tab Session with this ID is already attached or awaiting cleanup'))
    const operation = this.#attachSession(input)
    this.#attaching.set(input.sessionId, operation)
    void operation.then(() => this.#attaching.delete(input.sessionId), () => this.#attaching.delete(input.sessionId))
    return operation
  }

  async #attachSession(input: AttachSessionInput): Promise<RemoteTabSession> {
    input = { ...input, mediaLimits: normalizeMediaLimits(input.mediaLimits) }
    if (this.#sessions.has(input.sessionId)) {
      throw new RemoteTabError(
        'TAB_ALREADY_ATTACHED',
        'A Remote Tab Session with this ID is already attached',
      )
    }
    if (normalizeCapabilities(input.capabilities).includes('windowSelection') && input.childTargetPolicy !== 'retain') {
      throw new RemoteTabError('CAPABILITY_UNAVAILABLE', 'Window selection requires retained child targets')
    }
    if (normalizeCapabilities(input.capabilities).includes('download') && this.#downloadDirectory === undefined) {
      throw new RemoteTabError(
        'CAPABILITY_UNAVAILABLE',
        'File download requires a configured Chrome download directory',
      )
    }

    const requestedTargetId = input.tab.mode === 'adopt' ? input.tab.targetId : undefined
    if (
      requestedTargetId !== undefined &&
      (this.#targetOwners.has(requestedTargetId) || this.#targetReservations.has(requestedTargetId) ||
        [...this.#pendingCleanup.values()].some(entry => entry.browser?.ownsTargetPendingCleanup(requestedTargetId)) ||
        [...this.#sessions.values()].some((session) => session.ownsTarget(requestedTargetId)) ||
        [...this.#pendingAttachments.values()].some(tab => tab.controller.ownsTarget(requestedTargetId)))
    ) {
      throw new RemoteTabError(
        'TAB_ALREADY_ATTACHED',
        'The requested Chrome page target already belongs to a Remote Tab Session',
      )
    }
    if (requestedTargetId !== undefined) this.#targetReservations.add(requestedTargetId)

    const fileTransferLimits = normalizeFileTransferLimits(input.fileTransferLimits)
    const localOpenRequestTimeoutMs = normalizePositiveSafeInteger(
      input.localOpenRequestTimeoutMs ?? DEFAULT_LOCAL_OPEN_REQUEST_TIMEOUT_MS,
      'localOpenRequestTimeoutMs',
    )
    const state = new RemoteTabStateMachine({
      onTransition: (transition) => {
        callNotificationHook(() =>
          input.hooks.onStateChanged({
            sessionId: input.sessionId,
            previous: transition.previous,
            current: transition.current,
            ...(transition.reason === undefined ? {} : { reason: transition.reason }),
          }),
        )
      },
    })
    let browser: CdpBrowser | undefined
    let attached: AttachedCdpTab | undefined
    let ownedTargetId: string | undefined
    let session: RemoteTabSessionImplementation | undefined
    let ownershipConflict = false
    try {
      await this.#extension.waitUntilReady(
        ['service-worker', 'media'],
        this.#extensionReadyTimeoutMs,
      )
      browser = await CdpBrowser.connect(input.cdpEndpoint, {
        ...(this.#downloadDirectory === undefined
          ? {}
          : { downloadDirectory: this.#downloadDirectory }),
      })
      // The initial page must not make a request before the document authorization hook is installed.
      attached = await browser.attachTab(
        input.tab.mode === 'create' ? { mode: 'create' } : input.tab,
        this.#extension,
      )
      const targets = [attached.targetId, ...attached.controller.getChildTargets().map(child => child.targetId)]
      if (targets.some(targetId =>
        (targetId !== requestedTargetId && this.#targetReservations.has(targetId)) ||
        [...this.#pendingCleanup.values()].some(entry => entry.browser?.ownsTargetPendingCleanup(targetId)) ||
        [...this.#sessions.values()].some(existing => existing.ownsTarget(targetId)) ||
        [...this.#pendingAttachments.values()].some(existing => existing.controller.ownsTarget(targetId))
      )) {
        ownershipConflict = true
        throw new RemoteTabError('TAB_ALREADY_ATTACHED', 'An attached page or its descendant already belongs to another Session')
      }
      this.#pendingAttachments.set(input.sessionId, attached)
      await attached.controller.enableNavigationInterception(async (request, signal) => {
        const decision = await withTimeout(
          input.hooks.authorizeNavigation({
            sessionId: input.sessionId,
            action: 'go',
            source: 'document',
            ...request,
          }),
          this.#hookTimeoutMs,
          new RemoteTabError('NAVIGATION_DENIED', 'Navigation authorization timed out'),
        )
        if (!decision.allowed || decision.confirmation === undefined) return decision
        if (session === undefined) return { allowed: false, reason: 'Navigation confirmation requires a connected Viewer' }
        if (!session.isSelectedWindow(attached!.targetId)) return { allowed: false, reason: 'Select this window before confirming navigation' }
        return session.confirmNavigation(decision, signal)
      })
      if (input.childTargetPolicy !== 'retain') {
        await attached.controller.enableLocalOpenInterception()
      }
      if (input.tab.mode === 'create' && !input.tab.deferUntilViewer && input.tab.initialUrl !== undefined && input.tab.initialUrl !== 'about:blank') {
        await attached.controller.navigateAuthorized(input.tab.initialUrl)
      }
      this.#extension.bindSession(input.sessionId, attached.targetId)
      if (this.#targetOwners.has(attached.targetId)) {
        throw new RemoteTabError(
          'TAB_ALREADY_ATTACHED',
          'The requested Chrome page target already belongs to a Remote Tab Session',
        )
      }
      this.#targetOwners.set(attached.targetId, input.sessionId)
      const attachedTargetId = attached.targetId
      ownedTargetId = attachedTargetId
      const initialViewport = limitViewport(this.#defaultViewport, input.mediaLimits!)
      const cdpViewport = await attached.controller.setViewport(initialViewport)
      const viewport: Viewport = { ...cdpViewport, frameRate: initialViewport.frameRate }
      if (input.hooks.onTitleChanged !== undefined || input.capabilities.includes('windowSelection')) await attached.controller.observeTitle()
      state.transition('READY')

      session = new RemoteTabSessionImplementation({
        input,
        browser,
        attached,
        extension: this.#extension,
        state,
        viewport,
        initialTitle: attached.controller.title,
        fileTransferLimits,
        downloadDirectoryConfigured: this.#downloadDirectory !== undefined,
        localOpenRequestTimeoutMs,
        hookTimeoutMs: this.#hookTimeoutMs,
        withClipboardExclusive: (operation) => this.#withClipboardExclusive(operation),
        onDisposed: () => {
          this.#extension.releaseSession(input.sessionId)
          this.#extension.releaseTarget(attachedTargetId)
          this.#sessions.delete(input.sessionId)
          if (this.#targetOwners.get(attachedTargetId) === input.sessionId) {
            this.#targetOwners.delete(attachedTargetId)
          }
        },
      })
      this.#sessions.set(input.sessionId, session)
      await session.initializeOwnedChildren()
      await session.initializePageScript()
      return session
    } catch (cause) {
      if (session !== undefined) {
        // The returned handle is not yet published, but its Core ownership must survive a
        // failed initializer/close so the Embedder can retry cleanup by Session identity.
        await session.close('Attachment initialization failed').catch(() => undefined)
      } else {
        let pending: Promise<void> | undefined
        const cleanup = {
          browser,
          close: (options?: RemoteTabCloseOptions): Promise<void> => {
            pending ??= Promise.resolve().then(async () => {
              if (ownershipConflict) {
                await attached?.controller.detach().catch(() => undefined)
                if (input.tab.mode === 'create' && attached && !options?.browserClosed)
                  await browser!.closePageTarget(attached.targetId).catch(error => {
                    if (!(error instanceof RemoteTabError) || error.code !== 'TAB_NOT_FOUND') throw error
                  })
              } else await attached?.controller.close(options)
              await browser?.cleanupFailedAttachments(options)
              if (attached !== undefined) this.#extension.releaseTarget(attached.targetId)
              if (ownedTargetId !== undefined && this.#targetOwners.get(ownedTargetId) === input.sessionId)
                this.#targetOwners.delete(ownedTargetId)
              this.#pendingAttachments.delete(input.sessionId)
              this.#pendingCleanup.delete(input.sessionId)
              browser?.close()
            }).catch(error => { pending = undefined; throw error })
            return pending
          },
        }
        this.#pendingCleanup.set(input.sessionId, cleanup)
        await cleanup.close().catch(() => undefined)
      }
      if (state.canTransitionTo('FAILED')) state.transition('FAILED', safeError(cause).message)
      throw cause
    } finally {
      if (!this.#pendingCleanup.has(input.sessionId)) this.#pendingAttachments.delete(input.sessionId)
      if (requestedTargetId !== undefined) this.#targetReservations.delete(requestedTargetId)
    }
  }

  /** Also covers an attachment that rejected before its Session handle reached the Embedder. */
  public async closeSession(sessionId: string, reason: string, options?: RemoteTabCloseOptions): Promise<void> {
    await this.#attaching.get(sessionId)?.catch(() => undefined)
    await this.#sessions.get(sessionId)?.close(reason, options)
    await this.#pendingCleanup.get(sessionId)?.close(options)
  }

  public async close(reason = 'Remote Tab Core shutting down'): Promise<void> {
    const ids = new Set([...this.#sessions.keys(), ...this.#attaching.keys(), ...this.#pendingCleanup.keys()])
    const results = await Promise.allSettled([...ids].map(id => this.closeSession(id, reason)))
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }

  #withClipboardExclusive<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.#clipboardChain.then(operation, operation)
    this.#clipboardChain = result.then(() => undefined, () => undefined)
    return result
  }
}

interface RemoteTabSessionImplementationOptions {
  input: AttachSessionInput
  browser: CdpBrowser
  attached: AttachedCdpTab
  extension: ExtensionLoopbackServer
  state: RemoteTabStateMachine
  viewport: Viewport
  initialTitle: string | undefined
  fileTransferLimits: FileTransferLimits
  downloadDirectoryConfigured: boolean
  localOpenRequestTimeoutMs: number
  hookTimeoutMs: number
  withClipboardExclusive<Result>(operation: () => Promise<Result>): Promise<Result>
  onDisposed(): void
}

interface PendingFileChooser {
  requestId: string
  backendNodeId: number
  multiple: boolean
  expiresAt: number
  timer: ReturnType<typeof setTimeout>
}

interface UploadFileState {
  descriptor: FileDescriptor
  reservation: SessionStorageReservation
  nextOffset: number
}

interface UploadTransferState {
  requestId: string
  transferId: string
  backendNodeId: number
  files: Map<string, UploadFileState>
  timer: ReturnType<typeof setTimeout>
}

interface DownloadTransferState {
  guid: string
  transferId: string
  descriptor: FileDescriptor
  localPath: string
  viewerGeneration: number
  accepted: boolean
  timer: ReturnType<typeof setTimeout>
}

interface ClipboardWriteItemState {
  descriptor: ClipboardItemDescriptor
  chunks: Uint8Array<ArrayBuffer>[]
  nextOffset: number
}

interface ClipboardWriteTransferState {
  requestId: string
  transferId: string
  items: Map<string, ClipboardWriteItemState>
  timer: ReturnType<typeof setTimeout>
}

interface ClipboardReadItemState {
  descriptor: ClipboardItemDescriptor
  data: Uint8Array<ArrayBuffer>
}

interface ClipboardReadTransferState {
  requestId: string
  transferId: string
  viewerGeneration: number
  items: readonly ClipboardReadItemState[]
  accepted: boolean
  timer: ReturnType<typeof setTimeout>
}

interface PendingLocalOpenRequest {
  requestId: string
  url: string
  expiresAt: number
  viewerGeneration: number
  timer: ReturnType<typeof setTimeout>
}

type ViewerUploadMessage = Extract<
  ProtocolMessage,
  {
    type:
      | 'file.upload.offer'
      | 'file.upload.chunk'
      | 'file.upload.complete'
      | 'file.upload.cancel'
  }
>

type ViewerDownloadMessage = Extract<
  ProtocolMessage,
  {
    type: 'file.download.accept' | 'file.download.cancel' | 'file.download.result'
  }
>

type ViewerClipboardWriteMessage = Extract<
  ProtocolMessage,
  {
    type:
      | 'clipboard.write.offer'
      | 'clipboard.write.chunk'
      | 'clipboard.write.complete'
  }
>

type ViewerClipboardReadMessage = Extract<
  ProtocolMessage,
  { type: 'clipboard.read.request' | 'clipboard.read.accept' | 'clipboard.read.result' }
>

class RemoteTabSessionImplementation implements RemoteTabSession {
  readonly #input: AttachSessionInput
  readonly #browser: CdpBrowser
  readonly #attached: AttachedCdpTab
  #activeTab: AttachedCdpTab
  #windowRevision = 0
  #catalogRevision = 0
  #captureRevision = 0
  #endedCaptureRevision: number | undefined
  #windowSwitching = false
  #windowRecoveryQueued = false
  readonly #windowTabs = new Map<string, AttachedCdpTab>()
  readonly #windowSubscriptions = new Map<string, () => void>()
  readonly #sinkAborts = new Map<string, Promise<void>>()
  readonly #sinkReservations = new Set<string>()
  readonly #downloadCommits = new Set<Promise<void>>()
  readonly #downloadSources = new Map<string, CdpTabController>()
  readonly #extension: ExtensionLoopbackServer
  readonly #state: RemoteTabStateMachine
  readonly #hookTimeoutMs: number
  readonly #fileTransferLimits: FileTransferLimits
  readonly #downloadDirectoryConfigured: boolean
  readonly #localOpenRequestTimeoutMs: number
  readonly #withClipboardExclusive: <Result>(operation: () => Promise<Result>) => Promise<Result>
  readonly #onDisposed: () => void
  #capabilities: readonly Capability[]
  #viewerCapabilities: readonly Capability[] = []
  #viewerGeneration: number | undefined
  #viewerProtocolMinor: number | undefined
  readonly #mediaLimits: SessionMediaLimits
  #quality: MediaQualitySettings
  #qualityConfiguration: QualityConfiguration | undefined
  #advancedQualityConfigured = false
  #advancedQualityState: QualityState | undefined
  readonly #qualityRequests = new Map<string, { clientRequestId?: string; viewerGeneration: number; cancelled?: true }>()
  #viewport: Viewport
  #currentUrl: string | undefined
  #title: string | undefined
  #signaling: CoreSignalingClient | undefined
  #signalingRetryTimer: ReturnType<typeof setTimeout> | undefined
  #signalingRetryAttempt = 0
  #viewerTicketExpiresAtMs = 0
  #outboundSequence = 0
  #controlChain = Promise.resolve()
  #closed = false
  #termination: Promise<void> | undefined
  #terminationReason: { reason: string; failed: boolean } | undefined
  #browserClosed = false
  #pendingFileChooser: PendingFileChooser | undefined
  #uploadTransfer: UploadTransferState | undefined
  #uploadReservedBytes = 0
  readonly #downloadReservedBytes = new Map<string, number>()
  readonly #downloadTransfers = new Map<string, DownloadTransferState>()
  #clipboardWriteTransfer: ClipboardWriteTransferState | undefined
  #clipboardReadTransfer: ClipboardReadTransferState | undefined
  #noticeControlAvailable = false
  #deferredInitialUrl: string | undefined
  readonly #navigationConfirmations = new Set<AbortController>()
  readonly #noticeRequests = new NoticeRequests(
    (payload) => this.#send('notice.request', payload),
    (payload) => this.#send('notice.cancel', payload),
  )
  readonly #pendingLocalOpenRequests = new Map<string, PendingLocalOpenRequest>()
  #unsubscribeMediaSignal: () => void
  #unsubscribeMediaControl: () => void
  #unsubscribeCdp: () => void

  public constructor(options: RemoteTabSessionImplementationOptions) {
    this.#input = options.input
    if (options.input.tab.mode === 'create' && options.input.tab.deferUntilViewer && options.input.tab.initialUrl !== 'about:blank') {
      this.#deferredInitialUrl = options.input.tab.initialUrl
    }
    this.#browser = options.browser
    this.#attached = options.attached
    this.#activeTab = options.attached
    this.#windowTabs.set(options.attached.targetId, options.attached)
    this.#currentUrl = options.attached.controller.currentUrl
    this.#extension = options.extension
    this.#state = options.state
    this.#mediaLimits = normalizeMediaLimits(options.input.mediaLimits)
    this.#quality = limitQuality(QUALITY_PRESETS.balanced, this.#mediaLimits)
    this.#viewport = options.viewport
    this.#hookTimeoutMs = options.hookTimeoutMs
    this.#fileTransferLimits = options.fileTransferLimits
    this.#downloadDirectoryConfigured = options.downloadDirectoryConfigured
    this.#localOpenRequestTimeoutMs = options.localOpenRequestTimeoutMs
    this.#withClipboardExclusive = options.withClipboardExclusive
    this.#onDisposed = options.onDisposed
    this.#capabilities = normalizeCapabilities(options.input.capabilities)
    this.#unsubscribeMediaSignal = this.#extension.onMediaSignal((signal) =>
      this.#handleMediaSignal(signal),
    )
    this.#unsubscribeMediaControl = this.#extension.onMediaControl(this.id, (bytes) => {
      try {
        const message = decodeProtocolMessage(bytes)
        if (message === undefined) return
        // User decisions must unblock commands waiting for a prompt. All messages still pass
        // the same Session, generation, state and capability checks below.
        if (message.type === 'notice.response') {
          void this.#handleControl(message).catch((cause: unknown) => this.#handleControlError(cause))
        } else {
          this.#controlChain = this.#controlChain
            .then(() => this.#handleControl(message))
            .catch((cause: unknown) => this.#handleControlError(cause))
        }
      } catch (cause) {
        void this.#handleControlError(cause)
      }
    })
    this.#unsubscribeCdp = this.#observeTab(this.#attached)
    if (options.initialTitle !== undefined) this.#notifyTitle(options.initialTitle)
  }

  #observeTab(tab: AttachedCdpTab): () => void {
    return tab.controller.onEvent((event) => {
      if (event.type === 'tab-unavailable' && tab !== this.#attached) {
        if (tab === this.#activeTab) this.#queueWindowRecovery()
        return
      }
      if (tab === this.#attached && (event.type === 'child-target-created' || event.type === 'child-target-changed' || event.type === 'child-target-closed')) {
        if (event.type === 'child-target-closed' && event.targetId === this.#activeTab.targetId) this.#queueWindowRecovery()
        this.#publishWindows()
      }
      if (event.type === 'title-changed' || event.type === 'location-changed') this.#publishWindows()
      if (tab !== this.#activeTab && !['child-target-created', 'child-target-changed', 'child-target-closed', 'download-completed', 'download-progress', 'tab-unavailable'].includes(event.type)) return
      if (event.type === 'tab-unavailable') {
        try {
          this.#sendError(event.error.code, event.error.message)
        } catch {
          // The media runtime may already be unavailable with the Chrome target.
        }
        void this.#fail(event.error)
      } else if (event.type === 'location-changed') {
        this.#currentUrl = event.url
        this.#publishLocation()
      } else if (event.type === 'title-changed') {
        this.#notifyTitle(event.title)
      } else if (event.type === 'navigation-blocked') {
        this.#send('notice', { level: 'warning', code: 'NAVIGATION_DENIED', message: event.reason })
      } else if (event.type === 'file-chooser-opened') {
        this.#controlChain = this.#controlChain
          .then(() => {
            // This event may have waited behind a window selection on the control queue.
            if (tab !== this.#activeTab || this.#windowSwitching) return
            return this.#handleFileChooser(event.backendNodeId, event.multiple)
          })
          .catch((cause: unknown) => this.#handleControlError(cause))
      } else if (event.type === 'child-target-created' && tab === this.#attached) {
        const shouldCloseChild = this.#input.childTargetPolicy !== 'retain'
        this.#controlChain = this.#controlChain
          .then(async () => {
            if (shouldCloseChild && this.#attached.controller.ownsTarget(event.targetId)) {
              await this.#attached.controller.closeChildTarget(event.targetId)
            }
            await this.#handleChildTarget(event.targetId, event.url, shouldCloseChild)
          })
          .catch((cause: unknown) => this.#handleControlError(cause))
      } else if (event.type === 'local-open-requested') {
        this.#controlChain = this.#controlChain
          .then(async () => {
            this.#audit('child-target.intercepted', {})
            await this.#handleLocalOpenRequest(event.url)
          })
          .catch((cause: unknown) => this.#handleControlError(cause))
      } else if (event.type === 'download-progress') {
        if (event.state === 'canceled') {
          this.#downloadReservedBytes.delete(event.guid)
          this.#downloadSources.delete(event.guid)
          void this.#abortDownloadSink(event.guid).catch(() => undefined)
        } else {
          this.#downloadSources.set(event.guid, tab.controller)
          this.#reserveDownloadBytes(event.guid, Math.max(event.totalBytes, event.receivedBytes))
        }
      } else if (event.type === 'download-completed') {
        this.#downloadSources.set(event.guid, tab.controller)
        if (this.#input.downloadSink !== undefined) {
          // Register work before yielding so Session close waits for files already completed by Chrome.
          const operation = this.#handleDownloadCompleted(event).catch(async () => {
            await this.#removeDownload(event.guid).catch(() => undefined)
            this.#audit('download.failed', { code: 'FILE_TRANSFER_FAILED' })
            if (!this.#closed) this.#send('notice', { level: 'error', code: 'FILE_TRANSFER_FAILED', message: 'The download could not be retained.' })
          })
          this.#downloadCommits.add(operation)
          void operation.then(
            () => { this.#downloadCommits.delete(operation) },
            () => { this.#downloadCommits.delete(operation) },
          )
        } else {
          this.#controlChain = this.#controlChain
            .then(() => this.#handleDownloadCompleted(event))
            .catch((cause: unknown) => this.#handleControlError(cause))
        }
      } else if (event.type === 'page-script-event') {
        callNotificationHook(() =>
          this.#input.hooks.onDiagnostic?.({
            sessionId: this.id,
            name: 'page-script.lifecycle',
            occurredAt: event.occurredAt,
            fields: { eventName: event.name },
          }),
        )
        if (
          this.#state.state === 'CONNECTED' ||
          this.#state.state === 'SUSPENDED' ||
          (this.#state.state === 'CLOSING' && event.name === 'browshare:on_session_detached')
        ) {
          this.#send('page.lifecycle', {
            name: event.name,
            occurredAt: event.occurredAt,
            ...(event.location === undefined ? {} : { location: event.location }),
          })
        }
      } else if (event.type === 'page-script-error') {
        callNotificationHook(() =>
          this.#input.hooks.onDiagnostic?.({
            sessionId: this.id,
            name: 'page-script.error',
            occurredAt: event.occurredAt,
            fields: { message: event.message },
          }),
        )
      }
    })
  }

  public get id(): string {
    return this.#input.sessionId
  }

  public getState() {
    return this.#state.state
  }

  public ownsTarget(targetId: string): boolean {
    return this.#attached.controller.ownsTarget(targetId)
  }

  public getAttachment() {
    return {
      targetId: this.#attached.targetId,
      tabId: this.#attached.tabId,
    }
  }

  public isSelectedWindow(targetId: string): boolean { return this.#activeTab.targetId === targetId }

  public getWindowState(): WindowState {
    return {
      revision: this.#windowRevision, selectedTargetId: this.#activeTab.targetId, selecting: this.#windowSwitching,
      windows: [
        { targetId: this.#attached.targetId, title: Array.from(this.#attached.controller.title ?? '').slice(0, 256).join(''), url: Array.from(this.#attached.controller.currentUrl).slice(0, 512).join(''), main: true },
        ...this.#attached.controller.getChildTargets().map(child => ({ targetId: child.targetId,
          title: Array.from(child.title).slice(0, 256).join(''), url: Array.from(child.url).slice(0, 512).join(''), main: false })),
      ],
    }
  }

  #publishWindows(requestId?: string, error?: RemoteTabError): void {
    if (this.#closed || !this.#noticeControlAvailable || !this.#viewerCapabilities.includes('windowSelection')) return
    const state = { ...this.getWindowState(), ...(requestId === undefined ? {} : { requestId }),
      ...(error === undefined ? {} : { error: { code: error.code, retryable: error.retryable,
        message: Array.from(error.message).slice(0, 512).join('') || 'Window selection failed' } }) }
    for (const frame of splitWindowState(state, ++this.#catalogRevision, this.id, this.#viewerGeneration!)) {
      this.#send('window.state', frame)
    }
  }

  async #getWindow(targetId: string): Promise<AttachedCdpTab> {
    if (!this.#attached.controller.ownsTarget(targetId)) throw new RemoteTabError('TAB_NOT_FOUND', 'Window is not owned by this Session')
    const existing = this.#windowTabs.get(targetId)
    if (existing !== undefined) return existing
    const tab = await this.#browser.attachTab({ mode: 'adopt', targetId }, this.#extension)
    try {
      await tab.controller.enableNavigationInterception(async (request, signal) => {
        const decision = await withTimeout(this.#input.hooks.authorizeNavigation({
          sessionId: this.id, action: 'go', source: 'document', ...request,
        }), this.#hookTimeoutMs, new RemoteTabError('NAVIGATION_DENIED', 'Navigation authorization timed out'))
        if (!decision.allowed || decision.confirmation === undefined) return decision
        if (tab !== this.#activeTab) return { allowed: false, reason: 'Select this window before confirming navigation' }
        return this.confirmNavigation(decision, signal)
      })
      if (this.#closed || !this.#attached.controller.ownsTarget(targetId)) throw new RemoteTabError('TAB_NOT_FOUND', 'Window closed while attaching')
      this.#windowTabs.set(targetId, tab)
      this.#windowSubscriptions.set(targetId, this.#observeTab(tab))
      await tab.controller.observeTitle()
      await this.initializePageScript(tab)
      return tab
    } catch (cause) {
      this.#windowSubscriptions.get(targetId)?.()
      this.#windowSubscriptions.delete(targetId)
      this.#windowTabs.delete(targetId)
      await tab.controller.detach().catch(() => undefined)
      this.#extension.releaseTarget(targetId)
      throw cause
    }
  }

  #queueWindowRecovery(): void {
    if (this.#closed || this.#activeTab === this.#attached || this.#windowSwitching || this.#windowRecoveryQueued) return
    this.#windowRecoveryQueued = true
    this.#windowSwitching = true
    this.#noticeRequests.cancelAll('cancelled')
    this.#publishWindows()
    this.#controlChain = this.#controlChain.then(async () => {
      this.#windowRecoveryQueued = false
      await this.#selectWindow(this.#attached.targetId, undefined, true)
    }).catch(cause => this.#fail(safeError(cause)))
  }

  async #selectWindow(targetId: string, requestId?: string, recovering = false): Promise<boolean> {
    this.#requireActiveCapability('windowSelection')
    if (targetId === this.#activeTab.targetId && !recovering) { this.#publishWindows(requestId); return true }
    const generation = this.#viewerGeneration!
    let replacing = false
    this.#windowSwitching = true
    this.#windowRevision++
    this.#publishWindows()
    try {
      const tab = await this.#getWindow(targetId)
      await this.#cancelFileFlow('Window selection changed', true, false)
      this.#cancelClipboardTransfers('Window selection changed', true)
      this.#noticeRequests.cancelAll('cancelled')
      if (!recovering) await this.#activeTab.controller.releaseInput()
      const viewport = await tab.controller.setViewport(this.#viewport)
      const streamId = await this.#extension.prepareCapture({ sessionId: this.id, viewerGeneration: generation,
        targetId: tab.targetId, tabId: tab.tabId })
      if (this.#closed || generation !== this.#viewerGeneration) throw new RemoteTabError('VIEWER_REPLACED', 'Viewer changed during window selection')
      replacing = true
      await this.#extension.replaceMediaCapture({ sessionId: this.id, viewerGeneration: generation, streamId,
        viewport: { ...viewport, frameRate: this.#viewport.frameRate },
        captureFrameRateLimit: this.#mediaLimits.maxFrameRate, audio: this.#viewerCapabilities.includes('tabAudio'),
        captureRevision: this.#windowRevision })
      if (this.#closed || this.#endedCaptureRevision === this.#windowRevision || !this.#attached.controller.ownsTarget(tab.targetId)) throw new RemoteTabError('TAB_NOT_FOUND', 'Selected window closed')
      this.#captureRevision = this.#windowRevision
      this.#activeTab = tab
      this.#viewport = { ...viewport, frameRate: this.#viewport.frameRate }
      this.#currentUrl = tab.controller.currentUrl
      this.#notifyTitle(tab.controller.title ?? '')
      this.#send('viewport.ack', this.#viewport)
      this.#publishLocation()
      this.#windowSwitching = false
      this.#publishWindows(requestId)
      this.#notifyInput()
      return true
    } catch (cause) {
      this.#windowSwitching = false
      if (replacing || recovering) { await this.#fail(safeError(cause)); return false }
      this.#publishWindows(requestId, safeError(cause))
      if (!this.#attached.controller.ownsTarget(this.#activeTab.targetId) || this.#endedCaptureRevision === this.#captureRevision) {
        if (this.#activeTab === this.#attached) await this.#fail(safeError(cause))
        else this.#queueWindowRecovery()
      }
      return false
    }
  }

  #abortDownloadSink(downloadId: string): Promise<void> {
    const existing = this.#sinkAborts.get(downloadId)
    if (existing !== undefined) return existing
    if (!this.#sinkReservations.delete(downloadId)) return Promise.resolve()
    const operation = Promise.resolve().then(() => this.#input.downloadSink!.abort({ sessionId: this.id, downloadId }))
    this.#sinkAborts.set(downloadId, operation)
    void operation.then(
      () => { this.#sinkAborts.delete(downloadId) },
      () => { this.#sinkAborts.delete(downloadId) },
    )
    return operation
  }

  async #removeDownload(guid: string): Promise<void> {
    const controller = this.#downloadSources.get(guid) ?? this.#attached.controller
    this.#downloadSources.delete(guid)
    try { await controller.removeDownload(guid) }
    finally {
      this.#downloadReservedBytes.delete(guid)
      await this.#abortDownloadSink(guid)
    }
  }

  public async sampleFrameChange(): Promise<{ changed: boolean; observedAt: number }> {
    if (this.#closed) throw new RemoteTabError('SESSION_CLOSED', 'Session is closed')
    const changed = await this.#activeTab.controller.sampleFrameChange()
    if (this.#closed) throw new RemoteTabError('SESSION_CLOSED', 'Session is closed')
    return { changed, observedAt: Date.now() }
  }

  public async initializeOwnedChildren(): Promise<void> {
    if (this.#input.childTargetPolicy === 'retain') return
    // Discovery can precede this Session's listener (adopted pages and initial navigation).
    this.#controlChain = this.#controlChain.then(async () => {
      for (const child of this.#attached.controller.getChildTargets()) {
        if (this.#attached.controller.ownsTarget(child.targetId)) await this.#attached.controller.closeChildTarget(child.targetId)
      }
    })
    await this.#controlChain
  }

  public async initializePageScript(tab = this.#activeTab): Promise<void> {
    const pageScript = this.#input.pageScript
    if (pageScript === undefined) return
    try {
      await tab.controller.installPageScript({
        sessionId: this.id,
        source: pageScript.source,
        ...(this.#capabilities.includes('noticeRequests') ? {
          requestNotice: (content: import('@browshare/remote-tab-protocol').NoticeContent, options: NoticeRequestOptions) => {
            if (tab !== this.#activeTab || this.#windowSwitching) throw new RemoteTabError('CAPABILITY_UNAVAILABLE', 'Only the selected window can request a Viewer decision')
            return this.requestNotice(content, options)
          },
        } : {}),
        ...(pageScript.context === undefined ? {} : { context: pageScript.context }),
      })
    } catch (cause) {
      callNotificationHook(() =>
        this.#input.hooks.onDiagnostic?.({
          sessionId: this.id,
          name: 'page-script.error',
          occurredAt: Date.now(),
          fields: { message: safeError(cause).message.slice(0, 512) },
        }),
      )
    }
  }

  #notifyTitle(title: string): void {
    if (this.#closed || title === this.#title) return
    this.#title = title
    callNotificationHook(() => this.#input.hooks.onTitleChanged?.({ sessionId: this.id, title }))
  }

  public async createViewerTicket(
    input: Omit<ViewerTicketRequest, 'sessionId'>,
  ): Promise<ViewerTicket> {
    if (!['READY', 'NEGOTIATING', 'CONNECTED', 'SUSPENDED', 'RECONNECTING'].includes(this.#state.state)) {
      throw new RemoteTabError(
        'ILLEGAL_STATE_TRANSITION',
        'A Viewer ticket cannot be issued in the current Session state',
      )
    }
    if (input.gatewayId !== this.#input.signaling.gatewayId) {
      throw new RemoteTabError(
        'SIGNALING_AUTH_FAILED',
        'Viewer ticket requested a different assigned Gateway',
      )
    }
    if (this.#viewerGeneration !== undefined && input.viewerGeneration <= this.#viewerGeneration) {
      throw new RemoteTabError(
        'VIEWER_REPLACED',
        'Viewer generation must increase for each issued ticket',
      )
    }
    const requestedCapabilities = normalizeCapabilities(input.capabilities)
    for (const capability of requestedCapabilities) {
      if (!this.#capabilities.includes(capability)) {
        throw new RemoteTabError(
          'CAPABILITY_UNAVAILABLE',
          `Viewer capability is not granted: ${capability}`,
        )
      }
    }

    const request = {
      ...input,
      sessionId: this.id,
      capabilities: requestedCapabilities,
    }
    const ticket = await this.#input.ticketIssuer.issueViewerTicket(request)
    assertTicketBinding(ticket, request)
    this.#cancelSignalingRetry()
    const previousSignaling = this.#signaling
    const previousState = this.#state.state
    if (
      previousSignaling !== undefined &&
      (previousState === 'CONNECTED' || previousState === 'SUSPENDED')
    ) {
      try {
        previousSignaling.sendError(
          new RemoteTabError(
            'VIEWER_REPLACED',
            'Viewer was replaced by a newer authorized connection',
          ).toJSON(),
        )
      } catch {
        // Replacement must not fail just because the retiring Viewer cannot be notified.
      }
    }
    if (this.#viewerGeneration !== undefined) {
      this.#noticeRequests.cancelAll('viewer-replaced')
      this.#cancelLocalOpenRequests()
      this.#cancelClipboardTransfers('Viewer generation replaced', false)
      await this.#queueFileFlowCancellation('Viewer generation replaced', this.#input.downloadSink === undefined)
      await this.#extension.stopMedia(this.id, 'Viewer generation replaced')
      if (!requestedCapabilities.includes('windowSelection') && this.#activeTab !== this.#attached) {
        this.#activeTab = this.#attached
        this.#windowRevision++
        this.#windowSwitching = false
        const applied = await this.#attached.controller.setViewport(this.#viewport)
        this.#viewport = { ...applied, frameRate: this.#viewport.frameRate }
        this.#currentUrl = this.#attached.controller.currentUrl
        this.#notifyTitle(this.#attached.controller.title ?? '')
      }
    }
    this.#signaling = undefined
    this.#viewerGeneration = input.viewerGeneration
    this.#viewerProtocolMinor = undefined
    this.#advancedQualityConfigured = false
    this.#advancedQualityState = undefined
    this.#qualityRequests.clear()
    this.#viewerCapabilities = requestedCapabilities
    this.#viewerTicketExpiresAtMs = ticket.claims.expiresAt * 1_000
    this.#signalingRetryAttempt = 0
    if (previousState === 'READY') {
      this.#state.transition('NEGOTIATING')
    } else if (previousState === 'CONNECTED' || previousState === 'SUSPENDED') {
      this.#state.transition('RECONNECTING')
    }
    await previousSignaling?.close().catch(() => undefined)
    if (this.#closed) {
      throw new RemoteTabError('SESSION_CLOSED', 'Remote Tab Session closed before Viewer negotiation')
    }
    this.#startNegotiation(input.viewerGeneration)
    return ticket
  }

  public async updateCapabilities(next: readonly Capability[]): Promise<void> {
    if (isTerminalRemoteTabState(this.#state.state)) {
      throw new RemoteTabError('SESSION_CLOSED', 'Cannot update a closed Remote Tab Session')
    }
    const normalized = normalizeCapabilities(next)
    if (normalized.includes('windowSelection') && this.#input.childTargetPolicy !== 'retain') {
      throw new RemoteTabError('CAPABILITY_UNAVAILABLE', 'Window selection requires retained child targets')
    }
    if (normalized.includes('download') && !this.#downloadDirectoryConfigured) {
      throw new RemoteTabError(
        'CAPABILITY_UNAVAILABLE',
        'File download requires a configured Chrome download directory',
      )
    }
    if (!normalized.includes('windowSelection') && this.#viewerCapabilities.includes('windowSelection')) {
      // A queued selection may leave the root before revocation reaches the control queue.
      const returned = this.#controlChain.then(() => {
        if (this.#activeTab === this.#attached || !['CONNECTED', 'SUSPENDED'].includes(this.#state.state)) return true
        return this.#selectWindow(this.#attached.targetId)
      })
      this.#controlChain = returned.then(() => undefined).catch(cause => this.#handleControlError(cause))
      if (!await returned) throw new RemoteTabError('CAPTURE_DENIED', 'Could not return to the main window before revocation')
    }
    if (this.#advancedQualityAvailable() && (!normalized.includes('advancedQuality') || !normalized.includes('qualityControl'))) {
      this.#cancelQualityRequests('Advanced quality capability was revoked')
      this.#qualityConfiguration = undefined
      this.#advancedQualityConfigured = false
      this.#advancedQualityState = undefined
      if (this.#state.state === 'CONNECTED' || this.#state.state === 'SUSPENDED') this.#extension.setMediaQuality(this.id, this.#quality)
    }
    this.#capabilities = normalized
    if (!normalized.includes('noticeRequests')) this.#noticeRequests.cancelAll('capability-revoked')
    if (!normalized.includes('navigationConfirmation')) {
      for (const pending of this.#navigationConfirmations) pending.abort()
    }
    this.#viewerCapabilities = this.#viewerCapabilities.filter((capability) =>
      this.#capabilities.includes(capability),
    )
    if (!this.#capabilities.includes('upload')) {
      await this.#queueFileFlowCancellation('Upload capability was revoked', false)
    }
    if (!this.#capabilities.includes('download')) {
      await this.#cancelAllDownloads('Download capability was revoked', true)
    }
    if (
      !this.#capabilities.includes('clipboardText') &&
      !this.#capabilities.includes('clipboardImage')
    ) {
      this.#cancelClipboardTransfers('Clipboard capability was revoked', true)
    }
    if ((this.#viewerProtocolMinor ?? 0) >= 2 && !this.#closed) {
      this.#send('session.capabilities', { capabilities: [...this.#viewerCapabilities] })
    }
  }

  public sendNotice(notice: ProtocolPayload<'notice'>): void {
    if (this.#state.state !== 'CONNECTED' && this.#state.state !== 'SUSPENDED') {
      throw new RemoteTabError(
        'ILLEGAL_STATE_TRANSITION',
        'A Notice requires an active Viewer control channel',
      )
    }
    this.#send('notice', notice)
  }

  public requestNotice(
    content: import('@browshare/remote-tab-protocol').NoticeContent,
    options?: NoticeRequestOptions,
  ): Promise<NoticeResult> {
    this.#requireActiveCapability('noticeRequests')
    if (!this.#noticeControlAvailable) throw new RemoteTabError('CAPABILITY_UNAVAILABLE', 'Viewer Notice channel is closed')
    return this.#noticeRequests.request(content, options)
  }

  public async confirmNavigation(decision: NavigationDecision, signal: AbortSignal): Promise<NavigationDecision> {
    const confirmation = decision.confirmation!
    const pending = new AbortController()
    this.#navigationConfirmations.add(pending)
    const cancellation = AbortSignal.any([signal, pending.signal])
    try {
      this.#requireActiveCapability('navigationConfirmation')
      const result = await this.requestNotice({
        kind: 'confirm', title: confirmation.title, body: confirmation.body,
        buttons: [{ id: 'navigate', label: confirmation.confirmLabel }],
      }, { signal: cancellation, timeoutMs: 60_000 })
      if (result.reason === 'response' && result.buttonId === 'navigate' && !cancellation.aborted) {
        return { allowed: true, ...(decision.url === undefined ? {} : { url: decision.url }) }
      }
      return { allowed: false, reason: 'Navigation confirmation was cancelled or expired' }
    } catch {
      return { allowed: false, reason: 'Navigation confirmation is unavailable' }
    } finally {
      this.#navigationConfirmations.delete(pending)
    }
  }

  public close(reason: string, options?: RemoteTabCloseOptions): Promise<void> {
    if (options?.browserClosed) {
      this.#browserClosed = true
      // Forward proof to an already-running controller close as well as the next attempt.
      void this.#attached.controller.close(options).catch(() => undefined)
    }
    return this.#terminate(reason)
  }

  #startNegotiation(viewerGeneration: number): void {
    if (
      this.#closed ||
      this.#viewerGeneration !== viewerGeneration ||
      Date.now() >= this.#viewerTicketExpiresAtMs
    ) {
      this.#finishNegotiationFailure('Viewer ticket expired before signaling paired')
      return
    }
    const remainingTicketMs = this.#viewerTicketExpiresAtMs - Date.now()
    const configuredTimeoutMs = this.#input.signaling.connectionTimeoutMs ?? 15_000
    const signaling = new CoreSignalingClient({
      endpoint: this.#input.signaling.endpoint,
      gatewayId: this.#input.signaling.gatewayId,
      bindingToken: this.#input.signaling.bindingToken,
      sessionId: this.id,
      viewerGeneration,
      connectionTimeoutMs: Math.max(1, Math.min(configuredTimeoutMs, remainingTicketMs)),
    })
    this.#signaling = signaling
    signaling.onEvent((event) => this.#handleSignalingEvent(signaling, event))
    void signaling
      .connect()
      .then(async (ready) => {
        if (this.#closed || this.#signaling !== signaling) {
          return
        }
        this.#signalingRetryAttempt = 0
        this.#viewerCapabilities = this.#viewerCapabilities.filter((capability) =>
          ready.capabilities.includes(capability),
        )
        const streamId = await this.#extension.prepareCapture({
          sessionId: this.id,
          targetId: this.#activeTab.targetId,
          tabId: this.#activeTab.tabId,
          viewerGeneration,
        })
        if (this.#closed || this.#signaling !== signaling) {
          return
        }
        this.#captureRevision = this.#windowRevision
        this.#endedCaptureRevision = undefined
        this.#extension.startMedia({
          sessionId: this.id,
          viewerGeneration,
          tabId: this.#activeTab.tabId,
          streamId,
          capabilities: this.#viewerCapabilities,
          iceServers: ready.iceServers,
          iceTransportPolicy: ready.iceTransportPolicy,
          viewport: this.#viewport,
          captureFrameRateLimit: this.#mediaLimits.maxFrameRate,
          quality: this.#quality,
          audio: this.#viewerCapabilities.includes('tabAudio'),
          ...(this.#viewerCapabilities.includes('windowSelection') ? { captureRevision: this.#windowRevision } : {}),
        })
      })
      .catch((cause: unknown) => this.#handleSignalingFailure(signaling, safeError(cause)))
  }

  #handleSignalingEvent(signaling: CoreSignalingClient, event: CoreSignalingEvent): void {
    if (this.#closed || this.#signaling !== signaling) {
      return
    }
    try {
      if (event.type === 'description') {
        this.#extension.sendMediaSignal({
          type: 'description',
          sessionId: this.id,
          description: event.description,
        })
      } else if (event.type === 'ice') {
        this.#extension.sendMediaSignal({
          type: 'ice',
          sessionId: this.id,
          candidate: event.candidate,
        })
      } else if (event.type === 'ice-restart-request') {
        this.#extension.restartMediaIce(this.id)
      } else if (event.type === 'peer-ready') {
        // Signaling pairing can complete before tab capture is prepared. The media runtime keeps
        // this readiness edge so the publisher can offer as soon as it is created.
        this.#extension.sendMediaPeerState(this.id, true)
      } else if (event.type === 'peer-left') {
        this.#handleViewerDeparture(signaling)
      } else if (event.type === 'error') {
        this.#handleSignalingFailure(
          signaling,
          new RemoteTabError(event.error.code, event.error.message, {
            retryable: event.error.retryable,
            ...(event.error.details === undefined ? {} : { details: event.error.details }),
          }),
        )
      }
    } catch (cause) {
      void this.#fail(safeError(cause))
    }
  }

  #handleViewerDeparture(signaling: CoreSignalingClient): void {
    if (this.#closed || this.#signaling !== signaling) {
      return
    }
    this.#cancelSignalingRetry()
    this.#signaling = undefined
    this.#extension.sendMediaPeerState(this.id, false)
    this.#noticeRequests.cancelAll('connection-lost')
    this.#cancelLocalOpenRequests()
    void this.#queueFileFlowCancellation('Viewer disconnected', this.#input.downloadSink === undefined)
    if (this.#state.state === 'NEGOTIATING') {
      this.#state.transition('READY', 'Viewer left before negotiation completed')
    } else if (this.#state.state === 'CONNECTED' || this.#state.state === 'SUSPENDED') {
      this.#state.transition('RECONNECTING', 'Viewer disconnected')
    } else if (this.#state.state === 'RECONNECTING') {
      this.#state.transition('READY', 'Replacement Viewer disconnected')
    }
    void signaling.close().catch(() => undefined)
  }

  #handleSignalingFailure(signaling: CoreSignalingClient, error: RemoteTabError): void {
    if (this.#closed || this.#signaling !== signaling) {
      return
    }
    this.#signaling = undefined
    if (this.#state.state === 'NEGOTIATING' || this.#state.state === 'RECONNECTING') {
      this.#extension.sendMediaPeerState(this.id, false)
      if (
        error.retryable &&
        this.#viewerGeneration !== undefined &&
        Date.now() < this.#viewerTicketExpiresAtMs
      ) {
        this.#scheduleSignalingRetry(this.#viewerGeneration)
      } else {
        this.#finishNegotiationFailure(error.message)
      }
    }
    void signaling.close().catch(() => undefined)
  }

  #scheduleSignalingRetry(viewerGeneration: number): void {
    this.#cancelSignalingRetry()
    const remainingTicketMs = this.#viewerTicketExpiresAtMs - Date.now()
    if (remainingTicketMs <= 0) {
      this.#finishNegotiationFailure('Viewer ticket expired before signaling paired')
      return
    }
    const delayMs = Math.min(
      SIGNALING_RETRY_MIN_DELAY_MS * 2 ** Math.min(this.#signalingRetryAttempt, 3),
      SIGNALING_RETRY_MAX_DELAY_MS,
      remainingTicketMs,
    )
    this.#signalingRetryAttempt += 1
    this.#signalingRetryTimer = setTimeout(() => {
      this.#signalingRetryTimer = undefined
      this.#startNegotiation(viewerGeneration)
    }, delayMs)
  }

  #cancelSignalingRetry(): void {
    if (this.#signalingRetryTimer !== undefined) {
      clearTimeout(this.#signalingRetryTimer)
      this.#signalingRetryTimer = undefined
    }
  }

  #finishNegotiationFailure(reason: string): void {
    if (this.#state.state === 'NEGOTIATING' || this.#state.state === 'RECONNECTING') {
      this.#state.transition('READY', reason)
    }
  }

  #handleMediaSignal(signal: ExtensionMediaSignal): void {
    if (this.#closed || signal.sessionId !== this.id) {
      return
    }
    try {
      if (signal.type === 'capture-ended') {
        if (signal.viewerGeneration !== this.#viewerGeneration) return
        this.#endedCaptureRevision = signal.captureRevision
        if (signal.captureRevision !== this.#captureRevision) return
        if (this.#activeTab === this.#attached) void this.#fail(new RemoteTabError('CAPTURE_DENIED', 'The main window capture ended'))
        else this.#queueWindowRecovery()
      } else if (signal.type === 'description') {
        this.#signaling?.sendDescription(signal.description)
      } else if (signal.type === 'ice') {
        this.#signaling?.sendIce(signal.candidate)
      } else if (signal.type === 'start-failed') {
        void this.#fail(signal.error)
      } else if (signal.type === 'suspension-changed') {
        const expectedState = signal.suspended ? 'SUSPENDED' : 'CONNECTED'
        if (this.#state.canTransitionTo(expectedState)) {
          this.#state.transition(expectedState)
          this.#send('session.state', { state: expectedState })
        }
      } else if (signal.type === 'quality-configuration') {
        if (!this.#advancedQualityAvailable()) return
        const pending = signal.requestId === undefined ? undefined : this.#qualityRequests.get(signal.requestId)
        if (signal.requestId !== undefined && (pending === undefined || pending.viewerGeneration !== this.#viewerGeneration)) return
        if (signal.requestId === undefined && !this.#advancedQualityConfigured) return
        if (signal.requestId !== undefined) this.#qualityRequests.delete(signal.requestId)
        this.#advancedQualityConfigured = true
        this.#qualityConfiguration = signal.state.configuration
        this.#advancedQualityState = signal.state
        if (pending?.cancelled) return
        this.#send('quality.configuration', { state: signal.state,
          ...(pending?.clientRequestId === undefined ? {} : { requestId: pending.clientRequestId }) })
      } else if (signal.type === 'quality-configuration-failed') {
        const pending = this.#qualityRequests.get(signal.requestId)
        this.#qualityRequests.delete(signal.requestId)
        if (!this.#advancedQualityAvailable() || pending === undefined || pending.viewerGeneration !== this.#viewerGeneration) return
        if (pending.cancelled) return
        if (pending.clientRequestId !== undefined) {
          this.#send('quality.configuration_failed', { requestId: pending.clientRequestId, error: signal.error.toJSON() })
        } else this.#sendError(signal.error.code, signal.error.message)
      } else if (signal.type === 'quality-changed') {
        this.#advancedQualityConfigured = false
        this.#advancedQualityState = undefined
        this.#qualityConfiguration = { mode: 'preset', preset: signal.settings.preset }
        this.#quality = signal.settings
        this.#send('quality.ack', signal.settings)
      } else if (signal.type === 'quality-failed') {
        this.#sendError(signal.error.code, signal.error.message)
        if (this.#advancedQualityAvailable() && this.#advancedQualityConfigured && this.#advancedQualityState !== undefined) {
          this.#send('quality.configuration', { state: this.#advancedQualityState })
        }
      } else if (signal.type === 'control-closed') {
        if (signal.viewerGeneration === this.#viewerGeneration) {
          this.#noticeControlAvailable = false
          this.#noticeRequests.cancelAll('connection-lost')
        }
      } else if (signal.type === 'diagnostic') {
        const { name, ...diagnosticFields } = signal.diagnostic
        const fields = Object.fromEntries(
          Object.entries(diagnosticFields).filter((entry) => entry[1] !== undefined),
        ) as Readonly<Record<string, string | number | boolean | null>>
        callNotificationHook(() =>
          this.#input.hooks.onDiagnostic?.({
            sessionId: this.id,
            name,
            occurredAt: Date.now(),
            fields,
          }),
        )
      }
    } catch (cause) {
      void this.#fail(safeError(cause))
    }
  }

  async #handleControl(message: ProtocolMessage): Promise<void> {
    if (this.#closed) {
      return
    }
    if (message.sessionId !== this.id || message.viewerGeneration !== this.#viewerGeneration) {
      this.#sendError('VIEWER_REPLACED', 'Control message belongs to a stale Viewer generation')
      return
    }
    if (message.type !== 'hello' && this.#state.state === 'NEGOTIATING') {
      if (message.type === 'quality.configure') this.#send('quality.configuration_failed', {
        requestId: message.payload.requestId,
        error: new RemoteTabError('ILLEGAL_STATE_TRANSITION', 'Viewer must complete the control handshake first').toJSON(),
      })
      else this.#sendError('ILLEGAL_STATE_TRANSITION', 'Viewer must complete the control handshake first')
      return
    }

    if (this.#viewerCapabilities.includes('windowSelection') && isWindowScopedMessage(message.type) &&
        (this.#windowSwitching || message.windowRevision !== this.#windowRevision)) {
      if (message.type === 'window.select' || message.type === 'window.close') this.#publishWindows(message.payload.requestId,
        new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Window selection changed before this request'))
      return
    }

    if (isViewerUploadMessage(message)) {
      await this.#handleUploadMessage(message)
      if (message.type === 'file.upload.offer') this.#notifyInput()
      return
    }
    if (isViewerDownloadMessage(message)) {
      await this.#handleDownloadMessage(message)
      if (message.type === 'file.download.accept') this.#notifyInput()
      return
    }
    if (isViewerClipboardWriteMessage(message)) {
      await this.#handleClipboardWriteMessage(message)
      if (message.type === 'clipboard.write.offer') this.#notifyInput()
      return
    }
    if (isViewerClipboardReadMessage(message)) {
      await this.#handleClipboardReadMessage(message)
      if (message.type === 'clipboard.read.request') this.#notifyInput()
      return
    }

    switch (message.type) {
      case 'window.close': {
        this.#requireActiveCapability('windowSelection')
        if (this.#activeTab === this.#attached) {
          this.#publishWindows(message.payload.requestId, new RemoteTabError('CAPABILITY_UNAVAILABLE', 'End the Session to close its main window'))
          break
        }
        const targetId = this.#activeTab.targetId
        const returned = await this.#selectWindow(this.#attached.targetId)
        if (this.#closed) break
        if (!returned) {
          this.#publishWindows(message.payload.requestId, new RemoteTabError('CAPTURE_DENIED', 'Could not return to the main window'))
          break
        }
        try {
          if (this.#attached.controller.ownsTarget(targetId)) await this.#attached.controller.closeChildTarget(targetId)
          this.#publishWindows(message.payload.requestId)
        } catch (cause) { this.#publishWindows(message.payload.requestId, safeError(cause)) }
        break
      }
      case 'window.select':
        await this.#selectWindow(message.payload.targetId, message.payload.requestId)
        break
      case 'hello':
        await this.#acceptHello(message)
        break
      case 'input.pointer':
        this.#requireConnectedCapability(undefined)
        await this.#activeTab.controller.dispatchPointer({
          ...message.payload,
          type: message.payload.event,
        })
        this.#notifyInput()
        break
      case 'input.key':
        this.#requireConnectedCapability(undefined)
        await this.#activeTab.controller.dispatchKey({
          ...message.payload,
          type: message.payload.event,
        })
        this.#notifyInput()
        break
      case 'input.composition':
        this.#requireConnectedCapability(undefined)
        if (message.payload.event === 'commit') {
          await this.#activeTab.controller.insertText(message.payload.text ?? '')
        }
        this.#notifyInput()
        break
      case 'navigation.request':
        await this.#handleNavigation(message.payload).catch((cause: unknown) =>
          this.#handleNavigationError(cause, message.payload.action),
        )
        this.#notifyInput()
        break
      case 'viewport.request': {
        this.#requireConnectedCapability(undefined)
        const bounded = limitViewport(message.payload, this.#mediaLimits)
        const applied = await this.#activeTab.controller.setViewport(bounded)
        this.#viewport = { ...applied, frameRate: bounded.frameRate }
        this.#send('viewport.ack', this.#viewport)
        break
      }
      case 'quality.configure':
        this.#configureQuality(message.payload.configuration, message.payload.requestId)
        break
      case 'quality.request':
        this.#requireConnectedCapability('qualityControl')
        this.#extension.setMediaQuality(this.id, limitQuality(QUALITY_PRESETS[message.payload.preset], this.#mediaLimits))
        this.#cancelQualityRequests('Quality configuration was replaced by a preset request', true)
        break
      case 'session.suspend':
        this.#requireConnectedCapability(undefined)
        this.#extension.setMediaSuspended(this.id, true)
        break
      case 'session.resume':
        if (this.#state.state !== 'SUSPENDED') {
          this.#sendError('ILLEGAL_STATE_TRANSITION', 'Session is not suspended')
        } else {
          this.#extension.setMediaSuspended(this.id, false)
        }
        break
      case 'notice.response':
        this.#requireActiveCapability('noticeRequests')
        if (this.#noticeRequests.respond(message.payload)) this.#notifyInput()
        break
      case 'navigation.local_open_result':
        this.#handleLocalOpenResult(message.payload)
        break
      default:
        this.#sendError('PROTOCOL_MESSAGE_INVALID', `Unexpected Viewer message: ${message.type}`)
    }
  }

  #notifyInput(): void {
    if (this.#closed) return
    callNotificationHook(() => this.#input.hooks.onInput?.({ sessionId: this.id, observedAt: Date.now() }))
  }

  async #handleFileChooser(backendNodeId: number, multiple: boolean): Promise<void> {
    await this.#cancelFileFlow('A newer remote file chooser replaced this request', true, false)
    if (
      this.#closed ||
      this.#state.state !== 'CONNECTED' ||
      !this.#viewerCapabilities.includes('upload') ||
      !this.#capabilities.includes('upload')
    ) {
      return
    }
    const requestId = randomUUID()
    const expiresAt = Date.now() + this.#fileTransferLimits.requestTimeoutMs
    const request: PendingFileChooser = {
      requestId,
      backendNodeId,
      multiple,
      expiresAt,
      timer: setTimeout(() => {
        if (this.#pendingFileChooser?.requestId !== requestId) return
        this.#pendingFileChooser = undefined
        try {
          this.#sendFileMessage('file.upload.cancel', {
            requestId,
            reason: 'Remote file chooser request expired',
          })
        } catch {
          // The Viewer may have disconnected at the expiry boundary.
        }
      }, this.#fileTransferLimits.requestTimeoutMs),
    }
    request.timer.unref?.()
    this.#pendingFileChooser = request
    this.#sendFileMessage('file.upload.request', { requestId, multiple, expiresAt,
      ...((this.#viewerProtocolMinor ?? 0) < 3 ? {} : { constraints: { maxFileBytes: this.#fileTransferLimits.maxFileBytes,
        maxBatchBytes: this.#fileTransferLimits.maxBatchBytes, maxFiles: this.#fileTransferLimits.maxFiles,
        allowedExtensions: this.#fileTransferLimits.allowedExtensions } }) })
  }

  async #handleChildTarget(
    _targetId: string,
    discoveredUrl: string | undefined,
    childClosed: boolean,
  ): Promise<void> {
    if (!childClosed) {
      this.#audit('child-target.retained', {})
      return
    }
    this.#audit('child-target.closed', {})
    await this.#handleLocalOpenRequest(discoveredUrl)
  }

  async #handleLocalOpenRequest(discoveredUrl: string | undefined): Promise<void> {
    if (
      this.#closed ||
      this.#state.state !== 'CONNECTED' ||
      !this.#capabilities.includes('localOpen') ||
      !this.#viewerCapabilities.includes('localOpen')
    ) {
      return
    }
    const requestedUrl = normalizeHttpUrl(discoveredUrl)
    if (requestedUrl === undefined) {
      this.#send('notice', {
        level: 'warning',
        code: 'LOCAL_OPEN_URL_UNAVAILABLE',
        message: 'The remote page opened a window without a safe HTTP or HTTPS URL.',
      })
      return
    }
    const decision = await withTimeout(
      this.#input.hooks.authorizeNavigation({
        sessionId: this.id,
        action: 'local-open',
        url: requestedUrl,
      }),
      this.#hookTimeoutMs,
      new RemoteTabError('NAVIGATION_DENIED', 'Local-open authorization timed out'),
    )
    if (!decision.allowed) {
      this.#send('notice', {
        level: 'warning',
        code: 'LOCAL_OPEN_DENIED',
        message: decision.reason ?? 'The requested link cannot be opened on this device.',
      })
      return
    }
    const approvedUrl = normalizeHttpUrl(decision.url ?? requestedUrl)
    if (approvedUrl === undefined) {
      this.#send('notice', {
        level: 'error',
        code: 'LOCAL_OPEN_URL_INVALID',
        message: 'The approved local-open URL must use HTTP or HTTPS.',
      })
      return
    }
    const viewerGeneration = this.#viewerGeneration
    if (viewerGeneration === undefined || this.#state.state !== 'CONNECTED') return
    const requestId = randomUUID()
    const expiresAt = Date.now() + this.#localOpenRequestTimeoutMs
    const request: PendingLocalOpenRequest = {
      requestId,
      url: approvedUrl,
      expiresAt,
      viewerGeneration,
      timer: setTimeout(() => {
        const current = this.#pendingLocalOpenRequests.get(requestId)
        if (current !== request) return
        this.#pendingLocalOpenRequests.delete(requestId)
        this.#audit('local-open.expired', {})
      }, this.#localOpenRequestTimeoutMs),
    }
    request.timer.unref?.()
    this.#pendingLocalOpenRequests.set(requestId, request)
    this.#send('navigation.local_open_request', { requestId, url: approvedUrl, expiresAt })
  }

  #handleLocalOpenResult(payload: ProtocolPayload<'navigation.local_open_result'>): void {
    const request = this.#pendingLocalOpenRequests.get(payload.requestId)
    if (
      request === undefined ||
      request.expiresAt <= Date.now() ||
      request.viewerGeneration !== this.#viewerGeneration
    ) {
      throw new RemoteTabError(
        'PROTOCOL_MESSAGE_INVALID',
        'Local-open response does not match an active request',
      )
    }
    clearTimeout(request.timer)
    this.#pendingLocalOpenRequests.delete(request.requestId)
    this.#audit(payload.approved ? 'local-open.approved' : 'local-open.declined', {})
  }

  #cancelLocalOpenRequests(): void {
    for (const request of this.#pendingLocalOpenRequests.values()) clearTimeout(request.timer)
    this.#pendingLocalOpenRequests.clear()
  }

  #temporaryBytes(): number {
    return this.#uploadReservedBytes + [...this.#downloadReservedBytes.values()].reduce((sum, value) => sum + value, 0)
  }

  #reserveDownloadBytes(guid: string, bytes: number): boolean {
    const previous = this.#downloadReservedBytes.get(guid)
    const managed = this.#input.downloadSink !== undefined
    let rejection = { code: 'FILE_LIMIT_EXCEEDED',
      message: 'The download exceeds the Session file count, size or temporary quota.' }
    const allowed = !this.#closed && this.#capabilities.includes('download') && (managed ||
      ((this.#state.state === 'CONNECTED' || this.#state.state === 'SUSPENDED') && this.#viewerCapabilities.includes('download')))
    let limited = bytes > this.#fileTransferLimits.maxFileBytes ||
      (previous === undefined && this.#downloadReservedBytes.size >= this.#fileTransferLimits.maxFiles) ||
      this.#temporaryBytes() - (previous ?? 0) + bytes > this.#fileTransferLimits.maxTemporaryBytes
    if (allowed && !limited && this.#input.downloadSink !== undefined) {
      try {
        this.#input.downloadSink.reserve({ sessionId: this.id, downloadId: guid, declaredSize: bytes })
        this.#sinkReservations.add(guid)
      } catch (cause) {
        limited = true
        // Only an explicitly public file error may expose the Embedder's explanation.
        // Raw storage exceptions can contain local paths or credentials.
        rejection = cause instanceof RemoteTabError &&
          (cause.code === 'FILE_LIMIT_EXCEEDED' || cause.code === 'FILE_TRANSFER_FAILED') &&
          cause.message.length > 0 && cause.message.length <= 1_024
          ? { code: cause.code, message: cause.message }
          : { code: 'FILE_TRANSFER_FAILED', message: 'The download could not be accepted by storage.' }
      }
    }
    if (!allowed || limited) {
      void this.#removeDownload(guid).catch(() => undefined)
      if (allowed) this.#send('notice', { level: 'warning', ...rejection })
      return false
    }
    this.#downloadReservedBytes.set(guid, bytes)
    return true
  }

  async #handleDownloadCompleted(event: {
    guid: string
    displayName: string
    localPath: string
    totalBytes: number
  }): Promise<void> {
    if (!this.#reserveDownloadBytes(event.guid, event.totalBytes)) return
    if (this.#input.downloadSink === undefined && this.#viewerGeneration === undefined) {
      await this.#removeDownload(event.guid).catch(() => undefined)
      return
    }
    const fileStats = await stat(event.localPath)
    if (!fileStats.isFile() || fileStats.size !== event.totalBytes) {
      await this.#removeDownload(event.guid).catch(() => undefined)
      throw new RemoteTabError('FILE_TRANSFER_FAILED', 'Chrome download file is incomplete')
    }
    if (this.#input.downloadSink !== undefined) {
      try {
        await this.#input.downloadSink.commit({ sessionId: this.id, downloadId: event.guid,
          localPath: event.localPath, displayName: normalizeDisplayName(event.displayName), size: fileStats.size })
        this.#sinkReservations.delete(event.guid)
        this.#audit('download.retained', { size: fileStats.size })
      } finally {
        await this.#removeDownload(event.guid)
      }
      return
    }
    const transferId = randomUUID()
    const descriptor: FileDescriptor = {
      fileId: randomUUID(),
      displayName: normalizeDisplayName(event.displayName),
      size: fileStats.size,
    }
    const viewerGeneration = this.#viewerGeneration!
    const expiresAt = Date.now() + this.#fileTransferLimits.requestTimeoutMs
    const transfer: DownloadTransferState = {
      guid: event.guid,
      transferId,
      descriptor,
      localPath: event.localPath,
      viewerGeneration,
      accepted: false,
      timer: setTimeout(() => {
        void this.#finishDownloadTransfer(transfer, 'Download transfer expired', true)
      }, this.#fileTransferLimits.requestTimeoutMs),
    }
    transfer.timer.unref?.()
    this.#downloadTransfers.set(transferId, transfer)
    this.#sendFileMessage('file.download.offer', { transferId, file: descriptor, expiresAt })
  }

  async #handleDownloadMessage(message: ViewerDownloadMessage): Promise<void> {
    const transfer = this.#downloadTransfers.get(message.payload.transferId)
    if (
      transfer === undefined ||
      transfer.viewerGeneration !== this.#viewerGeneration ||
      (this.#state.state !== 'CONNECTED' && this.#state.state !== 'SUSPENDED')
    ) {
      throw new RemoteTabError('FILE_TRANSFER_FAILED', 'Download transfer is not active')
    }
    if (message.type === 'file.download.accept') {
      this.#requireActiveCapability('download')
      if (transfer.accepted) {
        throw new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Download transfer was already accepted')
      }
      transfer.accepted = true
      clearTimeout(transfer.timer)
      transfer.timer = this.#createDownloadTimer(transfer)
      void this.#streamDownload(transfer)
      return
    }
    if (message.type === 'file.download.cancel') {
      await this.#finishDownloadTransfer(
        transfer,
        message.payload.reason ?? 'Viewer cancelled the download',
        false,
      )
      return
    }
    if (!transfer.accepted) {
      throw new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Download result arrived before acceptance')
    }
    await this.#finishDownloadTransfer(
      transfer,
      message.payload.received ? 'Download delivered to Viewer' : 'Viewer rejected downloaded data',
      false,
    )
    this.#audit(message.payload.received ? 'download.delivered' : 'download.failed', {
      size: transfer.descriptor.size,
    })
  }

  async #streamDownload(transfer: DownloadTransferState): Promise<void> {
    let handle
    try {
      handle = await open(transfer.localPath, 'r')
      let offset = 0
      while (offset < transfer.descriptor.size) {
        if (this.#downloadTransfers.get(transfer.transferId) !== transfer) return
        const chunkSize = Math.min(
          this.#fileTransferLimits.maxChunkBytes,
          transfer.descriptor.size - offset,
        )
        const buffer = Buffer.allocUnsafe(chunkSize)
        const { bytesRead } = await handle.read(buffer, 0, chunkSize, offset)
        if (bytesRead <= 0) {
          throw new RemoteTabError('FILE_TRANSFER_FAILED', 'Downloaded file ended before declared size')
        }
        await this.#sendFileMessageAcknowledged('file.download.chunk', {
          transferId: transfer.transferId,
          offset,
          data: Uint8Array.from(buffer.subarray(0, bytesRead)),
        })
        offset += bytesRead
        this.#resetDownloadTimer(transfer)
      }
      if (this.#downloadTransfers.get(transfer.transferId) === transfer) {
        this.#sendFileMessage('file.download.complete', { transferId: transfer.transferId })
        this.#resetDownloadTimer(transfer)
      }
    } catch {
      if (this.#downloadTransfers.get(transfer.transferId) !== transfer) return
      try {
        this.#sendFileMessage('file.download.cancel', {
          transferId: transfer.transferId,
          reason: 'Remote Tab could not transfer the downloaded file',
        })
      } catch {
        // The Viewer may have disconnected with the file channel failure.
      }
      await this.#finishDownloadTransfer(transfer, 'Download transfer failed', false)
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  #createDownloadTimer(transfer: DownloadTransferState): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      if (this.#downloadTransfers.get(transfer.transferId) !== transfer) return
      try {
        this.#sendFileMessage('file.download.cancel', {
          transferId: transfer.transferId,
          reason: 'Download transfer expired',
        })
      } catch {
        // The Viewer may have disconnected at the expiry boundary.
      }
      void this.#finishDownloadTransfer(transfer, 'Download transfer expired', false)
    }, this.#fileTransferLimits.requestTimeoutMs)
    timer.unref?.()
    return timer
  }

  #resetDownloadTimer(transfer: DownloadTransferState): void {
    clearTimeout(transfer.timer)
    transfer.timer = this.#createDownloadTimer(transfer)
  }

  async #finishDownloadTransfer(
    transfer: DownloadTransferState,
    reason: string,
    notifyViewer: boolean,
  ): Promise<void> {
    if (this.#downloadTransfers.get(transfer.transferId) !== transfer) return
    this.#downloadTransfers.delete(transfer.transferId)
    clearTimeout(transfer.timer)
    if (notifyViewer) {
      try {
        this.#sendFileMessage('file.download.cancel', { transferId: transfer.transferId, reason })
      } catch {
        // The Viewer may no longer have an active file channel.
      }
    }
    await this.#removeDownload(transfer.guid).catch(() => undefined)
  }

  async #cancelAllDownloads(reason: string, notifyViewer: boolean): Promise<void> {
    await Promise.allSettled([...this.#downloadCommits])
    await Promise.allSettled(
      [...this.#downloadTransfers.values()].map((transfer) =>
        this.#finishDownloadTransfer(transfer, reason, notifyViewer),
      ),
    )
    await Promise.allSettled([...this.#downloadSources.keys()].map(guid => this.#removeDownload(guid)))
    await Promise.allSettled([...this.#sinkAborts.values()])
  }

  async #handleClipboardWriteMessage(message: ViewerClipboardWriteMessage): Promise<void> {
    if (message.type === 'clipboard.write.offer') {
      this.#requireClipboardCapabilities(message.payload.items.map((item) => item.mimeType))
      this.#cancelClipboardWrite('A newer clipboard write replaced this transfer', true)
      const itemIds = new Set<string>()
      const mimeTypes = new Set<string>()
      let totalBytes = 0
      const items = new Map<string, ClipboardWriteItemState>()
      for (const descriptor of message.payload.items) {
        if (itemIds.has(descriptor.itemId) || mimeTypes.has(descriptor.mimeType)) {
          throw new RemoteTabError(
            'PROTOCOL_MESSAGE_INVALID',
            'Clipboard item IDs and MIME types must be unique',
          )
        }
        if (descriptor.size > MAX_CLIPBOARD_ITEM_BYTES) {
          throw new RemoteTabError('FILE_LIMIT_EXCEEDED', 'Clipboard item exceeds the size limit')
        }
        itemIds.add(descriptor.itemId)
        mimeTypes.add(descriptor.mimeType)
        totalBytes += descriptor.size
        if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_CLIPBOARD_TOTAL_BYTES) {
          throw new RemoteTabError('FILE_LIMIT_EXCEEDED', 'Clipboard payload exceeds the size limit')
        }
        items.set(descriptor.itemId, { descriptor, chunks: [], nextOffset: 0 })
      }
      const transfer: ClipboardWriteTransferState = {
        requestId: message.payload.requestId,
        transferId: message.payload.transferId,
        items,
        timer: this.#createClipboardWriteTimer(message.payload.transferId),
      }
      this.#clipboardWriteTransfer = transfer
      this.#sendClipboardMessage('clipboard.write.accept', {
        transferId: transfer.transferId,
        maxChunkBytes: this.#fileTransferLimits.maxChunkBytes,
      })
      return
    }

    const transfer = this.#clipboardWriteTransfer
    if (transfer === undefined || transfer.transferId !== message.payload.transferId) {
      throw new RemoteTabError('FILE_TRANSFER_FAILED', 'Clipboard write transfer is not active')
    }
    if (message.type === 'clipboard.write.chunk') {
      const item = transfer.items.get(message.payload.itemId)
      if (
        item === undefined ||
        message.payload.data.byteLength === 0 ||
        message.payload.data.byteLength > this.#fileTransferLimits.maxChunkBytes ||
        message.payload.offset !== item.nextOffset ||
        item.nextOffset + message.payload.data.byteLength > item.descriptor.size
      ) {
        throw new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Clipboard chunks are invalid')
      }
      item.chunks.push(Uint8Array.from(message.payload.data))
      item.nextOffset += message.payload.data.byteLength
      this.#resetClipboardWriteTimer(transfer)
      return
    }

    clearTimeout(transfer.timer)
    for (const item of transfer.items.values()) {
      if (item.nextOffset !== item.descriptor.size) {
        this.#cancelClipboardWrite('Clipboard data ended before its declared size', false)
        this.#sendClipboardMessage('clipboard.write.result', {
          transferId: transfer.transferId,
          written: false,
          error: new RemoteTabError(
            'FILE_TRANSFER_FAILED',
            'Clipboard data ended before its declared size',
          ).toJSON(),
        })
        return
      }
    }
    try {
      await this.#withClipboardExclusive(() =>
        this.#activeTab.controller.writeClipboardAndPaste(
          [...transfer.items.values()].map((item) => ({
            mimeType: item.descriptor.mimeType,
            data: joinChunks(item.chunks, item.descriptor.size),
          })),
        ),
      )
      if (this.#clipboardWriteTransfer !== transfer) return
      this.#clipboardWriteTransfer = undefined
      this.#sendClipboardMessage('clipboard.write.result', {
        transferId: transfer.transferId,
        written: true,
      })
      this.#audit('clipboard.written', { itemCount: transfer.items.size })
    } catch (cause) {
      if (this.#clipboardWriteTransfer !== transfer) return
      this.#clipboardWriteTransfer = undefined
      const error = safeError(cause)
      this.#sendClipboardMessage('clipboard.write.result', {
        transferId: transfer.transferId,
        written: false,
        error: error.toJSON(),
      })
    }
  }

  async #handleClipboardReadMessage(message: ViewerClipboardReadMessage): Promise<void> {
    if (message.type === 'clipboard.read.request') {
      this.#requireAnyClipboardCapability()
      this.#cancelClipboardRead('A newer clipboard read replaced this transfer', true)
      let remoteItems
      try {
        remoteItems = await this.#withClipboardExclusive(() =>
          this.#activeTab.controller.readClipboard(),
        )
      } catch (cause) {
        this.#sendClipboardMessage('clipboard.read.result', {
          requestId: message.payload.requestId,
          received: false,
          error: safeError(cause).toJSON(),
        })
        return
      }
      const items: ClipboardReadItemState[] = []
      let totalBytes = 0
      for (const remoteItem of remoteItems) {
        const capability = remoteItem.mimeType === 'text/plain' ? 'clipboardText' : 'clipboardImage'
        if (!this.#capabilities.includes(capability) || !this.#viewerCapabilities.includes(capability)) {
          continue
        }
        if (remoteItem.data.byteLength > MAX_CLIPBOARD_ITEM_BYTES) continue
        totalBytes += remoteItem.data.byteLength
        if (totalBytes > MAX_CLIPBOARD_TOTAL_BYTES) continue
        items.push({
          descriptor: {
            itemId: randomUUID(),
            mimeType: remoteItem.mimeType,
            size: remoteItem.data.byteLength,
          },
          data: Uint8Array.from(remoteItem.data),
        })
      }
      if (items.length === 0 || this.#viewerGeneration === undefined) {
        this.#sendClipboardMessage('clipboard.read.result', {
          requestId: message.payload.requestId,
          received: false,
          error: new RemoteTabError(
            'FILE_TRANSFER_FAILED',
            'Remote clipboard has no permitted content within the size limit',
          ).toJSON(),
        })
        return
      }
      const transferId = randomUUID()
      const transfer: ClipboardReadTransferState = {
        requestId: message.payload.requestId,
        transferId,
        viewerGeneration: this.#viewerGeneration,
        items,
        accepted: false,
        timer: this.#createClipboardReadTimer(message.payload.requestId, transferId),
      }
      this.#clipboardReadTransfer = transfer
      this.#sendClipboardMessage('clipboard.read.offer', {
        requestId: transfer.requestId,
        transferId,
        items: items.map((item) => item.descriptor),
      })
      return
    }

    const transfer = this.#clipboardReadTransfer
    const transferId = message.payload.transferId
    if (
      transfer === undefined ||
      transferId === undefined ||
      transfer.transferId !== transferId ||
      transfer.viewerGeneration !== this.#viewerGeneration
    ) {
      throw new RemoteTabError('FILE_TRANSFER_FAILED', 'Clipboard read transfer is not active')
    }
    if (message.type === 'clipboard.read.accept') {
      if (transfer.accepted) {
        throw new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Clipboard read was already accepted')
      }
      transfer.accepted = true
      clearTimeout(transfer.timer)
      transfer.timer = this.#createClipboardReadTimer(transfer.requestId, transfer.transferId)
      void this.#streamClipboardRead(transfer)
      return
    }
    this.#cancelClipboardRead('Clipboard read finished', false)
    this.#audit(message.payload.received ? 'clipboard.read' : 'clipboard.read_failed', {
      itemCount: transfer.items.length,
    })
  }

  async #streamClipboardRead(transfer: ClipboardReadTransferState): Promise<void> {
    try {
      for (const item of transfer.items) {
        for (let offset = 0; offset < item.data.byteLength; offset += this.#fileTransferLimits.maxChunkBytes) {
          if (this.#clipboardReadTransfer !== transfer) return
          const data = item.data.slice(
            offset,
            Math.min(item.data.byteLength, offset + this.#fileTransferLimits.maxChunkBytes),
          )
          await this.#sendClipboardMessageAcknowledged('clipboard.read.chunk', {
            transferId: transfer.transferId,
            itemId: item.descriptor.itemId,
            offset,
            data,
          })
          this.#resetClipboardReadTimer(transfer)
        }
      }
      if (this.#clipboardReadTransfer === transfer) {
        this.#sendClipboardMessage('clipboard.read.complete', { transferId: transfer.transferId })
        this.#resetClipboardReadTimer(transfer)
      }
    } catch (cause) {
      if (this.#clipboardReadTransfer !== transfer) return
      this.#cancelClipboardRead('Clipboard read transfer failed', false)
      this.#sendClipboardMessage('clipboard.read.result', {
        requestId: transfer.requestId,
        transferId: transfer.transferId,
        received: false,
        error: safeError(cause).toJSON(),
      })
    }
  }

  #requireClipboardCapabilities(mimeTypes: readonly string[]): void {
    this.#requireAnyClipboardCapability()
    for (const mimeType of mimeTypes) {
      this.#requireActiveCapability(mimeType === 'text/plain' ? 'clipboardText' : 'clipboardImage')
    }
  }

  #requireAnyClipboardCapability(): void {
    this.#requireConnectedCapability(undefined)
    if (
      !this.#viewerCapabilities.some(
        (capability) => capability === 'clipboardText' || capability === 'clipboardImage',
      )
    ) {
      throw new RemoteTabError('CAPABILITY_UNAVAILABLE', 'Clipboard is not available')
    }
  }

  #cancelClipboardTransfers(reason: string, notifyViewer: boolean): void {
    this.#cancelClipboardWrite(reason, notifyViewer)
    this.#cancelClipboardRead(reason, notifyViewer)
  }

  #cancelClipboardWrite(reason: string, notifyViewer: boolean): void {
    const transfer = this.#clipboardWriteTransfer
    this.#clipboardWriteTransfer = undefined
    if (transfer === undefined) return
    clearTimeout(transfer.timer)
    if (notifyViewer) {
      this.#sendClipboardMessage('clipboard.write.result', {
        transferId: transfer.transferId,
        written: false,
        error: new RemoteTabError('FILE_TRANSFER_FAILED', reason, { retryable: true }).toJSON(),
      })
    }
  }

  #cancelClipboardRead(reason: string, notifyViewer: boolean): void {
    const transfer = this.#clipboardReadTransfer
    this.#clipboardReadTransfer = undefined
    if (transfer === undefined) return
    clearTimeout(transfer.timer)
    if (notifyViewer) {
      this.#sendClipboardMessage('clipboard.read.result', {
        requestId: transfer.requestId,
        transferId: transfer.transferId,
        received: false,
        error: new RemoteTabError('FILE_TRANSFER_FAILED', reason, { retryable: true }).toJSON(),
      })
    }
  }

  #createClipboardWriteTimer(transferId: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      if (this.#clipboardWriteTransfer?.transferId !== transferId) return
      this.#cancelClipboardWrite('Clipboard write expired', true)
    }, this.#fileTransferLimits.requestTimeoutMs)
    timer.unref?.()
    return timer
  }

  #resetClipboardWriteTimer(transfer: ClipboardWriteTransferState): void {
    clearTimeout(transfer.timer)
    transfer.timer = this.#createClipboardWriteTimer(transfer.transferId)
  }

  #createClipboardReadTimer(requestId: string, transferId: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      if (this.#clipboardReadTransfer?.transferId !== transferId) return
      this.#cancelClipboardRead('Clipboard read expired', false)
      this.#sendClipboardMessage('clipboard.read.result', {
        requestId,
        transferId,
        received: false,
        error: new RemoteTabError(
          'FILE_TRANSFER_FAILED',
          'Clipboard read expired',
          { retryable: true },
        ).toJSON(),
      })
    }, this.#fileTransferLimits.requestTimeoutMs)
    timer.unref?.()
    return timer
  }

  #resetClipboardReadTimer(transfer: ClipboardReadTransferState): void {
    clearTimeout(transfer.timer)
    transfer.timer = this.#createClipboardReadTimer(transfer.requestId, transfer.transferId)
  }

  #audit(name: string, fields: Readonly<Record<string, string | number | boolean | null>>): void {
    callNotificationHook(() =>
      this.#input.hooks.onAuditEvent?.({
        sessionId: this.id,
        name,
        occurredAt: Date.now(),
        fields,
      }),
    )
  }

  async #handleUploadMessage(message: ViewerUploadMessage): Promise<void> {
    try {
      if (message.type === 'file.upload.offer') {
        await this.#acceptUploadOffer(message.payload)
      } else if (message.type === 'file.upload.chunk') {
        await this.#writeUploadChunk(message.payload)
      } else if (message.type === 'file.upload.complete') {
        await this.#completeUpload(message.payload.transferId)
      } else {
        await this.#cancelUploadRequest(message.payload.requestId, message.payload.transferId)
      }
    } catch (cause) {
      const transferId =
        message.type === 'file.upload.offer' ||
        message.type === 'file.upload.chunk' ||
        message.type === 'file.upload.complete'
          ? message.payload.transferId
          : message.payload.transferId
      await this.#cancelFileFlow('Upload transfer failed', false, false)
      if (transferId !== undefined) {
        const error = toFileTransferError(cause)
        this.#sendFileMessage('file.upload.result', {
          transferId,
          delivered: false,
          error: error.toJSON(),
        })
      }
    }
  }

  async #acceptUploadOffer(payload: ProtocolPayload<'file.upload.offer'>): Promise<void> {
    this.#requireConnectedCapability('upload')
    const request = this.#pendingFileChooser
    if (request === undefined || request.requestId !== payload.requestId || request.expiresAt <= Date.now()) {
      throw new RemoteTabError('FILE_TRANSFER_FAILED', 'Remote file chooser request is no longer active')
    }
    if (this.#uploadTransfer !== undefined) {
      throw new RemoteTabError('FILE_TRANSFER_FAILED', 'Another upload transfer is active')
    }
    assertUploadAllowed(payload.files, this.#fileTransferLimits)
    if (!request.multiple && payload.files.length !== 1) {
      throw new RemoteTabError('FILE_LIMIT_EXCEEDED', 'Upload file count exceeds the Session limit')
    }
    const fileIds = new Set<string>()
    let totalBytes = 0
    for (const file of payload.files) {
      if (fileIds.has(file.fileId)) {
        throw new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Upload offer contains a duplicate file ID')
      }
      fileIds.add(file.fileId)
      totalBytes += file.size
    }

    if (this.#temporaryBytes() + totalBytes > this.#fileTransferLimits.maxTemporaryBytes) {
      throw new RemoteTabError('FILE_LIMIT_EXCEEDED', 'Session temporary file quota exceeded')
    }
    this.#uploadReservedBytes += totalBytes
    const reserved: UploadFileState[] = []
    try {
      for (const file of payload.files) {
        const descriptor = { ...file, displayName: normalizeDisplayName(file.displayName) }
        const reservation = await this.#input.storage.reserve({
          sessionId: this.id,
          transferId: `${payload.transferId}:${file.fileId}`,
          direction: 'upload',
          displayName: descriptor.displayName,
          declaredSize: descriptor.size,
          ...(descriptor.mimeType === undefined ? {} : { mimeType: descriptor.mimeType }),
        })
        reserved.push({ descriptor, reservation, nextOffset: 0 })
      }
    } catch (cause) {
      await Promise.allSettled(reserved.map((file) => file.reservation.abort('Upload reservation failed')))
      this.#uploadReservedBytes -= totalBytes
      throw cause
    }

    clearTimeout(request.timer)
    this.#pendingFileChooser = undefined
    this.#uploadTransfer = {
      requestId: request.requestId,
      transferId: payload.transferId,
      backendNodeId: request.backendNodeId,
      files: new Map(reserved.map((file) => [file.descriptor.fileId, file])),
      timer: this.#createUploadTimer(payload.transferId),
    }
    this.#sendFileMessage('file.upload.accept', {
      transferId: payload.transferId,
      maxChunkBytes: this.#fileTransferLimits.maxChunkBytes,
    })
  }

  async #writeUploadChunk(payload: ProtocolPayload<'file.upload.chunk'>): Promise<void> {
    this.#requireConnectedCapability('upload')
    const transfer = this.#requireUploadTransfer(payload.transferId)
    const file = transfer.files.get(payload.fileId)
    if (file === undefined) {
      throw new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Upload chunk references an unknown file')
    }
    if (payload.data.byteLength === 0 || payload.data.byteLength > this.#fileTransferLimits.maxChunkBytes) {
      throw new RemoteTabError('FILE_LIMIT_EXCEEDED', 'Upload chunk exceeds the negotiated limit')
    }
    if (payload.offset !== file.nextOffset || payload.offset + payload.data.byteLength > file.descriptor.size) {
      throw new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Upload chunk offset is not contiguous')
    }
    await file.reservation.write(payload.offset, payload.data)
    file.nextOffset += payload.data.byteLength
    this.#resetUploadTimer(transfer)
  }

  async #completeUpload(transferId: string): Promise<void> {
    this.#requireConnectedCapability('upload')
    const transfer = this.#requireUploadTransfer(transferId)
    for (const file of transfer.files.values()) {
      if (file.nextOffset !== file.descriptor.size) {
        throw new RemoteTabError('FILE_TRANSFER_FAILED', 'Upload completed before all bytes arrived')
      }
    }
    clearTimeout(transfer.timer)
    const stored = []
    for (const file of transfer.files.values()) {
      stored.push(await file.reservation.commit())
    }
    await this.#activeTab.controller.setFileInputFiles(
      transfer.backendNodeId,
      stored.map((file) => file.localPath),
    )
    // Chrome File objects read lazily; committed uploads consume quota until Session cleanup.
    this.#uploadTransfer = undefined
    this.#sendFileMessage('file.upload.result', { transferId, delivered: true })
  }

  async #cancelUploadRequest(requestId: string, transferId?: string): Promise<void> {
    if (this.#pendingFileChooser?.requestId === requestId) {
      clearTimeout(this.#pendingFileChooser.timer)
      this.#pendingFileChooser = undefined
    }
    if (
      this.#uploadTransfer?.requestId === requestId &&
      (transferId === undefined || transferId === this.#uploadTransfer.transferId)
    ) {
      await this.#abortUploadTransfer('Viewer cancelled the upload')
    }
  }

  #requireUploadTransfer(transferId: string): UploadTransferState {
    const transfer = this.#uploadTransfer
    if (transfer === undefined || transfer.transferId !== transferId) {
      throw new RemoteTabError('FILE_TRANSFER_FAILED', 'Upload transfer is not active')
    }
    return transfer
  }

  #createUploadTimer(transferId: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const transfer = this.#uploadTransfer
      if (transfer?.transferId !== transferId) return
      void this.#abortUploadTransfer('Upload transfer expired').then(() => {
        try {
          this.#sendFileMessage('file.upload.result', {
            transferId,
            delivered: false,
            error: new RemoteTabError(
              'FILE_TRANSFER_FAILED',
              'Upload transfer expired',
              { retryable: true },
            ).toJSON(),
          })
        } catch {
          // The Viewer may have disconnected at the expiry boundary.
        }
      })
    }, this.#fileTransferLimits.requestTimeoutMs)
    timer.unref?.()
    return timer
  }

  #resetUploadTimer(transfer: UploadTransferState): void {
    clearTimeout(transfer.timer)
    transfer.timer = this.#createUploadTimer(transfer.transferId)
  }

  async #abortUploadTransfer(reason: string): Promise<void> {
    const transfer = this.#uploadTransfer
    if (transfer === undefined) return
    this.#uploadTransfer = undefined
    clearTimeout(transfer.timer)
    await Promise.allSettled([...transfer.files.values()].map((file) => file.reservation.abort(reason)))
    this.#uploadReservedBytes -= [...transfer.files.values()].reduce((sum, file) => sum + file.descriptor.size, 0)
  }

  async #cancelFileFlow(
    reason: string,
    notifyViewer = false,
    cancelDownloads = true,
  ): Promise<void> {
    const pending = this.#pendingFileChooser
    this.#pendingFileChooser = undefined
    if (pending !== undefined) {
      clearTimeout(pending.timer)
      if (notifyViewer) {
        this.#sendFileMessage('file.upload.cancel', { requestId: pending.requestId, reason })
      }
    }
    const transferId = this.#uploadTransfer?.transferId
    await this.#abortUploadTransfer(reason)
    if (notifyViewer && transferId !== undefined) {
      this.#sendFileMessage('file.upload.result', {
        transferId,
        delivered: false,
        error: new RemoteTabError('FILE_TRANSFER_FAILED', reason, { retryable: true }).toJSON(),
      })
    }
    if (cancelDownloads) await this.#cancelAllDownloads(reason, notifyViewer)
  }

  #queueFileFlowCancellation(reason: string, cancelDownloads = true): Promise<void> {
    const cancellation = this.#controlChain.then(() =>
      this.#cancelFileFlow(reason, false, cancelDownloads),
    )
    this.#controlChain = cancellation.catch((cause: unknown) => this.#handleControlError(cause))
    return cancellation
  }

  #sendFileMessage<TypeName extends Extract<ProtocolMessageType, `file.${string}`>>(
    type: TypeName,
    payload: ProtocolPayload<TypeName>,
  ): void {
    this.#send(type, payload)
  }

  async #sendFileMessageAcknowledged<
    TypeName extends Extract<ProtocolMessageType, `file.${string}`>,
  >(type: TypeName, payload: ProtocolPayload<TypeName>): Promise<void> {
    if (this.#viewerGeneration === undefined) {
      throw new RemoteTabError('SESSION_CLOSED', 'Viewer generation is unavailable')
    }
    const sequence = ++this.#outboundSequence
    const message = createProtocolMessage(
      type,
      {
        sessionId: this.id,
        viewerGeneration: this.#viewerGeneration,
        sequence,
      },
      payload,
    )
    await this.#extension.sendMediaControlAndWait(
      encodeProtocolMessage(message as ProtocolMessage),
      this.id,
      sequence,
    )
  }

  #sendClipboardMessage<
    TypeName extends Extract<ProtocolMessageType, `clipboard.${string}`>,
  >(type: TypeName, payload: ProtocolPayload<TypeName>): void {
    this.#send(type, payload)
  }

  async #sendClipboardMessageAcknowledged<
    TypeName extends Extract<ProtocolMessageType, `clipboard.${string}`>,
  >(type: TypeName, payload: ProtocolPayload<TypeName>): Promise<void> {
    if (this.#viewerGeneration === undefined) {
      throw new RemoteTabError('SESSION_CLOSED', 'Viewer generation is unavailable')
    }
    const sequence = ++this.#outboundSequence
    const message = createProtocolMessage(
      type,
      {
        sessionId: this.id,
        viewerGeneration: this.#viewerGeneration,
        sequence,
      },
      payload,
    )
    await this.#extension.sendMediaControlAndWait(
      encodeProtocolMessage(message as ProtocolMessage),
      this.id,
      sequence,
    )
  }

  async #handleControlError(cause: unknown): Promise<void> {
    if (this.#closed) return
    if (!(cause instanceof RemoteTabError)) {
      await this.#fail(safeError(cause))
      return
    }
    try {
      this.#sendError(cause.code, cause.message)
    } catch (sendCause) {
      await this.#fail(safeError(sendCause))
    }
  }

  async #handleNavigationError(
    cause: unknown,
    action: ProtocolPayload<'navigation.request'>['action'],
  ): Promise<void> {
    if (this.#closed) return
    // A denied or cancelled document load leaves the Viewer connection usable.
    if (cause instanceof RemoteTabError && cause.code === 'NAVIGATION_DENIED') {
      this.#send('navigation.result', {
        allowed: false,
        action,
        ...(this.#currentUrl === undefined ? {} : { currentUrl: this.#currentUrl }),
        reason: cause.message,
      })
      return
    }
    await this.#handleControlError(cause)
  }

  async #acceptHello(message: Extract<ProtocolMessage, { type: 'hello' }>): Promise<void> {
    if (this.#state.state !== 'NEGOTIATING' && this.#state.state !== 'RECONNECTING') {
      this.#sendError('ILLEGAL_STATE_TRANSITION', 'Viewer handshake is not expected')
      return
    }
    const requested = normalizeCapabilities(message.payload.capabilities)
    const accepted = requested.filter(
      (capability) =>
        this.#viewerCapabilities.includes(capability) && this.#capabilities.includes(capability) &&
        (!['noticeRequests', 'navigationConfirmation', 'navigationState'].includes(capability) || message.minor >= 1) &&
        (capability !== 'windowSelection' || message.minor >= 2) &&
        (capability !== 'advancedQuality' || (message.minor >= 4 && requested.includes('qualityControl') &&
          this.#viewerCapabilities.includes('qualityControl') && this.#capabilities.includes('qualityControl'))),
    )
    this.#viewerCapabilities = accepted
    this.#viewerProtocolMinor = message.minor
    this.#noticeControlAvailable = true
    this.#state.transition('CONNECTED')
    this.#send('hello.accepted', { capabilities: accepted, viewport: this.#viewport })
    if (accepted.includes('advancedQuality')) this.#configureQuality(this.#qualityConfiguration ?? { mode: 'auto' })
    else if (accepted.includes('qualityControl')) this.#send('quality.ack', this.#quality)
    this.#publishWindows()
    this.#publishLocation()
    const initialUrl = this.#deferredInitialUrl
    this.#deferredInitialUrl = undefined
    if (initialUrl !== undefined) {
      void this.#activeTab.controller.navigateAuthorized(initialUrl)
        .catch((cause: unknown) => this.#handleNavigationError(cause, 'go'))
    }
  }

  #advancedQualityAvailable(): boolean {
    return this.#viewerProtocolMinor !== undefined && this.#viewerProtocolMinor >= 4 &&
      ['advancedQuality', 'qualityControl'].every((capability) =>
        this.#viewerCapabilities.includes(capability as Capability) && this.#capabilities.includes(capability as Capability))
  }

  #cancelQualityRequests(message: string, retainSenderReplies = false): void {
    if (this.#advancedQualityAvailable()) {
      for (const pending of this.#qualityRequests.values()) {
        if (!pending.cancelled && pending.clientRequestId !== undefined && pending.viewerGeneration === this.#viewerGeneration) {
          this.#send('quality.configuration_failed', { requestId: pending.clientRequestId,
            error: new RemoteTabError('CAPABILITY_UNAVAILABLE', message).toJSON() })
        }
      }
    }
    if (retainSenderReplies) {
      // The Extension serializes media operations. A preceding advanced request may
      // succeed before this legacy preset fails; retain its actual state without
      // resolving the already cancelled caller or replaying its UI acknowledgement.
      for (const pending of this.#qualityRequests.values()) pending.cancelled = true
    } else this.#qualityRequests.clear()
  }

  #configureQuality(configuration: QualityConfiguration, clientRequestId?: string): void {
    try {
      this.#requireActiveCapability('qualityControl')
      this.#requireActiveCapability('advancedQuality')
      if (!this.#advancedQualityAvailable()) throw new RemoteTabError('CAPABILITY_UNAVAILABLE', 'Advanced quality was not negotiated')
      // Extension applies the automatic-mode ceiling within this Session ceiling.
      const limits: EncodingSettings = {
        maxBitrate: this.#mediaLimits.maxBitrate ?? 20_000_000,
        maxFrameRate: this.#mediaLimits.maxFrameRate,
        scaleResolutionDownBy: 1,
      }
      const bounded: QualityConfiguration = configuration.mode === 'custom' ? {
        ...configuration, maxBitrate: Math.min(configuration.maxBitrate, limits.maxBitrate),
        maxFrameRate: Math.min(configuration.maxFrameRate, limits.maxFrameRate),
      } : configuration
      const requestId = randomUUID()
      this.#qualityRequests.set(requestId, { viewerGeneration: this.#viewerGeneration!,
        ...(clientRequestId === undefined ? {} : { clientRequestId }) })
      try { this.#extension.configureMediaQuality(this.id, requestId, bounded, limits) }
      catch (cause) { this.#qualityRequests.delete(requestId); throw cause }
    } catch (cause) {
      const error = safeError(cause)
      if (clientRequestId !== undefined) this.#send('quality.configuration_failed', { requestId: clientRequestId, error: error.toJSON() })
      else this.#sendError(error.code, error.message)
    }
  }

  #publishLocation(): void {
    if (this.#currentUrl === undefined || !this.#noticeControlAvailable ||
        !['CONNECTED', 'SUSPENDED'].includes(this.#state.state) ||
        !this.#capabilities.includes('navigationState') || !this.#viewerCapabilities.includes('navigationState')) return
    this.#send('navigation.location_changed', { url: this.#currentUrl.slice(0, 16_384) })
  }

  async #handleNavigation(payload: ProtocolPayload<'navigation.request'>): Promise<void> {
    const action = payload.action
    const capability = action === 'go' ? 'navigation' : action === 'reload' ? 'reload' : 'backForward'
    this.#requireConnectedCapability(capability)
    const decision = await withTimeout(
      this.#input.hooks.authorizeNavigation({
        sessionId: this.id,
        action,
        source: 'viewer',
        ...(action === 'go' ? { url: payload.url } : {}),
      }),
      this.#hookTimeoutMs,
      new RemoteTabError('NAVIGATION_DENIED', 'Navigation authorization timed out'),
    )
    if (!decision.allowed) {
      this.#send('navigation.result', {
        allowed: false,
        action,
        ...(this.#currentUrl === undefined ? {} : { currentUrl: this.#currentUrl }),
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
      })
      return
    }

    let succeeded = true
    if (action === 'go') {
      const url = decision.url ?? payload.url
      await this.#activeTab.controller.navigateAuthorized(url)
    } else if (action === 'reload') {
      await this.#activeTab.controller.reload()
    } else {
      succeeded = await this.#activeTab.controller.goHistory(action)
    }
    this.#send('navigation.result', {
      allowed: succeeded,
      action,
      ...(this.#currentUrl === undefined ? {} : { currentUrl: this.#currentUrl }),
      ...(!succeeded ? { reason: 'No matching navigation history entry' } : {}),
    })
  }

  #requireConnectedCapability(capability: Capability | undefined): void {
    if (this.#state.state !== 'CONNECTED') {
      throw new RemoteTabError('ILLEGAL_STATE_TRANSITION', 'Remote Tab Session is not connected')
    }
    if (capability !== undefined && !this.#viewerCapabilities.includes(capability)) {
      throw new RemoteTabError(
        'CAPABILITY_UNAVAILABLE',
        `Viewer capability is not available: ${capability}`,
      )
    }
  }

  #requireActiveCapability(capability: Capability): void {
    if (this.#state.state !== 'CONNECTED' && this.#state.state !== 'SUSPENDED') {
      throw new RemoteTabError('ILLEGAL_STATE_TRANSITION', 'Remote Tab Session has no active Viewer')
    }
    if (!this.#viewerCapabilities.includes(capability) || !this.#capabilities.includes(capability)) {
      throw new RemoteTabError(
        'CAPABILITY_UNAVAILABLE',
        `Viewer capability is not available: ${capability}`,
      )
    }
  }

  #send<TypeName extends ProtocolMessageType>(
    type: TypeName,
    payload: ProtocolPayload<TypeName>,
  ): void {
    if (this.#viewerGeneration === undefined) {
      return
    }
    const message = createProtocolMessage(
      type,
      {
        sessionId: this.id,
        viewerGeneration: this.#viewerGeneration,
        sequence: ++this.#outboundSequence,
      },
      payload,
    )
    this.#extension.sendMediaControl(encodeProtocolMessage(message as ProtocolMessage))
  }

  #sendError(code: RemoteTabErrorCode, message: string): void {
    this.#send('error', { code, message, retryable: false })
  }

  #fail(error: RemoteTabError): Promise<void> {
    // Failure notification owns the FAILED state; explicit close/manager cleanup owns retries.
    // Event callbacks must not create an unhandled rejection while retained cleanup is pending.
    return this.#terminate(error.message, true).catch(() => undefined)
  }

  #terminate(reason: string, failed = false): Promise<void> {
    if (this.#termination !== undefined) return this.#termination
    this.#closed = true
    this.#terminationReason ??= { reason, failed }
    ;({ reason, failed } = this.#terminationReason)
    // Publish the promise before notifying hooks: an Embedder may close again on FAILED.
    this.#termination = Promise.resolve().then(async () => {
      const state = failed ? 'FAILED' : 'CLOSING'
      if (this.#state.canTransitionTo(state)) this.#state.transition(state, reason)
      await this.#cleanup(reason)
      if (!failed && this.#state.canTransitionTo('CLOSED')) {
        this.#state.transition('CLOSED', reason)
      }
    }).catch(cause => { this.#termination = undefined; throw cause })
    return this.#termination
  }

  async #cleanup(reason: string): Promise<void> {
    this.#cancelSignalingRetry()
    this.#unsubscribeMediaSignal()
    this.#unsubscribeMediaControl()
    this.#noticeRequests.cancelAll('session-closed')
    this.#cancelLocalOpenRequests()
    this.#cancelClipboardTransfers(reason, false)
    await Promise.allSettled([...this.#downloadCommits])
    await this.#cancelFileFlow(reason, false)
    for (const tab of this.#windowTabs.values()) await tab.controller.dispatchPageScriptDetached().catch(() => undefined)
    for (const unsubscribe of this.#windowSubscriptions.values()) unsubscribe()
    this.#unsubscribeCdp()
    try {
      await this.#extension.stopMedia(this.id, reason)
    } catch {
      // The media runtime may already be gone; remaining cleanup is still required.
    }
    await this.#signaling?.close().catch(() => undefined)
    this.#signaling = undefined
    await this.#attached.controller.close({ browserClosed: this.#browserClosed })
    for (const tab of this.#windowTabs.values()) {
      if (tab === this.#attached) continue
      await tab.controller.detach().catch(() => undefined)
      this.#extension.releaseTarget(tab.targetId)
    }
    this.#windowTabs.clear()
    this.#browser.close()
    await this.#input.storage.cleanupSession(this.id)
    this.#onDisposed()
  }
}

function isViewerUploadMessage(message: ProtocolMessage): message is ViewerUploadMessage {
  return (
    message.type === 'file.upload.offer' ||
    message.type === 'file.upload.chunk' ||
    message.type === 'file.upload.complete' ||
    message.type === 'file.upload.cancel'
  )
}

function isViewerDownloadMessage(message: ProtocolMessage): message is ViewerDownloadMessage {
  return (
    message.type === 'file.download.accept' ||
    message.type === 'file.download.cancel' ||
    message.type === 'file.download.result'
  )
}

function isViewerClipboardWriteMessage(
  message: ProtocolMessage,
): message is ViewerClipboardWriteMessage {
  return (
    message.type === 'clipboard.write.offer' ||
    message.type === 'clipboard.write.chunk' ||
    message.type === 'clipboard.write.complete'
  )
}

function isViewerClipboardReadMessage(
  message: ProtocolMessage,
): message is ViewerClipboardReadMessage {
  return (
    message.type === 'clipboard.read.request' ||
    message.type === 'clipboard.read.accept' ||
    message.type === 'clipboard.read.result'
  )
}

function joinChunks(
  chunks: readonly Uint8Array<ArrayBuffer>[],
  expectedSize: number,
): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(expectedSize)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  if (offset !== expectedSize) {
    throw new RemoteTabError('FILE_TRANSFER_FAILED', 'Clipboard byte count changed during assembly')
  }
  return result
}

function normalizeFileTransferLimits(input: Partial<FileTransferLimits> | undefined): FileTransferLimits {
  const limits = { ...DEFAULT_FILE_TRANSFER_LIMITS, ...input }
  if (!Array.isArray(limits.allowedExtensions) || limits.allowedExtensions.length > 64 ||
      limits.allowedExtensions.some(value => typeof value !== 'string' || !/^\.[a-z0-9][a-z0-9._+-]{0,31}$/.test(value))) throw new RangeError('Invalid upload filename extensions')
  limits.allowedExtensions = [...new Set(limits.allowedExtensions)]
  const { allowedExtensions: _extensions, ...numeric } = limits
  for (const [name, value] of Object.entries(numeric)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer`)
    }
  }
  if (limits.maxFiles > 64) throw new RangeError('maxFiles must not exceed the protocol ceiling')
  if (limits.maxChunkBytes > 262_144) {
    throw new RangeError('maxChunkBytes must not exceed the protocol chunk ceiling')
  }
  if (limits.maxFileBytes > limits.maxTemporaryBytes) throw new RangeError('maxFileBytes must not exceed maxTemporaryBytes')
  if (limits.maxFileBytes > limits.maxBatchBytes) {
    throw new RangeError('maxFileBytes must not exceed maxBatchBytes')
  }
  return limits
}

function normalizePositiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
  return value
}

function normalizeHttpUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function normalizeDisplayName(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f/\\]/gu, '_')
    .trim()
    .slice(0, 255)
  return normalized.length === 0 || normalized === '.' || normalized === '..' ? 'file' : normalized
}

function toFileTransferError(cause: unknown): RemoteTabError {
  if (cause instanceof RemoteTabError) return cause
  return new RemoteTabError('FILE_TRANSFER_FAILED', 'Upload transfer failed', { cause })
}

function assertTicketBinding(
  ticket: ViewerTicket,
  request: ViewerTicketRequest,
): void {
  if (
    ticket.claims.sessionId !== request.sessionId ||
    ticket.claims.viewerGeneration !== request.viewerGeneration ||
    ticket.claims.gatewayId !== request.gatewayId
  ) {
    throw new RemoteTabError(
      'VIEWER_TICKET_INVALID',
      'Viewer ticket issuer returned different Session binding claims',
    )
  }
}

async function withTimeout<Result>(
  operation: Promise<Result>,
  timeoutMs: number,
  timeoutError: RemoteTabError,
): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(timeoutError), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function safeError(cause: unknown): RemoteTabError {
  return cause instanceof RemoteTabError
    ? cause
    : new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Remote Tab Session failed', { cause })
}

function callNotificationHook(invoke: () => Promise<void> | void): void {
  try {
    void Promise.resolve(invoke()).catch(() => undefined)
  } catch {
    // Notification hooks cannot alter an already-applied Session transition.
  }
}
