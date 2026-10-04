import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const serverFile = fileURLToPath(new URL('../viewer-server.py', import.meta.url))

function locate(root, relative) {
  const script = `
import importlib.util, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("viewer_server", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
try:
    print(mod.located_launch_path(Path(sys.argv[2]), sys.argv[3]))
except ValueError as error:
    print("ERR:" + str(error))
`
  const result = spawnSync('python', ['-c', script, serverFile, root, relative], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function locateFile(root, relative) {
  const script = `
import importlib.util, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("viewer_server", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
try:
    found = mod.located_launch_file(Path(sys.argv[2]), sys.argv[3])
    print(found.read_bytes()[:8].decode('latin1'))
except ValueError as error:
    print("ERR:" + str(error))
`
  const result = spawnSync('python', ['-c', script, serverFile, root, relative], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

test('a PDF shortcut inside the result folder opens its real file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mineru-pdf-link-'))
  const outside = mkdtempSync(join(tmpdir(), 'mineru-pdf-real-'))
  const notes = join(directory, 'notes')
  mkdirSync(notes)
  writeFileSync(join(outside, 'book.pdf'), '%PDF-1.4 real')
  writeFileSync(join(outside, 'secret.pdf'), '%PDF-1.4 secret')
  symlinkSync(join(outside, 'book.pdf'), join(notes, 'book_origin.pdf'))
  symlinkSync(outside, join(notes, 'escape'), 'dir')

  assert.equal(locateFile(notes, 'book_origin.pdf'), '%PDF-1.4')
  assert.equal(locateFile(notes, 'escape/secret.pdf'), 'ERR:path-not-allowed')
  assert.equal(locateFile(notes, '../book.pdf'), 'ERR:path-not-allowed')
})

test('reveal stays inside the launched file or folder', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mineru-reveal-'))
  const nested = join(directory, 'notes')
  mkdirSync(nested)
  writeFileSync(join(nested, 'chapter.md'), '# chapter\n')
  const single = join(directory, 'alone.md')
  writeFileSync(single, '# alone\n')

  assert.match(locate(directory, 'notes/chapter.md'), /\\notes\\chapter\.md$/i)
  assert.match(locate(directory, ''), new RegExp(`${directory.split(/[\\/]/).pop()}$`, 'i'))
  assert.match(locate(single, ''), /\\alone\.md$/i)
  assert.match(locate(directory, '../outside.md'), /^ERR:path-not-allowed$/)
  assert.match(locate(single, 'other.md'), /^ERR:path-not-allowed$/)
  assert.match(locate(directory, 'missing.md'), /^ERR:path-not-found$/)
})

test('a standalone Markdown file serves sibling images next to it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mineru-sibling-'))
  const single = join(directory, 'alone.md')
  writeFileSync(single, '# alone\n')
  mkdirSync(join(directory, 'imgs'))
  writeFileSync(join(directory, 'imgs', 'pic.gif'), 'GIF89axx')
  writeFileSync(join(directory, 'pic.txt'), 'not an image')

  assert.equal(locateFile(single, 'imgs/pic.gif'), 'GIF89axx')
  assert.equal(locateFile(single, ''), '# alone')
  assert.equal(locateFile(single, 'pic.txt'), 'ERR:path-not-allowed')
  assert.equal(locateFile(single, 'missing.gif'), 'ERR:path-not-found')
  assert.equal(locateFile(single, '../alone.md'), 'ERR:path-not-allowed')
})
