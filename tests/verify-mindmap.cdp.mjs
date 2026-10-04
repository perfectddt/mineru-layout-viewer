// 真机（无头 Chrome + CDP）验证：思维导图视图、编辑回写、多窗口同步。
// 用法：先起 http.server 8899 与 chrome --remote-debugging-port=9333，再 node tests/verify-mindmap.cdp.mjs
const list = await (await fetch('http://127.0.0.1:9333/json/list')).json()
let page = list.find(t => t.type === 'page')
if (!page) throw new Error('no page target')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

let seq = 0
const pending = new Map()
ws.onmessage = e => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
}
function send(method, params = {}) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise(res => pending.set(id, res))
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800))
  return r.result?.result?.value
}

await send('Page.enable')
await send('Page.navigate', { url: 'http://127.0.0.1:8899/index.html' })
await new Promise(r => setTimeout(r, 1500))

const results = []
function check(name, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}

// 1. 载入 Markdown 并切到思维导图
const step1 = await evaluate(`(async () => {
  const viewer = document.getElementById('viewer')
  const md = '# 系统分析师\\n## 1. 系统规划\\n### 1.1 立项\\n- 基础研究\\n- 应用研发\\n## 2. 分析\\n\\n## 3. **成本**效益\\n'
  await viewer.loadMarkdownFile(new File([md], 't.md'))
  // 真实页面里选择文件后首页会切到查看器；脚本直调 loadMarkdownFile 需要自己做
  document.getElementById('dropZone').classList.add('hidden')
  viewer.classList.remove('hidden')
  viewer.shadowRoot.getElementById('mdMindmapMode').click()
  await new Promise(r => setTimeout(r, 300))
  const nodes = [...viewer.shadowRoot.querySelectorAll('.mindmap-node')].map(n => n.dataset.id + ':' + n.textContent)
  const links = viewer.shadowRoot.querySelectorAll('.mindmap-links path').length
  const boldNode = [...viewer.shadowRoot.querySelectorAll('.mindmap-node')].find(n => n.textContent.includes('成本'))
  return { mode: viewer.markdownMode, nodes, links,
    hasNewWindowBtn: !!viewer.shadowRoot.getElementById('splitRight') && !!viewer.shadowRoot.getElementById('splitDown'),
    boldRendered: boldNode ? !!boldNode.querySelector('strong') : 'node-missing' }
})()`)
check('切换到思维导图模式', step1.mode === 'mindmap', `mode=${step1.mode}`)
check('渲染出 7 个节点', step1.nodes.length === 7, JSON.stringify(step1.nodes))
check('连线存在', step1.links >= 6, `links=${step1.links}`)
check('工具栏有分屏按钮', step1.hasNewWindowBtn === true)
check('节点标签渲染行内 Markdown（**加粗**）', step1.boldRendered === true, String(step1.boldRendered))

// 2. 双击节点改名 → 回写源码
const step2 = await evaluate(`(async () => {
  const viewer = document.getElementById('viewer')
  const node = viewer.shadowRoot.querySelector('.mindmap-node[data-id="line:1"]')
  const viewport = viewer.shadowRoot.getElementById('mindmapViewport')
  // dblclick 需带节点坐标
  const r = node.getBoundingClientRect(), v = viewport.getBoundingClientRect()
  node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r.left + 8, clientY: r.top + 8 }))
  await new Promise(r => setTimeout(r, 100))
  const editor = viewer.shadowRoot.querySelector('.mindmap-editor')
  if (!editor) return { fail: 'no editor' }
  editor.value = '1. 系统规划（改）'
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await new Promise(r => setTimeout(r, 200))
  return { text: viewer.markdownText }
})()`)
check('双击改名回写源码', step2.text && step2.text.includes('## 1. 系统规划（改）'), step2.text ? step2.text.split('\n')[1] : step2.fail)

// 3. 键盘结构编辑：选中根节点按 Tab 新增子级
const step3 = await evaluate(`(async () => {
  const viewer = document.getElementById('viewer')
  viewer.mindmapSelected = 'line:0'
  const host = viewer.shadowRoot.querySelector('.mindmap-host')
  host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
  await new Promise(r => setTimeout(r, 200))
  const editor = viewer.shadowRoot.querySelector('.mindmap-editor')
  if (!editor) return { fail: 'no editor after Tab' }
  editor.value = '新章节'
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await new Promise(r => setTimeout(r, 200))
  return { text: viewer.markdownText }
})()`)
check('Tab 新增子级并回写', step3.text && /# 新章节/.test(step3.text), step3.text ? step3.text.split('\n').slice(-2).join('|') : step3.fail)

// 4. 多窗口同步：伪造另一窗口的 BroadcastChannel 消息
const step4 = await evaluate(`(async () => {
  const viewer = document.getElementById('viewer')
  // 组件只在 ?window=1 时开频道，这里直接驱动 onWindowMessage 路径：模拟远端 document
  const before = viewer.markdownText
  viewer.adoptRemoteDocument({ text: before + '\\n## 远端新增\\n', format: 'markdown', name: 't.md', mode: 'mindmap' }, Date.now() + 1000)
  await new Promise(r => setTimeout(r, 300))
  const nodes = viewer.shadowRoot.querySelectorAll('.mindmap-node').length
  return { text: viewer.markdownText, nodes }
})()`)
check('远端修改实时同步进当前窗口', step4.text && step4.text.includes('## 远端新增') && step4.nodes === 9, `nodes=${step4.nodes}`)

// 5. 本地修改会广播（publishDocumentChange 经 edit 漏斗）
const step5 = await evaluate(`(async () => {
  const viewer = document.getElementById('viewer')
  const received = []
  const bc = new BroadcastChannel('mineru-layout-viewer-windows-v1')
  bc.onmessage = e => received.push(e.data)
  // 强制开频道模拟本窗口也是同步成员（openViewerInNewWindow 里同样 force）
  viewer.setupWindowChannel(true)
  viewer.markdownMode = 'source'   // 走 saveSourceAndPreview 漏斗太重，直接调 applyMarkdownEdit 风格：改源码后 funnel
  viewer.markdownMode = 'mindmap'
  viewer.suppressDocumentBroadcast = false
  const rev = viewer.documentRevision
  viewer.markdownText = viewer.markdownText + '\\n## 本地广播\\n'
  viewer.refreshSectionsPreservingMatches(viewer.sections)
  await new Promise(r => setTimeout(r, 300))
  bc.close()
  return { got: received.some(m => m.type === 'document' && m.document.text.includes('本地广播')) }
})()`)
check('本地编辑经统一漏斗广播', step5.got === true)

// 6. 切回预览模式应显示新内容
const step6 = await evaluate(`(async () => {
  const viewer = document.getElementById('viewer')
  viewer.shadowRoot.getElementById('mdPreviewMode').click()
  await new Promise(r => setTimeout(r, 300))
  const html = viewer.shadowRoot.querySelector('.md-preview')?.innerHTML || ''
  return { has: html.includes('远端新增') && html.includes('本地广播'), mode: viewer.markdownMode }
})()`)
check('切回预览显示同步后的内容', step6.has === true && step6.mode === 'preview', `mode=${step6.mode}`)

// 7. 按层级折叠：展开到 1 级只留根+一级
const step7 = await evaluate(`(async () => {
  const viewer = document.getElementById('viewer')
  viewer.shadowRoot.getElementById('mdMindmapMode').click()
  await new Promise(r => setTimeout(r, 200))
  const before = viewer.shadowRoot.querySelectorAll('.mindmap-node').length
  viewer.shadowRoot.querySelector('[data-mm="level-1"]').click()
  await new Promise(r => setTimeout(r, 200))
  const level1 = viewer.shadowRoot.querySelectorAll('.mindmap-node').length
  const labels1 = [...viewer.shadowRoot.querySelectorAll('.mindmap-node .mindmap-label')].map(n => n.textContent)
  viewer.shadowRoot.querySelector('[data-mm="expand"]').click()
  await new Promise(r => setTimeout(r, 200))
  const expanded = viewer.shadowRoot.querySelectorAll('.mindmap-node').length
  return { before, level1, labels1, expanded }
})()`)
check('1级折叠只显示根+一级节点', step7.level1 < step7.before && !step7.labels1.some(l => l.includes('1.1 立项')), `before=${step7.before} level1=${step7.level1} labels=${JSON.stringify(step7.labels1)}`)
check('全部展开恢复节点数', step7.expanded === step7.before, `expanded=${step7.expanded}`)

// 8. 模式切换光标跟随：code 光标在某行 → 导图选中该块 → 预览高亮该块
const step8 = await evaluate(`(async () => {
  const viewer = document.getElementById('viewer')
  // 去 code 模式，把光标放到 "1.1 立项" 所在行
  viewer.shadowRoot.getElementById('mdSourceMode').click()
  await new Promise(r => setTimeout(r, 300))
  const text = viewer.sourceEditor.getValue()
  const targetLine = text.split('\\n').findIndex(l => l.includes('1.1 立项')) + 1
  const offset = text.split('\\n').slice(0, targetLine - 1).join('\\n').length + 1
  viewer.sourceEditor.goTo(offset)
  // 切到导图：应选中包含该行的节点
  viewer.shadowRoot.getElementById('mdMindmapMode').click()
  await new Promise(r => setTimeout(r, 300))
  const selectedId = viewer.mindmapSelected
  const selectedNode = viewer.mindmapTree.nodes.find(n => n.id === selectedId)
  const mindmapOk = selectedNode && selectedNode.source && (targetLine - 1) >= selectedNode.source.line && (targetLine - 1) <= selectedNode.source.lastLine
  // 切到预览：previewCursorLine 应为该行
  viewer.shadowRoot.getElementById('mdPreviewMode').click()
  await new Promise(r => setTimeout(r, 500))
  return { targetLine, selectedId, mindmapOk, previewLine: viewer.previewCursorLine }
})()`)
check('code→导图 选中包含光标行的节点', step8.mindmapOk === true, `line=${step8.targetLine} selected=${step8.selectedId}`)
check('导图→预览 光标行跟随', step8.previewLine === step8.targetLine, `previewLine=${step8.previewLine} target=${step8.targetLine}`)

// 9. 分屏：右分屏出现嵌入查看器，双向同步，可关闭
const step9 = await evaluate(`(async () => {
  const viewer = document.getElementById('viewer')
  viewer.shadowRoot.getElementById('splitRight').click()
  await new Promise(r => setTimeout(r, 1200))
  const grid = viewer.shadowRoot.getElementById('mdSplitGrid')
  const pane = grid.querySelector('mineru-layout-viewer')
  if (!pane) return { fail: 'no pane' }
  const embeddedOk = pane.classList.contains('embedded') && !pane.shadowRoot.querySelector('.toolbar')
    || (pane.classList.contains('embedded') && getComputedStyle(pane.shadowRoot.querySelector('.toolbar')).display === 'none')
  const sameDoc = pane.markdownText === viewer.markdownText
  // 主栏改 → 副栏同步
  viewer.markdownText = viewer.markdownText + '\\n## 主栏新增\\n'
  viewer.refreshSectionsPreservingMatches(viewer.sections)
  await new Promise(r => setTimeout(r, 500))
  const mainToPane = pane.markdownText.includes('主栏新增')
  // 副栏改 → 主栏同步
  pane.markdownText = pane.markdownText + '\\n## 副栏新增\\n'
  pane.refreshSectionsPreservingMatches(pane.sections)
  await new Promise(r => setTimeout(r, 500))
  const paneToMain = viewer.markdownText.includes('副栏新增')
  // 副栏模式独立：切导图不影响主栏
  pane.shadowRoot.getElementById('mdMindmapMode').click()
  await new Promise(r => setTimeout(r, 300))
  const independent = pane.markdownMode === 'mindmap' && viewer.markdownMode === 'preview'
  // 关闭分屏
  pane.shadowRoot.getElementById('closeSplitPane').click()
  await new Promise(r => setTimeout(r, 300))
  const closed = !viewer.shadowRoot.getElementById('mdSplitGrid').querySelector('mineru-layout-viewer')
  return { embeddedOk, sameDoc, mainToPane, paneToMain, independent, closed }
})()`)
check('分屏创建嵌入查看器（隐藏应用级工具栏）', step9.embeddedOk === true && step9.sameDoc === true, JSON.stringify(step9))
check('主栏→副栏实时同步', step9.mainToPane === true)
check('副栏→主栏实时同步', step9.paneToMain === true)
check('各栏模式互不影响', step9.independent === true)
check('关闭分屏恢复单栏', step9.closed === true)

// 10. 嵌套分屏（不对称布局）：主栏右分 → 右栏再下分，三栏互通
const step10 = await evaluate(`(async () => {
  const viewer = document.getElementById('viewer')
  viewer.shadowRoot.getElementById('splitRight').click()
  await new Promise(r => setTimeout(r, 1000))
  const right = viewer.shadowRoot.getElementById('mdSplitGrid').querySelector('mineru-layout-viewer')
  if (!right) return { fail: 'no right pane' }
  // 右栏再向下分
  right.shadowRoot.getElementById('splitDown').click()
  await new Promise(r => setTimeout(r, 1000))
  const nested = right.shadowRoot.getElementById('mdSplitGrid').querySelector('mineru-layout-viewer')
  if (!nested) return { fail: 'no nested pane' }
  const layout = (() => {
    // 直接量几何：右栏在主栏右边且同高；嵌套栏在右栏下方且左对齐
    const mainRect = viewer.shadowRoot.getElementById('mdPane').getBoundingClientRect()
    const rightRect = right.getBoundingClientRect()
    const nestedRect = nested.getBoundingClientRect()
    return {
      sideBySide: rightRect.left > mainRect.left + 50 && Math.abs(rightRect.top - mainRect.top) < 20,
      stacked: nestedRect.top > rightRect.top + 50 && Math.abs(nestedRect.left - rightRect.left) < 20,
    }
  })()
  const sameDoc = right.markdownText === viewer.markdownText && nested.markdownText === viewer.markdownText
  // 最深层栏改 → 主栏与中间栏都同步
  nested.markdownText = nested.markdownText + '\\n## 深层栏新增\\n'
  nested.refreshSectionsPreservingMatches(nested.sections)
  await new Promise(r => setTimeout(r, 600))
  const deepToAll = viewer.markdownText.includes('深层栏新增') && right.markdownText.includes('深层栏新增')
  // 主栏改 → 深层栏也同步
  viewer.markdownText = viewer.markdownText + '\\n## 主栏再增\\n'
  viewer.refreshSectionsPreservingMatches(viewer.sections)
  await new Promise(r => setTimeout(r, 600))
  const mainToDeep = nested.markdownText.includes('主栏再增') && right.markdownText.includes('主栏再增')
  return { layout, sameDoc, deepToAll, mainToDeep }
})()`)
check('不对称嵌套分屏布局（左 | 右上/右下）', step10.layout && step10.layout.sideBySide === true && step10.layout.stacked === true, JSON.stringify(step10.layout || step10))
check('嵌套三栏同一份文档', step10.sameDoc === true)
check('深层栏 → 主栏/中间栏同步', step10.deepToAll === true)
check('主栏 → 深层栏同步', step10.mainToDeep === true)

console.log(results.join('\n'))
const fails = results.filter(r => r.startsWith('FAIL'))
console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS')
ws.close()
process.exit(fails.length ? 1 : 0)
