import { CURSOR_KINDS, type CursorKind } from '@browshare/remote-tab-protocol'

const WORLD = 'browshare.cursor'
const BINDING = '__browshareCursor'
const STOP = '__browshareStopCursor'
interface Event { method: string; params: Readonly<Record<string, unknown>>; sessionId?: string }
interface Connection {
  call<T = Readonly<Record<string, unknown>>>(method: string, params?: Readonly<Record<string, unknown>>, sessionId?: string): Promise<T>
  onEvent(listener: (event: Event) => void): () => void
}

// Isolated worlds read computed presentation only. No text, URLs, selectors or cursor image bytes
// leave the renderer. Event-driven sampling deduplicates changes without a per-pointer CDP query.
const SOURCE = `(() => {
 if (globalThis.${STOP}) return;
 const allowed = new Set(${JSON.stringify(CURSOR_KINDS)});
 let point, previous, frame;
 const send = cursor => { if (cursor !== previous) { previous = cursor; globalThis.${BINDING}(cursor); } };
 const sample = () => {
  frame = undefined;
  if (!point) return;
  let element = document.elementFromPoint(point.x, point.y);
  while (element?.shadowRoot) { const child = element.shadowRoot.elementFromPoint(point.x, point.y); if (!child || child === element) break; element = child; }
  if (!element) { send('default'); return; }
  // The child document owns its cursor, including out-of-process cross-origin frames.
  if (element instanceof HTMLIFrameElement || element instanceof HTMLFrameElement) return;
  const style = getComputedStyle(element);
  let cursor = style.cursor.trim().split(',').pop().trim();
  if (cursor === 'auto') {
   const textInput = element instanceof HTMLTextAreaElement || (element instanceof HTMLInputElement && ['text','search','email','url','tel','password','number'].includes(element.type));
   let text = false;
   const caret = document.caretPositionFromPoint?.(point.x, point.y, { shadowRoots: element.getRootNode() instanceof ShadowRoot ? [element.getRootNode()] : [] });
   if (caret?.offsetNode?.nodeType === Node.TEXT_NODE) {
    const range = document.createRange(); range.selectNodeContents(caret.offsetNode);
    text = [...range.getClientRects()].some(r => point.x >= r.left && point.x <= r.right && point.y >= r.top && point.y <= r.bottom);
   }
   cursor = (textInput && !element.disabled) || element.isContentEditable || (text && style.userSelect !== 'none') ? (style.writingMode.startsWith('vertical') ? 'vertical-text' : 'text') : 'default';
  }
  send(allowed.has(cursor) ? cursor : 'default');
 };
 const schedule = () => { if (frame === undefined) frame = requestAnimationFrame(sample); };
 const move = event => { point = { x: event.clientX, y: event.clientY }; schedule(); };
 const enter = event => { previous = undefined; move(event); };
 const leave = event => { if (!event.relatedTarget) { point = undefined; send('default'); } };
 document.addEventListener('pointermove', move, true);
 document.addEventListener('pointerover', enter, true);
 document.addEventListener('pointerout', leave, true);
 document.addEventListener('scroll', schedule, true);
 const observer = new MutationObserver(schedule);
 observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class','style','disabled','contenteditable'] });
 globalThis.${STOP} = () => { observer.disconnect(); cancelAnimationFrame(frame); document.removeEventListener('pointermove', move, true); document.removeEventListener('pointerover', enter, true); document.removeEventListener('pointerout', leave, true); document.removeEventListener('scroll', schedule, true); delete globalThis.${STOP}; };
})()`

/** One root page and only its auto-attached iframe targets; popup ownership stays in CdpTabController. */
export class CdpCursorObserver {
  readonly #sessions = new Map<string, { script?: string; contexts: Map<number, string> }>()
  readonly #operations = new Set<Promise<void>>()
  readonly #unsubscribe: () => void
  #cursorOwner: { sessionId: string; contextId: number } | undefined
  #rootFrameId: string | undefined
  #point: { x: number; y: number } | undefined
  #cursorRevision = 0
  #closed = false
  pointer(x: number, y: number): void { this.#point = { x, y } }
  constructor(readonly connection: Connection, readonly root: string, readonly publish: (cursor: CursorKind) => void) {
    this.#sessions.set(root, { contexts: new Map() })
    this.#unsubscribe = connection.onEvent(event => this.#event(event))
  }
  start(): Promise<void> { return this.#install(this.root) }
  async #install(sessionId: string): Promise<void> {
    const state = this.#sessions.get(sessionId)
    if (!state || this.#closed) return
    await this.connection.call('Runtime.enable', {}, sessionId)
    await this.connection.call('Page.enable', {}, sessionId)
    if (sessionId === this.root) {
      const { frameTree } = await this.connection.call<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree', {}, sessionId)
      this.#rootFrameId = frameTree.frame.id
    }
    await this.connection.call('Runtime.addBinding', { name: BINDING, executionContextName: WORLD }, sessionId)
    const { identifier } = await this.connection.call<{ identifier: string }>('Page.addScriptToEvaluateOnNewDocument', { source: SOURCE, worldName: WORLD, runImmediately: true }, sessionId)
    state.script = identifier
    if (!this.#closed) await this.connection.call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'iframe', exclude: false }] }, sessionId)
  }
  #event(event: Event): void {
    if (this.#closed || !event.sessionId || !this.#sessions.has(event.sessionId)) return
    const state = this.#sessions.get(event.sessionId)!
    if (event.method === 'Target.attachedToTarget') {
      const child = event.params.sessionId, info = event.params.targetInfo as { type?: string } | undefined
      if (typeof child !== 'string' || info?.type !== 'iframe') return
      this.#sessions.set(child, { contexts: new Map() })
      const operation = this.#install(child).catch(() => {
        // A frame can disappear during navigation. Cursor feedback is presentation only.
        this.publish('default')
      }).finally(() => this.#operations.delete(operation))
      this.#operations.add(operation)
    } else if (event.method === 'Target.detachedFromTarget') {
      if (typeof event.params.sessionId === 'string') this.#sessions.delete(event.params.sessionId)
      if (event.params.sessionId === this.#cursorOwner?.sessionId) { this.#cursorOwner = undefined; this.#cursorRevision += 1; this.publish('default') }
    } else if (event.method === 'Runtime.executionContextCreated') {
      const context = event.params.context as { id?: number; name?: string; auxData?: { frameId?: string } } | undefined
      if (context?.name === WORLD && typeof context.id === 'number' && typeof context.auxData?.frameId === 'string') state.contexts.set(context.id, context.auxData.frameId)
    } else if (event.method === 'Runtime.executionContextsCleared') {
      state.contexts.clear()
      if (event.sessionId === this.root || event.sessionId === this.#cursorOwner?.sessionId) { this.#cursorOwner = undefined; this.#cursorRevision += 1; this.publish('default') }
    } else if (event.method === 'Runtime.executionContextDestroyed') {
      if (typeof event.params.executionContextId === 'number') state.contexts.delete(event.params.executionContextId)
      if (event.sessionId === this.#cursorOwner?.sessionId && event.params.executionContextId === this.#cursorOwner.contextId) { this.#cursorOwner = undefined; this.#cursorRevision += 1; this.publish('default') }
    } else if (event.method === 'Runtime.bindingCalled' && event.params.name === BINDING &&
      typeof event.params.executionContextId === 'number' && state.contexts.has(event.params.executionContextId) &&
      typeof event.params.payload === 'string' && (CURSOR_KINDS as readonly string[]).includes(event.params.payload)) {
      const revision = ++this.#cursorRevision
      const owner = { sessionId: event.sessionId, contextId: event.params.executionContextId }
      const cursor = event.params.payload as CursorKind
      const frameId = state.contexts.get(owner.contextId)
      if (frameId === this.#rootFrameId) { this.#cursorOwner = owner; this.publish(cursor) }
      else if (this.#point) {
        // OOPIF pointer events can arrive after a parent overlay has covered that frame.
        // Verify only cursor changes against Chrome's hit-test; never query per pointer move.
        const operation = this.connection.call<{ frameId: string; backendNodeId: number }>('DOM.getNodeForLocation', {
          // CDP hit-testing takes integer CSS pixels; Input.dispatchMouseEvent keeps its
          // original fractional coordinates when the Viewer scales the remote viewport.
          x: Math.floor(this.#point.x), y: Math.floor(this.#point.y), includeUserAgentShadowDOM: true,
        }, this.root).then(async hit => {
          let hitFrame = hit.frameId
          if (hitFrame !== frameId) {
            // The root CDP session reports an OOPIF's frame-owner element. Its frameId identifies
            // the child document without reading that document or returning page content.
            const { node } = await this.connection.call<{ node: { frameId?: string } }>('DOM.describeNode', { backendNodeId: hit.backendNodeId, depth: 0 }, this.root)
            hitFrame = node.frameId ?? hitFrame
          }
          if (!this.#closed && revision === this.#cursorRevision && hitFrame === frameId) {
            this.#cursorOwner = owner; this.publish(cursor)
          }
        }).catch(() => undefined).finally(() => this.#operations.delete(operation))
        this.#operations.add(operation)
      }
    }
  }
  async close(browserClosed = false): Promise<void> {
    this.#closed = true
    this.#unsubscribe()
    await Promise.allSettled(this.#operations)
    if (!browserClosed) await Promise.allSettled([...this.#sessions].map(async ([sessionId, state]) => {
      if (state.script) await this.connection.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: state.script }, sessionId)
      await Promise.allSettled([...state.contexts.keys()].map(contextId => this.connection.call('Runtime.evaluate', { expression: `globalThis.${STOP}?.()`, contextId }, sessionId)))
    }))
    if (!browserClosed) await this.connection.call('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }, this.root).catch(() => undefined)
    this.#sessions.clear()
  }
}
