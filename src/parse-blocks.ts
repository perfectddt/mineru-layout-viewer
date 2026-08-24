// ── Block types ──

export type SectionKind = 'text' | 'image' | 'other'

export interface PdfBlock {
  id: string
  page_idx: number
  /** Normalized page coordinates in the 0..1 range. */
  bbox: [number, number, number, number]
  text?: string
  type?: string
  imagePath?: string
}

export interface MdSection {
  id: string
  raw: string
  text: string
  start: number
  end: number
  kind: SectionKind
  imagePath?: string
  page: number
  bbox: [number, number, number, number] | null
  blockId?: string
}

type JsonObject = Record<string, unknown>

const VISUAL_TYPES = new Set([
  'image',
  'image-body',
  'image_body',
  'chart',
  'chart-body',
  'chart_body',
])

export function normalizeAssetPath(path: string): string {
  let value = path.trim().replace(/^<|>$/g, '')
  try {
    value = decodeURIComponent(value)
  } catch {
    // Keep malformed percent sequences untouched; the ZIP may still contain them.
  }
  return value.replace(/\\/g, '/').replace(/^\.\//, '')
}

// ── Text and image extraction from middle.json span structures ──

export function extractSpanText(block: JsonObject): string {
  if (typeof block.text === 'string') return block.text

  const lines = block.lines as JsonObject[] | undefined
  if (lines) {
    const texts: string[] = []
    for (const line of lines) {
      const spans = line.spans as JsonObject[] | undefined
      if (!spans) continue
      for (const span of spans) {
        if (typeof span.content === 'string' && span.content.trim()) {
          texts.push(span.content)
        }
      }
    }
    if (texts.length) return texts.join(' ')
  }

  if (typeof block.content === 'string') return block.content
  return ''
}

export function extractImagePath(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const object = value as JsonObject

  for (const key of ['img_path', 'image_path']) {
    if (typeof object[key] === 'string' && object[key]) {
      return normalizeAssetPath(object[key] as string)
    }
  }

  for (const key of ['content', 'lines', 'spans', 'blocks', 'children']) {
    const child = object[key]
    if (Array.isArray(child)) {
      for (const item of child) {
        const found = extractImagePath(item)
        if (found) return found
      }
    } else if (child && typeof child === 'object') {
      const found = extractImagePath(child)
      if (found) return found
    }
  }

  return undefined
}

function normalizeType(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.toLowerCase()
}

function normalizeBbox(
  bbox: unknown,
  pageSize?: [number, number],
  normalizedTo1000 = false,
): [number, number, number, number] | null {
  if (!Array.isArray(bbox) || bbox.length < 4) return null
  const values = bbox.slice(0, 4).map(Number)
  if (values.some(value => !Number.isFinite(value))) return null

  let [x0, y0, x1, y1] = values
  const max = Math.max(Math.abs(x0), Math.abs(y0), Math.abs(x1), Math.abs(y1))

  if (normalizedTo1000) {
    x0 /= 1000; y0 /= 1000; x1 /= 1000; y1 /= 1000
  } else if (max > 1 && pageSize?.[0] && pageSize?.[1]) {
    x0 /= pageSize[0]; x1 /= pageSize[0]
    y0 /= pageSize[1]; y1 /= pageSize[1]
  } else if (max > 1) {
    x0 /= 1000; y0 /= 1000; x1 /= 1000; y1 /= 1000
  }

  return [x0, y0, x1, y1].map(value =>
    Math.min(1, Math.max(0, value)),
  ) as [number, number, number, number]
}

function pageSizeFrom(page: JsonObject): [number, number] | undefined {
  const pageSize = page.page_size
  if (Array.isArray(pageSize) && pageSize.length >= 2) {
    return [Number(pageSize[0]), Number(pageSize[1])]
  }
  return undefined
}

function contentListText(item: JsonObject): string {
  if (typeof item.text === 'string') return item.text
  for (const key of [
    'image_caption',
    'chart_caption',
    'table_caption',
    'image_footnote',
    'chart_footnote',
  ]) {
    const value = item[key]
    if (Array.isArray(value)) {
      const text = value.filter(v => typeof v === 'string').join(' ')
      if (text) return text
    }
  }
  return ''
}

// ── Block parser (supports layout.json, middle.json, content_list.json) ──

export function parseBlocks(jsonStr: string): PdfBlock[] {
  const result: PdfBlock[] = []
  let order = 0

  const addBlock = (
    item: JsonObject,
    pageIdx: number,
    bbox: [number, number, number, number],
    source: string,
  ) => {
    const type = normalizeType(item.category || item.type)
    const imagePath = extractImagePath(item)
    const text = contentListText(item) || extractSpanText(item) || undefined
    result.push({
      id: `${source}:${pageIdx}:${order++}`,
      page_idx: pageIdx,
      bbox,
      text,
      type,
      imagePath,
    })
  }

  try {
    const data = JSON.parse(jsonStr)

    if (data.pdf_info && Array.isArray(data.pdf_info)) {
      const walkLayout = (
        items: JsonObject[],
        pageIdx: number,
        pageSize?: [number, number],
        insideVisual = false,
      ) => {
        for (const item of items) {
          const bbox = normalizeBbox(item.bbox, pageSize)
          const type = normalizeType(item.type)
          const childBlocks = item.blocks as JsonObject[] | undefined
          const isVisual = VISUAL_TYPES.has(type || '') || Boolean(extractImagePath(item))

          // Keep visual parents: descending directly into image_body used to
          // discard image_path and made image blocks impossible to match.
          if (bbox && isVisual && !insideVisual) {
            addBlock(item, pageIdx, bbox, 'middle')
          }

          if (childBlocks?.length) {
            walkLayout(childBlocks, pageIdx, pageSize, insideVisual || isVisual)
          } else if (bbox && !VISUAL_TYPES.has(type || '') && !extractImagePath(item)) {
            addBlock(item, pageIdx, bbox, 'middle')
          }
        }
      }

      for (let i = 0; i < data.pdf_info.length; i++) {
        const page = data.pdf_info[i] as JsonObject
        const blocks = (page.para_blocks || page.preproc_blocks || []) as JsonObject[]
        walkLayout(blocks, i, pageSizeFrom(page))
      }
      return result
    }

    if (!Array.isArray(data)) return result
    const walk = (items: JsonObject[], inheritedPage?: number) => {
      for (const item of items) {
        const pageIdx = Number(item.page_idx ?? item.page_index ?? inheritedPage)
        const bbox = normalizeBbox(item.bbox, undefined, true)
        if (Number.isFinite(pageIdx) && bbox) {
          addBlock(item, pageIdx, bbox, 'content')
        }
        if (Array.isArray(item.children)) walk(item.children as JsonObject[], pageIdx)
        if (Array.isArray(item.blocks)) walk(item.blocks as JsonObject[], pageIdx)
      }
    }
    walk(data)
  } catch {
    // Preserve tolerant viewer behavior for malformed optional JSON.
  }
  return result
}
