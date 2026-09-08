import type {
  Capability,
  NoticeDecision,
  ProtocolPayload,
  RemoteTabErrorShape,
  RemoteTabState,
  ViewerTicketClaims,
} from '@browshare/remote-tab-protocol'

export type TabAttachment =
  | { mode: 'create'; initialUrl?: string; deferUntilViewer?: boolean }
  | { mode: 'adopt'; targetId: string }

export interface SignalingAssignment {
  gatewayId: string
  endpoint: string
  bindingToken: string
  connectionTimeoutMs?: number
}

export interface ViewerTicketRequest {
  sessionId: string
  viewerGeneration: number
  gatewayId: string
  capabilities: readonly Capability[]
  expiresInSeconds: number
}

export interface ViewerTicket {
  token: string
  claims: ViewerTicketClaims
}

export interface ViewerTicketIssuer {
  issueViewerTicket(request: ViewerTicketRequest): Promise<ViewerTicket>
}

export type NavigationAction = 'go' | 'back' | 'forward' | 'reload' | 'local-open'

export interface NavigationRequest {
  sessionId: string
  action: NavigationAction
  url?: string
  /** Document requests include page-initiated navigation and every HTTP redirect hop. */
  source?: 'viewer' | 'document'
  currentUrl?: string
  method?: string
  isRedirect?: boolean
}

export interface NavigationDecision {
  allowed: boolean
  url?: string
  reason?: string
  /** An allowed main Document still requires this Viewer confirmation before its request continues. */
  confirmation?: { title: string; body: string; confirmLabel: string }
}

export type ChildTargetPolicy = 'close-and-local-open' | 'retain'

export interface StateChangedEvent {
  sessionId: string
  previous: RemoteTabState
  current: RemoteTabState
  reason?: string
}

export interface TitleChangedEvent {
  sessionId: string
  /** Untrusted main-document title, up to 4096 Unicode code points. Not an audit/log field. */
  title: string
}

export interface RedactedAuditEvent {
  sessionId: string
  name: string
  occurredAt: number
  fields: Readonly<Record<string, string | number | boolean | null>>
}

export interface RedactedDiagnosticEvent {
  sessionId: string
  name: string
  occurredAt: number
  fields: Readonly<Record<string, string | number | boolean | null>>
}

export interface EmbedderHooks {
  authorizeNavigation(request: NavigationRequest): Promise<NavigationDecision>
  onStateChanged(event: StateChangedEvent): Promise<void> | void
  onTitleChanged?(event: TitleChangedEvent): Promise<void> | void
  onInput?(event: { sessionId: string; observedAt: number }): Promise<void> | void
  onAuditEvent?(event: RedactedAuditEvent): Promise<void> | void
  onDiagnostic?(event: RedactedDiagnosticEvent): Promise<void> | void
}

export type SessionFileDirection = 'upload' | 'download'

export interface SessionStorageReservationRequest {
  sessionId: string
  transferId: string
  direction: SessionFileDirection
  displayName: string
  declaredSize: number
  mimeType?: string
}

export interface StoredSessionFile {
  storageKey: string
  localPath: string
  displayName: string
  size: number
  mimeType?: string
}

export interface SessionStorageReservation {
  readonly localPath: string
  write(offset: number, chunk: Uint8Array): Promise<void>
  commit(): Promise<StoredSessionFile>
  abort(reason?: string): Promise<void>
}

export interface SessionStorageAdapter {
  reserve(request: SessionStorageReservationRequest): Promise<SessionStorageReservation>
  cleanupSession(sessionId: string): Promise<void>
}

/** Embedder-owned durable downloads; bytes and retention never belong to the control plane. */
export interface SessionDownloadSink {
  /** Atomically reserve or resize this download. Throw on quota exhaustion; failed resize is unchanged. */
  reserve(request: { sessionId: string; downloadId: string; declaredSize: number }): void
  /** Take ownership of a completed file before resolving. Core removes the original spool pathname afterward. */
  commit(request: { sessionId: string; downloadId: string; localPath: string; displayName: string; size: number }): Promise<void>
  /** Idempotently release an uncommitted reservation. Never delete a successfully committed file. */
  abort(request: { sessionId: string; downloadId: string }): Promise<void>
}

export interface FileTransferLimits {
  /** Empty permits every filename extension; no content sniffing is implied. */
  allowedExtensions: string[]
  maxFileBytes: number
  maxBatchBytes: number
  /** Aggregate upload reservations and Chrome download spool bytes for this Session. */
  maxTemporaryBytes: number
  maxFiles: number
  maxChunkBytes: number
  requestTimeoutMs: number
}

export interface PageScriptConfiguration {
  source: string
  context?: Readonly<Record<string, unknown>>
}

export interface SessionMediaLimits {
  maxWidth: number
  maxHeight: number
  maxFrameRate: number
  /** Bits per second; null lets the selected engine preset choose its rate. */
  maxBitrate: number | null
}

export interface AttachSessionInput {
  /** Immutable upper bounds, applied before capture and to every Viewer request. */
  mediaLimits?: SessionMediaLimits
  sessionId: string
  cdpEndpoint: string
  tab: TabAttachment
  capabilities: readonly Capability[]
  signaling: SignalingAssignment
  storage: SessionStorageAdapter
  /** With a sink, completed downloads bypass Viewer offers and survive Viewer/Session lifetime. */
  downloadSink?: SessionDownloadSink
  fileTransferLimits?: Partial<FileTransferLimits>
  childTargetPolicy?: ChildTargetPolicy
  localOpenRequestTimeoutMs?: number
  pageScript?: PageScriptConfiguration
  hooks: EmbedderHooks
  ticketIssuer: ViewerTicketIssuer
}

export interface RemoteTabAttachmentIdentity {
  readonly targetId: string
  readonly tabId: number
}

export interface NoticeRequestOptions {
  /** Defaults to 60 seconds; maximum 120 seconds. */
  timeoutMs?: number
  signal?: AbortSignal
}
export interface NoticeResult extends NoticeDecision {
  requestId: string
}

export interface RemoteTabCloseOptions {
  /** The Embedder has positively observed termination of this Session's Chrome process. */
  browserClosed?: boolean
}

export interface RemoteTabSession {
  readonly id: string
  getState(): RemoteTabState
  getAttachment(): RemoteTabAttachmentIdentity
  /** Current owned window catalog; the attachment root remains immutable. */
  getWindowState(): import('@browshare/remote-tab-protocol').WindowState
  /** Samples the visible Tab; pixels stay inside Core. First observation counts as changed. */
  sampleFrameChange(): Promise<{ changed: boolean; observedAt: number }>
  createViewerTicket(input: Omit<ViewerTicketRequest, 'sessionId'>): Promise<ViewerTicket>
  updateCapabilities(next: readonly Capability[]): Promise<void>
  sendNotice(notice: ProtocolPayload<'notice'>): void
  requestNotice(content: import('@browshare/remote-tab-protocol').NoticeContent, options?: NoticeRequestOptions): Promise<NoticeResult>
  close(reason: string, options?: RemoteTabCloseOptions): Promise<void>
}

export interface SessionFailureEvent {
  sessionId: string
  error: RemoteTabErrorShape
}
