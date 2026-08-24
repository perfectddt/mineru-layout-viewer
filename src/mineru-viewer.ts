import JSZip from 'jszip'
import { parseBlocks, normalizeAssetPath } from './parse-blocks.js'
import { matchMarkdownToPdf, matchSectionsToPdf, normalize, lcsSimilarity } from './match-markdown.js'
import { parseMarkdownSections } from './parse-markdown.js'
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
  type: 'replace-image' | 'remove-image-reference' | 'image-to-text' | 'edit-markdown' | 'replace-text'
  imagePath?: string
  detail?: string
  timestamp: string
}

type UndoAction =
  | { type: 'restore-markdown'; markdown: string }
  | { type: 'restore-image'; zipPath: string; data: Uint8Array }

const STYLES = `
:host { position:relative; display:flex; flex-direction:column; height:100%; font-family:system-ui,sans-serif; color:#1f2937; background:#fff; }
* { box-sizing:border-box; }
.toolbar { display:flex; align-items:center; gap:8px; padding:7px 10px; border-bottom:1px solid #e5e7eb; font-size:12px; color:#6b7280; flex-shrink:0; flex-wrap:wrap; }
.toolbar .spacer { flex:1; }
.toolbar .ok { color:#16a34a; }
.toolbar .warn { color:#d97706; }
.toolbar .dirty { color:#b45309; font-weight:600; }
.toolbar-group { display:flex; align-items:center; gap:4px; padding-left:7px; border-left:1px solid #e5e7eb; }
.toolbar-label { color:#6b7280; }
.zoom-value { min-width:42px; text-align:center; color:#374151; }
button { border:1px solid #d1d5db; border-radius:5px; padding:5px 9px; background:#fff; color:#374151; cursor:pointer; font:inherit; }
button:hover:not(:disabled) { border-color:#3b82f6; color:#1d4ed8; background:#eff6ff; }
button:disabled { cursor:not-allowed; opacity:.45; }
button.danger:hover:not(:disabled) { border-color:#dc2626; color:#b91c1c; background:#fef2f2; }
.split { flex:1; display:grid; grid-template-columns:1fr 1fr; min-height:0; overflow:hidden; }
.pane { overflow:auto; padding:10px; }
.pane-left { border-right:1px solid #e5e7eb; background:#f8fafc; }
.pane-right { background:#fff; --md-zoom:1; --md-image-width:100%; --md-image-height:520px; }
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
.md-line.active,.image-card.active { background:rgba(37,99,235,.08); border-color:#2563eb; box-shadow:inset 0 0 0 1px rgba(37,99,235,.25); }
.badge { display:inline-block; font-size:10px; color:#6b7280; margin-left:6px; font-family:system-ui,sans-serif; }
.image-card { border:1px solid #e5e7eb; border-left:3px solid #f59e0b; border-radius:7px; margin:8px 0; overflow:hidden; background:#fff; cursor:pointer; }
.image-preview { min-height:90px; display:flex; align-items:center; justify-content:center; padding:10px; background:#f8fafc; }
.image-preview img { display:block; max-width:var(--md-image-width); max-height:var(--md-image-height); object-fit:contain; }
.image-error { color:#b91c1c; font-size:12px; padding:16px; word-break:break-all; }
.image-meta { display:flex; align-items:center; gap:7px; padding:7px 9px; border-top:1px solid #e5e7eb; font-size:11px; color:#6b7280; }
.image-path { flex:1; min-width:0; font-family:'Cascadia Code',Consolas,monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.image-actions { display:flex; gap:6px; padding:0 9px 9px; justify-content:flex-end; }
.find-bar { display:none; align-items:center; gap:6px; padding:7px 10px; border-bottom:1px solid #e5e7eb; background:#f8fafc; flex-shrink:0; }
.find-bar.open { display:flex; }
.find-bar input { min-width:120px; flex:1; max-width:280px; border:1px solid #d1d5db; border-radius:5px; padding:6px 8px; font:12px system-ui,sans-serif; }
.find-result { min-width:80px; font-size:11px; color:#6b7280; }
.legend { display:flex; align-items:center; gap:8px; font-size:10px; color:#6b7280; }
.legend i { display:inline-block; width:12px; height:8px; margin-right:3px; vertical-align:middle; border:1px solid #2563eb; }
.legend .visual { border:2px solid #f59e0b; }
.legend .removed { border:2px dashed #dc2626; background:rgba(220,38,38,.12); }
.editor-backdrop { position:absolute; inset:0; z-index:100; display:flex; align-items:center; justify-content:center; padding:24px; background:rgba(15,23,42,.42); }
.editor-dialog { width:min(850px,96%); max-height:92%; display:flex; flex-direction:column; border:1px solid #cbd5e1; border-radius:9px; background:#fff; box-shadow:0 20px 45px rgba(15,23,42,.28); overflow:hidden; }
.editor-title { padding:10px 12px; font-weight:600; border-bottom:1px solid #e5e7eb; }
.editor-tools { display:flex; gap:5px; align-items:center; padding:7px 10px; border-bottom:1px solid #e5e7eb; }
.editor-tools .code-tab { color:#2563eb; background:#eff6ff; }
.editor-area { width:100%; min-height:150px; max-height:62vh; resize:vertical; border:0; outline:0; padding:12px; font:14px/1.65 'Cascadia Code',Consolas,monospace; color:#111827; }
.editor-dialog.full .editor-area { min-height:58vh; }
.editor-actions { display:flex; justify-content:flex-end; gap:8px; padding:9px 11px; border-top:1px solid #e5e7eb; }
.editor-actions .save { background:#111827; color:#fff; border-color:#111827; }
.pane-shell { min-height:0; position:relative; display:flex; flex-direction:column; }
.empty { display:flex; align-items:center; justify-content:center; height:100%; color:#9ca3af; text-align:center; padding:30px; }
@media (prefers-color-scheme:dark) {
  :host { color:#e5e7eb; background:#111827; }
  .toolbar,.toolbar-group,.find-bar,.pane-left,.image-meta,.editor-title,.editor-tools,.editor-actions { border-color:#374151; }
  .pane-left,.image-preview { background:#111827; }
  .pane-right,.image-card,.pdf-page,button,.editor-dialog,.editor-area,.find-bar { background:#1f2937; color:#e5e7eb; }
  .image-card { border-color:#374151; border-left-color:#f59e0b; }
  .image-meta { color:#9ca3af; }
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
          removedImages: 'Markdown reference removed; original ZIP asset and JSON retained',
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
    } else if (this.zip) {
      this.zip.file(action.zipPath, action.data)
      this.revokeAssetUrl(action.zipPath)
      this.rebuildMarkdownView()
    }
    this.updateToolbar()
  }

  private render() {
    if (!this.shadowRoot) return
    this.shadowRoot.innerHTML = `<style>${STYLES}</style>
      <div class="toolbar">
        <span id="stat">加载 MinerU ZIP 以开始</span>
        <span id="dirty"></span>
        <span class="spacer"></span>
        <div class="legend"><span><i></i>文字</span><span><i class="visual"></i>图片</span><span><i class="removed"></i>已删/未引用</span></div>
        <div class="toolbar-group">
          <span class="toolbar-label">PDF</span>
          <button id="pdfZoomOut" title="缩小 PDF">−</button>
          <span id="pdfZoomValue" class="zoom-value">适合宽度</span>
          <button id="pdfZoomIn" title="放大 PDF">＋</button>
          <button id="fitPage">整页</button>
          <button id="fitWidth">页宽</button>
        </div>
        <div class="toolbar-group">
          <span class="toolbar-label">右侧</span>
          <button id="mdZoomOut" title="缩小 Markdown">−</button>
          <span id="mdZoomValue" class="zoom-value">100%</span>
          <button id="mdZoomIn" title="放大 Markdown">＋</button>
        </div>
        <button id="toggleFind">查找替换</button>
        <button id="editAll">全文编辑</button>
        <button id="undo" disabled>撤销</button>
        <button id="export" disabled>导出修改版 ZIP</button>
      </div>
      <div class="find-bar" id="findBar">
        <input id="findText" placeholder="查找文字（Ctrl+F）">
        <input id="replaceText" placeholder="替换为">
        <button id="findNext">下一处</button>
        <button id="replaceOne">替换当前</button>
        <button id="replaceAll">全部替换</button>
        <span id="findResult" class="find-result"></span>
        <button id="closeFind" title="关闭">×</button>
      </div>
      <div class="split">
        <div class="pane pane-left" id="pdfPane"><slot name="loading">加载 PDF + JSON 以开始</slot></div>
        <div class="pane pane-right" id="mdPane"><div class="empty">右侧将显示 Markdown 审核内容</div></div>
      </div>`

    this.shadowRoot.getElementById('undo')!.addEventListener('click', () => {
      void this.undoLastEdit()
    })
    this.shadowRoot.getElementById('export')!.addEventListener('click', () => {
      void this.exportEditedZip()
    })
    this.shadowRoot.getElementById('pdfZoomOut')!.addEventListener('click', () => this.changePdfZoom(-0.1))
    this.shadowRoot.getElementById('pdfZoomIn')!.addEventListener('click', () => this.changePdfZoom(0.1))
    this.shadowRoot.getElementById('fitPage')!.addEventListener('click', () => this.setPdfFitMode('page'))
    this.shadowRoot.getElementById('fitWidth')!.addEventListener('click', () => this.setPdfFitMode('width'))
    this.shadowRoot.getElementById('mdZoomOut')!.addEventListener('click', () => this.changeMarkdownZoom(-0.1))
    this.shadowRoot.getElementById('mdZoomIn')!.addEventListener('click', () => this.changeMarkdownZoom(0.1))
    this.shadowRoot.getElementById('toggleFind')!.addEventListener('click', () => this.toggleFindBar(true))
    this.shadowRoot.getElementById('closeFind')!.addEventListener('click', () => this.toggleFindBar(false))
    this.shadowRoot.getElementById('findNext')!.addEventListener('click', () => this.findNext())
    this.shadowRoot.getElementById('replaceOne')!.addEventListener('click', () => this.replaceCurrentMatch())
    this.shadowRoot.getElementById('replaceAll')!.addEventListener('click', () => this.replaceAllMatches())
    this.shadowRoot.getElementById('editAll')!.addEventListener('click', () => this.openMarkdownEditor())
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
    dirty.className = this.reviewEdits.length ? 'dirty' : ''
    dirty.textContent = this.reviewEdits.length ? `已修改 ${this.reviewEdits.length} 项` : ''
    ;(shadow.getElementById('undo') as HTMLButtonElement).disabled = this.undoStack.length === 0
    ;(shadow.getElementById('export') as HTMLButtonElement).disabled = !this.zip
    const pdfZoomValue = shadow.getElementById('pdfZoomValue')
    if (pdfZoomValue) {
      pdfZoomValue.textContent = this.pdfFitMode === 'page'
        ? '适合整页'
        : this.pdfFitMode === 'width' ? '适合宽度' : `${Math.round(this.pdfZoom * 100)}%`
    }
    const mdZoomValue = shadow.getElementById('mdZoomValue')
    if (mdZoomValue) mdZoomValue.textContent = `${Math.round(this.markdownZoom * 100)}%`
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
    const pane = this.shadowRoot!.getElementById('mdPane')!
    this.imageObserver?.disconnect()
    pane.innerHTML = ''
    if (!this.sections.length) {
      pane.innerHTML = '<div class="empty">没有可显示的 Markdown 内容</div>'
      return
    }

    for (let index = 0; index < this.sections.length; index++) {
      const section = this.sections[index]
      if (section.kind === 'image' && section.imagePath) {
        pane.appendChild(this.createImageCard(section, index))
      } else {
        const line = document.createElement('span')
        line.className = 'md-line ' + (section.bbox ? 'match' : 'no-match')
        line.tabIndex = 0
        line.dataset.idx = String(index)
        line.textContent = section.text
        if (section.bbox) {
          const badge = document.createElement('span')
          badge.className = 'badge'
          badge.textContent = `p${section.page}`
          line.appendChild(badge)
        }
        line.addEventListener('click', () => this.onMdClick(section, index, line))
        line.addEventListener('dblclick', event => {
          event.preventDefault()
          this.openSectionEditor(section, false)
        })
        line.title = '单击定位 PDF；双击编辑此行'
        pane.appendChild(line)
      }
    }
  }

  private createImageCard(section: MdSection, index: number): HTMLElement {
    const card = document.createElement('article')
    card.className = 'image-card' + (section.bbox ? ' match' : ' no-match')
    card.tabIndex = 0
    card.dataset.idx = String(index)
    card.dataset.imagePath = section.imagePath

    const preview = document.createElement('div')
    preview.className = 'image-preview'
    preview.textContent = '加载图片…'
    card.appendChild(preview)

    const meta = document.createElement('div')
    meta.className = 'image-meta'
    const path = document.createElement('span')
    path.className = 'image-path'
    path.title = section.imagePath!
    path.textContent = section.imagePath!
    meta.appendChild(path)
    if (section.bbox) {
      const badge = document.createElement('span')
      badge.className = 'badge'
      badge.textContent = `p${section.page}`
      meta.appendChild(badge)
    }
    card.appendChild(meta)

    const actions = document.createElement('div')
    actions.className = 'image-actions'
    const replaceButton = document.createElement('button')
    replaceButton.textContent = '替换图片'
    replaceButton.addEventListener('click', event => {
      event.stopPropagation()
      this.chooseReplacement(section)
    })
    const toTextButton = document.createElement('button')
    toTextButton.textContent = '改为文字'
    toTextButton.addEventListener('click', event => {
      event.stopPropagation()
      this.openSectionEditor(section, true)
    })
    const removeButton = document.createElement('button')
    removeButton.className = 'danger'
    removeButton.textContent = '从 Markdown 删除'
    removeButton.addEventListener('click', event => {
      event.stopPropagation()
      this.removeImageReference(section)
    })
    actions.append(replaceButton, toTextButton, removeButton)
    card.appendChild(actions)

    card.addEventListener('click', () => this.onMdClick(section, index, card))
    this.observeImageCard(card)

    return card
  }

  private observeImageCard(card: HTMLElement) {
    if (typeof IntersectionObserver === 'undefined') {
      void this.loadImageCard(card)
      return
    }
    if (!this.imageObserver) {
      const pane = this.shadowRoot!.getElementById('mdPane')!
      this.imageObserver = new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const target = entry.target as HTMLElement
          this.imageObserver?.unobserve(target)
          void this.loadImageCard(target)
        }
      }, { root: pane, rootMargin: '600px 0px' })
    }
    this.imageObserver.observe(card)
  }

  private async loadImageCard(card: HTMLElement) {
    const imagePath = card.dataset.imagePath
    const preview = card.querySelector('.image-preview') as HTMLElement | null
    if (!imagePath || !preview) return
    try {
      const url = await this.getAssetUrl(imagePath)
      if (!card.isConnected) return
      preview.textContent = ''
      const image = document.createElement('img')
      image.src = url
      image.alt = imagePath
      preview.appendChild(image)
    } catch (error) {
      if (!card.isConnected) return
      preview.textContent = ''
      const message = document.createElement('div')
      message.className = 'image-error'
      message.textContent = error instanceof Error ? error.message : String(error)
      preview.appendChild(message)
    }
  }

  private onMdClick(section: MdSection, index: number, element: HTMLElement) {
    const shadow = this.shadowRoot!
    shadow.querySelectorAll('.active').forEach(item => item.classList.remove('active'))
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
    shadow.querySelectorAll('.active').forEach(item => item.classList.remove('active'))
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
    })
  }

  private openSectionEditor(section: MdSection, imageToText: boolean) {
    this.showEditor({
      title: imageToText ? '将图片改为文字' : '编辑 Markdown 行',
      value: imageToText ? '' : section.raw,
      placeholder: imageToText ? '输入用来替代这张图片的文字或 Markdown…' : '',
      full: false,
      onSave: value => {
        if (imageToText && !value.trim()) {
          alert('请输入替代文字；如果只想删除图片，请使用“从 Markdown 删除”。')
          return false
        }
        const source = this.markdownText?.slice(section.start, section.end) || ''
        const newline = source.match(/\r?\n$/)?.[0] || ''
        this.replaceMarkdownRange(section.start, section.end, value + newline, {
          type: imageToText ? 'image-to-text' : 'edit-markdown',
          imagePath: imageToText ? section.imagePath : undefined,
          detail: imageToText ? value.slice(0, 120) : 'edited one Markdown line',
          timestamp: new Date().toISOString(),
        })
        return true
      },
    })
  }

  private openMarkdownEditor() {
    if (this.markdownText == null) return
    this.showEditor({
      title: '全文 Markdown 编辑',
      value: this.markdownText,
      full: true,
      onSave: value => {
        if (value === this.markdownText) return true
        this.replaceMarkdownRange(0, this.markdownText!.length, value, {
          type: 'edit-markdown',
          detail: 'edited full Markdown source',
          timestamp: new Date().toISOString(),
        })
        return true
      },
    })
  }

  private showEditor(options: {
    title: string
    value: string
    placeholder?: string
    full: boolean
    onSave: (value: string) => boolean
  }) {
    const shadow = this.shadowRoot
    if (!shadow) return
    shadow.querySelector('.editor-backdrop')?.remove()

    const backdrop = document.createElement('div')
    backdrop.className = 'editor-backdrop'
    const dialog = document.createElement('section')
    dialog.className = 'editor-dialog' + (options.full ? ' full' : '')
    const title = document.createElement('div')
    title.className = 'editor-title'
    title.textContent = options.title
    const tools = document.createElement('div')
    tools.className = 'editor-tools'
    const textarea = document.createElement('textarea')
    textarea.className = 'editor-area'
    textarea.value = options.value
    textarea.placeholder = options.placeholder || ''

    const toolDefinitions: Array<[string, string, string]> = [
      ['CODE', '', ''], ['标题', '## ', ''], ['B', '**', '**'], ['I', '*', '*'], ['S', '~~', '~~'], ['引用', '> ', ''], ['链接', '[', '](https://)'],
    ]
    for (const [label, prefix, suffix] of toolDefinitions) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = label
      if (label === 'CODE') {
        button.className = 'code-tab'
        button.disabled = true
      } else {
        button.addEventListener('click', () => this.wrapEditorSelection(textarea, prefix, suffix))
      }
      tools.appendChild(button)
    }

    const actions = document.createElement('div')
    actions.className = 'editor-actions'
    const cancel = document.createElement('button')
    cancel.textContent = '取消'
    const save = document.createElement('button')
    save.className = 'save'
    save.textContent = '保存'
    const close = () => backdrop.remove()
    cancel.addEventListener('click', close)
    save.addEventListener('click', () => {
      if (options.onSave(textarea.value)) close()
    })
    actions.append(save, cancel)
    dialog.append(title, tools, textarea, actions)
    backdrop.appendChild(dialog)
    backdrop.addEventListener('click', event => {
      if (event.target === backdrop) close()
    })
    textarea.addEventListener('keydown', event => {
      if (event.key === 'Escape') close()
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault()
        save.click()
      }
    })
    shadow.appendChild(backdrop)
    textarea.focus()
    if (!options.full) textarea.select()
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
    if (open) (this.shadowRoot?.getElementById('findText') as HTMLInputElement | null)?.focus()
  }

  private findNext() {
    const markdown = this.markdownText || ''
    const input = this.shadowRoot?.getElementById('findText') as HTMLInputElement | null
    const query = input?.value || ''
    if (!query) return this.setFindResult('请输入内容')
    const source = markdown.toLocaleLowerCase()
    const needle = query.toLocaleLowerCase()
    let index = source.indexOf(needle, this.findCursor)
    if (index < 0 && this.findCursor > 0) index = source.indexOf(needle)
    if (index < 0) {
      this.currentFindStart = -1
      return this.setFindResult('未找到')
    }
    this.currentFindStart = index
    this.findCursor = index + Math.max(query.length, 1)
    const sectionIndex = this.sections.findIndex(section => section.start <= index && section.end > index)
    const element = sectionIndex >= 0
      ? this.shadowRoot?.querySelector(`[data-idx="${sectionIndex}"]`) as HTMLElement | null
      : null
    if (element) {
      this.shadowRoot?.querySelectorAll('.active').forEach(item => item.classList.remove('active'))
      element.classList.add('active')
      element.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
    const total = source.split(needle).length - 1
    const ordinal = source.slice(0, index).split(needle).length
    this.setFindResult(`${ordinal}/${total}`)
  }

  private replaceCurrentMatch() {
    const findInput = this.shadowRoot?.getElementById('findText') as HTMLInputElement | null
    const replaceInput = this.shadowRoot?.getElementById('replaceText') as HTMLInputElement | null
    const query = findInput?.value || ''
    if (!query) return this.setFindResult('请输入内容')
    if (this.currentFindStart < 0
      || this.markdownText?.slice(this.currentFindStart, this.currentFindStart + query.length).toLocaleLowerCase() !== query.toLocaleLowerCase()) {
      this.findNext()
      if (this.currentFindStart < 0) return
    }
    const start = this.currentFindStart
    const replacement = replaceInput?.value || ''
    this.replaceMarkdownRange(start, start + query.length, replacement, {
      type: 'replace-text',
      detail: `replace one: ${query}`,
      timestamp: new Date().toISOString(),
    })
    this.findCursor = start + replacement.length
    this.currentFindStart = -1
    this.findNext()
  }

  private replaceAllMatches() {
    if (this.markdownText == null) return
    const findInput = this.shadowRoot?.getElementById('findText') as HTMLInputElement | null
    const replaceInput = this.shadowRoot?.getElementById('replaceText') as HTMLInputElement | null
    const query = findInput?.value || ''
    if (!query) return this.setFindResult('请输入内容')
    const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    let count = 0
    const replacement = replaceInput?.value || ''
    const next = this.markdownText.replace(expression, () => {
      count++
      return replacement
    })
    if (!count) return this.setFindResult('未找到')
    this.replaceMarkdownRange(0, this.markdownText.length, next, {
      type: 'replace-text',
      detail: `replace all ${count}: ${query}`,
      timestamp: new Date().toISOString(),
    })
    this.currentFindStart = -1
    this.findCursor = 0
    this.setFindResult(`已替换 ${count} 处`)
  }

  private setFindResult(message: string) {
    const result = this.shadowRoot?.getElementById('findResult')
    if (result) result.textContent = message
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
  }

  private setStatus(message: string) {
    const stat = this.shadowRoot?.getElementById('stat')
    if (stat) stat.textContent = message
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('mineru-layout-viewer')) {
  customElements.define('mineru-layout-viewer', MineruLayoutViewer)
}
