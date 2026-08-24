import JSZip from 'jszip'
import { parseBlocks, normalizeAssetPath } from './parse-blocks.js'
import { matchMarkdownToPdf, matchSectionsToPdf, normalize, lcsSimilarity } from './match-markdown.js'
import { parseMarkdownSections } from './parse-markdown.js'
import { MarkdownPreviewRenderer, type MarkdownRenderPlugin } from './markdown-preview.js'
import { createElegantReadingTheme, createRichMarkdownPlugin } from './rich-markdown-plugin.js'
import { documentFormatFromName, orgToMarkdown, type DocumentFormat } from './org-format.js'
import {
  MarkdownSourceEditor,
  createVimEditorPlugin,
  type MarkdownEditorPlugin,
} from './markdown-source-editor.js'
import type { PdfBlock, MdSection } from './parse-blocks.js'

declare const pdfjsLib: typeof import('pdfjs-dist')

const RENDER_SCALE = 1.5

interface PdfPageState {
  p: number
  w: number
  h: number
  rendered: boolean
  rendering?: Promise<void>
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
}

const VIEWER_SETTINGS_KEY = 'mineru-layout-viewer-settings-v1'
const LEGACY_RENDER_PLUGIN_KEY = 'mineru-layout-viewer-default-render-plugin-v1'
const RENDER_PLUGIN_KEYS: Record<DocumentFormat, string> = {
  markdown: 'mineru-layout-viewer-default-markdown-plugin-v2',
  org: 'mineru-layout-viewer-default-org-plugin-v2',
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
}

const STYLES = `
:host { position:relative; display:flex; flex-direction:column; height:100%; font-family:system-ui,sans-serif; color:#1f2937; background:#fff; }
* { box-sizing:border-box; }
.toolbar { display:flex; align-items:center; gap:8px; padding:7px 10px; border-bottom:1px solid #e5e7eb; font-size:12px; color:#6b7280; flex-shrink:0; flex-wrap:wrap; }
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
.split:not(.workspace-stack):not(.swapped) .left-column .pane-toolbar,.split:not(.workspace-stack).swapped .right-column .pane-toolbar { padding-right:28px; }
.split:not(.workspace-stack):not(.swapped) .right-column .pane-toolbar,.split:not(.workspace-stack).swapped .left-column .pane-toolbar { padding-left:28px; }
.pane-toolbar .spacer { flex:1; }
.pane-toolbar button.active { border-color:#2563eb; color:#1d4ed8; background:#eff6ff; }
.menu-toggle { padding:4px 7px; font-size:16px; line-height:1; }
.history-panel { display:none; max-height:245px; overflow:auto; border-bottom:1px solid #e5e7eb; background:#fffbeb; flex-shrink:0; }
.history-panel.open { display:block; }
.history-empty { padding:12px; color:#92400e; font-size:12px; }
.history-item { display:block; width:100%; text-align:left; border:0; border-bottom:1px solid #fde68a; border-radius:0; padding:8px 10px; background:transparent; }
.history-item small { display:block; margin-top:2px; color:#78716c; }
.pane-body { flex:1; display:flex; min-width:0; min-height:0; overflow:hidden; --outline-size:33%; }
.pane-body.outline-stack { flex-direction:column; }
.outline-panel { display:none; flex:0 0 var(--outline-size); width:var(--outline-size); min-width:0; min-height:0; overflow:auto; background:#f8fafc; padding:5px 0; }
.pane-body.outline-open .outline-panel { display:block; }
.pane-body.outline-stack .outline-panel { width:auto; height:var(--outline-size); }
.outline-resizer { display:none; flex:0 0 6px; width:6px; cursor:col-resize; touch-action:none; background:linear-gradient(90deg,transparent 2px,#cbd5e1 2px,#cbd5e1 3px,transparent 3px); }
.pane-body.outline-open .outline-resizer { display:block; }
.pane-body.outline-stack .outline-resizer { width:auto; height:6px; cursor:row-resize; background:linear-gradient(transparent 2px,#cbd5e1 2px,#cbd5e1 3px,transparent 3px); }
.outline-item { display:block; width:100%; text-align:left; border:0; border-radius:0; padding:5px 9px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.outline-empty { padding:10px; color:#9ca3af; font-size:12px; }
.pane { flex:1; min-width:0; min-height:0; overflow:auto; padding:10px; }
.pane-left { background:#f8fafc; }
.pane-right { display:flex; flex-direction:column; background:#fff; --md-zoom:1; --md-image-width:100%; --md-image-height:520px; }
.pdf-page { position:relative; margin:0 auto 12px; border:1px solid #e5e7eb; border-radius:4px; overflow:hidden; background:#fff; }
.pdf-page > canvas { display:block; width:100%; height:100%; }
.pdf-placeholder { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:#9ca3af; font-size:12px; }
.pdf-page .page-num { position:absolute; bottom:2px; right:4px; font-size:9px; color:#6b7280; background:rgba(255,255,255,.9); padding:1px 4px; border-radius:3px; }
.block-overlay { position:absolute; border:1px solid rgba(37,99,235,.58); background:rgba(37,99,235,.035); cursor:pointer; transition:all .12s; }
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
.plugin-input { display:none; }
.legend { display:flex; align-items:center; gap:8px; font-size:10px; color:#6b7280; }
.legend i { display:inline-block; width:12px; height:8px; margin-right:3px; vertical-align:middle; border:1px solid #2563eb; }
.legend .visual { border:2px solid #f59e0b; }
.legend .removed { border:2px dashed #dc2626; background:rgba(220,38,38,.12); }
.md-preview { flex:none; width:100%; font-size:calc(15px * var(--md-zoom)); line-height:1.72; color:#1f2937; }
.md-preview h1,.md-preview h2,.md-preview h3,.md-preview h4 { line-height:1.32; margin:1.1em 0 .55em; color:#111827; }
.md-preview h1 { font-size:1.75em; border-bottom:1px solid #e5e7eb; padding-bottom:.3em; }
.md-preview h2 { font-size:1.45em; border-bottom:1px solid #e5e7eb; padding-bottom:.25em; }
.md-preview h3 { font-size:1.22em; }
.md-preview p { margin:.55em 0; }
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
.md-preview a { color:#2563eb; }
.md-preview img.md-asset { display:block; max-width:var(--md-image-width); max-height:var(--md-image-height); margin:8px auto; object-fit:contain; }
.md-preview [data-md-start-line] { border-radius:4px; transition:background .12s,box-shadow .12s; }
.md-preview [data-md-start-line]:hover { background:rgba(37,99,235,.045); box-shadow:inset 3px 0 0 rgba(37,99,235,.35); }
.md-preview [data-md-start-line].active { background:rgba(37,99,235,.08); box-shadow:inset 3px 0 0 #2563eb; }
.preview-image-actions { display:flex; justify-content:flex-end; gap:6px; margin:5px 0 10px; }
.inline-editor { margin:8px 0; border:1px solid #60a5fa; border-radius:7px; overflow:hidden; background:#fff; box-shadow:0 3px 12px rgba(37,99,235,.12); }
.inline-editor-tools { display:flex; align-items:center; gap:5px; padding:6px 8px; border-bottom:1px solid #dbeafe; background:#eff6ff; flex-wrap:wrap; }
.inline-editor-tools button.active { border-color:#2563eb; color:#1d4ed8; background:#dbeafe; }
.inline-editor-tools .spacer { flex:1; }
.inline-editor-tools select { border:1px solid #bfdbfe; border-radius:5px; padding:4px 6px; background:#fff; color:#1f2937; font:inherit; }
.inline-editor textarea { display:block; width:100%; min-height:120px; max-height:55vh; resize:vertical; border:0; outline:0; padding:10px; font:14px/1.65 'Cascadia Code',Consolas,monospace; }
.inline-editor-preview { min-height:120px; max-height:55vh; overflow:auto; padding:10px 16px; }
.inline-editor [hidden] { display:none!important; }
.live-preview-mode .live-editable { cursor:text; min-height:1.4em; outline:0; caret-color:#2563eb; }
.live-preview-mode .live-editable:hover { box-shadow:inset 3px 0 0 rgba(37,99,235,.3); }
.live-preview-mode .live-editable:focus { background:rgba(37,99,235,.045); box-shadow:inset 3px 0 0 #2563eb; }
.live-preview-mode .live-editable:empty::before { content:'输入内容…'; color:#94a3b8; }
.live-preview-mode .live-source-active { white-space:pre-wrap; word-break:break-word; }
.live-preview-mode .live-source-active .live-source-code { display:inline; white-space:pre-wrap; font:inherit; color:inherit; background:transparent; outline:0; }
.live-preview-mode pre.live-source-active .live-source-code { display:block; }
.live-preview-mode ul.live-source-active,.live-preview-mode ol.live-source-active { padding-left:1.8em; }
.live-preview-mode table.live-source-active td { white-space:pre-wrap; }
.live-preview-mode .live-table-source { display:block; width:100%; min-height:7em; padding:8px; resize:vertical; border:0; outline:0; color:inherit; background:transparent; font:inherit; line-height:1.65; white-space:pre; tab-size:2; }
.live-syntax-marker { color:#94a3b8!important; font-weight:400!important; font-style:normal!important; text-decoration:none!important; opacity:.88; }
.live-syntax-strong { font-weight:700; color:inherit; }
.live-syntax-em { font-style:italic; color:inherit; }
.live-syntax-strike { text-decoration:line-through; color:inherit; }
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
.settings-plugin { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
.settings-plugin-name { width:100%; color:#475569; word-break:break-all; }
.empty { display:flex; align-items:center; justify-content:center; height:100%; color:#9ca3af; text-align:center; padding:30px; }
@media (prefers-color-scheme:dark) {
  :host { color:#e5e7eb; background:#111827; }
  .toolbar,.toolbar-group,.find-bar,.find-results,.find-result-item,.pane-toolbar,.left-column,.pane-left,.history-panel { border-color:#374151; }
  .pane-left { background:#111827; }
  .pane-right,.pdf-page,button,.find-bar { background:#1f2937; color:#e5e7eb; }
  .pane-toolbar,.md-preview,.inline-editor,.inline-editor textarea,.settings-panel { background:#1f2937; color:#e5e7eb; }
  .history-panel,.history-item { background:#29251b; color:#fef3c7; }
  .md-preview h1,.md-preview h2,.md-preview h3,.md-preview h4 { color:#f8fafc; border-color:#374151; }
  .md-preview blockquote,.md-preview th,.md-preview code { background:#111827; }
}
`

export class MineruLayoutViewer extends HTMLElement {
  private blocks: PdfBlock[] = []
  private sections: MdSection[] = []
  private pages: PdfPageState[] = []
  private pdfDocument: Awaited<ReturnType<typeof pdfjsLib.getDocument>['promise']> | null = null
  private activeIdx: number | null = null
  private pdfUrl: string | null = null
  private renderedPdfUrl: string | null = null
  private ownedPdfUrl: string | null = null
  private layoutData: string | null = null
  private contentListData: string | null = null
  private markdownText: string | null = null
  private zip: JSZip | null = null
  private sourceZipName = 'mineru-result.zip'
  private markdownPath = ''
  private assetUrls = new Map<string, string>()
  private undoStack: UndoAction[] = []
  private redoStack: UndoAction[] = []
  private redoEdits: ReviewEdit[] = []
  private reviewEdits: ReviewEdit[] = []
  private resizeObserver: ResizeObserver | null = null
  private imageObserver: IntersectionObserver | null = null
  private pdfPageObserver: IntersectionObserver | null = null
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
  private markdownMode: 'preview' | 'live' | 'source' = 'preview'
  private sourceDraft = ''
  private vimEnabled = true
  private searchResults: SearchResult[] = []
  private sourceDirectoryHandle: FileSystemDirectoryHandle | null = null
  private sourceMarkdownFileHandle: FileSystemFileHandle | null = null
  private pendingDeletedAssets = new Set<string>()
  private standaloneMarkdown = false
  private documentFormat: DocumentFormat = 'markdown'
  private liveEditSession: LiveEditSession | null = null
  private panesSwapped = false
  private pdfOutline: PdfOutlineItem[] = []
  private progressStartedAt = 0
  private progressEstimateKey = ''
  private progressEstimateStartedAt = 0
  private progressHideTimer: ReturnType<typeof setTimeout> | null = null
  private viewerSettings: ViewerSettings = { ...DEFAULT_VIEWER_SETTINGS }
  private activeDefaultRenderPluginName = 'mineru-reading-theme'
  private defaultRenderPlugins: Record<DocumentFormat, { plugin: MarkdownRenderPlugin; label: string }> = {
    markdown: { plugin: createElegantReadingTheme(), label: '内置阅读主题' },
    org: { plugin: createElegantReadingTheme(), label: '内置阅读主题' },
  }
  private documentPluginFontStyle: HTMLStyleElement | null = null

  static observedAttributes = ['pdf', 'layout', 'markdown']

  constructor() {
    super()
    this.attachShadow({ mode: 'open' })
    this.loadViewerSettings()
  }

  connectedCallback() {
    this.render()
    this.setupResize()
    void this.restoreDefaultRenderPlugins()
  }

  disconnectedCallback() {
    this.resizeObserver?.disconnect()
    if (this.resizeTimer) clearTimeout(this.resizeTimer)
    if (this.progressHideTimer) clearTimeout(this.progressHideTimer)
    this.imageObserver?.disconnect()
    this.pdfPageObserver?.disconnect()
    this.sourceEditor?.destroy()
    this.sourceEditor = null
    this.documentPluginFontStyle?.remove()
    this.documentPluginFontStyle = null
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
    await this.rebuild()
  }

  async loadMarkdown(text: string) {
    this.documentFormat = 'markdown'
    this.activateDefaultRenderPlugin('markdown')
    this.markdownText = text
    await this.rebuild()
  }

  /** Open one Markdown or Org file without MinerU layout/PDF data. */
  async loadMarkdownFile(file: File, handle?: FileSystemFileHandle) {
    this.resetReviewState()
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
    if (!confirm(`加载插件会执行其中的 JavaScript，并把它设为以后默认使用的 ${formatLabel} 渲染插件。只加载你信任的文件。\n\n继续加载 ${file.name}？`)) return
    const source = await file.text()
    const plugin = await this.importMarkdownRenderPlugin(source)
    this.setDefaultRenderPlugin(format, plugin, file.name)
    let persisted = false
    try {
      localStorage.setItem(RENDER_PLUGIN_KEYS[format], JSON.stringify({ fileName: file.name, source }))
      persisted = true
    } catch { /* localStorage may be disabled */ }
    this.updateSettingsControls()
    alert(persisted
      ? `已加载并设为默认 ${formatLabel} 渲染插件：${plugin.name}`
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

  private setDefaultRenderPlugin(format: DocumentFormat, plugin: MarkdownRenderPlugin, label = plugin.name) {
    this.defaultRenderPlugins[format] = { plugin, label }
    if (format === this.documentFormat) this.activateDefaultRenderPlugin(format)
    this.updateSettingsControls()
  }

  private activateDefaultRenderPlugin(format: DocumentFormat) {
    const selected = this.defaultRenderPlugins[format]
    this.markdownRenderPlugins = this.markdownRenderPlugins.filter(item => item.name !== this.activeDefaultRenderPluginName)
    this.activeDefaultRenderPluginName = selected.plugin.name
    this.registerMarkdownRenderPlugin(selected.plugin)
  }

  private async restoreDefaultRenderPlugins() {
    for (const format of ['markdown', 'org'] as DocumentFormat[]) {
      try {
        const saved = localStorage.getItem(RENDER_PLUGIN_KEYS[format])
          || (format === 'markdown' ? localStorage.getItem(LEGACY_RENDER_PLUGIN_KEY) : null)
        if (!saved) continue
        const data = JSON.parse(saved) as { source?: string; fileName?: string }
        if (!data.source) continue
        this.defaultRenderPlugins[format] = {
          plugin: await this.importMarkdownRenderPlugin(data.source),
          label: data.fileName || '自定义渲染插件',
        }
      } catch (error) {
        console.warn(`无法恢复默认 ${format === 'org' ? 'Org' : 'Markdown'} 渲染插件`, error)
      }
    }
    this.activateDefaultRenderPlugin(this.documentFormat)
    this.updateSettingsControls()
  }

  private restoreBuiltinRenderPlugin(format: DocumentFormat) {
    try {
      localStorage.removeItem(RENDER_PLUGIN_KEYS[format])
      if (format === 'markdown') localStorage.removeItem(LEGACY_RENDER_PLUGIN_KEY)
    } catch { /* ignored */ }
    this.setDefaultRenderPlugin(format, createElegantReadingTheme(), '内置阅读主题')
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
  async loadDirectoryEntries(entries: Array<{ path: string; file: File }>) {
    this.resetReviewState()
    this.startLoadProgress('正在读取文件夹…')
    this.beginProgressEstimate('read-directory')
    if (!entries.length) throw new Error('所选文件夹为空')
    this.zip = new JSZip()
    for (let index = 0; index < entries.length; index++) {
      const { path, file } = entries[index]
      const relativePath = normalizeAssetPath(path).replace(/^\/+/, '')
      if (relativePath && !relativePath.split('/').includes('..')) this.zip.file(relativePath, file)
      if (index % 10 === 0 || index === entries.length - 1) {
        const ratio = (index + 1) / entries.length
        this.setLoadProgress(ratio * 35, `正在读取文件夹… ${index + 1}/${entries.length}`, { key: 'read-directory', ratio })
        await new Promise(resolve => setTimeout(resolve, 0))
      }
    }
    const rootName = normalizeAssetPath(entries[0].path).split('/')[0]
    this.sourceZipName = `${rootName || 'mineru-result'}.zip`
    const directPdf = entries.find(item => /_origin\.pdf$/i.test(item.file.name))?.file
      || entries.find(item => /\.pdf$/i.test(item.file.name))?.file
    await this.loadArchiveEntries(directPdf)
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

  private async loadArchiveEntries(directPdf?: File) {
    if (!this.zip) return

    const names = Object.keys(this.zip.files).filter(name => !this.zip!.files[name].dir)
    this.setLoadProgress(42, `正在解析 Markdown 和 JSON…（${names.length} 个文件）`)
    this.markdownPath = this.pickMarkdownPath(names)
    if (!this.markdownPath) throw new Error('ZIP 中未找到 Markdown 文件')

    this.markdownText = await this.zip.file(this.markdownPath)!.async('text')
    this.documentFormat = 'markdown'
    this.activateDefaultRenderPlugin('markdown')

    const contentListPath = names.find(name =>
      /(?:^|\/)(?:content_list|.+_content_list)\.json$/i.test(name),
    )
    const middlePath = names.find(name =>
      /(?:^|\/)(?:middle|layout|.+_(?:middle|layout))\.json$/i.test(name),
    )

    this.contentListData = contentListPath
      ? await this.zip.file(contentListPath)!.async('text')
      : null
    this.layoutData = middlePath
      ? await this.zip.file(middlePath)!.async('text')
      : this.contentListData

    if (!this.layoutData && !this.contentListData) {
      throw new Error('ZIP 缺少 middle.json、layout.json 或 content_list.json')
    }

    const pdfPath = names.find(name => /_origin\.pdf$/i.test(name))
      || names.find(name => /\.pdf$/i.test(name))
    if (directPdf) {
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
      this.zip.file(this.markdownPath, this.markdownText)
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
            <button id="mdPreviewMode" class="active">预览</button>
            <button id="mdLiveMode" title="直接在渲染内容上输入并自动同步源文件">实时预览</button>
            <button id="mdSourceMode">code</button>
            <div class="toolbar-group">
              <button id="mdZoomOut" title="缩小 Markdown">−</button>
              <span id="mdZoomValue" class="zoom-value">100%</span>
              <button id="mdZoomIn" title="放大 Markdown">＋</button>
            </div>
            <button id="vimToggle" title="源码模式使用 Vim 键位">Vim：开</button>
            <button id="toggleFind">查找替换</button>
            <span class="spacer"></span>
            <span id="sourceStatus" class="source-status"></span>
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
            <div class="pane pane-right" id="mdPane"><div class="empty">右侧将显示 Markdown 审核内容</div></div>
          </div>
        </section>
      </div>
      <aside id="settingsPanel" class="settings-panel">
        <div class="settings-header"><strong>设置</strong><span class="spacer"></span><button id="closeSettings" title="关闭">×</button></div>
        <div class="settings-group">
          <strong>PDF / Markdown 主工作区</strong>
          <div class="settings-row"><label for="workspaceLayout">排列</label><select id="workspaceLayout"><option value="side">左右</option><option value="stack">上下</option></select><span></span></div>
          <div class="settings-row"><label for="workspaceRatio">左/上工作区</label><input id="workspaceRatio" type="range" min="20" max="80" step="1"><output id="workspaceRatioValue" class="settings-value"></output></div>
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
        </div>
        <div class="settings-group">
          <strong>Markdown / Org 大纲</strong>
          <div class="settings-row"><label for="mdOutlineLayout">排列</label><select id="mdOutlineLayout"><option value="side">左右</option><option value="stack">上下</option></select><span></span></div>
          <div class="settings-row"><label for="mdOutlineSize">默认大小</label><input id="mdOutlineSize" type="range" min="15" max="70" step="1"><output id="mdOutlineSizeValue" class="settings-value"></output></div>
        </div>
        <div class="settings-group settings-plugin">
          <strong>Markdown 默认渲染插件</strong>
          <div id="markdownPluginName" class="settings-plugin-name"></div>
          <button id="loadMarkdownTheme" title="只用于 Markdown 的本地 JavaScript 渲染/主题插件">选择插件…</button>
          <button id="restoreMarkdownTheme">恢复内置</button>
          <input id="markdownThemeFile" class="plugin-input" type="file" accept=".js,.mjs">
        </div>
        <div class="settings-group settings-plugin">
          <strong>Org 默认渲染插件</strong>
          <div id="orgPluginName" class="settings-plugin-name"></div>
          <button id="loadOrgTheme" title="只用于 Org 的本地 JavaScript 渲染/主题插件">选择插件…</button>
          <button id="restoreOrgTheme">恢复内置</button>
          <input id="orgThemeFile" class="plugin-input" type="file" accept=".js,.mjs">
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
    this.shadowRoot.getElementById('settings')!.addEventListener('click', () => {
      this.shadowRoot?.getElementById('settingsPanel')?.classList.toggle('open')
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
    this.shadowRoot.getElementById('mdZoomOut')!.addEventListener('click', () => this.changeMarkdownZoom(-0.1))
    this.shadowRoot.getElementById('mdZoomIn')!.addEventListener('click', () => this.changeMarkdownZoom(0.1))
    this.shadowRoot.getElementById('mdPreviewMode')!.addEventListener('click', () => this.switchToPreviewMode())
    this.shadowRoot.getElementById('mdLiveMode')!.addEventListener('click', () => this.switchToLiveMode())
    this.shadowRoot.getElementById('mdSourceMode')!.addEventListener('click', () => this.switchToSourceMode())
    this.shadowRoot.getElementById('vimToggle')!.addEventListener('click', () => this.toggleVimMode())
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
        const file = input.files?.[0]
        if (file) void this.loadMarkdownRenderPlugin(file, format)
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
    this.layoutData = await response.text()
    await this.rebuild()
  }

  private async rebuild() {
    const sequence = ++this.rebuildSequence
    const primaryData = this.contentListData || this.layoutData
    if (!primaryData) return

    this.blocks = parseBlocks(primaryData)
    const markdown = this.markdownText
      || this.blocks.map(block => block.text || '').filter(Boolean).join('\n')
    this.sections = matchMarkdownToPdf(markdown, this.blocks)

    if (this.pdfUrl && this.renderedPdfUrl !== this.pdfUrl) {
      await this.renderPdfPages()
    }
    if (sequence !== this.rebuildSequence) return
    this.buildUI()
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
    this.pdfPageObserver?.disconnect()
    if (this.pdfDocument) await this.pdfDocument.destroy()
    const pdf = await pdfjsLib.getDocument(targetUrl).promise
    this.pdfDocument = pdf
    this.pdfOutline = ((await pdf.getOutline()) || []) as unknown as PdfOutlineItem[]
    const firstPage = await pdf.getPage(1)
    const viewport = firstPage.getViewport({ scale: 1 })
    firstPage.cleanup()
    const pages: PdfPageState[] = Array.from({ length: pdf.numPages }, (_, index) => ({
      p: index + 1,
      w: viewport.width,
      h: viewport.height,
      rendered: false,
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
    if (workspaceLayout) workspaceLayout.value = this.viewerSettings.workspaceLayout
    if (standaloneLayout) standaloneLayout.value = this.viewerSettings.standaloneSourceLayout
    if (pdfLayout) pdfLayout.value = this.viewerSettings.pdfOutlineLayout
    if (mdLayout) mdLayout.value = this.viewerSettings.markdownOutlineLayout
    const markdownPluginName = shadow.getElementById('markdownPluginName')
    const orgPluginName = shadow.getElementById('orgPluginName')
    if (markdownPluginName) markdownPluginName.textContent = this.defaultRenderPlugins.markdown.label
    if (orgPluginName) orgPluginName.textContent = this.defaultRenderPlugins.org.label
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
    const headings = this.sections.flatMap((section, index) => {
      const match = this.documentFormat === 'org'
        ? section.raw.match(/^(\*{1,6})\s+(.+)$/)
        : section.raw.match(/^(#{1,6})\s+(.+?)\s*#*$/)
      return match ? [{ section, index, level: match[1].length, title: match[2] }] : []
    })
    if (!headings.length) {
      panel.innerHTML = `<div class="outline-empty">没有 ${this.documentFormat === 'org' ? 'Org' : 'Markdown'} 标题</div>`
      return
    }
    for (const heading of headings) {
      const button = document.createElement('button')
      button.className = 'outline-item'
      button.style.paddingLeft = `${8 + (heading.level - 1) * 14}px`
      button.textContent = heading.title
      button.title = heading.title
      button.addEventListener('click', () => {
        if (this.markdownMode === 'source' && this.sourceEditor) {
          this.sourceEditor.goTo(heading.section.start, heading.section.end - heading.section.start)
          return
        }
        const element = this.shadowRoot?.querySelector<HTMLElement>(`[data-idx="${heading.index}"]`)
        element?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        if (element) this.onMdClick(heading.section, heading.index, element)
      })
      panel.appendChild(button)
    }
  }

  private renderPdfOutline() {
    const panel = this.shadowRoot?.getElementById('pdfOutlinePanel')
    if (!panel) return
    panel.innerHTML = ''
    if (this.pdfOutline.length) {
      const append = (items: PdfOutlineItem[], level: number) => {
        for (const item of items) {
          const button = document.createElement('button')
          button.className = 'outline-item'
          button.style.paddingLeft = `${8 + level * 14}px`
          button.textContent = item.title || '未命名书签'
          button.addEventListener('click', () => void this.goToPdfDestination(item.dest))
          panel.appendChild(button)
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
      panel.innerHTML = '<div class="outline-empty">PDF 没有内置书签，也没有可用的 Markdown 标题</div>'
      return
    }
    for (const item of fallback) {
      const button = document.createElement('button')
      button.className = 'outline-item'
      button.style.paddingLeft = `${8 + (item.level - 1) * 14}px`
      button.textContent = `${item.title} · p${item.section.page}`
      button.addEventListener('click', () => this.goToPdfPage(item.section.page))
      panel.appendChild(button)
    }
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
    this.pdfPageObserver?.disconnect()
    pane.innerHTML = ''
    const availableWidth = pane.clientWidth - 20
    const availableHeight = pane.clientHeight - 24
    if (availableWidth <= 0 || this.pages.length === 0) return
    const referencedImages = new Set(this.sections
      .filter(section => section.imagePath)
      .map(section => normalizeAssetPath(section.imagePath!)))

    for (const renderedPage of this.pages) {
      let cssWidth = availableWidth
      if (this.pdfFitMode === 'page') {
        cssWidth = Math.min(availableWidth, availableHeight * (renderedPage.w / renderedPage.h))
      } else if (this.pdfFitMode === 'custom') {
        cssWidth = availableWidth * this.pdfZoom
      }
      const cssHeight = renderedPage.h * (cssWidth / renderedPage.w)
      const pageBlocks = this.blocks.filter(block => block.page_idx === renderedPage.p - 1)

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

      for (const block of pageBlocks) {
        const [x0, y0, x1, y1] = block.bbox
        const overlay = document.createElement('div')
        const imagePath = block.imagePath ? normalizeAssetPath(block.imagePath) : ''
        const missingImage = imagePath && !referencedImages.has(imagePath)
        overlay.className = 'block-overlay'
          + (block.imagePath ? ' image-block' : '')
          + (missingImage ? ' missing-image' : '')
        overlay.style.left = `${x0 * cssWidth}px`
        overlay.style.top = `${y0 * cssHeight}px`
        overlay.style.width = `${Math.max((x1 - x0) * cssWidth, 2)}px`
        overlay.style.height = `${Math.max((y1 - y0) * cssHeight, 2)}px`
        overlay.title = (block.imagePath || block.text || block.type || '').slice(0, 160)
        overlay.dataset.blockId = block.id
        overlay.addEventListener('click', () => this.onBlockClick(block, overlay))
        wrapper.appendChild(overlay)
      }
      pane.appendChild(wrapper)
      this.observePdfPage(wrapper)
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

  private changeMarkdownZoom(delta: number) {
    this.markdownZoom = Math.min(2.2, Math.max(0.6, Number((this.markdownZoom + delta).toFixed(2))))
    const pane = this.shadowRoot?.getElementById('mdPane')
    pane?.style.setProperty('--md-zoom', String(this.markdownZoom))
    pane?.style.setProperty('--md-image-width', `${Math.round(this.markdownZoom * 100)}%`)
    pane?.style.setProperty('--md-image-height', `${Math.round(520 * this.markdownZoom)}px`)
    if (this.sourceEditor) this.sourceEditor.view.dom.style.fontSize = `${Math.round(14 * this.markdownZoom)}px`
    this.updateToolbar()
  }

  private observePdfPage(wrapper: HTMLElement) {
    const pageNumber = Number(wrapper.dataset.page)
    const pageState = this.pages[pageNumber - 1]
    if (!pageState || pageState.rendered) {
      if (pageState?.rendered) void this.renderPdfPage(pageNumber, wrapper)
      return
    }
    if (typeof IntersectionObserver === 'undefined') {
      void this.renderPdfPage(pageNumber, wrapper)
      return
    }
    if (!this.pdfPageObserver) {
      const pane = this.shadowRoot!.getElementById('pdfPane')!
      this.pdfPageObserver = new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const target = entry.target as HTMLElement
          this.pdfPageObserver?.unobserve(target)
          void this.renderPdfPage(Number(target.dataset.page), target)
        }
      }, { root: pane, rootMargin: '1200px 0px' })
    }
    this.pdfPageObserver.observe(wrapper)
  }

  private async renderPdfPage(pageNumber: number, wrapper?: HTMLElement) {
    const pageState = this.pages[pageNumber - 1]
    const pdfDocument = this.pdfDocument
    if (!pageState || !pdfDocument) return
    const target = wrapper || this.shadowRoot?.querySelector(`.pdf-page[data-page="${pageNumber}"]`) as HTMLElement | null
    if (!target || target.querySelector('canvas')) return
    if (!pageState.rendering) {
      pageState.rendering = (async () => {
        const page = await pdfDocument.getPage(pageNumber)
        const viewport = page.getViewport({ scale: RENDER_SCALE })
        const unscaledWidth = viewport.width / RENDER_SCALE
        const unscaledHeight = viewport.height / RENDER_SCALE
        if (Math.abs((pageState.w / pageState.h) - (unscaledWidth / unscaledHeight)) > 0.005) {
          pageState.w = unscaledWidth
          pageState.h = unscaledHeight
          this.updatePageGeometry(target, pageState)
        }
        const canvas = document.createElement('canvas')
        canvas.width = Math.ceil(viewport.width)
        canvas.height = Math.ceil(viewport.height)
        canvas.dataset.pageCanvas = String(pageNumber)
        await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise
        pageState.rendered = true
        page.cleanup()
        const current = this.shadowRoot?.querySelector(`.pdf-page[data-page="${pageNumber}"]`) as HTMLElement | null
        if (current && !current.querySelector('canvas')) {
          current.querySelector('.pdf-placeholder')?.replaceWith(canvas)
        }
      })().finally(() => { pageState.rendering = undefined })
    }
    await pageState.rendering
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
    this.buildMarkdownPreview()
  }

  private buildMarkdownPreview() {
    const pane = this.shadowRoot!.getElementById('mdPane')!
    this.sourceEditor?.destroy()
    this.sourceEditor = null
    this.imageObserver?.disconnect()
    pane.innerHTML = ''
    if (!this.markdownText?.trim()) {
      pane.innerHTML = `<div class="empty">没有可显示的 ${this.documentFormat === 'org' ? 'Org' : 'Markdown'} 内容</div>`
      return
    }

    const preview = document.createElement('article')
    preview.className = `md-preview ${this.documentFormat}-preview${this.markdownMode === 'live' ? ' live-preview-mode' : ''}`
    preview.innerHTML = this.previewRenderer.render(this.renderableDocument(this.markdownText))
    pane.appendChild(preview)
    this.previewRenderer.afterRender(preview)
    this.annotatePreviewBlocks(preview)
    this.decoratePreviewImages(preview)
    if (this.markdownMode === 'live') this.enableLivePreviewEditing(preview)
    preview.addEventListener('click', event => this.onPreviewClick(event))
    preview.addEventListener('dblclick', event => this.onPreviewDoubleClick(event))
    this.applySearchHighlights(preview)
    this.updateModeToolbar()
  }

  private annotatePreviewBlocks(preview: HTMLElement) {
    const displayMathRanges: Array<[number, number]> = []
    const tableRanges: Array<[number, number]> = []
    const sourceLines = (this.markdownText || '').split(/\r?\n/)
    let mathStart = -1
    let tableStart = -1
    sourceLines.forEach((line, index) => {
      const delimiters = (line.match(/\$\$/g) || []).length
      if (mathStart < 0 && delimiters) {
        mathStart = index
        if (delimiters > 1) {
          displayMathRanges.push([index, index + 1])
          mathStart = -1
        }
      } else if (mathStart >= 0 && delimiters) {
        displayMathRanges.push([mathStart, index + 1])
        mathStart = -1
      }
      const tableLine = this.documentFormat === 'org'
        ? /^\s*\\?\|.*\\?\|\s*$/.test(line)
        : /^\s*\|.*\|\s*$/.test(line)
      if (tableLine && tableStart < 0) tableStart = index
      if (!tableLine && tableStart >= 0) {
        tableRanges.push([tableStart, index])
        tableStart = -1
      }
    })
    if (tableStart >= 0) tableRanges.push([tableStart, sourceLines.length])
    const displayMath = Array.from(preview.querySelectorAll<HTMLElement>(':scope > section'))
      .filter(element => element.querySelector('eqn') && !element.hasAttribute('data-md-start-line'))
    displayMath.forEach((element, index) => {
      const range = displayMathRanges[index]
      if (!range) return
      element.dataset.mdStartLine = String(range[0])
      element.dataset.mdEndLine = String(range[1])
    })
    Array.from(preview.querySelectorAll<HTMLElement>(':scope > table')).forEach((element, index) => {
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
    if (target.closest('button,input,textarea')) return
    const block = target.closest<HTMLElement>('[data-md-start-line]')
    if (!block) return
    if (this.markdownMode === 'live' && !event.ctrlKey && !event.metaKey) {
      if (target.closest('a')) event.preventDefault()
      const editable = target.closest<HTMLElement>('.live-editable')
      if (editable) {
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
    const block = target.closest<HTMLElement>('[data-md-start-line]')
    if (!block) return
    event.preventDefault()
    event.stopPropagation()
    this.openInlineBlockEditor(block, target.closest('img.md-asset') ? '' : undefined)
  }

  /** Make rendered blocks themselves editable; no textarea or save dialog is involved. */
  private enableLivePreviewEditing(preview: HTMLElement) {
    const editableTags = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'BLOCKQUOTE', 'PRE', 'UL', 'OL', 'TABLE', 'SECTION'])
    for (const element of Array.from(preview.children) as HTMLElement[]) {
      if (!editableTags.has(element.tagName)) continue
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
      element.contentEditable = 'true'
      element.spellcheck = true
      element.setAttribute('role', 'textbox')
      element.setAttribute('aria-multiline', 'true')
    }
    for (const actions of preview.querySelectorAll<HTMLElement>('.preview-image-actions')) actions.contentEditable = 'false'

    preview.addEventListener('focusin', event => {
      const element = (event.target as Element).closest<HTMLElement>('.live-editable')
      if (element) this.beginLiveEdit(element)
    })
    preview.addEventListener('input', event => {
      const element = (event.target as Element).closest<HTMLElement>('.live-editable')
      if (element) this.syncLiveEdit(element)
    })
    preview.addEventListener('focusout', event => {
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
    }
    const source = this.markdownText.slice(start, end).replace(/\r?\n$/, '')
    this.showLiveSource(element, source)
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
    const host = element.querySelector<HTMLElement>('.live-source-code')
    if (!host) return
    queueMicrotask(() => {
      if (host instanceof HTMLTextAreaElement) {
        host.focus()
        host.setSelectionRange(host.value.length, host.value.length)
        return
      }
      const selection = document.getSelection()
      if (!selection || !host.isConnected) return
      const range = document.createRange()
      range.selectNodeContents(host)
      range.collapse(false)
      selection.removeAllRanges()
      selection.addRange(range)
    })
  }

  private highlightLiveSource(source: string): string {
    const escape = (value: string) => this.escapeHtml(value)
    const marker = (value: string) => `<span class="live-syntax-marker">${escape(value)}</span>`
    const plain = (value: string) => value.split('\n').map(line => {
      const pattern = this.documentFormat === 'org'
        ? /^(\*+\s+|#\+[A-Z_]+(?::|\s+)|[-+]\s+|\d+[.)]\s+)/i
        : /^(#{1,6}\s+|[-+*]\s+|\d+[.)]\s+|>\s+)/
      const match = line.match(pattern)
      return match ? marker(match[1]) + escape(line.slice(match[1].length)) : escape(line)
    }).join('<br>')

    const tokenPattern = this.documentFormat === 'org'
      ? /(\$\$[\s\S]*?\$\$|\$[^$\n]+\$|\[\[[^\]]+\](?:\[[^\]]*\])?\]|\*[^*\n]+\*|\/[^/\n]+\/|\+[^+\n]+\+|~[^~\n]+~|=[^=\n]+=)/g
      : /(\$\$[\s\S]*?\$\$|\$[^$\n]+\$|!\[[^\]]*\]\([^\n)]*\)|\[[^\]]+\]\([^\n)]*\)|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|`[^`\n]+`|\*[^*\n]+\*|_[^_\n]+_)/g
    let output = ''
    let cursor = 0
    let match: RegExpExecArray | null
    while ((match = tokenPattern.exec(source))) {
      output += plain(source.slice(cursor, match.index))
      const token = match[0]
      if (token.startsWith('$$') || (token.startsWith('$') && token.endsWith('$'))) {
        const width = token.startsWith('$$') ? 2 : 1
        output += marker(token.slice(0, width))
          + `<span class="live-syntax-math">${escape(token.slice(width, -width))}</span>`
          + marker(token.slice(-width))
      } else if (this.documentFormat === 'markdown' && (token.startsWith('**') || token.startsWith('__'))) {
        output += marker(token.slice(0, 2)) + `<span class="live-syntax-strong">${escape(token.slice(2, -2))}</span>` + marker(token.slice(-2))
      } else if (this.documentFormat === 'org' && token.startsWith('*')) {
        output += marker('*') + `<span class="live-syntax-strong">${escape(token.slice(1, -1))}</span>` + marker('*')
      } else if ((this.documentFormat === 'markdown' && (token.startsWith('*') || token.startsWith('_')))
        || (this.documentFormat === 'org' && token.startsWith('/'))) {
        output += marker(token[0]) + `<span class="live-syntax-em">${escape(token.slice(1, -1))}</span>` + marker(token.slice(-1))
      } else if (token.startsWith('~~')) {
        output += marker('~~') + `<span class="live-syntax-strike">${escape(token.slice(2, -2))}</span>` + marker('~~')
      } else if (this.documentFormat === 'org' && token.startsWith('+')) {
        output += marker('+') + `<span class="live-syntax-strike">${escape(token.slice(1, -1))}</span>` + marker('+')
      } else if (token.startsWith('`') || token.startsWith('~') || (this.documentFormat === 'org' && token.startsWith('='))) {
        output += marker(token[0]) + `<span class="live-syntax-code">${escape(token.slice(1, -1))}</span>` + marker(token.slice(-1))
      } else {
        output += `<span class="live-syntax-link">${escape(token)}</span>`
      }
      cursor = match.index + token.length
    }
    return output + plain(source.slice(cursor))
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
      if (node.classList.contains('preview-image-actions')) return ''
      const content = Array.from(node.childNodes).map(walk).join('')
      const org = this.documentFormat === 'org'
      if (node.tagName === 'BR') return '\n'
      if (node.tagName === 'DIV' || node.tagName === 'P') return `${content}${node === root ? '' : '\n'}`
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

  private openInlineBlockEditor(block: HTMLElement, replacementValue?: string) {
    if (this.markdownText == null) return
    const startLine = Number(block.dataset.mdStartLine)
    const endLine = Number(block.dataset.mdEndLine)
    const [start, end] = this.sourceRangeForLines(startLine, endLine)
    const original = this.markdownText.slice(start, end)
    const lineEnding = original.match(/\r?\n$/)?.[0] || ''
    const initialValue = replacementValue ?? (lineEnding ? original.slice(0, -lineEnding.length) : original)
    const editor = document.createElement('div')
    editor.className = 'inline-editor'
    const tools = document.createElement('div')
    tools.className = 'inline-editor-tools'
    const textarea = document.createElement('textarea')
    textarea.value = initialValue
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
      const replacement = textarea.value + lineEnding
      if (replacementValue !== undefined && !textarea.value.trim()) {
        alert('请输入替代文字；如果只想删除图片，请使用删除按钮。')
        return
      }
      this.replaceMarkdownRange(start, end, replacement, {
        type: replacementValue !== undefined ? 'image-to-text' : 'edit-markdown',
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
    if (replacementValue !== undefined) textarea.select()
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
      if (!this.zip) continue
      try {
        image.src = await this.getAssetUrl(source)
      } catch {
        image.alt = `找不到图片：${source}`
      }
    }
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
    const offsets = [0]
    for (let index = 0; index < markdown.length; index++) {
      if (markdown[index] === '\n') offsets.push(index + 1)
    }
    return [offsets[startLine] ?? markdown.length, offsets[endLine] ?? markdown.length]
  }

  private renderableDocument(source: string): string {
    return this.documentFormat === 'org' ? orgToMarkdown(source) : source
  }

  private buildSourceEditor() {
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

  private syncStandalonePreviewFromSource(preview: HTMLElement, offset: number, markdown: string) {
    const line = markdown.slice(0, Math.max(0, Math.min(offset, markdown.length))).split('\n').length - 1
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
    if (this.markdownMode === 'live') this.finishLiveEdit(false)
    this.markdownMode = 'source'
    this.sourceDraft = this.markdownText
    this.buildSourceEditor()
    this.updateSearchResults()
  }

  private switchToPreviewMode() {
    if (this.markdownMode === 'source') {
      this.saveSourceAndPreview()
      return
    }
    if (this.markdownMode === 'preview') return
    this.finishLiveEdit(false)
    this.markdownMode = 'preview'
    this.buildMarkdownPreview()
    this.updateModeToolbar()
  }

  private switchToLiveMode() {
    if (this.markdownText == null || this.markdownMode === 'live') return
    if (this.markdownMode === 'source') this.saveSourceAndPreview()
    this.markdownMode = 'live'
    this.buildMarkdownPreview()
    this.updateModeToolbar()
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

  private toggleVimMode() {
    this.vimEnabled = !this.vimEnabled
    if (this.markdownMode === 'source') {
      this.sourceDraft = this.sourceEditor?.getValue() ?? this.sourceDraft
      this.buildSourceEditor()
    }
    this.updateModeToolbar()
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

  private updateModeToolbar() {
    const shadow = this.shadowRoot
    if (!shadow) return
    shadow.getElementById('mdPreviewMode')?.classList.toggle('active', this.markdownMode === 'preview')
    shadow.getElementById('mdLiveMode')?.classList.toggle('active', this.markdownMode === 'live')
    shadow.getElementById('mdSourceMode')?.classList.toggle('active', this.markdownMode === 'source')
    const vimButton = shadow.getElementById('vimToggle')
    if (vimButton) vimButton.textContent = `Vim：${this.vimEnabled ? '开' : '关'}`
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
    const shadow = this.shadowRoot!
    shadow.querySelectorAll('.block-overlay.active,.md-preview .active')
      .forEach(item => item.classList.remove('active'))
    overlay.classList.add('active')

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
      const matched = matchSectionsToPdf(newMiddle, this.blocks)
      for (let index = 0; index < matched.length; index++) next[prefix + index] = matched[index]
    }
    this.sections = next
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
    const message = `确认覆盖本地文件？\n\n${markdownRelativePath}`
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

  private async getAssetUrl(imagePath: string): Promise<string> {
    if (!this.zip) throw new Error('图片预览仅支持从 MinerU ZIP 加载')
    const zipPath = this.resolveAssetPath(imagePath)
    const cached = this.assetUrls.get(zipPath)
    if (cached) return cached
    const entry = this.zip.file(zipPath)
    if (!entry) throw new Error(`ZIP 中找不到图片：${zipPath}`)
    const blob = await entry.async('blob')
    const url = URL.createObjectURL(blob)
    this.assetUrls.set(zipPath, url)
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

  private resetReviewState() {
    this.sourceEditor?.destroy()
    this.sourceEditor = null
    this.markdownMode = 'preview'
    this.sourceDraft = ''
    this.pdfPageObserver?.disconnect()
    this.pdfPageObserver = null
    void this.pdfDocument?.destroy()
    this.pdfDocument = null
    this.revokeAssetUrls()
    this.revokeOwnedPdfUrl()
    this.zip = null
    this.markdownPath = ''
    this.markdownText = null
    this.layoutData = null
    this.contentListData = null
    this.pdfUrl = null
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
