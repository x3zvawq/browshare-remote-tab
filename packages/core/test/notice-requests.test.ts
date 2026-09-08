import { afterEach, describe, expect, it, vi } from 'vitest'
import { NoticeRequests } from '../src/notice-requests.js'
import type { ProtocolPayload } from '@browshare/remote-tab-protocol'

const content = { kind: 'confirm' as const, title: 'Confirm', body: 'Text only', buttons: [{ id: 'ok', label: 'Continue' }] }
afterEach(() => vi.useRealTimers())
describe('Notice request lifetime', () => {
  it('rejects invalid input before allocation and enforces pending/rate limits', async () => {
    vi.useFakeTimers()
    const send = vi.fn(), cancel = vi.fn(), notices = new NoticeRequests(send, cancel)
    expect(() => notices.request({ ...content, buttons: [...content.buttons, ...content.buttons] })).toThrow('unique')
    expect(() => notices.request({ ...content, body: 'x'.repeat(2049) })).toThrow()
    expect(() => notices.request(content, { timeoutMs: 120001 })).toThrow()
    expect(send).not.toHaveBeenCalled()
    const pending = Array.from({ length: 4 }, () => notices.request(content))
    expect(() => notices.request(content)).toThrow('limit')
    notices.cancelAll('viewer-replaced')
    expect(await Promise.all(pending)).toEqual(Array.from({ length: 4 }, () => expect.objectContaining({ buttonId: null, reason: 'viewer-replaced' })))
    for (let i = 0; i < 6; i++) {
      const next = notices.request(content)
      notices.cancelAll('cancelled')
      await next
    }
    expect(() => notices.request(content)).toThrow('limit')
    vi.advanceTimersByTime(60001)
    const next = notices.request(content, { timeoutMs: 10 })
    vi.advanceTimersByTime(10)
    await expect(next).resolves.toMatchObject({ buttonId: null, reason: 'expired' })
  })

  it('validates button identity and cancels aborted requests without accepting late responses', async () => {
    const sent: ProtocolPayload<'notice.request'>[] = []
    const notices = new NoticeRequests((r) => sent.push(r), vi.fn())
    const abort = new AbortController()
    const result = notices.request(content, { signal: abort.signal })
    const requestId = sent[0]!.requestId
    expect(() => notices.respond({ requestId, buttonId: 'other' })).toThrow('unavailable')
    abort.abort()
    notices.respond({ requestId, buttonId: 'ok' })
    await expect(result).resolves.toMatchObject({ reason: 'cancelled', buttonId: null })
    await expect(notices.request(content, { signal: abort.signal })).resolves.toMatchObject({ reason: 'cancelled' })
    expect(sent).toHaveLength(1)
  })
})
