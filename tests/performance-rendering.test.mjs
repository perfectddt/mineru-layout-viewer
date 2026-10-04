import test from 'node:test'
import assert from 'node:assert/strict'
globalThis.HTMLElement = class {}
const { MarkdownPreviewRenderer, createRichMarkdownPlugin, matchMarkdownToPdf, normalize, lcsSimilarity } = await import('../dist/index.mjs')

test('batched rendering preserves nested structures, late references, footnotes, math and absolute source maps', () => {
  const renderer = new MarkdownPreviewRenderer([createRichMarkdownPlugin()])
  const markdown = '# Start\n\n- first\n  - nested **item**\n- second\n\n[late][ref] and note[^note]\n\n```js\nconst x = 2\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n$$x^2$$\n\n<table>\n<tr><td>HTML</td></tr>\n</table>\n\n# End\n\n[ref]: https://example.com\n[^note]: Footnote content\n'
  const batches = [...renderer.renderBatches(markdown, 3)]
  assert.ok(batches.length > 4)
  assert.equal(batches.join(''), renderer.render(markdown))
  assert.ok(batches.some(html => html.includes('<ul') && html.includes('nested') && html.includes('second') && html.includes('</ul>')))
  assert.ok(batches.some(html => html.includes('<table>') && html.includes('HTML') && html.includes('</table>')))
  assert.match(batches.join(''), /href="https:\/\/example.com"/)
  assert.ok(batches.join('').includes(`data-md-start-line="${markdown.split('\n').indexOf('# End')}"`))
})

test('score pruning agrees with exhaustive candidates across short, long and repeated text', () => {
  const sources = ['abcd', 'abcdefghijklmno', '数据库系统分析与设计'.repeat(8), 'the quick brown fox '.repeat(10)]
  for (const source of sources) {
    const norm = normalize(source)
    const texts = ['unrelated', source.slice(0, 4) + ' variant', source + ' extra', source.slice(1), ...Array.from({ length: 55 }, (_, i) => `${i} ${source.slice(i % source.length)} replacement`)]
    const blocks = texts.map((text, i) => ({ id: `b${i}`, type: 'text', text, page_idx: i, bbox: [0, 0, 1, 1] }))
    const exhaustive = blocks.map((block, index) => {
      const candidate = normalize(block.text)
      const grams = new Set(Array.from({ length: candidate.length - 1 }, (_, i) => candidate.slice(i, i + 2)))
      const hits = Array.from({ length: norm.length - 1 }, (_, i) => grams.has(norm.slice(i, i + 2)) ? 1 : 0).reduce((a, b) => a + b, 0)
      const score = Math.max(lcsSimilarity(norm, candidate) * (candidate.length < norm.length ? Math.sqrt(candidate.length / norm.length) : 1), hits / (norm.length - 1))
      return { block, score, adjusted: score - Math.min(index, 120) * 0.0007 }
    }).sort((a, b) => b.adjusted - a.adjusted)[0]
    const [actual] = matchMarkdownToPdf(source, blocks)
    assert.equal(actual.blockId, exhaustive.block.id)
    assert.equal(actual.matchScore, exhaustive.score)
  }
})

test('shared image index retains exact-path priority and ambiguous basename rejection across anchor gaps', () => {
  const blocks = [
    { id: 'a', text: 'First anchor sentence', type: 'text', page_idx: 0, bbox: [0, 0, 1, 1] },
    { id: 'image-a', imagePath: 'one/pic.png', text: '', type: 'image', page_idx: 0, bbox: [0, 0, 1, 1] },
    { id: 'b', text: 'Second anchor sentence', type: 'text', page_idx: 1, bbox: [0, 0, 1, 1] },
    { id: 'image-b', imagePath: 'two/pic.png', text: '', type: 'image', page_idx: 1, bbox: [0, 0, 1, 1] },
  ]
  const result = matchMarkdownToPdf('First anchor sentence\n\n![](one/pic.png)\n\nSecond anchor sentence\n\n![](pic.png)', blocks)
  assert.deepEqual(result.map(s => s.blockId), ['a', 'image-a', 'b', undefined])
})
