import Type from 'typebox'

/** Native CSS cursor keywords only: never transport custom cursor images or URLs. */
export const CURSOR_KINDS = ['default', 'none', 'context-menu', 'help', 'pointer', 'progress', 'wait', 'cell', 'crosshair', 'text', 'vertical-text', 'alias', 'copy', 'move', 'no-drop', 'not-allowed', 'grab', 'grabbing', 'all-scroll', 'col-resize', 'row-resize', 'n-resize', 'e-resize', 's-resize', 'w-resize', 'ne-resize', 'nw-resize', 'se-resize', 'sw-resize', 'ew-resize', 'ns-resize', 'nesw-resize', 'nwse-resize', 'zoom-in', 'zoom-out'] as const
export type CursorKind = (typeof CURSOR_KINDS)[number]
export const CursorKindSchema = Type.Enum(CURSOR_KINDS)
