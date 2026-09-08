import { describe, expect, it } from 'vitest'

import {
  createProtocolMessage,
  encodeProtocolMessage,
  type ProtocolMessage,
} from '@browshare/remote-tab-protocol'

import { decodeBoundViewerControl } from '../src/viewer-control.js'

describe('decodeBoundViewerControl', () => {
  it('accepts only the Publisher Session and Viewer generation', () => {
    const valid = encode('session.suspend', 'session-a', 7, {})
    expect(
      decodeBoundViewerControl(valid, {
        sessionId: 'session-a',
        viewerGeneration: 7,
      }, 'control-reliable'),
    ).toMatchObject({ type: 'session.suspend', sessionId: 'session-a', viewerGeneration: 7 })

    const foreignSession = encode('session.suspend', 'session-b', 7, {})
    expect(() =>
      decodeBoundViewerControl(foreignSession, {
        sessionId: 'session-a',
        viewerGeneration: 7,
      }, 'control-reliable'),
    ).toThrow(expect.objectContaining({ code: 'VIEWER_REPLACED' }))

    const staleGeneration = encode('session.suspend', 'session-a', 6, {})
    expect(() =>
      decodeBoundViewerControl(staleGeneration, {
        sessionId: 'session-a',
        viewerGeneration: 7,
      }, 'control-reliable'),
    ).toThrow(expect.objectContaining({ code: 'VIEWER_REPLACED' }))
  })

  it('keeps reliable, realtime, and transfer semantics separated', () => {
    const quality = encode('quality.configure', 'session-a', 7, {
      requestId: 'quality-1', configuration: { mode: 'auto' },
    })
    const binding = { sessionId: 'session-a', viewerGeneration: 7 }
    expect(decodeBoundViewerControl(quality, binding, 'control-reliable')).toMatchObject({ type: 'quality.configure' })
    expect(() => decodeBoundViewerControl(quality, binding, 'control-realtime'))
      .toThrow(expect.objectContaining({ code: 'PROTOCOL_MESSAGE_INVALID' }))
    const key = encode('input.key', 'session-a', 7, {
      event: 'keyDown',
      key: 'a',
      code: 'KeyA',
      modifiers: 0,
    })
    expect(() =>
      decodeBoundViewerControl(key, {
        sessionId: 'session-a',
        viewerGeneration: 7,
      }, 'control-realtime'),
    ).toThrow(expect.objectContaining({ code: 'PROTOCOL_MESSAGE_INVALID' }))

    const upload = encode('file.upload.complete', 'session-a', 7, {
      transferId: 'transfer-1',
    })
    expect(() =>
      decodeBoundViewerControl(upload, {
        sessionId: 'session-a',
        viewerGeneration: 7,
      }, 'control-reliable'),
    ).toThrow(expect.objectContaining({ code: 'PROTOCOL_MESSAGE_INVALID' }))
    expect(
      decodeBoundViewerControl(upload, {
        sessionId: 'session-a',
        viewerGeneration: 7,
      }, 'file-transfer'),
    ).toMatchObject({ type: 'file.upload.complete' })
  })
})

function encode<TypeName extends Parameters<typeof createProtocolMessage>[0]>(
  type: TypeName,
  sessionId: string,
  viewerGeneration: number,
  payload: Parameters<typeof createProtocolMessage<TypeName>>[2],
): ArrayBuffer {
  const encoded = encodeProtocolMessage(
    createProtocolMessage(
      type,
      { sessionId, viewerGeneration, sequence: 1 },
      payload,
    ) as ProtocolMessage,
  )
  return encoded.slice().buffer as ArrayBuffer
}
