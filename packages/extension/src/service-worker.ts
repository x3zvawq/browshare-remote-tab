/// <reference types="chrome" />

import {
  decodeExtensionLoopbackMessage,
  encodeExtensionLoopbackMessage,
  type ExtensionLoopbackMessage,
  type RemoteTabErrorCode,
} from '@browshare/remote-tab-protocol'
import {
  parseManagedRuntimeConfiguration,
  loadRuntimeInstanceId,
  type RuntimeConfiguration,
} from './runtime-config.js'

const OFFSCREEN_URL = 'offscreen.html'
const APPLICATION_ERROR_CLOSE_CODE = 4_000
let socket: WebSocket | undefined
let reconnectTimer: ReturnType<typeof setTimeout> | undefined
let stopped = false
let cachedConfiguration: RuntimeConfiguration | undefined
let startPromise: Promise<void> | undefined
let startRequested = false

chrome.runtime.onInstalled.addListener(() => startRuntime())
chrome.runtime.onStartup.addListener(() => startRuntime())
// On a fresh force-install, Chrome can start the worker before its managed
// schema has loaded the policy values. The change event also wakes a suspended
// worker; a timer alone cannot reliably recover that initial configuration.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (
    areaName === 'managed' &&
    cachedConfiguration === undefined &&
    ['loopbackUrl', 'runtimeSecret', 'runtimeGeneration'].some((key) => key in changes)
  ) {
    startRuntime()
  }
})
chrome.runtime.onSuspend.addListener(() => {
  socket?.close(1000, 'Service worker suspended')
})
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (isRecord(message) && message.type === 'runtime.get-config') {
    void loadConfiguration()
      .then((configuration) => sendResponse({ ok: true, configuration }))
      .catch(() => sendResponse({ ok: false }))
    return true
  }
  return false
})

startRuntime()

function startRuntime(): void {
  if (startPromise !== undefined) {
    startRequested = true
    return
  }
  startPromise = start()
    .catch((cause: unknown) => {
      console.error(cause instanceof Error ? cause.message : 'Remote Tab Extension failed to start')
    })
    .finally(() => {
      startPromise = undefined
      const retryConfiguration = startRequested && cachedConfiguration === undefined
      startRequested = false
      if (retryConfiguration) {
        startRuntime()
      }
    })
}

async function start(): Promise<void> {
  stopped = false
  const configuration = await loadConfiguration()
  await ensureOffscreenDocument()
  connectLoopback(configuration)
}

async function loadConfiguration(): Promise<RuntimeConfiguration> {
  if (cachedConfiguration !== undefined) {
    return cachedConfiguration
  }
  const values = await chrome.storage.managed.get([
    'loopbackUrl',
    'runtimeSecret',
    'runtimeGeneration',
  ])
  cachedConfiguration = {
    ...parseManagedRuntimeConfiguration(values),
    runtimeInstanceId: await loadRuntimeInstanceId(),
  }
  return cachedConfiguration
}

async function ensureOffscreenDocument(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) {
    return
  }
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Capture an Embedder-authorized Chrome tab and publish it over WebRTC',
  })
}

function connectLoopback(configuration: RuntimeConfiguration): void {
  clearTimeout(reconnectTimer)
  socket?.close()
  const next = new WebSocket(configuration.loopbackUrl)
  socket = next
  next.addEventListener('open', () => {
    send({
      type: 'runtime.bind',
      role: 'service-worker',
      secret: configuration.runtimeSecret,
      extensionId: chrome.runtime.id,
      // Injected from extension/manifest.json at build time. Offscreen documents cannot call
      // chrome.runtime.getManifest(), so both runtime roles share this context-neutral source.
      extensionVersion: __BROWSHARE_EXTENSION_VERSION__,
      runtimeGeneration: configuration.runtimeGeneration,
      runtimeInstanceId: configuration.runtimeInstanceId,
    })
  })
  next.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') {
      next.close(APPLICATION_ERROR_CLOSE_CODE, 'Text protocol required')
      return
    }
    let message: ExtensionLoopbackMessage
    try {
      message = decodeExtensionLoopbackMessage(event.data)
    } catch {
      next.close(APPLICATION_ERROR_CLOSE_CODE, 'Invalid loopback message')
      return
    }
    void handleMessage(message)
  })
  next.addEventListener('close', () => {
    if (socket === next) {
      socket = undefined
    }
    if (!stopped) {
      reconnectTimer = setTimeout(() => connectLoopback(configuration), 1_000)
    }
  })
}

async function handleMessage(message: ExtensionLoopbackMessage): Promise<void> {
  if (message.type === 'runtime.ping') {
    send({ type: 'runtime.pong', nonce: message.nonce })
    return
  }
  if (message.type === 'target.resolve') {
    await resolveTarget(message)
    return
  }
  if (message.type === 'capture.prepare') {
    await prepareCapture(message)
  }
}

async function resolveTarget(
  message: Extract<ExtensionLoopbackMessage, { type: 'target.resolve' }>,
): Promise<void> {
  try {
    const target = (await chrome.debugger.getTargets()).find(
      (candidate) => candidate.id === message.targetId && typeof candidate.tabId === 'number',
    )
    if (target?.tabId === undefined) {
      sendFailure(
        'target.resolve_failed',
        message,
        'TARGET_MAPPING_FAILED',
        'Chrome target does not map to a capturable tab',
      )
      return
    }
    send({
      type: 'target.resolved',
      requestId: message.requestId,
      targetId: message.targetId,
      tabId: target.tabId,
    })
  } catch {
    sendFailure(
      'target.resolve_failed',
      message,
      'TARGET_MAPPING_FAILED',
      'Chrome target mapping failed',
      true,
    )
  }
}

async function prepareCapture(
  message: Extract<ExtensionLoopbackMessage, { type: 'capture.prepare' }>,
): Promise<void> {
  try {
    const target = (await chrome.debugger.getTargets()).find(
      (candidate) => candidate.id === message.targetId && candidate.tabId === message.tabId,
    )
    if (target === undefined) {
      sendFailure(
        'capture.prepare_failed',
        message,
        'TARGET_MAPPING_FAILED',
        'Chrome target-to-tab mapping changed before capture',
      )
      return
    }
    await ensureOffscreenDocument()
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: message.tabId })
    send({
      type: 'capture.prepared',
      requestId: message.requestId,
      sessionId: message.sessionId,
      streamId,
    })
  } catch {
    sendFailure(
      'capture.prepare_failed',
      message,
      'CAPTURE_DENIED',
      'Chrome denied tab capture',
    )
  }
}

function sendFailure(
  type: 'target.resolve_failed' | 'capture.prepare_failed',
  request: { requestId: string; targetId?: string; sessionId?: string },
  code: RemoteTabErrorCode,
  message: string,
  retryable = false,
): void {
  const error = { code, message, retryable }
  if (type === 'target.resolve_failed' && request.targetId !== undefined) {
    send({
      type,
      requestId: request.requestId,
      targetId: request.targetId,
      error,
    })
  } else if (type === 'capture.prepare_failed' && request.sessionId !== undefined) {
    send({
      type,
      requestId: request.requestId,
      sessionId: request.sessionId,
      error,
    })
  }
}

function send(message: ExtensionLoopbackMessage): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(encodeExtensionLoopbackMessage(message))
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
