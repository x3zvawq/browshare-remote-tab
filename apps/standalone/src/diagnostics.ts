import type { StandaloneDiagnosticEvent } from './server.js'

export function formatStandaloneDiagnostic(event: StandaloneDiagnosticEvent): string {
  // Page Script errors can include page content or cookies in their message. Keep
  // the public diagnostic hook intact while emitting only a fixed log code.
  const logged = event.type === 'session.diagnostic' && event.name === 'page-script.error'
    ? { ...event, fields: { code: 'PAGE_SCRIPT_FAILED' } }
    : event
  return `${JSON.stringify({ source: 'standalone', ...logged })}\n`
}
