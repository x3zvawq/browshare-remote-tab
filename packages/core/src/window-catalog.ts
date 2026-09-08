import {
  createProtocolMessage, encodeProtocolMessage, RemoteTabError,
  type ProtocolPayload, type WindowState,
} from '@browshare/remote-tab-protocol'

// Keep catalog frames below the interoperable 16 KiB DataChannel message size.
const WINDOW_FRAME_BYTES = 16 * 1024

export function splitWindowState(
  state: WindowState,
  catalogRevision: number,
  sessionId: string,
  viewerGeneration: number,
): ProtocolPayload<'window.state'>[] {
  const { windows, ...selection } = state
  const frames: ProtocolPayload<'window.state'>[] = []
  let frame: ProtocolPayload<'window.state'> = { ...selection, catalogRevision, offset: 0, total: windows.length, windows: [] }
  const fits = (candidate: ProtocolPayload<'window.state'>): boolean => {
    // Reserve the largest sequence encoding; the Session allocates each real sequence on send.
    return encodeProtocolMessage(createProtocolMessage('window.state', {
      sessionId, viewerGeneration, sequence: Number.MAX_SAFE_INTEGER,
    }, candidate)).byteLength <= WINDOW_FRAME_BYTES
  }
  for (const window of windows) {
    const candidate = { ...frame, windows: [...frame.windows, window] }
    if (candidate.windows.length <= 128 && fits(candidate)) { frame = candidate; continue }
    if (frame.windows.length === 0) throw new RemoteTabError('PROTOCOL_MESSAGE_TOO_LARGE', 'Window display entry exceeds the catalog frame limit')
    frames.push(frame)
    frame = { ...frame, offset: frame.offset + frame.windows.length, windows: [window] }
    if (!fits(frame)) throw new RemoteTabError('PROTOCOL_MESSAGE_TOO_LARGE', 'Window display entry exceeds the catalog frame limit')
  }
  if (frame.windows.length > 0) frames.push(frame)
  return frames
}
