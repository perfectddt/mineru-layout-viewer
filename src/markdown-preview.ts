import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'

type MarkdownItInstance = ReturnType<typeof MarkdownIt>

export interface MarkdownRenderPlugin {
  name: string
  configure?: (renderer: MarkdownItInstance) => void
  styles?: string
  afterRender?: (root: HTMLElement) => void
}

/** Markdown preview renderer with source-line annotations and plugin hooks. */
export class MarkdownPreviewRenderer {
  private renderer: MarkdownItInstance

  constructor(private plugins: MarkdownRenderPlugin[] = []) {
    this.renderer = this.createRenderer()
  }

  setPlugins(plugins: MarkdownRenderPlugin[]) {
    this.plugins = [...plugins]
    this.renderer = this.createRenderer()
  }

  render(markdown: string): string {
    return [...this.renderBatches(markdown, Number.POSITIVE_INFINITY)].join('')
  }

  /** Inline-only rendering (bold/italic/code/links) for compact labels such as mind-map nodes. */
  renderInline(markdown: string): string {
    return this.sanitize(this.renderer.renderInline(markdown, {}))
  }

  /** Parse once, keeping references, footnotes and absolute source maps shared.
   * Yield only between balanced top-level structures, never inside a list/table.
   */
  *renderBatches(markdown: string, tokenBudget = 160): Generator<string> {
    const environment: Record<string, unknown> = {}
    const tokens = this.renderer.parse(markdown, environment)
    for (const token of tokens) {
      if (!token.map || (!token.block && token.nesting !== 1)) continue
      token.attrSet('data-md-start-line', String(token.map[0]))
      token.attrSet('data-md-end-line', String(token.map[1]))
    }
    let start = 0
    let depth = 0
    const htmlStack: string[] = []
    const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
    for (let index = 0; index < tokens.length; index++) {
      depth += tokens[index].nesting
      // Rich/Org plugins may emit one html_block per line of a table or div.
      // Such structures must reach their closing tag before a DOM insertion.
      if (tokens[index].type === 'html_block') {
        const html = tokens[index].content.replace(/<!--[\s\S]*?-->/g, '')
        for (const match of html.matchAll(/<(\/?)([a-z][\w:-]*)\b[^>]*>/gi)) {
          const tag = match[2].toLowerCase()
          if (match[1]) {
            const open = htmlStack.lastIndexOf(tag)
            if (open >= 0) htmlStack.length = open
          } else if (!voidTags.has(tag) && !/\/\s*>$/.test(match[0])) htmlStack.push(tag)
        }
      }
      if (depth !== 0 || htmlStack.length !== 0 || (index - start + 1 < tokenBudget && index < tokens.length - 1)) continue
      const html = this.renderer.renderer.render(tokens.slice(start, index + 1), this.renderer.options, environment)
      yield this.sanitize(html)
      start = index + 1
    }
    if (start < tokens.length) {
      yield this.sanitize(this.renderer.renderer.render(tokens.slice(start), this.renderer.options, environment))
    }
  }

  private sanitize(html: string): string {
    const purifier = DOMPurify as unknown as { sanitize?: (value: string, options: Record<string, unknown>) => string }
    if (!purifier.sanitize) return html
    return purifier.sanitize(html, {
      USE_PROFILES: { html: true, mathMl: true, svg: true },
      ADD_TAGS: ['eq', 'eqn'],
      ADD_ATTR: ['data-md-start-line', 'data-md-end-line', 'data-idx'],
    })
  }

  styles(): string {
    return this.plugins.map(plugin => plugin.styles || '').filter(Boolean).join('\n')
  }

  afterRender(root: HTMLElement) {
    for (const plugin of this.plugins) plugin.afterRender?.(root)
  }

  private createRenderer(): MarkdownItInstance {
    const renderer = new MarkdownIt({
      html: false,
      linkify: true,
      breaks: false,
      typographer: false,
    })
    for (const plugin of this.plugins) plugin.configure?.(renderer)
    return renderer
  }
}
