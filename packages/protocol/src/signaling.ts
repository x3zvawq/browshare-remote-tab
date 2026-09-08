import Type from 'typebox'
import Schema from 'typebox/schema'

import { CapabilityListSchema } from './capabilities.js'
import { RemoteTabError, RemoteTabErrorShapeSchema } from './errors.js'

export const MAX_SIGNALING_MESSAGE_BYTES = 262_144

const IdentifierSchema = Type.String({ minLength: 1, maxLength: 128 })
const TokenSchema = Type.String({ minLength: 1, maxLength: 16_384 })

export const IceServerSchema = Type.Object(
  {
    urls: Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), {
      minItems: 1,
      maxItems: 16,
    }),
    username: Type.Optional(Type.String({ maxLength: 1024 })),
    credential: Type.Optional(Type.String({ maxLength: 4096 })),
  },
  { additionalProperties: false },
)

export type IceServer = Type.Static<typeof IceServerSchema>

export const IceTransportPolicySchema = Type.Enum(['all', 'relay'] as const)
export type IceTransportPolicy = Type.Static<typeof IceTransportPolicySchema>

export const SessionDescriptionSchema = Type.Object(
  {
    type: Type.Union([Type.Literal('offer'), Type.Literal('answer')]),
    sdp: Type.String({ minLength: 1, maxLength: 196_608 }),
  },
  { additionalProperties: false },
)

export type SessionDescription = Type.Static<typeof SessionDescriptionSchema>

export const IceCandidateSchema = Type.Object(
  {
    candidate: Type.String({ maxLength: 8192 }),
    sdpMid: Type.Union([Type.String({ maxLength: 256 }), Type.Null()]),
    sdpMLineIndex: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    usernameFragment: Type.Optional(Type.String({ maxLength: 1024 })),
  },
  { additionalProperties: false },
)

export type IceCandidate = Type.Static<typeof IceCandidateSchema>

export interface IceCandidateSummary {
  candidateType?: 'host' | 'srflx' | 'prflx' | 'relay'
  protocol?: 'udp' | 'tcp'
  tcpType?: 'active' | 'passive' | 'so'
}

/**
 * Extracts only routing metadata that is safe to include in diagnostics. Candidate addresses,
 * ports, foundations and credentials are deliberately excluded.
 */
export function summarizeIceCandidate(candidate: string): IceCandidateSummary {
  const fields = candidate.trim().split(/\s+/u)
  const protocol = fields[2]?.toLowerCase()
  const typeIndex = fields.findIndex((field) => field.toLowerCase() === 'typ')
  const candidateType = typeIndex === -1 ? undefined : fields[typeIndex + 1]?.toLowerCase()
  const tcpTypeIndex = fields.findIndex((field) => field.toLowerCase() === 'tcptype')
  const tcpType = tcpTypeIndex === -1 ? undefined : fields[tcpTypeIndex + 1]?.toLowerCase()

  return {
    ...(isCandidateType(candidateType) ? { candidateType } : {}),
    ...(protocol === 'udp' || protocol === 'tcp' ? { protocol } : {}),
    ...(isTcpType(tcpType) ? { tcpType } : {}),
  }
}

export const SignalingMessageSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal('viewer.bind'),
      ticket: TokenSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('core.bind'),
      bindingToken: TokenSchema,
      sessionId: IdentifierSchema,
      viewerGeneration: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      gatewayId: IdentifierSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('signal.description'),
      description: SessionDescriptionSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('signal.ice'),
      candidate: IceCandidateSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal('signal.restart-ice') },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('signal.ready'),
      role: Type.Union([Type.Literal('core'), Type.Literal('viewer')]),
      sessionId: IdentifierSchema,
      viewerGeneration: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      capabilities: CapabilityListSchema,
      iceServers: Type.Array(IceServerSchema, { maxItems: 16 }),
      iceTransportPolicy: Type.Optional(IceTransportPolicySchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal('signal.peer-ready') },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('signal.peer-left'),
      role: Type.Union([Type.Literal('core'), Type.Literal('viewer')]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('signal.error'),
      error: RemoteTabErrorShapeSchema,
    },
    { additionalProperties: false },
  ),
])

export type SignalingMessage = Type.Static<typeof SignalingMessageSchema>

const signalingMessageValidator = Schema.Compile(SignalingMessageSchema)

export function decodeSignalingMessage(
  input: string | Uint8Array,
  maxBytes: number = MAX_SIGNALING_MESSAGE_BYTES,
): SignalingMessage {
  const byteLength =
    typeof input === 'string' ? new TextEncoder().encode(input).byteLength : input.byteLength
  assertSignalingSize(byteLength, maxBytes)

  let value: unknown
  try {
    value = JSON.parse(typeof input === 'string' ? input : new TextDecoder().decode(input))
  } catch (cause) {
    throw new RemoteTabError('PROTOCOL_DECODE_FAILED', 'Signaling message is not valid JSON', {
      cause,
    })
  }

  if (!signalingMessageValidator.Check(value)) {
    throw new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Signaling message is invalid')
  }
  return value
}

export function encodeSignalingMessage(
  message: SignalingMessage,
  maxBytes: number = MAX_SIGNALING_MESSAGE_BYTES,
): string {
  if (!signalingMessageValidator.Check(message)) {
    throw new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Signaling message is invalid')
  }
  const value = JSON.stringify(message)
  assertSignalingSize(new TextEncoder().encode(value).byteLength, maxBytes)
  return value
}

function assertSignalingSize(actual: number, maximum: number): void {
  if (!Number.isSafeInteger(maximum) || maximum <= 0) {
    throw new RangeError('maxBytes must be a positive safe integer')
  }
  if (actual > maximum) {
    throw new RemoteTabError(
      'PROTOCOL_MESSAGE_TOO_LARGE',
      `Signaling message is ${actual} bytes; maximum is ${maximum}`,
    )
  }
}

function isCandidateType(value: string | undefined): value is NonNullable<IceCandidateSummary['candidateType']> {
  return value === 'host' || value === 'srflx' || value === 'prflx' || value === 'relay'
}

function isTcpType(value: string | undefined): value is NonNullable<IceCandidateSummary['tcpType']> {
  return value === 'active' || value === 'passive' || value === 'so'
}
