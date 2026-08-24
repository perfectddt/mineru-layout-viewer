/**
 * Everforest reading theme for Markdown and Org previews.
 * Palette and Org face choices are adapted from the supplied Emacs themes:
 *   everforest-hard-light-theme.el / everforest-hard-dark-theme.el
 * Load from Settings -> Org default render plugin.
 */
export default {
  // Replace the built-in reading theme instead of stacking conflicting rules.
  name: 'mineru-reading-theme',
  styles: `
.md-preview {
  --ef-bg:#fff9e8;
  --ef-bg-1:#f7f4e0;
  --ef-bg-hl:#edf0cd;
  --ef-fg:#5c6a72;
  --ef-muted:#829181;
  --ef-border:#d8d5bd;
  --ef-green:#8da101;
  --ef-red:#f85552;
  --ef-orange:#f57d26;
  --ef-yellow:#dfa000;
  --ef-blue:#3a94c5;
  --ef-purple:#df69ba;
  --ef-cyan:#35a77c;
  max-width:920px;
  margin:0 auto;
  padding:26px 42px 72px;
  color:var(--ef-fg);
  background:var(--ef-bg);
  font-family:"LXGW WenKai","Microsoft YaHei","PingFang SC",system-ui,sans-serif;
  line-height:1.82;
}
.md-preview > :first-child { margin-top:0; }
.md-preview h1,.md-preview h2,.md-preview h3,.md-preview h4,.md-preview h5,.md-preview h6 {
  border:0;
  padding-bottom:.18em;
  font-weight:700;
  letter-spacing:.025em;
}
.md-preview h1 { color:var(--ef-green); border-bottom:2px solid color-mix(in srgb,var(--ef-green) 38%,transparent); }
.md-preview h2 { color:var(--ef-red); border-bottom:1px solid color-mix(in srgb,var(--ef-red) 30%,transparent); }
.md-preview h3 { color:var(--ef-purple); }
.md-preview h4 { color:var(--ef-orange); }
.md-preview h5 { color:var(--ef-blue); }
.md-preview h6 { color:var(--ef-cyan); }
.md-preview a { color:var(--ef-blue); font-weight:600; text-decoration-thickness:1px; text-underline-offset:3px; }
.md-preview strong { color:var(--ef-green); }
.md-preview em { color:var(--ef-purple); }
.md-preview s { color:var(--ef-muted); }
.md-preview blockquote {
  margin:.9em 0;
  padding:.5em 1em;
  color:var(--ef-muted);
  border-left:4px solid var(--ef-cyan);
  background:var(--ef-bg-1);
}
.md-preview code {
  color:var(--ef-orange);
  background:var(--ef-bg-hl);
  font-family:"Cascadia Code",Consolas,monospace;
}
.md-preview pre {
  position:relative;
  color:var(--ef-fg);
  background:var(--ef-bg-1);
  border:1px solid var(--ef-border);
  box-shadow:inset 4px 0 0 var(--ef-green);
}
.md-preview pre code { color:inherit; background:transparent; }
.md-preview table { display:table; width:100%; overflow:hidden; border:1px solid var(--ef-border); border-radius:7px; }
.md-preview th { color:var(--ef-green); background:var(--ef-bg-hl); }
.md-preview th,.md-preview td { border-color:var(--ef-border); }
.md-preview tr:nth-child(even) td { background:var(--ef-bg-1); }
.md-preview .task-list-item-checkbox { accent-color:var(--ef-green); }
.md-preview hr { border:0; border-top:1px solid var(--ef-border); }
.md-preview mark.search-hit { color:var(--ef-fg); background:#f4db7d; box-shadow:0 0 0 1px var(--ef-yellow); }
.md-preview.org-preview { box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--ef-green) 22%,transparent); }
.md-preview.org-preview .org-todo { color:var(--ef-red); }
.md-preview.org-preview .org-done { color:var(--ef-purple); text-decoration:line-through; }
.md-preview.org-preview .live-editable:focus { background:var(--ef-bg-hl); box-shadow:inset 3px 0 0 var(--ef-green); }
@media (prefers-color-scheme:dark) {
  .md-preview {
    --ef-bg:#2b3339;
    --ef-bg-1:#323c41;
    --ef-bg-hl:#3a454a;
    --ef-fg:#d3c6aa;
    --ef-muted:#859289;
    --ef-border:#4f5b58;
    --ef-green:#a7c080;
    --ef-red:#e67e80;
    --ef-orange:#e69875;
    --ef-yellow:#dbbc7f;
    --ef-blue:#7fbbb3;
    --ef-purple:#d699b6;
    --ef-cyan:#83c092;
  }
}
`,
  afterRender(root) {
    if (!root.classList.contains('org-preview')) return
    for (const heading of root.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
      const text = heading.textContent || ''
      if (/\bTODO\b/.test(text)) heading.classList.add('org-todo')
      if (/\bDONE\b/.test(text)) heading.classList.add('org-done')
    }
  },
}
