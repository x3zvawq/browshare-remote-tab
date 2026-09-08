import Type from 'typebox'
import Schema from 'typebox/schema'

import { CapabilityListSchema } from './capabilities.js'
import { RemoteTabError, RemoteTabErrorShapeSchema } from './errors.js'
import { EncodingSettingsSchema, QualityConfigurationSchema, QualityStateSchema, MediaQualitySettingsSchema, ViewportSchema } from './schemas.js'
import {
  IceCandidateSchema,
  IceServerSchema,
  IceTransportPolicySchema,
  SessionDescriptionSchema,
} from './signaling.js'

export const MAX_LOOPBACK_MESSAGE_BYTES = 1_048_576

const IdentifierSchema = Type.String({ minLength: 1, maxLength: 128 })

const WebRtcMediaMetricsSchema = Type.Object(
  {
    name: Type.Literal('webrtc.media-metrics'),
    direction: Type.Enum(['inbound', 'outbound'] as const),
    kind: Type.Enum(['audio', 'video'] as const),
    codec: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    frameWidth: Type.Optional(Type.Number({ minimum: 0, maximum: 16_384 })),
    frameHeight: Type.Optional(Type.Number({ minimum: 0, maximum: 16_384 })),
    framesPerSecond: Type.Optional(Type.Number({ minimum: 0, maximum: 1_000 })),
    bitrateBps: Type.Optional(Type.Number({ minimum: 0, maximum: 100_000_000_000 })),
    packetsLost: Type.Optional(Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    packetLossRatio: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    framesDropped: Type.Optional(Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    jitterMs: Type.Optional(Type.Number({ minimum: 0, maximum: 600_000 })),
    roundTripTimeMs: Type.Optional(Type.Number({ minimum: 0, maximum: 600_000 })),
    qualityLimitationReason: Type.Optional(
      Type.Enum(['none', 'cpu', 'bandwidth', 'other'] as const),
    ),
    sampleIntervalMs: Type.Optional(Type.Number({ minimum: 1, maximum: 600_000 })),
  },
  { additionalProperties: false },
)

const DataChannelMetricsSchema = Type.Object(
  {
    name: Type.Literal('data-channel.metrics'),
    label: Type.Enum(['control-reliable', 'control-realtime', 'file-transfer'] as const),
    bufferedAmount: Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
)

export const ExtensionMediaDiagnosticSchema = Type.Union([
  WebRtcMediaMetricsSchema,
  DataChannelMetricsSchema,
])

export type ExtensionMediaDiagnostic = Type.Static<typeof ExtensionMediaDiagnosticSchema>

export const ExtensionLoopbackMessageSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal('runtime.bind'),
      role: Type.Enum(['service-worker', 'media'] as const),
      secret: Type.String({ minLength: 32, maxLength: 4096 }),
      extensionId: Type.String({ pattern: '^[a-p]{32}$' }),
      extensionVersion: Type.String({ minLength: 1, maxLength: 64 }),
      runtimeGeneration: IdentifierSchema,
      runtimeInstanceId: Type.Optional(IdentifierSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('runtime.ready'),
      role: Type.Enum(['service-worker', 'media'] as const),
      extensionVersion: Type.String({ minLength: 1, maxLength: 64 }),
      runtimeGeneration: IdentifierSchema,
      runtimeInstanceId: Type.Optional(IdentifierSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('runtime.ping'),
      nonce: IdentifierSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('runtime.pong'),
      nonce: IdentifierSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('target.resolve'),
      requestId: IdentifierSchema,
      targetId: IdentifierSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('target.resolved'),
      requestId: IdentifierSchema,
      targetId: IdentifierSchema,
      tabId: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('target.resolve_failed'),
      requestId: IdentifierSchema,
      targetId: IdentifierSchema,
      error: RemoteTabErrorShapeSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('capture.prepare'),
      requestId: IdentifierSchema,
      sessionId: IdentifierSchema,
      targetId: IdentifierSchema,
      tabId: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
      viewerGeneration: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('capture.prepared'),
      requestId: IdentifierSchema,
      sessionId: IdentifierSchema,
      streamId: Type.String({ minLength: 1, maxLength: 4096 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('capture.prepare_failed'),
      requestId: IdentifierSchema,
      sessionId: IdentifierSchema,
      error: RemoteTabErrorShapeSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('media.start'),
      quality: Type.Optional(MediaQualitySettingsSchema),
      sessionId: IdentifierSchema,
      viewerGeneration: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      tabId: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
      streamId: Type.String({ minLength: 1, maxLength: 4096 }),
      capabilities: CapabilityListSchema,
      iceServers: Type.Array(IceServerSchema, { maxItems: 16 }),
      iceTransportPolicy: IceTransportPolicySchema,
      viewport: ViewportSchema,
      captureFrameRateLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
      audio: Type.Boolean(),
      captureRevision: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('media.replace_capture'),
      requestId: IdentifierSchema,
      sessionId: IdentifierSchema,
      viewerGeneration: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      streamId: Type.String({ minLength: 1, maxLength: 4096 }),
      viewport: ViewportSchema,
      captureFrameRateLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
      audio: Type.Boolean(),
      captureRevision: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    },
    { additionalProperties: false },
  ),
  Type.Object({
    type: Type.Literal('media.capture_ended'), sessionId: IdentifierSchema,
    viewerGeneration: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    captureRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  }, { additionalProperties: false }),
  Type.Object(
    {
      type: Type.Literal('media.capture_replaced'),
      requestId: IdentifierSchema,
      sessionId: IdentifierSchema,
      viewerGeneration: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('media.capture_replace_failed'),
      requestId: IdentifierSchema,
      sessionId: IdentifierSchema,
      viewerGeneration: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      error: RemoteTabErrorShapeSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('media.stop'),
      requestId: IdentifierSchema,
      sessionId: IdentifierSchema,
      reason: Type.String({ minLength: 1, maxLength: 512 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('media.stopped'),
      requestId: IdentifierSchema,
      sessionId: IdentifierSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('media.start_failed'),
      sessionId: IdentifierSchema,
      error: RemoteTabErrorShapeSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Union([Type.Literal('media.suspend'), Type.Literal('media.resume')]),
      sessionId: IdentifierSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('media.restart_ice'),
      sessionId: IdentifierSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object({
    type: Type.Literal('media.configure_quality'), sessionId: IdentifierSchema,
    requestId: IdentifierSchema, configuration: QualityConfigurationSchema, limits: EncodingSettingsSchema,
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal('media.quality_configuration'), sessionId: IdentifierSchema,
    requestId: Type.Optional(IdentifierSchema), state: QualityStateSchema,
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal('media.quality_configuration_failed'), sessionId: IdentifierSchema,
    requestId: IdentifierSchema, error: RemoteTabErrorShapeSchema,
  }, { additionalProperties: false }),
  Type.Object(
    {
      type: Type.Literal('media.set_quality'),
      sessionId: IdentifierSchema,
      settings: MediaQualitySettingsSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('media.quality_changed'),
      sessionId: IdentifierSchema,
      settings: MediaQualitySettingsSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('media.quality_failed'),
      sessionId: IdentifierSchema,
      error: RemoteTabErrorShapeSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object({
    type: Type.Literal('media.control_closed'),
    sessionId: IdentifierSchema,
    viewerGeneration: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  }, { additionalProperties: false }),
  Type.Object(
    {
      type: Type.Literal('media.diagnostic'),
      sessionId: IdentifierSchema,
      diagnostic: ExtensionMediaDiagnosticSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('media.control_forwarded'),
      sessionId: IdentifierSchema,
      sequence: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('media.suspension_changed'),
      sessionId: IdentifierSchema,
      suspended: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('media.signal_description'),
      sessionId: IdentifierSchema,
      description: SessionDescriptionSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('media.signal_ice'),
      sessionId: IdentifierSchema,
      candidate: IceCandidateSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('media.peer_ready'),
      sessionId: IdentifierSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('media.peer_left'),
      sessionId: IdentifierSchema,
    },
    { additionalProperties: false },
  ),
])

export type ExtensionLoopbackMessage = Type.Static<typeof ExtensionLoopbackMessageSchema>

const validator = Schema.Compile(ExtensionLoopbackMessageSchema)

export function decodeExtensionLoopbackMessage(
  input: string,
  maxBytes: number = MAX_LOOPBACK_MESSAGE_BYTES,
): ExtensionLoopbackMessage {
  assertSize(new TextEncoder().encode(input).byteLength, maxBytes)
  let value: unknown
  try {
    value = JSON.parse(input)
  } catch (cause) {
    throw new RemoteTabError('PROTOCOL_DECODE_FAILED', 'Extension loopback message is not valid JSON', {
      cause,
    })
  }
  if (!validator.Check(value)) {
    throw new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Extension loopback message is invalid')
  }
  return value
}

export function encodeExtensionLoopbackMessage(
  message: ExtensionLoopbackMessage,
  maxBytes: number = MAX_LOOPBACK_MESSAGE_BYTES,
): string {
  if (!validator.Check(message)) {
    throw new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Extension loopback message is invalid')
  }
  const value = JSON.stringify(message)
  assertSize(new TextEncoder().encode(value).byteLength, maxBytes)
  return value
}

function assertSize(actual: number, maximum: number): void {
  if (!Number.isSafeInteger(maximum) || maximum <= 0) {
    throw new RangeError('maxBytes must be a positive safe integer')
  }
  if (actual > maximum) {
    throw new RemoteTabError(
      'PROTOCOL_MESSAGE_TOO_LARGE',
      `Extension loopback message is ${actual} bytes; maximum is ${maximum}`,
    )
  }
}
