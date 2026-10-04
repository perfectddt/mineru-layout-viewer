import test from 'node:test'
import assert from 'node:assert/strict'

globalThis.HTMLElement = class {}

const { ViewerWindowChannel } = await import('../dist/index.mjs')

function nextMessage(channel, predicate, timeout = 500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error('no message arrived'))
    }, timeout)
    const unsubscribe = channel.subscribe(message => {
      if (!predicate(message)) return
      clearTimeout(timer)
      unsubscribe()
      resolve(message)
    })
  })
}

test('a window never receives its own message', async () => {
  const solo = new ViewerWindowChannel('mineru-test-self')
  let seen = 0
  solo.subscribe(() => { seen++ })
  solo.post({ type: 'hello', windowId: solo.windowId })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(seen, 0)
  solo.close()
})

test('a peer receives the document with its revision', async () => {
  const first = new ViewerWindowChannel('mineru-test-relay')
  const second = new ViewerWindowChannel('mineru-test-relay')
  const pending = nextMessage(second, message => message.type === 'document')
  first.post({
    type: 'document',
    windowId: first.windowId,
    revision: 42,
    document: { text: '# A', format: 'markdown', name: 'a.md', mode: 'mindmap' },
  })
  const received = await pending
  assert.equal(received.revision, 42)
  assert.equal(received.document.text, '# A')
  assert.equal(received.document.mode, 'mindmap')
  first.close()
  second.close()
})

test('window ids are unique per channel instance', () => {
  const first = new ViewerWindowChannel('mineru-test-ids')
  const second = new ViewerWindowChannel('mineru-test-ids')
  assert.notEqual(first.windowId, second.windowId)
  first.close()
  second.close()
})

test('an unsupported channel degrades instead of throwing', () => {
  const original = globalThis.BroadcastChannel
  // Simulate an engine or privacy mode where the constructor is unavailable.
  delete globalThis.BroadcastChannel
  try {
    const channel = new ViewerWindowChannel('mineru-test-missing')
    assert.equal(channel.supported, false)
    channel.post({ type: 'hello', windowId: channel.windowId })
    channel.close()
  } finally {
    globalThis.BroadcastChannel = original
  }
})
