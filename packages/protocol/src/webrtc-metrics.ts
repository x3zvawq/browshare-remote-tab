export type WebRtcMediaDirection = 'inbound' | 'outbound'
export type WebRtcMediaKind = 'audio' | 'video'
export type WebRtcQualityLimitationReason = 'none' | 'cpu' | 'bandwidth' | 'other'

export interface WebRtcMediaMetrics {
  name: 'webrtc.media-metrics'
  direction: WebRtcMediaDirection
  kind: WebRtcMediaKind
  codec?: string
  frameWidth?: number
  frameHeight?: number
  framesPerSecond?: number
  bitrateBps?: number
  packetsLost?: number
  packetLossRatio?: number
  framesDropped?: number
  jitterMs?: number
  roundTripTimeMs?: number
  qualityLimitationReason?: WebRtcQualityLimitationReason
  sampleIntervalMs?: number
}

export interface DataChannelMetrics {
  name: 'data-channel.metrics'
  label: 'control-reliable' | 'control-realtime' | 'file-transfer'
  bufferedAmount: number
}

export interface WebRtcMetricsHistoryEntry {
  timestamp: number
  bytes: number
  packets: number
  packetsLost: number
}

export type WebRtcMetricsHistory = ReadonlyMap<string, WebRtcMetricsHistoryEntry>

export interface WebRtcMediaMetricsSample {
  metrics: readonly WebRtcMediaMetrics[]
  history: WebRtcMetricsHistory
}

interface RtpStats {
  id: string
  type: 'inbound-rtp' | 'outbound-rtp'
  timestamp?: number
  kind?: string
  mediaType?: string
  codecId?: string
  remoteId?: string
  bytesReceived?: number
  bytesSent?: number
  packetsReceived?: number
  packetsSent?: number
  packetsLost?: number
  framesDropped?: number
  framesPerSecond?: number
  frameWidth?: number
  frameHeight?: number
  jitter?: number
  qualityLimitationReason?: string
}

interface RemoteInboundRtpStats {
  id: string
  type: 'remote-inbound-rtp'
  localId?: string
  packetsReceived?: number
  packetsLost?: number
  jitter?: number
  roundTripTime?: number
}

interface CodecStats {
  type: 'codec'
  mimeType?: string
}

interface CandidatePairStats {
  type: 'candidate-pair'
  state?: string
  nominated?: boolean
  currentRoundTripTime?: number
}

interface TransportStats {
  type: 'transport'
  selectedCandidatePairId?: string
}

/**
 * Reduces browser RTCStats to bounded media telemetry. Stats IDs remain only in the returned
 * in-memory history and are never copied into a metric event.
 */
export function summarizeWebRtcMediaMetrics(
  report: RTCStatsReport,
  direction: WebRtcMediaDirection,
  previous: WebRtcMetricsHistory = new Map(),
): WebRtcMediaMetricsSample {
  const records = new Map<string, RTCStats>()
  report.forEach((record) => records.set(record.id, record))
  const nextHistory = new Map<string, WebRtcMetricsHistoryEntry>()
  const connectionRttMs = readConnectionRttMs(records)
  const expectedType = direction === 'inbound' ? 'inbound-rtp' : 'outbound-rtp'
  const metrics: WebRtcMediaMetrics[] = []

  for (const raw of records.values()) {
    if (raw.type !== expectedType) continue
    const record = raw as RTCStats & RtpStats
    const kind = sanitizeKind(record.kind ?? record.mediaType)
    const timestamp = finiteNonNegative(record.timestamp)
    const bytes = finiteNonNegative(
      direction === 'inbound' ? record.bytesReceived : record.bytesSent,
    )
    if (kind === undefined || timestamp === undefined || bytes === undefined) continue

    const remote =
      direction === 'outbound' ? findRemoteInbound(records, record) : undefined
    const packets = finiteNonNegative(
      direction === 'inbound'
        ? record.packetsReceived
        : remote?.packetsReceived ?? record.packetsSent,
    ) ?? 0
    const packetsLost = finiteNonNegative(
      direction === 'inbound' ? record.packetsLost : remote?.packetsLost,
    ) ?? 0
    const historyKey = `${direction}:${record.id}`
    const old = previous.get(historyKey)
    const intervalMs =
      old !== undefined && timestamp > old.timestamp ? timestamp - old.timestamp : undefined
    const bitrateBps =
      intervalMs !== undefined && bytes >= old!.bytes
        ? Math.round(((bytes - old!.bytes) * 8_000) / intervalMs)
        : undefined
    const packetLossRatio = calculatePacketLossRatio(old, packets, packetsLost)
    const codec = readCodec(records, record.codecId)
    const jitterMs = secondsToMilliseconds(
      direction === 'inbound' ? record.jitter : remote?.jitter,
    )
    const roundTripTimeMs =
      secondsToMilliseconds(remote?.roundTripTime) ?? connectionRttMs
    const qualityLimitationReason = sanitizeQualityLimitationReason(
      record.qualityLimitationReason,
    )

    metrics.push({
      name: 'webrtc.media-metrics',
      direction,
      kind,
      ...(codec === undefined ? {} : { codec }),
      ...numberField('frameWidth', record.frameWidth),
      ...numberField('frameHeight', record.frameHeight),
      ...numberField('framesPerSecond', record.framesPerSecond),
      ...(bitrateBps === undefined ? {} : { bitrateBps }),
      ...(packetsLost === 0 ? {} : { packetsLost }),
      ...(packetLossRatio === undefined ? {} : { packetLossRatio }),
      ...numberField('framesDropped', record.framesDropped),
      ...(jitterMs === undefined ? {} : { jitterMs }),
      ...(roundTripTimeMs === undefined ? {} : { roundTripTimeMs }),
      ...(qualityLimitationReason === undefined ? {} : { qualityLimitationReason }),
      ...(intervalMs === undefined ? {} : { sampleIntervalMs: Math.round(intervalMs) }),
    })
    nextHistory.set(historyKey, { timestamp, bytes, packets, packetsLost })
  }

  metrics.sort((left, right) => left.kind.localeCompare(right.kind))
  return { metrics, history: nextHistory }
}

function findRemoteInbound(
  records: ReadonlyMap<string, RTCStats>,
  outbound: RtpStats,
): (RTCStats & RemoteInboundRtpStats) | undefined {
  const byId = outbound.remoteId === undefined ? undefined : records.get(outbound.remoteId)
  if (byId?.type === 'remote-inbound-rtp') {
    return byId as RTCStats & RemoteInboundRtpStats
  }
  return [...records.values()].find(
    (record): record is RTCStats & RemoteInboundRtpStats =>
      record.type === 'remote-inbound-rtp' &&
      (record as RTCStats & RemoteInboundRtpStats).localId === outbound.id,
  )
}

function readCodec(records: ReadonlyMap<string, RTCStats>, codecId: string | undefined): string | undefined {
  if (codecId === undefined) return undefined
  const record = records.get(codecId)
  if (record?.type !== 'codec') return undefined
  const mimeType = (record as RTCStats & CodecStats).mimeType?.trim()
  return mimeType === undefined || mimeType.length === 0 ? undefined : mimeType.slice(0, 64)
}

function readConnectionRttMs(records: ReadonlyMap<string, RTCStats>): number | undefined {
  const transport = [...records.values()].find(
    (record): record is RTCStats & TransportStats => record.type === 'transport',
  )
  const selected =
    transport?.selectedCandidatePairId === undefined
      ? undefined
      : records.get(transport.selectedCandidatePairId)
  const pair =
    selected?.type === 'candidate-pair'
      ? (selected as RTCStats & CandidatePairStats)
      : ([...records.values()].find(
          (record) =>
            record.type === 'candidate-pair' &&
            (record as RTCStats & CandidatePairStats).state === 'succeeded' &&
            (record as RTCStats & CandidatePairStats).nominated === true,
        ) as (RTCStats & CandidatePairStats) | undefined)
  return secondsToMilliseconds(pair?.currentRoundTripTime)
}

function calculatePacketLossRatio(
  previous: WebRtcMetricsHistoryEntry | undefined,
  packets: number,
  packetsLost: number,
): number | undefined {
  if (previous === undefined || packets < previous.packets || packetsLost < previous.packetsLost) {
    return undefined
  }
  const delivered = packets - previous.packets
  const lost = packetsLost - previous.packetsLost
  const total = delivered + lost
  return total === 0 ? undefined : round(lost / total, 6)
}

function sanitizeKind(value: string | undefined): WebRtcMediaKind | undefined {
  return value === 'audio' || value === 'video' ? value : undefined
}

function sanitizeQualityLimitationReason(
  value: string | undefined,
): WebRtcQualityLimitationReason | undefined {
  return value === 'none' || value === 'cpu' || value === 'bandwidth' || value === 'other'
    ? value
    : undefined
}

function secondsToMilliseconds(value: number | undefined): number | undefined {
  const seconds = finiteNonNegative(value)
  return seconds === undefined ? undefined : round(seconds * 1_000, 3)
}

function numberField<Name extends 'frameWidth' | 'frameHeight' | 'framesPerSecond' | 'framesDropped'>(
  name: Name,
  value: number | undefined,
): Partial<Record<Name, number>> {
  const safe = finiteNonNegative(value)
  return safe === undefined ? {} : ({ [name]: round(safe, 3) } as Partial<Record<Name, number>>)
}

function finiteNonNegative(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision
  return Math.round(value * factor) / factor
}
