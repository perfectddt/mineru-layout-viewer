// E2E：点击 UL → 输入 → 校验源码回写；再点别处 → 校验会话正常结束
const target = 'http://127.0.0.1:18768/?launch=Dz5P8hc981uOSMJ4DLapEA&token=gur5E5T2_uqhnww9hkUQ0STuwcxoQ0Xn'
const list = await (await fetch('http://127.0.0.1:9333/json/list')).json()
const page = list.find(t => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let seq = 0
const pending = new Map()
ws.onmessage = e => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
}
const send = (method, params = {}) => {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise(r => pending.set(id, r))
}
const evaluate = async (expression, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
  if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text }
  return r.result?.result?.value
}
const click = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}
const results = []
const check = (name, ok, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)

await send('Page.enable')
await send('Page.navigate', { url: target })
for (let i = 0; i < 60; i++) {
  await new Promise(r => setTimeout(r, 300))
  const ready = await evaluate(`(() => { const v = document.getElementById('viewer'); return !!(v && v.shadowRoot && v.markdownText && v.markdownText.includes('固定成本')) })()`)
  if (ready === true) break
}

const pos = await evaluate(`(async () => {
  const viewer = document.getElementById('viewer')
  viewer.shadowRoot.getElementById('mdLiveMode').click()
  await new Promise(r => setTimeout(r, 800))
  const preview = viewer.shadowRoot.querySelector('.md-preview')
  const block = preview.querySelector('[data-md-start-line="33"]')
  block.scrollIntoView({ block: 'center' })
  await new Promise(r => setTimeout(r, 250))
  const rect = block.querySelector('li').getBoundingClientRect()
  return { x: Math.round(rect.x + 120), y: Math.round(rect.y + 8) }
})()`, true)

await click(pos.x, pos.y)
await new Promise(r => setTimeout(r, 500))
const s1 = await evaluate(`(() => { const v = document.getElementById('viewer'); const s = v.liveEditSession; return { active: !!s, tag: s?.element?.tagName } })()`)
check('点击 UL 后编辑会话存活', s1.active && s1.tag === 'UL', JSON.stringify(s1))

// 输入文本（caret 在源码 span 末尾）
await send('Input.insertText', { text: '新增文字' })
await new Promise(r => setTimeout(r, 400))
const s2 = await evaluate(`(() => { const v = document.getElementById('viewer'); return {
  typed: v.markdownText.includes('新增文字'),
  boldKept: v.markdownText.includes('- **固定成本**'),
  line42: v.markdownText.split('\\n')[41],
} })()`)
check('输入同步进源码', s2.typed === true)
check('加粗标记保留', s2.boldKept === true)

// 点击另一个块（H3 1.5 业务需求，源第 44 行）→ 旧会话应结束
const pos2 = await evaluate(`(async () => {
  const viewer = document.getElementById('viewer')
  const preview = viewer.shadowRoot.querySelector('.md-preview')
  const h = [...preview.querySelectorAll('[data-md-start-line]')].find(el => el.textContent.includes('1.5 业务需求'))
  h.scrollIntoView({ block: 'center' })
  await new Promise(r => setTimeout(r, 250))
  const rect = h.getBoundingClientRect()
  return { x: Math.round(rect.x + 100), y: Math.round(rect.y + 8) }
})()`, true)
await click(pos2.x, pos2.y)
await new Promise(r => setTimeout(r, 600))
const s3 = await evaluate(`(() => { const v = document.getElementById('viewer'); return {
  ulSessionGone: !(v.liveEditSession && v.liveEditSession.element.tagName === 'UL'),
  stillTyped: v.markdownText.includes('新增文字'),
  stillBold: v.markdownText.includes('- **固定成本**'),
} })()`)
check('点击别处后旧会话正常结束', s3.ulSessionGone === true)
check('结束后修改仍在源码中', s3.stillTyped === true)
check('结束后加粗仍未丢失', s3.stillBold === true)

// 再点击一次 H3（第一次点击被重建吃掉，重新取坐标后第二次应能开新会话）
const pos3 = await evaluate(`(async () => {
  const viewer = document.getElementById('viewer')
  const preview = viewer.shadowRoot.querySelector('.md-preview')
  const h = [...preview.querySelectorAll('[data-md-start-line]')].find(el => el.textContent.includes('1.5 业务需求'))
  h.scrollIntoView({ block: 'center' })
  await new Promise(r => setTimeout(r, 250))
  const rect = h.getBoundingClientRect()
  return { x: Math.round(rect.x + 100), y: Math.round(rect.y + 8) }
})()`, true)
await click(pos3.x, pos3.y)
await new Promise(r => setTimeout(r, 500))
const s4 = await evaluate(`(() => { const v = document.getElementById('viewer'); const s = v.liveEditSession; return { active: !!s, tag: s?.element?.tagName } })()`)
check('新块可再次开启编辑', s4.active === true, JSON.stringify(s4))

console.log(results.join('\n'))
ws.close()
process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0)
