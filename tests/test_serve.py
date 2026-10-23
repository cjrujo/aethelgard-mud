import functools
import http.client
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("serve", Path(__file__).resolve().parents[1] / "tools/serve.py")
serve = importlib.util.module_from_spec(spec)
spec.loader.exec_module(serve)


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.tmp.name)
        (cls.root / "index.html").write_text("<title>Aethelgard test</title>")
        (cls.root / "runtime.wasm").write_bytes(b"wasm")
        (cls.root / "runtime.mjs").write_text("export const ok = true;")
        (cls.root / ".private").write_text("not served")
        (cls.root / "folder").mkdir()
        cls.server = serve.make_server(0, cls.root)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(2)
        cls.tmp.cleanup()

    def request(self, path="/", method="GET", body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

    def test_serves_entry_and_mime(self):
        self.assertEqual(self.request()[0], 200)
        self.assertEqual(self.request("/runtime.wasm")[1]["Content-type"], "application/wasm")
        self.assertEqual(self.request("/runtime.mjs")[1]["Content-type"], "text/javascript")

    def test_rejects_foreign_host_and_origin(self):
        self.assertEqual(self.request(headers={"Host": "other.example"})[0], 403)
        self.assertEqual(self.request(headers={"Origin": "https://other.example"})[0], 403)
        origin = "http://127.0.0.1:" + str(self.server.server_port)
        self.assertEqual(self.request(headers={"Origin": origin})[0], 200)

    def test_blocks_hidden_traversal_and_listings(self):
        for path in ["/.private", "/%2e%2e/secret", "/a%5cb", "/C:secret", "/folder/"]:
            with self.subTest(path=path):
                self.assertEqual(self.request(path)[0], 403)

    def test_blocks_symlink(self):
        outside = self.root.parent / (self.root.name + "-outside.txt")
        outside.write_text("outside")
        try:
            (self.root / "link.txt").symlink_to(outside)
            self.assertEqual(self.request("/link.txt")[0], 403)
        finally:
            outside.unlink()

    def test_only_fixed_bridge_operations(self):
        for path in ["/ollama/api/pull", "/ollama/api/tags?target=evil", "/ollama/http://other"]:
            self.assertEqual(self.request(path)[0], 404)
        self.assertEqual(self.request("/ollama/api/pull", "POST", "{}")[0], 404)

    def test_chat_validation(self):
        for data in [{"model": "qwen-cloud", "messages": []}, {"model": "https://evil", "messages": []}, {"model": "local"}]:
            self.assertEqual(self.request("/ollama/api/chat", "POST", json.dumps(data))[0], 400)
        self.assertEqual(self.request("/ollama/api/chat", "POST", "x" * (serve.MAX_CHAT_BYTES + 1))[0], 413)

    def test_chat_forwards_only_fixed_loopback(self):
        class Response:
            status = 200
            chunks = [b'{"message":{"content":"ok"},"done":true}\n', b""]
            def getheader(self, *args): return "application/x-ndjson"
            def read1(self, size): return self.chunks.pop(0)
        class Upstream:
            def __init__(self, host, port, **kwargs):
                self.destination = (host, port)
                captured.append(self)
            def request(self, *args, **kwargs): self.sent = (args, kwargs)
            def getresponse(self): return Response()
            def close(self): pass
        captured = []
        # Save the real client before patching the upstream constructor.
        real = http.client.HTTPConnection
        with patch.object(serve.http.client, "HTTPConnection", side_effect=lambda host, port, **kw: real(host, port, **kw) if port == self.server.server_port else Upstream(host, port, **kw)):
            result = self.request("/ollama/api/chat", "POST", json.dumps({"model": "qwen2.5:0.5b", "messages": [], "stream": True}))
        self.assertEqual(result[0], 200)
        self.assertIn(b'"done":true', result[2])
        self.assertEqual(captured[0].destination, ("127.0.0.1", 11434))
        self.assertEqual(captured[0].sent[0], ("POST", "/api/chat"))


if __name__ == "__main__":
    unittest.main()
