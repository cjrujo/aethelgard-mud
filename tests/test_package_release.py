"""Release integrity tests using tiny explicit mock model/runtime bytes.

The real builder, packager and offline verifier run against temporary projects.
Only the trusted runtime digests are replaced to match these fixture bytes;
these tests do not load models, download assets or verify inference quality.
"""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch
import zipfile

REPO = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("release", REPO / "tools/package_release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class PackageReleaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "project"
        self.root.mkdir()
        for name in release.REQUIRED_FILES:
            self.write(name, (name + "\n").encode())
        for name in release.SOURCE_DIRECTORIES:
            (self.root / name).mkdir(parents=True, exist_ok=True)
        for name in ("src/build_mud_game.py", "tools/prepare_offline.py", "tools/package_release.py"):
            shutil.copyfile(REPO / name, self.root / name)
        self.write("src/game.html", b"<!doctype html><title>fixture</title><!-- AETHELGARD_SCRIPTS -->")
        for name in ("core", "gameplay", "combat", "ai-dm", "online", "bootstrap"):
            self.write(f"src/{name}.js", (f"// fixture {name}\n").encode())
        self.write("src/service-worker.js", b"const build = '__BUILD_ID__';\n")
        self.write("docs/guide.md", b"Release fixture documentation.\n")
        self.write("docs/licenses/third-party.txt", b"Fixture license notice.\n")
        self.write("tests/regression.test.mjs", b"// fixture test\n")
        self.write(".github/workflows/verify.yml", b"name: fixture\n")
        self.write("cloudflare-worker/worker.js", b"// fixture server\n")
        self.write(".gitignore", b"dist-release/\n")
        self.runtime_names = ("transformers.min.js", "ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm")
        self.runtime_hashes = {}
        self.hashes = {}
        for name in self.runtime_names:
            value = ("MOCK RUNTIME " + name).encode()
            self.write("vendor/" + name, value)
            self.runtime_hashes[name] = self.hashes["vendor/" + name] = hashlib.sha256(value).hexdigest()
        self.models = []
        for dtype, weight in (("q8", "model_quantized.onnx"), ("q4", "model_q4.onnx")):
            names = ["config.json", "onnx/" + weight]
            model = {"key": "fixture-" + dtype, "id": "fixture/model", "revision": "a" * 40,
                     "dtype": dtype, "files": names, "sha256": {}}
            for name in names:
                relative = "models/fixture/model/" + name
                value = ("MOCK MODEL " + name).encode()
                self.write(relative, value)
                digest = hashlib.sha256(value).hexdigest()
                self.hashes[relative] = model["sha256"][name] = digest
            self.models.append(model)
        self.registry = {"runtime": "@huggingface/transformers@3.8.1", "models": self.models}
        self.manifest = {"runtime": self.registry["runtime"], "models": copy.deepcopy(self.models), "files": self.hashes.copy()}
        self.write_json("models/registry.json", self.registry)
        self.write_json("models/offline-manifest.json", self.manifest)
        self.original_load = release.load_helper

        def fixture_helper(path, name):
            module = self.original_load(path, name)
            if Path(path).name == "prepare_offline.py":
                module.RUNTIME_SHA256 = self.runtime_hashes.copy()
            return module

        self.helper_patch = patch.object(release, "load_helper", side_effect=fixture_helper)
        self.helper_patch.start()
        self.addCleanup(self.helper_patch.stop)
        self.builder = self.original_load(self.root / "src/build_mud_game.py", "fixture_builder")
        for name, content in self.builder.outputs().items():
            self.write(name, content.encode())
        self.output = Path(self.tmp.name) / "release.zip"

    def write(self, relative, value):
        target = self.root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(value)
        return target

    def write_json(self, relative, value):
        return self.write(relative, (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode())

    def create(self, model=None):
        return release.create_release(self.root, model, self.output)

    def test_source_archive_is_maintainable_clean_and_reproducible(self):
        for name in ("node_modules/private", ".cache/private", ".git/private", "saves/player.json",
                     "src/__pycache__/private.pyc", "docs/.secret", "tests/test-results/private.json"):
            self.write(name, b"DO NOT SHIP")
        result = self.create()
        with zipfile.ZipFile(self.output) as archive:
            names = set(archive.namelist())
            prefix = release.ARCHIVE_ROOT + "/"
            for name in ("index.html", "src/online.js", "docs/guide.md", "docs/licenses/third-party.txt",
                         "tests/regression.test.mjs", ".github/workflows/verify.yml", "cloudflare-worker/worker.js",
                         "tools/serve.py", "tools/prepare_offline.py", "models/registry.json"):
                self.assertIn(prefix + name, names)
            self.assertFalse(any("/vendor/" in n or "/onnx/" in n or n.endswith("offline-manifest.json") for n in names))
            self.assertFalse(any(b"DO NOT SHIP" == archive.read(n) for n in names))
            self.assertEqual(archive.getinfo(prefix + "start_unix.sh").external_attr >> 16 & 0o777, 0o755)
            self.assertEqual(result["files"], len(names))
        first = self.output.read_bytes()
        self.create()
        self.assertEqual(self.output.read_bytes(), first)

    def test_offline_archive_contains_only_selected_quantization_and_verifies_after_extraction(self):
        self.create("fixture-q8")
        with zipfile.ZipFile(self.output) as archive:
            prefix = release.ARCHIVE_ROOT + "/"
            self.assertNotIn(prefix + "models/fixture/model/onnx/model_q4.onnx", archive.namelist())
            selected = json.loads(archive.read(prefix + "models/offline-manifest.json"))
            self.assertEqual([m["key"] for m in selected["models"]], ["fixture-q8"])
            expected = {"vendor/" + name for name in self.runtime_names}
            expected.update("models/fixture/model/" + name for name in self.models[0]["files"])
            self.assertEqual(set(selected["files"]), expected)
            for name in ("models/fixture/model/onnx/model_quantized.onnx", "vendor/ort-wasm-simd-threaded.jsep.wasm"):
                self.assertEqual(archive.getinfo(prefix + name).compress_type, zipfile.ZIP_STORED)
            self.assertEqual(archive.getinfo(prefix + "models/offline-manifest.json").compress_type, zipfile.ZIP_DEFLATED)
            extracted = Path(self.tmp.name) / "extracted"
            archive.extractall(extracted)
        root = extracted / release.ARCHIVE_ROOT
        installer = release.load_helper(root / "tools/prepare_offline.py", "extracted_installer")
        with patch.object(installer.urllib.request, "urlopen", side_effect=AssertionError("No network during packaging")):
            self.assertEqual(installer.verify_manifest(selected, self.registry, root), {"models": 1, "files": 5})

    def test_missing_required_or_stale_generated_game_rejected(self):
        for name in ("assets/ai-worker.js", "start_Windows.cmd", "src/build_mud_game.py"):
            with self.subTest(missing=name):
                path = self.root / name
                contents = path.read_bytes()
                path.unlink()
                with self.assertRaisesRegex(ValueError, "missing"):
                    self.create()
                path.write_bytes(contents)
        self.write("index.html", b"old generated output")
        with self.assertRaisesRegex(ValueError, "stale"):
            self.create()
        self.assertFalse(self.output.exists())

    def test_entire_source_manifest_verified_including_unselected_model(self):
        self.output.write_bytes(b"previous release")
        for name in ("model_q4.onnx", "model_quantized.onnx"):
            with self.subTest(corrupted=name):
                path = self.root / "models/fixture/model/onnx" / name
                previous = path.read_bytes()
                path.write_bytes(b"corrupted")
                with self.assertRaisesRegex(ValueError, "SHA256"):
                    self.create("fixture-q8")
                self.assertEqual(self.output.read_bytes(), b"previous release")
                self.assertEqual(list(self.output.parent.glob("*.part")), [])
                path.write_bytes(previous)

    def test_incomplete_or_mismatched_manifest_and_unknown_model_rejected(self):
        mutations = (
            lambda data: data["files"].pop("vendor/transformers.min.js"),
            lambda data: data["files"].update({"models/unexpected": "a" * 64}),
            lambda data: data["models"][0].update({"dtype": "q4"}),
            lambda data: data.update({"runtime": "other"}),
        )
        for index, mutate in enumerate(mutations):
            with self.subTest(index=index):
                changed = copy.deepcopy(self.manifest)
                mutate(changed)
                self.write_json("models/offline-manifest.json", changed)
                with self.assertRaises(ValueError):
                    self.create("fixture-q8")
        with self.assertRaisesRegex(ValueError, "Model key"):
            self.create("not-in-registry")
        self.assertFalse(self.output.exists())

    def test_symlinks_and_escaping_paths_cannot_enter_release(self):
        for name in ("../outside", "/outside", "a/../../outside", "a\\outside", "C:outside"):
            with self.subTest(path=name), self.assertRaises(ValueError):
                release.checked_file(self.root, name)
        private = Path(self.tmp.name) / "private.txt"
        private.write_bytes(b"private")
        link = self.root / "docs/linked.txt"
        link.symlink_to(private)
        with self.assertRaisesRegex(ValueError, "symbolic"):
            self.create()
        link.unlink()
        runtime = self.root / "vendor/transformers.min.js"
        runtime.unlink()
        runtime.symlink_to(private)
        with self.assertRaisesRegex(ValueError, "Symbolic"):
            self.create("fixture-q8")

    def test_changed_file_during_archive_write_preserves_previous_output(self):
        self.output.write_bytes(b"previous complete archive")
        original = release.write_file

        def corrupt_during_copy(archive, relative, source, expected_hash=None):
            if relative.endswith("onnx/model_quantized.onnx"):
                source.write_bytes(b"changed after manifest verification")
            return original(archive, relative, source, expected_hash)

        with patch.object(release, "write_file", side_effect=corrupt_during_copy):
            with self.assertRaisesRegex(ValueError, "changed during packaging"):
                self.create("fixture-q8")
        self.assertEqual(self.output.read_bytes(), b"previous complete archive")
        self.assertEqual(list(self.output.parent.glob("*.part")), [])


if __name__ == "__main__":
    unittest.main()
