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
    const environment: Record<string, unknown> = {}
    const tokens = this.renderer.parse(markdown, environment)
    for (const token of tokens) {
      if (!token.map || (!token.block && token.nesting !== 1)) continue
      token.attrSet('data-md-start-line', String(token.map[0]))
      token.attrSet('data-md-end-line', String(token.map[1]))
    }
    const html = this.renderer.renderer.render(tokens, this.renderer.options, environment)
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
