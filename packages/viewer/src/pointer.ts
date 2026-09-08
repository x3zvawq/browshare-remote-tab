import type { Viewport } from '@browshare/remote-tab-protocol'

export interface PointerMappingInput {
  clientX: number
  clientY: number
  left: number
  top: number
  width: number
  height: number
  viewport: Viewport
}

export function mapPointerToViewport(input: PointerMappingInput): { x: number; y: number } | undefined {
  if (input.width <= 0 || input.height <= 0) return undefined
  const remoteRatio = input.viewport.width / input.viewport.height
  const surfaceRatio = input.width / input.height
  const contentWidth = surfaceRatio > remoteRatio ? input.height * remoteRatio : input.width
  const contentHeight = surfaceRatio > remoteRatio ? input.height : input.width / remoteRatio
  const contentLeft = input.left + (input.width - contentWidth) / 2
  const contentTop = input.top + (input.height - contentHeight) / 2
  const relativeX = input.clientX - contentLeft
  const relativeY = input.clientY - contentTop
  if (relativeX < 0 || relativeY < 0 || relativeX > contentWidth || relativeY > contentHeight) return undefined
  return {
    x: Math.min(input.viewport.width, Math.max(0, (relativeX / contentWidth) * input.viewport.width)),
    y: Math.min(input.viewport.height, Math.max(0, (relativeY / contentHeight) * input.viewport.height)),
  }
}
