import Type from 'typebox'

export const REMOTE_TAB_STATES = [
  'ATTACHING',
  'READY',
  'NEGOTIATING',
  'CONNECTED',
  'SUSPENDED',
  'RECONNECTING',
  'CLOSING',
  'CLOSED',
  'FAILED',
] as const

export type RemoteTabState = (typeof REMOTE_TAB_STATES)[number]

export const RemoteTabStateSchema = Type.Enum(REMOTE_TAB_STATES)
