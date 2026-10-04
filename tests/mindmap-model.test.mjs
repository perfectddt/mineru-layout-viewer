import test from 'node:test'
import assert from 'node:assert/strict'

// index.mjs exports the Web Component too; provide the minimal browser base
// class needed to import it while testing the pure helpers in Node.
globalThis.HTMLElement = class {}

const {
  deleteMindmapNode,
  detectMindmapIndentUnit,
  estimateMindmapNodeSize,
  insertMindmapChild,
  insertMindmapSibling,
  layoutMindmap,
  mindmapNodeAtLine,
  moveMindmapNode,
  parseMindmapTree,
  renameMindmapNode,
  shiftMindmapSubtree,
} = await import('../dist/index.mjs')

const markdown = lines => lines.join('\n')
const labels = node => node.children.map(child => child.label)

test('headings own their lists and nested bullets nest underneath', () => {
  const source = markdown([
    '# 标题',
    '## 一',
    '- a',
    '  - a1',
    '- b',
    '## 二',
    '### 二一',
  ])
  const tree = parseMindmapTree(source, { format: 'markdown' })
  assert.equal(tree.root.label, '标题')
  assert.equal(tree.syntheticRoot, false)
  assert.deepEqual(labels(tree.root), ['一', '二'])
  const first = tree.root.children[0]
  assert.deepEqual(labels(first), ['a', 'b'])
  assert.deepEqual(labels(first.children[0]), ['a1'])
  assert.deepEqual(labels(tree.root.children[1]), ['二一'])
})

test('a second top-level heading forces a synthetic root from the title', () => {
  const tree = parseMindmapTree('# 甲\n# 乙', { format: 'markdown' })
  assert.equal(tree.syntheticRoot, true)
  assert.equal(tree.root.label, '甲')
  assert.deepEqual(labels(tree.root), ['甲', '乙'])
  assert.equal(tree.root.source, null)
  assert.equal(tree.root.children[0].source.line, 0)
})

test('fenced code never leaks headings or bullets into the tree', () => {
  const source = markdown([
    '# A',
    '```markdown',
    '# not a heading',
    '- not a list',
    '```',
    '~~~',
    '* not a list either',
    '~~~',
    '## B',
  ])
  const tree = parseMindmapTree(source, { format: 'markdown' })
  assert.equal(tree.root.label, 'A')
  assert.deepEqual(labels(tree.root), ['B'])
})

test('org blocks are fenced the same way', () => {
  const source = markdown([
    '* A',
    '#+BEGIN_SRC text',
    '* not a heading',
    '#+END_SRC',
    '** B',
  ])
  const tree = parseMindmapTree(source, { format: 'org' })
  assert.deepEqual(labels(tree.root), ['B'])
})

test('thematic breaks are not list items', () => {
  const tree = parseMindmapTree('# A\n---\n- x', { format: 'markdown' })
  assert.deepEqual(labels(tree.root), ['x'])
  const dashed = parseMindmapTree('# A\n- - -\n- x', { format: 'markdown' })
  assert.deepEqual(labels(dashed.root), ['x'])
})

test('org headings use stars while org bullets use dashes', () => {
  const source = markdown([
    '* 一',
    '- a',
    '  - a1',
    '** 二',
  ])
  const tree = parseMindmapTree(source, { format: 'org' })
  assert.equal(tree.root.label, '一')
  assert.deepEqual(labels(tree.root), ['a', '二'])
  assert.deepEqual(labels(tree.root.children[0]), ['a1'])
})

test('org #+TITLE names the synthetic root', () => {
  const tree = parseMindmapTree('#+TITLE: 会议纪要\n* 甲\n* 乙', { format: 'org' })
  assert.equal(tree.syntheticRoot, true)
  assert.equal(tree.root.label, '会议纪要')
  assert.deepEqual(labels(tree.root), ['甲', '乙'])
})

test('indentation unit is detected from real list indentation', () => {
  assert.equal(detectMindmapIndentUnit('- a\n    - b', 'markdown'), 4)
  assert.equal(detectMindmapIndentUnit('- a\n  - b', 'markdown'), 2)
  assert.equal(detectMindmapIndentUnit('- a\n  - b\n    - c', 'markdown'), 2)
  // Nothing indented: fall back to a two-space unit.
  assert.equal(detectMindmapIndentUnit('- a\n- b', 'markdown'), 2)
})

test('node size grows with content and caps the line count', () => {
  const short = estimateMindmapNodeSize('a')
  const wide = estimateMindmapNodeSize('这是一个比较长的中文标题用来测试换行行为是否稳定')
  assert.ok(short.width <= wide.width)
  assert.ok(short.height <= wide.height)
  const long = estimateMindmapNodeSize('x'.repeat(400))
  assert.equal(long.height, 3 * 19 + 14)
})

test('layout is deterministic and pushes each depth further right', () => {
  const source = markdown(['# A', '## B', '- x', '## C', '### D'])
  const tree = parseMindmapTree(source, { format: 'markdown' })
  const first = layoutMindmap(tree)
  const second = layoutMindmap(tree)
  assert.deepEqual(first, second)
  const byLabel = new Map(first.boxes.map(box => [box.node.label, box]))
  assert.ok(byLabel.get('A').x < byLabel.get('B').x)
  assert.ok(byLabel.get('B').x < byLabel.get('D').x)
  assert.equal(first.links.length, first.boxes.length - 1)
})

test('siblings never overlap vertically', () => {
  const tree = parseMindmapTree('# A\n## B\n## C\n## D', { format: 'markdown' })
  const { boxes } = layoutMindmap(tree)
  const siblings = boxes.filter(box => box.node.parent === tree.root).sort((a, b) => a.y - b.y)
  for (let index = 1; index < siblings.length; index++) {
    assert.ok(siblings[index].y >= siblings[index - 1].y + siblings[index - 1].height)
  }
})

test('collapsing hides descendants from the layout', () => {
  const tree = parseMindmapTree('# A\n## B\n### C', { format: 'markdown' })
  const expanded = layoutMindmap(tree)
  const collapsed = layoutMindmap(tree, { collapsed: new Set([tree.root.children[0].id]) })
  assert.equal(expanded.boxes.length, 3)
  assert.equal(collapsed.boxes.length, 2)
  assert.equal(collapsed.boxes[1].collapsed, true)
})

test('a source line maps back to the innermost node', () => {
  const tree = parseMindmapTree('# A\n## B\n- x', { format: 'markdown' })
  assert.equal(mindmapNodeAtLine(tree, 0).label, 'A')
  assert.equal(mindmapNodeAtLine(tree, 1).label, 'B')
  assert.equal(mindmapNodeAtLine(tree, 2).label, 'x')
  assert.equal(mindmapNodeAtLine(tree, 9), null)
})

test('renaming rewrites only the label', () => {
  const source = '# A\n## B\n- x'
  const tree = parseMindmapTree(source, { format: 'markdown' })
  const renamed = renameMindmapNode(source, tree, tree.root.children[0], '新的标题')
  assert.equal(renamed, '# A\n## 新的标题\n- x')
  const bullet = renameMindmapNode(source, tree, tree.root.children[0].children[0], 'y')
  assert.equal(bullet, '# A\n## B\n- y')
  // Multi-line input collapses instead of corrupting the line map.
  assert.equal(renameMindmapNode(source, tree, tree.root.children[0], 'a\nb'), '# A\n## a b\n- x')
  assert.equal(renameMindmapNode(source, tree, tree.root.children[0], '   '), null)
})

test('renaming refuses stale offsets', () => {
  const source = '# A\n## B'
  const tree = parseMindmapTree(source, { format: 'markdown' })
  assert.equal(renameMindmapNode('# A\n## 换过的标题', tree, tree.root.children[0], 'x'), null)
})

test('adding a sibling lands after the whole subtree', () => {
  const source = markdown(['# A', '## B', '- x', '## C'])
  const tree = parseMindmapTree(source, { format: 'markdown' })
  const result = insertMindmapSibling(source, tree, tree.root.children[0], '新节')
  assert.equal(result.text, markdown(['# A', '## B', '- x', '## 新节', '## C']))
  assert.equal(result.line, 3)
  assert.equal(result.edit, true)
})

test('adding a child deepens a heading and indents a bullet', () => {
  const source = markdown(['# A', '## B', '- x'])
  const tree = parseMindmapTree(source, { format: 'markdown' })
  const headingChild = insertMindmapChild(source, tree, tree.root.children[0], '子节')
  assert.equal(headingChild.text, markdown(['# A', '## B', '- x', '### 子节']))
  const bullet = tree.root.children[0].children[0]
  const bulletChild = insertMindmapChild(source, tree, bullet, '子项')
  assert.equal(bulletChild.text, markdown(['# A', '## B', '- x', '  - 子项']))
})

test('the sixth heading level nests a bullet instead of a seventh hash', () => {
  const source = '###### A'
  const tree = parseMindmapTree(source, { format: 'markdown' })
  assert.equal(insertMindmapChild(source, tree, tree.root, '深').text, '###### A\n- 深')
})

test('adding a child under an ordered list keeps counting', () => {
  const source = '1. 甲\n2. 乙'
  const tree = parseMindmapTree(source, { format: 'markdown' })
  const result = insertMindmapChild(source, tree, tree.root.children[0], '丙')
  assert.equal(result.text, '1. 甲\n  1. 丙\n2. 乙')
})

test('a synthetic root grows top-level headings', () => {
  const source = '# 甲\n# 乙'
  const tree = parseMindmapTree(source, { format: 'markdown' })
  assert.equal(insertMindmapChild(source, tree, tree.root, '丙').text, '# 甲\n# 乙\n# 丙')
  // A synthetic root has no line, so it cannot take a sibling.
  assert.equal(insertMindmapSibling(source, tree, tree.root, '丁'), null)
})

test('deleting removes the node and every descendant', () => {
  const source = markdown(['# A', '## B', '- x', '- y', '## C'])
  const tree = parseMindmapTree(source, { format: 'markdown' })
  assert.equal(deleteMindmapNode(source, tree, tree.root.children[0]).text, markdown(['# A', '## C']))
})

test('indenting and outdenting shift the whole subtree', () => {
  const source = markdown(['# A', '## B', '- x'])
  const tree = parseMindmapTree(source, { format: 'markdown' })
  const indented = shiftMindmapSubtree(source, tree, tree.root.children[0], 1)
  assert.equal(indented, markdown(['# A', '### B', '  - x']))
  const back = shiftMindmapSubtree(indented, parseMindmapTree(indented, { format: 'markdown' }), parseMindmapTree(indented, { format: 'markdown' }).root.children[0], -1)
  assert.equal(back, source)
})

test('impossible outdents stay a no-op', () => {
  const source = '# A'
  const tree = parseMindmapTree(source, { format: 'markdown' })
  assert.equal(shiftMindmapSubtree(source, tree, tree.root, -1), null)
  const deeper = '# A\n## B\n### C'
  const deepTree = parseMindmapTree(deeper, { format: 'markdown' })
  assert.equal(shiftMindmapSubtree(deeper, deepTree, deepTree.root.children[0], 5), null)
})

test('dragging a section under another section keeps its shape', () => {
  const source = markdown(['# A', '## B', '- x', '## C'])
  const tree = parseMindmapTree(source, { format: 'markdown' })
  const moved = moveMindmapNode(source, tree, tree.root.children[1], tree.root.children[0], 'child')
  assert.equal(moved, markdown(['# A', '## B', '- x', '### C']))
})

test('dragging a heading into a list converts the block to list items', () => {
  const source = markdown(['# A', '- x', '## B'])
  const tree = parseMindmapTree(source, { format: 'markdown' })
  assert.deepEqual(labels(tree.root), ['x', 'B'])
  const moved = moveMindmapNode(source, tree, tree.root.children[1], tree.root.children[0], 'child')
  assert.equal(moved, markdown(['# A', '- x', '  - B']))
})

test('a node cannot be dropped into its own subtree', () => {
  const source = markdown(['# A', '## B', '### C'])
  const tree = parseMindmapTree(source, { format: 'markdown' })
  const b = tree.root.children[0]
  assert.equal(moveMindmapNode(source, tree, b, b.children[0], 'child'), null)
  assert.equal(moveMindmapNode(source, tree, b, b, 'before'), null)
})

test('CRLF documents keep their line endings when edited', () => {
  const source = '# A\r\n## B'
  const tree = parseMindmapTree(source, { format: 'markdown' })
  assert.equal(insertMindmapSibling(source, tree, tree.root.children[0], 'C').text, '# A\r\n## B\r\n## C')
  assert.equal(renameMindmapNode(source, tree, tree.root.children[0], 'BB'), '# A\r\n## BB')
})
