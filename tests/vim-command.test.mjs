import test from 'node:test'
import assert from 'node:assert/strict'

// index.mjs exports the Web Component too; provide the minimal browser base
// class needed to import it while testing the pure parser in Node.
globalThis.HTMLElement = class {}

const { parseViewerVimCommand, initialViewerVimNormalState, pushViewerVimNormalKey } = await import('../dist/index.mjs')

test('a preview `:` line number jumps to that line', () => {
  assert.deepEqual(parseViewerVimCommand('42'), { kind: 'goto', line: 42 })
  assert.deepEqual(parseViewerVimCommand('  7  '), { kind: 'goto', line: 7 })
  // Vim lands `:0` on the first line rather than reporting an error.
  assert.deepEqual(parseViewerVimCommand('0'), { kind: 'goto', line: 1 })
})

test('a preview `:` command reaches the last line with $', () => {
  assert.deepEqual(parseViewerVimCommand('$'), { kind: 'goto', line: 'last' })
})

test('a preview `:` command writes the document', () => {
  for (const command of ['w', 'write', 'wq']) {
    assert.deepEqual(parseViewerVimCommand(command), { kind: 'write' }, command)
  }
})

test('an empty command line just closes, unknown commands are reported', () => {
  assert.deepEqual(parseViewerVimCommand(''), { kind: 'none' })
  assert.deepEqual(parseViewerVimCommand('   '), { kind: 'none' })
  // Ranges and unit suffixes are not line numbers this view can honour.
  assert.deepEqual(parseViewerVimCommand('12,20'), { kind: 'unknown', command: '12,20' })
  assert.deepEqual(parseViewerVimCommand('42p'), { kind: 'unknown', command: '42p' })
})

test('`:noh` clears the search instead of reporting E492', () => {
  for (const command of ['noh', 'nohls', 'nohlsearch']) {
    assert.deepEqual(parseViewerVimCommand(command), { kind: 'noh' }, command)
  }
})

test('gg jumps to the first line, G to the last', () => {
  let step = pushViewerVimNormalKey(initialViewerVimNormalState(), 'g')
  assert.deepEqual(step.action, { kind: 'none' })
  step = pushViewerVimNormalKey(step.state, 'g')
  assert.deepEqual(step.action, { kind: 'goto', line: 'first' })
  step = pushViewerVimNormalKey(initialViewerVimNormalState(), 'G')
  assert.deepEqual(step.action, { kind: 'goto', line: 'last' })
})

test('a count retargets gg and G like Vim', () => {
  let step = pushViewerVimNormalKey(initialViewerVimNormalState(), '4')
  assert.deepEqual(step.action, { kind: 'none' })
  step = pushViewerVimNormalKey(step.state, '2')
  assert.deepEqual(step.action, { kind: 'none' })
  step = pushViewerVimNormalKey(step.state, 'G')
  assert.deepEqual(step.action, { kind: 'goto', line: 42 })

  step = pushViewerVimNormalKey(initialViewerVimNormalState(), '3')
  step = pushViewerVimNormalKey(step.state, 'g')
  step = pushViewerVimNormalKey(step.state, 'g')
  assert.deepEqual(step.action, { kind: 'goto', line: 3 })
})

test('n and N repeat the search, Escape resets pending state', () => {
  let step = pushViewerVimNormalKey(initialViewerVimNormalState(), 'n')
  assert.deepEqual(step.action, { kind: 'search-repeat', reverse: false })
  step = pushViewerVimNormalKey(initialViewerVimNormalState(), 'N')
  assert.deepEqual(step.action, { kind: 'search-repeat', reverse: true })
  step = pushViewerVimNormalKey(initialViewerVimNormalState(), '5')
  step = pushViewerVimNormalKey(step.state, 'Escape')
  assert.deepEqual(step.action, { kind: 'reset' })
  assert.deepEqual(step.state, { count: '', pendingG: false })
})

test('unrelated keys reset a pending sequence and stay untouched', () => {
  let step = pushViewerVimNormalKey(initialViewerVimNormalState(), 'g')
  step = pushViewerVimNormalKey(step.state, 'x')
  assert.deepEqual(step.action, { kind: 'ignored' })
  assert.deepEqual(step.state, { count: '', pendingG: false })
  // Bare 0 is a column motion in Vim, not a count start: left alone.
  step = pushViewerVimNormalKey(initialViewerVimNormalState(), '0')
  assert.deepEqual(step.action, { kind: 'ignored' })
  // A digit after a pending g is a broken sequence: reset, do not consume.
  step = pushViewerVimNormalKey(initialViewerVimNormalState(), 'g')
  step = pushViewerVimNormalKey(step.state, '4')
  assert.deepEqual(step.action, { kind: 'ignored' })
})
