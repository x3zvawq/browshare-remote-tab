import type {
  Capability,
  IceCandidateSummary,
  IceRelayProtocol,
  MediaQualityPreset,
  MediaQualitySettings,
  QualityConfiguration,
  QualityState,
  DataChannelMetrics,
  ProtocolPayload,
  RemoteTabErrorShape,
  RemoteTabState,
  WebRtcMediaMetrics,
  Viewport,
} from '@browshare/remote-tab-protocol'

export interface RemoteTabClientOptions {
  ticket: string
  endpoint: string
  signal?: AbortSignal
  connectionTimeoutMs?: number
  iceRestart?: false | RemoteTabIceRestartOptions
  reconnect?: false | RemoteTabReconnectOptions
}

export interface RemoteTabIceRestartOptions {
  maxAttempts?: number
  disconnectedDelayMs?: number
  attemptTimeoutMs?: number
}

export interface RemoteTabConnectionCredentials {
  ticket: string
  endpoint: string
}

export interface RemoteTabReconnectRequest {
  attempt: number
  cause: RemoteTabErrorShape
  previousSessionId: string
  previousViewerGeneration: number
}

export interface RemoteTabReconnectOptions {
  getConnection(request: RemoteTabReconnectRequest): Promise<RemoteTabConnectionCredentials>
  maxAttempts?: number
  minimumDelayMs?: number
  maximumDelayMs?: number
}

export interface RemoteTabConnectionStateEvent {
  type: 'connection-state-change'
  state: RemoteTabState
  reason?: string
}

export interface RemoteTabCapabilitiesEvent {
  type: 'capabilities-change'
  capabilities: readonly Capability[]
}

export interface RemoteTabViewportEvent {
  type: 'viewport-change'
  viewport: Viewport
}

export interface RemoteTabNavigationResultEvent {
  type: 'navigation-result'
  result: ProtocolPayload<'navigation.result'>
}

export interface RemoteTabNavigationLocationEvent {
  type: 'navigation-location-change'
  url: string
}

export interface RemoteTabPageScriptEvent {
  type: 'page-script-event'
  event: ProtocolPayload<'page.lifecycle'>
}

export interface RemoteTabQualityEvent {
  type: 'quality-change'
  quality: MediaQualitySettings
}

export interface RemoteTabQualityConfigurationEvent {
  type: 'quality-configuration-change'
  state: QualityState
}

export interface RemoteTabNoticeEvent {
  type: 'notice'
  notice: ProtocolPayload<'notice'>
}

export interface RemoteTabLocalOpenEvent {
  type: 'local-open-request'
  requestId: string
  url: string
  expiresAt: number
}

export interface RemoteTabLocalOpenCancelledEvent {
  type: 'local-open-cancelled'
  requestId: string
  reason: 'expired' | 'connection-lost'
}

export interface RemoteTabUploadRequestEvent {
  constraints?: ProtocolPayload<'file.upload.request'>['constraints']
  type: 'upload-request'
  requestId: string
  multiple: boolean
  expiresAt: number
}

export interface RemoteTabUploadProgressEvent {
  type: 'upload-progress'
  transferId: string
  sentBytes: number
  totalBytes: number
}

export interface RemoteTabUploadCancelledEvent {
  type: 'upload-cancelled'
  requestId: string
  transferId?: string
  reason?: string
}

export interface RemoteTabDownloadRequestEvent {
  type: 'download-request'
  transferId: string
  file: ProtocolPayload<'file.download.offer'>['file']
  expiresAt: number
}

export interface RemoteTabDownloadProgressEvent {
  type: 'download-progress'
  transferId: string
  receivedBytes: number
  totalBytes: number
}

export interface RemoteTabDownloadCancelledEvent {
  type: 'download-cancelled'
  transferId: string
  reason?: string
}

export interface RemoteTabDownloadedFile {
  transferId: string
  displayName: string
  size: number
  mimeType?: string
  blob: Blob
}

export interface RemoteTabDownloadCompleteEvent {
  type: 'download-complete'
  download: RemoteTabDownloadedFile
}

export type RemoteTabClipboardWriteItem =
  | {
      mimeType: 'text/plain'
      data: string | Blob | ArrayBuffer | Uint8Array
    }
  | {
      mimeType: 'image/png'
      data: Blob | ArrayBuffer | Uint8Array
    }

export interface RemoteTabClipboardItem {
  mimeType: 'text/plain' | 'image/png'
  size: number
  data: Uint8Array<ArrayBuffer>
  blob: Blob
}

export interface RemoteTabClipboardProgressEvent {
  type: 'clipboard-progress'
  direction: 'read' | 'write'
  transferId: string
  transferredBytes: number
  totalBytes: number
}

export type RemoteTabUploadFile =
  | File
  | {
      displayName: string
      data: Blob | ArrayBuffer | Uint8Array
      mimeType?: string
    }

export interface RemoteTabClientErrorEvent {
  type: 'error'
  error: RemoteTabErrorShape
}

export type RemoteTabDiagnostic =
  | { name: 'signaling.socket-open' }
  | { name: 'signaling.socket-close' }
  | { name: 'signaling.ready'; iceServerCount: number; iceTransportPolicy: 'all' | 'relay' }
  | { name: 'signaling.description-received'; descriptionType: 'offer' }
  | { name: 'signaling.description-sent'; descriptionType: 'answer' }
  | ({ name: 'ice.candidate-received' } & IceCandidateSummary)
  | ({ name: 'ice.candidate-sent' } & IceCandidateSummary)
  | {
      name: 'webrtc.state'
      signalingState: RTCSignalingState
      iceGatheringState: RTCIceGatheringState
      iceConnectionState: RTCIceConnectionState
      connectionState: RTCPeerConnectionState
    }
  | {
      name: 'webrtc.selected-candidate-pair'
      localCandidateType?: IceCandidateSummary['candidateType']
      remoteCandidateType?: IceCandidateSummary['candidateType']
      protocol?: IceCandidateSummary['protocol']
      relayProtocol?: IceRelayProtocol
    }
  | { name: 'media.track-received'; kind: 'audio' | 'video' }
  | { name: 'data-channel.open' | 'data-channel.close'; label: string }
  | { name: 'ice.restart-requested'; attempt: number; maximumAttempts: number }
  | { name: 'reconnect.credentials-requested'; attempt: number; maximumAttempts: number }
  | WebRtcMediaMetrics
  | DataChannelMetrics

export interface RemoteTabDiagnosticEvent {
  type: 'diagnostic'
  diagnostic: RemoteTabDiagnostic
}

export type RemoteTabClientEvent =
  | { type: 'cursor-change'; cursor: import('@browshare/remote-tab-protocol').CursorKind }
  | { type: 'window-change'; state: import('@browshare/remote-tab-protocol').WindowState }
  | { type: 'playback-blocked'; reason: 'user-activation-required' }
  | RemoteTabConnectionStateEvent
  | RemoteTabCapabilitiesEvent
  | RemoteTabViewportEvent
  | RemoteTabNavigationResultEvent
  | RemoteTabNavigationLocationEvent
  | RemoteTabPageScriptEvent
  | RemoteTabQualityEvent
  | RemoteTabQualityConfigurationEvent
  | { type: 'notice-request'; request: ProtocolPayload<'notice.request'> }
  | { type: 'notice-closed'; requestId: string; reason: 'response' | import('@browshare/remote-tab-protocol').NoticeCancellationReason }
  | RemoteTabNoticeEvent
  | RemoteTabLocalOpenEvent
  | RemoteTabLocalOpenCancelledEvent
  | RemoteTabUploadRequestEvent
  | RemoteTabUploadProgressEvent
  | RemoteTabUploadCancelledEvent
  | RemoteTabDownloadRequestEvent
  | RemoteTabDownloadProgressEvent
  | RemoteTabDownloadCancelledEvent
  | RemoteTabDownloadCompleteEvent
  | RemoteTabClipboardProgressEvent
  | RemoteTabClientErrorEvent
  | RemoteTabDiagnosticEvent

export type RemoteTabClientEventListener = (event: RemoteTabClientEvent) => void

export type NavigationCommand =
  | { action: 'go'; url: string }
  | { action: 'back' }
  | { action: 'forward' }
  | { action: 'reload' }

export interface RemoteTabClient {
  readonly windowState: import('@browshare/remote-tab-protocol').WindowState | undefined
  selectWindow(targetId: string): Promise<void>
  closeWindow(): Promise<void>
  readonly state: RemoteTabState
  readonly capabilities: readonly Capability[]
  connect(): Promise<void>
  disconnect(): Promise<void>
  attachVideo(element: HTMLVideoElement): void
  detachVideo(): void
  suspend(): Promise<void>
  resume(): Promise<void>
  navigate(command: NavigationCommand): Promise<void>
  requestViewport(request: ProtocolPayload<'viewport.request'>): Promise<void>
  requestQuality(preset: MediaQualityPreset): Promise<void>
  configureQuality(configuration: QualityConfiguration): Promise<QualityState>
  sendPointer(input: ProtocolPayload<'input.pointer'>): void
  sendKey(input: ProtocolPayload<'input.key'>): void
  sendComposition(input: ProtocolPayload<'input.composition'>): void
  respondToNotice(requestId: string, buttonId: string | null): Promise<void>
  respondToLocalOpen(requestId: string, approved: boolean): Promise<void>
  dropFiles(point: { x: number; y: number; viewportRevision: number }, files: readonly RemoteTabUploadFile[]): Promise<void>
  uploadFiles(requestId: string, files: readonly RemoteTabUploadFile[]): Promise<void>
  cancelUpload(requestId: string): Promise<void>
  acceptDownload(transferId: string): Promise<RemoteTabDownloadedFile>
  cancelDownload(transferId: string): Promise<void>
  writeRemoteClipboard(items: readonly RemoteTabClipboardWriteItem[]): Promise<void>
  readRemoteClipboard(selection?: 'copy' | 'cut'): Promise<readonly RemoteTabClipboardItem[]>
  addEventListener(listener: RemoteTabClientEventListener): () => void
}

export { createRemoteTabClient } from './remote-tab-client.js'
