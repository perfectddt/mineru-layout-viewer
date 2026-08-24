from __future__ import annotations

import json
import mimetypes
import os
import secrets
import sys
import tempfile
import threading
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PORT = 18768
TOKEN = secrets.token_urlsafe(24)
STATE_FILE = Path(tempfile.gettempdir()) / "mineru-layout-viewer-server.json"
LAUNCHES: dict[str, Path] = {}


class ViewerHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

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

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        if parsed.path == "/__viewer/identity":
            if not self._authorized(query):
                self._json({"error": "forbidden"}, 403)
                return
            self._json({"app": "mineru-layout-viewer", "pid": os.getpid()})
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
            launch_id = query.get("launch", [""])[0]
            target = LAUNCHES.get(launch_id)
            if not target:
                self.send_error(404)
                return
            relative = query.get("path", [""])[0]
            file_path = target if target.is_file() else (target / relative).resolve()
            if target.is_dir() and target not in file_path.parents:
                self.send_error(403)
                return
            if not file_path.is_file():
                self.send_error(404)
                return
            size = file_path.stat().st_size
            self.send_response(200)
            self.send_header("Content-Type", mimetypes.guess_type(file_path.name)[0] or "application/octet-stream")
            self.send_header("Content-Length", str(size))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            with file_path.open("rb") as source:
                while chunk := source.read(1024 * 1024):
                    self.wfile.write(chunk)
            return
        super().do_GET()

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
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
    server = ThreadingHTTPServer(("127.0.0.1", PORT), ViewerHandler)
    STATE_FILE.write_text(json.dumps({"port": PORT, "token": TOKEN, "pid": os.getpid()}), encoding="utf-8")
    try:
        server.serve_forever()
    finally:
        server.server_close()
        try:
            STATE_FILE.unlink()
        except FileNotFoundError:
            pass


if __name__ == "__main__":
    main()
