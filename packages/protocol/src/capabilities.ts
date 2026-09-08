import Type from 'typebox'

export const CAPABILITIES = [
  'cursorFeedback',
  'navigation',
  'backForward',
  'reload',
  'upload',
  'download',
  'clipboardText',
  'clipboardImage',
  'localOpen',
  'noticeRequests',
  'navigationConfirmation',
  'navigationState',
  'windowSelection',
  'fullscreen',
  'qualityControl',
  'advancedQuality',
  'diagnostics',
  'tabAudio',
] as const

export type Capability = (typeof CAPABILITIES)[number]

export const CapabilitySchema = Type.Enum(CAPABILITIES)

export const CapabilityListSchema = Type.Array(Type.String({ minLength: 1 }), {
  maxItems: 128,
  uniqueItems: true,
})

const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set(CAPABILITIES)

export function isCapability(value: string): value is Capability {
  return KNOWN_CAPABILITIES.has(value)
}

/**
 * Produces a deterministic allow-only set. Unknown names are intentionally
 * ignored so a newer peer cannot accidentally grant behavior to an older one.
 */
export function normalizeCapabilities(values: readonly string[]): Capability[] {
  const requested = new Set(values)
  return CAPABILITIES.filter((capability) => requested.has(capability))
}

export function hasCapability(
  capabilities: readonly Capability[],
  required: Capability,
): boolean {
  return capabilities.includes(required)
}
