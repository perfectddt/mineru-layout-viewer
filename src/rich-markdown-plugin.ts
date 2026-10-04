import type MarkdownIt from 'markdown-it'
import katex from 'katex'
import texmath from 'markdown-it-texmath'
import footnote from 'markdown-it-footnote'
import taskLists from 'markdown-it-task-lists'
import type { MarkdownRenderPlugin } from './markdown-preview.js'

type MarkdownItInstance = ReturnType<typeof MarkdownIt>

/** Built-in rich renderer: HTML/BR, extended tables, tasks, footnotes and KaTeX. */
export function createRichMarkdownPlugin(): MarkdownRenderPlugin {
  return {
    name: 'mineru-rich-markdown',
    configure(renderer: MarkdownItInstance) {
      renderer.set({
        html: true,
        linkify: true,
        breaks: true,
        typographer: true,
      })
      renderer
        .use(taskLists, { enabled: true, label: true, labelAfter: true })
        .use(footnote)
        .use(texmath, {
          engine: katex,
          delimiters: ['dollars', 'brackets', 'beg_end'],
          katexOptions: { throwOnError: false, strict: 'ignore', output: 'mathml' },
        })
      // Org planning, drawers and tables are one HTML tag per source line.
      // CommonMark would keep reading until a blank line and hide the next
      // heading or paragraph from preview, live edit and double-click.
      renderer.block.ruler.before('html_block', 'single_line_html', (state, startLine, _endLine, silent) => {
        const pos = state.bMarks[startLine] + state.tShift[startLine]
        const max = state.eMarks[startLine]
        if (state.src.charCodeAt(pos) !== 0x3C) return false
        const line = state.src.slice(pos, max)
        if (line.startsWith('<!--') && !line.includes('-->')) return false
        if (line.startsWith('<?') && !line.includes('?>')) return false
        const tag = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(line)
        if (!tag || !/^<\/?[A-Za-z][^>\n]*>/.test(line)) return false
        const name = tag[1].toLowerCase()
        if (name === 'script' || name === 'style' || name === 'pre' || name === 'textarea') return false
        if (name === 'http' || name === 'https' || name === 'mailto' || name === 'ftp') return false
        if (silent) return true
        const token = state.push('html_block', '', 0)
        token.content = `${line}\n`
        token.map = [startLine, startLine + 1]
        state.line = startLine + 1
        return true
      })
    },
    styles: `
.md-preview eq { display:inline-block; }
.md-preview eqn { display:block; overflow-x:auto; padding:.6em 0; text-align:center; }
.md-preview section.eqno { display:flex; align-items:center; }
.md-preview section.eqno > eqn { flex:1; }
.md-preview .katex math { font-size:1.06em; }
.md-preview .task-list-item { list-style:none; }
.md-preview .task-list-item-checkbox { margin:0 .55em 0 -1.35em; }
.md-preview .footnotes { margin-top:2em; padding-top:.8em; border-top:1px solid #dbe3ec; font-size:.9em; }
`,
  }
}

/** Default reading theme. Register another plugin with this name to replace it. */
export function createElegantReadingTheme(): MarkdownRenderPlugin {
  return {
    name: 'mineru-reading-theme',
    styles: `
.md-preview { max-width:920px; margin:0 auto; padding:18px 34px 64px; color:#253044; letter-spacing:.012em; }
.md-preview > :first-child { margin-top:0; }
.md-preview h1,.md-preview h2 { border-bottom-color:#d7e0ec; }
.md-preview h2 { margin-top:1.55em; }
.md-preview p { margin:.75em 0; }
.md-preview strong { color:#172033; }
.md-preview table { display:block; overflow-x:auto; border-radius:7px; }
.md-preview tr:nth-child(even) td { background:#f8fafc; }
.md-preview hr { border:0; border-top:1px solid #dbe3ec; margin:1.8em 0; }
.md-preview img.md-asset { border-radius:7px; box-shadow:0 4px 18px rgba(15,23,42,.10); }
@media (prefers-color-scheme:dark) {
  .md-preview { color:#dbe4f0; }
  .md-preview h1,.md-preview h2 { border-bottom-color:#334155; }
  .md-preview strong { color:#f8fafc; }
  .md-preview tr:nth-child(even) td { background:#111827; }
  .md-preview hr { border-top-color:#334155; }
  .md-preview img.md-asset { box-shadow:0 4px 18px rgba(0,0,0,.35); }
}
`,
  }
}
