import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("offline", Path(__file__).resolve().parents[1] / "tools/prepare_offline.py")
offline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(offline)


class OfflineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.model = {"key": "test", "id": "test/model", "revision": "a" * 40, "dtype": "q8", "files": ["config.json", "onnx/model_quantized.onnx"]}
        self.registry = {"runtime": offline.RUNTIME, "models": [self.model]}
        names = ["vendor/" + x for x in offline.RUNTIME_FILES] + ["models/test/model/" + x for x in self.model["files"]]
        hashes = {}
        for name in names:
            file = self.root / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(name.encode())
            hashes[name] = offline.sha256(file)
        self.runtime_patch = patch.object(offline, "RUNTIME_SHA256", {x: hashes["vendor/" + x] for x in offline.RUNTIME_FILES})
        self.runtime_patch.start()
        self.manifest = {"runtime": offline.RUNTIME, "models": [copy.deepcopy(self.model)], "files": hashes}

    def tearDown(self):
        self.runtime_patch.stop()
        self.tmp.cleanup()

    def verify(self, manifest=None):
        return offline.verify_manifest(manifest or self.manifest, self.registry, self.root)

    def test_valid_manifest_needs_no_network(self):
        with patch.object(offline.urllib.request, "urlopen", side_effect=AssertionError("Network must not be called")):
            self.assertEqual(self.verify(), {"models": 1, "files": 5})

    def test_corrupted_file_rejected(self):
        (self.root / "models/test/model/config.json").write_text("changed")
        with self.assertRaisesRegex(ValueError, "SHA256"):
            self.verify()

    def test_wrong_runtime_rejected(self):
        self.manifest["runtime"] = "other"
        with self.assertRaisesRegex(ValueError, "runtime"):
            self.verify()

    def test_wrong_dtype_revision_and_files_rejected(self):
        for field, value in [("dtype", "q4"), ("revision", "b" * 40), ("files", ["other"])]:
            bad = copy.deepcopy(self.manifest)
            bad["models"][0][field] = value
            with self.assertRaisesRegex(ValueError, "identity/files"):
                self.verify(bad)

    def test_missing_unexpected_and_duplicate_files_rejected(self):
        for edit in [lambda m: m["files"].pop("vendor/transformers.min.js"), lambda m: m["files"].update({"outside": "a" * 64}), lambda m: m["models"].append(m["models"][0])]:
            bad = copy.deepcopy(self.manifest)
            edit(bad)
            with self.assertRaises(ValueError): self.verify(bad)

    def test_trusted_hash_cannot_be_replaced_by_manifest(self):
        name = "onnx/model_quantized.onnx"
        self.model["sha256"] = {name: "f" * 64}
        with self.assertRaisesRegex(ValueError, "pinned SHA256"):
            self.verify()

    def test_paths_and_symlinks_rejected(self):
        for name in ["../a", "/a", "a/../../b", "a\\b", "C:a", ".private"]:
            with self.assertRaises(ValueError): offline.safe_file(self.root, name)
        target = self.root / "models/test/model/config.json"
        target.unlink()
        target.symlink_to(self.root / "vendor/transformers.min.js")
        with self.assertRaisesRegex(ValueError, "Symbolic"):
            self.verify()

    def test_bad_download_is_atomic(self):
        source = self.root / "incoming"
        source.write_bytes(b"wrong")
        destination = self.root / "saved"
        destination.write_bytes(b"old")
        with self.assertRaisesRegex(ValueError, "pinned SHA256"):
            offline.download_file("https://example.test/file", destination, "a" * 64, local_source=source)
        self.assertEqual(destination.read_bytes(), b"old")
        self.assertEqual(list(self.root.glob("*.part")), [])

    def test_valid_download_receipt_and_reuse(self):
        source = self.root / "incoming"
        source.write_bytes(b"valid data")
        destination = self.root / "saved"
        expected = hashlib.sha256(b"valid data").hexdigest()
        result = offline.download_file("https://example.test/file", destination, expected, 10, local_source=source)
        self.assertEqual(result, expected)
        with patch.object(offline.urllib.request, "urlopen", side_effect=AssertionError("Already downloaded")):
            self.assertEqual(offline.download_file("https://example.test/file", destination, expected), expected)
        self.assertEqual(json.loads(destination.with_name("saved.download.json").read_text())["bytes"], 10)

    def test_mutable_model_revision_rejected(self):
        self.model["revision"] = "main"
        with self.assertRaisesRegex(ValueError, "immutable"):
            self.verify()


if __name__ == "__main__":
    unittest.main()
