import test from 'node:test'
import assert from 'node:assert/strict'

// index.mjs exports the Web Component too; provide the minimal browser base
// class needed to import it while testing the pure parsers in Node.
globalThis.HTMLElement = class {}

const {
  parseBlocks,
  parseMarkdownSections,
  matchMarkdownToPdf,
  normalize,
  MarkdownPreviewRenderer,
  createRichMarkdownPlugin,
  documentFormatFromName,
  orgToMarkdown,
  computePdfRenderScale,
  pageMarkersAfterSections,
  markdownExchangeText,
  projectJsonOntoMarkdown,
  projectMarkdownOntoJson,
  sourceOffsetForLine,
  formatEditorLineNumber,
  uncoveredSourceLines,
} = await import('../dist/index.mjs')
const { default: orglistGtdPlugin } = await import('../plugins/orglist-gtd-format.js')

test('editor line numbers can be hidden, absolute, or relative to the cursor', () => {
  assert.equal(formatEditorLineNumber('off', 4, 4), '')
  assert.equal(formatEditorLineNumber('absolute', 4, 10), '4')
  assert.equal(formatEditorLineNumber('relative', 10, 10), '10')
  assert.equal(formatEditorLineNumber('relative', 7, 10), '3')
  assert.equal(formatEditorLineNumber('relative', 14, 10), '4')
})

test('preview line numbers skip source lines already claimed by a nested block', () => {
  assert.deepEqual(uncoveredSourceLines(2, 5, []), [2, 3, 4])
  assert.deepEqual(uncoveredSourceLines(0, 4, [[1, 3]]), [0, 3])
  assert.deepEqual(uncoveredSourceLines(0, 4, [[0, 4]]), [])
  assert.deepEqual(uncoveredSourceLines(3, Number.NaN, []), [3])
})

test('source line numbers are 1-based and clamp to the document', () => {
  const text = 'alpha\r\nbeta\r\ngamma\r\n'
  assert.equal(sourceOffsetForLine(text, 1), 0)
  assert.equal(sourceOffsetForLine(text, 2), 6)
  assert.equal(sourceOffsetForLine(text, 3), 11)
  assert.equal(sourceOffsetForLine(text, 99), 17)
  assert.equal(sourceOffsetForLine(text, 0), 0)
  assert.equal(sourceOffsetForLine('', 4), 0)
})

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

test('ordered matching keeps repeated headings on successive PDF pages', () => {
  const markdown = '# 练习题\n\n第一部分具体内容\n\n# 练习题\n\n第二部分具体内容\n'
  const blocks = [
    { id: 'heading-1', type: 'text', text: '练习题', page_idx: 0, bbox: [0.1, 0.1, 0.8, 0.2] },
    { id: 'body-1', type: 'text', text: '第一部分具体内容', page_idx: 0, bbox: [0.1, 0.2, 0.8, 0.3] },
    { id: 'heading-2', type: 'text', text: '练习题', page_idx: 1, bbox: [0.1, 0.1, 0.8, 0.2] },
    { id: 'body-2', type: 'text', text: '第二部分具体内容', page_idx: 1, bbox: [0.1, 0.2, 0.8, 0.3] },
  ]
  const matched = matchMarkdownToPdf(markdown, blocks)

  assert.deepEqual(matched.map(section => section.blockId), ['heading-1', 'body-1', 'heading-2', 'body-2'])
  assert.deepEqual(matched.map(section => section.page), [1, 1, 2, 2])
})

test('normalize strips TeX wrappers and fullwidth punctuation so formula lines can anchor', () => {
  assert.equal(
    normalize('计算出三个校验位后，可知最终要发送的海明校验码为 $1010101$.'),
    normalize('计算出三个校验位后,可知最终要发送的海明校验码为 1010101.'),
  )
  const markdown = '最终要发送的海明校验码为 $1010101$.\n'
  const blocks = [
    { id: 'eq-1', type: 'text', text: '最终要发送的海明校验码为 1010101.', page_idx: 4, bbox: [0.1, 0.1, 0.8, 0.2] },
  ]
  const matched = matchMarkdownToPdf(markdown, blocks)
  assert.equal(matched[0].page, 5)
  assert.equal(matched[0].blockId, 'eq-1')
})

test('middle.json keeps discarded page numbers, headers and footnotes', () => {
  const blocks = parseBlocks(JSON.stringify({
    pdf_info: [{
      page_size: [1000, 1000],
      para_blocks: [{
        type: 'text',
        bbox: [100, 200, 800, 300],
        lines: [{ spans: [{ type: 'text', content: '正文' }] }],
      }],
      discarded_blocks: [
        {
          type: 'page_number',
          bbox: [450, 920, 550, 960],
          lines: [{ spans: [{ type: 'text', content: '12' }] }],
        },
        {
          type: 'header',
          bbox: [100, 40, 700, 80],
          lines: [{ spans: [{ type: 'text', content: '期刊名' }] }],
        },
        {
          type: 'page_footnote',
          bbox: [80, 860, 900, 900],
          lines: [{ spans: [{ type: 'text', content: '* 通讯作者' }] }],
        },
      ],
    }],
  }))

  assert.deepEqual(
    blocks.map(block => [block.type, block.text, block.bbox]),
    [
      ['text', '正文', [0.1, 0.2, 0.8, 0.3]],
      ['page_number', '12', [0.45, 0.92, 0.55, 0.96]],
      ['header', '期刊名', [0.1, 0.04, 0.7, 0.08]],
      ['page_footnote', '* 通讯作者', [0.08, 0.86, 0.9, 0.9]],
    ],
  )
})

test('content_list_v2 keeps page groups, page numbers and image paths', () => {
  const blocks = parseBlocks(JSON.stringify([
    [
      {
        type: 'title',
        content: { title_content: [{ type: 'text', content: '1 Introduction' }], level: 1 },
        bbox: [83, 121, 917, 156],
      },
      {
        type: 'page_number',
        content: { page_number_content: [{ type: 'text', content: '1' }] },
        bbox: [470, 930, 530, 960],
      },
    ],
    [
      {
        type: 'image',
        content: {
          image_source: { path: 'images/figure-1.jpg' },
          image_caption: [{ type: 'text', content: 'Fig. 1' }],
        },
        bbox: [100, 200, 800, 700],
      },
      {
        type: 'equation_interline',
        content: { math_content: 'E=mc^2', math_type: 'latex' },
        bbox: [200, 300, 700, 380],
      },
    ],
  ]))

  assert.equal(blocks.length, 4)
  assert.equal(blocks[0].text, '1 Introduction')
  assert.equal(blocks[0].page_idx, 0)
  assert.deepEqual(blocks[0].bbox, [0.083, 0.121, 0.917, 0.156])
  assert.equal(blocks[1].type, 'page_number')
  assert.equal(blocks[1].text, '1')
  assert.equal(blocks[2].page_idx, 1)
  assert.equal(blocks[2].imagePath, 'images/figure-1.jpg')
  assert.equal(blocks[2].text, 'Fig. 1')
  assert.equal(blocks[3].text, 'E=mc^2')
})

test('content_list keeps lists, code and page furniture without using them as body matches', () => {
  const blocks = parseBlocks(JSON.stringify([
    {
      type: 'list',
      list_items: ['H.1 Introduction', 'H.2 Summary'],
      page_idx: 0,
      bbox: [100, 150, 800, 300],
    },
    {
      type: 'code',
      code_caption: ['Algorithm 1'],
      code_body: 'function search()',
      page_idx: 0,
      bbox: [100, 320, 800, 640],
    },
    {
      type: 'page_number',
      text: '3',
      page_idx: 0,
      bbox: [470, 930, 530, 960],
    },
    {
      type: 'page_header',
      text: '期刊名',
      page_idx: 0,
      bbox: [100, 40, 700, 80],
    },
  ]))
  const matched = matchMarkdownToPdf('H.1 Introduction\n\nfunction search()\n\n期刊名\n', blocks)

  assert.match(blocks[0].text, /H\.1 Introduction/)
  assert.match(blocks[0].text, /H\.2 Summary/)
  assert.match(blocks[1].text, /Algorithm 1/)
  assert.match(blocks[1].text, /function search/)
  assert.equal(matched[0].blockId, blocks[0].id)
  assert.equal(matched[1].blockId, blocks[1].id)
  assert.equal(matched[2].blockId, undefined)
  assert.equal(matched.some(section => section.blockId === blocks[2].id), false)
  assert.equal(matched.some(section => section.blockId === blocks[3].id), false)
})

test('ordered matching ignores page furniture and keeps tables on table blocks', () => {
  const markdown = '公共页眉文字\n\n| 姓名 | 分数 |\n| --- | --- |\n| 小王 | 90 |\n'
  const blocks = [
    { id: 'header', type: 'header', text: '公共页眉文字', page_idx: 0, bbox: [0, 0, 1, 0.05] },
    { id: 'body', type: 'text', text: '公共页眉文字', page_idx: 0, bbox: [0.1, 0.1, 0.9, 0.2] },
    { id: 'table-as-text', type: 'text', text: '姓名 分数 小王 90', page_idx: 0, bbox: [0.1, 0.2, 0.9, 0.4] },
    { id: 'table', type: 'table', text: '姓名 分数 小王 90', page_idx: 0, bbox: [0.1, 0.4, 0.9, 0.8] },
  ]
  const matched = matchMarkdownToPdf(markdown, blocks)

  assert.equal(matched[0].blockId, 'body')
  assert.equal(matched[1].blockId, 'table')
})

test('a table caption and its following HTML table can share one layout block', () => {
  const markdown = '年度汇总表\n\n<table><tr><td>年度</td><td>人数</td></tr></table>\n\n下一节\n'
  const blocks = [
    { id: 'captioned-table', type: 'table', text: '年度汇总表', page_idx: 0, bbox: [0.1, 0.1, 0.9, 0.6] },
    { id: 'next', type: 'text', text: '下一节', page_idx: 0, bbox: [0.1, 0.7, 0.9, 0.8] },
  ]
  const matched = matchMarkdownToPdf(markdown, blocks)

  assert.equal(matched[0].blockId, 'captioned-table')
  assert.equal(matched[1].blockId, 'captioned-table')
  assert.equal(matched[2].blockId, 'next')
})

test('Markdown and MinerU JSON text edits copy onto each other', () => {
  const blocks = parseBlocks(JSON.stringify([
    { type: 'text', text: '封面标题', text_level: 1, page_idx: 0, bbox: [80, 80, 800, 160] },
    { type: 'text', text: '第一章 绪论', text_level: 1, page_idx: 1, bbox: [80, 80, 800, 160] },
  ]))
  const json = JSON.stringify([
    { type: 'text', text: '封面标题', text_level: 1, page_idx: 0, bbox: [80, 80, 800, 160] },
    { type: 'text', text: '第一章 绪论', text_level: 1, page_idx: 1, bbox: [80, 80, 800, 160] },
  ])
  const sections = [
    { raw: '# 封面标题', start: 0, end: 6, kind: 'text', blockId: blocks[0].id },
    { raw: '# 新的章节', start: 7, end: 13, kind: 'text', blockId: blocks[1].id },
  ]
  const synced = projectMarkdownOntoJson(json, sections, blocks)
  assert.ok(synced)
  assert.match(synced, /"text": "新的章节"/)
  assert.match(synced, /"text": "封面标题"/)

  const editedJson = synced.replace('封面标题', '封面已改')
  const markdown = projectJsonOntoMarkdown('# 封面标题\n# 新的章节\n', editedJson, [
    { raw: '# 封面标题', start: 0, end: 6, kind: 'text', blockId: blocks[0].id },
    { raw: '# 新的章节', start: 7, end: 13, kind: 'text', blockId: blocks[1].id },
  ], blocks)
  assert.equal(markdown, '# 封面已改\n# 新的章节\n')
  assert.equal(markdownExchangeText('![](images/a.jpg)'), undefined)
})

test('content list blocks remember their JSON path', () => {
  const blocks = parseBlocks(JSON.stringify([
    { type: 'text', text: '甲', page_idx: 0, bbox: [0, 0, 10, 10] },
    { type: 'text', text: '乙', page_idx: 1, bbox: [0, 0, 10, 10] },
  ]))
  assert.deepEqual(blocks.map(block => block.jsonPath), ['0', '1'])
})

test('rewritten Markdown stays on the page locked by the unchanged lines around it', () => {
  const markdown = [
    '第一章 绪论的开头',
    '系统分析师需要掌握需求工程',
    '第一章保持的结尾',
    '第九章 复用的句子系统分析师需要掌握需求工程实践',
  ].join('\n')
  const blocks = [
    { id: 'a', type: 'text', text: '第一章 绪论的开头', page_idx: 0, bbox: [0, 0, 1, 1] },
    { id: 'b', type: 'text', text: '原始的第一章正文完全不同', page_idx: 0, bbox: [0, 0, 1, 1] },
    { id: 'c', type: 'text', text: '第一章保持的结尾', page_idx: 0, bbox: [0, 0, 1, 1] },
    { id: 'd', type: 'text', text: '第九章 复用的句子系统分析师需要掌握需求工程实践', page_idx: 8, bbox: [0, 0, 1, 1] },
  ]
  const matched = matchMarkdownToPdf(markdown, blocks)

  assert.deepEqual(matched.map(section => section.page), [1, 1, 1, 9])
  assert.equal(matched[0].blockId, 'a')
  assert.equal(matched[2].blockId, 'c')
  assert.equal(matched[3].blockId, 'd')
  assert.notEqual(matched[1].blockId, 'd')
})

test('an inserted Markdown line does not move the next unchanged line off its page', () => {
  const markdown = '第一页原文\n这是后加的一段\n第二页原文\n'
  const blocks = [
    { id: 'p1', type: 'text', text: '第一页原文', page_idx: 0, bbox: [0, 0, 1, 1] },
    { id: 'p2', type: 'text', text: '第二页原文', page_idx: 1, bbox: [0, 0, 1, 1] },
  ]
  const matched = matchMarkdownToPdf(markdown, blocks)

  assert.deepEqual(matched.map(section => section.page), [1, 1, 2])
  assert.equal(matched[2].blockId, 'p2')
})

test('Markdown page markers close each PDF page, including the last one', () => {
  assert.deepEqual(pageMarkersAfterSections([1, 1, 2, 2, 3]), [
    { afterIndex: 1, page: 1 },
    { afterIndex: 3, page: 2 },
    { afterIndex: 4, page: 3 },
  ])
  assert.deepEqual(pageMarkersAfterSections([1, 1]), [{ afterIndex: 1, page: 1 }])
  assert.deepEqual(pageMarkersAfterSections([]), [])
  assert.deepEqual(pageMarkersAfterSections([0, 0]), [])
})

test('PDF render modes cap fast pixels and scale quality with display density', () => {
  assert.equal(computePdfRenderScale('fast', 1600, 600, 2), 1.15)
  assert.equal(computePdfRenderScale('fast', 300, 600, 1), 0.75)
  assert.equal(computePdfRenderScale('quality', 600, 600, 1), 1.75)
  assert.equal(computePdfRenderScale('quality', 1200, 600, 2), 3)
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

test('rich Markdown plugin renders HTML breaks, tables, tasks, footnotes and TeX', () => {
  const renderer = new MarkdownPreviewRenderer([createRichMarkdownPlugin()])
  const html = renderer.render(`first<br>second

| A | B |
| - | - |
| 1 | 2 |

- [x] done

$E=mc^2$

$$
a^2+b^2=c^2
$$

note[^1]

[^1]: footnote`)

  assert.match(html, /first<br>second/)
  assert.match(html, /<table/)
  assert.match(html, /task-list-item/)
  assert.match(html, /<math/)
  assert.match(html, /a\^2\+b\^2=c\^2/)
  assert.match(html, /footnotes/)
})

test('Org conversion preserves source line mapping and renders common Org constructs', () => {
  const org = `#+TITLE: Org 文档

* 一级标题
正文包含 *粗体*、/斜体/ 和 [[https://orgmode.org][链接]]。

[[file:images/figure.png]]

| 名称 | 状态 |
|------+------|
| Org  | 正常 |

CLOSED: [2024-01-20 Sat 13:23]
:PROPERTIES:
:ID:       GTD-flow-2024-01-20-13-13-42
:END:

\\| , g ~     \\| 设置 gtd       \\|                                                         \\|
\\| , g o     \\|                \\| org-gtd-organize                                        \\|
\\| , p       \\| 设置优先级      \\| org-priority                                            \\|

#+BEGIN_SRC javascript
console.log('ok')
#+END_SRC

: fixed width example

<%%(diary-chinese-anniversary 8 15)>
`
  const markdown = orgToMarkdown(org)
  const renderer = new MarkdownPreviewRenderer([createRichMarkdownPlugin(), orglistGtdPlugin])
  const sections = parseMarkdownSections(org)
  const image = sections.find(section => section.kind === 'image')

  assert.equal(documentFormatFromName('notes.org'), 'org')
  assert.equal(org.split('\n').length, markdown.split('\n').length)
  assert.match(markdown, /^# Org 文档/m)
  assert.match(markdown, /^# 一级标题/m)
  assert.match(markdown, /\*\*粗体\*\*/)
  assert.match(markdown, /\*斜体\*/)
  assert.equal(image?.imagePath, 'images/figure.png')
  const html = renderer.render(markdown)
  assert.match(html, /<table/)
  assert.match(html, /class="org-planning"/)
  assert.match(html, /<strong>CLOSED:<\/strong>/)
  assert.match(html, /class="org-properties"/)
  assert.match(html, /GTD-flow-2024-01-20-13-13-42/)
  assert.match(html, /org-gtd-organize/)
  assert.match(html, /fixed width example/)
  assert.match(html, /class="gtd-lunar-anniversary"/)
  assert.match(html, /language-javascript/)
  assert.match(html, /<img[^>]+figure\.png/)
})

test('Org HTML lines do not swallow the following heading, paragraph, or list', () => {
  const org = [
    '* 任务',
    'SCHEDULED: <2024-01-20 Sat>',
    '正文仍然是段落',
    ':PROPERTIES:',
    ':ID: abc',
    ':END:',
    '* 紧跟标题',
    '',
    '| 名称 | 状态 |',
    '| Org | 正常 |',
    '** 表后标题',
    '',
    '1) 有序列表',
    '_下划线_',
    '* 下划线后的标题',
    '',
    ':LOGBOOK:',
    '- State "DONE" from "NEXT" [2024-01-20 Sat 13:23]',
    ':END:',
    '抽屉后的正文',
  ].join('\n')
  const markdown = orgToMarkdown(org)
  assert.equal(org.split('\n').length, markdown.split('\n').length)
  const html = new MarkdownPreviewRenderer([createRichMarkdownPlugin()]).render(markdown)
  assert.match(html, /<h1[^>]*data-md-start-line="0"[^>]*>[\s\S]*?任务/)
  assert.match(html, /<p[^>]*data-md-start-line="2"[^>]*>正文仍然是段落/)
  assert.match(html, /<h1[^>]*data-md-start-line="6"[^>]*>[\s\S]*?紧跟标题/)
  assert.match(html, /<h2[^>]*data-md-start-line="10"[^>]*>[\s\S]*?表后标题/)
  assert.match(html, /<h1[^>]*data-md-start-line="14"[^>]*>[\s\S]*?下划线后的标题/)
  assert.match(html, /<p[^>]*data-md-start-line="19"[^>]*>抽屉后的正文/)
  assert.match(html, /<ol[\s>]/)
  assert.match(html, /<u>下划线<\/u>/)
  assert.match(html, /class="org-planning"[^>]*data-md-start-line="1"/)
  assert.match(html, /class="org-drawer"/)
  assert.doesNotMatch(html, /# 紧跟标题/)
})
