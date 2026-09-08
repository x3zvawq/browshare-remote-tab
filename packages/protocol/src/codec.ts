import { decode, encode } from '@msgpack/msgpack'
import Type from 'typebox'
import Schema from 'typebox/schema'

import { RemoteTabError } from './errors.js'
import {
  ProtocolPayloadSchemas,
  type ProtocolMessageType,
  type ProtocolPayload,
} from './schemas.js'
import { assessProtocolVersion, PROTOCOL_VERSION } from './version.js'

export const MAX_PROTOCOL_MESSAGE_BYTES = 1_048_576

const EnvelopeSchema = Type.Object(
  {
    version: Type.Integer({ minimum: 0 }),
    minor: Type.Integer({ minimum: 0 }),
    type: Type.String({ minLength: 1, maxLength: 128 }),
    sessionId: Type.String({ minLength: 1, maxLength: 128 }),
    viewerGeneration: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    sequence: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    windowRevision: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    payload: Type.Unknown(),
  },
  { additionalProperties: false },
)

const envelopeValidator = Schema.Compile(EnvelopeSchema)

interface RuntimeValidator {
  Check(value: unknown): boolean
}

const payloadValidators: ReadonlyMap<string, RuntimeValidator> = new Map(
  Object.entries(ProtocolPayloadSchemas).map(([type, schema]) => [type, Schema.Compile(schema)]),
)

export interface ProtocolEnvelopeMetadata {
  sessionId: string
  viewerGeneration: number
  sequence: number
  minor?: number
  windowRevision?: number
}

export interface ProtocolEnvelope<TypeName extends ProtocolMessageType = ProtocolMessageType> {
  version: number
  minor: number
  type: TypeName
  sessionId: string
  viewerGeneration: number
  sequence: number
  windowRevision?: number
  payload: ProtocolPayload<TypeName>
}

export type ProtocolMessage = {
  [TypeName in ProtocolMessageType]: ProtocolEnvelope<TypeName>
}[ProtocolMessageType]

export type UnknownMessagePolicy = 'reject' | 'ignore'

export interface DecodeProtocolMessageOptions {
  maxBytes?: number
  unknownMessage?: UnknownMessagePolicy
}

export function createProtocolMessage<TypeName extends ProtocolMessageType>(
  type: TypeName,
  metadata: ProtocolEnvelopeMetadata,
  payload: ProtocolPayload<TypeName>,
): ProtocolEnvelope<TypeName> {
  return {
    version: PROTOCOL_VERSION.major,
    minor: metadata.minor ?? PROTOCOL_VERSION.minor,
    type,
    sessionId: metadata.sessionId,
    viewerGeneration: metadata.viewerGeneration,
    sequence: metadata.sequence,
    ...(metadata.windowRevision === undefined ? {} : { windowRevision: metadata.windowRevision }),
    payload,
  }
}

export function encodeProtocolMessage(
  message: ProtocolMessage,
  maxBytes: number = MAX_PROTOCOL_MESSAGE_BYTES,
): Uint8Array {
  validateKnownMessage(message)

  const encoded = encode(message)
  assertMessageSize(encoded.byteLength, maxBytes)
  return encoded
}

export function decodeProtocolMessage(
  data: Uint8Array,
  options: DecodeProtocolMessageOptions = {},
): ProtocolMessage | undefined {
  const maxBytes = options.maxBytes ?? MAX_PROTOCOL_MESSAGE_BYTES
  assertMessageSize(data.byteLength, maxBytes)

  let value: unknown
  try {
    value = decode(data)
  } catch (cause) {
    throw new RemoteTabError('PROTOCOL_DECODE_FAILED', 'MessagePack payload could not be decoded', {
      cause,
    })
  }

  if (!envelopeValidator.Check(value)) {
    throw new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Protocol envelope is invalid')
  }

  const envelope = value as Type.Static<typeof EnvelopeSchema>
  const compatibility = assessProtocolVersion({
    major: envelope.version,
    minor: envelope.minor,
  })

  if (!compatibility.compatible) {
    throw new RemoteTabError(
      'PROTOCOL_VERSION_UNSUPPORTED',
      `Protocol major ${envelope.version} is not supported`,
    )
  }

  const validator = payloadValidators.get(envelope.type)
  if (validator === undefined) {
    if (options.unknownMessage === 'ignore') {
      return undefined
    }

    throw new RemoteTabError(
      'PROTOCOL_MESSAGE_UNKNOWN',
      `Protocol message type ${envelope.type} is not recognized`,
    )
  }

  if (!validator.Check(envelope.payload)) {
    throw new RemoteTabError(
      'PROTOCOL_MESSAGE_INVALID',
      `Payload for ${envelope.type} is invalid`,
    )
  }

  validateBinaryPayload(envelope.type, envelope.payload)

  return envelope as ProtocolMessage
}

function validateKnownMessage(message: ProtocolMessage): void {
  if (!envelopeValidator.Check(message)) {
    throw new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Protocol envelope is invalid')
  }

  const compatibility = assessProtocolVersion({ major: message.version, minor: message.minor })
  if (!compatibility.compatible) {
    throw new RemoteTabError(
      'PROTOCOL_VERSION_UNSUPPORTED',
      `Protocol major ${message.version} is not supported`,
    )
  }

  const validator = payloadValidators.get(message.type)
  if (validator === undefined || !validator.Check(message.payload)) {
    throw new RemoteTabError(
      'PROTOCOL_MESSAGE_INVALID',
      `Payload for ${message.type} is invalid`,
    )
  }
  validateBinaryPayload(message.type, message.payload)
}

function validateBinaryPayload(type: string, payload: unknown): void {
  if (
    type !== 'file.upload.chunk' &&
    type !== 'file.download.chunk' &&
    type !== 'clipboard.write.chunk' &&
    type !== 'clipboard.read.chunk'
  ) return
  const data =
    typeof payload === 'object' && payload !== null && 'data' in payload
      ? (payload as { data?: unknown }).data
      : undefined
  if (!(data instanceof Uint8Array) || data.byteLength > 262_144) {
    throw new RemoteTabError(
      'PROTOCOL_MESSAGE_INVALID',
      'Transfer chunk data must be a bounded binary value',
    )
  }
}

function assertMessageSize(actual: number, maximum: number): void {
  if (!Number.isSafeInteger(maximum) || maximum <= 0) {
    throw new RangeError('maxBytes must be a positive safe integer')
  }

  if (actual > maximum) {
    throw new RemoteTabError(
      'PROTOCOL_MESSAGE_TOO_LARGE',
      `Protocol message is ${actual} bytes; maximum is ${maximum}`,
    )
  }
}

/** Commands whose meaning depends on the currently selected remote window. */
export function isWindowScopedMessage(type: ProtocolMessageType): boolean {
  return type.startsWith('input.') || type === 'navigation.request' || type === 'viewport.request' ||
    type.startsWith('file.upload.') || type.startsWith('clipboard.') || (type === 'window.select' || type === 'window.close')
}
