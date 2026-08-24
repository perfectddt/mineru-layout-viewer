import JSZip from 'jszip'
import { parseBlocks, normalizeAssetPath } from './parse-blocks.js'
import { matchMarkdownToPdf, matchSectionsToPdf, normalize, lcsSimilarity } from './match-markdown.js'
import { parseMarkdownSections } from './parse-markdown.js'
import { MarkdownPreviewRenderer, type MarkdownRenderPlugin } from './markdown-preview.js'
import { createElegantReadingTheme, createRichMarkdownPlugin } from './rich-markdown-plugin.js'
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
  | { type: 'restore-image'; zipPath: string; data: Uint8Array }
  | { type: 'restore-markdown-and-image'; markdown: string; zipPath: string; data: Uint8Array }

interface SearchResult {
  start: number
  end: number
  sectionIndex: number
  snippet: string
  match: string
}

const STYLES = `
:host { position:relative; display:flex; flex-direction:column; height:100%; font-family:system-ui,sans-serif; color:#1f2937; background:#fff; }
* { box-sizing:border-box; }
.toolbar { display:flex; align-items:center; gap:8px; padding:7px 10px; border-bottom:1px solid #e5e7eb; font-size:12px; color:#6b7280; flex-shrink:0; flex-wrap:wrap; }
.toolbar .spacer { flex:1; }
.toolbar .ok { color:#16a34a; }
.toolbar .warn { color:#d97706; }
.toolbar .dirty { color:#b45309; font-weight:600; }
.history-toggle { color:#b45309; border-color:#f59e0b; font-weight:600; }
.toolbar-group { display:flex; align-items:center; gap:4px; padding-left:7px; border-left:1px solid #e5e7eb; }
.toolbar-label { color:#6b7280; }
.zoom-value { min-width:42px; text-align:center; color:#374151; }
button { border:1px solid #d1d5db; border-radius:5px; padding:5px 9px; background:#fff; color:#374151; cursor:pointer; font:inherit; }
button:hover:not(:disabled) { border-color:#3b82f6; color:#1d4ed8; background:#eff6ff; }
button:disabled { cursor:not-allowed; opacity:.45; }
button.danger:hover:not(:disabled) { border-color:#dc2626; color:#b91c1c; background:#fef2f2; }
.split { flex:1; display:grid; grid-template-columns:1fr 1fr; min-height:0; overflow:hidden; }
.pane-column { min-width:0; min-height:0; display:flex; flex-direction:column; overflow:hidden; }
.left-column { border-right:1px solid #e5e7eb; }
.pane-toolbar { min-height:42px; display:flex; align-items:center; gap:5px; padding:6px 9px; border-bottom:1px solid #e5e7eb; flex-shrink:0; font-size:12px; color:#6b7280; background:#fff; }
.pane-toolbar .spacer { flex:1; }
.pane-toolbar button.active { border-color:#2563eb; color:#1d4ed8; background:#eff6ff; }
.history-panel { display:none; max-height:245px; overflow:auto; border-bottom:1px solid #e5e7eb; background:#fffbeb; flex-shrink:0; }
.history-panel.open { display:block; }
.history-empty { padding:12px; color:#92400e; font-size:12px; }
.history-item { display:block; width:100%; text-align:left; border:0; border-bottom:1px solid #fde68a; border-radius:0; padding:8px 10px; background:transparent; }
.history-item small { display:block; margin-top:2px; color:#78716c; }
.pane { flex:1; min-height:0; overflow:auto; padding:10px; }
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
.md-preview a { color:#2563eb; }
.md-preview img.md-asset { display:block; max-width:var(--md-image-width); max-height:var(--md-image-height); margin:8px auto; object-fit:contain; }
.md-preview [data-md-start-line] { border-radius:4px; transition:background .12s,box-shadow .12s; }
.md-preview [data-md-start-line]:hover { background:rgba(37,99,235,.045); box-shadow:inset 3px 0 0 rgba(37,99,235,.35); }
.md-preview [data-md-start-line].active { background:rgba(37,99,235,.08); box-shadow:inset 3px 0 0 #2563eb; }
.preview-image-actions { display:flex; justify-content:flex-end; gap:6px; margin:5px 0 10px; }
.inline-editor { margin:8px 0; border:1px solid #60a5fa; border-radius:7px; overflow:hidden; background:#fff; box-shadow:0 3px 12px rgba(37,99,235,.12); }
.inline-editor-tools { display:flex; align-items:center; gap:5px; padding:6px 8px; border-bottom:1px solid #dbeafe; background:#eff6ff; }
.inline-editor-tools .spacer { flex:1; }
.inline-editor textarea { display:block; width:100%; min-height:120px; max-height:55vh; resize:vertical; border:0; outline:0; padding:10px; font:14px/1.65 'Cascadia Code',Consolas,monospace; }
.source-editor-host { flex:1; width:100%; height:100%; min-height:0; overflow:hidden; }
.source-editor-host .cm-editor { height:100%; }
.source-status { color:#2563eb; font-weight:600; }
.empty { display:flex; align-items:center; justify-content:center; height:100%; color:#9ca3af; text-align:center; padding:30px; }
@media (prefers-color-scheme:dark) {
  :host { color:#e5e7eb; background:#111827; }
  .toolbar,.toolbar-group,.find-bar,.find-results,.find-result-item,.pane-toolbar,.left-column,.pane-left,.history-panel { border-color:#374151; }
  .pane-left { background:#111827; }
  .pane-right,.pdf-page,button,.find-bar { background:#1f2937; color:#e5e7eb; }
  .pane-toolbar,.md-preview,.inline-editor,.inline-editor textarea { background:#1f2937; color:#e5e7eb; }
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
  private markdownMode: 'preview' | 'source' = 'preview'
  private sourceDraft = ''
  private vimEnabled = true
  private searchResults: SearchResult[] = []
  private sourceDirectoryHandle: FileSystemDirectoryHandle | null = null
  private pendingDeletedAssets = new Set<string>()

  static observedAttributes = ['pdf', 'layout', 'markdown']

  constructor() {
    super()
    this.attachShadow({ mode: 'open' })
  }

  connectedCallback() {
    this.render()
    this.setupResize()
  }

  disconnectedCallback() {
    this.resizeObserver?.disconnect()
    if (this.resizeTimer) clearTimeout(this.resizeTimer)
    this.imageObserver?.disconnect()
    this.pdfPageObserver?.disconnect()
    this.sourceEditor?.destroy()
    this.sourceEditor = null
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
    this.markdownText = text
    await this.rebuild()
  }

  registerMarkdownRenderPlugin(plugin: MarkdownRenderPlugin) {
    this.markdownRenderPlugins = this.markdownRenderPlugins.filter(item => item.name !== plugin.name)
    this.markdownRenderPlugins.push(plugin)
    this.previewRenderer.setPlugins(this.markdownRenderPlugins)
    this.updatePluginStyles()
    if (this.markdownMode === 'preview') this.buildMarkdown()
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
  async loadMarkdownRenderPlugin(file: File) {
    if (!/\.m?js$/i.test(file.name)) throw new Error('渲染插件必须是 .js 或 .mjs 文件')
    if (!confirm(`加载插件会执行其中的 JavaScript。只加载你信任的文件。\n\n继续加载 ${file.name}？`)) return
    const url = URL.createObjectURL(file)
    try {
      const module = await import(/* @vite-ignore */ url) as {
        default?: MarkdownRenderPlugin
        markdownRenderPlugin?: MarkdownRenderPlugin
      }
      const plugin = module.default || module.markdownRenderPlugin
      if (!plugin || typeof plugin.name !== 'string') throw new Error('插件需要导出带 name 的 MarkdownRenderPlugin 对象')
      this.registerMarkdownRenderPlugin(plugin)
      alert(`已加载渲染插件：${plugin.name}`)
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  /** Load one MinerU result ZIP and keep it in memory for review edits. */
  async loadZip(zipBlob: Blob) {
    this.resetReviewState()
    this.setStatus('正在读取 ZIP…')
    this.zip = await JSZip.loadAsync(zipBlob)
    this.sourceZipName = (zipBlob as File).name || 'mineru-result.zip'
    await this.loadArchiveEntries()
  }

  /** Load a MinerU result directory selected with a webkitdirectory file input. */
  async loadDirectory(files: File[] | FileList) {
    this.resetReviewState()
    const selected = Array.from(files)
    if (!selected.length) throw new Error('所选文件夹为空')
    this.setStatus(`正在读取文件夹… 0/${selected.length}`)
    this.zip = new JSZip()
    for (let index = 0; index < selected.length; index++) {
      const file = selected[index]
      const relativePath = normalizeAssetPath(file.webkitRelativePath || file.name).replace(/^\/+/, '')
      if (relativePath && !relativePath.split('/').includes('..')) this.zip.file(relativePath, file)
      if (index % 50 === 0) this.setStatus(`正在读取文件夹… ${index + 1}/${selected.length}`)
    }
    const rootName = normalizeAssetPath(selected[0].webkitRelativePath || '').split('/')[0]
    this.sourceZipName = `${rootName || 'mineru-result'}.zip`
    const directPdf = selected.find(file => /_origin\.pdf$/i.test(file.name))
      || selected.find(file => /\.pdf$/i.test(file.name))
    await this.loadArchiveEntries(directPdf)
  }

  /** Open a directory with read/write permission so full.md and deleted assets can be saved in place. */
  async loadDirectoryHandle(handle: FileSystemDirectoryHandle) {
    this.resetReviewState()
    this.setStatus('正在读取可写文件夹…')
    this.zip = new JSZip()
    const collected: Array<{ path: string; file: File }> = []
    await this.collectDirectoryFiles(handle, handle.name, collected)
    if (!collected.length) throw new Error('所选文件夹为空')
    for (let index = 0; index < collected.length; index++) {
      const item = collected[index]
      this.zip.file(item.path, item.file)
      if (index % 50 === 0) this.setStatus(`正在读取可写文件夹… ${index + 1}/${collected.length}`)
    }
    this.sourceDirectoryHandle = handle
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
    }
  }

  private async loadArchiveEntries(directPdf?: File) {
    if (!this.zip) return

    const names = Object.keys(this.zip.files).filter(name => !this.zip!.files[name].dir)
    this.setStatus(`正在解析 Markdown 和 JSON…（${names.length} 个文件）`)
    this.markdownPath = this.pickMarkdownPath(names)
    if (!this.markdownPath) throw new Error('ZIP 中未找到 Markdown 文件')

    this.markdownText = await this.zip.file(this.markdownPath)!.async('text')

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
      this.setStatus('正在打开 PDF…')
      this.ownedPdfUrl = URL.createObjectURL(directPdf)
      this.pdfUrl = this.ownedPdfUrl
    } else if (pdfPath) {
      this.setStatus('正在解压 PDF…')
      const pdfBlob = await this.zip.file(pdfPath)!.async('blob', metadata => {
        this.setStatus(`正在解压 PDF… ${Math.round(metadata.percent)}%`)
      })
      this.ownedPdfUrl = URL.createObjectURL(pdfBlob)
      this.pdfUrl = this.ownedPdfUrl
    }

    this.setStatus('正在建立页面索引…')
    await this.rebuild()
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

    this.reviewEdits.pop()
    if (action.type === 'restore-markdown') {
      const previousSections = this.sections
      this.markdownText = action.markdown
      this.refreshSectionsPreservingMatches(previousSections)
      this.rebuildMarkdownView()
    } else if (action.type === 'restore-image' && this.zip) {
      this.zip.file(action.zipPath, action.data)
      this.revokeAssetUrl(action.zipPath)
      this.rebuildMarkdownView()
    } else if (action.type === 'restore-markdown-and-image' && this.zip) {
      const previousSections = this.sections
      this.zip.file(action.zipPath, action.data)
      this.pendingDeletedAssets.delete(action.zipPath)
      this.revokeAssetUrl(action.zipPath)
      this.markdownText = action.markdown
      this.refreshSectionsPreservingMatches(previousSections)
      this.rebuildMarkdownView()
    }
    this.updateToolbar()
  }

  private render() {
    if (!this.shadowRoot) return
    this.shadowRoot.innerHTML = `<style>${STYLES}</style><style id="markdownPluginStyles"></style>
      <div class="toolbar">
        <span id="stat">加载 MinerU ZIP 以开始</span>
        <span class="spacer"></span>
        <button id="undo" disabled>撤销</button>
        <button id="export" disabled>导出修改版 ZIP</button>
      </div>
      <div class="split">
        <section class="pane-column left-column">
          <div class="pane-toolbar">
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
          <div class="pane pane-left" id="pdfPane"><slot name="loading">加载 PDF + JSON 以开始</slot></div>
        </section>
        <section class="pane-column right-column" id="rightColumn">
          <div class="pane-toolbar">
            <strong>Markdown</strong>
            <button id="mdPreviewMode" class="active">预览</button>
            <button id="mdSourceMode">源码（全文）</button>
            <div class="toolbar-group">
              <button id="mdZoomOut" title="缩小 Markdown">−</button>
              <span id="mdZoomValue" class="zoom-value">100%</span>
              <button id="mdZoomIn" title="放大 Markdown">＋</button>
            </div>
            <button id="vimToggle" title="源码模式使用 Vim 键位">Vim：开</button>
            <button id="toggleFind">查找替换</button>
            <button id="loadTheme" title="加载本地 JavaScript 渲染/主题插件">加载渲染插件</button>
            <input id="themeFile" class="plugin-input" type="file" accept=".js,.mjs">
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
          <div class="pane pane-right" id="mdPane"><div class="empty">右侧将显示 Markdown 审核内容</div></div>
        </section>
      </div>`

    this.updatePluginStyles()
    this.shadowRoot.getElementById('undo')!.addEventListener('click', () => {
      void this.undoLastEdit()
    })
    this.shadowRoot.getElementById('export')!.addEventListener('click', () => {
      void this.exportEditedZip()
    })
    this.shadowRoot.getElementById('dirty')!.addEventListener('click', () => this.toggleHistoryPanel())
    this.shadowRoot.getElementById('pdfZoomOut')!.addEventListener('click', () => this.changePdfZoom(-0.1))
    this.shadowRoot.getElementById('pdfZoomIn')!.addEventListener('click', () => this.changePdfZoom(0.1))
    this.shadowRoot.getElementById('fitPage')!.addEventListener('click', () => this.setPdfFitMode('page'))
    this.shadowRoot.getElementById('fitWidth')!.addEventListener('click', () => this.setPdfFitMode('width'))
    this.shadowRoot.getElementById('mdZoomOut')!.addEventListener('click', () => this.changeMarkdownZoom(-0.1))
    this.shadowRoot.getElementById('mdZoomIn')!.addEventListener('click', () => this.changeMarkdownZoom(0.1))
    this.shadowRoot.getElementById('mdPreviewMode')!.addEventListener('click', () => this.saveSourceAndPreview())
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
    const themeFile = this.shadowRoot.getElementById('themeFile') as HTMLInputElement
    this.shadowRoot.getElementById('loadTheme')!.addEventListener('click', () => themeFile.click())
    themeFile.addEventListener('change', () => {
      const file = themeFile.files?.[0]
      if (file) void this.loadMarkdownRenderPlugin(file)
      themeFile.value = ''
    })
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
  }

  private updateToolbar() {
    const shadow = this.shadowRoot
    if (!shadow) return
    const matched = this.sections.filter(section => section.bbox).length
    const images = this.sections.filter(section => section.kind === 'image').length
    shadow.getElementById('stat')!.innerHTML =
      `${this.pages.length} 页 · ${this.sections.length} 行 · ${images} 张图片 · <span class="${matched ? 'ok' : 'warn'}">匹配 ${matched}</span>`
    const dirty = shadow.getElementById('dirty')!
    dirty.className = `history-toggle${this.reviewEdits.length ? ' dirty' : ''}`
    dirty.textContent = this.reviewEdits.length ? `已修改 ${this.reviewEdits.length} 项 ▾` : '暂无修改'
    ;(shadow.getElementById('undo') as HTMLButtonElement).disabled = this.undoStack.length === 0 || this.markdownMode === 'source'
    ;(shadow.getElementById('export') as HTMLButtonElement).disabled = !this.zip
    ;(shadow.getElementById('saveLocalMarkdown') as HTMLButtonElement).disabled = !this.sourceDirectoryHandle
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
      'edit-markdown': '编辑 Markdown',
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
      pane.innerHTML = '<div class="empty">没有可显示的 Markdown 内容</div>'
      return
    }

    const preview = document.createElement('article')
    preview.className = 'md-preview'
    preview.innerHTML = this.previewRenderer.render(this.markdownText)
    pane.appendChild(preview)
    this.previewRenderer.afterRender(preview)
    this.annotatePreviewBlocks(preview)
    this.decoratePreviewImages(preview)
    preview.addEventListener('click', event => this.onPreviewClick(event))
    preview.addEventListener('dblclick', event => this.onPreviewDoubleClick(event))
    this.applySearchHighlights(preview)
    this.updateModeToolbar()
  }

  private annotatePreviewBlocks(preview: HTMLElement) {
    for (const element of preview.querySelectorAll<HTMLElement>('[data-md-start-line]')) {
      const startLine = Number(element.dataset.mdStartLine)
      const endLine = Number(element.dataset.mdEndLine)
      const [start, end] = this.sourceRangeForLines(startLine, endLine)
      const sectionIndex = this.sections.findIndex(section => section.start >= start && section.start < end)
      if (sectionIndex >= 0) element.dataset.idx = String(sectionIndex)
      element.title = '单击定位 PDF；双击在原位置编辑'
      element.tabIndex = 0
    }
  }

  private onPreviewClick(event: MouseEvent) {
    const target = event.target as HTMLElement
    if (target.closest('button,a,input,textarea')) return
    const block = target.closest<HTMLElement>('[data-md-start-line]')
    if (!block) return
    const sectionIndex = Number(block.dataset.idx)
    const section = this.sections[sectionIndex]
    if (section) this.onMdClick(section, sectionIndex, block)
  }

  private onPreviewDoubleClick(event: MouseEvent) {
    const target = event.target as HTMLElement
    if (target.closest('button,a,input,textarea')) return
    const block = target.closest<HTMLElement>('[data-md-start-line]')
    if (!block) return
    event.preventDefault()
    event.stopPropagation()
    this.openInlineBlockEditor(block, target.closest('img.md-asset') ? '' : undefined)
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
    const definitions: Array<[string, string, string]> = [
      ['标题', '## ', ''], ['B', '**', '**'], ['I', '*', '*'], ['S', '~~', '~~'], ['引用', '> ', ''], ['链接', '[', '](https://)'],
    ]
    for (const [label, prefix, suffix] of definitions) {
      const button = document.createElement('button')
      button.textContent = label
      button.addEventListener('click', () => this.wrapEditorSelection(textarea, prefix, suffix))
      tools.appendChild(button)
    }
    const spacer = document.createElement('span')
    spacer.className = 'spacer'
    const save = document.createElement('button')
    save.textContent = '保存'
    const cancel = document.createElement('button')
    cancel.textContent = '取消'
    tools.append(spacer, save, cancel)
    editor.append(tools, textarea)
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
        detail: 'inline Markdown block edit',
        timestamp: new Date().toISOString(),
      })
    })
    textarea.addEventListener('keydown', event => {
      if (event.key === 'Escape') editor.replaceWith(block)
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') save.click()
    })
    textarea.focus()
    if (replacementValue !== undefined) textarea.select()
  }

  private decoratePreviewImages(preview: HTMLElement) {
    for (const image of preview.querySelectorAll<HTMLImageElement>('img')) {
      const source = image.getAttribute('src') || ''
      const imagePath = normalizeAssetPath(source)
      image.removeAttribute('src')
      image.classList.add('md-asset')
      image.dataset.assetPath = imagePath
      image.alt ||= imagePath
      this.observeRenderedImage(image)

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
      actions.append(replace, remove, removeBoth)
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
    const markdown = this.markdownText || ''
    const offsets = [0]
    for (let index = 0; index < markdown.length; index++) {
      if (markdown[index] === '\n') offsets.push(index + 1)
    }
    return [offsets[startLine] ?? markdown.length, offsets[endLine] ?? markdown.length]
  }

  private buildSourceEditor() {
    const pane = this.shadowRoot?.getElementById('mdPane')
    if (!pane) return
    const value = this.sourceDraft
    this.sourceEditor?.destroy()
    pane.innerHTML = ''
    const host = document.createElement('div')
    host.className = 'source-editor-host'
    pane.appendChild(host)
    const plugins = [...this.markdownEditorPlugins]
    if (this.vimEnabled && !plugins.some(plugin => plugin.name === 'vim')) plugins.push(createVimEditorPlugin())
    this.sourceEditor = new MarkdownSourceEditor({
      parent: host,
      document: value,
      plugins,
      onChange: next => {
        this.sourceDraft = next
        const status = this.shadowRoot?.getElementById('sourceStatus')
        if (status) status.textContent = next === this.markdownText ? '' : '未保存'
      },
    })
    this.sourceEditor.view.dom.style.fontSize = `${Math.round(14 * this.markdownZoom)}px`
    this.sourceDraft = value
    this.updateModeToolbar()
    this.sourceEditor.focus()
  }

  private switchToSourceMode() {
    if (this.markdownText == null || this.markdownMode === 'source') return
    this.markdownMode = 'source'
    this.sourceDraft = this.markdownText
    this.buildSourceEditor()
    this.updateSearchResults()
  }

  private saveSourceAndPreview() {
    if (this.markdownMode !== 'source') return
    const next = this.sourceEditor?.getValue() ?? this.sourceDraft
    const previousMarkdown = this.markdownText || ''
    const previousSections = this.sections
    if (next !== previousMarkdown) {
      this.undoStack.push({ type: 'restore-markdown', markdown: previousMarkdown })
      this.markdownText = next
      this.reviewEdits.push({ type: 'edit-markdown', detail: 'edited full Markdown source', timestamp: new Date().toISOString() })
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

  private updateModeToolbar() {
    const shadow = this.shadowRoot
    if (!shadow) return
    shadow.getElementById('mdPreviewMode')?.classList.toggle('active', this.markdownMode === 'preview')
    shadow.getElementById('mdSourceMode')?.classList.toggle('active', this.markdownMode === 'source')
    const vimButton = shadow.getElementById('vimToggle')
    if (vimButton) vimButton.textContent = `Vim：${this.vimEnabled ? '开' : '关'}`
    ;(shadow.getElementById('sourceSave') as HTMLButtonElement | null)?.toggleAttribute('hidden', this.markdownMode !== 'source')
    ;(shadow.getElementById('sourceCancel') as HTMLButtonElement | null)?.toggleAttribute('hidden', this.markdownMode !== 'source')
    const status = shadow.getElementById('sourceStatus')
    if (status && this.markdownMode === 'preview') status.textContent = ''
    const undo = shadow.getElementById('undo') as HTMLButtonElement | null
    if (undo) undo.disabled = this.undoStack.length === 0 || this.markdownMode === 'source'
  }

  private updatePluginStyles() {
    const style = this.shadowRoot?.getElementById('markdownPluginStyles')
    if (style) style.textContent = this.previewRenderer.styles()
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
    this.undoStack.push({ type: 'restore-image', zipPath, data: previousData })
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
    this.undoStack.push({ type: 'restore-markdown-and-image', markdown: previousMarkdown, zipPath, data })
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
    this.undoStack.push({ type: 'restore-markdown', markdown: previousMarkdown })
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
    if (!this.sourceDirectoryHandle || this.markdownText == null || !this.markdownPath) return
    if (this.markdownMode === 'source') this.saveSourceAndPreview()
    const markdownRelativePath = this.relativeToSourceRoot(this.markdownPath)
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
      await this.writeLocalFile(markdownRelativePath, this.markdownText)
      this.zip?.file(this.markdownPath, this.markdownText)
      for (const zipPath of this.pendingDeletedAssets) {
        await this.removeLocalFile(this.relativeToSourceRoot(zipPath))
      }
      this.pendingDeletedAssets.clear()
      this.setStatus(`已覆盖保存 ${markdownRelativePath}`)
      if (button) button.textContent = '已保存到本地'
    } catch (error) {
      alert(`保存失败：${error instanceof Error ? error.message : String(error)}`)
      if (button) button.textContent = '保存失败'
    } finally {
      setTimeout(() => {
        if (!button) return
        button.textContent = '覆盖保存 Markdown'
        button.disabled = !this.sourceDirectoryHandle
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
    this.reviewEdits = []
    this.sourceDirectoryHandle = null
    this.pendingDeletedAssets.clear()
  }

  private setStatus(message: string) {
    const stat = this.shadowRoot?.getElementById('stat')
    if (stat) stat.textContent = message
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('mineru-layout-viewer')) {
  customElements.define('mineru-layout-viewer', MineruLayoutViewer)
}
