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
  const endings = org.match(/\r?\n/g) || []
  const lines = org.split(/\r?\n/)
  const htmlTableRows = new Map<number, { cells: string[], first: boolean, last: boolean }>()
  for (let index = 0; index < lines.length;) {
    if (!isOrgTableLine(lines[index])) { index++; continue }
    let end = index
    while (end + 1 < lines.length && isOrgTableLine(lines[end + 1])) end++
    const group = lines.slice(index, end + 1).map(normalizeOrgTableLine)
    if (!group.some(isOrgTableSeparator)) {
      group.forEach((line, offset) => htmlTableRows.set(index + offset, {
        cells: orgTableCells(line),
        first: offset === 0,
        last: offset === group.length - 1,
      }))
    }
    index = end + 1
  }

  let block: 'src' | 'example' | 'quote' | null = null
  let propertyDrawer = false
  let plainDrawer = false
  const converted = lines.map((line, lineIndex) => {
    const htmlTable = htmlTableRows.get(lineIndex)
    if (htmlTable) {
      const row = `<tr>${htmlTable.cells.map(cell => `<td>${orgInlineToHtml(cell)}</td>`).join('')}</tr>`
      return `${htmlTable.first ? '<table class="org-table"><tbody>' : ''}${row}${htmlTable.last ? '</tbody></table>' : ''}`
    }

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

    if (/^\s*:PROPERTIES:\s*$/i.test(line)) {
      propertyDrawer = true
      return `<dl class="org-properties"${sourceLineAttribute(lineIndex)}>`
    }
    if (propertyDrawer && /^\s*:END:\s*$/i.test(line)) {
      propertyDrawer = false
      return '</dl>'
    }
    if (propertyDrawer) {
      const property = line.match(/^\s*:([^:]+):\s*(.*)$/)
      if (property) return `<div class="org-property"${sourceLineAttribute(lineIndex)}><dt>${escapeHtml(property[1])}</dt><dd>${orgInlineToHtml(property[2])}</dd></div>`
    }
    if (/^\s*(?:(?:CLOSED|SCHEDULED|DEADLINE):\s*(?:\[[^\]]+\]|<[^>]+>)\s*)+$/i.test(line)) {
      const items = Array.from(line.matchAll(/(CLOSED|SCHEDULED|DEADLINE):\s*(\[[^\]]+\]|<[^>]+>)/gi))
      return `<div class="org-planning"${sourceLineAttribute(lineIndex)}>${items.map(item => `<span class="org-${item[1].toLowerCase()}"><strong>${item[1].toUpperCase()}:</strong> <time>${escapeHtml(item[2])}</time></span>`).join(' ')}</div>`
    }
    const drawer = line.match(/^\s*:([A-Za-z][A-Za-z0-9_-]*):\s*$/)
    if (!plainDrawer && drawer && drawer[1].toUpperCase() !== 'END') {
      plainDrawer = true
      return `<div class="org-drawer" data-drawer="${escapeHtml(drawer[1])}"${sourceLineAttribute(lineIndex)}>`
    }
    if (plainDrawer && /^\s*:END:\s*$/i.test(line)) {
      plainDrawer = false
      return '</div>'
    }

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
    if (isOrgTableSeparator(normalizeOrgTableLine(line))) return normalizeOrgTableLine(line).replace(/\+/g, '|')
    if (isOrgTableLine(line)) return normalizeOrgTableLine(line)
    const fixedWidth = line.match(/^\s*:\s(.*)$/)
    if (fixedWidth) return `    ${fixedWidth[1]}`
    return orgInlineToMarkdown(line.replace(/^(\s*)(\d+)\)(\s+)/, '$1$2.$3'))
  })
  return converted.map((line, index) => line + (endings[index] || '')).join('')
}

function normalizeOrgTableLine(line: string): string {
  return line.replace(/\\\|/g, '|').trim()
}

function isOrgTableLine(line: string): boolean {
  return /^\s*\\?\|.*\\?\|\s*$/.test(line)
}

function isOrgTableSeparator(line: string): boolean {
  return /^\|[-+]+(?:\+[-+]+)+\|?$/.test(line.replace(/\s/g, ''))
}

function orgTableCells(line: string): string[] {
  const normalized = normalizeOrgTableLine(line)
  return normalized.slice(1, normalized.endsWith('|') ? -1 : undefined).split('|').map(cell => cell.trim())
}

function sourceLineAttribute(lineIndex: number): string {
  return ` data-md-start-line="${lineIndex}" data-md-end-line="${lineIndex + 1}"`
}

function escapeHtml(source: string): string {
  return source.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function orgInlineToHtml(source: string): string {
  let value = escapeHtml(source)
  value = value.replace(/\[\[(?:file:)?([^\]]+)\]\[([^\]]+)\]\]/gi, '<a href="$1">$2</a>')
  value = value.replace(/~([^~\n]+)~|=([^=\n]+)=/g, (_match, code, verbatim) => `<code>${code || verbatim}</code>`)
  value = value.replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>')
  value = value.replace(/\/([^/\n]+)\//g, '<em>$1</em>')
  value = value.replace(/\+([^+\n]+)\+/g, '<del>$1</del>')
  return value
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
