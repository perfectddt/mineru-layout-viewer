type JsonObject = Record<string, unknown>

export interface SyncSection {
  raw: string
  start: number
  end: number
  kind: string
  blockId?: string
}

export interface SyncBlock {
  id: string
  jsonPath?: string
}

export interface JsonTextField {
  current: string
  apply: (text: string) => void
}

const CAPTION_KEYS = [
  'image_caption',
  'chart_caption',
  'table_caption',
  'image_footnote',
  'chart_footnote',
  'code_caption',
]

/** Plain text exchanged between a Markdown line and one MinerU JSON field. */
export function markdownExchangeText(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  if (/^!\[[^\]]*\]\(/.test(trimmed) || /^<img\b/i.test(trimmed)) return undefined
  if (/^<table\b/i.test(trimmed)) return undefined
  const heading = trimmed.match(/^#{1,6}\s+([\s\S]*)$/)
  return (heading ? heading[1] : trimmed).trim()
}

export function jsonValueAt(root: unknown, path: string): JsonObject | undefined {
  let current: unknown = root
  for (const part of path.split('.')) {
    if (!current || typeof current !== 'object') return undefined
    if (Array.isArray(current)) {
      const index = Number(part)
      if (!Number.isInteger(index)) return undefined
      current = current[index]
    } else {
      current = (current as JsonObject)[part]
    }
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
  return current as JsonObject
}

function spanText(value: unknown): string {
  if (!Array.isArray(value) || !value.length) return ''
  if (!value.every(span => span && typeof span === 'object' && typeof (span as JsonObject).content === 'string')) return ''
  return value.map(span => String((span as JsonObject).content)).join('').trim()
}

/** The single text field that can be edited without guessing among several. */
export function singleJsonTextField(item: JsonObject): JsonTextField | undefined {
  const fields: JsonTextField[] = []
  if (typeof item.text === 'string') {
    fields.push({ current: item.text, apply: text => { item.text = text } })
  }
  for (const key of CAPTION_KEYS) {
    const value = item[key]
    if (Array.isArray(value) && value.length && value.every(entry => typeof entry === 'string')) {
      fields.push({
        current: value.join(' '),
        apply: text => { item[key] = [text] },
      })
    }
  }
  if (typeof item.code_body === 'string' && item.code_body.trim()) {
    fields.push({ current: item.code_body, apply: text => { item.code_body = text } })
  }
  const content = item.content
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    const record = content as JsonObject
    for (const [key, value] of Object.entries(record)) {
      const current = spanText(value)
      if (!current) continue
      fields.push({
        current,
        apply: text => { record[key] = [{ type: 'text', content: text }] },
      })
    }
  }
  return fields.length === 1 ? fields[0] : undefined
}

export interface MarkdownJsonPair {
  jsonPath: string
  raw: string
  start: number
  end: number
}

/** One Markdown line mapped to one JSON item. Shared blocks are left untouched. */
export function markdownJsonPairs(sections: SyncSection[], blocks: SyncBlock[]): MarkdownJsonPair[] {
  const byId = new Map(blocks.map(block => [block.id, block]))
  const grouped = new Map<string, MarkdownJsonPair[]>()
  for (const section of sections) {
    if (section.kind === 'image' || !section.blockId) continue
    const path = byId.get(section.blockId)?.jsonPath
    if (!path || markdownExchangeText(section.raw) == null) continue
    const pair = { jsonPath: path, raw: section.raw, start: section.start, end: section.end }
    const list = grouped.get(path) || []
    list.push(pair)
    grouped.set(path, list)
  }
  return [...grouped.values()].filter(list => list.length === 1).map(list => list[0])
}

function replaceMarkdownSlice(markdown: string, start: number, end: number, raw: string, nextText: string): string {
  const slice = markdown.slice(start, end)
  const ending = slice.endsWith('\r\n') ? '\r\n' : slice.endsWith('\n') ? '\n' : ''
  const heading = raw.match(/^(\s*#{1,6}\s+)/)
  const nextRaw = heading ? `${heading[1]}${nextText}` : nextText
  return markdown.slice(0, start) + nextRaw + ending + markdown.slice(end)
}

/** Copy changed Markdown lines into the matching JSON text fields. */
export function projectMarkdownOntoJson(
  jsonText: string,
  sections: SyncSection[],
  blocks: SyncBlock[],
): string | null {
  let data: unknown
  try {
    data = JSON.parse(jsonText)
  } catch {
    return null
  }
  let changed = false
  for (const pair of markdownJsonPairs(sections, blocks)) {
    const text = markdownExchangeText(pair.raw)
    if (text == null) continue
    const item = jsonValueAt(data, pair.jsonPath)
    const field = item ? singleJsonTextField(item) : undefined
    if (!field || field.current.trim() === text) continue
    field.apply(text)
    changed = true
  }
  return changed ? JSON.stringify(data, null, 2) : jsonText
}

/** Copy changed JSON text fields into the matching Markdown lines. */
export function projectJsonOntoMarkdown(
  markdown: string,
  jsonText: string,
  sections: SyncSection[],
  blocks: SyncBlock[],
): string | null {
  let data: unknown
  try {
    data = JSON.parse(jsonText)
  } catch {
    return null
  }
  const pairs = markdownJsonPairs(sections, blocks).sort((left, right) => right.start - left.start)
  let next = markdown
  for (const pair of pairs) {
    const item = jsonValueAt(data, pair.jsonPath)
    const field = item ? singleJsonTextField(item) : undefined
    const current = markdownExchangeText(pair.raw)
    if (!field || current == null || field.current.trim() === current) continue
    next = replaceMarkdownSlice(next, pair.start, pair.end, pair.raw, field.current.trim())
  }
  return next
}

/** Current text of each JSON path, including items that have no Markdown line. */
export function jsonTextsByPath(jsonText: string, paths: string[]): Map<string, string> | null {
  let data: unknown
  try {
    data = JSON.parse(jsonText)
  } catch {
    return null
  }
  const texts = new Map<string, string>()
  for (const path of paths) {
    const item = jsonValueAt(data, path)
    const field = item ? singleJsonTextField(item) : undefined
    if (field) texts.set(path, field.current)
  }
  return texts
}
