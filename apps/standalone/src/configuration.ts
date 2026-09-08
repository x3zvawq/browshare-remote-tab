import Type from 'typebox'
import Schema from 'typebox/schema'

export const StandaloneConfigurationSchema = Type.Object(
  {
    cdpEndpoint: Type.String({ minLength: 1, maxLength: 2048 }),
    embedderApi: Type.Object(
      {
        host: Type.Enum(['127.0.0.1', '::1'] as const),
        port: Type.Integer({ minimum: 0, maximum: 65535 }),
        token: Type.String({ minLength: 32, maxLength: 16_384 }),
        maxRequestBodyBytes: Type.Integer({ minimum: 1024, maximum: 1_048_576 }),
      },
      { additionalProperties: false },
    ),
    extension: Type.Object(
      {
        host: Type.Enum(['127.0.0.1', '::1'] as const),
        port: Type.Integer({ minimum: 0, maximum: 65535 }),
        id: Type.String({ pattern: '^[a-p]{32}$' }),
        runtimeSecret: Type.String({ minLength: 32, maxLength: 16_384 }),
        runtimeGeneration: Type.String({ minLength: 1, maxLength: 256 }),
        requestTimeoutMs: Type.Integer({ minimum: 100, maximum: 300_000 }),
      },
      { additionalProperties: false },
    ),
    viewerTickets: Type.Object(
      {
        secret: Type.String({ minLength: 32, maxLength: 16_384 }),
        issuer: Type.String({ minLength: 1, maxLength: 128 }),
        audience: Type.String({ minLength: 1, maxLength: 128 }),
        maximumLifetimeSeconds: Type.Integer({ minimum: 1, maximum: 3600 }),
      },
      { additionalProperties: false },
    ),
    tempRoot: Type.String({ minLength: 1, maxLength: 4096 }),
    maxSessions: Type.Integer({ minimum: 1, maximum: 100_000 }),
  },
  { additionalProperties: false },
)

export type StandaloneConfiguration = Type.Static<typeof StandaloneConfigurationSchema>

const configurationValidator = Schema.Compile(StandaloneConfigurationSchema)

export function parseStandaloneConfiguration(value: unknown): StandaloneConfiguration {
  if (!configurationValidator.Check(value)) {
    throw new TypeError('Standalone configuration is invalid')
  }
  return value
}

export function loadStandaloneConfiguration(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): StandaloneConfiguration {
  return parseStandaloneConfiguration({
    cdpEndpoint: required(environment, 'BROWSHARE_REMOTE_TAB_CDP_ENDPOINT'),
    embedderApi: {
      host: environment.BROWSHARE_REMOTE_TAB_API_HOST ?? '127.0.0.1',
      port: integer(environment, 'BROWSHARE_REMOTE_TAB_API_PORT', 9230),
      token: required(environment, 'BROWSHARE_REMOTE_TAB_API_TOKEN'),
      maxRequestBodyBytes: integer(
        environment,
        'BROWSHARE_REMOTE_TAB_API_MAX_BODY_BYTES',
        262_144,
      ),
    },
    extension: {
      host: environment.BROWSHARE_REMOTE_TAB_EXTENSION_HOST ?? '127.0.0.1',
      port: integer(environment, 'BROWSHARE_REMOTE_TAB_EXTENSION_PORT', 9224),
      id: required(environment, 'BROWSHARE_REMOTE_TAB_EXTENSION_ID'),
      runtimeSecret: required(environment, 'BROWSHARE_REMOTE_TAB_RUNTIME_SECRET'),
      runtimeGeneration: required(environment, 'BROWSHARE_REMOTE_TAB_RUNTIME_GENERATION'),
      requestTimeoutMs: integer(
        environment,
        'BROWSHARE_REMOTE_TAB_EXTENSION_TIMEOUT_MS',
        15_000,
      ),
    },
    viewerTickets: {
      secret: required(environment, 'BROWSHARE_REMOTE_TAB_VIEWER_TICKET_SECRET'),
      issuer: environment.BROWSHARE_REMOTE_TAB_VIEWER_TICKET_ISSUER ?? 'remote-tab-standalone',
      audience: environment.BROWSHARE_REMOTE_TAB_VIEWER_TICKET_AUDIENCE ?? 'remote-tab-viewer',
      maximumLifetimeSeconds: integer(
        environment,
        'BROWSHARE_REMOTE_TAB_VIEWER_TICKET_MAX_SECONDS',
        600,
      ),
    },
    tempRoot: required(environment, 'BROWSHARE_REMOTE_TAB_TEMP_ROOT'),
    maxSessions: integer(environment, 'BROWSHARE_REMOTE_TAB_MAX_SESSIONS', 16),
  })
}

function required(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name]
  if (value === undefined || value.length === 0) {
    throw new TypeError(`Missing required environment variable ${name}`)
  }
  return value
}

function integer(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  defaultValue: number,
): number {
  const source = environment[name]
  if (source === undefined) {
    return defaultValue
  }
  if (!/^\d+$/u.test(source)) {
    throw new TypeError(`Environment variable ${name} must be an integer`)
  }
  return Number(source)
}
