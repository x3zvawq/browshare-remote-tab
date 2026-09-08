import {
  createProtocolMessage, encodeProtocolMessage, RemoteTabError,
  type NoticeContent, type NoticeDecision,
} from '@browshare/remote-tab-protocol'
import type { NoticeRequestOptions, NoticeResult } from './contracts.js'

export const PAGE_NOTICE_BINDING = '__browshareRemoteTabPageNotice'
export const PAGE_NOTICE_RESULT_EVENT = 'browshare:notice_result'

export type PageScriptNoticeHandler = (
  content: NoticeContent, options: NoticeRequestOptions,
) => Promise<NoticeResult>

type Reply = { result: NoticeDecision } | { error: { code: string; message: string } }

/** The CDP owner supplies a verified MAIN-world context; replies never use the current default context. */
export class PageScriptNotices {
  readonly #pending = new Map<string, { contextId: string; abort: AbortController }>()
  #recentRequests: number[] = []

  public constructor(
    private readonly requestNotice: PageScriptNoticeHandler,
    private readonly deliver: (contextId: string, requestId: number, reply: Reply) => Promise<void>,
  ) {}

  public handle(payload: unknown, contextId: string): void {
    if (typeof payload !== 'string' || payload.length > 16_384) return
    let value: unknown
    try { value = JSON.parse(payload) } catch { return }
    if (value === null || typeof value !== 'object') return
    const request = value as Record<string, unknown>
    if (!Number.isSafeInteger(request.requestId) || (request.requestId as number) < 1) return
    const requestId = request.requestId as number
    const key = `${contextId}:${requestId}`
    if (request.type === 'cancel' && Object.keys(request).length === 2) {
      this.#pending.get(key)?.abort.abort()
      return
    }
    if (request.type !== 'request' || Object.keys(request).some((key) => !['type', 'requestId', 'content'].includes(key))) return
    if (this.#pending.has(key)) return
    void this.#request(key, contextId, requestId, request.content)
  }

  public cancelContext(contextId: string): void {
    for (const [key, pending] of this.#pending) {
      if (pending.contextId !== contextId) continue
      this.#pending.delete(key)
      pending.abort.abort()
    }
  }

  public cancelAll(): void {
    for (const pending of this.#pending.values()) pending.abort.abort()
    this.#pending.clear()
  }

  async #request(key: string, contextId: string, requestId: number, content: unknown): Promise<void> {
    let pending: { contextId: string; abort: AbortController } | undefined
    let reply: Reply
    try {
      this.#recentRequests = this.#recentRequests.filter((time) => time > Date.now() - 60_000)
      if (this.#pending.size >= 4 || this.#recentRequests.length >= 10) {
        throw new RemoteTabError('CAPABILITY_UNAVAILABLE', 'Page Notice limit reached')
      }
      this.#recentRequests.push(Date.now())
      encodeProtocolMessage(createProtocolMessage('notice.request', {
        sessionId: 'validation', viewerGeneration: 0, sequence: 0,
      }, { requestId: String(requestId), expiresAt: Date.now() + 60_000, content: content as NoticeContent }))
      const buttons = (content as NoticeContent).buttons
      if (new Set(buttons.map((button) => button.id)).size !== buttons.length) {
        throw new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Page Notice button IDs must be unique')
      }
      pending = { contextId, abort: new AbortController() }
      this.#pending.set(key, pending)
      const result = await this.requestNotice(content as NoticeContent, { signal: pending.abort.signal })
      reply = { result: { buttonId: result.buttonId, reason: result.reason } }
    } catch (cause) {
      reply = { error: {
        code: cause instanceof RemoteTabError ? cause.code : 'CAPABILITY_UNAVAILABLE',
        message: 'Page Notice request could not be completed',
      } }
    }
    // Context retirement removes the entry before aborting the Core request. Never deliver to
    // its successor, even if a numeric executionContextId is reused after process navigation.
    if (pending !== undefined && this.#pending.get(key) !== pending) return
    this.#pending.delete(key)
    await this.deliver(contextId, requestId, reply).catch(() => undefined)
  }
}

/** Included in the existing trusted lifecycle bootstrap before it dispatches its first event. */
export function createPageNoticeBootstrap(): string {
  return String.raw`
  const noticeBinding = globalThis[${JSON.stringify(PAGE_NOTICE_BINDING)}]
  const pendingNotices = new Map()
  let nextNoticeId = 0
  const finishNotice = (requestId, reply) => {
    const pending = pendingNotices.get(requestId)
    if (!pending) return
    pendingNotices.delete(requestId)
    clearTimeout(pending.timer)
    if (reply.error) {
      const error = new Error(reply.error.message)
      error.code = reply.error.code
      pending.reject(error)
    } else pending.resolve(Object.freeze(reply.result))
  }
  const cancelNotices = () => {
    for (const requestId of [...pendingNotices.keys()]) {
      try { noticeBinding(JSON.stringify({type: 'cancel', requestId})) } catch {}
      finishNotice(requestId, {result: {buttonId: null, reason: 'cancelled'}})
    }
  }
  const requestNotice = (content) => new Promise((resolve, reject) => {
    if (detached || pendingNotices.size >= 4 || typeof noticeBinding !== 'function') {
      const error = new Error('Page Notice is unavailable')
      error.code = 'CAPABILITY_UNAVAILABLE'
      reject(error)
      return
    }
    const requestId = ++nextNoticeId
    const timer = setTimeout(() => {
      try { noticeBinding(JSON.stringify({type: 'cancel', requestId})) } catch {}
      finishNotice(requestId, {result: {buttonId: null, reason: 'expired'}})
    }, 60_000)
    pendingNotices.set(requestId, {resolve, reject, timer})
    try {
      const payload = JSON.stringify({type: 'request', requestId, content})
      if (payload.length > 16384) throw new Error('Page Notice exceeds its size limit')
      noticeBinding(payload)
    } catch {
      finishNotice(requestId, {error: {code: 'PROTOCOL_MESSAGE_INVALID', message: 'Page Notice content is invalid'}})
    }
  })
  globalThis.addEventListener(${JSON.stringify(PAGE_NOTICE_RESULT_EVENT)}, event => {
    const detail = event.detail
    if (detail && Number.isSafeInteger(detail.requestId)) finishNotice(detail.requestId, detail.reply)
  })
  globalThis.addEventListener('pagehide', cancelNotices, {capture: true})
`
}

export function pageNoticeReplyExpression(requestId: number, reply: Reply): string {
  return `globalThis.dispatchEvent(new CustomEvent(${JSON.stringify(PAGE_NOTICE_RESULT_EVENT)}, {detail: ${JSON.stringify({ requestId, reply })}}))`
}
