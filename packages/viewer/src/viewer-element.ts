import {
  createRemoteTabClient,
  type RemoteTabClient,
  type RemoteTabClipboardItem,
  type RemoteTabClipboardWriteItem,
  type RemoteTabClientEvent,
  type RemoteTabDownloadedFile,
  type RemoteTabIceRestartOptions,
  type RemoteTabReconnectOptions,
} from '@browshare/remote-tab-client'
import { assertUploadAllowed, RemoteTabError, type UploadConstraints } from '@browshare/remote-tab-protocol'
import type { Capability, QualityConfiguration, QualityState, MediaQualitySettings, MediaQualityPreset, RemoteTabState, Viewport, WindowState } from '@browshare/remote-tab-protocol'

import { mapPointerToViewport } from './pointer.js'
import { viewerIcon } from './icons.js'
import { VIEWER_STYLES } from './styles.js'

const HTMLElementBase = (globalThis.HTMLElement ?? class {}) as typeof HTMLElement
const copy = {
  'zh-CN': {
    autoQuality: '自动', customQuality: '自定义', configureQuality: '调整自定义画质', qualityCopy: '自动模式根据网络和编码压力调整画质。自定义设置仍受会话媒体上限约束。缩小倍数 2 表示宽高各缩小一半。', bitrate: '最高码率（kbps）', frameRate: '最高帧率（FPS）', resolutionScale: '分辨率缩小倍数', qualityApply: '应用', qualityApplying: '正在应用…', qualityApplied: '已应用的编码上限', qualityUnknown: '等待发送端确认', qualityInvalid: '请输入码率 100–20000（最多三位小数）、整数帧率 1–60，以及 1–4 的分辨率缩小倍数。', qualityFailed: '画质设置失败，请重试。',
    immersive: '沉浸模式', exitImmersive: '退出沉浸',
    windows: '远端窗口', mainWindow: '主窗口', childWindow: '附属窗口', switchingWindow: '正在切换窗口…', closeWindow: '关闭当前附属窗口',
    playback: '点击播放', playbackTitle: '浏览器需要你允许播放', playbackCopy: '连接已建立。点击播放后显示远端画面并启用可用的声音。',
    back: '后退', forward: '前进', reload: '刷新', address: '输入网址', quality: '画质', dataSaver: '节省流量', balanced: '均衡', high: '高清', fullscreen: '全屏', end: '结束',
    keyboard: '打开键盘', mobilePreview: '移动端预览支持：轻点或拖动控制，双指滚动；先点远端输入框，再点键盘按钮输入文字。剪贴板和下载能力取决于浏览器权限。',
    resume: '恢复传输', suspendedCopy: '音视频传输已暂停，远端页面仍在运行。点击恢复继续操作。',
    ready: '等待连接', connecting: '正在连接远程标签页…', connected: '已连接', suspended: '已暂停传输', failed: '连接失败', closed: '会话已关闭',
    localTitle: '是否在本机打开？', localCopy: '此链接将在本机浏览器中打开，不会继承远端登录状态。原窗口的表单提交数据和窗口关联不会传递，部分页面可能需要重新登录或操作。', cancel: '取消', open: '在本机打开',
    uploadInvalid: '所选文件不符合以上上传限制，请调整后重试。', uploadTitle: '选择本机文件', uploadSingle: '远程页面正在等待一个文件。', uploadMultiple: '远程页面正在等待一个或多个文件。', chooseFiles: '选择文件', uploading: '正在发送', uploadFailed: '文件发送失败', uploadRestart: '本次文件选择请求已结束。请关闭此窗口，在远端页面重新点击选择文件后再试。', close: '关闭',
    downloadTitle: '保存远程下载？', downloadCopy: '远程页面下载了这个文件。确认后会保存到你的设备。', saveDownload: '保存到本机', downloading: '正在接收', downloadFailed: '文件接收失败',
    copyRemote: '复制远端内容', pasteRemote: '粘贴到远端', clipboardReading: '正在读取远端剪贴板…', clipboardWriting: '正在发送到远端…', clipboardDone: '剪贴板操作完成',
    pasteFallbackTitle: '手动粘贴文字', pasteFallbackCopy: '浏览器不允许此页面读取本机剪贴板。请在下方粘贴文字，再发送到远端。', pastePlaceholder: '在这里粘贴要发送的文字', sendRemote: '发送到远端',
    copyFallbackTitle: '手动复制内容', copyFallbackCopy: '浏览器不允许此页面写入本机剪贴板。请从下方文本框手动复制。', imageFallback: '远端剪贴板还包含一张图片；当前浏览器拒绝写入图片，请允许剪贴板权限后重试。', imagePasteFallback: '当前会话只允许图片剪贴板，但浏览器拒绝读取图片。请允许剪贴板权限后重试。', clipboardFailed: '剪贴板操作失败',
  },
  'en-US': {
    autoQuality: 'Auto', customQuality: 'Custom', configureQuality: 'Adjust custom quality', qualityCopy: 'Auto adjusts quality to network and encoder pressure. Custom settings remain subject to session media limits. A downscale factor of 2 halves both width and height.', bitrate: 'Maximum bitrate (kbps)', frameRate: 'Maximum frame rate (FPS)', resolutionScale: 'Resolution downscale factor', qualityApply: 'Apply', qualityApplying: 'Applying…', qualityApplied: 'Applied encoding limits', qualityUnknown: 'Waiting for sender confirmation', qualityInvalid: 'Enter a bitrate from 100 to 20000 (up to three decimals), an integer frame rate from 1 to 60, and a resolution factor from 1 to 4.', qualityFailed: 'Quality settings failed. Please retry.',
    immersive: 'Immersive', exitImmersive: 'Exit immersive',
    windows: 'Remote window', mainWindow: 'Main window', childWindow: 'Child window', switchingWindow: 'Switching windows…', closeWindow: 'Close current child window',
    playback: 'Start playback', playbackTitle: 'Playback needs your permission', playbackCopy: 'Connected. Start playback to show the remote screen and enable available audio.',
    back: 'Back', forward: 'Forward', reload: 'Reload', address: 'Enter address', quality: 'Quality', dataSaver: 'Data saver', balanced: 'Balanced', high: 'High', fullscreen: 'Fullscreen', end: 'End',
    keyboard: 'Open keyboard', mobilePreview: 'Mobile preview support: tap or drag to control, use two fingers to scroll, then open the keyboard after selecting a remote field. Clipboard and download behavior depends on browser permissions.',
    resume: 'Resume streaming', suspendedCopy: 'Audio and video are paused. The remote page is still running. Resume to continue.',
    ready: 'Ready to connect', connecting: 'Connecting to the remote tab…', connected: 'Connected', suspended: 'Streaming paused', failed: 'Connection failed', closed: 'Session closed',
    localTitle: 'Open on this device?', localCopy: 'This link opens in your browser without the remote sign-in state, submitted form data or connection to the original window. You may need to sign in or repeat an action.', cancel: 'Cancel', open: 'Open locally',
    uploadInvalid: 'Selected files exceed the limits above. Adjust your selection and try again.', uploadTitle: 'Choose local files', uploadSingle: 'The remote page is waiting for one file.', uploadMultiple: 'The remote page is waiting for one or more files.', chooseFiles: 'Choose files', uploading: 'Sending', uploadFailed: 'File transfer failed', uploadRestart: 'This file selection request has ended. Close this dialog, then choose files again on the remote page to retry.', close: 'Close',
    downloadTitle: 'Save remote download?', downloadCopy: 'The remote page downloaded this file. Confirm to save it on your device.', saveDownload: 'Save to device', downloading: 'Receiving', downloadFailed: 'File transfer failed',
    copyRemote: 'Copy from remote', pasteRemote: 'Paste to remote', clipboardReading: 'Reading the remote clipboard…', clipboardWriting: 'Sending to the remote tab…', clipboardDone: 'Clipboard action completed',
    pasteFallbackTitle: 'Paste text manually', pasteFallbackCopy: 'This browser did not allow the Viewer to read your clipboard. Paste text below, then send it to the remote tab.', pastePlaceholder: 'Paste the text to send here', sendRemote: 'Send to remote',
    copyFallbackTitle: 'Copy content manually', copyFallbackCopy: 'This browser did not allow the Viewer to write to your clipboard. Copy the text below manually.', imageFallback: 'The remote clipboard also contains an image. This browser refused image clipboard access; allow clipboard permission and try again.', imagePasteFallback: 'This session only allows image clipboard data, but the browser refused image access. Allow clipboard permission and try again.', clipboardFailed: 'Clipboard action failed',
  },
} as const

export interface ViewerFocusPolicy {
  mode: 'NEVER' | 'WHEN_HIDDEN' | 'WHEN_UNFOCUSED'
  gracePeriodMs: number
}

interface TouchPoint {
  clientX: number
  clientY: number
}

type TouchGesture =
  | {
      mode: 'pending' | 'drag'
      primaryPointerId: number
      startClient: TouchPoint
      startRemote: { x: number; y: number }
      lastRemote: { x: number; y: number }
    }
  | {
      mode: 'scroll'
      lastCenter: TouchPoint
    }
  | {
      mode: 'scroll-ended'
    }

export class RemoteTabViewerElement extends HTMLElementBase {
  public static get observedAttributes(): string[] {
    return ['ticket', 'endpoint', 'locale', 'suspend-when-unfocused']
  }

  public iceRestartOptions: false | RemoteTabIceRestartOptions | undefined
  public reconnectOptions: false | RemoteTabReconnectOptions | undefined

  #immersive = false

  /** Hides Viewer chrome; Embedders can follow immersive-change to hide their own header. */
  public get immersive(): boolean { return this.#immersive }
  public set immersive(value: boolean) {
    if (typeof value !== 'boolean') throw new TypeError('immersive must be a boolean')
    if (value === this.#immersive) return
    this.#releasePressedInput()
    this.#immersive = value
    this.dataset.immersive = String(value)
    this.#required<HTMLElement>('.shell').dataset.immersive = String(value)
    this.#required<HTMLElement>('.toolbar').hidden = value
    this.#button('exit-immersive').hidden = !value
    this.#button('immersive').setAttribute('aria-pressed', String(value))
    this.#dispatch('immersive-change', { immersive: value })
    this.#scheduleViewport()
  }

  #focusPolicy: ViewerFocusPolicy | undefined
  #focusTimer: ReturnType<typeof setTimeout> | undefined
  #focusOperation: Promise<void> | undefined
  #focusSuspended = false

  public get focusPolicy(): ViewerFocusPolicy {
    return { ...(this.#focusPolicy ?? {
      mode: this.getAttribute('suspend-when-unfocused') === 'false' ? 'NEVER' : 'WHEN_UNFOCUSED',
      gracePeriodMs: 0,
    }) }
  }

  public set focusPolicy(value: ViewerFocusPolicy | undefined) {
    if (value !== undefined && (!['NEVER', 'WHEN_HIDDEN', 'WHEN_UNFOCUSED'].includes(value.mode) ||
      !Number.isSafeInteger(value.gracePeriodMs) || value.gracePeriodMs < 0 || value.gracePeriodMs > 300_000)) {
      throw new TypeError('focusPolicy requires a supported mode and an integer gracePeriodMs from 0 to 300000')
    }
    this.#focusPolicy = value === undefined ? undefined : { ...value }
    this.#clearFocusTimer()
    this.#handleFocusPolicy()
  }

  readonly #root: ShadowRoot
  #client: RemoteTabClient | undefined
  #unsubscribeClient: (() => void) | undefined
  #resizeObserver: ResizeObserver | undefined
  #resizeTimer: ReturnType<typeof setTimeout> | undefined
  #viewport: Viewport | undefined
  #state: RemoteTabState = 'ATTACHING'
  #windows: WindowState | undefined
  #compositionActive = false
  #navigationUrl: string | undefined
  #addressEditing = false
  #skipInputAfterComposition = false
  #lastPointer: { x: number; y: number } | undefined
  #pressedPointerButton: 'left' | 'middle' | 'right' | 'back' | 'forward' | undefined
  readonly #pressedKeys = new Map<string, { key: string; code: string; modifiers: number; isKeypad: boolean }>()
  #localOpen: { requestId: string; url: string } | undefined
  readonly #localOpenQueue: Array<{ requestId: string; url: string; expiresAt: number }> = []
  readonly #noticeRequests: Array<Extract<RemoteTabClientEvent, { type: 'notice-request' }>['request']> = []
  #activeNoticeId: string | undefined
  #noticeReturnFocus: HTMLElement | undefined
  readonly #noticeTimers = new Map<HTMLElement, ReturnType<typeof setTimeout>>()
  #uploadRequest: { requestId: string; multiple: boolean; constraints?: UploadConstraints } | undefined
  readonly #downloadOffers = new Map<string, Extract<RemoteTabClientEvent, { type: 'download-request' }>>()
  readonly #downloadQueue: string[] = []
  readonly #acceptedDownloads = new Set<string>()
  #downloadRequest: string | undefined
  #clipboardOperation: 'read' | 'write' | undefined
  #clipboardFallback:
    | { mode: 'paste' }
    | { mode: 'copy'; items: readonly RemoteTabClipboardItem[] }
    | undefined
  #connectedOnce = false
  #playbackBlocked = false
  #quality: MediaQualityPreset = 'balanced'
  #appliedQuality: MediaQualitySettings | undefined
  #qualityState: QualityState | undefined
  #qualityPending = false
  #listenersInstalled = false
  readonly #touchPoints = new Map<number, TouchPoint>()
  #touchGesture: TouchGesture | undefined
  #mobileGuidanceDismissed = false
  readonly #coarsePointerQuery = typeof globalThis.matchMedia === 'function'
    ? globalThis.matchMedia('(pointer: coarse)')
    : undefined

  public constructor() {
    super()
    this.#root = this.attachShadow({ mode: 'open' })
    this.#render()
  }

  public connectedCallback(): void {
    this.#installDomListeners()
    this.#resizeObserver = new ResizeObserver(() => this.#scheduleViewport())
    this.#resizeObserver.observe(this.#surface)
    document.addEventListener('visibilitychange', this.#handleFocusPolicy)
    window.addEventListener('focus', this.#handleFocusPolicy)
    window.addEventListener('blur', this.#handleFocusPolicy)
    this.#coarsePointerQuery?.addEventListener('change', this.#handleInputModeChange)
    this.#syncInputMode()
    this.#dispatch('viewer-ready', { state: 'READY' })
    void this.connect()
  }

  public disconnectedCallback(): void {
    document.removeEventListener('visibilitychange', this.#handleFocusPolicy)
    window.removeEventListener('focus', this.#handleFocusPolicy)
    window.removeEventListener('blur', this.#handleFocusPolicy)
    this.#coarsePointerQuery?.removeEventListener('change', this.#handleInputModeChange)
    this.#resizeObserver?.disconnect()
    this.#resizeObserver = undefined
    clearTimeout(this.#resizeTimer)
    void this.disconnect()
  }

  public attributeChangedCallback(name: string, oldValue: string | null, nextValue: string | null): void {
    if (oldValue === nextValue) return
    if (name === 'locale') this.#applyTranslations()
    if (name === 'suspend-when-unfocused' && this.#focusPolicy === undefined) {
      this.#clearFocusTimer()
      this.#handleFocusPolicy()
    }
    if ((name === 'ticket' || name === 'endpoint') && this.isConnected) {
      if (this.#client === undefined) {
        if (this.hasAttribute('ticket') && this.hasAttribute('endpoint')) void this.connect()
      } else {
        void this.disconnect().then(() => this.connect())
      }
    }
  }

  public async connect(): Promise<void> {
    if (this.#client !== undefined) return
    const ticket = this.getAttribute('ticket')
    const endpoint = this.getAttribute('endpoint')
    if (!ticket || !endpoint) {
      this.#setStatus('ATTACHING')
      return
    }
    const client = createRemoteTabClient({
      ticket,
      endpoint,
      ...(this.iceRestartOptions === undefined ? {} : { iceRestart: this.iceRestartOptions }),
      ...(this.reconnectOptions === undefined ? {} : { reconnect: this.reconnectOptions }),
    })
    this.#client = client
    this.#unsubscribeClient = client.addEventListener((event) => this.#handleClientEvent(event))
    client.attachVideo(this.#video)
    try {
      await client.connect()
      if (this.#client === client) {
        this.#connectedOnce = true
        this.#scheduleViewport()
        this.#handleFocusPolicy()
      }
    } catch {
      // The typed error event is the public failure surface.
    }
  }

  public async disconnect(): Promise<void> {
    const client = this.#client
    this.#client = undefined
    this.#unsubscribeClient?.()
    this.#unsubscribeClient = undefined
    this.#connectedOnce = false
    this.#clearFocusTimer()
    this.#focusSuspended = false
    this.#focusOperation = undefined
    this.#clearTransientUi()
    this.#windows = undefined
    this.#syncWindows()
    if (client !== undefined) await client.disconnect()
  }

  public async suspend(): Promise<void> {
    this.#clearFocusTimer()
    this.#focusSuspended = false
    if (this.#state === 'SUSPENDED') return
    if (this.#state !== 'CONNECTED' || this.#client === undefined) {
      throw new Error('Remote Tab Viewer is not connected')
    }
    this.#releasePressedInput()
    await this.#client.suspend()
  }

  public async resume(): Promise<void> {
    this.#focusSuspended = false
    if (this.#state === 'CONNECTED') return
    if (this.#state !== 'SUSPENDED' || this.#client === undefined) {
      throw new Error('Remote Tab Viewer is not suspended')
    }
    await this.#client.resume()
  }

  public get qualityState(): QualityState | undefined {
    const state = this.#qualityState
    return state === undefined ? undefined : { configuration: { ...state.configuration }, applied: { ...state.applied } }
  }

  public configureQuality(configuration: QualityConfiguration): Promise<QualityState> {
    return this.#client?.configureQuality(configuration) ?? Promise.reject(new Error('Remote Tab Viewer is not connected'))
  }

  public get windowState(): WindowState | undefined { return this.#client?.windowState }

  public selectWindow(targetId: string): Promise<void> {
    if (this.#client === undefined) return Promise.reject(new Error('Remote Tab Viewer is not connected'))
    this.#releasePressedInput()
    return this.#client.selectWindow(targetId)
  }

  public closeWindow(): Promise<void> {
    if (this.#client === undefined) return Promise.reject(new Error('Remote Tab Viewer is not connected'))
    this.#releasePressedInput()
    return this.#client.closeWindow()
  }

  public async respondToNotice(requestId: string, buttonId: string | null): Promise<void> {
    await this.#client?.respondToNotice(requestId, buttonId)
  }

  public async respondToLocalOpen(requestId: string, approved: boolean): Promise<void> {
    if (this.#localOpen?.requestId === requestId) {
      await this.#resolveLocalOpen(approved)
      return
    }
    const index = this.#localOpenQueue.findIndex((request) => request.requestId === requestId)
    if (index >= 0) this.#localOpenQueue.splice(index, 1)
    await this.#client?.respondToLocalOpen(requestId, approved)
  }

  public acceptDownload(transferId: string): Promise<RemoteTabDownloadedFile> {
    const offer = this.#downloadOffers.get(transferId)
    if (offer === undefined) {
      return Promise.reject(new Error('Remote download request is not active'))
    }
    this.#acceptedDownloads.add(transferId)
    if (this.#downloadRequest === transferId) {
      this.#required<HTMLElement>('[data-download-summary]').hidden = true
      this.#required<HTMLElement>('[data-download-progress]').hidden = false
      this.#button('download-save').hidden = true
      this.#button('download-cancel').textContent = this.#strings.cancel
      this.#updateDownloadProgress(0, offer.file.size)
    }
    return this.#client?.acceptDownload(transferId) ?? Promise.reject(new Error('Remote Tab Viewer is not connected'))
  }

  public async cancelDownload(transferId: string): Promise<void> {
    if (!this.#downloadOffers.has(transferId)) {
      throw new Error('Remote download request is not active')
    }
    await this.#client?.cancelDownload(transferId)
    this.#removeDownload(transferId)
  }

  public writeRemoteClipboard(items: readonly RemoteTabClipboardWriteItem[]): Promise<void> {
    return this.#client?.writeRemoteClipboard(items) ??
      Promise.reject(new Error('Remote Tab Viewer is not connected'))
  }

  public readRemoteClipboard(): Promise<readonly RemoteTabClipboardItem[]> {
    return this.#client?.readRemoteClipboard() ??
      Promise.reject(new Error('Remote Tab Viewer is not connected'))
  }

  get #video(): HTMLVideoElement { return this.#required('video') }
  get #surface(): HTMLElement { return this.#required('[data-surface]') }
  get #imeProxy(): HTMLTextAreaElement { return this.#required('[data-ime]') }
  get #address(): HTMLInputElement { return this.#required('[data-address]') }
  #syncQualityDescription(): void {
    const settings = this.#qualityState?.applied ?? this.#appliedQuality
    const description = settings === undefined ? this.#strings.qualityUnknown : `${this.#strings.qualityApplied}: ≤ ${settings.maxFrameRate} FPS · ≤ ${settings.maxBitrate / 1000} kbps · ÷ ${settings.scaleResolutionDownBy}`
    this.#required<HTMLElement>('[data-quality-applied]').textContent = description
    this.#qualitySelect.title = description
    this.#qualitySelect.setAttribute('aria-description', description)
  }

  get #qualitySelect(): HTMLSelectElement { return this.#required('[data-quality]') }
  get #fileInput(): HTMLInputElement { return this.#required('[data-upload-input]') }
  get #clipboardText(): HTMLTextAreaElement { return this.#required('[data-clipboard-text]') }

  #render(): void {
    this.#root.innerHTML = `
      <style>${VIEWER_STYLES}</style>
      <div class="shell" part="shell">
        <header class="toolbar" part="toolbar">
          <div class="group">
            <button class="button" data-action="back" part="button back-button">${viewerIcon('back')}<span class="sr-only"></span></button>
            <button class="button" data-action="forward" part="button forward-button">${viewerIcon('forward')}<span class="sr-only"></span></button>
            <button class="button" data-action="reload" part="button reload-button">${viewerIcon('reload')}<span class="sr-only"></span></button>
            <button class="button immersive-button" type="button" data-action="immersive" aria-pressed="false" part="button immersive-button">${viewerIcon('immersive')}<span data-immersive-label></span></button>
          </div>
          <form class="address-form" data-address-form part="address-form">
            <input class="address" data-address type="url" autocomplete="off" spellcheck="false" part="address" />
          </form>
          <div class="group media-controls">
            <button class="button" data-action="clipboard-copy" part="button clipboard-copy-button">${viewerIcon('copy')}<span class="sr-only"></span></button>
            <button class="button" data-action="clipboard-paste" part="button clipboard-paste-button">${viewerIcon('paste')}<span class="sr-only"></span></button>
            <button class="button keyboard-button" data-action="keyboard" part="button keyboard-button">${viewerIcon('keyboard')}<span class="sr-only"></span></button>
            <label class="quality-control" data-quality-control>
              <span class="sr-only" data-quality-label></span>
              <select class="quality-select" data-quality part="quality-select">
                <option value="data-saver"></option>
                <option value="balanced" selected></option>
                <option value="high"></option>
              </select>
            </label>
            <button class="button" type="button" data-action="quality-custom" hidden>${viewerIcon('quality')}<span class="sr-only"></span></button>
            <button class="button" data-action="fullscreen" part="button fullscreen-button">${viewerIcon('fullscreen')}<span class="sr-only"></span></button>
            <button class="button danger" data-action="end" part="button end-button"><span data-end-label></span></button>
          </div>
          <div class="window-bar" data-window-bar hidden part="window-bar">
            <label class="window-label"><span data-window-label></span><select class="window-select" data-window-select part="window-select"></select></label>
            <span data-window-status role="status" aria-live="polite"></span>
            <button type="button" class="button" data-action="window-close">${viewerIcon('close')}<span class="sr-only"></span></button>
          </div>
        </header>
        <main class="stage" part="stage">
          <button class="button immersive-exit" type="button" data-action="exit-immersive" part="button immersive-exit" hidden>${viewerIcon('restore')}<span data-exit-immersive-label></span></button>
          <div class="surface" data-surface tabindex="0" role="application" part="surface">
            <video autoplay playsinline part="video"></video>
            <textarea class="ime-proxy" data-ime aria-label="Remote text input"></textarea>
          </div>
          <div class="overlay" data-overlay part="overlay"><div class="overlay-card"><h2 class="overlay-title" data-overlay-title></h2><p class="overlay-copy" data-overlay-copy></p><button class="button primary" type="button" data-action="playback" hidden></button><button class="button primary" type="button" data-action="resume" hidden></button></div></div>
          <div class="status" data-status data-state="ATTACHING" role="status" aria-live="polite" part="status"><span class="status-dot"></span><span data-status-copy></span></div>
          <div class="mobile-guidance" data-mobile-guidance hidden role="note" part="mobile-guidance"><span data-mobile-guidance-copy></span><button class="notice-close" type="button" data-action="mobile-guidance-close"></button></div>
          <dialog class="notice-dialog quality-dialog" data-quality-dialog aria-labelledby="quality-title" aria-describedby="quality-copy" part="quality-dialog">
            <form data-quality-form novalidate>
              <h2 id="quality-title" data-quality-title></h2><p id="quality-copy" data-quality-copy></p>
              <p class="quality-applied" data-quality-applied role="status"></p>
              <div class="quality-fields">
                <label><span data-quality-bitrate-label></span><input type="number" inputmode="decimal" data-quality-bitrate required min="100" max="20000" step="0.001" aria-describedby="quality-error" /></label>
                <label><span data-quality-fps-label></span><input type="number" inputmode="numeric" data-quality-fps required min="1" max="60" step="1" aria-describedby="quality-error" /></label>
                <label><span data-quality-scale-label></span><input type="number" inputmode="decimal" data-quality-scale required min="1" max="4" step="any" aria-describedby="quality-error" /></label>
              </div>
              <p id="quality-error" class="dialog-error" data-quality-error role="alert" hidden></p>
              <div class="dialog-actions"><button class="button" type="button" data-action="quality-cancel"></button><button class="button primary" type="submit" data-action="quality-apply"></button></div>
            </form>
          </dialog>
          <dialog class="notice-dialog" data-notice-dialog aria-labelledby="notice-title" aria-describedby="notice-body" part="notice-dialog">
            <h2 id="notice-title"></h2><p id="notice-body"></p>
            <div class="dialog-actions" data-notice-actions></div>
          </dialog>
          <div class="notices" data-notices role="status" aria-live="polite" part="notices"></div>
          <dialog class="notice-dialog" data-local-dialog role="alertdialog" aria-labelledby="local-title" aria-describedby="local-copy" part="dialog-backdrop dialog">
            <h2 id="local-title" data-local-title></h2><p id="local-copy"><span data-local-copy></span><br><strong data-local-url></strong></p>
            <div class="dialog-actions"><button class="button" data-action="local-cancel"></button><button class="button primary" data-action="local-open"></button></div>
          </dialog>
          <div class="dialog-backdrop" data-upload-dialog hidden part="dialog-backdrop upload-dialog-backdrop">
            <div class="dialog upload-dialog" role="dialog" aria-modal="true" aria-labelledby="upload-title" aria-describedby="upload-copy" part="dialog upload-dialog">
              <h2 id="upload-title" data-upload-title></h2>
              <p id="upload-copy" data-upload-copy></p>
              <div class="file-picker" data-upload-picker>
                <div class="file-icon" aria-hidden="true">⇧</div>
                <button class="button primary" type="button" data-action="upload-choose"></button>
                <input data-upload-input type="file" hidden />
              </div>
              <div class="upload-progress" data-upload-progress hidden role="status" aria-live="polite">
                <div class="upload-progress-row"><span data-upload-progress-label></span><span data-upload-progress-value></span></div>
                <progress data-upload-progress-bar max="1" value="0"></progress>
              </div>
              <p class="dialog-error" data-upload-error hidden></p>
              <div class="dialog-actions"><button class="button" type="button" data-action="upload-cancel"></button></div>
            </div>
          </div>
          <div class="dialog-backdrop" data-download-dialog hidden part="dialog-backdrop download-dialog-backdrop">
            <div class="dialog download-dialog" role="dialog" aria-modal="true" aria-labelledby="download-title" aria-describedby="download-copy" part="dialog download-dialog">
              <h2 id="download-title" data-download-title></h2>
              <p id="download-copy" data-download-copy></p>
              <div class="download-summary" data-download-summary>
                <div class="file-icon download-icon" aria-hidden="true">↓</div>
                <div class="download-file"><strong data-download-name></strong><span data-download-size></span></div>
              </div>
              <div class="upload-progress" data-download-progress hidden role="status" aria-live="polite">
                <div class="upload-progress-row"><span data-download-progress-label></span><span data-download-progress-value></span></div>
                <progress data-download-progress-bar max="1" value="0"></progress>
              </div>
              <p class="dialog-error" data-download-error hidden></p>
              <div class="dialog-actions"><button class="button" type="button" data-action="download-cancel"></button><button class="button primary" type="button" data-action="download-save"></button></div>
            </div>
          </div>
          <div class="dialog-backdrop" data-clipboard-dialog hidden part="dialog-backdrop clipboard-dialog-backdrop">
            <div class="dialog clipboard-dialog" role="dialog" aria-modal="true" aria-labelledby="clipboard-title" aria-describedby="clipboard-copy" part="dialog clipboard-dialog">
              <h2 id="clipboard-title" data-clipboard-title></h2>
              <p id="clipboard-copy" data-clipboard-copy></p>
              <textarea class="clipboard-text" data-clipboard-text spellcheck="false"></textarea>
              <p class="clipboard-image-note" data-clipboard-image-note hidden></p>
              <p class="dialog-error" data-clipboard-error hidden></p>
              <div class="dialog-actions"><button class="button" type="button" data-action="clipboard-close"></button><button class="button primary" type="button" data-action="clipboard-send"></button></div>
            </div>
          </div>
        </main>
      </div>`
    this.#applyTranslations()
    this.#setStatus('ATTACHING')
  }

  #installDomListeners(): void {
    if (this.#listenersInstalled) return
    this.#listenersInstalled = true
    this.#root.addEventListener('click', (event) => this.#handleClick(event))
    this.#required<HTMLSelectElement>('[data-window-select]').addEventListener('change', event => {
      const targetId = (event.target as HTMLSelectElement).value
      void this.#invoke(async () => { await this.selectWindow(targetId); this.#syncWindows() })
    })
    this.#video.addEventListener('playing', () => {
      if (!this.#playbackBlocked) return
      this.#playbackBlocked = false
      this.#setStatus(this.#state)
    })
    this.#address.addEventListener('input', () => { this.#addressEditing = true })
    this.#address.addEventListener('blur', () => {
      this.#addressEditing = false
      if (this.#navigationUrl !== undefined) this.#address.value = this.#navigationUrl
    })
    this.#root.querySelector('[data-address-form]')?.addEventListener('submit', (event) => {
      event.preventDefault()
      const value = this.#address.value.trim()
      this.#addressEditing = false
      if (value) void this.#invoke(() => this.#client?.navigate({ action: 'go', url: normalizeUrl(value) }))
    })
    this.#qualitySelect.addEventListener('change', () => {
      const value = this.#qualitySelect.value
      this.#syncQualitySelection()
      if (value === 'custom') this.#openQualityDialog()
      else if (this.#client?.capabilities.includes('advancedQuality')) {
        void this.#applyQuality(value === 'auto' ? { mode: 'auto' } : { mode: 'preset', preset: value as MediaQualityPreset })
      } else void this.#applyLegacyQuality(value as MediaQualityPreset)
    })
    this.#required<HTMLFormElement>('[data-quality-form]').addEventListener('submit', event => {
      event.preventDefault()
      void this.#submitCustomQuality()
    })
    this.#required<HTMLDialogElement>('[data-quality-dialog]').addEventListener('cancel', event => {
      event.preventDefault()
      if (!this.#qualityPending) this.#closeQualityDialog()
    })
    this.#fileInput.addEventListener('change', () => {
      const files = [...(this.#fileInput.files ?? [])]
      this.#fileInput.value = ''
      if (files.length > 0) void this.#uploadFiles(files)
    })
    this.#surface.addEventListener('pointerdown', (event) => this.#handlePointer(event, 'mousePressed'))
    this.#surface.addEventListener('pointermove', (event) => this.#handlePointer(event, 'mouseMoved'))
    this.#surface.addEventListener('pointerup', (event) => this.#handlePointer(event, 'mouseReleased'))
    this.#surface.addEventListener('pointercancel', (event) => this.#handlePointer(event, 'mouseReleased'))
    this.#surface.addEventListener('wheel', (event) => this.#sendWheel(event), { passive: false })
    this.#surface.addEventListener('contextmenu', (event) => event.preventDefault())
    this.#required<HTMLDialogElement>('[data-local-dialog]').addEventListener('cancel', (event) => {
      event.preventDefault()
      void this.#resolveLocalOpen(false)
    })
    this.#required<HTMLDialogElement>('[data-notice-dialog]').addEventListener('cancel', (event) => {
      event.preventDefault()
      if (this.#activeNoticeId !== undefined) void this.#answerNotice(this.#activeNoticeId, null)
    })
    this.#imeProxy.addEventListener('keydown', (event) => this.#sendKey(event, 'keyDown'))
    this.#imeProxy.addEventListener('keyup', (event) => this.#sendKey(event, 'keyUp'))
    this.#imeProxy.addEventListener('compositionstart', () => {
      this.#compositionActive = true
      this.#client?.sendComposition({ event: 'start' })
    })
    this.#imeProxy.addEventListener('compositionupdate', (event) => this.#client?.sendComposition({ event: 'update', text: event.data }))
    this.#imeProxy.addEventListener('compositionend', (event) => {
      this.#compositionActive = false
      this.#skipInputAfterComposition = true
      this.#client?.sendComposition({ event: 'commit', text: event.data })
      this.#imeProxy.value = ''
      queueMicrotask(() => {
        this.#skipInputAfterComposition = false
      })
    })
    this.#imeProxy.addEventListener('input', () => {
      if (this.#compositionActive || this.#windowInputBlocked) return
      const text = this.#imeProxy.value
      this.#imeProxy.value = ''
      if (!this.#skipInputAfterComposition && text !== '') {
        this.#client?.sendComposition({ event: 'commit', text })
      }
    })
  }

  #handleClientEvent(event: RemoteTabClientEvent): void {
    if (event.type === 'window-change') {
      const changed = this.#windows?.revision !== event.state.revision || this.#windows?.selectedTargetId !== event.state.selectedTargetId ||
        (!this.#windows?.selecting && event.state.selecting)
      this.#windows = event.state
      if (changed) {
      // Core releases held input before switching. Local release messages would refer to a retired revision.
      this.#pressedKeys.clear()
      this.#pressedPointerButton = undefined
      this.#touchPoints.clear()
      this.#touchGesture = undefined
      this.#compositionActive = false
      this.#imeProxy.value = ''
      }
      this.#syncWindows()
      this.#syncCapabilities()
      this.#dispatch('window-change', event)
    } else if (event.type === 'playback-blocked') {
      this.#playbackBlocked = true
      this.#releasePressedInput()
      this.#setStatus(this.#state)
      this.#dispatch('playback-blocked', event)
    } else if (event.type === 'connection-state-change') {
      this.#setStatus(event.state)
      this.#dispatch('connection-state-change', event)
      this.#handleFocusPolicy()
    } else if (event.type === 'viewport-change') {
      this.#viewport = event.viewport
      this.#layoutVideo()
    } else if (event.type === 'navigation-result') {
      if (event.result.currentUrl) {
        this.#navigationUrl = event.result.currentUrl
        if (!this.#addressEditing) this.#address.value = event.result.currentUrl
      }
    } else if (event.type === 'navigation-location-change') {
      this.#navigationUrl = event.url
      if (!this.#addressEditing) this.#address.value = event.url
      this.#dispatch('navigation-location-change', event)
    } else if (event.type === 'quality-configuration-change') {
      this.#qualityState = { configuration: { ...event.state.configuration }, applied: { ...event.state.applied } }
      this.#syncQualitySelection()
      this.#syncQualityDescription()
      this.#dispatch('quality-configuration-change', event)
    } else if (event.type === 'quality-change') {
      this.#quality = event.quality.preset
      this.#appliedQuality = event.quality
      this.#syncQualitySelection()
      this.#syncQualityDescription()
      this.#dispatch('quality-change', event)
    } else if (event.type === 'local-open-request') {
      if (this.#dispatch('local-open-request', event, true)) this.#enqueueLocalOpen(event)
    } else if (event.type === 'local-open-cancelled') {
      this.#removeLocalOpen(event.requestId)
    } else if (event.type === 'upload-request') {
      if (this.#dispatch('upload-request', event, true)) this.#showUpload(event.requestId, event.multiple, event.constraints)
    } else if (event.type === 'upload-progress') {
      this.#updateUploadProgress(event.sentBytes, event.totalBytes)
      this.#dispatch('upload-progress', event)
    } else if (event.type === 'upload-cancelled') {
      if (this.#uploadRequest?.requestId === event.requestId) this.#hideUpload()
      this.#dispatch('upload-cancelled', event)
    } else if (event.type === 'download-request') {
      this.#downloadOffers.set(event.transferId, event)
      if (this.#dispatch('download-request', event, true)) {
        this.#downloadQueue.push(event.transferId)
        this.#showNextDownload()
      }
    } else if (event.type === 'download-progress') {
      if (this.#downloadRequest === event.transferId) {
        this.#updateDownloadProgress(event.receivedBytes, event.totalBytes)
      }
      this.#dispatch('download-progress', event)
    } else if (event.type === 'download-cancelled') {
      this.#removeDownload(event.transferId)
      this.#dispatch('download-cancelled', event)
    } else if (event.type === 'download-complete') {
      this.#removeDownload(event.download.transferId)
      if (this.#dispatch('download-complete', event, true)) this.#saveDownload(event.download)
    } else if (event.type === 'clipboard-progress') {
      this.#dispatch('clipboard-progress', event)
    } else if (event.type === 'page-script-event') {
      this.#dispatch('page-script-event', event)
    } else if (event.type === 'notice-request') {
      if (this.#dispatch('notice-request', event, true)) {
        this.#noticeRequests.push(event.request)
        this.#showNextNotice()
      }
    } else if (event.type === 'notice-closed') {
      this.#removeNoticeRequest(event.requestId)
      this.#dispatch('notice-closed', event)
    } else if (event.type === 'notice') {
      if (this.#dispatch('notice', event, true)) this.#showNotice(event.notice)
    } else if (event.type === 'diagnostic') {
      this.#dispatch('diagnostic', event)
    } else if (event.type === 'error') {
      this.#syncQualitySelection()
      this.#dispatch('error', event, false, false)
    }
    this.#syncCapabilities()
  }

  #handleClick(event: Event): void {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-action]')
    const action = button?.dataset.action
    if (!action) return
    if (action === 'immersive' || action === 'exit-immersive') {
      this.immersive = action === 'immersive'
      ;(this.immersive ? this.#button('exit-immersive') : this.#button('immersive')).focus({ preventScroll: true })
    } else if (action === 'quality-custom') {
      this.#openQualityDialog()
    } else if (action === 'quality-cancel') {
      if (!this.#qualityPending) this.#closeQualityDialog()
    } else if (action === 'window-close') {
      void this.#invoke(() => this.closeWindow())
    } else if (action === 'resume') {
      void this.#invoke(() => this.resume())
    } else if (action === 'playback') {
      // Call play directly inside the trusted click; awaiting other work loses user activation.
      void this.#invoke(() => this.#video.play())
    } else if (action === 'back' || action === 'forward' || action === 'reload') {
      void this.#invoke(() => this.#client?.navigate({ action }))
    } else if (action === 'fullscreen') {
      void this.#surface.requestFullscreen()
    } else if (action === 'keyboard') {
      this.#imeProxy.focus({ preventScroll: true })
    } else if (action === 'end') {
      this.#dispatch('session-close-request', { reason: 'viewer-requested' })
    } else if (action === 'local-cancel') {
      void this.#resolveLocalOpen(false)
    } else if (action === 'local-open') {
      void this.#resolveLocalOpen(true)
    } else if (action === 'upload-choose') {
      this.#fileInput.click()
    } else if (action === 'upload-cancel') {
      void this.#cancelUpload()
    } else if (action === 'download-save') {
      const transferId = this.#downloadRequest
      if (transferId !== undefined) void this.#startDownload(transferId)
    } else if (action === 'download-cancel') {
      const transferId = this.#downloadRequest
      if (transferId !== undefined) void this.#invoke(() => this.cancelDownload(transferId))
    } else if (action === 'clipboard-copy') {
      void this.#copyFromRemote()
    } else if (action === 'clipboard-paste') {
      void this.#pasteToRemote()
    } else if (action === 'clipboard-close') {
      this.#hideClipboardFallback()
    } else if (action === 'clipboard-send') {
      void this.#sendManualClipboardText()
    } else if (action === 'notice-close') {
      const notice = button?.closest<HTMLElement>('[data-notice]')
      if (notice !== null && notice !== undefined) this.#removeNotice(notice)
    } else if (action === 'mobile-guidance-close') {
      this.#mobileGuidanceDismissed = true
      this.#syncInputMode()
    }
  }

  #handlePointer(
    event: PointerEvent,
    type: 'mousePressed' | 'mouseMoved' | 'mouseReleased',
  ): void {
    if (event.pointerType === 'touch') {
      this.#sendTouchPointer(event, type)
      return
    }
    this.#sendPointer(event, type)
  }

  #sendPointer(event: PointerEvent, type: 'mousePressed' | 'mouseMoved' | 'mouseReleased'): void {
    if (!this.#viewport || this.#state !== 'CONNECTED' || this.#playbackBlocked || this.#windowInputBlocked) return
    const rect = this.#video.getBoundingClientRect()
    const point = mapPointerToViewport({ clientX: event.clientX, clientY: event.clientY, left: rect.left, top: rect.top, width: rect.width, height: rect.height, viewport: this.#viewport })
    if (!point) return
    event.preventDefault()
    if (type === 'mousePressed') {
      this.#surface.setPointerCapture(event.pointerId)
      this.#imeProxy.focus({ preventScroll: true })
      const button = pointerButton(event.button)
      this.#pressedPointerButton = button === 'none' ? undefined : button
    }
    this.#lastPointer = point
    this.#client?.sendPointer({
      event: type,
      ...point,
      viewportRevision: this.#viewport.revision,
      button: pointerButton(event.button),
      buttons: type === 'mouseReleased' ? 0 : event.buttons,
      modifiers: modifiers(event),
      clickCount: type === 'mousePressed' ? Math.min(event.detail || 1, 3) : 0,
      pointerType: event.pointerType === 'pen' ? 'pen' : 'mouse',
    })
    if (type === 'mouseReleased') this.#pressedPointerButton = undefined
  }

  #sendTouchPointer(
    event: PointerEvent,
    type: 'mousePressed' | 'mouseMoved' | 'mouseReleased',
  ): void {
    if (!this.#viewport || this.#state !== 'CONNECTED' || this.#playbackBlocked || this.#windowInputBlocked) return
    const remotePoint = this.#mapPointer(event.clientX, event.clientY)
    if (type === 'mousePressed') {
      if (remotePoint === undefined) return
      event.preventDefault()
      this.#surface.setPointerCapture(event.pointerId)
      this.#touchPoints.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY })
      if (this.#touchGesture === undefined) {
        this.#touchGesture = {
          mode: 'pending',
          primaryPointerId: event.pointerId,
          startClient: { clientX: event.clientX, clientY: event.clientY },
          startRemote: remotePoint,
          lastRemote: remotePoint,
        }
      } else if (this.#touchGesture.mode === 'pending' || this.#touchGesture.mode === 'drag') {
        if (this.#touchGesture.mode === 'drag') this.#sendTouchMouse('mouseReleased', this.#touchGesture.lastRemote)
        this.#pressedPointerButton = undefined
        this.#touchGesture = { mode: 'scroll', lastCenter: this.#touchCenter() }
      }
      return
    }

    if (!this.#touchPoints.has(event.pointerId)) return
    event.preventDefault()
    if (type === 'mouseMoved') {
      this.#touchPoints.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY })
      const gesture = this.#touchGesture
      if (
        gesture !== undefined &&
        (gesture.mode === 'pending' || gesture.mode === 'drag') &&
        gesture.primaryPointerId === event.pointerId &&
        remotePoint !== undefined
      ) {
        if (
          gesture.mode === 'pending' &&
          Math.hypot(
            event.clientX - gesture.startClient.clientX,
            event.clientY - gesture.startClient.clientY,
          ) >= 8
        ) {
          this.#sendTouchMouse('mousePressed', gesture.startRemote)
          gesture.mode = 'drag'
          this.#pressedPointerButton = 'left'
        }
        if (gesture.mode === 'drag') {
          gesture.lastRemote = remotePoint
          this.#sendTouchMouse('mouseMoved', remotePoint)
        }
      } else if (gesture?.mode === 'scroll' && this.#touchPoints.size >= 2) {
        const center = this.#touchCenter()
        const point = this.#mapPointer(center.clientX, center.clientY)
        const deltaX = (gesture.lastCenter.clientX - center.clientX) * 1.5
        const deltaY = (gesture.lastCenter.clientY - center.clientY) * 1.5
        gesture.lastCenter = center
        if (point !== undefined && (Math.abs(deltaX) >= 0.5 || Math.abs(deltaY) >= 0.5)) {
          this.#client?.sendPointer({
            event: 'mouseWheel',
            ...point,
            viewportRevision: this.#viewport.revision,
            button: 'none',
            buttons: 0,
            modifiers: 0,
            clickCount: 0,
            deltaX,
            deltaY,
          })
        }
      }
      return
    }

    const gesture = this.#touchGesture
    this.#touchPoints.delete(event.pointerId)
    if (
      gesture !== undefined &&
      (gesture.mode === 'pending' || gesture.mode === 'drag') &&
      gesture.primaryPointerId === event.pointerId
    ) {
      if (gesture.mode === 'pending' && event.type !== 'pointercancel' && remotePoint !== undefined) {
        this.#sendTouchMouse('mousePressed', remotePoint)
        this.#sendTouchMouse('mouseReleased', remotePoint)
      } else if (gesture.mode === 'drag') {
        this.#sendTouchMouse('mouseReleased', remotePoint ?? gesture.lastRemote)
      }
      this.#pressedPointerButton = undefined
      this.#touchGesture = this.#touchPoints.size === 0 ? undefined : { mode: 'scroll-ended' }
    } else if (gesture?.mode === 'scroll') {
      this.#touchGesture = this.#touchPoints.size >= 2
        ? { mode: 'scroll', lastCenter: this.#touchCenter() }
        : this.#touchPoints.size === 0
          ? undefined
          : { mode: 'scroll-ended' }
    } else if (gesture?.mode === 'scroll-ended' && this.#touchPoints.size === 0) {
      this.#touchGesture = undefined
    }
  }

  #sendTouchMouse(
    event: 'mousePressed' | 'mouseMoved' | 'mouseReleased',
    point: { x: number; y: number },
  ): void {
    if (!this.#viewport) return
    this.#lastPointer = point
    this.#client?.sendPointer({
      event,
      ...point,
      viewportRevision: this.#viewport.revision,
      button: 'left',
      buttons: event === 'mouseReleased' ? 0 : 1,
      modifiers: 0,
      clickCount: event === 'mousePressed' ? 1 : 0,
      pointerType: 'mouse',
    })
  }

  #mapPointer(clientX: number, clientY: number): { x: number; y: number } | undefined {
    if (!this.#viewport) return undefined
    const rect = this.#video.getBoundingClientRect()
    return mapPointerToViewport({
      clientX,
      clientY,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      viewport: this.#viewport,
    })
  }

  #touchCenter(): TouchPoint {
    const points = [...this.#touchPoints.values()].slice(0, 2)
    const divisor = Math.max(1, points.length)
    return {
      clientX: points.reduce((sum, point) => sum + point.clientX, 0) / divisor,
      clientY: points.reduce((sum, point) => sum + point.clientY, 0) / divisor,
    }
  }

  #sendWheel(event: WheelEvent): void {
    if (!this.#viewport || this.#state !== 'CONNECTED' || this.#playbackBlocked || this.#windowInputBlocked) return
    const rect = this.#video.getBoundingClientRect()
    const point = mapPointerToViewport({ clientX: event.clientX, clientY: event.clientY, left: rect.left, top: rect.top, width: rect.width, height: rect.height, viewport: this.#viewport })
    if (!point) return
    event.preventDefault()
    const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? rect.height : 1
    this.#client?.sendPointer({ event: 'mouseWheel', ...point, viewportRevision: this.#viewport.revision, button: 'none', buttons: event.buttons, modifiers: modifiers(event), clickCount: 0, deltaX: event.deltaX * scale, deltaY: event.deltaY * scale })
  }

  #sendKey(event: KeyboardEvent, type: 'keyDown' | 'keyUp'): void {
    if (this.#state !== 'CONNECTED' || this.#playbackBlocked || this.#windowInputBlocked || this.#compositionActive || event.key === 'Process') return
    event.preventDefault()
    const text = type === 'keyDown' && event.key.length === 1 && !event.ctrlKey && !event.metaKey
      ? event.key
      : undefined
    const input = {
      key: event.key,
      code: event.code,
      modifiers: modifiers(event),
      isKeypad: event.location === KeyboardEvent.DOM_KEY_LOCATION_NUMPAD,
      ...(text === undefined ? {} : { text, unmodifiedText: text }),
    }
    this.#client?.sendKey({ event: type, ...input, autoRepeat: event.repeat })
    if (type === 'keyDown') this.#pressedKeys.set(event.code, input)
    else this.#pressedKeys.delete(event.code)
  }

  #layoutVideo(): void {
    const { width, height } = this.#surface.getBoundingClientRect()
    if (width <= 0 || height <= 0) return
    const ratio = this.#viewport === undefined ? width / height : this.#viewport.width / this.#viewport.height
    const contentWidth = Math.min(width, height * ratio)
    this.#video.style.width = `${contentWidth}px`
    this.#video.style.height = `${contentWidth / ratio}px`
    // Chrome can letterbox a changed viewport into the capture track's original dimensions.
    // Fit the ACK viewport to the stage, then crop that encoder padding inside the video element.
    // Input and visible content consequently use the same viewport rectangle, never decoded pixels.
    this.#video.style.objectFit = this.#viewport === undefined ? 'contain' : 'cover'
  }

  #scheduleViewport(): void {
    this.#layoutVideo()
    clearTimeout(this.#resizeTimer)
    this.#resizeTimer = setTimeout(() => {
      if (this.#state !== 'CONNECTED') return
      const rect = this.#surface.getBoundingClientRect()
      const width = Math.max(1, Math.min(1920, Math.round(rect.width)))
      const height = Math.max(1, Math.min(1080, Math.round(rect.height)))
      void this.#invoke(() => this.#client?.requestViewport({ width, height, deviceScaleFactor: 1, frameRate: 60 }))
    }, 150)
  }

  #clearFocusTimer(): void {
    clearTimeout(this.#focusTimer)
    this.#focusTimer = undefined
  }

  get #focusInactive(): boolean {
    const mode = this.focusPolicy.mode
    return mode !== 'NEVER' && (document.visibilityState !== 'visible' ||
      (mode === 'WHEN_UNFOCUSED' && !document.hasFocus()))
  }

  #handleFocusPolicy = (): void => {
    if (!this.#connectedOnce || !this.isConnected) return
    const inactive = this.#focusInactive
    if (!inactive || this.#state !== 'CONNECTED') this.#clearFocusTimer()
    if (this.#focusOperation !== undefined) return
    if (inactive && this.#state === 'CONNECTED' && this.#focusTimer === undefined) {
      const grace = this.focusPolicy.gracePeriodMs
      if (grace === 0) this.#applyFocusPolicy(true)
      else this.#focusTimer = setTimeout(() => {
        this.#focusTimer = undefined
        if (this.#focusInactive && this.#state === 'CONNECTED') this.#applyFocusPolicy(true)
      }, grace)
    } else if (!inactive && this.#state === 'SUSPENDED' && (this.#focusSuspended ||
      (this.#focusPolicy === undefined && this.focusPolicy.mode !== 'NEVER'))) {
      this.#applyFocusPolicy(false)
    }
  }

  #applyFocusPolicy(suspend: boolean): void {
    const client = this.#client
    if (client === undefined || this.#focusOperation !== undefined) return
    const operation = this.#invoke(async () => {
      if (suspend) {
        this.#releasePressedInput()
        await client.suspend()
      } else await client.resume()
      if (this.#client === client) this.#focusSuspended = suspend
    })
    this.#focusOperation = operation
    void operation.finally(() => {
      if (this.#focusOperation === operation) this.#focusOperation = undefined
      // Focus may return while the reliable suspend acknowledgement is in flight.
      // Reconcile that change, without retrying a failed command in a tight loop.
      if (this.#client === client && this.#focusInactive !== suspend) this.#handleFocusPolicy()
    })
  }

  #releasePressedInput(): void {
    if (this.#state !== 'CONNECTED' || this.#windowInputBlocked) return
    if (this.#pressedPointerButton && this.#lastPointer && this.#viewport) {
      this.#client?.sendPointer({
        event: 'mouseReleased',
        ...this.#lastPointer,
        viewportRevision: this.#viewport.revision,
        button: this.#pressedPointerButton,
        buttons: 0,
        modifiers: 0,
        clickCount: 0,
      })
    }
    this.#pressedPointerButton = undefined
    this.#touchPoints.clear()
    this.#touchGesture = undefined
    for (const input of this.#pressedKeys.values()) {
      this.#client?.sendKey({ event: 'keyUp', ...input, modifiers: 0 })
    }
    this.#pressedKeys.clear()
  }

  #setStatus(state: RemoteTabState): void {
    this.#state = state
    if (state === 'CLOSED' || state === 'FAILED' || state === 'ATTACHING') this.#playbackBlocked = false
    const text = this.#strings
    const labels: Partial<Record<RemoteTabState, string>> = { ATTACHING: text.ready, READY: text.ready, NEGOTIATING: text.connecting, CONNECTED: text.connected, SUSPENDED: text.suspended, RECONNECTING: text.connecting, FAILED: text.failed, CLOSED: text.closed, CLOSING: text.closed }
    const status = this.#required<HTMLElement>('[data-status]')
    status.dataset.state = state
    this.#required<HTMLElement>('[data-status-copy]').textContent = labels[state] ?? state
    const overlay = this.#required<HTMLElement>('[data-overlay]')
    const blocked = state === 'CONNECTED' && this.#playbackBlocked
    overlay.hidden = state === 'CONNECTED' && !blocked
    this.#button('resume').hidden = state !== 'SUSPENDED'
    this.#button('resume').textContent = text.resume
    this.#button('playback').hidden = !blocked
    this.#button('playback').textContent = text.playback
    this.#required<HTMLElement>('[data-overlay-title]').textContent = blocked ? text.playbackTitle : labels[state] ?? state
    this.#required<HTMLElement>('[data-overlay-copy]').textContent = blocked ? text.playbackCopy : state === 'SUSPENDED' ? text.suspendedCopy : state === 'FAILED' ? text.failed : state === 'CONNECTED' ? '' : text.connecting
    this.#syncCapabilities()
    this.#syncInputMode()
  }

  get #windowInputBlocked(): boolean {
    return this.#required<HTMLDialogElement>('[data-quality-dialog]').open ||
      ((this.#client?.capabilities.includes('windowSelection') ?? false) &&
      (this.#client?.windowState === undefined || this.#client.windowState.selecting))
  }

  #syncWindows(): void {
    const text = this.#strings
    const bar = this.#required<HTMLElement>('[data-window-bar]')
    bar.hidden = !(this.#client?.capabilities.includes('windowSelection') ?? false)
    const select = this.#required<HTMLSelectElement>('[data-window-select]')
    select.setAttribute('aria-label', text.windows)
    this.#required<HTMLElement>('[data-window-label]').textContent = text.windows
    const windows = this.#windows
    select.replaceChildren(...(windows?.windows ?? []).map(window => {
      const option = document.createElement('option')
      option.value = window.targetId
      const label = window.main ? text.mainWindow : text.childWindow
      option.textContent = `${label} · ${window.title || window.url}`
      option.title = window.url
      return option
    }))
    if (windows !== undefined) select.value = windows.selectedTargetId
    select.disabled = windows === undefined || windows.selecting || !['CONNECTED', 'SUSPENDED'].includes(this.#state)
    const close = this.#button('window-close')
    close.disabled = select.disabled || windows?.windows.find(window => window.targetId === windows.selectedTargetId)?.main !== false
    close.title = text.closeWindow
    close.setAttribute('aria-label', text.closeWindow)
    close.querySelector('.sr-only')!.textContent = text.closeWindow
    this.#required<HTMLElement>('[data-window-status]').textContent = windows?.selecting ? text.switchingWindow : ''
  }

  #syncQualityOptions(): void {
    const advanced = this.#client?.capabilities.includes('advancedQuality') === true
    const values = advanced ? ['auto', 'data-saver', 'balanced', 'high', 'custom'] : ['data-saver', 'balanced', 'high']
    if ([...this.#qualitySelect.options].map(option => option.value).join() !== values.join()) {
      this.#qualitySelect.replaceChildren(...values.map(value => {
        const option = document.createElement('option')
        option.value = value
        return option
      }))
    }
    const text = this.#strings
    const labels: Record<string, string> = { auto: text.autoQuality, custom: text.customQuality, 'data-saver': text.dataSaver, balanced: text.balanced, high: text.high }
    for (const option of this.#qualitySelect.options) option.textContent = labels[option.value] ?? option.value
    this.#syncQualitySelection()
  }

  #syncQualitySelection(): void {
    const advanced = this.#client?.capabilities.includes('advancedQuality') === true
    const configuration = this.#qualityState?.configuration
    this.#qualitySelect.value = advanced
      ? configuration === undefined ? '' : configuration.mode === 'preset' ? configuration.preset : configuration.mode
      : this.#quality
  }

  #openQualityDialog(): void {
    if (this.#qualityPending || this.#state !== 'CONNECTED' || !this.#client?.capabilities.includes('advancedQuality') || !this.#client.capabilities.includes('qualityControl') ||
      this.#activeNoticeId !== undefined || this.#localOpen !== undefined || this.#uploadRequest !== undefined || this.#downloadRequest !== undefined || this.#clipboardFallback !== undefined) return
    const settings = this.#qualityState?.configuration.mode === 'custom' ? this.#qualityState.configuration : this.#qualityState?.applied
    this.#required<HTMLInputElement>('[data-quality-bitrate]').value = String((settings?.maxBitrate ?? 2_500_000) / 1000)
    this.#required<HTMLInputElement>('[data-quality-fps]').value = String(settings?.maxFrameRate ?? 30)
    this.#required<HTMLInputElement>('[data-quality-scale]').value = String(settings?.scaleResolutionDownBy ?? 1)
    for (const input of this.#root.querySelectorAll<HTMLInputElement>('.quality-fields input')) input.removeAttribute('aria-invalid')
    this.#required<HTMLElement>('[data-quality-error]').hidden = true
    this.#releasePressedInput()
    this.#required<HTMLDialogElement>('[data-quality-dialog]').showModal()
    this.#syncCapabilities()
    this.#required<HTMLInputElement>('[data-quality-bitrate]').focus()
  }

  #closeQualityDialog(): void {
    this.#required<HTMLDialogElement>('[data-quality-dialog]').close()
    this.#syncQualitySelection()
    this.#syncCapabilities()
    this.#qualitySelect.focus({ preventScroll: true })
  }

  async #submitCustomQuality(): Promise<void> {
    if (this.#qualityPending) return
    const bitrate = this.#required<HTMLInputElement>('[data-quality-bitrate]')
    const fps = this.#required<HTMLInputElement>('[data-quality-fps]')
    const scale = this.#required<HTMLInputElement>('[data-quality-scale]')
    let invalid: HTMLInputElement | undefined
    for (const input of [bitrate, fps, scale]) {
      const valid = input.checkValidity() && Number.isFinite(input.valueAsNumber)
      input.setAttribute('aria-invalid', String(!valid))
      if (!valid) invalid ??= input
    }
    if (invalid !== undefined) {
      const error = this.#required<HTMLElement>('[data-quality-error]')
      error.textContent = this.#strings.qualityInvalid
      error.hidden = false
      invalid.focus()
      return
    }
    await this.#applyQuality({ mode: 'custom', maxBitrate: Math.round(bitrate.valueAsNumber * 1000), maxFrameRate: fps.valueAsNumber, scaleResolutionDownBy: scale.valueAsNumber }, true)
  }

  async #applyQuality(configuration: QualityConfiguration, fromDialog = false): Promise<void> {
    if (this.#qualityPending) return
    this.#qualityPending = true
    const error = this.#required<HTMLElement>('[data-quality-error]')
    error.hidden = true
    this.#syncCapabilities()
    try {
      await this.configureQuality(configuration)
      if (fromDialog) {
        this.#qualityPending = false
        this.#closeQualityDialog()
      }
    } catch (cause) {
      const message = `${this.#strings.qualityFailed} ${cause instanceof Error ? cause.message : ''}`
      if (fromDialog) {
        error.textContent = message
        error.hidden = false
      } else this.#showNotice({ level: 'error', code: 'QUALITY_CONFIGURATION_FAILED', message })
      this.#dispatchViewerError(cause)
    } finally {
      this.#qualityPending = false
      this.#syncQualitySelection()
      this.#syncCapabilities()
    }
  }

  async #applyLegacyQuality(preset: MediaQualityPreset): Promise<void> {
    if (this.#qualityPending) return
    this.#qualityPending = true
    this.#syncCapabilities()
    try { await this.#client?.requestQuality(preset) }
    catch (cause) {
      this.#showNotice({ level: 'error', code: 'QUALITY_CONFIGURATION_FAILED', message: this.#strings.qualityFailed })
      this.#dispatchViewerError(cause)
    } finally {
      this.#qualityPending = false
      this.#syncQualitySelection()
      this.#syncCapabilities()
    }
  }

  #syncCapabilities(): void {
    this.#syncWindows()
    const capabilities = this.#client?.capabilities ?? []
    const interactive = this.#state === 'CONNECTED' && !this.#playbackBlocked && !this.#windowInputBlocked
    this.#imeProxy.disabled = !interactive
    for (const action of ['back', 'forward']) this.#button(action).disabled = !interactive || !capabilities.includes('backForward')
    this.#button('reload').disabled = !interactive || !capabilities.includes('reload')
    this.#button('fullscreen').disabled = this.#state !== 'CONNECTED' || !capabilities.includes('fullscreen')
    this.#address.disabled = !interactive || !capabilities.includes('navigation')
    this.#syncQualityOptions()
    const qualityUnavailable = this.#state !== 'CONNECTED' || !capabilities.includes('qualityControl') || this.#qualityPending
    this.#required<HTMLElement>('[data-quality-control]').hidden = !capabilities.includes('qualityControl')
    this.#qualitySelect.disabled = qualityUnavailable
    this.#button('quality-custom').hidden = !capabilities.includes('advancedQuality') || !capabilities.includes('qualityControl')
    this.#button('quality-custom').disabled = qualityUnavailable
    this.#button('quality-apply').disabled = qualityUnavailable || !capabilities.includes('advancedQuality')
    this.#button('quality-cancel').disabled = this.#qualityPending
    for (const input of this.#root.querySelectorAll<HTMLInputElement>('.quality-fields input')) input.disabled = this.#qualityPending
    this.#required<HTMLFormElement>('[data-quality-form]').setAttribute('aria-busy', String(this.#qualityPending))
    this.#button('quality-apply').textContent = this.#qualityPending ? this.#strings.qualityApplying : this.#strings.qualityApply
    const clipboardUnavailable =
      !interactive ||
      this.#clipboardOperation !== undefined ||
      (!capabilities.includes('clipboardText') && !capabilities.includes('clipboardImage'))
    this.#button('clipboard-copy').disabled = clipboardUnavailable
    this.#button('clipboard-paste').disabled = clipboardUnavailable
    this.#button('keyboard').disabled = !interactive
  }

  #handleInputModeChange = (): void => this.#syncInputMode()

  #syncInputMode(): void {
    const shell = this.#root.querySelector<HTMLElement>('.shell')
    const guidance = this.#root.querySelector<HTMLElement>('[data-mobile-guidance]')
    if (shell === null || guidance === null) return
    const touchPreferred = this.#coarsePointerQuery?.matches === true || navigator.maxTouchPoints > 0
    shell.dataset.inputMode = touchPreferred ? 'touch' : 'pointer'
    guidance.hidden = !touchPreferred || this.#state !== 'CONNECTED' || this.#mobileGuidanceDismissed
  }

  #enqueueLocalOpen(request: { requestId: string; url: string; expiresAt: number }): void {
    this.#localOpenQueue.push(request)
    this.#showNextLocalOpen()
  }

  #showNextLocalOpen(): void {
    if (
      this.#localOpen !== undefined ||
      this.#uploadRequest !== undefined ||
      this.#downloadRequest !== undefined ||
      this.#clipboardFallback !== undefined
    ) return
    let request = this.#localOpenQueue.shift()
    while (request !== undefined && request.expiresAt <= Date.now()) {
      request = this.#localOpenQueue.shift()
    }
    if (request === undefined) return
    this.#localOpen = { requestId: request.requestId, url: request.url }
    this.#required<HTMLElement>('[data-local-url]').textContent = request.url
    this.#required<HTMLDialogElement>('[data-local-dialog]').showModal()
    this.#button('local-open').focus()
  }

  #removeLocalOpen(requestId: string): void {
    const index = this.#localOpenQueue.findIndex((request) => request.requestId === requestId)
    if (index >= 0) this.#localOpenQueue.splice(index, 1)
    if (this.#localOpen?.requestId !== requestId) return
    this.#localOpen = undefined
    this.#required<HTMLDialogElement>('[data-local-dialog]').close()
    this.#showNextLocalOpen()
  }

  #showUpload(requestId: string, multiple: boolean, constraints?: UploadConstraints): void {
    if (this.#localOpen !== undefined) void this.#resolveLocalOpen(false)
    this.#required<HTMLElement>('[data-download-dialog]').hidden = true
    this.#uploadRequest = { requestId, multiple, ...(constraints === undefined ? {} : { constraints }) }
    this.#fileInput.multiple = multiple
    this.#fileInput.accept = constraints?.allowedExtensions.join(',') ?? ''
    this.#required<HTMLElement>('[data-upload-picker]').hidden = false
    this.#required<HTMLElement>('[data-upload-progress]').hidden = true
    this.#required<HTMLElement>('[data-upload-error]').hidden = true
    this.#required<HTMLElement>('[data-upload-dialog]').hidden = false
    this.#syncUploadCopy()
    this.#button('upload-choose').focus()
  }

  #syncUploadCopy(): void {
    const request = this.#uploadRequest
    if (request === undefined) return
    if (this.#required<HTMLElement>('[data-upload-picker]').hidden && !this.#required<HTMLElement>('[data-upload-error]').hidden) {
      this.#required<HTMLElement>('[data-upload-copy]').textContent = this.#strings.uploadRestart
      this.#button('upload-cancel').textContent = this.#strings.close
      return
    }
    this.#button('upload-cancel').textContent = this.#strings.cancel
    const parts: string[] = [request.multiple ? this.#strings.uploadMultiple : this.#strings.uploadSingle]
    const limits = request.constraints
    if (limits !== undefined) {
      const count = request.multiple ? limits.maxFiles : 1
      const perFile = formatBytes(limits.maxFileBytes, this.#locale)
      const batch = formatBytes(limits.maxBatchBytes, this.#locale)
      const extensions = limits.allowedExtensions.join(', ')
      parts.push(this.#locale === 'zh-CN'
        ? `最多 ${count} 个文件；单个 ${perFile}，合计 ${batch}。${extensions ? `允许的文件后缀：${extensions}。` : '不限文件后缀。'}`
        : `Up to ${count} files; ${perFile} each, ${batch} total. ${extensions ? `Allowed filename extensions: ${extensions}.` : 'Any filename extension.'}`)
    }
    this.#required<HTMLElement>('[data-upload-copy]').textContent = parts.join(' ')
  }

  async #uploadFiles(files: readonly File[]): Promise<void> {
    const request = this.#uploadRequest
    if (request === undefined || this.#client === undefined) return
    try {
      if (request.constraints !== undefined) {
        assertUploadAllowed(files.map(file => ({ displayName: file.name, size: file.size })), {
          ...request.constraints,
          maxFiles: request.multiple ? request.constraints.maxFiles : 1,
        })
      }
    } catch (cause) {
      const error = this.#required<HTMLElement>('[data-upload-error]')
      error.textContent = this.#strings.uploadInvalid
      error.hidden = false
      this.#fileInput.value = ''
      this.#button('upload-choose').focus()
      return
    }
    this.#required<HTMLElement>('[data-upload-picker]').hidden = true
    this.#required<HTMLElement>('[data-upload-progress]').hidden = false
    this.#required<HTMLElement>('[data-upload-error]').hidden = true
    this.#updateUploadProgress(0, files.reduce((total, file) => total + file.size, 0))
    try {
      await this.#client.uploadFiles(request.requestId, files)
      if (this.#uploadRequest !== request) return
      this.#dispatch('upload-complete', { requestId: request.requestId })
      this.#hideUpload()
      this.#surface.focus()
    } catch (cause) {
      if (this.#uploadRequest !== request) return
      const error = this.#required<HTMLElement>('[data-upload-error]')
      error.textContent = cause instanceof Error && cause.message !== ''
        ? cause.message
        : this.#strings.uploadFailed
      error.hidden = false
      this.#required<HTMLElement>('[data-upload-progress]').hidden = true
      this.#syncUploadCopy()
      // The upload dialog owns transfer failures; transport failures arrive through client events.
    }
  }

  async #cancelUpload(): Promise<void> {
    const request = this.#uploadRequest
    if (request === undefined) return
    this.#hideUpload()
    try {
      await this.#client?.cancelUpload(request.requestId)
    } catch (cause) {
      this.#dispatchViewerError(cause)
    }
    this.#surface.focus()
  }

  #hideUpload(): void {
    this.#uploadRequest = undefined
    this.#fileInput.value = ''
    this.#required<HTMLElement>('[data-upload-dialog]').hidden = true
    this.#resumePrompts()
  }

  #updateUploadProgress(sentBytes: number, totalBytes: number): void {
    if (this.#uploadRequest === undefined) return
    const progress = this.#required<HTMLProgressElement>('[data-upload-progress-bar]')
    progress.max = Math.max(1, totalBytes)
    progress.value = Math.min(sentBytes, progress.max)
    this.#required<HTMLElement>('[data-upload-progress-label]').textContent = this.#strings.uploading
    this.#required<HTMLElement>('[data-upload-progress-value]').textContent =
      `${formatBytes(sentBytes, this.#locale)} / ${formatBytes(totalBytes, this.#locale)}`
  }

  #showNextDownload(): void {
    if (
      this.#uploadRequest !== undefined ||
      this.#localOpen !== undefined ||
      this.#downloadRequest !== undefined ||
      this.#clipboardFallback !== undefined
    ) return
    let transferId = this.#downloadQueue.shift()
    let offer = transferId === undefined ? undefined : this.#downloadOffers.get(transferId)
    while (transferId !== undefined && (offer === undefined || offer.expiresAt <= Date.now())) {
      transferId = this.#downloadQueue.shift()
      offer = transferId === undefined ? undefined : this.#downloadOffers.get(transferId)
    }
    if (transferId === undefined || offer === undefined) {
      this.#showNextLocalOpen()
      return
    }
    this.#downloadRequest = transferId
    this.#required<HTMLElement>('[data-download-summary]').hidden = false
    this.#required<HTMLElement>('[data-download-progress]').hidden = true
    this.#required<HTMLElement>('[data-download-error]').hidden = true
    this.#required<HTMLElement>('[data-download-name]').textContent = offer.file.displayName
    this.#required<HTMLElement>('[data-download-size]').textContent = formatBytes(offer.file.size, this.#locale)
    this.#button('download-save').hidden = false
    this.#button('download-save').textContent = this.#strings.saveDownload
    this.#button('download-cancel').textContent = this.#strings.cancel
    this.#required<HTMLElement>('[data-download-dialog]').hidden = false
    this.#button('download-save').focus()
  }

  async #startDownload(transferId: string): Promise<void> {
    try {
      await this.acceptDownload(transferId)
    } catch (cause) {
      if (this.#downloadRequest !== transferId || !this.#downloadOffers.has(transferId)) return
      const error = this.#required<HTMLElement>('[data-download-error]')
      error.textContent = cause instanceof Error && cause.message !== ''
        ? cause.message
        : this.#strings.downloadFailed
      error.hidden = false
      this.#button('download-cancel').textContent = this.#strings.close
      this.#dispatchViewerError(cause)
    }
  }

  #updateDownloadProgress(receivedBytes: number, totalBytes: number): void {
    if (this.#downloadRequest === undefined) return
    const progress = this.#required<HTMLProgressElement>('[data-download-progress-bar]')
    progress.max = Math.max(1, totalBytes)
    progress.value = Math.min(receivedBytes, progress.max)
    this.#required<HTMLElement>('[data-download-progress-label]').textContent = this.#strings.downloading
    this.#required<HTMLElement>('[data-download-progress-value]').textContent =
      `${formatBytes(receivedBytes, this.#locale)} / ${formatBytes(totalBytes, this.#locale)}`
  }

  #removeDownload(transferId: string): void {
    this.#downloadOffers.delete(transferId)
    this.#acceptedDownloads.delete(transferId)
    for (let index = this.#downloadQueue.length - 1; index >= 0; index -= 1) {
      if (this.#downloadQueue[index] === transferId) this.#downloadQueue.splice(index, 1)
    }
    if (this.#downloadRequest !== transferId) return
    this.#downloadRequest = undefined
    this.#required<HTMLElement>('[data-download-dialog]').hidden = true
    this.#resumePrompts()
  }

  #resumePrompts(): void {
    if (this.#clipboardFallback !== undefined) return
    if (this.#uploadRequest !== undefined) return
    if (this.#downloadRequest !== undefined) {
      this.#required<HTMLElement>('[data-download-dialog]').hidden = false
      const action = this.#acceptedDownloads.has(this.#downloadRequest) ? 'download-cancel' : 'download-save'
      this.#button(action).focus()
      return
    }
    this.#showNextDownload()
  }

  #saveDownload(download: RemoteTabDownloadedFile): void {
    const url = URL.createObjectURL(download.blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = download.displayName
    anchor.hidden = true
    this.#root.append(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  async #pasteToRemote(): Promise<void> {
    if (
      this.#client === undefined ||
      this.#state !== 'CONNECTED' ||
      this.#clipboardOperation !== undefined ||
      !this.#dispatch('clipboard-write-request', { direction: 'local-to-remote' }, true)
    ) return

    this.#clipboardOperation = 'write'
    this.#syncCapabilities()
    let items: readonly RemoteTabClipboardWriteItem[]
    try {
      items = await readLocalClipboardItems(this.#client.capabilities)
    } catch {
      this.#clipboardOperation = undefined
      this.#syncCapabilities()
      this.#showClipboardFallback({ mode: 'paste' })
      return
    }
    try {
      await this.writeRemoteClipboard(items)
      this.#dispatch('clipboard-write-complete', {
        mimeTypes: items.map((item) => item.mimeType),
      })
      this.#showNotice({ level: 'info', code: 'CLIPBOARD_WRITTEN', message: this.#strings.clipboardDone })
    } catch (cause) {
      this.#showNotice({
        level: 'error',
        code: 'CLIPBOARD_WRITE_FAILED',
        message: cause instanceof Error && cause.message !== '' ? cause.message : this.#strings.clipboardFailed,
      })
      this.#dispatchViewerError(cause)
    } finally {
      this.#clipboardOperation = undefined
      this.#syncCapabilities()
      this.#surface.focus()
    }
  }

  async #copyFromRemote(): Promise<void> {
    if (
      this.#client === undefined ||
      this.#state !== 'CONNECTED' ||
      this.#clipboardOperation !== undefined ||
      !this.#dispatch('clipboard-read-request', { direction: 'remote-to-local' }, true)
    ) return

    this.#clipboardOperation = 'read'
    this.#syncCapabilities()
    try {
      const items = await this.readRemoteClipboard()
      if (!this.#dispatch('clipboard-read-complete', { items }, true)) return
      try {
        await writeLocalClipboardItems(items)
        this.#showNotice({ level: 'info', code: 'CLIPBOARD_READ', message: this.#strings.clipboardDone })
      } catch {
        this.#showClipboardFallback({ mode: 'copy', items })
      }
    } catch (cause) {
      this.#showNotice({
        level: 'error',
        code: 'CLIPBOARD_READ_FAILED',
        message: cause instanceof Error && cause.message !== '' ? cause.message : this.#strings.clipboardFailed,
      })
      this.#dispatchViewerError(cause)
    } finally {
      this.#clipboardOperation = undefined
      this.#syncCapabilities()
      if (this.#clipboardFallback === undefined) this.#surface.focus()
    }
  }

  #showClipboardFallback(
    fallback: { mode: 'paste' } | { mode: 'copy'; items: readonly RemoteTabClipboardItem[] },
  ): void {
    this.#clipboardFallback = fallback
    this.#required<HTMLDialogElement>('[data-local-dialog]').close()
    this.#required<HTMLElement>('[data-upload-dialog]').hidden = true
    this.#required<HTMLElement>('[data-download-dialog]').hidden = true
    const imageNote = this.#required<HTMLElement>('[data-clipboard-image-note]')
    const error = this.#required<HTMLElement>('[data-clipboard-error]')
    const send = this.#button('clipboard-send')
    this.#clipboardText.hidden = false
    this.#clipboardText.value = ''
    error.hidden = true
    imageNote.hidden = true
    if (fallback.mode === 'paste') {
      this.#required<HTMLElement>('[data-clipboard-title]').textContent = this.#strings.pasteFallbackTitle
      this.#required<HTMLElement>('[data-clipboard-copy]').textContent = this.#strings.pasteFallbackCopy
      const canPasteText = this.#client?.capabilities.includes('clipboardText') === true
      this.#clipboardText.readOnly = false
      this.#clipboardText.placeholder = this.#strings.pastePlaceholder
      this.#clipboardText.hidden = !canPasteText
      imageNote.textContent = this.#strings.imagePasteFallback
      imageNote.hidden = canPasteText
      send.hidden = !canPasteText
      send.textContent = this.#strings.sendRemote
      this.#button('clipboard-close').textContent = this.#strings.cancel
    } else {
      this.#required<HTMLElement>('[data-clipboard-title]').textContent = this.#strings.copyFallbackTitle
      this.#required<HTMLElement>('[data-clipboard-copy]').textContent = this.#strings.copyFallbackCopy
      this.#clipboardText.readOnly = true
      this.#clipboardText.placeholder = ''
      const textItem = fallback.items.find((item) => item.mimeType === 'text/plain')
      this.#clipboardText.value = textItem === undefined ? '' : new TextDecoder().decode(textItem.data)
      this.#clipboardText.hidden = textItem === undefined
      const hasImage = fallback.items.some((item) => item.mimeType === 'image/png')
      imageNote.textContent = this.#strings.imageFallback
      imageNote.hidden = !hasImage
      send.hidden = true
      this.#button('clipboard-close').textContent = this.#strings.close
    }
    this.#required<HTMLElement>('[data-clipboard-dialog]').hidden = false
    const initialFocus =
      fallback.mode === 'paste' && !this.#clipboardText.hidden
        ? this.#clipboardText
        : this.#button('clipboard-close')
    initialFocus.focus()
    if (fallback.mode === 'copy' && !this.#clipboardText.hidden) this.#clipboardText.select()
  }

  #hideClipboardFallback(): void {
    this.#clipboardFallback = undefined
    this.#required<HTMLElement>('[data-clipboard-dialog]').hidden = true
    this.#resumePrompts()
    this.#surface.focus()
  }

  async #sendManualClipboardText(): Promise<void> {
    if (this.#clipboardFallback?.mode !== 'paste' || this.#clipboardOperation !== undefined) return
    this.#clipboardOperation = 'write'
    this.#syncCapabilities()
    const error = this.#required<HTMLElement>('[data-clipboard-error]')
    error.hidden = true
    try {
      await this.writeRemoteClipboard([{ mimeType: 'text/plain', data: this.#clipboardText.value }])
      this.#dispatch('clipboard-write-complete', { mimeTypes: ['text/plain'], manual: true })
      this.#hideClipboardFallback()
      this.#showNotice({ level: 'info', code: 'CLIPBOARD_WRITTEN', message: this.#strings.clipboardDone })
    } catch (cause) {
      error.textContent = cause instanceof Error && cause.message !== '' ? cause.message : this.#strings.clipboardFailed
      error.hidden = false
      this.#dispatchViewerError(cause)
    } finally {
      this.#clipboardOperation = undefined
      this.#syncCapabilities()
    }
  }

  async #resolveLocalOpen(approved: boolean): Promise<void> {
    const request = this.#localOpen
    if (!request) return
    this.#localOpen = undefined
    this.#required<HTMLDialogElement>('[data-local-dialog]').close()
    try {
      await this.#client?.respondToLocalOpen(request.requestId, approved)
      if (approved) window.open(request.url, '_blank', 'noopener,noreferrer')
    } catch (cause) {
      this.#dispatchViewerError(cause)
    }
    this.#surface.focus()
    this.#resumePrompts()
  }

  #showNextNotice(): void {
    if (this.#activeNoticeId !== undefined || !this.isConnected) return
    let request = this.#noticeRequests[0]
    while (request !== undefined && request.expiresAt <= Date.now()) {
      this.#noticeRequests.shift()
      request = this.#noticeRequests[0]
    }
    if (request === undefined) return
    this.#activeNoticeId = request.requestId
    const focused = this.#root.activeElement ?? document.activeElement
    this.#noticeReturnFocus = focused instanceof HTMLElement ? focused : undefined
    const dialog = this.#required<HTMLDialogElement>('[data-notice-dialog]')
    dialog.dataset.kind = request.content.kind
    this.#required<HTMLElement>('#notice-title').textContent = request.content.title
    this.#required<HTMLElement>('#notice-body').textContent = request.content.body
    const actions = this.#required<HTMLElement>('[data-notice-actions]')
    actions.replaceChildren()
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'button'
    close.textContent = request.content.kind === 'confirm' ? this.#strings.cancel : this.#strings.close
    const requestId = request.requestId
    close.addEventListener('click', () => { void this.#answerNotice(requestId, null) })
    actions.append(close)
    for (const action of request.content.buttons) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'button primary'
      button.textContent = action.label
      button.addEventListener('click', () => { void this.#answerNotice(requestId, action.id) })
      actions.append(button)
    }
    // The browser top layer coordinates existing file/clipboard dialogs and traps focus.
    dialog.showModal()
    close.focus()
  }

  async #answerNotice(requestId: string, buttonId: string | null): Promise<void> {
    try {
      await this.respondToNotice(requestId, buttonId)
    } catch (cause) {
      this.#dispatchViewerError(cause)
    }
  }

  #removeNoticeRequest(requestId: string): void {
    const index = this.#noticeRequests.findIndex((request) => request.requestId === requestId)
    if (index >= 0) this.#noticeRequests.splice(index, 1)
    if (this.#activeNoticeId !== requestId) return
    this.#activeNoticeId = undefined
    this.#required<HTMLDialogElement>('[data-notice-dialog]').close()
    if (this.#noticeReturnFocus?.isConnected) this.#noticeReturnFocus.focus()
    this.#noticeReturnFocus = undefined
    this.#showNextNotice()
  }

  #showNotice(notice: { level: 'info' | 'warning' | 'error'; code: string; message: string }): void {
    const container = this.#required<HTMLElement>('[data-notices]')
    const element = document.createElement('div')
    element.className = 'notice'
    element.dataset.notice = ''
    element.dataset.level = notice.level
    element.setAttribute('part', `notice notice-${notice.level}`)
    const copy = document.createElement('p')
    copy.textContent = notice.message
    const close = document.createElement('button')
    close.className = 'notice-close'
    close.type = 'button'
    close.dataset.action = 'notice-close'
    close.title = this.#strings.close
    close.setAttribute('aria-label', this.#strings.close)
    close.textContent = '×'
    element.append(copy, close)
    container.prepend(element)
    while (container.children.length > 3) {
      const oldest = container.lastElementChild
      if (oldest instanceof HTMLElement) this.#removeNotice(oldest)
    }
    const duration = notice.level === 'error' ? 12_000 : notice.level === 'warning' ? 9_000 : 6_000
    const timer = setTimeout(() => this.#removeNotice(element), duration)
    this.#noticeTimers.set(element, timer)
  }

  #removeNotice(element: HTMLElement): void {
    clearTimeout(this.#noticeTimers.get(element))
    this.#noticeTimers.delete(element)
    element.remove()
  }

  #clearTransientUi(): void {
    this.#noticeRequests.length = 0
    this.#activeNoticeId = undefined
    const noticeDialog = this.#required<HTMLDialogElement>('[data-notice-dialog]')
    if (noticeDialog.open) noticeDialog.close()
    this.#noticeReturnFocus = undefined
    this.#localOpen = undefined
    this.#localOpenQueue.length = 0
    this.#uploadRequest = undefined
    this.#downloadOffers.clear()
    this.#downloadQueue.length = 0
    this.#acceptedDownloads.clear()
    this.#downloadRequest = undefined
    this.#clipboardOperation = undefined
    this.#clipboardFallback = undefined
    this.#required<HTMLDialogElement>('[data-local-dialog]').close()
    this.#required<HTMLDialogElement>('[data-quality-dialog]').close()
    this.#qualityState = undefined
    this.#appliedQuality = undefined
    this.#required<HTMLElement>('[data-upload-dialog]').hidden = true
    this.#required<HTMLElement>('[data-download-dialog]').hidden = true
    this.#required<HTMLElement>('[data-clipboard-dialog]').hidden = true
    for (const notice of this.#noticeTimers.keys()) this.#removeNotice(notice)
  }

  #applyTranslations(): void {
    if (!this.#root.querySelector('.shell')) return
    const text = this.#strings
    this.#syncWindows()
    this.#required<HTMLElement>('[data-immersive-label]').textContent = text.immersive
    this.#required<HTMLElement>('[data-exit-immersive-label]').textContent = text.exitImmersive
    this.#button('immersive').title = text.immersive
    this.#button('exit-immersive').title = text.exitImmersive
    for (const [action, label] of [['back', text.back], ['forward', text.forward], ['reload', text.reload], ['clipboard-copy', text.copyRemote], ['clipboard-paste', text.pasteRemote], ['keyboard', text.keyboard], ['fullscreen', text.fullscreen]] as const) {
      const button = this.#button(action)
      button.title = label
      button.setAttribute('aria-label', label)
      button.querySelector('.sr-only')!.textContent = label
    }
    this.#address.placeholder = text.address
    this.#address.setAttribute('aria-label', text.address)
    this.#required<HTMLElement>('[data-quality-label]').textContent = text.quality
    this.#qualitySelect.setAttribute('aria-label', text.quality)
    this.#syncQualityOptions()
    this.#syncQualityDescription()
    this.#required<HTMLElement>('[data-quality-title]').textContent = text.customQuality
    this.#required<HTMLElement>('[data-quality-copy]').textContent = text.qualityCopy
    this.#required<HTMLElement>('[data-quality-bitrate-label]').textContent = text.bitrate
    this.#required<HTMLElement>('[data-quality-fps-label]').textContent = text.frameRate
    this.#required<HTMLElement>('[data-quality-scale-label]').textContent = text.resolutionScale
    this.#button('quality-cancel').textContent = text.cancel
    this.#button('quality-apply').textContent = this.#qualityPending ? text.qualityApplying : text.qualityApply
    this.#button('quality-custom').title = text.configureQuality
    this.#button('quality-custom').setAttribute('aria-label', text.configureQuality)
    this.#button('quality-custom').querySelector('.sr-only')!.textContent = text.configureQuality
    this.#required<HTMLElement>('[data-end-label]').textContent = text.end
    this.#button('end').setAttribute('aria-label', text.end)
    this.#required<HTMLElement>('[data-mobile-guidance-copy]').textContent = text.mobilePreview
    const mobileGuidanceClose = this.#button('mobile-guidance-close')
    mobileGuidanceClose.title = text.close
    mobileGuidanceClose.setAttribute('aria-label', text.close)
    mobileGuidanceClose.textContent = '×'
    this.#required<HTMLElement>('[data-local-title]').textContent = text.localTitle
    this.#required<HTMLElement>('[data-local-copy]').textContent = text.localCopy
    this.#button('local-cancel').textContent = text.cancel
    this.#button('local-open').textContent = text.open
    this.#required<HTMLElement>('[data-upload-title]').textContent = text.uploadTitle
    this.#button('upload-choose').textContent = text.chooseFiles
    if (this.#uploadRequest !== undefined) {
      this.#syncUploadCopy()
    }
    this.#required<HTMLElement>('[data-download-title]').textContent = text.downloadTitle
    this.#required<HTMLElement>('[data-download-copy]').textContent = text.downloadCopy
    this.#button('download-save').textContent = text.saveDownload
    this.#button('download-cancel').textContent = text.cancel
    if (this.#clipboardFallback !== undefined) this.#showClipboardFallback(this.#clipboardFallback)
    if (this.#downloadRequest !== undefined) {
      const offer = this.#downloadOffers.get(this.#downloadRequest)
      if (offer !== undefined) {
        this.#required<HTMLElement>('[data-download-size]').textContent = formatBytes(offer.file.size, this.#locale)
      }
    }
    this.#setStatus(this.#state)
  }

  get #strings() {
    return copy[this.getAttribute('locale') === 'en-US' ? 'en-US' : 'zh-CN']
  }
  get #locale(): 'zh-CN' | 'en-US' {
    return this.getAttribute('locale') === 'en-US' ? 'en-US' : 'zh-CN'
  }

  #button(action: string): HTMLButtonElement { return this.#required(`[data-action="${action}"]`) }
  #required<ElementType extends Element>(selector: string): ElementType {
    const element = this.#root.querySelector<ElementType>(selector)
    if (!element) throw new Error(`Remote Tab Viewer is missing ${selector}`)
    return element
  }
  async #invoke(invoke: () => Promise<void> | void | undefined): Promise<void> {
    try { await invoke() } catch (cause) { this.#dispatchViewerError(cause) }
  }
  #dispatchViewerError(cause: unknown): void {
    this.#dispatch('error', { type: 'error', error: cause instanceof RemoteTabError ? cause.toJSON() : { code: 'PROTOCOL_MESSAGE_INVALID', message: cause instanceof Error ? cause.message : 'Viewer action failed', retryable: false } }, false, false)
  }
  #dispatch(name: string, detail: unknown, cancelable = false, bubbles = true): boolean {
    return this.dispatchEvent(new CustomEvent(name, { detail, bubbles, composed: bubbles, cancelable }))
  }
}

function normalizeUrl(value: string): string {
  return /^[a-z][a-z\d+.-]*:/iu.test(value) ? value : `https://${value}`
}

function modifiers(event: MouseEvent | KeyboardEvent): number {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0)
}

function pointerButton(button: number): 'none' | 'left' | 'middle' | 'right' | 'back' | 'forward' {
  if (button === 0) return 'left'
  if (button === 1) return 'middle'
  if (button === 2) return 'right'
  if (button === 3) return 'back'
  if (button === 4) return 'forward'
  return 'none'
}

function formatBytes(value: number, locale: 'zh-CN' | 'en-US'): string {
  if (value < 1024) return `${value} B`
  const units = ['KB', 'MB', 'GB'] as const
  let amount = value
  let unit: (typeof units)[number] = units[0]
  for (const candidate of units) {
    amount /= 1024
    unit = candidate
    if (amount < 1024 || candidate === 'GB') break
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: amount < 10 ? 1 : 0 }).format(amount)} ${unit}`
}

async function readLocalClipboardItems(
  capabilities: readonly Capability[],
): Promise<readonly RemoteTabClipboardWriteItem[]> {
  const clipboard = navigator.clipboard
  if (clipboard === undefined) throw new Error('Clipboard API is unavailable')
  const canReadText = capabilities.includes('clipboardText')
  const canReadImage = capabilities.includes('clipboardImage')
  const result: RemoteTabClipboardWriteItem[] = []
  if (typeof clipboard.read === 'function') {
    const localItems = await clipboard.read()
    let hasText = false
    let hasImage = false
    for (const localItem of localItems) {
      if (canReadText && !hasText && localItem.types.includes('text/plain')) {
        result.push({ mimeType: 'text/plain', data: await localItem.getType('text/plain') })
        hasText = true
      }
      if (canReadImage && !hasImage) {
        const imageType = localItem.types.includes('image/png')
          ? 'image/png'
          : localItem.types.find((type) => type.startsWith('image/'))
        if (imageType !== undefined) {
          const source = await localItem.getType(imageType)
          result.push({
            mimeType: 'image/png',
            data: imageType === 'image/png' ? source : await convertImageToPng(source),
          })
          hasImage = true
        }
      }
      if ((!canReadText || hasText) && (!canReadImage || hasImage)) break
    }
  } else if (canReadText && typeof clipboard.readText === 'function') {
    result.push({ mimeType: 'text/plain', data: await clipboard.readText() })
  }
  if (result.length === 0) throw new Error('Clipboard has no supported text or image content')
  return result
}

async function writeLocalClipboardItems(items: readonly RemoteTabClipboardItem[]): Promise<void> {
  const clipboard = navigator.clipboard
  if (clipboard === undefined) throw new Error('Clipboard API is unavailable')
  const representations: Record<string, Blob> = {}
  for (const item of items) representations[item.mimeType] = item.blob
  if (typeof clipboard.write === 'function' && typeof ClipboardItem !== 'undefined') {
    await clipboard.write([new ClipboardItem(representations)])
    return
  }
  const text = items.find((item) => item.mimeType === 'text/plain')
  if (text !== undefined && typeof clipboard.writeText === 'function' && items.length === 1) {
    await clipboard.writeText(new TextDecoder().decode(text.data))
    return
  }
  throw new Error('This browser cannot write the remote clipboard content')
}

async function convertImageToPng(source: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(source)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (context === null) throw new Error('Canvas is unavailable')
    context.drawImage(bitmap, 0, 0)
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => blob === null ? reject(new Error('Could not encode clipboard image')) : resolve(blob),
        'image/png',
      )
    })
  } finally {
    bitmap.close()
  }
}
