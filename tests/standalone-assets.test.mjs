import test from 'node:test'
import assert from 'node:assert/strict'

globalThis.HTMLElement = class {}
globalThis.URL.createObjectURL = () => 'blob:standalone-asset'

const { MineruLayoutViewer } = await import('../dist/index.mjs')

/** Build a viewer with the DOM-heavy parts of loadMarkdownFile stubbed out. */
function createViewer(requests, { fail = false } = {}) {
  const viewer = Object.create(MineruLayoutViewer.prototype)
  viewer.zip = null
  viewer.assetUrls = new Map()
  viewer.siblingAssetSource = null
  viewer.resetReviewState = () => {
    viewer.zip = null
    viewer.siblingAssetSource = null
  }
  viewer.activateDefaultRenderPlugin = () => {}
  viewer.startLoadProgress = () => {}
  viewer.setLoadProgress = () => {}
  viewer.finishLoadProgress = () => {}
  viewer.buildUI = () => {}
  globalThis.fetch = async url => {
    requests.push(String(url))
    if (fail) return { ok: false, status: 404, blob: async () => new Blob([]) }
    return { ok: true, status: 200, blob: async () => new Blob(['image-bytes']) }
  }
  return viewer
}

test('a launched standalone Markdown keeps its launch and resolves sibling images', async () => {
  const requests = []
  const viewer = createViewer(requests)
  await viewer.loadMarkdownFile(new File(['![](imgs/pic.jpg)\n'], '教材.md', { type: 'text/markdown' }), undefined,
    { siblingAssets: { token: 'tok', launch: 'ln' } })

  // Loading must not wipe the launch recorded by the page that opened the file.
  assert.deepEqual(viewer.siblingAssetSource, { token: 'tok', launch: 'ln' })
  assert.equal(await viewer.getAssetUrl('imgs/pic.jpg'), 'blob:standalone-asset')
  assert.equal(requests.length, 1)
  assert.match(requests[0], /^\/__viewer\/file\?/)
  assert.match(requests[0], /token=tok/)
  assert.match(requests[0], /launch=ln/)
  assert.match(requests[0], /path=imgs%2Fpic\.jpg/)

  // The same image is fetched once and reused.
  assert.equal(await viewer.getAssetUrl('imgs/pic.jpg'), 'blob:standalone-asset')
  assert.equal(requests.length, 1)
})

test('a standalone Markdown opened without the local server reports why images are missing', async () => {
  const requests = []
  const viewer = createViewer(requests)
  await viewer.loadMarkdownFile(new File(['![](imgs/pic.jpg)\n'], 'plain.md', { type: 'text/markdown' }))

  assert.equal(viewer.siblingAssetSource, null)
  await assert.rejects(() => viewer.getAssetUrl('imgs/pic.jpg'), /MinerU ZIP/)
  assert.equal(requests.length, 0)
})

test('sibling image paths may not escape the document folder', async () => {
  const requests = []
  const viewer = createViewer(requests)
  await viewer.loadMarkdownFile(new File(['x\n'], 'plain.md', { type: 'text/markdown' }), undefined,
    { siblingAssets: { token: 't', launch: 'l' } })

  await assert.rejects(() => viewer.getAssetUrl('../secret.jpg'), /不安全的图片路径/)
  await assert.rejects(() => viewer.getAssetUrl(''), /不安全的图片路径/)
  assert.equal(requests.length, 0)
})

test('a missing sibling image surfaces an error instead of a silent broken image', async () => {
  const requests = []
  const viewer = createViewer(requests, { fail: true })
  await viewer.loadMarkdownFile(new File(['x\n'], 'plain.md', { type: 'text/markdown' }), undefined,
    { siblingAssets: { token: 't', launch: 'l' } })

  await assert.rejects(() => viewer.getAssetUrl('imgs/missing.jpg'), /读取图片失败：HTTP 404/)
  assert.equal(requests.length, 1)
})
