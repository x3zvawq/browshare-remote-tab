import { RemoteTabError, type ProtocolPayload, type WindowState } from '@browshare/remote-tab-protocol'

type Frame = ProtocolPayload<'window.state'>

export class WindowCatalogReceiver {
  #latestRevision = -1
  #pending: { first: Frame; windows: WindowState['windows'] } | undefined

  get pending(): boolean { return this.#pending !== undefined }

  reset(): void { this.#latestRevision = -1; this.#pending = undefined }

  accept(frame: Frame): WindowState | undefined {
    if (frame.catalogRevision < this.#latestRevision ||
        (frame.catalogRevision === this.#latestRevision && this.#pending === undefined)) return undefined
    if (frame.catalogRevision > this.#latestRevision) {
      if (frame.offset !== 0) throw invalidCatalog()
      this.#latestRevision = frame.catalogRevision
      this.#pending = { first: frame, windows: [] }
    }
    const pending = this.#pending!
    const first = pending.first
    if (frame.offset !== pending.windows.length || frame.total !== first.total ||
        frame.revision !== first.revision || frame.selectedTargetId !== first.selectedTargetId ||
        frame.selecting !== first.selecting || frame.requestId !== first.requestId ||
        frame.offset + frame.windows.length > frame.total) throw invalidCatalog()
    pending.windows.push(...frame.windows)
    if (pending.windows.length !== frame.total) return undefined
    this.#pending = undefined
    return {
      revision: first.revision, selectedTargetId: first.selectedTargetId, selecting: first.selecting,
      windows: pending.windows,
      ...(first.requestId === undefined ? {} : { requestId: first.requestId }),
      ...(first.error === undefined ? {} : { error: first.error }),
    }
  }
}

function invalidCatalog(): RemoteTabError {
  return new RemoteTabError('PROTOCOL_MESSAGE_INVALID', 'Window catalog frames do not form one ordered snapshot')
}
