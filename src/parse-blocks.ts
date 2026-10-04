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
  /** Path into the parsed JSON, such as `0` or `pdf_info.0.para_blocks.1`. */
  jsonPath?: string
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
  matchScore?: number
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

/** Page furniture MinerU keeps out of the Markdown body. */
const PAGE_FURNITURE_TYPES = new Set([
  'header',
  'footer',
  'page_number',
  'page-number',
  'page_header',
  'page_footer',
  'page_footnote',
  'aside_text',
  'page_aside_text',
])

export function isPageFurnitureType(type?: string): boolean {
  return PAGE_FURNITURE_TYPES.has((type || '').toLowerCase())
}

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

  const imageSource = object.image_source
  if (imageSource && typeof imageSource === 'object') {
    const path = (imageSource as JsonObject).path
    if (typeof path === 'string' && path) return normalizeAssetPath(path)
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

function textFromStructured(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) {
    return value.map(textFromStructured).filter(Boolean).join('\n').trim()
  }
  if (!value || typeof value !== 'object') return ''
  const object = value as JsonObject
  if (typeof object.content === 'string' && object.content.trim()) return object.content.trim()
  if (typeof object.text === 'string' && object.text.trim()) return object.text.trim()
  if (Array.isArray(object.item_content)) return textFromStructured(object.item_content)

  const parts: string[] = []
  for (const [key, child] of Object.entries(object)) {
    if ([
      'image_source', 'math_type', 'level', 'table_type', 'table_nest_level',
      'list_type', 'code_language', 'sub_type', 'item_type', 'path', 'url', 'type',
    ].includes(key)) continue
    const text = textFromStructured(child)
    if (text) parts.push(text)
  }
  return parts.join('\n').trim()
}

function captionText(item: JsonObject): string {
  for (const key of [
    'image_caption',
    'chart_caption',
    'table_caption',
    'image_footnote',
    'chart_footnote',
    'code_caption',
  ]) {
    const value = item[key]
    if (Array.isArray(value) && value.every(entry => typeof entry === 'string')) {
      const text = value.filter(Boolean).join(' ')
      if (text) return text
    }
    const text = textFromStructured(value)
    if (text) return text
  }
  return ''
}

function contentListText(item: JsonObject): string {
  if (typeof item.text === 'string' && item.text.trim()) return item.text
  const caption = captionText(item)
  const listItems = textFromStructured(item.list_items)
  const codeBody = typeof item.code_body === 'string' ? item.code_body.trim() : ''
  const structured = item.content && typeof item.content === 'object'
    ? textFromStructured(item.content)
    : ''
  const combined = [caption, listItems, codeBody, structured].filter(Boolean).join('\n')
  if (combined) return combined
  if (typeof item.table_body === 'string' && item.table_body.trim()) return item.table_body
  return ''
}

function furnitureKey(block: PdfBlock): string {
  const box = block.bbox.map(value => value.toFixed(3)).join(',')
  const text = (block.text || '').replace(/\s+/g, ' ').trim()
  return `${block.page_idx}|${(block.type || '').toLowerCase()}|${box}|${text}`
}

/** Add page numbers, headers, footers, and notes that the primary JSON omitted. */
export function appendPageFurniture(blocks: PdfBlock[], extras: PdfBlock[]): PdfBlock[] {
  const incoming = extras.filter(block => isPageFurnitureType(block.type))
  if (!incoming.length) return blocks
  const seen = new Set(blocks.filter(block => isPageFurnitureType(block.type)).map(furnitureKey))
  const merged = blocks.slice()
  for (const block of incoming) {
    const key = furnitureKey(block)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push({ ...block, id: `page-furniture:${merged.length}`, jsonPath: undefined })
  }
  return merged
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
    jsonPath?: string,
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
      jsonPath,
    })
  }

  try {
    const data = JSON.parse(jsonStr)

    if (data.pdf_info && Array.isArray(data.pdf_info)) {
      const walkLayout = (
        items: JsonObject[],
        pageIdx: number,
        pageSize: [number, number] | undefined,
        insideVisual: boolean,
        pathPrefix: string,
      ) => {
        items.forEach((item, index) => {
          const path = `${pathPrefix}.${index}`
          const bbox = normalizeBbox(item.bbox, pageSize)
          const type = normalizeType(item.type)
          const childBlocks = item.blocks as JsonObject[] | undefined
          const isVisual = VISUAL_TYPES.has(type || '') || Boolean(extractImagePath(item))

          // Keep visual parents: descending directly into image_body used to
          // discard image_path and made image blocks impossible to match.
          if (bbox && isVisual && !insideVisual) {
            addBlock(item, pageIdx, bbox, 'middle', path)
          }

          if (childBlocks?.length) {
            walkLayout(childBlocks, pageIdx, pageSize, insideVisual || isVisual, `${path}.blocks`)
          } else if (bbox && !VISUAL_TYPES.has(type || '') && !extractImagePath(item)) {
            addBlock(item, pageIdx, bbox, 'middle', path)
          }
        })
      }

      for (let i = 0; i < data.pdf_info.length; i++) {
        const page = data.pdf_info[i] as JsonObject
        const pageSize = pageSizeFrom(page)
        const blocks = (page.para_blocks || page.preproc_blocks || []) as JsonObject[]
        const blockKey = page.para_blocks ? 'para_blocks' : 'preproc_blocks'
        walkLayout(blocks, i, pageSize, false, `pdf_info.${i}.${blockKey}`)
        const discarded = page.discarded_blocks
        if (Array.isArray(discarded)) {
          walkLayout(discarded as JsonObject[], i, pageSize, false, `pdf_info.${i}.discarded_blocks`)
        }
      }
      return result
    }

    if (!Array.isArray(data)) return result
    if (data.some(page => Array.isArray(page))) {
      data.forEach((page, pageIdx) => {
        if (!Array.isArray(page)) return
        page.forEach((item, index) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return
          const object = item as JsonObject
          const explicitPage = Number(object.page_idx ?? object.page_index)
          const resolvedPage = Number.isFinite(explicitPage) ? explicitPage : pageIdx
          const bbox = normalizeBbox(object.bbox)
          if (bbox) addBlock(object, resolvedPage, bbox, 'content-v2', `${pageIdx}.${index}`)
        })
      })
      return result
    }

    const walk = (items: JsonObject[], inheritedPage?: number, pathPrefix = '') => {
      items.forEach((item, index) => {
        const path = pathPrefix ? `${pathPrefix}.${index}` : String(index)
        const pageIdx = Number(item.page_idx ?? item.page_index ?? inheritedPage)
        const bbox = normalizeBbox(item.bbox, undefined, true)
        if (Number.isFinite(pageIdx) && bbox) {
          addBlock(item, pageIdx, bbox, 'content', path)
        }
        if (Array.isArray(item.children)) walk(item.children as JsonObject[], pageIdx, `${path}.children`)
        if (Array.isArray(item.blocks)) walk(item.blocks as JsonObject[], pageIdx, `${path}.blocks`)
      })
    }
    walk(data)
  } catch {
    // Preserve tolerant viewer behavior for malformed optional JSON.
  }
  return result
}
