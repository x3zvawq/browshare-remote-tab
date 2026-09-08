import type {
  RemoteTabClientEvent,
  RemoteTabClipboardItem,
} from '@browshare/remote-tab-client'

export { mapPointerToViewport, type PointerMappingInput } from './pointer.js'
export { RemoteTabViewerElement, type ViewerFocusPolicy } from './viewer-element.js'

import { RemoteTabViewerElement } from './viewer-element.js'

export const REMOTE_TAB_VIEWER_TAG_NAME: 'browshare-tab-viewer' = 'browshare-tab-viewer'

export interface RemoteTabViewerAttributes {
  ticket: string
  endpoint: string
  locale?: string
  suspendWhenUnfocused?: boolean
}

export interface ViewerReadyDetail {
  state: 'READY'
}

export interface SessionCloseRequestDetail {
  reason: string
}

export interface RemoteTabViewerEventDetailMap {
  'viewer-ready': ViewerReadyDetail
  'quality-configuration-change': Extract<RemoteTabClientEvent, { type: 'quality-configuration-change' }>
  'quality-change': Extract<RemoteTabClientEvent, { type: 'quality-change' }>
  'window-change': Extract<RemoteTabClientEvent, { type: 'window-change' }>
  'playback-blocked': Extract<RemoteTabClientEvent, { type: 'playback-blocked' }>
  'connection-state-change': Extract<RemoteTabClientEvent, { type: 'connection-state-change' }>
  'session-close-request': SessionCloseRequestDetail
  'navigation-location-change': Extract<RemoteTabClientEvent, { type: 'navigation-location-change' }>
  'local-open-request': Extract<RemoteTabClientEvent, { type: 'local-open-request' }>
  'upload-request': Extract<RemoteTabClientEvent, { type: 'upload-request' }>
  'upload-progress': Extract<RemoteTabClientEvent, { type: 'upload-progress' }>
  'upload-cancelled': Extract<RemoteTabClientEvent, { type: 'upload-cancelled' }>
  'upload-complete': { requestId: string }
  'download-request': Extract<RemoteTabClientEvent, { type: 'download-request' }>
  'download-progress': Extract<RemoteTabClientEvent, { type: 'download-progress' }>
  'download-cancelled': Extract<RemoteTabClientEvent, { type: 'download-cancelled' }>
  'download-complete': Extract<RemoteTabClientEvent, { type: 'download-complete' }>
  'clipboard-write-request': { direction: 'local-to-remote' }
  'clipboard-read-request': { direction: 'remote-to-local' }
  'clipboard-progress': Extract<RemoteTabClientEvent, { type: 'clipboard-progress' }>
  'clipboard-write-complete': {
    mimeTypes: readonly ('text/plain' | 'image/png')[]
    manual?: boolean
  }
  'clipboard-read-complete': { items: readonly RemoteTabClipboardItem[] }
  'page-script-event': Extract<RemoteTabClientEvent, { type: 'page-script-event' }>
  'notice-request': Extract<RemoteTabClientEvent, { type: 'notice-request' }>
  'notice-closed': Extract<RemoteTabClientEvent, { type: 'notice-closed' }>
  'notice': Extract<RemoteTabClientEvent, { type: 'notice' }>
  'diagnostic': Extract<RemoteTabClientEvent, { type: 'diagnostic' }>
  'error': Extract<RemoteTabClientEvent, { type: 'error' }>
}

export type RemoteTabViewerEventName = keyof RemoteTabViewerEventDetailMap

export function defineRemoteTabViewer(
  registry: CustomElementRegistry = globalThis.customElements,
): void {
  if (registry.get(REMOTE_TAB_VIEWER_TAG_NAME) === undefined) {
    registry.define(REMOTE_TAB_VIEWER_TAG_NAME, RemoteTabViewerElement)
  }
}
