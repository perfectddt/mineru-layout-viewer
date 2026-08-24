/**
 * Phycat Prussian theme adapted for MinerU Layout Viewer.
 *
 * Reference:
 *   %APPDATA%/Typora/themes/phycat-prussian.css
 *   %APPDATA%/Typora/themes/phycat/phycat.light.css
 *
 * Load it from Settings -> Default Markdown render plugin. The bundled font
 * files live in /plugins/phycat/ and are copied from the supplied Typora theme.
 */
export default {
  // Reuse the built-in theme name so this replaces it instead of stacking.
  name: 'mineru-reading-theme',
  styles: `
@font-face {
  font-family:"LXGW WenKai";
  src:local("LXGW WenKai"),
      url("./plugins/phycat/LXGWWenKai-Regular.ttf") format("truetype"),
      url("../plugins/phycat/LXGWWenKai-Regular.ttf") format("truetype"),
      url("/plugins/phycat/LXGWWenKai-Regular.ttf") format("truetype");
  font-display:swap;
}
@font-face {
  font-family:CascadiaCode;
  src:local("Cascadia Code"),
      url("./plugins/phycat/Cascadia-Code-Regular.ttf") format("truetype"),
      url("../plugins/phycat/Cascadia-Code-Regular.ttf") format("truetype"),
      url("/plugins/phycat/Cascadia-Code-Regular.ttf") format("truetype");
  font-display:swap;
}
.md-preview {
  --phycat-blue:#1d4e89;
  --phycat-deep:#003153;
  --phycat-light:#6ba3cc;
  --phycat-pale:#e1edf5;
  --phycat-mist:#f0f6fa;
  max-width:950px;
  margin:0 auto;
  padding:28px 42px 72px;
  color:#273444;
  position:relative;
  z-index:0;
  isolation:isolate;
  font-family:"LXGW WenKai",KaiTi,STKaiti,"Microsoft YaHei","PingFang SC",serif;
  font-synthesis:none;
  font-size:calc(16px * var(--md-zoom));
  line-height:2;
  letter-spacing:.035em;
  background-color:#fff;
}
.md-preview::before {
  content:"";
  position:absolute;
  inset:0;
  z-index:-1;
  pointer-events:none;
  background-color:var(--phycat-blue);
  opacity:.12;
  -webkit-mask-image:url("data:image/svg+xml,%3Csvg width='30' height='30' viewBox='0 0 30 30' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M0 0h30v30H0z' fill='none'/%3E%3Cpath d='M0 0L15 15M30 0L15 15M0 30L15 15M30 30L15 15' stroke='black' stroke-width='0.4'/%3E%3C/svg%3E");
  -webkit-mask-size:20px 20px;
  -webkit-mask-repeat:repeat;
  mask-image:url("data:image/svg+xml,%3Csvg width='30' height='30' viewBox='0 0 30 30' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M0 0h30v30H0z' fill='none'/%3E%3Cpath d='M0 0L15 15M30 0L15 15M0 30L15 15M30 30L15 15' stroke='black' stroke-width='0.4'/%3E%3C/svg%3E");
  mask-size:20px 20px;
  mask-repeat:repeat;
}
.md-preview p { margin:.65em .6em; color:#333; word-spacing:.08em; }
.md-preview h1,.md-preview h2,.md-preview h3,.md-preview h4,.md-preview h5,.md-preview h6 {
  font-family:inherit;
  font-weight:700;
  line-height:1.45;
}
.md-preview h1 {
  position:relative;
  width:fit-content;
  min-width:120px;
  margin:1.2em auto 1em;
  padding:0 0 12px;
  border:0;
  color:#222;
  text-align:center;
  font-size:1.8em;
}
.md-preview h1::after {
  content:'';
  position:absolute;
  bottom:0;
  left:50%;
  width:42px;
  height:4px;
  border-radius:4px;
  background:linear-gradient(90deg,var(--phycat-light),var(--phycat-blue),var(--phycat-light));
  transform:translateX(-50%);
  transition:width .35s ease;
}
.md-preview h1:hover { color:var(--phycat-blue); }
.md-preview h1:hover::after { width:100%; }
.md-preview h2 {
  width:fit-content;
  margin:1.3em 0 .75em;
  padding:.28em .8em;
  border:0;
  border-radius:8px;
  color:#fff;
  font-size:1.42em;
  background:linear-gradient(90deg,var(--phycat-light),var(--phycat-blue),var(--phycat-light));
  background-size:200% auto;
  box-shadow:0 3px 10px rgba(29,78,137,.18);
  transition:background-position .4s ease,transform .3s ease,box-shadow .3s ease;
}
.md-preview h2:hover { background-position:100% center; transform:translateY(-1px); box-shadow:0 8px 20px rgba(29,78,137,.26); }
.md-preview h3 {
  position:relative;
  width:fit-content;
  margin:1.25em 0 .7em;
  padding-left:13px;
  color:var(--phycat-deep);
  font-size:1.28em;
  transition:padding .25s ease,color .25s ease;
}
.md-preview h3::before {
  content:'';
  position:absolute;
  left:0;
  top:20%;
  width:5px;
  height:60%;
  border-radius:4px;
  background:var(--phycat-blue);
}
.md-preview h3:hover { padding-left:19px; color:var(--phycat-blue); }
.md-preview h4,.md-preview h5,.md-preview h6 { margin:1.2em 0 .55em; color:var(--phycat-deep); }
.md-preview h4::before,.md-preview h5::before {
  content:'';
  display:inline-block;
  width:10px;
  height:10px;
  margin-right:8px;
  border:2px solid var(--phycat-blue);
  border-radius:50%;
  box-sizing:border-box;
}
.md-preview h4::before { background:var(--phycat-blue); }
.md-preview h6::before { content:'—'; margin-right:7px; color:var(--phycat-blue); }
.md-preview strong { color:var(--phycat-blue); font-weight:700; border-bottom:2px solid transparent; }
.md-preview strong:hover { border-bottom-color:var(--phycat-light); }
.md-preview em {
  color:#52606d;
  text-decoration:none;
  background-image:linear-gradient(-45deg,transparent 35%,var(--phycat-light) 35%,var(--phycat-light) 65%,transparent 65%);
  background-position:0 100%;
  background-size:6px 3px;
  background-repeat:repeat-x;
}
.md-preview del { color:#94a3b8; text-decoration-color:var(--phycat-blue); }
.md-preview mark {
  padding:0 .15em;
  color:inherit;
  background:linear-gradient(to top,var(--phycat-pale) 42%,transparent 42%);
}
.md-preview a { color:var(--phycat-deep); text-decoration:none; border-bottom:1px dashed var(--phycat-light); }
.md-preview a:hover { color:var(--phycat-blue); background:var(--phycat-mist); }
.md-preview ul,.md-preview ol { margin:.45em 0 .7em 1em; padding-left:1.35em; }
.md-preview li { margin:.25em 0; }
.md-preview li::marker { color:var(--phycat-deep); font-weight:700; }
.md-preview blockquote {
  position:relative;
  margin:1.1em 0;
  padding:1em 1.2em 1em 3.1em;
  border:0;
  border-radius:16px;
  color:#52606d;
  background:var(--phycat-mist);
  box-shadow:inset 4px 0 0 var(--phycat-light);
}
.md-preview blockquote::before { content:'✨'; position:absolute; left:1em; top:1em; }
.md-preview blockquote p { color:inherit; margin:.25em 0; }
.md-preview hr { margin:2em 0; border:0; border-top:3px dashed var(--phycat-light); opacity:.65; }
.md-preview code {
  padding:.14em .38em;
  border-radius:5px;
  color:#0f3057;
  background:#ebf5fa;
  font-family:CascadiaCode,"Cascadia Code",Consolas,monospace;
}
.md-preview pre {
  position:relative;
  margin:1.1em 0;
  padding:1.1em 1.2em;
  border:1px solid #c9ddeb;
  border-radius:12px;
  color:#eaf3f8;
  background:linear-gradient(145deg,#0f3057,#003153);
  box-shadow:0 8px 22px rgba(0,49,83,.16);
}
.md-preview pre code { padding:0; color:inherit; background:transparent; }
.md-preview table {
  width:100%;
  margin:1.15em 0;
  border-collapse:separate;
  border-spacing:0;
  border:1px solid #c9ddeb;
  border-radius:10px;
  overflow:hidden;
  box-shadow:0 4px 14px rgba(29,78,137,.08);
}
.md-preview th,.md-preview td { padding:.58em .8em; border:0; border-right:1px solid #d8e6ef; border-bottom:1px solid #d8e6ef; }
.md-preview th:last-child,.md-preview td:last-child { border-right:0; }
.md-preview tr:last-child td { border-bottom:0; }
.md-preview th { color:#fff; background:var(--phycat-blue); }
.md-preview tr:nth-child(even) td { background:var(--phycat-mist); }
.md-preview img.md-asset {
  border:1px solid #c9ddeb;
  border-radius:12px;
  box-shadow:0 8px 26px rgba(29,78,137,.18);
}
.md-preview input[type=checkbox] { accent-color:var(--phycat-blue); }
.md-preview .katex-display { overflow-x:auto; overflow-y:hidden; padding:.5em 0; }
.md-preview [data-md-start-line].active { outline:2px solid var(--phycat-light); outline-offset:2px; }
`,
}
