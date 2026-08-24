import { basicSetup, EditorView } from 'codemirror'
import { EditorState, type Extension } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { vim } from '@replit/codemirror-vim'

export interface MarkdownEditorPlugin {
  name: string
  extension: Extension
}

export function createVimEditorPlugin(): MarkdownEditorPlugin {
  return { name: 'vim', extension: vim({ status: true }) }
}

export class MarkdownSourceEditor {
  readonly view: EditorView

  constructor(options: {
    parent: HTMLElement
    document: string
    plugins?: MarkdownEditorPlugin[]
    onChange?: (value: string) => void
    onSelectionChange?: (offset: number) => void
  }) {
    const extensions: Extension[] = [
      basicSetup,
      markdown(),
      EditorView.lineWrapping,
      EditorView.theme({
        '&': { height: '100%', fontSize: '14px' },
        '.cm-scroller': { overflow: 'auto', fontFamily: "'Cascadia Code', Consolas, monospace" },
        '.cm-content': { padding: '12px 0' },
      }),
    ]
    for (const plugin of options.plugins || []) extensions.push(plugin.extension)
    if (options.onChange || options.onSelectionChange) {
      extensions.push(EditorView.updateListener.of(update => {
        if (update.docChanged) options.onChange?.(update.state.doc.toString())
        if (update.docChanged || update.selectionSet) {
          options.onSelectionChange?.(update.state.selection.main.head)
        }
      }))
    }
    this.view = new EditorView({
      state: EditorState.create({ doc: options.document, extensions }),
      parent: options.parent,
    })
  }

  getValue(): string {
    return this.view.state.doc.toString()
  }

  focus() {
    this.view.focus()
  }

  goTo(offset: number, length = 0) {
    const position = Math.max(0, Math.min(offset, this.view.state.doc.length))
    // Focus first: the Vim extension may restore its remembered cursor when a
    // blurred editor receives focus, which would otherwise undo this jump.
    this.focus()
    this.view.dispatch({
      selection: { anchor: position, head: Math.min(position + length, this.view.state.doc.length) },
      effects: EditorView.scrollIntoView(position, { y: 'center' }),
    })
  }

  destroy() {
    this.view.destroy()
  }
}
