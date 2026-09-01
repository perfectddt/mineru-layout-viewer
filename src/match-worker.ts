import { matchSectionsToPdf } from './match-markdown.js'
import type { MdSection, PdfBlock } from './parse-blocks.js'

interface MatchRequest { id: number; sections: MdSection[]; blocks: PdfBlock[] }

self.addEventListener('message', (event: MessageEvent<MatchRequest>) => {
  const { id, sections, blocks } = event.data
  try {
    self.postMessage({ id, matched: matchSectionsToPdf(sections, blocks) })
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
  }
})
