import {
  PAGE_SCRIPT_EVENTS,
  type Capability,
  type NoticeContent,
  type NoticeDecision,
  type PageScriptEventName,
} from '@browshare/remote-tab-protocol'

export {
  parseManagedRuntimeConfiguration,
  loadRuntimeInstanceId,
  type ManagedRuntimeConfiguration,
  type RuntimeConfiguration,
} from './runtime-config.js'

export { PAGE_SCRIPT_EVENTS, type PageScriptEventName }

export interface PageScriptEventDetail {
  sessionId: string
  occurredAt: number
  location?: string
  context?: Readonly<Record<string, unknown>>
  /** Available when the Session permits noticeRequests; MAIN world, not a security boundary. */
  requestNotice?(content: NoticeContent): Promise<NoticeDecision>
}

export interface ExtensionRuntimeIdentity {
  extensionId: string
  extensionVersion: string
  runtimeGeneration: string
  runtimeInstanceId: string
}

export interface ExtensionTabBinding {
  sessionId: string
  tabId: number
  targetId: string
  viewerGeneration: number
  capabilities: readonly Capability[]
}
