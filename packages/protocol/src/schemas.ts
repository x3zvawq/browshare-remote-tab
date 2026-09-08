import { UploadConstraintsSchema } from './upload-policy.js'
import Type from 'typebox'

import { CapabilityListSchema } from './capabilities.js'
import { RemoteTabErrorShapeSchema } from './errors.js'
import { RemoteTabStateSchema } from './states.js'

const IdentifierSchema = Type.String({ minLength: 1, maxLength: 128 })
const NonNegativeSafeIntegerSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })

export const NoticeContentSchema = Type.Object(
  {
    kind: Type.Enum(['info', 'success', 'warning', 'error', 'confirm'] as const),
    title: Type.String({ minLength: 1, maxLength: 160 }),
    body: Type.String({ minLength: 1, maxLength: 2_048 }),
    buttons: Type.Array(Type.Object({
      id: Type.String({ minLength: 1, maxLength: 64 }),
      label: Type.String({ minLength: 1, maxLength: 80 }),
    }, { additionalProperties: false }), { maxItems: 3 }),
  },
  { additionalProperties: false },
)
export type NoticeContent = Type.Static<typeof NoticeContentSchema>
export const NoticeCancellationReasonSchema = Type.Enum([
  'expired', 'cancelled', 'connection-lost', 'viewer-replaced', 'capability-revoked', 'session-closed',
] as const)
export type NoticeCancellationReason = Type.Static<typeof NoticeCancellationReasonSchema>
export interface NoticeDecision {
  buttonId: string | null
  reason: 'response' | NoticeCancellationReason
}

export const ViewportSchema = Type.Object(
  {
    width: Type.Integer({ minimum: 1, maximum: 1920 }),
    height: Type.Integer({ minimum: 1, maximum: 1080 }),
    deviceScaleFactor: Type.Number({ exclusiveMinimum: 0, maximum: 4 }),
    frameRate: Type.Integer({ minimum: 1, maximum: 60 }),
    revision: NonNegativeSafeIntegerSchema,
  },
  { additionalProperties: false },
)

export type Viewport = Type.Static<typeof ViewportSchema>

export const MediaQualityPresetSchema = Type.Enum(
  ['data-saver', 'balanced', 'high'] as const,
)
export type MediaQualityPreset = Type.Static<typeof MediaQualityPresetSchema>

export const MediaQualitySettingsSchema = Type.Object(
  {
    preset: MediaQualityPresetSchema,
    maxBitrate: Type.Integer({ minimum: 100_000, maximum: 20_000_000 }),
    maxFrameRate: Type.Integer({ minimum: 1, maximum: 60 }),
    scaleResolutionDownBy: Type.Number({ minimum: 1, maximum: 4 }),
  },
  { additionalProperties: false },
)
export type MediaQualitySettings = Type.Static<typeof MediaQualitySettingsSchema>

export const EncodingSettingsSchema = Type.Object({
  maxBitrate: Type.Integer({ minimum: 100_000, maximum: 20_000_000 }),
  maxFrameRate: Type.Integer({ minimum: 1, maximum: 60 }),
  scaleResolutionDownBy: Type.Number({ minimum: 1, maximum: 4 }),
}, { additionalProperties: false })
export type EncodingSettings = Type.Static<typeof EncodingSettingsSchema>

export const QualityConfigurationSchema = Type.Union([
  Type.Object({ mode: Type.Literal('auto') }, { additionalProperties: false }),
  Type.Object({ mode: Type.Literal('preset'), preset: MediaQualityPresetSchema }, { additionalProperties: false }),
  Type.Object({ mode: Type.Literal('custom'), ...EncodingSettingsSchema.properties }, { additionalProperties: false }),
])
export type QualityConfiguration = Type.Static<typeof QualityConfigurationSchema>
export const QualityStateSchema = Type.Object({
  configuration: QualityConfigurationSchema,
  applied: EncodingSettingsSchema,
}, { additionalProperties: false })
export type QualityState = Type.Static<typeof QualityStateSchema>

export const ViewerTicketClaimsSchema = Type.Object(
  {
    sessionId: IdentifierSchema,
    viewerGeneration: NonNegativeSafeIntegerSchema,
    gatewayId: IdentifierSchema,
    capabilities: CapabilityListSchema,
    issuedAt: NonNegativeSafeIntegerSchema,
    expiresAt: NonNegativeSafeIntegerSchema,
    jti: IdentifierSchema,
    issuer: IdentifierSchema,
    audience: IdentifierSchema,
  },
  { additionalProperties: false },
)

export type ViewerTicketClaims = Type.Static<typeof ViewerTicketClaimsSchema>

const EmptyPayloadSchema = Type.Object({}, { additionalProperties: false })
const BinaryDataSchema = Type.Unsafe<Uint8Array>({})

export const FileDescriptorSchema = Type.Object(
  {
    fileId: IdentifierSchema,
    displayName: Type.String({ minLength: 1, maxLength: 512 }),
    size: NonNegativeSafeIntegerSchema,
    mimeType: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  },
  { additionalProperties: false },
)

export type FileDescriptor = Type.Static<typeof FileDescriptorSchema>

export const ClipboardMimeTypeSchema = Type.Enum(['text/plain', 'image/png'] as const)
export type ClipboardMimeType = Type.Static<typeof ClipboardMimeTypeSchema>

export const ClipboardItemDescriptorSchema = Type.Object(
  {
    itemId: IdentifierSchema,
    mimeType: ClipboardMimeTypeSchema,
    size: NonNegativeSafeIntegerSchema,
  },
  { additionalProperties: false },
)

export type ClipboardItemDescriptor = Type.Static<typeof ClipboardItemDescriptorSchema>

export const PAGE_SCRIPT_EVENTS = [
  'browshare:on_document_start',
  'browshare:on_dom_content_loaded',
  'browshare:on_load',
  'browshare:on_location_changed',
  'browshare:on_session_attached',
  'browshare:on_session_detached',
] as const

export const PageScriptEventNameSchema = Type.Enum(PAGE_SCRIPT_EVENTS)
export type PageScriptEventName = Type.Static<typeof PageScriptEventNameSchema>

const WindowSelectionFields = {
  revision: NonNegativeSafeIntegerSchema,
  selectedTargetId: IdentifierSchema,
  selecting: Type.Boolean(),
  requestId: Type.Optional(IdentifierSchema),
  error: Type.Optional(RemoteTabErrorShapeSchema),
}
export const WindowEntrySchema = Type.Object({
  targetId: IdentifierSchema,
  // Display excerpts only. Navigation uses targetId and separately observed location state.
  title: Type.String({ maxLength: 512 }),
  url: Type.String({ maxLength: 1024 }),
  main: Type.Boolean(),
}, { additionalProperties: false })
export const WindowStateSchema = Type.Object({
  ...WindowSelectionFields,
  windows: Type.Array(WindowEntrySchema, { minItems: 1 }),
}, { additionalProperties: false })
export type WindowState = Type.Static<typeof WindowStateSchema>

const WindowStateFrameSchema = Type.Object({
  ...WindowSelectionFields,
  catalogRevision: NonNegativeSafeIntegerSchema,
  offset: NonNegativeSafeIntegerSchema,
  total: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  windows: Type.Array(WindowEntrySchema, { minItems: 1, maxItems: 128 }),
}, { additionalProperties: false })

export const ProtocolPayloadSchemas = {
  'window.state': WindowStateFrameSchema,
  'session.capabilities': Type.Object({ capabilities: CapabilityListSchema }, { additionalProperties: false }),
  'window.close': Type.Object({ requestId: IdentifierSchema }, { additionalProperties: false }),
  'window.select': Type.Object({ requestId: IdentifierSchema, targetId: IdentifierSchema }, { additionalProperties: false }),
  'hello': Type.Object(
    {
      clientVersion: Type.String({ minLength: 1, maxLength: 128 }),
      capabilities: CapabilityListSchema,
    },
    { additionalProperties: false },
  ),
  'hello.accepted': Type.Object(
    {
      capabilities: CapabilityListSchema,
      viewport: ViewportSchema,
    },
    { additionalProperties: false },
  ),
  'hello.rejected': RemoteTabErrorShapeSchema,
  'session.state': Type.Object(
    {
      state: RemoteTabStateSchema,
      reason: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    },
    { additionalProperties: false },
  ),
  'session.suspend': EmptyPayloadSchema,
  'session.resume': EmptyPayloadSchema,
  'input.pointer': Type.Object(
    {
      event: Type.Enum(['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseWheel'] as const),
      x: Type.Number({ minimum: 0 }),
      y: Type.Number({ minimum: 0 }),
      viewportRevision: NonNegativeSafeIntegerSchema,
      button: Type.Enum(['none', 'left', 'middle', 'right', 'back', 'forward'] as const),
      buttons: Type.Integer({ minimum: 0, maximum: 31 }),
      modifiers: Type.Integer({ minimum: 0, maximum: 15 }),
      clickCount: Type.Integer({ minimum: 0, maximum: 3 }),
      deltaX: Type.Optional(Type.Number()),
      deltaY: Type.Optional(Type.Number()),
      pointerType: Type.Optional(Type.Enum(['mouse', 'pen'] as const)),
    },
    { additionalProperties: false },
  ),
  'input.key': Type.Object(
    {
      event: Type.Enum(['keyDown', 'keyUp', 'rawKeyDown', 'char'] as const),
      key: Type.String({ maxLength: 256 }),
      code: Type.String({ maxLength: 256 }),
      text: Type.Optional(Type.String({ maxLength: 256 })),
      unmodifiedText: Type.Optional(Type.String({ maxLength: 256 })),
      modifiers: Type.Integer({ minimum: 0, maximum: 15 }),
      windowsVirtualKeyCode: Type.Optional(Type.Integer({ minimum: 0, maximum: 65_535 })),
      nativeVirtualKeyCode: Type.Optional(Type.Integer({ minimum: 0, maximum: 65_535 })),
      autoRepeat: Type.Optional(Type.Boolean()),
      isKeypad: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  'input.composition': Type.Object(
    {
      event: Type.Enum(['start', 'update', 'commit', 'cancel'] as const),
      text: Type.Optional(Type.String({ maxLength: 65_536 })),
    },
    { additionalProperties: false },
  ),
  'navigation.request': Type.Union([
    Type.Object(
      {
        action: Type.Literal('go'),
        url: Type.String({ minLength: 1, maxLength: 16_384 }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        action: Type.Enum(['back', 'forward', 'reload'] as const),
      },
      { additionalProperties: false },
    ),
  ]),
  'navigation.result': Type.Object(
    {
      allowed: Type.Boolean(),
      action: Type.Enum(['go', 'back', 'forward', 'reload'] as const),
      currentUrl: Type.Optional(Type.String({ maxLength: 16_384 })),
      reason: Type.Optional(Type.String({ maxLength: 512 })),
    },
    { additionalProperties: false },
  ),
  'navigation.location_changed': Type.Object(
    { url: Type.String({ minLength: 1, maxLength: 16_384 }) },
    { additionalProperties: false },
  ),
  'navigation.local_open_request': Type.Object(
    {
      requestId: IdentifierSchema,
      url: Type.String({ minLength: 1, maxLength: 16_384 }),
      expiresAt: NonNegativeSafeIntegerSchema,
    },
    { additionalProperties: false },
  ),
  'navigation.local_open_result': Type.Object(
    {
      requestId: IdentifierSchema,
      approved: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  'notice': Type.Object(
    {
      level: Type.Enum(['info', 'warning', 'error'] as const),
      code: Type.String({ minLength: 1, maxLength: 128 }),
      message: Type.String({ minLength: 1, maxLength: 2_048 }),
    },
    { additionalProperties: false },
  ),
  'notice.request': Type.Object({
    requestId: IdentifierSchema,
    content: NoticeContentSchema,
    expiresAt: NonNegativeSafeIntegerSchema,
  }, { additionalProperties: false }),
  'notice.response': Type.Object({
    requestId: IdentifierSchema,
    buttonId: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
  }, { additionalProperties: false }),
  'notice.cancel': Type.Object({
    requestId: IdentifierSchema,
    reason: NoticeCancellationReasonSchema,
  }, { additionalProperties: false }),
  'page.lifecycle': Type.Object(
    {
      name: PageScriptEventNameSchema,
      occurredAt: NonNegativeSafeIntegerSchema,
      location: Type.Optional(Type.String({ minLength: 1, maxLength: 16_384 })),
    },
    { additionalProperties: false },
  ),
  'file.upload.request': Type.Object(
    {
      constraints: Type.Optional(UploadConstraintsSchema),
      requestId: IdentifierSchema,
      multiple: Type.Boolean(),
      expiresAt: NonNegativeSafeIntegerSchema,
    },
    { additionalProperties: false },
  ),
  'file.upload.offer': Type.Object(
    {
      requestId: IdentifierSchema,
      transferId: IdentifierSchema,
      files: Type.Array(FileDescriptorSchema, { minItems: 1, maxItems: 64 }),
    },
    { additionalProperties: false },
  ),
  'file.upload.accept': Type.Object(
    {
      transferId: IdentifierSchema,
      maxChunkBytes: Type.Integer({ minimum: 1, maximum: 262_144 }),
    },
    { additionalProperties: false },
  ),
  'file.upload.chunk': Type.Object(
    {
      transferId: IdentifierSchema,
      fileId: IdentifierSchema,
      offset: NonNegativeSafeIntegerSchema,
      data: BinaryDataSchema,
    },
    { additionalProperties: false },
  ),
  'file.upload.complete': Type.Object(
    { transferId: IdentifierSchema },
    { additionalProperties: false },
  ),
  'file.upload.cancel': Type.Object(
    {
      requestId: IdentifierSchema,
      transferId: Type.Optional(IdentifierSchema),
      reason: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    },
    { additionalProperties: false },
  ),
  'file.upload.result': Type.Object(
    {
      transferId: IdentifierSchema,
      delivered: Type.Boolean(),
      error: Type.Optional(RemoteTabErrorShapeSchema),
    },
    { additionalProperties: false },
  ),
  'file.download.offer': Type.Object(
    {
      transferId: IdentifierSchema,
      file: FileDescriptorSchema,
      expiresAt: NonNegativeSafeIntegerSchema,
    },
    { additionalProperties: false },
  ),
  'file.download.accept': Type.Object(
    { transferId: IdentifierSchema },
    { additionalProperties: false },
  ),
  'file.download.chunk': Type.Object(
    {
      transferId: IdentifierSchema,
      offset: NonNegativeSafeIntegerSchema,
      data: BinaryDataSchema,
    },
    { additionalProperties: false },
  ),
  'file.download.complete': Type.Object(
    { transferId: IdentifierSchema },
    { additionalProperties: false },
  ),
  'file.download.cancel': Type.Object(
    {
      transferId: IdentifierSchema,
      reason: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    },
    { additionalProperties: false },
  ),
  'file.download.result': Type.Object(
    {
      transferId: IdentifierSchema,
      received: Type.Boolean(),
      error: Type.Optional(RemoteTabErrorShapeSchema),
    },
    { additionalProperties: false },
  ),
  'clipboard.write.offer': Type.Object(
    {
      requestId: IdentifierSchema,
      transferId: IdentifierSchema,
      items: Type.Array(ClipboardItemDescriptorSchema, { minItems: 1, maxItems: 2 }),
    },
    { additionalProperties: false },
  ),
  'clipboard.write.accept': Type.Object(
    {
      transferId: IdentifierSchema,
      maxChunkBytes: Type.Integer({ minimum: 1, maximum: 262_144 }),
    },
    { additionalProperties: false },
  ),
  'clipboard.write.chunk': Type.Object(
    {
      transferId: IdentifierSchema,
      itemId: IdentifierSchema,
      offset: NonNegativeSafeIntegerSchema,
      data: BinaryDataSchema,
    },
    { additionalProperties: false },
  ),
  'clipboard.write.complete': Type.Object(
    { transferId: IdentifierSchema },
    { additionalProperties: false },
  ),
  'clipboard.write.result': Type.Object(
    {
      transferId: IdentifierSchema,
      written: Type.Boolean(),
      error: Type.Optional(RemoteTabErrorShapeSchema),
    },
    { additionalProperties: false },
  ),
  'clipboard.read.request': Type.Object(
    { requestId: IdentifierSchema },
    { additionalProperties: false },
  ),
  'clipboard.read.offer': Type.Object(
    {
      requestId: IdentifierSchema,
      transferId: IdentifierSchema,
      items: Type.Array(ClipboardItemDescriptorSchema, { minItems: 1, maxItems: 2 }),
    },
    { additionalProperties: false },
  ),
  'clipboard.read.accept': Type.Object(
    { transferId: IdentifierSchema },
    { additionalProperties: false },
  ),
  'clipboard.read.chunk': Type.Object(
    {
      transferId: IdentifierSchema,
      itemId: IdentifierSchema,
      offset: NonNegativeSafeIntegerSchema,
      data: BinaryDataSchema,
    },
    { additionalProperties: false },
  ),
  'clipboard.read.complete': Type.Object(
    { transferId: IdentifierSchema },
    { additionalProperties: false },
  ),
  'clipboard.read.result': Type.Object(
    {
      requestId: IdentifierSchema,
      transferId: Type.Optional(IdentifierSchema),
      received: Type.Boolean(),
      error: Type.Optional(RemoteTabErrorShapeSchema),
    },
    { additionalProperties: false },
  ),
  'viewport.request': Type.Object(
    {
      width: Type.Integer({ minimum: 1, maximum: 1920 }),
      height: Type.Integer({ minimum: 1, maximum: 1080 }),
      deviceScaleFactor: Type.Number({ exclusiveMinimum: 0, maximum: 4 }),
      frameRate: Type.Integer({ minimum: 1, maximum: 60 }),
    },
    { additionalProperties: false },
  ),
  'viewport.ack': ViewportSchema,
  'quality.request': Type.Object(
    { preset: MediaQualityPresetSchema },
    { additionalProperties: false },
  ),
  'quality.ack': MediaQualitySettingsSchema,
  'quality.configure': Type.Object({ requestId: IdentifierSchema, configuration: QualityConfigurationSchema }, { additionalProperties: false }),
  'quality.configuration': Type.Object({ requestId: Type.Optional(IdentifierSchema), state: QualityStateSchema }, { additionalProperties: false }),
  'quality.configuration_failed': Type.Object({ requestId: IdentifierSchema, error: RemoteTabErrorShapeSchema }, { additionalProperties: false }),
  'error': RemoteTabErrorShapeSchema,
} as const

export type ProtocolMessageType = keyof typeof ProtocolPayloadSchemas

export type ProtocolPayload<TypeName extends ProtocolMessageType> = Type.Static<
  (typeof ProtocolPayloadSchemas)[TypeName]
>
