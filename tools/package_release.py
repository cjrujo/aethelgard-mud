#!/usr/bin/env python3
"""Create a local source/game ZIP, optionally containing one verified offline model.

No network requests, model downloads, Git operations, or deployment are performed.
The current generated game must match its sources before packaging.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.util
import json
from pathlib import Path, PurePosixPath
import re
import stat
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent
ARCHIVE_ROOT = "aethelgard-mud"
REQUIRED_FILES = (
    "index.html", "open_world_mud.html", "sw.js", "build-info.json", "assets/game.css", "assets/ai-worker.js",
    "models/registry.json", "tools/serve.py", "tools/prepare_offline.py", "tools/package_release.py",
    "start_Windows.cmd", "start_unix.sh", "README.md", "src/build_mud_game.py",
    "package.json", "package-lock.json", "tailwind.config.cjs", "cloudflare-worker/entry.js", "cloudflare-worker/worker.js", "cloudflare-worker/receipts.js",
    "cloudflare-worker/build-info.js", "cloudflare-worker/wrangler.toml",
)
SOURCE_DIRECTORIES = ("assets", "docs", "src", "tests", ".github", "cloudflare-worker")
OPTIONAL_FILES = (".gitignore", ".gitattributes", "LICENSE", "LICENSE.txt", "LICENSE.md", "NOTICE", "NOTICE.txt")
EXCLUDED_PARTS = {"node_modules", ".git", ".cache", "__pycache__", "test-results", "playwright-report",
                  "dist", "dist-release", "saves", "savegames"}
TEXT_SUFFIXES = {".html", ".js", ".mjs", ".cjs", ".css", ".json", ".md", ".txt", ".py",
                 ".toml", ".yml", ".yaml", ".cmd", ".sh", ".svg"}


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def load_helper(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def checked_file(root, relative):
    """Package regular files under this project, never a symlink or external path."""
    name = PurePosixPath(relative)
    if name.is_absolute() or ".." in name.parts or "\\" in relative or ":" in relative:
        raise ValueError(f"Invalid release path: {relative}")
    target = root.joinpath(*name.parts)
    cursor = target
    while cursor != root:
        if cursor.is_symlink():
            raise ValueError(f"Release input cannot be a symbolic link: {relative}")
        cursor = cursor.parent
    if not target.resolve().is_relative_to(root) or not target.is_file():
        raise ValueError(f"Required release file is missing or outside the project: {relative}")
    return target


def source_files(root):
    files = {name: checked_file(root, name) for name in REQUIRED_FILES}
    for directory in SOURCE_DIRECTORIES:
        base = root / directory
        if not base.is_dir() or base.is_symlink():
            raise ValueError(f"Required source directory is missing or a symbolic link: {directory}")
        for path in base.rglob("*"):
            relative = path.relative_to(root)
            parts = relative.parts
            if any(part in EXCLUDED_PARTS or (part.startswith(".") and part != ".github") for part in parts):
                continue
            if path.suffix in {".pyc", ".pyo", ".zip", ".part", ".tmp", ".log"} or path.name.endswith(".download.json"):
                continue
            if path.is_symlink():
                raise ValueError(f"Release input cannot be a symbolic link: {relative.as_posix()}")
            if path.is_file():
                name = relative.as_posix()
                files[name] = checked_file(root, name)
    for name in OPTIONAL_FILES:
        if (root / name).exists():
            files[name] = checked_file(root, name)
    return files


def check_build(root):
    builder = load_helper(root / "src/build_mud_game.py", "aethelgard_release_builder")
    stale = [name for name, content in builder.outputs().items()
             if not (root / name).is_file() or (root / name).read_text(encoding="utf-8") != content]
    if stale:
        raise ValueError("Generated game is stale; run python src/build_mud_game.py before packaging: " + ", ".join(stale))


def selected_offline_files(root, registry, key):
    model = next((item for item in registry["models"] if item["key"] == key), None)
    if model is None:
        raise ValueError(f"Model key is not in the current registry: {key}")
    installer = load_helper(root / "tools/prepare_offline.py", "aethelgard_release_installer")
    manifest_path = checked_file(root, "models/offline-manifest.json")
    original = read_json(manifest_path)
    # Deliberately validate the entire source package before trimming it. A broken
    # unselected model is reported, not silently hidden by the release filter.
    installer.verify_manifest(original, registry)
    if not any(installer.model_identity(item) == installer.model_identity(model) for item in original["models"]):
        raise ValueError(f"Offline package does not contain the registry's exact id/revision/dtype for {key}")
    names = {f"models/{model['id']}/{name}" for name in model["files"]}
    names.update(f"vendor/{name}" for name in installer.RUNTIME_FILES)
    if not names <= original["files"].keys():
        raise ValueError("Offline manifest is missing files required by the selected model")
    trimmed = {"runtime": registry["runtime"], "models": [copy.deepcopy(model)],
               "files": {name: original["files"][name] for name in sorted(names)}}
    files = {name: checked_file(root, name) for name in sorted(names)}
    return files, trimmed


def zip_info(relative):
    # Fixed metadata makes identical inputs reproducible and avoids host-specific
    # ownership/timestamps. The shell launcher remains executable after extraction.
    info = zipfile.ZipInfo(f"{ARCHIVE_ROOT}/{relative}", date_time=(2020, 1, 1, 0, 0, 0))
    info.create_system = 3
    mode = 0o755 if relative == "start_unix.sh" else 0o644
    info.external_attr = (stat.S_IFREG | mode) << 16
    path = PurePosixPath(relative)
    info.compress_type = zipfile.ZIP_DEFLATED if path.suffix.lower() in TEXT_SUFFIXES or path.name in OPTIONAL_FILES else zipfile.ZIP_STORED
    return info


def write_file(archive, relative, source, expected_hash=None):
    digest = hashlib.sha256() if expected_hash else None
    size = 0
    with source.open("rb") as incoming, archive.open(zip_info(relative), "w", force_zip64=True) as outgoing:
        while chunk := incoming.read(1024 * 1024):
            outgoing.write(chunk)
            size += len(chunk)
            if digest:
                digest.update(chunk)
    if digest and digest.hexdigest() != expected_hash:
        raise ValueError(f"Offline file changed during packaging or failed SHA256: {relative}")
    return size


def create_release(root=None, model_key=None, output=None):
    root = Path(root or ROOT).resolve()
    files = source_files(root)
    check_build(root)
    registry = read_json(root / "models/registry.json")
    manifest = None
    if model_key:
        offline_files, manifest = selected_offline_files(root, registry, model_key)
        files.update(offline_files)
    version = read_json(root / "package.json")["version"]
    if not re.fullmatch(r"[0-9]+(?:\.[0-9]+){0,2}(?:-[a-zA-Z0-9.-]+)?", version):
        raise ValueError("Invalid package version for release filename")
    name = f"aethelgard-v{version}-{model_key}-offline.zip" if model_key else f"aethelgard-v{version}-source.zip"
    destination = Path(output).resolve() if output else root / "dist-release" / name
    if destination.suffix.lower() != ".zip":
        raise ValueError("Release output must be a .zip file")
    if destination in {path.resolve() for path in files.values()}:
        raise ValueError("Release output cannot overwrite a source file")
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = None
    total_bytes = 0
    count = len(files) + bool(manifest)
    try:
        with tempfile.NamedTemporaryFile(prefix=destination.name + ".", suffix=".part", dir=destination.parent, delete=False) as pending:
            partial = Path(pending.name)
        with zipfile.ZipFile(partial, "w", allowZip64=True) as archive:
            hashes = manifest["files"] if manifest else {}
            for relative, source in sorted(files.items()):
                total_bytes += write_file(archive, relative, source, hashes.get(relative))
            if manifest:
                payload = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
                archive.writestr(zip_info("models/offline-manifest.json"), payload)
                total_bytes += len(payload)
        partial.replace(destination)
    finally:
        if partial:
            partial.unlink(missing_ok=True)
    return {"path": str(destination), "files": count, "uncompressedBytes": total_bytes,
            "archiveBytes": destination.stat().st_size, "model": model_key}


def main(argv=None):
    registry = read_json(ROOT / "models/registry.json")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", choices=[model["key"] for model in registry["models"]],
                        help="Include only this exact registry model and its verified offline runtime")
    parser.add_argument("--output", type=Path, help="Output ZIP path; default is dist-release/aethelgard-v<VERSION>-*.zip")
    args = parser.parse_args(argv)
    try:
        result = create_release(model_key=args.model, output=args.output)
    except (OSError, ValueError) as error:
        parser.exit(1, f"Release was not created: {error}\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    print("Extract the ZIP, open its aethelgard-mud folder, then run start_Windows.cmd or python tools/serve.py --open.")
    if args.model:
        print(f"Offline model: {args.model}. In AI DM, select it and enable 'Use downloaded offline package'.")
        print("To check the extracted package: python tools/prepare_offline.py --verify-only")
    else:
        print("This source/game package contains no model weights or runtime. Rules gameplay is available immediately.")


if __name__ == "__main__":
    main()
