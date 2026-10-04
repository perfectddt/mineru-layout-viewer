import test from 'node:test'
import assert from 'node:assert/strict'
import JSZip from 'jszip'

globalThis.HTMLElement = class {}
const { MineruLayoutViewer } = await import('../dist/index.mjs')
const prototype = MineruLayoutViewer.prototype

function receiver(paths = ['images/original.png']) {
  const zip = new JSZip()
  for (const path of paths) zip.file(path, new Uint8Array())
  return {
    zip,
    deferredAssets: new Map(paths.map(path => [path, { url: `http://local/${path}` }])),
    hydrateAsset: prototype.hydrateAsset,
  }
}

// JSZip in Node does not consume browser Blobs, so the mocked response supplies
// the same binary content in the Uint8Array representation JSZip supports here.
function response(bytes) {
  return { ok: true, blob: async () => Uint8Array.from(bytes) }
}

test('concurrent image access fetches once and retains original bytes', async t => {
  const viewer = receiver()
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => {
    requests++
    return response([0, 17, 255])
  })
  await Promise.all([viewer.hydrateAsset('images/original.png'), viewer.hydrateAsset('images/original.png')])
  await viewer.hydrateAsset('images/original.png')
  assert.equal(requests, 1)
  assert.equal(viewer.deferredAssets.size, 0)
  assert.deepEqual(await viewer.zip.file('images/original.png').async('uint8array'), Uint8Array.of(0, 17, 255))
})

test('failed image fetch remains deferred and can be retried', async t => {
  const viewer = receiver()
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => ++requests === 1
    ? { ok: false, status: 503 }
    : response([42]))
  await assert.rejects(viewer.hydrateAsset('images/original.png'), /503/)
  assert.equal(viewer.deferredAssets.size, 1)
  await viewer.hydrateAsset('images/original.png')
  assert.equal(requests, 2)
  assert.deepEqual(await viewer.zip.file('images/original.png').async('uint8array'), Uint8Array.of(42))
})

test('source line offsets are reused and invalidate after source edits', () => {
  const viewer = { sourceLineCache: null }
  const source = 'first\r\nsecond\nthird'
  assert.deepEqual(prototype.sourceRangeForLinesIn.call(viewer, source, 1, 2), [7, 14])
  const cache = viewer.sourceLineCache
  for (let index = 0; index < 100; index++) {
    assert.deepEqual(prototype.sourceRangeForLinesIn.call(viewer, source, 2, 99), [14, source.length])
  }
  assert.equal(viewer.sourceLineCache, cache)
  assert.deepEqual(prototype.sourceRangeForLinesIn.call(viewer, 'changed\nnext', 1, 2), [8, 12])
  assert.notEqual(viewer.sourceLineCache, cache)
})

test('attaching a PDF retains the current document and assets', async t => {
  const viewer = receiver()
  const archive = viewer.zip
  const assets = viewer.deferredAssets
  let rebuilt = 0
  Object.assign(viewer, {
    markdownText: 'keep this document',
    externalPdfUrl: 'old-url', externalPdfPath: 'old.pdf',
    revokeOwnedPdfUrl() {}, rebuild: async () => { rebuilt++ },
  })
  t.mock.method(URL, 'createObjectURL', () => 'blob:attached-pdf')
  const file = Object.assign(Uint8Array.of(37, 80, 68, 70), { name: 'original.pdf' })
  await prototype.attachPdf.call(viewer, file)
  assert.equal(viewer.zip, archive)
  assert.equal(viewer.deferredAssets, assets)
  assert.equal(viewer.markdownText, 'keep this document')
  assert.ok(viewer.zip.file('original.pdf'))
  assert.equal(viewer.pdfUrl, 'blob:attached-pdf')
  assert.equal(viewer.externalPdfUrl, null)
  assert.equal(rebuilt, 1)
})

test('matched metadata refresh keeps existing preview and editing state', () => {
  const events = []
  const preview = {
    editingText: 'unsaved live edit',
    querySelectorAll: selector => {
      assert.equal(selector, '.md-page-marker')
      return [{ remove: () => events.push('remove-old-marker') }]
    },
  }
  const pane = { scrollTop: 700, querySelector: () => preview }
  const viewer = {
    markdownMode: 'live', activeIdx: 12,
    shadowRoot: { getElementById: () => pane },
    annotatePreviewBlocks: node => { assert.equal(node, preview); events.push('annotate') },
    insertMarkdownPageMarkers: node => { assert.equal(node, preview); events.push('markers') },
    schedulePreviewLineNumbers: () => events.push('line-numbers'),
    updateOverlayStates: () => events.push('overlays'),
  }
  prototype.refreshMatchedPreview.call(viewer)
  assert.deepEqual(events, ['annotate', 'remove-old-marker', 'markers', 'line-numbers', 'overlays'])
  assert.equal(preview.editingText, 'unsaved live edit')
  assert.equal(pane.scrollTop, 700)
  assert.equal(viewer.activeIdx, 12)
  events.length = 0
  viewer.markdownMode = 'source'
  prototype.refreshMatchedPreview.call(viewer)
  assert.deepEqual(events, ['overlays'])
})

test('fetch completing after a document switch cannot overwrite the new archive', async t => {
  const viewer = receiver()
  let complete
  t.mock.method(globalThis, 'fetch', () => new Promise(resolve => { complete = resolve }))
  const pending = viewer.hydrateAsset('images/original.png')
  const next = receiver()
  next.zip.file('images/original.png', Uint8Array.of(99))
  viewer.zip = next.zip
  viewer.deferredAssets = next.deferredAssets
  complete(response([1, 2, 3]))
  await pending
  assert.deepEqual(await viewer.zip.file('images/original.png').async('uint8array'), Uint8Array.of(99))
  assert.equal(viewer.deferredAssets.size, 1)
})

test('ZIP export hydrates unseen images and preserves replacements and deletions', async t => {
  const viewer = receiver(['images/unseen.png', 'images/deleted.png'])
  // Deletion hydrates the original bytes for undo, then removes its ZIP entry.
  viewer.zip.file('images/deleted.png', Uint8Array.of(77))
  viewer.deferredAssets.delete('images/deleted.png')
  viewer.zip.remove('images/deleted.png')
  Object.assign(viewer, {
    markdownMode: 'preview', markdownPath: 'full.md', markdownText: 'edited',
    sourceZipName: 'result.zip', reviewEdits: [], flushDocumentSync: () => true,
  })
  viewer.zip.file('images/replaced.png', Uint8Array.of(88))
  let requests = 0
  let exported
  t.mock.method(globalThis, 'fetch', async () => { requests++; return response([11, 22]) })
  t.mock.method(URL, 'createObjectURL', blob => { exported = blob; return 'blob:export' })
  const previousDocument = globalThis.document
  const previousAlert = globalThis.alert
  globalThis.document = {
    createElement: () => ({ style: {}, click() {}, remove() {} }),
    body: { appendChild() {} },
  }
  globalThis.alert = message => assert.fail(message)
  // No browser cleanup timer is needed for this stubbed download.
  t.mock.method(globalThis, 'setTimeout', () => 0)
  try {
    await prototype.exportEditedZip.call(viewer)
    assert.ok(exported)
    const archive = await JSZip.loadAsync(await exported.arrayBuffer())
    assert.equal(requests, 1)
    assert.deepEqual(await archive.file('images/unseen.png').async('uint8array'), Uint8Array.of(11, 22))
    assert.deepEqual(await archive.file('images/replaced.png').async('uint8array'), Uint8Array.of(88))
    assert.equal(archive.file('images/deleted.png'), null)
    assert.equal(await archive.file('full.md').async('text'), 'edited')
  } finally {
    globalThis.document = previousDocument
    globalThis.alert = previousAlert
  }
})
