#!/usr/bin/env python3
"""Serve Aethelgard on this computer, with a fixed local Ollama bridge."""
from __future__ import annotations
import argparse
import http.client
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path, PurePosixPath
import re
import threading
from urllib.parse import unquote, urlsplit
import webbrowser

ROOT = Path(__file__).resolve().parent.parent
LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}
OLLAMA_HOST, OLLAMA_PORT = "127.0.0.1", 11434
MAX_CHAT_BYTES = 64 * 1024


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                      ".mjs": "text/javascript", ".js": "text/javascript",
                      ".wasm": "application/wasm", ".onnx": "application/octet-stream",
                      ".json": "application/json"}

    def __init__(self, *args, directory=None, **kwargs):
        self.root = Path(directory or ROOT).resolve()
        super().__init__(*args, directory=str(self.root), **kwargs)

    def local_request(self):
        authority = self.headers.get("Host", "")
        try:
            parsed = urlsplit("http://" + authority)
            if (parsed.hostname not in LOCAL_HOSTS or parsed.username or parsed.password
                    or parsed.path or parsed.query or parsed.fragment
                    or parsed.port != self.server.server_port):
                raise ValueError("Invalid host")
        except ValueError:
            self.send_error(403, "Use the localhost URL printed by the launcher")
            return False
        origin = self.headers.get("Origin")
        if origin is not None and origin != "http://" + authority:
            self.send_error(403, "Requests must come from this game origin")
            return False
        return True

    def safe_path(self):
        path = unquote(urlsplit(self.path).path)
        parts = PurePosixPath(path).parts
        if ("\\" in path or ":" in path or any(ord(c) < 32 for c in path)
                or any(p in {"..", "node_modules", "test-results", "saves", "savegames"}
                       or p.startswith(".") for p in parts if p != "/")):
            return None
        target = self.root / path.lstrip("/")
        if not target.resolve().is_relative_to(self.root):
            return None
        cursor = target
        while cursor != self.root:
            if cursor.is_symlink():
                return None
            cursor = cursor.parent
        return target

    def list_directory(self, path):
        self.send_error(403, "Directory listing is disabled")
        return None

    def translate_path(self, path):
        target = self.safe_path()
        return str(target or self.root / "__forbidden__")

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()

    def do_GET(self):
        if not self.local_request():
            return
        path = urlsplit(self.path).path
        if path.startswith("/ollama/"):
            if path != "/ollama/api/tags" or urlsplit(self.path).query:
                self.send_error(404, "Unsupported Ollama operation")
                return
            self.proxy_ollama("GET", "/api/tags")
            return
        if self.safe_path() is None:
            self.send_error(403, "Forbidden path")
            return
        super().do_GET()

    def do_HEAD(self):
        if not self.local_request():
            return
        if self.safe_path() is None or self.path.startswith("/ollama/"):
            self.send_error(403, "Forbidden path")
            return
        super().do_HEAD()

    def do_POST(self):
        if not self.local_request():
            return
        if self.path != "/ollama/api/chat":
            self.send_error(404, "Unsupported operation")
            return
        try:
            length = int(self.headers.get("Content-Length", "-1"))
            if length <= 0 or length > MAX_CHAT_BYTES or self.headers.get("Transfer-Encoding"):
                self.send_error(413, "Chat request must be at most 64 KiB")
                return
            data = json.loads(self.rfile.read(length))
            model = data.get("model", "")
            if not isinstance(model, str) or not model.strip() or re.search(r"cloud|://", model, re.I):
                raise ValueError("Select an installed local model")
            if not isinstance(data.get("messages"), list):
                raise ValueError("Missing messages")
        except (ValueError, AttributeError, UnicodeDecodeError):
            self.send_error(400, "Invalid local chat request")
            return
        self.proxy_ollama("POST", "/api/chat", json.dumps(data).encode())

    def proxy_ollama(self, method, path, payload=None):
        connection = http.client.HTTPConnection(OLLAMA_HOST, OLLAMA_PORT, timeout=240)
        started = False
        try:
            connection.request(method, path, body=payload,
                               headers={"Content-Type": "application/json"} if payload else {})
            response = connection.getresponse()
            self.send_response(response.status)
            self.send_header("Content-Type", response.getheader("Content-Type", "application/json"))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            started = True
            self.close_connection = True
            while chunk := response.read1(65536):
                self.wfile.write(chunk)
                self.wfile.flush()
        except (OSError, http.client.HTTPException):
            if not started:
                self.send_error(502, "Ollama is unavailable at 127.0.0.1:11434")
        finally:
            connection.close()


def make_server(port=8765, directory=None):
    def handler(*args, **kwargs):
        return Handler(*args, directory=directory, **kwargs)
    return ThreadingHTTPServer(("127.0.0.1", port), handler)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--open", action="store_true", dest="open_browser")
    args = parser.parse_args()
    server = make_server(args.port)
    url = f"http://127.0.0.1:{server.server_port}/"
    print(f"Aethelgard v10: {url}\nKeep this window open. Press Ctrl+C to stop.", flush=True)
    if args.open_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
