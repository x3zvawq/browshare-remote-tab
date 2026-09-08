import type { MediaQualitySettings, Viewport } from '@browshare/remote-tab-protocol'
import type { SessionMediaLimits } from './contracts.js'

export function normalizeMediaLimits(input?: SessionMediaLimits): SessionMediaLimits {
  const limits = { ...(input ?? { maxWidth: 1920, maxHeight: 1080, maxFrameRate: 60, maxBitrate: null }) }
  const ranges: readonly (readonly [number, number, number])[] = [
    [limits.maxWidth, 1, 1920], [limits.maxHeight, 1, 1080], [limits.maxFrameRate, 1, 60],
    ...(limits.maxBitrate === null ? [] : [[limits.maxBitrate, 100_000, 20_000_000] as const]),
  ]
  for (const [value, min, max] of ranges) {
    if (!Number.isInteger(value) || value < min || value > max) throw new RangeError('Invalid Session media limits')
  }
  return limits
}

export function limitViewport<T extends Omit<Viewport, 'revision'>>(viewport: T, limits: SessionMediaLimits): T {
  return { ...viewport, width: Math.min(viewport.width, limits.maxWidth),
    height: Math.min(viewport.height, limits.maxHeight), frameRate: Math.min(viewport.frameRate, limits.maxFrameRate) }
}

export function limitQuality(settings: MediaQualitySettings, limits: SessionMediaLimits): MediaQualitySettings {
  return { ...settings, maxFrameRate: Math.min(settings.maxFrameRate, limits.maxFrameRate),
    maxBitrate: Math.min(settings.maxBitrate, limits.maxBitrate ?? settings.maxBitrate) }
}
