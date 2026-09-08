import {
  RemoteTabError,
  type RemoteTabState,
} from '@browshare/remote-tab-protocol'

const LEGAL_TRANSITIONS: Readonly<Record<RemoteTabState, ReadonlySet<RemoteTabState>>> = {
  ATTACHING: new Set(['READY', 'CLOSING', 'FAILED']),
  READY: new Set(['NEGOTIATING', 'CLOSING', 'FAILED']),
  NEGOTIATING: new Set(['CONNECTED', 'READY', 'CLOSING', 'FAILED']),
  CONNECTED: new Set(['SUSPENDED', 'RECONNECTING', 'CLOSING', 'FAILED']),
  SUSPENDED: new Set(['CONNECTED', 'RECONNECTING', 'CLOSING', 'FAILED']),
  RECONNECTING: new Set(['READY', 'CONNECTED', 'CLOSING', 'FAILED']),
  CLOSING: new Set(['CLOSED', 'FAILED']),
  CLOSED: new Set(),
  FAILED: new Set(),
}

export interface RemoteTabStateTransition {
  previous: RemoteTabState
  current: RemoteTabState
  reason: string | undefined
  occurredAt: number
}

export interface RemoteTabStateMachineOptions {
  initialState?: RemoteTabState
  now?: () => number
  onTransition?: (transition: RemoteTabStateTransition) => void
}

export class RemoteTabStateMachine {
  #state: RemoteTabState
  readonly #now: () => number
  readonly #onTransition: ((transition: RemoteTabStateTransition) => void) | undefined

  public constructor(options: RemoteTabStateMachineOptions = {}) {
    this.#state = options.initialState ?? 'ATTACHING'
    this.#now = options.now ?? Date.now
    this.#onTransition = options.onTransition
  }

  public get state(): RemoteTabState {
    return this.#state
  }

  public canTransitionTo(next: RemoteTabState): boolean {
    return LEGAL_TRANSITIONS[this.#state]?.has(next) ?? false
  }

  public transition(next: RemoteTabState, reason?: string): RemoteTabStateTransition {
    const previous = this.#state
    if (!this.canTransitionTo(next)) {
      throw new RemoteTabError(
        'ILLEGAL_STATE_TRANSITION',
        `Remote Tab state cannot transition from ${previous} to ${next}`,
        { details: { previous, next } },
      )
    }

    const transition: RemoteTabStateTransition = {
      previous,
      current: next,
      reason,
      occurredAt: this.#now(),
    }

    this.#state = next
    this.#onTransition?.(transition)
    return transition
  }
}

export function isTerminalRemoteTabState(state: RemoteTabState): boolean {
  return state === 'CLOSED' || state === 'FAILED'
}
