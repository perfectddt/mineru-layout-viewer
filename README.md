# MinerU Layout Viewer

On Windows, double-click `start-viewer.cmd` to start the local server from the
project root and open the viewer automatically. It prefers `http://127.0.0.1:18768/`
and automatically chooses a free loopback port when that port is occupied. Avoid opening `index.html`
through `file://`, because browser security restrictions can prevent folder
write-back, plugin fonts, dynamic resources, or PDF workers from loading.

Run `install-windows-integration.cmd` once to create the desktop shortcut with
the application icon and add MinerU Layout Viewer to **Open with** for ZIP,
Markdown, and Org files. You can also drop any supported file or a MinerU result
folder onto the shortcut. Markdown and Org files opened this way support writing
changes back to the original file.

Visualize [MinerU](https://github.com/opendatalab/MinerU) `layout.json` / `middle.json` output — side-by-side PDF + Markdown with bidirectional click-to-navigate.

[English](#english) | [中文](#chinese) | [完整更新记录](CHANGELOG.md)

---

<a name="english"></a>
## English

### Demo

Drop a MinerU export `.zip` (or PDF + `layout.json`) onto the page:

```html
<mineru-layout-viewer
  pdf="document.pdf"
  layout="layout.json"
  markdown="full.md">
</mineru-layout-viewer>
```

### Features

- **Dual-pane view** — PDF pages on the left, Markdown text on the right
- **Bidirectional navigation** — click a Markdown line → scrolls to the corresponding PDF block and highlights it; click a PDF overlay → scrolls to the matching Markdown line
- **Open at a source line** — `start-viewer.cmd notes.md +120`, `--line 120 notes.md`, or `notes.md:120` opens the file and scrolls to that line
- **Multi-format support** — automatically detects `layout.json`, `middle.json`, `content_list.json`, and `content_list_v2.json`, including page numbers, headers, footers, and page footnotes. Edited Markdown keeps page breaks aligned to the unchanged lines.
- **Nested block handling** — resolves list items, table cells, and other nested blocks to their leaf coordinates
- **Framework-agnostic** — built as a Web Component, works with React, Vue, or plain HTML
- **Zip support** — drop a MinerU output `.zip` directly, auto-extracts PDF + layout + markdown
- **Folder support** — select an uncompressed MinerU result directory directly (no ZIP required)
- **Folder drag/drop** — recursively opens modern directory handles with a legacy WebKit fallback
- **Stage-aware progress + ETA** — shows the active load stage and only estimates time for measurable byte/file/decompression stages
- **Resizable workspace + outlines** — arrange PDF/Markdown side-by-side or top/bottom, swap their positions, and drag the split; outlines also support side/stack layouts
- **Persistent settings** — remember workspace ratios, outline direction/size, and a trusted default render plugin
- **Standalone Markdown editor** — CodeMirror/live-preview panes support side or stacked layout, draggable ratios, center-line swapping, and bidirectional navigation
- **Typora-style hybrid editing** — focusing a rendered block reveals its real Markdown/Org markers with syntax styling while bold, italic, heading, and math semantics remain visible
- **Standalone Org editor** — open `.org` files with the same preview/live/Code/Vim, outline, search/replace, history, zoom, layout, and local-save workflow
- **Org metadata and code rendering** — source/example blocks, fixed-width lines, planning timestamps, property drawers, and Org tables with or without separator rows
- **Large PDF support** — renders PDF pages only near the viewport
- **Rendered Markdown preview** — CommonMark formatting, tables, lists, quotes, code blocks, links, and lazy-loaded images
- **Lazy image loading** — only decode image cards near the viewport for large review jobs
- **Replace / soft-delete / undo/redo** — replace an asset in-place or remove only its Markdown reference while retaining audit evidence
- **Typora-style editing flow** — preview by default; double-click a rendered block to edit it in place
- **Full source + Vim mode** — CodeMirror 6 fills the right pane, with an optional Vim keybinding plugin; the rendered preview and live preview accept `:` commands (`:42` jumps to a source line, `:$` to the last line, `:w` saves, `:noh` clears search), normal-mode motions (`gg` / `G` with optional counts like `42G`), and `/` incremental search with `n` / `N`. Preview, live preview, and source mode share absolute, relative, or hidden line numbers; a multi-line preview block is labelled with its first source line only (a table spanning lines 4-9 is labelled `4`)
- **Reveal in folder** — after the Windows shortcut opens a file or MinerU folder, the toolbar locates that file in Explorer
- **Plugin APIs** — extend Markdown-it rendering/styles and CodeMirror editor extensions
- **Find result navigator** — red preview highlights plus a clickable result list, replace-one, and replace-all
- **Independent zoom** — PDF fit-page/fit-width/custom zoom and separate Markdown/image zoom
- **Persistent layout boxes** — text, image, and removed/unreferenced image boxes use distinct always-visible colors
- **Edited ZIP export** — download a new ZIP with edited Markdown, replacement assets, and `review_edits.json`

### Recent performance and reliability updates

The current `my-main` branch includes three related large-document improvements:

1. **Ordered matching in a Web Worker** — Markdown sections are matched against a local reading-order window instead of scanning every PDF block globally. Repeated headings no longer jump backwards, page furniture is excluded, HTML tables stay on table blocks, and the work no longer blocks the UI thread.
2. **Range-based folder loading** — when a MinerU result folder is opened through the Windows launcher, the original PDF is served with HTTP Range requests. The browser reads page data on demand; the full PDF is fetched only when an edited ZIP must include it. A directly dropped ZIP still has to decompress its embedded PDF.
3. **Virtual PDF canvases** — all page shells and overlays remain available for navigation, but Canvas pixels exist only inside a 900 px viewport buffer. Leaving that buffer cancels unfinished rendering, zeroes the Canvas dimensions, and removes it; returning to the page renders it again.

PDF rendering can be changed from either the PDF toolbar or **Settings → PDF rendering**:

| Mode | Behavior | Recommended use |
|------|----------|-----------------|
| Fast (default) | Caps the render scale at `1.15×` | Normal review, rapid scrolling, large PDFs |
| Quality | Uses zoom and display density, capped at `3×` | Small text, figures, and final visual checking |

The Windows launcher prefers port `18768`. If another application owns it, the Viewer uses an OS-selected free loopback port and records the actual port, token, and PID in `%TEMP%\mineru-layout-viewer-server.json`. Later launches reuse that verified instance. Always open the app through its shortcut instead of bookmarking a fixed localhost URL.

Validation on a 142 MB, 88-page MinerU folder: 823 of 978 Markdown sections matched (84.2%), no matched page moved backwards, all six HTML tables found table blocks, initial reload completed in about seven seconds, and only two to four PDF canvases remained allocated while navigating between pages 1 and 60.

### Installation

```bash
npm install mineru-layout-viewer
```

#### Via CDN

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>
<script src="https://unpkg.com/mineru-layout-viewer/dist/mineru-layout-viewer.iife.js"></script>
```

Set the PDF.js worker:

```html
<script>
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
</script>
```

### Usage

#### HTML / Web Component

```html
<!-- Attribute-based -->
<mineru-layout-viewer
  pdf="./document.pdf"
  layout="./layout.json"
  markdown="./full.md">
</mineru-layout-viewer>

<!-- Programmatic API (zip) -->
<script>
  const viewer = document.querySelector('mineru-layout-viewer')
  await viewer.loadZip(zipBlob)  // from MinerU export .zip
  await viewer.undoLastEdit()
  await viewer.exportEditedZip()
</script>

<!-- Programmatic API (JSON) -->
<script>
  const viewer = document.querySelector('mineru-layout-viewer')
  viewer.loadLayoutFromJson(jsonData)
  viewer.loadMarkdown(markdownText)
</script>
```

#### JavaScript / ESM

```js
import {
  parseBlocks,
  matchMarkdownToPdf,
  MineruLayoutViewer,
} from 'mineru-layout-viewer'

// Parse a layout.json string into blocks
const blocks = parseBlocks(layoutJsonStr)

// Match markdown paragraphs to PDF blocks
const sections = matchMarkdownToPdf(markdown, blocks)

// Each section: { text, page, bbox: [x0,y0,x1,y1] | null }
```

### API

#### `parseBlocks(jsonStr: string): PdfBlock[]`

Parses a MinerU JSON file (`layout.json`, `middle.json`, `content_list.json`, or `content_list_v2.json`) into an array of leaf-level blocks. Page numbers, headers, footers, margin notes, and page footnotes are kept for PDF overlays and are not used as body matches.

```ts
interface PdfBlock {
  id: string
  page_idx: number              // 0-based page index
  bbox: [number, number, number, number]  // normalized [x0,y0,x1,y1], 0..1
  text?: string                  // extracted span content
  type?: string                  // block type: "text", "title", "list", etc.
  imagePath?: string             // image path inside the MinerU result
}
```

#### `matchMarkdownToPdf(markdown: string, blocks: PdfBlock[]): MdSection[]`

Matches markdown text (split by lines) to PDF blocks using LCS similarity.

```ts
interface MdSection {
  id: string
  raw: string
  text: string
  start: number                  // exact source offsets in Markdown
  end: number
  kind: 'text' | 'image' | 'other'
  imagePath?: string
  page: number                   // 1-based page number
  bbox: [number, number, number, number] | null
  blockId?: string
}
```

#### `<mineru-layout-viewer>` Attributes

| Attribute  | Description                              |
|------------|------------------------------------------|
| `pdf`      | URL to the PDF file                      |
| `layout`   | URL to `layout.json` / `middle.json`     |
| `markdown` | URL to `full.md` (optional)              |

#### `<mineru-layout-viewer>` Methods

| Method                                  | Description                           |
|-----------------------------------------|---------------------------------------|
| `loadZip(blob: Blob): Promise<void>`    | Load from a MinerU export .zip        |
| `loadDirectory(files: FileList \| File[]): Promise<void>` | Load an uncompressed MinerU result folder |
| `loadDirectoryHandle(handle): Promise<void>` | Load a folder with read/write permission |
| `loadDirectoryEntries(entries): Promise<void>` | Load recursively collected drag/drop files and paths |
| `loadMarkdownFile(file, handle?): Promise<void>` | Open one Markdown or Org file in standalone editor mode |
| `loadLayoutFromJson(data: object\|string)`| Load layout JSON directly           |
| `loadMarkdown(text: string)`            | Load markdown text directly           |
| `revealSourceLine(line: number): boolean` | Scroll to a 1-based source line in the current Markdown or Org view |
| `undoLastEdit(): Promise<void>`          | Undo the most recent image edit        |
| `redoLastEdit(): Promise<void>`          | Redo the most recently undone edit     |
| `exportEditedZip(): Promise<void>`       | Download the edited result ZIP         |
| `registerMarkdownRenderPlugin(plugin)`   | Add Markdown-it rules, preview styles, or post-render hooks |
| `registerMarkdownEditorPlugin(plugin)`   | Add a CodeMirror 6 editor extension     |
| `loadMarkdownRenderPlugin(file, format?)` | Load a trusted local `.js`/`.mjs` plugin for `markdown` or `org` |

```js
viewer.registerMarkdownRenderPlugin({
  name: 'review-heading-theme',
  styles: '.md-preview h2 { color:#0f766e; border-color:#5eead4; }',
  configure(markdownIt) { markdownIt.set({ breaks: true }) },
})
```

The viewer enables sanitized HTML (`<br>`, HTML tables), GFM tables, task lists,
footnotes and KaTeX by default. To customize the appearance, copy
`plugins/ocean-reading-theme.js`, change its scoped `.md-preview` CSS, then click
**Load render plugin**. Markdown and Org keep separate default plugin selections,
so each format can use its own fonts, colors, and background. A plugin is JavaScript
and runs in the page, so only load files you trust. Reuse the name
`mineru-reading-theme` to replace the corresponding built-in theme.

### Image edit semantics

- **Replace** requires the replacement to use the same image format and overwrites the bytes at the original ZIP path. Markdown and JSON paths therefore stay valid.
- **Remove from Markdown** removes only the image reference from Markdown. The original asset and JSON are retained for review/audit and the operation is recorded in `review_edits.json`.
- The original ZIP is never overwritten; export creates an `-edited.zip` download.

### Local development

```bash
npm ci
npm test
npx serve .
```

### Supported JSON Formats

| Format              | Structure                          | Origin    |
|---------------------|------------------------------------|-----------|
| `layout.json`       | `{ pdf_info: [{ preproc_blocks }] }` | top-left  |
| `middle.json`       | `{ pdf_info: [{ para_blocks, discarded_blocks }] }` | top-left  |
| `content_list.json` | `[{ page_idx, bbox, text }]`       | 0–1000    |
| `content_list_v2.json` | `[[{ type, content, bbox }]]` grouped by page | 0–1000 |

### License

MIT

---

<a name="chinese"></a>
## 中文

Windows 用户可直接双击项目根目录的 `start-viewer.cmd`。脚本会从项目根目录
启动本地服务并自动打开浏览器，不需要手动输入网址。服务优先使用 `http://127.0.0.1:18768/`；若端口已被占用，会自动选择其他空闲的本机端口。启动器还会核对页面身份并读取实际端口，避免误打开其他软件。不要通过 `file://` 直接
打开 `index.html`，否则浏览器安全限制可能导致文件夹写回、插件字体、动态资源
或 PDF Worker 无法正常工作。

首次使用可运行 `install-windows-integration.cmd`：它会创建带专用图标的桌面
快捷方式，把 MinerU Layout Viewer 加入 ZIP、Markdown、Org 文件的“打开方式”，
并为文件夹添加“用 MinerU Layout Viewer 打开”右键菜单。也可以把这些文件或
MinerU 结果文件夹直接拖到快捷方式上。通过该方式打开的单个 Markdown/Org 文件
支持覆盖保存回原文件。

启动时可以指定源码行号。查看器会打开文件或 MinerU 结果，并滚动到该行：预览和实时预览高亮包含这一行的块，已匹配的 PDF 会同步定位；源码模式则把光标放到该行。行号从 1 开始。通过这种方式打开后，工具栏的「所在文件夹」会在资源管理器中定位当前文件。

```bat
start-viewer.cmd D:\notes\file.org +120
start-viewer.cmd --line 120 D:\notes\file.md
start-viewer.cmd D:\notes\file.md:120
```

`文件:行号` 只在去掉后缀后的路径真实存在时生效，因此普通的 `C:\目录\文件.md` 不会被误当成行号。`:行号:列号` 也可以识别，列号会被忽略。显式的 `+行号` 或 `--line` 优先于路径后缀。

### 演示

将 MinerU 导出 `.zip`（或 PDF + `layout.json`）拖放到页面上即可：

```html
<mineru-layout-viewer
  pdf="document.pdf"
  layout="layout.json"
  markdown="full.md">
</mineru-layout-viewer>
```

### 特性

- **双栏对照** — 左侧 PDF 页面，右侧 Markdown 文本
- **双向定位** — 点击 Markdown 行 → 滚动到对应 PDF 块并高亮；点击 PDF 覆盖块 → 滚动到匹配的 Markdown 行
- **多格式支持** — 自动识别 `layout.json`、`middle.json`、`content_list.json`、`content_list_v2.json`；页眉、页脚和边注画在 PDF 上，Markdown 预览在每页内容后显示「第 N 页」。改过的正文仍按未改动的原文对齐页码
- **Markdown / JSON 切换** — 右侧可切换两种视图；修改一边的正文，另一边同步，保存时两个文件一起写回
- **嵌套块解析** — 将列表项、表格单元格等嵌套块解析到叶子节点坐标
- **框架无关** — 基于 Web Component，支持 React、Vue 或原生 HTML
- **Zip 直拖** — 直接拖放 MinerU 输出 `.zip`，自动解压 PDF + layout + markdown
- **文件夹直拖** — 支持现代目录句柄，并提供旧版 WebKit 目录递归读取后备方案
- **大 PDF 流式加载** — 通过 Windows 启动器打开文件夹时使用 HTTP Range 按需读取 PDF 页面，不再等待整份 PDF 进入内存；导出修改版 ZIP 时才补读原 PDF
- **Canvas 页面虚拟化** — 仅渲染可视区附近的 PDF Canvas；远离视口后取消未完成任务并主动清空、移除 Canvas，滚回时自动重绘
- **快速 / 高清渲染** — PDF 工具栏和设置中可切换；快速模式限制像素倍率以降低 CPU、显存占用，高清模式随缩放与屏幕像素密度提高分辨率
- **后台有序匹配** — 在 Web Worker 中按阅读顺序和局部窗口匹配 Markdown/PDF，区分正文、表格和页眉页脚，避免重复标题跳到错误页面并减少界面卡顿
- **分阶段动态进度** — 显示载入阶段；仅在字节读取、文件计数和解压等可测阶段估算剩余时间
- **可拖动工作区与目录** — PDF/Markdown 支持左右或上下排列、位置交换和分隔线拖动；书签/大纲也支持左右或上下排列
- **持久化设置** — 记住主工作区比例、目录方向/大小以及 Markdown、Org 各自的渲染插件列表
- **最近打开** — 记录最近使用的本地文件、文件夹和 Windows 启动路径，可从页面右上角快速重新打开
- **单 Markdown 编辑器** — `code` 模式的源码/渲染支持左右或上下排列、拖动比例、中线交换和双向定位
- **Typora 式混合编辑** — 聚焦当前块时显示真实 Markdown/Org 标记并进行语法着色，同时保留粗体、斜体、标题和公式源码的语义样式
- **单 Org 编辑器** — `.org` 文件同样支持预览/实时预览/Code/Vim、大纲、搜索替换、历史、缩放、布局和覆盖保存
- **思维导图** — 把 Markdown/Org 的标题与嵌套列表展开成右向树，节点按行内 Markdown 渲染，可按层级（1/2/3 级）折叠、缩放、拖拽换层级；双击改文字，`Enter`/`Tab`/`Shift+Tab`/`Delete` 增删改结构，全部实时回写源码并可撤销
- **同窗口分屏** — 「右分屏 / 下分屏」把 Markdown 区分成多栏，每栏还能继续再分（左右套上下等不对称布局），各栏独立切换预览/实时预览/code/思维导图，修改实时双向同步；切换模式时自动跟随光标所在源码行
- **Org 元数据与代码渲染** — 支持源码/示例块、固定宽度代码行、计划时间戳、属性抽屉，以及有无分隔行的 Org 表格
- **Markdown 格式化预览** — 渲染标题、列表、引用、表格、代码、链接和懒加载图片
- **图片懒加载** — 只解压接近可视区域的图片，降低大批量审核时的内存占用
- **替换、软删除、撤销/重做** — 原路径替换图片，或仅删除 Markdown 引用并保留审核证据
- **类 Typora 编辑流程** — 默认预览，双击渲染块后直接在原位置编辑
- **全文源码与 Vim** — CodeMirror 6 直接占据右栏，并支持可开关的 Vim 键位插件；预览与实时预览里也能用 Vim：`:` 命令行（`:42` 定位、`:$` 末行、`:w` 覆盖保存、`:noh` 清除搜索）、普通模式动作（`gg` / `G`，支持 `42G`、`3gg` 计数）、`/` 增量搜索与 `n` / `N` 跳转。预览、实时预览和源码共用行号开关，可选关闭、绝对或相对；多行块只标注首个源码行（跨 4-9 行的表格标为 `4`）
- **插件接口** — 可扩展 Markdown-it 渲染规则/样式和 CodeMirror 编辑扩展
- **搜索结果导航** — 预览内红色高亮，并提供可点击跳转的结果列表、单项替换和全部替换
- **左右独立缩放** — PDF 支持整页、页宽和自定义缩放，Markdown 与图片可单独缩放
- **框常显与状态配色** — 文字、图片、已删除或未引用图片使用不同颜色且始终可见
- **导出修改版 ZIP** — 导出修改后的 Markdown、图片以及 `review_edits.json` 操作记录

### 最近的性能与可靠性更新

当前 `my-main` 分支包含三组相互配合的大文档优化：

1. **Web Worker 有序匹配**：Markdown 按阅读顺序和局部候选窗口匹配，不再对全部 PDF 框反复全局扫描；重复标题不会向前跳页，页眉、页脚、页码不参与正文匹配，HTML 表格只落到表格块，计算过程不再阻塞界面线程。
2. **文件夹 PDF Range 加载**：通过 Windows 启动器打开 MinerU 结果文件夹时，原始 PDF 使用 HTTP Range 按页读取；只有导出必须包含原 PDF 的修改版 ZIP 时才完整读取。直接拖入 ZIP 时仍需解压 ZIP 内的 PDF。
3. **PDF Canvas 虚拟化**：全部页面外壳和定位框继续保留，但只有可视区域上下 900px 缓冲区内存在 Canvas。页面离开缓冲区后会取消未完成任务、把 Canvas 尺寸归零并移除；滚回时自动重新渲染。

可在 PDF 顶部工具栏或“设置 → PDF 渲染”切换清晰度：

| 模式 | 行为 | 建议场景 |
|------|------|----------|
| 快速（默认） | 渲染倍率最高 `1.15×` | 日常审核、快速滚动、大型 PDF |
| 高清 | 根据当前缩放和屏幕像素密度渲染，最高 `3×` | 小字、图表和最终视觉检查 |

Windows 启动器优先使用 18768。若该端口已被其他软件占用，Viewer 会使用操作系统分配的空闲本机端口，并把实际端口、令牌和 PID 写入 `%TEMP%\mineru-layout-viewer-server.json`；后续启动会验证并复用该实例。请始终通过快捷方式打开，不要收藏固定的 localhost 地址。

使用一份 142MB、88 页的 MinerU 文件夹验证：978 个 Markdown 段落中匹配 823 个（84.2%），匹配页码倒退为 0，6 个 HTML 表格均对应到表格块；重新加载约 7 秒，在第 1 页与第 60 页之间跳转时仅保留 2–4 个 PDF Canvas。

### 安装

```bash
npm install mineru-layout-viewer
```

#### CDN 引入

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>
<script src="https://unpkg.com/mineru-layout-viewer/dist/mineru-layout-viewer.iife.js"></script>
```

设置 PDF.js Worker：

```html
<script>
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
</script>
```

### 使用方式

#### HTML / Web Component

```html
<!-- 属性方式 -->
<mineru-layout-viewer
  pdf="./document.pdf"
  layout="./layout.json"
  markdown="./full.md">
</mineru-layout-viewer>

<!-- 编程 API（从 zip 加载） -->
<script>
  const viewer = document.querySelector('mineru-layout-viewer')
  await viewer.loadZip(zipBlob)  // 从 MinerU 导出 .zip 加载
  await viewer.undoLastEdit()
  await viewer.exportEditedZip()
</script>

<!-- 编程 API（直接传 JSON） -->
<script>
  const viewer = document.querySelector('mineru-layout-viewer')
  viewer.loadLayoutFromJson(jsonData)
  viewer.loadMarkdown(markdownText)
</script>
```

#### JavaScript / ESM

```js
import {
  parseBlocks,
  matchMarkdownToPdf,
  MineruLayoutViewer,
} from 'mineru-layout-viewer'

// 解析 layout.json 字符串为 block 数组
const blocks = parseBlocks(layoutJsonStr)

// 将 markdown 段落匹配到 PDF block
const sections = matchMarkdownToPdf(markdown, blocks)

// 每个 section: { text, page, bbox: [x0,y0,x1,y1] | null }
```

### API

#### `parseBlocks(jsonStr: string): PdfBlock[]`

将 MinerU JSON 文件（`layout.json`、`middle.json`、`content_list.json` 或 `content_list_v2.json`）解析为叶子级 block 数组。页眉、页脚、边注和页脚注会画在 PDF 上，但不参与正文匹配。Markdown 预览会在每一页匹配内容结束后显示「第 N 页」。改写或增删的段落会留在前后未改行所在的页，页码不会被后文吸走。

```ts
interface PdfBlock {
  id: string
  page_idx: number              // 0-based 页码
  bbox: [number, number, number, number]  // 归一化 0..1 坐标
  text?: string                  // 提取的 span 文本
  type?: string                  // block 类型："text"、"title"、"list" 等
  imagePath?: string             // MinerU 结果内的图片路径
}
```

#### `matchMarkdownToPdf(markdown: string, blocks: PdfBlock[]): MdSection[]`

使用阅读顺序、局部候选窗口和文本相似度将 Markdown 文本匹配到 PDF block。图片按资源路径匹配，表格仅匹配表格块，页眉、页脚和页码不参与正文匹配。组件界面加载时会把这项工作放到 Web Worker 中。

```ts
interface MdSection {
  id: string
  raw: string
  text: string
  start: number                  // Markdown 中的精确字符位置
  end: number
  kind: 'text' | 'image' | 'other'
  imagePath?: string
  page: number                   // 1-based 页码
  bbox: [number, number, number, number] | null
  blockId?: string
}
```

#### `<mineru-layout-viewer>` 属性

| 属性       | 说明                                   |
|------------|----------------------------------------|
| `pdf`      | PDF 文件 URL                           |
| `layout`   | `layout.json` / `middle.json` 文件 URL |
| `markdown` | `full.md` 文件 URL（可选）              |

#### `<mineru-layout-viewer>` 方法

| 方法                                    | 说明                        |
|-----------------------------------------|-----------------------------|
| `loadZip(blob: Blob): Promise<void>`    | 从 Mineru 导出 .zip 加载    |
| `loadDirectory(files: FileList \| File[]): Promise<void>` | 直接加载未压缩的 MinerU 结果文件夹 |
| `loadDirectoryHandle(handle): Promise<void>` | 以可读写权限打开结果文件夹 |
| `loadDirectoryEntries(entries, directPdfUrl?, directPdfPath?): Promise<void>` | 加载目录拖放递归收集的文件和路径；可传入支持 Range 的 PDF URL |
| `loadMarkdownFile(file, handle?): Promise<void>` | 以独立 Markdown 或 Org 编辑器模式打开单文件 |
| `loadLayoutFromJson(data: object\|string)`| 直接加载 layout JSON       |
| `loadMarkdown(text: string)`            | 直接加载 markdown 文本      |
| `revealSourceLine(line: number): boolean` | 滚动到从 1 开始的源码行。预览高亮所在块；源码模式移动光标 |
| `undoLastEdit(): Promise<void>`          | 撤销最近一次图片修改        |
| `redoLastEdit(): Promise<void>`          | 重做最近撤销的修改          |
| `exportEditedZip(): Promise<void>`       | 下载修改后的结果 ZIP        |
| `registerMarkdownRenderPlugin(plugin)`   | 注册 Markdown-it 规则、预览样式或渲染后钩子 |
| `registerMarkdownEditorPlugin(plugin)`   | 注册 CodeMirror 6 编辑扩展   |
| `loadMarkdownRenderPlugin(file, format?)` | 为 `markdown` 或 `org` 追加可信的本地 `.js`/`.mjs` 渲染插件；同名插件会更新替换 |

```js
viewer.registerMarkdownRenderPlugin({
  name: 'review-heading-theme',
  styles: '.md-preview h2 { color:#0f766e; border-color:#5eead4; }',
  configure(markdownIt) { markdownIt.set({ breaks: true }) },
})
```

默认富渲染已启用：经过清洗的 HTML（含 `<br>`、HTML 表格）、GFM 表格、任务列表、
脚注和 KaTeX。想换样式时，复制 `plugins/ocean-reading-theme.js` 并只修改其中
作用于 `.md-preview` 的 CSS，然后点击右上角“设置”按钮。Markdown 与 Org 各有独立的插件列表和本地保存项，同一格式可同时加载多个插件；插件按列表顺序执行，后面的插件可覆盖前面的冲突配置。切换文件格式时只启用对应列表，因此 Markdown 与 Org 的字体、颜色和背景不会互相覆盖。插件会在
页面中执行 JavaScript，只加载自己信任的文件；沿用 `mineru-reading-theme` 名称会
替换对应格式的内置主题，而不是叠加两份主题。

项目还提供了根据 Typora `phycat-prussian.css` 与 `phycat/phycat.light.css` 改编的主题：
`plugins/phycat-prussian-theme.js`。原主题的交叉斜线背景、霞鹜文楷和 Cascadia Code 字体均已保留；字体文件放在
`plugins/phycat/`。插件会依次尝试当前页面相对路径、上级路径和站点根路径，并在字体不可用时回退到系统楷体；修改插件后需在设置中重新选择该文件，以更新浏览器保存的插件源码。
查看器会把插件中的 `@font-face` 单独同步到页面级样式，避免字体声明停留在 Shadow DOM 中而不触发浏览器下载。
原版 `phycat-prussian-theme.js` 与 `everforest-org-theme.js` 保持不变；`phycat-prussian-theme-v2.js` 与 `everforest-org-theme-v2.js` 会在正文标题左侧显示同字号、同颜色的 `H1`–`H6` 层级标记，并按标题等级逐级缩进。`phycat-prussian-theme-v3.js` 在此基础上跟随系统暗色：暗色下用深色纸面，H2 仍保留蓝底白字；浅色外观与 v2 一致。PDF 书签和 Markdown/Org 大纲也显示层级标记，并各自提供标题搜索框。

单 Org 文件还可加载 `plugins/everforest-org-theme.js`。它根据提供的 Emacs
`everforest-hard-light-theme.el` / `everforest-hard-dark-theme.el` 配色制作，包含 Org 标题层级、TODO/DONE、表格、代码块、任务列表和实时编辑状态样式。

如果 Org 文件来自同级的 Orglist GTD 应用，可在设置中把
`plugins/everforest-org-theme.js` 和 `plugins/orglist-gtd-format.js` 都加入 **Org 默认插件列表**。前者负责主题，后者负责 GTD 语法；TODO/NEXT/DONE/CNCL、
优先级、尾部标签、Habit、LOGBOOK、农历周年、计划时间和常用属性的特殊显示
全部封装在该插件中，不写入查看器核心。

要覆盖保存本地 `full.md`，必须通过“选择结果文件夹”打开目录并授予读写权限。
旧式文件夹上传和 ZIP 模式只能导出修改版 ZIP，不能原位覆盖。浏览器目录写入功能
要求 Chromium 系浏览器的安全上下文（`localhost` 或 HTTPS）。

### 图片修改规则

- **替换图片**：新旧图片格式必须一致，图片内容覆盖到 ZIP 中的原始路径，因此 Markdown 和 JSON 路径无需改变。
- **删除链接**：只删除 Markdown 图片引用，原图片和 JSON 保留用于审核追溯。
- **删除链接和图片**：删除引用并从工作副本移除图片；文件夹模式下点击“覆盖保存 Markdown”时才永久删除本地图片。
- 工具不会覆盖原始 ZIP，导出文件名为 `原文件名-edited.zip`。

### 本地开发

```bash
npm ci
npm test
npx serve .
```

### 支持的 JSON 格式

| 格式                | 结构                               | 坐标系   |
|---------------------|------------------------------------|----------|
| `layout.json`       | `{ pdf_info: [{ preproc_blocks }] }` | 左上角   |
| `middle.json`       | `{ pdf_info: [{ para_blocks, discarded_blocks }] }` | 左上角   |
| `content_list.json` | `[{ page_idx, bbox, text }]`       | 0–1000   |
| `content_list_v2.json` | 按页分组的 `[[{ type, content, bbox }]]` | 0–1000 |

### 许可证

MIT
