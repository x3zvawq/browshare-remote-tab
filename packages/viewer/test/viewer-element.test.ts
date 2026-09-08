// @vitest-environment happy-dom

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  RemoteTabClient,
  RemoteTabClientEvent,
  RemoteTabClientEventListener,
} from '@browshare/remote-tab-client'

const clientFactory = vi.hoisted(() => vi.fn())

vi.mock('@browshare/remote-tab-client', async (loadOriginal) => ({
  ...(await loadOriginal<typeof import('@browshare/remote-tab-client')>()),
  createRemoteTabClient: clientFactory,
}))

import { RemoteTabViewerElement } from '../src/viewer-element.js'

describe('RemoteTabViewerElement file chooser', () => {
  let emit: (event: RemoteTabClientEvent) => void
  let client: RemoteTabClient
  let uploadFiles: ReturnType<typeof vi.fn>
  let cancelUpload: ReturnType<typeof vi.fn>

  beforeAll(() => {
    customElements.define('test-remote-tab-viewer', RemoteTabViewerElement)
  })

  beforeEach(() => {
    uploadFiles = vi.fn(async () => undefined)
    cancelUpload = vi.fn(async () => undefined)
    client = createClient((listener) => {
      emit = listener
    }, uploadFiles, cancelUpload)
    clientFactory.mockReturnValue(client)
  })

  afterEach(() => {
    document.body.replaceChildren()
    clientFactory.mockReset()
  })

  it('uses local cursor presentation and clears it on viewport/reconnect/revocation', async () => {
    const viewer = mountViewer()
    await tick()
    emit({ type: 'connection-state-change', state: 'CONNECTED' })
    const surface = required<HTMLElement>(viewer, '.surface')
    emit({ type: 'cursor-change', cursor: 'text' })
    expect(surface.style.cursor).toBe('text')
    emit({ type: 'viewport-change', viewport: { width: 1280, height: 720, deviceScaleFactor: 1, frameRate: 30, revision: 2 } })
    expect(surface.style.cursor).toBe('default')
    emit({ type: 'cursor-change', cursor: 'pointer' })
    expect(surface.style.cursor).toBe('pointer')
    emit({ type: 'capabilities-change', capabilities: [] })
    expect(surface.style.cursor).toBe('default')
    emit({ type: 'cursor-change', cursor: 'wait' })
    emit({ type: 'connection-state-change', state: 'RECONNECTING' })
    expect(surface.style.cursor).toBe('default')
  })

  it('selects local files, renders progress, and closes only after remote delivery', async () => {
    let resolveUpload!: () => void
    uploadFiles.mockReturnValueOnce(new Promise<void>((resolve) => {
      resolveUpload = resolve
    }))
    const viewer = mountViewer()
    const completed = vi.fn()
    viewer.addEventListener('upload-complete', completed)
    await tick()

    emit({
      type: 'upload-request',
      requestId: 'request-1',
      multiple: true,
      expiresAt: Date.now() + 10_000,
    })
    const dialog = required<HTMLElement>(viewer, '[data-upload-dialog]')
    const input = required<HTMLInputElement>(viewer, '[data-upload-input]')
    expect(dialog.hidden).toBe(false)
    expect(input.multiple).toBe(true)

    const first = new File([Uint8Array.of(1, 2)], 'first.txt', { type: 'text/plain' })
    const second = new File([Uint8Array.of(3)], 'second.bin')
    Object.defineProperty(input, 'files', { configurable: true, value: [first, second] })
    input.dispatchEvent(new Event('change'))
    await tick()
    expect(uploadFiles).toHaveBeenCalledWith('request-1', [first, second])
    expect(required<HTMLElement>(viewer, '[data-upload-progress]').hidden).toBe(false)

    emit({ type: 'upload-progress', transferId: 'transfer-1', sentBytes: 2, totalBytes: 3 })
    expect(required<HTMLProgressElement>(viewer, '[data-upload-progress-bar]')).toMatchObject({
      value: 2,
      max: 3,
    })
    expect(required<HTMLElement>(viewer, '[data-upload-progress-value]').textContent).toBe('2 B / 3 B')
    expect(dialog.hidden).toBe(false)

    resolveUpload()
    await tick()
    expect(dialog.hidden).toBe(true)
    expect(completed).toHaveBeenCalledOnce()
  })

  it('lets the user cancel and closes stale dialogs when Core cancels a request', async () => {
    const viewer = mountViewer()
    await tick()
    emit({
      type: 'upload-request',
      requestId: 'request-cancel',
      multiple: false,
      expiresAt: Date.now() + 10_000,
    })
    required<HTMLButtonElement>(viewer, '[data-action="upload-cancel"]').click()
    await tick()
    expect(cancelUpload).toHaveBeenCalledWith('request-cancel')
    expect(required<HTMLElement>(viewer, '[data-upload-dialog]').hidden).toBe(true)

    emit({
      type: 'upload-request',
      requestId: 'request-expired',
      multiple: false,
      expiresAt: Date.now() + 10_000,
    })
    expect(required<HTMLElement>(viewer, '[data-upload-dialog]').hidden).toBe(false)
    emit({
      type: 'upload-cancelled',
      requestId: 'request-expired',
      reason: 'Remote file chooser request expired',
    })
    expect(required<HTMLElement>(viewer, '[data-upload-dialog]').hidden).toBe(true)
  })

  it('queues local-open confirmations and renders dismissible structured Notices', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const viewer = mountViewer()
    await tick()
    emit({
      type: 'local-open-request',
      requestId: 'local-1',
      url: 'https://example.test/first',
      expiresAt: Date.now() + 10_000,
    })
    emit({
      type: 'local-open-request',
      requestId: 'local-2',
      url: 'https://example.test/second',
      expiresAt: Date.now() + 10_000,
    })
    expect(required<HTMLElement>(viewer, '[data-local-url]').textContent).toBe(
      'https://example.test/first',
    )

    required<HTMLButtonElement>(viewer, '[data-action="local-open"]').click()
    await tick()
    expect(client.respondToLocalOpen).toHaveBeenCalledWith('local-1', true)
    expect(open).toHaveBeenCalledWith(
      'https://example.test/first',
      '_blank',
      'noopener,noreferrer',
    )
    expect(required<HTMLElement>(viewer, '[data-local-url]').textContent).toBe(
      'https://example.test/second',
    )

    emit({ type: 'local-open-cancelled', requestId: 'local-2', reason: 'expired' })
    expect(required<HTMLDialogElement>(viewer, '[data-local-dialog]').open).toBe(false)

    emit({
      type: 'notice',
      notice: { level: 'warning', code: 'LOCAL_OPEN_DENIED', message: 'Policy denied this link.' },
    })
    const notice = required<HTMLElement>(viewer, '[data-notice]')
    expect(notice.dataset.level).toBe('warning')
    expect(notice.textContent).toContain('Policy denied this link.')
    required<HTMLButtonElement>(viewer, '[data-action="notice-close"]').click()
    expect(viewer.shadowRoot?.querySelector('[data-notice]')).toBeNull()
    open.mockRestore()
  })

  it('connects when an async Embedder supplies both credentials after mounting', async () => {
    const viewer = document.createElement('test-remote-tab-viewer') as RemoteTabViewerElement
    document.body.append(viewer)
    await tick()
    expect(clientFactory).not.toHaveBeenCalled()

    viewer.setAttribute('endpoint', 'wss://signal.example.test')
    viewer.setAttribute('ticket', 'viewer-ticket')
    await tick()

    expect(clientFactory).toHaveBeenCalledOnce()
    expect(client.connect).toHaveBeenCalledOnce()
  })

  it('reports errors on the Viewer without reaching global error handlers', async () => {
    const viewer = mountViewer()
    const elementHandler = vi.fn()
    const documentHandler = vi.fn()
    const windowHandler = vi.fn()
    viewer.addEventListener('error', elementHandler)
    document.addEventListener('error', documentHandler)
    window.addEventListener('error', windowHandler)
    await tick()

    emit({
      type: 'error',
      error: { code: 'ICE_FAILED', message: 'No viable ICE pair', retryable: true },
    })

    expect(elementHandler).toHaveBeenCalledOnce()
    expect((elementHandler.mock.calls[0]![0] as CustomEvent).detail).toEqual({
      type: 'error',
      error: { code: 'ICE_FAILED', message: 'No viable ICE pair', retryable: true },
    })
    expect(documentHandler).not.toHaveBeenCalled()
    expect(windowHandler).not.toHaveBeenCalled()
    document.removeEventListener('error', documentHandler)
    window.removeEventListener('error', windowHandler)
  })
})

function createClient(
  installListener: (listener: RemoteTabClientEventListener) => void,
  uploadFiles: ReturnType<typeof vi.fn>,
  cancelUpload: ReturnType<typeof vi.fn>,
): RemoteTabClient {
  return {
    state: 'CONNECTED',
    capabilities: ['upload'],
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    attachVideo: vi.fn(),
    detachVideo: vi.fn(),
    suspend: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    navigate: vi.fn(async () => undefined),
    requestViewport: vi.fn(async () => undefined),
    requestQuality: vi.fn(async () => undefined),
    sendPointer: vi.fn(),
    sendKey: vi.fn(),
    sendComposition: vi.fn(),
    respondToLocalOpen: vi.fn(async () => undefined),
    uploadFiles,
    cancelUpload,
    addEventListener: vi.fn((listener: RemoteTabClientEventListener) => {
      installListener(listener)
      return () => undefined
    }),
  }
}

function mountViewer(): RemoteTabViewerElement {
  const viewer = document.createElement('test-remote-tab-viewer') as RemoteTabViewerElement
  viewer.setAttribute('ticket', 'viewer-ticket')
  viewer.setAttribute('endpoint', 'wss://signal.example.test')
  document.body.append(viewer)
  return viewer
}

function required<ElementType extends Element>(
  viewer: RemoteTabViewerElement,
  selector: string,
): ElementType {
  const element = viewer.shadowRoot?.querySelector<ElementType>(selector)
  if (element === null || element === undefined) throw new Error(`Missing ${selector}`)
  return element
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
