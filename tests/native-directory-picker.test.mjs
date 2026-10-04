import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('native directory picker authenticates, cancels, and keeps linked PDFs in the manifest', () => {
  const script = `
import importlib.util, sys, threading, tempfile, json, http.client
from pathlib import Path
spec = importlib.util.spec_from_file_location('viewer_server', sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
server = mod.ViewerServer(('127.0.0.1', 0), mod.ViewerHandler)
threading.Thread(target=server.serve_forever, daemon=True).start()
calls = []
selected = ''
def picker():
    calls.append(True)
    return selected
mod.choose_native_directory = picker
def request(path, method='POST', headers=None):
    conn = http.client.HTTPConnection('127.0.0.1', server.server_port)
    conn.request(method, path, headers=headers or {})
    response = conn.getresponse()
    data = json.loads(response.read())
    conn.close()
    return response.status, data
try:
    status, data = request('/__viewer/choose-directory?token=bad')
    assert status == 403 and calls == []
    path = '/__viewer/choose-directory?token=' + mod.TOKEN
    status, data = request(path, headers={'Origin': 'http://evil.example'})
    assert status == 403 and calls == []
    status, data = request(path + '&path=C:/ignored')
    assert status == 200 and data == {'cancelled': True} and len(calls) == 1
    mod.DIRECTORY_PICKER_LOCK.acquire()
    try:
        status, data = request(path)
        assert status == 409 and len(calls) == 1
    finally:
        mod.DIRECTORY_PICKER_LOCK.release()
    folder = Path(tempfile.mkdtemp(prefix='mineru-native-picker-'))
    outside = Path(tempfile.mkdtemp(prefix='mineru-native-pdf-')) / 'original.pdf'
    outside.write_bytes(b'%PDF-1.4 native')
    (folder / 'book_origin.pdf').symlink_to(outside)
    (folder / 'full.md').write_text('# notes', encoding='utf-8')
    selected = str(folder)
    status, data = request(path)
    assert status == 200 and data['kind'] == 'directory'
    query = data['url'].split('?', 1)[1]
    status, manifest = request('/__viewer/manifest?' + query, 'GET')
    assert status == 200 and 'book_origin.pdf' in manifest['files']
    launch = next(value for value in mod.LAUNCHES.values())
    assert mod.located_launch_file(launch, 'book_origin.pdf').read_bytes() == outside.read_bytes()
    print('picker regression checks passed')
finally:
    server.shutdown()
    server.server_close()
`
  const result = spawnSync('python', ['-c', script, fileURLToPath(new URL('../viewer-server.py', import.meta.url))], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /picker regression checks passed/)
})
