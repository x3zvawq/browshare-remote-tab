import { describe, expect, it } from 'vitest'

import { parseManagedRuntimeConfiguration } from '../src/runtime-config.js'

const validConfiguration = {
  loopbackUrl: 'ws://127.0.0.1:9224',
  runtimeSecret: '0123456789abcdef0123456789abcdef',
  runtimeGeneration: 'runtime-1',
}

describe('parseManagedRuntimeConfiguration', () => {
  it('accepts IPv4 and IPv6 loopback WebSocket endpoints', () => {
    expect(parseManagedRuntimeConfiguration(validConfiguration)).toEqual(validConfiguration)
    expect(
      parseManagedRuntimeConfiguration({
        ...validConfiguration,
        loopbackUrl: 'ws://[::1]:9224/runtime',
      }),
    ).toMatchObject({ loopbackUrl: 'ws://[::1]:9224/runtime' })
  })

  it('rejects non-loopback or encrypted endpoints', () => {
    expect(() =>
      parseManagedRuntimeConfiguration({
        ...validConfiguration,
        loopbackUrl: 'ws://192.0.2.1:9224',
      }),
    ).toThrow('loopbackUrl is a 19-byte string')
    expect(() =>
      parseManagedRuntimeConfiguration({
        ...validConfiguration,
        loopbackUrl: 'wss://127.0.0.1:9224',
      }),
    ).toThrow('loopbackUrl is a 20-byte string')
  })

  it('reports every invalid field without exposing the secret value', () => {
    expect(() =>
      parseManagedRuntimeConfiguration({
        runtimeSecret: 'too-short',
        runtimeGeneration: 7,
      }),
    ).toThrow(
      'loopbackUrl is missing; runtimeSecret is a 9-byte string; runtimeGeneration is a number',
    )
  })
})
