#!/usr/bin/env python3
"""Download pinned model/runtime files, or verify a complete offline package."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
RUNTIME = "@huggingface/transformers@3.8.1"
RUNTIME_FILES = ("transformers.min.js", "ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm")
RUNTIME_SHA256 = {
    "transformers.min.js": "aa5002b70e789798da263f5f99c62bd3e8fcd0c119258a493c40c180648365fa",
    "ort-wasm-simd-threaded.jsep.mjs": "08fb86ec433c78bfb032c5d84a68b8e8e5a8d81268fa39e24314179a5767a5b9",
    "ort-wasm-simd-threaded.jsep.wasm": "c46655e8a94afc45338d4cb2b840475f88e5012d524509916e505079c00bfa39",
}


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def json_file(path):
    return json.loads(path.read_text(encoding="utf-8"))


def safe_file(root, name):
    path = PurePosixPath(name)
    if not isinstance(name, str) or path.is_absolute() or not path.parts or any(
            part in {"..", "."} or part.startswith(".") for part in path.parts) or "\\" in name or ":" in name:
        raise ValueError(f"Unsafe package path: {name}")
    target = root.joinpath(*path.parts)
    cursor = target
    while cursor != root:
        if cursor.is_symlink():
            raise ValueError(f"Symbolic links are not accepted: {name}")
        cursor = cursor.parent
    if not target.resolve().is_relative_to(root):
        raise ValueError(f"Package path leaves project: {name}")
    return target


def model_identity(model):
    return model["id"], model["revision"], model["dtype"]


def validate_registry(registry):
    if registry.get("runtime") != RUNTIME:
        raise ValueError("Runtime must match the pinned Transformers.js version")
    models = registry.get("models")
    if not isinstance(models, list) or not models:
        raise ValueError("Model registry is empty")
    keys = set()
    for model in models:
        if model["key"] in keys:
            raise ValueError("Duplicate model key")
        keys.add(model["key"])
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", model["id"]) or any(p.startswith(".") for p in model["id"].split("/")):
            raise ValueError("Invalid model id")
        if not re.fullmatch(r"[0-9a-f]{40}", model["revision"]):
            raise ValueError("Every model must use an immutable full commit revision")
        files = model.get("files", [])
        if not files or len(files) != len(set(files)):
            raise ValueError("Invalid model file list")
        for name in files:
            safe_file(ROOT, "models/" + model["id"] + "/" + name)
    return models


def verify_manifest(manifest, registry, root=None):
    root = Path(root or ROOT).resolve()
    registered = validate_registry(registry)
    if manifest.get("runtime") != registry["runtime"]:
        raise ValueError("Offline runtime does not match this game")
    models, files = manifest.get("models"), manifest.get("files")
    if not isinstance(models, list) or not models or not isinstance(files, dict):
        raise ValueError("Offline manifest is incomplete")
    expected = {"vendor/" + name for name in RUNTIME_FILES}
    trusted = {"vendor/" + name: digest for name, digest in RUNTIME_SHA256.items()}
    sizes = {}
    identities = set()
    for item in models:
        current = next((m for m in registered if m["key"] == item.get("key")), None)
        if not current or model_identity(current) != model_identity(item) or item.get("files") != current["files"]:
            raise ValueError("Offline model identity/files do not match the current registry")
        identity = model_identity(current)
        if identity in identities:
            raise ValueError("Duplicate offline model")
        identities.add(identity)
        prefix = "models/" + current["id"] + "/"
        expected.update(prefix + name for name in current["files"])
        trusted.update({prefix + name: digest for name, digest in current.get("sha256", {}).items()})
        sizes.update({prefix + name: size for name, size in current.get("sizes", {}).items()})
    if set(files) != expected:
        raise ValueError("Offline manifest has missing or unexpected files")
    for name, digest in files.items():
        path = safe_file(root, name)
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ValueError(f"Invalid SHA256 for {name}")
        if name in trusted and digest != trusted[name]:
            raise ValueError(f"Manifest does not match the pinned SHA256: {name}")
        if not path.is_file():
            raise ValueError(f"Missing offline file: {name}")
        if name in sizes and path.stat().st_size != sizes[name]:
            raise ValueError(f"Unexpected offline file size: {name}")
        if sha256(path) != digest:
            raise ValueError(f"SHA256 mismatch: {name}")
    return {"models": len(models), "files": len(files)}


def write_json_atomic(destination, data):
    destination.parent.mkdir(parents=True, exist_ok=True)
    pending = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=destination.parent,
                                         prefix=destination.name + ".", suffix=".part", delete=False) as stream:
            pending = Path(stream.name)
            json.dump(data, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        pending.replace(destination)
    finally:
        if pending:
            pending.unlink(missing_ok=True)


def download_file(url, destination, expected_hash=None, expected_size=None, local_source=None):
    destination.parent.mkdir(parents=True, exist_ok=True)
    receipt = destination.with_name(destination.name + ".download.json")
    if destination.is_file():
        digest = sha256(destination)
        known = None
        if receipt.is_file():
            try:
                record = json_file(receipt)
                if record.get("url") == url:
                    known = record.get("sha256")
            except (ValueError, OSError):
                pass
        if (expected_hash or known) == digest and (expected_size is None or destination.stat().st_size == expected_size):
            print(f"Verified existing: {destination.name}", flush=True)
            return digest
    pending = None
    try:
        with tempfile.NamedTemporaryFile(dir=destination.parent, prefix=destination.name + ".", suffix=".part", delete=False) as stream:
            pending = Path(stream.name)
            digest = hashlib.sha256()
            source = (Path(local_source).open("rb") if local_source else
                      urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Aethelgard-offline-installer/10"}), timeout=60))
            total, next_progress = 0, 64 * 1024 * 1024
            with source:
                while chunk := source.read(1024 * 1024):
                    stream.write(chunk)
                    digest.update(chunk)
                    total += len(chunk)
                    if total >= next_progress:
                        print(f"  {destination.name}: {total / 1e6:.0f} MB", flush=True)
                        next_progress += 64 * 1024 * 1024
        result = digest.hexdigest()
        if expected_hash and result != expected_hash:
            raise ValueError(f"Downloaded file failed pinned SHA256: {destination.name}")
        if expected_size is not None and total != expected_size:
            raise ValueError(f"Downloaded file has unexpected size: {destination.name}")
        pending.replace(destination)
        write_json_atomic(receipt, {"url": url, "sha256": result, "bytes": total})
        return result
    finally:
        if pending:
            pending.unlink(missing_ok=True)


def prepare(registry, keys=None, root=None):
    root = Path(root or ROOT).resolve()
    all_models = validate_registry(registry)
    keys = keys or [all_models[0]["key"]]
    models = [m for m in all_models if m["key"] in keys]
    if set(keys) != {m["key"] for m in models}:
        raise ValueError("Unknown model selection")
    files = {}
    npm = root / "node_modules/@huggingface/transformers"
    npm_ok = (npm / "package.json").is_file() and json_file(npm / "package.json").get("version") == "3.8.1"
    for name in RUNTIME_FILES:
        relative = "vendor/" + name
        source = npm / "dist" / name
        files[relative] = download_file("https://cdn.jsdelivr.net/npm/" + RUNTIME + "/dist/" + name,
                                       safe_file(root, relative), expected_hash=RUNTIME_SHA256[name],
                                       local_source=source if npm_ok and source.is_file() else None)
    for model in models:
        for name in model["files"]:
            relative = "models/" + model["id"] + "/" + name
            print(f"Preparing {model['key']}: {name}", flush=True)
            files[relative] = download_file("https://huggingface.co/" + model["id"] + "/resolve/" + model["revision"] + "/" + name,
                                           safe_file(root, relative), model.get("sha256", {}).get(name),
                                           model.get("sizes", {}).get(name))
    manifest = {"runtime": registry["runtime"], "models": models, "files": files}
    verify_manifest(manifest, registry, root)
    write_json_atomic(root / "models/offline-manifest.json", manifest)
    return manifest


def main(argv=None):
    registry = json_file(ROOT / "models/registry.json")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", action="append", choices=[m["key"] for m in registry["models"]])
    parser.add_argument("--verify-only", action="store_true", help="Verify all package hashes without network access")
    args = parser.parse_args(argv)
    try:
        manifest = json_file(ROOT / "models/offline-manifest.json") if args.verify_only else prepare(registry, args.model)
        result = verify_manifest(manifest, registry)
    except (OSError, ValueError, KeyError) as error:
        parser.exit(1, f"Offline package is not ready: {error}\n")
    print(f"Verified {result['models']} model(s), runtime, and {result['files']} files; no network needed.")


if __name__ == "__main__":
    main()
