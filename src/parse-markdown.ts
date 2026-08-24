import type { MdSection } from './parse-blocks.js'
import { normalizeAssetPath } from './parse-blocks.js'

const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/
const HTML_IMAGE_RE = /<(?:img|file)\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/i
const ORG_IMAGE_RE = /\[\[(?:file:)?([^\]]+\.(?:avif|bmp|gif|jpe?g|png|svg|webp)(?:[?#][^\]]*)?)\](?:\[[^\]]*\])?\]/i

function imagePathFromLine(line: string): string | undefined {
  const markdownMatch = line.match(MARKDOWN_IMAGE_RE)
  const path = markdownMatch?.[1] || markdownMatch?.[2]
  if (path) return normalizeAssetPath(path)

  const htmlMatch = line.match(HTML_IMAGE_RE)
  if (htmlMatch?.[1]) return normalizeAssetPath(htmlMatch[1])
  const orgMatch = line.match(ORG_IMAGE_RE)
  if (orgMatch?.[1]) return normalizeAssetPath(orgMatch[1])
  return undefined
}

/** Split Markdown into editable lines while preserving exact source offsets. */
export function parseMarkdownSections(markdown: string): MdSection[] {
  const sections: MdSection[] = []
  const linePattern = /.*(?:\r\n|\n|$)/g
  let match: RegExpExecArray | null

  while ((match = linePattern.exec(markdown)) !== null) {
    const rawWithNewline = match[0]
    if (!rawWithNewline) break

    const raw = rawWithNewline.replace(/\r?\n$/, '')
    const start = match.index
    const end = start + rawWithNewline.length
    if (!raw.trim()) continue

    const imagePath = imagePathFromLine(raw)
    sections.push({
      id: `md:${start}:${imagePath || 'text'}`,
      raw,
      text: raw,
      start,
      end,
      kind: imagePath ? 'image' : 'text',
      imagePath,
      page: 1,
      bbox: null,
    })
  }

  return sections
}
