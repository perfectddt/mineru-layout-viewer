import type { PdfBlock, MdSection } from './parse-blocks.js'
import { normalizeAssetPath } from './parse-blocks.js'
import { parseMarkdownSections } from './parse-markdown.js'

export function normalize(s: string): string {
  return s
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
      if (longer.includes(sub)) {
        maxLen = sub.length
        break
      }
    }
  }
  return maxLen / Math.max(shorter.length, 1)
}

function imageBlockFor(section: MdSection, blocks: PdfBlock[]): PdfBlock | undefined {
  if (!section.imagePath) return undefined
  const target = normalizeAssetPath(section.imagePath)
  const exact = blocks.find(block =>
    block.imagePath && normalizeAssetPath(block.imagePath) === target,
  )
  if (exact) return exact

  const targetName = basename(target)
  const sameName = blocks.filter(block =>
    block.imagePath && basename(block.imagePath) === targetName,
  )
  return sameName.length === 1 ? sameName[0] : undefined
}

export function matchSectionsToPdf(
  sections: MdSection[],
  blocks: PdfBlock[],
): MdSection[] {
  const textBlocks = blocks.filter(block =>
    block.text && block.text.trim().length > 1,
  )
  const pageCount = blocks.length
    ? Math.max(...blocks.map(block => block.page_idx)) + 1
    : 1

  return sections.map((section, sectionIndex) => {
    if (section.kind === 'image') {
      const block = imageBlockFor(section, blocks)
      return block
        ? { ...section, page: block.page_idx + 1, bbox: block.bbox, blockId: block.id }
        : section
    }

    const norm = normalize(section.text)
    if (norm.length < 4 || textBlocks.length === 0) return section

    let best: PdfBlock | null = null
    let bestScore = 0
    const topBlocks = textBlocks.filter(block =>
      block.type !== 'table-body' && block.type !== 'table-row',
    )

    for (const block of topBlocks) {
      const score = lcsSimilarity(norm, normalize(block.text!))
      if (score > bestScore) {
        bestScore = score
        best = block
      }
    }

    if (bestScore < 0.2) {
      for (const block of textBlocks) {
        const score = lcsSimilarity(norm, normalize(block.text!))
        if (score > bestScore) {
          bestScore = score
          best = block
        }
      }
    }

    if (!best || bestScore < 0.1) {
      const estimatedPage = Math.min(
        pageCount,
        Math.floor(sectionIndex / Math.max(sections.length, 1) * pageCount) + 1,
      )
      return { ...section, page: estimatedPage }
    }

    return {
      ...section,
      page: best.page_idx + 1,
      bbox: best.bbox,
      blockId: best.id,
    }
  })
}

export function matchMarkdownToPdf(
  markdown: string,
  blocks: PdfBlock[],
): MdSection[] {
  return matchSectionsToPdf(parseMarkdownSections(markdown), blocks)
}
