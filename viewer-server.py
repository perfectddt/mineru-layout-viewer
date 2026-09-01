from __future__ import annotations

import json
import mimetypes
import os
import secrets
import re
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

    def _launch_file(self, query: dict[str, list[str]]) -> Path | None:
        target = LAUNCHES.get(query.get("launch", [""])[0])
        if not target:
            return None
        relative = query.get("path", [""])[0]
        file_path = target if target.is_file() else (target / relative).resolve()
        if target.is_dir() and target not in file_path.parents:
            return None
        return file_path if file_path.is_file() else None

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
