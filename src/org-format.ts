export type DocumentFormat = 'markdown' | 'org'

const ORG_IMAGE_EXTENSION = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/i

/** Detect the source syntax used by a standalone document. */
export function documentFormatFromName(name: string): DocumentFormat {
  return /\.org$/i.test(name) ? 'org' : 'markdown'
}

/**
 * Convert common Org syntax to Markdown while preserving one output line for
 * every input line. Keeping the line map stable lets preview clicks, search,
 * edits, and outlines continue to address the original Org source.
 */
export function orgToMarkdown(org: string): string {
  let block: 'src' | 'example' | 'quote' | null = null
  return org.split(/(\r?\n)/).map(part => {
    if (part === '\n' || part === '\r\n') return part
    const line = part

    const beginSrc = line.match(/^\s*#\+BEGIN_SRC\s*([^\s]*)/i)
    if (beginSrc) {
      block = 'src'
      return `\`\`\`${beginSrc[1] || ''}`
    }
    if (/^\s*#\+END_SRC\s*$/i.test(line)) {
      block = null
      return '```'
    }
    if (/^\s*#\+BEGIN_EXAMPLE\s*$/i.test(line)) {
      block = 'example'
      return '```text'
    }
    if (/^\s*#\+END_EXAMPLE\s*$/i.test(line)) {
      block = null
      return '```'
    }
    if (/^\s*#\+BEGIN_QUOTE\s*$/i.test(line)) {
      block = 'quote'
      return '> '
    }
    if (/^\s*#\+END_QUOTE\s*$/i.test(line)) {
      block = null
      return '> '
    }
    if (block === 'src' || block === 'example') return line
    if (block === 'quote') return `> ${orgInlineToMarkdown(line)}`

    const heading = line.match(/^(\*+)\s+(.+)$/)
    if (heading) return `${'#'.repeat(Math.min(heading[1].length, 6))} ${orgInlineToMarkdown(heading[2])}`

    const keyword = line.match(/^\s*#\+([A-Z_]+):\s*(.*)$/i)
    if (keyword) {
      const key = keyword[1].toUpperCase()
      const value = orgInlineToMarkdown(keyword[2])
      if (key === 'TITLE') return `# ${value}`
      if (key === 'SUBTITLE') return `## ${value}`
      if (key === 'AUTHOR' || key === 'DATE' || key === 'EMAIL') return `> **${key[0]}${key.slice(1).toLowerCase()}：** ${value}`
      if (key === 'CAPTION') return `*${value}*`
      return `<!-- #+${key}: ${keyword[2]} -->`
    }

    if (/^\s*#(?!\+)\s?/.test(line)) return `<!-- ${line.replace(/^\s*#\s?/, '')} -->`
    const footnote = line.match(/^\s*\[fn:([^\]]+)\]\s+(.*)$/i)
    if (footnote) return `[^${footnote[1]}]: ${orgInlineToMarkdown(footnote[2])}`
    if (/^\s*\|[-+]+(?:\+[-+]+)+\|?\s*$/.test(line)) return line.replace(/\+/g, '|')
    return orgInlineToMarkdown(line)
  }).join('')
}

function orgInlineToMarkdown(source: string): string {
  let value = source
  value = value.replace(/\[\[(?:file:)?([^\]]+)\]\[([^\]]+)\]\]/gi, '[$2]($1)')
  value = value.replace(/\[\[(?:file:)?([^\]]+)\]\]/gi, (_match, target: string) =>
    ORG_IMAGE_EXTENSION.test(target) ? `![](${target})` : `[${target}](${target})`)
  value = value.replace(/\[fn:([^\]]+)\]/gi, '[^$1]')
  const prefix = '\\s([{、。，；：！？《【（'
  const punctuation = '\\s.,;:!?)}\\]、。，；：！？》】）'
  value = value.replace(new RegExp(`(^|[${prefix}])\\*([^*\\n]+)\\*(?=$|[${punctuation}])`, 'g'), '$1**$2**')
  value = value.replace(new RegExp(`(^|[${prefix}])\\/([^/\\n]+)\\/(?=$|[${punctuation}])`, 'g'), '$1*$2*')
  value = value.replace(new RegExp(`(^|[${prefix}])\\+([^+\\n]+)\\+(?=$|[${punctuation}])`, 'g'), '$1~~$2~~')
  value = value.replace(new RegExp(`(^|[${prefix}])(?:~([^~\\n]+)~|=([^=\\n]+)=)(?=$|[${punctuation}])`, 'g'), (_match, boundary, code, verbatim) => `${boundary}\`${code || verbatim}\``)
  value = value.replace(new RegExp(`(^|[${prefix}])_([^_\\n]+)_(?=$|[${punctuation}])`, 'g'), '$1<u>$2</u>')
  return value
}
