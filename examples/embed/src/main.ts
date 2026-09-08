import { defineRemoteTabViewer, type RemoteTabViewerElement } from '@browshare/remote-tab-viewer'

import './styles.css'

defineRemoteTabViewer()

const form = required<HTMLFormElement>('connection-form')
const endpoint = required<HTMLInputElement>('endpoint')
const ticket = required<HTMLTextAreaElement>('ticket')
const backgroundStreaming = required<HTMLInputElement>('background-streaming')
const disconnect = required<HTMLButtonElement>('disconnect')
const suspend = required<HTMLButtonElement>('suspend')
const resume = required<HTMLButtonElement>('resume')
const host = required<HTMLElement>('viewer-host')
const eventList = required<HTMLOListElement>('events')
let viewer: RemoteTabViewerElement | undefined

form.addEventListener('submit', (event) => {
  event.preventDefault()
  viewer?.remove()
  viewer = document.createElement('browshare-tab-viewer') as RemoteTabViewerElement
  viewer.setAttribute('endpoint', endpoint.value.trim())
  viewer.setAttribute('ticket', ticket.value.trim())
  viewer.setAttribute('locale', 'zh-CN')
  viewer.setAttribute('suspend-when-unfocused', String(!backgroundStreaming.checked))
  for (const name of [
    'viewer-ready',
    'local-open-request',
    'clipboard-write-request',
    'clipboard-read-request',
    'clipboard-progress',
    'clipboard-write-complete',
    'clipboard-read-complete',
    'page-script-event',
    'diagnostic',
    'error',
  ]) {
    viewer.addEventListener(name, (viewerEvent) => appendEvent(name, (viewerEvent as CustomEvent).detail))
  }
  viewer.addEventListener('connection-state-change', (viewerEvent) => {
    const detail = (viewerEvent as CustomEvent<{ state: string }>).detail
    syncLifecycleControls(detail.state)
    appendEvent('connection-state-change', detail)
  })
  viewer.addEventListener('session-close-request', () => appendEvent('session-close-request', { note: 'Embedder 应在此调用自己的结束 Session API' }))
  host.replaceChildren(viewer)
  ticket.value = ''
  disconnect.disabled = false
  syncLifecycleControls()
})

disconnect.addEventListener('click', () => {
  viewer?.remove()
  viewer = undefined
  disconnect.disabled = true
  syncLifecycleControls()
  host.innerHTML = '<div class="empty"><span>⌁</span><strong>Viewer 已断开</strong><p>单次 Ticket 已被消费；再次连接前请申请新的 Ticket。</p></div>'
  appendEvent('viewer-disconnected', {})
})

suspend.addEventListener('click', () => void invokeViewerAction('suspend'))
resume.addEventListener('click', () => void invokeViewerAction('resume'))

async function invokeViewerAction(action: 'suspend' | 'resume'): Promise<void> {
  try {
    await viewer?.[action]()
  } catch (cause) {
    appendEvent('error', {
      code: 'VIEWER_ACTION_FAILED',
      message: cause instanceof Error ? cause.message : 'Viewer action failed',
    })
  }
}

function syncLifecycleControls(state?: string): void {
  suspend.disabled = viewer === undefined || state !== 'CONNECTED'
  resume.disabled = viewer === undefined || state !== 'SUSPENDED'
}

function appendEvent(name: string, detail: unknown): void {
  const entry = document.createElement('li')
  const time = document.createElement('time')
  time.textContent = new Date().toLocaleTimeString()
  const message = document.createElement('code')
  message.textContent = `${name} ${JSON.stringify(detail)}`
  entry.append(time, message)
  eventList.prepend(entry)
  while (eventList.children.length > 12) eventList.lastElementChild?.remove()
}

function required<ElementType extends HTMLElement>(id: string): ElementType {
  const element = document.getElementById(id)
  if (element === null) throw new Error(`Example is missing #${id}`)
  return element as ElementType
}
