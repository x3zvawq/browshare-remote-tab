import Schema from 'typebox/schema'

import type { Capability } from './capabilities.js'
import { RemoteTabError } from './errors.js'
import { ViewerTicketClaimsSchema, type ViewerTicketClaims } from './schemas.js'

const HEADER = Object.freeze({ alg: 'HS256', typ: 'BRTV1' })
const claimsValidator = Schema.Compile(ViewerTicketClaimsSchema)

export interface HmacViewerTicketCodecOptions {
  secret: string | Uint8Array
  issuer: string
  audience: string
  maxClockSkewSeconds?: number
  now?: () => number
  createId?: () => string
}

export interface IssueViewerTicketInput {
  sessionId: string
  viewerGeneration: number
  gatewayId: string
  capabilities: readonly Capability[]
  expiresInSeconds: number
}

export interface IssuedViewerTicket {
  token: string
  claims: ViewerTicketClaims
}

export class HmacViewerTicketCodec {
  readonly #secret: Uint8Array<ArrayBuffer>
  readonly #issuer: string
  readonly #audience: string
  readonly #maxClockSkewSeconds: number
  readonly #now: () => number
  readonly #createId: () => string
  #key: Promise<CryptoKey> | undefined

  public constructor(options: HmacViewerTicketCodecOptions) {
    const secret =
      typeof options.secret === 'string' ? new TextEncoder().encode(options.secret) : options.secret
    this.#secret = new Uint8Array(secret)
    if (this.#secret.byteLength < 32) {
      throw new TypeError('Viewer ticket HMAC secret must contain at least 32 bytes')
    }
    if (options.issuer.length === 0 || options.audience.length === 0) {
      throw new TypeError('Viewer ticket issuer and audience must not be empty')
    }
    this.#issuer = options.issuer
    this.#audience = options.audience
    this.#maxClockSkewSeconds = options.maxClockSkewSeconds ?? 30
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000))
    this.#createId = options.createId ?? (() => globalThis.crypto.randomUUID())
  }

  public async issue(input: IssueViewerTicketInput): Promise<IssuedViewerTicket> {
    if (!Number.isSafeInteger(input.expiresInSeconds) || input.expiresInSeconds <= 0) {
      throw new RangeError('expiresInSeconds must be a positive safe integer')
    }
    const issuedAt = this.#now()
    const claims: ViewerTicketClaims = {
      sessionId: input.sessionId,
      viewerGeneration: input.viewerGeneration,
      gatewayId: input.gatewayId,
      capabilities: [...input.capabilities],
      issuedAt,
      expiresAt: issuedAt + input.expiresInSeconds,
      jti: this.#createId(),
      issuer: this.#issuer,
      audience: this.#audience,
    }
    if (!claimsValidator.Check(claims)) {
      throw new TypeError('Viewer ticket claims are invalid')
    }

    const header = encodeBase64Url(new TextEncoder().encode(JSON.stringify(HEADER)))
    const payload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(claims)))
    const signingInput = `${header}.${payload}`
    const signature = await globalThis.crypto.subtle.sign(
      'HMAC',
      await this.#getKey(),
      new TextEncoder().encode(signingInput),
    )
    return {
      token: `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`,
      claims,
    }
  }

  public async verify(token: string): Promise<ViewerTicketClaims> {
    const parts = token.split('.')
    if (parts.length !== 3) {
      throw invalidTicket()
    }
    const [header, payload, signature] = parts
    if (header === undefined || payload === undefined || signature === undefined) {
      throw invalidTicket()
    }

    let parsedHeader: unknown
    let claims: unknown
    let signatureBytes: Uint8Array<ArrayBuffer>
    try {
      parsedHeader = JSON.parse(new TextDecoder().decode(decodeBase64Url(header)))
      claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload)))
      signatureBytes = decodeBase64Url(signature)
    } catch {
      throw invalidTicket()
    }

    if (
      !isRecord(parsedHeader) ||
      parsedHeader.alg !== HEADER.alg ||
      parsedHeader.typ !== HEADER.typ ||
      !claimsValidator.Check(claims)
    ) {
      throw invalidTicket()
    }

    const verified = await globalThis.crypto.subtle.verify(
      'HMAC',
      await this.#getKey(),
      signatureBytes,
      new TextEncoder().encode(`${header}.${payload}`),
    )
    if (!verified) {
      throw invalidTicket()
    }

    const typedClaims = claims as ViewerTicketClaims
    const now = this.#now()
    if (typedClaims.issuer !== this.#issuer || typedClaims.audience !== this.#audience) {
      throw invalidTicket()
    }
    if (
      typedClaims.issuedAt > now + this.#maxClockSkewSeconds ||
      typedClaims.expiresAt <= now - this.#maxClockSkewSeconds ||
      typedClaims.expiresAt <= typedClaims.issuedAt
    ) {
      throw new RemoteTabError('VIEWER_TICKET_EXPIRED', 'Viewer ticket is expired')
    }
    return typedClaims
  }

  #getKey(): Promise<CryptoKey> {
    this.#key ??= globalThis.crypto.subtle.importKey(
      'raw',
      this.#secret,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    )
    return this.#key
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new TypeError('Invalid base64url')
  }
  const padded = value
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalidTicket(): RemoteTabError {
  return new RemoteTabError('VIEWER_TICKET_INVALID', 'Viewer ticket is invalid')
}
