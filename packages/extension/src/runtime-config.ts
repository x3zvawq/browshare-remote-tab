export interface ManagedRuntimeConfiguration {
  loopbackUrl: string
  runtimeSecret: string
  runtimeGeneration: string
}

export interface RuntimeConfiguration extends ManagedRuntimeConfiguration {
  runtimeInstanceId: string
}

const RUNTIME_INSTANCE_ID_KEY = 'runtimeInstanceId'

const LOOPBACK_WEBSOCKET_PATTERN =
  /^ws:\/\/(127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/[^#]*)?$/u

export function parseManagedRuntimeConfiguration(
  values: Record<string, unknown>,
): ManagedRuntimeConfiguration {
  const issues: string[] = []
  const loopbackUrl = values.loopbackUrl
  const runtimeSecret = values.runtimeSecret
  const runtimeGeneration = values.runtimeGeneration

  if (typeof loopbackUrl !== 'string' || !LOOPBACK_WEBSOCKET_PATTERN.test(loopbackUrl)) {
    issues.push(`loopbackUrl is ${describeValue(loopbackUrl)}`)
  }

  const runtimeSecretBytes =
    typeof runtimeSecret === 'string' ? new TextEncoder().encode(runtimeSecret).byteLength : undefined
  if (runtimeSecretBytes === undefined || runtimeSecretBytes < 32) {
    issues.push(
      runtimeSecretBytes === undefined
        ? `runtimeSecret is ${describeValue(runtimeSecret)}`
        : `runtimeSecret is a ${runtimeSecretBytes}-byte string`,
    )
  }

  if (typeof runtimeGeneration !== 'string' || runtimeGeneration.length === 0) {
    issues.push(`runtimeGeneration is ${describeValue(runtimeGeneration)}`)
  }

  if (issues.length > 0) {
    throw new Error(`Remote Tab managed runtime configuration is invalid: ${issues.join('; ')}`)
  }

  return {
    loopbackUrl: loopbackUrl as string,
    runtimeSecret: runtimeSecret as string,
    runtimeGeneration: runtimeGeneration as string,
  }
}

export async function loadRuntimeInstanceId(): Promise<string> {
  const stored = await chrome.storage.session.get(RUNTIME_INSTANCE_ID_KEY)
  const existing = stored[RUNTIME_INSTANCE_ID_KEY]
  if (typeof existing === 'string' && existing.length > 0 && existing.length <= 128) {
    return existing
  }
  const runtimeInstanceId = crypto.randomUUID()
  await chrome.storage.session.set({ [RUNTIME_INSTANCE_ID_KEY]: runtimeInstanceId })
  return runtimeInstanceId
}

function describeValue(value: unknown): string {
  if (value === undefined) {
    return 'missing'
  }
  if (value === null) {
    return 'null'
  }
  if (typeof value === 'string') {
    return `a ${new TextEncoder().encode(value).byteLength}-byte string`
  }
  return `a ${typeof value}`
}
