from __future__ import annotations

import json
import mimetypes
import os
import secrets
import re
import subprocess
import sys
import tempfile
import threading
import urllib.parse
import argparse
import errno
import socket
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PREFERRED_PORT = 18768
TOKEN = secrets.token_urlsafe(24)
STATE_FILE = Path(tempfile.gettempdir()) / "mineru-layout-viewer-server.json"
LAUNCHES: dict[str, Path] = {}
DIRECTORY_PICKER_LOCK = threading.Lock()
SHELL_INTEGRATION_LOCK = threading.Lock()


def shell_integration_status() -> dict:
    if sys.platform != 'win32':
        return {"supported": False, "enabled": False}
    import winreg
    enabled = False
    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        try:
            with winreg.OpenKey(hive, r'Software\Classes\Directory\shell\MinerULayoutViewer.Open') as key:
                try:
                    winreg.QueryValueEx(key, 'LegacyDisable')
                except FileNotFoundError:
                    enabled = True
        except FileNotFoundError:
            pass
    return {"supported": True, "enabled": enabled}


def choose_native_directory() -> str:
    """Run Tk on a subprocess main thread, independent of HTTP worker threads."""
    script = """
import json
import tkinter as tk
from tkinter import filedialog
root = tk.Tk()
root.title('MinerU 文件夹选择')
root.geometry('420x100')
root.resizable(False, False)
root.attributes('-topmost', True)
tk.Label(root, text='请在目录对话框中选择 MinerU 结果文件夹。', padx=20, pady=25).pack()
root.update_idletasks()
root.geometry('+%d+%d' % ((root.winfo_screenwidth() - 420) // 2, (root.winfo_screenheight() - 100) // 2))
root.update()
try:
    selected = filedialog.askdirectory(parent=root, title='选择 MinerU 结果文件夹', mustexist=True)
    print(json.dumps(selected, ensure_ascii=True))
finally:
    root.destroy()
"""
    result = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    if result.returncode:
        raise RuntimeError("native-directory-picker-unavailable")
    return json.loads(result.stdout)


def located_launch_path(root: Path, relative: str) -> Path:
    """Resolve a file inside a launched file or directory. Rejects paths outside that root."""
    root = root.resolve()
    relative = relative.replace("\\", "/").strip().lstrip("/")
    if any(part == ".." for part in relative.split("/")):
        raise ValueError("path-not-allowed")
    if root.is_file():
        if relative:
            raise ValueError("path-not-allowed")
        return root
    if not relative:
        return root
    candidate = (root / relative).resolve()
    if candidate != root and root not in candidate.parents:
        raise ValueError("path-not-allowed")
    if not candidate.exists():
        raise ValueError("path-not-found")
    return candidate


def located_launch_file(root: Path, relative: str) -> Path:
    """Open one launched file. A symlink file inside the folder may point at a PDF stored elsewhere.

    A launched file also resolves sibling paths next to it (read-only) so a
    standalone Markdown file can load images stored beside it, e.g. imgs/.
    """
    root = root.resolve()
    relative = relative.replace("\\", "/").strip().lstrip("/")
    if root.is_file():
        # No relative path means "the launched file itself".
        if not relative:
            return root
        parts = relative.split("/")
        if any(part in ("", ".", "..") for part in parts):
            raise ValueError("path-not-allowed")
        candidate = (root.parent / relative).resolve()
        if root.parent not in candidate.parents:
            raise ValueError("path-not-allowed")
        if not re.search(r"\.(?:png|jpe?g|gif|webp|bmp|svg|avif|tiff?)$", relative, re.IGNORECASE):
            raise ValueError("path-not-allowed")
        if not candidate.is_file():
            raise ValueError("path-not-found")
        return candidate
    parts = relative.split("/")
    if not relative or any(part in ("", ".", "..") for part in parts):
        raise ValueError("path-not-allowed")
    current = root
    for index, part in enumerate(parts):
        current = current / part
        is_last = index == len(parts) - 1
        if is_last and current.is_symlink():
            if not current.is_file():
                raise ValueError("path-not-found")
            return current
        if not current.exists():
            raise ValueError("path-not-found")
        resolved = current.resolve()
        if resolved != root and root not in resolved.parents:
            raise ValueError("path-not-allowed")
        current = resolved
    if not current.is_file():
        raise ValueError("path-not-found")
    return current


def open_containing_folder(path: Path) -> None:
    """Open the system file manager. A file is selected; a directory is opened."""
    if os.name == "nt":
        if path.is_dir():
            subprocess.Popen(["explorer", str(path)])
        else:
            subprocess.Popen(["explorer", f"/select,{path}"])
        return
    if sys.platform == "darwin":
        subprocess.Popen(["open", "-R", str(path)] if path.is_file() else ["open", str(path)])
        return
    folder = path if path.is_dir() else path.parent
    subprocess.Popen(["xdg-open", str(folder)])


class ViewerServer(ThreadingHTTPServer):
    allow_reuse_address = False

    def server_bind(self) -> None:
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


class ViewerHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self) -> None:
        # This is a local development/editor server. Always revalidate UI
        # assets so an already-used browser does not keep an older viewer
        # bundle after the source has been rebuilt.
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def _json(self, data: object, status: int = 200) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self, query: dict[str, list[str]]) -> bool:
        return secrets.compare_digest(query.get("token", [""])[0], TOKEN)

    def _launch_line(self, query: dict[str, list[str]]) -> int | None:
        raw = query.get("line", [""])[0].strip()
        if not re.fullmatch(r"[1-9]\d{0,7}", raw):
            return None
        return int(raw)

    def _launch_file(self, query: dict[str, list[str]]) -> Path | None:
        target = LAUNCHES.get(query.get("launch", [""])[0])
        if not target:
            return None
        try:
            return located_launch_file(target, query.get("path", [""])[0])
        except ValueError:
            return None

    def _serve_local_file(self, file_path: Path, include_body: bool = True) -> None:
        size = file_path.stat().st_size
        start, end = 0, max(0, size - 1)
        partial = False
        range_header = self.headers.get("Range", "")
        if range_header:
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header.strip())
            if not match:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            first, last = match.groups()
            if first:
                start = int(first)
                end = min(int(last), size - 1) if last else size - 1
            elif last:
                length = min(int(last), size)
                start, end = size - length, size - 1
            if start >= size or start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            partial = True

        length = max(0, end - start + 1)
        self.send_response(206 if partial else 200)
        self.send_header("Content-Type", mimetypes.guess_type(file_path.name)[0] or "application/octet-stream")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if not include_body:
            return
        with file_path.open("rb") as source:
            source.seek(start)
            remaining = length
            while remaining:
                chunk = source.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        if parsed.path == "/__viewer/identity":
            if not self._authorized(query):
                self._json({"error": "forbidden"}, 403)
                return
            self._json({"app": "mineru-layout-viewer", "pid": os.getpid()})
            return
        if parsed.path == "/__viewer/shell-integration":
            if not self._authorized(query):
                self._json({"error": "forbidden"}, 403)
                return
            self._json(shell_integration_status())
            return
        if parsed.path == "/__viewer/open":
            if not self._authorized(query):
                self._json({"error": "forbidden"}, 403)
                return
            target = Path(query.get("path", [""])[0]).resolve()
            if not target.exists():
                self._json({"error": "path-not-found"}, 404)
                return
            launch_id = secrets.token_urlsafe(16)
            LAUNCHES[launch_id] = target
            url = f"/?launch={urllib.parse.quote(launch_id)}&token={urllib.parse.quote(TOKEN)}"
            line = self._launch_line(query)
            if line is not None:
                url += f"&line={line}"
            self._json({"url": url, "kind": "directory" if target.is_dir() else "file"})
            return
        if parsed.path == "/__viewer/manifest":
            if not self._authorized(query):
                self._json({"error": "forbidden"}, 403)
                return
            launch_id = query.get("launch", [""])[0]
            target = LAUNCHES.get(launch_id)
            if not target:
                self._json({"error": "unknown-launch"}, 404)
                return
            if target.is_file():
                self._json({"kind": "file", "name": target.name, "path": str(target)})
            else:
                files = [p.relative_to(target).as_posix() for p in target.rglob("*") if p.is_file()]
                self._json({"kind": "directory", "name": target.name, "path": str(target), "files": files})
            return
        if parsed.path == "/__viewer/file":
            if not self._authorized(query):
                self.send_error(403)
                return
            file_path = self._launch_file(query)
            if not file_path:
                self.send_error(404)
                return
            self._serve_local_file(file_path)
            return
        super().do_GET()

    def do_HEAD(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        if parsed.path == "/__viewer/file":
            if not self._authorized(query):
                self.send_error(403)
                return
            file_path = self._launch_file(query)
            if not file_path:
                self.send_error(404)
                return
            self._serve_local_file(file_path, include_body=False)
            return
        super().do_HEAD()

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        if parsed.path == "/__viewer/shell-integration":
            if not self._authorized(query):
                self._json({"error": "forbidden"}, 403)
                return
            origin = self.headers.get('Origin')
            if (origin and origin != f"http://{self.headers.get('Host', '')}") or self.headers.get('Sec-Fetch-Site') == 'cross-site':
                self._json({"error": "origin-not-allowed"}, 403)
                return
            if sys.platform != 'win32':
                self._json({"error": "仅 Windows 本地服务支持右键集成"}, 400)
                return
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if length < 1 or length > 1024:
                    raise ValueError('invalid-body')
                enabled = json.loads(self.rfile.read(length)).get('enabled')
                if not isinstance(enabled, bool):
                    raise ValueError('invalid-enabled')
            except (ValueError, AttributeError):
                self._json({"error": "invalid-body"}, 400)
                return
            with SHELL_INTEGRATION_LOCK:
                command = [str(Path(os.environ['WINDIR']) / 'System32/WindowsPowerShell/v1.0/powershell.exe'), '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(ROOT / 'install-windows-integration.ps1'), '-ShellIntegrationOnly']
                if not enabled:
                    command.append('-DisableShellIntegration')
                try:
                    result = subprocess.run(command, capture_output=True, timeout=45, creationflags=subprocess.CREATE_NO_WINDOW)
                    if result.returncode:
                        self._json({"error": "设置失败，请以管理员身份启动查看器后重试"}, 500)
                        return
                    self._json(shell_integration_status())
                except (OSError, subprocess.TimeoutExpired):
                    self._json({"error": "右键集成设置失败，请重试"}, 500)
            return
        if parsed.path == "/__viewer/choose-directory":
            if not self._authorized(query):
                self._json({"error": "forbidden"}, 403)
                return
            origin = self.headers.get("Origin")
            expected_origin = f"http://{self.headers.get('Host', '')}"
            if (origin and origin != expected_origin) or self.headers.get("Sec-Fetch-Site") == "cross-site":
                self._json({"error": "origin-not-allowed"}, 403)
                return
            if not DIRECTORY_PICKER_LOCK.acquire(blocking=False):
                self._json({"error": "directory-picker-busy"}, 409)
                return
            try:
                selected = choose_native_directory()
                if not selected:
                    self._json({"cancelled": True})
                    return
                target = Path(selected).resolve()
                if not target.is_dir():
                    self._json({"error": "directory-not-found"}, 404)
                    return
                launch_id = secrets.token_urlsafe(16)
                LAUNCHES[launch_id] = target
                url = f"/?launch={urllib.parse.quote(launch_id)}&token={urllib.parse.quote(TOKEN)}"
                self._json({"url": url, "kind": "directory"})
            except Exception:
                self._json({"error": "native-directory-picker-unavailable"}, 500)
            finally:
                DIRECTORY_PICKER_LOCK.release()
            return
        if parsed.path == "/__viewer/reveal":
            if not self._authorized(query):
                self._json({"error": "forbidden"}, 403)
                return
            target = LAUNCHES.get(query.get("launch", [""])[0])
            if not target:
                self._json({"error": "unknown-launch"}, 404)
                return
            try:
                located = located_launch_path(target, query.get("path", [""])[0])
            except ValueError as error:
                status = 404 if str(error) == "path-not-found" else 400
                self._json({"error": str(error)}, status)
                return
            open_containing_folder(located)
            self._json({"opened": True, "path": str(located)})
            return
        if parsed.path != "/__viewer/save" or not self._authorized(query):
            self._json({"error": "forbidden"}, 403)
            return
        launch_id = query.get("launch", [""])[0]
        target = LAUNCHES.get(launch_id)
        if not target or not target.is_file() or target.suffix.lower() not in {".md", ".markdown", ".org"}:
            self._json({"error": "not-writable"}, 400)
            return
        length = int(self.headers.get("Content-Length", "0"))
        content = self.rfile.read(length)
        temporary = target.with_name(f".{target.name}.{secrets.token_hex(6)}.tmp")
        try:
            temporary.write_bytes(content)
            os.replace(temporary, target)
        finally:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass
        self._json({"saved": True, "bytes": len(content)})


def main() -> None:
    parser = argparse.ArgumentParser(description="MinerU Layout Viewer local server")
    parser.add_argument("--port", type=int, default=PREFERRED_PORT)
    args = parser.parse_args()
    try:
        server = ViewerServer(("127.0.0.1", args.port), ViewerHandler)
    except OSError as error:
        address_in_use = error.errno in {errno.EADDRINUSE, 10048} or getattr(error, "winerror", None) == 10048
        if not address_in_use or args.port == 0:
            raise
        server = ViewerServer(("127.0.0.1", 0), ViewerHandler)
    actual_port = int(server.server_address[1])
    state_data = {"port": actual_port, "token": TOKEN, "pid": os.getpid()}
    state_temporary = STATE_FILE.with_name(f".{STATE_FILE.name}.{os.getpid()}.tmp")
    state_temporary.write_text(
        json.dumps(state_data),
        encoding="utf-8",
    )
    os.replace(state_temporary, STATE_FILE)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        try:
            current_state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
            if current_state.get("pid") == os.getpid() and current_state.get("token") == TOKEN:
                STATE_FILE.unlink()
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            pass


if __name__ == "__main__":
    main()
