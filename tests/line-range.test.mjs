import test from 'node:test'
import assert from 'node:assert/strict'

// index.mjs exports the Web Component too; provide the minimal browser base
// class needed to import it while testing the pure helpers in Node.
globalThis.HTMLElement = class {}

const { formatPreviewBlockLine, scanUnmappedSourceRanges } = await import('../dist/index.mjs')

test('absolute mode only ever shows the first line of a block', () => {
  assert.equal(formatPreviewBlockLine('absolute', 7, 7, 1), '7')
  assert.equal(formatPreviewBlockLine('absolute', 4, 9, 1), '4')
  assert.equal(formatPreviewBlockLine('absolute', 4, 9, 6), '4')
  // A broken end falls back to the start line.
  assert.equal(formatPreviewBlockLine('absolute', 5, 3, 1), '5')
})

test('relative mode keeps the cursor line absolute inside the range', () => {
  assert.equal(formatPreviewBlockLine('relative', 4, 9, 6), '6')
  // Distance to the nearest edge outside the range.
  assert.equal(formatPreviewBlockLine('relative', 4, 9, 1), '3')
  assert.equal(formatPreviewBlockLine('relative', 4, 9, 12), '3')
  assert.equal(formatPreviewBlockLine('relative', 7, 7, 2), '5')
})

test('off mode stays empty', () => {
  assert.equal(formatPreviewBlockLine('off', 4, 9, 6), '')
})

test('pipe lines inside fenced code never create phantom table ranges', () => {
  const source = [
    '# t', // 0
    '', // 1
    '```markdown', // 2
    '| a | b |', // 3  inside the fence: not a table
    '| 1 | 2 |', // 4
    '```', // 5
    '', // 6
    '<table>', // 7
    '<tr><td>x</td></tr>', // 8
    '</table>', // 9
  ].join('\n')
  const { tables } = scanUnmappedSourceRanges(source)
  assert.deepEqual(tables, [[7, 10]])
})

test('an unclosed html table runs to the end of the document', () => {
  const { tables } = scanUnmappedSourceRanges('<table>\n<tr><td>x</td></tr>')
  assert.deepEqual(tables, [[0, 2]])
})

test('$$ lines inside fenced code never create phantom math ranges', () => {
  const source = [
    '```', // 0
    '$$', // 1  inside the fence: not math
    'x', // 2
    '$$', // 3
    '```', // 4
    '$$', // 5
    'E=mc^2', // 6
    '$$', // 7
  ].join('\n')
  const { displayMath } = scanUnmappedSourceRanges(source)
  assert.deepEqual(displayMath, [[5, 8]])
})

test('tildes fences are honoured and mismatched markers stay open', () => {
  const source = '~~~\n<table>\n</table>\n~~~\n<table>\n</table>'
  const { tables } = scanUnmappedSourceRanges(source)
  assert.deepEqual(tables, [[4, 6]])
})
