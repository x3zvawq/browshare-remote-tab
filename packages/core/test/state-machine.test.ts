import { describe, expect, it, vi } from 'vitest'

import { RemoteTabStateMachine, isTerminalRemoteTabState } from '../src/index.js'

describe('RemoteTabStateMachine', () => {
  it('supports the connected, suspended, reconnecting, and close lifecycle', () => {
    const observed = vi.fn()
    const machine = new RemoteTabStateMachine({ now: () => 42, onTransition: observed })

    machine.transition('READY')
    machine.transition('NEGOTIATING')
    machine.transition('CONNECTED')
    machine.transition('SUSPENDED')
    machine.transition('RECONNECTING')
    machine.transition('CONNECTED')
    machine.transition('CLOSING', 'embedder-close')
    const final = machine.transition('CLOSED')

    expect(machine.state).toBe('CLOSED')
    expect(final).toEqual({
      previous: 'CLOSING',
      current: 'CLOSED',
      reason: undefined,
      occurredAt: 42,
    })
    expect(observed).toHaveBeenCalledTimes(8)
    expect(isTerminalRemoteTabState(machine.state)).toBe(true)
  })

  it('allows an attaching session to be cancelled cleanly', () => {
    const machine = new RemoteTabStateMachine()
    expect(machine.canTransitionTo('CLOSING')).toBe(true)
    machine.transition('CLOSING')
    machine.transition('CLOSED')
    expect(machine.state).toBe('CLOSED')
  })

  it('returns a failed replacement negotiation to the ready state', () => {
    const machine = new RemoteTabStateMachine({ initialState: 'RECONNECTING' })
    machine.transition('READY', 'replacement timed out')
    expect(machine.state).toBe('READY')
  })

  it('rejects illegal and terminal transitions without changing state', () => {
    const machine = new RemoteTabStateMachine()

    expect(() => machine.transition('CONNECTED')).toThrowError(
      expect.objectContaining({ code: 'ILLEGAL_STATE_TRANSITION' }),
    )
    expect(machine.state).toBe('ATTACHING')

    machine.transition('FAILED')
    expect(() => machine.transition('ATTACHING')).toThrowError(
      expect.objectContaining({ code: 'ILLEGAL_STATE_TRANSITION' }),
    )
    expect(machine.state).toBe('FAILED')
  })
})
