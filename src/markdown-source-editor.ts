import { EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor, rectangularSelection, crosshairCursor, keymap, lineNumbers } from '@codemirror/view'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { bracketMatching, defaultHighlightStyle, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
import { lintKeymap } from '@codemirror/lint'
import { markdown } from '@codemirror/lang-markdown'
import { vim } from '@replit/codemirror-vim'
import type { DocumentFormat } from './org-format.js'

export type LineNumberMode = 'off' | 'absolute' | 'relative'

/** Gutter label for one line. Relative mode keeps the cursor line absolute. */
export function formatEditorLineNumber(mode: LineNumberMode, line: number, cursorLine: number): string {
  if (mode === 'off') return ''
  if (mode === 'absolute' || line === cursorLine) return String(line)
  return String(Math.abs(line - cursorLine))
}

/**
 * Gutter label for a preview block spanning 1-based inclusive source lines
 * [startLine, endLine]. The label is anchored on the block's first line and
 * stays narrow: absolute mode always shows just `S`, however many source lines
 * the block covers. Relative mode shows the distance to the block and keeps the
 * cursor's absolute line while the cursor sits inside the range, mirroring Vim.
 */
export function formatPreviewBlockLine(mode: LineNumberMode, startLine: number, endLine: number, cursorLine: number): string {
  if (mode === 'off') return ''
  const last = Math.max(startLine, endLine)
  if (mode === 'absolute') return String(startLine)
  if (cursorLine >= startLine && cursorLine <= last) return String(cursorLine)
  return String(Math.min(Math.abs(cursorLine - startLine), Math.abs(cursorLine - last)))
}

/** 0-based source lines owned by one preview block, skipping lines claimed by a nested annotated block. */
export function uncoveredSourceLines(start: number, end: number, nested: Array<[number, number]>): number[] {
  if (!Number.isFinite(start) || start < 0) return []
  const last = Number.isFinite(end) ? end : start + 1
  const covered = new Set<number>()
  for (const [childStart, childEnd] of nested) {
    if (!Number.isFinite(childStart) || childStart < 0) continue
    const childLast = Number.isFinite(childEnd) ? childEnd : childStart + 1
    for (let line = childStart; line < childLast; line++) covered.add(line)
  }
  const lines: number[] = []
  for (let line = start; line < Math.max(start + 1, last); line++) {
    if (!covered.has(line)) lines.push(line)
  }
  return lines
}

const editorBaseExtensions: Extension[] = [
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  history(),
  foldGutter(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  bracketMatching(),
  closeBrackets(),
  autocompletion(),
  rectangularSelection(),
  crosshairCursor(),
  highlightActiveLine(),
  highlightSelectionMatches(),
  keymap.of([
    ...closeBracketsKeymap,
    ...defaultKeymap,
    ...searchKeymap,
    ...historyKeymap,
    ...foldKeymap,
    ...completionKeymap,
    ...lintKeymap,
  ]),
]

export interface MarkdownEditorPlugin {
  name: string
  extension: Extension
}

export function createVimEditorPlugin(): MarkdownEditorPlugin {
  return { name: 'vim', extension: vim({ status: true }) }
}

export class MarkdownSourceEditor {
  readonly view: EditorView
  private readonly lineNumberCompartment = new Compartment()
  private lineNumberMode: LineNumberMode
  private relativeCursorLine = 1
  private relativeRefreshQueued = false

  constructor(options: {
    parent: HTMLElement
    document: string
    format?: DocumentFormat
    plugins?: MarkdownEditorPlugin[]
    lineNumbers?: LineNumberMode
    onChange?: (value: string) => void
    onSelectionChange?: (offset: number) => void
  }) {
    this.lineNumberMode = options.lineNumbers || 'absolute'
    const extensions: Extension[] = [
      editorBaseExtensions,
      this.lineNumberCompartment.of(this.lineNumberExtension()),
      EditorView.lineWrapping,
      EditorView.theme({
        '&': { height: '100%', fontSize: '14px' },
        '.cm-scroller': { overflow: 'auto', fontFamily: "'Cascadia Code', Consolas, monospace" },
        '.cm-content': { padding: '12px 0' },
        '.cm-lineNumbers .cm-gutterElement': { fontVariantNumeric: 'tabular-nums', minWidth: '2.6em', padding: '0 8px 0 4px' },
      }),
    ]
    if (options.format !== 'org') extensions.splice(1, 0, markdown())
    for (const plugin of options.plugins || []) extensions.push(plugin.extension)
    extensions.push(EditorView.updateListener.of(update => {
      if (update.docChanged) options.onChange?.(update.state.doc.toString())
      if (update.docChanged || update.selectionSet) {
        options.onSelectionChange?.(update.state.selection.main.head)
        this.scheduleRelativeLineNumbers()
      }
    }))
    this.view = new EditorView({
      state: EditorState.create({ doc: options.document, extensions }),
      parent: options.parent,
    })
  }

  getValue(): string {
    return this.view.state.doc.toString()
  }

  /** Absolute offset of the main cursor, for cross-mode line tracking. */
  getCursorOffset(): number {
    return this.view.state.selection.main.head
  }

  focus() {
    this.view.focus()
  }

  setLineNumberMode(mode: LineNumberMode) {
    this.lineNumberMode = mode
    this.relativeCursorLine = this.view.state.doc.lineAt(this.view.state.selection.main.head).number
    this.reconfigureLineNumbers()
  }

  private lineNumberExtension(): Extension {
    if (this.lineNumberMode === 'off') return []
    const mode = this.lineNumberMode
    const cursorLine = this.relativeCursorLine
    return lineNumbers({
      formatNumber: line => formatEditorLineNumber(mode, line, cursorLine),
    })
  }

  private reconfigureLineNumbers() {
    this.view.dispatch({
      effects: this.lineNumberCompartment.reconfigure(this.lineNumberExtension()),
    })
  }

  private scheduleRelativeLineNumbers() {
    if (this.lineNumberMode !== 'relative' || this.relativeRefreshQueued || !this.view) return
    const line = this.view.state.doc.lineAt(this.view.state.selection.main.head).number
    if (line === this.relativeCursorLine) return
    this.relativeRefreshQueued = true
    queueMicrotask(() => {
      this.relativeRefreshQueued = false
      if (!this.view.dom.isConnected) return
      const next = this.view.state.doc.lineAt(this.view.state.selection.main.head).number
      if (next === this.relativeCursorLine) return
      this.relativeCursorLine = next
      this.reconfigureLineNumbers()
    })
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
