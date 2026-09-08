import {
  decodeProtocolMessage,
  RemoteTabError,
  type ProtocolMessage,
  type ProtocolMessageType,
} from '@browshare/remote-tab-protocol'

export type ViewerControlChannel =
  | 'control-reliable'
  | 'control-realtime'
  | 'file-transfer'

export interface ViewerControlBinding {
  sessionId: string
  viewerGeneration: number
}

const RELIABLE_VIEWER_MESSAGES = new Set<ProtocolMessageType>([
  'hello',
  'window.select',
  'window.close',
  'session.suspend',
  'session.resume',
  'input.pointer',
  'input.key',
  'input.composition',
  'navigation.request',
  'navigation.local_open_result',
  'notice.response',
  'viewport.request',
  'quality.request',
  'quality.configure',
])

const REALTIME_VIEWER_MESSAGES = new Set<ProtocolMessageType>(['input.pointer'])

export function decodeBoundViewerControl(
  data: ArrayBuffer,
  binding: ViewerControlBinding,
  channel: ViewerControlChannel,
): ProtocolMessage {
  const message = decodeProtocolMessage(new Uint8Array(data))
  if (message === undefined) {
    throw new RemoteTabError(
      'PROTOCOL_MESSAGE_INVALID',
      'Viewer sent an unsupported control message',
    )
  }
  if (
    message.sessionId !== binding.sessionId ||
    message.viewerGeneration !== binding.viewerGeneration
  ) {
    throw new RemoteTabError(
      'VIEWER_REPLACED',
      'Viewer control envelope does not match its Publisher binding',
    )
  }
  if (!isViewerMessageAllowedOnChannel(message.type, channel)) {
    throw new RemoteTabError(
      'PROTOCOL_MESSAGE_INVALID',
      'Viewer control message used the wrong DataChannel',
    )
  }
  return message
}

function isViewerMessageAllowedOnChannel(
  type: ProtocolMessageType,
  channel: ViewerControlChannel,
): boolean {
  if (channel === 'control-reliable') return RELIABLE_VIEWER_MESSAGES.has(type)
  if (channel === 'control-realtime') return REALTIME_VIEWER_MESSAGES.has(type)
  return type.startsWith('file.') || type.startsWith('clipboard.')
}
