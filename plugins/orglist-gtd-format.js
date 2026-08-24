/**
 * Orglist GTD format plugin for MinerU Layout Viewer.
 * Load this file from Settings -> Org default render plugin.
 * All Orglist-specific presentation stays in this plugin.
 */
export default {
  name: 'orglist-gtd-format',
  configure(markdownIt) {
    markdownIt.core.ruler.before('block', 'orglist-gtd-diary', state => {
      state.src = state.src.replace(/^\s*<%%\(diary-chinese-anniversary\s+(\d+)\s+(\d+)\)>\s*$/gim,
        (_match, month, day) => `<div class="gtd-lunar-anniversary" data-month="${month}" data-day="${day}">农历周年：${month} 月 ${day} 日</div>`)
      state.src = state.src.replace(/^\s*:LOGBOOK:\s*\n((?:\s*-\s+State[^\n]*(?:\n|$))+)\s*:END:\s*$/gim, (_match, entries) => {
        const rows = String(entries).trim().split('\n').map(line => line.replace(/^\s*-\s*/, ''))
        const escape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        return `<div class="gtd-logbook"><strong>LOGBOOK</strong><ul>${rows.map(row => `<li>${escape(row)}</li>`).join('')}</ul></div>`
      })
    })
  },
  styles: `
.md-preview.org-preview {
  --gtd-todo:#d97706; --gtd-next:#0284c7; --gtd-done:#16a34a; --gtd-cncl:#94a3b8;
  --gtd-priority-a:#dc2626; --gtd-priority-b:#d97706; --gtd-priority-c:#2563eb;
}
.md-preview.org-preview .gtd-heading { display:flex; align-items:baseline; flex-wrap:wrap; gap:.35em; }
.md-preview.org-preview .gtd-status { padding:.08em .45em; border-radius:999px; color:#fff; font-size:.62em; letter-spacing:.04em; vertical-align:.12em; }
.md-preview.org-preview .gtd-status-todo { background:var(--gtd-todo); }
.md-preview.org-preview .gtd-status-next { background:var(--gtd-next); }
.md-preview.org-preview .gtd-status-done { background:var(--gtd-done); }
.md-preview.org-preview .gtd-status-cncl { background:var(--gtd-cncl); }
.md-preview.org-preview .gtd-heading-done .gtd-title,.md-preview.org-preview .gtd-heading-cncl .gtd-title { opacity:.62; text-decoration:line-through; }
.md-preview.org-preview .gtd-priority { font:.72em/1 ui-monospace,monospace; }
.md-preview.org-preview .gtd-priority-a { color:var(--gtd-priority-a); }
.md-preview.org-preview .gtd-priority-b { color:var(--gtd-priority-b); }
.md-preview.org-preview .gtd-priority-c { color:var(--gtd-priority-c); }
.md-preview.org-preview .gtd-tags { color:#7c3aed; font-size:.7em; font-weight:500; }
.md-preview.org-preview .gtd-habit::after { content:'习惯'; margin-left:.45em; padding:.08em .42em; border:1px solid #22c55e; border-radius:999px; color:#15803d; font-size:.58em; vertical-align:.15em; }
.md-preview.org-preview .org-scheduled strong { color:#0284c7; }
.md-preview.org-preview .org-deadline strong { color:#dc2626; }
.md-preview.org-preview .org-closed strong { color:#16a34a; }
.md-preview.org-preview .gtd-property-id dd { font-family:ui-monospace,monospace; }
.md-preview.org-preview .gtd-property-modified dd { color:#64748b; }
.md-preview.org-preview .gtd-property-org_gtd dd { color:#7c3aed; font-weight:700; }
.md-preview.org-preview .gtd-logbook-boundary { color:#94a3b8; font:700 .82em ui-monospace,monospace; }
.md-preview.org-preview .gtd-logbook { padding:.55em 1em .55em 2em; border-left:3px solid #22c55e; background:color-mix(in srgb,#22c55e 7%,transparent); }
.md-preview.org-preview .gtd-lunar-anniversary { margin:.5em 0; padding:.45em .8em; border-left:3px solid #e11d48; background:color-mix(in srgb,#e11d48 7%,transparent); color:#be123c; }
.md-preview.org-preview table.live-source-active { display:table; }
.md-preview.org-preview table.live-source-active td { background:transparent; font-family:ui-monospace,monospace; }
`,
  afterRender(root) {
    if (!root.classList.contains('org-preview')) return
    const statusPattern = /^(TODO|NEXT|DONE|CNCL)\s+/i
    for (const heading of root.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
      const raw = (heading.textContent || '').trim()
      const status = raw.match(statusPattern)?.[1]?.toUpperCase() || ''
      const priority = raw.match(/\[#([A-Z0-9])\]/i)?.[1]?.toUpperCase() || ''
      const tags = raw.match(/\s+(:[^:\s]+(?::[^:\s]+)*:)\s*$/)?.[1] || ''
      let title = raw.replace(statusPattern, '').replace(/\s*\[#[A-Z0-9]\]\s*/i, ' ')
      if (tags) title = title.slice(0, title.lastIndexOf(tags)).trim()
      if (!status && !priority && !tags) continue
      heading.classList.add('gtd-heading')
      if (status) heading.classList.add(`gtd-heading-${status.toLowerCase()}`)
      heading.replaceChildren()
      if (status) {
        const badge = document.createElement('span')
        badge.className = `gtd-status gtd-status-${status.toLowerCase()}`
        badge.textContent = status
        heading.appendChild(badge)
      }
      if (priority) {
        const badge = document.createElement('span')
        badge.className = `gtd-priority gtd-priority-${priority.toLowerCase()}`
        badge.textContent = `[#${priority}]`
        heading.appendChild(badge)
      }
      const titleNode = document.createElement('span')
      titleNode.className = 'gtd-title'
      titleNode.textContent = title
      heading.appendChild(titleNode)
      if (tags) {
        const tagNode = document.createElement('span')
        tagNode.className = 'gtd-tags'
        tagNode.textContent = tags.split(':').filter(Boolean).map(tag => `#${tag}`).join(' ')
        heading.appendChild(tagNode)
      }
    }
    for (const property of root.querySelectorAll('.org-property')) {
      const key = (property.querySelector('dt')?.textContent || '').trim().toLowerCase()
      if (key) property.classList.add(`gtd-property-${key.replace(/[^a-z0-9_-]/g, '-')}`)
      if (key === 'style' && /\bhabit\b/i.test(property.querySelector('dd')?.textContent || '')) {
        let sibling = property.closest('.org-properties')?.previousElementSibling
        while (sibling && !/^H[1-6]$/.test(sibling.tagName)) sibling = sibling.previousElementSibling
        sibling?.classList.add('gtd-habit')
      }
    }
    for (const paragraph of root.querySelectorAll('p')) {
      const text = (paragraph.textContent || '').trim()
      if (!/^:(?:LOGBOOK|END):$/i.test(text)) continue
      paragraph.classList.add('gtd-logbook-boundary')
      if (/^:LOGBOOK:$/i.test(text) && paragraph.nextElementSibling?.matches('ul,ol')) {
        paragraph.nextElementSibling.classList.add('gtd-logbook')
      }
    }
  },
}
