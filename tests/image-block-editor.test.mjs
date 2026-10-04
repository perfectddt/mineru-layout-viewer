import test from 'node:test'
import assert from 'node:assert/strict'

globalThis.HTMLElement = class {}

const { MineruLayoutViewer } = await import('../dist/index.mjs')

/** Tiny DOM stand-in: only what openInlineBlockEditor actually touches. */
class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase()
    this.children = []
    this.dataset = {}
    this.style = {}
    this.handlers = new Map()
    this.classList = { add() {}, toggle() {}, contains: () => false }
    this.value = ''
    this.textContent = ''
    this.title = ''
    this.hidden = false
    this.selectionStart = 0
    this.selectionEnd = 0
  }
  append(...nodes) { this.children.push(...nodes) }
  appendChild(node) { this.children.push(node); return node }
  addEventListener(type, handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, [])
    this.handlers.get(type).push(handler)
  }
  fire(type, event = {}) { for (const handler of this.handlers.get(type) || []) handler(event) }
  click() { this.fire('click', { stopPropagation() {} }) }
  focus() {}
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end }
  setRangeText() {}
  replaceWith(node) { this.replacedWith = node }
  querySelectorAll() { return [] }
  closest() { return null }
}

function findButton(root, label) {
  if (root.textContent === label) return root
  for (const child of root.children || []) {
    const hit = findButton(child, label)
    if (hit) return hit
  }
  return null
}

const MARKDOWN = '# 教材\n\n![](imgs/pic.jpg)\n'

/** Viewer with the editor's collaborators (source ranges, edit log) stubbed. */
function createViewer(edits) {
  const viewer = Object.create(MineruLayoutViewer.prototype)
  viewer.markdownMode = 'preview'
  viewer.markdownText = MARKDOWN
  viewer.documentFormat = 'markdown'
  viewer.replaceMarkdownRange = (start, end, replacement, edit) => {
    edits.push({ start, end, replacement, edit })
  }
  return viewer
}

/** The paragraph block that owns line 2 of MARKDOWN (end line is exclusive). */
function createBlock() {
  const block = new FakeElement('p')
  block.dataset.mdStartLine = '2'
  block.dataset.mdEndLine = '3'
  return block
}

let document
test.before(() => {
  document = {
    createElement: tagName => new FakeElement(tagName),
    execCommand: () => true,
  }
  globalThis.document = document
  globalThis.alert = () => {}
})

test('double-clicking an image opens an editor prefilled with its link code', () => {
  const edits = []
  const viewer = createViewer(edits)
  const block = createBlock()
  const image = new FakeElement('img')
  image.closest = selector => {
    if (selector === 'button,a,input,textarea') return null
    if (selector.startsWith('table')) return null
    if (selector.includes('img')) return image
    return block
  }

  viewer.onPreviewDoubleClick({
    target: image,
    preventDefault() {},
    stopPropagation() {},
  })

  const editor = block.replacedWith
  assert.ok(editor, 'the block should be swapped for the inline editor')
  const textarea = editor.children[1]
  // The link code must be visible; an empty box was the reported bug.
  assert.equal(textarea.value, '![](imgs/pic.jpg)')
  assert.equal(textarea.selectionStart, textarea.value.length)
  assert.ok(findButton(editor.children[0], '保存'))

  // Saving without touching anything must not record a no-op edit.
  findButton(editor.children[0], '保存').click()
  assert.equal(edits.length, 0)
  assert.equal(editor.replacedWith, block)
})

test('editing the image path stays a Markdown edit', () => {
  const edits = []
  const viewer = createViewer(edits)
  const block = createBlock()
  viewer.openInlineBlockEditor(block, { imageBlock: true })

  const editor = block.replacedWith
  const textarea = editor.children[1]
  textarea.value = '![](imgs/renamed.jpg)'
  findButton(editor.children[0], '保存').click()

  assert.equal(edits.length, 1)
  assert.equal(edits[0].replacement, '![](imgs/renamed.jpg)\n')
  assert.equal(edits[0].start, MARKDOWN.indexOf('!['))
  assert.equal(edits[0].edit.type, 'edit-markdown')
})

test('replacing the link code with plain text is logged as image-to-text', () => {
  const edits = []
  const viewer = createViewer(edits)
  const block = createBlock()
  viewer.openInlineBlockEditor(block, { imageBlock: true })

  const editor = block.replacedWith
  editor.children[1].value = '图 6-7 企业信息化总体架构'
  findButton(editor.children[0], '保存').click()

  assert.equal(edits.length, 1)
  assert.equal(edits[0].edit.type, 'image-to-text')
})

test('clearing an image block is rejected instead of silently deleting it', () => {
  const edits = []
  let alerted = 0
  globalThis.alert = () => { alerted++ }
  const viewer = createViewer(edits)
  const block = createBlock()
  viewer.openInlineBlockEditor(block, { imageBlock: true })

  const editor = block.replacedWith
  editor.children[1].value = '   '
  findButton(editor.children[0], '保存').click()

  assert.equal(edits.length, 0)
  assert.equal(alerted, 1)
  assert.equal(editor.replacedWith, undefined)
})

test('plain text blocks still open with their own source', () => {
  const edits = []
  const viewer = createViewer(edits)
  const block = createBlock()
  block.dataset.mdStartLine = '0'
  block.dataset.mdEndLine = '1'
  viewer.openInlineBlockEditor(block)

  assert.equal(block.replacedWith.children[1].value, '# 教材')
})
