import { randomUUID } from 'node:crypto'
import { mkdir, open, rm, stat, type FileHandle } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import type {
  SessionStorageAdapter,
  SessionStorageReservation,
  SessionStorageReservationRequest,
  StoredSessionFile,
} from '@browshare/remote-tab-core'
import { RemoteTabError } from '@browshare/remote-tab-protocol'

export class LocalSessionStorage implements SessionStorageAdapter {
  readonly #root: string

  public constructor(root: string) {
    this.#root = resolve(root, '.sessions')
  }

  public async initialize(): Promise<void> {
    await rm(this.#root, { recursive: true, force: true })
    await mkdir(this.#root, { recursive: true, mode: 0o700 })
  }

  public async cleanupAll(): Promise<void> {
    await rm(this.#root, { recursive: true, force: true })
  }

  public async reserve(
    request: SessionStorageReservationRequest,
  ): Promise<SessionStorageReservation> {
    if (!Number.isSafeInteger(request.declaredSize) || request.declaredSize < 0) {
      throw new RemoteTabError('FILE_LIMIT_EXCEEDED', 'Declared file size is invalid')
    }
    const directory = join(
      this.#sessionDirectory(request.sessionId),
      encodeURIComponent(request.transferId),
    )
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const localPath = join(directory, safeDisplayName(request.displayName))
    const handle = await open(localPath, 'wx', 0o600)
    return new LocalReservation(handle, localPath, request)
  }

  public async cleanupSession(sessionId: string): Promise<void> {
    await rm(this.#sessionDirectory(sessionId), { recursive: true, force: true })
  }

  #sessionDirectory(sessionId: string): string {
    return join(this.#root, encodeURIComponent(sessionId))
  }
}

function safeDisplayName(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f/\\]/gu, '_')
    .trim()
    .slice(0, 255)
  return normalized === '' || normalized === '.' || normalized === '..' ? `file-${randomUUID()}` : normalized
}

class LocalReservation implements SessionStorageReservation {
  readonly localPath: string
  readonly #request: SessionStorageReservationRequest
  #handle: FileHandle | undefined
  #committed = false

  public constructor(
    handle: FileHandle,
    localPath: string,
    request: SessionStorageReservationRequest,
  ) {
    this.#handle = handle
    this.localPath = localPath
    this.#request = request
  }

  public async write(offset: number, chunk: Uint8Array): Promise<void> {
    const handle = this.#requireOpen()
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset + chunk.byteLength > this.#request.declaredSize
    ) {
      throw new RemoteTabError('FILE_LIMIT_EXCEEDED', 'File chunk exceeds its reservation')
    }
    const result = await handle.write(chunk, 0, chunk.byteLength, offset)
    if (result.bytesWritten !== chunk.byteLength) {
      throw new Error('Session storage wrote a partial file chunk')
    }
  }

  public async commit(): Promise<StoredSessionFile> {
    const handle = this.#requireOpen()
    await handle.sync()
    await handle.close()
    this.#handle = undefined
    const actual = await stat(this.localPath)
    if (actual.size !== this.#request.declaredSize) {
      await rm(this.localPath, { force: true })
      throw new RemoteTabError('FILE_LIMIT_EXCEEDED', 'Completed file size does not match reservation')
    }
    this.#committed = true
    return {
      storageKey: this.localPath,
      localPath: this.localPath,
      displayName: this.#request.displayName,
      size: actual.size,
      ...(this.#request.mimeType === undefined ? {} : { mimeType: this.#request.mimeType }),
    }
  }

  public async abort(): Promise<void> {
    const handle = this.#handle
    this.#handle = undefined
    await handle?.close().catch(() => undefined)
    await rm(this.localPath, { force: true })
  }

  #requireOpen(): FileHandle {
    if (this.#handle === undefined || this.#committed) {
      throw new RemoteTabError('SESSION_CLOSED', 'Session storage reservation is closed')
    }
    return this.#handle
  }
}
