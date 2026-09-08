import { describe, expect, it } from 'vitest'

import { mapPointerToViewport } from '../src/index.js'

const viewport = { width: 1920, height: 1080, deviceScaleFactor: 1, frameRate: 60, revision: 2 }

describe('mapPointerToViewport', () => {
  it('maps contained video content and rejects letterbox input', () => {
    expect(mapPointerToViewport({ clientX: 500, clientY: 300, left: 0, top: 0, width: 1000, height: 600, viewport })).toEqual({ x: 960, y: 540 })
    expect(mapPointerToViewport({ clientX: 500, clientY: 10, left: 0, top: 0, width: 1000, height: 600, viewport })).toBeUndefined()
  })
})
