import { describe, expect, it } from 'vitest'

import { HmacViewerTicketCodec } from '../src/index.js'

const SECRET = '0123456789abcdef0123456789abcdef'

describe('HmacViewerTicketCodec', () => {
  it('issues and verifies a scoped short-lived ticket', async () => {
    const codec = new HmacViewerTicketCodec({
      secret: SECRET,
      issuer: 'browshare-test',
      audience: 'remote-tab-viewer',
      now: () => 1_000,
      createId: () => 'ticket-1',
    })
    const issued = await codec.issue({
      sessionId: 'session-1',
      viewerGeneration: 4,
      gatewayId: 'gateway-1',
      capabilities: ['navigation'],
      expiresInSeconds: 60,
    })

    await expect(codec.verify(issued.token)).resolves.toEqual(issued.claims)
    expect(issued.claims).toMatchObject({
      issuedAt: 1_000,
      expiresAt: 1_060,
      jti: 'ticket-1',
    })
  })

  it('rejects tampering and an expired ticket with stable codes', async () => {
    let now = 1_000
    const codec = new HmacViewerTicketCodec({
      secret: SECRET,
      issuer: 'browshare-test',
      audience: 'remote-tab-viewer',
      maxClockSkewSeconds: 0,
      now: () => now,
      createId: () => 'ticket-2',
    })
    const issued = await codec.issue({
      sessionId: 'session-2',
      viewerGeneration: 1,
      gatewayId: 'gateway-1',
      capabilities: [],
      expiresInSeconds: 10,
    })

    const tampered = `${issued.token.slice(0, -1)}${issued.token.endsWith('a') ? 'b' : 'a'}`
    await expect(codec.verify(tampered)).rejects.toMatchObject({ code: 'VIEWER_TICKET_INVALID' })

    now = 1_011
    await expect(codec.verify(issued.token)).rejects.toMatchObject({ code: 'VIEWER_TICKET_EXPIRED' })
  })
})
