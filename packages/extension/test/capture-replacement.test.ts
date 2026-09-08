import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  decodeExtensionLoopbackMessage,
  encodeExtensionLoopbackMessage,
  type ExtensionLoopbackMessage,
} from '@browshare/remote-tab-protocol'

class Track extends EventTarget {
  enabled = true
  readyState = 'live'
  contentHint = ''
  constructor(readonly kind: 'audio' | 'video') { super() }
  stop(): void { this.readyState = 'ended' }
}
class Stream {
  readonly tracks = [new Track('audio'), new Track('video')]
  getTracks() { return this.tracks }
  getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio') }
  getVideoTracks() { return this.tracks.filter(t => t.kind === 'video') }
}
class Channel extends EventTarget {
  readyState = 'open'
  constructor(readonly label: string) { super() }
  close(): void { this.readyState = 'closed'; this.dispatchEvent(new Event('close')) }
}
class Sender {
  replaceTrack = vi.fn(async (track: Track) => { this.track = track })
  constructor(public track: Track) {}
  private parameters = { encodings: [{ active: true }] }
  getParameters() { return structuredClone(this.parameters) }
  async setParameters(parameters: typeof this.parameters) { this.parameters = structuredClone(parameters) }
}
class Peer extends EventTarget {
  connectionState = 'connected'
  readonly senders: Sender[] = []
  readonly channels: Channel[] = []
  addTrack(track: Track) { const sender = new Sender(track); this.senders.push(sender); return sender }
  getSenders() { return this.senders }
  createDataChannel(label: string) { const channel = new Channel(label); this.channels.push(channel); return channel }
  close() { this.connectionState = 'closed' }
}

async function runtime(windowSelection = false) {
  vi.resetModules()
  const output: ExtensionLoopbackMessage[] = []
  let socket!: EventTarget
  let peer!: Peer
  class Socket extends EventTarget {
    static OPEN = 1
    readyState = 1
    constructor() { super(); socket = this }
    send(raw: string) { output.push(decodeExtensionLoopbackMessage(raw)) }
  }
  vi.stubGlobal('WebSocket', Socket)
  vi.stubGlobal('RTCPeerConnection', class extends Peer { constructor() { super(); peer = this } })
  vi.stubGlobal('chrome', { runtime: { sendMessage: async () => ({ ok: true, configuration: {
    loopbackUrl: 'ws://127.0.0.1:1234', runtimeSecret: 'a'.repeat(32), runtimeGeneration: 'runtime', runtimeInstanceId: 'instance',
  } }) } })
  const initial = new Stream()
  const acquire = vi.fn().mockResolvedValue(initial)
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: acquire } })
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  await import('../src/offscreen.js')
  await vi.waitFor(() => expect(socket).toBeDefined())
  const send = (message: ExtensionLoopbackMessage) => {
    socket.dispatchEvent(new MessageEvent('message', { data: encodeExtensionLoopbackMessage(message) }))
  }
  const viewport = { width: 900, height: 600, deviceScaleFactor: 1, frameRate: 15, revision: 1 }
  send({ type: 'media.start', sessionId: 'session', viewerGeneration: 2, tabId: 1,
    streamId: 'initial', capabilities: windowSelection ? ['windowSelection'] : [],
    ...(windowSelection ? { captureRevision: 0 } : {}), iceServers: [], iceTransportPolicy: 'all', viewport, audio: true })
  await vi.waitFor(() => expect(peer?.channels).toHaveLength(3))
  const replace = (requestId = 'replace') => send({ type: 'media.replace_capture', sessionId: 'session',
    viewerGeneration: 2, requestId, streamId: 'next', viewport, audio: true,
    ...(windowSelection ? { captureRevision: 1 } : {}) })
  const waitFor = async (type: ExtensionLoopbackMessage['type']) => {
    await vi.waitFor(() => expect(output.some(m => m.type === type)).toBe(true))
  }
  return { initial, acquire, peer, output, send, replace, waitFor }
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('offscreen capture replacement lifecycle', () => {
  it('retains the peer after a revision-bound selected capture ends so Core can return to its root', async () => {
    const r = await runtime(true)
    r.initial.getVideoTracks()[0]!.stop()
    r.initial.getVideoTracks()[0]!.dispatchEvent(new Event('ended'))
    await r.waitFor('media.capture_ended')
    expect(r.output).toContainEqual({ type: 'media.capture_ended', sessionId: 'session', viewerGeneration: 2, captureRevision: 0 })
    expect(r.peer.connectionState).toBe('connected')
    const next = new Stream()
    r.acquire.mockResolvedValueOnce(next)
    r.replace()
    await r.waitFor('media.capture_replaced')
    r.initial.getVideoTracks()[0]!.dispatchEvent(new Event('ended'))
    expect(r.output.filter(m => m.type === 'media.capture_ended')).toHaveLength(1)
    next.getVideoTracks()[0]!.stop()
    next.getVideoTracks()[0]!.dispatchEvent(new Event('ended'))
    expect(r.output).toContainEqual({ type: 'media.capture_ended', sessionId: 'session', viewerGeneration: 2, captureRevision: 1 })
    r.send({ type: 'media.stop', requestId: 'stop', sessionId: 'session', reason: 'done' })
    await r.waitFor('media.stopped')
    expect(r.peer.connectionState).toBe('closed')
  })

  it('keeps the previous capture when acquisition fails and preserves suspension on success', async () => {
    const r = await runtime()
    r.acquire.mockRejectedValueOnce(new Error('capture denied'))
    r.replace('failed')
    await r.waitFor('media.capture_replace_failed')
    expect(r.initial.tracks.every(t => t.readyState === 'live')).toBe(true)
    expect(r.peer.connectionState).toBe('connected')
    r.send({ type: 'media.suspend', sessionId: 'session' })
    await r.waitFor('media.suspension_changed')
    expect(r.peer.senders.every(sender => !sender.getParameters().encodings[0]!.active)).toBe(true)
    const next = new Stream()
    r.acquire.mockResolvedValueOnce(next)
    r.replace()
    await r.waitFor('media.capture_replaced')
    expect(next.tracks.every(t => !t.enabled)).toBe(true)
    expect(r.initial.tracks.every(t => t.readyState === 'ended')).toBe(true)
    r.initial.getVideoTracks()[0]!.dispatchEvent(new Event('ended'))
    expect(r.peer.connectionState).toBe('connected')
    r.send({ type: 'media.resume', sessionId: 'session' })
    await vi.waitFor(() => expect(next.tracks.every(t => t.enabled)).toBe(true))
    expect(r.peer.senders.every(sender => sender.getParameters().encodings[0]!.active)).toBe(true)
    next.getVideoTracks()[0]!.dispatchEvent(new Event('ended'))
    expect(r.peer.connectionState).toBe('closed')
    expect(next.tracks.every(t => t.readyState === 'ended')).toBe(true)
  })

  it('closes all media after a partial sender replacement failure', async () => {
    const r = await runtime(), next = new Stream()
    r.acquire.mockResolvedValueOnce(next)
    r.peer.senders[1]!.replaceTrack.mockRejectedValueOnce(new Error('replaceTrack failed'))
    r.replace()
    await r.waitFor('media.capture_replace_failed')
    expect(r.peer.senders[0]!.track).toBe(next.getAudioTracks()[0])
    expect(r.peer.connectionState).toBe('closed')
    expect(r.peer.channels.every(c => c.readyState === 'closed')).toBe(true)
    expect([...next.tracks, ...r.initial.tracks].every(t => t.readyState === 'ended')).toBe(true)
    expect(r.output.some(m => m.type === 'media.capture_replaced')).toBe(false)
  })

  it('waits for late capture cleanup before acknowledging stop and rejects concurrent replacement', async () => {
    const r = await runtime(), next = new Stream()
    let resolve!: (stream: Stream) => void
    r.acquire.mockReturnValueOnce(new Promise<Stream>(done => { resolve = done }))
    r.replace()
    r.replace('concurrent')
    await r.waitFor('media.capture_replace_failed')
    expect(r.acquire).toHaveBeenCalledTimes(2)
    r.send({ type: 'media.stop', requestId: 'stop', sessionId: 'session', reason: 'closed' })
    expect(r.peer.connectionState).toBe('closed')
    expect(r.output.some(m => m.type === 'media.stopped')).toBe(false)
    resolve(next)
    await r.waitFor('media.stopped')
    expect(next.tracks.every(t => t.readyState === 'ended')).toBe(true)
    expect(r.output.some(m => m.type === 'media.capture_replaced')).toBe(false)
  })
})
