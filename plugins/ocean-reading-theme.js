/**
 * MinerU Markdown render theme example.
 * In the viewer, click “加载渲染插件” and select this file.
 */
export default {
  name: 'mineru-reading-theme',
  styles: `
.md-preview {
  max-width: 900px;
  margin: 0 auto;
  padding: 28px 42px 72px;
  color: #203047;
  font-family: "Noto Serif SC", "Source Han Serif SC", "Microsoft YaHei", sans-serif;
  line-height: 1.88;
}
.md-preview h1 { color:#0f3f5f; text-align:center; border-bottom:3px double #8ecae6; }
.md-preview h2 { color:#075985; border-bottom:1px solid #bae6fd; }
.md-preview h3 { color:#0369a1; }
.md-preview blockquote { border-left-color:#0284c7; background:#f0f9ff; color:#334155; }
.md-preview th { background:#e0f2fe; color:#0c4a6e; }
.md-preview tr:nth-child(even) td { background:#f8fcff; }
.md-preview img.md-asset { border:1px solid #dbeafe; box-shadow:0 5px 22px rgba(3,105,161,.14); }
`,
}
