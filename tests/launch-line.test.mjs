import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../start-viewer.ps1', import.meta.url))

function launch(args, line = 0) {
  const quoted = args.map(value => `'${String(value).replaceAll("'", "''")}'`).join(',')
  const command = [
    `. '${script.replaceAll("'", "''")}'`,
    `$result = Resolve-ViewerLaunch -Arguments @(${quoted}) -Line ${line}`,
    'if ($null -eq $result.Line) { $result.Line = 0 }',
    'Write-Output ("{0}|{1}" -f $result.Path, $result.Line)',
  ].join('; ')
  return execFileSync('powershell.exe', ['-NoProfile', '-Command', command], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

test('launcher reads an explicit line without treating a drive letter as one', () => {
  assert.equal(launch(['D:\\notes\\file.md']), 'D:\\notes\\file.md|0')
  assert.equal(launch(['D:\\notes\\file.md', '+120']), 'D:\\notes\\file.md|120')
  assert.equal(launch(['+15', 'D:\\notes\\file.org']), 'D:\\notes\\file.org|15')
  assert.equal(launch(['--line', '8', 'D:\\notes\\file.md']), 'D:\\notes\\file.md|8')
  assert.equal(launch(['D:\\notes\\file.md'], 4), 'D:\\notes\\file.md|4')
  assert.equal(launch(['D:\\notes\\file.md', '+9'], 4), 'D:\\notes\\file.md|4')
})

test('launcher splits a trailing :line only when that file exists', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mineru-launch-'))
  const file = join(directory, 'notes.md')
  writeFileSync(file, 'one\ntwo\nthree\n')
  try {
    assert.equal(launch([`${file}:2`]), `${file}|2`)
    assert.equal(launch([`${file}:2:5`]), `${file}|2`)
    assert.equal(launch([`${file}:3`, '+9']), `${file}|9`)
    assert.equal(launch(['D:\\missing\\notes.md:7']), 'D:\\missing\\notes.md:7|0')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('launcher rejects a missing line number', () => {
  assert.throws(() => launch(['--line']), /positive line number/i)
})

// The tests above call Resolve-ViewerLaunch directly and therefore never touch the
// script's own param() block. That block used to bind a bare positional argument to
// -Line (an [int]), so "start-viewer.cmd notes.md +208" failed with
// "Cannot convert value ... to type System.Int32" before any parsing happened.
// Run the real param block in isolation to keep that fixed.
function extractParamBlock(source) {
  const lines = source.split(/\r?\n/)
  const start = lines.findIndex(line => line.trim() === 'param(')
  assert.notEqual(start, -1, 'start-viewer.ps1 must declare a param() block')
  const end = lines.findIndex((line, index) => index > start && line.trim() === ')')
  assert.notEqual(end, -1, 'start-viewer.ps1 param() block must be closed')
  return lines.slice(start, end + 1).join('\n')
}

function bind(args) {
  const directory = mkdtempSync(join(tmpdir(), 'mineru-bind-'))
  const probe = join(directory, 'bind-probe.ps1')
  const source = readFileSync(script, 'utf8')
  writeFileSync(probe, `${extractParamBlock(source)}
Write-Output ("{0}|{1}|{2}" -f $NoOpen, $Line, (($Paths | Where-Object { $_ }) -join '~'))
`)
  try {
    const stdout = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', probe, ...args],
      { encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim()
    return { ok: true, value: stdout }
  } catch (error) {
    return { ok: false, value: `${error.stderr || ''}${error.stdout || ''}` }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('launcher binds a bare positional path to -Paths, not to -Line', () => {
  assert.deepEqual(bind(['D:\\notes\\file.md']), { ok: true, value: 'False|0|D:\\notes\\file.md' })
  assert.deepEqual(bind(['D:\\notes\\file.md', '+208']), {
    ok: true,
    value: 'False|0|D:\\notes\\file.md~+208',
  })
  assert.deepEqual(bind(['+208', 'D:\\notes\\file.md']), {
    ok: true,
    value: 'False|0|+208~D:\\notes\\file.md',
  })
  assert.deepEqual(bind(['D:\\notes\\file.md:208']), {
    ok: true,
    value: 'False|0|D:\\notes\\file.md:208',
  })
})

test('launcher still binds named line arguments and -NoOpen', () => {
  const named = 'True|208|D:\\notes\\file.md'
  for (const flag of ['--line', '-line', '-g', '--goto', '-Line']) {
    assert.deepEqual(bind(['-NoOpen', flag, '208', 'D:\\notes\\file.md']), { ok: true, value: named })
  }
  assert.deepEqual(bind(['-NoOpen', 'D:\\notes\\file.md', '+208']), {
    ok: true,
    value: 'True|0|D:\\notes\\file.md~+208',
  })
})

// A wrong path used to surface as the backend's bare `path-not-found`, and under
// Windows PowerShell as "The given path's format is not supported" when the
// argument still carried a ":line" suffix. Both now name the missing path.
function resolveExisting(target) {
  const quoted = String(target).replaceAll("'", "''")
  const command = [
    `. '${script.replaceAll("'", "''")}'`,
    `try { Write-Output ("OK|" + (Resolve-ExistingPath -Path '${quoted}')) } catch { Write-Output ("ERR|" + $_.Exception.Message) }`,
  ].join('; ')
  return execFileSync('powershell.exe', ['-NoProfile', '-Command', command], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

test('launcher accepts an existing file or folder', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mineru-existing-'))
  const file = join(directory, 'notes.md')
  writeFileSync(file, 'one\n')
  try {
    for (const target of [file, directory]) {
      // The resolved path is normalized (an 8.3 name such as ADMINI~1 becomes the
      // long form), so assert on what matters: it resolved and it exists.
      const result = resolveExisting(target)
      assert.match(result, /^OK\|/, result)
      const resolved = result.slice(3)
      assert.equal(existsSync(resolved), true, `resolved path must exist: ${resolved}`)
      assert.ok(resolved.toLowerCase().endsWith(target.split('\\').pop().toLowerCase()))
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('launcher names a missing path instead of reporting path-not-found', () => {
  const missing = resolveExisting('D:\\missing\\notes.md')
  assert.match(missing, /^ERR\|/, 'a missing path must fail')
  assert.match(missing, /D:\\missing\\notes\.md/, 'the missing path must be named')

  const suffixed = resolveExisting('D:\\missing\\notes.md:7')
  assert.match(suffixed, /^ERR\|/)
  assert.match(suffixed, /D:\\missing\\notes\.md(?!:7)/, 'the base path must be named without the suffix')
  assert.match(suffixed, /:7/, 'the ignored suffix must be explained')
})
