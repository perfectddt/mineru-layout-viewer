/**
 * Cross-window messaging for the viewer.
 *
 * Several viewer windows may show the same document at once. BroadcastChannel
 * is the only transport that works for every way a window can be opened here
 * (a launcher URL, `window.open`, or a duplicate tab), it never echoes to the
 * sender, and it keeps messages off the main thread's DOM.
 *
 * The document text stays the single source of truth, so a message carries the
 * whole text plus a monotonically increasing revision. A receiver drops
 * anything it has already applied, which keeps a burst of edits ordered without
 * needing per-window clocks.
 */

export const VIEWER_WINDOW_CHANNEL = 'mineru-layout-viewer-windows-v1'

export interface ViewerDocumentPayload {
  text: string
  format: 'markdown' | 'org'
  name: string
  /** View mode the receiving window should adopt. */
  mode: string
}

export type ViewerWindowMessage =
  /** A window just came up and would like the current document. */
  | { type: 'hello'; windowId: string }
  /** Reply to `hello`, telling the newcomer it is not alone. */
  | { type: 'welcome'; windowId: string }
  /** Ask whoever owns the document to send it. */
  | { type: 'request-document'; windowId: string }
  /** The document, either after a handshake or after an edit. */
  | { type: 'document'; windowId: string; revision: number; document: ViewerDocumentPayload }
  /** The window is closing so peers can drop it from their peer count. */
  | { type: 'bye'; windowId: string }

function createWindowId(): string {
  const random = Math.random().toString(36).slice(2, 10)
  return `w-${Date.now().toString(36)}-${random}`
}

export class ViewerWindowChannel {
  readonly windowId = createWindowId()
  private channel: BroadcastChannel | null = null
  private listeners = new Set<(message: ViewerWindowMessage) => void>()

  constructor(name = VIEWER_WINDOW_CHANNEL) {
    try {
      this.channel = new BroadcastChannel(name)
      this.channel.addEventListener('message', event => {
        const message = event.data as ViewerWindowMessage | undefined
        if (!message || typeof message !== 'object') return
        // BroadcastChannel does not deliver to the sender, but a duplicated
        // window inherits nothing, so this guard is cheap insurance.
        if ('windowId' in message && message.windowId === this.windowId) return
        for (const listener of this.listeners) listener(message)
      })
    } catch {
      // Private mode or an unsupported engine: the viewer still works alone.
      this.channel = null
    }
  }

  get supported(): boolean {
    return this.channel !== null
  }

  subscribe(listener: (message: ViewerWindowMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  post(message: ViewerWindowMessage): void {
    try {
      this.channel?.postMessage(message)
    } catch {
      // A channel can be closed by the browser during unload; ignore.
    }
  }

  close(): void {
    this.listeners.clear()
    try {
      this.channel?.close()
    } catch {
      // Already closed.
    }
    this.channel = null
  }
}
