# 更新记录

本文件记录 `my-main` 分支相对原始 `mineru-layout-viewer` 的主要功能变化。最新状态截至 2026-09-01。

## 当前版本：大型 MinerU 文档审核工作流

### PDF 性能、对应关系与稳定性

- `8d8c2e4`：PDF 与 Markdown 改为按阅读顺序和局部窗口匹配；排除页眉、页脚和页码，区分正文与表格，并将计算放入 Web Worker，避免主界面长时间无响应。
- `8d8c2e4`：通过 Windows 启动器打开 MinerU 文件夹时，PDF 使用 HTTP Range 按需读取；导出修改版 ZIP 时才补读完整 PDF。直接拖入 ZIP 仍需解压其中的 PDF。
- `5c64407`：PDF Canvas 页面虚拟化。保留全部页面外壳、页码、定位框和滚动高度，但只为可视区域上下 900px 缓冲区生成 Canvas；离开后取消任务、清空像素并移除，返回时重新渲染。
- `5c64407`：新增“快速/高清”PDF 渲染模式。快速模式默认最高 `1.15×`，适合审核与快速滚动；高清模式结合缩放和屏幕像素密度，最高 `3×`。
- `22bac3e`：本地服务优先使用 18768；端口冲突时独占检测并自动选择空闲本机端口。启动器读取状态文件中的实际端口、令牌和 PID，复用正确实例，不停止占用 18768 的其他软件。
- `235ee94`：本地服务禁止缓存旧前端资源，配合 bundle 查询版本避免浏览器继续使用旧代码。

实测一份 142MB、88 页的 MinerU 文件夹：978 个 Markdown 段落中匹配 823 个（84.2%），页码倒退为 0，6 个 HTML 表格均对应到表格块；重新加载约 7 秒，第 1 页与第 60 页之间跳转时只保留 2–4 个 Canvas。

### Markdown 表格编辑

- `ac2fde0`：预览和实时预览模式支持识别、选择并编辑整张 Markdown/HTML 表格。
- `84ae8ae`：原始 HTML `<table>` 在预览与实时预览中可双击进入源码编辑，不再被渲染层拦截。
- `a06ce32`：实时预览支持单个 HTML 表格单元格原位编辑；只显示、修改当前单元格内容，不再把整张表切换成源码。
- `6d59f1f`：补充 Org 表格的实时编辑支持。

### Markdown / Org 编辑器

- `0170eaa`、`f5fac16`：右侧由纯查看器升级为 Markdown 渲染与编辑工作区，支持预览、CodeMirror 全文源码、Vim、搜索替换、撤销和重做。
- `dffc8f0`、`271d8cf`：新增类 Typora 实时预览。聚焦当前块时显示真实 Markdown/Org 标记，同时保留标题、粗体、斜体、颜色和公式的视觉语义。
- `7e3f109`：支持独立 `.org` 文件，并保留 Markdown 编辑器具有的预览、实时预览、Code/Vim、搜索、历史、缩放和保存能力。
- `3e39431`：支持 Org 源码块、示例块、固定宽度代码行、`CLOSED` 等计划时间戳、属性抽屉，以及带或不带分隔行的表格。
- `6d59f1f`：新增独立的 `orglist-gtd-format.js`，处理 Orglist/GTD 特殊格式，避免把项目专用规则写入核心编辑器。

### 渲染插件与主题

- `dffc8f0`、`0db0c99`：加入完整 Phycat Prussian Markdown 主题和字体资源。
- `271d8cf`：Markdown 与 Org 使用独立主题栈；Everforest 作为 Org 主题，不再与 Markdown 主题混用。
- `54192ef`：支持同时加载多个渲染插件，不再因加载 Orglist GTD 插件而覆盖 Everforest 主题。
- `6a4b04a`：主题和大纲显示 `H1`、`H2` 等标题等级，并按标题层级缩进。
- `525c8f6`：保留原插件文件，新版本使用 `-v2` 等版本后缀；现有文件包括 `phycat-prussian-theme.js`、`phycat-prussian-theme-v2.js`、`everforest-org-theme.js` 和 `everforest-org-theme-v2.js`。

### 布局、导航与最近打开

- `49c6a66`、`7d831e3`、`0db0c99`：PDF/Markdown 支持左右或上下排列、互换位置、拖动主分隔线并保存默认比例；书签/大纲也支持左右或上下排列及独立尺寸。
- `6a4b04a`、`525c8f6`：PDF 书签和 Markdown/Org 大纲显示标题等级，并支持搜索与点击跳转。
- `54192ef`、`5cede58`：新增最近打开记录，并将入口固定到最左侧工具区，避免遮挡设置按钮。
- PDF 与 Markdown 具有独立缩放；PDF 支持整页、页宽和自定义比例，Markdown 图片随右侧缩放。

### 图片审核与本地保存

- `e76bda3`：新增图片替换、图片转文字、删除链接、删除链接和本地图片、撤销/重做以及修改版 ZIP 导出。
- 已从 Markdown 删除但仍存在于 MinerU JSON/PDF 的图片框以不同颜色显示，方便审核遗漏。
- 文件夹读写模式和通过 Windows 启动器打开的单个 Markdown/Org 文件支持覆盖保存；ZIP 和旧式文件夹上传模式导出修改版 ZIP，不覆盖原始 ZIP。

### Windows 启动与集成

- `e834f53`：新增一键本地启动器，不再直接用 `file://` 打开 `index.html`。
- `4338c30`、`a380bf6`：修复 PowerShell/CMD 编码问题，并优先使用 PowerShell 7，找不到时回退 Windows PowerShell。
- `b4954c2`：增加“双文档”应用图标、桌面快捷方式，以及 ZIP、Markdown、Org 的“打开方式”注册；文件或 MinerU 文件夹可直接拖到快捷方式上。
- `.cmd` 启动器保持 ASCII 与 CRLF；Unicode 逻辑放在 PowerShell 中，避免中文系统上的乱码与解析错误。

## 使用注意事项

- 始终通过 `start-viewer.cmd.lnk` 或“打开方式”启动，不要收藏固定的 localhost 端口，也不要直接双击 `index.html`。
- 动态服务状态位于 `%TEMP%\mineru-layout-viewer-server.json`。端口可能不是 18768，这是正常的端口避让行为。
- 快速模式适合日常审核；只有确实需要检查小字或图片细节时再切换高清模式。
- 通过启动器打开文件夹才能获得 PDF Range 流式读取；直接拖 ZIP 不具备这一优势。
- 新主题或格式插件必须保留旧文件，并以 `-v2`、`-v3` 等新文件名发布。

