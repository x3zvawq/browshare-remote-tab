import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import WebSocket, { WebSocketServer } from 'ws'
import { describe, expect, it, vi } from 'vitest'

import { CdpBrowser } from '../src/index.js'

interface RecordedCommand {
  id: number
  method: string
  params?: Record<string, unknown>
  sessionId?: string
}

describe('CdpBrowser', () => {
  it('creates, maps, controls, observes, and closes exactly one target', async () => {
    const commands: RecordedCommand[] = []
    let acknowledgeChildClose: (() => void) | undefined
    let childCloseObserved: (() => void) | undefined
    const childClosing = new Promise<void>((resolve) => { childCloseObserved = resolve })
    const server = createServer()
    const sockets = new Set<WebSocket>()
    const webSocketServer = new WebSocketServer({ noServer: true })

    server.on('request', (request, response) => {
      if (request.url !== '/json/version') {
        response.writeHead(404).end()
        return
      }
      const address = server.address() as AddressInfo
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/devtools/browser/mock` }),
      )
    })
    server.on('upgrade', (request, socket, head) => {
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit('connection', webSocket, request)
      })
    })
    webSocketServer.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      socket.on('message', (data) => {
        const command = JSON.parse(data.toString()) as RecordedCommand
        commands.push(command)
        if (command.method === 'Target.closeTarget' && command.params?.targetId === 'grandchild-target') {
          acknowledgeChildClose = () => socket.send(JSON.stringify({ id: command.id, result: { success: true } }))
          childCloseObserved!()
          return
        }

        let result: unknown = {}
        if (command.method === 'Browser.getVersion') {
          result = {
            protocolVersion: '1.3',
            product: 'Chrome/152.0.7977.75',
            revision: '@revision',
            userAgent: 'Mozilla/5.0 Chrome/152.0.7977.75',
            jsVersion: '15.2.1',
          }
        } else if (command.method === 'Target.createTarget') {
          result = { targetId: 'target-1' }
        } else if (command.method === 'Target.getTargets') {
          // Snapshot order is unspecified; destruction can arrive before its reply.
          socket.send(JSON.stringify({ method: 'Target.targetDestroyed', params: { targetId: 'initial-opener' } }))
          result = { targetInfos: [
            { targetId: 'initial-grandchild', type: 'page', openerId: 'initial-opener', title: 'Existing grandchild', url: 'https://example.com/child' },
            { targetId: 'initial-opener', type: 'page', openerId: 'target-1', url: 'https://example.com/opener' },
            { targetId: 'initial-unrelated', type: 'page', openerId: 'other-root', url: 'https://example.com/other' },
            { targetId: 'target-1', type: 'page', url: 'https://example.com/' },
          ] }
        } else if (command.method === 'Target.closeTarget') {
          result = { success: true }
        } else if (command.method === 'Target.attachToTarget') {
          result = { sessionId: 'cdp-session-1' }
        } else if (command.method === 'Page.getNavigationHistory') {
          result = { currentIndex: 1, entries: [{ id: 10 }, { id: 11 }, { id: 12 }] }
        }
        socket.send(JSON.stringify({ id: command.id, result }))
      })
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    const resolver = { resolveTabId: vi.fn(async () => 44) }
    const browser = await CdpBrowser.connect(`http://127.0.0.1:${address.port}`, {
      requestTimeoutMs: 1_000,
      downloadDirectory: '/tmp/remote-tab-downloads',
    })

    try {
      await expect(browser.getVersion()).resolves.toEqual({
        protocolVersion: '1.3',
        product: 'Chrome/152.0.7977.75',
        revision: '@revision',
        userAgent: 'Mozilla/5.0 Chrome/152.0.7977.75',
        jsVersion: '15.2.1',
      })
      const attached = await browser.attachTab(
        { mode: 'create', initialUrl: 'https://example.com/' },
        resolver,
      )

      expect(attached.targetId).toBe('target-1')
      expect(attached.tabId).toBe(44)
      expect(attached.controller.getChildTargets()).toEqual([
        { targetId: 'initial-grandchild', title: 'Existing grandchild', url: 'https://example.com/child' },
      ])
      expect(attached.controller.ownsTarget('initial-opener')).toBe(false)
      expect(attached.controller.ownsTarget('initial-unrelated')).toBe(false)

      expect(resolver.resolveTabId).toHaveBeenCalledWith({ targetId: 'target-1' })

      const viewport = await attached.controller.setViewport({
        width: 1280,
        height: 720,
        deviceScaleFactor: 1,
      })
      expect(viewport.revision).toBe(1)

      await attached.controller.dispatchPointer({
        type: 'mousePressed',
        x: 120,
        y: 80,
        viewportRevision: viewport.revision,
        button: 'left',
        buttons: 1,
        modifiers: 0,
        clickCount: 1,
      })
      await attached.controller.dispatchKey({
        type: 'keyDown',
        key: 'a',
        code: 'KeyA',
        modifiers: 0,
      })
      await attached.controller.insertText('输入')
      await attached.controller.setFileInputFiles(321, ['/tmp/session/file.txt'])
      expect(await attached.controller.goHistory('back')).toBe(true)

      const location = new Promise<string>((resolve) => {
        const unsubscribe = attached.controller.onEvent((event) => {
          if (event.type !== 'location-changed') return
          unsubscribe()
          resolve(event.url)
        })
      })
      for (const socket of sockets) {
        socket.send(
          JSON.stringify({
            method: 'Page.frameNavigated',
            sessionId: 'cdp-session-1',
            params: { frame: { id: 'frame-1', url: 'https://example.com/next' } },
          }),
        )
      }
      await expect(location).resolves.toBe('https://example.com/next')

      const chooser = new Promise<{ backendNodeId: number; multiple: boolean }>((resolve) => {
        const unsubscribe = attached.controller.onEvent((event) => {
          if (event.type !== 'file-chooser-opened') return
          unsubscribe()
          resolve(event)
        })
      })
      for (const socket of sockets) {
        socket.send(
          JSON.stringify({
            method: 'Page.fileChooserOpened',
            sessionId: 'cdp-session-1',
            params: { backendNodeId: 654, mode: 'selectMultiple' },
          }),
        )
      }
      await expect(chooser).resolves.toMatchObject({ backendNodeId: 654, multiple: true })

      const childTarget = new Promise<{ targetId: string; url?: string }>((resolve) => {
        const unsubscribe = attached.controller.onEvent((event) => {
          if (event.type !== 'child-target-created') return
          unsubscribe()
          resolve(event)
        })
      })
      for (const socket of sockets) {
        socket.send(
          JSON.stringify({
            method: 'Page.windowOpen',
            sessionId: 'cdp-session-1',
            params: { url: 'https://example.com/local', windowName: '_blank' },
          }),
        )
        socket.send(
          JSON.stringify({
            method: 'Target.targetCreated',
            params: {
              targetInfo: {
                targetId: 'child-target-1',
                type: 'page',
                url: '',
                openerId: 'target-1',
              },
            },
          }),
        )
      }
      await expect(childTarget).resolves.toEqual({
        type: 'child-target-created',
        targetId: 'child-target-1',
        url: 'https://example.com/local',
      })
      const interceptedOpen = new Promise<{ url: string }>((resolve) => {
        const unsubscribe = attached.controller.onEvent((event) => {
          if (event.type !== 'local-open-requested') return
          unsubscribe()
          resolve(event)
        })
      })
      await attached.controller.enableLocalOpenInterception()
      for (const socket of sockets) {
        socket.send(
          JSON.stringify({
            method: 'Runtime.bindingCalled',
            sessionId: 'cdp-session-1',
            params: {
              name: '__browshareRemoteTabOpen',
              payload: JSON.stringify({ url: 'https://example.com/intercepted' }),
            },
          }),
        )
      }
      await expect(interceptedOpen).resolves.toEqual({
        type: 'local-open-requested',
        url: 'https://example.com/intercepted',
      })

      const completedDownload = new Promise<{
        guid: string
        displayName: string
        localPath: string
        totalBytes: number
      }>((resolve) => {
        const unsubscribe = attached.controller.onEvent((event) => {
          if (event.type !== 'download-completed') return
          unsubscribe()
          resolve(event)
        })
      })
      for (const socket of sockets) {
        socket.send(
          JSON.stringify({
            method: 'Page.downloadWillBegin',
            sessionId: 'cdp-session-1',
            params: { guid: 'download-guid-1', suggestedFilename: '../report.txt' },
          }),
        )
        socket.send(
          JSON.stringify({
            method: 'Page.downloadProgress',
            sessionId: 'cdp-session-1',
            params: { guid: 'download-guid-1', receivedBytes: 23, state: 'completed' },
          }),
        )
      }
      await expect(completedDownload).resolves.toEqual({
        type: 'download-completed',
        guid: 'download-guid-1',
        displayName: '../report.txt',
        localPath: '/tmp/remote-tab-downloads/download-guid-1',
        totalBytes: 23,
      })
      await attached.controller.removeDownload('download-guid-1')
      await attached.controller.closeChildTarget('child-target-1')
      for (const socket of sockets) {
        socket.send(
          JSON.stringify({
            method: 'Target.targetCreated',
            params: {
              targetInfo: {
                targetId: 'child-target-2',
                type: 'page',
                url: 'https://example.com/retained',
                openerId: 'target-1',
              },
            },
          }),
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 0))

      for (const socket of sockets) {
        for (const [targetId, openerId] of [
          ['grandchild-target', 'child-target-2'],
          ['unrelated-child', 'other-session-target'],
        ]) {
          socket.send(JSON.stringify({
            method: 'Target.targetCreated',
            params: { targetInfo: { targetId, openerId, type: 'page', url: 'https://example.com/popup' } },
          }))
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 0))

      await expect(
        attached.controller.dispatchPointer({
          type: 'mouseMoved',
          x: 1,
          y: 1,
          viewportRevision: 0,
          button: 'none',
          buttons: 0,
          modifiers: 0,
          clickCount: 0,
        }),
      ).rejects.toMatchObject({ code: 'VIEWPORT_STALE' })

      const closing = attached.controller.close()
      await childClosing
      expect(attached.controller.ownsTarget('grandchild-target')).toBe(true)
      acknowledgeChildClose!()
      await closing
      expect(attached.controller.ownsTarget('grandchild-target')).toBe(false)

      expect(commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: 'Target.closeTarget',
            params: { targetId: 'child-target-2' },
          }),
          expect.objectContaining({ method: 'Target.closeTarget', params: { targetId: 'grandchild-target' } }),
        ]),
      )
      expect(commands).not.toContainEqual(expect.objectContaining({
        method: 'Target.closeTarget', params: { targetId: 'unrelated-child' },
      }))

      expect(commands.map((command) => command.method)).toEqual(
        expect.arrayContaining([
          'Target.createTarget',
          'Browser.setDownloadBehavior',
          'Target.attachToTarget',
          'Target.setDiscoverTargets',
          'Page.enable',
          'Runtime.enable',
          'DOM.enable',
          'Page.setInterceptFileChooserDialog',
          'Emulation.setDeviceMetricsOverride',
          'Input.dispatchMouseEvent',
          'Input.dispatchKeyEvent',
          'Input.insertText',
          'DOM.setFileInputFiles',
          'Runtime.addBinding',
          'Page.addScriptToEvaluateOnNewDocument',
          'Page.getNavigationHistory',
          'Page.navigateToHistoryEntry',
          'Target.detachFromTarget',
          'Target.closeTarget',
        ]),
      )
      expect(
        commands.find((command) => command.method === 'Input.dispatchMouseEvent')?.sessionId,
      ).toBe('cdp-session-1')
    } finally {
      browser.close()
      for (const socket of sockets) {
        socket.terminate()
      }
      await new Promise<void>((resolve) => webSocketServer.close(() => resolve()))
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      })
    }
  })
})
