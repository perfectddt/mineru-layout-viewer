import { copyFileSync } from 'node:fs'
import * as esbuild from 'esbuild'

const shared = {
  bundle: true,
  format: 'esm',
  target: 'es2022',
  sourcemap: true,
  external: ['pdfjs-dist', 'jszip'],
}

const watch = process.argv.includes('--watch')

// ESM build — core + web component
const ctx1 = await esbuild.context({
  ...shared,
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.mjs',
})

// IIFE build — auto-registers <mineru-layout-viewer>, all deps bundled
const ctx2 = await esbuild.context({
  entryPoints: ['src/mineru-viewer.ts'],
  outfile: 'dist/mineru-layout-viewer.iife.js',
  bundle: true,
  format: 'iife',
  target: 'es2022',
  globalName: 'MineruViewer',
  sourcemap: true,
  // Bundle pdfjs-dist and jszip into IIFE so <script> tag works standalone
  external: [],
})

const ctx3 = await esbuild.context({
  entryPoints: ['src/match-worker.ts'],
  outfile: 'dist/match-worker.js',
  bundle: true,
  format: 'iife',
  target: 'es2022',
  sourcemap: true,
})

if (watch) {
  await Promise.all([ctx1.watch(), ctx2.watch(), ctx3.watch()])
  console.log('👀 watching...')
} else {
  await Promise.all([ctx1.rebuild(), ctx2.rebuild(), ctx3.rebuild()])
  // index.html loads pdf.js and jszip as plain <script> tags from dist/. Keep the
  // local copies in sync with node_modules so the viewer never depends on a CDN.
  copyFileSync('node_modules/pdfjs-dist/build/pdf.worker.min.js', 'dist/pdf.worker.min.js')
  copyFileSync('node_modules/pdfjs-dist/build/pdf.min.js', 'dist/pdf.min.js')
  copyFileSync('node_modules/jszip/dist/jszip.min.js', 'dist/jszip.min.js')
  console.log('✅ built viewer bundles + dist/match-worker.js')
  await ctx1.dispose()
  await ctx2.dispose()
  await ctx3.dispose()
}
