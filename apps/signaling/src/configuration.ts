import { IceServerSchema, IceTransportPolicySchema } from '@browshare/remote-tab-protocol'
import Type from 'typebox'
import Schema from 'typebox/schema'

export const SignalingProcessConfigurationSchema = Type.Object(
  {
    gatewayId: Type.String({ minLength: 1, maxLength: 128 }),
    host: Type.String({ minLength: 1, maxLength: 255 }),
    port: Type.Integer({ minimum: 1, maximum: 65535 }),
    publicEndpoint: Type.String({ minLength: 1, maxLength: 2048 }),
    pairingTimeoutMs: Type.Integer({ minimum: 100, maximum: 600_000 }),
    maxMessageBytes: Type.Integer({ minimum: 1024, maximum: 262_144 }),
    maxPendingPairs: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    maxConnections: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    maxConnectionsPerIp: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    messageRateWindowMs: Type.Integer({ minimum: 1_000, maximum: 600_000 }),
    maxMessagesPerWindow: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    maxConsumedTickets: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
    metricsIntervalMs: Type.Integer({ minimum: 1_000, maximum: 3_600_000 }),
    metricsHost: Type.String({ minLength: 1, maxLength: 255 }),
    metricsPort: Type.Integer({ minimum: 1, maximum: 65_535 }),
    viewerTickets: Type.Object(
      {
        secret: Type.String({ minLength: 32, maxLength: 16_384 }),
        issuer: Type.String({ minLength: 1, maxLength: 128 }),
        audience: Type.String({ minLength: 1, maxLength: 128 }),
      },
      { additionalProperties: false },
    ),
    coreBindingToken: Type.String({ minLength: 32, maxLength: 16_384 }),
    iceServers: Type.Array(IceServerSchema, { maxItems: 16 }),
    iceTransportPolicy: IceTransportPolicySchema,
  },
  { additionalProperties: false },
)

export type SignalingProcessConfiguration = Type.Static<
  typeof SignalingProcessConfigurationSchema
>

const configurationValidator = Schema.Compile(SignalingProcessConfigurationSchema)

export function parseSignalingProcessConfiguration(
  value: unknown,
): SignalingProcessConfiguration {
  if (!configurationValidator.Check(value)) {
    throw new TypeError('Signaling process configuration is invalid')
  }
  assertWebSocketEndpoint(value.publicEndpoint)
  return value
}

export function loadSignalingProcessConfiguration(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SignalingProcessConfiguration {
  return parseSignalingProcessConfiguration({
    gatewayId: required(environment, 'BROWSHARE_REMOTE_TAB_GATEWAY_ID'),
    host: environment.BROWSHARE_REMOTE_TAB_GATEWAY_HOST ?? '0.0.0.0',
    port: integer(environment, 'BROWSHARE_REMOTE_TAB_GATEWAY_PORT', 8081),
    publicEndpoint: required(environment, 'BROWSHARE_REMOTE_TAB_GATEWAY_PUBLIC_ENDPOINT'),
    pairingTimeoutMs: integer(
      environment,
      'BROWSHARE_REMOTE_TAB_GATEWAY_PAIRING_TIMEOUT_MS',
      30_000,
    ),
    maxMessageBytes: integer(
      environment,
      'BROWSHARE_REMOTE_TAB_GATEWAY_MAX_MESSAGE_BYTES',
      262_144,
    ),
    maxPendingPairs: integer(
      environment,
      'BROWSHARE_REMOTE_TAB_GATEWAY_MAX_PENDING_PAIRS',
      10_000,
    ),
    maxConnections: integer(
      environment,
      'BROWSHARE_REMOTE_TAB_GATEWAY_MAX_CONNECTIONS',
      20_000,
    ),
    maxConnectionsPerIp: integer(
      environment,
      'BROWSHARE_REMOTE_TAB_GATEWAY_MAX_CONNECTIONS_PER_IP',
      128,
    ),
    messageRateWindowMs: integer(
      environment,
      'BROWSHARE_REMOTE_TAB_GATEWAY_MESSAGE_RATE_WINDOW_MS',
      60_000,
    ),
    maxMessagesPerWindow: integer(
      environment,
      'BROWSHARE_REMOTE_TAB_GATEWAY_MAX_MESSAGES_PER_WINDOW',
      1_200,
    ),
    maxConsumedTickets: integer(
      environment,
      'BROWSHARE_REMOTE_TAB_GATEWAY_MAX_CONSUMED_TICKETS',
      100_000,
    ),
    metricsIntervalMs: integer(
      environment,
      'BROWSHARE_REMOTE_TAB_GATEWAY_METRICS_INTERVAL_MS',
      30_000,
    ),
    metricsHost: environment.BROWSHARE_REMOTE_TAB_GATEWAY_METRICS_HOST ?? '127.0.0.1',
    metricsPort: integer(environment, 'BROWSHARE_REMOTE_TAB_GATEWAY_METRICS_PORT', 9090),
    viewerTickets: {
      secret: required(environment, 'BROWSHARE_REMOTE_TAB_VIEWER_TICKET_SECRET'),
      issuer: environment.BROWSHARE_REMOTE_TAB_VIEWER_TICKET_ISSUER ?? 'remote-tab-standalone',
      audience: environment.BROWSHARE_REMOTE_TAB_VIEWER_TICKET_AUDIENCE ?? 'remote-tab-viewer',
    },
    coreBindingToken: required(environment, 'BROWSHARE_REMOTE_TAB_CORE_BINDING_TOKEN'),
    iceServers: parseIceServers(environment.BROWSHARE_REMOTE_TAB_ICE_SERVERS_JSON),
    iceTransportPolicy: environment.BROWSHARE_REMOTE_TAB_ICE_TRANSPORT_POLICY ?? 'all',
  })
}

function parseIceServers(source: string | undefined): unknown {
  if (source === undefined || source.length === 0) {
    return []
  }
  try {
    return JSON.parse(source) as unknown
  } catch {
    throw new TypeError('BROWSHARE_REMOTE_TAB_ICE_SERVERS_JSON must be valid JSON')
  }
}

function assertWebSocketEndpoint(value: string): void {
  let endpoint: URL
  try {
    endpoint = new URL(value)
  } catch {
    throw new TypeError('Gateway public endpoint is invalid')
  }
  if (endpoint.protocol !== 'ws:' && endpoint.protocol !== 'wss:') {
    throw new TypeError('Gateway public endpoint must use WebSocket')
  }
  if (endpoint.username.length > 0 || endpoint.password.length > 0) {
    throw new TypeError('Gateway public endpoint must not contain credentials')
  }
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
  if (source === undefined) return defaultValue
  if (!/^\d+$/u.test(source)) {
    throw new TypeError(`Environment variable ${name} must be an integer`)
  }
  return Number(source)
}
