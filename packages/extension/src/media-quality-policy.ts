import type { EncodingSettings, QualityConfiguration, WebRtcMediaMetrics } from '@browshare/remote-tab-protocol'

export interface AutomaticQualityHistory {
  pressureSamples: number
  healthySamples: number
}

export function boundEncoding(settings: EncodingSettings, limits: EncodingSettings): EncodingSettings {
  return {
    maxBitrate: Math.min(settings.maxBitrate, limits.maxBitrate),
    maxFrameRate: Math.min(settings.maxFrameRate, limits.maxFrameRate),
    scaleResolutionDownBy: Math.max(settings.scaleResolutionDownBy, limits.scaleResolutionDownBy),
  }
}

export function configuredEncoding(configuration: QualityConfiguration, limits: EncodingSettings): EncodingSettings {
  const settings = configuration.mode === 'custom' ? configuration :
    configuration.mode === 'preset' && configuration.preset === 'data-saver'
      ? { maxBitrate: 750_000, maxFrameRate: 15, scaleResolutionDownBy: 2 }
      : configuration.mode === 'preset' && configuration.preset === 'high'
        ? { maxBitrate: 6_000_000, maxFrameRate: 60, scaleResolutionDownBy: 1 }
        : { maxBitrate: 2_500_000, maxFrameRate: 30, scaleResolutionDownBy: 1 }
  return boundEncoding(settings, limits)
}

/** Chrome congestion control reacts immediately; these slower changes reduce sustained capture/encoding work. */
export function adaptEncoding(
  metrics: WebRtcMediaMetrics | undefined,
  current: EncodingSettings,
  ceiling: EncodingSettings,
  history: AutomaticQualityHistory,
): EncodingSettings | undefined {
  if (metrics?.sampleIntervalMs === undefined || metrics.sampleIntervalMs < 1_000 || metrics.sampleIntervalMs > 15_000) {
    history.pressureSamples = 0
    history.healthySamples = 0
    return
  }
  // Low FPS/bitrate alone is normal for static pages and is deliberately not a pressure signal.
  const pressure = metrics.qualityLimitationReason === 'cpu' || metrics.qualityLimitationReason === 'bandwidth' ||
    (metrics.packetLossRatio ?? 0) >= 0.05 || (metrics.roundTripTimeMs ?? 0) >= 400
  const healthy = metrics.qualityLimitationReason === 'none' &&
    (metrics.packetLossRatio ?? 0) < 0.01 && metrics.roundTripTimeMs !== undefined && metrics.roundTripTimeMs < 200
  history.pressureSamples = pressure ? history.pressureSamples + 1 : 0
  history.healthySamples = healthy ? history.healthySamples + 1 : 0
  let next: EncodingSettings | undefined
  if (history.pressureSamples >= 3) {
    history.pressureSamples = 0
    next = {
      maxBitrate: Math.max(Math.min(250_000, ceiling.maxBitrate), Math.round(current.maxBitrate * 0.7)),
      maxFrameRate: Math.max(Math.min(5, ceiling.maxFrameRate), Math.floor(current.maxFrameRate * 0.8)),
      scaleResolutionDownBy: Math.min(Math.max(4, ceiling.scaleResolutionDownBy), current.scaleResolutionDownBy * 1.25),
    }
  } else if (history.healthySamples >= 6) {
    history.healthySamples = 0
    next = boundEncoding({
      maxBitrate: Math.ceil(current.maxBitrate / 0.7),
      maxFrameRate: Math.ceil(current.maxFrameRate / 0.8),
      scaleResolutionDownBy: Math.max(1, current.scaleResolutionDownBy / 1.25),
    }, ceiling)
  }
  if (next !== undefined && (next.maxBitrate !== current.maxBitrate || next.maxFrameRate !== current.maxFrameRate ||
      next.scaleResolutionDownBy !== current.scaleResolutionDownBy)) return next
}
