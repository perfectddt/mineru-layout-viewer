import type { PdfBlock, MdSection } from './parse-blocks.js'
import { isPageFurnitureType, normalizeAssetPath } from './parse-blocks.js'
import { parseMarkdownSections } from './parse-markdown.js'

export function normalize(s: string): string {
  return s
    .replace(/\$\$([\s\S]*?)\$\$/g, ' $1 ')
    .replace(/\$([^$\n]+?)\$/g, ' $1 ')
    .replace(/\\[a-zA-Z]+\{([^}]*)\}/g, ' $1 ')
    .replace(/\\[a-zA-Z]+/g, ' ')
    .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:nbsp|amp|lt|gt|quot|#\d+);/gi, ' ')
    .replace(/[#*\s\n\r\t`~|>\\[\](){}_^=+\-]+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
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

/** Built once for an entire match, including all anchored gaps. */
function createMatchIndex(blocks: PdfBlock[]) {
  const imagePaths = new Map<string, number>()
  const imageNames = new Map<string, number | null>()
  const indexed = blocks.map((block, index) => {
    if (block.imagePath) {
      const path = normalizeAssetPath(block.imagePath)
      if (!imagePaths.has(path)) imagePaths.set(path, index)
      const name = basename(path)
      imageNames.set(name, imageNames.has(name) ? null : index)
    }
    const norm = normalize(block.text || '')
    return { block, index, norm, type: (block.type || '').toLowerCase(), grams: ngrams(norm) }
  })
  return { indexed, imagePaths, imageNames }
}
type MatchIndex = ReturnType<typeof createMatchIndex>

function imageBlockFor(section: MdSection, index: MatchIndex): number | undefined {
  if (!section.imagePath) return undefined
  const target = normalizeAssetPath(section.imagePath)
  return index.imagePaths.get(target) ?? index.imageNames.get(basename(target)) ?? undefined
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

export type PdfMatchRange = {
  fromBlock?: number
  toBlock?: number
  initialPage?: number
}

type Anchor = { sectionIndex: number, blockIndex: number, page: number }

function anchorDistanceLimit(length: number): number {
  if (length >= 24) return 500
  if (length >= 12) return 160
  if (length >= 6) return 40
  return 12
}

/** Unchanged lines lock page boundaries so a rewrite cannot jump to a later page. */
function findAnchors(sections: MdSection[], blocks: PdfBlock[], matchIndex: MatchIndex, fromBlock: number, toBlock: number, initialPage: number): Anchor[] {
  const byNorm = new Map<string, number[]>()
  matchIndex.indexed.forEach(({ block, index, norm }) => {
    if (index < fromBlock || index >= toBlock || isPageFurnitureType(block.type)) return
    if (norm.length < 2) return
    const list = byNorm.get(norm)
    if (list) list.push(index)
    else byNorm.set(norm, [index])
  })

  const anchors: Anchor[] = []
  const used = new Set<number>()
  let cursor = fromBlock
  let lastPage = initialPage
  sections.forEach((section, sectionIndex) => {
    if (section.kind === 'image' && section.imagePath) {
      const index = imageBlockFor(section, matchIndex)
      if (index == null) return
      const block = blocks[index]
      const page = block.page_idx + 1
      if (index < fromBlock || index >= toBlock || index < cursor - 1 || page < lastPage || used.has(index)) return
      used.add(index)
      cursor = Math.max(cursor, index + 1)
      lastPage = page
      anchors.push({ sectionIndex, blockIndex: index, page })
      return
    }

    const norm = normalize(section.raw)
    if (norm.length < 2) return
    const limit = anchorDistanceLimit(norm.length)
    const index = (byNorm.get(norm) || []).find(candidate => (
      candidate >= cursor && candidate - cursor <= limit && !used.has(candidate)
    ))
    if (index == null) return
    const page = blocks[index].page_idx + 1
    if (page < lastPage) return
    used.add(index)
    cursor = index + 1
    lastPage = page
    anchors.push({ sectionIndex, blockIndex: index, page })
  })
  return anchors
}

function assignAnchor(section: MdSection, block: PdfBlock): MdSection {
  return {
    ...section,
    page: block.page_idx + 1,
    bbox: block.bbox,
    blockId: block.id,
    matchScore: 1,
  }
}

function enforceForwardPages(sections: MdSection[]): MdSection[] {
  let last = 0
  return sections.map(section => {
    const page = section.page || last || 1
    if (!last || page >= last) {
      last = page
      return section.page === page ? section : { ...section, page }
    }
    return { ...section, page: last, bbox: null, blockId: undefined, matchScore: undefined }
  })
}

/** Match inside one block span. Callers use this for text that no longer matches exactly. */
function matchWindow(sections: MdSection[], blocks: PdfBlock[], matchIndex: MatchIndex, fromBlock: number, toBlock: number, initialPage: number): MdSection[] {
  const indexed = matchIndex.indexed
  const used = new Set<number>()
  let cursor = fromBlock
  let lastPage = initialPage

  return sections.map(section => {
    if (section.kind === 'image') {
      const index = imageBlockFor(section, matchIndex)
      if (index == null) return { ...section, page: lastPage }
      const block = blocks[index]
      if (index < fromBlock || index >= toBlock || index < Math.max(fromBlock, cursor - 1) || block.page_idx + 1 < lastPage) {
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
    const to = Math.min(toBlock, cursor + 180)
    let best: typeof indexed[number] | null = null
    let bestRawScore = 0
    let bestAdjustedScore = -Infinity

    for (let index = from; index < to; index++) {
      const candidate = indexed[index]
      if (candidate.index >= toBlock) continue
      const tableBlock = candidate.type.includes('table')
      const continuingCaptionedTable = tableSection && tableBlock && candidate.index === cursor - 1
      if (candidate.index < fromBlock && !continuingCaptionedTable) continue
      if ((used.has(candidate.index) && !continuingCaptionedTable) || isPageFurnitureType(candidate.type)) continue
      if (tableSection && !tableBlock) continue
      // A MinerU table caption may itself be the only text stored on the
      // table block. Permit that exact caption line to select the block.
      if (!tableSection && tableBlock && candidate.norm !== norm) continue
      const distance = Math.max(0, candidate.index - cursor)
      const penalty = Math.min(distance, 120) * 0.0007
        + (candidate.index < cursor && !continuingCaptionedTable ? 0.08 : 0)
      let rawScore = 0
      if (candidate.norm) {
        const lengthBalance = candidate.norm.length < norm.length
          ? Math.sqrt(candidate.norm.length / norm.length)
          : 1
        const coverage = sourceCoverage(norm, candidate.grams)
        const shorterLength = Math.min(norm.length, candidate.norm.length)
        // lcsSimilarity examines at most 30 characters (except exact equality).
        // Bound the original score, including table fallback, before expensive LCS.
        const lcsBound = norm === candidate.norm ? 1
          : (shorterLength < 4 ? 0 : Math.min(30, shorterLength) / shorterLength) * lengthBalance
        if (Math.max(coverage, lcsBound, tableSection && tableBlock ? 0.18 : 0) - penalty < bestAdjustedScore - 1e-12) continue
        rawScore = Math.max(lcsSimilarity(norm, candidate.norm) * lengthBalance, coverage)
      }
      // MinerU often stores a whole HTML table in Markdown while the layout
      // block contains only a caption (or no text). In that case proximity in
      // reading order is more reliable than comparing the cell text.
      if (tableSection && tableBlock) rawScore = Math.max(rawScore, 0.18)
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

/**
 * Match in reading order. Lines that still equal a layout block lock that page.
 * Rewritten lines are aligned only between those locks, so a similar sentence
 * later in the PDF cannot pull the page number forward.
 */
export function matchSectionsToPdf(sections: MdSection[], blocks: PdfBlock[], range?: PdfMatchRange): MdSection[] {
  const fromBlock = Math.max(0, range?.fromBlock ?? 0)
  const toBlock = Math.min(blocks.length, Math.max(fromBlock, range?.toBlock ?? blocks.length))
  const initialPage = range?.initialPage && range.initialPage > 0 ? range.initialPage : 1
  const matchIndex = createMatchIndex(blocks)
  const anchors = findAnchors(sections, blocks, matchIndex, fromBlock, toBlock, initialPage)
  if (!anchors.length) return enforceForwardPages(matchWindow(sections, blocks, matchIndex, fromBlock, toBlock, initialPage))

  const matched: MdSection[] = sections.map(section => ({
    ...section,
    page: initialPage,
    bbox: null,
    blockId: undefined,
    matchScore: undefined,
  }))
  const gaps: Array<{ start: number, end: number, fromBlock: number, toBlock: number, initialPage: number }> = []
  gaps.push({
    start: 0,
    end: anchors[0].sectionIndex,
    fromBlock,
    toBlock: anchors[0].blockIndex,
    initialPage,
  })
  anchors.forEach((anchor, index) => {
    const block = blocks[anchor.blockIndex]
    if (block) matched[anchor.sectionIndex] = assignAnchor(sections[anchor.sectionIndex], block)
    const previous = index === 0 ? null : anchors[index - 1]
    if (previous) {
      gaps.push({
        start: previous.sectionIndex + 1,
        end: anchor.sectionIndex,
        fromBlock: previous.blockIndex + 1,
        toBlock: anchor.blockIndex,
        initialPage: previous.page,
      })
    }
  })
  const last = anchors[anchors.length - 1]
  gaps.push({
    start: last.sectionIndex + 1,
    end: sections.length,
    fromBlock: last.blockIndex + 1,
    toBlock,
    initialPage: last.page,
  })
  for (const gap of gaps) {
    if (gap.start >= gap.end) continue
    const filled = matchWindow(sections.slice(gap.start, gap.end), blocks, matchIndex, gap.fromBlock, gap.toBlock, gap.initialPage)
    for (let index = 0; index < filled.length; index++) matched[gap.start + index] = filled[index]
  }
  return enforceForwardPages(matched)
}

export function matchMarkdownToPdf(markdown: string, blocks: PdfBlock[]): MdSection[] {
  return matchSectionsToPdf(parseMarkdownSections(markdown), blocks)
}
