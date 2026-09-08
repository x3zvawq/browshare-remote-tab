import { randomUUID } from 'node:crypto'
import {
  createProtocolMessage, encodeProtocolMessage, RemoteTabError,
  type NoticeContent, type NoticeCancellationReason, type ProtocolPayload,
} from '@browshare/remote-tab-protocol'
import type { NoticeRequestOptions, NoticeResult } from './contracts.js'

interface PendingNotice {
  content: NoticeContent
  expiresAt: number
  resolve(result: NoticeResult): void
  timer: ReturnType<typeof setTimeout>
  removeAbortListener(): void
}

/** Owns correlated user decisions independently of the serialized input command queue. */
export class NoticeRequests {
  readonly #pending = new Map<string, PendingNotice>()
  #recentRequests: number[] = []

  public constructor(
    private readonly sendRequest: (payload: ProtocolPayload<'notice.request'>) => void,
    private readonly sendCancel: (payload: ProtocolPayload<'notice.cancel'>) => void,
  ) {}

  public request(content: NoticeContent, options: NoticeRequestOptions = {}): Promise<NoticeResult> {
    const timeoutMs = options.timeoutMs ?? 60_000
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      throw new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Notice timeout must be 1–120000 milliseconds')
    }
    const requestId = randomUUID()
    const expiresAt = Date.now() + timeoutMs
    const payload = { requestId, content, expiresAt }
    // Validate the public JavaScript call before registering timers or consuming rate allowance.
    encodeProtocolMessage(createProtocolMessage('notice.request', {
      sessionId: 'validation', viewerGeneration: 0, sequence: 0,
    }, payload))
    if (new Set(content.buttons.map((button) => button.id)).size !== content.buttons.length) {
      throw new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Notice button IDs must be unique')
    }
    if (options.signal?.aborted) return Promise.resolve({ requestId, buttonId: null, reason: 'cancelled' })
    this.#recentRequests = this.#recentRequests.filter((time) => time > Date.now() - 60_000)
    if (this.#pending.size >= 4 || this.#recentRequests.length >= 10) {
      throw new RemoteTabError('CAPABILITY_UNAVAILABLE', 'Notice limit reached: four pending, ten per minute')
    }
    this.#recentRequests.push(Date.now())
    return new Promise<NoticeResult>((resolve, reject) => {
      const abort = (): void => this.#finish(requestId, null, 'cancelled')
      const timer = setTimeout(() => this.#finish(requestId, null, 'expired'), timeoutMs)
      timer.unref?.()
      const pending: PendingNotice = {
        content: structuredClone(content), expiresAt, resolve, timer,
        removeAbortListener: () => options.signal?.removeEventListener('abort', abort),
      }
      this.#pending.set(requestId, pending)
      options.signal?.addEventListener('abort', abort, { once: true })
      try {
        this.sendRequest(payload)
      } catch (cause) {
        clearTimeout(timer)
        pending.removeAbortListener()
        this.#pending.delete(requestId)
        reject(cause)
      }
    })
  }

  public respond(payload: ProtocolPayload<'notice.response'>): boolean {
    const pending = this.#pending.get(payload.requestId)
    // A response may cross an expiry/cancellation in flight. It can never revive a request.
    if (pending === undefined) return false
    if (pending.expiresAt <= Date.now()) {
      this.#finish(payload.requestId, null, 'expired')
      return false
    }
    if (payload.buttonId !== null && !pending.content.buttons.some((button) => button.id === payload.buttonId)) {
      throw new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Notice response names an unavailable button')
    }
    this.#finish(payload.requestId, payload.buttonId, 'response')
    return true
  }

  public cancelAll(reason: NoticeCancellationReason): void {
    for (const requestId of this.#pending.keys()) this.#finish(requestId, null, reason)
  }

  #finish(requestId: string, buttonId: string | null, reason: NoticeResult['reason']): void {
    const pending = this.#pending.get(requestId)
    if (pending === undefined) return
    this.#pending.delete(requestId)
    clearTimeout(pending.timer)
    pending.removeAbortListener()
    if (reason !== 'response') {
      try { this.sendCancel({ requestId, reason }) } catch { /* The retiring channel may already be closed. */ }
    }
    pending.resolve({ requestId, buttonId, reason })
  }
}
