// 分屏分隔条拖拽真机验证
// 运行前：python -m http.server 8899 + chrome --headless=new --remote-debugging-port=9333
const base = 'http://127.0.0.1:8899'
const results = []
const check = (name, ok, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)

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
const mouse = async (type, x, y) => {
  await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 })
}
const drag = async (x1, y1, x2, y2, steps = 8) => {
  await mouse('mousePressed', x1, y1)
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', Math.round(x1 + (x2 - x1) * i / steps), Math.round(y1 + (y2 - y1) * i / steps))
    await new Promise(r => setTimeout(r, 30))
  }
  await mouse('mouseReleased', x2, y2)
  await new Promise(r => setTimeout(r, 200))
}

await send('Page.enable')
await send('Page.navigate', { url: `${base}/index.html` })
for (let i = 0; i < 40; i++) {
  await new Promise(r => setTimeout(r, 250))
  const ready = await evaluate(`!!document.getElementById('viewer') && !!document.getElementById('viewer').loadMarkdownFile`)
  if (ready === true) break
}

// 加载文档并左右分屏（隐藏首页，让 viewer 占满窗口，接近真实使用）
const s1 = await evaluate(`(async () => {
  const viewer = document.getElementById('viewer')
  document.getElementById('dropZone').classList.add('hidden')
  viewer.classList.remove('hidden')
  const md = '# 标题\\n## A\\n- 甲\\n- 乙\\n## B\\n正文\\n'
  await viewer.loadMarkdownFile(new File([md], 't.md'))
  viewer.shadowRoot.getElementById('splitRight').click()
  await new Promise(r => setTimeout(r, 800))
  const grid = viewer.shadowRoot.getElementById('mdSplitGrid')
  const divider = grid.querySelector('.split-divider')
  const mainRect = viewer.shadowRoot.getElementById('mdPane').getBoundingClientRect()
  const splitRect = grid.querySelector('mineru-layout-viewer').getBoundingClientRect()
  const rect = divider.getBoundingClientRect()
  return {
    dividers: grid.querySelectorAll('.split-divider').length,
    mainW: Math.round(mainRect.width), splitW: Math.round(splitRect.width),
    dx: Math.round(rect.x + rect.width / 2), dy: Math.round(rect.y + rect.height / 2),
    cursor: getComputedStyle(divider).cursor,
    fractions: viewer.splitFractions.map(f => +f.toFixed(3)),
  }
})()`, true)
check('分屏后出现 1 个分隔条', s1.dividers === 1, JSON.stringify(s1))
check('初始两栏等宽', Math.abs(s1.mainW - s1.splitW) <= 12, `main=${s1.mainW} split=${s1.splitW}`)
check('分隔条光标为 col-resize', s1.cursor === 'col-resize', s1.cursor)

// 向右拖 200px：左栏应变宽 200px 左右
await drag(s1.dx, s1.dy, s1.dx + 200, s1.dy)
const s2 = await evaluate(`(() => {
  const viewer = document.getElementById('viewer')
  const grid = viewer.shadowRoot.getElementById('mdSplitGrid')
  const mainRect = viewer.shadowRoot.getElementById('mdPane').getBoundingClientRect()
  const splitRect = grid.querySelector('mineru-layout-viewer').getBoundingClientRect()
  return { mainW: Math.round(mainRect.width), splitW: Math.round(splitRect.width), fractions: viewer.splitFractions.map(f => +f.toFixed(3)) }
})()`)
check('右拖 200px 后左栏变宽', s2.mainW >= s1.mainW + 180 && s2.mainW <= s1.mainW + 220, `${s1.mainW} -> ${s2.mainW}`)
check('右栏相应变窄', s2.splitW <= s1.splitW - 180 && s2.splitW >= s1.splitW - 220, `${s1.splitW} -> ${s2.splitW}`)

// 向左猛拖 5000px：应被最小宽度钳制，不会交换/塌陷
const s3pos = await evaluate(`(() => {
  const viewer = document.getElementById('viewer')
  const rect = viewer.shadowRoot.querySelector('.split-divider').getBoundingClientRect()
  return { x: Math.round(rect.x + 3), y: Math.round(rect.y + rect.height / 2) }
})()`)
await drag(s3pos.x, s3pos.y, s3pos.x - 5000, s3pos.y)
const s3 = await evaluate(`(() => {
  const viewer = document.getElementById('viewer')
  const grid = viewer.shadowRoot.getElementById('mdSplitGrid')
  const mainRect = viewer.shadowRoot.getElementById('mdPane').getBoundingClientRect()
  const splitRect = grid.querySelector('mineru-layout-viewer').getBoundingClientRect()
  return { mainW: Math.round(mainRect.width), splitW: Math.round(splitRect.width) }
})()`)
check('拖到极限时左栏不小于最小宽度', s3.mainW >= 130 && s3.mainW <= 200, `mainW=${s3.mainW}`)
check('拖到极限时右栏仍占剩余空间', s3.splitW > 400, `splitW=${s3.splitW}`)

// 右栏内再做上下分屏 → 嵌套分隔条可纵向拖
const s4 = await evaluate(`(async () => {
  const viewer = document.getElementById('viewer')
  const right = viewer.shadowRoot.getElementById('mdSplitGrid').querySelector('mineru-layout-viewer')
  right.shadowRoot.getElementById('splitDown').click()
  await new Promise(r => setTimeout(r, 800))
  const nestedGrid = right.shadowRoot.getElementById('mdSplitGrid')
  const divider = nestedGrid.querySelector('.split-divider')
  const rect = divider.getBoundingClientRect()
  const topH = Math.round(right.shadowRoot.getElementById('mdPane').getBoundingClientRect().height)
  return {
    nestedDividers: nestedGrid.querySelectorAll('.split-divider').length,
    cursor: getComputedStyle(divider).cursor,
    dx: Math.round(rect.x + rect.width / 2), dy: Math.round(rect.y + rect.height / 2),
    topH,
  }
})()`, true)
check('嵌套分屏出现分隔条', s4.nestedDividers === 1)
check('嵌套分隔条光标为 row-resize', s4.cursor === 'row-resize', s4.cursor)

await drag(s4.dx, s4.dy, s4.dx, s4.dy + 120)
const s5 = await evaluate(`(() => {
  const viewer = document.getElementById('viewer')
  const right = viewer.shadowRoot.getElementById('mdSplitGrid').querySelector('mineru-layout-viewer')
  const topH = Math.round(right.shadowRoot.getElementById('mdPane').getBoundingClientRect().height)
  return { topH }
})()`)
check('嵌套分隔条下拉 120px 后上栏变高', s5.topH >= s4.topH + 100 && s5.topH <= s4.topH + 140, `${s4.topH} -> ${s5.topH}`)

// 关闭嵌套分屏（点嵌套栏的关闭按钮，不是右栏自己的）→ 外层分隔条与比例不受影响
const s6 = await evaluate(`(async () => {
  const viewer = document.getElementById('viewer')
  const right = viewer.shadowRoot.getElementById('mdSplitGrid').querySelector('mineru-layout-viewer')
  const nested = right.shadowRoot.getElementById('mdSplitGrid').querySelector('mineru-layout-viewer')
  nested.shadowRoot.getElementById('closeSplitPane').click()
  await new Promise(r => setTimeout(r, 500))
  const grid = viewer.shadowRoot.getElementById('mdSplitGrid')
  return {
    outerDividers: grid.querySelectorAll('.split-divider').length,
    fractions: viewer.splitFractions.map(f => +f.toFixed(3)),
    panes: grid.querySelectorAll('mineru-layout-viewer').length,
  }
})()`, true)
check('关闭嵌套后外层仍为 1 个分隔条 2 栏', s6.outerDividers === 1 && s6.panes === 1, JSON.stringify(s6))
check('外层比例未被重置为等分', Math.abs(s6.fractions[0] - 0.5) > 0.05, JSON.stringify(s6.fractions))

console.log(results.join('\n'))
ws.close()
process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0)
