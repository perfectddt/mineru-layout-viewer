/**
 * Mind map model for standalone Markdown / Org documents.
 *
 * Everything in this module is a pure function over the document text so the
 * tree, the layout and every structural edit can be unit tested without a DOM.
 * The viewer owns selection, folding and drag state; this module only answers
 * "what does this document look like as a tree" and "what does the source look
 * like after this edit".
 *
 * Line mapping is the contract that makes live editing safe: every node keeps
 * the exact offsets of its own line plus the offset just past its whole
 * subtree, so an edit is a slice/replace on the original string and never a
 * re-serialization of the document.
 */

import type { DocumentFormat } from './org-format.js'

// ── Public types ─────────────────────────────────────────────────────────────

/** Source anchors for one mind map line. All offsets index the document text. */
export interface MindmapSourceRef {
  /** 0-based index of the line that owns this node. */
  line: number
  /** Offset of the line start. */
  lineStart: number
  /** Offset of the line end, excluding the line ending. */
  lineEnd: number
  /** Offset just past the last line ending of the whole subtree. */
  subtreeEnd: number
  /** 0-based index of the subtree's last line. */
  lastLine: number
  /** Offset of the node label (the text after the heading marker or bullet). */
  labelStart: number
  labelEnd: number
  /** Heading marker (`##`) or list bullet (`-`, `1.`). */
  marker: string
  /** Raw indentation in front of a list bullet; empty for headings. */
  indent: string
  /** Indent width in spaces, counting a tab as four. */
  indentWidth: number
  /** Unified nesting depth: heading level, or heading level + list depth. */
  depth: number
}

export type MindmapNodeKind = 'root' | 'heading' | 'list'

export interface MindmapNode {
  id: string
  kind: MindmapNodeKind
  label: string
  /** Heading level 1..6, list nesting depth, or 0 for a synthetic root. */
  level: number
  depth: number
  /** `null` only for a synthetic root, which has no line of its own. */
  source: MindmapSourceRef | null
  children: MindmapNode[]
  parent: MindmapNode | null
}

export interface MindmapTree {
  root: MindmapNode
  /** Pre-order flat list, root first. */
  nodes: MindmapNode[]
  title: string
  /** Resolved list indentation unit used when adding nested nodes. */
  indentUnit: number
  /** True when the root has no source line of its own. */
  syntheticRoot: boolean
  format: DocumentFormat
}

export interface MindmapParseOptions {
  format: DocumentFormat
  /** Document title; falls back to `#+TITLE:` / the first H1 / `思维导图`. */
  title?: string
}

// ── Line classification ──────────────────────────────────────────────────────

interface ClassifiedLine {
  index: number
  kind: 'heading' | 'list'
  /** Heading level 1..6; 0 for a list line. */
  level: number
  /** Indent width in spaces before the bullet; 0 for headings. */
  indentWidth: number
  marker: string
  indent: string
  label: string
  labelStartInLine: number
  labelEndInLine: number
  /** Unified nesting depth derived while walking the document. */
  depth: number
}

const MARKDOWN_HEADING = /^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/
const ORG_HEADING = /^(\*+)[ \t]+(.*)$/
const MARKDOWN_LIST = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)(.*)$/
const ORG_LIST = /^([ \t]*)([-+]|\d{1,9}[.)])([ \t]+)(.*)$/
const THEMATIC_BREAK = /^ {0,3}(?:(?:[-*_])[ \t]*){3,}$/
const ORG_TITLE = /^[ \t]*#\+TITLE:[ \t]*(.*)$/i
const ORG_BLOCK_BEGIN = /^[ \t]*#\+BEGIN_([A-Za-z]+)/
const ORG_BLOCK_END = /^[ \t]*#\+END_([A-Za-z]+)/
const MARKDOWN_FENCE = /^ {0,3}(`{3,}|~{3,})/

interface LineOffset {
  index: number
  start: number
  end: number
  next: number
  text: string
}

/** A tab is four columns wide everywhere indentation is measured. */
function indentWidthOf(indent: string): number {
  let width = 0
  for (const char of indent) width += char === '\t' ? 4 : 1
  return width
}

/** Classify one source line as a heading, a list item, or neither. */
function classifyLine(line: string, format: DocumentFormat): Omit<ClassifiedLine, 'index' | 'depth'> | null {
  const heading = format === 'org' ? ORG_HEADING.exec(line) : MARKDOWN_HEADING.exec(line)
  if (heading) {
    const marker = heading[1]
    const label = heading[2]
    let cursor = marker.length
    while (cursor < line.length && /[ \t]/.test(line[cursor])) cursor++
    return {
      kind: 'heading',
      level: marker.length,
      indentWidth: 0,
      marker,
      indent: '',
      label,
      labelStartInLine: cursor,
      labelEndInLine: cursor + label.length,
    }
  }

  if (format === 'markdown' && THEMATIC_BREAK.test(line)) return null
  const list = (format === 'org' ? ORG_LIST : MARKDOWN_LIST).exec(line)
  if (!list) return null
  const indent = list[1]
  const marker = list[2]
  const label = list[4]
  let cursor = indent.length + marker.length
  while (cursor < line.length && /[ \t]/.test(line[cursor])) cursor++
  return {
    kind: 'list',
    level: 0,
    indentWidth: indentWidthOf(indent),
    marker,
    indent,
    label,
    labelStartInLine: cursor,
    labelEndInLine: cursor + label.length,
  }
}

/** Split the document into lines while keeping exact offsets and line endings. */
function scanLines(source: string): LineOffset[] {
  const lines: LineOffset[] = []
  const pattern = /[^\r\n]*(?:\r\n|\n|\r|$)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source)) !== null) {
    const raw = match[0]
    if (!raw) break
    const withoutEol = raw.replace(/\r\n$|\n$|\r$/, '')
    lines.push({
      index: lines.length,
      start: match.index,
      end: match.index + withoutEol.length,
      next: match.index + raw.length,
      text: withoutEol,
    })
    if (pattern.lastIndex >= source.length) break
  }
  if (!lines.length) lines.push({ index: 0, start: 0, end: 0, next: 0, text: '' })
  return lines
}

/** 0-based line index containing `offset`. */
function lineIndexAt(text: string, offset: number): number {
  let line = 0
  const limit = Math.min(offset, text.length)
  for (let index = 0; index < limit; index++) {
    if (text[index] === '\n') line++
    else if (text[index] === '\r' && text[index + 1] !== '\n') line++
  }
  return line
}

/** Line ending the document already uses, so inserted lines match the file. */
export function preferredLineEnding(source: string): string {
  const crlf = source.split('\r\n').length - 1
  if (!crlf) return '\n'
  const lf = source.split('\n').length - 1
  return crlf * 2 >= lf ? '\r\n' : '\n'
}

/**
 * Track fenced code while walking lines. Headings and bullets inside a fence
 * are content, not structure — the same trap that made source line scanning
 * produce phantom ranges before.
 */
function createFenceTracker(): (line: string, format: DocumentFormat) => boolean {
  let markdownFence: string | null = null
  let orgBlocks = 0
  return (line, format) => {
    if (format === 'org') {
      if (ORG_BLOCK_BEGIN.test(line)) { orgBlocks++; return true }
      if (ORG_BLOCK_END.test(line)) { orgBlocks = Math.max(0, orgBlocks - 1); return true }
      return orgBlocks > 0
    }
    const fence = MARKDOWN_FENCE.exec(line)
    if (markdownFence) {
      if (fence && fence[1][0] === markdownFence[0] && fence[1].length >= markdownFence.length) {
        markdownFence = null
      }
      return true
    }
    if (fence) {
      markdownFence = fence[1]
      return true
    }
    return false
  }
}

/** Smallest positive list indentation in the document; the nesting unit. */
export function detectMindmapIndentUnit(source: string, format: DocumentFormat): number {
  const inFence = createFenceTracker()
  const listPattern = format === 'org' ? ORG_LIST : MARKDOWN_LIST
  let unit = 0
  for (const line of source.split(/\r\n|\n|\r/)) {
    if (inFence(line, format)) continue
    const match = listPattern.exec(line)
    if (!match) continue
    const width = indentWidthOf(match[1])
    if (width > 0 && (unit === 0 || width < unit)) unit = width
  }
  return unit >= 2 && unit <= 8 ? unit : 2
}

/** Classify and depth-annotate every structural line of a fragment. */
function classifyDocument(source: string, format: DocumentFormat, indentUnit: number): ClassifiedLine[] {
  const inFence = createFenceTracker()
  const items: ClassifiedLine[] = []
  let lastHeadingLevel = 0
  for (const line of scanLines(source)) {
    if (!line.text.trim()) continue
    if (inFence(line.text, format)) continue
    const classified = classifyLine(line.text, format)
    if (!classified) continue
    let depth: number
    if (classified.kind === 'heading') {
      depth = classified.level
      lastHeadingLevel = classified.level
    } else {
      depth = (lastHeadingLevel > 0 ? lastHeadingLevel : 0) + 1 + Math.floor(classified.indentWidth / indentUnit)
    }
    items.push({ ...classified, index: line.index, depth })
  }
  return items
}

/**
 * Title for a synthetic root. An explicit Org `#+TITLE:` is the document's own
 * answer, so it wins over the caller's suggestion, which in turn beats the
 * first level-1 heading (that heading is already a child of the root).
 */
function documentTitle(source: string, format: DocumentFormat, items: ClassifiedLine[], preferred?: string): string {
  if (format === 'org') {
    for (const line of source.split(/\r\n|\n|\r/)) {
      const title = ORG_TITLE.exec(line)
      if (title && title[1].trim()) return title[1].trim()
    }
  }
  if (preferred?.trim()) return preferred.trim()
  const firstHeading = items.find(item => item.kind === 'heading' && item.level === 1)
  return firstHeading?.label.trim() || ''
}

// ── Tree construction ────────────────────────────────────────────────────────

function makeNode(
  kind: MindmapNodeKind,
  label: string,
  level: number,
  depth: number,
  source: MindmapSourceRef | null,
): MindmapNode {
  return {
    id: source ? `line:${source.line}` : 'root',
    kind,
    label,
    level,
    depth,
    source,
    children: [],
    parent: null,
  }
}

function sourceRefFor(item: ClassifiedLine, lines: LineOffset[], depth: number): MindmapSourceRef {
  const line = lines[item.index]
  return {
    line: item.index,
    lineStart: line.start,
    lineEnd: line.end,
    subtreeEnd: line.next,
    lastLine: item.index,
    labelStart: line.start + item.labelStartInLine,
    labelEnd: line.start + item.labelEndInLine,
    marker: item.marker,
    indent: item.indent,
    indentWidth: item.indentWidth,
    depth,
  }
}

/**
 * Build the tree for a document.
 *
 * Depth is a single scale shared by headings and lists: a heading sits at its
 * own level and a list sits one step below the nearest heading, so one stack
 * can nest both kinds correctly.
 */
export function parseMindmapTree(source: string, options: MindmapParseOptions): MindmapTree {
  const format = options.format
  const indentUnit = detectMindmapIndentUnit(source, format)
  const items = classifyDocument(source, format, indentUnit)
  const lines = scanLines(source)

  const roots: MindmapNode[] = []
  const stack: MindmapNode[] = []
  for (const item of items) {
    const node = makeNode(item.kind, item.label, item.level, item.depth, sourceRefFor(item, lines, item.depth))
    node.id = `line:${item.index}`
    while (stack.length && stack[stack.length - 1].depth >= item.depth) stack.pop()
    const parent = stack[stack.length - 1]
    if (parent) {
      node.parent = parent
      parent.children.push(node)
    } else {
      roots.push(node)
    }
    stack.push(node)
  }

  let root: MindmapNode
  if (roots.length === 1) {
    root = roots[0]
  } else {
    const title = documentTitle(source, format, items, options.title) || '思维导图'
    root = makeNode('root', title, 0, 0, null)
    for (const child of roots) {
      child.parent = root
      root.children.push(child)
    }
  }

  annotateSubtrees(root)
  return {
    root,
    nodes: collectMindmapNodes(root),
    title: root.label,
    indentUnit,
    syntheticRoot: !root.source,
    format,
  }
}

/** Fill `subtreeEnd` / `lastLine` bottom-up; subtrees are contiguous in source. */
function annotateSubtrees(node: MindmapNode): void {
  for (const child of node.children) annotateSubtrees(child)
  if (!node.source) return
  let subtreeEnd = node.source.subtreeEnd
  let lastLine = node.source.line
  for (const child of node.children) {
    if (!child.source) continue
    subtreeEnd = Math.max(subtreeEnd, child.source.subtreeEnd)
    lastLine = Math.max(lastLine, child.source.lastLine)
  }
  node.source.subtreeEnd = subtreeEnd
  node.source.lastLine = lastLine
}

export function collectMindmapNodes(root: MindmapNode): MindmapNode[] {
  const out: MindmapNode[] = []
  const walk = (node: MindmapNode) => {
    out.push(node)
    for (const child of node.children) walk(child)
  }
  walk(root)
  return out
}

/** Innermost node whose subtree covers a 0-based source line. */
export function mindmapNodeAtLine(tree: MindmapTree, line: number): MindmapNode | null {
  let found: MindmapNode | null = null
  for (const node of tree.nodes) {
    const ref = node.source
    if (!ref) continue
    if (line < ref.line || line > ref.lastLine) continue
    if (!found?.source || ref.line >= found.source.line) found = node
  }
  return found
}

// ── Layout ───────────────────────────────────────────────────────────────────

/** Full-width characters, so a CJK label is measured twice as wide. */
const WIDE_CHARACTER = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/

export interface MindmapSize {
  width: number
  height: number
}

export interface MindmapSizeOptions {
  charWidth?: number
  lineHeight?: number
  horizontalPadding?: number
  verticalPadding?: number
  maxTextWidth?: number
  maxLines?: number
  minWidth?: number
}

/**
 * Deterministic node size estimate. The viewer can pass a canvas measurer for
 * pixel-perfect boxes, but tests and the layout maths rely on this estimate.
 */
export function estimateMindmapNodeSize(label: string, options: MindmapSizeOptions = {}): MindmapSize {
  const charWidth = options.charWidth ?? 8
  const lineHeight = options.lineHeight ?? 19
  const horizontalPadding = options.horizontalPadding ?? 24
  const verticalPadding = options.verticalPadding ?? 14
  const maxTextWidth = options.maxTextWidth ?? 208
  const maxLines = options.maxLines ?? 3
  const minWidth = options.minWidth ?? 78

  let units = 0
  for (const char of label) units += WIDE_CHARACTER.test(char) ? 2 : 1
  const unitsPerLine = Math.max(6, Math.floor(maxTextWidth / charWidth))
  const lineCount = Math.min(maxLines, Math.max(1, Math.ceil(units / unitsPerLine)))
  return {
    width: Math.max(minWidth, Math.round(Math.min(units, unitsPerLine) * charWidth) + horizontalPadding),
    height: lineCount * lineHeight + verticalPadding,
  }
}

export interface MindmapLayoutOptions {
  verticalGap?: number
  horizontalGap?: number
  padding?: number
  /** Node ids whose children are hidden. */
  collapsed?: ReadonlySet<string>
  measure?: (node: MindmapNode) => MindmapSize
}

export interface MindmapLayoutBox {
  node: MindmapNode
  index: number
  /** Index of the nearest visible ancestor box; -1 for the root. */
  parentIndex: number
  depth: number
  x: number
  y: number
  width: number
  height: number
  collapsed: boolean
  hasChildren: boolean
}

export interface MindmapLayout {
  boxes: MindmapLayoutBox[]
  /** Index pairs into `boxes`, drawn parent-edge to child-edge. */
  links: Array<{ from: number; to: number }>
  width: number
  height: number
}

/**
 * Right-facing tidy tree. Every node is centred on the band its own subtree
 * occupies, which is what keeps a long branch anchored instead of drifting.
 */
export function layoutMindmap(tree: MindmapTree, options: MindmapLayoutOptions = {}): MindmapLayout {
  const verticalGap = options.verticalGap ?? 12
  const horizontalGap = options.horizontalGap ?? 46
  const padding = options.padding ?? 32
  const collapsed = options.collapsed ?? new Set<string>()
  const measure = options.measure ?? ((node: MindmapNode) => estimateMindmapNodeSize(node.label))

  const boxes: MindmapLayoutBox[] = []
  const links: Array<{ from: number; to: number }> = []
  const bandHeight = new Map<number, number>()

  const build = (node: MindmapNode, parentIndex: number, depth: number): number => {
    const size = measure(node)
    const isCollapsed = collapsed.has(node.id)
    const index = boxes.length
    boxes.push({
      node,
      index,
      parentIndex,
      depth,
      x: 0,
      y: 0,
      width: size.width,
      height: size.height,
      collapsed: isCollapsed,
      hasChildren: node.children.length > 0,
    })
    let band = 0
    if (!isCollapsed) {
      let total = 0
      let count = 0
      for (const child of node.children) {
        const childIndex = build(child, index, depth + 1)
        links.push({ from: index, to: childIndex })
        total += bandHeight.get(childIndex) ?? 0
        count++
      }
      band = count ? total + verticalGap * (count - 1) : 0
    }
    bandHeight.set(index, Math.max(size.height, band))
    return index
  }
  build(tree.root, -1, 0)

  const childrenOf = new Map<number, number[]>()
  for (const link of links) {
    const bucket = childrenOf.get(link.from)
    if (bucket) bucket.push(link.to)
    else childrenOf.set(link.from, [link.to])
  }

  const place = (index: number, x: number, top: number) => {
    const box = boxes[index]
    const band = bandHeight.get(index) ?? box.height
    box.x = x
    box.y = top + (band - box.height) / 2
    let cursor = top
    for (const childIndex of childrenOf.get(index) ?? []) {
      place(childIndex, x + box.width + horizontalGap, cursor)
      cursor += (bandHeight.get(childIndex) ?? 0) + verticalGap
    }
  }
  place(0, 0, 0)

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = 0
  let maxY = 0
  for (const box of boxes) {
    minX = Math.min(minX, box.x)
    minY = Math.min(minY, box.y)
    maxX = Math.max(maxX, box.x + box.width)
    maxY = Math.max(maxY, box.y + box.height)
  }
  if (!boxes.length) return { boxes, links, width: padding * 2, height: padding * 2 }
  const offsetX = padding - minX
  const offsetY = padding - minY
  for (const box of boxes) {
    box.x = Math.round(box.x + offsetX)
    box.y = Math.round(box.y + offsetY)
  }
  return {
    boxes,
    links,
    width: Math.round(maxX + offsetX + padding),
    height: Math.round(maxY + offsetY + padding),
  }
}

// ── Source edits ─────────────────────────────────────────────────────────────

export interface MindmapEditResult {
  text: string
  /** Line the caller should select after the edit. */
  line: number
  /** True when the caller should start inline editing on the new node. */
  edit: boolean
}

export type MindmapDropPosition = 'child' | 'before' | 'after'

/** Labels are single-line; newlines and runs of blanks collapse to one space. */
export function sanitizeMindmapLabel(label: string): string {
  return label.replace(/\s+/g, ' ').trim()
}

/** The line must still carry the label the node was parsed from. */
function sourceIsCurrent(source: string, node: MindmapNode): boolean {
  const ref = node.source
  if (!ref) return false
  if (ref.labelEnd > source.length || ref.lineEnd > source.length) return false
  return source.slice(ref.labelStart, ref.labelEnd) === node.label
}

function nextBullet(marker: string): string {
  const ordered = /^(\d{1,9})([.)])$/.exec(marker)
  return ordered ? `${Number(ordered[1]) + 1}${ordered[2]}` : marker
}

/** A nested ordered list restarts at one instead of continuing the parent. */
function childBullet(marker: string): string {
  const ordered = /^(\d{1,9})([.)])$/.exec(marker)
  return ordered ? `1${ordered[2]}` : marker
}

function headingLine(level: number, label: string): string {
  return `${'#'.repeat(Math.min(6, Math.max(1, level)))} ${label}`
}

/** True when the document already ends with a line break. */
function endsWithLineBreak(source: string): boolean {
  return /[\r\n]$/.test(source)
}

/**
 * Insert `line` as a whole line starting at `offset`. `keepTrailingBreak`
 * preserves the document's habit of ending with a newline or not.
 */
function insertLineAt(
  source: string,
  offset: number,
  line: string,
  eol: string,
  keepTrailingBreak: boolean,
): { text: string; lineStart: number } {
  const before = source.slice(0, offset)
  const after = source.slice(offset)
  const leadingBreak = before.length > 0 && !/[\r\n]$/.test(before) ? eol : ''
  // Appending at the end of a file that has no trailing newline keeps it that way.
  const trailingBreak = after.length === 0 && !keepTrailingBreak ? '' : eol
  return {
    text: `${before}${leadingBreak}${line}${trailingBreak}${after}`,
    lineStart: before.length + leadingBreak.length,
  }
}

/** Re-locate a node in the current tree, guarding against stale offsets. */
function resolveNode(tree: MindmapTree, node: MindmapNode): MindmapNode | null {
  if (!node.source) return tree.syntheticRoot ? tree.root : null
  return tree.nodes.find(candidate => candidate.source?.line === node.source?.line && candidate.label === node.label) ?? null
}

/** Rewrite only the label text of one node; the marker stays untouched. */
export function renameMindmapNode(source: string, tree: MindmapTree, node: MindmapNode, label: string): string | null {
  const target = resolveNode(tree, node)
  const ref = target?.source
  if (!target || !ref || !sourceIsCurrent(source, target)) return null
  const clean = sanitizeMindmapLabel(label)
  if (!clean) return null
  return source.slice(0, ref.labelStart) + clean + source.slice(ref.labelEnd)
}

function lineForChild(node: MindmapNode, label: string, indentUnit: number): string {
  if (!node.source || node.kind !== 'list') {
    // A sixth-level heading cannot nest another heading, so it gains a bullet.
    if (node.source && node.source.marker.length >= 6) return `- ${label}`
    return headingLine(node.source ? node.source.marker.length + 1 : 1, label)
  }
  return `${node.source.indent}${' '.repeat(indentUnit)}${childBullet(node.source.marker)} ${label}`
}

function lineForSibling(node: MindmapNode, label: string): string | null {
  const ref = node.source
  if (!ref) return null
  if (node.kind === 'heading') return headingLine(ref.marker.length, label)
  return `${ref.indent}${nextBullet(ref.marker)} ${label}`
}

/** Add a node right after `node`'s whole subtree, keeping its level and style. */
export function insertMindmapSibling(
  root: string,
  tree: MindmapTree,
  node: MindmapNode,
  label: string,
  indentUnit = tree.indentUnit,
): MindmapEditResult | null {
  const clean = sanitizeMindmapLabel(label)
  if (!clean) return null
  const target = resolveNode(tree, node)
  if (!target?.source) return null
  const line = lineForSibling(target, clean)
  if (!line) return null
  const inserted = insertLineAt(
    root,
    target.source.subtreeEnd,
    line,
    preferredLineEnding(root),
    endsWithLineBreak(root),
  )
  return { text: inserted.text, line: lineIndexAt(inserted.text, inserted.lineStart), edit: true }
}

/** Add a node as the last child of `node`. */
export function insertMindmapChild(
  root: string,
  tree: MindmapTree,
  node: MindmapNode,
  label: string,
  indentUnit = tree.indentUnit,
): MindmapEditResult | null {
  const clean = sanitizeMindmapLabel(label)
  if (!clean) return null
  const target = resolveNode(tree, node)
  if (!target) return null
  const line = lineForChild(target, clean, indentUnit)
  const offset = target.source ? target.source.subtreeEnd : root.length
  const inserted = insertLineAt(root, offset, line, preferredLineEnding(root), endsWithLineBreak(root))
  return { text: inserted.text, line: lineIndexAt(inserted.text, inserted.lineStart), edit: true }
}

/** Remove a node together with everything nested under it. */
export function deleteMindmapNode(source: string, tree: MindmapTree, node: MindmapNode): MindmapEditResult | null {
  const target = resolveNode(tree, node)
  const ref = target?.source
  if (!target || !ref || !sourceIsCurrent(source, target)) return null
  const text = source.slice(0, ref.lineStart) + source.slice(ref.subtreeEnd)
  return { text, line: lineIndexAt(text, Math.min(ref.lineStart, text.length)), edit: false }
}

/**
 * Re-level a subtree by `delta` steps: headings gain or lose `#`, list lines
 * gain or lose one indentation unit. Returns `null` when any line would leave
 * its legal range, so an impossible outdent stays a no-op.
 */
export function shiftMindmapSubtree(
  source: string,
  tree: MindmapTree,
  node: MindmapNode,
  delta: number,
  indentUnit = tree.indentUnit,
): string | null {
  const target = resolveNode(tree, node)
  const ref = target?.source
  if (!target || !ref || !delta || !sourceIsCurrent(source, target)) return null
  const block = source.slice(ref.lineStart, ref.subtreeEnd)
  const classified = new Map(classifyDocument(block, tree.format, indentUnit).map(item => [item.index, item]))
  const eol = preferredLineEnding(source)
  const rewritten: string[] = []
  for (const line of scanLines(block)) {
    const item = classified.get(line.index)
    if (!item) {
      rewritten.push(line.text)
      continue
    }
    if (item.kind === 'heading') {
      const level = item.level + delta
      if (level < 1 || level > 6) return null
      rewritten.push(headingLine(level, item.label))
      continue
    }
    const width = item.indentWidth + delta * indentUnit
    if (width < 0) return null
    rewritten.push(`${' '.repeat(width)}${item.marker} ${item.label}`)
  }
  const text = source.slice(0, ref.lineStart) + rewritten.join(eol) + source.slice(ref.subtreeEnd)
  return text === source ? null : text
}

/** Structural lines of a detached block, with depth relative to its first line. */
function blockLines(block: string, format: DocumentFormat, indentUnit: number): Array<ClassifiedLine & { relative: number }> {
  const classified = classifyDocument(block, format, indentUnit)
  const base = classified.length ? classified[0].depth : 0
  return classified.map(item => ({ ...item, relative: item.depth - base }))
}

/**
 * Re-parent a node. The destination decides the kind: dropping into a list
 * makes the whole block a list, while dropping under a heading keeps headings
 * as headings and shifts the lists nested inside them along.
 */
export function moveMindmapNode(
  source: string,
  tree: MindmapTree,
  node: MindmapNode,
  target: MindmapNode,
  position: MindmapDropPosition,
  indentUnit = tree.indentUnit,
): string | null {
  const moving = resolveNode(tree, node)
  const anchor = resolveNode(tree, target)
  if (!moving?.source || !anchor || moving === anchor) return null
  for (let cursor: MindmapNode | null = anchor; cursor; cursor = cursor.parent) {
    if (cursor === moving) return null
  }
  const ref = moving.source
  if (!sourceIsCurrent(source, moving)) return null

  const removed = ref.subtreeEnd - ref.lineStart
  const stripped = source.slice(0, ref.lineStart) + source.slice(ref.subtreeEnd)
  let insertAt: number
  if (!anchor.source) {
    // Only a synthetic root lacks a source line; new material is appended.
    if (position !== 'child') return null
    insertAt = stripped.length
  } else if (position === 'before') {
    insertAt = anchor.source.lineStart > ref.lineStart
      ? anchor.source.lineStart - removed
      : anchor.source.lineStart
  } else {
    insertAt = anchor.source.subtreeEnd > ref.lineStart
      ? anchor.source.subtreeEnd - removed
      : anchor.source.subtreeEnd
  }

  const block = source.slice(ref.lineStart, ref.subtreeEnd)
  const lines = blockLines(block, tree.format, indentUnit)
  if (!lines.length) return null

  const destinationIsList = anchor.kind === 'list'
  const rootIsList = moving.kind === 'list'
  const anchorIndent = anchor.source?.indentWidth ?? 0
  const listBaseWidth = anchorIndent + (position === 'child' ? indentUnit : 0)
  const headingRootLevel = (anchor.kind === 'root' ? 0 : anchor.level) + (position === 'child' ? 1 : 0)
  const levelDelta = headingRootLevel - moving.level

  const rewritten = lines.map(line => {
    if (destinationIsList || rootIsList) {
      const width = Math.max(0, listBaseWidth + line.relative * indentUnit)
      return `${' '.repeat(width)}- ${line.label}`
    }
    if (line.kind === 'heading') return headingLine(line.level + levelDelta, line.label)
    const width = Math.max(0, line.indentWidth + levelDelta * indentUnit)
    return `${' '.repeat(width)}${line.marker} ${line.label}`
  })

  const eol = preferredLineEnding(source)
  const inserted = insertLineAt(stripped, insertAt, rewritten.join(eol), eol, endsWithLineBreak(source))
  return inserted.text === source ? null : inserted.text
}

// ── Folding helpers ──────────────────────────────────────────────────────────

/** Every node id that has children, used by "collapse all". */
export function mindmapParentIds(tree: MindmapTree): string[] {
  return tree.nodes.filter(node => node.children.length > 0).map(node => node.id)
}

/** Ids of the nodes on the path from the root to `line`, for reveal-scroll. */
export function mindmapPathIds(tree: MindmapTree, line: number): string[] {
  const node = mindmapNodeAtLine(tree, line)
  if (!node) return []
  const ids: string[] = []
  for (let cursor: MindmapNode | null = node; cursor; cursor = cursor.parent) ids.unshift(cursor.id)
  return ids
}
