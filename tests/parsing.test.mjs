import test from 'node:test'
import assert from 'node:assert/strict'

// index.mjs exports the Web Component too; provide the minimal browser base
// class needed to import it while testing the pure parsers in Node.
globalThis.HTMLElement = class {}

const {
  parseBlocks,
  parseMarkdownSections,
  matchMarkdownToPdf,
  MarkdownPreviewRenderer,
} = await import('../dist/index.mjs')

test('content_list images keep paths and normalize 0..1000 bbox values', () => {
  const blocks = parseBlocks(JSON.stringify([
    {
      type: 'image',
      img_path: 'images/figure-1.jpg',
      image_caption: ['Figure 1'],
      page_idx: 1,
      bbox: [100, 200, 800, 700],
    },
  ]))

  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].imagePath, 'images/figure-1.jpg')
  assert.deepEqual(blocks[0].bbox, [0.1, 0.2, 0.8, 0.7])
})

test('middle.json keeps one visual parent and normalizes using page_size', () => {
  const blocks = parseBlocks(JSON.stringify({
    pdf_info: [{
      page_size: [1000, 2000],
      para_blocks: [{
        type: 'image',
        bbox: [100, 400, 900, 1400],
        blocks: [{
          type: 'image_body',
          bbox: [100, 400, 900, 1400],
          lines: [{ spans: [{ type: 'image', image_path: 'images/middle.jpg' }] }],
        }],
      }],
    }],
  }))

  const images = blocks.filter(block => block.imagePath)
  assert.equal(images.length, 1)
  assert.equal(images[0].imagePath, 'images/middle.jpg')
  assert.deepEqual(images[0].bbox, [0.1, 0.2, 0.9, 0.7])
})

test('Markdown image lines preserve offsets and match blocks by image path', () => {
  const markdown = '# Introduction\r\n\r\n![](images/figure-1.jpg)\r\n\r\nEnd\r\n'
  const blocks = parseBlocks(JSON.stringify([
    { type: 'image', img_path: 'images/figure-1.jpg', page_idx: 1, bbox: [100, 200, 800, 700] },
  ]))
  const parsed = parseMarkdownSections(markdown)
  const sections = matchMarkdownToPdf(markdown, blocks)
  const image = sections.find(section => section.kind === 'image')

  assert.equal(parsed.length, 3)
  assert.ok(image)
  assert.equal(image.page, 2)
  assert.ok(image.blockId)

  const removed = markdown.slice(0, image.start) + markdown.slice(image.end)
  assert.equal(removed.includes('figure-1.jpg'), false)
  assert.equal(removed.includes('# Introduction'), true)
  assert.equal(removed.includes('End'), true)
})

test('Markdown preview renders formatting with source-line annotations and safe HTML defaults', () => {
  const renderer = new MarkdownPreviewRenderer()
  const html = renderer.render('# Heading\n\n**bold** and <script>alert(1)</script>\n')

  assert.match(html, /<h1[^>]*data-md-start-line="0"/)
  assert.match(html, /<strong>bold<\/strong>/)
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /&lt;script&gt;/)
})

test('Markdown preview plugins can configure rendering and provide scoped styles', () => {
  const renderer = new MarkdownPreviewRenderer([{
    name: 'line-breaks',
    styles: '.md-preview { color: rebeccapurple; }',
    configure(markdownIt) { markdownIt.set({ breaks: true }) },
  }])

  assert.match(renderer.render('first\nsecond'), /first<br>\nsecond/)
  assert.match(renderer.styles(), /rebeccapurple/)
})
