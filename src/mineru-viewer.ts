import JSZip from 'jszip'
import { appendPageFurniture, isPageFurnitureType, parseBlocks, normalizeAssetPath } from './parse-blocks.js'
import { jsonTextsByPath, projectJsonOntoMarkdown, projectMarkdownOntoJson } from './markdown-json-sync.js'
import { matchSectionsToPdf, normalize, lcsSimilarity } from './match-markdown.js'
import { parseMarkdownSections } from './parse-markdown.js'
import { MarkdownPreviewRenderer, type MarkdownRenderPlugin } from './markdown-preview.js'
import { createElegantReadingTheme, createRichMarkdownPlugin } from './rich-markdown-plugin.js'
import { documentFormatFromName, orgToMarkdown, type DocumentFormat } from './org-format.js'
import {
  MarkdownSourceEditor,
  createVimEditorPlugin,
  formatPreviewBlockLine,
  uncoveredSourceLines,
  type LineNumberMode,
  type MarkdownEditorPlugin,
} from './markdown-source-editor.js'
import {
  deleteMindmapNode,
  insertMindmapChild,
  insertMindmapSibling,
  layoutMindmap,
  mindmapNodeAtLine,
  mindmapParentIds,
  mindmapPathIds,
  moveMindmapNode,
  parseMindmapTree,
  renameMindmapNode,
  shiftMindmapSubtree,
  type MindmapDropPosition,
  type MindmapLayout,
  type MindmapNode,
  type MindmapTree,
} from './mindmap-model.js'
import { ViewerWindowChannel, type ViewerDocumentPayload, type ViewerWindowMessage } from './window-channel.js'
import type { PdfBlock, MdSection } from './parse-blocks.js'

declare const pdfjsLib: typeof import('pdfjs-dist')

export type PdfRenderMode = 'fast' | 'quality'
/** How the right pane renders the source: rendered, in-place editable, code, or mind map. */
export type MarkdownViewMode = 'preview' | 'live' | 'source' | 'mindmap'
const PDF_VIRTUAL_MARGIN = 900

/** Narrow a value that arrived from another window. */
function isMarkdownViewMode(value: string): value is MarkdownViewMode {
  return value === 'preview' || value === 'live' || value === 'source' || value === 'mindmap'
}

/**
 * The deepest <mineru-layout-viewer> in an event path. Split panes nest a
 * viewer inside the main one's shadow DOM, so "path includes this" is true
 * for both; the innermost host is the one that should react.
 */
function innermostViewerHost(path: EventTarget[]): MineruLayoutViewer | null {
  for (const node of path) {
    if (node instanceof MineruLayoutViewer) return node
  }
  return null
}

function pageFurnitureLabel(type?: string): string {
  switch ((type || '').toLowerCase()) {
    case 'page_number':
    case 'page-number':
      return '页码'
    case 'header':
    case 'page_header':
      return '页眉'
    case 'footer':
    case 'page_footer':
      return '页脚'
    case 'page_footnote':
      return '页脚注'
    case 'aside_text':
    case 'page_aside_text':
      return '边注'
    default:
      return '页面信息'
  }
}

/** Page labels inserted after the last Markdown block of each PDF page. */
export function pageMarkersAfterSections(pages: number[]): Array<{ afterIndex: number, page: number }> {
  const markers: Array<{ afterIndex: number, page: number }> = []
  let lastPage = 0
  let lastIndex = -1
  pages.forEach((page, index) => {
    if (!page) return
    if (lastPage && page !== lastPage && lastIndex >= 0) markers.push({ afterIndex: lastIndex, page: lastPage })
    lastPage = page
    lastIndex = index
  })
  if (lastPage && lastIndex >= 0) markers.push({ afterIndex: lastIndex, page: lastPage })
  return markers
}

export function computePdfRenderScale(
  mode: PdfRenderMode,
  cssWidth: number,
  pageWidth: number,
  pixelRatio: number,
): number {
  const cssScale = Math.max(0.1, cssWidth / Math.max(pageWidth, 1))
  if (mode === 'fast') return Math.max(0.75, Math.min(1.15, cssScale))
  return Math.max(1.75, Math.min(3, cssScale * Math.max(pixelRatio, 1)))
}

/** Character offset of a 1-based source line. Out-of-range lines clamp to the document. */
export function sourceOffsetForLine(text: string, lineNumber: number): number {
  const normalized = text.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  const lineCount = Math.max(1, lines.length)
  const line = Number.isFinite(lineNumber) ? Math.floor(lineNumber) : 1
  const index = Math.min(Math.max(line, 1), lineCount) - 1
  let offset = 0
  for (let current = 0; current < index; current++) offset += lines[current].length + 1
  return Math.min(offset, normalized.length)
}

/** Command line understood by the rendered preview when Vim mode is on. */
export type ViewerVimCommand =
  | { kind: 'none' }
  | { kind: 'goto'; line: number | 'last' }
  | { kind: 'write' }
  | { kind: 'noh' }
  | { kind: 'unknown'; command: string }

/**
 * Parse a `:` command typed over the rendered Markdown. Only commands the
 * rendered view can honour are recognised; everything else is reported back
 * the way Vim reports E492. `:0` matches Vim by landing on the first line.
 */
export function parseViewerVimCommand(input: string): ViewerVimCommand {
  const command = input.trim()
  if (!command) return { kind: 'none' }
  if (/^\d+$/.test(command)) return { kind: 'goto', line: Math.max(1, Number(command)) }
  if (command === '$') return { kind: 'goto', line: 'last' }
  if (command === 'w' || command === 'write' || command === 'wq') return { kind: 'write' }
  if (command === 'noh' || command === 'nohlsearch' || command === 'nohls') return { kind: 'noh' }
  return { kind: 'unknown', command }
}

/**
 * Normal-mode state kept while the rendered preview owns Vim keys: digits
 * collected so far and whether the first `g` of a `gg` sequence is pending.
 */
export interface ViewerVimNormalState {
  count: string
  pendingG: boolean
}

export function initialViewerVimNormalState(): ViewerVimNormalState {
  return { count: '', pendingG: false }
}

export type ViewerVimNormalAction =
  | { kind: 'none' } // recognised but incomplete: keep collecting
  | { kind: 'ignored' } // not a Vim motion: reset and let the page see it
  | { kind: 'goto'; line: number | 'first' | 'last' }
  | { kind: 'search-repeat'; reverse: boolean }
  | { kind: 'reset' } // Escape or a broken sequence: clear pending state

/**
 * Feed one key into the normal-mode buffer. `gg`/`G` jump to the first/last
 * line, a leading count retargets them (`42G`, `3gg`), `n`/`N` repeat the
 * last `/` search. Bare `0` is not a count start (Vim treats it as a column
 * motion, meaningless over a rendered page) and is ignored.
 */
export function pushViewerVimNormalKey(
  state: ViewerVimNormalState,
  key: string,
): { state: ViewerVimNormalState; action: ViewerVimNormalAction } {
  const reset = initialViewerVimNormalState()
  if (key === 'Escape') return { state: reset, action: { kind: 'reset' } }
  if (/^[0-9]$/.test(key)) {
    if (state.pendingG) return { state: reset, action: { kind: 'ignored' } }
    if (key === '0' && state.count === '') return { state: reset, action: { kind: 'ignored' } }
    return { state: { count: state.count + key, pendingG: false }, action: { kind: 'none' } }
  }
  if (key === 'g') {
    if (state.pendingG) {
      const line = state.count ? Math.max(1, Number(state.count)) : 'first'
      return { state: reset, action: { kind: 'goto', line } }
    }
    return { state: { count: state.count, pendingG: true }, action: { kind: 'none' } }
  }
  if (key === 'G') {
    const line = state.count ? Math.max(1, Number(state.count)) : 'last'
    return { state: reset, action: { kind: 'goto', line } }
  }
  if (key === 'n') return { state: reset, action: { kind: 'search-repeat', reverse: false } }
  if (key === 'N') return { state: reset, action: { kind: 'search-repeat', reverse: true } }
  if (state.count || state.pendingG) return { state: reset, action: { kind: 'ignored' } }
  return { state, action: { kind: 'ignored' } }
}

/**
 * Source ranges a rendered preview cannot derive from markdown-it token
 * maps: raw HTML `<table>` blocks (token attributes never reach their DOM)
 * and `$$...$$` display math emitted as custom tags. Markdown pipe tables
 * and Org tables already carry correct `data-md-*` attributes from the
 * renderer, so they are not scanned here. The scan skips fenced code, so
 * pipe or `$$` lines inside ``` blocks never create phantom ranges, and
 * ignores lines indented 4+ spaces (indented code). Ranges are `[start,
 * end)` over 0-based source lines.
 */
export function scanUnmappedSourceRanges(source: string): {
  tables: Array<[number, number]>
  displayMath: Array<[number, number]>
} {
  const tables: Array<[number, number]> = []
  const displayMath: Array<[number, number]> = []
  const lines = source.split(/\r?\n/)
  let fenceChar = ''
  let fenceLength = 0
  let mathStart = -1
  let htmlTableStart = -1
  lines.forEach((line, index) => {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1]
      if (!fenceChar) {
        fenceChar = marker[0]
        fenceLength = marker.length
      } else if (marker[0] === fenceChar && marker.length >= fenceLength) {
        fenceChar = ''
        fenceLength = 0
      }
      return
    }
    if (fenceChar) return
    const delimiters = (line.match(/\$\$/g) || []).length
    if (mathStart < 0 && delimiters) {
      mathStart = index
      if (delimiters > 1) {
        displayMath.push([index, index + 1])
        mathStart = -1
      }
    } else if (mathStart >= 0 && delimiters) {
      displayMath.push([mathStart, index + 1])
      mathStart = -1
    }
    if (htmlTableStart < 0 && /<table\b/i.test(line)) htmlTableStart = index
    if (htmlTableStart >= 0 && /<\/table\s*>/i.test(line)) {
      tables.push([htmlTableStart, index + 1])
      htmlTableStart = -1
    }
  })
  if (htmlTableStart >= 0) tables.push([htmlTableStart, lines.length])
  return { tables, displayMath }
}

interface PdfPageState {
  p: number
  w: number
  h: number
  rendered: boolean
  renderVersion: number
  rendering?: Promise<void>
  renderTask?: { cancel(): void }
}

interface ReviewEdit {
  type: 'replace-image' | 'remove-image-reference' | 'remove-image-and-reference' | 'image-to-text' | 'edit-markdown' | 'replace-text'
  imagePath?: string
  detail?: string
  timestamp: string
  page?: number
  blockId?: string
  markdownStart?: number
}

type UndoAction =
  | { type: 'restore-markdown'; markdown: string }
  | { type: 'restore-image'; zipPath: string; data: Uint8Array | null }
  | { type: 'restore-markdown-and-image'; markdown: string; zipPath: string; data: Uint8Array | null }

interface PdfOutlineItem {
  title: string
  dest?: string | unknown[] | null
  items?: PdfOutlineItem[]
}

interface SearchResult {
  start: number
  end: number
  sectionIndex: number
  snippet: string
  match: string
}

interface LiveEditSession {
  element: HTMLElement
  start: number
  end: number
  originalEnd: number
  originalDocument: string
  originalSections: MdSection[]
  changed: boolean
  kind?: 'block' | 'table-cell'
}

type OutlineLayout = 'side' | 'stack'

interface ViewerSettings {
  workspaceLayout: OutlineLayout
  workspaceLeftPercent: number
  standaloneSourceLayout: OutlineLayout
  standaloneSourceFirstPercent: number
  standaloneSourceSwapped: boolean
  pdfOutlineLayout: OutlineLayout
  pdfOutlineSize: number
  markdownOutlineLayout: OutlineLayout
  markdownOutlineSize: number
  pdfRenderMode: PdfRenderMode
  lineNumberMode: LineNumberMode
}

const VIEWER_SETTINGS_KEY = 'mineru-layout-viewer-settings-v1'
const LEGACY_RENDER_PLUGIN_KEY = 'mineru-layout-viewer-default-render-plugin-v1'
const RENDER_PLUGIN_KEYS: Record<DocumentFormat, string> = {
  markdown: 'mineru-layout-viewer-default-markdown-plugin-v2',
  org: 'mineru-layout-viewer-default-org-plugin-v2',
}
const RENDER_PLUGIN_STACK_KEYS: Record<DocumentFormat, string> = {
  markdown: 'mineru-layout-viewer-markdown-plugin-stack-v3',
  org: 'mineru-layout-viewer-org-plugin-stack-v3',
}
const DEFAULT_VIEWER_SETTINGS: ViewerSettings = {
  workspaceLayout: 'side',
  workspaceLeftPercent: 50,
  standaloneSourceLayout: 'side',
  standaloneSourceFirstPercent: 50,
  standaloneSourceSwapped: false,
  pdfOutlineLayout: 'side',
  pdfOutlineSize: 33,
  markdownOutlineLayout: 'side',
  markdownOutlineSize: 33,
  pdfRenderMode: 'fast',
  lineNumberMode: 'absolute',
}

const STYLES = `
:host { position:relative; display:flex; flex-direction:column; height:100%; font-family:system-ui,sans-serif; color:#1f2937; background:#fff; }
* { box-sizing:border-box; }
.toolbar { display:flex; align-items:center; gap:8px; padding:7px 10px 7px calc(10px + var(--toolbar-leading, 0px)); border-bottom:1px solid #e5e7eb; font-size:12px; color:#6b7280; flex-shrink:0; flex-wrap:wrap; }
.toolbar .spacer { flex:1; }
.toolbar .ok { color:#16a34a; }
.toolbar .warn { color:#d97706; }
.toolbar .dirty { color:#b45309; font-weight:600; }
.load-progress { display:none; align-items:center; gap:7px; min-width:260px; }
.load-progress.open { display:flex; }
.load-progress-track { width:150px; height:7px; border-radius:999px; background:#e5e7eb; overflow:hidden; }
.load-progress-fill { width:0; height:100%; background:#2563eb; transition:width .2s; }
.load-progress-fill.indeterminate { width:38%; animation:progress-slide 1.15s linear infinite; }
.load-progress-text { min-width:180px; white-space:nowrap; }
@keyframes progress-slide { from { transform:translateX(-110%); } to { transform:translateX(290%); } }
.history-toggle { color:#b45309; border-color:#f59e0b; font-weight:600; }
.toolbar-group { display:flex; align-items:center; gap:4px; padding-left:7px; border-left:1px solid #e5e7eb; }
.toolbar-label { color:#6b7280; }
.zoom-value { min-width:42px; text-align:center; color:#374151; }
.line-number-mode { height:28px; border:1px solid #d1d5db; border-radius:5px; background:#fff; color:#374151; }
button { border:1px solid #d1d5db; border-radius:5px; padding:5px 9px; background:#fff; color:#374151; cursor:pointer; font:inherit; }
button:hover:not(:disabled) { border-color:#3b82f6; color:#1d4ed8; background:#eff6ff; }
button:disabled { cursor:not-allowed; opacity:.45; }
button.danger:hover:not(:disabled) { border-color:#dc2626; color:#b91c1c; background:#fef2f2; }
.split { position:relative; flex:1; display:grid; grid-template-columns:var(--workspace-left, 50%) 1fr; min-height:0; overflow:hidden; }
.split.swapped .left-column { order:2; border-right:0; border-left:1px solid #e5e7eb; }
.split.swapped .right-column { order:1; }
.split.workspace-stack { grid-template-columns:1fr; grid-template-rows:var(--workspace-left, 50%) 1fr; }
.split.workspace-stack .left-column { border-right:0; border-left:0; border-bottom:1px solid #e5e7eb; }
.split.workspace-stack.swapped .left-column { border-bottom:0; border-top:1px solid #e5e7eb; }
.split.markdown-only { grid-template-columns:1fr; }
.split.workspace-stack.markdown-only { grid-template-rows:1fr; }
.split.markdown-only .left-column { display:none; }
.workspace-divider { position:absolute; z-index:19; left:var(--workspace-left, 50%); top:0; bottom:0; width:9px; transform:translateX(-50%); cursor:col-resize; touch-action:none; }
.workspace-divider::after { content:''; position:absolute; top:42px; bottom:0; left:4px; width:1px; background:#cbd5e1; }
.swap-panes { position:absolute; z-index:20; left:50%; top:7px; transform:translateX(-50%); width:31px; height:28px; padding:0; border-radius:999px; box-shadow:0 2px 7px rgba(15,23,42,.14); font-size:17px; cursor:pointer; }
.workspace-divider.stack { left:0; right:0; top:var(--workspace-left, 50%); bottom:auto; width:auto; height:9px; transform:translateY(-50%); cursor:row-resize; }
.workspace-divider.stack::after { top:4px; bottom:auto; left:0; right:0; width:auto; height:1px; }
.workspace-divider.stack .swap-panes { left:50%; top:50%; transform:translate(-50%,-50%); }
.split.markdown-only .workspace-divider { display:none; }
.pane-column { min-width:0; min-height:0; display:flex; flex-direction:column; overflow:hidden; }
.left-column { border-right:1px solid #e5e7eb; }
.pane-toolbar { min-height:42px; display:flex; align-items:center; gap:5px; padding:6px 9px; border-bottom:1px solid #e5e7eb; flex-shrink:0; font-size:12px; color:#6b7280; background:#fff; }
.pane-toolbar select { height:28px; padding:2px 6px; border:1px solid #cbd5e1; border-radius:6px; background:#fff; color:#334155; font-size:12px; }
.split:not(.workspace-stack):not(.swapped) .left-column .pane-toolbar,.split:not(.workspace-stack).swapped .right-column .pane-toolbar { padding-right:28px; }
.split:not(.workspace-stack):not(.swapped) .right-column .pane-toolbar,.split:not(.workspace-stack).swapped .left-column .pane-toolbar { padding-left:28px; }
.pane-toolbar .spacer { flex:1; }
.pane-toolbar button.active { border-color:#2563eb; color:#1d4ed8; background:#eff6ff; }
.format-switch { display:inline-flex; border:1px solid #cbd5e1; border-radius:7px; overflow:hidden; }
.format-switch button { border:0; border-radius:0; background:transparent; color:#475569; }
.format-switch button.active { border:0; background:#2563eb; color:#fff; }
.format-switch button:disabled { opacity:.4; }
.json-editor { flex:1; min-width:0; min-height:0; margin:0; padding:14px 16px; border:0; resize:none; overflow:auto; background:#fff; color:#1f2937; font:13px/1.55 'Cascadia Code',Consolas,monospace; white-space:pre; }
.pane-body.json-view .outline-panel,.pane-body.json-view .outline-resizer,.pane-body.json-view > .pane,.pane-body.json-view #mdSplitGrid { display:none !important; }
.menu-toggle { padding:4px 7px; font-size:16px; line-height:1; }
.history-panel { display:none; max-height:245px; overflow:auto; border-bottom:1px solid #e5e7eb; background:#fffbeb; flex-shrink:0; }
.history-panel.open { display:block; }
.history-empty { padding:12px; color:#92400e; font-size:12px; }
.history-item { display:block; width:100%; text-align:left; border:0; border-bottom:1px solid #fde68a; border-radius:0; padding:8px 10px; background:transparent; }
.history-item small { display:block; margin-top:2px; color:#78716c; }
.pane-body { position:relative; flex:1; display:flex; min-width:0; min-height:0; overflow:hidden; --outline-size:33%; }
.pane-body.outline-stack { flex-direction:column; }
.outline-panel { display:none; flex:0 0 var(--outline-size); width:var(--outline-size); min-width:0; min-height:0; overflow:auto; background:#f8fafc; padding:5px 0; }
.pane-body.outline-open .outline-panel { display:block; }
.pane-body.outline-stack .outline-panel { width:auto; height:var(--outline-size); }
.outline-resizer { display:none; flex:0 0 6px; width:6px; cursor:col-resize; touch-action:none; background:linear-gradient(90deg,transparent 2px,#cbd5e1 2px,#cbd5e1 3px,transparent 3px); }
.pane-body.outline-open .outline-resizer { display:block; }
.pane-body.outline-stack .outline-resizer { width:auto; height:6px; cursor:row-resize; background:linear-gradient(transparent 2px,#cbd5e1 2px,#cbd5e1 3px,transparent 3px); }
.outline-item { display:block; width:100%; text-align:left; border:0; border-radius:0; padding:5px 9px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.outline-level { display:inline-block; width:2.35em; margin-right:5px; color:#64748b; font:600 10px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace; vertical-align:1px; }
.outline-search { position:sticky; top:0; z-index:2; padding:6px 7px; background:#f8fafc; border-bottom:1px solid #e5e7eb; }
.outline-search input { width:100%; height:28px; padding:3px 8px; border:1px solid #cbd5e1; border-radius:6px; color:#334155; background:#fff; font:12px/1.4 system-ui,sans-serif; outline:none; }
.outline-search input:focus { border-color:#3b82f6; box-shadow:0 0 0 2px #3b82f622; }
.outline-no-match { display:none; padding:10px; color:#9ca3af; font-size:12px; }
.outline-empty { padding:10px; color:#9ca3af; font-size:12px; }
.pane { flex:1; min-width:0; min-height:0; overflow:auto; padding:10px; }
/* Split panes: the markdown area becomes a grid of full editor groups. */
.md-split-grid { flex:1; min-width:0; min-height:0; display:grid; grid-template-columns:minmax(0,1fr); overflow:hidden; }
.md-split-grid > mineru-layout-viewer { min-width:0; min-height:0; box-shadow:inset 2px 0 0 #cbd5e1; }
.md-split-grid.has-splits > #mdPane { box-shadow:inset 0 0 0 1px #cbd5e1; }
.md-split-grid > .split-divider { background:#e2e8f0; z-index:6; transition:background .12s; }
.md-split-grid > .split-divider:hover,.md-split-grid > .split-divider.dragging { background:#60a5fa; }
.md-split-grid.dir-row > .split-divider { cursor:col-resize; }
.md-split-grid.dir-column > .split-divider { cursor:row-resize; }
.md-split-grid.split-dragging,.md-split-grid.split-dragging * { user-select:none !important; }
.md-split-grid.dir-row.split-dragging,.md-split-grid.dir-row.split-dragging * { cursor:col-resize !important; }
.md-split-grid.dir-column.split-dragging,.md-split-grid.dir-column.split-dragging * { cursor:row-resize !important; }
/* Embedded split panes keep only the mode toolbar; app-level chrome belongs to the main window. */
:host(.embedded) .toolbar { display:none !important; }
:host(.embedded) #saveLocalMarkdown { display:none !important; }
.pane-left { background:#f8fafc; }
.pane-right { display:flex; flex-direction:column; background:#fff; --md-zoom:1; --md-image-width:100%; --md-image-height:520px; }
.pdf-page { position:relative; margin:0 auto 12px; border:1px solid #e5e7eb; border-radius:4px; overflow:hidden; background:#fff; }
.pdf-page > canvas { display:block; width:100%; height:100%; }
.pdf-placeholder { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:#9ca3af; font-size:12px; }
.pdf-page .page-num { position:absolute; bottom:2px; right:4px; z-index:4; font-size:9px; color:#6b7280; background:rgba(255,255,255,.9); padding:1px 4px; border-radius:3px; }
.block-overlay { position:absolute; z-index:2; border:1px solid rgba(37,99,235,.58); background:rgba(37,99,235,.035); cursor:pointer; transition:all .12s; }
.block-overlay.page-furniture { z-index:1; border:1px dashed rgba(14,116,144,.72); background:rgba(14,116,144,.08); }
.block-overlay.page-furniture .furniture-label { position:absolute; left:0; right:0; bottom:0; padding:0 2px; overflow:hidden; color:#0f172a; font:9px/1.3 system-ui,sans-serif; white-space:nowrap; text-overflow:ellipsis; background:rgba(255,255,255,.9); pointer-events:none; }
.block-overlay.image-block { border:2px solid rgba(245,158,11,.78); background:rgba(245,158,11,.06); }
.block-overlay.missing-image { border:2px dashed #dc2626; background:rgba(220,38,38,.12); }
.block-overlay:hover { border-color:#f59e0b; background:rgba(245,158,11,.12); }
.block-overlay.active { border-color:#2563eb!important; background:rgba(37,99,235,.18)!important; z-index:10; box-shadow:0 0 0 1px #2563eb; }
.md-line { display:block; cursor:pointer; padding:3px 8px; border-radius:4px; border-left:2px solid transparent; font-size:calc(13px * var(--md-zoom)); line-height:1.55; font-family:'Cascadia Code',Consolas,monospace; white-space:pre-wrap; word-break:break-word; }
.md-line.match { border-left-color:rgba(245,158,11,.4); }
.md-line.match:hover { background:rgba(245,158,11,.08); }
.md-line.no-match { color:#9ca3af; }
.md-line.active { background:rgba(37,99,235,.08); border-color:#2563eb; box-shadow:inset 0 0 0 1px rgba(37,99,235,.25); }
.badge { display:inline-block; font-size:10px; color:#6b7280; margin-left:6px; font-family:system-ui,sans-serif; }
.image-error { color:#b91c1c; font-size:12px; padding:16px; word-break:break-all; }
.find-bar { display:none; padding:8px 10px; border-bottom:1px solid #e5e7eb; background:#f8fafc; flex-shrink:0; }
.find-bar.open { display:block; }
.find-controls { display:flex; align-items:center; gap:6px; }
.find-options { display:flex; align-items:center; gap:12px; margin-top:7px; font-size:11px; color:#4b5563; }
.find-options label { display:flex; align-items:center; gap:4px; }
.find-options input { min-width:0; flex:none; width:auto; }
.find-bar input { min-width:120px; flex:1; max-width:280px; border:1px solid #d1d5db; border-radius:5px; padding:6px 8px; font:12px system-ui,sans-serif; }
.find-result { min-width:80px; font-size:11px; color:#6b7280; }
.find-results { max-height:190px; overflow:auto; margin-top:7px; border-top:1px solid #e5e7eb; }
.find-result-item { display:block; width:100%; text-align:left; border:0; border-bottom:1px solid #e5e7eb; border-radius:0; padding:6px 8px; font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.find-result-item.active { color:#b91c1c; background:#fef2f2; }
.search-hit { color:#b91c1c; background:#fee2e2; border-radius:2px; padding:0 1px; }
.vim-command-bar { position:absolute; left:0; right:0; bottom:0; z-index:6; display:flex; align-items:center; gap:6px; padding:5px 10px; border-top:1px solid #cbd5e1; background:#f1f5f9; color:#0f172a; font:13px/1.5 'Cascadia Code',Consolas,monospace; box-shadow:0 -6px 16px rgba(15,23,42,.08); }
.vim-command-bar[hidden] { display:none; }
.vim-command-bar .vim-command-prefix { font-weight:700; color:#2563eb; }
.vim-command-bar input { flex:1; min-width:0; border:0; outline:0; background:transparent; font:inherit; color:inherit; }
.vim-command-bar .vim-command-hint { flex:none; max-width:62%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#64748b; font-size:12px; }
.vim-command-bar.error, .vim-command-bar.error .vim-command-prefix { color:#b91c1c; }
.pane-body.json-view .vim-command-bar { display:none; }
.md-preview:focus { outline:none; }
.plugin-input { display:none; }
.legend { display:flex; align-items:center; gap:8px; font-size:10px; color:#6b7280; }
.legend i { display:inline-block; width:12px; height:8px; margin-right:3px; vertical-align:middle; border:1px solid #2563eb; }
.legend .visual { border:2px solid #f59e0b; }
.legend .removed { border:2px dashed #dc2626; background:rgba(220,38,38,.12); }
.md-preview { flex:none; width:100%; font-size:calc(15px * var(--md-zoom)); line-height:1.72; color:#1f2937; }
.md-preview h1,.md-preview h2,.md-preview h3,.md-preview h4,.md-preview h5,.md-preview h6 { line-height:1.32; margin:1.1em 0 .55em; color:#111827; }
.md-preview h1 { font-size:1.75em; border-bottom:1px solid #e5e7eb; padding-bottom:.3em; }
.md-preview h2 { font-size:1.45em; border-bottom:1px solid #e5e7eb; padding-bottom:.25em; }
.md-preview h3 { font-size:1.22em; }
.md-preview h4 { font-size:1.1em; }
.md-preview h5,.md-preview h6 { font-size:1em; font-weight:700; }
.md-preview p { margin:.55em 0; }
.md-preview .md-page-marker { margin:1.15em 0 1.35em; color:#94a3b8; font-size:13px; line-height:1.4; text-align:right; cursor:pointer; user-select:none; display:block; width:100%; }
.md-preview ul > .md-page-marker, .md-preview ol > .md-page-marker { list-style:none; }
.md-preview ul,.md-preview ol { padding-left:1.8em; margin:.55em 0; }
.md-preview blockquote { margin:.7em 0; padding:.2em .9em; border-left:4px solid #94a3b8; color:#64748b; background:#f8fafc; }
.md-preview code { padding:.12em .3em; border-radius:4px; background:#f1f5f9; font-family:'Cascadia Code',Consolas,monospace; }
.md-preview pre { overflow:auto; padding:11px; border-radius:6px; background:#0f172a; color:#e2e8f0; }
.md-preview pre code { padding:0; background:transparent; color:inherit; }
.md-preview table { width:100%; border-collapse:collapse; margin:.8em 0; }
.md-preview th,.md-preview td { border:1px solid #cbd5e1; padding:6px 8px; }
.md-preview th { background:#f1f5f9; }
.md-preview .org-planning { display:flex; flex-wrap:wrap; gap:8px 14px; margin:.45em 0; color:#64748b; font-size:.9em; }
.md-preview .org-planning strong { color:#9f1239; }
.md-preview .org-properties { margin:.55em 0; padding:8px 12px; border-left:3px solid #94a3b8; background:#f8fafc; }
.md-preview .org-property { display:grid; grid-template-columns:minmax(70px,max-content) 1fr; gap:10px; }
.md-preview .org-property dt { color:#475569; font-family:ui-monospace,monospace; font-weight:700; }
.md-preview .org-property dd { margin:0; overflow-wrap:anywhere; }
.md-preview .org-drawer { margin:.45em 0 .45em 1.1em; padding:.2em .8em; border-left:3px solid #94a3b8; }
.md-preview a { color:#2563eb; }
.md-preview img.md-asset { display:block; max-width:var(--md-image-width); max-height:var(--md-image-height); margin:8px auto; object-fit:contain; }
.md-preview [data-md-start-line] { border-radius:4px; transition:box-shadow .12s; }
.md-preview [data-md-start-line]:hover { box-shadow:inset 3px 0 0 rgba(37,99,235,.35); }
.md-preview [data-md-start-line].active { box-shadow:inset 3px 0 0 #2563eb; }
.md-preview.show-line-numbers { position:relative; padding-left:5.4em; }
.preview-line-gutter { position:absolute; left:.7em; width:3.6em; text-align:right; color:#94a3b8; font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:.75em; font-variant-numeric:tabular-nums; user-select:none; pointer-events:none; z-index:2; }
.preview-line-gutter span { display:block; white-space:nowrap; }
.preview-line-gutter span.current { color:#2563eb; font-weight:700; }
.preview-image-actions { display:flex; justify-content:flex-end; gap:6px; margin:5px 0 10px; }
.inline-editor { margin:8px 0; border:1px solid #60a5fa; border-radius:7px; overflow:hidden; background:#fff; box-shadow:0 3px 12px rgba(37,99,235,.12); }
.inline-editor-tools { display:flex; align-items:center; gap:5px; padding:6px 8px; border-bottom:1px solid #dbeafe; background:#eff6ff; flex-wrap:wrap; }
.inline-editor-tools button.active { border-color:#2563eb; color:#1d4ed8; background:#dbeafe; }
.inline-editor-tools .spacer { flex:1; }
.inline-editor-tools select { border:1px solid #bfdbfe; border-radius:5px; padding:4px 6px; background:#fff; color:#1f2937; font:inherit; }
.inline-editor textarea { display:block; width:100%; min-height:120px; max-height:55vh; resize:vertical; border:0; outline:0; padding:10px; font:14px/1.65 'Cascadia Code',Consolas,monospace; }
.inline-editor-preview { min-height:120px; max-height:55vh; overflow:auto; padding:10px 16px; }
.inline-editor [hidden] { display:none!important; }
.live-preview-mode .live-editable { cursor:text; min-height:1.4em; outline:0; caret-color:currentColor; }
.live-preview-mode .live-editable:hover { box-shadow:inset 3px 0 0 rgba(37,99,235,.3); }
.live-preview-mode .live-editable:focus { box-shadow:inset 3px 0 0 #2563eb; }
.live-preview-mode .live-editable:empty::before { content:'输入内容…'; color:#94a3b8; }
.live-preview-mode .live-source-active { white-space:pre-wrap; word-break:break-word; }
.live-preview-mode .live-source-active .live-source-code { display:inline; white-space:pre-wrap; font:inherit; color:inherit; background:transparent; outline:0; }
.live-preview-mode pre.live-source-active .live-source-code { display:block; }
.live-preview-mode ul.live-source-active,.live-preview-mode ol.live-source-active { padding-left:1.8em; }
.live-preview-mode table.live-source-active td { white-space:pre-wrap; }
.live-preview-mode .live-table-source { display:block; width:100%; min-height:7em; padding:8px; resize:vertical; border:0; outline:0; color:inherit; background:transparent; font:inherit; line-height:1.65; white-space:pre; tab-size:2; }
.live-preview-mode .live-table-cell-source { display:block; width:100%; min-width:7em; min-height:2.4em; padding:4px 6px; resize:both; border:1px solid #3b82f6; border-radius:4px; outline:0; color:inherit; background:color-mix(in srgb,currentColor 8%,transparent); font:inherit; line-height:1.5; white-space:pre-wrap; }
/* Markers follow the surrounding theme color so white-on-pill headings stay readable. */
.live-syntax-marker { color:currentColor!important; font-weight:400!important; font-style:normal!important; text-decoration:none!important; opacity:.55; }
.live-syntax-code { padding:.08em .25em; border-radius:3px; color:#b45309; background:rgba(245,158,11,.10); font-family:'Cascadia Code',Consolas,monospace; }
.live-syntax-math { padding:.04em .2em; color:#7c3aed; background:rgba(124,58,237,.08); font-family:'Cascadia Code',Consolas,monospace; }
.live-syntax-link { color:#2563eb; text-decoration:underline; text-underline-offset:2px; }
.source-editor-host { flex:1; width:100%; height:100%; min-height:0; overflow:hidden; }
.source-editor-host .cm-editor { height:100%; }
.standalone-source-split { position:relative; display:grid; grid-template-columns:var(--standalone-first, 50%) 1fr; gap:0; width:100%; height:100%; min-height:0; overflow:hidden; }
.standalone-source-split.stack { grid-template-columns:1fr; grid-template-rows:var(--standalone-first, 50%) 1fr; }
.standalone-source-split .source-editor-host { border-right:1px solid #dbe3ec; }
.standalone-source-split.swapped .source-editor-host { order:2; border-right:0; }
.standalone-live-preview { height:100%; min-width:0; overflow:auto; padding:10px; }
.standalone-source-split.swapped .standalone-live-preview { order:1; border-right:1px solid #dbe3ec; }
.standalone-source-split.stack .source-editor-host { border-right:0; border-bottom:1px solid #dbe3ec; }
.standalone-source-split.stack.swapped .source-editor-host { border-bottom:0; border-top:1px solid #dbe3ec; }
.standalone-source-split.stack.swapped .standalone-live-preview { border-right:0; }
.standalone-divider { position:absolute; z-index:8; left:var(--standalone-first, 50%); top:0; bottom:0; width:9px; transform:translateX(-50%); cursor:col-resize; touch-action:none; }
.standalone-divider::after { content:''; position:absolute; top:0; bottom:0; left:4px; width:1px; background:#94a3b8; }
.standalone-divider button { position:absolute; z-index:2; left:50%; top:50%; transform:translate(-50%,-50%); width:32px; height:30px; padding:0; border-radius:999px; box-shadow:0 2px 8px rgba(15,23,42,.18); font-size:17px; }
.standalone-source-split.stack .standalone-divider { left:0; right:0; top:var(--standalone-first, 50%); bottom:auto; width:auto; height:9px; transform:translateY(-50%); cursor:row-resize; }
.standalone-source-split.stack .standalone-divider::after { top:4px; bottom:auto; left:0; right:0; width:auto; height:1px; }
.source-status { color:#2563eb; font-weight:600; }
.settings-panel { display:none; position:absolute; z-index:50; right:10px; top:48px; width:min(350px,calc(100% - 20px)); max-height:calc(100% - 58px); overflow:auto; border:1px solid #cbd5e1; border-radius:9px; padding:12px; background:#fff; box-shadow:0 12px 34px rgba(15,23,42,.22); font-size:12px; }
.settings-panel.open { display:block; }
.settings-header { display:flex; align-items:center; margin-bottom:10px; font-size:14px; }
.settings-header .spacer { flex:1; }
.settings-group { padding:9px 0; border-top:1px solid #e5e7eb; }
.settings-row { display:grid; grid-template-columns:112px minmax(0,1fr) 42px; align-items:center; gap:7px; margin:7px 0; }
.settings-row select,.settings-row input[type=range] { width:100%; min-width:0; }
.settings-value { text-align:right; color:#475569; font-variant-numeric:tabular-nums; }
.settings-note { color:#64748b; line-height:1.55; }
.settings-plugin { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
.settings-plugin-name { width:100%; color:#475569; word-break:break-all; }
.settings-plugin-item { display:flex; align-items:center; gap:6px; margin:3px 0; padding:4px 7px; border:1px solid #e2e8f0; border-radius:6px; background:#f8fafc; }
.settings-plugin-item span { min-width:0; flex:1; }
.settings-plugin-item button { padding:2px 6px; color:#b91c1c; }
/* ---- Mind map view ---- */
.mindmap-host { display:flex; flex-direction:column; width:100%; height:100%; min-height:0; outline:0; background:#f8fafc; }
.mindmap-toolbar { display:flex; align-items:center; gap:6px; padding:6px 10px; border-bottom:1px solid #dbe3ec; background:#fff; font-size:12px; flex:none; }
.mindmap-toolbar button { padding:2px 9px; font-size:12px; }
.mindmap-hint { color:#94a3b8; margin-right:10px; }
.mindmap-count { color:#64748b; font-variant-numeric:tabular-nums; }
.mindmap-levels { display:inline-flex; gap:2px; padding:1px; border:1px solid #dbe3ec; border-radius:6px; }
.mindmap-levels button { border:0; background:transparent; padding:1px 7px; box-shadow:none; }
.mindmap-viewport { position:relative; flex:1; min-height:0; overflow:hidden; cursor:grab; }
.mindmap-viewport:active { cursor:grabbing; }
.mindmap-canvas { position:absolute; top:0; left:0; transform-origin:0 0; }
.mindmap-links { position:absolute; top:0; left:0; pointer-events:none; overflow:visible; }
.mindmap-links path { fill:none; stroke:#94a3b8; stroke-width:1.6; }
.mindmap-node { position:absolute; display:flex; align-items:center; gap:2px; box-sizing:border-box; padding:4px 10px; border:1px solid #cbd5e1; border-radius:8px; background:#fff; color:#1e293b; font-size:13px; line-height:1.35; cursor:pointer; user-select:none; box-shadow:0 1px 3px rgba(15,23,42,.08); overflow:hidden; }
.mindmap-node .mindmap-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.mindmap-node.kind-root,.mindmap-node.root-node { background:#2563eb; border-color:#1d4ed8; color:#fff; font-weight:600; }
.mindmap-node.kind-heading { border-color:#93c5fd; background:#eff6ff; }
.mindmap-node.selected { outline:2px solid #f59e0b; outline-offset:1px; }
.mindmap-node.drop-child { outline:2px dashed #2563eb; outline-offset:2px; }
.mindmap-node.drop-before { box-shadow:0 -3px 0 0 #2563eb, 0 1px 3px rgba(15,23,42,.08); }
.mindmap-node.drop-after { box-shadow:0 3px 0 0 #2563eb, 0 1px 3px rgba(15,23,42,.08); }
.mindmap-node.editing { padding:2px; }
.mindmap-toggle { flex:none; width:18px; height:18px; padding:0; border:1px solid #cbd5e1; border-radius:50%; background:#fff; color:#475569; font-size:11px; line-height:1; display:flex; align-items:center; justify-content:center; cursor:pointer; }
.mindmap-node.kind-root .mindmap-toggle,.mindmap-node.root-node .mindmap-toggle { border-color:rgba(255,255,255,.6); background:rgba(255,255,255,.16); color:#fff; }
.mindmap-editor { width:100%; height:100%; box-sizing:border-box; border:0; outline:0; resize:none; padding:2px 6px; font:inherit; color:inherit; background:transparent; }
.empty { display:flex; align-items:center; justify-content:center; height:100%; color:#9ca3af; text-align:center; padding:30px; }
@media (prefers-color-scheme:dark) {
  :host { color:#e5e7eb; background:#111827; }
  .toolbar,.toolbar-group,.find-bar,.find-results,.find-result-item,.pane-toolbar,.left-column,.pane-left,.history-panel { border-color:#374151; }
  .pane-left { background:#111827; }
  .pane-right,.pdf-page,button,.find-bar { background:#1f2937; color:#e5e7eb; }
  .vim-command-bar { background:#111827; color:#e5e7eb; border-color:#374151; box-shadow:0 -6px 16px rgba(0,0,0,.35); }
  .vim-command-bar .vim-command-prefix { color:#93c5fd; }
  .vim-command-bar .vim-command-hint { color:#94a3b8; }
  .vim-command-bar.error, .vim-command-bar.error .vim-command-prefix { color:#fca5a5; }
  .pane-toolbar,.md-preview,.inline-editor,.inline-editor textarea,.settings-panel,.json-editor { background:#1f2937; color:#e5e7eb; }
  .format-switch { border-color:#475569; }
  .format-switch button { color:#cbd5e1; }
  .format-switch button.active { background:#2563eb; color:#fff; }
  .history-panel,.history-item { background:#29251b; color:#fef3c7; }
  .md-preview h1,.md-preview h2,.md-preview h3,.md-preview h4,.md-preview h5,.md-preview h6 { color:#e2e8f0; border-color:#374151; }
  .md-preview .md-page-marker { color:#cbd5e1; }
  .md-preview .org-properties,.md-preview .org-drawer { background:#111827; }
  .md-preview .org-planning,.md-preview .org-property dt { color:#94a3b8; }
  .md-preview blockquote,.md-preview th,.md-preview code { background:#111827; }
  .live-preview-mode .live-editable:hover { box-shadow:inset 3px 0 0 rgba(147,197,253,.55); }
  .live-preview-mode .live-editable:focus { box-shadow:inset 3px 0 0 #93c5fd; }
  .md-preview [data-md-start-line]:hover { box-shadow:inset 3px 0 0 rgba(147,197,253,.55); }
  .md-preview [data-md-start-line].active { box-shadow:inset 3px 0 0 #93c5fd; }
  .live-syntax-code { color:#fbbf24; background:rgba(251,191,36,.12); }
  .live-syntax-math { color:#c4b5fd; background:rgba(167,139,250,.14); }
  .live-syntax-link { color:#93c5fd; }
  .standalone-source-split .source-editor-host,.standalone-source-split.swapped .standalone-live-preview { border-color:#374151; }
  .standalone-divider::after { background:#64748b; }
  .source-editor-host .cm-editor { background:#111827; color:#e5e7eb; }
  .line-number-mode { background:#1f2937; color:#e5e7eb; border-color:#374151; }
  .preview-line-gutter { color:#64748b; }
  .preview-line-gutter span.current { color:#93c5fd; }
  .source-editor-host .cm-gutters { background:#0f172a; color:#94a3b8; border-color:#374151; }
  .source-editor-host .cm-activeLine { background:rgba(148,163,184,.12); }
  .source-editor-host .cm-activeLineGutter { background:rgba(148,163,184,.12); }
  .source-editor-host .cm-selectionBackground,.source-editor-host .cm-editor ::selection { background:rgba(59,130,246,.35)!important; }
  .source-editor-host .cm-cursor { border-left-color:#e5e7eb; }
  .settings-panel { color-scheme:dark; border-color:#374151; }
  .settings-group { border-color:#374151; }
  .settings-panel select { background:#111827; color:#e5e7eb; border:1px solid #4b5563; border-radius:6px; height:28px; }
  .settings-value { color:#cbd5e1; }
  .settings-note,.settings-plugin-name { color:#94a3b8; }
  .settings-plugin-item { background:#111827; border-color:#374151; color:#e5e7eb; }
  .settings-panel input[type=range] { accent-color:#60a5fa; }
  .settings-panel button:hover:not(:disabled) { background:#111827; color:#93c5fd; border-color:#60a5fa; }
  .mindmap-host { background:#111827; }
  .mindmap-toolbar { background:#1f2937; border-color:#374151; }
  .mindmap-hint { color:#64748b; }
  .mindmap-count { color:#94a3b8; }
  .mindmap-links path { stroke:#4b5563; }
  .mindmap-node { background:#1f2937; border-color:#4b5563; color:#e5e7eb; box-shadow:0 1px 3px rgba(0,0,0,.4); }
  .mindmap-node.kind-heading { background:#172033; border-color:#3b5a8a; }
  .mindmap-node.kind-root,.mindmap-node.root-node { background:#1d4ed8; border-color:#2563eb; color:#fff; }
  .mindmap-toggle { background:#111827; border-color:#4b5563; color:#cbd5e1; }
  .outline-panel,.outline-search { background:#111827; border-color:#374151; }
  .outline-search input { background:#1f2937; color:#e5e7eb; border-color:#4b5563; }
  .outline-search input::placeholder { color:#94a3b8; }
  .outline-search input:focus { border-color:#60a5fa; box-shadow:0 0 0 2px #3b82f655; }
  .outline-item { background:#111827; color:#e5e7eb; }
  .outline-item:hover:not(:disabled) { background:#1f2937; color:#93c5fd; border-color:transparent; }
  .outline-level { color:#94a3b8; }
  .outline-no-match,.outline-empty { color:#9ca3af; }
  .outline-resizer { background:linear-gradient(90deg,transparent 2px,#4b5563 2px,#4b5563 3px,transparent 3px); }
  .pane-body.outline-stack .outline-resizer { background:linear-gradient(transparent 2px,#4b5563 2px,#4b5563 3px,transparent 3px); }
}
`

const VIEWER_SCRIPT_URL = (() => {
  if (typeof document === 'undefined') return null
  const current = document.currentScript as HTMLScriptElement | null
  return current?.src || Array.from(document.scripts)
    .map(script => script.src)
    .find(url => /(?:mineru-layout-viewer\.iife\.js|index\.mjs)(?:\?|$)/.test(url))
})()
const VIEWER_ASSET_BASE_URL = VIEWER_SCRIPT_URL ? new URL('.', VIEWER_SCRIPT_URL).href : null
const VIEWER_ASSET_VERSION = VIEWER_SCRIPT_URL
  ? new URL(VIEWER_SCRIPT_URL).searchParams.get('v')
  : null

export class MineruLayoutViewer extends HTMLElement {
  private blocks: PdfBlock[] = []
  private sections: MdSection[] = []
  private pages: PdfPageState[] = []
  private pdfDocument: Awaited<ReturnType<typeof pdfjsLib.getDocument>['promise']> | null = null
  private activeIdx: number | null = null
  private pdfUrl: string | null = null
  private renderedPdfUrl: string | null = null
  private ownedPdfUrl: string | null = null
  private externalPdfUrl: string | null = null
  private externalPdfPath = ''
  private layoutData: string | null = null
  private contentListData: string | null = null
  private contentListV2Data: string | null = null
  private contentListPath = ''
  private contentListV2Path = ''
  private layoutPath = ''
  private syncedJsonPath = ''
  private syncedJsonText: string | null = null
  private syncedJsonKind: 'content' | 'v2' | 'layout' | '' = ''
  private documentView: 'markdown' | 'json' = 'markdown'
  private jsonSyncTimer: ReturnType<typeof setTimeout> | null = null
  private markdownText: string | null = null
  private zip: JSZip | null = null
  private sourceLineCache: { markdown: string; offsets: number[] } | null = null
  private deferredAssets = new Map<string, { url: string; loading?: Promise<void> }>()
  private sourceZipName = 'mineru-result.zip'
  private markdownPath = ''
  private launcherLocation: { token: string; launch: string; kind: 'file' | 'directory' } | null = null
  /** Local server launch used to resolve images stored beside a standalone Markdown file. */
  private siblingAssetSource: { token: string; launch: string } | null = null
  private assetUrls = new Map<string, string>()
  private undoStack: UndoAction[] = []
  private redoStack: UndoAction[] = []
  private redoEdits: ReviewEdit[] = []
  private reviewEdits: ReviewEdit[] = []
  private resizeObserver: ResizeObserver | null = null
  private imageObserver: IntersectionObserver | null = null
  private pdfPageObserver: IntersectionObserver | null = null
  private pdfBlocksByPage = new Map<number, PdfBlock[]>()
  private previewBuildSequence = 0
  private previewBuild: Promise<void> | null = null
  private rebuildSequence = 0
  private pdfZoom = 1
  private markdownZoom = 1
  private pdfFitMode: 'width' | 'page' | 'custom' = 'width'
  private findCursor = 0
  private currentFindStart = -1
  private resizeTimer: ReturnType<typeof setTimeout> | null = null
  private markdownRenderPlugins: MarkdownRenderPlugin[] = [createRichMarkdownPlugin(), createElegantReadingTheme()]
  private previewRenderer = new MarkdownPreviewRenderer(this.markdownRenderPlugins)
  private markdownEditorPlugins: MarkdownEditorPlugin[] = []
  private sourceEditor: MarkdownSourceEditor | null = null
  private previewCursorLine = 1
  private previewLineNumberFrame = 0
  private previewLineNumberObserver: ResizeObserver | null = null
  private markdownMode: MarkdownViewMode = 'preview'
  private sourceDraft = ''
  // ── Mind map state ──
  private mindmapTree: MindmapTree | null = null
  private mindmapLayout: MindmapLayout | null = null
  private mindmapCollapsed = new Set<string>()
  private mindmapSelected: string | null = null
  private mindmapEditing: string | null = null
  private mindmapZoom = 1
  private mindmapPan = { x: 0, y: 0 }
  private mindmapDrag: {
    nodeId: string
    startX: number
    startY: number
    pointerId: number
    targetId: string | null
    position: MindmapDropPosition | null
    moved: boolean
  } | null = null
  // ── Cross-window state ──
  private windowChannel: ViewerWindowChannel | null = null
  private windowPeers = new Set<string>()
  private documentRevision = 0
  private appliedRemoteRevision = 0
  private suppressDocumentBroadcast = false
  private windowReadyTimer: ReturnType<typeof setTimeout> | null = null
  // ── Split panes (VS Code 式分屏) ──
  /** True on panes created by 分屏: keeps the mode toolbar, hides app chrome. */
  embeddedPane = false
  /** Main viewer that owns this embedded pane. */
  ownerViewer: MineruLayoutViewer | null = null
  /** Embedded panes resolve images through the owner's asset pipeline. */
  assetUrlDelegate: ((imagePath: string) => Promise<string>) | null = null
  private splitPanes: MineruLayoutViewer[] = []
  /** 各分栏的相对尺寸（主栏在首位，总和约为 1），拖拽分栏条时实时改写。 */
  private splitFractions: number[] = []
  private splitDirection: 'row' | 'column' = 'row'
  private vimEnabled = true
  private vimCommandOrigin: HTMLElement | null = null
  private vimCommandMode: ':' | '/' = ':'
  private vimNormalState = initialViewerVimNormalState()
  private vimNormalTimer = 0
  private vimSearch: { query: string; matches: number[]; index: number } | null = null
  private vimSearchOriginLine = 1
  // Clicking a non-focusable preview block moves focus to <body>, outside this
  // component; remembering where the last pointer press landed lets `:` and
  // motions still reach the viewer instead of dying on the scope check.
  private vimPointerInside = true
  private documentKeydownBound = false
  private onDocumentKeydown = (event: KeyboardEvent) => this.onPreviewVimKeydown(event)
  private onDocumentPointerdown = (event: PointerEvent) => {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : []
    // With split panes, a press inside a nested viewer is also inside this
    // one's shadow tree; only the innermost viewer owns the pointer.
    this.vimPointerInside = innermostViewerHost(path) === this
  }
  private searchResults: SearchResult[] = []
  private sourceDirectoryHandle: FileSystemDirectoryHandle | null = null
  private sourceMarkdownFileHandle: FileSystemFileHandle | null = null
  private pendingDeletedAssets = new Set<string>()
  private standaloneMarkdown = false
  private documentFormat: DocumentFormat = 'markdown'
  private liveEditSession: LiveEditSession | null = null
  /** Set while showLiveSource swaps block HTML so the synthetic focusout is ignored. */
  private liveDomMutationGuard = false
  private panesSwapped = false
  private pdfOutline: PdfOutlineItem[] = []
  private progressStartedAt = 0
  private progressEstimateKey = ''
  private progressEstimateStartedAt = 0
  private progressHideTimer: ReturnType<typeof setTimeout> | null = null
  private viewerSettings: ViewerSettings = { ...DEFAULT_VIEWER_SETTINGS }
  private activeFormatPluginNames = new Set<string>(['mineru-reading-theme'])
  private defaultRenderPlugins: Record<DocumentFormat, Array<{ plugin: MarkdownRenderPlugin; label: string; source?: string; builtin?: boolean }>> = {
    markdown: [{ plugin: createElegantReadingTheme(), label: '内置阅读主题', builtin: true }],
    org: [{ plugin: createElegantReadingTheme(), label: '内置阅读主题', builtin: true }],
  }
  private documentPluginFontStyle: HTMLStyleElement | null = null

  static observedAttributes = ['pdf', 'layout', 'markdown']

  constructor() {
    super()
    this.attachShadow({ mode: 'open' })
    this.loadViewerSettings()
  }

  connectedCallback() {
    this.classList.toggle('embedded', this.embeddedPane)
    this.render()
    this.setupResize()
    if (this.embeddedPane) {
      const close = this.shadowRoot?.getElementById('closeSplitPane')
      if (close) close.hidden = false
    }
    // `:` is typed over the rendered preview, where no CodeMirror instance can
    // receive it, so the command line listens document-wide and filters hard.
    if (!this.documentKeydownBound) {
      document.addEventListener('keydown', this.onDocumentKeydown)
      document.addEventListener('pointerdown', this.onDocumentPointerdown, true)
      this.documentKeydownBound = true
    }
    void this.restoreDefaultRenderPlugins()
    this.setupWindowChannel()
  }

  disconnectedCallback() {
    if (this.documentKeydownBound) {
      document.removeEventListener('keydown', this.onDocumentKeydown)
      document.removeEventListener('pointerdown', this.onDocumentPointerdown, true)
      this.documentKeydownBound = false
    }
    this.clearVimNormalTimer()
    this.teardownWindowChannel()
    this.previewBuildSequence++
    this.previewBuild = null
    this.resizeObserver?.disconnect()
    if (this.resizeTimer) clearTimeout(this.resizeTimer)
    if (this.progressHideTimer) clearTimeout(this.progressHideTimer)
    this.imageObserver?.disconnect()
    this.pdfPageObserver?.disconnect()
    this.sourceEditor?.destroy()
    this.sourceEditor = null
    this.documentPluginFontStyle?.remove()
    this.documentPluginFontStyle = null
    this.releaseAllPdfPages()
    void this.pdfDocument?.destroy()
    this.revokeAssetUrls()
    this.revokeOwnedPdfUrl()
  }

  attributeChangedCallback(name: string, _old: string | null, newValue: string | null) {
    if (name === 'pdf' && newValue) {
      this.pdfUrl = newValue
      void this.loadPdf(newValue)
    }
    if (name === 'layout' && newValue) void this.loadLayout(newValue)
    if (name === 'markdown' && newValue) {
      this.documentFormat = 'markdown'
      this.activateDefaultRenderPlugin('markdown')
      this.markdownText = newValue
      void this.rebuild()
    }
  }

  set pdf(value: string) { this.setAttribute('pdf', value) }
  get pdf(): string { return this.getAttribute('pdf') || '' }
  set layout(value: string) { this.setAttribute('layout', value) }
  get layout(): string { return this.getAttribute('layout') || '' }
  set markdown(value: string) { this.setAttribute('markdown', value) }
  get markdown(): string { return this.getAttribute('markdown') || '' }

  async loadLayoutFromJson(data: Record<string, unknown> | string) {
    this.layoutData = typeof data === 'string' ? data : JSON.stringify(data)
    this.chooseSyncedJson()
    await this.rebuild()
  }

  async loadMarkdown(text: string) {
    this.documentFormat = 'markdown'
    this.activateDefaultRenderPlugin('markdown')
    this.markdownText = text
    await this.rebuild()
  }

  hasPendingChanges(): boolean {
    if (this.reviewEdits.length > 0 || this.liveEditSession || this.jsonSyncTimer) return true
    if (this.markdownMode === 'source'
      && (this.sourceEditor?.getValue() ?? this.sourceDraft) !== (this.markdownText || '')) return true
    if (this.documentView === 'json') {
      const editor = this.shadowRoot?.getElementById('jsonEditor') as HTMLTextAreaElement | null
      if (editor && editor.value !== this.syncedJsonText) return true
    }
    return false
  }

  /**
   * Scroll to a 1-based source line. Preview and live mode highlight the block
   * that contains the line and, when a PDF match exists, scroll to that block.
   * Source mode places the cursor on the line. `quiet` skips the status line,
   * which keeps routine mode switches from shouting.
   */
  revealSourceLine(lineNumber: number, options?: { quiet?: boolean }): boolean {
    if (this.previewBuild) {
      void this.waitForPreview().then(() => this.revealSourceLine(lineNumber, options))
      return Number.isInteger(lineNumber) && lineNumber > 0
    }
    if (!Number.isInteger(lineNumber) || lineNumber < 1 || this.markdownText == null) return false
    const source = this.markdownMode === 'source' && this.sourceEditor
      ? this.sourceEditor.getValue()
      : this.markdownText.replace(/\r\n?/g, '\n')
    const lineCount = Math.max(1, source.replace(/\r\n?/g, '\n').split('\n').length)
    const target = Math.min(lineNumber, lineCount)
    this.setPreviewCursorLine(target)
    if (this.markdownMode === 'mindmap') {
      if (!this.revealMindmapLine(target)) return false
    } else if (this.markdownMode === 'source' && this.sourceEditor) {
      const offset = sourceOffsetForLine(source, target)
      this.sourceEditor.goTo(offset)
      const livePreview = this.shadowRoot?.querySelector<HTMLElement>('.standalone-live-preview')
      if (livePreview) this.syncStandalonePreviewFromSource(livePreview, offset, source)
    } else if (!this.revealPreviewLine(target - 1)) {
      return false
    }
    if (!options?.quiet) {
      this.setStatus(target === lineNumber
        ? `已定位到第 ${target} 行`
        : `第 ${lineNumber} 行超出范围，已定位到第 ${target} 行`)
    }
    return true
  }

  /** The 1-based source line the current mode is focused on. */
  private currentSourceLine(): number {
    if (this.markdownMode === 'source' && this.sourceEditor) {
      const value = this.sourceEditor.getValue()
      const offset = Math.max(0, Math.min(this.sourceEditor.getCursorOffset(), value.length))
      return value.slice(0, offset).split('\n').length
    }
    if (this.markdownMode === 'mindmap') {
      const node = this.mindmapNodeById(this.mindmapSelected)
      if (node?.source) return node.source.line + 1
    }
    return this.previewCursorLine
  }

  /** Remember the shortcut launch so the toolbar can reveal that file in Explorer. */
  setLauncherLocation(location: { token: string; launch: string; kind: 'file' | 'directory' } | null) {
    if (!location?.token || !location.launch) {
      this.launcherLocation = null
    } else {
      this.launcherLocation = {
        token: location.token,
        launch: location.launch,
        kind: location.kind === 'directory' ? 'directory' : 'file',
      }
    }
    this.updateToolbar()
  }

  private async revealCurrentFolder() {
    const location = this.launcherLocation
    if (!location) return
    const params = new URLSearchParams({ token: location.token, launch: location.launch })
    if (location.kind === 'directory' && this.markdownPath) params.set('path', this.markdownPath)
    try {
      const response = await fetch(`/__viewer/reveal?${params}`, { method: 'POST' })
      const body = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(body.error || `打开所在文件夹失败：HTTP ${response.status}`)
      this.setStatus('已打开所在文件夹')
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : String(error))
    }
  }

  /** Open one Markdown or Org file without MinerU layout/PDF data.
   * `siblingAssets` lets a file launched by the local server load images stored next to it.
   */
  async loadMarkdownFile(
    file: File,
    handle?: FileSystemFileHandle,
    options?: { siblingAssets?: { token: string; launch: string } },
  ) {
    this.resetReviewState()
    this.siblingAssetSource = options?.siblingAssets ?? null
    this.documentFormat = documentFormatFromName(file.name)
    this.activateDefaultRenderPlugin(this.documentFormat)
    const formatLabel = this.documentFormat === 'org' ? 'Org' : 'Markdown'
    this.startLoadProgress(`正在读取 ${formatLabel}…`)
    this.standaloneMarkdown = true
    this.sourceMarkdownFileHandle = handle || null
    this.markdownPath = file.name
    this.sourceZipName = file.name
    this.markdownText = await file.text()
    this.sections = parseMarkdownSections(this.markdownText)
    this.setLoadProgress(80, `正在渲染 ${formatLabel}…`)
    this.buildUI()
    this.finishLoadProgress(`已打开 ${file.name}`)
  }

  registerMarkdownRenderPlugin(plugin: MarkdownRenderPlugin) {
    this.markdownRenderPlugins = this.markdownRenderPlugins.filter(item => item.name !== plugin.name)
    this.markdownRenderPlugins.push(plugin)
    this.previewRenderer.setPlugins(this.markdownRenderPlugins)
    this.updatePluginStyles()
    if (this.markdownMode !== 'source') this.buildMarkdown()
  }

  registerMarkdownEditorPlugin(plugin: MarkdownEditorPlugin) {
    this.markdownEditorPlugins = this.markdownEditorPlugins.filter(item => item.name !== plugin.name)
    this.markdownEditorPlugins.push(plugin)
    if (this.markdownMode === 'source') {
      this.sourceDraft = this.sourceEditor?.getValue() ?? this.sourceDraft
      this.buildSourceEditor()
    }
  }

  /** Load a JavaScript render/theme plugin exported as default or markdownRenderPlugin. */
  async loadMarkdownRenderPlugin(file: File, format: DocumentFormat = this.documentFormat) {
    if (!/\.m?js$/i.test(file.name)) throw new Error('渲染插件必须是 .js 或 .mjs 文件')
    const formatLabel = format === 'org' ? 'Org' : 'Markdown'
    if (!confirm(`加载插件会执行其中的 JavaScript，并加入以后默认使用的 ${formatLabel} 插件列表。只加载你信任的文件。\n\n继续加载 ${file.name}？`)) return
    const source = await file.text()
    const plugin = await this.importMarkdownRenderPlugin(source)
    this.setDefaultRenderPlugin(format, plugin, file.name, source)
    let persisted = false
    try {
      this.persistRenderPluginStack(format)
      persisted = true
    } catch { /* localStorage may be disabled */ }
    this.updateSettingsControls()
    alert(persisted
      ? `已加入默认 ${formatLabel} 插件列表：${plugin.name}`
      : `已加载 ${formatLabel} 渲染插件：${plugin.name}\n浏览器未允许保存设置，下次打开时需要重新加载。`)
  }

  private async importMarkdownRenderPlugin(source: string): Promise<MarkdownRenderPlugin> {
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
    try {
      const module = await import(/* @vite-ignore */ url) as {
        default?: MarkdownRenderPlugin
        markdownRenderPlugin?: MarkdownRenderPlugin
      }
      const plugin = module.default || module.markdownRenderPlugin
      if (!plugin || typeof plugin.name !== 'string') throw new Error('插件需要导出带 name 的 MarkdownRenderPlugin 对象')
      return plugin
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  private setDefaultRenderPlugin(format: DocumentFormat, plugin: MarkdownRenderPlugin, label = plugin.name, source?: string) {
    this.defaultRenderPlugins[format] = this.defaultRenderPlugins[format]
      .filter(item => item.plugin.name !== plugin.name)
    this.defaultRenderPlugins[format].push({ plugin, label, source })
    if (format === this.documentFormat) this.activateDefaultRenderPlugin(format)
    this.updateSettingsControls()
  }

  private activateDefaultRenderPlugin(format: DocumentFormat) {
    this.markdownRenderPlugins = this.markdownRenderPlugins.filter(item => !this.activeFormatPluginNames.has(item.name))
    this.activeFormatPluginNames = new Set(this.defaultRenderPlugins[format].map(item => item.plugin.name))
    for (const selected of this.defaultRenderPlugins[format]) {
      this.markdownRenderPlugins = this.markdownRenderPlugins.filter(item => item.name !== selected.plugin.name)
      this.markdownRenderPlugins.push(selected.plugin)
    }
    this.previewRenderer.setPlugins(this.markdownRenderPlugins)
    this.updatePluginStyles()
    if (this.markdownMode !== 'source') this.buildMarkdown()
  }

  private async restoreDefaultRenderPlugins() {
    for (const format of ['markdown', 'org'] as DocumentFormat[]) {
      try {
        const savedStack = localStorage.getItem(RENDER_PLUGIN_STACK_KEYS[format])
        const saved = savedStack || localStorage.getItem(RENDER_PLUGIN_KEYS[format])
          || (format === 'markdown' ? localStorage.getItem(LEGACY_RENDER_PLUGIN_KEY) : null)
        if (!saved) continue
        const parsed = JSON.parse(saved) as { source?: string; fileName?: string } | Array<{ source?: string; fileName?: string }>
        const records = Array.isArray(parsed) ? parsed : [parsed]
        for (const data of records) {
          if (!data.source) continue
          const plugin = await this.importMarkdownRenderPlugin(data.source)
          this.defaultRenderPlugins[format] = this.defaultRenderPlugins[format].filter(item => item.plugin.name !== plugin.name)
          this.defaultRenderPlugins[format].push({ plugin, label: data.fileName || plugin.name, source: data.source })
        }
        if (!savedStack) this.persistRenderPluginStack(format)
      } catch (error) {
        console.warn(`无法恢复默认 ${format === 'org' ? 'Org' : 'Markdown'} 渲染插件`, error)
      }
    }
    this.activateDefaultRenderPlugin(this.documentFormat)
    this.updateSettingsControls()
  }

  private restoreBuiltinRenderPlugin(format: DocumentFormat) {
    try {
      localStorage.removeItem(RENDER_PLUGIN_STACK_KEYS[format])
      localStorage.removeItem(RENDER_PLUGIN_KEYS[format])
      if (format === 'markdown') localStorage.removeItem(LEGACY_RENDER_PLUGIN_KEY)
    } catch { /* ignored */ }
    this.defaultRenderPlugins[format] = [{ plugin: createElegantReadingTheme(), label: '内置阅读主题', builtin: true }]
    if (format === this.documentFormat) this.activateDefaultRenderPlugin(format)
    this.updateSettingsControls()
  }

  private persistRenderPluginStack(format: DocumentFormat) {
    const records = this.defaultRenderPlugins[format]
      .filter(item => item.source)
      .map(item => ({ fileName: item.label, source: item.source }))
    localStorage.setItem(RENDER_PLUGIN_STACK_KEYS[format], JSON.stringify(records))
  }

  private removeDefaultRenderPlugin(format: DocumentFormat, pluginName: string) {
    const next = this.defaultRenderPlugins[format].filter(item => item.plugin.name !== pluginName)
    this.defaultRenderPlugins[format] = next.length
      ? next
      : [{ plugin: createElegantReadingTheme(), label: '内置阅读主题', builtin: true }]
    try { this.persistRenderPluginStack(format) } catch { /* ignored */ }
    if (format === this.documentFormat) this.activateDefaultRenderPlugin(format)
    this.updateSettingsControls()
  }

  /** Load one MinerU result ZIP and keep it in memory for review edits. */
  async loadZip(zipBlob: Blob) {
    this.resetReviewState()
    this.startLoadProgress('正在读取 ZIP…')
    this.beginProgressEstimate('read-zip')
    const zipData = await this.readBlobWithProgress(zipBlob, (loaded, total) => {
      const ratio = total ? loaded / total : 0
      this.setLoadProgress(total ? ratio * 28 : null, `正在读取 ZIP… ${this.formatBytes(loaded)}/${this.formatBytes(total)}`,
        total ? { key: 'read-zip', ratio } : undefined)
    })
    this.setLoadProgress(null, '正在解析 ZIP 索引…')
    await new Promise(resolve => setTimeout(resolve, 0))
    this.zip = await JSZip.loadAsync(zipData)
    this.sourceZipName = (zipBlob as File).name || 'mineru-result.zip'
    await this.loadArchiveEntries()
  }

  /** Load a MinerU result directory selected with a webkitdirectory file input. */
  async loadDirectory(files: File[] | FileList) {
    const selected = Array.from(files)
    if (!selected.length) throw new Error('所选文件夹为空')
    const entries = selected.map(file => ({
      path: normalizeAssetPath(file.webkitRelativePath || file.name).replace(/^\/+/, ''),
      file,
    }))
    await this.loadDirectoryEntries(entries)
  }

  /** Load recursively collected drag/drop entries, including legacy webkitGetAsEntry results. */
  async loadDirectoryEntries(
    entries: Array<{ path: string; file?: File; url?: string }>,
    directPdfUrl?: string,
    directPdfPath = '',
  ) {
    this.resetReviewState()
    this.startLoadProgress('正在读取文件夹…')
    this.beginProgressEstimate('read-directory')
    if (!entries.length) throw new Error('所选文件夹为空')
    this.zip = new JSZip()
    for (let index = 0; index < entries.length; index++) {
      const { path, file, url } = entries[index]
      const relativePath = normalizeAssetPath(path).replace(/^\/+/, '')
      if (relativePath && !relativePath.split('/').includes('..')) {
        if (file) this.zip.file(relativePath, file)
        else if (url) {
          this.zip.file(relativePath, new Uint8Array())
          this.deferredAssets.set(relativePath, { url })
        }
      }
      if (index % 10 === 0 || index === entries.length - 1) {
        const ratio = (index + 1) / entries.length
        this.setLoadProgress(ratio * 35, `正在读取文件夹… ${index + 1}/${entries.length}`, { key: 'read-directory', ratio })
        await new Promise(resolve => setTimeout(resolve, 0))
      }
    }
    const rootName = normalizeAssetPath(entries[0].path).split('/')[0]
    this.sourceZipName = `${rootName || 'mineru-result'}.zip`
    const directPdf = entries.find(item => item.file && /_origin\.pdf$/i.test(item.file.name))?.file
      || entries.find(item => item.file && /\.pdf$/i.test(item.file.name))?.file
    await this.loadArchiveEntries(directPdfUrl || directPdf, directPdfPath)
  }

  /** Open a directory with read/write permission so full.md and deleted assets can be saved in place. */
  async loadDirectoryHandle(handle: FileSystemDirectoryHandle, writable = true) {
    this.resetReviewState()
    this.startLoadProgress('正在扫描文件夹…')
    this.zip = new JSZip()
    const collected: Array<{ path: string; file: File }> = []
    await this.collectDirectoryFiles(handle, handle.name, collected)
    if (!collected.length) throw new Error('所选文件夹为空')
    for (let index = 0; index < collected.length; index++) {
      if (index === 0) this.beginProgressEstimate('read-directory')
      const item = collected[index]
      this.zip.file(item.path, item.file)
      if (index % 10 === 0 || index === collected.length - 1) {
        const ratio = (index + 1) / collected.length
        this.setLoadProgress(ratio * 35, `正在读取文件夹… ${index + 1}/${collected.length}`, { key: 'read-directory', ratio })
        await new Promise(resolve => setTimeout(resolve, 0))
      }
    }
    this.sourceDirectoryHandle = writable ? handle : null
    this.sourceZipName = `${handle.name || 'mineru-result'}.zip`
    const directPdf = collected.find(item => /_origin\.pdf$/i.test(item.file.name))?.file
      || collected.find(item => /\.pdf$/i.test(item.file.name))?.file
    await this.loadArchiveEntries(directPdf)
  }

  private async collectDirectoryFiles(
    directory: FileSystemDirectoryHandle,
    prefix: string,
    output: Array<{ path: string; file: File }>,
  ) {
    for await (const child of (directory as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
      const path = `${prefix}/${child.name}`
      if (child.kind === 'file') {
        output.push({ path, file: await (child as FileSystemFileHandle).getFile() })
      } else {
        await this.collectDirectoryFiles(child as FileSystemDirectoryHandle, path, output)
      }
      if (output.length % 10 === 0) this.setLoadProgress(null, `正在扫描文件夹… 已发现 ${output.length} 个文件`)
    }
  }

  private async loadArchiveEntries(directPdf?: File | string, directPdfPath = '') {
    if (!this.zip) return

    const names = Object.keys(this.zip.files).filter(name => !this.zip!.files[name].dir)
    this.setLoadProgress(42, `正在解析 Markdown 和 JSON…（${names.length} 个文件）`)
    this.markdownPath = this.pickMarkdownPath(names)
    if (!this.markdownPath) throw new Error('ZIP 中未找到 Markdown 文件')

    this.markdownText = await this.zip.file(this.markdownPath)!.async('text')
    this.documentFormat = 'markdown'
    this.activateDefaultRenderPlugin('markdown')

    const contentListV2Path = names.find(name =>
      /(?:^|\/)(?:content_list_v2|.+_content_list_v2)\.json$/i.test(name),
    )
    const contentListPath = names.find(name =>
      /(?:^|\/)(?:content_list|.+_content_list)\.json$/i.test(name),
    )
    const middlePath = names.find(name =>
      /(?:^|\/)(?:middle|layout|.+_(?:middle|layout))\.json$/i.test(name),
    )

    this.contentListV2Path = contentListV2Path || ''
    this.contentListPath = contentListPath || ''
    this.layoutPath = middlePath || ''
    this.contentListV2Data = contentListV2Path
      ? await this.zip.file(contentListV2Path)!.async('text')
      : null
    this.contentListData = contentListPath
      ? await this.zip.file(contentListPath)!.async('text')
      : null
    this.layoutData = middlePath
      ? await this.zip.file(middlePath)!.async('text')
      : (this.contentListData || this.contentListV2Data)
    this.chooseSyncedJson()

    if (!this.layoutData && !this.contentListData && !this.contentListV2Data) {
      throw new Error('ZIP 缺少 middle.json、layout.json、content_list.json 或 content_list_v2.json')
    }

    const pdfPath = names.find(name => /_origin\.pdf$/i.test(name))
      || names.find(name => /\.pdf$/i.test(name))
    if (typeof directPdf === 'string') {
      this.setLoadProgress(64, '正在流式打开 PDF…')
      this.externalPdfUrl = directPdf
      this.externalPdfPath = normalizeAssetPath(directPdfPath).replace(/^\/+/, '')
      this.pdfUrl = directPdf
    } else if (directPdf) {
      this.setLoadProgress(64, '正在打开 PDF…')
      this.ownedPdfUrl = URL.createObjectURL(directPdf)
      this.pdfUrl = this.ownedPdfUrl
    } else if (pdfPath) {
      this.setLoadProgress(48, '正在解压 PDF…')
      this.beginProgressEstimate('decompress-pdf')
      const pdfBlob = await this.zip.file(pdfPath)!.async('blob', metadata => {
        const ratio = metadata.percent / 100
        this.setLoadProgress(48 + metadata.percent * .28, `正在解压 PDF… ${Math.round(metadata.percent)}%`,
          { key: 'decompress-pdf', ratio })
      })
      this.ownedPdfUrl = URL.createObjectURL(pdfBlob)
      this.pdfUrl = this.ownedPdfUrl
    }

    this.setLoadProgress(82, '正在建立页面索引并匹配内容…')
    await new Promise(resolve => setTimeout(resolve, 0))
    await this.rebuild()
    this.finishLoadProgress(`已加载 ${this.sourceZipName}`)
  }

  /** Export the edited Markdown, replacement images, and an audit manifest. */
  async exportEditedZip() {
    if (this.markdownMode === 'source') this.saveSourceAndPreview()
    if (!this.zip || !this.markdownPath || this.markdownText == null) return
    const exportButton = this.shadowRoot?.getElementById('export') as HTMLButtonElement | null
    if (exportButton) {
      exportButton.disabled = true
      exportButton.textContent = '正在生成 ZIP…'
    }

    try {
      if (!this.flushDocumentSync()) throw new Error('JSON 格式不正确，请先改好再导出')
      for (const path of this.deferredAssets.keys()) await this.hydrateAsset(path)
      this.zip.file(this.markdownPath, this.markdownText!)
      if (this.syncedJsonPath && this.syncedJsonText != null) this.zip.file(this.syncedJsonPath, this.syncedJsonText)
      if (this.externalPdfUrl && this.externalPdfPath && !this.zip.file(this.externalPdfPath)) {
        if (exportButton) exportButton.textContent = '正在读取原始 PDF…'
        const response = await fetch(this.externalPdfUrl)
        if (!response.ok) throw new Error(`读取原始 PDF 失败：HTTP ${response.status}`)
        this.zip.file(this.externalPdfPath, await response.blob())
        if (exportButton) exportButton.textContent = '正在生成 ZIP…'
      }
      this.zip.file('review_edits.json', JSON.stringify({
        source: this.sourceZipName,
        markdown: this.markdownPath,
        exportedAt: new Date().toISOString(),
        semantics: {
          removedImageReferences: 'Markdown reference removed; original asset and JSON retained',
          removedImages: 'For remove-image-and-reference edits, the image asset is removed and JSON is retained',
          replacedImages: 'Asset bytes replaced at the original path',
        },
        edits: this.reviewEdits,
      }, null, 2))

      const blob = await this.zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = this.sourceZipName.replace(/\.zip$/i, '') + '-edited.zip'
      link.style.display = 'none'
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      if (exportButton) exportButton.textContent = 'ZIP 已生成'
    } catch (error) {
      if (exportButton) exportButton.textContent = '导出失败'
      alert(error instanceof Error ? error.message : String(error))
    } finally {
      setTimeout(() => {
        if (!exportButton) return
        exportButton.textContent = '导出修改版 ZIP'
        exportButton.disabled = !this.zip
      }, 1200)
    }
  }

  async undoLastEdit() {
    const action = this.undoStack.pop()
    if (!action) return
    this.redoStack.push(await this.inverseHistoryAction(action))
    const edit = this.reviewEdits.pop()
    if (edit) this.redoEdits.push(edit)
    await this.applyHistoryAction(action)
    this.updateToolbar()
  }

  async redoLastEdit() {
    const action = this.redoStack.pop()
    if (!action) return
    this.undoStack.push(await this.inverseHistoryAction(action))
    const edit = this.redoEdits.pop()
    if (edit) this.reviewEdits.push(edit)
    await this.applyHistoryAction(action)
    this.updateToolbar()
  }

  private pushUndoAction(action: UndoAction) {
    this.undoStack.push(action)
    this.redoStack = []
    this.redoEdits = []
  }

  private async inverseHistoryAction(action: UndoAction): Promise<UndoAction> {
    if (action.type === 'restore-markdown') {
      return { type: 'restore-markdown', markdown: this.markdownText || '' }
    }
    const current = this.zip?.file(action.zipPath)
    const data = current ? await current.async('uint8array') : null
    if (action.type === 'restore-image') return { type: 'restore-image', zipPath: action.zipPath, data }
    return {
      type: 'restore-markdown-and-image',
      markdown: this.markdownText || '',
      zipPath: action.zipPath,
      data,
    }
  }

  private async applyHistoryAction(action: UndoAction) {
    const previousSections = this.sections
    if (action.type === 'restore-markdown') {
      this.markdownText = action.markdown
      this.refreshSectionsPreservingMatches(previousSections)
    } else if (action.type === 'restore-image' && this.zip) {
      if (action.data) this.zip.file(action.zipPath, action.data)
      else this.zip.remove(action.zipPath)
      this.revokeAssetUrl(action.zipPath)
    } else if (action.type === 'restore-markdown-and-image' && this.zip) {
      if (action.data) {
        this.zip.file(action.zipPath, action.data)
        this.pendingDeletedAssets.delete(action.zipPath)
      } else {
        this.zip.remove(action.zipPath)
        this.pendingDeletedAssets.add(action.zipPath)
      }
      this.revokeAssetUrl(action.zipPath)
      this.markdownText = action.markdown
      this.refreshSectionsPreservingMatches(previousSections)
    }
    this.rebuildMarkdownView()
  }

  private render() {
    if (!this.shadowRoot) return
    this.previewLineNumberObserver?.disconnect()
    this.previewLineNumberObserver = null
    if (this.previewLineNumberFrame) cancelAnimationFrame(this.previewLineNumberFrame)
    this.previewLineNumberFrame = 0
    this.shadowRoot.innerHTML = `<style>${STYLES}</style><style id="markdownPluginStyles"></style>
      <div class="toolbar">
        <span id="stat">加载 MinerU ZIP 以开始</span>
        <div id="loadProgress" class="load-progress">
          <div class="load-progress-track"><div id="loadProgressFill" class="load-progress-fill"></div></div>
          <span id="loadProgressText" class="load-progress-text"></span>
        </div>
        <span class="spacer"></span>
        <button id="undo" disabled title="撤销">↶</button>
        <button id="redo" disabled title="重做">↷</button>
        <button id="export" disabled>导出修改版 ZIP</button>
        <button id="revealFolder" disabled title="通过快捷方式打开文件或文件夹后，可在资源管理器中定位">所在文件夹</button>
        <button id="settings" title="布局与渲染设置">⚙</button>
      </div>
      <div class="split" id="split">
        <div id="workspaceDivider" class="workspace-divider" title="拖动调整左右工作区比例">
          <button id="swapPanes" class="swap-panes" title="交换 PDF 与 Markdown 左右位置">⇄</button>
        </div>
        <section class="pane-column left-column">
          <div class="pane-toolbar">
            <button id="togglePdfOutline" class="menu-toggle" title="显示或隐藏 PDF 书签">☰</button>
            <strong>PDF</strong>
            <button id="dirty" class="history-toggle" title="查看并跳转到修改历史">暂无修改</button>
            <select id="pdfRenderModeToolbar" title="PDF Canvas 渲染清晰度"><option value="fast">快速</option><option value="quality">高清</option></select>
            <div class="toolbar-group">
              <button id="pdfZoomOut" title="缩小 PDF">−</button>
              <span id="pdfZoomValue" class="zoom-value">适合宽度</span>
              <button id="pdfZoomIn" title="放大 PDF">＋</button>
              <button id="fitPage">整页</button>
              <button id="fitWidth">页宽</button>
            </div>
            <span class="spacer"></span>
            <div class="legend"><span><i></i>文字</span><span><i class="visual"></i>图片</span><span><i class="removed"></i>已删/未引用</span></div>
          </div>
          <div id="historyPanel" class="history-panel"></div>
          <div id="pdfPaneBody" class="pane-body">
            <div id="pdfOutlinePanel" class="outline-panel"></div>
            <div id="pdfOutlineResizer" class="outline-resizer" title="拖动调整书签区域大小"></div>
            <div class="pane pane-left" id="pdfPane"><slot name="loading">加载 PDF + JSON 以开始</slot></div>
          </div>
        </section>
        <section class="pane-column right-column" id="rightColumn">
          <div class="pane-toolbar">
            <button id="toggleMdOutline" class="menu-toggle" title="显示或隐藏 Markdown 大纲">☰</button>
            <strong id="documentFormatLabel">Markdown</strong>
            <div class="format-switch" role="tablist">
              <button id="showMarkdownView" class="active" type="button">Markdown</button>
              <button id="showJsonView" type="button" disabled title="打开带 JSON 的 MinerU 结果后可切换">JSON</button>
            </div>
            <button id="mdPreviewMode" class="active">预览</button>
            <button id="mdLiveMode" title="直接在渲染内容上输入并自动同步源文件">实时预览</button>
            <button id="mdSourceMode">code</button>
            <button id="mdMindmapMode" title="把标题与列表展开成思维导图，双击改文字、拖拽调整层级，改动实时写回源码">思维导图</button>
            <div class="toolbar-group">
              <button id="mdZoomOut" title="缩小 Markdown">−</button>
              <span id="mdZoomValue" class="zoom-value">100%</span>
              <button id="mdZoomIn" title="放大 Markdown">＋</button>
            </div>
            <button id="vimToggle" title="源码模式使用 Vim 键位；预览与实时预览支持 : 命令行（:N 跳行、:w 保存）、gg/G 跳转、/ 搜索与 n/N">Vim：开</button>
            <select id="lineNumberMode" class="line-number-mode" title="预览、实时预览和源码共用。相对模式下当前行显示绝对行号，其余显示与当前行的距离">
              <option value="off">行号关</option>
              <option value="absolute">绝对行号</option>
              <option value="relative">相对行号</option>
            </select>
            <button id="toggleFind">查找替换</button>
            <span class="spacer"></span>
            <span id="sourceStatus" class="source-status"></span>
            <button id="splitRight" title="在右侧新增一栏；每一栏都可以继续再分（如先左右、右边再上下），各栏独立切换预览/实时预览/code/思维导图，修改实时同步">⇥ 右分屏</button>
            <button id="splitDown" title="在下方新增一栏；每一栏都可以继续再分（如先左右、右边再上下），各栏独立切换预览/实时预览/code/思维导图，修改实时同步">⬒ 下分屏</button>
            <button id="closeSplitPane" hidden title="关闭这一栏分屏">✕ 关闭分屏</button>
            <button id="saveLocalMarkdown" disabled title="仅使用目录读写方式打开时可用">覆盖保存 Markdown</button>
            <button id="sourceSave" hidden>保存并预览</button>
            <button id="sourceCancel" hidden>取消</button>
          </div>
          <div class="find-bar" id="findBar">
            <div class="find-controls">
              <input id="findText" placeholder="查找文字（结果将在下方列出）">
              <input id="replaceText" placeholder="替换为">
              <button id="findNext">下一处</button>
              <button id="replaceOne">替换当前</button>
              <button id="replaceAll">全部替换</button>
              <span id="findResult" class="find-result"></span>
              <button id="closeFind" title="关闭">×</button>
            </div>
            <div class="find-options">
              <label><input id="findRegex" type="checkbox">正则</label>
              <label><input id="findCase" type="checkbox">区分大小写</label>
              <button id="removeBrokenImages" class="danger">删除失效图片链接</button>
            </div>
            <div id="findResults" class="find-results"></div>
          </div>
          <div id="mdPaneBody" class="pane-body">
            <div id="mdOutlinePanel" class="outline-panel"></div>
            <div id="mdOutlineResizer" class="outline-resizer" title="拖动调整大纲区域大小"></div>
            <div id="mdSplitGrid" class="md-split-grid">
              <div class="pane pane-right" id="mdPane"><div class="empty">右侧将显示 Markdown 审核内容</div></div>
            </div>
            <div class="vim-command-bar" id="vimCommandBar" role="dialog" aria-label="Vim 命令行" hidden>
              <span class="vim-command-prefix" id="vimCommandPrefix">:</span>
              <input id="vimCommandInput" spellcheck="false" autocomplete="off" aria-label="Vim 命令">
              <span class="vim-command-hint" id="vimCommandHint"></span>
            </div>
            <textarea id="jsonEditor" class="json-editor" spellcheck="false" hidden aria-label="MinerU JSON"></textarea>
          </div>
        </section>
      </div>
      <aside id="settingsPanel" class="settings-panel">
        <div class="settings-header"><strong>设置</strong><span class="spacer"></span><button id="closeSettings" title="关闭">×</button></div>
        <div class="settings-group">
          <label><input id="shellIntegration" type="checkbox" disabled> 开启 Windows 鼠标右键打开</label>
          <div class="settings-note">添加文件夹右键菜单，以及 Markdown / Org / ZIP 文件的“打开方式”。</div>
          <div id="shellIntegrationStatus" class="settings-note" role="status"></div>
        </div>
        <div class="settings-group">
          <strong>PDF / Markdown 主工作区</strong>
          <div class="settings-row"><label for="workspaceLayout">排列</label><select id="workspaceLayout"><option value="side">左右</option><option value="stack">上下</option></select><span></span></div>
          <div class="settings-row"><label for="workspaceRatio">左/上工作区</label><input id="workspaceRatio" type="range" min="20" max="80" step="1"><output id="workspaceRatioValue" class="settings-value"></output></div>
        </div>
        <div class="settings-group">
          <strong>PDF 渲染</strong>
          <div class="settings-row"><label for="pdfRenderModeSetting">清晰度</label><select id="pdfRenderModeSetting"><option value="fast">快速</option><option value="quality">高清</option></select><span></span></div>
          <div class="settings-note">快速模式减少 Canvas 像素与内存；高清模式按缩放和屏幕像素密度渲染。离开可视缓冲区的页面都会自动释放。</div>
        </div>
        <div class="settings-group">
          <strong>PDF 书签</strong>
          <div class="settings-row"><label for="pdfOutlineLayout">排列</label><select id="pdfOutlineLayout"><option value="side">左右</option><option value="stack">上下</option></select><span></span></div>
          <div class="settings-row"><label for="pdfOutlineSize">默认大小</label><input id="pdfOutlineSize" type="range" min="15" max="70" step="1"><output id="pdfOutlineSizeValue" class="settings-value"></output></div>
        </div>
        <div class="settings-group">
          <strong>单 Markdown / Org code 工作区</strong>
          <div class="settings-row"><label for="standaloneSourceLayout">排列</label><select id="standaloneSourceLayout"><option value="side">左右</option><option value="stack">上下</option></select><span></span></div>
          <div class="settings-row"><label for="standaloneSourceRatio">左/上编辑区</label><input id="standaloneSourceRatio" type="range" min="20" max="80" step="1"><output id="standaloneSourceRatioValue" class="settings-value"></output></div>
          <div class="settings-row"><label for="lineNumberModeSetting">行号</label><select id="lineNumberModeSetting"><option value="off">不显示</option><option value="absolute">绝对</option><option value="relative">相对</option></select><span></span></div>
          <div class="settings-note">预览、实时预览和源码模式共用。相对行号时，当前行仍显示绝对行号，其余显示与当前行的距离。</div>
        </div>
        <div class="settings-group">
          <strong>Markdown / Org 大纲</strong>
          <div class="settings-row"><label for="mdOutlineLayout">排列</label><select id="mdOutlineLayout"><option value="side">左右</option><option value="stack">上下</option></select><span></span></div>
          <div class="settings-row"><label for="mdOutlineSize">默认大小</label><input id="mdOutlineSize" type="range" min="15" max="70" step="1"><output id="mdOutlineSizeValue" class="settings-value"></output></div>
        </div>
        <div class="settings-group settings-plugin">
          <strong>Markdown 默认插件列表</strong>
          <div id="markdownPluginName" class="settings-plugin-name"></div>
          <button id="loadMarkdownTheme" title="只用于 Markdown 的本地 JavaScript 渲染/主题插件">添加插件…</button>
          <button id="restoreMarkdownTheme">恢复内置</button>
          <input id="markdownThemeFile" class="plugin-input" type="file" accept=".js,.mjs" multiple>
        </div>
        <div class="settings-group settings-plugin">
          <strong>Org 默认插件列表</strong>
          <div id="orgPluginName" class="settings-plugin-name"></div>
          <button id="loadOrgTheme" title="只用于 Org 的本地 JavaScript 渲染/主题插件">添加插件…</button>
          <button id="restoreOrgTheme">恢复内置</button>
          <input id="orgThemeFile" class="plugin-input" type="file" accept=".js,.mjs" multiple>
        </div>
      </aside>`

    this.updatePluginStyles()
    this.shadowRoot.getElementById('undo')!.addEventListener('click', () => {
      void this.undoLastEdit()
    })
    this.shadowRoot.getElementById('redo')!.addEventListener('click', () => {
      void this.redoLastEdit()
    })
    this.shadowRoot.getElementById('export')!.addEventListener('click', () => {
      void this.exportEditedZip()
    })
    this.shadowRoot.getElementById('revealFolder')!.addEventListener('click', () => {
      void this.revealCurrentFolder()
    })
    const shellToggle = this.shadowRoot.getElementById('shellIntegration') as HTMLInputElement
    const shellStatus = this.shadowRoot.getElementById('shellIntegrationStatus')!
    const updateShellIntegration = async (enabled?: boolean) => {
      const previous = enabled === undefined ? shellToggle.checked : !enabled
      shellToggle.disabled = true
      shellStatus.textContent = enabled === undefined ? '正在读取设置…' : '正在应用设置…'
      try {
        const token = new URLSearchParams(location.search).get('token')
        if (!token) throw new Error('请从桌面快捷方式启动本地查看器后设置。')
        const response = await fetch(`/__viewer/shell-integration?token=${encodeURIComponent(token)}`, enabled === undefined ? {} : {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }),
        })
        const result = await response.json()
        if (!response.ok) throw new Error(result.error || '无法读取设置')
        shellToggle.checked = result.enabled
        shellToggle.disabled = !result.supported
        shellStatus.textContent = result.supported ? (result.enabled ? '已开启；文件夹右键 → 显示更多选项。' : '已关闭') : '仅 Windows 本地查看器支持。'
      } catch (error) {
        shellToggle.checked = previous
        shellToggle.disabled = enabled === undefined
        shellStatus.textContent = error instanceof Error ? error.message : '设置失败'
      }
    }
    shellToggle.addEventListener('change', () => { void updateShellIntegration(shellToggle.checked) })
    this.shadowRoot.getElementById('settings')!.addEventListener('click', () => {
      this.shadowRoot?.getElementById('settingsPanel')?.classList.toggle('open')
      if (this.shadowRoot?.getElementById('settingsPanel')?.classList.contains('open')) void updateShellIntegration()
    })
    this.shadowRoot.getElementById('closeSettings')!.addEventListener('click', () => {
      this.shadowRoot?.getElementById('settingsPanel')?.classList.remove('open')
    })
    this.shadowRoot.getElementById('dirty')!.addEventListener('click', () => this.toggleHistoryPanel())
    this.shadowRoot.getElementById('swapPanes')!.addEventListener('click', () => {
      this.panesSwapped = !this.panesSwapped
      this.updatePaneLayout()
    })
    this.setupWorkspaceDivider()
    this.setupOutlineResizer('pdf')
    this.setupOutlineResizer('markdown')
    this.shadowRoot.getElementById('togglePdfOutline')!.addEventListener('click', () => this.toggleOutline('pdf'))
    this.shadowRoot.getElementById('toggleMdOutline')!.addEventListener('click', () => this.toggleOutline('markdown'))
    this.shadowRoot.getElementById('pdfZoomOut')!.addEventListener('click', () => this.changePdfZoom(-0.1))
    this.shadowRoot.getElementById('pdfZoomIn')!.addEventListener('click', () => this.changePdfZoom(0.1))
    this.shadowRoot.getElementById('fitPage')!.addEventListener('click', () => this.setPdfFitMode('page'))
    this.shadowRoot.getElementById('fitWidth')!.addEventListener('click', () => this.setPdfFitMode('width'))
    const pdfRenderModeToolbar = this.shadowRoot.getElementById('pdfRenderModeToolbar') as HTMLSelectElement
    pdfRenderModeToolbar.addEventListener('change', () => {
      this.setPdfRenderMode(pdfRenderModeToolbar.value === 'quality' ? 'quality' : 'fast')
    })
    this.shadowRoot.getElementById('mdZoomOut')!.addEventListener('click', () => this.changeMarkdownZoom(-0.1))
    this.shadowRoot.getElementById('mdZoomIn')!.addEventListener('click', () => this.changeMarkdownZoom(0.1))
    this.shadowRoot.getElementById('showMarkdownView')!.addEventListener('click', () => this.showMarkdownDocument())
    this.shadowRoot.getElementById('showJsonView')!.addEventListener('click', () => this.showJsonDocument())
    this.shadowRoot.getElementById('jsonEditor')!.addEventListener('input', () => this.scheduleJsonSync())
    this.shadowRoot.getElementById('mdPreviewMode')!.addEventListener('click', () => this.switchToPreviewMode())
    this.shadowRoot.getElementById('mdLiveMode')!.addEventListener('click', () => this.switchToLiveMode())
    this.shadowRoot.getElementById('mdSourceMode')!.addEventListener('click', () => this.switchToSourceMode())
    this.shadowRoot.getElementById('mdMindmapMode')!.addEventListener('click', () => this.switchToMindmapMode())
    this.shadowRoot.getElementById('splitRight')!.addEventListener('click', () => this.addSplitPane('row'))
    this.shadowRoot.getElementById('splitDown')!.addEventListener('click', () => this.addSplitPane('column'))
    this.shadowRoot.getElementById('closeSplitPane')!.addEventListener('click', () => this.ownerViewer?.removeSplitPane(this))
    this.shadowRoot.getElementById('vimToggle')!.addEventListener('click', () => this.toggleVimMode())
    const vimCommandInput = this.shadowRoot.getElementById('vimCommandInput') as HTMLInputElement
    vimCommandInput.addEventListener('input', () => {
      this.updateVimCommandHint()
      if (this.vimCommandMode === '/') this.previewVimSearchMatch()
    })
    vimCommandInput.addEventListener('keydown', event => this.onVimCommandKeydown(event))
    this.shadowRoot.getElementById('lineNumberMode')!.addEventListener('change', event => {
      this.setLineNumberMode((event.target as HTMLSelectElement).value)
    })
    this.shadowRoot.getElementById('sourceSave')!.addEventListener('click', () => this.saveSourceAndPreview())
    this.shadowRoot.getElementById('sourceCancel')!.addEventListener('click', () => this.cancelSourceMode())
    this.shadowRoot.getElementById('toggleFind')!.addEventListener('click', () => this.toggleFindBar(true))
    this.shadowRoot.getElementById('closeFind')!.addEventListener('click', () => this.toggleFindBar(false))
    this.shadowRoot.getElementById('findNext')!.addEventListener('click', () => this.findNext())
    this.shadowRoot.getElementById('replaceOne')!.addEventListener('click', () => this.replaceCurrentMatch())
    this.shadowRoot.getElementById('replaceAll')!.addEventListener('click', () => this.replaceAllMatches())
    this.shadowRoot.getElementById('removeBrokenImages')!.addEventListener('click', () => this.removeBrokenImageReferences())
    this.shadowRoot.getElementById('saveLocalMarkdown')!.addEventListener('click', () => {
      void this.saveMarkdownToFolder()
    })
    const setupThemeInput = (format: DocumentFormat, inputId: string, loadId: string, restoreId: string) => {
      const input = this.shadowRoot!.getElementById(inputId) as HTMLInputElement
      this.shadowRoot!.getElementById(loadId)!.addEventListener('click', () => input.click())
      this.shadowRoot!.getElementById(restoreId)!.addEventListener('click', () => this.restoreBuiltinRenderPlugin(format))
      input.addEventListener('change', () => {
        const files = Array.from(input.files || [])
        void (async () => {
          for (const file of files) await this.loadMarkdownRenderPlugin(file, format)
        })()
        input.value = ''
      })
    }
    setupThemeInput('markdown', 'markdownThemeFile', 'loadMarkdownTheme', 'restoreMarkdownTheme')
    setupThemeInput('org', 'orgThemeFile', 'loadOrgTheme', 'restoreOrgTheme')
    const findInput = this.shadowRoot.getElementById('findText') as HTMLInputElement
    findInput.addEventListener('input', () => this.updateSearchResults())
    this.shadowRoot.getElementById('findRegex')!.addEventListener('change', () => this.updateSearchResults())
    this.shadowRoot.getElementById('findCase')!.addEventListener('change', () => this.updateSearchResults())
    findInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') this.findNext()
    })
    this.shadowRoot.addEventListener('keydown', event => {
      const keyboardEvent = event as KeyboardEvent
      if ((keyboardEvent.ctrlKey || keyboardEvent.metaKey) && keyboardEvent.key.toLowerCase() === 'f') {
        event.preventDefault()
        this.toggleFindBar(true)
      }
    })
    this.setupSettingsControls()
    this.updatePaneLayout()
  }

  private setupResize() {
    this.resizeObserver?.disconnect()
    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeTimer) clearTimeout(this.resizeTimer)
      this.resizeTimer = setTimeout(() => this.rebuildPdfPreservingPosition(), 100)
    })
    const pane = this.shadowRoot?.getElementById('pdfPane')
    if (pane) this.resizeObserver.observe(pane)
  }

  private async loadPdf(url: string) {
    this.pdfUrl = url
    await this.rebuild()
  }

  private async loadLayout(url: string) {
    const response = await fetch(url)
    this.layoutPath = url
    this.layoutData = await response.text()
    this.chooseSyncedJson()
    await this.rebuild()
  }

  private async rebuild() {
    const sequence = ++this.rebuildSequence
    const primaryData = this.contentListData || this.contentListV2Data || this.layoutData
    if (!primaryData) return

    const extras: PdfBlock[] = []
    if (this.layoutData && this.layoutData !== primaryData) extras.push(...parseBlocks(this.layoutData))
    if (this.contentListV2Data && this.contentListV2Data !== primaryData) extras.push(...parseBlocks(this.contentListV2Data))
    this.blocks = appendPageFurniture(parseBlocks(primaryData), extras)
    const markdown = this.markdownText
      || this.blocks.map(block => block.text || '').filter(Boolean).join('\n')
    const sourceMarkdown = this.markdownText
    this.setStatus('正在后台匹配 PDF 与 Markdown…')
    const matching = this.matchMarkdownInWorker(markdown, this.blocks)
    const pdfLoading = this.pdfUrl && this.renderedPdfUrl !== this.pdfUrl
      ? this.renderPdfPages()
      : Promise.resolve()
    await pdfLoading
    if (sequence !== this.rebuildSequence) return
    this.sections = parseMarkdownSections(markdown)
    this.updateToolbar()
    this.buildPdfOverlays()
    this.updatePaneLayout()
    this.renderPdfOutline()
    this.buildMarkdown()
    this.renderMarkdownOutline()
    this.setStatus(this.pages.length ? 'PDF 已可阅读，正在后台准备双向定位…' : '未加载 PDF，正在准备 Markdown…')
    const sections = await matching
    if (sequence !== this.rebuildSequence) return
    if (this.markdownText !== sourceMarkdown) {
      await this.rebuild()
      return
    }
    this.sections = sections
    await this.waitForPreview()
    if (sequence !== this.rebuildSequence) return
    this.updateToolbar()
    this.refreshMatchedPreview()
    this.renderMarkdownOutline()
    this.setStatus(this.pages.length ? 'PDF 与 Markdown 匹配完成' : 'Markdown 已加载，请补充原始 PDF')
  }

  private async matchMarkdownInWorker(markdown: string, blocks: PdfBlock[]): Promise<MdSection[]> {
    const sections = parseMarkdownSections(markdown)
    if (typeof Worker === 'undefined' || !VIEWER_ASSET_BASE_URL) {
      return matchSectionsToPdf(sections, blocks)
    }
    const workerUrl = new URL('match-worker.js', VIEWER_ASSET_BASE_URL)
    if (VIEWER_ASSET_VERSION) workerUrl.searchParams.set('v', VIEWER_ASSET_VERSION)
    const worker = new Worker(workerUrl)
    return new Promise(resolve => {
      let settled = false
      const finish = (matched: MdSection[]) => {
        if (settled) return
        settled = true
        worker.terminate()
        resolve(matched)
      }
      const fallback = () => {
        finish(matchSectionsToPdf(sections, blocks))
      }
      const timer = setTimeout(fallback, 120000)
      worker.addEventListener('message', event => {
        clearTimeout(timer)
        if (event.data?.error || !Array.isArray(event.data?.matched)) {
          fallback()
          return
        }
        finish(event.data.matched as MdSection[])
      }, { once: true })
      worker.addEventListener('error', () => {
        clearTimeout(timer)
        fallback()
      }, { once: true })
      worker.postMessage({ id: 1, sections, blocks })
    })
  }

  private refreshMatchedPreview() {
    const preview = this.shadowRoot?.getElementById('mdPane')?.querySelector<HTMLElement>('.md-preview')
    if (preview && this.markdownMode !== 'source') {
      this.annotatePreviewBlocks(preview)
      preview.querySelectorAll('.md-page-marker').forEach(marker => marker.remove())
      this.insertMarkdownPageMarkers(preview)
      this.schedulePreviewLineNumbers()
    }
    this.updateOverlayStates()
  }

  private rebuildMarkdownView() {
    const pane = this.shadowRoot?.getElementById('mdPane')
    const scrollTop = pane?.scrollTop || 0
    this.activeIdx = null
    this.buildMarkdown()
    if (pane) pane.scrollTop = scrollTop
    this.updateOverlayStates()
    this.updateToolbar()
    if (this.shadowRoot?.getElementById('findBar')?.classList.contains('open')) this.updateSearchResults()
  }

  private async renderPdfPages() {
    if (!this.pdfUrl) return
    const targetUrl = this.pdfUrl
    const sequence = this.rebuildSequence
    this.pdfPageObserver?.disconnect()
    this.pdfPageObserver = null
    this.releaseAllPdfPages()
    if (this.pdfDocument) await this.pdfDocument.destroy()
    const pdf = await pdfjsLib.getDocument(targetUrl).promise
    if (sequence !== this.rebuildSequence || targetUrl !== this.pdfUrl) {
      await pdf.destroy()
      return
    }
    this.pdfDocument = pdf
    const outline = ((await pdf.getOutline()) || []) as unknown as PdfOutlineItem[]
    const firstPage = await pdf.getPage(1)
    const viewport = firstPage.getViewport({ scale: 1 })
    firstPage.cleanup()
    if (sequence !== this.rebuildSequence || targetUrl !== this.pdfUrl) return
    this.pdfOutline = outline
    const pages: PdfPageState[] = Array.from({ length: pdf.numPages }, (_, index) => ({
      p: index + 1,
      w: viewport.width,
      h: viewport.height,
      rendered: false,
      renderVersion: 0,
    }))
    this.setStatus(`已建立 ${pdf.numPages} 页索引，正在显示首屏…`)
    this.pages = pages
    this.renderedPdfUrl = targetUrl
  }

  private buildUI() {
    this.updateToolbar()
    this.buildPdfOverlays()
    this.buildMarkdown()
    this.updatePaneLayout()
    this.renderMarkdownOutline()
    this.renderPdfOutline()
    // A launcher window can only merge with its peers once its own load is done.
    this.announceWindowReady()
  }

  private updateToolbar() {
    const shadow = this.shadowRoot
    if (!shadow) return
    const matched = this.sections.filter(section => section.bbox).length
    const images = this.sections.filter(section => section.kind === 'image').length
    const formatLabel = this.documentFormat === 'org' ? 'Org' : 'Markdown'
    shadow.getElementById('stat')!.innerHTML = this.standaloneMarkdown
      ? `${formatLabel} 编辑器 · ${this.sections.length} 个内容块 · ${images} 张图片`
      : `${this.pages.length} 页 · ${this.sections.length} 行 · ${images} 张图片 · <span class="${matched ? 'ok' : 'warn'}">匹配 ${matched}</span>`
    const documentFormatLabel = shadow.getElementById('documentFormatLabel')
    if (documentFormatLabel) documentFormatLabel.textContent = formatLabel
    const localSave = shadow.getElementById('saveLocalMarkdown') as HTMLButtonElement | null
    if (localSave && localSave.textContent !== '正在保存…' && localSave.textContent !== '已保存到本地') {
      localSave.textContent = `覆盖保存 ${formatLabel}`
    }
    const dirty = shadow.getElementById('dirty')!
    dirty.className = `history-toggle${this.reviewEdits.length ? ' dirty' : ''}`
    dirty.textContent = this.reviewEdits.length ? `已修改 ${this.reviewEdits.length} 项 ▾` : '暂无修改'
    ;(shadow.getElementById('undo') as HTMLButtonElement).disabled = this.undoStack.length === 0 || this.markdownMode === 'source'
    ;(shadow.getElementById('redo') as HTMLButtonElement).disabled = this.redoStack.length === 0 || this.markdownMode === 'source'
    ;(shadow.getElementById('export') as HTMLButtonElement).disabled = !this.zip
    const revealFolder = shadow.getElementById('revealFolder') as HTMLButtonElement | null
    if (revealFolder) {
      revealFolder.disabled = !this.launcherLocation
      revealFolder.title = this.launcherLocation
        ? '在资源管理器中打开当前文件所在文件夹'
        : '通过快捷方式打开文件或文件夹后，可在资源管理器中定位'
    }
    ;(shadow.getElementById('saveLocalMarkdown') as HTMLButtonElement).disabled = !this.sourceDirectoryHandle && !this.sourceMarkdownFileHandle
    ;(shadow.getElementById('togglePdfOutline') as HTMLButtonElement).hidden = this.standaloneMarkdown
    const brokenButton = shadow.getElementById('removeBrokenImages') as HTMLButtonElement | null
    if (brokenButton) {
      const count = this.brokenImageSections().length
      brokenButton.textContent = `删除失效图片链接${count ? `（${count}）` : ''}`
      brokenButton.disabled = count === 0
    }
    const pdfZoomValue = shadow.getElementById('pdfZoomValue')
    if (pdfZoomValue) {
      pdfZoomValue.textContent = this.pdfFitMode === 'page'
        ? '适合整页'
        : this.pdfFitMode === 'width' ? '适合宽度' : `${Math.round(this.pdfZoom * 100)}%`
    }
    const mdZoomValue = shadow.getElementById('mdZoomValue')
    if (mdZoomValue) mdZoomValue.textContent = `${Math.round(this.markdownZoom * 100)}%`
    this.renderHistoryPanel()
    this.updateDocumentView()
  }

  private updatePaneLayout() {
    const split = this.shadowRoot?.getElementById('split')
    if (!split) return
    split.classList.toggle('swapped', this.panesSwapped && !this.standaloneMarkdown)
    split.classList.toggle('markdown-only', this.standaloneMarkdown)
    split.classList.toggle('workspace-stack', this.viewerSettings.workspaceLayout === 'stack' && !this.standaloneMarkdown)
    split.style.setProperty('--workspace-left', `${this.viewerSettings.workspaceLeftPercent}%`)
    const divider = this.shadowRoot?.getElementById('workspaceDivider')
    divider?.classList.toggle('stack', this.viewerSettings.workspaceLayout === 'stack')
    if (divider) divider.title = this.viewerSettings.workspaceLayout === 'stack'
      ? '拖动调整上下工作区比例'
      : '拖动调整左右工作区比例'
    const swap = this.shadowRoot?.getElementById('swapPanes') as HTMLButtonElement | null
    if (swap) {
      swap.textContent = this.viewerSettings.workspaceLayout === 'stack' ? '⇅' : '⇄'
      swap.title = this.viewerSettings.workspaceLayout === 'stack'
        ? '交换 PDF 与 Markdown 上下位置'
        : '交换 PDF 与 Markdown 左右位置'
    }
    this.updateOutlineLayout('pdf')
    this.updateOutlineLayout('markdown')
    this.updateSettingsControls()
  }

  private toggleOutline(kind: 'pdf' | 'markdown') {
    const body = this.shadowRoot?.getElementById(kind === 'pdf' ? 'pdfPaneBody' : 'mdPaneBody')
    if (!body) return
    body.classList.toggle('outline-open')
    if (kind === 'pdf') this.renderPdfOutline()
    else this.renderMarkdownOutline()
  }

  private loadViewerSettings() {
    try {
      const stored = JSON.parse(localStorage.getItem(VIEWER_SETTINGS_KEY) || '{}') as Partial<ViewerSettings>
      this.viewerSettings = {
        workspaceLayout: stored.workspaceLayout === 'stack' ? 'stack' : 'side',
        workspaceLeftPercent: this.clampPercent(stored.workspaceLeftPercent, DEFAULT_VIEWER_SETTINGS.workspaceLeftPercent, 20, 80),
        standaloneSourceLayout: stored.standaloneSourceLayout === 'stack' ? 'stack' : 'side',
        standaloneSourceFirstPercent: this.clampPercent(stored.standaloneSourceFirstPercent, DEFAULT_VIEWER_SETTINGS.standaloneSourceFirstPercent, 20, 80),
        standaloneSourceSwapped: stored.standaloneSourceSwapped === true,
        pdfOutlineLayout: stored.pdfOutlineLayout === 'stack' ? 'stack' : 'side',
        pdfOutlineSize: this.clampPercent(stored.pdfOutlineSize, DEFAULT_VIEWER_SETTINGS.pdfOutlineSize, 15, 70),
        markdownOutlineLayout: stored.markdownOutlineLayout === 'stack' ? 'stack' : 'side',
        markdownOutlineSize: this.clampPercent(stored.markdownOutlineSize, DEFAULT_VIEWER_SETTINGS.markdownOutlineSize, 15, 70),
        pdfRenderMode: stored.pdfRenderMode === 'quality' ? 'quality' : 'fast',
        lineNumberMode: stored.lineNumberMode === 'off' || stored.lineNumberMode === 'relative' ? stored.lineNumberMode : 'absolute',
      }
    } catch {
      this.viewerSettings = { ...DEFAULT_VIEWER_SETTINGS }
    }
  }

  private saveViewerSettings() {
    try { localStorage.setItem(VIEWER_SETTINGS_KEY, JSON.stringify(this.viewerSettings)) } catch { /* ignored */ }
  }

  private clampPercent(value: unknown, fallback: number, min: number, max: number): number {
    const number = Number(value)
    return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback
  }

  private setupSettingsControls() {
    const shadow = this.shadowRoot
    if (!shadow) return
    const listenRange = (id: string, apply: (value: number) => void) => {
      const input = shadow.getElementById(id) as HTMLInputElement
      input.addEventListener('input', () => {
        apply(Number(input.value))
        this.updatePaneLayout()
        this.saveViewerSettings()
      })
    }
    listenRange('workspaceRatio', value => { this.viewerSettings.workspaceLeftPercent = value })
    listenRange('standaloneSourceRatio', value => {
      this.viewerSettings.standaloneSourceFirstPercent = value
      this.updateStandaloneSourceLayout()
    })
    listenRange('pdfOutlineSize', value => { this.viewerSettings.pdfOutlineSize = value })
    listenRange('mdOutlineSize', value => { this.viewerSettings.markdownOutlineSize = value })
    const workspaceLayout = shadow.getElementById('workspaceLayout') as HTMLSelectElement
    workspaceLayout.addEventListener('change', () => {
      this.viewerSettings.workspaceLayout = workspaceLayout.value === 'stack' ? 'stack' : 'side'
      this.updatePaneLayout()
      this.saveViewerSettings()
    })
    const standaloneLayout = shadow.getElementById('standaloneSourceLayout') as HTMLSelectElement
    standaloneLayout.addEventListener('change', () => {
      this.viewerSettings.standaloneSourceLayout = standaloneLayout.value === 'stack' ? 'stack' : 'side'
      this.updateStandaloneSourceLayout()
      this.updateSettingsControls()
      this.saveViewerSettings()
    })
    const pdfLayout = shadow.getElementById('pdfOutlineLayout') as HTMLSelectElement
    pdfLayout.addEventListener('change', () => {
      this.viewerSettings.pdfOutlineLayout = pdfLayout.value === 'stack' ? 'stack' : 'side'
      this.updatePaneLayout()
      this.saveViewerSettings()
    })
    const mdLayout = shadow.getElementById('mdOutlineLayout') as HTMLSelectElement
    mdLayout.addEventListener('change', () => {
      this.viewerSettings.markdownOutlineLayout = mdLayout.value === 'stack' ? 'stack' : 'side'
      this.updatePaneLayout()
      this.saveViewerSettings()
    })
    const pdfRenderMode = shadow.getElementById('pdfRenderModeSetting') as HTMLSelectElement
    pdfRenderMode.addEventListener('change', () => {
      this.setPdfRenderMode(pdfRenderMode.value === 'quality' ? 'quality' : 'fast')
    })
    const lineNumberModeSetting = shadow.getElementById('lineNumberModeSetting') as HTMLSelectElement
    lineNumberModeSetting.addEventListener('change', () => this.setLineNumberMode(lineNumberModeSetting.value))
  }

  private updateSettingsControls() {
    const shadow = this.shadowRoot
    if (!shadow) return
    const setRange = (id: string, valueId: string, value: number) => {
      const input = shadow.getElementById(id) as HTMLInputElement | null
      const output = shadow.getElementById(valueId)
      if (input) input.value = String(value)
      if (output) output.textContent = `${value}%`
    }
    setRange('workspaceRatio', 'workspaceRatioValue', this.viewerSettings.workspaceLeftPercent)
    setRange('standaloneSourceRatio', 'standaloneSourceRatioValue', this.viewerSettings.standaloneSourceFirstPercent)
    setRange('pdfOutlineSize', 'pdfOutlineSizeValue', this.viewerSettings.pdfOutlineSize)
    setRange('mdOutlineSize', 'mdOutlineSizeValue', this.viewerSettings.markdownOutlineSize)
    const workspaceLayout = shadow.getElementById('workspaceLayout') as HTMLSelectElement | null
    const standaloneLayout = shadow.getElementById('standaloneSourceLayout') as HTMLSelectElement | null
    const pdfLayout = shadow.getElementById('pdfOutlineLayout') as HTMLSelectElement | null
    const mdLayout = shadow.getElementById('mdOutlineLayout') as HTMLSelectElement | null
    const pdfRenderModeSetting = shadow.getElementById('pdfRenderModeSetting') as HTMLSelectElement | null
    const pdfRenderModeToolbar = shadow.getElementById('pdfRenderModeToolbar') as HTMLSelectElement | null
    if (workspaceLayout) workspaceLayout.value = this.viewerSettings.workspaceLayout
    if (standaloneLayout) standaloneLayout.value = this.viewerSettings.standaloneSourceLayout
    if (pdfLayout) pdfLayout.value = this.viewerSettings.pdfOutlineLayout
    if (mdLayout) mdLayout.value = this.viewerSettings.markdownOutlineLayout
    if (pdfRenderModeSetting) pdfRenderModeSetting.value = this.viewerSettings.pdfRenderMode
    if (pdfRenderModeToolbar) pdfRenderModeToolbar.value = this.viewerSettings.pdfRenderMode
    for (const id of ['lineNumberMode', 'lineNumberModeSetting']) {
      const select = shadow.getElementById(id) as HTMLSelectElement | null
      if (select) select.value = this.viewerSettings.lineNumberMode
    }
    const markdownPluginName = shadow.getElementById('markdownPluginName')
    const orgPluginName = shadow.getElementById('orgPluginName')
    const renderPluginList = (host: HTMLElement | null, format: DocumentFormat) => {
      if (!host) return
      host.innerHTML = ''
      for (const item of this.defaultRenderPlugins[format]) {
        const row = document.createElement('div')
        row.className = 'settings-plugin-item'
        const label = document.createElement('span')
        label.textContent = `${item.label}（${item.plugin.name}）`
        row.appendChild(label)
        if (!item.builtin) {
          const remove = document.createElement('button')
          remove.type = 'button'
          remove.textContent = '移除'
          remove.addEventListener('click', () => this.removeDefaultRenderPlugin(format, item.plugin.name))
          row.appendChild(remove)
        }
        host.appendChild(row)
      }
    }
    renderPluginList(markdownPluginName, 'markdown')
    renderPluginList(orgPluginName, 'org')
  }

  private updateOutlineLayout(kind: 'pdf' | 'markdown') {
    const body = this.shadowRoot?.getElementById(kind === 'pdf' ? 'pdfPaneBody' : 'mdPaneBody')
    if (!body) return
    const layout = kind === 'pdf' ? this.viewerSettings.pdfOutlineLayout : this.viewerSettings.markdownOutlineLayout
    const size = kind === 'pdf' ? this.viewerSettings.pdfOutlineSize : this.viewerSettings.markdownOutlineSize
    body.classList.toggle('outline-stack', layout === 'stack')
    body.style.setProperty('--outline-size', `${size}%`)
  }

  private setupWorkspaceDivider() {
    const divider = this.shadowRoot?.getElementById('workspaceDivider')
    const split = this.shadowRoot?.getElementById('split')
    if (!divider || !split) return
    divider.addEventListener('pointerdown', event => {
      if ((event.target as Element).closest('button') || this.standaloneMarkdown) return
      event.preventDefault()
      divider.setPointerCapture(event.pointerId)
      const move = (moveEvent: PointerEvent) => {
        const rect = split.getBoundingClientRect()
        const raw = this.viewerSettings.workspaceLayout === 'stack'
          ? (moveEvent.clientY - rect.top) / rect.height * 100
          : (moveEvent.clientX - rect.left) / rect.width * 100
        this.viewerSettings.workspaceLeftPercent = this.clampPercent(
          raw, 50, 20, 80,
        )
        this.updatePaneLayout()
      }
      const finish = () => {
        divider.removeEventListener('pointermove', move)
        this.saveViewerSettings()
      }
      divider.addEventListener('pointermove', move)
      divider.addEventListener('pointerup', finish, { once: true })
      divider.addEventListener('pointercancel', finish, { once: true })
    })
  }

  private setupOutlineResizer(kind: 'pdf' | 'markdown') {
    const body = this.shadowRoot?.getElementById(kind === 'pdf' ? 'pdfPaneBody' : 'mdPaneBody')
    const resizer = this.shadowRoot?.getElementById(kind === 'pdf' ? 'pdfOutlineResizer' : 'mdOutlineResizer')
    if (!body || !resizer) return
    resizer.addEventListener('pointerdown', event => {
      event.preventDefault()
      resizer.setPointerCapture(event.pointerId)
      const move = (moveEvent: PointerEvent) => {
        const rect = body.getBoundingClientRect()
        const layout = kind === 'pdf' ? this.viewerSettings.pdfOutlineLayout : this.viewerSettings.markdownOutlineLayout
        const raw = layout === 'side'
          ? (moveEvent.clientX - rect.left) / rect.width * 100
          : (moveEvent.clientY - rect.top) / rect.height * 100
        const value = this.clampPercent(raw, 33, 15, 70)
        if (kind === 'pdf') this.viewerSettings.pdfOutlineSize = value
        else this.viewerSettings.markdownOutlineSize = value
        this.updatePaneLayout()
      }
      const finish = () => {
        resizer.removeEventListener('pointermove', move)
        this.saveViewerSettings()
      }
      resizer.addEventListener('pointermove', move)
      resizer.addEventListener('pointerup', finish, { once: true })
      resizer.addEventListener('pointercancel', finish, { once: true })
    })
  }

  private renderMarkdownOutline() {
    const panel = this.shadowRoot?.getElementById('mdOutlinePanel')
    if (!panel) return
    panel.innerHTML = ''
    const list = this.createOutlineSearch(panel, `搜索 ${this.documentFormat === 'org' ? 'Org' : 'Markdown'} 大纲`)
    const headings = this.sections.flatMap((section, index) => {
      const match = this.documentFormat === 'org'
        ? section.raw.match(/^(\*{1,6})\s+(.+)$/)
        : section.raw.match(/^(#{1,6})\s+(.+?)\s*#*$/)
      return match ? [{ section, index, level: match[1].length, title: match[2] }] : []
    })
    if (!headings.length) {
      list.innerHTML = `<div class="outline-empty">没有 ${this.documentFormat === 'org' ? 'Org' : 'Markdown'} 标题</div>`
      return
    }
    for (const heading of headings) {
      const button = document.createElement('button')
      button.className = 'outline-item'
      button.style.paddingLeft = `${8 + (heading.level - 1) * 14}px`
      const level = document.createElement('span')
      level.className = 'outline-level'
      level.textContent = `H${heading.level}`
      button.append(level, document.createTextNode(heading.title))
      button.title = heading.title
      button.addEventListener('click', async () => {
        await this.waitForPreview()
        if (this.markdownMode === 'source' && this.sourceEditor) {
          this.sourceEditor.goTo(heading.section.start, heading.section.end - heading.section.start)
          return
        }
        const element = this.shadowRoot?.querySelector<HTMLElement>(`[data-idx="${heading.index}"]`)
        element?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        if (element) this.onMdClick(heading.section, heading.index, element)
      })
      list.appendChild(button)
    }
  }

  private renderPdfOutline() {
    const panel = this.shadowRoot?.getElementById('pdfOutlinePanel')
    if (!panel) return
    panel.innerHTML = ''
    const list = this.createOutlineSearch(panel, '搜索 PDF 书签')
    if (this.pdfOutline.length) {
      const append = (items: PdfOutlineItem[], level: number) => {
        for (const item of items) {
          const button = document.createElement('button')
          button.className = 'outline-item'
          button.style.paddingLeft = `${8 + level * 14}px`
          const badge = document.createElement('span')
          badge.className = 'outline-level'
          badge.textContent = `H${Math.min(level + 1, 6)}`
          button.append(badge, document.createTextNode(item.title || '未命名书签'))
          button.addEventListener('click', () => void this.goToPdfDestination(item.dest))
          list.appendChild(button)
          if (item.items?.length) append(item.items, level + 1)
        }
      }
      append(this.pdfOutline, 0)
      return
    }
    const fallback = this.sections.flatMap(section => {
      const match = section.raw.match(/^(#{1,6})\s+(.+?)\s*#*$/)
      return match && section.page ? [{ section, level: match[1].length, title: match[2] }] : []
    })
    if (!fallback.length) {
      list.innerHTML = '<div class="outline-empty">PDF 没有内置书签，也没有可用的 Markdown 标题</div>'
      return
    }
    for (const item of fallback) {
      const button = document.createElement('button')
      button.className = 'outline-item'
      button.style.paddingLeft = `${8 + (item.level - 1) * 14}px`
      const level = document.createElement('span')
      level.className = 'outline-level'
      level.textContent = `H${item.level}`
      button.append(level, document.createTextNode(`${item.title} · p${item.section.page}`))
      button.addEventListener('click', () => this.goToPdfPage(item.section.page))
      list.appendChild(button)
    }
  }

  private createOutlineSearch(panel: HTMLElement, placeholder: string) {
    const search = document.createElement('div')
    search.className = 'outline-search'
    const input = document.createElement('input')
    input.type = 'search'
    input.placeholder = placeholder
    input.setAttribute('aria-label', placeholder)
    search.appendChild(input)
    const list = document.createElement('div')
    const noMatch = document.createElement('div')
    noMatch.className = 'outline-no-match'
    noMatch.textContent = '没有匹配的标题'
    input.addEventListener('input', () => {
      const query = input.value.trim().toLocaleLowerCase()
      let visible = 0
      for (const item of list.querySelectorAll<HTMLElement>('.outline-item')) {
        const matched = !query || (item.title || item.textContent || '').toLocaleLowerCase().includes(query)
        item.style.display = matched ? '' : 'none'
        if (matched) visible++
      }
      noMatch.style.display = query && !visible ? 'block' : 'none'
    })
    panel.append(search, list, noMatch)
    return list
  }

  private async goToPdfDestination(destination: PdfOutlineItem['dest']) {
    if (!this.pdfDocument || !destination) return
    try {
      const explicit = typeof destination === 'string'
        ? await this.pdfDocument.getDestination(destination)
        : destination
      if (!explicit?.length) return
      const reference = explicit[0]
      const pageIndex = typeof reference === 'number'
        ? reference
        : await this.pdfDocument.getPageIndex(reference)
      this.goToPdfPage(pageIndex + 1)
    } catch (error) {
      console.warn('无法跳转 PDF 书签', error)
    }
  }

  private goToPdfPage(pageNumber: number) {
    const page = this.shadowRoot?.querySelector<HTMLElement>(`.pdf-page[data-page="${pageNumber}"]`)
    page?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    void this.renderPdfPage(pageNumber, page || undefined)
  }

  private toggleHistoryPanel() {
    const panel = this.shadowRoot?.getElementById('historyPanel')
    if (!panel) return
    panel.classList.toggle('open')
    this.renderHistoryPanel()
  }

  private renderHistoryPanel() {
    const panel = this.shadowRoot?.getElementById('historyPanel')
    if (!panel) return
    panel.innerHTML = ''
    if (!this.reviewEdits.length) {
      panel.innerHTML = '<div class="history-empty">还没有修改记录</div>'
      return
    }
    const labels: Record<ReviewEdit['type'], string> = {
      'replace-image': '替换图片',
      'remove-image-reference': '删除图片链接',
      'remove-image-and-reference': '删除链接和图片',
      'image-to-text': '图片改为文字',
      'edit-markdown': `编辑 ${this.documentFormat === 'org' ? 'Org' : 'Markdown'}`,
      'replace-text': '查找替换',
    }
    this.reviewEdits.slice().reverse().forEach((edit, reverseIndex) => {
      const index = this.reviewEdits.length - 1 - reverseIndex
      const button = document.createElement('button')
      button.className = 'history-item'
      const when = new Date(edit.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      button.innerHTML = `<strong>${index + 1}. ${labels[edit.type]}</strong><small>${edit.page ? `第 ${edit.page} 页 · ` : ''}${when}${edit.detail ? ` · ${this.escapeHtml(edit.detail)}` : ''}</small>`
      button.addEventListener('click', () => this.goToReviewEdit(edit))
      panel.appendChild(button)
    })
  }

  private goToReviewEdit(edit: ReviewEdit) {
    if (this.previewBuild) {
      void this.waitForPreview().then(() => this.goToReviewEdit(edit))
      return
    }
    if (edit.page) {
      const page = this.shadowRoot?.querySelector<HTMLElement>(`.pdf-page[data-page="${edit.page}"]`)
      page?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      void this.renderPdfPage(edit.page, page || undefined)
    }
    if (edit.blockId) {
      const overlay = this.shadowRoot?.querySelector<HTMLElement>(`.block-overlay[data-block-id="${CSS.escape(edit.blockId)}"]`)
      overlay?.classList.add('active')
    }
    if (typeof edit.markdownStart === 'number') {
      if (this.markdownMode === 'source' && this.sourceEditor) {
        this.sourceEditor.goTo(edit.markdownStart)
      } else {
        const index = this.sections.findIndex(section => section.start <= edit.markdownStart! && section.end > edit.markdownStart!)
        const element = this.shadowRoot?.querySelector<HTMLElement>(`[data-idx="${index}"]`)
        element?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        element?.classList.add('active')
      }
    }
  }

  private escapeHtml(value: string): string {
    const element = document.createElement('span')
    element.textContent = value
    return element.innerHTML
  }

  private buildPdfOverlays() {
    const pane = this.shadowRoot?.getElementById('pdfPane')
    if (!pane) return
    this.releaseAllPdfPages()
    this.pdfPageObserver?.disconnect()
    this.pdfPageObserver = null
    pane.innerHTML = ''
    if (!this.pdfUrl) {
      const notice = document.createElement('div')
      notice.className = 'empty'
      notice.textContent = '文件夹中没有可读取的 PDF。浏览器选择文件夹时可能忽略符号链接，请选择原始 PDF 文件。'
      const button = document.createElement('button')
      button.textContent = '选择原始 PDF'
      button.addEventListener('click', () => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.pdf,application/pdf'
        input.addEventListener('change', () => {
          const file = input.files?.[0]
          if (file) void this.attachPdf(file).catch(error => this.setStatus(`PDF 打开失败：${error instanceof Error ? error.message : String(error)}`))
        })
        input.click()
      })
      notice.appendChild(button)
      pane.appendChild(notice)
      return
    }
    const availableWidth = pane.clientWidth - 20
    const availableHeight = pane.clientHeight - 24
    if (availableWidth <= 0 || this.pages.length === 0) return
    this.pdfBlocksByPage.clear()
    for (const block of this.blocks) {
      const page = block.page_idx + 1
      const list = this.pdfBlocksByPage.get(page)
      if (list) list.push(block)
      else this.pdfBlocksByPage.set(page, [block])
    }

    for (const renderedPage of this.pages) {
      let cssWidth = availableWidth
      if (this.pdfFitMode === 'page') {
        cssWidth = Math.min(availableWidth, availableHeight * (renderedPage.w / renderedPage.h))
      } else if (this.pdfFitMode === 'custom') {
        cssWidth = availableWidth * this.pdfZoom
      }
      const cssHeight = renderedPage.h * (cssWidth / renderedPage.w)

      const wrapper = document.createElement('div')
      wrapper.className = 'pdf-page'
      wrapper.style.width = `${cssWidth}px`
      wrapper.style.height = `${cssHeight}px`
      wrapper.dataset.page = String(renderedPage.p)

      const placeholder = document.createElement('div')
      placeholder.className = 'pdf-placeholder'
      placeholder.textContent = `第 ${renderedPage.p} 页 · 滚动到此处时加载`
      wrapper.appendChild(placeholder)

      const label = document.createElement('span')
      label.className = 'page-num'
      label.textContent = String(renderedPage.p)
      wrapper.appendChild(label)

      pane.appendChild(wrapper)
      this.observePdfPage(wrapper)
    }
  }

  private mountPdfOverlays(wrapper: HTMLElement) {
    if (wrapper.dataset.overlaysMounted) return
    wrapper.dataset.overlaysMounted = 'true'
    const cssWidth = parseFloat(wrapper.style.width)
    const cssHeight = parseFloat(wrapper.style.height)
    const pageBlocks = [...(this.pdfBlocksByPage.get(Number(wrapper.dataset.page)) || [])]
      .sort((left, right) => Number(isPageFurnitureType(right.type)) - Number(isPageFurnitureType(left.type)))
    const referencedImages = new Set(this.sections.filter(section => section.imagePath)
      .map(section => normalizeAssetPath(section.imagePath!)))
    for (const block of pageBlocks) {
      const [x0, y0, x1, y1] = block.bbox
      const overlay = document.createElement('div')
      const imagePath = block.imagePath ? normalizeAssetPath(block.imagePath) : ''
      const missingImage = imagePath && !referencedImages.has(imagePath)
      const furniture = isPageFurnitureType(block.type)
      overlay.className = 'block-overlay'
        + (block.imagePath ? ' image-block' : '')
        + (missingImage ? ' missing-image' : '')
        + (furniture ? ' page-furniture' : '')
      overlay.style.left = `${x0 * cssWidth}px`
      overlay.style.top = `${y0 * cssHeight}px`
      overlay.style.width = `${Math.max((x1 - x0) * cssWidth, 2)}px`
      overlay.style.height = `${Math.max((y1 - y0) * cssHeight, 2)}px`
      overlay.title = (furniture
        ? `${pageFurnitureLabel(block.type)} ${block.text || ''}`.trim()
        : (block.imagePath || block.text || block.type || '')
      ).slice(0, 160)
      overlay.dataset.blockId = block.id
      if (this.activeIdx != null && this.sections[this.activeIdx]?.blockId === block.id) overlay.classList.add('active')
      if (furniture && block.text) {
        const caption = document.createElement('span')
        caption.className = 'furniture-label'
        caption.textContent = block.text
        overlay.appendChild(caption)
      }
      overlay.addEventListener('click', () => this.onBlockClick(block, overlay))
      wrapper.appendChild(overlay)
    }
  }

  private updateOverlayStates() {
    const shadow = this.shadowRoot
    if (!shadow) return
    const referencedImages = new Set(this.sections
      .filter(section => section.imagePath)
      .map(section => normalizeAssetPath(section.imagePath!)))
    const blocksById = new Map(this.blocks.map(block => [block.id, block]))
    shadow.querySelectorAll('.block-overlay.image-block').forEach(element => {
      const overlay = element as HTMLElement
      const block = blocksById.get(overlay.dataset.blockId || '')
      const missing = Boolean(block?.imagePath)
        && !referencedImages.has(normalizeAssetPath(block!.imagePath!))
      overlay.classList.toggle('missing-image', missing)
    })
  }

  private rebuildPdfPreservingPosition() {
    const pane = this.shadowRoot?.getElementById('pdfPane')
    if (!pane || !this.pages.length) return
    const wrappers = Array.from(pane.querySelectorAll('.pdf-page')) as HTMLElement[]
    const anchor = wrappers.find(page => page.offsetTop + page.offsetHeight >= pane.scrollTop)
    const pageNumber = Number(anchor?.dataset.page || 1)
    const ratio = anchor
      ? Math.max(0, (pane.scrollTop - anchor.offsetTop) / Math.max(anchor.offsetHeight, 1))
      : 0
    this.buildPdfOverlays()
    const nextAnchor = pane.querySelector(`.pdf-page[data-page="${pageNumber}"]`) as HTMLElement | null
    if (nextAnchor) pane.scrollTop = nextAnchor.offsetTop + ratio * nextAnchor.offsetHeight
  }

  private changePdfZoom(delta: number) {
    this.pdfFitMode = 'custom'
    this.pdfZoom = Math.min(3, Math.max(0.35, Number((this.pdfZoom + delta).toFixed(2))))
    this.rebuildPdfPreservingPosition()
    this.updateToolbar()
  }

  private setPdfFitMode(mode: 'width' | 'page') {
    this.pdfFitMode = mode
    this.rebuildPdfPreservingPosition()
    this.updateToolbar()
  }

  private setPdfRenderMode(mode: PdfRenderMode) {
    if (this.viewerSettings.pdfRenderMode === mode) return
    this.viewerSettings.pdfRenderMode = mode
    this.saveViewerSettings()
    this.updateSettingsControls()
    this.refreshPdfVirtualization()
  }

  private changeMarkdownZoom(delta: number) {
    this.markdownZoom = Math.min(2.2, Math.max(0.6, Number((this.markdownZoom + delta).toFixed(2))))
    const pane = this.shadowRoot?.getElementById('mdPane')
    pane?.style.setProperty('--md-zoom', String(this.markdownZoom))
    pane?.style.setProperty('--md-image-width', `${Math.round(this.markdownZoom * 100)}%`)
    pane?.style.setProperty('--md-image-height', `${Math.round(520 * this.markdownZoom)}px`)
    if (this.sourceEditor) this.sourceEditor.view.dom.style.fontSize = `${Math.round(14 * this.markdownZoom)}px`
    this.schedulePreviewLineNumbers()
    this.updateToolbar()
  }

  private observePdfPage(wrapper: HTMLElement) {
    const pageNumber = Number(wrapper.dataset.page)
    const pageState = this.pages[pageNumber - 1]
    if (!pageState) return
    if (typeof IntersectionObserver === 'undefined') {
      void this.renderPdfPage(pageNumber, wrapper)
      return
    }
    if (!this.pdfPageObserver) {
      const pane = this.shadowRoot!.getElementById('pdfPane')!
      this.pdfPageObserver = new IntersectionObserver(entries => {
        for (const entry of entries) {
          const target = entry.target as HTMLElement
          const targetPage = Number(target.dataset.page)
          if (entry.isIntersecting) void this.renderPdfPage(targetPage, target)
          else this.releasePdfPage(targetPage, target)
        }
      }, { root: pane, rootMargin: `${PDF_VIRTUAL_MARGIN}px 0px` })
    }
    this.pdfPageObserver.observe(wrapper)
  }

  private async renderPdfPage(pageNumber: number, wrapper?: HTMLElement) {
    const pageState = this.pages[pageNumber - 1]
    const pdfDocument = this.pdfDocument
    if (!pageState || !pdfDocument) return
    const target = wrapper || this.shadowRoot?.querySelector(`.pdf-page[data-page="${pageNumber}"]`) as HTMLElement | null
    if (!target) return
    this.mountPdfOverlays(target)
    if (target.querySelector('canvas')) return
    if (!pageState.rendering) {
      const renderVersion = ++pageState.renderVersion
      let job: Promise<void>
      job = (async () => {
        const page = await pdfDocument.getPage(pageNumber)
        try {
          if (renderVersion !== pageState.renderVersion) return
          const baseViewport = page.getViewport({ scale: 1 })
          if (Math.abs((pageState.w / pageState.h) - (baseViewport.width / baseViewport.height)) > 0.005) {
            pageState.w = baseViewport.width
            pageState.h = baseViewport.height
            this.updatePageGeometry(target, pageState)
          }
          const renderScale = this.pdfRenderScale(target, pageState)
          const viewport = page.getViewport({ scale: renderScale })
          const canvas = document.createElement('canvas')
          canvas.width = Math.ceil(viewport.width)
          canvas.height = Math.ceil(viewport.height)
          canvas.dataset.pageCanvas = String(pageNumber)
          canvas.dataset.renderMode = this.viewerSettings.pdfRenderMode
          canvas.dataset.renderScale = renderScale.toFixed(2)
          const renderTask = page.render({ canvasContext: canvas.getContext('2d')!, viewport })
          pageState.renderTask = renderTask
          try {
            await renderTask.promise
          } catch (error) {
            if ((error as { name?: string })?.name !== 'RenderingCancelledException') throw error
            return
          } finally {
            if (pageState.renderTask === renderTask) pageState.renderTask = undefined
          }
          if (renderVersion !== pageState.renderVersion) {
            canvas.width = 0
            canvas.height = 0
            return
          }
          const current = this.shadowRoot?.querySelector(`.pdf-page[data-page="${pageNumber}"]`) as HTMLElement | null
          if (current && !current.querySelector('canvas')) {
            current.querySelector('.pdf-placeholder')?.replaceWith(canvas)
            pageState.rendered = true
          } else {
            canvas.width = 0
            canvas.height = 0
          }
        } finally {
          page.cleanup()
        }
      })()
      pageState.rendering = job
      const clearRendering = () => {
        if (pageState.rendering === job) pageState.rendering = undefined
      }
      void job.then(clearRendering, clearRendering)
    }
    await pageState.rendering
  }

  private pdfRenderScale(wrapper: HTMLElement, pageState: PdfPageState): number {
    const pixelRatio = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1
    return computePdfRenderScale(
      this.viewerSettings.pdfRenderMode,
      wrapper.clientWidth,
      pageState.w,
      pixelRatio,
    )
  }

  private releasePdfPage(pageNumber: number, wrapper?: HTMLElement) {
    const pageState = this.pages[pageNumber - 1]
    if (!pageState) return
    pageState.renderVersion++
    try { pageState.renderTask?.cancel() } catch { /* already completed */ }
    pageState.renderTask = undefined
    pageState.rendering = undefined
    pageState.rendered = false
    const target = wrapper || this.shadowRoot?.querySelector(`.pdf-page[data-page="${pageNumber}"]`) as HTMLElement | null
    if (!target) return
    target.querySelectorAll('.block-overlay').forEach(overlay => overlay.remove())
    delete target.dataset.overlaysMounted
    for (const canvas of target.querySelectorAll('canvas')) {
      canvas.width = 0
      canvas.height = 0
      canvas.remove()
    }
    if (!target.querySelector('.pdf-placeholder')) {
      const placeholder = document.createElement('div')
      placeholder.className = 'pdf-placeholder'
      placeholder.textContent = `第 ${pageNumber} 页 · 滚动到此处时加载`
      target.prepend(placeholder)
    }
  }

  private releaseAllPdfPages() {
    for (const pageState of this.pages) {
      const wrapper = this.shadowRoot?.querySelector(`.pdf-page[data-page="${pageState.p}"]`) as HTMLElement | null
      this.releasePdfPage(pageState.p, wrapper || undefined)
    }
  }

  private refreshPdfVirtualization() {
    const pane = this.shadowRoot?.getElementById('pdfPane')
    if (!pane) return
    this.releaseAllPdfPages()
    this.pdfPageObserver?.disconnect()
    this.pdfPageObserver = null
    pane.querySelectorAll<HTMLElement>('.pdf-page').forEach(wrapper => this.observePdfPage(wrapper))
  }

  private updatePageGeometry(wrapper: HTMLElement, pageState: PdfPageState) {
    const cssWidth = wrapper.clientWidth
    const cssHeight = pageState.h * (cssWidth / pageState.w)
    wrapper.style.height = `${cssHeight}px`
    const blocksById = new Map(this.blocks
      .filter(block => block.page_idx === pageState.p - 1)
      .map(block => [block.id, block]))
    wrapper.querySelectorAll('.block-overlay').forEach(element => {
      const overlay = element as HTMLElement
      const block = blocksById.get(overlay.dataset.blockId || '')
      if (!block) return
      const [, y0, , y1] = block.bbox
      overlay.style.top = `${y0 * cssHeight}px`
      overlay.style.height = `${Math.max((y1 - y0) * cssHeight, 2)}px`
    })
  }

  private buildMarkdown() {
    if (this.markdownMode === 'source') {
      this.buildSourceEditor()
      return
    }
    if (this.markdownMode === 'mindmap') {
      this.buildMindmap()
      return
    }
    this.buildMarkdownPreview()
  }

  // ── Mind map ───────────────────────────────────────────────────────────────
  //
  // The map is a view over `markdownText`, exactly like the preview: every node
  // keeps the offsets of its own source line, so editing a node is a string
  // splice on the original document rather than a re-serialization. That is what
  // lets preview, live preview, code and the map stay in step.

  /** File name without its extension, used as the title of a synthetic root. */
  private mindmapDocumentTitle(): string {
    const name = this.sourceZipName || this.markdownPath || ''
    const trimmed = name.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '')
    return trimmed || '思维导图'
  }

  private buildMindmap() {
    const pane = this.shadowRoot?.getElementById('mdPane')
    if (!pane) return
    this.sourceEditor?.destroy()
    this.sourceEditor = null
    this.imageObserver?.disconnect()
    this.previewBuildSequence++
    this.previewBuild = null
    this.mindmapEditing = null

    const source = this.markdownText
    if (source == null || !source.trim()) {
      this.mindmapTree = null
      this.mindmapLayout = null
      const empty = document.createElement('div')
      empty.className = 'empty'
      empty.textContent = '没有可展开的标题或列表'
      pane.replaceChildren(empty)
      this.updateModeToolbar()
      return
    }
    this.mindmapTree = parseMindmapTree(source, {
      format: this.documentFormat,
      title: this.mindmapDocumentTitle(),
    })
    this.ensureMindmapSelection()

    const host = document.createElement('div')
    host.className = 'mindmap-host'
    host.tabIndex = 0
    host.innerHTML = `
      <div class="mindmap-toolbar">
        <span class="mindmap-hint">双击改文字 · Enter 同级 · Tab 子级 · Shift+Tab 升级 · Delete 删除 · 拖拽节点可换层级</span>
        <span id="mindmapCount" class="mindmap-count"></span>
        <span class="spacer"></span>
        <span class="mindmap-levels" title="按层级展开：只显示到第几级">
          <button type="button" data-mm="level-1">1级</button>
          <button type="button" data-mm="level-2">2级</button>
          <button type="button" data-mm="level-3">3级</button>
          <button type="button" data-mm="expand" title="展开全部层级">全部</button>
        </span>
        <button type="button" data-mm="collapse" title="折叠所有分支，只保留根节点">全部折叠</button>
        <button type="button" data-mm="fit">适应窗口</button>
        <button type="button" data-mm="zoom-out" title="缩小">−</button>
        <span id="mindmapZoom" class="zoom-value">100%</span>
        <button type="button" data-mm="zoom-in" title="放大">＋</button>
      </div>
      <div class="mindmap-viewport" id="mindmapViewport">
        <div class="mindmap-canvas" id="mindmapCanvas">
          <svg class="mindmap-links" id="mindmapLinks" aria-hidden="true"></svg>
        </div>
      </div>`

    host.querySelector('.mindmap-toolbar')!.addEventListener('click', event => this.onMindmapToolbarClick(event as MouseEvent))
    const viewport = host.querySelector('.mindmap-viewport')!
    viewport.addEventListener('pointerdown', event => this.onMindmapPointerDown(event as PointerEvent))
    viewport.addEventListener('pointermove', event => this.onMindmapPointerMove(event as PointerEvent))
    viewport.addEventListener('pointerup', event => this.onMindmapPointerUp(event as PointerEvent))
    viewport.addEventListener('pointercancel', event => this.onMindmapPointerUp(event as PointerEvent))
    viewport.addEventListener('click', event => this.onMindmapClick(event as MouseEvent))
    viewport.addEventListener('dblclick', event => this.onMindmapDoubleClick(event as MouseEvent))
    viewport.addEventListener('wheel', event => this.onMindmapWheel(event as WheelEvent), { passive: false })
    host.addEventListener('keydown', event => this.onMindmapKeydown(event))

    pane.replaceChildren(host)
    this.renderMindmapCanvas()
    this.fitMindmapToView()
    host.focus()
    this.updateModeToolbar()
  }

  private mindmapNodeById(id: string | null): MindmapNode | null {
    if (!id || !this.mindmapTree) return null
    return this.mindmapTree.nodes.find(node => node.id === id) ?? null
  }

  private mindmapElementFor(id: string | null): HTMLElement | null {
    if (!id) return null
    return this.shadowRoot?.querySelector<HTMLElement>(`.mindmap-node[data-id="${id}"]`) ?? null
  }

  private ensureMindmapSelection() {
    const tree = this.mindmapTree
    if (!tree) {
      this.mindmapSelected = null
      return
    }
    if (this.mindmapSelected && tree.nodes.some(node => node.id === this.mindmapSelected)) return
    this.mindmapSelected = tree.root.id
  }

  /** Rebuild the canvas in place, keeping pan, zoom, selection and folding. */
  private renderMindmapCanvas() {
    const tree = this.mindmapTree
    const canvas = this.shadowRoot?.getElementById('mindmapCanvas')
    const svg = this.shadowRoot?.getElementById('mindmapLinks') as unknown as SVGSVGElement | null
    if (!tree || !canvas || !svg) return

    const layout = layoutMindmap(tree, {
      collapsed: this.mindmapCollapsed,
      verticalGap: 14,
      horizontalGap: 52,
    })
    this.mindmapLayout = layout
    canvas.style.width = `${layout.width}px`
    canvas.style.height = `${layout.height}px`

    const boxes = new Map(layout.boxes.map(box => [box.index, box]))
    const paths: string[] = []
    for (const link of layout.links) {
      const from = boxes.get(link.from)
      const to = boxes.get(link.to)
      if (!from || !to) continue
      const x1 = from.x + from.width
      const y1 = from.y + from.height / 2
      const x2 = to.x
      const y2 = to.y + to.height / 2
      const mid = x1 + (x2 - x1) / 2
      paths.push(`M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`)
    }
    svg.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`)
    svg.setAttribute('width', String(layout.width))
    svg.setAttribute('height', String(layout.height))
    svg.innerHTML = paths.map(path => `<path d="${path}"></path>`).join('')

    canvas.querySelectorAll('.mindmap-node').forEach(element => element.remove())
    for (const box of layout.boxes) {
      const node = box.node
      const element = document.createElement('div')
      element.className = `mindmap-node kind-${node.kind}${box.depth === 0 ? ' root-node' : ''}`
      if (node.id === this.mindmapSelected) element.classList.add('selected')
      element.dataset.id = node.id
      element.style.left = `${box.x}px`
      element.style.top = `${box.y}px`
      element.style.width = `${box.width}px`
      element.style.height = `${box.height}px`
      element.title = node.source
        ? `${node.label}\n第 ${node.source.line + 1}-${node.source.lastLine + 1} 行`
        : node.label
      if (box.hasChildren) {
        const toggle = document.createElement('button')
        toggle.type = 'button'
        toggle.className = 'mindmap-toggle'
        toggle.dataset.mmToggle = node.id
        toggle.textContent = box.collapsed ? String(node.children.length) : '−'
        toggle.title = box.collapsed ? '展开子树' : '折叠子树'
        element.appendChild(toggle)
      }
      const label = document.createElement('span')
      label.className = 'mindmap-label'
      // Inline render so **bold** / `code` markers do not leak into the label.
      label.innerHTML = this.previewRenderer.renderInline(node.label || '（空标题）')
      element.appendChild(label)
      canvas.appendChild(element)
    }

    this.applyMindmapTransform()
    const count = this.shadowRoot?.getElementById('mindmapCount')
    if (count) count.textContent = `${layout.boxes.length}/${tree.nodes.length} 个节点`
  }

  private applyMindmapTransform() {
    const canvas = this.shadowRoot?.getElementById('mindmapCanvas')
    if (canvas) {
      canvas.style.transform = `translate(${this.mindmapPan.x}px, ${this.mindmapPan.y}px) scale(${this.mindmapZoom})`
    }
    const value = this.shadowRoot?.getElementById('mindmapZoom')
    if (value) value.textContent = `${Math.round(this.mindmapZoom * 100)}%`
  }

  private setMindmapZoom(zoom: number, anchor?: { x: number; y: number }) {
    const next = Math.min(2.5, Math.max(0.2, zoom))
    if (anchor && this.mindmapZoom > 0) {
      const ratio = next / this.mindmapZoom
      this.mindmapPan = {
        x: anchor.x - (anchor.x - this.mindmapPan.x) * ratio,
        y: anchor.y - (anchor.y - this.mindmapPan.y) * ratio,
      }
    }
    this.mindmapZoom = next
    this.applyMindmapTransform()
  }

  private fitMindmapToView() {
    const viewport = this.shadowRoot?.getElementById('mindmapViewport')
    const layout = this.mindmapLayout
    if (!viewport || !layout) return
    const width = viewport.clientWidth
    const height = viewport.clientHeight
    if (!width || !height) return
    const scale = Math.min(1.1, Math.max(0.25, Math.min(width / layout.width, height / layout.height)))
    this.mindmapZoom = Number(scale.toFixed(3))
    this.mindmapPan = {
      x: Math.round(Math.max(0, (width - layout.width * scale) / 2)),
      y: Math.round(Math.max(0, (height - layout.height * scale) / 2)),
    }
    this.applyMindmapTransform()
  }

  private mindmapSyncSelection() {
    const shadow = this.shadowRoot
    if (!shadow) return
    shadow.querySelectorAll<HTMLElement>('.mindmap-node').forEach(element => {
      element.classList.toggle('selected', element.dataset.id === this.mindmapSelected)
    })
  }

  /** Pull a node into the visible area by nudging the pan, not by scrolling. */
  private mindmapReveal(id: string) {
    const viewport = this.shadowRoot?.getElementById('mindmapViewport')
    const box = this.mindmapLayout?.boxes.find(entry => entry.node.id === id)
    if (!viewport || !box) return
    const margin = 64
    const left = box.x * this.mindmapZoom + this.mindmapPan.x
    const top = box.y * this.mindmapZoom + this.mindmapPan.y
    const right = left + box.width * this.mindmapZoom
    const bottom = top + box.height * this.mindmapZoom
    let dx = 0
    let dy = 0
    if (left < margin) dx = margin - left
    else if (right > viewport.clientWidth - margin) dx = viewport.clientWidth - margin - right
    if (top < margin) dy = margin - top
    else if (bottom > viewport.clientHeight - margin) dy = viewport.clientHeight - margin - bottom
    if (!dx && !dy) return
    this.mindmapPan = { x: this.mindmapPan.x + dx, y: this.mindmapPan.y + dy }
    this.applyMindmapTransform()
  }

  /** Expand the ancestors of a source line and select its node. */
  private revealMindmapLine(line: number): boolean {
    const tree = this.mindmapTree
    if (!tree) return false
    const node = mindmapNodeAtLine(tree, line - 1)
    if (!node) return false
    let collapsedChanged = false
    for (const id of mindmapPathIds(tree, line - 1)) {
      if (this.mindmapCollapsed.delete(id)) collapsedChanged = true
    }
    if (collapsedChanged) this.renderMindmapCanvas()
    this.mindmapSelected = node.id
    this.mindmapSyncSelection()
    this.mindmapReveal(node.id)
    return true
  }

  /** Push a new source text and re-render the map without losing the viewport. */
  private applyMindmapSourceChange(
    next: string,
    detail: string,
    options: { line?: number; markdownStart?: number; edit?: boolean } = {},
  ): boolean {
    const previous = this.markdownText || ''
    if (next === previous) return false
    this.pushUndoAction({ type: 'restore-markdown', markdown: previous })
    this.markdownText = next
    this.reviewEdits.push({
      type: 'edit-markdown',
      detail,
      timestamp: new Date().toISOString(),
      markdownStart: options.markdownStart,
    })
    // Also publishes the change to any other window showing this document.
    this.refreshSectionsPreservingMatches(this.sections)
    this.mindmapTree = parseMindmapTree(next, {
      format: this.documentFormat,
      title: this.mindmapDocumentTitle(),
    })
    if (options.line != null) this.mindmapSelected = `line:${options.line}`
    this.ensureMindmapSelection()
    this.renderMindmapCanvas()
    if (this.mindmapSelected) this.mindmapReveal(this.mindmapSelected)
    if (options.edit) this.startMindmapEdit()
    this.renderMarkdownOutline()
    this.updateToolbar()
    return true
  }

  /** Run one structural edit against the current source and tree. */
  private runMindmapEdit(
    produce: (source: string, tree: MindmapTree) => { text: string; line?: number; edit?: boolean } | null,
    detail: string,
  ): boolean {
    const source = this.markdownText
    const tree = this.mindmapTree
    if (source == null || !tree) return false
    const result = produce(source, tree)
    if (!result || result.text === source) {
      this.renderMindmapCanvas()
      return false
    }
    return this.applyMindmapSourceChange(result.text, detail, {
      line: result.line,
      edit: result.edit,
      markdownStart: tree.nodes.find(node => node.id === this.mindmapSelected)?.source?.lineStart,
    })
  }

  private mindmapIsDescendant(ancestorId: string, nodeId: string): boolean {
    const node = this.mindmapNodeById(nodeId)
    for (let cursor = node; cursor; cursor = cursor.parent) {
      if (cursor.id === ancestorId) return true
    }
    return false
  }

  // ── Mind map: pointer interaction ──

  private onMindmapToolbarClick(event: MouseEvent) {
    const button = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-mm]')
    if (!button) return
    const action = button.dataset.mm
    if (action === 'fit') {
      this.fitMindmapToView()
      return
    }
    if (action === 'zoom-in') {
      this.setMindmapZoom(this.mindmapZoom * 1.2)
      return
    }
    if (action === 'zoom-out') {
      this.setMindmapZoom(this.mindmapZoom / 1.2)
      return
    }
    if (!this.mindmapTree) return
    const level = action && /^level-(\d+)$/.exec(action)
    if (level) {
      this.collapseMindmapToLevel(Number(level[1]))
    } else if (action === 'collapse') this.mindmapCollapsed = new Set(mindmapParentIds(this.mindmapTree))
    else if (action === 'expand') this.mindmapCollapsed = new Set()
    else return
    this.renderMindmapCanvas()
  }

  /** 展开到第 N 级：根为第 0 级，深度 ≥ N 且带孩子的节点全部折叠。 */
  private collapseMindmapToLevel(level: number) {
    const tree = this.mindmapTree
    if (!tree) return
    this.mindmapCollapsed = new Set(
      tree.nodes
        .filter(node => node.depth >= level && node.children.length > 0)
        .map(node => node.id),
    )
  }

  private onMindmapPointerDown(event: PointerEvent) {
    if (event.button !== 0) return
    const target = event.target as HTMLElement | null
    if (target?.closest('[data-mm-toggle]')) return
    const nodeElement = target?.closest<HTMLElement>('.mindmap-node') ?? null
    if (!nodeElement?.dataset.id) {
      this.startMindmapPan(event)
      return
    }
    if (this.mindmapEditing && this.mindmapEditing !== nodeElement.dataset.id) this.commitMindmapEdit()
    if (this.mindmapEditing) return
    this.mindmapSelected = nodeElement.dataset.id
    this.mindmapSyncSelection()
    this.mindmapDrag = {
      nodeId: nodeElement.dataset.id,
      startX: event.clientX,
      startY: event.clientY,
      pointerId: event.pointerId,
      targetId: null,
      position: null,
      moved: false,
    }
    nodeElement.setPointerCapture?.(event.pointerId)
  }

  private startMindmapPan(event: PointerEvent) {
    const viewport = this.shadowRoot?.getElementById('mindmapViewport')
    if (!viewport) return
    this.commitMindmapEdit()
    const origin = { x: event.clientX, y: event.clientY, panX: this.mindmapPan.x, panY: this.mindmapPan.y }
    viewport.classList.add('panning')
    viewport.setPointerCapture?.(event.pointerId)
    const move = (moveEvent: PointerEvent) => {
      this.mindmapPan = {
        x: origin.panX + (moveEvent.clientX - origin.x),
        y: origin.panY + (moveEvent.clientY - origin.y),
      }
      this.applyMindmapTransform()
    }
    const finish = () => {
      viewport.classList.remove('panning')
      viewport.removeEventListener('pointermove', move)
      viewport.removeEventListener('pointerup', finish)
      viewport.removeEventListener('pointercancel', finish)
    }
    viewport.addEventListener('pointermove', move)
    viewport.addEventListener('pointerup', finish)
    viewport.addEventListener('pointercancel', finish)
  }

  private onMindmapPointerMove(event: PointerEvent) {
    const drag = this.mindmapDrag
    if (!drag || event.pointerId !== drag.pointerId) return
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return
    drag.moved = true
    const drop = this.mindmapDropAt(event.clientX, event.clientY, drag.nodeId)
    drag.targetId = drop?.id ?? null
    drag.position = drop?.position ?? null
    this.showMindmapDrop(drop)
  }

  private mindmapDropAt(x: number, y: number, draggedId: string): { id: string; position: MindmapDropPosition } | null {
    const shadow = this.shadowRoot
    if (!shadow) return null
    const element = shadow.elementFromPoint(x, y)?.closest<HTMLElement>('.mindmap-node')
    const id = element?.dataset.id
    if (!element || !id || id === draggedId || this.mindmapIsDescendant(draggedId, id)) return null
    const rect = element.getBoundingClientRect()
    const ratio = (y - rect.top) / Math.max(1, rect.height)
    if (ratio < 0.3) return { id, position: 'before' }
    if (ratio > 0.7) return { id, position: 'after' }
    return { id, position: 'child' }
  }

  private showMindmapDrop(drop: { id: string; position: MindmapDropPosition } | null) {
    const shadow = this.shadowRoot
    if (!shadow) return
    shadow.querySelectorAll<HTMLElement>('.mindmap-node').forEach(element => {
      const active = Boolean(drop) && element.dataset.id === drop!.id
      element.classList.toggle('drop-child', active && drop!.position === 'child')
      element.classList.toggle('drop-before', active && drop!.position === 'before')
      element.classList.toggle('drop-after', active && drop!.position === 'after')
    })
  }

  private onMindmapPointerUp(event: PointerEvent) {
    const drag = this.mindmapDrag
    if (!drag || event.pointerId !== drag.pointerId) return
    this.mindmapDrag = null
    this.showMindmapDrop(null)
    if (!drag.moved) return
    const position = drag.position
    const targetId = drag.targetId
    if (!position || !targetId) return
    const node = this.mindmapNodeById(drag.nodeId)
    const target = this.mindmapNodeById(targetId)
    if (!node || !target) return
    this.runMindmapEdit(
      (source, tree) => {
        const text = moveMindmapNode(source, tree, node, target, position)
        return text ? { text, line: node.source?.line } : null
      },
      position === 'child' ? '把思维导图节点拖入其它分支' : '调整思维导图节点顺序',
    )
  }

  private onMindmapClick(event: MouseEvent) {
    const target = event.target as HTMLElement | null
    const toggle = target?.closest<HTMLElement>('[data-mm-toggle]')
    if (toggle?.dataset.mmToggle) {
      this.toggleMindmapNode(toggle.dataset.mmToggle)
      return
    }
    const element = target?.closest<HTMLElement>('.mindmap-node')
    const id = element?.dataset.id
    if (!id) return
    this.mindmapSelected = id
    this.mindmapSyncSelection()
  }

  private onMindmapDoubleClick(event: MouseEvent) {
    const element = (event.target as HTMLElement | null)?.closest<HTMLElement>('.mindmap-node')
    const id = element?.dataset.id
    if (!id) return
    this.mindmapSelected = id
    this.mindmapSyncSelection()
    this.startMindmapEdit()
  }

  private onMindmapWheel(event: WheelEvent) {
    event.preventDefault()
    if (event.ctrlKey || event.metaKey) {
      const viewport = this.shadowRoot?.getElementById('mindmapViewport')
      if (!viewport) return
      const rect = viewport.getBoundingClientRect()
      this.setMindmapZoom(this.mindmapZoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12), {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      })
      return
    }
    this.mindmapPan = {
      x: this.mindmapPan.x - event.deltaX,
      y: this.mindmapPan.y - event.deltaY,
    }
    this.applyMindmapTransform()
  }

  private toggleMindmapNode(id: string) {
    if (this.mindmapCollapsed.has(id)) this.mindmapCollapsed.delete(id)
    else this.mindmapCollapsed.add(id)
    this.mindmapSelected = id
    this.renderMindmapCanvas()
  }

  // ── Mind map: inline editing and keyboard ──

  private startMindmapEdit(id: string | null = this.mindmapSelected) {
    const node = this.mindmapNodeById(id)
    const element = this.mindmapElementFor(id)
    if (!node || !element || !node.source) return
    this.mindmapEditing = node.id
    this.mindmapSelected = node.id
    element.classList.add('editing')
    const textarea = document.createElement('textarea')
    textarea.className = 'mindmap-editor'
    textarea.value = node.label
    textarea.rows = 1
    textarea.spellcheck = false
    textarea.setAttribute('aria-label', '节点标题')
    textarea.addEventListener('keydown', event => {
      event.stopPropagation()
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        this.commitMindmapEdit()
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        this.commitMindmapEdit(false)
        return
      }
      if (event.key === 'Tab') {
        event.preventDefault()
        const outdent = event.shiftKey
        this.commitMindmapEdit()
        this.runMindmapEdit(
          (source, tree) => {
            const target = tree.nodes.find(candidate => candidate.id === node.id)
            if (!target) return null
            const text = shiftMindmapSubtree(source, tree, target, outdent ? -1 : 1)
            return text ? { text, line: target.source?.line ?? undefined } : null
          },
          outdent ? '把思维导图节点升级' : '把思维导图节点降级',
        )
      }
    })
    textarea.addEventListener('blur', () => this.commitMindmapEdit())
    textarea.addEventListener('pointerdown', event => event.stopPropagation())
    const label = element.querySelector('.mindmap-label')
    if (label) label.replaceWith(textarea)
    else element.appendChild(textarea)
    textarea.focus()
    textarea.select()
  }

  private commitMindmapEdit(save = true) {
    if (!this.mindmapEditing) return
    const id = this.mindmapEditing
    this.mindmapEditing = null
    const textarea = this.shadowRoot?.querySelector<HTMLTextAreaElement>('.mindmap-editor')
    const value = textarea?.value ?? ''
    const node = this.mindmapNodeById(id)
    this.shadowRoot?.querySelectorAll('.mindmap-editor').forEach(element => element.remove())
    const source = this.markdownText
    if (!save || !node || source == null || !this.mindmapTree) {
      this.renderMindmapCanvas()
      return
    }
    if (value === node.label) {
      this.renderMindmapCanvas()
      return
    }
    const next = renameMindmapNode(source, this.mindmapTree, node, value)
    if (!next || next === source) {
      this.setStatus('节点标题不能为空，已保留原内容')
      this.renderMindmapCanvas()
      return
    }
    this.applyMindmapSourceChange(next, '重命名思维导图节点', {
      line: node.source?.line,
      markdownStart: node.source?.labelStart,
    })
  }

  private onMindmapKeydown(event: KeyboardEvent) {
    if (this.markdownMode !== 'mindmap' || this.mindmapEditing) return
    if (event.ctrlKey || event.metaKey || event.altKey) return
    const tree = this.mindmapTree
    if (!tree) return
    const node = this.mindmapNodeById(this.mindmapSelected)
    if (!node) return
    const boxes = this.mindmapLayout?.boxes ?? []
    const position = boxes.findIndex(box => box.node.id === node.id)
    const moveSelection = (index: number) => {
      const box = boxes[index]
      if (!box) return
      this.mindmapSelected = box.node.id
      this.mindmapSyncSelection()
      this.mindmapReveal(box.node.id)
    }

    switch (event.key) {
      case 'Enter':
        event.preventDefault()
        this.runMindmapEdit(
          (source, current) => insertMindmapSibling(source, current, node, '新节点'),
          '新增思维导图同级节点',
        )
        return
      case 'Tab':
        event.preventDefault()
        this.runMindmapEdit(
          (source, current) => insertMindmapChild(source, current, node, '新节点'),
          '新增思维导图子节点',
        )
        return
      case 'Delete':
      case 'Backspace':
        event.preventDefault()
        if (node.source && tree.syntheticRoot && node.parent === tree.root && node.parent.children.length === 1) {
          this.setStatus('这是唯一的顶层节点，无法删除')
          return
        }
        if (!node.source) {
          this.setStatus('根节点没有对应的源码行，无法删除')
          return
        }
        this.runMindmapEdit(
          (source, current) => deleteMindmapNode(source, current, node),
          '删除思维导图节点',
        )
        return
      case 'F2':
        event.preventDefault()
        this.startMindmapEdit()
        return
      case 'ArrowDown':
        event.preventDefault()
        moveSelection(position + 1)
        return
      case 'ArrowUp':
        event.preventDefault()
        moveSelection(position - 1)
        return
      case 'ArrowRight':
        event.preventDefault()
        if (node.children.length && this.mindmapCollapsed.has(node.id)) {
          this.toggleMindmapNode(node.id)
          return
        }
        if (node.children.length) {
          this.mindmapSelected = node.children[0].id
          this.mindmapSyncSelection()
          this.mindmapReveal(node.children[0].id)
        }
        return
      case 'ArrowLeft':
        event.preventDefault()
        if (node.children.length && !this.mindmapCollapsed.has(node.id)) {
          this.toggleMindmapNode(node.id)
          return
        }
        if (node.parent) {
          this.mindmapSelected = node.parent.id
          this.mindmapSyncSelection()
          this.mindmapReveal(node.parent.id)
        }
        return
      case ' ':
      case 'Spacebar':
        event.preventDefault()
        if (node.children.length) this.toggleMindmapNode(node.id)
        return
      default:
        return
    }
  }

  private previewLineNumberRoots(): HTMLElement[] {
    const shadow = this.shadowRoot
    if (!shadow) return []
    return Array.from(shadow.querySelectorAll<HTMLElement>('.md-preview:not(.inline-editor-preview)'))
  }

  private ensurePreviewLineNumberObserver() {
    if (this.previewLineNumberObserver) return
    const pane = this.shadowRoot?.getElementById('mdPane')
    if (!pane || typeof ResizeObserver === 'undefined') return
    this.previewLineNumberObserver = new ResizeObserver(() => this.schedulePreviewLineNumbers())
    this.previewLineNumberObserver.observe(pane)
  }

  private schedulePreviewLineNumbers() {
    if (this.previewLineNumberFrame) return
    this.previewLineNumberFrame = requestAnimationFrame(() => {
      this.previewLineNumberFrame = 0
      this.renderPreviewLineNumbers()
    })
  }

  private renderPreviewLineNumbers(target?: HTMLElement) {
    const roots = target ? [target] : this.previewLineNumberRoots()
    if (!target) this.ensurePreviewLineNumberObserver()
    for (const preview of roots) {
      if (preview.classList.contains('inline-editor-preview')) continue
      this.paintPreviewLineNumbers(preview)
    }
  }

  private paintPreviewLineNumbers(preview: HTMLElement) {
    preview.querySelectorAll('.preview-line-gutter').forEach(node => node.remove())
    const mode = this.viewerSettings.lineNumberMode
    preview.classList.toggle('show-line-numbers', mode !== 'off')
    if (mode === 'off') return
    for (const image of preview.querySelectorAll<HTMLImageElement>('img')) {
      if (image.dataset.previewLineBound === '1') continue
      image.dataset.previewLineBound = '1'
      image.addEventListener('load', () => this.schedulePreviewLineNumbers())
    }
    const fragment = document.createDocumentFragment()
    for (const element of preview.querySelectorAll<HTMLElement>('[data-md-start-line]')) {
      const fence = element.tagName === 'PRE'
        || (element.tagName === 'CODE' && element.parentElement?.tagName === 'PRE')
        || element.classList.contains('live-source-active')
      if (fence) {
        // Code fences map visual lines 1:1 to source lines: keep per-line
        // labels. Live preview annotates PRE and CODE alike; whichever owns
        // uncovered lines paints them, the other finds none and skips.
        const lines = this.previewLinesForElement(element)
        if (!lines.length) continue
        const anchor = this.previewLineAnchor(element)
        const gutter = document.createElement('div')
        gutter.className = 'preview-line-gutter'
        gutter.setAttribute('aria-hidden', 'true')
        gutter.contentEditable = 'false'
        const metrics = this.previewAnchorMetrics(anchor, preview)
        gutter.style.top = `${metrics.top}px`
        gutter.style.lineHeight = metrics.lineHeight
        for (const line of lines) {
          gutter.appendChild(this.previewLineLabel(mode, line + 1, line + 1))
        }
        fragment.appendChild(gutter)
        continue
      }
      // Only the outermost annotated block owns a label: nested structure
      // (THEAD/TR, list items, quoted blocks) defers to its ancestor.
      if (element.parentElement?.closest('[data-md-start-line]')) continue
      const start = Number(element.dataset.mdStartLine)
      if (!Number.isFinite(start) || start < 0) continue
      const endRaw = Number(element.dataset.mdEndLine)
      const last = Number.isFinite(endRaw) && endRaw > start ? endRaw : start + 1
      // Every other block carries one label on its first source line, so a
      // 6-line table reads `4`, not `4-9`.
      const anchor = this.previewLineAnchor(element)
      const gutter = document.createElement('div')
      gutter.className = 'preview-line-gutter'
      gutter.setAttribute('aria-hidden', 'true')
      gutter.contentEditable = 'false'
      const metrics = this.previewAnchorMetrics(anchor, preview)
      gutter.style.top = `${metrics.top}px`
      gutter.style.lineHeight = metrics.lineHeight
      gutter.appendChild(this.previewLineLabel(mode, start + 1, last))
      fragment.appendChild(gutter)
    }
    preview.appendChild(fragment)
  }

  private previewLineLabel(mode: LineNumberMode, startLine: number, endLine: number): HTMLSpanElement {
    const label = document.createElement('span')
    label.dataset.sourceLine = String(startLine)
    label.dataset.sourceEndLine = String(endLine)
    label.textContent = formatPreviewBlockLine(mode, startLine, endLine, this.previewCursorLine)
    label.classList.toggle('current', this.previewCursorLine >= startLine && this.previewCursorLine <= endLine)
    return label
  }

  private previewLineAnchor(element: HTMLElement): HTMLElement {
    if (element.classList.contains('live-source-active')) {
      return element.querySelector<HTMLElement>('.live-source-code') || element
    }
    if (element.tagName === 'CODE' && element.parentElement?.tagName === 'PRE') return element.parentElement
    return element
  }

  private previewLinesForElement(element: HTMLElement): number[] {
    const start = Number(element.dataset.mdStartLine)
    if (!Number.isFinite(start) || start < 0) return []
    if (element.classList.contains('live-source-active')) {
      const count = this.liveSourceLineCount(element)
      return Array.from({ length: count }, (_, index) => start + index)
    }
    const end = Number(element.dataset.mdEndLine)
    const nested = Array.from(element.querySelectorAll<HTMLElement>('[data-md-start-line]')).map(child => [
      Number(child.dataset.mdStartLine),
      Number(child.dataset.mdEndLine),
    ] as [number, number])
    const lines = uncoveredSourceLines(start, end, nested)
    if (!lines.length) return lines
    if (element.tagName === 'PRE' || (element.tagName === 'CODE' && element.parentElement?.tagName === 'PRE')) {
      const host = element.tagName === 'PRE' ? element.querySelector('code') || element : element
      const visual = (host.textContent || '').replace(/\n$/, '').split('\n').length
      if (visual > 0 && visual < lines.length) return lines.slice(1, 1 + visual)
    }
    return lines
  }

  private liveSourceLineCount(element: HTMLElement): number {
    const host = element.querySelector<HTMLElement>('.live-source-code')
    if (host instanceof HTMLTextAreaElement) return Math.max(1, host.value.split('\n').length)
    const text = (host?.innerText || '').replace(/\n$/, '')
    return Math.max(1, text.split('\n').length)
  }

  private previewAnchorMetrics(anchor: HTMLElement, preview: HTMLElement): { top: number, lineHeight: string } {
    const anchorRect = anchor.getBoundingClientRect()
    const previewRect = preview.getBoundingClientRect()
    const previewStyle = getComputedStyle(preview)
    const anchorStyle = getComputedStyle(anchor)
    const borderTop = parseFloat(previewStyle.borderTopWidth) || 0
    const anchorOffset = (parseFloat(anchorStyle.borderTopWidth) || 0) + (parseFloat(anchorStyle.paddingTop) || 0)
    const top = anchorRect.top - previewRect.top - borderTop + preview.scrollTop + anchorOffset
    let lineHeight = anchorStyle.lineHeight
    if (!lineHeight || lineHeight === 'normal') {
      const fontSize = parseFloat(anchorStyle.fontSize) || 16
      lineHeight = `${Math.round(fontSize * 1.45)}px`
    }
    return { top, lineHeight }
  }

  private setPreviewCursorLine(line: number) {
    if (!Number.isFinite(line) || line < 1 || this.previewCursorLine === line) return
    this.previewCursorLine = line
    this.updatePreviewLineNumberLabels()
  }

  private updatePreviewLineNumberLabels() {
    const mode = this.viewerSettings.lineNumberMode
    const cursor = this.previewCursorLine
    const labels = this.shadowRoot?.querySelectorAll<HTMLElement>('.preview-line-gutter span') || []
    for (const label of labels) {
      const line = Number(label.dataset.sourceLine)
      const end = Number(label.dataset.sourceEndLine) || line
      label.textContent = formatPreviewBlockLine(mode, line, end, cursor)
      label.classList.toggle('current', cursor >= line && cursor <= end)
    }
  }

  private capturePreviewCursor(eventTarget?: EventTarget | null) {
    const source = eventTarget instanceof Element ? eventTarget : this.shadowRoot?.activeElement || null
    if (!(source instanceof Element)) return
    const block = source.closest<HTMLElement>('[data-md-start-line]')
    if (!block || block.closest('.inline-editor')) return
    const start = Number(block.dataset.mdStartLine)
    if (!Number.isFinite(start)) return
    const host = block.querySelector<HTMLElement>('.live-source-code')
    const active = this.shadowRoot?.activeElement
    if (host instanceof HTMLTextAreaElement && active === host) {
      const before = host.value.slice(0, host.selectionStart).split('\n').length - 1
      this.setPreviewCursorLine(start + 1 + before)
      return
    }
    const selection = document.getSelection()
    if (host && selection?.anchorNode && host.contains(selection.anchorNode)) {
      this.setPreviewCursorLine(start + 1 + this.linesBeforeCaret(host, selection))
      return
    }
    this.setPreviewCursorLine(start + 1)
  }

  private linesBeforeCaret(host: HTMLElement, selection: Selection): number {
    const node = selection.anchorNode
    if (!node || !host.contains(node)) return 0
    const range = document.createRange()
    range.setStart(host, 0)
    try {
      range.setEnd(node, selection.anchorOffset)
    } catch {
      return 0
    }
    return range.cloneContents().querySelectorAll('br').length
  }

  private buildMarkdownPreview() {
    const sequence = ++this.previewBuildSequence
    this.previewBuild = null
    const pane = this.shadowRoot!.getElementById('mdPane')!
    this.sourceEditor?.destroy()
    this.sourceEditor = null
    this.imageObserver?.disconnect()
    if (!this.markdownText?.trim()) {
      pane.innerHTML = `<div class="empty">没有可显示的 ${this.documentFormat === 'org' ? 'Org' : 'Markdown'} 内容</div>`
      return
    }
    const source = this.renderableDocument(this.markdownText)
    const preview = document.createElement('article')
    preview.className = `md-preview ${this.documentFormat}-preview${this.markdownMode === 'live' ? ' live-preview-mode' : ''}`
    // Focusable surface for the `:` command line when no block is focused.
    preview.tabIndex = -1
    const commit = () => {
      if (sequence !== this.previewBuildSequence || this.markdownMode === 'source') return
      const scrollTop = pane.scrollTop
      pane.replaceChildren(preview)
      pane.removeAttribute('aria-busy')
      this.previewRenderer.afterRender(preview)
      this.annotatePreviewBlocks(preview)
      this.insertMarkdownPageMarkers(preview)
      this.decoratePreviewImages(preview)
      if (this.markdownMode === 'live') this.enableLivePreviewEditing(preview)
      preview.addEventListener('click', event => this.onPreviewClick(event))
      preview.addEventListener('dblclick', event => this.onPreviewDoubleClick(event))
      this.applySearchHighlights(preview)
      this.updateModeToolbar()
      preview.addEventListener('keyup', event => this.capturePreviewCursor(event.target))
      preview.addEventListener('mouseup', event => this.capturePreviewCursor(event.target))
      this.renderPreviewLineNumbers(preview)
      pane.scrollTop = scrollTop
    }
    if (source.length < 100_000 || this.documentFormat !== 'markdown' || this.standaloneMarkdown) {
      preview.innerHTML = this.previewRenderer.render(source)
      commit()
      return
    }
    // Build off-DOM so edits/navigation never see half a list or incomplete maps.
    // Keep the old view usable until the replacement is complete.
    pane.setAttribute('aria-busy', 'true')
    if (!pane.firstElementChild) {
      const notice = document.createElement('div')
      notice.className = 'empty'
      notice.textContent = '正在分批构建 Markdown…'
      pane.appendChild(notice)
    }
    const build = async () => {
      for (const html of this.previewRenderer.renderBatches(source)) {
        if (sequence !== this.previewBuildSequence || this.markdownMode === 'source') return
        preview.insertAdjacentHTML('beforeend', html)
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
      commit()
    }
    const pending = build().catch(error => {
      if (sequence === this.previewBuildSequence) {
        pane.removeAttribute('aria-busy')
        this.setStatus(`Markdown 构建失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }).finally(() => {
      if (this.previewBuild === pending) this.previewBuild = null
    })
    this.previewBuild = pending
  }

  private async waitForPreview() {
    while (this.previewBuild) await this.previewBuild
  }

  private insertMarkdownPageMarkers(preview: HTMLElement) {
    if (!this.blocks.length || !this.sections.length) return
    const markers = pageMarkersAfterSections(this.sections.map(section => section.page || 0))
    const anchors = Array.from(preview.querySelectorAll<HTMLElement>('[data-md-start-line]')).map(element => {
      const startLine = Number(element.dataset.mdStartLine)
      const endLine = Number(element.dataset.mdEndLine)
      const [start, end] = this.sourceRangeForLines(startLine, endLine)
      return { element, start, end, span: endLine - startLine }
    }).filter(anchor => Number.isFinite(anchor.span) && anchor.span > 0)
    for (let index = markers.length - 1; index >= 0; index -= 1) {
      const marker = markers[index]
      const section = this.sections[marker.afterIndex]
      let best: typeof anchors[number] | undefined
      for (const candidate of anchors) {
        if (section && section.start >= candidate.start && section.start < candidate.end
          && (!best || candidate.span < best.span)) best = candidate
      }
      const anchor = best?.element
      if (!anchor) continue
      const parent = anchor.parentElement
      const label = document.createElement(parent && (parent.tagName === 'UL' || parent.tagName === 'OL') ? 'li' : 'div')
      label.className = 'md-page-marker'
      label.contentEditable = 'false'
      label.textContent = `第 ${marker.page} 页`
      label.title = `定位到 PDF 第 ${marker.page} 页`
      label.addEventListener('click', event => {
        event.preventDefault()
        event.stopPropagation()
        this.goToPdfPage(marker.page)
      })
      anchor.after(label)
    }
  }

  /** Tightest rendered block that contains this Markdown section, so a page break inside a list stays between items. */
  private previewAnchorForSection(preview: HTMLElement, sectionIndex: number): HTMLElement | null {
    const section = this.sections[sectionIndex]
    if (!section) return null
    let best: HTMLElement | null = null
    let bestSpan = Infinity
    for (const element of preview.querySelectorAll<HTMLElement>('[data-md-start-line]')) {
      const startLine = Number(element.dataset.mdStartLine)
      const endLine = Number(element.dataset.mdEndLine)
      if (!Number.isFinite(startLine) || !Number.isFinite(endLine) || endLine <= startLine) continue
      const [start, end] = this.sourceRangeForLines(startLine, endLine)
      if (section.start < start || section.start >= end) continue
      const span = endLine - startLine
      if (span < bestSpan) {
        best = element
        bestSpan = span
      }
    }
    return best
  }

  private annotatePreviewBlocks(preview: HTMLElement) {
    // Raw HTML tables and $$ display math carry no token-map attributes;
    // derive their ranges from a fence-aware scan. Pipe/Org tables trust the
    // markdown-it maps already on the elements.
    const { tables: tableRanges, displayMath: displayMathRanges } = scanUnmappedSourceRanges(this.markdownText || '')
    const displayMath = Array.from(preview.querySelectorAll<HTMLElement>(':scope > section'))
      .filter(element => element.querySelector('eqn') && !element.hasAttribute('data-md-start-line'))
    displayMath.forEach((element, index) => {
      const range = displayMathRanges[index]
      if (!range) return
      element.dataset.mdStartLine = String(range[0])
      element.dataset.mdEndLine = String(range[1])
    })
    Array.from(preview.querySelectorAll<HTMLElement>('table'))
      .filter(element => !element.hasAttribute('data-md-start-line'))
      .forEach((element, index) => {
        const range = tableRanges[index]
        if (!range) return
        element.dataset.mdStartLine = String(range[0])
        element.dataset.mdEndLine = String(range[1])
      })
    for (const element of preview.querySelectorAll<HTMLElement>('[data-md-start-line]')) {
      const startLine = Number(element.dataset.mdStartLine)
      const endLine = Number(element.dataset.mdEndLine)
      const [start, end] = this.sourceRangeForLines(startLine, endLine)
      const sectionIndex = this.sections.findIndex(section => section.start >= start && section.start < end)
      if (sectionIndex >= 0) element.dataset.idx = String(sectionIndex)
      element.title = this.markdownMode === 'live'
        ? '直接单击文字并输入；内容会自动同步到源文件。Ctrl+单击定位 PDF'
        : '单击定位 PDF；双击在原位置编辑'
      element.tabIndex = 0
    }
  }

  private onPreviewClick(event: MouseEvent) {
    const target = event.target as HTMLElement
    this.capturePreviewCursor(target)
    if (target.closest('button,input,textarea')) return
    const block = target.closest<HTMLElement>('[data-md-start-line]')
    if (!block) return
    if (this.markdownMode === 'live' && !event.ctrlKey && !event.metaKey) {
      if (target.closest('a')) event.preventDefault()
      const editable = target.closest<HTMLElement>('.live-editable')
      if (editable) {
        const cell = target.closest<HTMLElement>('th,td')
        if (editable.tagName === 'TABLE' && cell) {
          this.beginLiveTableCellEdit(editable, cell)
          return
        }
        this.beginLiveEdit(editable)
        editable.focus()
      }
      return
    }
    const sectionIndex = Number(block.dataset.idx)
    const section = this.sections[sectionIndex]
    if (section) this.onMdClick(section, sectionIndex, block)
  }

  private onPreviewDoubleClick(event: MouseEvent) {
    if (this.markdownMode === 'live') return
    const target = event.target as HTMLElement
    if (target.closest('button,a,input,textarea')) return
    // Markdown-it also annotates table rows. Always edit the whole table so
    // replacing the rendered block remains valid HTML and covers every row.
    const block = target.closest<HTMLElement>('table[data-md-start-line]')
      || target.closest<HTMLElement>('[data-md-start-line]')
    if (!block) return
    event.preventDefault()
    event.stopPropagation()
    this.openInlineBlockEditor(block, target.closest('img.md-asset') ? { imageBlock: true } : undefined)
  }

  /** Make rendered blocks themselves editable; no textarea or save dialog is involved. */
  private enableLivePreviewEditing(preview: HTMLElement) {
    const editableTags = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'BLOCKQUOTE', 'PRE', 'UL', 'OL', 'TABLE', 'SECTION', 'DIV', 'DL'])
    const candidates = Array.from(preview.children) as HTMLElement[]
    for (const table of preview.querySelectorAll<HTMLElement>('table[data-md-start-line]')) {
      if (!candidates.includes(table)) candidates.push(table)
    }
    for (const block of preview.querySelectorAll<HTMLElement>('div[data-md-start-line], dl[data-md-start-line]')) {
      if (!candidates.includes(block)) candidates.push(block)
    }
    for (const element of candidates) {
      if (!editableTags.has(element.tagName)) continue
      // A drawer or property list wraps other annotated blocks. Editing the
      // wrapper would replace those blocks with a single source line.
      if ((element.tagName === 'DIV' || element.tagName === 'DL') && element.querySelector('[data-md-start-line]')) continue
      // A nested table owns its complete source range. Do not let an outer
      // Org section become a competing editable region for the same click.
      if (element.tagName === 'SECTION' && element.querySelector('table[data-md-start-line]')) continue
      if (!element.hasAttribute('data-md-start-line')) {
        const annotatedChild = element.querySelector<HTMLElement>('[data-md-start-line]')
        if (annotatedChild) {
          element.dataset.mdStartLine = annotatedChild.dataset.mdStartLine
          element.dataset.mdEndLine = annotatedChild.dataset.mdEndLine
          if (annotatedChild.dataset.idx) element.dataset.idx = annotatedChild.dataset.idx
          element.title = annotatedChild.title
        }
      }
      if (!element.hasAttribute('data-md-start-line')) continue
      element.classList.add('live-editable')
      element.contentEditable = element.tagName === 'TABLE' ? 'false' : 'true'
      element.spellcheck = true
      element.setAttribute('role', 'textbox')
      element.setAttribute('aria-multiline', 'true')
    }
    for (const actions of preview.querySelectorAll<HTMLElement>('.preview-image-actions')) actions.contentEditable = 'false'

    preview.addEventListener('focusin', event => {
      const element = (event.target as Element).closest<HTMLElement>('.live-editable')
      // A table receives focus before the cell click is dispatched. Starting
      // whole-table editing here would erase the clicked cell before the
      // cell-level click handler can identify it.
      if (element && element.tagName !== 'TABLE') this.beginLiveEdit(element)
    })
    preview.addEventListener('input', event => {
      const element = (event.target as Element).closest<HTMLElement>('.live-editable')
      if (element) this.syncLiveEdit(element)
      this.capturePreviewCursor(event.target)
      this.schedulePreviewLineNumbers()
    })
    preview.addEventListener('focusout', event => {
      // showLiveSource swaps the block's innerHTML while the just-focused node
      // (e.g. a list item) is still inside it. Chrome then dispatches a
      // synchronous focusout for the removed node; that is our own DOM
      // replacement, not the user leaving the block.
      if (this.liveDomMutationGuard) return
      if (!(event.target as Element).isConnected) return
      const element = (event.target as Element).closest<HTMLElement>('.live-editable')
      const next = event.relatedTarget as Node | null
      if (element && (!next || !element.contains(next))) this.finishLiveEdit()
    })
    preview.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        ;(event.target as HTMLElement).blur()
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        this.syncLiveEdit((event.target as Element).closest<HTMLElement>('.live-editable')!)
        this.finishLiveEdit()
        void this.saveMarkdownToFolder()
      }
    })
  }

  private beginLiveEdit(element: HTMLElement) {
    if (this.markdownText == null || this.liveEditSession?.element === element) return
    if (this.liveEditSession) this.finishLiveEdit(false)
    const startLine = Number(element.dataset.mdStartLine)
    const endLine = Number(element.dataset.mdEndLine)
    const [start, end] = this.sourceRangeForLines(startLine, endLine)
    this.liveEditSession = {
      element,
      start,
      end,
      originalEnd: end,
      originalDocument: this.markdownText,
      originalSections: this.sections,
      changed: false,
      kind: 'block',
    }
    const source = this.markdownText.slice(start, end).replace(/\r?\n$/, '')
    this.showLiveSource(element, source)
  }

  private beginLiveTableCellEdit(table: HTMLElement, cell: HTMLElement) {
    if (this.markdownText == null) return
    const range = this.sourceRangeForTableCell(table, cell)
    if (!range) {
      // Unknown table syntax keeps the previous whole-table editor as a safe fallback.
      this.beginLiveEdit(table)
      return
    }
    if (this.liveEditSession) this.finishLiveEdit(false)
    const [start, end] = range
    const source = this.markdownText.slice(start, end)
    const original = cell.innerHTML
    const textarea = document.createElement('textarea')
    textarea.className = 'live-source-code live-table-cell-source'
    textarea.setAttribute('aria-label', '单元格内容')
    textarea.spellcheck = false
    textarea.value = source
    cell.replaceChildren(textarea)
    this.liveEditSession = {
      element: cell,
      start,
      end,
      originalEnd: end,
      originalDocument: this.markdownText,
      originalSections: this.sections,
      changed: false,
      kind: 'table-cell',
    }
    for (const eventName of ['click', 'dblclick', 'focusin', 'input', 'focusout']) {
      textarea.addEventListener(eventName, event => event.stopPropagation())
    }
    textarea.addEventListener('input', () => this.syncLiveEdit(cell))
    textarea.addEventListener('blur', () => this.finishLiveEdit())
    textarea.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        cell.innerHTML = original
        this.markdownText = this.liveEditSession?.originalDocument || this.markdownText
        this.sections = this.liveEditSession?.originalSections || this.sections
        this.liveEditSession = null
        this.rebuildMarkdownView()
      }
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        this.syncLiveEdit(cell)
        textarea.blur()
      }
    })
    queueMicrotask(() => {
      textarea.focus()
      textarea.select()
    })
  }

  private sourceRangeForTableCell(table: HTMLElement, cell: HTMLElement): [number, number] | null {
    if (this.markdownText == null) return null
    const startLine = Number(table.dataset.mdStartLine)
    const endLine = Number(table.dataset.mdEndLine)
    if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) return null
    const [tableStart, tableEnd] = this.sourceRangeForLines(startLine, endLine)
    const source = this.markdownText.slice(tableStart, tableEnd).replace(/\r?\n$/, '')
    const cells = Array.from(table.querySelectorAll<HTMLElement>('th,td'))
      .filter(candidate => candidate.closest('table') === table)
    const cellIndex = cells.indexOf(cell)
    if (cellIndex < 0) return null

    if (/<table\b/i.test(source)) {
      const openings = Array.from(source.matchAll(/<(td|th)\b[^>]*>/gi))
      const opening = openings[cellIndex]
      if (!opening || opening.index == null) return null
      const contentStart = opening.index + opening[0].length
      const closing = new RegExp(`<\\/${opening[1]}\\s*>`, 'i').exec(source.slice(contentStart))
      if (!closing || closing.index == null) return null
      return [tableStart + contentStart, tableStart + contentStart + closing.index]
    }

    const rows = Array.from(table.querySelectorAll<HTMLElement>('tr'))
      .filter(row => row.closest('table') === table)
    const row = cell.closest<HTMLElement>('tr')
    const rowIndex = row ? rows.indexOf(row) : -1
    if (rowIndex < 0) return null
    const sourceLines = source.split('\n')
    const contentLines = sourceLines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /^\s*\|.*\|\s*$/.test(line) && !/^\s*\|[-+:|\s]+\|\s*$/.test(line))
    const sourceRow = contentLines[rowIndex]
    if (!sourceRow) return null
    const rowCells = Array.from(row!.querySelectorAll<HTMLElement>('th,td'))
      .filter(candidate => candidate.closest('tr') === row)
    const columnIndex = rowCells.indexOf(cell)
    const pipes: number[] = []
    for (let index = 0; index < sourceRow.line.length; index++) {
      if (sourceRow.line[index] === '|' && (index === 0 || sourceRow.line[index - 1] !== '\\')) pipes.push(index)
    }
    if (columnIndex < 0 || pipes.length <= columnIndex + 1) return null
    let contentStart = pipes[columnIndex] + 1
    let contentEnd = pipes[columnIndex + 1]
    while (contentStart < contentEnd && /\s/.test(sourceRow.line[contentStart])) contentStart++
    while (contentEnd > contentStart && /\s/.test(sourceRow.line[contentEnd - 1])) contentEnd--
    const precedingLength = sourceLines.slice(0, sourceRow.index).reduce((total, line) => total + line.length + 1, 0)
    return [tableStart + precedingLength + contentStart, tableStart + precedingLength + contentEnd]
  }

  private syncLiveEdit(element: HTMLElement) {
    if (this.markdownText == null) return
    if (this.liveEditSession?.element !== element) this.beginLiveEdit(element)
    const session = this.liveEditSession
    if (!session) return
    const currentSource = this.markdownText.slice(session.start, session.end)
    const lineEnding = currentSource.match(/\r?\n$/)?.[0] || ''
    const sourceHost = element.querySelector<HTMLElement>('.live-source-code')
    const editedSource = sourceHost
      ? ((sourceHost instanceof HTMLTextAreaElement ? sourceHost.value : sourceHost.innerText || sourceHost.textContent || '')).replace(/\r\n?/g, '\n')
      : this.blockElementToSource(element)
    const replacement = editedSource.replace(/\s+$/, '') + lineEnding
    this.markdownText = this.markdownText.slice(0, session.start) + replacement + this.markdownText.slice(session.end)
    session.end = session.start + replacement.length
    session.changed = this.markdownText !== session.originalDocument
    const status = this.shadowRoot?.getElementById('sourceStatus')
    if (status) status.textContent = session.changed ? '实时同步中' : ''
  }

  private finishLiveEdit(rebuild = true) {
    const session = this.liveEditSession
    if (!session) return
    this.liveEditSession = null
    if (session.changed && this.markdownText != null) {
      this.pushUndoAction({ type: 'restore-markdown', markdown: session.originalDocument })
      this.reviewEdits.push({
        type: 'edit-markdown',
        detail: `${this.documentFormat === 'org' ? 'Org' : 'Markdown'} live visual edit`,
        timestamp: new Date().toISOString(),
        markdownStart: session.start,
      })
      this.refreshSectionsPreservingMatches(session.originalSections)
      this.renderMarkdownOutline()
      this.updateToolbar()
      if (this.shadowRoot?.getElementById('findBar')?.classList.contains('open')) this.updateSearchResults()
    }
    const status = this.shadowRoot?.getElementById('sourceStatus')
    if (status) status.textContent = ''
    if (rebuild && this.markdownMode === 'live') this.rebuildMarkdownView()
  }

  private showLiveSource(element: HTMLElement, source: string) {
    const highlighted = this.highlightLiveSource(source)
    element.classList.add('live-source-active')
    // Replacing the children of the block removes the node that received focus
    // on mousedown (list items are focusable for keyboard navigation). Chrome
    // fires a synchronous focusout for the removed node right here; the guard
    // keeps that artifact from ending the edit session it just started.
    this.liveDomMutationGuard = true
    try {
      if (element.tagName === 'TABLE') {
        element.contentEditable = 'false'
        element.innerHTML = '<tbody><tr><td><textarea class="live-source-code live-table-source" spellcheck="false" aria-label="表格源码"></textarea></td></tr></tbody>'
        const textarea = element.querySelector<HTMLTextAreaElement>('.live-table-source')!
        textarea.value = source
        textarea.rows = Math.max(3, source.split('\n').length)
      } else if (element.tagName === 'UL' || element.tagName === 'OL') {
        element.innerHTML = `<li><span class="live-source-code">${highlighted}</span></li>`
      } else if (element.tagName === 'PRE') {
        element.innerHTML = `<code class="live-source-code">${highlighted}</code>`
      } else {
        element.innerHTML = `<span class="live-source-code">${highlighted}</span>`
      }
    } finally {
      this.liveDomMutationGuard = false
    }
    const host = element.querySelector<HTMLElement>('.live-source-code')
    this.renderPreviewLineNumbers()
    if (!host) return
    queueMicrotask(() => {
      if (host instanceof HTMLTextAreaElement) {
        host.focus()
        host.setSelectionRange(host.value.length, host.value.length)
        this.capturePreviewCursor(host)
        return
      }
      const selection = document.getSelection()
      if (!selection || !host.isConnected) return
      const range = document.createRange()
      range.selectNodeContents(host)
      range.collapse(false)
      selection.removeAllRanges()
      selection.addRange(range)
      this.capturePreviewCursor(host)
    })
  }

  private highlightLiveSource(source: string): string {
    const escape = (value: string) => this.escapeHtml(value)
    const marker = (value: string) => `<span class="live-syntax-marker">${escape(value)}</span>`
    const prefixPattern = this.documentFormat === 'org'
      ? /^(\*+\s+|#\+[A-Z_]+(?::|\s+)|[-+]\s+|\d+[.)]\s+)/i
      : /^(#{1,6}\s+|[-+*]\s+|\d+[.)]\s+|>\s+)/
    const tokenPattern = this.documentFormat === 'org'
      ? /(\[\[[^\]]+\](?:\[[^\]]*\])?\]|\*[^*\n]+\*|\/[^/\n]+\/|\+[^+\n]+\+|~[^~\n]+~|=[^=\n]+=|_[^_\n]+_|\$[^$\n]+\$)/g
      : /(!\[[^\]]*\]\([^\n)]*\)|\[[^\]]+\]\([^\n)]*\)|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|`[^`\n]+`|\*[^*\n]+\*|_[^_\n]+_|\$[^$\n]+\$)/g
    const highlightLine = (line: string) => {
      const prefix = line.match(prefixPattern)
      const head = prefix ? marker(prefix[1]) : ''
      const body = prefix ? line.slice(prefix[1].length) : line
      tokenPattern.lastIndex = 0
      let output = ''
      let cursor = 0
      let match: RegExpExecArray | null
      while ((match = tokenPattern.exec(body))) {
        output += escape(body.slice(cursor, match.index))
        const token = match[0]
        if (token.startsWith('$') && token.endsWith('$')) {
          output += marker('$') + `<span class="live-syntax-math">${escape(token.slice(1, -1))}</span>` + marker('$')
        } else if (this.documentFormat === 'markdown' && (token.startsWith('**') || token.startsWith('__'))) {
          output += marker(token.slice(0, 2)) + `<strong class="live-syntax-strong">${escape(token.slice(2, -2))}</strong>` + marker(token.slice(-2))
        } else if (this.documentFormat === 'org' && token.startsWith('*')) {
          output += marker('*') + `<strong class="live-syntax-strong">${escape(token.slice(1, -1))}</strong>` + marker('*')
        } else if (this.documentFormat === 'org' && token.startsWith('_')) {
          output += marker('_') + `<u>${escape(token.slice(1, -1))}</u>` + marker('_')
        } else if ((this.documentFormat === 'markdown' && (token.startsWith('*') || token.startsWith('_')))
          || (this.documentFormat === 'org' && token.startsWith('/'))) {
          output += marker(token[0]) + `<em class="live-syntax-em">${escape(token.slice(1, -1))}</em>` + marker(token.slice(-1))
        } else if (token.startsWith('~~')) {
          output += marker('~~') + `<s class="live-syntax-strike">${escape(token.slice(2, -2))}</s>` + marker('~~')
        } else if (this.documentFormat === 'org' && token.startsWith('+')) {
          output += marker('+') + `<s class="live-syntax-strike">${escape(token.slice(1, -1))}</s>` + marker('+')
        } else if (token.startsWith('`') || token.startsWith('~') || (this.documentFormat === 'org' && token.startsWith('='))) {
          output += marker(token[0]) + `<code class="live-syntax-code">${escape(token.slice(1, -1))}</code>` + marker(token.slice(-1))
        } else {
          output += `<span class="live-syntax-link">${escape(token)}</span>`
        }
        cursor = match.index + token.length
      }
      return head + output + escape(body.slice(cursor))
    }
    const displayMath = /\$\$[\s\S]*?\$\$/g
    let result = ''
    let cursor = 0
    let match: RegExpExecArray | null
    while ((match = displayMath.exec(source))) {
      result += source.slice(cursor, match.index).split('\n').map(highlightLine).join('<br>')
      result += marker('$$') + `<span class="live-syntax-math">${escape(match[0].slice(2, -2))}</span>` + marker('$$')
      cursor = match.index + match[0].length
    }
    return result + source.slice(cursor).split('\n').map(highlightLine).join('<br>')
  }

  private blockElementToSource(element: HTMLElement): string {
    const originalBlock = this.liveEditSession
      ? this.liveEditSession.originalDocument.slice(this.liveEditSession.start, this.liveEditSession.originalEnd).trimEnd()
      : ''
    const level = /^H([1-6])$/.exec(element.tagName)?.[1]
    if (level) {
      const orgKeyword = this.documentFormat === 'org' ? originalBlock.match(/^\s*#\+(TITLE|SUBTITLE):/i)?.[1] : null
      if (orgKeyword) return `#+${orgKeyword.toUpperCase()}: ${this.inlineDomToSource(element)}`
      const marker = this.documentFormat === 'org' ? '*'.repeat(Number(level)) : '#'.repeat(Number(level))
      return `${marker} ${this.inlineDomToSource(element)}`
    }
    if (element.tagName === 'PRE') {
      const code = element.querySelector('code')
      const originalLanguage = originalBlock.match(/^\s*#\+BEGIN_SRC\s+([^\s]+)/i)?.[1]
        || originalBlock.match(/^\s*```([^\s]*)/)?.[1]
      const language = Array.from(code?.classList || []).find(name => name.startsWith('language-'))?.slice(9)
        || originalLanguage || ''
      const body = code?.textContent?.replace(/\n$/, '') || element.textContent?.replace(/\n$/, '') || ''
      return this.documentFormat === 'org'
        ? `#+BEGIN_SRC${language ? ` ${language}` : ''}\n${body}\n#+END_SRC`
        : `\`\`\`${language}\n${body}\n\`\`\``
    }
    if (element.tagName === 'BLOCKQUOTE') {
      const body = this.inlineDomToSource(element).split('\n').map(line => line.trim()).filter(Boolean)
      const orgKeyword = this.documentFormat === 'org' ? originalBlock.match(/^\s*#\+(AUTHOR|DATE|EMAIL):/i)?.[1] : null
      if (orgKeyword) {
        const value = body.join(' ').replace(/^(?:\*|__)?(?:Author|Date|Email)：(?:\*|__)?\s*/i, '')
        return `#+${orgKeyword.toUpperCase()}: ${value}`
      }
      return this.documentFormat === 'org'
        ? `#+BEGIN_QUOTE\n${body.join('\n')}\n#+END_QUOTE`
        : body.map(line => `> ${line}`).join('\n')
    }
    if (element.tagName === 'UL' || element.tagName === 'OL') return this.listDomToSource(element)
    if (element.tagName === 'TABLE') return this.tableDomToSource(element)
    return this.inlineDomToSource(element)
  }

  private inlineDomToSource(root: Node): string {
    const walk = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent || ''
      if (!(node instanceof HTMLElement)) return ''
      if (node.classList.contains('preview-image-actions')
        || node.classList.contains('preview-line-gutter')
        || node.classList.contains('heading-level-badge')
        || node.classList.contains('gtd-status')
        || node.classList.contains('gtd-priority')
        || node.classList.contains('gtd-tags')) return ''
      // Live-edit markers already contribute source characters; avoid wrapping twice.
      if (node.classList.contains('live-syntax-marker')) return node.textContent || ''
      const content = Array.from(node.childNodes).map(walk).join('')
      const org = this.documentFormat === 'org'
      if (node.tagName === 'BR') return '\n'
      if (node.tagName === 'DIV' || node.tagName === 'P') return `${content}${node === root ? '' : '\n'}`
      if (node.classList.contains('live-syntax-strong')
        || node.classList.contains('live-syntax-em')
        || node.classList.contains('live-syntax-strike')
        || node.classList.contains('live-syntax-code')) {
        return content
      }
      if (node.tagName === 'STRONG' || node.tagName === 'B') return org ? `*${content}*` : `**${content}**`
      if (node.tagName === 'EM' || node.tagName === 'I') return org ? `/${content}/` : `*${content}*`
      if (node.tagName === 'S' || node.tagName === 'DEL' || node.tagName === 'STRIKE') return org ? `+${content}+` : `~~${content}~~`
      if (node.tagName === 'U') return org ? `_${content}_` : `<u>${content}</u>`
      if (node.tagName === 'CODE' && node.parentElement?.tagName !== 'PRE') return org ? `~${content}~` : `\`${content}\``
      if (node.tagName === 'A') {
        const href = node.getAttribute('href') || ''
        return org ? `[[${href}][${content || href}]]` : `[${content || href}](${href})`
      }
      if (node.tagName === 'IMG') {
        const image = node as HTMLImageElement
        const path = image.dataset.assetPath || image.getAttribute('src') || ''
        const alt = image.alt || ''
        return org ? `[[file:${path}]${alt ? `[${alt}]` : ''}]` : `![${alt}](${path})`
      }
      return content
    }
    return walk(root).replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  }

  private listDomToSource(list: HTMLElement, depth = 0): string {
    const ordered = list.tagName === 'OL'
    const items = Array.from(list.children).filter(child => child.tagName === 'LI') as HTMLElement[]
    const lines: string[] = []
    items.forEach((item, index) => {
      const clone = item.cloneNode(true) as HTMLElement
      clone.querySelectorAll('ul,ol,.preview-image-actions').forEach(child => child.remove())
      const checkbox = item.querySelector<HTMLInputElement>('input[type="checkbox"]')
      clone.querySelectorAll('input[type="checkbox"]').forEach(child => child.remove())
      const prefix = ordered ? `${index + 1}.` : '-'
      const task = checkbox ? `[${checkbox.checked ? 'x' : ' '}] ` : ''
      lines.push(`${'  '.repeat(depth)}${prefix} ${task}${this.inlineDomToSource(clone)}`.trimEnd())
      for (const nested of Array.from(item.children).filter(child => child.tagName === 'UL' || child.tagName === 'OL') as HTMLElement[]) {
        lines.push(this.listDomToSource(nested, depth + 1))
      }
    })
    return lines.join('\n')
  }

  private tableDomToSource(table: HTMLElement): string {
    const rows = Array.from(table.querySelectorAll('tr')).map(row =>
      Array.from(row.querySelectorAll('th,td')).map(cell => this.inlineDomToSource(cell).replace(/\|/g, '\\|')))
    if (!rows.length) return ''
    const output = [`| ${rows[0].join(' | ')} |`]
    output.push(this.documentFormat === 'org'
      ? `|${rows[0].map(() => '---').join('+')}|`
      : `| ${rows[0].map(() => '---').join(' | ')} |`)
    for (const row of rows.slice(1)) output.push(`| ${row.join(' | ')} |`)
    return output.join('\n')
  }

  private openInlineBlockEditor(block: HTMLElement, options?: { imageBlock?: boolean }) {
    if (this.markdownText == null) return
    const startLine = Number(block.dataset.mdStartLine)
    const endLine = Number(block.dataset.mdEndLine)
    const [start, end] = this.sourceRangeForLines(startLine, endLine)
    const original = this.markdownText.slice(start, end)
    const lineEnding = original.match(/\r?\n$/)?.[0] || ''
    // Double-clicking an image opens the very source line that produced it, so
    // the link code stays visible and editable instead of starting blank.
    const imageBlock = options?.imageBlock === true
    const initialValue = lineEnding ? original.slice(0, -lineEnding.length) : original
    const editor = document.createElement('div')
    editor.className = 'inline-editor'
    const tools = document.createElement('div')
    tools.className = 'inline-editor-tools'
    const textarea = document.createElement('textarea')
    textarea.value = initialValue
    if (imageBlock) textarea.title = '这是图片的链接代码，可直接修改路径；整段替换为普通文字即为“图片改为文字”。'
    const preview = document.createElement('div')
    preview.className = 'inline-editor-preview md-preview'
    preview.hidden = true
    const previewMode = document.createElement('button')
    previewMode.textContent = '预览'
    const codeMode = document.createElement('button')
    codeMode.textContent = 'code'
    codeMode.className = 'active'
    const setMode = (mode: 'preview' | 'code') => {
      textarea.hidden = mode === 'preview'
      preview.hidden = mode === 'code'
      previewMode.classList.toggle('active', mode === 'preview')
      codeMode.classList.toggle('active', mode === 'code')
      if (mode === 'preview') void this.renderInlinePreview(preview, textarea.value)
      else textarea.focus()
    }
    previewMode.addEventListener('click', () => setMode('preview'))
    codeMode.addEventListener('click', () => setMode('code'))
    tools.append(previewMode, codeMode)

    const localUndo = document.createElement('button')
    localUndo.textContent = '↶'
    localUndo.title = '撤销输入'
    localUndo.addEventListener('click', () => { textarea.focus(); document.execCommand('undo') })
    const localRedo = document.createElement('button')
    localRedo.textContent = '↷'
    localRedo.title = '重做输入'
    localRedo.addEventListener('click', () => { textarea.focus(); document.execCommand('redo') })
    tools.append(localUndo, localRedo)

    const heading = document.createElement('select')
    const currentHeading = initialValue.match(this.documentFormat === 'org' ? /^(\*{1,6})\s+/ : /^(#{1,6})\s+/)?.[1].length || 0
    ;['正文', '一级标题', '二级标题', '三级标题', '四级标题', '五级标题', '六级标题']
      .forEach((label, level) => {
        const option = document.createElement('option')
        option.value = String(level)
        option.textContent = label
        option.selected = level === currentHeading
        heading.appendChild(option)
      })
    heading.addEventListener('change', () => this.applyHeadingLevel(textarea, Number(heading.value)))
    tools.appendChild(heading)

    const definitions: Array<[string, string, string, string]> = this.documentFormat === 'org'
      ? [
          ['<strong>B</strong>', '*', '*', '加粗'],
          ['<em>I</em>', '/', '/', '斜体'],
          ['<s>S</s>', '+', '+', '删除线'],
          ['引用', '#+BEGIN_QUOTE\n', '\n#+END_QUOTE', '引用'],
          ['链接', '[[https://][', ']]', '链接'],
        ]
      : [
          ['<strong>B</strong>', '**', '**', '加粗'],
          ['<em>I</em>', '*', '*', '斜体'],
          ['<s>S</s>', '~~', '~~', '删除线'],
          ['引用', '> ', '', '引用'],
          ['链接', '[', '](https://)', '链接'],
        ]
    for (const [label, prefix, suffix, title] of definitions) {
      const button = document.createElement('button')
      button.innerHTML = label
      button.title = title
      button.addEventListener('click', () => this.wrapEditorSelection(textarea, prefix, suffix))
      tools.appendChild(button)
    }
    const table = document.createElement('button')
    table.textContent = '表格'
    table.addEventListener('click', () => this.insertEditorSnippet(textarea, this.documentFormat === 'org'
      ? '| 列 1 | 列 2 |\n|------+------|\n| 内容 | 内容 |'
      : '| 列 1 | 列 2 |\n| --- | --- |\n| 内容 | 内容 |'))
    const code = document.createElement('button')
    code.textContent = '</>'
    code.title = '代码块'
    code.addEventListener('click', () => {
      const selected = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd) || '代码'
      this.wrapEditorSelection(textarea,
        this.documentFormat === 'org' ? '#+BEGIN_SRC\n' : '```\n',
        this.documentFormat === 'org' ? '\n#+END_SRC' : '\n```')
      if (!textarea.value.includes(selected)) textarea.setRangeText(selected)
    })
    tools.append(table, code)
    const spacer = document.createElement('span')
    spacer.className = 'spacer'
    const save = document.createElement('button')
    save.textContent = '保存'
    const cancel = document.createElement('button')
    cancel.textContent = '取消'
    tools.append(spacer, save, cancel)
    editor.append(tools, textarea, preview)
    block.replaceWith(editor)
    cancel.addEventListener('click', () => editor.replaceWith(block))
    save.addEventListener('click', () => {
      const value = textarea.value
      if (imageBlock && !value.trim()) {
        alert('请输入替代文字或图片链接；如果只想删除图片，请使用删除按钮。')
        return
      }
      if (imageBlock && value === initialValue) {
        editor.replaceWith(block)
        return
      }
      const keepsImage = this.documentFormat === 'org'
        ? /\[\[file:[^\]]+\]/.test(value)
        : /!\[[^\]]*\]\([^)]*\)/.test(value)
      this.replaceMarkdownRange(start, end, value + lineEnding, {
        type: imageBlock && !keepsImage ? 'image-to-text' : 'edit-markdown',
        detail: `inline ${this.documentFormat === 'org' ? 'Org' : 'Markdown'} block edit`,
        timestamp: new Date().toISOString(),
      })
    })
    textarea.addEventListener('keydown', event => {
      if (event.key === 'Escape') editor.replaceWith(block)
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') save.click()
    })
    textarea.addEventListener('input', () => {
      if (!preview.hidden) void this.renderInlinePreview(preview, textarea.value)
    })
    textarea.focus()
    // Keep the link code readable; place the caret at the end instead of
    // selecting everything, so an accidental keystroke cannot wipe the path.
    textarea.setSelectionRange(initialValue.length, initialValue.length)
  }

  private applyHeadingLevel(textarea: HTMLTextAreaElement, level: number) {
    const lineEnd = textarea.value.indexOf('\n') < 0 ? textarea.value.length : textarea.value.indexOf('\n')
    const firstLine = textarea.value.slice(0, lineEnd).replace(this.documentFormat === 'org' ? /^\*{1,6}\s+/ : /^#{1,6}\s+/, '')
    const marker = this.documentFormat === 'org' ? '*' : '#'
    const replacement = `${level ? `${marker.repeat(level)} ` : ''}${firstLine}`
    textarea.setRangeText(replacement, 0, lineEnd, 'end')
    textarea.focus()
  }

  private insertEditorSnippet(textarea: HTMLTextAreaElement, snippet: string) {
    const start = textarea.selectionStart
    const prefix = start > 0 && textarea.value[start - 1] !== '\n' ? '\n' : ''
    const suffix = start < textarea.value.length && textarea.value[start] !== '\n' ? '\n' : ''
    textarea.setRangeText(prefix + snippet + suffix, start, textarea.selectionEnd, 'end')
    textarea.focus()
  }

  private async renderInlinePreview(target: HTMLElement, markdown: string) {
    target.classList.toggle('org-preview', this.documentFormat === 'org')
    target.classList.toggle('markdown-preview', this.documentFormat === 'markdown')
    target.innerHTML = this.previewRenderer.render(this.renderableDocument(markdown || ' '))
    this.previewRenderer.afterRender(target)
    for (const image of target.querySelectorAll<HTMLImageElement>('img')) {
      const source = image.getAttribute('src') || ''
      if (/^(?:https?:|data:|blob:)/i.test(source)) continue
      image.classList.add('md-asset')
      try {
        image.src = await this.getAssetUrl(source)
      } catch {
        image.alt = `找不到图片：${source}`
      }
    }
    if (!target.classList.contains('inline-editor-preview')) this.renderPreviewLineNumbers(target)
  }

  private decoratePreviewImages(preview: HTMLElement) {
    for (const image of preview.querySelectorAll<HTMLImageElement>('img')) {
      const source = image.getAttribute('src') || ''
      const imagePath = normalizeAssetPath(source)
      image.classList.add('md-asset')
      image.dataset.assetPath = imagePath
      image.alt ||= imagePath
      if (!/^(?:https?:|data:|blob:)/i.test(source)) {
        image.removeAttribute('src')
        this.observeRenderedImage(image)
      }

      const block = image.closest<HTMLElement>('[data-md-start-line]')
      if (!block) continue
      const startLine = Number(block.dataset.mdStartLine)
      const endLine = Number(block.dataset.mdEndLine)
      const [start, end] = this.sourceRangeForLines(startLine, endLine)
      const section = this.sections.find(item => item.kind === 'image'
        && item.start >= start && item.start < end
        && normalizeAssetPath(item.imagePath || '') === imagePath)
        || this.sections.find(item => item.kind === 'image' && item.start >= start && item.start < end)
      if (!section) continue

      const actions = document.createElement('div')
      actions.className = 'preview-image-actions'
      const replace = document.createElement('button')
      replace.textContent = '替换图片'
      replace.addEventListener('click', event => {
        event.stopPropagation()
        this.chooseReplacement(section)
      })
      const remove = document.createElement('button')
      remove.className = 'danger'
      remove.textContent = '删除链接'
      remove.addEventListener('click', event => {
        event.stopPropagation()
        this.removeImageReference(section)
      })
      const removeBoth = document.createElement('button')
      removeBoth.className = 'danger'
      removeBoth.textContent = '删除链接和图片'
      removeBoth.title = '立即从当前工作副本删除；打开文件夹时，点击“覆盖保存 Markdown”后才删除本地图片'
      removeBoth.addEventListener('click', event => {
        event.stopPropagation()
        void this.removeImageAndReference(section)
      })
      if (this.zip) actions.append(replace)
      actions.append(remove)
      if (this.zip) actions.append(removeBoth)
      block.appendChild(actions)
    }
  }

  private observeRenderedImage(image: HTMLImageElement) {
    if (typeof IntersectionObserver === 'undefined') {
      void this.loadRenderedImage(image)
      return
    }
    if (!this.imageObserver) {
      const pane = this.shadowRoot!.getElementById('mdPane')!
      this.imageObserver = new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const target = entry.target as HTMLImageElement
          this.imageObserver?.unobserve(target)
          void this.loadRenderedImage(target)
        }
      }, { root: pane, rootMargin: '600px 0px' })
    }
    this.imageObserver.observe(image)
  }

  private async loadRenderedImage(image: HTMLImageElement) {
    const path = image.dataset.assetPath
    if (!path) return
    try {
      image.src = await this.getAssetUrl(path)
    } catch (error) {
      image.alt = error instanceof Error ? error.message : String(error)
      image.classList.add('image-error')
    }
  }

  private sourceRangeForLines(startLine: number, endLine: number): [number, number] {
    return this.sourceRangeForLinesIn(this.markdownText || '', startLine, endLine)
  }

  private sourceRangeForLinesIn(markdown: string, startLine: number, endLine: number): [number, number] {
    if (this.sourceLineCache?.markdown !== markdown) {
      const offsets = [0]
      for (let index = 0; index < markdown.length; index++) {
        if (markdown[index] === '\n') offsets.push(index + 1)
      }
      this.sourceLineCache = { markdown, offsets }
    }
    const offsets = this.sourceLineCache.offsets
    return [offsets[startLine] ?? markdown.length, offsets[endLine] ?? markdown.length]
  }

  private async attachPdf(file: File) {
    if (!this.zip) return
    this.zip.file(file.name, file)
    this.revokeOwnedPdfUrl()
    this.externalPdfUrl = null
    this.externalPdfPath = ''
    this.ownedPdfUrl = URL.createObjectURL(file)
    this.pdfUrl = this.ownedPdfUrl
    await this.rebuild()
  }

  private renderableDocument(source: string): string {
    return this.documentFormat === 'org' ? orgToMarkdown(source) : source
  }

  private buildSourceEditor() {
    this.previewBuildSequence++
    this.previewBuild = null
    this.shadowRoot?.getElementById('mdPane')?.removeAttribute('aria-busy')
    const pane = this.shadowRoot?.getElementById('mdPane')
    if (!pane) return
    const value = this.sourceDraft
    this.sourceEditor?.destroy()
    pane.innerHTML = ''
    const host = document.createElement('div')
    host.className = 'source-editor-host'
    let livePreview: HTMLElement | null = null
    if (this.standaloneMarkdown) {
      const split = document.createElement('div')
      split.className = 'standalone-source-split'
      livePreview = document.createElement('article')
      livePreview.className = `standalone-live-preview md-preview ${this.documentFormat}-preview`
      const divider = document.createElement('div')
      divider.className = 'standalone-divider'
      divider.title = '拖动调整编辑与渲染区域比例'
      const swap = document.createElement('button')
      swap.type = 'button'
      swap.title = `交换 ${this.documentFormat === 'org' ? 'Org' : 'Markdown'} 编辑器与渲染预览的位置`
      swap.addEventListener('click', () => this.toggleStandaloneSourceOrder())
      divider.appendChild(swap)
      split.append(host, divider, livePreview)
      pane.appendChild(split)
      this.setupStandaloneSourceDivider(split, divider)
      this.updateStandaloneSourceLayout()
      void this.renderInlinePreview(livePreview, value).then(() => this.syncStandalonePreviewFromSource(livePreview!, 0, value))
      livePreview.addEventListener('click', event => {
        const block = (event.target as Element).closest<HTMLElement>('[data-md-start-line]')
        if (!block || !this.sourceEditor) return
        event.preventDefault()
        const markdown = this.sourceEditor.getValue()
        const startLine = Number(block.dataset.mdStartLine)
        const endLine = Number(block.dataset.mdEndLine)
        const [start] = this.sourceRangeForLinesIn(markdown, startLine, endLine)
        // A cursor jump works in both standard CodeMirror and Vim normal mode;
        // selecting the whole block makes Vim enter/reshape a visual selection.
        this.sourceEditor.goTo(start)
        this.syncStandalonePreviewFromSource(livePreview!, start, markdown)
      })
    } else {
      pane.appendChild(host)
    }
    const plugins = [...this.markdownEditorPlugins]
    if (this.vimEnabled && !plugins.some(plugin => plugin.name === 'vim')) plugins.push(createVimEditorPlugin())
    this.sourceEditor = new MarkdownSourceEditor({
      parent: host,
      document: value,
      format: this.documentFormat,
      plugins,
      lineNumbers: this.viewerSettings.lineNumberMode,
      onChange: next => {
        this.sourceDraft = next
        const status = this.shadowRoot?.getElementById('sourceStatus')
        if (status) status.textContent = next === this.markdownText ? '' : '未保存'
        if (livePreview) {
          const offset = this.sourceEditor?.view.state.selection.main.head || 0
          void this.renderInlinePreview(livePreview, next)
            .then(() => this.syncStandalonePreviewFromSource(livePreview!, offset, next))
        }
      },
      onSelectionChange: offset => {
        if (livePreview) queueMicrotask(() => {
          // CodeMirror normalizes CRLF to LF, so use its current document for
          // offset-to-line mapping instead of the original file text.
          const current = this.sourceEditor?.getValue() ?? value.replace(/\r\n?/g, '\n')
          this.syncStandalonePreviewFromSource(livePreview!, offset, current)
        })
      },
    })
    this.sourceEditor.view.dom.style.fontSize = `${Math.round(14 * this.markdownZoom)}px`
    this.sourceDraft = value
    this.updateModeToolbar()
    this.sourceEditor.focus()
  }

  private revealPreviewLine(zeroBasedLine: number): boolean {
    const preview = this.shadowRoot?.querySelector<HTMLElement>('.md-preview')
    if (!preview) return false
    const blocks = Array.from(preview.querySelectorAll<HTMLElement>('[data-md-start-line]'))
    const span = (element: HTMLElement) => Number(element.dataset.mdEndLine) - Number(element.dataset.mdStartLine)
    const containsLine = (element: HTMLElement) => {
      const start = Number(element.dataset.mdStartLine)
      const end = Number(element.dataset.mdEndLine)
      return zeroBasedLine >= start && zeroBasedLine < Math.max(start + 1, end)
    }
    const containers = blocks.filter(containsLine).sort((left, right) => span(left) - span(right))
    const previous = blocks
      .filter(element => Number(element.dataset.mdStartLine) <= zeroBasedLine)
      .sort((left, right) => Number(right.dataset.mdStartLine) - Number(left.dataset.mdStartLine)
        || span(left) - span(right))
    const active = containers[0] || previous[0] || blocks[0]
    if (!active) return false
    const sectionIndex = active.dataset.idx == null || active.dataset.idx === ''
      ? Number.NaN
      : Number(active.dataset.idx)
    const section = this.sections[sectionIndex]
    if (section) this.onMdClick(section, sectionIndex, active)
    else {
      preview.querySelectorAll('.active').forEach(item => item.classList.remove('active'))
      active.classList.add('active')
    }
    active.scrollIntoView({ block: 'center' })
    return true
  }

  private syncStandalonePreviewFromSource(preview: HTMLElement, offset: number, markdown: string) {
    const line = markdown.slice(0, Math.max(0, Math.min(offset, markdown.length))).split('\n').length - 1
    this.setPreviewCursorLine(line + 1)
    const blocks = Array.from(preview.querySelectorAll<HTMLElement>('[data-md-start-line]'))
    const active = blocks.find(block => {
      const start = Number(block.dataset.mdStartLine)
      const end = Number(block.dataset.mdEndLine)
      return line >= start && line < Math.max(start + 1, end)
    }) || [...blocks].reverse().find(block => Number(block.dataset.mdStartLine) <= line)
    blocks.forEach(block => block.classList.toggle('active', block === active))
    active?.scrollIntoView({ block: 'nearest' })
  }

  private switchToSourceMode() {
    if (this.markdownText == null || this.markdownMode === 'source') return
    const line = this.currentSourceLine()
    this.closeVimCommandBar(false)
    if (this.markdownMode === 'live') this.finishLiveEdit(false)
    this.markdownMode = 'source'
    this.sourceDraft = this.markdownText
    this.buildSourceEditor()
    this.revealSourceLine(line, { quiet: true })
    this.updateSearchResults()
  }

  private switchToPreviewMode() {
    const line = this.currentSourceLine()
    if (this.markdownMode === 'source') {
      this.saveSourceAndPreview()
      this.revealSourceLine(line, { quiet: true })
      return
    }
    if (this.markdownMode === 'preview') return
    this.closeVimCommandBar(false)
    this.finishLiveEdit(false)
    this.markdownMode = 'preview'
    this.buildMarkdownPreview()
    this.revealSourceLine(line, { quiet: true })
    this.updateModeToolbar()
  }

  private switchToLiveMode() {
    if (this.markdownText == null || this.markdownMode === 'live') return
    const line = this.currentSourceLine()
    this.closeVimCommandBar(false)
    if (this.markdownMode === 'source') this.saveSourceAndPreview()
    this.markdownMode = 'live'
    this.buildMarkdownPreview()
    this.revealSourceLine(line, { quiet: true })
    this.updateModeToolbar()
  }

  private switchToMindmapMode() {
    if (this.markdownText == null || this.markdownMode === 'mindmap') return
    const line = this.currentSourceLine()
    this.closeVimCommandBar(false)
    if (this.markdownMode === 'live') this.finishLiveEdit(false)
    if (this.markdownMode === 'source') this.flushSourceDraft()
    this.markdownMode = 'mindmap'
    this.buildMindmap()
    this.revealSourceLine(line, { quiet: true })
    this.updateModeToolbar()
    this.updateSearchResults()
  }

  /**
   * Fold the code-mode draft back into `markdownText` without changing mode.
   * `saveSourceAndPreview` also leaves source mode, which is not what switching
   * to the mind map wants.
   */
  private flushSourceDraft(): boolean {
    if (this.markdownMode !== 'source') return false
    const next = this.sourceEditor?.getValue() ?? this.sourceDraft
    const previous = this.markdownText || ''
    if (next === previous) return false
    this.pushUndoAction({ type: 'restore-markdown', markdown: previous })
    this.markdownText = next
    this.reviewEdits.push({
      type: 'edit-markdown',
      detail: `edited full ${this.documentFormat === 'org' ? 'Org' : 'Markdown'} source`,
      timestamp: new Date().toISOString(),
    })
    this.refreshSectionsPreservingMatches(this.sections)
    return true
  }

  private saveSourceAndPreview() {
    if (this.markdownMode !== 'source') return
    const next = this.sourceEditor?.getValue() ?? this.sourceDraft
    const previousMarkdown = this.markdownText || ''
    const previousSections = this.sections
    if (next !== previousMarkdown) {
      this.pushUndoAction({ type: 'restore-markdown', markdown: previousMarkdown })
      this.markdownText = next
      this.reviewEdits.push({
        type: 'edit-markdown',
        detail: `edited full ${this.documentFormat === 'org' ? 'Org' : 'Markdown'} source`,
        timestamp: new Date().toISOString(),
      })
      this.refreshSectionsPreservingMatches(previousSections)
    }
    this.sourceEditor?.destroy()
    this.sourceEditor = null
    this.markdownMode = 'preview'
    this.sourceDraft = ''
    this.buildMarkdownPreview()
    this.updateOverlayStates()
    this.updateToolbar()
    this.updateSearchResults()
    this.renderMarkdownOutline()
  }

  private cancelSourceMode() {
    if (this.markdownMode !== 'source') return
    this.sourceEditor?.destroy()
    this.sourceEditor = null
    this.markdownMode = 'preview'
    this.sourceDraft = ''
    this.buildMarkdownPreview()
    this.updateSearchResults()
  }

  private setLineNumberMode(value: string) {
    const mode: LineNumberMode = value === 'off' || value === 'relative' ? value : 'absolute'
    this.viewerSettings.lineNumberMode = mode
    this.sourceEditor?.setLineNumberMode(mode)
    this.renderPreviewLineNumbers()
    this.updateSettingsControls()
    this.saveViewerSettings()
  }

  private toggleVimMode() {
    this.vimEnabled = !this.vimEnabled
    if (!this.vimEnabled) {
      this.closeVimCommandBar(false)
      this.resetVimNormalState()
      this.vimSearch = null
    }
    if (this.markdownMode === 'source') {
      this.sourceDraft = this.sourceEditor?.getValue() ?? this.sourceDraft
      this.buildSourceEditor()
    }
    this.updateModeToolbar()
  }

  /** `:` commands only apply where Vim is on and no CodeMirror instance owns the keys. */
  private previewVimCommandReady(): boolean {
    if (!this.vimEnabled || this.documentView === 'json') return false
    if (this.markdownMode !== 'preview' && this.markdownMode !== 'live') return false
    return Boolean(this.shadowRoot?.querySelector('.md-preview'))
  }

  private onPreviewVimKeydown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
    if (event.isComposing) return
    const bar = this.shadowRoot?.getElementById('vimCommandBar')
    // The command line owns the keyboard while it is open.
    if (!bar || !bar.hidden) return
    if (!this.previewVimCommandReady()) return
    const path = typeof event.composedPath === 'function' ? event.composedPath() : []
    const target = path[0]
    // Preview blocks are not focusable, so a click parks focus on <body> and
    // the keydown path no longer includes this component. Trust the pointer
    // flag instead: the user is still "in" the viewer.
    const onChrome = target === document.body || target === document.documentElement || target === document
    const innermost = innermostViewerHost(path)
    if (innermost ? innermost !== this : !(onChrome && this.vimPointerInside)) {
      this.resetVimNormalState()
      return
    }
    if (!this.canOpenVimCommand(target)) {
      this.resetVimNormalState()
      return
    }
    // IMEs in Chinese mode emit the fullwidth colon; the code fallback covers
    // layouts where Shift+; does not report ':'.
    const isColon = event.key === ':' || event.key === '：'
      || (event.code === 'Semicolon' && event.shiftKey)
    if (isColon) {
      event.preventDefault()
      this.resetVimNormalState()
      this.openVimCommandBar(':')
      return
    }
    if (event.key === '/') {
      event.preventDefault()
      this.resetVimNormalState()
      this.openVimCommandBar('/')
      return
    }
    this.handleVimNormalKey(event)
  }

  /** Normal-mode keys (`gg`, `G`, counts, `n`/`N`) typed over the preview. */
  private handleVimNormalKey(event: KeyboardEvent) {
    const { state, action } = pushViewerVimNormalKey(this.vimNormalState, event.key)
    this.vimNormalState = state
    if (action.kind === 'ignored') {
      this.clearVimNormalTimer()
      return
    }
    event.preventDefault()
    if (action.kind === 'none') {
      // Half a sequence (`g`, digits): echo it and arm the reset timer.
      this.setStatus(state.pendingG ? `g…` : state.count)
      this.armVimNormalTimer()
      return
    }
    this.clearVimNormalTimer()
    if (action.kind === 'reset') {
      if (this.vimSearch) this.setStatus('已取消')
      this.vimSearch = null
      return
    }
    if (action.kind === 'goto') {
      const line = action.line === 'first' ? 1 : action.line === 'last' ? this.sourceLineTotal() : action.line
      this.revealSourceLine(line)
      return
    }
    this.repeatVimSearch(action.reverse)
  }

  private armVimNormalTimer() {
    this.clearVimNormalTimer()
    this.vimNormalTimer = window.setTimeout(() => {
      this.vimNormalTimer = 0
      this.resetVimNormalState()
    }, 1500)
  }

  private clearVimNormalTimer() {
    if (this.vimNormalTimer) {
      clearTimeout(this.vimNormalTimer)
      this.vimNormalTimer = 0
    }
  }

  private resetVimNormalState() {
    this.vimNormalState = initialViewerVimNormalState()
    this.clearVimNormalTimer()
  }

  /** A focused editor or an in-place block edit must keep the literal colon. */
  private canOpenVimCommand(target: unknown): boolean {
    if (this.liveEditSession) return false
    if (!(target instanceof Element)) return true
    if (target.closest('input, textarea, select, .inline-editor')) return false
    if (target.closest('[contenteditable="true"]')) return false
    return true
  }

  private openVimCommandBar(mode: ':' | '/' = ':') {
    const bar = this.shadowRoot?.getElementById('vimCommandBar') as HTMLElement | null
    const input = this.shadowRoot?.getElementById('vimCommandInput') as HTMLInputElement | null
    if (!bar || !input) return
    const active = this.shadowRoot?.activeElement
    this.vimCommandOrigin = active instanceof HTMLElement ? active : null
    this.vimCommandMode = mode
    this.vimSearchOriginLine = this.previewCursorLine
    const prefix = this.shadowRoot?.getElementById('vimCommandPrefix')
    if (prefix) prefix.textContent = mode
    bar.hidden = false
    bar.classList.remove('error')
    input.value = ''
    this.updateVimCommandHint()
    input.focus()
  }

  private closeVimCommandBar(restoreFocus = true) {
    const bar = this.shadowRoot?.getElementById('vimCommandBar') as HTMLElement | null
    if (!bar || bar.hidden) return
    const input = this.shadowRoot?.getElementById('vimCommandInput') as HTMLInputElement | null
    bar.hidden = true
    bar.classList.remove('error')
    if (input) input.value = ''
    const origin = this.vimCommandOrigin
    this.vimCommandOrigin = null
    if (!restoreFocus) return
    if (origin?.isConnected) origin.focus({ preventScroll: true })
    else this.focusPreviewSurface()
  }

  /** Park focus on the rendered document so the next `:` needs no extra click. */
  private focusPreviewSurface() {
    this.shadowRoot?.querySelector<HTMLElement>('.md-preview')?.focus({ preventScroll: true })
  }

  private updateVimCommandHint() {
    const hint = this.shadowRoot?.getElementById('vimCommandHint')
    if (!hint) return
    const value = (this.shadowRoot?.getElementById('vimCommandInput') as HTMLInputElement | null)?.value || ''
    if (this.vimCommandMode === '/') {
      if (!value) {
        hint.textContent = this.vimSearch
          ? `增量搜索 · 上次：/${this.vimSearch.query}/ · 回车确认 · Esc 取消`
          : '增量搜索 · 回车确认 · Esc 取消'
        return
      }
      const matches = this.findVimSearchMatches(value)
      hint.textContent = matches.length ? `共 ${matches.length} 处匹配` : '未找到'
      return
    }
    const command = parseViewerVimCommand(value)
    if (command.kind === 'none') {
      hint.textContent = `共 ${this.sourceLineTotal()} 行 · :N 跳行 · :w 保存 · gg/G 首末行 · / 搜索`
      return
    }
    if (command.kind === 'goto') {
      hint.textContent = command.line === 'last' ? '跳转到末行' : `跳转到第 ${command.line} 行`
      return
    }
    if (command.kind === 'write') {
      hint.textContent = '保存 Markdown'
      return
    }
    if (command.kind === 'noh') {
      hint.textContent = '清除搜索'
      return
    }
    hint.textContent = ''
  }

  private onVimCommandKeydown(event: KeyboardEvent) {
    const input = event.target as HTMLInputElement
    if (event.key === 'Escape') {
      event.preventDefault()
      if (this.vimCommandMode === '/') this.cancelVimSearch(input.value)
      this.closeVimCommandBar()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (this.vimCommandMode === '/') this.commitVimSearch(input.value)
      else void this.runVimCommand(input.value)
      return
    }
    // Vim leaves the command line when Backspace passes its ':' or '/'.
    if (event.key === 'Backspace' && input.value === '') {
      event.preventDefault()
      if (this.vimCommandMode === '/') this.cancelVimSearch(input.value)
      this.closeVimCommandBar()
    }
  }

  private async runVimCommand(value: string) {
    const command = parseViewerVimCommand(value)
    if (command.kind === 'none') {
      this.closeVimCommandBar()
      return
    }
    if (command.kind === 'unknown') {
      this.reportVimCommandError(`E492: 不是编辑器命令：${command.command}`)
      return
    }
    if (command.kind === 'goto') {
      const line = command.line === 'last' ? this.sourceLineTotal() : command.line
      if (!this.revealSourceLine(line)) {
        this.reportVimCommandError(`E16: 无效的行号：${command.line}`)
        return
      }
      this.closeVimCommandBar()
      return
    }
    if (command.kind === 'noh') {
      this.vimSearch = null
      this.closeVimCommandBar()
      this.setStatus('已清除搜索')
      return
    }
    if (!this.sourceDirectoryHandle && !this.sourceMarkdownFileHandle) {
      this.reportVimCommandError('E32: 没有可写入的文件（需通过文件夹或文件句柄打开）')
      return
    }
    this.closeVimCommandBar()
    await this.saveMarkdownToFolder()
  }

  /** Keep the bar open on failure so the typed command can be corrected. */
  private reportVimCommandError(message: string) {
    const bar = this.shadowRoot?.getElementById('vimCommandBar')
    const hint = this.shadowRoot?.getElementById('vimCommandHint')
    bar?.classList.add('error')
    if (hint) hint.textContent = message
    this.setStatus(message)
    const input = this.shadowRoot?.getElementById('vimCommandInput') as HTMLInputElement | null
    input?.focus()
    input?.select()
  }

  private viewerSourceLines(): string[] {
    const source = this.markdownMode === 'source' && this.sourceEditor
      ? this.sourceEditor.getValue()
      : this.markdownText || ''
    return source.replace(/\r\n?/g, '\n').split('\n')
  }

  /** 1-based line numbers containing the query; smartcase like Vim (`\C` off). */
  private findVimSearchMatches(query: string): number[] {
    if (!query) return []
    const sensitive = /[A-Z]/.test(query)
    const needle = sensitive ? query : query.toLowerCase()
    const matches: number[] = []
    const lines = this.viewerSourceLines()
    for (let index = 0; index < lines.length; index++) {
      const haystack = sensitive ? lines[index] : lines[index].toLowerCase()
      if (haystack.includes(needle)) matches.push(index + 1)
    }
    return matches
  }

  /** First match at or after `fromLine`, wrapping like Vim. */
  private vimSearchFrom(matches: number[], fromLine: number): number {
    const next = matches.findIndex(line => line >= fromLine)
    return next >= 0 ? next : 0
  }

  /** incsearch: reveal the first match as the user types the `/` query. */
  private previewVimSearchMatch() {
    const bar = this.shadowRoot?.getElementById('vimCommandBar')
    const input = this.shadowRoot?.getElementById('vimCommandInput') as HTMLInputElement | null
    if (!input?.value) {
      bar?.classList.remove('error')
      return
    }
    const matches = this.findVimSearchMatches(input.value)
    bar?.classList.toggle('error', matches.length === 0)
    if (matches.length) this.revealSourceLine(matches[this.vimSearchFrom(matches, this.vimSearchOriginLine)])
  }

  private commitVimSearch(query: string) {
    if (!query) {
      this.closeVimCommandBar()
      return
    }
    const matches = this.findVimSearchMatches(query)
    if (!matches.length) {
      this.reportVimCommandError(`E486: 找不到模式：${query}`)
      return
    }
    // incsearch may already have moved the cursor onto a match; keep that one.
    let index = matches.indexOf(this.previewCursorLine)
    if (index < 0) index = this.vimSearchFrom(matches, this.vimSearchOriginLine)
    this.vimSearch = { query, matches, index }
    this.revealSourceLine(matches[index])
    this.closeVimCommandBar()
    this.setStatus(`第 ${index + 1}/${matches.length} 处匹配 · /${query}/ · n 下一个`)
  }

  /** Esc or backing out of `/` restores the line the search started from. */
  private cancelVimSearch(query: string) {
    if (query && this.previewCursorLine !== this.vimSearchOriginLine) {
      this.revealSourceLine(this.vimSearchOriginLine)
    }
  }

  private repeatVimSearch(reverse: boolean) {
    const search = this.vimSearch
    if (!search || !search.matches.length) {
      this.setStatus('E35: 没有之前的搜索模式')
      return
    }
    const total = search.matches.length
    search.index = (search.index + (reverse ? -1 : 1) + total) % total
    this.revealSourceLine(search.matches[search.index])
    this.setStatus(`第 ${search.index + 1}/${total} 处匹配 · /${search.query}/`)
  }

  private sourceLineTotal(): number {
    const source = this.markdownMode === 'source' && this.sourceEditor
      ? this.sourceEditor.getValue()
      : this.markdownText || ''
    return Math.max(1, source.replace(/\r\n?/g, '\n').split('\n').length)
  }

  private toggleStandaloneSourceOrder() {
    if (!this.standaloneMarkdown || this.markdownMode !== 'source') return
    this.viewerSettings.standaloneSourceSwapped = !this.viewerSettings.standaloneSourceSwapped
    this.updateStandaloneSourceLayout()
    this.saveViewerSettings()
  }

  private updateStandaloneSourceLayout() {
    const split = this.shadowRoot?.querySelector<HTMLElement>('.standalone-source-split')
    if (!split) return
    const stack = this.viewerSettings.standaloneSourceLayout === 'stack'
    split.classList.toggle('stack', stack)
    split.classList.toggle('swapped', this.viewerSettings.standaloneSourceSwapped)
    split.style.setProperty('--standalone-first', `${this.viewerSettings.standaloneSourceFirstPercent}%`)
    const swap = split.querySelector<HTMLButtonElement>('.standalone-divider button')
    if (swap) {
      swap.textContent = stack ? '⇅' : '⇄'
      swap.title = stack
        ? '交换 Markdown 编辑器与渲染预览的上下位置'
        : '交换 Markdown 编辑器与渲染预览的左右位置'
    }
  }

  private setupStandaloneSourceDivider(split: HTMLElement, divider: HTMLElement) {
    divider.addEventListener('pointerdown', event => {
      if ((event.target as Element).closest('button')) return
      event.preventDefault()
      divider.setPointerCapture(event.pointerId)
      const move = (moveEvent: PointerEvent) => {
        const rect = split.getBoundingClientRect()
        const raw = this.viewerSettings.standaloneSourceLayout === 'stack'
          ? (moveEvent.clientY - rect.top) / rect.height * 100
          : (moveEvent.clientX - rect.left) / rect.width * 100
        this.viewerSettings.standaloneSourceFirstPercent = this.clampPercent(raw, 50, 20, 80)
        this.updateStandaloneSourceLayout()
        this.updateSettingsControls()
      }
      const finish = () => {
        divider.removeEventListener('pointermove', move)
        this.saveViewerSettings()
      }
      divider.addEventListener('pointermove', move)
      divider.addEventListener('pointerup', finish, { once: true })
      divider.addEventListener('pointercancel', finish, { once: true })
    })
  }

  private chooseSyncedJson() {
    if (this.contentListData != null) {
      this.syncedJsonKind = 'content'
      this.syncedJsonPath = this.contentListPath
      this.syncedJsonText = this.contentListData
    } else if (this.contentListV2Data != null) {
      this.syncedJsonKind = 'v2'
      this.syncedJsonPath = this.contentListV2Path
      this.syncedJsonText = this.contentListV2Data
    } else if (this.layoutData != null) {
      this.syncedJsonKind = 'layout'
      this.syncedJsonPath = this.layoutPath
      this.syncedJsonText = this.layoutData
    } else {
      this.syncedJsonKind = ''
      this.syncedJsonPath = ''
      this.syncedJsonText = null
    }
    this.updateDocumentView()
  }

  private commitSyncedJson(text: string) {
    this.syncedJsonText = text
    if (this.syncedJsonKind === 'content') this.contentListData = text
    else if (this.syncedJsonKind === 'v2') this.contentListV2Data = text
    else if (this.syncedJsonKind === 'layout') this.layoutData = text
    const editor = this.shadowRoot?.getElementById('jsonEditor') as HTMLTextAreaElement | null
    if (editor && editor.value !== text && this.shadowRoot?.activeElement !== editor) editor.value = text
    const paths = this.blocks.flatMap(block => block.jsonPath ? [block.jsonPath] : [])
    const texts = jsonTextsByPath(text, paths)
    if (!texts) return
    for (const block of this.blocks) {
      const next = block.jsonPath ? texts.get(block.jsonPath) : undefined
      if (next != null) block.text = next
    }
    this.refreshOverlayTitles()
  }

  private refreshOverlayTitles() {
    const byId = new Map(this.blocks.map(block => [block.id, block]))
    this.shadowRoot?.querySelectorAll<HTMLElement>('.block-overlay').forEach(overlay => {
      const block = byId.get(overlay.dataset.blockId || '')
      if (!block) return
      const furniture = isPageFurnitureType(block.type)
      overlay.title = (furniture
        ? `${pageFurnitureLabel(block.type)} ${block.text || ''}`.trim()
        : (block.imagePath || block.text || block.type || '')
      ).slice(0, 160)
      const caption = overlay.querySelector('.furniture-label')
      if (caption && block.text) caption.textContent = block.text
    })
  }

  private syncMarkdownIntoJson() {
    if (this.syncingDocuments || !this.syncedJsonText || this.markdownText == null) return
    const next = projectMarkdownOntoJson(this.syncedJsonText, this.sections, this.blocks)
    if (next && next !== this.syncedJsonText) this.commitSyncedJson(next)
  }

  private applyJsonEditor(): boolean {
    const editor = this.shadowRoot?.getElementById('jsonEditor') as HTMLTextAreaElement | null
    if (!editor || !this.syncedJsonText) return true
    if (editor.value === this.syncedJsonText) return true
    const nextMarkdown = projectJsonOntoMarkdown(this.markdownText || '', editor.value, this.sections, this.blocks)
    if (nextMarkdown == null) {
      this.setSourceStatus('JSON 格式不正确，尚未同步到 Markdown')
      return false
    }
    this.syncingDocuments = true
    try {
      this.commitSyncedJson(editor.value)
      if (nextMarkdown !== this.markdownText) {
        const previous = this.sections
        this.markdownText = nextMarkdown
        this.refreshSectionsPreservingMatches(previous)
      }
    } finally {
      this.syncingDocuments = false
    }
    this.setSourceStatus('Markdown 已同步')
    return true
  }

  private flushDocumentSync(): boolean {
    if (this.jsonSyncTimer) {
      clearTimeout(this.jsonSyncTimer)
      this.jsonSyncTimer = null
    }
    if (this.documentView === 'json') return this.applyJsonEditor()
    if (this.markdownMode === 'live') this.finishLiveEdit(false)
    if (this.markdownMode === 'source') this.saveSourceAndPreview()
    this.syncMarkdownIntoJson()
    return true
  }

  private scheduleJsonSync() {
    if (this.jsonSyncTimer) clearTimeout(this.jsonSyncTimer)
    this.jsonSyncTimer = setTimeout(() => {
      this.jsonSyncTimer = null
      if (this.documentView === 'json') this.applyJsonEditor()
    }, 400)
  }

  private showJsonDocument() {
    if (!this.syncedJsonText || this.documentView === 'json') return
    if (this.markdownMode === 'live') this.finishLiveEdit(false)
    if (this.markdownMode === 'source') this.saveSourceAndPreview()
    this.syncMarkdownIntoJson()
    this.documentView = 'json'
    const editor = this.shadowRoot?.getElementById('jsonEditor') as HTMLTextAreaElement | null
    if (editor) editor.value = this.syncedJsonText || ''
    this.updateDocumentView()
  }

  private showMarkdownDocument() {
    if (this.documentView !== 'json') return
    if (this.jsonSyncTimer) {
      clearTimeout(this.jsonSyncTimer)
      this.jsonSyncTimer = null
    }
    if (!this.applyJsonEditor()) return
    this.documentView = 'markdown'
    this.rebuildMarkdownView()
    this.updateDocumentView()
  }

  private setSourceStatus(message: string) {
    const status = this.shadowRoot?.getElementById('sourceStatus')
    if (status) status.textContent = message
  }

  private updateDocumentView() {
    const shadow = this.shadowRoot
    if (!shadow) return
    const markdownButton = shadow.getElementById('showMarkdownView')
    const jsonButton = shadow.getElementById('showJsonView') as HTMLButtonElement | null
    markdownButton?.classList.toggle('active', this.documentView === 'markdown')
    jsonButton?.classList.toggle('active', this.documentView === 'json')
    if (jsonButton) {
      jsonButton.disabled = !this.syncedJsonText
      jsonButton.title = this.syncedJsonText ? '查看并编辑 MinerU JSON，修改会同步到 Markdown' : '打开带 JSON 的 MinerU 结果后可切换'
    }
    shadow.getElementById('mdPaneBody')?.classList.toggle('json-view', this.documentView === 'json')
    if (this.documentView === 'json') this.closeVimCommandBar(false)
    const editor = shadow.getElementById('jsonEditor') as HTMLTextAreaElement | null
    if (editor) editor.hidden = this.documentView !== 'json'
    for (const id of ['mdPreviewMode', 'mdLiveMode', 'mdSourceMode', 'mdMindmapMode', 'mdZoomOut', 'mdZoomIn', 'vimToggle', 'lineNumberMode', 'toggleFind', 'toggleMdOutline', 'splitRight', 'splitDown']) {
      const control = shadow.getElementById(id) as HTMLButtonElement | HTMLSelectElement | null
      if (control) control.disabled = this.documentView === 'json'
    }
  }

  private syncingDocuments = false

  private updateModeToolbar() {
    const shadow = this.shadowRoot
    if (!shadow) return
    shadow.getElementById('mdPreviewMode')?.classList.toggle('active', this.markdownMode === 'preview')
    shadow.getElementById('mdLiveMode')?.classList.toggle('active', this.markdownMode === 'live')
    shadow.getElementById('mdSourceMode')?.classList.toggle('active', this.markdownMode === 'source')
    shadow.getElementById('mdMindmapMode')?.classList.toggle('active', this.markdownMode === 'mindmap')
    const vimButton = shadow.getElementById('vimToggle')
    if (vimButton) {
      vimButton.textContent = `Vim：${this.vimEnabled ? '开' : '关'}`
      vimButton.title = this.vimEnabled
        ? '源码模式使用 Vim 键位；预览与实时预览中按 : 可跳转到指定行'
        : '开启后源码模式使用 Vim 键位，预览与实时预览中可按 : 跳转行'
    }
    ;(shadow.getElementById('sourceSave') as HTMLButtonElement | null)?.toggleAttribute('hidden', this.markdownMode !== 'source')
    ;(shadow.getElementById('sourceCancel') as HTMLButtonElement | null)?.toggleAttribute('hidden', this.markdownMode !== 'source')
    const status = shadow.getElementById('sourceStatus')
    if (status && this.markdownMode !== 'source') status.textContent = ''
    const undo = shadow.getElementById('undo') as HTMLButtonElement | null
    if (undo) undo.disabled = this.undoStack.length === 0 || this.markdownMode === 'source'
    const redo = shadow.getElementById('redo') as HTMLButtonElement | null
    if (redo) redo.disabled = this.redoStack.length === 0 || this.markdownMode === 'source'
  }

  private updatePluginStyles() {
    const pluginStyles = this.previewRenderer.styles()
    const style = this.shadowRoot?.getElementById('markdownPluginStyles')
    if (style) style.textContent = pluginStyles

    // Chromium does not reliably activate @font-face rules declared inside a
    // shadow tree. Mirror only those rules into the document so theme fonts
    // are fetched while all visual selectors remain scoped to this component.
    const fontFaces = pluginStyles.match(/@font-face\s*\{[^}]*\}/gi)?.join('\n') || ''
    if (!fontFaces) {
      this.documentPluginFontStyle?.remove()
      this.documentPluginFontStyle = null
      return
    }
    if (!this.documentPluginFontStyle) {
      this.documentPluginFontStyle = document.createElement('style')
      this.documentPluginFontStyle.dataset.mineruPluginFonts = ''
      document.head.appendChild(this.documentPluginFontStyle)
    }
    this.documentPluginFontStyle.textContent = fontFaces
  }

  private onMdClick(section: MdSection, index: number, element: HTMLElement) {
    const shadow = this.shadowRoot!
    shadow.querySelectorAll('.block-overlay.active,.md-preview .active')
      .forEach(item => item.classList.remove('active'))
    element.classList.add('active')
    this.activeIdx = index
    if (!section.bbox) return

    const pageElement = shadow.querySelector(`.pdf-page[data-page="${section.page}"]`) as HTMLElement | null
    pageElement?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    void this.renderPdfPage(section.page, pageElement || undefined)
    const overlays = shadow.querySelectorAll('.block-overlay')
    overlays.forEach(item => {
      const overlay = item as HTMLElement
      if (overlay.dataset.blockId === section.blockId) {
        overlay.classList.add('active')
        overlay.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    })
  }

  private onBlockClick(block: PdfBlock, overlay: HTMLElement) {
    if (this.previewBuild) {
      void this.waitForPreview().then(() => this.onBlockClick(block, overlay))
      return
    }
    const shadow = this.shadowRoot!
    shadow.querySelectorAll('.block-overlay.active,.md-preview .active')
      .forEach(item => item.classList.remove('active'))
    overlay.classList.add('active')
    if (isPageFurnitureType(block.type)) return

    let bestIndex = this.sections.findIndex(section => section.blockId === block.id)
    if (bestIndex < 0 && block.imagePath) {
      const target = normalizeAssetPath(block.imagePath)
      bestIndex = this.sections.findIndex(section =>
        section.imagePath && normalizeAssetPath(section.imagePath) === target,
      )
    }
    if (bestIndex < 0 && block.text) {
      const blockNorm = normalize(block.text)
      let bestSimilarity = 0
      for (let index = 0; index < this.sections.length; index++) {
        const similarity = lcsSimilarity(blockNorm, normalize(this.sections[index].text))
        if (similarity > bestSimilarity && similarity > 0.05) {
          bestSimilarity = similarity
          bestIndex = index
        }
      }
    }

    if (bestIndex >= 0) {
      this.activeIdx = bestIndex
      if (this.markdownMode === 'source' && this.sourceEditor) {
        const section = this.sections[bestIndex]
        this.sourceEditor.goTo(section.start, Math.max(0, section.end - section.start))
        return
      }
      const element = shadow.querySelector(`[data-idx="${bestIndex}"]`) as HTMLElement | null
      if (element) {
        element.classList.add('active')
        element.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    }
  }

  private chooseReplacement(section: MdSection) {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.jpg,.jpeg,.png,.webp,.gif,.bmp'
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (file) void this.replaceImage(section, file)
    })
    input.click()
  }

  private async replaceImage(section: MdSection, file: File) {
    if (!this.zip || !section.imagePath) return
    const zipPath = this.resolveAssetPath(section.imagePath)
    await this.hydrateAsset(zipPath)
    const entry = this.zip.file(zipPath)
    if (!entry) {
      alert(`ZIP 中找不到原图片：${zipPath}`)
      return
    }

    const oldExtension = this.canonicalExtension(section.imagePath)
    const newExtension = this.canonicalExtension(file.name)
    if (!oldExtension || oldExtension !== newExtension) {
      alert(`替换图片格式必须一致：原图为 ${oldExtension || '未知'}，新图为 ${newExtension || '未知'}`)
      return
    }

    const previousData = await entry.async('uint8array')
    this.pushUndoAction({ type: 'restore-image', zipPath, data: previousData })
    this.zip.file(zipPath, file)
    this.revokeAssetUrl(zipPath)
    this.reviewEdits.push({
      type: 'replace-image',
      imagePath: section.imagePath,
      timestamp: new Date().toISOString(),
      page: section.page,
      blockId: section.blockId,
      markdownStart: section.start,
    })
    this.rebuildMarkdownView()
    this.updateToolbar()
  }

  private removeImageReference(section: MdSection) {
    if (this.markdownText == null) return
    this.replaceMarkdownRange(section.start, section.end, '', {
      type: 'remove-image-reference',
      imagePath: section.imagePath,
      timestamp: new Date().toISOString(),
      page: section.page,
      blockId: section.blockId,
      markdownStart: section.start,
    })
  }

  private async removeImageAndReference(section: MdSection) {
    if (!this.zip || this.markdownText == null || !section.imagePath) return
    const zipPath = this.resolveAssetPath(section.imagePath)
    await this.hydrateAsset(zipPath)
    const entry = this.zip.file(zipPath)
    if (!entry) {
      if (confirm('本地图片本来就不存在。是否只删除 Markdown 图片链接？')) this.removeImageReference(section)
      return
    }
    const localNotice = this.sourceDirectoryHandle
      ? '\n\n本地图片会在点击“覆盖保存 Markdown”后删除。此前可撤销。'
      : '\n\n图片会从导出的修改版 ZIP 中删除。'
    if (!confirm(`确认删除图片链接及文件？\n${section.imagePath}${localNotice}`)) return
    const previousMarkdown = this.markdownText
    const previousSections = this.sections
    const data = await entry.async('uint8array')
    this.pushUndoAction({ type: 'restore-markdown-and-image', markdown: previousMarkdown, zipPath, data })
    this.zip.remove(zipPath)
    this.pendingDeletedAssets.add(zipPath)
    this.revokeAssetUrl(zipPath)
    this.markdownText = previousMarkdown.slice(0, section.start) + previousMarkdown.slice(section.end)
    this.reviewEdits.push({
      type: 'remove-image-and-reference',
      imagePath: section.imagePath,
      timestamp: new Date().toISOString(),
      page: section.page,
      blockId: section.blockId,
      markdownStart: section.start,
    })
    this.refreshSectionsPreservingMatches(previousSections)
    this.rebuildMarkdownView()
  }

  private wrapEditorSelection(textarea: HTMLTextAreaElement, prefix: string, suffix: string) {
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const selected = textarea.value.slice(start, end)
    if ((prefix === '## ' || prefix === '> ') && start > 0) {
      const lineStart = textarea.value.lastIndexOf('\n', start - 1) + 1
      textarea.setRangeText(prefix, lineStart, lineStart, 'end')
      textarea.focus()
      return
    }
    textarea.setRangeText(prefix + selected + suffix, start, end, 'select')
    textarea.selectionStart = start + prefix.length
    textarea.selectionEnd = start + prefix.length + selected.length
    textarea.focus()
  }

  private replaceMarkdownRange(start: number, end: number, replacement: string, edit: ReviewEdit) {
    if (this.markdownText == null) return
    const previousMarkdown = this.markdownText
    const previousSections = this.sections
    const anchor = previousSections.find(section => section.start <= start && section.end > start)
      || previousSections.find(section => section.start >= start)
    edit.markdownStart ??= start
    edit.page ??= anchor?.page
    edit.blockId ??= anchor?.blockId
    this.pushUndoAction({ type: 'restore-markdown', markdown: previousMarkdown })
    this.markdownText = previousMarkdown.slice(0, start) + replacement + previousMarkdown.slice(end)
    this.reviewEdits.push(edit)
    this.refreshSectionsPreservingMatches(previousSections)
    this.rebuildMarkdownView()
  }

  private refreshSectionsPreservingMatches(previous: MdSection[]) {
    const next = parseMarkdownSections(this.markdownText || '')
    let prefix = 0
    while (prefix < previous.length && prefix < next.length && previous[prefix].raw === next[prefix].raw) prefix++
    let suffix = 0
    while (
      suffix < previous.length - prefix
      && suffix < next.length - prefix
      && previous[previous.length - 1 - suffix].raw === next[next.length - 1 - suffix].raw
    ) suffix++

    const copyMatch = (target: MdSection, source: MdSection): MdSection => ({
      ...target,
      page: source.page,
      bbox: source.bbox,
      blockId: source.blockId,
    })
    for (let index = 0; index < prefix; index++) next[index] = copyMatch(next[index], previous[index])
    for (let index = 0; index < suffix; index++) {
      const nextIndex = next.length - 1 - index
      const previousIndex = previous.length - 1 - index
      next[nextIndex] = copyMatch(next[nextIndex], previous[previousIndex])
    }

    const oldMiddle = previous.slice(prefix, previous.length - suffix)
    const newMiddle = next.slice(prefix, next.length - suffix)
    if (oldMiddle.length === newMiddle.length) {
      for (let index = 0; index < newMiddle.length; index++) {
        next[prefix + index] = copyMatch(newMiddle[index], oldMiddle[index])
      }
    } else if (newMiddle.length) {
      let fromBlock = 0
      let initialPage = 1
      for (let index = prefix - 1; index >= 0; index--) {
        const located = this.blocks.findIndex(block => block.id === previous[index].blockId)
        if (located >= 0) {
          fromBlock = located + 1
          initialPage = previous[index].page || 1
          break
        }
      }
      let toBlock = this.blocks.length
      for (let index = 0; index < suffix; index++) {
        const source = previous[previous.length - 1 - index]
        const located = this.blocks.findIndex(block => block.id === source.blockId)
        if (located >= 0) {
          toBlock = located
          break
        }
      }
      if (toBlock < fromBlock) toBlock = fromBlock
      const matched = matchSectionsToPdf(newMiddle, this.blocks, { fromBlock, toBlock, initialPage })
      for (let index = 0; index < matched.length; index++) next[prefix + index] = matched[index]
    }
    this.sections = next
    this.syncMarkdownIntoJson()
    // Every Markdown edit path funnels through here, so this is the one place
    // that has to tell the other windows the document changed.
    this.publishDocumentChange()
  }

  private toggleFindBar(open: boolean) {
    const bar = this.shadowRoot?.getElementById('findBar')
    bar?.classList.toggle('open', open)
    if (open) {
      this.updateSearchResults()
      ;(this.shadowRoot?.getElementById('findText') as HTMLInputElement | null)?.focus()
    }
  }

  private brokenImageSections(): MdSection[] {
    if (!this.zip) return []
    return this.sections.filter(section => {
      if (section.kind !== 'image' || !section.imagePath) return false
      if (/^(?:https?:|data:|blob:)/i.test(section.imagePath)) return false
      return !this.zip!.file(this.resolveAssetPath(section.imagePath))
    })
  }

  private removeBrokenImageReferences() {
    if (this.markdownText == null) return
    const broken = this.brokenImageSections()
    if (!broken.length) {
      this.setFindResult('没有失效图片链接')
      return
    }
    const examples = broken.slice(0, 4).map(section => `• ${section.imagePath}`).join('\n')
    if (!confirm(`发现 ${broken.length} 个本地文件不存在的图片链接，确认全部删除？\n\n${examples}${broken.length > 4 ? '\n…' : ''}`)) return
    let next = this.markdownText
    for (const section of [...broken].sort((a, b) => b.start - a.start)) {
      next = next.slice(0, section.start) + next.slice(section.end)
    }
    const first = broken[0]
    this.replaceMarkdownRange(0, this.markdownText.length, next, {
      type: 'remove-image-reference',
      detail: `批量删除 ${broken.length} 个失效图片链接`,
      timestamp: new Date().toISOString(),
      page: first.page,
      blockId: first.blockId,
      markdownStart: first.start,
    })
    this.setFindResult(`已删除 ${broken.length} 个失效图片链接`)
  }

  private findNext() {
    if (!this.searchResults.length) this.updateSearchResults()
    if (!this.searchResults.length) return
    let index = this.searchResults.findIndex(result => result.start >= this.findCursor)
    if (index < 0) index = 0
    this.goToSearchResult(index)
  }

  private replaceCurrentMatch() {
    const replaceInput = this.shadowRoot?.getElementById('replaceText') as HTMLInputElement | null
    if (!this.buildSearchRegex(false)) return
    let result = this.searchResults.find(item => item.start === this.currentFindStart)
    if (!result) {
      this.findNext()
      result = this.searchResults.find(item => item.start === this.currentFindStart)
      if (!result) return
    }
    const start = result.start
    const replacementPattern = replaceInput?.value || ''
    const singleExpression = this.buildSearchRegex(false)!
    const replacement = result.match.replace(singleExpression, replacementPattern)
    if (this.markdownMode === 'source' && this.sourceEditor) {
      this.sourceEditor.view.dispatch({ changes: { from: start, to: result.end, insert: replacement } })
      this.sourceDraft = this.sourceEditor.getValue()
    } else {
      this.replaceMarkdownRange(start, result.end, replacement, {
        type: 'replace-text',
        detail: `替换：${result.match}`,
        timestamp: new Date().toISOString(),
      })
    }
    this.findCursor = start + replacement.length
    this.currentFindStart = -1
    this.updateSearchResults()
    this.findNext()
  }

  private replaceAllMatches() {
    if (this.markdownText == null && !this.sourceEditor) return
    const replaceInput = this.shadowRoot?.getElementById('replaceText') as HTMLInputElement | null
    const expression = this.buildSearchRegex(true)
    if (!expression) return
    const replacement = replaceInput?.value || ''
    const currentDocument = this.currentMarkdownDocument()
    const count = Array.from(currentDocument.matchAll(expression)).length
    expression.lastIndex = 0
    const next = currentDocument.replace(expression, replacement)
    if (!count) return this.setFindResult('未找到')
    if (this.markdownMode === 'source' && this.sourceEditor) {
      this.sourceEditor.view.dispatch({ changes: { from: 0, to: currentDocument.length, insert: next } })
      this.sourceDraft = next
    } else {
      this.replaceMarkdownRange(0, currentDocument.length, next, {
        type: 'replace-text',
        detail: `正则/查找全部替换 ${count} 处`,
        timestamp: new Date().toISOString(),
      })
    }
    this.currentFindStart = -1
    this.findCursor = 0
    this.updateSearchResults()
    this.setFindResult(`已替换 ${count} 处`)
  }

  private updateSearchResults() {
    const container = this.shadowRoot?.getElementById('findResults')
    const input = this.shadowRoot?.getElementById('findText') as HTMLInputElement | null
    if (!container || !input) return
    const query = input.value
    container.innerHTML = ''
    this.searchResults = []
    if (!query) {
      this.setFindResult('')
      this.clearSearchHighlights()
      return
    }

    const documentText = this.currentMarkdownDocument()
    const expression = this.buildSearchRegex(true)
    if (!expression) {
      this.clearSearchHighlights()
      return
    }
    let match: RegExpExecArray | null
    while ((match = expression.exec(documentText)) && this.searchResults.length < 1000) {
      const start = match.index
      const end = start + match[0].length
      const sectionIndex = this.sections.findIndex(section => section.start <= start && section.end > start)
      const lineStart = documentText.lastIndexOf('\n', start - 1) + 1
      const nextLine = documentText.indexOf('\n', end)
      const lineEnd = nextLine < 0 ? documentText.length : nextLine
      const snippet = documentText.slice(lineStart, lineEnd).trim().replace(/\s+/g, ' ')
      this.searchResults.push({ start, end, sectionIndex, snippet, match: match[0] })
      if (match[0].length === 0) expression.lastIndex++
    }

    this.searchResults.forEach((result, index) => {
      const button = document.createElement('button')
      button.className = 'find-result-item'
      const section = this.sections[result.sectionIndex]
      button.textContent = `${index + 1}. ${section?.page ? `p${section.page} · ` : ''}${result.snippet}`
      button.title = result.snippet
      button.addEventListener('click', () => this.goToSearchResult(index))
      container.appendChild(button)
    })
    this.setFindResult(`${this.searchResults.length} 处`)
    this.applySearchHighlights()
  }

  private buildSearchRegex(global: boolean): RegExp | null {
    const query = (this.shadowRoot?.getElementById('findText') as HTMLInputElement | null)?.value || ''
    if (!query) {
      this.setFindResult('请输入内容')
      return null
    }
    const regexMode = (this.shadowRoot?.getElementById('findRegex') as HTMLInputElement | null)?.checked
    const caseSensitive = (this.shadowRoot?.getElementById('findCase') as HTMLInputElement | null)?.checked
    const pattern = regexMode ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    try {
      return new RegExp(pattern, `${global ? 'g' : ''}${caseSensitive ? '' : 'i'}u`)
    } catch (error) {
      this.setFindResult(`正则错误：${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  private goToSearchResult(index: number) {
    if (this.previewBuild) {
      void this.waitForPreview().then(() => this.goToSearchResult(index))
      return
    }
    const result = this.searchResults[index]
    if (!result) return
    this.currentFindStart = result.start
    this.findCursor = result.end
    this.shadowRoot?.querySelectorAll('.find-result-item').forEach((item, itemIndex) => {
      item.classList.toggle('active', itemIndex === index)
    })
    if (this.markdownMode === 'source' && this.sourceEditor) {
      this.sourceEditor.goTo(result.start, result.end - result.start)
    } else {
      const element = this.shadowRoot?.querySelector(`[data-idx="${result.sectionIndex}"]`) as HTMLElement | null
      if (element) {
        this.shadowRoot?.querySelectorAll('.md-preview .active').forEach(item => item.classList.remove('active'))
        element.classList.add('active')
        element.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
      const section = this.sections[result.sectionIndex]
      if (section && element) this.onMdClick(section, result.sectionIndex, element)
    }
    this.setFindResult(`${index + 1}/${this.searchResults.length}`)
  }

  private currentMarkdownDocument(): string {
    return this.markdownMode === 'source'
      ? this.sourceEditor?.getValue() ?? this.sourceDraft
      : this.markdownText || ''
  }

  private clearSearchHighlights() {
    const preview = this.shadowRoot?.querySelector('.md-preview')
    if (!preview) return
    preview.querySelectorAll('mark.search-hit').forEach(mark => mark.replaceWith(document.createTextNode(mark.textContent || '')))
    preview.normalize()
  }

  private applySearchHighlights(root?: HTMLElement) {
    const preview = root || this.shadowRoot?.querySelector<HTMLElement>('.md-preview')
    if (!preview) return
    this.clearSearchHighlights()
    const input = this.shadowRoot?.getElementById('findText') as HTMLInputElement | null
    const query = input?.value || ''
    if (!query) return
    const expression = this.buildSearchRegex(true)
    if (!expression) return
    const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT)
    const nodes: Text[] = []
    let node: Node | null
    while ((node = walker.nextNode())) {
      const parent = node.parentElement
      if (!parent || parent.closest('button,textarea,mark,.preview-image-actions')) continue
      expression.lastIndex = 0
      if (expression.test(node.textContent || '')) nodes.push(node as Text)
    }
    for (const textNode of nodes) {
      const text = textNode.data
      const fragment = document.createDocumentFragment()
      let cursor = 0
      expression.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = expression.exec(text))) {
        if (match.index > cursor) fragment.append(text.slice(cursor, match.index))
        const mark = document.createElement('mark')
        mark.className = 'search-hit'
        mark.textContent = match[0]
        fragment.append(mark)
        cursor = match.index + match[0].length
        if (match[0].length === 0) expression.lastIndex++
      }
      if (cursor < text.length) fragment.append(text.slice(cursor))
      textNode.replaceWith(fragment)
    }
  }

  private setFindResult(message: string) {
    const result = this.shadowRoot?.getElementById('findResult')
    if (result) result.textContent = message
  }

  private async saveMarkdownToFolder() {
    if ((!this.sourceDirectoryHandle && !this.sourceMarkdownFileHandle) || this.markdownText == null || !this.markdownPath) return
    if (this.markdownMode === 'live') this.finishLiveEdit(false)
    if (this.markdownMode === 'source') this.saveSourceAndPreview()
    const markdownRelativePath = this.sourceDirectoryHandle
      ? this.relativeToSourceRoot(this.markdownPath)
      : this.sourceMarkdownFileHandle!.name
    const assetCount = this.pendingDeletedAssets.size
    if (!this.flushDocumentSync()) {
      alert('JSON 格式不正确，尚未保存')
      return
    }
    const jsonRelativePath = this.sourceDirectoryHandle && this.syncedJsonPath
      ? this.relativeToSourceRoot(this.syncedJsonPath)
      : ''
    const message = `确认覆盖本地文件？\n\n${markdownRelativePath}`
      + (jsonRelativePath ? `\n${jsonRelativePath}` : '')
      + (assetCount ? `\n\n并永久删除 ${assetCount} 个本地图片文件。` : '')
    if (!confirm(message)) return
    const button = this.shadowRoot?.getElementById('saveLocalMarkdown') as HTMLButtonElement | null
    if (button) {
      button.disabled = true
      button.textContent = '正在保存…'
    }
    try {
      if (this.sourceMarkdownFileHandle) {
        const writable = await this.sourceMarkdownFileHandle.createWritable()
        await writable.write(this.markdownText)
        await writable.close()
      } else {
        await this.writeLocalFile(markdownRelativePath, this.markdownText)
        this.zip?.file(this.markdownPath, this.markdownText)
        if (jsonRelativePath && this.syncedJsonText != null) {
          await this.writeLocalFile(jsonRelativePath, this.syncedJsonText)
          this.zip?.file(this.syncedJsonPath, this.syncedJsonText)
        }
        for (const zipPath of this.pendingDeletedAssets) {
          await this.removeLocalFile(this.relativeToSourceRoot(zipPath))
        }
        this.pendingDeletedAssets.clear()
      }
      this.setStatus(`已覆盖保存 ${markdownRelativePath}`)
      if (button) button.textContent = '已保存到本地'
    } catch (error) {
      alert(`保存失败：${error instanceof Error ? error.message : String(error)}`)
      if (button) button.textContent = '保存失败'
    } finally {
      setTimeout(() => {
        if (!button) return
        button.textContent = `覆盖保存 ${this.documentFormat === 'org' ? 'Org' : 'Markdown'}`
        button.disabled = !this.sourceDirectoryHandle && !this.sourceMarkdownFileHandle
      }, 1400)
    }
  }

  private relativeToSourceRoot(path: string): string {
    const normalized = normalizeAssetPath(path).replace(/^\/+/, '')
    const root = normalizeAssetPath(this.sourceDirectoryHandle?.name || '')
    const relative = root && normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized
    if (!relative || relative.split('/').includes('..')) throw new Error(`不安全的本地路径：${path}`)
    return relative
  }

  private async localParent(path: string): Promise<{ parent: FileSystemDirectoryHandle; name: string }> {
    if (!this.sourceDirectoryHandle) throw new Error('没有文件夹写入权限')
    const parts = path.split('/').filter(Boolean)
    const name = parts.pop()
    if (!name) throw new Error(`无效路径：${path}`)
    let parent = this.sourceDirectoryHandle
    for (const part of parts) parent = await parent.getDirectoryHandle(part)
    return { parent, name }
  }

  private async writeLocalFile(path: string, data: string) {
    const { parent, name } = await this.localParent(path)
    const handle = await parent.getFileHandle(name, { create: true })
    const writable = await handle.createWritable()
    await writable.write(data)
    await writable.close()
  }

  private async removeLocalFile(path: string) {
    const { parent, name } = await this.localParent(path)
    await parent.removeEntry(name)
  }

  private pickMarkdownPath(names: string[]): string {
    const markdownFiles = names.filter(name => /\.md$/i.test(name))
    return markdownFiles.find(name => /(?:^|\/)full\.md$/i.test(name))
      || markdownFiles.sort((a, b) => a.split('/').length - b.split('/').length)[0]
      || ''
  }

  private resolveAssetPath(imagePath: string): string {
    if (!this.zip) return normalizeAssetPath(imagePath)
    const normalized = normalizeAssetPath(imagePath).replace(/^\/+/, '')
    if (normalized.split('/').includes('..')) return '__invalid_asset_path__'
    const markdownDirectory = this.markdownPath.includes('/')
      ? this.markdownPath.slice(0, this.markdownPath.lastIndexOf('/') + 1)
      : ''
    const candidates = [normalized, markdownDirectory + normalized]
    for (const candidate of candidates) {
      if (this.zip.file(candidate)) return candidate
    }

    const filename = normalized.slice(normalized.lastIndexOf('/') + 1)
    const sameName = Object.keys(this.zip.files).filter(name =>
      !this.zip!.files[name].dir && name.slice(name.lastIndexOf('/') + 1) === filename,
    )
    return sameName.length === 1 ? sameName[0] : markdownDirectory + normalized
  }

  private async hydrateAsset(path: string): Promise<void> {
    const asset = this.deferredAssets.get(path)
    const archive = this.zip
    if (!asset || !archive) return
    if (!asset.loading) {
      asset.loading = (async () => {
        const response = await fetch(asset.url)
        if (!response.ok) throw new Error(`读取图片失败：HTTP ${response.status}`)
        const blob = await response.blob()
        if (this.zip !== archive || this.deferredAssets.get(path) !== asset) return
        archive.file(path, blob)
        this.deferredAssets.delete(path)
      })().catch(error => {
        asset.loading = undefined
        throw error
      })
    }
    await asset.loading
  }

  private async getAssetUrl(imagePath: string): Promise<string> {
    // Split panes borrow the owner's cache and channels (ZIP, directory
    // handle, or sibling files) so images work identically in every pane.
    if (this.assetUrlDelegate) return this.assetUrlDelegate(imagePath)
    if (!this.zip) {
      if (this.siblingAssetSource) return this.fetchSiblingAsset(imagePath)
      throw new Error('图片预览需要 MinerU ZIP/文件夹，或通过本地服务打开 Markdown 文件')
    }
    const archive = this.zip
    const zipPath = this.resolveAssetPath(imagePath)
    const cached = this.assetUrls.get(zipPath)
    if (cached) return cached
    await this.hydrateAsset(zipPath)
    if (this.zip !== archive) throw new Error('文档已切换')
    const loaded = this.assetUrls.get(zipPath)
    if (loaded) return loaded
    const entry = this.zip.file(zipPath)
    if (!entry) throw new Error(`ZIP 中找不到图片：${zipPath}`)
    const blob = await entry.async('blob')
    const url = URL.createObjectURL(blob)
    this.assetUrls.set(zipPath, url)
    return url
  }

  /** Fetch an image stored next to a standalone Markdown launched by the local server. */
  private async fetchSiblingAsset(imagePath: string): Promise<string> {
    const location = this.siblingAssetSource!
    const relative = normalizeAssetPath(imagePath).replace(/^\/+/, '')
    if (!relative || relative.split('/').includes('..')) throw new Error(`不安全的图片路径：${imagePath}`)
    const key = `sibling:${relative}`
    const cached = this.assetUrls.get(key)
    if (cached) return cached
    const params = new URLSearchParams({ token: location.token, launch: location.launch, path: relative })
    const response = await fetch(`/__viewer/file?${params.toString()}`)
    if (!response.ok) throw new Error(`读取图片失败：HTTP ${response.status}`)
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    this.assetUrls.set(key, url)
    return url
  }

  private canonicalExtension(path: string): string {
    const clean = path.split(/[?#]/, 1)[0]
    const extension = clean.includes('.') ? clean.slice(clean.lastIndexOf('.') + 1).toLowerCase() : ''
    return extension === 'jpg' ? 'jpeg' : extension
  }

  private revokeAssetUrl(zipPath: string) {
    const url = this.assetUrls.get(zipPath)
    if (url) URL.revokeObjectURL(url)
    this.assetUrls.delete(zipPath)
  }

  private revokeAssetUrls() {
    for (const url of this.assetUrls.values()) URL.revokeObjectURL(url)
    this.assetUrls.clear()
  }

  private revokeOwnedPdfUrl() {
    if (this.ownedPdfUrl) URL.revokeObjectURL(this.ownedPdfUrl)
    this.ownedPdfUrl = null
  }

  // ── Multiple windows ───────────────────────────────────────────────────────
  //
  // Every viewer window that was opened by the "新窗口" button joins one
  // BroadcastChannel. The document text is the single source of truth, so a
  // message carries the whole text plus a clock-derived revision; a receiver
  // drops anything older than what it already applied. View modes stay local,
  // so one window can sit on the mind map while another shows the code.
  //
  // The handshake is deliberately one-directional: a new window asks for the
  // document, nobody pushes it. A launcher window loads the file over HTTP
  // itself, so it only asks once that load has settled — otherwise its own
  // fetch would overwrite the edits a peer just handed over.

  private setupWindowChannel(force = false) {
    if (this.windowChannel) return
    const params = new URLSearchParams(location.search)
    // An ordinary visit stays a single window; 新窗口 force-joins the opener.
    if (!force && !params.get('window')) return
    this.windowChannel = new ViewerWindowChannel()
    this.windowChannel.subscribe(message => this.onWindowMessage(message))
    if (params.get('launch') && params.get('token')) {
      this.windowReadyTimer = setTimeout(() => this.requestWindowDocument(), 6000)
    } else {
      this.requestWindowDocument()
    }
  }

  private teardownWindowChannel() {
    if (this.windowReadyTimer) clearTimeout(this.windowReadyTimer)
    this.windowReadyTimer = null
    const channel = this.windowChannel
    if (!channel) return
    channel.post({ type: 'bye', windowId: channel.windowId })
    channel.close()
    this.windowChannel = null
    this.windowPeers.clear()
  }

  private requestWindowDocument() {
    const channel = this.windowChannel
    if (!channel) return
    channel.post({ type: 'request-document', windowId: channel.windowId })
  }

  /** Called once a document is on screen: a launcher window is ready to merge. */
  private announceWindowReady() {
    if (!this.windowChannel) return
    const params = new URLSearchParams(location.search)
    if (!params.get('launch') || !params.get('token')) return
    if (this.windowReadyTimer) clearTimeout(this.windowReadyTimer)
    this.windowReadyTimer = null
    this.requestWindowDocument()
  }

  private onWindowMessage(message: ViewerWindowMessage) {
    const channel = this.windowChannel
    if (!channel) return
    if ('windowId' in message && message.windowId) this.windowPeers.add(message.windowId)
    switch (message.type) {
      case 'hello':
        channel.post({ type: 'welcome', windowId: channel.windowId })
        return
      case 'request-document':
        if (this.markdownText != null) this.publishDocumentChange()
        return
      case 'document':
        this.adoptRemoteDocument(message.document, message.revision)
        return
      case 'bye':
        this.windowPeers.delete(message.windowId)
        return
      default:
        return
    }
  }

  private publishDocumentChange() {
    const channel = this.windowChannel
    if (!channel || this.suppressDocumentBroadcast || this.markdownText == null) return
    this.documentRevision = Date.now()
    channel.post({
      type: 'document',
      windowId: channel.windowId,
      revision: this.documentRevision,
      document: {
        text: this.markdownText,
        format: this.documentFormat,
        name: this.sourceZipName || this.markdownPath || this.mindmapDocumentTitle(),
        mode: this.markdownMode,
      },
    })
  }

  private adoptRemoteDocument(document: ViewerDocumentPayload, revision: number) {
    if (revision <= this.appliedRemoteRevision) return
    this.appliedRemoteRevision = revision
    this.documentRevision = revision
    if (document.text === this.markdownText) return
    if (this.markdownMode === 'source') {
      const draft = this.sourceEditor?.getValue() ?? this.sourceDraft
      if (draft !== (this.markdownText || '')) {
        this.setStatus('另一个窗口修改了文档，请先保存或取消 code 模式中的改动')
        return
      }
    }
    const firstDocument = this.markdownText == null
    this.suppressDocumentBroadcast = true
    try {
      const previousSections = this.sections
      const previous = this.markdownText || ''
      if (this.documentFormat !== document.format) {
        this.documentFormat = document.format
        this.activateDefaultRenderPlugin(this.documentFormat)
      }
      if (!this.sourceZipName || this.sourceZipName === 'mineru-result.zip') this.sourceZipName = document.name
      this.markdownText = document.text
      if (previous) this.pushUndoAction({ type: 'restore-markdown', markdown: previous })
      this.refreshSectionsPreservingMatches(previousSections)
    } finally {
      this.suppressDocumentBroadcast = false
    }
    if (firstDocument) {
      // A window opened by 新窗口 starts on the home page, so it has to be told
      // to reveal the viewer before it can show anything.
      this.dispatchEvent(new CustomEvent('mineru-viewer-show-document', { bubbles: true, composed: true }))
      this.standaloneMarkdown = true
      if (isMarkdownViewMode(document.mode)) this.markdownMode = document.mode
      this.rebuildSequence++
      this.buildUI()
    } else if (this.markdownMode === 'mindmap') {
      // Re-rendering the canvas keeps the pan, zoom and folding the user set up.
      this.mindmapTree = parseMindmapTree(this.markdownText || '', {
        format: this.documentFormat,
        title: this.mindmapDocumentTitle(),
      })
      this.ensureMindmapSelection()
      this.renderMindmapCanvas()
      this.renderMarkdownOutline()
      this.updateToolbar()
    } else {
      this.rebuildMarkdownView()
    }
    this.setStatus('已同步另一个窗口的修改')
  }

  /**
   * VS Code 式分屏：在 Markdown 区新增一个完整的查看器实例。分屏栏自己也能
   * 继续分屏（左-右、右再上-下这类不对称布局），各栏模式独立，文档经
   * BroadcastChannel 实时双向同步（与跨窗口共用一套机制）。
   */
  private addSplitPane(direction: 'row' | 'column') {
    if (this.markdownText == null) {
      this.setStatus('请先打开 Markdown 或 Org 文档')
      return
    }
    if (this.splitPanes.length >= 3) {
      this.setStatus('每栏最多再分出 3 栏')
      return
    }
    const grid = this.shadowRoot?.getElementById('mdSplitGrid')
    if (!grid) return
    this.splitDirection = direction
    const pane = document.createElement('mineru-layout-viewer') as MineruLayoutViewer
    pane.embeddedPane = true
    pane.ownerViewer = this
    // 图片走主栏的缓存与通道（ZIP、目录句柄、同目录文件通吃）。
    pane.assetUrlDelegate = imagePath => this.getAssetUrl(imagePath)
    grid.appendChild(pane)
    this.splitPanes.push(pane)
    // 既有栏按比例让出空间，新栏拿平均份额，拖拽好的比例不会被重置。
    const count = this.splitPanes.length + 1
    if (this.splitFractions.length !== count - 1) {
      this.splitFractions = Array.from({ length: count - 1 }, () => 1 / (count - 1))
    }
    this.splitFractions = this.splitFractions.map(fraction => fraction * (count - 1) / count)
    this.splitFractions.push(1 / count)
    this.layoutSplitGrid()
    this.setupWindowChannel(true)
    const extension = this.documentFormat === 'org' ? 'org' : 'md'
    const base = (this.markdownPath || this.sourceZipName || `文档.${extension}`).replace(/\.[a-z0-9]+$/i, '')
    const file = new File([this.markdownText], `${base || '文档'}.${extension}`)
    void pane.loadMarkdownFile(file, undefined, { siblingAssets: this.siblingAssetSource ?? undefined })
      .then(() => pane.setupWindowChannel(true))
      .catch(error => this.setStatus(`分屏打开失败：${error instanceof Error ? error.message : String(error)}`))
    this.setStatus(`已${direction === 'row' ? '向右' : '向下'}分屏，两栏的修改会实时同步`)
  }

  /** Called by an embedded pane's 关闭分屏 button; also used for cleanup. */
  removeSplitPane(pane: MineruLayoutViewer) {
    const index = this.splitPanes.indexOf(pane)
    if (index < 0) return
    this.splitPanes.splice(index, 1)
    // 关掉的栏把空间按比例还给剩下的栏。
    this.splitFractions.splice(index + 1, 1)
    const sum = this.splitFractions.reduce((total, fraction) => total + fraction, 0)
    if (this.splitFractions.length > 0 && sum > 0) {
      this.splitFractions = this.splitFractions.map(fraction => fraction / sum)
    }
    pane.ownerViewer = null
    pane.remove()
    this.layoutSplitGrid()
  }

  private closeAllSplitPanes() {
    for (const pane of [...this.splitPanes]) this.removeSplitPane(pane)
  }

  private layoutSplitGrid() {
    const grid = this.shadowRoot?.getElementById('mdSplitGrid')
    if (!grid) return
    const count = this.splitPanes.length + 1
    if (count === 1) this.splitFractions = []
    if (this.splitFractions.length !== count) {
      this.splitFractions = Array.from({ length: count }, () => 1 / count)
    }
    grid.classList.toggle('has-splits', this.splitPanes.length > 0)
    grid.classList.toggle('dir-row', this.splitDirection === 'row')
    grid.classList.toggle('dir-column', this.splitDirection === 'column')
    // 分隔条插在栏与栏之间：mdPane, [divider, splitPane]…
    grid.querySelectorAll(':scope > .split-divider').forEach(divider => divider.remove())
    for (let index = 1; index < count; index += 1) {
      const divider = document.createElement('div')
      divider.className = 'split-divider'
      divider.title = '拖动调整分栏大小'
      divider.setAttribute('role', 'separator')
      grid.insertBefore(divider, this.splitPanes[index - 1])
      divider.addEventListener('pointerdown', event => this.onSplitDividerPointerdown(event, index, divider))
    }
    this.applySplitTracks()
  }

  /** 按 splitFractions 计算 grid 轨道，栏间是 6px 的分隔条轨道。 */
  private applySplitTracks() {
    const grid = this.shadowRoot?.getElementById('mdSplitGrid')
    if (!grid) return
    const tracks: string[] = []
    for (let index = 0; index < this.splitFractions.length; index += 1) {
      if (index > 0) tracks.push('6px')
      tracks.push(`${(this.splitFractions[index] * 1000).toFixed(2)}fr`)
    }
    const template = tracks.join(' ')
    grid.style.gridTemplateColumns = this.splitDirection === 'row' ? template : 'minmax(0, 1fr)'
    grid.style.gridTemplateRows = this.splitDirection === 'column' ? template : 'minmax(0, 1fr)'
  }

  /** 拖动分隔条：调整相邻两栏的份额，每栏至少保留 140px。 */
  private onSplitDividerPointerdown(event: PointerEvent, index: number, divider: HTMLElement) {
    if (event.button !== 0) return
    const grid = this.shadowRoot?.getElementById('mdSplitGrid')
    if (!grid || index < 1 || index >= this.splitFractions.length) return
    event.preventDefault()
    const horizontal = this.splitDirection === 'row'
    const dividerTracks = 6 * (this.splitFractions.length - 1)
    const availablePx = Math.max(1, (horizontal ? grid.clientWidth : grid.clientHeight) - dividerTracks)
    const totalFr = this.splitFractions.reduce((total, fraction) => total + fraction, 0)
    const before0 = this.splitFractions[index - 1]
    const after0 = this.splitFractions[index]
    const pair = before0 + after0
    // 每栏至少 140px；空间不足两栏最小值时放宽到 45%，避免钳制把两栏锁死在 50/50。
    const minFr = Math.min(140 / availablePx * totalFr, pair * 0.45)
    const startPos = horizontal ? event.clientX : event.clientY
    grid.classList.add('split-dragging')
    divider.classList.add('dragging')
    divider.setPointerCapture(event.pointerId)
    const onMove = (move: PointerEvent) => {
      const delta = ((horizontal ? move.clientX : move.clientY) - startPos) / availablePx * totalFr
      const before = Math.min(Math.max(before0 + delta, minFr), pair - minFr)
      this.splitFractions[index - 1] = before
      this.splitFractions[index] = pair - before
      this.applySplitTracks()
    }
    const onUp = () => {
      divider.removeEventListener('pointermove', onMove)
      grid.classList.remove('split-dragging')
      divider.classList.remove('dragging')
    }
    divider.addEventListener('pointermove', onMove)
    divider.addEventListener('pointerup', onUp, { once: true })
    divider.addEventListener('pointercancel', onUp, { once: true })
  }

  private resetReviewState() {
    this.closeAllSplitPanes()
    this.sourceLineCache = null
    ++this.rebuildSequence
    this.deferredAssets.clear()
    this.sourceEditor?.destroy()
    this.sourceEditor = null
    this.markdownMode = 'preview'
    this.sourceDraft = ''
    this.mindmapTree = null
    this.mindmapLayout = null
    this.mindmapCollapsed = new Set()
    this.mindmapSelected = null
    this.mindmapEditing = null
    this.mindmapDrag = null
    this.mindmapZoom = 1
    this.mindmapPan = { x: 0, y: 0 }
    this.pdfPageObserver?.disconnect()
    this.pdfPageObserver = null
    this.releaseAllPdfPages()
    void this.pdfDocument?.destroy()
    this.pdfDocument = null
    this.revokeAssetUrls()
    this.revokeOwnedPdfUrl()
    this.zip = null
    this.markdownPath = ''
    this.markdownText = null
    this.layoutData = null
    this.contentListData = null
    this.contentListV2Data = null
    this.contentListPath = ''
    this.contentListV2Path = ''
    this.layoutPath = ''
    this.syncedJsonPath = ''
    this.syncedJsonText = null
    this.syncedJsonKind = ''
    this.documentView = 'markdown'
    if (this.jsonSyncTimer) clearTimeout(this.jsonSyncTimer)
    this.jsonSyncTimer = null
    this.pdfUrl = null
    this.externalPdfUrl = null
    this.externalPdfPath = ''
    this.renderedPdfUrl = null
    this.pages = []
    this.blocks = []
    this.sections = []
    this.undoStack = []
    this.redoStack = []
    this.redoEdits = []
    this.reviewEdits = []
    this.sourceDirectoryHandle = null
    this.sourceMarkdownFileHandle = null
    this.launcherLocation = null
    this.siblingAssetSource = null
    this.pendingDeletedAssets.clear()
    this.standaloneMarkdown = false
    this.documentFormat = 'markdown'
    this.liveEditSession = null
    this.pdfOutline = []
  }

  private startLoadProgress(label: string) {
    if (this.progressHideTimer) clearTimeout(this.progressHideTimer)
    this.progressHideTimer = null
    this.progressStartedAt = performance.now()
    this.progressEstimateKey = ''
    this.progressEstimateStartedAt = this.progressStartedAt
    this.setLoadProgress(0, label)
  }

  private beginProgressEstimate(key: string) {
    this.progressEstimateKey = key
    this.progressEstimateStartedAt = performance.now()
  }

  private setLoadProgress(percent: number | null, label: string, estimate?: { key: string; ratio: number }) {
    const container = this.shadowRoot?.getElementById('loadProgress')
    const fill = this.shadowRoot?.getElementById('loadProgressFill') as HTMLElement | null
    const text = this.shadowRoot?.getElementById('loadProgressText')
    if (!container || !fill || !text) return
    container.classList.add('open')
    fill.classList.toggle('indeterminate', percent == null)
    if (percent == null) {
      fill.style.width = ''
      const elapsed = performance.now() - this.progressStartedAt
      text.textContent = `${label}${elapsed >= 1000 ? ` · 已用 ${this.formatDuration(elapsed)}` : ''}`
    } else {
      const safe = Math.max(0, Math.min(100, percent))
      fill.style.width = `${safe}%`
      let remaining = 0
      if (estimate) {
        if (this.progressEstimateKey !== estimate.key) {
          this.progressEstimateKey = estimate.key
          this.progressEstimateStartedAt = performance.now()
        }
        const elapsed = Math.max(0, performance.now() - this.progressEstimateStartedAt)
        const ratio = Math.max(0, Math.min(1, estimate.ratio))
        if (ratio >= .03 && ratio < 1 && elapsed >= 500) remaining = elapsed * (1 - ratio) / ratio
      } else {
        this.progressEstimateKey = ''
      }
      text.textContent = `${label} · 总体 ${Math.round(safe)}%${remaining ? ` · 本阶段约剩 ${this.formatDuration(remaining)}` : ''}`
    }
    this.setStatus(label)
  }

  private finishLoadProgress(message: string) {
    this.setLoadProgress(100, message)
    this.progressHideTimer = setTimeout(() => {
      this.shadowRoot?.getElementById('loadProgress')?.classList.remove('open')
      this.progressHideTimer = null
    }, 1400)
    this.setStatus(message)
  }

  private readBlobWithProgress(blob: Blob, onProgress: (loaded: number, total: number) => void): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onprogress = event => onProgress(event.loaded, event.total || blob.size)
      reader.onerror = () => reject(reader.error || new Error('读取文件失败'))
      reader.onload = () => resolve(reader.result as ArrayBuffer)
      reader.readAsArrayBuffer(blob)
    })
  }

  private formatDuration(milliseconds: number): string {
    const seconds = Math.max(1, Math.round(milliseconds / 1000))
    if (seconds < 60) return `${seconds} 秒`
    const minutes = Math.floor(seconds / 60)
    return `${minutes}分${seconds % 60}秒`
  }

  private formatBytes(bytes: number): string {
    if (!bytes) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB']
    const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
    return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`
  }

  private setStatus(message: string) {
    const stat = this.shadowRoot?.getElementById('stat')
    if (stat) stat.textContent = message
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('mineru-layout-viewer')) {
  customElements.define('mineru-layout-viewer', MineruLayoutViewer)
}
