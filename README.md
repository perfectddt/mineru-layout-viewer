# MinerU Layout Viewer

On Windows, double-click `start-viewer.cmd` to start the local server from the
project root at `http://127.0.0.1:18768/` and open the viewer automatically. Avoid opening `index.html`
through `file://`, because browser security restrictions can prevent folder
write-back, plugin fonts, dynamic resources, or PDF workers from loading.

Visualize [MinerU](https://github.com/opendatalab/MinerU) `layout.json` / `middle.json` output — side-by-side PDF + Markdown with bidirectional click-to-navigate.

[English](#english) | [中文](#chinese)

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
- **Multi-format support** — automatically detects `layout.json`, `middle.json`, and `content_list.json`
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
- **Large PDF support** — renders PDF pages only near the viewport
- **Rendered Markdown preview** — CommonMark formatting, tables, lists, quotes, code blocks, links, and lazy-loaded images
- **Lazy image loading** — only decode image cards near the viewport for large review jobs
- **Replace / soft-delete / undo/redo** — replace an asset in-place or remove only its Markdown reference while retaining audit evidence
- **Typora-style editing flow** — preview by default; double-click a rendered block to edit it in place
- **Full source + Vim mode** — CodeMirror 6 fills the right pane, with an optional Vim keybinding plugin
- **Plugin APIs** — extend Markdown-it rendering/styles and CodeMirror editor extensions
- **Find result navigator** — red preview highlights plus a clickable result list, replace-one, and replace-all
- **Independent zoom** — PDF fit-page/fit-width/custom zoom and separate Markdown/image zoom
- **Persistent layout boxes** — text, image, and removed/unreferenced image boxes use distinct always-visible colors
- **Edited ZIP export** — download a new ZIP with edited Markdown, replacement assets, and `review_edits.json`

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

Parses a MinerU JSON file (`layout.json`, `middle.json`, or `content_list.json`) into an array of leaf-level blocks.

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
| `middle.json`       | `{ pdf_info: [{ preproc_blocks }] }` | top-left  |
| `content_list.json` | `[{ page_idx, bbox, text }]`       | 0–1000    |

### License

MIT

---

<a name="chinese"></a>
## 中文

Windows 用户可直接双击项目根目录的 `start-viewer.cmd`。脚本会从项目根目录
在独立地址 `http://127.0.0.1:18768/` 启动本地服务并自动打开浏览器，不需要手动输入网址。启动器还会核对页面身份，避免误打开占用其他端口的软件。不要通过 `file://` 直接
打开 `index.html`，否则浏览器安全限制可能导致文件夹写回、插件字体、动态资源
或 PDF Worker 无法正常工作。

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
- **多格式支持** — 自动识别 `layout.json`、`middle.json`、`content_list.json`
- **嵌套块解析** — 将列表项、表格单元格等嵌套块解析到叶子节点坐标
- **框架无关** — 基于 Web Component，支持 React、Vue 或原生 HTML
- **Zip 直拖** — 直接拖放 MinerU 输出 `.zip`，自动解压 PDF + layout + markdown
- **文件夹直拖** — 支持现代目录句柄，并提供旧版 WebKit 目录递归读取后备方案
- **分阶段动态进度** — 显示载入阶段；仅在字节读取、文件计数和解压等可测阶段估算剩余时间
- **可拖动工作区与目录** — PDF/Markdown 支持左右或上下排列、位置交换和分隔线拖动；书签/大纲也支持左右或上下排列
- **持久化设置** — 记住主工作区比例、目录方向/大小以及可信的默认渲染插件
- **单 Markdown 编辑器** — `code` 模式的源码/渲染支持左右或上下排列、拖动比例、中线交换和双向定位
- **Typora 式混合编辑** — 聚焦当前块时显示真实 Markdown/Org 标记并进行语法着色，同时保留粗体、斜体、标题和公式源码的语义样式
- **单 Org 编辑器** — `.org` 文件同样支持预览/实时预览/Code/Vim、大纲、搜索替换、历史、缩放、布局和覆盖保存
- **Markdown 格式化预览** — 渲染标题、列表、引用、表格、代码、链接和懒加载图片
- **图片懒加载** — 只解压接近可视区域的图片，降低大批量审核时的内存占用
- **替换、软删除、撤销/重做** — 原路径替换图片，或仅删除 Markdown 引用并保留审核证据
- **类 Typora 编辑流程** — 默认预览，双击渲染块后直接在原位置编辑
- **全文源码与 Vim** — CodeMirror 6 直接占据右栏，并支持可开关的 Vim 键位插件
- **插件接口** — 可扩展 Markdown-it 渲染规则/样式和 CodeMirror 编辑扩展
- **搜索结果导航** — 预览内红色高亮，并提供可点击跳转的结果列表、单项替换和全部替换
- **左右独立缩放** — PDF 支持整页、页宽和自定义缩放，Markdown 与图片可单独缩放
- **框常显与状态配色** — 文字、图片、已删除或未引用图片使用不同颜色且始终可见
- **导出修改版 ZIP** — 导出修改后的 Markdown、图片以及 `review_edits.json` 操作记录

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

将 MinerU JSON 文件（`layout.json`、`middle.json` 或 `content_list.json`）解析为叶子级 block 数组。

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

使用 LCS 相似度将 Markdown 文本（按行分割）匹配到 PDF block。

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
| `loadDirectoryEntries(entries): Promise<void>` | 加载目录拖放递归收集的文件和路径 |
| `loadMarkdownFile(file, handle?): Promise<void>` | 以独立 Markdown 或 Org 编辑器模式打开单文件 |
| `loadLayoutFromJson(data: object\|string)`| 直接加载 layout JSON       |
| `loadMarkdown(text: string)`            | 直接加载 markdown 文本      |
| `undoLastEdit(): Promise<void>`          | 撤销最近一次图片修改        |
| `redoLastEdit(): Promise<void>`          | 重做最近撤销的修改          |
| `exportEditedZip(): Promise<void>`       | 下载修改后的结果 ZIP        |
| `registerMarkdownRenderPlugin(plugin)`   | 注册 Markdown-it 规则、预览样式或渲染后钩子 |
| `registerMarkdownEditorPlugin(plugin)`   | 注册 CodeMirror 6 编辑扩展   |
| `loadMarkdownRenderPlugin(file, format?)` | 为 `markdown` 或 `org` 加载可信的本地 `.js`/`.mjs` 渲染插件 |

```js
viewer.registerMarkdownRenderPlugin({
  name: 'review-heading-theme',
  styles: '.md-preview h2 { color:#0f766e; border-color:#5eead4; }',
  configure(markdownIt) { markdownIt.set({ breaks: true }) },
})
```

默认富渲染已启用：经过清洗的 HTML（含 `<br>`、HTML 表格）、GFM 表格、任务列表、
脚注和 KaTeX。想换样式时，复制 `plugins/ocean-reading-theme.js` 并只修改其中
作用于 `.md-preview` 的 CSS，然后点击右上角“设置”按钮。Markdown 与 Org 各有独立的默认插件选择和本地保存项，切换文件格式时只启用对应插件，因此字体、颜色和背景不会互相覆盖。插件会在
页面中执行 JavaScript，只加载自己信任的文件；沿用 `mineru-reading-theme` 名称会
替换对应格式的内置主题，而不是叠加两份主题。

项目还提供了根据 Typora `phycat-prussian.css` 与 `phycat/phycat.light.css` 改编的主题：
`plugins/phycat-prussian-theme.js`。原主题的交叉斜线背景、霞鹜文楷和 Cascadia Code 字体均已保留；字体文件放在
`plugins/phycat/`。插件会依次尝试当前页面相对路径、上级路径和站点根路径，并在字体不可用时回退到系统楷体；修改插件后需在设置中重新选择该文件，以更新浏览器保存的插件源码。
查看器会把插件中的 `@font-face` 单独同步到页面级样式，避免字体声明停留在 Shadow DOM 中而不触发浏览器下载。

单 Org 文件还可加载 `plugins/everforest-org-theme.js`。它根据提供的 Emacs
`everforest-hard-light-theme.el` / `everforest-hard-dark-theme.el` 配色制作，包含 Org 标题层级、TODO/DONE、表格、代码块、任务列表和实时编辑状态样式。

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
| `middle.json`       | `{ pdf_info: [{ preproc_blocks }] }` | 左上角   |
| `content_list.json` | `[{ page_idx, bbox, text }]`       | 0–1000   |

### 许可证

MIT
