# MinerU Layout Viewer

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
- **Large PDF support** — shows loading progress and renders PDF pages only near the viewport
- **Image review cards** — render image assets from the ZIP and map them to PDF image blocks by path
- **Lazy image loading** — only decode image cards near the viewport for large review jobs
- **Replace / soft-delete / undo** — replace an asset in-place or remove only its Markdown reference while retaining audit evidence
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
| `loadLayoutFromJson(data: object\|string)`| Load layout JSON directly           |
| `loadMarkdown(text: string)`            | Load markdown text directly           |
| `undoLastEdit(): Promise<void>`          | Undo the most recent image edit        |
| `exportEditedZip(): Promise<void>`       | Download the edited result ZIP         |

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
- **图片审核卡片** — 显示 ZIP 内的真实图片，并通过图片路径与 PDF 图片框精确关联
- **图片懒加载** — 只解压接近可视区域的图片，降低大批量审核时的内存占用
- **替换、软删除、撤销** — 原路径替换图片，或仅删除 Markdown 引用并保留审核证据
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
| `loadLayoutFromJson(data: object\|string)`| 直接加载 layout JSON       |
| `loadMarkdown(text: string)`            | 直接加载 markdown 文本      |
| `undoLastEdit(): Promise<void>`          | 撤销最近一次图片修改        |
| `exportEditedZip(): Promise<void>`       | 下载修改后的结果 ZIP        |

### 图片修改规则

- **替换图片**：新旧图片格式必须一致，图片内容覆盖到 ZIP 中的原始路径，因此 Markdown 和 JSON 路径无需改变。
- **从 Markdown 删除**：只删除 Markdown 图片引用，原图片和 JSON 保留用于审核追溯，并在 `review_edits.json` 中记录操作。
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
