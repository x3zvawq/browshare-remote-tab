import type { IceCandidateSummary } from './signaling.js'

export type IceRelayProtocol = 'udp' | 'tcp' | 'tls'

export interface SelectedIceCandidatePairSummary {
  localCandidateType?: IceCandidateSummary['candidateType']
  remoteCandidateType?: IceCandidateSummary['candidateType']
  protocol?: IceCandidateSummary['protocol']
  relayProtocol?: IceRelayProtocol
}

interface CandidateStats {
  type: 'local-candidate' | 'remote-candidate'
  candidateType?: string
  protocol?: string
  relayProtocol?: string
}

interface CandidatePairStats {
  type: 'candidate-pair'
  state?: string
  nominated?: boolean
  localCandidateId?: string
  remoteCandidateId?: string
}

interface TransportStats {
  type: 'transport'
  selectedCandidatePairId?: string
}

/** Returns the selected route without exposing either peer's address, port or candidate ID. */
export function summarizeSelectedIceCandidatePair(
  report: RTCStatsReport,
): SelectedIceCandidatePairSummary | undefined {
  const records = new Map<string, RTCStats>()
  report.forEach((record) => records.set(record.id, record))
  const transport = [...records.values()].find(
    (record): record is RTCStats & TransportStats => record.type === 'transport',
  )
  const selectedId = transport?.selectedCandidatePairId
  const pair =
    (selectedId === undefined ? undefined : records.get(selectedId)) ??
    [...records.values()].find(
      (record) =>
        record.type === 'candidate-pair' &&
        (record as RTCStats & CandidatePairStats).state === 'succeeded' &&
        (record as RTCStats & CandidatePairStats).nominated === true,
    )
  if (pair?.type !== 'candidate-pair') return undefined

  const candidatePair = pair as RTCStats & CandidatePairStats
  const local = readCandidateStats(records, candidatePair.localCandidateId, 'local-candidate')
  const remote = readCandidateStats(records, candidatePair.remoteCandidateId, 'remote-candidate')
  const localCandidateType = sanitizeCandidateType(local?.candidateType)
  const remoteCandidateType = sanitizeCandidateType(remote?.candidateType)
  const protocol = sanitizeProtocol(local?.protocol ?? remote?.protocol)
  const relayProtocol = sanitizeRelayProtocol(local?.relayProtocol ?? remote?.relayProtocol)
  return {
    ...(localCandidateType === undefined ? {} : { localCandidateType }),
    ...(remoteCandidateType === undefined ? {} : { remoteCandidateType }),
    ...(protocol === undefined ? {} : { protocol }),
    ...(relayProtocol === undefined ? {} : { relayProtocol }),
  }
}

function readCandidateStats(
  records: ReadonlyMap<string, RTCStats>,
  id: string | undefined,
  type: CandidateStats['type'],
): (RTCStats & CandidateStats) | undefined {
  if (id === undefined) return undefined
  const record = records.get(id)
  return record?.type === type ? (record as RTCStats & CandidateStats) : undefined
}

function sanitizeCandidateType(
  value: string | undefined,
): IceCandidateSummary['candidateType'] | undefined {
  return value === 'host' || value === 'srflx' || value === 'prflx' || value === 'relay'
    ? value
    : undefined
}

function sanitizeProtocol(value: string | undefined): IceCandidateSummary['protocol'] | undefined {
  const normalized = value?.toLowerCase()
  return normalized === 'udp' || normalized === 'tcp' ? normalized : undefined
}

function sanitizeRelayProtocol(value: string | undefined): IceRelayProtocol | undefined {
  const normalized = value?.toLowerCase()
  return normalized === 'udp' || normalized === 'tcp' || normalized === 'tls'
    ? normalized
    : undefined
}
