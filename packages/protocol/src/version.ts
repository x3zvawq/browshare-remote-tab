export interface ProtocolVersion {
  major: number
  minor: number
}

export type ProtocolVersionRelationship = 'same' | 'remote-older' | 'remote-newer' | 'incompatible'

export interface ProtocolCompatibility {
  compatible: boolean
  relationship: ProtocolVersionRelationship
  local: ProtocolVersion
  remote: ProtocolVersion
}

export const PROTOCOL_VERSION = Object.freeze({ major: 1, minor: 4 }) satisfies ProtocolVersion

export function assessProtocolVersion(remote: ProtocolVersion): ProtocolCompatibility {
  let relationship: ProtocolVersionRelationship

  if (remote.major !== PROTOCOL_VERSION.major) {
    relationship = 'incompatible'
  } else if (remote.minor < PROTOCOL_VERSION.minor) {
    relationship = 'remote-older'
  } else if (remote.minor > PROTOCOL_VERSION.minor) {
    relationship = 'remote-newer'
  } else {
    relationship = 'same'
  }

  return {
    compatible: relationship !== 'incompatible',
    relationship,
    local: PROTOCOL_VERSION,
    remote,
  }
}
