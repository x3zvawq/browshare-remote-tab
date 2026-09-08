import {
  CAPABILITIES,
  CapabilitySchema,
  ProtocolPayloadSchemas,
  type ProtocolPayload,
} from '@browshare/remote-tab-protocol'
import Type from 'typebox'
import Schema from 'typebox/schema'

const IdentifierSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$',
})

const CapabilitiesSchema = Type.Array(CapabilitySchema, {
  maxItems: CAPABILITIES.length,
  uniqueItems: true,
})

export const CreateStandaloneSessionSchema = Type.Object(
  {
    sessionId: IdentifierSchema,
    tab: Type.Union([
      Type.Object(
        {
          mode: Type.Literal('create'),
          initialUrl: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          mode: Type.Literal('adopt'),
          targetId: Type.String({ minLength: 1, maxLength: 256 }),
        },
        { additionalProperties: false },
      ),
    ]),
    capabilities: CapabilitiesSchema,
    signaling: Type.Object(
      {
        gatewayId: IdentifierSchema,
        coreEndpoint: Type.String({ minLength: 1, maxLength: 2048 }),
        viewerEndpoint: Type.String({ minLength: 1, maxLength: 2048 }),
        bindingToken: Type.String({ minLength: 1, maxLength: 16_384 }),
        connectionTimeoutMs: Type.Optional(
          Type.Integer({ minimum: 100, maximum: 300_000 }),
        ),
      },
      { additionalProperties: false },
    ),
    navigationPolicy: Type.Enum(['allow-all', 'deny-all'] as const),
    childTargetPolicy: Type.Optional(
      Type.Enum(['close-and-local-open', 'retain'] as const),
    ),
    localOpenRequestTimeoutMs: Type.Optional(
      Type.Integer({ minimum: 1_000, maximum: 300_000 }),
    ),
    pageScript: Type.Optional(
      Type.Object(
        {
          source: Type.String({ minLength: 1, maxLength: 524_288 }),
          context: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
)

export const CreateViewerTicketSchema = Type.Object(
  {
    capabilities: Type.Optional(CapabilitiesSchema),
    expiresInSeconds: Type.Integer({ minimum: 1, maximum: 3600 }),
  },
  { additionalProperties: false },
)

export const UpdateCapabilitiesSchema = Type.Object(
  { capabilities: CapabilitiesSchema },
  { additionalProperties: false },
)

export const SendNoticeSchema = ProtocolPayloadSchemas.notice

export type CreateStandaloneSessionInput = Type.Static<typeof CreateStandaloneSessionSchema>
export type CreateViewerTicketInput = Type.Static<typeof CreateViewerTicketSchema>
export type UpdateCapabilitiesInput = Type.Static<typeof UpdateCapabilitiesSchema>
export type SendNoticeInput = ProtocolPayload<'notice'>

const createSessionValidator = Schema.Compile(CreateStandaloneSessionSchema)
const createTicketValidator = Schema.Compile(CreateViewerTicketSchema)
const updateCapabilitiesValidator = Schema.Compile(UpdateCapabilitiesSchema)
const sendNoticeValidator = Schema.Compile(SendNoticeSchema)

export function isCreateStandaloneSessionInput(
  value: unknown,
): value is CreateStandaloneSessionInput {
  return createSessionValidator.Check(value)
}

export function isCreateViewerTicketInput(value: unknown): value is CreateViewerTicketInput {
  return createTicketValidator.Check(value)
}

export function isUpdateCapabilitiesInput(value: unknown): value is UpdateCapabilitiesInput {
  return updateCapabilitiesValidator.Check(value)
}

export function isSendNoticeInput(value: unknown): value is SendNoticeInput {
  return sendNoticeValidator.Check(value)
}
