import Type from 'typebox'

export const REMOTE_TAB_ERROR_CODES = [
  'CHROME_UNSUPPORTED',
  'CHROME_CONNECTION_FAILED',
  'CDP_COMMAND_FAILED',
  'CDP_COMMAND_TIMEOUT',
  'EXTENSION_UNAVAILABLE',
  'EXTENSION_AUTH_FAILED',
  'TAB_NOT_FOUND',
  'TAB_ALREADY_ATTACHED',
  'TARGET_MAPPING_FAILED',
  'VIEWPORT_STALE',
  'CAPTURE_DENIED',
  'VIEWER_TICKET_EXPIRED',
  'VIEWER_TICKET_REPLAYED',
  'VIEWER_TICKET_INVALID',
  'VIEWER_REPLACED',
  'NAVIGATION_DENIED',
  'CAPABILITY_UNAVAILABLE',
  'FILE_LIMIT_EXCEEDED',
  'FILE_TRANSFER_FAILED',
  'ICE_FAILED',
  'TURN_UNAVAILABLE',
  'SIGNALING_AUTH_FAILED',
  'SIGNALING_PAIR_CONFLICT',
  'SIGNALING_PAIR_TIMEOUT',
  'SIGNALING_NOT_PAIRED',
  'SESSION_CLOSED',
  'ILLEGAL_STATE_TRANSITION',
  'PROTOCOL_MESSAGE_TOO_LARGE',
  'PROTOCOL_DECODE_FAILED',
  'PROTOCOL_MESSAGE_INVALID',
  'PROTOCOL_MESSAGE_UNKNOWN',
  'PROTOCOL_VERSION_UNSUPPORTED',
] as const

export type RemoteTabErrorCode = (typeof REMOTE_TAB_ERROR_CODES)[number]

export interface RemoteTabErrorShape {
  code: RemoteTabErrorCode
  message: string
  retryable: boolean
  details?: Readonly<Record<string, unknown>>
}

export interface RemoteTabErrorOptions {
  retryable?: boolean
  details?: Readonly<Record<string, unknown>>
  cause?: unknown
}

export const RemoteTabErrorCodeSchema = Type.Enum(REMOTE_TAB_ERROR_CODES)

export const RemoteTabErrorShapeSchema = Type.Object(
  {
    code: RemoteTabErrorCodeSchema,
    message: Type.String({ minLength: 1, maxLength: 1024 }),
    retryable: Type.Boolean(),
    details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
)

export class RemoteTabError extends Error {
  public override readonly name = 'RemoteTabError'
  public readonly code: RemoteTabErrorCode
  public readonly retryable: boolean
  public readonly details: Readonly<Record<string, unknown>> | undefined

  public constructor(
    code: RemoteTabErrorCode,
    message: string,
    options: RemoteTabErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
    this.retryable = options.retryable ?? false
    this.details = options.details
  }

  public toJSON(): RemoteTabErrorShape {
    const base = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    }

    return this.details === undefined ? base : { ...base, details: this.details }
  }
}
