import type { PdfBlock, MdSection } from './parse-blocks.js'
import { normalizeAssetPath } from './parse-blocks.js'
import { parseMarkdownSections } from './parse-markdown.js'

export function normalize(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:nbsp|amp|lt|gt|quot|#\d+);/gi, ' ')
    .replace(/[#*\s\n\r\t`~|>\\[\]()]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .toLowerCase()
}

function basename(path: string): string {
  const normalized = normalizeAssetPath(path)
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

export function lcsSimilarity(a: string, b: string): number {
  if (a === b && a.length > 0) return 1
  const shorter = a.length < b.length ? a : b
  const longer = a.length < b.length ? b : a
  if (shorter.length === 0) return 0
  let maxLen = 0
  const window = Math.min(shorter.length, 30)
  for (let i = 0; i < shorter.length; i++) {
    if (shorter.length - i <= maxLen) break
    for (let len = window; len > maxLen; len--) {
      const sub = shorter.substring(i, i + len)
      if (sub.length < 4) continue
      if (longer.includes(sub)) { maxLen = sub.length; break }
    }
  }
  return maxLen / Math.max(shorter.length, 1)
}

function imageBlockFor(section: MdSection, blocks: PdfBlock[]): PdfBlock | undefined {
  if (!section.imagePath) return undefined
  const target = normalizeAssetPath(section.imagePath)
  const exact = blocks.find(block => block.imagePath && normalizeAssetPath(block.imagePath) === target)
  if (exact) return exact
  const targetName = basename(target)
  const sameName = blocks.filter(block => block.imagePath && basename(block.imagePath) === targetName)
  return sameName.length === 1 ? sameName[0] : undefined
}

function isTableSection(section: MdSection): boolean {
  return /<table\b/i.test(section.raw) || /^\s*\|.*\|\s*$/.test(section.raw)
}

function minimumScore(length: number): number {
  if (length <= 8) return 0.62
  if (length <= 20) return 0.42
  if (length <= 50) return 0.28
  return 0.16
}

function ngrams(value: string): Set<string> {
  const result = new Set<string>()
  if (value.length < 2) return result
  for (let index = 0; index < value.length - 1; index++) result.add(value.slice(index, index + 2))
  return result
}

function sourceCoverage(source: string, candidate: Set<string>): number {
  if (source.length < 2 || !candidate.size) return 0
  let hits = 0
  for (let index = 0; index < source.length - 1; index++) {
    if (candidate.has(source.slice(index, index + 2))) hits++
  }
  return hits / (source.length - 1)
}

/** Match in reading order, inside a local candidate window. */
export function matchSectionsToPdf(sections: MdSection[], blocks: PdfBlock[]): MdSection[] {
  const indexed = blocks.map((block, index) => ({
    block, index, norm: normalize(block.text || ''), type: (block.type || '').toLowerCase(),
    grams: ngrams(normalize(block.text || '')),
  }))
  const excludedTypes = new Set(['header', 'footer', 'page_number', 'page-number'])
  const used = new Set<number>()
  let cursor = 0
  let lastPage = 1

  return sections.map(section => {
    if (section.kind === 'image') {
      const block = imageBlockFor(section, blocks)
      if (!block) return { ...section, page: lastPage }
      const index = blocks.indexOf(block)
      if (index < Math.max(0, cursor - 1) || block.page_idx + 1 < lastPage) {
        return { ...section, page: lastPage }
      }
      if (index >= 0) cursor = Math.max(cursor, index + 1)
      lastPage = block.page_idx + 1
      return { ...section, page: lastPage, bbox: block.bbox, blockId: block.id, matchScore: 1 }
    }

    // Use the raw source so HTML tables and <br>-joined OCR lines keep all of
    // their text instead of matching only the first rendered fragment.
    const norm = normalize(section.raw)
    if (norm.length < 2) return { ...section, page: lastPage }
    const tableSection = isTableSection(section)
    // One previous block is retained for an image caption that shares its
    // visual parent; general text matching never jumps farther backwards.
    const from = Math.max(0, cursor - 1)
    const to = Math.min(indexed.length, cursor + 180)
    let best: typeof indexed[number] | null = null
    let bestRawScore = 0
    let bestAdjustedScore = -Infinity

    for (let index = from; index < to; index++) {
      const candidate = indexed[index]
      const tableBlock = candidate.type.includes('table')
      const continuingCaptionedTable = tableSection && tableBlock && candidate.index === cursor - 1
      if ((used.has(candidate.index) && !continuingCaptionedTable) || excludedTypes.has(candidate.type)) continue
      if (tableSection && !tableBlock) continue
      // A MinerU table caption may itself be the only text stored on the
      // table block. Permit that exact caption line to select the block.
      if (!tableSection && tableBlock && candidate.norm !== norm) continue
      let rawScore = 0
      if (candidate.norm) {
        const lengthBalance = candidate.norm.length < norm.length
          ? Math.sqrt(candidate.norm.length / norm.length)
          : 1
        rawScore = Math.max(
          lcsSimilarity(norm, candidate.norm) * lengthBalance,
          sourceCoverage(norm, candidate.grams),
        )
      }
      // MinerU often stores a whole HTML table in Markdown while the layout
      // block contains only a caption (or no text). In that case proximity in
      // reading order is more reliable than comparing the cell text.
      if (tableSection && tableBlock) rawScore = Math.max(rawScore, 0.18)
      const distance = Math.max(0, candidate.index - cursor)
      const adjusted = rawScore
        - Math.min(distance, 120) * 0.0007
        - (candidate.index < cursor && !continuingCaptionedTable ? 0.08 : 0)
      if (adjusted > bestAdjustedScore) {
        best = candidate
        bestRawScore = rawScore
        bestAdjustedScore = adjusted
      }
    }

    const threshold = tableSection ? 0.14 : minimumScore(norm.length)
    if (!best || bestRawScore < threshold) return { ...section, page: lastPage }
    used.add(best.index)
    cursor = Math.max(cursor, best.index + 1)
    lastPage = best.block.page_idx + 1
    return { ...section, page: lastPage, bbox: best.block.bbox, blockId: best.block.id, matchScore: bestRawScore }
  })
}

export function matchMarkdownToPdf(markdown: string, blocks: PdfBlock[]): MdSection[] {
  return matchSectionsToPdf(parseMarkdownSections(markdown), blocks)
}
